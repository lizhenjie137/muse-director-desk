// 八项媒体合约；执行使用受控本地目录与 FFmpeg。
// 平台适配：契约规格与源码包 server/src/privileged.ts 逐项一致（名称、
// 请求/响应、capabilities、timeoutMs 均未改）；handler 本体移植自源码包
// 的本机媒体实现（FFmpeg 裁切/抽尾帧/归一化/拼接/受控目录校验/属主标记
// 逻辑不变）。平台 handler 只收到请求参数：受控目录优先取 args.spaceDir，
// 无 spaceDir 的契约由媒体路径所在的 imports/exports/blobs 目录推导；
// FFmpeg 不可用或文件不在受控目录时，沿用原实现返回结构化 error，
// 绝不伪造成功。
import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
// 八项媒体合约；执行使用受控本地目录与 FFmpeg。


export const privileged = definePrivilegedContracts({
  trimVideoToDuration: {
    request: z.object({ spaceDir: z.string().min(1).max(600), path: z.string().min(1).max(600), targetSec: z.number().min(0.3).max(3600), workName: z.string().min(1).max(100) }),
    response: z.object({ error: z.string().nullable(), outputPath: z.string().nullable(), durationSec: z.number(), totalBytes: z.number() }),
    capabilities: ["fs.read", "fs.write", "process.exec"], timeoutMs: 180000,
  },
  exportRefImageFile: {
    request: z.object({ spaceDir: z.string().min(1).max(600), mediaKey: z.string().min(1).max(300), outName: z.string().min(1).max(100) }),
    response: z.object({ error: z.string().nullable(), path: z.string().nullable(), bytes: z.number(), mimeType: z.string() }),
    capabilities: ["fs.read", "fs.write"], timeoutMs: 60000,
  },
  readWorkspaceImageChunk: {
    request: z.object({ path: z.string().min(1).max(600), offset: z.number().int().min(0), maxBytes: z.number().int().min(1024).max(1048576) }),
    response: z.object({ dataBase64: z.string(), bytesRead: z.number(), totalBytes: z.number(), mimeType: z.string(), eof: z.boolean() }),
    capabilities: ["fs.read"], timeoutMs: 60000,
  },
  readWorkspaceVideoChunk: {
    request: z.object({
      path: z.string().min(1).max(600),
      offset: z.number().int().min(0),
      maxBytes: z.number().int().min(1024).max(1048576),
    }),
    response: z.object({
      dataBase64: z.string(),
      bytesRead: z.number(),
      totalBytes: z.number(),
      mimeType: z.string(),
      eof: z.boolean(),
    }),
    capabilities: ["fs.read"],
    timeoutMs: 60000,
  },
  extractVideoLastFrame: {
    request: z.object({ path: z.string().min(1).max(600) }),
    response: z.object({
      frameBase64: z.string().nullable(),
      mimeType: z.string(),
      durationSec: z.number(),
      width: z.number(),
      height: z.number(),
      error: z.string().nullable(),
    }),
    capabilities: ["fs.read", "process.exec"],
    timeoutMs: 120000,
  },
  // 画布内导出最终完整品（两段式，配合宿主单次调用约 30s 预算）：
  // ① normalizeFinalSegment 逐段把采用版 blob 成片按入/出点裁切并统一
  //    画幅/帧率/音频，写到 spaceDir/exports/（一段一次调用）；
  // ② assembleFinalVideo 把归一化段拼成成品：全直切走 concat 无损合并
  //    （秒级），含转场时组间用 xfade/acrossfade（ultrafast 编码）。
  // 产物再由动作层分块直读回 blob 落到项目成品字段，不在聊天/资源库中转。
  normalizeFinalSegment: {
    request: z.object({
      spaceDir: z.string().min(1).max(600),
      blobKey: z.string().min(1).max(300),
      inSec: z.number().min(0).max(3600),
      outSec: z.number().min(0).max(3600).nullable(),
      width: z.number().int().min(16).max(3840),
      height: z.number().int().min(16).max(2160),
      fps: z.number().int().min(1).max(60),
      workName: z.string().min(1).max(100),
    }),
    response: z.object({
      error: z.string().nullable(),
      fileName: z.string().nullable(),
      lenSec: z.number(),
      totalBytes: z.number(),
    }),
    capabilities: ["fs.read", "fs.write", "process.exec"],
    timeoutMs: 120000,
  },
  assembleFinalVideo: {
    request: z.object({
      spaceDir: z.string().min(1).max(600),
      // exports/ 之内的归一化段文件名（basename），按拼接顺序
      files: z.array(z.string().min(1).max(120)).min(1).max(24),
      segLens: z.array(z.number().min(0).max(3600)).min(1).max(24),
      // transitions[i] = 第 i 段与第 i+1 段之间的转场（取后一段的 cutType）
      transitions: z.array(z.string().max(40)).max(23),
      fps: z.number().int().min(1).max(60),
      outputName: z.string().min(1).max(100),
    }),
    response: z.object({
      error: z.string().nullable(),
      outputPath: z.string().nullable(),
      totalBytes: z.number(),
      durationSec: z.number(),
    }),
    capabilities: ["fs.read", "fs.write", "process.exec"],
    timeoutMs: 120000,
  },
  deleteExportFiles: {
    request: z.object({
      spaceDir: z.string().min(1).max(600),
      names: z.array(z.string().min(1).max(120)).max(40),
    }),
    response: z.object({ error: z.string().nullable() }),
    capabilities: ["fs.write"],
    timeoutMs: 30000,
  },
});

// ---------- 媒体实现（移植自源码包本机媒体层，逻辑不变） ----------

const execute = promisify(execFile);
const MAX_BYTES = 45_000_000;
const OWNER = "director-desk-local-media";
export interface MediaContext { spaceDir: string; resolveBlobPath?: (key: string) => string | Promise<string> }
// 平台生成媒体的固定产物根（服务端写死，调用方不可选择）：助手执行
// 任务用平台原生生图/生视频产出的文件统一落在这个目录。数据目录之
// 外的文件只允许从这个固定根读取——路径本身不能授权自己的目录，
// 任意绝对路径一律拒绝（仍保留普通文件/大小/格式校验）。
const GENERATION_MEDIA_ROOT = join(homedir(), "workspace", "imagine_media");
async function generationRoot(): Promise<string | null> {
  try { return await realpath(GENERATION_MEDIA_ROOT); } catch { return null; }
}
// 媒体键校验（与平台 blob 命名空间对齐）：平台原生 generate_media 产出
// 的键是多段键 generated/<uuid>.webp，台内 blobs.put 的键是单段键；
// 两者都必须能被解析到 blob 内容。只拦真正的越界/非法键：空段、"."、
// ".." 跳转段、反斜杠、超长、段首非字母数字。
export function isValidBlobKey(key: string): boolean {
  if (!key || key.length > 300 || key.includes("\\")) return false;
  return key.split("/").every((seg) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/.test(seg) && seg !== "." && seg !== "..");
}
interface NormalizeArgs { spaceDir: string; blobKey: string; inSec: number; outSec: number | null; width: number; height: number; fps: number; workName: string }
interface AssembleArgs { spaceDir: string; files: string[]; segLens: number[]; transitions: string[]; fps: number; outputName: string }
interface MediaInfo { durationSec: number; width: number; height: number; hasAudio: boolean }
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../"));
}
async function area(ctx: MediaContext, name: "imports" | "exports" | "blobs") {
  if (!ctx || !isAbsolute(ctx.spaceDir)) throw new Error("媒体执行缺少受控数据目录。");
  const root = await realpath(ctx.spaceDir);
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  const actual = await realpath(path);
  if (!within(root, actual) || actual === root) throw new Error("媒体目录指向数据目录之外，拒绝访问。");
  return actual;
}
function sameSpace(ctx: MediaContext, requested: string) {
  if (!ctx || resolve(requested) !== resolve(ctx.spaceDir)) throw new Error("只能在当前导演台自己的数据目录内处理媒体。");
}
async function regularInside(path: string, roots: string[], maxBytes = MAX_BYTES) {
  if (!isAbsolute(path)) throw new Error("媒体路径必须是受控目录内的绝对路径。");
  const actual = await realpath(path);
  if (!roots.some(root => within(root, actual) && root !== actual)) throw new Error("文件不在允许的媒体目录内，拒绝访问。");
  const st = await stat(actual);
  if (!st.isFile()) throw new Error("该路径不是普通媒体文件。");
  if (st.size > maxBytes) throw new Error(`媒体超过台内可存上限 ${maxBytes / 1_000_000}MB。`);
  return { path: actual, size: st.size };
}
async function checkedVideoPath(ctx: MediaContext, raw: string, allowBlobs = false) {
  if (!allowBlobs && ![".mp4", ".mov", ".webm", ".m4v"].includes(extname(raw).toLowerCase())) throw new Error("只允许读取 .mp4 / .mov / .webm / .m4v 视频文件。");
  // 无 spaceDir（路径来自助手生成文件）：唯一允许根是平台固定生成
  // 产物根，路径不能自带授权目录。
  if (!ctx.spaceDir) {
    const root = await generationRoot();
    if (!root) throw new Error("平台生成产物目录不可用，拒绝读取数据目录之外的文件。");
    return regularInside(raw, [root]);
  }
  const roots = [await area(ctx, "imports"), await area(ctx, "exports")];
  if (allowBlobs) roots.push(await area(ctx, "blobs"));
  try {
    return await regularInside(raw, roots);
  } catch (e) {
    if (!allowBlobs) throw e;
    if (!isAbsolute(raw)) throw e;
    // 动作层按 <spaceDir>/blobs/<key> 拼出的路径在平台内容寻址存储下
    // 没有实体文件：取出 /blobs/ 后的键、经平台索引解析到对象实体再
    // 校验（仍须落在该数据目录的 blobs 根内、普通文件、大小上限）。
    const marker = "/blobs/";
    const bi = raw.lastIndexOf(marker);
    if (bi > 0) {
      const key = raw.slice(bi + marker.length);
      if (isValidBlobKey(key)) {
        const resolved = await blobObjectPath(raw.slice(0, bi), key);
        const st = await stat(resolved).catch(() => null);
        if (st?.isFile()) {
          if (st.size > MAX_BYTES) throw new Error(`媒体超过台内可存上限 ${MAX_BYTES / 1_000_000}MB。`);
          return { path: await realpath(resolved), size: st.size };
        }
      }
    }
    // 平台助手生成的成片位于构件数据目录之外：只允许平台固定生成
    // 产物根内的文件（服务端写死的根，调用方不可选择），其余任意
    // 绝对路径一律拒绝；根内仍走普通文件/大小校验，真实性由后续
    // ffprobe 解码与文件头校验把关。
    const root = await generationRoot();
    if (root) {
      try { return await regularInside(raw, [root]); } catch { /* 落回原错误 */ }
    }
    throw e;
  }
}
function safeBase(name: string, extension = false) {
  const pattern = extension ? /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/ : /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
  if (!pattern.test(name) || name.includes("..") || basename(name) !== name || (extension && !name.endsWith(".mp4"))) throw new Error("导出文件名无效，不能包含目录或路径跳转。");
  return name;
}
const mimeFor = (path: string) => extname(path).toLowerCase() === ".webm" ? "video/webm" : extname(path).toLowerCase() === ".mov" ? "video/quicktime" : "video/mp4";
const MAX_IMAGE_BYTES = 20_000_000;
function imageFormat(bytes: Buffer, allowGif = false) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: "jpg", mimeType: "image/jpeg" };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: "png", mimeType: "image/png" };
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { ext: "webp", mimeType: "image/webp" };
  if (allowGif && /^(GIF87a|GIF89a)$/.test(bytes.toString("ascii", 0, 6))) return { ext: "gif", mimeType: "image/gif" };
  throw new Error("参考图不是可识别的图片格式（JPEG/PNG/WebP）。");
}
async function run(command: "ffmpeg" | "ffprobe", args: string[], timeout = 120_000) {
  try { return await execute(command, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }); }
  catch (e) {
    const detail = e as Error & { code?: string; stderr?: string; killed?: boolean };
    if (detail.code === "ENOENT") throw new Error(`未找到 ${command}，请安装 FFmpeg 并加入 PATH。`);
    if (detail.killed) throw new Error(`${command} 处理超时，未生成可用产物。`);
    throw new Error(`${command} 处理失败：${String(detail.stderr || detail.message).slice(-700)}`);
  }
}
export async function probeLocalMedia(path: string): Promise<MediaInfo> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", path], 30_000);
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[] };
  const video = info.streams?.find(s => s.codec_type === "video");
  const durationSec = Number(video?.duration) || Number(info.format?.duration) || 0;
  if (!video || !(durationSec > 0) || !video.width || !video.height) throw new Error("文件没有可解码的视频轨或有效时长。");
  return { durationSec, width: video.width, height: video.height, hasAudio: !!info.streams?.some(s => s.codec_type === "audio") };
}
async function reserveOutput(dir: string, name: string) {
  const path = join(dir, safeBase(name, true));
  const handle = await open(path, "wx");
  await handle.close();
  return path;
}
async function markOwned(path: string) {
  const bytes = await readFile(path);
  if (bytes.length < 32) throw new Error("媒体产物为空或不完整。");
  await writeFile(`${path}.media.json`, JSON.stringify({ owner: OWNER, fileName: basename(path), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }), { flag: "wx" });
  return bytes.length;
}
async function removeTemp(dir: string, root: string) {
  if (!within(root, resolve(dir)) || resolve(dir) === resolve(root)) throw new Error("临时媒体清理路径越界。");
  await rm(dir, { recursive: true, force: true });
}

export function createLocalMediaHandlers() {
  return {
    async trimVideoToDuration(args: { spaceDir: string; path: string; targetSec: number; workName: string }, ctx: MediaContext) {
      const fail = (error: string) => ({ error, outputPath: null, durationSec: 0, totalBytes: 0 });
      try {
        sameSpace(ctx, args.spaceDir);
        if (!Number.isFinite(args.targetSec) || args.targetSec < 0.3 || args.targetSec > 3600) throw new Error("裁切时长必须介于 0.3 至 3600 秒。");
        const input = await checkedVideoPath(ctx, args.path, true);
        await probeLocalMedia(input.path);
        const exportsDir = await area(ctx, "exports");
        const name = args.workName.replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 70) || "trim";
        const output = await reserveOutput(exportsDir, `${name}-${randomUUID()}.mp4`);
        await run("ffmpeg", ["-v", "error", "-i", input.path, "-t", String(args.targetSec),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-y", output], 180000);
        const info = await probeLocalMedia(output);
        const st = await stat(output);
        if (st.size < 1024 || st.size > MAX_BYTES) throw new Error("裁切产物大小无效或超过台内上限。");
        await markOwned(output);
        return { error: null, outputPath: output, durationSec: info.durationSec, totalBytes: st.size };
      } catch (error) { return fail(message(error)); }
    },

    async exportRefImageFile(args: { spaceDir: string; mediaKey: string; outName: string }, ctx: MediaContext) {
      const fail = (error: string) => ({ error, path: null, bytes: 0, mimeType: "" });
      try {
        sameSpace(ctx, args.spaceDir);
        // 参考格键可含下划线；导出只使用无目录的独立文件名，不覆盖旧尝试。
        const name = args.outName.replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 100) || "ref";
        let key = args.mediaKey;
        if (key.startsWith("asset:")) {
          const root = await realpath(ctx.spaceDir);
          const mappingFile = await regularInside(join(root, "assets.json"), [root], 1024 * 1024);
          const mapping: unknown = JSON.parse(await readFile(mappingFile.path, "utf8"));
          const mapped = mapping && typeof mapping === "object" && Object.hasOwn(mapping, key) ? (mapping as Record<string, unknown>)[key] : null;
          // 映射值是 /blobs/ 下的 blob 键，平台多段键（generated/…）同样合法。
          if (typeof mapped !== "string" || !mapped.startsWith("/blobs/") || !isValidBlobKey(mapped.slice("/blobs/".length))) throw new Error("参考图原件尚未在本机恢复，不能将缺失图片当作生成参照。");
          key = mapped.slice("/blobs/".length);
        }
        if (!ctx.resolveBlobPath) throw new Error("本地媒体读取入口不可用。");
        const blobs = await area(ctx, "blobs");
        const input = await regularInside(await ctx.resolveBlobPath(key), [blobs], MAX_IMAGE_BYTES);
        const bytes = await readFile(input.path);
        const format = imageFormat(bytes);
        const exportsDir = await area(ctx, "exports");
        const output = join(exportsDir, `${name}-${randomUUID()}.${format.ext}`);
        await writeFile(output, bytes, { flag: "wx" });
        return { error: null, path: output, bytes: bytes.length, mimeType: format.mimeType };
      } catch (error) { return fail(message(error)); }
    },

    async readWorkspaceImageChunk(args: { path: string; offset: number; maxBytes: number }, ctx: MediaContext) {
      if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(args.path).toLowerCase())) throw new Error("只允许读取 PNG/JPEG/WebP/GIF 图片文件。");
      // 无 spaceDir（助手生成图在构件数据目录外）：唯一允许根是平台
      // 固定生成产物根；有 spaceDir 时只读台内 imports/exports。
      let roots: string[];
      if (ctx.spaceDir) roots = [await area(ctx, "imports"), await area(ctx, "exports")];
      else {
        const root = await generationRoot();
        if (!root) throw new Error("平台生成产物目录不可用，拒绝读取数据目录之外的文件。");
        roots = [root];
      }
      const input = await regularInside(args.path, roots, MAX_IMAGE_BYTES);
      if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > input.size) throw new Error("读取偏移超出文件大小。");
      if (!Number.isInteger(args.maxBytes) || args.maxBytes < 1024 || args.maxBytes > 1048576) throw new Error("分片大小无效。");
      const handle = await open(input.path, "r");
      try {
        const header = Buffer.alloc(Math.min(12, input.size));
        await handle.read(header, 0, header.length, 0);
        const format = imageFormat(header, true);
        const buffer = Buffer.alloc(Math.min(args.maxBytes, input.size - args.offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, args.offset);
        return { dataBase64: buffer.subarray(0, bytesRead).toString("base64"), bytesRead, totalBytes: input.size, mimeType: format.mimeType, eof: args.offset + bytesRead >= input.size };
      } finally { await handle.close(); }
    },

    async readWorkspaceVideoChunk(args: { path: string; offset: number; maxBytes: number }, ctx: MediaContext) {
      const file = await checkedVideoPath(ctx, args.path);
      if (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > file.size) throw new Error("读取偏移超出文件大小。");
      if (!Number.isInteger(args.maxBytes) || args.maxBytes < 1024 || args.maxBytes > 1048576) throw new Error("分片大小无效。");
      const buffer = Buffer.alloc(Math.min(args.maxBytes, file.size - args.offset));
      const handle = await open(file.path, "r");
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, args.offset);
        return { dataBase64: buffer.subarray(0, bytesRead).toString("base64"), bytesRead, totalBytes: file.size, mimeType: mimeFor(file.path), eof: args.offset + bytesRead >= file.size };
      } finally { await handle.close(); }
    },

    async extractVideoLastFrame(args: { path: string }, ctx: MediaContext) {
      let info: MediaInfo = { durationSec: 0, width: 0, height: 0, hasAudio: false };
      let temp: string | undefined, exportsDir: string | undefined;
      try {
        const input = await checkedVideoPath(ctx, args.path, true);
        info = await probeLocalMedia(input.path);
        // 无 spaceDir 时没有构件 exports 目录：临时帧目录放系统临时目录，用完即删。
        exportsDir = ctx.spaceDir ? await area(ctx, "exports") : await realpath(tmpdir());
        temp = await mkdtemp(join(exportsDir, "media-tail-"));
        const frame = join(temp, "last.jpg");
        // 解码至 EOF，持续覆盖同一 JPEG，留下真正最后解出的帧。
        // 不再用 duration-0.3；短于 0.3 秒的成片也可以提取末帧。
        await run("ffmpeg", ["-v", "error", "-i", input.path, "-map", "0:v:0", "-an", "-fps_mode", "passthrough", "-q:v", "2", "-update", "1", "-y", frame]);
        const bytes = await readFile(frame);
        if (bytes.length < 32) throw new Error("没有解出有效尾帧。");
        return { frameBase64: bytes.toString("base64"), mimeType: "image/jpeg", durationSec: info.durationSec, width: info.width, height: info.height, error: null };
      } catch (e) { return { frameBase64: null, mimeType: "image/jpeg", durationSec: info.durationSec, width: info.width, height: info.height, error: message(e) }; }
      finally { if (temp && exportsDir) await removeTemp(temp, exportsDir); }
    },

    async normalizeFinalSegment(args: NormalizeArgs, ctx: MediaContext) {
      const fail = (error: string) => ({ error, fileName: null, lenSec: 0, totalBytes: 0 });
      let output: string | undefined, success = false;
      try {
        sameSpace(ctx, args.spaceDir);
        safeBase(args.workName);
        if (![args.width, args.height, args.fps].every(Number.isInteger) || args.width < 16 || args.width > 3840 || args.height < 16 || args.height > 2160 || args.width % 2 || args.height % 2 || args.fps < 1 || args.fps > 60) throw new Error("导出尺寸必须为允许范围内的偶数，帧率需为 1–60。");
        if (!Number.isFinite(args.inSec) || args.inSec < 0 || args.inSec > 3600 || (args.outSec !== null && (!Number.isFinite(args.outSec) || args.outSec < 0 || args.outSec > 3600))) throw new Error("剪辑区间无效。");
        if (!isValidBlobKey(args.blobKey)) throw new Error("媒体键无效。");
        const blobs = await area(ctx, "blobs");
        const source = ctx.resolveBlobPath ? await ctx.resolveBlobPath(args.blobKey) : join(blobs, args.blobKey);
        const input = await regularInside(source, [blobs]);
        const info = await probeLocalMedia(input.path);
        const len = Math.min(args.outSec ?? info.durationSec, info.durationSec) - args.inSec;
        if (!(len >= 0.3)) throw new Error("剪辑区间不足 0.3 秒，请先调整剪辑点。");
        const exportsDir = await area(ctx, "exports");
        const fileName = `${args.workName}.mp4`;
        output = await reserveOutput(exportsDir, fileName);
        const vf = `scale=${args.width}:${args.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${args.width}:${args.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${args.fps},format=yuv420p,setpts=PTS-STARTPTS`;
        const command = ["-v", "error", "-ss", String(args.inSec), "-i", input.path];
        if (!info.hasAudio) command.push("-f", "lavfi", "-t", String(len), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        command.push("-t", String(len), "-map", "0:v:0", "-map", info.hasAudio ? "0:a:0" : "1:a:0", "-vf", vf, "-af", `apad,atrim=duration=${len},asetpts=PTS-STARTPTS`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(args.fps), "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-y", output);
        await run("ffmpeg", command);
        const normalized = await probeLocalMedia(output);
        const totalBytes = await markOwned(output);
        success = true;
        return { error: null, fileName, lenSec: normalized.durationSec, totalBytes };
      } catch (e) { return fail(message(e)); }
      finally { if (output && !success) await rm(output, { force: true }).catch(() => undefined); }
    },

    async assembleFinalVideo(args: AssembleArgs, ctx: MediaContext) {
      const fail = (error: string) => ({ error, outputPath: null, totalBytes: 0, durationSec: 0 });
      let output: string | undefined, temp: string | undefined, exportsDir: string | undefined, success = false;
      try {
        sameSpace(ctx, args.spaceDir);
        safeBase(args.outputName);
        if (!Number.isInteger(args.fps) || args.fps < 1 || args.fps > 60) throw new Error("导出帧率无效。");
        if (args.files.length < 1 || args.files.length > 24 || args.segLens.length !== args.files.length || args.transitions.length !== args.files.length - 1) throw new Error("拼接分段、时长与转场数不匹配。");
        if (args.transitions.some(t => !["", "直切", "叠化", "淡入淡出"].includes(t))) throw new Error("转场只支持直切、叠化或淡入淡出。");
        exportsDir = await area(ctx, "exports");
        const files: string[] = [];
        for (const name of args.files) {
          const file = await regularInside(join(exportsDir, safeBase(name, true)), [exportsDir]);
          if (!(await probeLocalMedia(file.path)).hasAudio) throw new Error("归一化段缺少音轨，请重新归一化。");
          files.push(file.path);
        }
        output = await reserveOutput(exportsDir, `${args.outputName}.mp4`);
        temp = await mkdtemp(join(exportsDir, "media-assemble-"));
        const tempRoot = temp;
        const concatCopy = async (inputs: string[], out: string) => {
          const list = join(tempRoot, `list-${randomUUID()}.txt`);
          const content = inputs.map(f => `file '${f.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n");
          await writeFile(list, content, "utf8");
          await run("ffmpeg", ["-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", "-y", out]);
        };
        const groups: { indexes: number[]; transAfter: string }[] = [];
        let current = { indexes: [0], transAfter: "" };
        for (let i = 0; i < files.length - 1; i++) {
          // 原 actions 取后一片的 cutType 作为 transitions[i]，保持边界语义。
          const transition = args.transitions[i] || "直切";
          if (transition === "直切") current.indexes.push(i + 1);
          else { current.transAfter = transition; groups.push(current); current = { indexes: [i + 1], transAfter: "" }; }
        }
        groups.push(current);
        const groupFiles: string[] = [], groupLens: number[] = [];
        for (const [index, group] of groups.entries()) {
          let file = files[group.indexes[0]!]!;
          if (group.indexes.length > 1) { file = join(tempRoot, `group-${index}.mp4`); await concatCopy(group.indexes.map(i => files[i]!), file); }
          groupFiles.push(file);
          groupLens.push((await probeLocalMedia(file)).durationSec); // 不信任请求的 segLens。
        }
        if (groups.length === 1) await concatCopy(groupFiles, output);
        else {
          const command = ["-v", "error", "-filter_complex_threads", "1"];
          for (const file of groupFiles) command.push("-i", file);
          const filters: string[] = [];
          for (let i = 0; i < groupFiles.length; i++) { filters.push(`[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[v${i}]`); filters.push(`[${i}:a]aresample=48000,asetpts=PTS-STARTPTS[a${i}]`); }
          let v = "[v0]", a = "[a0]", duration = groupLens[0]!;
          for (let i = 1; i < groups.length; i++) {
            const nextLen = groupLens[i]!;
            const transition = groups[i - 1]!.transAfter === "淡入淡出" ? "fadeblack" : "fade";
            const d = Math.max(0.1, Math.min(0.5, 0.4 * Math.min(duration, nextLen)));
            filters.push(`${v}[v${i}]xfade=transition=${transition}:duration=${d.toFixed(3)}:offset=${Math.max(0, duration - d).toFixed(3)}[vx${i}]`);
            filters.push(`${a}[a${i}]acrossfade=d=${d.toFixed(3)}[ax${i}]`);
            v = `[vx${i}]`; a = `[ax${i}]`; duration += nextLen - d;
          }
          command.push("-filter_complex", filters.join(";"), "-map", v, "-map", a, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p", "-r", String(args.fps), "-c:a", "aac", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-y", output);
          await run("ffmpeg", command);
        }
        const result = await probeLocalMedia(output);
        const totalBytes = await markOwned(output);
        success = true;
        return { error: null, outputPath: output, totalBytes, durationSec: result.durationSec };
      } catch (e) { return fail(message(e)); }
      finally { if (temp && exportsDir) await removeTemp(temp, exportsDir); if (output && !success) await rm(output, { force: true }).catch(() => undefined); }
    },

    async deleteExportFiles(args: { spaceDir: string; names: string[] }, ctx: MediaContext) {
      try {
        sameSpace(ctx, args.spaceDir);
        if (args.names.length > 40) throw new Error("一次清理的临时文件过多。");
        const root = await area(ctx, "exports");
        const approved: string[] = [];
        for (const name of args.names) {
          const file = await regularInside(join(root, safeBase(name, true)), [root], Number.MAX_SAFE_INTEGER);
          const markerFile = await regularInside(`${file.path}.media.json`, [root], 4096);
          const marker = JSON.parse(await readFile(markerFile.path, "utf8")) as { owner?: string; fileName?: string; sha256?: string };
          if (marker.owner !== OWNER || marker.fileName !== name || createHash("sha256").update(await readFile(file.path)).digest("hex") !== marker.sha256) throw new Error("文件不是本媒体处理层生成的中转文件，或内容已改变，拒绝清理。");
          approved.push(file.path);
        }
        // 全部验证后，仅清理有来源记录且摘要一致的中转文件。
        for (const path of approved) { await rm(path); await rm(`${path}.media.json`); }
        return { error: null };
      } catch (e) { return { error: message(e) }; }
    },
  };
}

// ---------- 平台 blob 存储解析 ----------
// 平台 ctx.blobs 不是按键平铺文件：实体是内容寻址对象
// <spaceDir>/blobs/objects/<object_id 前 2 位>/<object_id>，键→对象
// 的映射在 <spaceDir>/blobs/index.sqlite 的 blobs 表（key 主键，
// object_id 列）。键解析必须查这份索引；索引里没有该键时回退旧的
// 平铺路径 <spaceDir>/blobs/<key>（本机版布局），由后续 regularInside
// 的存在性校验如实报错，绝不假装解析成功。
const execAny = execute as unknown as (command: string, args: string[], options: { timeout?: number; maxBuffer?: number; encoding?: string }) => Promise<{ stdout: string; stderr: string }>;
async function blobObjectPath(spaceDir: string, key: string): Promise<string> {
  const blobsRoot = join(spaceDir, "blobs");
  const indexPath = join(blobsRoot, "index.sqlite");
  try {
    if ((await stat(indexPath)).isFile()) {
      const sql = `SELECT object_id FROM blobs WHERE key = '${key.replaceAll("'", "''")}' LIMIT 1`;
      const { stdout } = await execAny("sqlite3", ["-readonly", "-json", indexPath, sql], { timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8" });
      const rows = JSON.parse(stdout || "[]") as Array<{ object_id?: unknown }>;
      const oid = rows[0]?.object_id;
      if (typeof oid === "string" && /^[a-f0-9]{64}$/.test(oid)) return join(blobsRoot, "objects", oid.slice(0, 2), oid);
    }
  } catch { /* 索引不可用时回退平铺路径，由存在性校验如实报错 */ }
  return join(blobsRoot, key);
}

// ---------- 平台 handler 上下文推导 ----------
function deriveSpaceDir(args: { spaceDir?: string; path?: string }): string | null {
  if (typeof args.spaceDir === "string" && args.spaceDir) return args.spaceDir;
  const p = typeof args.path === "string" ? args.path : "";
  for (const seg of ["/imports/", "/exports/", "/blobs/"]) {
    const i = p.lastIndexOf(seg);
    if (i > 0) return p.slice(0, i);
  }
  return null;
}

function mediaCtx(args: { spaceDir?: string; path?: string }): MediaContext {
  const spaceDir = deriveSpaceDir(args);
  if (spaceDir) {
    return {
      spaceDir,
      resolveBlobPath: async (key: string) => {
        // 平台多段键（generated/<uuid>.webp）与台内单段键同等解析；
        // 只拦空段/跳转段等真正的非法键（见 isValidBlobKey）。实体位置
        // 经平台 blob 索引解析（见 blobObjectPath），不是按键平铺。
        if (!isValidBlobKey(key)) throw new Error("媒体键无效。");
        return blobObjectPath(spaceDir, key);
      },
    };
  }
  // 路径不在构件数据目录内：这是助手生成工具的产物文件（生成图/成片
  // 的 local_path）。spaceDir 留空，各 handler 只允许从平台固定生成
  // 产物根（GENERATION_MEDIA_ROOT，服务端写死）读取，路径本身不带来
  // 任何授权；相对路径仍拒绝。
  const p = typeof args.path === "string" ? args.path : "";
  if (isAbsolute(p)) return { spaceDir: "" };
  throw new Error("无法确定受控数据目录，拒绝执行媒体操作。");
}

const mediaImpl = createLocalMediaHandlers();

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  trimVideoToDuration: (args) => mediaImpl.trimVideoToDuration(args, mediaCtx(args)),
  exportRefImageFile: (args) => mediaImpl.exportRefImageFile(args, mediaCtx(args)),
  readWorkspaceImageChunk: (args) => mediaImpl.readWorkspaceImageChunk(args, mediaCtx(args)),
  readWorkspaceVideoChunk: (args) => mediaImpl.readWorkspaceVideoChunk(args, mediaCtx(args)),
  extractVideoLastFrame: (args) => mediaImpl.extractVideoLastFrame(args, mediaCtx(args)),
  normalizeFinalSegment: (args) => mediaImpl.normalizeFinalSegment(args, mediaCtx(args)),
  assembleFinalVideo: (args) => mediaImpl.assembleFinalVideo(args, mediaCtx(args)),
  deleteExportFiles: (args) => mediaImpl.deleteExportFiles(args, mediaCtx(args)),
});
