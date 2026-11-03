// 导演台动作层。行为按《导演台工作台重建规格》与 2026-10-28 更新说明实现：
// 脚本 ready 自动拆分镜、链式生成三级取帧、身份锁原文不改写、派单按锁定
// 基准组装、档案/项目双轨锁版。所有被拦截的操作返回中文原因，不静默失败。

// 平台适配层（替换源码包的本机 SDK 适配）：
// - defineAction / z / 特权契约改走 @hatch/space-sdk 与 @space/privileged；
// - 生成通道已接通（用户 2026-11-03「把所有通道打通」）：providers 与
//   下方四条真实执行路径一一对应，不是只改标志——
//   · 图像：无参照图走 ctx.tool.generate_media 平台原生生图直接回候选；
//     有参照包走 exportRefImageFile 导出真实文件＋ctx.agent.spawnTask
//     派助手以图片本身图生图，按 attemptId 回调 completeRefImage /
//     completeSceneImage 回填同一格作候选待审核；
//   · 视频：派单建结果卡＋任务后 ctx.agent.spawnTask 派助手执行原生
//     视频生成，回填走 ingestGeneratedVideo（文件直读）或分片
//     beginVideoUpload→appendVideoChunk→completeGenerationJob，全部带
//     attemptId 尝试归属与 SHA-256 重复回填保护；
//   · 推理：ctx.inference.complete 结构化推理（previewSplit 拆镜提炼
//     enrichDrafts、autoFillAndLockIdentity 身份锁补写），失败才回退
//     纯规则；
//   · 媒体：8 项特权契约走宿主 FFmpeg 与受控目录（见 privileged.ts）。
//   图像/视频本次接通验收未执行收费真实生成，状态如实标「已接通 ·
//   待首次真实生成验证」（见 channelStatus），不冒充已实测生成成功；
//   任一通道真实执行失败时沿原业务逻辑如实报错，绝不伪造任务或结果。
// - GENERATION_UNCONNECTED 保留为通道异常时的兜底文案导出（providers
//   已接通后正常路径不再返回它），文案已按真实状态更新；
// - importDir / resolveBlobPath 按平台 spaceDir 约定推导（imports/ 与
//   blobs/ 子目录），与特权媒体层的受控目录规则保持一致。
import { defineAction as sdkDefineAction, z, type ActionsModule, type Ctx as PlatformCtx, type PrivilegedContract, type SpaceDb } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";

export const GENERATION_UNCONNECTED = "生成通道暂时不可用：本次生成未启动、未产生结果。请稍后重试；若持续失败，请把报错原文反馈以便核查通道。";

// ---------- 通道状态（可查询，与真实执行路径一致） ----------
// 经 listProjects / getProject 响应返回，前端在项目列表页展示。
// image/video 已在沙盒隔离数据里各做一次最小端到端实测（直生、
// 锚点参照、派单视频整圈均真实生成并回填成功），故标 connected；
// 正式项目里的首次真实生成仍由用户自行触发。inference 已用隔离
// 演示实测；media 的成品导出动作链未完整跑通，单独标
// connected_pending_first_export，不与已验证段混同。
const channelStatusOut = z.object({
  image: z.object({ state: z.string(), label: z.string(), detail: z.string() }),
  video: z.object({ state: z.string(), label: z.string(), detail: z.string() }),
  inference: z.object({ state: z.string(), label: z.string(), detail: z.string() }),
  media: z.object({ state: z.string(), label: z.string(), detail: z.string() }),
});
type ChannelStatus = z.infer<typeof channelStatusOut>;
function channelStatus(): ChannelStatus {
  return {
    image: {
      state: "connected",
      label: "已接通",
      detail: "无参照图走平台原生生图（generate_media）直接回候选；有参照包走导出参照文件＋助手图生图＋attemptId 回调回填候选待审核。已在隔离验收中端到端实测：主肖像直生、纯场景直生、参考格锚点参照、场景结合参照各跑通一次并回填候选成功（参照导出按平台 blob 索引解析 generated/ 等多段键）。",
    },
    video: {
      state: "connected",
      label: "已接通",
      detail: "派单建结果卡与任务后派 Muse 助手执行原生视频生成，回填走文件直读 ingestGeneratedVideo 或分片 completeGenerationJob，带尝试归属与 SHA 重复保护。执行指令逐人标注参照图编号并要求全部参照作为实际图像入参喂入；成功回填前有出镜自检门：执行方须抽至少 3 帧逐人核验本镜出场人物真实出镜、服装标志无误并随回填带 castCheck 报告，缺人或参照未喂全一律拒绝落卡、须标失败并写明「人物未出镜/参照未生效」原因。已在隔离验收中端到端实测一次：派单（含参照包导出）→助手领取生成→文件直读回填成片并抽真实尾帧成功。成品导出段（归一化→拼接→导出）不在本通道实测内，见媒体处理状态。",
    },
    inference: {
      state: "connected",
      label: "已接通",
      detail: "拆镜提炼（previewSplit 的 enrichDrafts）与身份锁自动补写走平台结构化推理 ctx.inference.complete；推理失败才回退纯规则拆镜，不静默假装提炼成功。",
    },
    media: {
      state: "connected_pending_first_export",
      label: "已接通 · 成品导出段待首次真实导出验证",
      detail: "8 项特权媒体契约走宿主 FFmpeg 与受控目录：裁切、导出参照图、分块直读图片/视频、抽真实尾帧、归一化、转场拼接、清理中转文件。blob 键（平台 generated/ 多段键与台内单段键）经平台 blob 索引解析到内容寻址实体（与参照导出共用同一解析，已实证）；助手生成文件只允许从平台固定生成产物根直读，任意绝对路径拒绝。归一化/拼接的 FFmpeg 逻辑此前已用合成媒体实测，但成品导出动作链（采用→确认拼接→exportFinalVideo 产出成品）尚未完整跑通一次——沙盒验收时沙盒数据根与正式根分离、读不到沙盒回填的视频键，故如实标待首次真实导出验证，不标全验。",
    },
  };
}

interface DeskCtx {
  db: PlatformCtx["db"];
  spaceDir: string;
  importDir: string;
  resolveBlobPath(key: string): Promise<string>;
  blobs: PlatformCtx["blobs"];
  invalidateQueries(): void;
  providers: { video: boolean; image: boolean; inference: boolean };
  agent: PlatformCtx["agent"];
  tool: PlatformCtx["tool"];
  inference: PlatformCtx["inference"];
  executePrivileged: PlatformCtx["executePrivileged"];
}
type Ctx = DeskCtx;

function adaptCtx(ctx: PlatformCtx): DeskCtx {
  return {
    db: ctx.db,
    spaceDir: ctx.spaceDir,
    importDir: `${ctx.spaceDir}/imports`,
    resolveBlobPath: async (key: string) => `${ctx.spaceDir}/blobs/${key}`,
    blobs: ctx.blobs,
    invalidateQueries: () => ctx.invalidateQueries(),
    // 已接通：三项分别对应 generate_media＋助手参照回填（图像）、
    // spawnTask 助手执行＋ingest/分片回填（视频）、inference.complete
    // （推理）的真实可调用路径，详见文件头与 channelStatus()。
    providers: { video: true, image: true, inference: true },
    agent: ctx.agent,
    tool: ctx.tool,
    inference: ctx.inference,
    executePrivileged: ctx.executePrivileged,
  };
}

function deskAction<Req extends z.ZodType, Res extends z.ZodType>(def: {
  request: Req;
  response: Res;
  privileged?: readonly PrivilegedContract[];
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>> | z.infer<Res>;
}) {
  return sdkDefineAction({
    request: def.request,
    response: def.response,
    privileged: def.privileged,
    handler: async (ctx, args) => def.handler(adaptCtx(ctx), args),
  });
}

import { and, asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import { SEED_PROJECTS } from "./seed";

type DB = SpaceDb<typeof schema>;

// ---------- 通用小工具 ----------

const now = () => Date.now();
const iso = (ms: number | null | undefined) =>
ms? new Date(ms).toISOString(): null;
const parseMs = (v: unknown): number => {
if (typeof v === "string") {
const t = Date.parse(v);
if (!Number.isNaN(t)) return t;
}
return now();
};
const s = (v: unknown): string => (typeof v === "string"? v: "");
const nn = (v: unknown): number | null =>
typeof v === "number" && Number.isFinite(v)? v: null;
const ok = z.object({ ok: z.boolean(), error: z.string().nullable() });
const exportFinalResponse = z.object({
  ok: z.boolean(), error: z.string().nullable(),
  videoKey: z.string().nullable(), bytes: z.number(), durationSec: z.number(),
});

// ---------- 人物档案数据结构 ----------

interface RefSlot {
slotKey: string;
label: string;
groupKey: string;
custom?: boolean;
imageKey: string | null;
filled: boolean;
mediaMissing?: boolean;
candidateKey: string | null;
genStatus: string;
genError: string;
/** 本次生成开始时间（毫秒）：用于「生成中超时＝状态待核查」判定。 */
genStartedAt?: number | null;
/** 本次生成的尝试标识：回填回调必须带同一标识，旧尝试晚到拒绝。 */
genAttemptId?: string | null;
/** 最近一次生成的参照说明（锚点图＋定版图清单），界面可见、不静默。 */
genNote?: string;
}

interface VoiceRef {
id: string;
name: string;
key: string;
mimeType: string;
isMain: boolean;
}

type CharData = {
[k: string]: unknown;
refs: RefSlot[];
voiceRefs: VoiceRef[];
autoFilledFields: string[];
identityBaseline: string[];
identityBaselineVersion: number | null;
changeLog: string;
extraAssets: string[];
masterCandidateKey: string | null;
masterGenStatus: string;
masterGenError: string;
masterGenStartedAt: number | null;
masterGenAttemptId: string | null;
masterGenNote: string;
identityTextStatus: string;
lockBuild: string;
lockEyes: string;
lockFace: string;
lockFeatures: string;
lockHair: string;
lockMarks: string;
lockProportions: string;
lockSkin: string;
};

const REF_TEMPLATE: Array<[string, string, string]> = [
["body", "body_front", "全身 · 正面"],
["body", "body_left", "全身 · 左侧面"],
["body", "body_back", "全身 · 背面"],
["body", "body_front34", "全身 · 前三分之二面"],
["body", "body_back34", "全身 · 后三分之二面"],
["face", "face_front", "脸部 · 正面"],
["face", "face_45", "脸部 · 45°"],
["face", "face_profile", "脸部 · 90° 侧面"],
["face", "face_high", "脸部 · 俯角"],
["face", "face_low", "脸部 · 仰角"],
["closeup", "close_eyes", "特写 · 眼睛"],
["closeup", "close_brows", "特写 · 眉毛"],
["closeup", "close_nose", "特写 · 鼻子"],
["closeup", "close_mouth", "特写 · 嘴部"],
["closeup", "close_ears", "特写 · 耳朵"],
["closeup", "close_hair", "特写 · 发型（前/侧/后）"],
["closeup", "close_hands", "特写 · 手部"],
["closeup", "close_skin", "特写 · 肌肤质感"],
["closeup", "close_body", "特写 · 身体细节（肩/背/腿）"],
["closeup", "close_feature", "特写 · 持续特征单独特写"],
["expression", "expr_neutral", "表情 · 中性"],
["expression", "expr_smile", "表情 · 温和微笑"],
["expression", "expr_laugh", "表情 · 开怀大笑"],
["expression", "expr_thoughtful", "表情 · 沉思"],
["expression", "expr_surprised", "表情 · 惊讶"],
["expression", "expr_tearful", "表情 · 含泪克制（泪只在眼眶）"],
["expression", "expr_determined", "表情 · 坚定"],
];

const CHAR_TEXT_FIELDS = [
"identity", "ageImpression", "background", "personality", "relationships",
"lockFace", "lockEyes", "lockFeatures", "lockHair", "lockSkin", "lockBuild",
"lockProportions", "lockMarks", "variableNotes", "visualAnchor",
"expressions", "expressionLimits", "poses", "posesToAvoid", "contactRules",
"wardrobe", "wardrobeDetails", "wardrobeVersions", "persistentFeatures",
"voice", "dialogueRules", "masterPrompt", "identityPrompt", "negativePrompt",
"notes",
] as const;

function emptyCharData(): CharData {
const d: CharData = {
refs: REF_TEMPLATE.map(([groupKey, slotKey, label]) => ({
slotKey, label, groupKey,
imageKey: null, filled: false, candidateKey: null,
genStatus: "none", genError: "",
})),
voiceRefs: [],
autoFilledFields: [],
identityBaseline: [],
identityBaselineVersion: null,
changeLog: "",
extraAssets: [],
masterCandidateKey: null,
masterGenStatus: "none",
masterGenError: "",
masterGenStartedAt: null,
masterGenAttemptId: null,
masterGenNote: "",
identityTextStatus: "none",
lockBuild: "", lockEyes: "", lockFace: "", lockFeatures: "",
lockHair: "", lockMarks: "", lockProportions: "", lockSkin: "",
};
for (const f of CHAR_TEXT_FIELDS) if (!(f in d)) d[f] = "";
return d;
}

function parseCharData(raw: string): CharData {
const base = emptyCharData();
try {
const parsed = JSON.parse(raw) as Partial<CharData>;
const merged = {...base,...parsed} as CharData;
if (!Array.isArray(merged.refs)) merged.refs = base.refs;
if (!Array.isArray(merged.voiceRefs)) merged.voiceRefs = [];
if (!Array.isArray(merged.autoFilledFields)) merged.autoFilledFields = [];
if (!Array.isArray(merged.identityBaseline)) merged.identityBaseline = [];
if (!Array.isArray(merged.extraAssets)) merged.extraAssets = [];
return merged;
} catch {
return base;
}
}

/** 槽位是否有真实可用的图片（只有定版记录、原图未随包提供的不算）。 */
function slotHasRealImage(r: RefSlot): boolean {
return r.filled && r.mediaMissing !== true && r.imageKey != null;
}

function countFilled(data: CharData, imageKey: string | null): number {
// 完整度只数真实图片：1 张主肖像（有图才算）＋ 有图的定版参考格。
// filled=true 但 mediaMissing / 无 imageKey 的格子是历史定版记录，不是图片。
const slots = data.refs.filter((r) => slotHasRealImage(r)).length;
return slots + (imageKey? 1: 0);
}

function totalSlots(data: CharData): number {
return data.refs.length + 1;
}

function logLine(version: number, text: string): string {
const d = new Date();
const p = (v: number) => String(v).padStart(2, "0");
return `v${version} · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} · ${text}`;
}

async function saveCharacter(
db: DB,
row: typeof schema.characters.$inferSelect,
data: CharData,
patch: Partial<typeof schema.characters.$inferInsert> = {},
) {
const filled = countFilled(data, patch.imageKey?? row.imageKey);
await db
.update(schema.characters)
.set({
...patch,
data: JSON.stringify(data),
refsFilled: filled,
refsTotal: totalSlots(data),
updatedAt: now(),
})
.where(eq(schema.characters.id, row.id));
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- 分镜多选（人物/场景数组真源） ----------
// shots.characterIds / sceneIds 是 JSON 数组真源；旧单值 characterId /
// sceneId 是数组第一项的同步镜像。解析时数组为空才回退单值，保证迁移
// 前的老数据（只有单值）打开即呈单元素多选。所有业务链（准备检查、
// 身份冲突、派单拦截、任务单、参照包）都经下面的 helper 取全量名单，
// 不得只读第一项。
type ShotRow = typeof schema.shots.$inferSelect;

function parseShotIdArray(raw: unknown, fallback: number | null | undefined): number[] {
  let arr: unknown = null;
  if (typeof raw === "string" && raw.trim()) {
    try { arr = JSON.parse(raw); } catch { arr = null; }
  }
  const out: number[] = [];
  if (Array.isArray(arr)) {
    for (const v of arr) {
      if (typeof v === "number" && Number.isInteger(v) && v > 0 && !out.includes(v)) out.push(v);
    }
  }
  if (out.length === 0 && typeof fallback === "number" && fallback > 0) out.push(fallback);
  return out;
}

function shotCharacterIds(shot: ShotRow): number[] {
  return parseShotIdArray(shot.characterIds, shot.characterId);
}

function shotSceneIds(shot: ShotRow): number[] {
  return parseShotIdArray(shot.sceneIds, shot.sceneId);
}

/** 换场景判定（多选口径）：两镜场景集合有交集＝连续场景（共享场景承接），
 *  完全不相交才算换场景、链条重置；任一镜未选场景时不算换场景（与旧
 *  单值口径一致）。多选不解除严格链：不相交照样重置、相交照样严格承接。 */
function shotScenesBreak(prev: ShotRow, cur: ShotRow): boolean {
  const a = shotSceneIds(prev);
  const b = shotSceneIds(cur);
  if (a.length === 0 || b.length === 0) return false;
  return !b.some((id) => a.includes(id));
}

/** 去重保序并过滤不属于本项目的 id（updateShot / 拆镜写入共用）。 */
function sanitizeShotIds(ids: number[], valid: Set<number>): number[] {
  const out: number[] = [];
  for (const id of ids) {
    if (Number.isInteger(id) && valid.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 本镜人物/场景有序名单：分镜多选（按选择顺序）在前，画布连线补充在后。 */
function shotCharSceneIdArrays(
  shot: ShotRow,
  links: Array<typeof schema.canvasLinks.$inferSelect>,
): { charIds: number[]; sceneIds: number[] } {
  const charIds = shotCharacterIds(shot);
  const sceneIds = shotSceneIds(shot);
  for (const l of links) {
    if (l.toKind !== "shot" || l.toId !== shot.id) continue;
    if (l.fromKind === "character" && !charIds.includes(l.fromId)) charIds.push(l.fromId);
    if (l.fromKind === "scene" && !sceneIds.includes(l.fromId)) sceneIds.push(l.fromId);
  }
  return { charIds, sceneIds };
}

// ---------- 首帧链式解析（三级取帧） ----------

interface ResolvedFrame {
key: string | null;
mediaMissing: boolean;
source: "own" | "adopted" | "latest" | "planned" | null;
fromShotOrder: number | null;
}

function resolveFirstFrame(
shot: typeof schema.shots.$inferSelect,
shotsSorted: Array<typeof schema.shots.$inferSelect>,
results: Array<typeof schema.results.$inferSelect>,
): ResolvedFrame {
if (shot.firstFrameKey)
return { key: shot.firstFrameKey, mediaMissing: false, source: "own", fromShotOrder: null};
if (shot.firstFrameMissing)
return { key: null, mediaMissing: true, source: "own", fromShotOrder: null};
const idx = shotsSorted.findIndex((x) => x.id === shot.id);
if (idx <= 0)
return { key: null, mediaMissing: false, source: null, fromShotOrder: null};
const prev = shotsSorted[idx - 1];
if (!prev)
return { key: null, mediaMissing: false, source: null, fromShotOrder: null};
// 换场景链条重置（多选口径：场景集合完全不相交才重置，共享任一场景仍连续）
if (shotScenesBreak(prev, shot))
return { key: null, mediaMissing: false, source: null, fromShotOrder: null};
const prevResults = results
.filter((r) => r.shotId === prev.id)
.sort((a, b) => b.createdAt - a.createdAt);
const adopted = prevResults.find((r) => r.adopted === 1);
if (adopted) {
if (adopted.actualLastFrameKey)
return { key: adopted.actualLastFrameKey, mediaMissing: false, source: "adopted", fromShotOrder: prev.sortOrder};
if (adopted.lastFrameMissing)
return { key: null, mediaMissing: true, source: "adopted", fromShotOrder: prev.sortOrder};
}
const latest = prevResults.find(
(r) => r.genStatus === "done" && (r.actualLastFrameKey || r.lastFrameMissing),
);
if (latest) {
if (latest.actualLastFrameKey)
return { key: latest.actualLastFrameKey, mediaMissing: false, source: "latest", fromShotOrder: prev.sortOrder};
return { key: null, mediaMissing: true, source: "latest", fromShotOrder: prev.sortOrder};
}
if (prev.lastFrameKey)
return { key: prev.lastFrameKey, mediaMissing: false, source: "planned", fromShotOrder: prev.sortOrder};
if (prev.lastFrameMissing)
return { key: null, mediaMissing: true, source: "planned", fromShotOrder: prev.sortOrder};
return { key: null, mediaMissing: false, source: null, fromShotOrder: null};
}

function isSceneBreak(prev: typeof schema.shots.$inferSelect, cur: typeof schema.shots.$inferSelect): boolean {
  return shotScenesBreak(prev, cur);
}
function isAutoFilled(shot: typeof schema.shots.$inferSelect): boolean {
  return !!shot.firstFrameKey && shot.firstFrameLabel.startsWith("自动带入");
}
/** 严格链判定：返回 null 表示可派单，否则返回阻塞原因（中文，含补法）。 */
function strictChainBlock(
  project: typeof schema.projects.$inferSelect,
  shot: typeof schema.shots.$inferSelect,
  shotsSorted: Array<typeof schema.shots.$inferSelect>,
  results: Array<typeof schema.results.$inferSelect>,
  canvasFirstHasImage: boolean,
): string | null {
  if ((project as unknown as { chainStrict?: number }).chainStrict === 0) return null;
  const idx = shotsSorted.findIndex((x) => x.id === shot.id);
  // 第一镜本来就没有上一镜尾帧：不按缺尾帧阻塞，它走方式 A（上传图
  // 锚点）/方式 B（脚本＋档案＋场景严格生成），见任务单。换场景镜头在
  // 此返回 null 是原有的链条重置口径（首帧独立定位，由生成准备检查的
  // 独立定位规则处理；锁版不查首尾帧定位），不走方式 B 兜底。
  if (idx <= 0) return null;
  const prev = shotsSorted[idx - 1];
  if (!prev) return null;
  if (isSceneBreak(prev, shot)) return null;
  if (shot.firstFrameKey) return null; // 自有或已自动填入的真实首帧图
  if (canvasFirstHasImage) return null;
  const rf = resolveFirstFrame(shot, shotsSorted, results);
  if (rf.key && !rf.mediaMissing && (rf.source === "adopted" || rf.source === "latest")) return null;
  if (rf.source === "planned") {
    return `严格链阻塞：第 ${shot.sortOrder + 1} 镜的首帧现在只有第 ${prev.sortOrder + 1} 镜的「目标尾帧」规划图，还没有上一段视频的真实尾帧图。严格参照要求以真实尾帧图像本身为首帧，不得只按规划图/标签生成。请先生成第 ${prev.sortOrder + 1} 镜、回填成片并截取/上传其真实尾帧，尾帧会自动填入本镜后再生成本镜；或为本镜上传一张自有首帧图解除链式依赖。`;
  }
  if (rf.mediaMissing) {
    return `严格链阻塞：第 ${shot.sortOrder + 1} 镜要承接第 ${prev.sortOrder + 1} 镜，但上一段的尾帧只有记录、原图缺失，无法严格以图像为首帧参照。请在质检页为上一镜的采用/最新回填版本补上真实尾帧图（截取当前帧为尾帧或上传尾帧图），它会自动填入本镜；或为本镜上传自有首帧图。`;
  }
  return `严格链阻塞：第 ${shot.sortOrder + 1} 镜是连续镜头，必须严格以第 ${prev.sortOrder + 1} 镜视频的真实尾帧图像为首帧，现在上一段还没有可用的真实尾帧（未生成、未回填，或回填时没带尾帧）。不得只按首帧标签/文字描述放行。请先完成上一段生成并确保其真实尾帧已回填——它会自动填入本镜首帧——再生成本镜；或为本镜上传自有首帧图解除依赖。`;
}

// ---------- 第一镜：没有上一镜尾帧时的两种生成方式（仅第一镜） ----------
// 用户口径（2026-10-30）：第一镜按理没有尾帧可参考，只能二选一——
// 方式 A：用户上传了首帧参考图（本镜自有首帧图，或画布首帧连线带来的
//   真实图片），生成严格以那张上传图为开场锚点；
// 方式 B：没上传，就严格按三类依据生成：①文字脚本（项目脚本原文＋本镜
//   锁版文字）②人物档案里的角色参考（真实定版图＋身份锁原文）③场景卡
//   参考（场景图＋场景卡文字）。不许纯文字想象人物/场景，也不许把第一镜
//   当作在等上一镜尾帧而阻塞、更不许声称它有一张不存在的尾帧。
// 范围（用户二次确认）：这两种方式只适用于第一镜这一种情形。第一镜
// 之外的任何镜头（含换场景镜头）缺上一镜真实尾帧时仍按原规则处理：
// 连续镜头严格阻塞、换场景镜头独立定位首帧，不得用文字/档案兜底代替，
// 也不得用不存在的尾帧标签冒充。
// 只有定版记录、原图缺失的首帧不算方式 A（没有真实图片可锚定），落回 B。

type NoTailMode = "uploaded" | "archive_scene";

function isNoTailShot(
  shot: typeof schema.shots.$inferSelect,
  shotsSorted: Array<typeof schema.shots.$inferSelect>,
): boolean {
  const idx = shotsSorted.findIndex((x) => x.id === shot.id);
  return idx <= 0;
}

/** 人物真实参考图数：主肖像（有图）＋有真实图片的定版参考格。 */
function charRealImageCount(c: typeof schema.characters.$inferSelect): number {
  const d = parseCharData(c.data);
  return (c.imageKey ? 1 : 0) + d.refs.filter((r) => slotHasRealImage(r)).length;
}

/** 本镜出场人物/场景 id 集合：分镜多选设置＋画布连线（与任务单、引用清单同口径）。 */
function shotCharSceneIds(
  shot: typeof schema.shots.$inferSelect,
  links: Array<typeof schema.canvasLinks.$inferSelect>,
): { charIds: Set<number>; sceneIds: Set<number> } {
  const { charIds, sceneIds } = shotCharSceneIdArrays(shot, links);
  return { charIds: new Set(charIds), sceneIds: new Set(sceneIds) };
}

async function propagateTailToNext(
  db: DB,
  projectId: number,
  fromShotId: number,
  tailKey: string,
  versionLabel: string,
): Promise<void> {
  const shotsSorted = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, projectId))).sort((a, b) => a.sortOrder - b.sortOrder);
  const idx = shotsSorted.findIndex((x) => x.id === fromShotId);
  if (idx < 0) return;
  const fromShot = shotsSorted[idx];
  const next = shotsSorted[idx + 1];
  if (!fromShot || !next) return;
  if (isSceneBreak(fromShot, next)) return;
  if (next.firstFrameKey && !isAutoFilled(next)) return; // 手动自有首帧不覆盖
  await db.update(schema.shots).set({
    firstFrameKey: tailKey, firstFrameMissing: 0,
    firstFrameLabel: `自动带入 · 第 ${fromShot.sortOrder + 1} 镜真实尾帧${versionLabel ? ` ${versionLabel}` : ""}`,
    updatedAt: now(),
  }).where(eq(schema.shots.id, next.id));
}

// ---------- 参照图像本身传入（全工具通用 · 所有项目/所有分镜/所有参考类型） ----------
// 病根（2026-10-30 实测）：视频派单此前只把人物/场景/首尾帧的「名字与
// 标签」写进任务单文本，生成通道从没见过图像本身——人物档案里有主
// 肖像与 9 张定版图，第 1 镜照样按纯文字生成出不像的人。人物生图通道
// 早已修对（参照包导出为真实文件、随执行指令把文件路径给助手、助手
// 把图片本身传入生图），视频通道本轮同口径补齐：派单/领取执行时把
// 本镜全部参照图（首帧图、上一镜真实尾帧、人物定版图、场景图、目标
// 尾帧、画布连线/节点图）经特权层导出为真实图片文件，文件清单随执行
// 指令交给助手，助手必须把这些图片文件本身作为图片输入传入生成。
// 指定了却没有图像的参照逐项进 missing 清单：人物无任何真实定版图
// 时派单直接拦截（见 dispatchRefBlock），其余缺图在任务单与执行指令
// 里明示缺哪一张，绝不静默按文字生成、绝不假装已参照。

interface ShotVisualRef { label: string; role: string; key: string }

async function collectShotVisualRefs(
  db: DB,
  project: typeof schema.projects.$inferSelect,
  shot: typeof schema.shots.$inferSelect,
): Promise<{ items: ShotVisualRef[]; missing: string[] }> {
  const items: ShotVisualRef[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const push = (label: string, role: string, key: string | null) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push({ label, role, key });
  };
  const allChars = await db.select().from(schema.characters).where(eq(schema.characters.projectId, project.id));
  const allScenes = await db.select().from(schema.scenes).where(eq(schema.scenes.projectId, project.id));
  const links = await db.select().from(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, project.id));
  const nodes = await db.select().from(schema.canvasNodes).where(eq(schema.canvasNodes.projectId, project.id));
  const shotsSorted = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, project.id))).sort((a, b) => a.sortOrder - b.sortOrder);
  const results = await db.select().from(schema.results).where(eq(schema.results.projectId, project.id));
  const { charIds, sceneIds } = shotCharSceneIds(shot, links);
  // 1. 首帧图：自有/上传首帧，或承接的上一镜真实尾帧（adopted/latest）。
  const rf = resolveFirstFrame(shot, shotsSorted, results);
  if (rf.key && !rf.mediaMissing && rf.source !== "planned") {
    push(
      rf.source === "own" ? "本镜首帧图（上传/自有）" : `上一镜真实尾帧（第 ${(rf.fromShotOrder ?? 0) + 1} 镜，本镜首帧）`,
      "首帧图（开场帧，必须与该图一致）",
      rf.key,
    );
  } else if (shot.firstFrameMissing) {
    missing.push(`第 ${shot.sortOrder + 1} 镜自有首帧只有定版记录、原图缺失，没有首帧图像可传入`);
  }
  // 画布首帧连线来源图（与自有/承接首帧不同源时补入）。
  for (const l of links.filter((x) => x.toKind === "shot" && x.toId === shot.id && x.role === "firstframe")) {
    const key = l.fromKind === "character" ? allChars.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "scene" ? allScenes.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "node" ? nodes.find((x) => x.id === l.fromId)?.mediaKey : l.fromKind === "shot" ? results.filter((r) => r.shotId === l.fromId).sort((a, b) => b.createdAt - a.createdAt).find((r) => r.actualLastFrameKey)?.actualLastFrameKey ?? shotsSorted.find((x) => x.id === l.fromId)?.lastFrameKey : null;
    if (key) push("画布首帧连线指定图", "首帧图（画布连线指定）", key);
    else missing.push(`画布首帧连线来源（${l.fromKind} #${l.fromId}）没有可用图片，未能传入`);
  }
  // 2. 人物定版图：按本镜多选顺序逐人导出——主定锚点第一、基准顺序、
  // 其余定版图（buildRefPack 同口径）；多个人物一个都不能少。
  for (const c of [...charIds].map((cid) => allChars.find((x) => x.id === cid)).filter((x) => !!x)) {
    const data = parseCharData(c.data);
    const { pack } = buildRefPack(c, data);
    if (pack.length === 0) {
      missing.push(`人物「${c.name}」没有任何真实定版图（主肖像与参考格均无真实图片），无法把该人物图像传入生成`);
      continue;
    }
    for (const pitem of pack) push(`人物「${c.name}」· ${pitem.label}`, pitem.role, pitem.key);
  }
  // 3. 场景图：按本镜多选顺序逐个场景导出，多选场景全部传入。
  for (const sc of [...sceneIds].map((sid) => allScenes.find((x) => x.id === sid)).filter((x) => !!x)) {
    if (sc.imageKey) push(`场景「${sc.name}」场景图`, "场景图（环境/光线/色板以图为准）", sc.imageKey);
    else missing.push(`场景「${sc.name}」没有场景图，环境只能按场景卡文字生成（没有场景图像可传入）`);
  }
  // 4. 画布参考节点图（reference 连线）。
  for (const l of links.filter((x) => x.toKind === "shot" && x.toId === shot.id && x.role === "reference" && x.fromKind === "node")) {
    const n = nodes.find((x) => x.id === l.fromId);
    if (n?.mediaKey) push(`画布参考节点「${n.title || "未命名"}」`, "画布参考图", n.mediaKey);
    else if (n) missing.push(`画布参考节点「${n.title || "未命名"}」没有图片，未能传入`);
  }
  // 5. 目标尾帧图（本镜须到达的结束帧）。
  if (shot.lastFrameKey) push("本镜目标尾帧图", "目标尾帧（结束帧须到达该图）", shot.lastFrameKey);
  else if (shot.lastFrameMissing) missing.push(`第 ${shot.sortOrder + 1} 镜目标尾帧只有记录、原图缺失，没有尾帧图像可传入`);
  for (const l of links.filter((x) => x.toKind === "shot" && x.toId === shot.id && x.role === "lastframe")) {
    const key = l.fromKind === "character" ? allChars.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "scene" ? allScenes.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "node" ? nodes.find((x) => x.id === l.fromId)?.mediaKey : l.fromKind === "shot" ? shotsSorted.find((x) => x.id === l.fromId)?.lastFrameKey : null;
    if (key) push("画布尾帧连线指定图", "目标尾帧（画布连线指定）", key);
    else missing.push(`画布尾帧连线来源（${l.fromKind} #${l.fromId}）没有可用图片，未能传入`);
  }
  return { items, missing };
}

interface ExportedVisualPack {
  files: Array<{ label: string; role: string; path: string }>;
  missing: string[];
  note: string;
}

/** 把参照包说明追加进任务记录：派了哪些图像文件、缺哪几张，在质检页
 *  的任务详情里可见可查，不只存在于给助手的指令文本里。 */
async function appendPackNoteToJob(db: DB, jobId: number, pack: ExportedVisualPack): Promise<void> {
  const [j] = await db.select().from(schema.genJobs).where(eq(schema.genJobs.id, jobId));
  if (!j) return;
  await db.update(schema.genJobs)
    .set({ detail: `${j.detail}｜${pack.note}`, updatedAt: now() })
    .where(eq(schema.genJobs.id, jobId));
}

/** 把本镜参照包逐张导出为真实图片文件（特权层），供执行指令随单携带。
 *  导出失败的图按缺图处理并明示，绝不悄悄只剩文字清单。 */
async function exportShotVisualPack(
  ctx: Ctx,
  project: typeof schema.projects.$inferSelect,
  shot: typeof schema.shots.$inferSelect,
  tag: string,
): Promise<ExportedVisualPack> {
  const db = ctx.db<typeof schema>();
  const { items, missing } = await collectShotVisualRefs(db, project, shot);
  const files: ExportedVisualPack["files"] = [];
  const allMissing = [...missing];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    try {
      const ex = await ctx.executePrivileged(privileged.exportRefImageFile, {
        spaceDir: ctx.spaceDir, mediaKey: it.key,
        outName: `vid-shot${shot.id}-${tag}-ref${i}`,
      });
      if (ex.error || !ex.path) {
        allMissing.push(`参照图「${it.label}」导出失败（${ex.error ?? "未返回路径"}），未能作为图像传入`);
        continue;
      }
      files.push({ label: it.label, role: it.role, path: ex.path });
    } catch (e) {
      allMissing.push(`参照图「${it.label}」导出失败（${e instanceof Error ? e.message : String(e)}），未能作为图像传入`);
    }
  }
  const note = files.length
    ? `本次参照图像（图像本身随派单传入，共 ${files.length} 张）：${files.map((f, i) => `${i + 1}.${f.label}`).join("、")}${allMissing.length ? `；缺图：${allMissing.join("；")}` : ""}`
    : `本次没有任何参照图像可传入${allMissing.length ? `（缺图：${allMissing.join("；")}）` : ""}`;
  return { files, missing: allMissing, note };
}

/** 派单前参照拦截（全工具通用）：本镜指定了出场人物、但该人物在档案
 *  里没有任何真实定版图时，严格参照无图可依——直接拦住并指名，不许
 *  静默按文字/标签生成。第一镜方式 B（无上传首帧）另加：未指定出场
 *  人物（分镜与画布连线都没有）同样拦住。场景缺图不拦（场景卡文字
 *  仍是依据），但会进任务单警告与参照缺图清单明示。 */
async function dispatchRefBlock(
  db: DB,
  project: typeof schema.projects.$inferSelect,
  shot: typeof schema.shots.$inferSelect,
): Promise<string | null> {
  const links = await db.select().from(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, project.id));
  const { charIds } = shotCharSceneIds(shot, links);
  const shotsSorted = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, project.id))).sort((a, b) => a.sortOrder - b.sortOrder);
  const noTail = isNoTailShot(shot, shotsSorted);
  const hasUploadedFirst = !!shot.firstFrameKey || links.some((l) => l.toKind === "shot" && l.toId === shot.id && l.role === "firstframe");
  if (noTail && !hasUploadedFirst && charIds.size === 0) {
    return `派单被拦下：第 ${shot.sortOrder + 1} 镜是第一镜、未上传首帧图（方式 B），但本镜未指定出场人物、画布也没有人物连线，派单读不到任何人物档案角色参考，无法严格参照生成。请先在分镜里指定出场人物（拆镜已自动指定单人项目的人物；多人项目请逐镜指定），或上传一张首帧参考图改走方式 A。未派单、未做任何更改。`;
  }
  if (charIds.size > 0) {
    const allChars = await db.select().from(schema.characters).where(eq(schema.characters.projectId, project.id));
    // 多选逐个查：任一所选人物缺真实定版图都拦截，并把缺图的每个人都指名。
    const missingChars = [...charIds]
      .map((cid) => allChars.find((x) => x.id === cid))
      .filter((c): c is NonNullable<typeof c> => !!c && charRealImageCount(c) === 0);
    if (missingChars.length > 0) {
      return `派单被拦下：第 ${shot.sortOrder + 1} 镜指定的出场人物${missingChars.map((c) => `「${c.name}」`).join("、")}在人物档案里没有任何真实参考图（主肖像与定版参考格都没有真实图片）——本镜多选了 ${charIds.size} 个人物，每个人物的定版图都必须本身传入生成，缺谁的图都不能派单按文字生成。请先在人物档案为${missingChars.map((c) => `「${c.name}」`).join("、")}定版至少主肖像，再派单。未派单、未做任何更改。`;
    }
  }
  return null;
}

// ---------- 时长校验（按该镜实时分镜时长，回填不得静默接受错时长） ----------

/** 时长容差：短镜按绝对值、长镜按比例，避免 3.1 秒镜收到 10 秒片。 */
function durationToleranceSec(target: number): number {
  return Math.max(0.6, target * 0.2);
}

/** 从 MP4/MOV 字节里读 mvhd 时长（无 ffprobe 的字节回填通道用）；
 *  读不到（WebM 等）返回 null，表示该通道无法判时长、跳过校验，
 *  文件直读通道另有 ffprobe 校验兜底。 */
function parseMp4DurationSec(bytes: Uint8Array): number | null {
  // 找 'mvhd' box 类型标记
  let idx = -1;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x6d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x68 && bytes[i + 3] === 0x64) { idx = i; break; }
  }
  if (idx < 0) return null;
  const version = bytes[idx + 4] ?? 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (version === 1) {
      const timescale = dv.getUint32(idx + 4 + 4 + 16);
      const durHi = dv.getUint32(idx + 4 + 4 + 20);
      const durLo = dv.getUint32(idx + 4 + 4 + 24);
      const duration = durHi * 4294967296 + durLo;
      return timescale > 0 ? duration / timescale : null;
    }
    const timescale = dv.getUint32(idx + 4 + 4 + 8);
    const duration = dv.getUint32(idx + 4 + 4 + 12);
    return timescale > 0 ? duration / timescale : null;
  } catch {
    return null;
  }
}

/** 时长不符的拒绝文案；时长读不到或在容差内返回 null。 */
function durationMismatchError(target: number, actual: number | null, shotOrder: number): string | null {
  if (actual == null || !(actual > 0) || !(target > 0)) return null;
  const tol = durationToleranceSec(target);
  if (Math.abs(actual - target) <= tol) return null;
  return `回填被拒绝：成片时长 ${actual.toFixed(2)} 秒与第 ${shotOrder + 1} 镜实时分镜时长 ${target} 秒不符（差 ${(actual - target).toFixed(2)} 秒，容差 ±${tol.toFixed(2)} 秒）。不得把错时长的成片当作本镜成片静默落卡：请按 ${target} 秒重新生成，或经文件直读通道回填（过长时服务端会自动裁切到 ${target} 秒并明示）。未做任何更改，本版本仍无成片。`;
}

// ---------- 身份与动作分离（档案是身份唯一来源） ----------
// 病根（用户实测）：脚本提示词写「长发」、人物档案是短发时，任务单把
// 档案图、档案身份文字与脚本文字平铺给生成通道，模型在冲突时跟了文
// 字（长发），档案图被当成次要参考，成片就不像档案里的人。
// 区分规则（全工具通用）：
//  · 人物档案（主定版肖像＋定版参考图＋身份锁原文）是身份唯一来源，
//    决定脸、发型长度与样式、发色、服装、体型、年龄感等不变特征；
//  · 脚本/分镜提示词只决定本镜动作、场景、运镜、光线、情绪，不决定身份。
// 派单时逐项比对脚本侧身份描述与档案身份：冲突项在任务单明示警告，
// 并从生成提示词中剥离——生成指令的身份段只写档案身份，动作段只保
// 留剥离后的动作/场景/运镜。想用脚本里的新身份（如长发），必须先更
// 新人物档案（改身份文字、重新生成主肖像与参考图并定版）再派单，
// 不靠提示词临时改身份。

interface IdentityConflict {
  characterId: number;
  characterName: string;
  field: string;
  scriptValue: string;
  archiveValue: string;
}

function findHairLength(text: string): string | null {
  if (!text) return null;
  if (text.includes("超长发")) return "长发";
  if (text.includes("中长发")) return "中长发";
  if (text.includes("长发") || text.includes("长直发") || text.includes("黑长直")) return "长发";
  if (text.includes("短发") || text.includes("寸头") || text.includes("超短发")) return "短发";
  return null;
}
function findHairStyle(text: string): string | null {
  if (!text) return null;
  if (text.includes("卷发") || text.includes("波浪卷")) return "卷发";
  if (text.includes("直发") || text.includes("黑长直")) return "直发";
  return null;
}
function findHairColor(text: string): string | null {
  if (!text) return null;
  const table: Array<[string, string]> = [
    ["黑色头发", "黑发"], ["黑发", "黑发"], ["黑长直", "黑发"],
    ["金色头发", "金发"], ["金发", "金发"],
    ["棕色头发", "棕发"], ["棕发", "棕发"], ["褐发", "棕发"],
    ["红色头发", "红发"], ["红发", "红发"],
    ["白色头发", "白发"], ["白发", "白发"],
    ["银发", "银发"], ["灰发", "灰发"], ["蓝发", "蓝发"], ["粉发", "粉发"],
  ];
  for (const [pat, val] of table) if (text.includes(pat)) return val;
  return null;
}
const GARMENT_WORDS = ["亚麻长裙", "连衣裙", "长裙", "短裙", "白裙", "黑裙", "红裙", "蓝裙", "旗袍", "和服", "西装", "军装", "制服", "校服", "牛仔裤", "短裤", "长裤", "T恤", "衬衫", "毛衣", "外套", "大衣", "围巾", "长裤", "裙子", "长衫", "短衫"];
function findGarments(text: string): string[] {
  const out: string[] = [];
  for (const g of GARMENT_WORDS) if (text.includes(g) && !out.includes(g)) out.push(g);
  return out;
}
function findAgeLabel(text: string): string | null {
  if (!text) return null;
  const table = ["十几岁", "二十多岁", "二十岁", "三十多岁", "三十岁", "四十多岁", "四十岁", "五十岁", "少女", "少年", "青年", "中年", "老年", "老人", "小孩", "儿童"];
  for (const t of table) if (text.includes(t)) return t;
  return null;
}
function findBuildLabel(text: string): string | null {
  if (!text) return null;
  const table = ["高挑", "娇小", "健壮", "强壮", "瘦弱", "清瘦", "肥胖", "微胖", "苗条", "纤细", "魁梧"];
  for (const t of table) if (text.includes(t)) return t;
  return null;
}

/** 档案侧身份文本（按类别取最权威的字段组合）。 */
function archiveIdentityTexts(data: CharData): { hair: string; wardrobe: string; age: string; build: string; all: string } {
  const hair = [s(data.lockHair), s(data.identityPrompt), s(data.masterPrompt), s(data.visualAnchor)].join("\n");
  const wardrobe = [s(data.wardrobe), s(data.wardrobeDetails), s(data.identityPrompt), s(data.masterPrompt)].join("\n");
  const age = [s(data.ageImpression), s(data.identity), s(data.identityPrompt), s(data.masterPrompt)].join("\n");
  const build = [s(data.lockBuild), s(data.lockProportions), s(data.identityPrompt), s(data.masterPrompt)].join("\n");
  return { hair, wardrobe, age, build, all: [hair, wardrobe, age, build, s(data.persistentFeatures)].join("\n") };
}

/** 脚本侧文本：本镜分镜提示词字段（动作/起止/站位/英文提示词）。
 *  单人项目时项目脚本正文也是脚本提示词的一部分（人物锁定段常写在
 *  脚本开头），一并纳入比对；多人项目脚本正文归属不明，不纳入。 */
function scriptIdentityText(
  project: typeof schema.projects.$inferSelect,
  shot: typeof schema.shots.$inferSelect,
  singleCharProject: boolean,
): string {
  const parts = [shot.startState, shot.action, shot.endState, shot.characterPosition, shot.promptEn, shot.handoffNote];
  if (singleCharProject && project.scriptText) parts.push(project.scriptText);
  return parts.join("\n");
}

/** 逐人逐项比对脚本身份描述与档案身份，返回冲突清单（无冲突返回空）。 */
function detectIdentityConflicts(
  project: typeof schema.projects.$inferSelect,
  shot: typeof schema.shots.$inferSelect,
  shotChars: Array<typeof schema.characters.$inferSelect>,
): IdentityConflict[] {
  const out: IdentityConflict[] = [];
  if (shotChars.length === 0) return out;
  const scriptText = scriptIdentityText(project, shot, shotChars.length === 1);
  const sHairLen = findHairLength(scriptText);
  const sHairStyle = findHairStyle(scriptText);
  const sHairColor = findHairColor(scriptText);
  const sGarments = findGarments(scriptText);
  const sAge = findAgeLabel(scriptText);
  const sBuild = findBuildLabel(scriptText);
  for (const c of shotChars) {
    const data = parseCharData(c.data);
    const arc = archiveIdentityTexts(data);
    const aHairLen = findHairLength(arc.hair);
    if (sHairLen && aHairLen && sHairLen !== aHairLen)
      out.push({ characterId: c.id, characterName: c.name, field: "发型长度", scriptValue: sHairLen, archiveValue: aHairLen });
    const aHairStyle = findHairStyle(arc.hair);
    if (sHairStyle && aHairStyle && sHairStyle !== aHairStyle)
      out.push({ characterId: c.id, characterName: c.name, field: "发型样式", scriptValue: sHairStyle, archiveValue: aHairStyle });
    const aHairColor = findHairColor(arc.hair);
    if (sHairColor && aHairColor && sHairColor !== aHairColor)
      out.push({ characterId: c.id, characterName: c.name, field: "发色", scriptValue: sHairColor, archiveValue: aHairColor });
    const aGarments = findGarments(arc.wardrobe);
    if (sGarments.length && aGarments.length) {
      const onlyScript = sGarments.filter((g) => !aGarments.includes(g));
      // 档案写了具体服装、脚本写了档案里没有的服装 → 服装冲突（脚本服装剥离）。
      if (onlyScript.length && aGarments.some((g) => !sGarments.includes(g)))
        out.push({ characterId: c.id, characterName: c.name, field: "服装", scriptValue: onlyScript.join("、"), archiveValue: aGarments.join("、") });
    }
    const aAge = findAgeLabel(arc.age);
    // 年龄感只在人生阶段明显不同才算冲突（少女/二十岁同属年轻阶段，
    // 不误报）：年轻（少女/少年/青年/十几岁/二十多岁）vs 中年
    // （中年/三十多岁/四十多岁）vs 年长（老年/五十岁以上）。
    if (sAge && aAge && sAge !== aAge) {
      const ageGroup = (v: string) => (["老年", "老人", "五十岁"].includes(v) ? "old" : ["中年", "三十岁", "三十多岁", "四十岁", "四十多岁"].includes(v) ? "mid" : "young");
      if (ageGroup(sAge) !== ageGroup(aAge))
        out.push({ characterId: c.id, characterName: c.name, field: "年龄感", scriptValue: sAge, archiveValue: aAge });
    }
    const aBuild = findBuildLabel(arc.build);
    if (sBuild && aBuild && sBuild !== aBuild)
      out.push({ characterId: c.id, characterName: c.name, field: "体型", scriptValue: sBuild, archiveValue: aBuild });
  }
  return out;
}

/** 把冲突的身份词从一段脚本/分镜文本里剥离：冲突词不进入生成提示词，
 *  只保留动作、场景、运镜、光线、情绪。复合词（如「黑色长直发」）整段
 *  优先剥离，避免只删一半留下残词继续误导生成。 */
function stripIdentityTokens(text: string, conflicts: IdentityConflict[]): string {
  if (!text || conflicts.length === 0) return text;
  let out = text;
  // 按冲突类别给出要剥离的全部写法变体（长发类含长直发/黑长直等复合词，
  // 否则只删「长发」二字会留下「直发」残词继续误导生成）。
  const variants: Record<string, string[]> = {
    "长发": ["黑色长直发", "黑长直", "长直发", "超长发", "长发"],
    "中长发": ["中长发"],
    "短发": ["超短发", "短发", "寸头"],
    "直发": ["黑色长直发", "黑长直", "长直发", "直发"],
    "卷发": ["波浪卷发", "卷发", "波浪卷"],
    "黑发": ["黑色头发", "黑发", "黑长直"],
    "金发": ["金色头发", "金发"],
    "棕发": ["棕色头发", "棕发", "褐发"],
    "红发": ["红色头发", "红发"],
    "白发": ["白色头发", "白发"],
    "银发": ["银发"], "灰发": ["灰发"], "蓝发": ["蓝发"], "粉发": ["粉发"],
  };
  for (const cf of conflicts) {
    const toks = cf.scriptValue.split("、").filter(Boolean);
    for (const tok of toks) {
      const list = variants[tok] ?? [tok];
      // 先剥长写法再剥短写法，避免残词。
      for (const v of [...list].sort((a, b) => b.length - a.length)) out = out.split(v).join("");
      if (!variants[tok]) out = out.split(tok).join("");
    }
  }
  return out.replace(/[，,、；;]{2,}/g, "，").replace(/^[，,、\s]+/, "").replace(/\s{2,}/g, " ");
}

function conflictSummaryLine(cf: IdentityConflict): string {
  return `${cf.scriptValue}→档案${cf.archiveValue}`;
}

// ---------- 任务单组装（派单按锁定基准） ----------

interface TaskSheetOut {
text: string;
warnings: string[];
refCount: number;
}

async function buildTaskSheet(
db: DB,
project: typeof schema.projects.$inferSelect,
shot: typeof schema.shots.$inferSelect,
quality: string,
reshoot?: {
  fromVersionNumber: number;
  fromResultId: number;
  qcNote: string;
  variantSeed: string;
},
): Promise<TaskSheetOut> {
const warnings: string[] = [];
const allChars = await db
.select()
.from(schema.characters)
.where(eq(schema.characters.projectId, project.id));
const allScenes = await db
.select()
.from(schema.scenes)
.where(eq(schema.scenes.projectId, project.id));
const links = await db
.select()
.from(schema.canvasLinks)
.where(eq(schema.canvasLinks.projectId, project.id));
const nodes = await db
.select()
.from(schema.canvasNodes)
.where(eq(schema.canvasNodes.projectId, project.id));
const shotsSorted = (
await db
.select()
.from(schema.shots)
.where(eq(schema.shots.projectId, project.id))
).sort((a, b) => a.sortOrder - b.sortOrder);
const results = await db
.select()
.from(schema.results)
.where(eq(schema.results.projectId, project.id));
const frame = resolveFirstFrame(shot, shotsSorted, results);

// 多选全量：分镜多选名单（按选择顺序）＋画布连线，逐人逐场景进任务单，
// 不得只带第一项。顺序即参照编号顺序，与参照包导出一一对应。
const { charIds: charIdList, sceneIds: sceneIdList } = shotCharSceneIdArrays(shot, links);
const shotChars = charIdList.map((cid) => allChars.find((c) => c.id === cid)).filter((c) => !!c);
const shotScenes = sceneIdList.map((sid) => allScenes.find((x) => x.id === sid)).filter((x) => !!x);
const shotNodes = nodes.filter((n) =>
links.some(
(l) => l.fromKind === "node" && l.fromId === n.id && l.toKind === "shot" && l.toId === shot.id,
),
);

// 身份冲突检测：脚本侧身份描述 vs 档案身份，逐项比对。冲突词从
// 生成用文本中剥离（san* 系列），原始分镜行本身不改写。
const identityConflicts = detectIdentityConflicts(project, shot, shotChars);
for (const cf of identityConflicts) {
  warnings.push(`⚠ 身份冲突（已剥离）：人物「${cf.characterName}」的${cf.field}——脚本/分镜提示词写「${cf.scriptValue}」，人物档案是「${cf.archiveValue}」。本镜身份以档案为准：生成指令的身份段只写档案的「${cf.archiveValue}」，脚本里的「${cf.scriptValue}」已从生成提示词中剥离、不进入生成，只保留动作/场景/运镜部分。如果你其实想要「${cf.scriptValue}」，不要靠提示词临时改身份：请先更新人物档案（改${cf.field}、重新生成主肖像和参考图并定版），再派单。`);
}
const sanStartState = stripIdentityTokens(shot.startState, identityConflicts);
const sanAction = stripIdentityTokens(shot.action, identityConflicts);
const sanEndState = stripIdentityTokens(shot.endState, identityConflicts);
const sanPosition = stripIdentityTokens(shot.characterPosition, identityConflicts);
const sanPromptEn = stripIdentityTokens(shot.promptEn, identityConflicts);
const sanScriptText = stripIdentityTokens(project.scriptText, identityConflicts);
const sanHandoff = stripIdentityTokens(shot.handoffNote, identityConflicts);

const lines: string[] = [];
const order: string[] = [];
// 数据基准时间：取组装所依据数据的最新修改时间（项目/分镜/出场人物/
// 所选场景），不用组装当刻的墙钟——这样同一份数据下「派单前组装预览」
// 与正式派单冻结出的任务单逐字一致，用户在预览里看到什么、派单就冻结
// 什么；任一来源数据被改，基准时间与内容一起变，不会假装是同一份。
const snapshotAt = new Date(Math.max(
  project.updatedAt, shot.updatedAt,
  ...shotChars.map((c) => c.updatedAt),
  ...shotScenes.map((x) => x.updatedAt),
)).toISOString();
lines.push(`项目《${project.name}》 · 第 ${shot.sortOrder + 1} 镜 · 画质 ${quality}（派单冻结，不得更改）`);
lines.push(`画幅 ${project.aspect} · ${project.fps}fps · 导出规格 ${project.exportSpec} · 时长 ${shot.durationSec}s`);
lines.push(`【时长硬约束 · 按本镜实时分镜时长】本镜时长 = ${shot.durationSec} 秒——这是派单这一刻从本镜分镜行实时读到的 durationSec，不是项目目标时长、不是默认 10 秒、不得四舍五入或凑整。生成时长的参数就填 ${shot.durationSec} 秒，生成出的成片必须为 ${shot.durationSec} 秒（回填校验容差 ±${durationToleranceSec(shot.durationSec).toFixed(2)} 秒）：回填时服务端会用 ffprobe/文件头校验真实时长，过长的文件直读回填会自动裁切到 ${shot.durationSec} 秒并明示，过短或字节通道测得时长不符的回填会被拒绝，不得静默接受错时长成片。本镜时长若在派单后被修改，只影响下一单，本单仍按 ${shot.durationSec} 秒执行。`);
lines.push(`【参照图像 · 图像本身传入】本单参照不是文字清单：派单/领取执行时，服务端会把本镜全部参照图（首帧图/上一镜真实尾帧/人物定版图/场景图/目标尾帧/画布连线图，见下方清单的图像键）导出为真实图片文件，文件路径随执行指令逐张列明，生成时必须把这些图片文件本身作为图片输入传入生成通道，按清单顺序参照；只看名字、标签或文字描述另行想象，一律视为未参照。清单里标为缺图的参照没有图像可传，已在警告中逐项指名，不得假装已参照。`);
lines.push(`【派单快照冻结】本任务单是派单时刻按当前数据实时组装并冻结的快照（数据基准 ${snapshotAt}＝项目/分镜/人物档案/场景卡的最新修改时间 · 项目版本 v${project.version} · 定稿标记：${project.locked === 1 ? "已锁版（可选定稿）" : "未锁版（锁版为可选定稿，未点不拦派单）"}）：组装永远读最新值——脚本页保存后已同步回分镜的段落、本镜分镜文字、人物档案（身份锁原文与真实定版图清单）、场景卡、项目硬规则、首尾帧链与画质，都以派单这一刻台内实际存着的内容为准，不存在预先定死的旧提示词；数据不变时，派单前组装预览与本单逐字一致。派单后即使再改脚本、分镜、档案或场景，本单内容不变、不受影响；改动只会进入下一单的快照。人物一致性与首尾帧对齐靠本快照冻结的参考图与链，不靠手动锁版。`);
lines.push(`【定版图外观以图为准 · 改文字改不掉已定版的图】人物定版参照图（主定版肖像＋定版参考格）与场景图的外观——服装颜色、发型、体型等——已经画进图片本身：改脚本/分镜/档案里的文字只会改变任务单的文字段，不会改变已定版图片里的外观，图生视频以图片本身为准。所以删掉文字里的某个服装颜色词，成片仍会按定版图里的原外观生成，这不是没按新文本执行，而是图片那一层没变。要改变某个人物的外观（例如不再穿某个颜色的衣服），必须先到人物档案修改该人物并重新生成、定版其主肖像与参考图（或换图），再重新派单；同理项目硬规则（见下方原文段）与每位人物的身份段都是派单时实时读取的现行文本，预览里能逐段看到，想改哪段就去对应位置改完再派单。`);
lines.push(`【身份与动作分离 · 最高优先级】人物身份只有一个来源：人物档案（主定版肖像＋定版参考图的图片本身＋下方身份唯一来源段的身份锁原文）。脸、发型长度与样式、发色、服装、体型、年龄感等不变特征一律以档案图与档案身份为准，档案图不是次要参考。脚本/分镜提示词只决定本镜动作、场景、运镜、光线、情绪，不决定身份：脚本里任何与档案冲突的身份描述都不得用于生成（冲突项见下方检测段，已从生成提示词中剥离）。组装生成提示词时必须分开：身份段只写档案身份，动作段只用剥离后的动作/场景/运镜文字，两段不得混用、不得用脚本身份词覆盖档案身份。`);
if (identityConflicts.length) {
  lines.push(`【身份冲突检测 · 本镜身份以档案为准，已剥离】检测到 ${identityConflicts.length} 项冲突，脚本里与档案冲突的身份描述已剥离：${identityConflicts.map((cf) => `${cf.characterName}·${cf.field}：${conflictSummaryLine(cf)}（脚本「${cf.scriptValue}」不进入生成提示词）`).join("；")}。生成时身份只按档案：${identityConflicts.map((cf) => `${cf.characterName}${cf.field}＝${cf.archiveValue}`).join("；")}。如需改用脚本里的身份，先更新人物档案并重新定版参考图，再派单。`);
} else if (shotChars.length) {
  lines.push(`【身份冲突检测】本镜脚本/分镜提示词中的身份描述与人物档案未检出冲突；身份仍只以档案图与身份锁原文为准，脚本只决定动作、场景、运镜、光线与情绪。`);
}
lines.push("");
if (reshoot) {
  // 重拍单必须与上一版不同：冻结任务单「不变」是为普通派单防漂移，但重拍
  // 若逐字复用上一版任务单（同一首帧图＋同一人物参考＋同一文字），模型必然
  // 收敛出几乎一样的成片。故重拍单在最前面写入上一版质检意见与强制变化
  // 要求，并带本次专属变化标识——重拍单与上一版任务单必然逐字不同。
  lines.push("【重拍派单 · 必须生成与上一版不一样的新成片】");
  lines.push(`本单是第 ${shot.sortOrder + 1} 镜 V${reshoot.fromVersionNumber}（resultId=${reshoot.fromResultId}）质检不通过后的新派单重拍，不是重播、不是复用上一版成片；严禁把上一版成片或其任何片段当作本次成片回填（服务端会按成片 SHA-256 校验，与同镜其他版本完全相同的成片将被拒绝）。`);
  lines.push(`上一版质检意见（用户不满意的原因，本次必须逐条避开）：${reshoot.qcNote.trim() ? reshoot.qcNote.trim() : "（用户未填写具体意见，仅判定不满意）"}`);
  lines.push("保持不变（一致性底线）：人物身份与脸、服装、首帧构图与站位、场景、项目硬规则与身份锁原文——这些仍以下方冻结内容为准，不得推翻。");
  lines.push("必须变化（与上一版可感知地不同）：在不违背上一条的前提下，本次生成的动作节奏、表情幅度、动作起止时机、镜头微动/运镜细节必须与上一版明显不同，不得复刻上一版的动作轨迹、节奏与镜头运动；质检意见点名的问题优先改掉，其余维度至少改变两项。");
  lines.push(`本次重拍变化标识：${reshoot.variantSeed}（每单唯一；生成时以此标识对应的新一次生成为准，不得沿用以前任何一次的产物）。`);
  lines.push("");
}

// 身份锁三态（按锁定基准组装）
const charSections: string[] = [];
let refCount = 0;
for (const c of shotChars) {
const data = parseCharData(c.data);
const filledSlots = data.refs.filter((r) => r.filled);
const baseline = data.identityBaseline;
if (data.identityBaselineVersion == null) {
warnings.push(`⚠ 身份锁未锁定：人物「${c.name}」的身份锁尚未锁定，本单按当前档案组装，生成前请知悉。`);
} else {
const extra = filledSlots
.map((r) => r.slotKey)
.filter((k) =>!baseline.includes(k));
const hasMasterExtra =!!c.imageKey &&!baseline.includes("master");
if (extra.length > 0 || hasMasterExtra) {
warnings.push(
`⚠ 身份锁已过期：人物「${c.name}」在身份锁 v${data.identityBaselineVersion} 锁定后新增了 ${extra.length + (hasMasterExtra? 1: 0)} 张定版图，本单仍按原基准顺序在前、新图在后全量传入。`,
);
}
}
if (c.archiveStatus!== "locked") {
warnings.push(`人物「${c.name}」档案为草稿状态（v${c.archiveVersion}），任务单按现状组装，档案内容以档案页为准、未编造补齐。`);
}
const missing: string[] = [];
if (!s(data.masterPrompt)) missing.push("主提示词未填");
if (!s(data.identityPrompt)) missing.push("身份锁提示词未填");
if (missing.length)
warnings.push(`人物「${c.name}」档案缺项：${missing.join("、")}（任务单中如实标注，不编造）。`);

// 参考图顺序：链式首帧 → 主肖像（基准）→ 基准定版图（登记顺序）→ 基准外定版图 → 其余
const ordered: Array<{ label: string; note: string}> = [];
if (c.imageKey || baseline.includes("master"))
ordered.push({ label: "主定版肖像", note: "首要身份基准"});
for (const key of baseline) {
if (key === "master") continue;
const slot = data.refs.find((r) => r.slotKey === key);
if (slot && slotHasRealImage(slot)) ordered.push({ label: slot.label, note: "身份基准"});
}
for (const slot of filledSlots) {
if (!slotHasRealImage(slot)) continue;
if (baseline.includes(slot.slotKey)) continue;
ordered.push({
label: slot.label,
note: data.identityBaselineVersion!= null? "定版图（未纳入基准）": "定版图",
});
}
refCount += ordered.length;
for (const o of ordered) order.push(`人物「${c.name}」· ${o.label}（${o.note}）`);

const lockParts = [
["脸型骨骼", data.lockFace], ["眼睛", data.lockEyes], ["眉鼻嘴", data.lockFeatures],
["发型", data.lockHair], ["肌肤", data.lockSkin], ["身材比例", data.lockProportions],
["体态", data.lockBuild], ["标志特征", data.lockMarks],
].filter(([, v]) => s(v));
charSections.push(
[
`—— 人物：${c.name}（档案 v${c.archiveVersion}${data.identityBaselineVersion!= null? ` · 身份锁 v${data.identityBaselineVersion} · 基准定版图 ${baseline.length} 张 · 本单传入 ${ordered.length} 张`: " · 身份锁未锁定"}）`,
s(data.identity)? `身份：${s(data.identity)}`: "",
s(data.visualAnchor)? `视觉锚点：${s(data.visualAnchor)}`: "",
lockParts.length? `身份锁逐项：\n${lockParts.map(([k, v]) => `· ${k}：${s(v)}`).join("\n")}`: "",
s(data.persistentFeatures)? `持续特征：${s(data.persistentFeatures)}`: "",
s(data.expressionLimits)? `表现红线：${s(data.expressionLimits)}`: "",
s(data.contactRules)? `接触规矩：${s(data.contactRules)}`: "",
s(data.wardrobe)? `服装：${s(data.wardrobe)}`: "",
s(data.masterPrompt)? `主提示词：${s(data.masterPrompt)}`: "主提示词：（未填）",
s(data.identityPrompt)
? `身份锁（原文，不得改写）：${s(data.identityPrompt)}`
: "身份锁提示词：（未填）",
s(data.negativePrompt)? `负面提示词：${s(data.negativePrompt)}`: "",
data.voiceRefs.find((v) => v.isMain)
? `主声音参考：${data.voiceRefs.find((v) => v.isMain)?.name?? ""}（供台词/配音环节参照）`
: "",
]
.filter(Boolean)
.join("\n"),
);
}

// 第一镜的两种方式判定（仅第一镜适用；后续镜头不进此分支）。
const noTail = isNoTailShot(shot, shotsSorted);
let canvasFirstHasImage = false;
for (const l of links.filter((x) => x.toKind === "shot" && x.toId === shot.id && x.role === "firstframe")) {
  const k = l.fromKind === "character" ? allChars.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "scene" ? allScenes.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "node" ? nodes.find((x) => x.id === l.fromId)?.mediaKey : l.fromKind === "shot" ? shotsSorted.find((x) => x.id === l.fromId)?.lastFrameKey : null;
  if (k) canvasFirstHasImage = true;
}
const noTailMode: NoTailMode | null = noTail
  ? (shot.firstFrameKey || canvasFirstHasImage ? "uploaded" : "archive_scene")
  : null;
// 参考图清点补齐：方式 A 的上传首帧图、场景图都是真实传入的图片参照。
if (noTailMode === "uploaded" && shot.firstFrameKey) refCount += 1;
else if (noTailMode === "uploaded" && canvasFirstHasImage) refCount += 1;
for (const sc of shotScenes) if (sc.imageKey) refCount += 1;
if (noTailMode === "archive_scene") {
  // 方式 B 的依据必须真实存在，缺哪类就在任务单里如实警告，不假装严格。
  if (!project.scriptText.trim() && !shot.startState.trim())
    warnings.push(`⚠ 第一镜方式 B 依据缺失：第 ${shot.sortOrder + 1} 镜没有上传首帧，项目脚本正文为空、本镜开始状态也没填，文字脚本依据不足；请先补脚本或开始状态。`);
  if (shotChars.length === 0)
    warnings.push(`⚠ 第一镜方式 B 依据缺失：第 ${shot.sortOrder + 1} 镜未指定出场人物、画布也没有人物连线，无法读取人物档案角色参考；请指定出场人物，或改走方式 A 上传首帧图。`);
  for (const c of shotChars)
    if (charRealImageCount(c) === 0)
      warnings.push(`⚠ 第一镜方式 B 依据缺失：人物「${c.name}」在人物档案里没有任何真实参考图（主肖像与定版格都没有真实图片），本单无法把该人物的图作为参照传入，只能靠身份锁文字；请先在人物档案定版至少主肖像，或改走方式 A。`);
  if (shotScenes.length === 0)
    warnings.push(`⚠ 第一镜方式 B 依据提示：第 ${shot.sortOrder + 1} 镜未指定场景、画布也没有场景连线，无法读取场景卡参考；环境只能按本镜文字生成，请指定场景或知悉此限。`);
  for (const sc of shotScenes)
    if (!sc.imageKey)
      warnings.push(`⚠ 第一镜方式 B 依据提示：场景「${sc.name}」没有场景图，本单只能按场景卡文字（地点/时段/光线/氛围/色板）生成环境，不能以图为准；需要严格贴场景时请先给场景卡补图。`);
}

lines.push(`【本镜多选名单 · 全部生效】出场人物共 ${shotChars.length} 人：${shotChars.length ? shotChars.map((c, i) => `${i + 1}.人物「${c.name}」`).join("、") : "（未指定）"}；场景共 ${shotScenes.length} 个：${shotScenes.length ? shotScenes.map((x, i) => `${i + 1}.场景「${x.name}」`).join("、") : "（未指定）"}。多个人物同处所选场景中被参照：每个人物的定版图与身份锁文字、每个场景的场景图都逐个列入下方清单与参照包并按此顺序编号传入，不得只带第一项；不同分镜的多选组合互相独立，以本单冻结的本镜名单为准。`);
lines.push("（顺序固定，不得调整、不得以基准之外的旧图或候选图替代）");
if (noTailMode === "uploaded") {
lines.push(
`1. 首帧（第一镜方式 A · 上传参考图）：本镜是第一镜，没有上一镜尾帧可参考——${shot.firstFrameKey ? "用户上传的本镜自有首帧图" : "画布首帧连线带来的真实图片"}就是开场唯一图像锚点，生成视频的第一帧必须与该图完全一致（人物身份、姿势、站位、构图、光线、服装以该图为准），随后的人物定版图与场景图用于校正身份与环境细节，不得推翻该图的开场构图另起画面。${shot.firstFrameLabel ? ` · 标签：${shot.firstFrameLabel}` : ""}`,
);
} else if (noTailMode === "archive_scene") {
lines.push(
`1. 首帧（第一镜方式 B · 无上传图，脚本＋档案＋场景严格生成）：本镜是第一镜，没有上一镜尾帧可参考，也不存在可等待的尾帧——不得声称或虚构有尾帧参照。生成必须严格依据下方三类依据：①文字脚本（项目脚本原文＋本镜分镜文字：开始状态/动作/结束状态）②人物档案角色参考（下方逐人列出的真实定版图须实际作为图片参照传入，身份锁原文不得改写）③场景卡参考（场景图须实际作为图片参照传入，场景卡文字为准）。执行顺序：先用人物定版图＋场景图生成严格贴档案与场景的首帧静图，再以该静图驱动视频；不许跳过参照图纯文字想象人物或场景。`,
);
} else if (frame.source) {
lines.push(
`1. 链式首帧：${frame.source === "own"? "本镜自有首帧": `上一镜${frame.source === "adopted"? "已采用结果": frame.source === "latest"? "最新回填结果": "目标尾帧"}（第 ${(frame.fromShotOrder?? 0) + 1} 镜）`}${frame.mediaMissing? "（原台内图未随数据包提供，制作时按标签定位）": ""}${shot.firstFrameLabel? ` · 标签：${shot.firstFrameLabel}`: ""}`,
);
} else if (shot.firstFrameLabel) {
lines.push(`1. 首帧：无图 · 制作时定位（标签：${shot.firstFrameLabel}）——须先用档案参考图＋场景图生成严格贴档案的首帧静图，再以该图驱动视频，不许纯文字直接生成。`);
} else {
lines.push("1. 首帧：无图且无可带入尾帧——须先用档案参考图＋场景图生成严格贴档案的首帧静图，再以该图驱动视频，不许纯文字直接生成。");
}
// 画布首/尾帧连线冲突与缺图检查：不悄悄取其一、不悄悄忽略。
const frameLinksOf = (role: string) =>
  links.filter((x) => x.toKind === "shot" && x.toId === shot.id && x.role === role);
const sourceTitle = (kind: string, id: number): string =>
  kind === "character" ? (allChars.find((x) => x.id === id)?.name ?? `人物 #${id}`) :
  kind === "scene" ? (allScenes.find((x) => x.id === id)?.name ?? `场景 #${id}`) :
  kind === "node" ? (nodes.find((x) => x.id === id)?.title || `参考节点 #${id}`) :
  kind === "shot" ? `第 ${((shotsSorted.find((x) => x.id === id)?.sortOrder ?? 0) + 1)} 镜` : `${kind} #${id}`;
const sourceMediaKey = (kind: string, id: number): string | null =>
  kind === "character" ? (allChars.find((x) => x.id === id)?.imageKey ?? null) :
  kind === "scene" ? (allScenes.find((x) => x.id === id)?.imageKey ?? null) :
  kind === "node" ? (nodes.find((x) => x.id === id)?.mediaKey ?? null) :
  // 镜头来源的可用图 = 该镜最新回填结果的真实尾帧（链式承接的图），
  // 没有结果尾帧时才退到该镜的目标尾帧规划图——与参照包收集同口径。
  kind === "shot" ? (results.filter((r) => r.shotId === id && r.actualLastFrameKey).sort((a, b) => b.createdAt - a.createdAt)[0]?.actualLastFrameKey ?? shotsSorted.find((x) => x.id === id)?.lastFrameKey ?? null) : null;
for (const role of ["firstframe", "lastframe"] as const) {
  const ls = frameLinksOf(role);
  const roleLabel = role === "firstframe" ? "首帧" : "尾帧";
  if (ls.length > 1)
    warnings.push(`⚠ ${roleLabel}冲突：第 ${shot.sortOrder + 1} 镜有 ${ls.length} 条${roleLabel}连线（${ls.map((x) => sourceTitle(x.fromKind, x.fromId)).join("、")}），任务单不会悄悄取其一；请在画布连线管理里删到只剩一条后重新派单确认。`);
  for (const l of ls) {
    if (!sourceMediaKey(l.fromKind, l.fromId))
      warnings.push(`⚠ ${roleLabel}缺图：第 ${shot.sortOrder + 1} 镜的${roleLabel}连线来源「${sourceTitle(l.fromKind, l.fromId)}」没有可用图片，本单只能按标签定位、不能以图为准；请给该来源补图或改连有图的来源。`);
  }
}
if (shot.firstFrameKey && frameLinksOf("firstframe").length > 0) {
  // 自动带入的首帧（上一镜真实尾帧回填后填入）与拆镜自动连的链连线
  // （上一镜→本镜首帧）是同一个来源的两种记录，不算冲突，不警告。
  const prevShotId = shotsSorted[shotsSorted.findIndex((x) => x.id === shot.id) - 1]?.id;
  const sameChain = isAutoFilled(shot) && frameLinksOf("firstframe").every((l) => l.fromKind === "shot" && l.fromId === prevShotId);
  if (!sameChain)
    warnings.push(`⚠ 首帧冲突：第 ${shot.sortOrder + 1} 镜已有自有首帧图，又有画布首帧连线（${frameLinksOf("firstframe").map((x) => sourceTitle(x.fromKind, x.fromId)).join("、")}）；生成以任务单中逐条列出的两项为准存在歧义，请在分镜页清除自有首帧或在画布删除首帧连线，只保留一个首帧来源。`);
}
if (shot.lastFrameKey && frameLinksOf("lastframe").length > 0)
  warnings.push(`⚠ 尾帧冲突：第 ${shot.sortOrder + 1} 镜已有目标尾帧图，又有画布尾帧连线（${frameLinksOf("lastframe").map((x) => sourceTitle(x.fromKind, x.fromId)).join("、")}）；请只保留一个尾帧来源，避免生成口径不一致。`);
for (const c of shotChars) {
  const d2 = parseCharData(c.data);
  for (const r of d2.refs)
    if (r.filled && !slotHasRealImage(r))
      warnings.push(`人物「${c.name}」参考格「${r.label}」只有定版记录、原图未随数据包提供，不计入真实参考图，也不会作为图片传入；需要该角度时请在人物档案重新上传或生成定版。`);
}
for (const l of links.filter(
  (x) => x.toKind === "shot" && x.toId === shot.id && (x.role === "firstframe" || x.role === "lastframe"),
)) {
  const fromTitle =
    l.fromKind === "character" ? allChars.find((x) => x.id === l.fromId)?.name :
    l.fromKind === "scene" ? allScenes.find((x) => x.id === l.fromId)?.name :
    l.fromKind === "node" ? nodes.find((x) => x.id === l.fromId)?.title :
    l.fromKind === "shot" ? `第 ${((shotsSorted.find((x) => x.id === l.fromId)?.sortOrder ?? 0) + 1)} 镜` : "";
  if (fromTitle) {
    const hasImage = !!sourceMediaKey(l.fromKind, l.fromId);
    lines.push(
      hasImage
        ? `画布指定${l.role === "firstframe" ? "首帧" : "尾帧"}：${fromTitle}（连线图即本镜指定${l.role === "firstframe" ? "首帧" : "尾帧"}，生成时以该图为准）`
        : `画布指定${l.role === "firstframe" ? "首帧" : "尾帧"}：${fromTitle}（无图 · 仅按标签定位）`,
    );
  }
}
order.forEach((o, i) => lines.push(`${i + 2}. ${o}`));
shotScenes.forEach((sc, i) =>
lines.push(`场景定版 ${i + 1}/${shotScenes.length}：${sc.name}${sc.imageKey? "（含场景图，图像本身随参照包传入）": "（无场景图，仅场景卡文字）"}`));
for (const n of shotNodes)
lines.push(`画布参考：${n.title || "未命名节点"}${n.note? `（${n.note}）`: ""}`);
if (shot.lastFrameKey || shot.lastFrameLabel)
lines.push(`目标尾帧：${shot.lastFrameLabel || "已上传目标尾帧图"}`);
lines.push("");

lines.push("【本镜动作 · 生成用（已剥离冲突身份词，只决定动作/场景/运镜/光线/情绪，不决定身份）】派单时刻冻结；与档案冲突的身份词已按上方检测段剥离，剥离前的原文不进入生成提示词。");
lines.push(`景别：${shot.framing} · 运镜：${shot.cameraMove}`);
if (sanPosition) lines.push(`人物与站位（生成用）：${sanPosition}`);
lines.push(`开始状态（生成用）：${sanStartState}`);
lines.push(`动作（生成用）：${sanAction}`);
lines.push(`结束状态（生成用）：${sanEndState}`);
if (sanPromptEn) lines.push(`英文提示词（生成用，已剥离冲突身份词）：${sanPromptEn}`);
if (sanHandoff) lines.push(`交接备注（生成用）：${sanHandoff}`);
lines.push("");
if (noTail) {
lines.push("（文字脚本 · 生成用（已剥离冲突身份词）；第一镜方式 B 时脚本只决定剧情与动作，人物身份仍只以档案为准；方式 A 时用于核对动作与剧情）");
lines.push(sanScriptText.trim() ? sanScriptText.trim() : "（项目脚本正文未填——文字依据只有上方本镜分镜文字）");
lines.push("");
}

if (charSections.length) {
lines.push("【身份唯一来源 · 人物档案（决定脸/发型/服装/体型，脚本不得覆盖）】以下档案身份与定版图是本镜人物身份的唯一依据；生成提示词的身份段只能取自这里。");
lines.push(charSections.join("\n\n"));
lines.push("");
}
if (shotScenes.length) {
lines.push("【场景卡参考 · 全部所选场景（逐个列明，多选场景的环境/光线/色板都以各自场景卡与场景图为准）】");
shotScenes.forEach((sc, i) =>
lines.push(
`场景 ${i + 1}「${sc.name}」：地点 ${sc.location}｜时段 ${sc.timeOfDay}｜光线 ${sc.lighting}｜氛围 ${sc.atmosphere}｜色板 ${sc.palette}${sc.notes? `｜备注 ${sc.notes}`: ""}`,
));
lines.push("");
}
if (project.rules) {
lines.push("（全项目硬约束，原文）");
lines.push(project.rules);
lines.push("");
}
if (noTailMode === "uploaded") {
  lines.push("【第一镜首帧锁定 · 方式 A 上传图为准】本镜没有上一镜尾帧：第 1 项上传首帧图就是开场唯一图像锚点，生成视频的第一帧必须与该图完全一致——人物身份、姿势、站位、构图、光线、服装、道具位置、断臂等持续特征与硬规则状态都以该图为准，不得重新想象、不得换位、不得漂移。视频只能从该帧自然接续本镜动作；人物档案定版图与场景图只用于校正身份与环境细节，不得推翻锚点图的开场。");
} else if (noTailMode === "archive_scene") {
  lines.push("【第一镜生成依据锁定 · 方式 B】本镜没有上一镜尾帧，也没有上传首帧图，生成依据只有三类且必须全部实际使用：文字脚本决定剧情、动作与开场状态；人物档案的真实定版图决定人物身份、脸、发型、体型与服装（身份锁原文不得改写，定版图必须作为图片参照实际传入，不得只看文字清单）；场景图与场景卡文字决定环境、光线与色板（场景图必须实际传入）。三类依据冲突时的裁决：人物身份以人物档案图为准，环境以场景图为准，动作与剧情以脚本文字为准。禁止纯文字直接生成视频：须先按上述依据生成首帧静图，再以该图驱动视频。");
} else if (frame.key && !frame.mediaMissing && frame.source !== "planned") {
  lines.push("【严格首帧锁定 · 必须以图为准】本镜第 1 项链式首帧就是开场唯一图像依据：生成视频的第一帧必须与该尾帧图像本身完全一致——人物身份、姿势、站位、构图、光线、服装、道具位置、断臂等持续特征与硬规则状态都以该图为准，不得重新想象、不得换位、不得漂移。视频只能从该帧的姿势自然接续动作，不得跳到另一个开场画面。若该图里人物状态与文字描述冲突，以图像为准。");
} else if (frame.source === "planned") {
  warnings.push(`⚠ 严格链提示：第 ${shot.sortOrder + 1} 镜现在只有目标尾帧规划图、没有上一段真实尾帧图；严格模式下派单会被阻塞（见派单拦截），本任务单仅供核对，不得据此按标签/规划图放行生成。`);
  lines.push("【严格链未满足】本镜尚无上一段真实尾帧图像，不得只按标签或目标尾帧规划图生成；须等上一段真实尾帧自动填入后再派单。");
}
if (shot.lastFrameKey) {
  lines.push("【严格尾帧锁定】本镜最后一帧必须严格到达目标尾帧图：结束构图、站位、光线与该图一致，为下一镜首帧做好定格。");
} else {
  lines.push("【尾帧衔接要求】本镜结束画面必须定格为清晰、无运动模糊、可直接用作下一镜首帧的静帧：人物站位稳定、光线连续、硬规则状态正确。回填时必须截取成片真实最后一帧随成片一并回填，没有真实尾帧下一镜将严格阻塞。");
}
lines.push("");
lines.push(
noTail
  ? "以任务单标注的身份锁版本与基准为准：不得改写身份锁原文，不得调整参考图顺序，不得用基准之外的旧图或候选图替代。本镜是无尾帧可参考的首镜：方式 A 以用户上传首帧图为开场锚点，方式 B 以文字脚本＋人物档案参考图＋场景卡参考为全部依据；两种方式都不得虚构或等待上一镜尾帧。"
  : "以任务单标注的身份锁版本与基准为准：不得改写身份锁原文，不得调整参考图顺序，不得用基准之外的旧图或候选图替代。链式首帧以图像本身为准锁定身份、姿势、站位、构图、光线、服装与硬规则状态；身份锁文字与档案主肖像用于校正尾帧中可能的局部漂移，但不得借此推翻尾帧的构图与站位另起开场。",
);
{
  // 生成指令：身份段与动作段物理分开组装——这是执行方真正要拼给生成
  // 通道的提示词结构。身份段只含档案身份（逐人），动作段只含剥离后
  // 的本镜动作文字；两段之间明示不得互串。
  lines.push("");
  lines.push("【生成指令 · 身份段＋动作段分离组装（执行时按此结构拼提示词）】");
  lines.push("身份段（只写档案身份，决定脸/发型/发色/服装/体型/年龄感；同时以参照图像清单中的人物定版图图片本身为第一依据）：");
  if (shotChars.length) {
    for (const c of shotChars) {
      const d = parseCharData(c.data);
      const arc = archiveIdentityTexts(d);
      const bits: string[] = [];
      const hl = findHairLength(arc.hair); if (hl) bits.push(`发型长度：${hl}`);
      const hs = findHairStyle(arc.hair); if (hs) bits.push(`发型样式：${hs}`);
      const hc = findHairColor(arc.hair); if (hc) bits.push(`发色：${hc}`);
      if (s(d.lockHair)) bits.push(`发型（档案原文）：${s(d.lockHair)}`);
      if (s(d.wardrobe)) bits.push(`服装（档案原文）：${s(d.wardrobe)}`);
      if (s(d.visualAnchor)) bits.push(`视觉锚点：${s(d.visualAnchor)}`);
      lines.push(`· ${c.name}：${bits.length ? bits.join("；") : "以档案定版图与身份锁原文为准（档案未写明具体身份词）"}`);
    }
  } else {
    lines.push("· （本镜未指定出场人物，无身份段）");
  }
  lines.push("动作段（只决定动作/场景/运镜/光线/情绪，已剥离与档案冲突的身份词；不得从这里推导或改动人物身份）：");
  lines.push(`· 景别 ${shot.framing || "（未填）"} · 运镜 ${shot.cameraMove || "（未填）"} · 开始：${sanStartState || "（未填）"} · 动作：${sanAction || "（未填）"} · 结束：${sanEndState || "（未填）"}`);
  if (identityConflicts.length)
    lines.push(`· 本镜已剥离的脚本身份描述（不得写入生成提示词、不得用于生成）：${identityConflicts.map((cf) => `${cf.characterName}·${cf.field}「${cf.scriptValue}」`).join("；")}——身份按上方身份段的档案值执行。`);
  if (shotChars.length)
    lines.push(`· 出镜硬要求：本镜出场人物（${shotChars.map((c) => c.name).join("、")}）必须全部真实出现在成片画面中，服装颜色等标志以项目硬规则与档案为准；下方参照清单的图必须全部作为实际图像入参喂入生成（不是只在文字里列清单）。执行方回填前须抽至少 3 帧逐人自检并随回填带 castCheck，缺人、服装标志不符或参照未喂全一律标失败（原因写明「人物未出镜/参照未生效」并点名），不得按成功回填。`);
}
// 参照图像清单（图像键级）：任务单逐张列明本镜要传入的真实图像及其
// 在台内的图像键，派单导出文件与执行指令的文件清单与此一一对应；
// 缺图逐项列明。refCount 以这份清单为准（真实可传入的图像数）。
{
  const pack = await collectShotVisualRefs(db, project, shot);
  lines.push("");
  lines.push("【参照图像清单 · 派单时导出为真实图片文件随执行指令传入】");
  if (pack.items.length) {
    pack.items.forEach((it, i) => lines.push(`${i + 1}. ${it.label}（${it.role}）［图像键 ${it.key}］`));
  } else {
    lines.push("（本镜没有任何真实参照图像可传入——见下方缺图清单；不得假装已参照。）");
  }
  for (const m of pack.missing) lines.push(`缺图：${m}——没有图像可传入，不得静默按文字生成该参照。`);
  refCount = pack.items.length;
}
if (warnings.length) {
lines.unshift(...warnings, "");
}
return { text: lines.join("\n"), warnings, refCount};
}

/** 派单前组装预览的分段标注：按任务单里各来源段的标题锚点把全文切成
 *  连续切片（切片按顺序拼接 === 任务单全文，逐字一致由构造保证），每段
 *  标明来源与修改入口，用户派单前就能看到项目规则、逐人身份段里仍生效
 *  的旧表述并去对应位置改。锚点在最终文本（含前置警告行）里定位，警告
 *  行归入第一段（派单信息）一并展示，不藏。 */
function taskSheetSections(text: string): Array<{ key: string; label: string; text: string }> {
  const anchors: Array<{ key: string; label: string; at: number }> = [
    { key: "meta", label: "派单信息与组装警告（系统按当前数据实时组装：画质/时长/参照口径/快照冻结/定版图以图为准）", at: 0 },
    { key: "shot", label: "来源① 本镜脚本段——分镜页本镜文字（景别/运镜/站位/开始·动作·结束状态/英文提示词/交接备注；脚本页保存已同步的段落也在此）", at: text.indexOf("【本镜动作 · 生成用") },
    { key: "identity", label: "来源② 人物身份段总说明（人物身份只以人物档案为准，逐人内容紧随其后）", at: text.indexOf("【身份唯一来源 · 人物档案") },
    { key: "scenes", label: "来源③ 场景卡——场景页修改（地点/时段/光线/氛围/色板与场景图）", at: text.indexOf("【场景卡参考") },
    { key: "rules", label: "来源④ 项目规则原文——脚本页「项目硬规则」修改（全项目每一镜的任务单都带这一段，改一处全镜生效）", at: text.indexOf("（全项目硬约束，原文）") },
    {
      key: "lock", label: "首尾帧锁定口径（系统按首尾帧链与第一镜方式组装）",
      at: ["【第一镜首帧锁定", "【第一镜生成依据锁定", "【严格首帧锁定", "【严格链未满足", "【严格尾帧锁定】", "【尾帧衔接要求】"]
        .map((h) => text.indexOf(h)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1,
    },
    { key: "gen", label: "生成指令与参照清单（系统组装：身份段＋动作段分离/出镜硬要求/参照图像清单）", at: text.indexOf("【生成指令 · 身份段＋动作段分离组装") },
  ];
  // 逐人身份段：从任务单正文里扫出每位人物的段首，逐人成段。
  for (const m of text.matchAll(/—— 人物：([^（\n]+)（档案/g)) {
    anchors.push({
      key: `char-${m[1]}`,
      label: `来源② 人物「${m[1]}」身份段——人物档案页修改（身份锁原文/服装/主提示词/负面提示词；其定版图的外观以图为准，改文字改不掉图）`,
      at: m.index,
    });
  }
  const sorted = anchors.filter((a) => a.at >= 0).sort((a, b) => a.at - b.at);
  const dedup: typeof sorted = [];
  for (const a of sorted) {
    if (dedup.length && dedup[dedup.length - 1]?.at === a.at) continue;
    dedup.push(a);
  }
  return dedup.map((a, i) => ({
    key: a.key, label: a.label,
    text: text.slice(a.at, i + 1 < dedup.length ? dedup[i + 1]?.at : undefined),
  }));
}

// ---------- 成片回填落卡（所有回填通道共用同一出口） ----------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 严格链下本镜回填是否必须带真实尾帧：后面还有同场景连续镜时必须带。 */
async function strictTailFrameRequired(
  db: DB,
  r: typeof schema.results.$inferSelect,
): Promise<boolean> {
  if (r.actualLastFrameKey) return false;
  const [proj] = await db.select().from(schema.projects).where(eq(schema.projects.id, r.projectId));
  if (!proj || (proj as unknown as { chainStrict?: number }).chainStrict === 0) return false;
  const shots = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, r.projectId))).sort((a, b) => a.sortOrder - b.sortOrder);
  const cur = shots.find((x) => x.id === r.shotId);
  const nxt = cur ? shots[shots.findIndex((x) => x.id === cur.id) + 1] : undefined;
  return !!cur && !!nxt && !isSceneBreak(cur, nxt);
}

/** 把成片字节落回同一结果版本卡：存 blob、（有尾帧时）存尾帧并自动填入
 *  下一镜首帧、任务转「回填待审核」。质检/采用状态一律重置，质检通过前
 *  不得采用的拦截在 updateResult，不在这里放行。
 *  防复用旧片：新成片 SHA-256 与同镜任一其他已有版本完全相同时拒绝落卡
 *  并返回中文原因（重拍回填了旧片最常见的形态），不静默复用。返回 null
 *  表示已落卡，返回字符串表示被拒绝、未做任何更改。 */
async function finalizeReturnedVideo(
  ctx: Ctx,
  db: DB,
  r: typeof schema.results.$inferSelect,
  videoBytes: Uint8Array,
  mimeType: string,
  lastFrame: { bytes: Uint8Array; mimeType: string } | null,
  detailPrefix: string,
): Promise<string | null> {
  // 时长校验（字节通道）：MP4/MOV 可从文件头读出真实时长，与本镜实时
  // 分镜时长差超容差直接拒绝——3.1 秒镜收到 10 秒片就是在这里被拦下，
  // 不再静默落卡。文件直读通道（ingestGeneratedVideo）另有 ffprobe
  // 校验＋过长自动裁切，进入本函数时其时长已处理完毕、此处复核通过。
  {
    const [shRow] = await db.select().from(schema.shots).where(eq(schema.shots.id, r.shotId));
    if (shRow) {
      const durErr = durationMismatchError(shRow.durationSec, parseMp4DurationSec(videoBytes), shRow.sortOrder);
      if (durErr) return durErr;
    }
  }
  const sha = await sha256Hex(videoBytes);
  const siblings = await db.select().from(schema.results).where(eq(schema.results.shotId, r.shotId));
  const dup = siblings.find((x) => x.id !== r.id && x.videoSha && x.videoSha === sha);
  if (dup) {
    return `回填被拒绝：本次成片与第 V${dup.versionNumber} 版的成片完全相同（SHA-256 一致），这是复用了旧片、不是新生成的成片。重拍必须重新生成一条不一样的成片再回填；未做任何更改，本版本仍无成片。`;
  }
  const key = `result-${r.id}-video-${now()}`;
  await ctx.blobs.put(key, videoBytes, { contentType: mimeType || "video/mp4" });
  // 本地恢复：旧视频的尾帧不能用于新视频；从新媒体实际抽帧，失败则保留待补尾帧。
  if (!lastFrame) {
    try {
      const extracted = await ctx.executePrivileged(privileged.extractVideoLastFrame, { path: await ctx.resolveBlobPath(key) });
      if (!extracted.error && extracted.frameBase64) lastFrame = { bytes: decodeB64(extracted.frameBase64), mimeType: extracted.mimeType };
    } catch { /* 视频仍可人工审核，抽帧失败不冒充成功。 */ }
  }
  if (r.actualLastFrameKey) {
    const ordered = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, r.projectId))).sort((a, b) => a.sortOrder - b.sortOrder);
    const next = ordered[ordered.findIndex((shot) => shot.id === r.shotId) + 1];
    if (next && isAutoFilled(next) && next.firstFrameKey === r.actualLastFrameKey) {
      await db.update(schema.shots).set({ firstFrameKey: null, firstFrameLabel: "", firstFrameMissing: 0, updatedAt: now() }).where(eq(schema.shots.id, next.id));
    }
  }
  const patch: Partial<typeof schema.results.$inferInsert> = {
    videoKey: key, videoSha: sha, videoMissing: 0, genStatus: "done", genError: "",
    qcStatus: "pending", adopted: 0, actualLastFrameKey: null, lastFrameMissing: 0, updatedAt: now(),
  };
  if (lastFrame) {
    const fk = `result-${r.id}-lastframe-${now()}`;
    await ctx.blobs.put(fk, lastFrame.bytes, { contentType: lastFrame.mimeType || "image/jpeg" });
    patch.actualLastFrameKey = fk;
    patch.lastFrameMissing = 0;
  }
  await db.update(schema.results).set(patch).where(eq(schema.results.id, r.id));
  await db.update(schema.projects).set({ assemblyConfirmed: 0, updatedAt: now() }).where(eq(schema.projects.id, r.projectId));
  if (patch.actualLastFrameKey) {
    await propagateTailToNext(db, r.projectId, r.shotId, patch.actualLastFrameKey, `V${r.versionNumber}`);
  }
  await db
    .update(schema.genJobs)
    .set({
      status: "returned",
      detail: `${detailPrefix}状态：回填待审核（待质检）。${patch.actualLastFrameKey ? "真实尾帧已自动填入下一镜首帧，下一镜将严格以该图为首帧参照。" : "⚠ 本次回填没有带真实尾帧：下一连续镜会被严格阻塞，请在本版本截取当前帧为尾帧或上传尾帧图补齐。"}质检通过并采用后才进入拼接清单。`,
      error: "", updatedAt: now(),
    })
    .where(eq(schema.genJobs.resultId, r.id));
  ctx.invalidateQueries();
  return null;
}

// ---------- 人物参考图：锚点参照生成（全工具通用） ----------
// 病根（2026-10-30 修复）：旧 generateRefImage 只把已定版图的「名字」写进
// 文字提示词、调 generate_media 纯文字生图，生成通道从没见过主定锚点图
// 本身，身份必然漂移；且生成在动作内同步等待，一旦超时/中断，槽位永久
// 停在「生成中」，防重复守卫又把之后每次生成都拦死（卡住生成不了）。
// 新通道对全部项目、全部人物、全部参考格一视同仁：
// ① 参考格生成必须有锚点：主定版肖像就是一致性锚点；主肖像缺失时用
//    身份基准中第一张真实定版图作锚点；两者都没有 → 拦截，不按文字放行。
// ② 锚点图与全部真实定版图经特权层导出为真实图片文件，按「锚点第一 →
//    身份基准顺序 → 其余定版图」冻结成参照包，派 Muse 助手把图片本身
//    作为参照传入生图（图生图），成图经 completeRefImage 文件直读回填
//    同一格作候选图；每次生成发放尝试标识，旧尝试晚到回调拒绝。
// ③ 生成开始时间落库：超时未回填只标「状态待核查」，不自动改判、更不
//    直接重新生成；核查确认旧执行终止后用 releaseRefImageClaim 释放。
// ④ 只有「人物还没有任何真实图片、正在生成第一张主肖像（建立锚点
//    本身）」才走纯文字生图——那时世上还没有锚点图可参照。

const REF_PACK_CAP = 12;

interface RefPackItem { label: string; key: string; role: string }

function buildRefPack(
  c: typeof schema.characters.$inferSelect,
  data: CharData,
): { pack: RefPackItem[]; anchorLabel: string; omitted: number } {
  const pack: RefPackItem[] = [];
  const seen = new Set<string>();
  const push = (label: string, key: string | null, role: string) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    pack.push({ label, key, role });
  };
  let anchorLabel = "";
  if (c.imageKey) {
    anchorLabel = "主定版肖像";
    push("主定版肖像", c.imageKey, "主定锚点（身份基准，以图像本身为准）");
  } else {
    // 主肖像缺失：身份基准里第一张真实定版图临时作锚点（顺序在最前）。
    let anchorSlot: RefSlot | undefined;
    for (const key of data.identityBaseline) {
      if (key === "master") continue;
      const sl = data.refs.find((r) => r.slotKey === key);
      if (sl && slotHasRealImage(sl)) { anchorSlot = sl; break; }
    }
    if (!anchorSlot) anchorSlot = data.refs.find((r) => slotHasRealImage(r));
    if (anchorSlot) {
      anchorLabel = anchorSlot.label;
      push(anchorSlot.label, anchorSlot.imageKey, "主定锚点（身份基准，以图像本身为准）");
    }
  }
  for (const key of data.identityBaseline) {
    if (key === "master") continue;
    const sl = data.refs.find((r) => r.slotKey === key);
    if (sl && slotHasRealImage(sl)) push(sl.label, sl.imageKey, "身份基准定版图");
  }
  for (const r of data.refs) {
    if (slotHasRealImage(r)) push(r.label, r.imageKey, "已定版参考图");
  }
  let omitted = 0;
  if (pack.length > REF_PACK_CAP) {
    omitted = pack.length - REF_PACK_CAP;
    pack.length = REF_PACK_CAP;
  }
  return { pack, anchorLabel, omitted };
}

function buildRefPrompt(
  charName: string,
  data: CharData,
  label: string,
  pack: RefPackItem[],
  anchorLabel: string,
  omitted: number,
  userPrompt = "",
): string {
  const lockBits: string[] = [];
  if (data.lockFace) lockBits.push(`脸型骨骼：${data.lockFace}`);
  if (data.lockEyes) lockBits.push(`眼睛：${data.lockEyes}`);
  if (data.lockFeatures) lockBits.push(`眉鼻嘴：${data.lockFeatures}`);
  if (data.lockHair) lockBits.push(`发型：${data.lockHair}`);
  if (data.lockSkin) lockBits.push(`肌肤：${data.lockSkin}`);
  if (data.lockBuild) lockBits.push(`体态：${data.lockBuild}`);
  if (data.lockMarks) lockBits.push(`标志特征：${data.lockMarks}`);
  return [
    `为短片人物「${charName}」生成参考图：${label}。`,
    pack.length
      ? `【严格参照主定锚点图——以图为准】本次生成随附 ${pack.length} 张参考图片，第 1 张是主定锚点图（${anchorLabel}），是这个人物的唯一身份基准：必须以该图的图像本身为准生成——同一张脸、脸型骨骼、五官、发型、肌肤、体型与服装不得漂移，不得只按文字描述另行想象人物。其余随附定版图按顺序（${pack.slice(1).map((p) => p.label).join("、") || "无"}）作为角度、姿势与服装参照；任何文字描述与锚点图冲突时，以锚点图为准。${omitted ? `（另有 ${omitted} 张定版图超过单次参照上限，本次未传入。）` : ""}`
      : "",
    s(data.masterPrompt) ? `人物主提示词：${s(data.masterPrompt)}` : "",
    s(data.identityPrompt) ? `身份锁（原文，不得改写）：${s(data.identityPrompt)}` : "",
    lockBits.join("；"),
    s(data.persistentFeatures) ? `持续特征：${s(data.persistentFeatures)}` : "",
    s(data.expressionLimits) ? `表现红线：${s(data.expressionLimits)}` : "",
    s(data.contactRules) ? `接触规矩：${s(data.contactRules)}` : "",
    s(data.negativePrompt) ? `必须避免：${s(data.negativePrompt)}` : "",
    userPrompt.trim()
      ? `用户补充提示词（本次生成要求，在不违背身份锁原文与锚点图的前提下执行；与身份锁冲突时以身份锁和锚点图为准）：${userPrompt.trim()}`
      : "",
    "写实摄影风格，中性背景，人物特征清晰，便于作为后续生成的身份参考。",
  ].filter(Boolean).join("\n");
}

// ---------- 助手执行启动（视频生成走 Muse 原生通道） ----------
// 服务端动作内没有视频生成工具：派单冻结任务单后，由 ctx.agent.spawnTask
// 启动一个 Muse 助手任务领取本单，用原生 media 视频生成产出成片，再通过
// completeGenerationJob 把成片回填到同一个结果版本。启动失败不假装已执行，
// 任务保持 awaiting_assistant（待助手执行），用户可在质检页重新启动，或在
// 对话里让 Muse 领取待处理任务后用 attachResultVideo 手工回填。
//
// 回填主通道是「文件直读」（ingestGeneratedVideo）：助手生成出的成片是
// 宿主工作区里的真实文件，动作只传文件路径，服务端经特权层直接读字节
// 并截取真实尾帧，第一时间落回同一结果版本。旧的分片 base64 通道
// （beginVideoUpload → appendVideoChunk×N → completeGenerationJob）只
// 保留给浏览器端程序化上传等场景：让执行助手逐片转录约 52 万字符的
// base64 文本在实践中必然出错/中断，成片永远落不回版本卡——那正是
// 「以前能马上生成预览、后来不行」的断点所在。

/** 超时未回填 ≠ 已中断：无回填可能是原生成仍在运行，也可能是成片已
 *  生成但上传卡住。超过此时长只标记「状态待核查」，绝不自动改回待领取、
 *  更不直接重新生成。重新执行必须先核查原执行/原产物/上传状态：已有成片
 *  只恢复原结果的上传/关联；确认旧执行已终止后，用 releaseGenerationClaim
 *  显式释放并轮换尝试标识，旧尝试的晚到回调会被 attemptId 校验拒绝。 */
const GEN_STALE_MS = 30 * 60 * 1000;

function isStaleGenerating(
  job: { status: string; updatedAt: number } | null | undefined,
  hasVideo: boolean,
): boolean {
  return !!job && job.status === "generating" && !hasVideo && now() - job.updatedAt > GEN_STALE_MS;
}

function effectiveJobStatus(
  job: { status: string; updatedAt: number } | null | undefined,
  _hasVideo: boolean,
): string | null {
  if (!job) return null;
  // 状态查不明就保留原状态（generating 就是 generating），不因超时改判。
  return job.status;
}

/** 从冻结任务单解析本镜出场人物名单与参照清单张数：名单以任务单
 *  【本镜多选名单】段的「人物「…」」为准（派单时刻冻结，不随派单后
 *  改分镜漂移），参照张数以【参照图像清单】段的［图像键］条目数计。 */
function frozenCastOf(taskSheet: string | null): { names: string[]; refCount: number } {
  const names: string[] = [];
  let refCount = 0;
  if (taskSheet) {
    const m = taskSheet.match(/出场人物共 \d+ 人：([^\n；]*)/);
    if (m?.[1]) {
      for (const mm of m[1].matchAll(/人物「([^」]+)」/g)) {
        if (mm[1] && !names.includes(mm[1])) names.push(mm[1]);
      }
    }
    const idx = taskSheet.indexOf("【参照图像清单");
    if (idx >= 0) refCount = (taskSheet.slice(idx).match(/［图像键 /g) ?? []).length;
  }
  return { names, refCount };
}

/** 回填前出镜自检报告（执行方抽帧逐人核验后随成功回填带上）：
 *  framesChecked=实际查看的抽帧数；presentNames=逐帧确认真实出现在
 *  画面中的人物姓名；fedRefCount=本次生成实际作为图像入参喂入的
 *  参照图张数。服务端按冻结任务单名单与清单张数核对，缺人/喂不全
 *  一律拒绝按成功回填——杜绝「参照只写在任务单文字里、成片里没人」
 *  却落卡为成功的假回填。 */
const castCheckSchema = z.object({
  framesChecked: z.number().int().min(0).max(60),
  presentNames: z.array(z.string().max(60)).max(20),
  fedRefCount: z.number().int().min(0).max(200),
}).optional();

type CastCheck = z.infer<typeof castCheckSchema>;

/** 出镜自检门：本镜有出场人物时，成功回填必须过检。返回拒绝原因
 *  （非空即拦截）；本镜未指定出场人物（纯场景镜等）不设此门。 */
function castGateError(taskSheet: string | null, castCheck: CastCheck): string | null {
  const { names, refCount } = frozenCastOf(taskSheet);
  if (names.length === 0) return null;
  if (!castCheck) {
    return `回填被拒绝（出镜自检未做）：本镜出场人物共 ${names.length} 人（${names.join("、")}），按成功回填前必须先对成片抽帧自检，并随回填带 castCheck（framesChecked=实际查看的帧数，须≥3；presentNames=逐帧确认真实出现在画面中的人物姓名，须逐人列全；fedRefCount=本次生成实际作为图像入参喂入的参照图张数）。若自检发现有人未出镜或参照未喂全，不得按成功回填：请调用 completeGenerationJob 传 error 标失败，原因写明「人物未出镜/参照未生效：……」。未做任何更改。`;
  }
  if (castCheck.framesChecked < 3) {
    return `回填被拒绝（出镜自检帧数不足）：castCheck.framesChecked=${castCheck.framesChecked}，须从成片开头/中间/结尾抽至少 3 帧逐帧查看、逐人核对后再回填。未做任何更改。`;
  }
  const missing = names.filter((n) => !castCheck.presentNames.includes(n));
  if (missing.length > 0) {
    return `回填被拒绝（出镜自检未通过）：自检未确认出镜的人物：${missing.join("、")}。本镜出场人物（${names.join("、")}）必须全部真实出现在成片画面中，缺人不得按成功回填：请先在同一尝试内强化未出镜人物的入画要求重新生成并重新自检；仍未出镜时调用 completeGenerationJob 传 error 标失败，原因写明「人物未出镜/参照未生效：${missing.join("、")} 未出现在成片画面中」。未做任何更改。`;
  }
  if (refCount > 0 && castCheck.fedRefCount < refCount) {
    return `回填被拒绝（参照未喂全）：任务单参照清单共 ${refCount} 张，castCheck.fedRefCount=${castCheck.fedRefCount}。参照图必须全部作为实际图像入参喂给生成调用（任务单清单、参照包导出、执行指令、实际生成入参四处逐项一致），不得只传首帧/尾帧、不得因数量多丢弃人物定版图。喂不全时不要生成，请调用 completeGenerationJob 传 error 标失败并写明原因。未做任何更改。`;
  }
  return null;
}

/** 把出镜自检结论追加进任务记录，质检页可见可查。 */
async function appendCastNoteToJob(db: DB, resultId: number, castCheck: CastCheck): Promise<void> {
  if (!castCheck) return;
  const [j] = (await db.select().from(schema.genJobs).where(eq(schema.genJobs.resultId, resultId)))
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!j) return;
  const note = `出镜自检：已抽 ${castCheck.framesChecked} 帧逐人核验，确认出镜 ${castCheck.presentNames.join("、")}；参照图实际喂入 ${castCheck.fedRefCount} 张`;
  if (j.detail.includes("出镜自检：")) return;
  await db.update(schema.genJobs)
    .set({ detail: `${j.detail}｜${note}`, updatedAt: now() })
    .where(eq(schema.genJobs.id, j.id));
}

async function startAssistantExecution(
  ctx: Ctx,
  job: typeof schema.genJobs.$inferSelect,
  projectName: string,
  shotOrder: number,
  taskSheet: string,
  live?: {
    durationSec: number;
    visualFiles: Array<{ label: string; role: string; path: string }>;
    visualMissing: string[];
  },
): Promise<{ taskId: string | null; error: string | null }> {
  const db = ctx.db<typeof schema>();
  const rid = job.resultId ?? 0;
  // 服务端唯一领取：每次领取生成新的尝试标识并先落库，旧尝试的晚到回调
  // 会在 completeGenerationJob 被 attemptId 校验拒绝，不能覆盖新结果。
  const attemptNo = (job.attemptNo ?? 0) + 1;
  const attemptId = `att-${job.id}-${attemptNo}-${now().toString(36)}`;
  await db
    .update(schema.genJobs)
    .set({ attemptId, attemptNo, updatedAt: now() })
    .where(eq(schema.genJobs.id, job.id));
  // 逐人入参对齐表：按参照文件标签把每个人物的图编号分组，让执行方
  // 调用生成时能逐人核对「谁的图是第几张」，而不是只拿到一串文件后
  // 靠文字清单想象——参照只列清单、没真正喂进生成入参正是「成片里
  // 没人/不像本人」的断点。
  let castAlignNote = "";
  if (live && live.visualFiles.length) {
    const byChar = new Map<string, number[]>();
    live.visualFiles.forEach((f, i) => {
      const mm = f.label.match(/人物「([^」]+)」/);
      if (mm?.[1]) {
        const arr = byChar.get(mm[1]) ?? [];
        arr.push(i + 1);
        byChar.set(mm[1], arr);
      }
    });
    if (byChar.size) {
      const parts = [...byChar.entries()].map(
        ([name, idxs]) => `人物「${name}」的定版图是第 ${idxs.join("、")} 张（共 ${idxs.length} 张，第 ${idxs[0]} 张是其主定版肖像）`,
      );
      castAlignNote = `【逐人入参对齐 · 谁的图是第几张】${parts.join("；")}。本镜出场人物共 ${byChar.size} 人，必须全部真实出现在成片画面中（服装颜色等标志以任务单与项目硬规则为准，如深绿/亮黄不得互换或缺失）。生成调用的图像入参须与本清单逐项对上：任务单清单 ${live.visualFiles.length} 张 = 参照包导出 ${live.visualFiles.length} 个文件 = 本指令清单 ${live.visualFiles.length} 项 = 实际喂入 ${live.visualFiles.length} 张，四处一致、缺一不可。`;
    }
  }
  const message = [
    `你是导演台的生成执行助手。请为项目《${projectName}》第 ${shotOrder + 1} 镜生成一条镜头视频，生成完第一时间（秒回填）直接回填到导演台的结果版本 resultId=${rid}：成片只能落回这同一张镜头版本卡（能在卡上直接播放、下载、删除、替换），不要导到资源库/媒体库、不要只把成片发到聊天里、不要另存别处就算完成——版本卡上没有可播放成片就不算完成。`,
    `画质要求：${job.videoQuality ?? "按任务单"}；时长与内容以下方冻结任务单为准，不得改写任务单中的身份锁原文，不得调整参考图顺序。`,
    "【身份与动作分离 · 执行时必须遵守】人物身份只认任务单的「身份唯一来源」段与随单传入的人物定版图图片本身：脸、发型长度与样式、发色、服装、体型、年龄感都以档案为准，档案图是身份唯一依据、不是次要参考。任务单的动作段与脚本文字只决定动作、场景、运镜、光线、情绪，不决定身份；任务单已把脚本里与档案冲突的身份词（如脚本写长发、档案是短发）从生成提示词中剥离并在「身份冲突检测」段明示——拼生成提示词时身份段只写档案身份，绝不能把已剥离的脚本身份词捡回来、绝不能让脚本文字覆盖档案图。如果任务单的冲突段提示需要新身份，那是让用户先更新档案的事，本次执行仍按档案生成。",
    live ? `【时长硬约束 · 实时分镜】本镜时长 = ${live.durationSec} 秒（领取执行这一刻从分镜行实时读到）：生成工具的时长参数就填 ${live.durationSec}，不要用默认 10 秒、不要凑整。回填时服务端会校验真实时长：过长的文件直读回填会被自动裁切到 ${live.durationSec} 秒并明示，过短或时长不符的字节回填会被拒绝——生成前先按 ${live.durationSec} 秒出片，不要事后补救。` : "",
    live ? (live.visualFiles.length
      ? `【参照图像本身 · 必须实际传入生成通道】下面 ${live.visualFiles.length} 张图片文件是本镜派单这一刻从台内导出的人物定版图/场景图/首帧图/尾帧图本身（不是名字清单）：生成时必须把这些图片文件作为图片输入实际传入你的视频生成工具，并按顺序参照——第 1 张若标注为首帧图，它就是开场帧；人物定版图决定人物身份与脸，不得只看任务单文字另行想象人物。参考图片（顺序不得调整）：\n${live.visualFiles.map((f, i) => `${i + 1}. ${f.label}（${f.role}）：${f.path}`).join("\n")}`
      : "【参照图像本身】本镜派单这一刻没有任何参照图像被导出（见下方缺图清单）：不得假装已参照任何图片；若缺图清单涉及出场人物定版图，应先报告失败让用户补图，不要纯文字生成人物。") : "",
    castAlignNote,
    live && live.visualMissing.length ? `【参照缺图 · 明示】以下参照没有图像可传入，不得静默按文字生成、不得声称已参照：${live.visualMissing.join("；")}。其中场景图缺失时可按场景卡文字生成环境，但必须在回填说明里注明该场景无图；人物定版图缺失时不要生成该人物。` : "",
    "执行步骤：",
    `本次领取的尝试标识 attemptId=${attemptId}（第 ${attemptNo} 次尝试）。回填与报告失败时必须原样带上 attemptId；标识对不上的晚到回调会被服务端拒绝，不得覆盖更新的尝试。如果你在执行中发现已有成片文件（原产物），只恢复它的上传/关联，不要重新生成。`,
    "若任务单开头有【重拍派单】一节：这是质检不通过后的重拍，必须按其中质检意见避开上一版的问题，并在动作节奏、表情幅度、镜头微动等维度生成与上一版可感知不同的新成片；严禁拿上一版成片充当本次成片回填——服务端会按 SHA-256 校验，与同镜其他版本完全相同的成片回填会被拒绝并要求重新生成。",
    "1. 用你的原生视频生成能力（media 视频生成）按任务单生成这一镜的视频，拿到成片文件的本地路径；任务单中的身份锁原文不得改写，参考图顺序不得调整，且参考图必须以图像本身实际传入生成（不是只看文字清单）：链式首帧图、人物定版图、场景图都是图像参照。严格首帧分两种情形，按任务单第 1 项标注执行：（a）连续镜头：任务单第 1 项链式首帧图像本身就是本镜第一帧，开场的人物身份、姿势、站位、构图、光线、服装与断臂等硬规则状态必须与该图完全一致，不得只按标签/文字另行想象开场；生成时把该尾帧图作为首帧参照图实际传入，不得省略。（b）仅第一镜（没有上一镜尾帧）：方式 A 以任务单标注的用户上传首帧图为开场锚点、第一帧须与该图完全一致；方式 B 没有任何首帧图，必须把任务单列出的人物档案真实定版图与场景图实际作为图片参照传入，先按文字脚本＋人物档案＋场景卡生成严格贴合的首帧静图，再以该静图驱动视频——不得纯文字直接生成、不得等待或虚构上一镜尾帧。第一镜之外的镜头（含换场景镜头）不适用方式 B：缺上一镜真实尾帧时按任务单的严格链口径阻塞或独立定位，不得用文字/档案兜底代替。喂入方式硬性要求：调用生成时必须把上方清单的全部图片文件逐个作为生成调用的图像入参条目实际传入（在生成请求里逐个附上这些图片文件本身），不许只把首帧/尾帧当入参、其余人物图只在文字提示里提名字；不许因参照数量多自行截断、丢弃任何一位出场人物的定版图；生成工具若有单次入参数量上限，须分步把每位出场人物的主定版肖像与定版图都实际用上，实在喂不全就不要生成、直接按第 4 步标失败并写明原因。",
    "2. 【回填前强制自检 · 不过不许按成功回填】成片生成后、先回填前，必须用 ffmpeg（或等价工具）从成片开头/中间/结尾抽至少 3 帧静图并逐帧查看，按上方逐人名单逐个核对：每一位出场人物是否真实出现在画面中、服装颜色等标志是否与任务单和项目硬规则一致（不得缺人、不得两人服装互换、不得只出现与档案无关的路人）。核验结果随第 3 步回填带 castCheck 参数：framesChecked=实际查看的帧数（≥3）、presentNames=确认真实出镜的人物姓名（逐人列全）、fedRefCount=本次生成实际喂入的参照图张数（须等于上方清单总数）。任一人物未出镜、服装标志明显不符或参照未喂全：不得回填成功——先在同一次尝试内强化未出镜人物的入画要求重新生成并重新自检；仍不过时按第 4 步标失败，原因以「人物未出镜/参照未生效：」开头并点名未出镜的人物，让用户在台内看到失败原因，而不是拿到一条没人的“成功”成片。",
    `3. 自检通过后立刻（秒回填）调用导演台动作 ingestGeneratedVideo，参数：resultId=${rid}、attemptId=${attemptId}、filePath=成片文件的绝对路径（生成工具返回的 local_path，原样照抄，不要改名、不要转存到别处再传）、castCheck={framesChecked, presentNames, fedRefCount}（第 2 步自检结论，缺了会被服务端拒绝）。服务端会直接从该路径读出成片字节存回本版本卡，并用 ffmpeg 从成片本身截取真实最后一帧自动填入下一镜首帧——你不需要再截尾帧、不需要传任何 base64。严禁把视频转成 base64 文本逐字/逐片转录（数百万字符必然出错或中断，这正是旧通道卡死的原因）；若 ingestGeneratedVideo 明确返回路径不可读一类的错误，先确认路径照抄无误并重试一次，仍失败再调用 completeGenerationJob 传 attemptId=${attemptId} 与 error 写明 ingest 的真实报错，不要编造结果；若返回的是出镜自检类拒绝（未做自检/有人未出镜/参照未喂全），按拒绝原因处理：补做自检、重新生成或按第 4 步标失败，不得绕过。`,
    `4. 如果生成失败、通道不可用、参照喂不全或出镜自检最终不过，调用 completeGenerationJob 并传 attemptId=${attemptId} 与 error 写明真实原因（自检不过时以「人物未出镜/参照未生效：」开头并点名未出镜的人物），不要编造结果、不要把不合格成片按成功回填。`,
    "5. 回填后不要自行质检或采用：成片处于「回填待审核」，由用户在导演台质检页审核；质检通过前该版本不能被采用、不能进拼接清单。",
    "",
    "—— 冻结任务单 ——",
    taskSheet,
  ].join("\n");
  try {
    const tsk = await ctx.agent.spawnTask(message, {
      expectsAction: "completeGenerationJob",
      // 每次领取用独立 dedupeKey：旧任务中断/超时后重新领取必须能起新任务，
      // 不能被上一轮的 dedupe 记录挡住；并发防重由任务状态本身负责。
      dedupeKey: `video-gen-result-${job.resultId ?? job.id}-${attemptId}`,
    });
    if (!tsk.ok) {
      await db
        .update(schema.genJobs)
        .set({
          status: "awaiting_assistant",
          detail: `${job.detail}｜助手自动领取未启动：${tsk.error}。可在质检页点「交给助手执行」重试，或在对话里让 Muse 领取待处理任务。`,
          updatedAt: now(),
        })
        .where(eq(schema.genJobs.id, job.id));
      return { taskId: null, error: tsk.error };
    }
    await db
      .update(schema.genJobs)
      .set({
        status: "generating",
        detail: `${job.detail}｜Muse 助手已领取执行（任务 ${tsk.taskId}），生成中，成片将回填到本结果版本待质检。`,
        updatedAt: now(),
      })
      .where(eq(schema.genJobs.id, job.id));
    return { taskId: tsk.taskId, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(schema.genJobs)
      .set({
        status: "awaiting_assistant",
        detail: `${job.detail}｜助手自动领取未启动：${msg}。可在质检页点「交给助手执行」重试，或在对话里让 Muse 领取待处理任务。`,
        updatedAt: now(),
      })
      .where(eq(schema.genJobs.id, job.id));
    return { taskId: null, error: msg };
  }
}

// ---------- 返回形状 ----------

/** 当前拼接清单签名：采用版本+入/出点+转场+成片键。成品导出时把当时的
 *  签名存进项目，之后清单任何改动都会让签名不一致 → 界面提示成品已过期。 */
function assemblySignatureOf(
  shotsSorted: Array<typeof schema.shots.$inferSelect>,
  results: Array<typeof schema.results.$inferSelect>,
): string {
  return shotsSorted
    .map((sh) => {
      const r = results.find((x) => x.shotId === sh.id && x.adopted === 1 && x.includeInEdit === 1);
      if (!r) return `${sh.id}:none`;
      return `${sh.id}:${r.id}:${r.inPoint}:${r.outPoint ?? ""}:${r.cutType}:${r.videoKey ?? ""}`;
    })
    .join("|");
}

const projectOut = z.object({
  id: z.number(), name: z.string(), targetSeconds: z.number(),
  aspect: z.string(), fps: z.number(), exportSpec: z.string(),
  defaultQuality: z.string(), locked: z.boolean(),
  lockedAt: z.string().nullable(), version: z.number(),
  scriptTitle: z.string(), scriptText: z.string(), scriptNotes: z.string(),
  scriptStatus: z.string(), rules: z.string(), assemblyConfirmed: z.boolean(),
  chainStrict: z.boolean(),
  finalVideoKey: z.string().nullable(), finalExportedAt: z.string().nullable(),
  finalSignature: z.string(), assemblySignature: z.string(), finalStale: z.boolean(),
  history: z.array(z.string()), createdAt: z.string(), updatedAt: z.string(),
  characterCount: z.number(), sceneCount: z.number(), shotCount: z.number(),
  adoptedCount: z.number(), totalShotSeconds: z.number(),
});

function toProjectOut(
  p: typeof schema.projects.$inferSelect,
  counts?: { characters: number; scenes: number; shots: number; adopted: number; totalSec: number },
  currentSignature = "",
): z.infer<typeof projectOut> {
  let history: string[] = [];
  try {
    const h = JSON.parse(p.history) as unknown;
    if (Array.isArray(h)) history = h.filter((x): x is string => typeof x === "string");
  } catch { /* 保持空 */ }
  const finalVideoKey = (p as unknown as { finalVideoKey?: string | null }).finalVideoKey ?? null;
  const finalSignature = (p as unknown as { finalSignature?: string }).finalSignature ?? "";
  return {
    id: p.id, name: p.name, targetSeconds: p.targetSeconds, aspect: p.aspect,
    fps: p.fps, exportSpec: p.exportSpec, defaultQuality: p.defaultQuality,
    locked: p.locked === 1, lockedAt: iso(p.lockedAt), version: p.version,
    scriptTitle: p.scriptTitle, scriptText: p.scriptText,
    scriptNotes: p.scriptNotes, scriptStatus: p.scriptStatus, rules: p.rules,
    assemblyConfirmed: p.assemblyConfirmed === 1, chainStrict: (p as unknown as { chainStrict?: number }).chainStrict !== 0,
    finalVideoKey,
    finalExportedAt: iso((p as unknown as { finalExportedAt?: number | null }).finalExportedAt ?? null),
    finalSignature, assemblySignature: currentSignature,
    finalStale: !!finalVideoKey && currentSignature !== "" && currentSignature !== finalSignature,
    history,
    createdAt: iso(p.createdAt) ?? "", updatedAt: iso(p.updatedAt) ?? "",
    characterCount: counts?.characters ?? 0, sceneCount: counts?.scenes ?? 0,
    shotCount: counts?.shots ?? 0, adoptedCount: counts?.adopted ?? 0,
    totalShotSeconds: counts?.totalSec ?? 0,
  };
}

const refSlotOut = z.object({
  slotKey: z.string(), label: z.string(), groupKey: z.string(),
  custom: z.boolean(), imageKey: z.string().nullable(), filled: z.boolean(),
  mediaMissing: z.boolean(), candidateKey: z.string().nullable(),
  genStatus: z.string(), genError: z.string(),
  // 生成追踪：开始时间、本次参照说明、是否已超时待核查（生成中超过阈值
  // 不等于已中断，只标待核查，须核查后显式释放才能重新生成）。
  genStartedAt: z.string().nullable(), genNote: z.string(), genStaleUnknown: z.boolean(),
});

const characterOut = z.object({
  id: z.number(), projectId: z.number(), name: z.string(),
  archiveStatus: z.string(), archiveVersion: z.number(),
  archiveLockedAt: z.string().nullable(),
  refsFilled: z.number(), refsTotal: z.number(),
  imageKey: z.string().nullable(),
  masterCandidateKey: z.string().nullable(),
  masterGenStatus: z.string(), masterGenError: z.string(),
  masterGenStartedAt: z.string().nullable(), masterGenNote: z.string(), masterGenStaleUnknown: z.boolean(),
  identityBaselineVersion: z.number().nullable(),
  identityBaselineCount: z.number(),
  identityTextStatus: z.string(),
  autoFilledFields: z.array(z.string()),
  changeLog: z.string(), extraAssets: z.array(z.string()),
  canvasX: z.number().nullable(), canvasY: z.number().nullable(),
  fields: z.record(z.string(), z.string()),
  refs: z.array(refSlotOut),
  voiceRefs: z.array(z.object({
    id: z.string(), name: z.string(), key: z.string(),
    mimeType: z.string(), isMain: z.boolean(),
  })),
});

function toCharacterOut(
  c: typeof schema.characters.$inferSelect,
): z.infer<typeof characterOut> {
  const data = parseCharData(c.data);
  const fields: Record<string, string> = {};
  for (const f of CHAR_TEXT_FIELDS) fields[f] = s(data[f]);
  return {
    id: c.id, projectId: c.projectId, name: c.name,
    archiveStatus: c.archiveStatus, archiveVersion: c.archiveVersion,
    archiveLockedAt: typeof data.archiveLockedAt === "number" ? iso(data.archiveLockedAt) : null,
    // 按真实图片实时重算，不沿用可能把缺图记录算进去的旧计数列。
    refsFilled: countFilled(data, c.imageKey), refsTotal: totalSlots(data), imageKey: c.imageKey,
    masterCandidateKey: data.masterCandidateKey,
    masterGenStatus: data.masterGenStatus, masterGenError: data.masterGenError,
    masterGenStartedAt: iso(nn(data.masterGenStartedAt)),
    masterGenNote: s(data.masterGenNote),
    masterGenStaleUnknown:
      data.masterGenStatus === "running" &&
      (nn(data.masterGenStartedAt) == null ||
        now() - (nn(data.masterGenStartedAt) ?? 0) > GEN_STALE_MS),
    identityBaselineVersion: data.identityBaselineVersion,
    identityBaselineCount: data.identityBaseline.length,
    identityTextStatus: data.identityTextStatus,
    autoFilledFields: data.autoFilledFields,
    changeLog: data.changeLog, extraAssets: data.extraAssets,
    canvasX: c.canvasX, canvasY: c.canvasY, fields,
    refs: data.refs.map((r) => ({
      slotKey: r.slotKey, label: r.label, groupKey: r.groupKey,
      custom: r.custom === true, imageKey: r.imageKey, filled: r.filled,
      mediaMissing: r.mediaMissing === true, candidateKey: r.candidateKey,
      genStatus: r.genStatus, genError: r.genError,
      genStartedAt: iso(r.genStartedAt ?? null),
      genNote: r.genNote ?? "",
      // 无开始时间的「生成中」是旧版遗留卡死状态，同样按待核查呈现。
      genStaleUnknown:
        r.genStatus === "running" &&
        (typeof r.genStartedAt !== "number" ||
          now() - r.genStartedAt > GEN_STALE_MS),
    })),
    voiceRefs: data.voiceRefs,
  };
}

const sceneOut = z.object({
  id: z.number(), projectId: z.number(), name: z.string(),
  location: z.string(), timeOfDay: z.string(), lighting: z.string(),
  atmosphere: z.string(), palette: z.string(), notes: z.string(),
  imageKey: z.string().nullable(),
  // 场景图生成：候选图（待审核，通过才设为场景图）、生成状态与参照说明。
  candidateKey: z.string().nullable(),
  genStatus: z.string(), genError: z.string(),
  genStartedAt: z.string().nullable(), genNote: z.string(),
  genPrompt: z.string(), genCharIds: z.array(z.number()),
  genStaleUnknown: z.boolean(),
  canvasX: z.number().nullable(), canvasY: z.number().nullable(),
});

const resultOut = z.object({
  id: z.number(), shotId: z.number(), versionNumber: z.number(),
  label: z.string(), genStatus: z.string(), genError: z.string(),
  videoKey: z.string().nullable(), videoMissing: z.boolean(),
  actualLastFrameKey: z.string().nullable(), lastFrameMissing: z.boolean(),
  qcStatus: z.string(), qcNote: z.string(), adopted: z.boolean(),
  includeInEdit: z.boolean(), inPoint: z.number(),
  outPoint: z.number().nullable(), cutType: z.string(),
  videoQuality: z.string().nullable(), taskSheet: z.string().nullable(),
  jobStatus: z.string().nullable(),
  createdAt: z.string(),
});

const shotRefOut = z.object({
  kind: z.string(), refId: z.number(), title: z.string(), role: z.string(),
  mediaKey: z.string().nullable(), mediaMissing: z.boolean(), detail: z.string(),
});

const prepTargetOut = z.object({
  tab: z.string(), shotId: z.number().nullable(), characterId: z.number().nullable(),
  sceneId: z.number().nullable(), slotKey: z.string().nullable(),
  field: z.string().nullable(), resultId: z.number().nullable(),
});

const prepIssueOut = z.object({
  code: z.string(), severity: z.enum(["blocked", "warn"]),
  message: z.string(), actionLabel: z.string(), target: prepTargetOut,
});

const prepOut = z.object({
  level: z.enum(["ok", "blocked", "warn"]),
  issues: z.array(prepIssueOut),
});

const shotOut = z.object({
  id: z.number(), projectId: z.number(), sortOrder: z.number(),
  durationSec: z.number(), framing: z.string(), cameraMove: z.string(),
  characterId: z.number().nullable(), sceneId: z.number().nullable(),
  characterIds: z.array(z.number()), sceneIds: z.array(z.number()),
  characterPosition: z.string(), startState: z.string(), action: z.string(),
  endState: z.string(), handoffNote: z.string(),
  firstFrameLabel: z.string(), firstFrameKey: z.string().nullable(),
  firstFrameMissing: z.boolean(),
  lastFrameLabel: z.string(), lastFrameKey: z.string().nullable(),
  lastFrameMissing: z.boolean(),
  videoQuality: z.string().nullable(), promptEn: z.string(),
  canvasX: z.number().nullable(), canvasY: z.number().nullable(),
  resolvedFirstFrame: z.object({
    key: z.string().nullable(), mediaMissing: z.boolean(),
    source: z.string().nullable(), fromShotOrder: z.number().nullable(),
  }),
  chain: z.object({
    autoFilled: z.boolean(), isFirst: z.boolean(), sceneBreak: z.boolean(),
    status: z.string(), detail: z.string(),
    // 无尾帧首镜的生成方式：uploaded=方式 A 上传图锚点；
    // archive_scene=方式 B 脚本＋人物档案＋场景卡严格生成；
    // chained=连续镜头走尾帧链；own=连续镜头自有首帧。
    mode: z.string(),
    charRefCount: z.number(), sceneHasImage: z.boolean(),
  }),
  references: z.array(shotRefOut),
  // 身份冲突（脚本身份描述 vs 档案身份）：派单前提示与任务单剥离同口径，
  // 界面据此区分「人物档案身份区」与「分镜提示词区」并明示已剥离项。
  identityConflicts: z.array(z.object({
    characterId: z.number(), characterName: z.string(), field: z.string(),
    scriptValue: z.string(), archiveValue: z.string(),
  })),
  prep: prepOut,
  results: z.array(resultOut),
});

function toResultOut(
  r: typeof schema.results.$inferSelect,
  jobStatus: string | null = null,
): z.infer<typeof resultOut> {
  return {
    id: r.id, shotId: r.shotId, versionNumber: r.versionNumber, label: r.label,
    genStatus: r.genStatus, genError: r.genError, videoKey: r.videoKey,
    videoMissing: r.videoMissing === 1, actualLastFrameKey: r.actualLastFrameKey,
    lastFrameMissing: r.lastFrameMissing === 1, qcStatus: r.qcStatus,
    qcNote: r.qcNote, adopted: r.adopted === 1,
    includeInEdit: r.includeInEdit === 1, inPoint: r.inPoint,
    outPoint: r.outPoint, cutType: r.cutType, videoQuality: r.videoQuality,
    taskSheet: r.taskSheet, jobStatus, createdAt: iso(r.createdAt) ?? "",
  };
}

const jobOut = z.object({
  id: z.number(), shotId: z.number().nullable(), resultId: z.number().nullable(),
  characterId: z.number().nullable(), kind: z.string(), status: z.string(),
  videoQuality: z.string().nullable(), detail: z.string(), error: z.string(),
  attemptId: z.string().nullable(), attemptNo: z.number(), staleUnknown: z.boolean(),
  createdAt: z.string(),
});

const nodeOut = z.object({
  id: z.number(), kind: z.string(), title: z.string(), note: z.string(),
  mediaKey: z.string().nullable(), mimeType: z.string().nullable(),
  x: z.number(), y: z.number(),
});

const linkOut = z.object({
  id: z.number(), fromKind: z.string(), fromId: z.number(),
  toKind: z.string(), toId: z.number(), role: z.string(), note: z.string(),
});

// ---------- 逐镜生成准备检查（只读，不改数据、不触发任何生成） ----------
// 口径与现有生成规则一致：blocked = 按现行规则真的进行不下去（空镜、缺动作、
// 首帧未定位且无标签、连续镜头等不到上镜尾帧且无标签）；warn = 能继续但有
// 明确问题（未锁版仅作可选定稿提示——不拦派单、派单自动冻结快照，指定参考实际无图、首尾帧来源冲突、承接首帧原图缺失、
// 定版记录缺图、已有任务进行中）。参考集没凑满 28 项不算问题，不在此列。

function computeShotPrep(
  p: typeof schema.projects.$inferSelect,
  sh: typeof schema.shots.$inferSelect,
  rf: ResolvedFrame,
  references: Array<z.infer<typeof shotRefOut>>,
  shotsSorted: Array<typeof schema.shots.$inferSelect>,
  results: Array<typeof schema.results.$inferSelect>,
  jobs: Array<typeof schema.genJobs.$inferSelect>,
  links: Array<typeof schema.canvasLinks.$inferSelect>,
  charRows: Array<typeof schema.characters.$inferSelect>,
): z.infer<typeof prepOut> {
  type Issue = z.infer<typeof prepIssueOut>;
  const issues: Issue[] = [];
  const n = sh.sortOrder + 1;
  const tgt = (partial: Partial<Issue["target"]>): Issue["target"] => ({
    tab: "shots", shotId: sh.id, characterId: null, sceneId: null,
    slotKey: null, field: null, resultId: null, ...partial,
  });

  const isEmpty =
    !sh.action.trim() && !sh.startState.trim() && !sh.endState.trim() &&
    shotCharacterIds(sh).length === 0 && shotSceneIds(sh).length === 0 && !sh.framing.trim();
  if (isEmpty) {
    issues.push({
      code: "empty_shot", severity: "blocked",
      message: `第 ${n} 镜是空镜头：动作、人物、场景、起止状态都还没填，不能算已准备好。`,
      actionLabel: "去补充本镜", target: tgt({ field: "action" }),
    });
  } else if (!sh.action.trim()) {
    issues.push({
      code: "action_missing", severity: "blocked",
      message: `第 ${n} 镜缺少「一个动作」：派单要求每镜只有一个明确动作。`,
      actionLabel: "去填动作", target: tgt({ field: "action" }),
    });
  }

  if (p.locked !== 1) {
    issues.push({
      code: "not_locked", severity: "warn",
      message: "当前未锁版——锁版是可选的定稿标记，不点也能派单。本次派单将按当前分镜冻结：服务端会自动冻结当前脚本、分镜、人物档案参考、场景卡参考与首尾帧链生成任务单快照，生成中再改分镜不会影响这一单，下一单才用新版。",
      actionLabel: "去脚本页看可选锁版", target: tgt({ tab: "script", shotId: null }),
    });
  }

  // 身份冲突（脚本身份描述 vs 档案身份）：不阻塞派单，但派单前必须
  // 明示——本镜身份以档案为准，脚本冲突词已剥离、不进入生成提示词；
  // 想改身份先更新档案并重新定版参考图（与任务单同口径）。
  {
    const icIds = new Set<number>(shotCharacterIds(sh));
    for (const r of references) if (r.kind === "character") icIds.add(r.refId);
    const icChars = [...icIds].map((cid) => charRows.find((x) => x.id === cid)).filter((c) => !!c);
    const conflicts = detectIdentityConflicts(p, sh, icChars);
    for (const cf of conflicts) {
      issues.push({
        code: "identity_conflict", severity: "warn",
        message: `第 ${n} 镜身份冲突：脚本/分镜提示词里人物「${cf.characterName}」的${cf.field}写的是「${cf.scriptValue}」，人物档案是「${cf.archiveValue}」。本镜身份以档案为准，脚本里与档案冲突的身份描述已剥离：${conflictSummaryLine(cf)}——派单时生成指令的身份段只写档案的「${cf.archiveValue}」，脚本的「${cf.scriptValue}」不进入生成提示词，只保留动作/场景/运镜。如果你其实想要「${cf.scriptValue}」，请先更新人物档案（改${cf.field}、重新生成主肖像和参考图并定版），再派单，不要靠提示词临时改身份。`,
        actionLabel: "去人物档案更新身份",
        target: tgt({ tab: "characters", characterId: cf.characterId, field: "master" }),
      });
    }
  }

  // 首尾帧来源冲突（与任务单的冲突警告同一口径）
  const firstLinks = links.filter((l) => l.toKind === "shot" && l.toId === sh.id && l.role === "firstframe");
  const lastLinks = links.filter((l) => l.toKind === "shot" && l.toId === sh.id && l.role === "lastframe");
  // 自动带入首帧＋拆镜自动链连线（上一镜→本镜）是同一来源，不算冲突。
  const prevForChain = shotsSorted[shotsSorted.findIndex((x) => x.id === sh.id) - 1];
  const sameChainPrep = isAutoFilled(sh) && firstLinks.length > 0 && firstLinks.every((l) => l.fromKind === "shot" && l.fromId === prevForChain?.id);
  if (firstLinks.length > 1 || (sh.firstFrameKey && firstLinks.length > 0 && !sameChainPrep)) {
    issues.push({
      code: "firstframe_conflict", severity: "warn",
      message: `第 ${n} 镜首帧来源冲突：${sh.firstFrameKey ? "已有自有首帧图，又有画布首帧连线" : `有 ${firstLinks.length} 条画布首帧连线`}，派单口径会有歧义，请只保留一个首帧来源。`,
      actionLabel: "去画布管理连线", target: tgt({ tab: "canvas", field: "firstframe" }),
    });
  }
  if (lastLinks.length > 1 || (sh.lastFrameKey && lastLinks.length > 0)) {
    issues.push({
      code: "lastframe_conflict", severity: "warn",
      message: `第 ${n} 镜尾帧来源冲突：${sh.lastFrameKey ? "已有目标尾帧图，又有画布尾帧连线" : `有 ${lastLinks.length} 条画布尾帧连线`}，请只保留一个尾帧来源。`,
      actionLabel: "去画布管理连线", target: tgt({ tab: "canvas", field: "lastframe" }),
    });
  }

  // 首帧定位与连续镜头承接
  const idx = shotsSorted.findIndex((x) => x.id === sh.id);
  const prev = idx > 0 ? shotsSorted[idx - 1] : undefined;
  // 仅第一镜：没有上一镜尾帧，走方式 A（上传图）或方式 B
  // （脚本＋人物档案＋场景卡严格生成），不因「没有尾帧/没有首帧标签」阻塞；
  // 但方式 B 声称依据的脚本、人物真实参考图必须真实存在，否则明确列出。
  // 后续镜头（含换场景）不进此分支，仍走下方原有定位/阻塞规则。
  const noTailShot = !prev;
  const canvasFirstImg = references.some((r) => r.role === "firstframe" && !r.mediaMissing);
  const firstModeA = !!sh.firstFrameKey || canvasFirstImg;
  if (noTailShot && !firstModeA) {
    if (!p.scriptText.trim() && !sh.startState.trim()) {
      issues.push({
        code: "first_script_missing", severity: "blocked",
        message: `第 ${n} 镜是第一镜、未上传首帧（方式 B），但项目脚本正文为空、本镜开始状态也没填，文字脚本依据不足，无法严格按脚本生成。`,
        actionLabel: "去补脚本/开始状态", target: tgt({ tab: "script", shotId: null }),
      });
    }
    const charIdsB = new Set<number>(shotCharacterIds(sh));
    for (const r of references) if (r.kind === "character") charIdsB.add(r.refId);
    if (charIdsB.size === 0) {
      issues.push({
        code: "first_char_missing", severity: "blocked",
        message: `第 ${n} 镜未上传首帧（方式 B），但本镜未指定出场人物、画布也没有人物连线，无法读取人物档案里的角色参考严格生成。请指定出场人物（可多选），或上传一张首帧参考图改走方式 A。`,
        actionLabel: "去指定出场人物", target: tgt({ field: "character" }),
      });
    } else {
      // 多选逐个查：缺图的每个人单独指名（不能只查第一项、也不能等全员缺图才报）。
      const charsB = [...charIdsB].map((cid) => charRows.find((x) => x.id === cid)).filter((c) => !!c);
      for (const c of charsB) {
        if (charRealImageCount(c) === 0) {
          issues.push({
            code: "first_char_no_image", severity: "blocked",
            message: `第 ${n} 镜未上传首帧（方式 B），本镜多选的出场人物「${c.name}」在人物档案里没有任何真实参考图（主肖像与定版格都没有真实图片），严格生成无图可依。请先在人物档案为「${c.name}」定版至少主肖像，或为本镜上传首帧图改走方式 A。`,
            actionLabel: "去人物档案补图", target: tgt({ tab: "characters", characterId: c.id, field: "master" }),
          });
        }
      }
    }
    const hasSceneRef = shotSceneIds(sh).length > 0 || references.some((r) => r.kind === "scene");
    if (!hasSceneRef) {
      issues.push({
        code: "first_scene_missing", severity: "warn",
        message: `第 ${n} 镜未上传首帧（方式 B），且未指定场景、画布也没有场景连线：无法读取场景卡参考，环境只能按本镜文字生成。建议指定场景卡，或知悉此限。`,
        actionLabel: "去指定场景", target: tgt({ field: "scene" }),
      });
    }
  }
  // 全工具通用（不限第一镜）：本镜指定了出场人物（分镜设置或画布
  // 连线）、但该人物在档案里没有任何真实定版图时，严格参照无图可依，
  // 派单会被服务端拦下——这里同步列为阻塞，与派单口径一致，不让界面
  // 显示可派、服务端又静默按文字生成。第一镜方式 B 已在上方逐项列过
  // 的不重复列。
  if (!(noTailShot && !(!!sh.firstFrameKey || canvasFirstImg))) {
    const idsAll = new Set<number>(shotCharacterIds(sh));
    for (const r of references) if (r.kind === "character") idsAll.add(r.refId);
    for (const cid of idsAll) {
      const c = charRows.find((x) => x.id === cid);
      if (c && charRealImageCount(c) === 0) {
        issues.push({
          code: "char_no_image", severity: "blocked",
          message: `第 ${n} 镜指定了出场人物「${c.name}」，但该人物在人物档案里没有任何真实参考图（主肖像与定版格都没有真实图片）：派单必须把人物定版图本身传入生成，没有图会被拦下，不能按文字生成。请先在人物档案定版至少主肖像。`,
          actionLabel: "去人物档案补图", target: tgt({ tab: "characters", characterId: c.id, field: "master" }),
        });
      }
    }
  }
  if (sh.firstFrameMissing) {
    issues.push({
      code: "own_first_missing", severity: "warn",
      message: `第 ${n} 镜自有首帧只有记录、原图缺失：派单只能按标签定位，不能以图为准。`,
      actionLabel: "去补首帧图", target: tgt({ field: "firstframe" }),
    });
  } else if (!rf.source) {
    if (!prev) {
      // 仅第一镜：没有尾帧是正常的，不按「首帧未定位」阻塞，也不要求
      // 首帧标签——方式 A/B 的依据检查已在上方逐项列出。
    } else if (isSceneBreak(prev, sh)) {
      if (!sh.firstFrameLabel.trim()) {
        issues.push({
          code: "first_unresolved", severity: "blocked",
          message: `第 ${n} 镜与上一镜的场景组合完全不相交（换场景），链条重置、首帧不自动带入，且本镜还没有首帧标签定位（换场景镜头不走第一镜方式 B 兜底）。与上一镜共享任一所选场景时按连续场景承接、不在此列。`,
          actionLabel: "去定位首帧", target: tgt({ field: "firstframe" }),
        });
      }
    } else if (!sh.firstFrameLabel.trim()) {
      issues.push({
        code: "waiting_prev_tail", severity: "blocked",
        message: `连续镜头在等上镜：第 ${prev.sortOrder + 1} 镜尚无可用尾帧（没有采用/回填结果的真实尾帧，也没有目标尾帧），本镜首帧无法自动带入，本镜也没有首帧标签可定位。`,
        actionLabel: "查看来源镜头", target: tgt({ shotId: prev.id, field: "lastframe" }),
      });
    } else {
      issues.push({
        code: "waiting_prev_tail", severity: (p as unknown as { chainStrict?: number }).chainStrict !== 0 ? "blocked" : "warn",
        message: (p as unknown as { chainStrict?: number }).chainStrict !== 0
          ? `严格链阻塞：第 ${prev.sortOrder + 1} 镜尚无真实尾帧图像可带入，本镜只有首帧标签「${sh.firstFrameLabel}」——严格参照不认标签定位，必须等上一段真实尾帧自动填入后才能生成，或为本镜上传自有首帧图。`
          : `第 ${prev.sortOrder + 1} 镜尚无可用尾帧可带入，本镜首帧暂按标签「${sh.firstFrameLabel}」定位；上镜有可用尾帧后会自动带入。`,
        actionLabel: "查看来源镜头", target: tgt({ shotId: prev.id, field: "lastframe" }),
      });
    }
  } else if (rf.source === "planned" && prev && p.chainStrict !== 0) {
    issues.push({
      code: "strict_planned_only", severity: "blocked",
      message: `严格链阻塞：第 ${n} 镜现在只有第 ${prev.sortOrder + 1} 镜的目标尾帧规划图，还没有上一段视频的真实尾帧图。严格参照必须以真实尾帧图像本身为首帧，不得只按规划图/标签放行。请先生成上一镜并回填其真实尾帧（会自动填入本镜），或为本镜上传自有首帧图。`,
      actionLabel: "查看来源镜头", target: tgt({ shotId: prev.id, field: "lastframe" }),
    });
  } else if (rf.mediaMissing && rf.source !== "own") {
    const prevResults = results
      .filter((r) => r.shotId === (prev?.id ?? -1))
      .sort((a, b) => b.createdAt - a.createdAt);
    const srcResult = rf.source === "adopted"
      ? prevResults.find((r) => r.adopted === 1)
      : rf.source === "latest"
        ? prevResults.find((r) => r.genStatus === "done")
        : undefined;
    issues.push({
      code: "chained_first_missing", severity: (p as unknown as { chainStrict?: number }).chainStrict !== 0 ? "blocked" : "warn",
      message: (p as unknown as { chainStrict?: number }).chainStrict !== 0
        ? `严格链阻塞：第 ${n} 镜的承接首帧来自第 ${(rf.fromShotOrder ?? 0) + 1} 镜尾帧，但那张尾帧原图缺失，无法严格以图像为首帧。请为来源版本补真实尾帧图，或为本镜上传自有首帧图。`
        : `第 ${n} 镜的承接首帧来自第 ${(rf.fromShotOrder ?? 0) + 1} 镜尾帧，但那张尾帧原图缺失：派单只能按标签定位。`,
      actionLabel: "查看来源",
      target: srcResult
        ? tgt({ tab: "qc", shotId: prev?.id ?? sh.id, resultId: srcResult.id })
        : tgt({ shotId: prev?.id ?? sh.id, field: "lastframe" }),
    });
  }

  // 指定参考实际无图
  for (const r of references) {
    if (!r.mediaMissing) continue;
    if (r.kind === "character") {
      issues.push({
        code: "ref_no_image", severity: "warn",
        message: `指定参考「${r.title}」（${r.detail}）实际无图：人物主肖像还没有真实图片，派单不会以图为准。`,
        actionLabel: "去补人物图", target: tgt({ tab: "characters", characterId: r.refId, field: "master" }),
      });
    } else if (r.kind === "scene") {
      issues.push({
        code: "ref_no_image", severity: "warn",
        message: `指定参考「${r.title}」（${r.detail}）实际无图：该场景还没有场景图。`,
        actionLabel: "去补场景图", target: tgt({ tab: "scenes", sceneId: r.refId }),
      });
    } else if (r.kind === "node") {
      issues.push({
        code: "ref_no_image", severity: "warn",
        message: `画布参考节点「${r.title}」实际无图：连线只剩文字说明。`,
        actionLabel: "去画布查看", target: tgt({ tab: "canvas" }),
      });
    } else {
      issues.push({
        code: "ref_no_image", severity: "warn",
        message: `连线来源「${r.title}」实际无图：该镜对应的帧图缺失。`,
        actionLabel: "查看来源镜头",
        target: tgt({ shotId: r.refId, field: r.role === "firstframe" ? "firstframe" : "lastframe" }),
      });
    }
  }

  // 出场人物的定版记录缺图（只有记录、没有真实图片的格子）：多选逐人查。
  const refCharIds = new Set<number>(shotCharacterIds(sh));
  for (const r of references) if (r.kind === "character") refCharIds.add(r.refId);
  for (const cid of refCharIds) {
    const c = charRows.find((x) => x.id === cid);
    if (!c) continue;
    const data = parseCharData(c.data);
    const missingRecs = data.refs.filter((x) => x.filled && !slotHasRealImage(x));
    if (missingRecs.length > 0) {
      issues.push({
        code: "char_records_missing", severity: "warn",
        message: `人物「${c.name}」有 ${missingRecs.length} 格只有定版记录、原图缺失（${missingRecs.slice(0, 3).map((x) => x.label).join("、")}${missingRecs.length > 3 ? "等" : ""}）：不计入真实参考数，也不会作为图片传入任务单。`,
        actionLabel: "去人物档案查看",
        target: tgt({ tab: "characters", characterId: c.id, slotKey: missingRecs[0]?.slotKey ?? null, field: "refs" }),
      });
    }
  }

  // 已有任务进行中
  for (const r of results.filter((x) => x.shotId === sh.id)) {
    const job = jobs.find((j) => j.resultId === r.id);
    if (!job || r.videoKey) continue;
    const jobSt = effectiveJobStatus(job, !!r.videoKey);
    if (r.genStatus === "running" && (jobSt === "awaiting_assistant" || jobSt === "generating" || jobSt === "dispatched")) {
      issues.push({
        code: "job_active", severity: "warn",
        message: isStaleGenerating(job, false)
          ? `已有任务状态待核查：V${r.versionNumber} 已「生成中」超过 30 分钟未回填，不等于已中断（可能仍在生成或成片卡在上传）。不要重复派单、不要直接重新生成：先核查原执行/原产物/上传状态，已有成片只恢复上传；确认旧执行终止后才能在质检页释放领取。`
          : `已有任务进行中：V${r.versionNumber} 处于「${jobSt === "generating" ? "生成中" : "待助手执行"}」，不要重复派单；重试领取在质检页对该版本操作，不产生新版本。`,
        actionLabel: "查看任务", target: tgt({ tab: "qc", resultId: r.id }),
      });
    }
  }

  const level = issues.some((x) => x.severity === "blocked")
    ? "blocked"
    : issues.length > 0
      ? "warn"
      : "ok";
  return { level, issues };
}

// ---------- 动作 ----------

export const Actions = {
  importPackage: deskAction({
    request: z.object({}),
    response: z.object({ imported: z.boolean(), projectCount: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const existing = await db.select({ id: schema.projects.id }).from(schema.projects);
      if (existing.length > 0) return { imported: false, projectCount: existing.length };
      if (SEED_PROJECTS.length === 0) return { imported: false, projectCount: 0 };

      const ASSET_CHAR: Record<string, Record<string, string>> = {
        "2": { "2": "asset:son-a", "3": "asset:father-v7" },
        "3": { "4": "asset:tractor-man" },
      };
      const ASSET_SCENE: Record<string, Record<string, string>> = {
        "2": { "1": "asset:yard" },
        "3": { "3": "asset:tractor-field" },
      };
      const EXTRA_ASSETS: Record<string, string[]> = { "2:2": ["asset:son-b"] };

      let count = 0;
      for (const raw of SEED_PROJECTS) {
        const pack = raw as Record<string, unknown>;
        const proj = pack.project as Record<string, unknown>;
        const oldPid = String(proj.id);
        const t = now();
        const [pRow] = await db
          .insert(schema.projects)
          .values({
            name: s(proj.name),
            targetSeconds: nn(proj.targetSeconds) ?? 30,
            aspect: s(proj.aspect) || "1392×640",
            fps: nn(proj.fps) ?? 24,
            exportSpec: s(proj.exportSpec) || "H.264 yuv420p · 恒定帧率 · 可导入剪映",
            defaultQuality: s(proj.defaultVideoQuality) || "720P",
            locked: proj.locked === true ? 1 : 0,
            lockedAt: typeof proj.lockedAt === "string" ? parseMs(proj.lockedAt) : null,
            version: nn(proj.version) ?? 1,
            scriptTitle: s(proj.scriptTitle), scriptText: s(proj.scriptText),
            scriptNotes: s(proj.scriptNotes),
            scriptStatus: s(proj.scriptStatus) || "draft",
            rules: s(proj.rules),
            assemblyConfirmed: proj.assemblyConfirmed === true ? 1 : 0,
            history: JSON.stringify([`由导演台数据包（2026-10-28）导入原台内数据 · 原项目 id ${oldPid}`]),
            createdAt: parseMs(proj.createdAt), updatedAt: parseMs(proj.updatedAt) || t,
          })
          .returning({ id: schema.projects.id });
        if (!pRow) continue;
        const pid = pRow.id;
        count++;

        const charMap = new Map<number, number>();
        for (const rc of (pack.characters as Array<Record<string, unknown>>) ?? []) {
          const data = emptyCharData();
          for (const f of CHAR_TEXT_FIELDS) data[f] = s(rc[f]);
          data.changeLog = s(rc.changeLog);
          data.identityTextStatus = s(rc.identityTextStatus) || "none";
          data.autoFilledFields = Array.isArray(rc.autoFilledFields)
            ? (rc.autoFilledFields as unknown[]).filter((x): x is string => typeof x === "string")
            : [];
          data.masterGenStatus = s(rc.masterGenStatus) || "none";
          data.masterGenError = s(rc.masterGenError);
          data.masterCandidateKey = null;
          if (typeof rc.archiveLockedAt === "string")
            data.archiveLockedAt = parseMs(rc.archiveLockedAt);
          const rawRefs = Array.isArray(rc.refs) ? (rc.refs as Array<Record<string, unknown>>) : [];
          data.refs = rawRefs.map((r) => ({
            slotKey: s(r.slotKey), label: s(r.label), groupKey: s(r.groupKey) || "custom",
            custom: r.custom === true,
            imageKey: null,
            filled: typeof r.imageUrl === "string" && r.imageUrl.length > 0,
            mediaMissing: typeof r.imageUrl === "string" && r.imageUrl.length > 0,
            candidateKey: null,
            genStatus: s(r.genStatus) || "none",
            genError: s(r.genError),
          }));
          if (data.refs.length === 0) data.refs = emptyCharData().refs;
          const filledKeys = data.refs.filter((r) => r.filled).map((r) => r.slotKey);
          const oldCid = String(rc.id);
          const assetKey = ASSET_CHAR[oldPid]?.[oldCid] ?? null;
          const baseVer = nn(rc.identityBaselineVersion);
          if (baseVer != null) {
            data.identityBaselineVersion = baseVer;
            data.identityBaseline = [...(assetKey ? ["master"] : []), ...filledKeys];
          }
          data.extraAssets = EXTRA_ASSETS[`${oldPid}:${oldCid}`] ?? [];
          const imageKey = assetKey;
          const [cRow] = await db
            .insert(schema.characters)
            .values({
              projectId: pid, name: s(rc.name),
              archiveStatus: s(rc.archiveStatus) || "draft",
              archiveVersion: nn(rc.archiveVersion) ?? 1,
              refsFilled: 0, refsTotal: 28, imageKey,
              canvasX: nn(rc.canvasX), canvasY: nn(rc.canvasY),
              data: JSON.stringify(data),
              createdAt: t, updatedAt: t,
            })
            .returning({ id: schema.characters.id });
          if (!cRow) continue;
          charMap.set(nn(rc.id) ?? 0, cRow.id);
          const [full] = await db
            .select()
            .from(schema.characters)
            .where(eq(schema.characters.id, cRow.id));
          if (full) await saveCharacter(db, full, data, {});
        }

        const sceneMap = new Map<number, number>();
        for (const rs of (pack.scenes as Array<Record<string, unknown>>) ?? []) {
          const [sRow] = await db
            .insert(schema.scenes)
            .values({
              projectId: pid, name: s(rs.name), location: s(rs.location),
              timeOfDay: s(rs.timeOfDay), lighting: s(rs.lighting),
              atmosphere: s(rs.atmosphere), palette: s(rs.palette),
              notes: s(rs.notes),
              imageKey: ASSET_SCENE[oldPid]?.[String(rs.id)] ?? null,
              canvasX: nn(rs.canvasX), canvasY: nn(rs.canvasY),
              createdAt: t, updatedAt: t,
            })
            .returning({ id: schema.scenes.id });
          if (sRow) sceneMap.set(nn(rs.id) ?? 0, sRow.id);
        }

        const shotMap = new Map<number, number>();
        const rawShots = ((pack.shots as Array<Record<string, unknown>>) ?? [])
          .slice()
          .sort((a, b) => (nn(a.sortOrder) ?? 0) - (nn(b.sortOrder) ?? 0));
        for (const rsh of rawShots) {
          const [shRow] = await db
            .insert(schema.shots)
            .values({
              projectId: pid,
              sortOrder: nn(rsh.sortOrder) ?? shotMap.size,
              durationSec: nn(rsh.durationSec) ?? 10,
              framing: s(rsh.framing), cameraMove: s(rsh.cameraMove),
              characterId: rsh.characterId != null ? (charMap.get(nn(rsh.characterId) ?? -1) ?? null) : null,
              sceneId: rsh.sceneId != null ? (sceneMap.get(nn(rsh.sceneId) ?? -1) ?? null) : null,
              characterIds: JSON.stringify(rsh.characterId != null && (charMap.get(nn(rsh.characterId) ?? -1) ?? null) != null ? [charMap.get(nn(rsh.characterId) ?? -1)] : []),
              sceneIds: JSON.stringify(rsh.sceneId != null && (sceneMap.get(nn(rsh.sceneId) ?? -1) ?? null) != null ? [sceneMap.get(nn(rsh.sceneId) ?? -1)] : []),
              characterPosition: s(rsh.characterPosition),
              startState: s(rsh.startState), action: s(rsh.action), endState: s(rsh.endState),
              handoffNote: s(rsh.handoffNote),
              firstFrameLabel: s(rsh.firstFrameLabel),
              firstFrameKey: null,
              firstFrameMissing: typeof rsh.firstFrameUrl === "string" && rsh.firstFrameUrl ? 1 : 0,
              lastFrameLabel: s(rsh.lastFrameLabel),
              lastFrameKey: null,
              lastFrameMissing: typeof rsh.lastFrameUrl === "string" && rsh.lastFrameUrl ? 1 : 0,
              videoQuality: typeof rsh.videoQuality === "string" ? (rsh.videoQuality as string) : null,
              promptEn: s(rsh.promptEn),
              canvasX: nn(rsh.canvasX), canvasY: nn(rsh.canvasY),
              createdAt: t, updatedAt: t,
            })
            .returning({ id: schema.shots.id });
          if (!shRow) continue;
          shotMap.set(nn(rsh.id) ?? 0, shRow.id);
          const resultMap = new Map<number, number>();
          for (const rr of (rsh.results as Array<Record<string, unknown>>) ?? []) {
            const [resRow] = await db
              .insert(schema.results)
              .values({
                projectId: pid, shotId: shRow.id,
                versionNumber: nn(rr.versionNumber) ?? 1,
                label: s(rr.label), genStatus: s(rr.genStatus) || "none",
                genError: s(rr.genError),
                videoKey: null,
                videoMissing: typeof rr.videoUrl === "string" && rr.videoUrl ? 1 : 0,
                actualLastFrameKey: null,
                lastFrameMissing: typeof rr.actualLastFrameUrl === "string" && rr.actualLastFrameUrl ? 1 : 0,
                qcStatus: s(rr.qcStatus) || "pending", qcNote: s(rr.qcNote),
                adopted: rr.adopted === true ? 1 : 0,
                includeInEdit: rr.includeInEdit === false ? 0 : 1,
                inPoint: nn(rr.inPoint) ?? 0, outPoint: nn(rr.outPoint),
                cutType: s(rr.cutType) || "直切",
                videoQuality: typeof rr.videoQuality === "string" ? (rr.videoQuality as string) : null,
                taskSheet: null,
                createdAt: parseMs(rr.createdAt), updatedAt: parseMs(rr.updatedAt),
              })
              .returning({ id: schema.results.id });
            if (resRow) resultMap.set(nn(rr.id) ?? 0, resRow.id);
          }
          (rsh as Record<string, unknown>)["__resultMap"] = resultMap;
        }

        for (const rj of (pack.generationJobs as Array<Record<string, unknown>>) ?? []) {
          const oldShot = rawShots.find((x) => nn(x.id) === nn(rj.shotId));
          const rmap = oldShot?.["__resultMap"] as Map<number, number> | undefined;
          const st = s(rj.status);
          await db.insert(schema.genJobs).values({
            projectId: pid,
            shotId: rj.shotId != null ? (shotMap.get(nn(rj.shotId) ?? -1) ?? null) : null,
            resultId: rj.resultId != null ? (rmap?.get(nn(rj.resultId) ?? -1) ?? null) : null,
            characterId: null, kind: "video",
            status: st === "running" ? "dispatched" : st || "dispatched",
            videoQuality: typeof rj.videoQuality === "string" ? (rj.videoQuality as string) : null,
            detail: "导演台数据包导入的历史任务记录",
            error: s(rj.error),
            createdAt: parseMs(rj.createdAt), updatedAt: parseMs(rj.updatedAt),
          });
        }

        const nodeMap = new Map<number, number>();
        for (const rn of (pack.canvasNodes as Array<Record<string, unknown>>) ?? []) {
          const [nRow] = await db
            .insert(schema.canvasNodes)
            .values({
              projectId: pid, kind: s(rn.kind) || "image", title: s(rn.title),
              note: s(rn.note), mediaKey: null,
              mimeType: typeof rn.mimeType === "string" ? (rn.mimeType as string) : null,
              x: nn(rn.x) ?? 0, y: nn(rn.y) ?? 0, createdAt: t, updatedAt: t,
            })
            .returning({ id: schema.canvasNodes.id });
          if (nRow) nodeMap.set(nn(rn.id) ?? 0, nRow.id);
        }
        const remap = (kind: string, id: number): number | null => {
          if (kind === "character") return charMap.get(id) ?? null;
          if (kind === "scene") return sceneMap.get(id) ?? null;
          if (kind === "shot") return shotMap.get(id) ?? null;
          if (kind === "node") return nodeMap.get(id) ?? null;
          return null;
        };
        for (const rl of (pack.canvasLinks as Array<Record<string, unknown>>) ?? []) {
          const f = remap(s(rl.fromKind), nn(rl.fromId) ?? -1);
          const to = remap(s(rl.toKind), nn(rl.toId) ?? -1);
          if (f == null || to == null) continue;
          await db.insert(schema.canvasLinks).values({
            projectId: pid, fromKind: s(rl.fromKind), fromId: f,
            toKind: s(rl.toKind), toId: to, role: s(rl.role) || "reference",
            note: "", createdAt: t,
          });
        }
      }
      ctx.invalidateQueries();
      return { imported: true, projectCount: count };
    },
  }),

  listProjects: deskAction({
    request: z.object({}),
    response: z.object({ projects: z.array(projectOut), channels: channelStatusOut }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.projects)
        .orderBy(desc(schema.projects.updatedAt));
      const chars = await db.select().from(schema.characters);
      const scns = await db.select().from(schema.scenes);
      const shts = await db.select().from(schema.shots);
      const res = await db.select().from(schema.results);
      return {
        projects: rows.map((p) =>
          toProjectOut(p, {
            characters: chars.filter((c) => c.projectId === p.id).length,
            scenes: scns.filter((x) => x.projectId === p.id).length,
            shots: shts.filter((x) => x.projectId === p.id).length,
            adopted: res.filter((r) => r.projectId === p.id && r.adopted === 1).length,
            totalSec: shts
              .filter((x) => x.projectId === p.id)
              .reduce((a, x) => a + x.durationSec, 0),
          }, assemblySignatureOf(
            shts.filter((x) => x.projectId === p.id).sort((a, b) => a.sortOrder - b.sortOrder),
            res.filter((r) => r.projectId === p.id),
          )),
        ),
        channels: channelStatus(),
      };
    },
  }),

  getProject: deskAction({
    request: z.object({ id: z.number().int() }),
    response: z.object({
      channels: channelStatusOut,
      project: projectOut.nullable(),
      characters: z.array(characterOut),
      scenes: z.array(sceneOut),
      shots: z.array(shotOut),
      jobs: z.array(jobOut),
      nodes: z.array(nodeOut),
      links: z.array(linkOut),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.id));
      if (!p) return { channels: channelStatus(), project: null, characters: [], scenes: [], shots: [], jobs: [], nodes: [], links: [] };
      const chars = await db.select().from(schema.characters).where(eq(schema.characters.projectId, p.id)).orderBy(asc(schema.characters.id));
      const scns = await db.select().from(schema.scenes).where(eq(schema.scenes.projectId, p.id)).orderBy(asc(schema.scenes.id));
      const shts = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, p.id))).sort((a, b) => a.sortOrder - b.sortOrder);
      const res = await db.select().from(schema.results).where(eq(schema.results.projectId, p.id)).orderBy(desc(schema.results.createdAt));
      const jobs = await db.select().from(schema.genJobs).where(eq(schema.genJobs.projectId, p.id)).orderBy(desc(schema.genJobs.createdAt));
      const nodes = await db.select().from(schema.canvasNodes).where(eq(schema.canvasNodes.projectId, p.id));
      const links = await db.select().from(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, p.id));
      return {
        channels: channelStatus(),
        project: toProjectOut(p, {
          characters: chars.length, scenes: scns.length, shots: shts.length,
          adopted: res.filter((r) => r.adopted === 1).length,
          totalSec: shts.reduce((a, x) => a + x.durationSec, 0),
        }, assemblySignatureOf(shts, res)),
        characters: chars.map(toCharacterOut),
        scenes: scns.map((x) => {
          let genCharIds: number[] = [];
          try {
            const parsed = JSON.parse(x.genCharIds) as unknown;
            if (Array.isArray(parsed)) genCharIds = parsed.filter((v): v is number => typeof v === "number");
          } catch { /* 保持空 */ }
          return {
            id: x.id, projectId: x.projectId, name: x.name, location: x.location,
            timeOfDay: x.timeOfDay, lighting: x.lighting, atmosphere: x.atmosphere,
            palette: x.palette, notes: x.notes, imageKey: x.imageKey,
            candidateKey: x.candidateKey,
            genStatus: x.genStatus, genError: x.genError,
            genStartedAt: iso(x.genStartedAt),
            genNote: x.genNote, genPrompt: x.genPrompt, genCharIds,
            genStaleUnknown:
              x.genStatus === "running" &&
              (x.genStartedAt == null || now() - x.genStartedAt > GEN_STALE_MS),
            canvasX: x.canvasX, canvasY: x.canvasY,
          };
        }),
        shots: shts.map((sh) => {
          const rf = resolveFirstFrame(sh, shts, res);
          const out = {
            id: sh.id, projectId: sh.projectId, sortOrder: sh.sortOrder,
            durationSec: sh.durationSec, framing: sh.framing, cameraMove: sh.cameraMove,
            characterId: sh.characterId, sceneId: sh.sceneId,
            characterIds: shotCharacterIds(sh), sceneIds: shotSceneIds(sh),
            characterPosition: sh.characterPosition, startState: sh.startState,
            action: sh.action, endState: sh.endState, handoffNote: sh.handoffNote,
            firstFrameLabel: sh.firstFrameLabel, firstFrameKey: sh.firstFrameKey,
            firstFrameMissing: sh.firstFrameMissing === 1,
            lastFrameLabel: sh.lastFrameLabel, lastFrameKey: sh.lastFrameKey,
            lastFrameMissing: sh.lastFrameMissing === 1,
            videoQuality: sh.videoQuality, promptEn: sh.promptEn,
            canvasX: sh.canvasX, canvasY: sh.canvasY,
            resolvedFirstFrame: {
              key: rf.key, mediaMissing: rf.mediaMissing,
              source: rf.source, fromShotOrder: rf.fromShotOrder,
            },
            chain: (() => {
              const idx2 = shts.findIndex((x) => x.id === sh.id);
              const prev2 = idx2 > 0 ? shts[idx2 - 1] : undefined;
              const sceneBreak = prev2 ? isSceneBreak(prev2, sh) : false;
              const autoFilled = isAutoFilled(sh);
              // 无尾帧首镜的方式与依据清点（人物/场景含画布连线口径）。
              const { charIds: ccIds, sceneIds: ssIds } = shotCharSceneIds(sh, links);
              const charRefCount = chars.filter((c) => ccIds.has(c.id)).reduce((a, c) => a + charRealImageCount(c), 0);
              const sceneHasImage = scns.some((x) => ssIds.has(x.id) && !!x.imageKey);
              const canvasFirstImg2 = links.some((l) => l.toKind === "shot" && l.toId === sh.id && l.role === "firstframe" && (() => { const k = l.fromKind === "character" ? chars.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "scene" ? scns.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "node" ? nodes.find((x) => x.id === l.fromId)?.mediaKey : l.fromKind === "shot" ? shts.find((x) => x.id === l.fromId)?.lastFrameKey : null; return !!k; })());
              const noTail2 = idx2 === 0;
              const mode = noTail2
                ? (sh.firstFrameKey || canvasFirstImg2 ? "uploaded" : "archive_scene")
                : sh.firstFrameKey ? "own" : "chained";
              // 三类参照同存口径（每一镜都适用，不只是第一镜）：首尾帧链只是
              // 首帧约束，不替代人物/场景参照——本镜所选人物的定版图＋身份锁
              // 文字、所选场景的场景图在派单时都会逐个作为图片参照传入。
              // chain 文案必须把这层说清，避免后续镜看起来「只带尾帧」。
              const refSuffix = `同时，本镜所选人物的定版图＋身份锁文字、所选场景的场景图也会逐个作为图片参照随派单传入（本镜可读：人物真实参考图 ${charRefCount} 张、场景图${sceneHasImage ? "有" : "无（只有场景卡文字）"}）——首尾帧只是首帧约束，不替代人物/场景参照，三类参照同时存在、互不替代。`;
              const refBlockedSuffix = `（此阻塞只针对首帧承接；本镜人物/场景参照已备：人物真实参考图 ${charRefCount} 张、场景图${sceneHasImage ? "有" : "无（只有场景卡文字）"}，尾帧到位后派单时三类参照会一并传入。）`;
              let status = "ready";
              let detail = `首帧已就绪，生成时严格以首帧图像为准。${refSuffix}`;
              if (idx2 === 0 && mode === "uploaded") { status = "first_uploaded"; detail = "第一镜 · 方式 A（上传参考图）：没有上一镜尾帧，本镜上传的首帧图就是开场锚点，生成时严格以该图为首帧；本镜生成后的真实尾帧会自动填入下一镜。"; }
              else if (idx2 === 0) { status = "first_archive"; detail = charRefCount > 0 ? `第一镜 · 方式 B（无上传图）：没有上一镜尾帧可参考，也不等尾帧。派单时严格按文字脚本＋人物档案角色参考＋场景卡参考生成——本镜可读到的人物真实参考图 ${charRefCount} 张、场景图${sceneHasImage ? "有" : "无（只有场景卡文字）"}；人物定版图与场景图会实际作为图片参照传入，不许纯文字想象。` : `第一镜 · 方式 B（无上传图）：没有上一镜尾帧可参考，也不等尾帧，应按文字脚本＋人物档案角色参考＋场景卡参考严格生成——但本镜出场人物在档案里还没有任何真实参考图（0 张），方式 B 依据缺失：请先在人物档案定版至少主肖像，或上传首帧图改走方式 A（准备检查已阻塞）。`; }
              else if (sceneBreak) { status = "scene_break"; detail = `与上一镜换场景，链条重置：本镜首帧独立定位，不带入上一镜尾帧；缺独立首帧时按原规则定位/阻塞，不走第一镜的方式 B 档案兜底（指首帧不靠档案兜底，不是指不读档案）。${refSuffix}`; }
              else if (autoFilled) { status = "auto_filled"; detail = `已自动填入：本镜首帧 = ${sh.firstFrameLabel}，生成时必须严格以该图为首帧参照（身份/姿势/站位/构图/光线/服装/硬规则以图为准）。${refSuffix}`; }
              else if (sh.firstFrameKey) { status = "own"; detail = `本镜有自有首帧图，生成时严格以该图为首帧。${refSuffix}`; }
              else if (rf.key && !rf.mediaMissing && (rf.source === "adopted" || rf.source === "latest")) { status = "ready_chained"; detail = `可严格衔接：上一镜${rf.source === "adopted" ? "已采用" : "最新回填"}结果的真实尾帧图可作本镜首帧，派单时将冻结该图为参照清单第 1 项（首帧）。${refSuffix}`; }
              else if (rf.source === "planned") { status = "blocked_planned"; detail = `严格阻塞：只有上一镜目标尾帧规划图，还没有真实尾帧图，不得按规划图/标签生成。先完成上一镜并回填真实尾帧。${refBlockedSuffix}`; }
              else if (rf.mediaMissing) { status = "blocked_missing"; detail = `严格阻塞：上一镜尾帧原图缺失，无法以图像严格参照。请补真实尾帧图或为本镜上传自有首帧。${refBlockedSuffix}`; }
              else { status = "blocked_waiting"; detail = `严格阻塞：上一镜还没有真实尾帧图，本镜不能只按标签生成。先生成上一段，尾帧会自动填入本镜。${refBlockedSuffix}`; }
              return { autoFilled, isFirst: idx2 === 0, sceneBreak, status, detail, mode, charRefCount, sceneHasImage };
            })(),
            references: (() => {
              const out: Array<z.infer<typeof shotRefOut>> = [];
              const seen = new Set<string>();
              const push = (kind: string, refId: number, title: string, role: string, mediaKey: string | null, detail: string) => {
                const k = `${kind}:${refId}:${role}`;
                if (seen.has(k)) return;
                seen.add(k);
                out.push({ kind, refId, title, role, mediaKey, mediaMissing: mediaKey == null, detail });
              };
              for (const cid of shotCharacterIds(sh)) {
                const c = chars.find((x) => x.id === cid);
                if (c) push("character", c.id, c.name, "reference", c.imageKey, "分镜「出场人物」多选设置");
              }
              for (const sid of shotSceneIds(sh)) {
                const sc = scns.find((x) => x.id === sid);
                if (sc) push("scene", sc.id, sc.name, "reference", sc.imageKey, "分镜「场景」多选设置");
              }
              for (const l of links.filter((x) => x.toKind === "shot" && x.toId === sh.id)) {
                if (l.fromKind === "character") {
                  const c = chars.find((x) => x.id === l.fromId);
                  if (c) push("character", c.id, c.name, l.role, c.imageKey, "画布连线");
                } else if (l.fromKind === "scene") {
                  const sc = scns.find((x) => x.id === l.fromId);
                  if (sc) push("scene", sc.id, sc.name, l.role, sc.imageKey, "画布连线");
                } else if (l.fromKind === "node") {
                  const n = nodes.find((x) => x.id === l.fromId);
                  if (n) push("node", n.id, n.title || "未命名参考节点", l.role, n.mediaKey, n.note || "画布连线");
                } else if (l.fromKind === "shot") {
                  const from = shts.find((x) => x.id === l.fromId);
                  // 首帧连线的图 = 来源镜最新回填结果的真实尾帧（链图本身），
                  // 与参照包/任务单同口径；尚无结果尾帧时退到目标尾帧图。
                  if (from) push("shot", from.id, `第 ${from.sortOrder + 1} 镜`, l.role, l.role === "firstframe" ? (res.filter((r) => r.shotId === from.id && r.actualLastFrameKey).sort((a, b) => b.createdAt - a.createdAt)[0]?.actualLastFrameKey ?? from.lastFrameKey) : from.lastFrameKey, "画布连线");
                }
              }
              return out;
            })(),
            identityConflicts: (() => {
              const { charIds: icIds } = shotCharSceneIds(sh, links);
              const icChars = chars.filter((c) => icIds.has(c.id));
              return detectIdentityConflicts(p, sh, icChars);
            })(),
            results: res
              .filter((r) => r.shotId === sh.id)
              .map((r) => {
                const jb = jobs.find((j) => j.resultId === r.id);
                return toResultOut(r, jb && isStaleGenerating(jb, !!r.videoKey) ? "generating_stale_unknown" : effectiveJobStatus(jb, !!r.videoKey));
              }),
          };
          return { ...out, prep: computeShotPrep(p, sh, rf, out.references, shts, res, jobs, links, chars) };
        }),
        jobs: jobs.map((j) => ({
          id: j.id, shotId: j.shotId, resultId: j.resultId, characterId: j.characterId, kind: j.kind,
          status: effectiveJobStatus(j, !!res.find((r) => r.id === j.resultId)?.videoKey) ?? j.status,
          videoQuality: j.videoQuality, detail: j.detail,
          error: j.error, attemptId: j.attemptId ?? null, attemptNo: j.attemptNo ?? 0,
          staleUnknown: isStaleGenerating(j, !!res.find((r) => r.id === j.resultId)?.videoKey),
          createdAt: iso(j.createdAt) ?? "",
        })),
        nodes: nodes.map((n) => ({
          id: n.id, kind: n.kind, title: n.title, note: n.note,
          mediaKey: n.mediaKey, mimeType: n.mimeType, x: n.x, y: n.y,
        })),
        links: links.map((l) => ({
          id: l.id, fromKind: l.fromKind, fromId: l.fromId, toKind: l.toKind,
          toId: l.toId, role: l.role, note: l.note,
        })),
      };
    },
  }),

  createProject: deskAction({
    request: z.object({
      name: z.string().min(1).max(80),
      targetSeconds: z.number().positive().max(3600).default(30),
      defaultQuality: z.enum(["480P", "720P", "1080P"]).default("720P"),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const t = now();
      const [row] = await db
        .insert(schema.projects)
        .values({
          name: args.name, targetSeconds: args.targetSeconds,
          defaultQuality: args.defaultQuality, createdAt: t, updatedAt: t,
        })
        .returning({ id: schema.projects.id });
      if (!row) throw new Error("createProject failed");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateProjectSettings: deskAction({
    request: z.object({
      id: z.number().int(),
      name: z.string().min(1).max(80).optional(),
      targetSeconds: z.number().positive().max(3600).optional(),
      aspect: z.string().max(40).optional(),
      fps: z.number().int().positive().max(120).optional(),
      exportSpec: z.string().max(200).optional(),
      defaultQuality: z.enum(["480P", "720P", "1080P"]).optional(),
      chainStrict: z.boolean().optional(),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const patch: Partial<typeof schema.projects.$inferInsert> = { updatedAt: now() };
      if (args.chainStrict !== undefined) (patch as Record<string, unknown>).chainStrict = args.chainStrict ? 1 : 0;
      if (args.name !== undefined) patch.name = args.name;
      if (args.targetSeconds !== undefined) patch.targetSeconds = args.targetSeconds;
      if (args.aspect !== undefined) patch.aspect = args.aspect;
      if (args.fps !== undefined) patch.fps = args.fps;
      if (args.exportSpec !== undefined) patch.exportSpec = args.exportSpec;
      if (args.defaultQuality !== undefined) patch.defaultQuality = args.defaultQuality;
      await db.update(schema.projects).set(patch).where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  deleteProject: deskAction({
    request: z.object({ id: z.number().int() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, args.id));
      await db.delete(schema.canvasNodes).where(eq(schema.canvasNodes.projectId, args.id));
      await db.delete(schema.genJobs).where(eq(schema.genJobs.projectId, args.id));
      await db.delete(schema.results).where(eq(schema.results.projectId, args.id));
      await db.delete(schema.shots).where(eq(schema.shots.projectId, args.id));
      await db.delete(schema.scenes).where(eq(schema.scenes.projectId, args.id));
      await db.delete(schema.characters).where(eq(schema.characters.projectId, args.id));
      await db.delete(schema.projects).where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  updateScript: deskAction({
    request: z.object({
      id: z.number().int(),
      scriptTitle: z.string().max(200),
      scriptText: z.string().max(60000),
      scriptNotes: z.string().max(20000),
      rules: z.string().max(20000),
      scriptStatus: z.enum(["draft", "ready"]),
    }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(), autoSplit: z.number(),
      // 脚本→分镜实时同步结果：syncedShots＝本次按序号回写到既有分镜的
      // 镜数；syncWarning 非空＝结构对不上未同步的原因（明示，不静默）。
      syncedShots: z.number(), syncWarning: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.id));
      if (!p) return { ok: false, error: "项目不存在。", autoSplit: 0, syncedShots: 0, syncWarning: null };
      if (p.locked === 1)
        return { ok: false, error: "项目已锁版，脚本与分镜已冻结，不能修改脚本。如需修改请先解锁项目（需填写原因并升版）。", autoSplit: 0, syncedShots: 0, syncWarning: null };
      await db
        .update(schema.projects)
        .set({
          scriptTitle: args.scriptTitle, scriptText: args.scriptText,
          scriptNotes: args.scriptNotes, rules: args.rules,
          scriptStatus: args.scriptStatus, assemblyConfirmed: 0, updatedAt: now(),
        })
        .where(eq(schema.projects.id, args.id));
      // 脚本→分镜实时同步（改工具本身的缺口修复）：此前保存脚本只改
      // projects.scriptText，既有分镜的段落文本纹丝不动，派单仍按旧分镜
      // 组装——用户在脚本页删改的词当然不会进新任务单。现在保存时只要
      // 正文变了，就按拆镜同一套纯规则把新脚本切段、按镜头序号逐段比对，
      // 变更段回写到对应既有 shot（只改文本类字段：段落原文＋提炼出的
      // 景别/运镜/起止状态；shot id、人物/场景多选、首尾帧、results、
      // 画布连线与尾帧链一律不动，不重建分镜）。段数与镜数对不上＝结构
      // 变了（增删镜头），不硬套序号：明示需重新拆镜，绝不静默用旧文本
      // 也绝不悄悄覆盖。
      let syncedShots = 0;
      let syncWarning: string | null = null;
      if (args.scriptText !== p.scriptText) {
        const existingShots = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.id)))
          .sort((a, b) => a.sortOrder - b.sortOrder);
        if (existingShots.length > 0) {
          const { drafts } = parseScriptDrafts(args.scriptText, p.targetSeconds);
          if (drafts.length !== existingShots.length) {
            syncWarning = `脚本已保存，但段落结构变了：新脚本可拆 ${drafts.length} 段、现有分镜 ${existingShots.length} 镜，按镜头序号对不上——分镜未自动同步、仍是旧文本，派单仍会按旧分镜组装。请用脚本页「拆镜预览」核对后重新拆镜，或在分镜页逐镜修改后再派单。`;
          } else {
            // 只回写「本次保存里真正变了的段落」：与旧脚本同序号段落比对，
            // 本次没动的段落不碰对应分镜——用户在分镜页单独改过的镜不被
            // 未变更的脚本段反向覆盖。旧脚本段数对不上（分镜是手工建的
            // 等情形）才退回与分镜现值比对。
            const oldDrafts = parseScriptDrafts(p.scriptText, p.targetSeconds).drafts;
            const aligned = oldDrafts.length === existingShots.length;
            const changedIdx = existingShots
              .map((sh, i) => {
                const d = drafts[i];
                if (!d) return -1;
                const changed = aligned ? d.action !== oldDrafts[i]?.action : d.action !== sh.action;
                return changed && d.action !== sh.action ? i : -1;
              })
              .filter((i) => i >= 0);
            if (changedIdx.length > 0) {
              // 提炼（景别/运镜/起止状态）只对变更段回写且只写非空值：
              // 推理不可用时提炼字段为空，保留分镜原值不清空。
              await enrichDrafts(ctx, args.id, drafts);
              for (const i of changedIdx) {
                const sh = existingShots[i];
                const d = drafts[i];
                if (!sh || !d) continue;
                const patch: Partial<typeof schema.shots.$inferInsert> = { action: d.action, updatedAt: now() };
                if (d.startState) patch.startState = d.startState;
                if (d.endState) patch.endState = d.endState;
                if (d.framing) patch.framing = d.framing;
                if (d.cameraMove) patch.cameraMove = d.cameraMove;
                await db.update(schema.shots).set(patch).where(eq(schema.shots.id, sh.id));
                syncedShots++;
              }
            }
          }
        }
      }
      let autoSplit = 0;
      if (args.scriptStatus === "ready") {
        const existing = await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.id));
        if (existing.length === 0) {
          const r = await doSplitScript(ctx, { ...p, scriptText: args.scriptText, scriptTitle: args.scriptTitle });
          autoSplit = r.created;
        }
      }
      ctx.invalidateQueries();
      return { ok: true, error: null, autoSplit, syncedShots, syncWarning };
    },
  }),

  previewSplit: deskAction({
    request: z.object({
      id: z.number().int(),
      // 可传编辑框里的当前文本先预览（不必先保存）；不传则用已保存的脚本正文。
      scriptText: z.string().max(60000).optional(),
    }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(),
      shots: z.array(z.object({
        action: z.string(), durationSec: z.number(), framing: z.string(),
        cameraMove: z.string(), characterName: z.string(), sceneName: z.string(),
        characterNames: z.array(z.string()), sceneNames: z.array(z.string()),
        startState: z.string(), endState: z.string(),
        firstFrameDesc: z.string(), lastFrameDesc: z.string(),
      })),
      totalSeconds: z.number(),
      excluded: z.array(z.string()),
      existingShots: z.number(),
      canApply: z.boolean(), needsConfirm: z.boolean(),
      blockedReason: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const empty = {
        shots: [], totalSeconds: 0, excluded: [], existingShots: 0,
        canApply: false, needsConfirm: false,
      };
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.id));
      if (!p) return { ok: false, error: "项目不存在。", ...empty, blockedReason: "项目不存在。" };
      const text = (args.scriptText ?? p.scriptText).trim();
      if (!text) return { ok: false, error: "脚本正文为空，先写脚本再预览拆镜。", ...empty, blockedReason: "脚本正文为空。" };
      const existing = await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.id));
      const res = await db.select().from(schema.results).where(eq(schema.results.projectId, args.id));
      const jobs = await db.select().from(schema.genJobs).where(eq(schema.genJobs.projectId, args.id));
      let blockedReason: string | null = null;
      if (p.locked === 1) blockedReason = "项目已锁版：可以查看拆镜预览核对，但不能应用、不能重拆（锁版纪律不变）。";
      else if (existing.length > 0 && (res.length > 0 || jobs.length > 0))
        blockedReason = "已有镜头生成过版本或派过生成任务：为保护成片记录，不能重拆覆盖；预览仅供核对。";
      const { drafts, excluded } = parseScriptDrafts(text, p.targetSeconds);
      if (drafts.length === 0)
        return { ok: false, error: "脚本里没有可拆成镜头的段落（段落都被识别为梗概/说明，或正文为空）。", ...empty, existingShots: existing.length, excluded, blockedReason };
      await enrichDrafts(ctx, p.id, drafts);
      // 只读预览：不写任何表。确认应用走 splitScript 并带回这份校对稿。
      return {
        ok: true, error: null,
        shots: drafts.map((d, i) => ({
          ...d,
          firstFrameDesc: i === 0
            ? `首帧 · 第 1 段开场（制作时定位）${d.startState ? `：${d.startState}` : ""}`
            : `自动带入上一镜尾帧${d.startState ? `：${d.startState}` : ""}`,
          lastFrameDesc: `尾帧 · 第 ${i + 1} 段结尾${d.endState ? `：${d.endState}` : ""}`,
        })),
        totalSeconds: drafts.reduce((a, d) => a + d.durationSec, 0),
        excluded, existingShots: existing.length,
        canApply: blockedReason == null,
        needsConfirm: blockedReason == null && existing.length > 0,
        blockedReason,
      };
    },
  }),

  splitScript: deskAction({
    request: z.object({
      id: z.number().int(), force: z.boolean().default(false),
      // 拆镜校对确认稿：传了就按校对稿原样写入（不再二次提炼）；不传走原自动拆分。
      drafts: z.array(z.object({
        action: z.string().max(20000), durationSec: z.number().min(0.5).max(600),
        framing: z.string().max(200), cameraMove: z.string().max(200),
        characterName: z.string().max(120), sceneName: z.string().max(120),
        characterNames: z.array(z.string().max(120)).max(50).optional(),
        sceneNames: z.array(z.string().max(120)).max(50).optional(),
        startState: z.string().max(5000), endState: z.string().max(5000),
      })).max(200).optional(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable(), created: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.id));
      if (!p) return { ok: false, error: "项目不存在。", created: 0 };
      if (p.locked === 1)
        return { ok: false, error: "项目已锁版，分镜已冻结，不能重新拆分镜。", created: 0 };
      if (!args.drafts && !p.scriptText.trim())
        return { ok: false, error: "脚本正文为空，先写脚本再拆分镜。", created: 0 };
      if (args.drafts && args.drafts.length === 0)
        return { ok: false, error: "校对稿为空，没有可应用的镜头。", created: 0 };
      const existing = await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.id));
      if (existing.length > 0) {
        const res = await db.select().from(schema.results).where(eq(schema.results.projectId, args.id));
        const jobs = await db.select().from(schema.genJobs).where(eq(schema.genJobs.projectId, args.id));
        if (res.length > 0 || jobs.length > 0)
          return {
            ok: false, created: 0,
            error: "已有镜头生成过版本或派过生成任务，重拆会丢失成片记录，已拦下。如确需重拆，请先删除相关镜头的生成结果与任务。",
          };
        if (!args.force)
          return { ok: false, created: 0, error: "项目已有分镜。确认重拆将删除现有分镜（无生成记录），请确认后再拆。" };
        await db.delete(schema.shots).where(eq(schema.shots.projectId, args.id));
      }
      const r = args.drafts
        ? await writeDrafts(ctx, p, args.drafts.map((d) => ({
            ...d,
            characterNames: [...new Set([...(d.characterNames ?? []), d.characterName].filter(Boolean))],
            sceneNames: [...new Set([...(d.sceneNames ?? []), d.sceneName].filter(Boolean))],
            handoffNote: "",
          })))
        : await doSplitScript(ctx, p);
      ctx.invalidateQueries();
      return { ok: true, error: null, created: r.created };
    },
  }),

  lockProject: deskAction({
    request: z.object({ id: z.number().int() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.id));
      if (!p) return { ok: false, error: "项目不存在。" };
      if (p.locked === 1) return { ok: false, error: "项目已经是锁版状态。" };
      const shots = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.id)))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      if (shots.length === 0)
        return { ok: false, error: "项目还没有分镜，无法锁版。先把脚本标为「可进入分镜」自动拆分，或在分镜页手动添加镜头。" };
      // 锁版定义（用户口径 2026-10-30，更正此前概念＋可选化）：脚本页
      // 顶部这个锁版是可选的「定稿」标记——想定稿就点，不点不拦派单；
      // 派单不以锁版为前置，派单时服务端自动冻结当前脚本/分镜/人物
      // 档案参考/场景卡参考/首尾帧链快照生成任务单（见 buildTaskSheet）。
      // 已锁版项目的锁版状态与历史不动，不自动解锁；点锁版后仍按原
      // 纪律冻结脚本与分镜（解锁需填原因升版）。锁版本身只看「定好」
      // 的脚本与分镜——有分镜、每镜动作等分镜内容定好即可锁版。首帧/
      // 尾帧是否定位、上一镜尾帧是否已生成、第一镜方式 A/B 的档案/
      // 场景图依据是否齐备，都不属于锁版条件：后面镜头的首帧是生成
      // 时为一致性服务的承接图，与锁不锁无关，缺失只在派单/生成时按
      // 严格链与准备检查规则拦截（strictChainBlock 等，本动作不查）。
      for (const sh of shots) {
        const n = sh.sortOrder + 1;
        if (!sh.action.trim())
          return { ok: false, error: `第 ${n} 镜缺少「一个动作」内容，锁版前必须补齐。` };
      }
      const history = [...(JSON.parse(p.history) as string[]), logLine(p.version, "项目锁版")];
      await db
        .update(schema.projects)
        .set({ locked: 1, lockedAt: now(), history: JSON.stringify(history), updatedAt: now() })
        .where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  unlockProject: deskAction({
    request: z.object({ id: z.number().int(), reason: z.string().min(1).max(500) }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.id));
      if (!p) return { ok: false, error: "项目不存在。" };
      if (p.locked !== 1) return { ok: false, error: "项目当前未锁版。" };
      const history = [
        ...(JSON.parse(p.history) as string[]),
        logLine(p.version + 1, `解锁项目：${args.reason}`),
      ];
      await db
        .update(schema.projects)
        .set({ locked: 0, lockedAt: null, version: p.version + 1, history: JSON.stringify(history), updatedAt: now() })
        .where(eq(schema.projects.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // ---------- 人物 ----------

  createCharacter: deskAction({
    request: z.object({ projectId: z.number().int(), name: z.string().min(1).max(60) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const t = now();
      const [row] = await db
        .insert(schema.characters)
        .values({
          projectId: args.projectId, name: args.name,
          data: JSON.stringify(emptyCharData()), createdAt: t, updatedAt: t,
        })
        .returning({ id: schema.characters.id });
      if (!row) throw new Error("createCharacter failed");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateCharacter: deskAction({
    request: z.object({
      id: z.number().int(),
      name: z.string().min(1).max(60).optional(),
      fields: z.record(z.string(), z.string().max(20000)).optional(),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.id));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked")
        return { ok: false, error: `人物「${c.name}」档案已锁版（v${c.archiveVersion}），不能修改。修改前请先解锁档案（需填写原因、自动升版）。` };
      const data = parseCharData(c.data);
      if (args.fields) {
        for (const f of CHAR_TEXT_FIELDS) {
          const v = args.fields[f];
          if (v !== undefined) {
            data[f] = v;
            if (data.autoFilledFields.includes(f))
              data.autoFilledFields = data.autoFilledFields.filter((x) => x !== f);
          }
        }
      }
      await saveCharacter(db, c, data, args.name !== undefined ? { name: args.name } : {});
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  deleteCharacter: deskAction({
    request: z.object({ id: z.number().int() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.id));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked")
        return { ok: false, error: "该人物档案已锁版，不能删除；请先解锁档案。" };
      await db.delete(schema.characters).where(eq(schema.characters.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  uploadMasterImage: deskAction({
    request: z.object({
      characterId: z.number().int(),
      dataBase64: z.string().min(10).max(16000000),
      mimeType: z.string().max(60),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked")
        return { ok: false, error: "档案已锁版，不能更换主定版肖像；请先解锁档案。" };
      const key = `character-${c.id}-master-${now()}`;
      await ctx.blobs.put(key, decodeB64(args.dataBase64), { contentType: args.mimeType });
      const data = parseCharData(c.data);
      data.masterCandidateKey = null;
      data.masterGenStatus = "none";
      data.masterGenStartedAt = null;
      data.masterGenAttemptId = null;
      data.changeLog = [logLine(c.archiveVersion, "主定版肖像：上传图片设为定版"), data.changeLog].filter(Boolean).join("\n");
      await saveCharacter(db, c, data, { imageKey: key });
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  uploadRefImage: deskAction({
    request: z.object({
      characterId: z.number().int(),
      slotKey: z.string().max(80),
      dataBase64: z.string().min(10).max(16000000),
      mimeType: z.string().max(60),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked")
        return { ok: false, error: "档案已锁版，不能上传参考图；请先解锁档案。" };
      const data = parseCharData(c.data);
      const slot = data.refs.find((r) => r.slotKey === args.slotKey);
      if (!slot) return { ok: false, error: "参考格不存在。" };
      const key = `character-${c.id}-ref-${args.slotKey}-${now()}`;
      await ctx.blobs.put(key, decodeB64(args.dataBase64), { contentType: args.mimeType });
      slot.imageKey = key;
      slot.filled = true;
      slot.mediaMissing = false;
      slot.candidateKey = null;
      slot.genStatus = "none";
      slot.genError = "";
      slot.genStartedAt = null;
      slot.genAttemptId = null;
      data.changeLog = [logLine(c.archiveVersion, `定版图通过：${slot.label}（上传）`), data.changeLog].filter(Boolean).join("\n");
      await saveCharacter(db, c, data, {});
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  generateRefImage: deskAction({
    request: z.object({
      characterId: z.number().int(),
      slotKey: z.string().max(80).nullable(),
      // 生成旁的用户提示词输入：作为本次补充要求并入冻结提示词，
      // 身份锁原文与锚点参照规则不变，冲突时以身份锁/锚点图为准。
      prompt: z.string().max(2000).optional(),
    }),
    response: ok,
    privileged: [privileged.exportRefImageFile],
    async handler(ctx, args) {
      if (!ctx.providers.image) return { ok: false, error: GENERATION_UNCONNECTED };
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked")
        return { ok: false, error: "档案已锁版，生图被拦截；请先解锁档案。" };
      const data = parseCharData(c.data);
      const slot = args.slotKey ? data.refs.find((r) => r.slotKey === args.slotKey) : null;
      if (args.slotKey && !slot) return { ok: false, error: "参考格不存在。" };
      const label = slot ? slot.label : "主定版肖像";
      const curStatus = slot ? slot.genStatus : data.masterGenStatus;
      const curStartedAt = slot ? (slot.genStartedAt ?? null) : nn(data.masterGenStartedAt);
      const curCandidate = slot ? slot.candidateKey : data.masterCandidateKey;
      if (curCandidate)
        return { ok: false, error: `人物「${c.name}」的「${label}」已有一张候选图待审核：先「通过·定版」或「重拍」处理它，再重新生成，避免候选与定版混淆。` };
      // 防重复生图＋卡死处理：生成中不重复提交；超时未回填只是「状态待
      // 核查」（可能原生成仍在跑、也可能成图卡在回填），不自动改判、更
      // 不直接再生成——先核查，确认旧执行终止后用释放通道放开（见
      // releaseRefImageClaim）。无开始时间的旧版「生成中」同样待核查。
      if (curStatus === "running") {
        const stale = curStartedAt == null || now() - curStartedAt > GEN_STALE_MS;
        if (stale)
          return { ok: false, error: `人物「${c.name}」的「${label}」上一次生成已超过 30 分钟没有回填，状态待核查（不等于已中断）：可能原生成仍在运行，也可能图已生成但回填卡住。请先核查原执行；确认旧执行已终止后，在该格点「释放卡住的生成」放开再重新生成。未做任何更改，也没有重复生成。` };
        return { ok: false, error: `人物「${c.name}」的「${label}」正在生成中（已按主定锚点图派单），候选图将回到这一个槽位待审核；请勿重复提交，刷新页面状态会保留。` };
      }
      // 锚点参照包：主定锚点图第一位，其余真实定版图全量随后。
      const { pack, anchorLabel, omitted } = buildRefPack(c, data);
      const isMaster = !slot;
      if (!isMaster && pack.length === 0)
        return { ok: false, error: `人物「${c.name}」还没有主定版肖像（一致性锚点），参考格「${label}」不能只按文字/标签生成：请先上传一张主肖像或生成主肖像并定版，之后每个参考格都会把这张锚点图本身作为图片参照传入生成。未做任何更改。` };
      const prompt = buildRefPrompt(c.name, data, label, pack, anchorLabel, omitted, args.prompt ?? "");
      const packNote = pack.length
        ? `本次参照：${pack.map((p, i) => `${i + 1}.${p.label}${i === 0 ? "（主定锚点）" : ""}`).join("、")}——图像本身已传入生成${omitted ? `；另有 ${omitted} 张定版图超单次上限未传入` : ""}`
        : "本次无参照图：正在生成第一张主肖像（建立锚点本身），纯文字生成";
      const startedAt = now();
      const setRunning = (attemptId: string | null) => {
        if (slot) {
          slot.genStatus = "running"; slot.genError = "";
          slot.genStartedAt = startedAt; slot.genAttemptId = attemptId; slot.genNote = packNote;
        } else {
          data.masterGenStatus = "running"; data.masterGenError = "";
          data.masterGenStartedAt = startedAt; data.masterGenAttemptId = attemptId; data.masterGenNote = packNote;
        }
      };
      const setFailed = async (jobId: number | undefined, msg: string) => {
        if (slot) { slot.genStatus = "failed"; slot.genError = msg; slot.genAttemptId = null; }
        else { data.masterGenStatus = "failed"; data.masterGenError = msg; data.masterGenAttemptId = null; }
        if (jobId)
          await db.update(schema.genJobs)
            .set({ status: "failed", error: msg, updatedAt: now() })
            .where(eq(schema.genJobs.id, jobId));
        await saveCharacter(db, c, data, {});
        ctx.invalidateQueries();
      };

      // 无任何真实图片、生成第一张主肖像（建立锚点本身）：纯文字生图。
      if (pack.length === 0) {
        setRunning(null);
        await saveCharacter(db, c, data, {});
        const [job] = await db.insert(schema.genJobs).values({
          projectId: c.projectId, characterId: c.id, kind: "refimage",
          status: "generating", detail: `主肖像生成中（建立锚点，纯文字）：${label}`,
          createdAt: now(), updatedAt: now(),
        }).returning({ id: schema.genJobs.id });
        try {
          const media = await ctx.tool.generate_media(prompt, { orientation: "portrait" });
          if (slot) { slot.candidateKey = media.blobKey; slot.genStatus = "done"; slot.genError = ""; }
          else { data.masterCandidateKey = media.blobKey; data.masterGenStatus = "done"; data.masterGenError = ""; }
          if (job)
            await db.update(schema.genJobs)
              .set({ status: "returned", detail: `主肖像已生成（候选图，待通过定版；定版后即成为全档案的一致性锚点）`, updatedAt: now() })
              .where(eq(schema.genJobs.id, job.id));
          await saveCharacter(db, c, data, {});
          ctx.invalidateQueries();
          return { ok: true, error: null };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await setFailed(job?.id, msg);
          return { ok: false, error: `主肖像生成失败：${msg}` };
        }
      }

      // 锚点参照路径：先落「生成中＋尝试标识」，导出参照包为真实文件，
      // 再派 Muse 助手以图片本身作参照生成、文件直读回填同一格。
      const attemptId = `rat-${c.id}-${slot?.slotKey ?? "master"}-${startedAt.toString(36)}`;
      setRunning(attemptId);
      await saveCharacter(db, c, data, {});
      const [job] = await db.insert(schema.genJobs).values({
        projectId: c.projectId, characterId: c.id, kind: "refimage",
        status: "awaiting_assistant", attemptId, attemptNo: 1,
        detail: `参考图生成（锚点参照）：${label}｜${packNote}｜冻结提示词：\n${prompt}`,
        createdAt: now(), updatedAt: now(),
      }).returning({ id: schema.genJobs.id });
      const files: Array<{ label: string; role: string; path: string }> = [];
      try {
        for (let i = 0; i < pack.length; i++) {
          const p = pack[i];
          if (!p) continue;
          const ex = await ctx.executePrivileged(privileged.exportRefImageFile, {
            spaceDir: ctx.spaceDir, mediaKey: p.key,
            outName: `char${c.id}-${slot?.slotKey ?? "master"}-ref${i}`,
          });
          if (ex.error || !ex.path)
            throw new Error(`参考图「${p.label}」导出失败：${ex.error ?? "未返回文件路径"}`);
          files.push({ label: p.label, role: p.role, path: ex.path });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await setFailed(job?.id, `锚点参照图准备失败：${msg}`);
        return { ok: false, error: `「${label}」未启动生成：锚点参照图准备失败——${msg}。没有参照图就不按文字放行；请确认锚点图文件完好后重试。` };
      }
      const orientationHint = slot?.groupKey === "body" ? "竖幅全身构图" : slot ? "方幅构图" : "竖幅肖像构图";
      const message = [
        `你是导演台的参考图生成执行助手。请为人物「${c.name}」生成一张参考图：${label}（${orientationHint}），生成后第一时间回填到导演台同一个参考格作候选图待用户审核——不要把图只发到聊天里、不要存进资源库就算完成，参考格里没有候选图就不算完成。`,
        `【最重要：严格参照主定锚点图，以图为准】下面按顺序列出的图片文件必须作为图片参照实际传入你的生图工具（生成提示里带上这些图片本身，不只是文字）：第 1 张是主定锚点图，这个人物的身份、脸、发型、体型、服装都以它为准，不得漂移；其余图片按顺序作角度/姿势/服装参照，冲突时以锚点图为准。参考图片（顺序不得调整）：`,
        ...files.map((f, i) => `${i + 1}. ${f.label}（${f.role}）：${f.path}`),
        `本次领取的尝试标识 attemptId=${attemptId}。回填与报告失败时必须原样带上 attemptId；标识对不上的晚到回调会被服务端拒绝，不得覆盖更新的尝试。`,
        `生成完成后立刻调用导演台动作 completeRefImage，只传短参数：characterId=${c.id}、slotKey=${slot ? JSON.stringify(slot.slotKey) : "null"}、attemptId=${attemptId}、filePath=生成图片文件的绝对路径（生成工具返回的 local_path，原样照抄，不要改名、不要转存）。服务端会直读该文件存回同一参考格作候选图。严禁把图片转成 base64 文本转录。`,
        `如果生成失败或通道不可用，调用 completeRefImage 并传 characterId=${c.id}、slotKey=${slot ? JSON.stringify(slot.slotKey) : "null"}、attemptId=${attemptId} 与 error 写明真实原因，不要编造结果。`,
        "回填后不要自行定版：候选图由用户在人物档案页审核，通过后才定版、才会被后续生成引用。",
        "",
        "—— 冻结提示词（不得改写其中身份锁原文） ——",
        prompt,
      ].join("\n");
      let taskId: string | null = null;
      let spawnErr: string | null = null;
      try {
        const tsk = await ctx.agent.spawnTask(message, {
          expectsAction: "completeRefImage",
          dedupeKey: `refimage-${c.id}-${slot?.slotKey ?? "master"}-${attemptId}`,
        });
        if (tsk.ok) taskId = tsk.taskId;
        else spawnErr = tsk.error;
      } catch (e) {
        spawnErr = e instanceof Error ? e.message : String(e);
      }
      if (!taskId) {
        // 领取未启动＝没有任何助手任务在跑：如实标失败可直接重试，
        // 不留假「生成中」把槽位卡死，也不会与重试重复生成。
        const msg = `助手领取未启动：${spawnErr ?? "未知原因"}。本次没有产生任何生成，直接再点一次生成即可重试。`;
        await setFailed(job?.id, msg);
        return { ok: false, error: `「${label}」未启动生成：${msg}` };
      }
      if (job)
        await db.update(schema.genJobs)
          .set({
            status: "generating",
            detail: `参考图生成（锚点参照）：${label}｜${packNote}｜Muse 助手已领取执行（任务 ${taskId}），将以主定锚点图本身为第一参照生成，成图回填本格作候选图待审核。｜冻结提示词：\n${prompt}`,
            updatedAt: now(),
          })
          .where(eq(schema.genJobs.id, job.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 参考图回填（锚点参照生成的唯一回调）：执行助手只传生成图片的文
  // 件路径，服务端经特权层分块直读字节、校验图片文件头与 SHA-256 后
  // 落回同一参考格作候选图（待审核）。尝试标识不符的旧回调拒绝；已
  // 回填/不在生成中的重复回调拒绝。传 error 则把该格标为生成失败。
  completeRefImage: deskAction({
    request: z.object({
      characterId: z.number().int(),
      slotKey: z.string().max(80).nullable(),
      attemptId: z.string().max(120).optional(),
      filePath: z.string().min(1).max(600).optional(),
      error: z.string().max(4000).optional(),
    }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(),
      bytes: z.number(), sha256: z.string().nullable(),
    }),
    privileged: [privileged.readWorkspaceImageChunk],
    async handler(ctx, args): Promise<{ ok: boolean; error: string | null; bytes: number; sha256: string | null }> {
      const fail = (error: string) => ({ ok: false, error, bytes: 0, sha256: null });
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return fail("人物不存在。");
      const data = parseCharData(c.data);
      const slot = args.slotKey ? data.refs.find((r) => r.slotKey === args.slotKey) : null;
      if (args.slotKey && !slot) return fail("参考格不存在。");
      const label = slot ? slot.label : "主定版肖像";
      const curStatus = slot ? slot.genStatus : data.masterGenStatus;
      const curAttempt = slot ? (slot.genAttemptId ?? null) : s(data.masterGenAttemptId) || null;
      const curCandidate = slot ? slot.candidateKey : data.masterCandidateKey;
      if (curStatus !== "running")
        return fail(`回填被拒绝：人物「${c.name}」的「${label}」当前不在生成中（状态：${curStatus}），这通常是重复回填或已被释放的旧执行晚到。未做任何更改。`);
      if (curAttempt && args.attemptId !== curAttempt)
        return fail(`回填被拒绝：尝试标识不符（本格当前尝试 ${curAttempt}，回调带来 ${args.attemptId ?? "无标识"}）。这通常是已被释放/轮换的旧执行晚到回调，不能覆盖新尝试；请由当前尝试的执行方带正确 attemptId 回填。未做任何更改。`);
      if (curCandidate)
        return fail(`回填被拒绝：人物「${c.name}」的「${label}」已有候选图待审核，不重复回填。未做任何更改。`);
      const jobs = (await db.select().from(schema.genJobs)
        .where(and(eq(schema.genJobs.characterId, c.id), eq(schema.genJobs.kind, "refimage"))))
        .sort((a, b) => b.createdAt - a.createdAt);
      // 本地恢复：缺失关联记录时不借用另一参考格的最新任务。
      const job = curAttempt ? jobs.find((j) => j.attemptId === curAttempt) : undefined;
      const markJob = async (patch: Partial<typeof schema.genJobs.$inferInsert>) => {
        if (job) await db.update(schema.genJobs).set({ ...patch, updatedAt: now() }).where(eq(schema.genJobs.id, job.id));
      };
      if (args.error) {
        if (slot) { slot.genStatus = "failed"; slot.genError = args.error; slot.genAttemptId = null; }
        else { data.masterGenStatus = "failed"; data.masterGenError = args.error; data.masterGenAttemptId = null; }
        await markJob({ status: "failed", error: args.error });
        await saveCharacter(db, c, data, {});
        ctx.invalidateQueries();
        return { ok: true, error: null, bytes: 0, sha256: null };
      }
      if (!args.filePath)
        return fail("既没有给出生成图片的文件路径，也没有给出失败原因，无法回填。未做任何更改。");
      // 分块直读生成图片：每块 768KB，宿主本地通道，不经文本转录。
      const CHUNK = 786432;
      let assembled: Uint8Array | null = null;
      let total = -1;
      let offset = 0;
      try {
        for (;;) {
          const part = await ctx.executePrivileged(privileged.readWorkspaceImageChunk, {
            path: args.filePath, offset, maxBytes: CHUNK,
          });
          if (total < 0) {
            total = part.totalBytes;
            if (total < 100) return fail(`生成图片只有 ${total} 字节，不像完整图片，未做任何更改。`);
            assembled = new Uint8Array(total);
          }
          if (part.bytesRead > 0 && assembled) {
            assembled.set(decodeB64(part.dataBase64), offset);
            offset += part.bytesRead;
          }
          if (part.eof) break;
          if (part.bytesRead === 0) return fail("读取生成图片中途无数据，文件可能仍在写入或已被移动，未做任何更改。");
        }
      } catch (e) {
        return fail(`读取生成图片失败：${e instanceof Error ? e.message : String(e)}。未做任何更改；请确认文件路径无误、文件确在工作区内。`);
      }
      if (!assembled || offset !== total)
        return fail(`生成图片读取不完整：应读 ${total} 字节、实读 ${offset} 字节，未做任何更改。`);
      // 图片文件头校验，防止把任意文件误当生成图落格。
      const head = assembled.subarray(0, 12);
      let mimeType = "";
      if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) mimeType = "image/jpeg";
      else if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) mimeType = "image/png";
      else if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) mimeType = "image/webp";
      else if (head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) mimeType = "image/gif";
      if (!mimeType)
        return fail("文件头不是可识别的图片格式（JPEG/PNG/WebP/GIF），未做任何更改。");
      const sha = await sha256Hex(assembled);
      const key = `character-${c.id}-ref-${args.slotKey ?? "master"}-cand-${now()}`;
      await ctx.blobs.put(key, assembled, { contentType: mimeType });
      if (slot) { slot.candidateKey = key; slot.genStatus = "done"; slot.genError = ""; slot.genAttemptId = null; }
      else { data.masterCandidateKey = key; data.masterGenStatus = "done"; data.masterGenError = ""; data.masterGenAttemptId = null; }
      await markJob({
        status: "returned",
        detail: `参考图已生成并回填本格（候选图，待用户审核通过才定版）：${label}（约 ${(assembled.length / 1048576).toFixed(2)}MB · SHA-256 ${sha.slice(0, 16)}… · 文件直读回填）。`,
        error: "",
      });
      await saveCharacter(db, c, data, {});
      ctx.invalidateQueries();
      return { ok: true, error: null, bytes: assembled.length, sha256: sha };
    },
  }),

  // 释放卡住的参考图生成：与镜头视频同一口径——超时无回填不等于已
  // 中断，只有调用方明确确认旧执行已终止才释放；释放后旧尝试标识
  // 作废，其晚到回调会被 completeRefImage 拒绝，重新生成发放新标识。
  releaseRefImageClaim: deskAction({
    request: z.object({
      characterId: z.number().int(),
      slotKey: z.string().max(80).nullable(),
      confirmTerminated: z.boolean(),
      note: z.string().max(1000).default(""),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      const data = parseCharData(c.data);
      const slot = args.slotKey ? data.refs.find((r) => r.slotKey === args.slotKey) : null;
      if (args.slotKey && !slot) return { ok: false, error: "参考格不存在。" };
      const label = slot ? slot.label : "主定版肖像";
      const curStatus = slot ? slot.genStatus : data.masterGenStatus;
      if (curStatus !== "running")
        return { ok: false, error: `人物「${c.name}」的「${label}」当前状态是「${curStatus}」，不是生成中，无需释放。` };
      if (!args.confirmTerminated)
        return { ok: false, error: "未确认旧执行已终止，不能释放：无回填可能是原生成仍在运行，或图已生成但回填卡住。请先核查原执行与原产物；状态不明就保留未知，不要直接重新生成。" };
      const oldAttempt = (slot ? slot.genAttemptId : s(data.masterGenAttemptId)) || "无标识";
      const note = `已释放卡住的生成（尝试 ${oldAttempt}）${args.note ? `，核查说明：${args.note}` : ""}，于 ${new Date(now()).toISOString()} 释放；旧尝试标识已作废，其晚到回调将被拒绝。重新生成将发放新尝试标识。`;
      if (slot) {
        slot.genStatus = "none"; slot.genError = ""; slot.genStartedAt = null; slot.genAttemptId = null; slot.genNote = note;
      } else {
        data.masterGenStatus = "none"; data.masterGenError = "";
        data.masterGenStartedAt = null; data.masterGenAttemptId = null; data.masterGenNote = note;
      }
      const jobs = (await db.select().from(schema.genJobs)
        .where(and(eq(schema.genJobs.characterId, c.id), eq(schema.genJobs.kind, "refimage"))))
        .sort((a, b) => b.createdAt - a.createdAt);
      const job = oldAttempt !== "无标识" ? jobs.find((j) => j.attemptId === oldAttempt) : undefined;
      if (job)
        await db.update(schema.genJobs)
          .set({ status: "failed", attemptId: null, detail: `${job.detail}｜领取释放记录：${note}`, updatedAt: now() })
          .where(eq(schema.genJobs.id, job.id));
      await saveCharacter(db, c, data, {});
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  reviewRefImage: deskAction({
    request: z.object({
      characterId: z.number().int(),
      slotKey: z.string().max(80).nullable(),
      approve: z.boolean(),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked")
        return { ok: false, error: "档案已锁版，不能处理候选图；请先解锁档案。" };
      const data = parseCharData(c.data);
      if (args.slotKey == null) {
        if (!data.masterCandidateKey) return { ok: false, error: "主肖像没有待处理的候选图。" };
        if (args.approve) {
          data.changeLog = [logLine(c.archiveVersion, "主定版肖像：生成候选图通过定版"), data.changeLog].filter(Boolean).join("\n");
          await saveCharacter(db, c, { ...data, masterCandidateKey: null, masterGenStatus: "none", masterGenStartedAt: null, masterGenAttemptId: null }, { imageKey: data.masterCandidateKey });
        } else {
          data.masterCandidateKey = null;
          data.masterGenStatus = "none";
          data.masterGenStartedAt = null;
          data.masterGenAttemptId = null;
          await saveCharacter(db, c, data, {});
        }
      } else {
        const slot = data.refs.find((r) => r.slotKey === args.slotKey);
        if (!slot) return { ok: false, error: "参考格不存在。" };
        if (!slot.candidateKey) return { ok: false, error: "该格没有待处理的候选图。" };
        if (args.approve) {
          slot.imageKey = slot.candidateKey;
          slot.filled = true;
          slot.mediaMissing = false;
          data.changeLog = [logLine(c.archiveVersion, `定版图通过：${slot.label}（台内生成候选图转为定版）`), data.changeLog].filter(Boolean).join("\n");
        }
        slot.candidateKey = null;
        slot.genStatus = "none";
        slot.genError = "";
        slot.genStartedAt = null;
        slot.genAttemptId = null;
        await saveCharacter(db, c, data, {});
      }
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  addRefSlot: deskAction({
    request: z.object({ characterId: z.number().int(), label: z.string().min(1).max(60) }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked") return { ok: false, error: "档案已锁版，不能新增参考格；请先解锁档案。" };
      const data = parseCharData(c.data);
      data.refs.push({
        slotKey: `custom_${now()}`, label: args.label, groupKey: "custom", custom: true,
        imageKey: null, filled: false, candidateKey: null, genStatus: "none", genError: "",
      });
      await saveCharacter(db, c, data, {});
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  deleteRefSlot: deskAction({
    request: z.object({ characterId: z.number().int(), slotKey: z.string().max(80) }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked") return { ok: false, error: "档案已锁版，不能删除参考格；请先解锁档案。" };
      const data = parseCharData(c.data);
      const slot = data.refs.find((r) => r.slotKey === args.slotKey);
      if (!slot) return { ok: false, error: "参考格不存在。" };
      if (!slot.custom) return { ok: false, error: "标准参考格不能删除；只有自定义格可删。" };
      data.refs = data.refs.filter((r) => r.slotKey !== args.slotKey);
      await saveCharacter(db, c, data, {});
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  clearRefSlot: deskAction({
    request: z.object({ characterId: z.number().int(), slotKey: z.string().max(80) }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked") return { ok: false, error: "档案已锁版，不能清除参考图；请先解锁档案。" };
      const data = parseCharData(c.data);
      const slot = data.refs.find((r) => r.slotKey === args.slotKey);
      if (!slot) return { ok: false, error: "参考格不存在。" };
      slot.imageKey = null;
      slot.filled = false;
      slot.mediaMissing = false;
      slot.candidateKey = null;
      slot.genStatus = "none";
      slot.genError = "";
      slot.genStartedAt = null;
      slot.genAttemptId = null;
      data.changeLog = [logLine(c.archiveVersion, `定版图清除：${slot.label}`), data.changeLog].filter(Boolean).join("\n");
      await saveCharacter(db, c, data, {});
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  autoFillAndLockIdentity: deskAction({
    request: z.object({ characterId: z.number().int() }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable(), note: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。", note: "" };
      const data = parseCharData(c.data);
      let note = "";
      const filledLabels = data.refs.filter((r) => slotHasRealImage(r)).map((r) => r.label);
      if (!c.imageKey && filledLabels.length === 0)
        return { ok: false, error: "还没有任何带真实图片的定版图，无法自动生成身份锁。只有定版记录、原图缺失的格子不算；先上传或生成并定版至少一张真实参考图。", note: "" };
      const emptyLockFields = (["lockFace", "lockEyes", "lockFeatures", "lockHair", "lockSkin", "lockBuild", "lockProportions", "lockMarks"] as const)
        .filter((f) => !s(data[f]).trim());
      const needText =
        emptyLockFields.length > 0 || !s(data.visualAnchor).trim() ||
        !s(data.masterPrompt).trim() || !s(data.identityPrompt).trim() || !s(data.negativePrompt).trim();
      if (needText && !ctx.providers.inference) return { ok: false, error: GENERATION_UNCONNECTED, note: "尚未自动补写或锁定档案。可先手动补齐身份锁文字。" };
      if (needText) {
        try {
          const out = await ctx.inference.complete(
            [
              `你在为短片人物「${c.name}」撰写身份锁文字。只能依据下面已有的档案文字与已定版参考图清单来写，不得虚构档案里没有的具体长相细节；已有信息不足的字段就留空字符串。`,
              `身份一句话：${s(data.identity)}`,
              `年龄感：${s(data.ageImpression)}；时代地域背景：${s(data.background)}`,
              `已有身份锁逐项（原文）：脸型骨骼=${data.lockFace}｜眼睛=${data.lockEyes}｜眉鼻嘴=${data.lockFeatures}｜发型=${data.lockHair}｜肌肤=${data.lockSkin}｜体态=${data.lockBuild}｜身材比例=${data.lockProportions}｜标志特征=${data.lockMarks}`,
              `持续特征：${s(data.persistentFeatures)}`,
              `服装：${s(data.wardrobe)}`,
              `已定版参考图：${[c.imageKey ? "主定版肖像" : "", ...filledLabels].filter(Boolean).join("、")}`,
              `请补齐空缺字段：身份锁逐项（具体、可执行、同一人识别口径）、视觉锚点一句话、主提示词一段、身份锁提示词一段（整段可直接用于生成）、负面提示词一段（列出绝不能出现的漂移）。已有内容的字段原样返回。`,
            ].join("\n"),
            {
              schema: z.object({
                lockFace: z.string(), lockEyes: z.string(), lockFeatures: z.string(),
                lockHair: z.string(), lockSkin: z.string(), lockBuild: z.string(),
                lockProportions: z.string(), lockMarks: z.string(),
                visualAnchor: z.string(), masterPrompt: z.string(),
                identityPrompt: z.string(), negativePrompt: z.string(),
              }),
            },
          );
          const filledNow: string[] = [];
          for (const f of ["lockFace", "lockEyes", "lockFeatures", "lockHair", "lockSkin", "lockBuild", "lockProportions", "lockMarks", "visualAnchor", "masterPrompt", "identityPrompt", "negativePrompt"] as const) {
            if (!s(data[f]).trim() && out[f].trim()) {
              data[f] = out[f].trim();
              filledNow.push(f);
            }
          }
          data.autoFilledFields = Array.from(new Set([...data.autoFilledFields, ...filledNow]));
          if (filledNow.length) data.identityTextStatus = "generated";
          note = filledNow.length
            ? `已自动填入 ${filledNow.length} 个空缺字段（标「自动生成，可改」）。`
            : "空缺字段依据现有档案信息不足以补齐，保持留空。";
        } catch {
          note = "自动填入暂不可用（模型通道异常），已按现有文字直接登记基准并锁定，可稍后解锁补填。";
        }
      }
      const baseline: string[] = [
        ...(c.imageKey ? ["master"] : []),
        ...data.refs.filter((r) => slotHasRealImage(r)).map((r) => r.slotKey),
      ];
      const newVersion = c.archiveVersion + 1;
      data.identityBaseline = baseline;
      data.identityBaselineVersion = newVersion;
      data.archiveLockedAt = now();
      data.changeLog = [
        logLine(newVersion, `自动填入身份锁并锁定：登记基准定版图 ${baseline.length} 张${note ? `（${note}）` : ""}`),
        data.changeLog,
      ].filter(Boolean).join("\n");
      await db
        .update(schema.characters)
        .set({
          data: JSON.stringify(data), archiveStatus: "locked",
          archiveVersion: newVersion,
          refsFilled: countFilled(data, c.imageKey), refsTotal: totalSlots(data),
          updatedAt: now(),
        })
        .where(eq(schema.characters.id, c.id));
      ctx.invalidateQueries();
      return { ok: true, error: null, note };
    },
  }),

  unlockCharacter: deskAction({
    request: z.object({ characterId: z.number().int(), reason: z.string().min(1).max(500) }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus !== "locked") return { ok: false, error: "该档案当前未锁版。" };
      const data = parseCharData(c.data);
      const newVersion = c.archiveVersion + 1;
      data.changeLog = [logLine(newVersion, `解锁档案：${args.reason}`), data.changeLog].filter(Boolean).join("\n");
      await db
        .update(schema.characters)
        .set({
          data: JSON.stringify(data), archiveStatus: "draft",
          archiveVersion: newVersion, updatedAt: now(),
        })
        .where(eq(schema.characters.id, c.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  uploadVoiceRef: deskAction({
    request: z.object({
      characterId: z.number().int(), name: z.string().min(1).max(80),
      dataBase64: z.string().min(10).max(24000000),
      mimeType: z.string().max(60),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked") return { ok: false, error: "档案已锁版，不能新增声音参考；请先解锁档案。" };
      const key = `character-${c.id}-voice-${now()}`;
      await ctx.blobs.put(key, decodeB64(args.dataBase64), { contentType: args.mimeType });
      const data = parseCharData(c.data);
      data.voiceRefs.push({
        id: `v${now()}`, name: args.name, key, mimeType: args.mimeType,
        isMain: data.voiceRefs.length === 0,
      });
      await saveCharacter(db, c, data, {});
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  updateVoiceRefs: deskAction({
    request: z.object({
      characterId: z.number().int(),
      voiceRefs: z.array(z.object({
        id: z.string(), name: z.string().max(80), key: z.string(),
        mimeType: z.string(), isMain: z.boolean(),
      })).max(20),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, args.characterId));
      if (!c) return { ok: false, error: "人物不存在。" };
      if (c.archiveStatus === "locked") return { ok: false, error: "档案已锁版，不能修改声音参考；请先解锁档案。" };
      const data = parseCharData(c.data);
      const validKeys = new Set(data.voiceRefs.map((v) => v.key));
      const next = args.voiceRefs.filter((v) => validKeys.has(v.key));
      let mainSeen = false;
      for (const v of next) {
        if (v.isMain && !mainSeen) mainSeen = true;
        else if (v.isMain) v.isMain = false;
      }
      data.voiceRefs = next;
      await saveCharacter(db, c, data, {});
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // ---------- 场景 ----------

  createScene: deskAction({
    request: z.object({ projectId: z.number().int(), name: z.string().min(1).max(80) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const t = now();
      const [row] = await db
        .insert(schema.scenes)
        .values({ projectId: args.projectId, name: args.name, createdAt: t, updatedAt: t })
        .returning({ id: schema.scenes.id });
      if (!row) throw new Error("createScene failed");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateScene: deskAction({
    request: z.object({
      id: z.number().int(),
      name: z.string().min(1).max(80).optional(),
      location: z.string().max(2000).optional(),
      timeOfDay: z.string().max(200).optional(),
      lighting: z.string().max(2000).optional(),
      atmosphere: z.string().max(2000).optional(),
      palette: z.string().max(2000).optional(),
      notes: z.string().max(4000).optional(),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const { id, ...fields } = args;
      await db
        .update(schema.scenes)
        .set({ ...fields, updatedAt: now() })
        .where(eq(schema.scenes.id, id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  deleteScene: deskAction({
    request: z.object({ id: z.number().int() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.scenes).where(eq(schema.scenes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  uploadSceneImage: deskAction({
    request: z.object({
      sceneId: z.number().int(),
      dataBase64: z.string().min(10).max(16000000),
      mimeType: z.string().max(60),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = `scene-${args.sceneId}-image-${now()}`;
      await ctx.blobs.put(key, decodeB64(args.dataBase64), { contentType: args.mimeType });
      await db
        .update(schema.scenes)
        .set({ imageKey: key, updatedAt: now() })
        .where(eq(schema.scenes.id, args.sceneId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 场景图生成：纯场景（提示词+场景卡）或参照人物结合生成（勾选一个或
  // 多个本项目人物，以其已定版主肖像/参考图为身份基准、身份锁原文不
  // 改写，连同场景提示词生成一张结合图）。与人物参考图同一通道纪律：
  // 有参照图时派 Muse 助手把图片本身传入生图、文件直读回填；成图只
  // 落场景卡作候选图待审核，通过（reviewSceneImage）后才设为场景图，
  // 绝不直接覆盖原场景图、绝不替用户定版。生成中防重复；超时未回填
  // 只标待核查，确认旧执行终止后用 releaseSceneGenClaim 释放。
  generateSceneImage: deskAction({
    request: z.object({
      sceneId: z.number().int(),
      prompt: z.string().max(4000).default(""),
      characterIds: z.array(z.number().int()).max(8).default([]),
    }),
    response: ok,
    privileged: [privileged.exportRefImageFile],
    async handler(ctx, args) {
      if (!ctx.providers.image) return { ok: false, error: GENERATION_UNCONNECTED };
      const db = ctx.db<typeof schema>();
      const [sc] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, args.sceneId));
      if (!sc) return { ok: false, error: "场景不存在。" };
      if (sc.candidateKey)
        return { ok: false, error: `场景「${sc.name}」已有一张生成候选图待审核：先「通过·设为场景图」或「丢弃候选」处理它，再重新生成，避免候选与定版混淆。` };
      if (sc.genStatus === "running") {
        const stale = sc.genStartedAt == null || now() - sc.genStartedAt > GEN_STALE_MS;
        if (stale)
          return { ok: false, error: `场景「${sc.name}」上一次生成已超过 30 分钟没有回填，状态待核查（不等于已中断）：可能原生成仍在运行，也可能图已生成但回填卡住。请先核查原执行；确认旧执行已终止后，在场景卡点「释放卡住的生成」放开再重新生成。未做任何更改，也没有重复生成。` };
        return { ok: false, error: `场景「${sc.name}」正在生成中，成图将回到本场景卡作候选图待审核；请勿重复提交。` };
      }
      const userPrompt = args.prompt.trim();
      const charIds = [...new Set(args.characterIds)];
      const members: Array<{ c: typeof schema.characters.$inferSelect; data: CharData; pack: RefPackItem[] }> = [];
      for (const cid of charIds) {
        const [c] = await db.select().from(schema.characters).where(eq(schema.characters.id, cid));
        if (!c || c.projectId !== sc.projectId)
          return { ok: false, error: "所选人物不属于本项目，已拦下，未做任何更改。" };
        const data = parseCharData(c.data);
        const { pack } = buildRefPack(c, data);
        if (pack.length === 0)
          return { ok: false, error: `人物「${c.name}」在档案里还没有任何真实定版图（主肖像与参考格都没有图），不能作结合生成的身份基准：请先为其定版至少主肖像，或取消勾选该人物。未做任何更改。` };
        members.push({ c, data, pack });
      }
      if (!userPrompt && members.length === 0 && !sc.location.trim() && !sc.notes.trim() && !sc.imageKey)
        return { ok: false, error: "还没有可生成的依据：请填写场景提示词、补场景卡内容（地点/备注），或勾选参照人物后再生成。" };
      // 参照包：场景现有图（环境基准）第一位，其后按勾选顺序逐人放其
      // 锚点图与定版参考图（buildRefPack 已按锚点→基准→定版排序），
      // 全量上限与人物参考图同一口径 12 张，超出明示。
      const refs: Array<{ label: string; key: string; role: string; charName?: string }> = [];
      const seenKeys = new Set<string>();
      const pushRef = (label: string, key: string | null, role: string, charName?: string) => {
        if (!key || seenKeys.has(key)) return;
        seenKeys.add(key);
        refs.push({ label, key, role, ...(charName ? { charName } : {}) });
      };
      if (sc.imageKey) pushRef("场景现有图", sc.imageKey, "环境基准（现有场景图）");
      for (const m of members)
        for (const p of m.pack) pushRef(p.label, p.key, p.role, m.c.name);
      let omitted = 0;
      if (refs.length > REF_PACK_CAP) {
        omitted = refs.length - REF_PACK_CAP;
        refs.length = REF_PACK_CAP;
      }
      const refNote = refs.length
        ? `本次参照：${refs.map((r, i) => `${i + 1}.${r.charName ? `「${r.charName}」` : ""}${r.label}${r.role.includes("主定锚点") ? "（身份锚点）" : r.role.includes("环境基准") ? "（环境基准）" : ""}`).join("、")}——图像本身已传入生成${omitted ? `；另有 ${omitted} 张定版图超单次上限未传入` : ""}`
        : "本次无参照图：按场景卡文字与用户提示词纯文字生成";
      const cardBits = [
        sc.location ? `地点 ${sc.location}` : "",
        sc.timeOfDay ? `时段 ${sc.timeOfDay}` : "",
        sc.lighting ? `光线 ${sc.lighting}` : "",
        sc.atmosphere ? `氛围 ${sc.atmosphere}` : "",
        sc.palette ? `色板 ${sc.palette}` : "",
        sc.notes ? `备注 ${sc.notes}` : "",
      ].filter(Boolean);
      const promptLines: string[] = [
        members.length
          ? `为场景「${sc.name}」生成一张结合图：所选 ${members.length} 位人物出现在这个场景里（横幅构图，写实）。`
          : `为场景「${sc.name}」生成一张场景图（横幅构图，写实，不出现人物——除非用户提示词明确要求）。`,
        cardBits.length ? `场景卡：${cardBits.join("｜")}` : "",
      ];
      if (sc.imageKey && refs.length && refs[0]?.key === sc.imageKey)
        promptLines.push("【环境基准】随附图片第 1 张是本场景现有场景图：环境的空间结构、陈设与氛围以它为准，在此基础上按本次要求生成新图。");
      for (const m of members) {
        const idxs = refs.map((r, i) => (r.charName === m.c.name ? i + 1 : 0)).filter((n) => n > 0);
        if (idxs.length)
          promptLines.push(
            `【严格参照人物定版图——以图为准】人物「${m.c.name}」的定版参考图是随附图片第 ${idxs.join("、")} 张（第 ${idxs[0]} 张是其主定锚点）：${m.c.name} 出场时必须严格以这些图片本身为准——同一张脸、脸型骨骼、五官、发型、肌肤、体型与服装不得漂移，不得只按文字描述另行想象这个人。`,
          );
        if (s(m.data.identityPrompt))
          promptLines.push(`人物「${m.c.name}」身份锁（原文，不得改写）：${s(m.data.identityPrompt)}`);
        if (s(m.data.masterPrompt))
          promptLines.push(`人物「${m.c.name}」主提示词：${s(m.data.masterPrompt)}`);
        if (s(m.data.negativePrompt))
          promptLines.push(`人物「${m.c.name}」必须避免：${s(m.data.negativePrompt)}`);
      }
      if (userPrompt) promptLines.push(`用户提示词（本次生成要求）：${userPrompt}`);
      promptLines.push(
        members.length
          ? "画面要求：一张完整连贯的场景画面，所选人物全部自然地处在场景中——站位、光影、透视与场景一致，人物之间互不换脸、不串装、不多出未勾选的人物。写实摄影风格。"
          : "画面要求：一张完整连贯的场景画面，环境细节与场景卡一致。写实摄影风格。",
      );
      const frozenPrompt = promptLines.filter(Boolean).join("\n");
      const startedAt = now();
      const saveScene = async (patch: Partial<typeof schema.scenes.$inferInsert>) => {
        await db.update(schema.scenes).set({ ...patch, updatedAt: now() }).where(eq(schema.scenes.id, sc.id));
      };
      const setFailed = async (jobId: number | undefined, msg: string) => {
        await saveScene({ genStatus: "failed", genError: msg, genAttemptId: null });
        if (jobId)
          await db.update(schema.genJobs).set({ status: "failed", error: msg, updatedAt: now() }).where(eq(schema.genJobs.id, jobId));
        ctx.invalidateQueries();
      };

      // 无任何参照图（纯场景文字生成）：动作内纯文字生图，成图作候选。
      if (refs.length === 0) {
        await saveScene({
          genStatus: "running", genError: "", genStartedAt: startedAt, genAttemptId: null,
          genNote: refNote, genPrompt: userPrompt, genCharIds: JSON.stringify(charIds),
        });
        const [job] = await db.insert(schema.genJobs).values({
          projectId: sc.projectId, kind: "scenegen",
          status: "generating", detail: `场景图生成中（纯文字）：${sc.name}｜冻结提示词：\n${frozenPrompt}`,
          createdAt: now(), updatedAt: now(),
        }).returning({ id: schema.genJobs.id });
        try {
          const media = await ctx.tool.generate_media(frozenPrompt, { orientation: "landscape" });
          await saveScene({ candidateKey: media.blobKey, genStatus: "done", genError: "" });
          if (job)
            await db.update(schema.genJobs)
              .set({ status: "returned", detail: `场景图已生成（候选图，待用户审核通过才设为场景图）：${sc.name}`, updatedAt: now() })
              .where(eq(schema.genJobs.id, job.id));
          ctx.invalidateQueries();
          return { ok: true, error: null };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await setFailed(job?.id, msg);
          return { ok: false, error: `场景图生成失败：${msg}` };
        }
      }

      // 参照路径：导出参照包为真实文件 → 派 Muse 助手以图片本身作
      // 参照生成 → completeSceneImage 文件直读回填本场景卡作候选图。
      const attemptId = `sat-${sc.id}-${startedAt.toString(36)}`;
      await saveScene({
        genStatus: "running", genError: "", genStartedAt: startedAt, genAttemptId: attemptId,
        genNote: refNote, genPrompt: userPrompt, genCharIds: JSON.stringify(charIds),
      });
      const [job] = await db.insert(schema.genJobs).values({
        projectId: sc.projectId, kind: "scenegen",
        status: "awaiting_assistant", attemptId, attemptNo: 1,
        detail: `场景图生成（参照结合）：${sc.name}｜${refNote}｜冻结提示词：\n${frozenPrompt}`,
        createdAt: now(), updatedAt: now(),
      }).returning({ id: schema.genJobs.id });
      const files: Array<{ label: string; role: string; path: string }> = [];
      try {
        for (let i = 0; i < refs.length; i++) {
          const r = refs[i];
          if (!r) continue;
          const ex = await ctx.executePrivileged(privileged.exportRefImageFile, {
            spaceDir: ctx.spaceDir, mediaKey: r.key,
            outName: `scene${sc.id}-ref${i}`,
          });
          if (ex.error || !ex.path)
            throw new Error(`参照图「${r.label}」导出失败：${ex.error ?? "未返回文件路径"}`);
          files.push({ label: r.charName ? `「${r.charName}」${r.label}` : r.label, role: r.role, path: ex.path });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await setFailed(job?.id, `参照图准备失败：${msg}`);
        return { ok: false, error: `场景「${sc.name}」未启动生成：参照图准备失败——${msg}。没有参照图就不按文字放行；请确认参照图文件完好后重试。` };
      }
      const message = [
        `你是导演台的场景图生成执行助手。请为场景「${sc.name}」生成一张图${members.length ? `（结合图：${members.map((m) => m.c.name).join("、")} 出现在该场景里）` : ""}，生成后第一时间回填到导演台同一张场景卡作候选图待用户审核——不要把图只发到聊天里、不要存进资源库就算完成，场景卡里没有候选图就不算完成。`,
        `【最重要：严格参照随附图片，以图为准】下面按顺序列出的图片文件必须作为图片参照实际传入你的生图工具（生成提示里带上这些图片本身，不只是文字）：场景现有图是环境基准；每个人物的第一张定版图是其身份锚点，脸、发型、体型、服装都以它为准，不得漂移；冲突时以锚点图为准。参考图片（顺序不得调整）：`,
        ...files.map((f, i) => `${i + 1}. ${f.label}（${f.role}）：${f.path}`),
        `本次领取的尝试标识 attemptId=${attemptId}。回填与报告失败时必须原样带上 attemptId；标识对不上的晚到回调会被服务端拒绝，不得覆盖更新的尝试。`,
        `生成完成后立刻调用导演台动作 completeSceneImage，只传短参数：sceneId=${sc.id}、attemptId=${attemptId}、filePath=生成图片文件的绝对路径（生成工具返回的 local_path，原样照抄，不要改名、不要转存）。服务端会直读该文件存回同一场景卡作候选图。严禁把图片转成 base64 文本转录。`,
        `如果生成失败或通道不可用，调用 completeSceneImage 并传 sceneId=${sc.id}、attemptId=${attemptId} 与 error 写明真实原因，不要编造结果。`,
        "回填后不要自行定版：候选图由用户在场景卡审核，通过后才设为场景图、才会被后续生成引用；原场景图在用户通过前保持不变。",
        "",
        "—— 冻结提示词（不得改写其中身份锁原文） ——",
        frozenPrompt,
      ].join("\n");
      let taskId: string | null = null;
      let spawnErr: string | null = null;
      try {
        const tsk = await ctx.agent.spawnTask(message, {
          expectsAction: "completeSceneImage",
          dedupeKey: `scenegen-${sc.id}-${attemptId}`,
        });
        if (tsk.ok) taskId = tsk.taskId;
        else spawnErr = tsk.error;
      } catch (e) {
        spawnErr = e instanceof Error ? e.message : String(e);
      }
      if (!taskId) {
        const msg = `助手领取未启动：${spawnErr ?? "未知原因"}。本次没有产生任何生成，直接再点一次生成即可重试。`;
        await setFailed(job?.id, msg);
        return { ok: false, error: `场景「${sc.name}」未启动生成：${msg}` };
      }
      if (job)
        await db.update(schema.genJobs)
          .set({
            status: "generating",
            detail: `场景图生成（参照结合）：${sc.name}｜${refNote}｜Muse 助手已领取执行（任务 ${taskId}），将以随附图片本身为参照生成，成图回填本场景卡作候选图待审核。｜冻结提示词：\n${frozenPrompt}`,
            updatedAt: now(),
          })
          .where(eq(schema.genJobs.id, job.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 场景图回填（参照结合生成的唯一回调）：与 completeRefImage 同口径——
  // 尝试标识校验、文件直读拼装、图片文件头校验、SHA-256，落回同一场
  // 景卡作候选图（待审核），不触碰原场景图。传 error 则标为生成失败。
  completeSceneImage: deskAction({
    request: z.object({
      sceneId: z.number().int(),
      attemptId: z.string().max(120).optional(),
      filePath: z.string().min(1).max(600).optional(),
      error: z.string().max(4000).optional(),
    }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(),
      bytes: z.number(), sha256: z.string().nullable(),
    }),
    privileged: [privileged.readWorkspaceImageChunk],
    async handler(ctx, args): Promise<{ ok: boolean; error: string | null; bytes: number; sha256: string | null }> {
      const fail = (error: string) => ({ ok: false, error, bytes: 0, sha256: null });
      const db = ctx.db<typeof schema>();
      const [sc] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, args.sceneId));
      if (!sc) return fail("场景不存在。");
      if (sc.genStatus !== "running")
        return fail(`回填被拒绝：场景「${sc.name}」当前不在生成中（状态：${sc.genStatus}），这通常是重复回填或已被释放的旧执行晚到。未做任何更改。`);
      if (sc.genAttemptId && args.attemptId !== sc.genAttemptId)
        return fail(`回填被拒绝：尝试标识不符（本场景当前尝试 ${sc.genAttemptId}，回调带来 ${args.attemptId ?? "无标识"}）。这通常是已被释放/轮换的旧执行晚到回调，不能覆盖新尝试；请由当前尝试的执行方带正确 attemptId 回填。未做任何更改。`);
      if (sc.candidateKey)
        return fail(`回填被拒绝：场景「${sc.name}」已有候选图待审核，不重复回填。未做任何更改。`);
      const jobs = (await db.select().from(schema.genJobs)
        .where(and(eq(schema.genJobs.projectId, sc.projectId), eq(schema.genJobs.kind, "scenegen"))))
        .sort((a, b) => b.createdAt - a.createdAt);
      // 本地恢复：场景表没有 job 外键；只修改能由尝试标识确定归属的任务。
      const job = sc.genAttemptId ? jobs.find((j) => j.attemptId === sc.genAttemptId) : undefined;
      const markJob = async (patch: Partial<typeof schema.genJobs.$inferInsert>) => {
        if (job) await db.update(schema.genJobs).set({ ...patch, updatedAt: now() }).where(eq(schema.genJobs.id, job.id));
      };
      const saveScene = async (patch: Partial<typeof schema.scenes.$inferInsert>) => {
        await db.update(schema.scenes).set({ ...patch, updatedAt: now() }).where(eq(schema.scenes.id, sc.id));
      };
      if (args.error) {
        await saveScene({ genStatus: "failed", genError: args.error, genAttemptId: null });
        await markJob({ status: "failed", error: args.error });
        ctx.invalidateQueries();
        return { ok: true, error: null, bytes: 0, sha256: null };
      }
      if (!args.filePath)
        return fail("既没有给出生成图片的文件路径，也没有给出失败原因，无法回填。未做任何更改。");
      const CHUNK = 786432;
      let assembled: Uint8Array | null = null;
      let total = -1;
      let offset = 0;
      try {
        for (;;) {
          const part = await ctx.executePrivileged(privileged.readWorkspaceImageChunk, {
            path: args.filePath, offset, maxBytes: CHUNK,
          });
          if (total < 0) {
            total = part.totalBytes;
            if (total < 100) return fail(`生成图片只有 ${total} 字节，不像完整图片，未做任何更改。`);
            assembled = new Uint8Array(total);
          }
          if (part.bytesRead > 0 && assembled) {
            assembled.set(decodeB64(part.dataBase64), offset);
            offset += part.bytesRead;
          }
          if (part.eof) break;
          if (part.bytesRead === 0) return fail("读取生成图片中途无数据，文件可能仍在写入或已被移动，未做任何更改。");
        }
      } catch (e) {
        return fail(`读取生成图片失败：${e instanceof Error ? e.message : String(e)}。未做任何更改；请确认文件路径无误、文件确在工作区内。`);
      }
      if (!assembled || offset !== total)
        return fail(`生成图片读取不完整：应读 ${total} 字节、实读 ${offset} 字节，未做任何更改。`);
      const head = assembled.subarray(0, 12);
      let mimeType = "";
      if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) mimeType = "image/jpeg";
      else if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) mimeType = "image/png";
      else if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) mimeType = "image/webp";
      else if (head.length >= 4 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) mimeType = "image/gif";
      if (!mimeType)
        return fail("文件头不是可识别的图片格式（JPEG/PNG/WebP/GIF），未做任何更改。");
      const sha = await sha256Hex(assembled);
      const key = `scene-${sc.id}-gen-cand-${now()}`;
      await ctx.blobs.put(key, assembled, { contentType: mimeType });
      await saveScene({ candidateKey: key, genStatus: "done", genError: "", genAttemptId: null });
      await markJob({
        status: "returned",
        detail: `场景图已生成并回填本场景卡（候选图，待用户审核通过才设为场景图）：${sc.name}（约 ${(assembled.length / 1048576).toFixed(2)}MB · SHA-256 ${sha.slice(0, 16)}… · 文件直读回填）。`,
        error: "",
      });
      ctx.invalidateQueries();
      return { ok: true, error: null, bytes: assembled.length, sha256: sha };
    },
  }),

  // 场景候选图审核：通过才把候选设为场景图（替换原图）；丢弃则只清
  // 候选，原场景图保持不变。服务端不替用户定版。
  reviewSceneImage: deskAction({
    request: z.object({ sceneId: z.number().int(), approve: z.boolean() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [sc] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, args.sceneId));
      if (!sc) return { ok: false, error: "场景不存在。" };
      if (!sc.candidateKey) return { ok: false, error: "该场景没有待审核的生成候选图。" };
      await db.update(schema.scenes)
        .set({
          ...(args.approve ? { imageKey: sc.candidateKey } : {}),
          candidateKey: null, genStatus: "none", genError: "", updatedAt: now(),
        })
        .where(eq(schema.scenes.id, sc.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 释放卡住的场景图生成：与人物参考图同一口径——超时无回填不等于已
  // 中断，须确认旧执行已终止才释放并作废旧尝试标识。
  releaseSceneGenClaim: deskAction({
    request: z.object({
      sceneId: z.number().int(),
      confirmTerminated: z.boolean(),
      note: z.string().max(1000).default(""),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [sc] = await db.select().from(schema.scenes).where(eq(schema.scenes.id, args.sceneId));
      if (!sc) return { ok: false, error: "场景不存在。" };
      if (sc.genStatus !== "running")
        return { ok: false, error: `场景「${sc.name}」当前状态是「${sc.genStatus}」，不是生成中，无需释放。` };
      if (!args.confirmTerminated)
        return { ok: false, error: "未确认旧执行已终止，不能释放：无回填可能是原生成仍在运行，或图已生成但回填卡住。请先核查原执行与原产物；状态不明就保留未知，不要直接重新生成。" };
      const oldAttempt = sc.genAttemptId || "无标识";
      const note = `已释放卡住的生成（尝试 ${oldAttempt}）${args.note ? `，核查说明：${args.note}` : ""}，于 ${new Date(now()).toISOString()} 释放；旧尝试标识已作废，其晚到回调将被拒绝。重新生成将发放新尝试标识。`;
      await db.update(schema.scenes)
        .set({ genStatus: "none", genError: "", genStartedAt: null, genAttemptId: null, genNote: note, updatedAt: now() })
        .where(eq(schema.scenes.id, sc.id));
      const jobs = (await db.select().from(schema.genJobs)
        .where(and(eq(schema.genJobs.projectId, sc.projectId), eq(schema.genJobs.kind, "scenegen"))))
        .sort((a, b) => b.createdAt - a.createdAt);
      const job = oldAttempt !== "无标识" ? jobs.find((j) => j.attemptId === oldAttempt) : undefined;
      if (job)
        await db.update(schema.genJobs)
          .set({ status: "failed", attemptId: null, detail: `${job.detail}｜领取释放记录：${note}`, updatedAt: now() })
          .where(eq(schema.genJobs.id, job.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // ---------- 分镜 ----------

  createShot: deskAction({
    request: z.object({ projectId: z.number().int() }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable(), id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.projectId));
      if (!p) return { ok: false, error: "项目不存在。", id: 0 };
      if (p.locked === 1) return { ok: false, error: "项目已锁版，分镜已冻结，不能新增镜头。", id: 0 };
      const existing = await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.projectId));
      const prev = existing.slice().sort((a, b) => a.sortOrder - b.sortOrder).at(-1);
      const t = now();
      const [row] = await db
        .insert(schema.shots)
        .values({
          projectId: args.projectId,
          sortOrder: existing.length,
          durationSec: 10,
          startState: prev ? prev.endState : "",
          handoffNote: "",
          createdAt: t, updatedAt: t,
        })
        .returning({ id: schema.shots.id });
      if (!row) return { ok: false, error: "新增镜头失败。", id: 0 };
      ctx.invalidateQueries();
      return { ok: true, error: null, id: row.id };
    },
  }),

  updateShot: deskAction({
    request: z.object({
      id: z.number().int(),
      durationSec: z.number().positive().max(600).optional(),
      framing: z.string().max(500).optional(),
      cameraMove: z.string().max(500).optional(),
      characterId: z.number().int().nullable().optional(),
      sceneId: z.number().int().nullable().optional(),
      // 多选真源：传了数组就以数组为准（去重、过滤不属于本项目的 id），
      // 单值字段同步为第一项；只传旧单值时数组同步为单元素/空。
      characterIds: z.array(z.number().int()).max(50).optional(),
      sceneIds: z.array(z.number().int()).max(50).optional(),
      characterPosition: z.string().max(2000).optional(),
      startState: z.string().max(4000).optional(),
      action: z.string().max(8000).optional(),
      endState: z.string().max(4000).optional(),
      handoffNote: z.string().max(4000).optional(),
      firstFrameLabel: z.string().max(500).optional(),
      lastFrameLabel: z.string().max(500).optional(),
      promptEn: z.string().max(8000).optional(),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [sh] = await db.select().from(schema.shots).where(eq(schema.shots.id, args.id));
      if (!sh) return { ok: false, error: "镜头不存在。" };
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, sh.projectId));
      if (p?.locked === 1)
        return { ok: false, error: "项目已锁版，分镜已冻结，不能修改镜头内容（画质仍可单独调整）。" };
      const { id, characterIds: inCharIds, sceneIds: inSceneIds, ...fields } = args;
      const patch: Partial<typeof schema.shots.$inferInsert> = { ...fields };
      if (inCharIds !== undefined || args.characterId !== undefined) {
        const validChars = new Set(
          (await db.select({ id: schema.characters.id }).from(schema.characters).where(eq(schema.characters.projectId, sh.projectId))).map((x) => x.id),
        );
        const next = inCharIds !== undefined
          ? sanitizeShotIds(inCharIds, validChars)
          : (args.characterId != null && validChars.has(args.characterId) ? [args.characterId] : []);
        patch.characterIds = JSON.stringify(next);
        patch.characterId = next[0] ?? null;
      }
      if (inSceneIds !== undefined || args.sceneId !== undefined) {
        const validScenes = new Set(
          (await db.select({ id: schema.scenes.id }).from(schema.scenes).where(eq(schema.scenes.projectId, sh.projectId))).map((x) => x.id),
        );
        const next = inSceneIds !== undefined
          ? sanitizeShotIds(inSceneIds, validScenes)
          : (args.sceneId != null && validScenes.has(args.sceneId) ? [args.sceneId] : []);
        patch.sceneIds = JSON.stringify(next);
        patch.sceneId = next[0] ?? null;
      }
      await db.update(schema.shots).set({ ...patch, updatedAt: now() }).where(eq(schema.shots.id, id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  deleteShot: deskAction({
    request: z.object({ id: z.number().int() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [sh] = await db.select().from(schema.shots).where(eq(schema.shots.id, args.id));
      if (!sh) return { ok: false, error: "镜头不存在。" };
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, sh.projectId));
      if (p?.locked === 1) return { ok: false, error: "项目已锁版，分镜已冻结，不能删除镜头。" };
      const res = await db.select().from(schema.results).where(eq(schema.results.shotId, args.id));
      if (res.length > 0)
        return { ok: false, error: "该镜头已有生成结果版本，不能直接删除；请先在质检页删除其结果版本。" };
      await db.delete(schema.shots).where(eq(schema.shots.id, args.id));
      const rest = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, sh.projectId)))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      for (let i = 0; i < rest.length; i++) {
        const r = rest[i];
        if (r && r.sortOrder !== i)
          await db.update(schema.shots).set({ sortOrder: i }).where(eq(schema.shots.id, r.id));
      }
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  moveShot: deskAction({
    request: z.object({ id: z.number().int(), direction: z.enum(["up", "down"]) }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [sh] = await db.select().from(schema.shots).where(eq(schema.shots.id, args.id));
      if (!sh) return { ok: false, error: "镜头不存在。" };
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, sh.projectId));
      if (p?.locked === 1) return { ok: false, error: "项目已锁版，分镜已冻结，不能调整镜头顺序。" };
      const all = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, sh.projectId)))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const idx = all.findIndex((x) => x.id === sh.id);
      const swap = args.direction === "up" ? idx - 1 : idx + 1;
      if (idx < 0 || swap < 0 || swap >= all.length) return { ok: true, error: null };
      const a = all[idx];
      const b = all[swap];
      if (!a || !b) return { ok: true, error: null };
      await db.update(schema.shots).set({ sortOrder: b.sortOrder }).where(eq(schema.shots.id, a.id));
      await db.update(schema.shots).set({ sortOrder: a.sortOrder }).where(eq(schema.shots.id, b.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  setShotQuality: deskAction({
    request: z.object({ shotId: z.number().int(), quality: z.enum(["480P", "720P", "1080P"]).nullable() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.shots)
        .set({ videoQuality: args.quality, updatedAt: now() })
        .where(eq(schema.shots.id, args.shotId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  setShotFrame: deskAction({
    request: z.object({
      shotId: z.number().int(),
      which: z.enum(["first", "last"]),
      dataBase64: z.string().min(10).max(16000000).nullable(),
      mimeType: z.string().max(60).default("image/jpeg"),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [sh] = await db.select().from(schema.shots).where(eq(schema.shots.id, args.shotId));
      if (!sh) return { ok: false, error: "镜头不存在。" };
      if (args.dataBase64 == null) {
        await db
          .update(schema.shots)
          .set(
            args.which === "first"
              ? { firstFrameKey: null, firstFrameMissing: 0, updatedAt: now() }
              : { lastFrameKey: null, lastFrameMissing: 0, updatedAt: now() },
          )
          .where(eq(schema.shots.id, args.shotId));
      } else {
        const key = `shot-${args.shotId}-${args.which}frame-${now()}`;
        await ctx.blobs.put(key, decodeB64(args.dataBase64), { contentType: args.mimeType });
        await db
          .update(schema.shots)
          .set(
            args.which === "first"
              ? { firstFrameKey: key, firstFrameMissing: 0, updatedAt: now() }
              : { lastFrameKey: key, lastFrameMissing: 0, updatedAt: now() },
          )
          .where(eq(schema.shots.id, args.shotId));
      }
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // ---------- 生成 / 质检 / 拼接 ----------

  dispatchGeneration: deskAction({
    privileged: [privileged.exportRefImageFile],
    request: z.object({
      shotId: z.number().int(),
      quality: z.enum(["480P", "720P", "1080P"]),
      // 质检重拍：上一版结果 id（须已判不通过）。带上后新任务单会写入该版
      // 质检意见与强制变化要求，与上一版任务单必然不同；不带则为普通首派。
      reshootFromResultId: z.number().int().optional(),
      // 本次重拍的质检意见（优先于上一版已存的 qcNote，并回写到上一版）。
      qcNote: z.string().max(4000).optional(),
    }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(),
      taskSheet: z.string().nullable(), warnings: z.array(z.string()),
      resultId: z.number(), jobStatus: z.string().nullable(),
      assistantTaskId: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const fail = { taskSheet: null, warnings: [] as string[], resultId: 0, jobStatus: null, assistantTaskId: null };
      if (!ctx.providers.video) return { ok: false, error: GENERATION_UNCONNECTED, ...fail };
      const [sh] = await db.select().from(schema.shots).where(eq(schema.shots.id, args.shotId));
      if (!sh) return { ok: false, error: "镜头不存在。", ...fail };
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, sh.projectId));
      if (!p) return { ok: false, error: "项目不存在。", ...fail };
      // 锁版已改为可选定稿（用户口径 2026-10-30）：派单不再以锁版为
      // 前置门槛——未锁版也能派单。派单时 buildTaskSheet 会自动冻结
      // 当前脚本、分镜、人物档案参考、场景卡参考与首尾帧链快照生成
      // 任务单并存入本版本；派单后改分镜不影响这一单，下一单才用新版。
      // 已锁版项目照常派单，其锁版状态与历史不动。
      // 防重复派单：本镜已有进行中的版本（已派单未回填、未失败）时直接拦下，
      // 连续点击、切换页面、多处入口同时派单、刷新后重派都不会再建新版本。
      // 「重试」指对原版本点「交给助手执行」重新领取，不产生新版本；失败或已回填的版本不挡新派单。
      const priorResults = await db.select().from(schema.results).where(eq(schema.results.shotId, sh.id));
      const priorJobs = await db.select().from(schema.genJobs).where(eq(schema.genJobs.projectId, p.id));
      const active = priorResults.find((r) =>
        r.genStatus === "running" && !r.videoKey &&
        ["awaiting_assistant", "generating", "dispatched"].includes(
          priorJobs.filter((j) => j.resultId === r.id).sort((a, b) => b.createdAt - a.createdAt)[0]?.status ?? "",
        ),
      );
      if (active) {
        const st = effectiveJobStatus(
          priorJobs.filter((j) => j.resultId === active.id).sort((a, b) => b.createdAt - a.createdAt)[0],
          !!active.videoKey,
        );
        return {
          ok: false,
          error: `第 ${sh.sortOrder + 1} 镜已有进行中的任务：版本 V${active.versionNumber}（${st === "generating" ? "生成中" : "待助手执行"}），任务已冻结、结果将回填到该版本。不要重复派单；如助手未启动，请到质检页对 V${active.versionNumber} 点「交给助手执行」（那是重试领取，不产生新版本）。`,
          taskSheet: active.taskSheet, warnings: [] as string[],
          resultId: active.id, jobStatus: st, assistantTaskId: null,
        };
      }
      // 严格链拦截：连续镜头必须有上一段真实尾帧图像作首帧，缺图/只有规划图/只有标签一律阻塞。
      {
        const allShots = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, p.id))).sort((a, b) => a.sortOrder - b.sortOrder);
        const allResults = await db.select().from(schema.results).where(eq(schema.results.projectId, p.id));
        const allLinks = await db.select().from(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, p.id));
        const allChars2 = await db.select().from(schema.characters).where(eq(schema.characters.projectId, p.id));
        const allScenes2 = await db.select().from(schema.scenes).where(eq(schema.scenes.projectId, p.id));
        const allNodes2 = await db.select().from(schema.canvasNodes).where(eq(schema.canvasNodes.projectId, p.id));
        let canvasFirstHasImage = false;
        for (const l of allLinks.filter((x) => x.toKind === "shot" && x.toId === sh.id && x.role === "firstframe")) {
          const key = l.fromKind === "character" ? allChars2.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "scene" ? allScenes2.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "node" ? allNodes2.find((x) => x.id === l.fromId)?.mediaKey : l.fromKind === "shot" ? allShots.find((x) => x.id === l.fromId)?.lastFrameKey : null;
          if (key) canvasFirstHasImage = true;
        }
        const block = strictChainBlock(p, sh, allShots, allResults, canvasFirstHasImage);
        if (block) return { ok: false, error: block, ...fail };
      }
      // 参照拦截（全工具通用）：指定了出场人物却没有任何真实定版图、
      // 或第一镜方式 B 连人物都没指定时，严格参照无图可依，直接拦住
      // 并指名——不许静默按文字生成（任务单只有警告拦不住实际派单，
  // 实测事故就是警告存在却照样派单生成出不像的人与错时长）。
      {
        const refBlock = await dispatchRefBlock(db, p, sh);
        if (refBlock) return { ok: false, error: refBlock, ...fail };
      }
      // 质检重拍校验：必须指名同镜一个已判「不通过」的版本，质检意见
      // （本次传入优先，其次该版已存 qcNote）会写进新任务单；没有不满意
      // 原因的重拍单和普通单逐字相同、必然生成一样——这正是要修的病根。
      let reshoot: { fromVersionNumber: number; fromResultId: number; qcNote: string; variantSeed: string } | undefined;
      if (args.reshootFromResultId != null) {
        const prev = priorResults.find((r) => r.id === args.reshootFromResultId);
        if (!prev)
          return { ok: false, error: "重拍来源版本不存在于本镜，不能重拍派单；请在质检页对要重拍的版本点「新派单重拍」。", ...fail };
        if (prev.qcStatus !== "fail")
          return { ok: false, error: `V${prev.versionNumber} 还没有被判质检不通过，不能走重拍派单：请先在该版本卡写清不满意原因（质检备注），点「✕ 重拍」判不通过，再点「新派单重拍」——质检意见会写进新任务单，保证新成片和上一版不一样。`, ...fail };
        const note = (args.qcNote ?? "").trim() || prev.qcNote;
        if ((args.qcNote ?? "").trim() && (args.qcNote ?? "").trim() !== prev.qcNote) {
          await db.update(schema.results).set({ qcNote: (args.qcNote ?? "").trim(), updatedAt: now() }).where(eq(schema.results.id, prev.id));
        }
        reshoot = {
          fromVersionNumber: prev.versionNumber,
          fromResultId: prev.id,
          qcNote: note,
          variantSeed: `reshoot-${sh.id}-from${prev.id}-${now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
        };
      }
      const sheet = await buildTaskSheet(db, p, sh, args.quality, reshoot);
      const existing = priorResults;
      const nextVer = existing.reduce((a, r) => Math.max(a, r.versionNumber), 0) + 1;
      const t = now();
      const [res] = await db
        .insert(schema.results)
        .values({
          projectId: p.id, shotId: sh.id, versionNumber: nextVer,
          label: reshoot ? `重拍 V${nextVer}（据 V${reshoot.fromVersionNumber} 质检意见）` : `台内生成 V${nextVer}`, genStatus: "running",
          videoQuality: args.quality, taskSheet: sheet.text,
          createdAt: t, updatedAt: t,
        })
        .returning({ id: schema.results.id });
      if (!res) return { ok: false, error: "派单失败。", ...fail };
      const [job] = await db
        .insert(schema.genJobs)
        .values({
          projectId: p.id, shotId: sh.id, resultId: res.id, kind: "video",
          status: "awaiting_assistant", videoQuality: args.quality,
          detail: reshoot
            ? `第 ${sh.sortOrder + 1} 镜重拍 · 据 V${reshoot.fromVersionNumber} 质检意见${reshoot.qcNote.trim() ? `「${reshoot.qcNote.trim().slice(0, 120)}」` : "（未填写具体意见）"} · 参考图 ${sheet.refCount} 张 · 重拍派单快照已冻结（含质检意见＋强制变化要求＋变化标识 ${reshoot.variantSeed}，与上一版任务单不同；${p.locked === 1 ? "项目已锁版定稿" : "项目未锁版，锁版为可选定稿、未点不拦派单"}），待 Muse 助手执行`
            : `第 ${sh.sortOrder + 1} 镜 · 参考图 ${sheet.refCount} 张 · 派单快照已冻结（派单时刻的脚本/分镜/身份锁原文＋全部定版参考/场景卡参考/首尾帧链＋画质 ${args.quality}；${p.locked === 1 ? "项目已锁版定稿" : "项目未锁版，锁版为可选定稿、未点不拦派单"}；派单后改分镜不影响本单，下一单才用新版），待 Muse 助手执行`,
          createdAt: t, updatedAt: t,
        })
        .returning();
      let jobStatus: string | null = "awaiting_assistant";
      let assistantTaskId: string | null = null;
      if (job) {
        // 参照图像本身随派单导出为真实文件，执行指令逐张列路径传入。
        const pack = await exportShotVisualPack(ctx, p, sh, `r${res.id}`);
        const started = await startAssistantExecution(ctx, job, p.name, sh.sortOrder, sheet.text, {
          durationSec: sh.durationSec, visualFiles: pack.files, visualMissing: pack.missing,
        });
        await appendPackNoteToJob(db, job.id, pack);
        assistantTaskId = started.taskId;
        jobStatus = started.taskId ? "generating" : "awaiting_assistant";
      }
      ctx.invalidateQueries();
      return {
        ok: true, error: null, taskSheet: sheet.text, warnings: sheet.warnings,
        resultId: res.id, jobStatus, assistantTaskId,
      };
    },
  }),

  // 派单前组装预览：按当前实时数据组装本镜将冻结的完整任务单并按来源
  // 分段标注，不建单、不派单（与 dispatchGeneration 共用 buildTaskSheet）。
  previewTaskSheet: deskAction({
    request: z.object({
      shotId: z.number().int(),
      quality: z.enum(["480P", "720P", "1080P"]).optional(),
    }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(),
      text: z.string().nullable(), warnings: z.array(z.string()),
      refCount: z.number(),
      sections: z.array(z.object({ key: z.string(), label: z.string(), text: z.string() })),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const fail = { text: null, warnings: [] as string[], refCount: 0, sections: [] as Array<{ key: string; label: string; text: string }> };
      const [sh] = await db.select().from(schema.shots).where(eq(schema.shots.id, args.shotId));
      if (!sh) return { ok: false, error: "镜头不存在。", ...fail };
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, sh.projectId));
      if (!p) return { ok: false, error: "项目不存在。", ...fail };
      // 与派单完全同一条组装路径（buildTaskSheet 读实时数据）：预览看到
      // 的就是现在派单会冻结的任务单；分段是全文的连续切片，拼接===全文。
      const quality = args.quality ?? sh.videoQuality ?? p.defaultQuality;
      const sheet = await buildTaskSheet(db, p, sh, quality);
      return {
        ok: true, error: null, text: sheet.text, warnings: sheet.warnings,
        refCount: sheet.refCount, sections: taskSheetSections(sheet.text),
      };
    },
  }),

  dispatchNextSegment: deskAction({
    privileged: [privileged.exportRefImageFile],
    request: z.object({ projectId: z.number().int(), quality: z.enum(["480P", "720P", "1080P"]).optional() }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(),
      taskSheet: z.string().nullable(), warnings: z.array(z.string()),
      resultId: z.number(), shotId: z.number(), shotOrder: z.number(),
      jobStatus: z.string().nullable(), assistantTaskId: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const fail = { taskSheet: null, warnings: [] as string[], resultId: 0, shotId: 0, shotOrder: -1, jobStatus: null, assistantTaskId: null };
      if (!ctx.providers.video) return { ok: false, error: GENERATION_UNCONNECTED, ...fail };
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.projectId));
      if (!p) return { ok: false, error: "项目不存在。", ...fail };
      // 锁版为可选定稿：链式生成同样不以锁版为前置，派单时自动冻结快照（同 dispatchGeneration 口径）。
      const shotsSorted = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, p.id))).sort((a, b) => a.sortOrder - b.sortOrder);
      if (shotsSorted.length === 0) return { ok: false, error: "项目还没有分镜。", ...fail };
      const allResults = await db.select().from(schema.results).where(eq(schema.results.projectId, p.id));
      const candidate = shotsSorted.find((sh) => !allResults.some((r) => r.shotId === sh.id && r.adopted === 1));
      if (!candidate) return { ok: false, error: "全部镜头都已有采用版，长片链已走完；如需重做某镜，请在该镜单独派单。", ...fail };
      const quality = (args.quality ?? candidate.videoQuality ?? p.defaultQuality) as "480P" | "720P" | "1080P";
      // 复用单镜派单的全部拦截（防重复 + 严格链）：直接内联同等检查后建单。
      const priorJobs = await db.select().from(schema.genJobs).where(eq(schema.genJobs.projectId, p.id));
      const candResults = allResults.filter((r) => r.shotId === candidate.id);
      const active = candResults.find((r) => r.genStatus === "running" && !r.videoKey && ["awaiting_assistant", "generating", "dispatched"].includes(priorJobs.filter((j) => j.resultId === r.id).sort((a, b) => b.createdAt - a.createdAt)[0]?.status ?? ""));
      if (active) return { ok: false, error: `下一段是第 ${candidate.sortOrder + 1} 镜，它已有进行中的任务 V${active.versionNumber}，不要重复派单；到质检页对该版本点「交给助手执行」即可。`, taskSheet: active.taskSheet, warnings: [], resultId: active.id, shotId: candidate.id, shotOrder: candidate.sortOrder, jobStatus: null, assistantTaskId: null };
      const allLinks = await db.select().from(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, p.id));
      const allChars2 = await db.select().from(schema.characters).where(eq(schema.characters.projectId, p.id));
      const allScenes2 = await db.select().from(schema.scenes).where(eq(schema.scenes.projectId, p.id));
      const allNodes2 = await db.select().from(schema.canvasNodes).where(eq(schema.canvasNodes.projectId, p.id));
      let canvasFirstHasImage = false;
      for (const l of allLinks.filter((x) => x.toKind === "shot" && x.toId === candidate.id && x.role === "firstframe")) {
        const key = l.fromKind === "character" ? allChars2.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "scene" ? allScenes2.find((x) => x.id === l.fromId)?.imageKey : l.fromKind === "node" ? allNodes2.find((x) => x.id === l.fromId)?.mediaKey : l.fromKind === "shot" ? shotsSorted.find((x) => x.id === l.fromId)?.lastFrameKey : null;
        if (key) canvasFirstHasImage = true;
      }
      const block = strictChainBlock(p, candidate, shotsSorted, allResults, canvasFirstHasImage);
      if (block) return { ok: false, error: `下一段（第 ${candidate.sortOrder + 1} 镜）还不能生成。${block}`, ...fail, shotId: candidate.id, shotOrder: candidate.sortOrder };
      const refBlock2 = await dispatchRefBlock(db, p, candidate);
      if (refBlock2) return { ok: false, error: `下一段（第 ${candidate.sortOrder + 1} 镜）还不能生成。${refBlock2}`, ...fail, shotId: candidate.id, shotOrder: candidate.sortOrder };
      const sheet = await buildTaskSheet(db, p, candidate, quality);
      const nextVer = candResults.reduce((a, r) => Math.max(a, r.versionNumber), 0) + 1;
      const t = now();
      const [res] = await db.insert(schema.results).values({ projectId: p.id, shotId: candidate.id, versionNumber: nextVer, label: `台内生成 V${nextVer}`, genStatus: "running", videoQuality: quality, taskSheet: sheet.text, createdAt: t, updatedAt: t }).returning({ id: schema.results.id });
      if (!res) return { ok: false, error: "派单失败。", ...fail };
      const [job] = await db.insert(schema.genJobs).values({ projectId: p.id, shotId: candidate.id, resultId: res.id, kind: "video", status: "awaiting_assistant", videoQuality: quality, detail: `链式生成下一段：第 ${candidate.sortOrder + 1} 镜 · 参考图 ${sheet.refCount} 张 · 派单快照已冻结（派单时刻的脚本/分镜/人物档案参考/场景卡参考/首尾帧链；${p.locked === 1 ? "项目已锁版定稿" : "项目未锁版，锁版为可选定稿、未点不拦派单"}），待 Muse 助手执行`, createdAt: t, updatedAt: t }).returning();
      let jobStatus: string | null = "awaiting_assistant";
      let assistantTaskId: string | null = null;
      if (job) { const pack2 = await exportShotVisualPack(ctx, p, candidate, `r${res.id}`); const started = await startAssistantExecution(ctx, job, p.name, candidate.sortOrder, sheet.text, { durationSec: candidate.durationSec, visualFiles: pack2.files, visualMissing: pack2.missing }); await appendPackNoteToJob(db, job.id, pack2); assistantTaskId = started.taskId; jobStatus = started.taskId ? "generating" : "awaiting_assistant"; }
      ctx.invalidateQueries();
      return { ok: true, error: null, taskSheet: sheet.text, warnings: sheet.warnings, resultId: res.id, shotId: candidate.id, shotOrder: candidate.sortOrder, jobStatus, assistantTaskId };
    },
  }),

  startGenerationExecution: deskAction({
    privileged: [privileged.exportRefImageFile],
    request: z.object({ resultId: z.number().int() }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(),
      jobStatus: z.string().nullable(), assistantTaskId: z.string().nullable(),
    }),
    async handler(ctx, args) {
      if (!ctx.providers.video) return { ok: false, error: GENERATION_UNCONNECTED, jobStatus: null, assistantTaskId: null };
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return { ok: false, error: "结果版本不存在。", jobStatus: null, assistantTaskId: null };
      if (r.videoKey) return { ok: false, error: "该版本已有成片，无需再执行；如需新版本请重新派单。", jobStatus: null, assistantTaskId: null };
      if (r.genStatus === "failed") return { ok: false, error: "该版本已标记生成失败，请重新派单生成新版本。", jobStatus: null, assistantTaskId: null };
      const jobs = (await db.select().from(schema.genJobs).where(eq(schema.genJobs.resultId, r.id)))
        .sort((a, b) => b.createdAt - a.createdAt);
      const job = jobs[0];
      if (!job) return { ok: false, error: "该版本没有生成任务记录，请重新派单。", jobStatus: null, assistantTaskId: null };
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, r.projectId));
      const [sh] = await db.select().from(schema.shots).where(eq(schema.shots.id, r.shotId));
      if (!p || !sh) return { ok: false, error: "项目或镜头不存在。", jobStatus: null, assistantTaskId: null };
      // 历史导入的任务（如原台内记录）没有冻结任务单：按当前分镜与档案
      // 现场重建并冻结到本版本（恢复快照，非原始派单快照），使这条老
      // 任务也能被真正执行，而不是永远卡在「待助手执行」且无单可依。
      // 严格链：老任务重建/领取时同样不得绕过——无真实尾帧图就先阻塞，等尾帧自动填入。
      {
        const allShots2 = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, p.id))).sort((a, b) => a.sortOrder - b.sortOrder);
        const allResults2 = await db.select().from(schema.results).where(eq(schema.results.projectId, p.id));
        const block2 = strictChainBlock(p, sh, allShots2, allResults2, false);
        // 自有首帧/画布情形已在 strictChainBlock 内处理（own key 放行）；此处 canvas 未查，若本镜已有连线图可能误挡，故仅当本镜无任何首帧连线时才拦截。
        const links2 = await db.select().from(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, p.id));
        const hasFirstLink = links2.some((x) => x.toKind === "shot" && x.toId === sh.id && x.role === "firstframe");
        if (block2 && !hasFirstLink) return { ok: false, error: block2, jobStatus: null, assistantTaskId: null };
      }
      // 生成中一律先核查，绝不因超时直接重开：原执行可能仍在运行，或成片
      // 已生成只是上传卡住——两种情况重新生成都是错的（重复费用＋新旧回调竞态）。
      if (job.status === "generating") {
        const stale = isStaleGenerating(job, false);
        return {
          ok: false, jobStatus: stale ? "generating_stale_unknown" : "generating", assistantTaskId: null,
          error: stale
            ? `本单已「生成中」超过 30 分钟未回填，状态待核查（不等于已中断）：可能原生成仍在运行，也可能成片已生成但上传卡住。请先核查原执行（尝试 ${job.attemptId ?? "无标识"}）、原产物文件与上传状态：已有成片只恢复该成片的上传/关联到本版本，不要再次生成；只有确认旧执行已终止后，才能用「释放领取（确认旧执行已终止）」释放本单再重新领取——释放会轮换尝试标识，旧回调将作废。现保留未知状态，未做任何更改。`
            : "助手已在执行本单（生成中），成片回填后会在此版本显示为待审核。如怀疑执行异常，先核查原执行与原产物，不要重复领取。",
        };
      }
      let sheet = r.taskSheet;
      if (!sheet) {
        // 旧记录缺原始任务单：按当前内容重建的只能叫「恢复任务单」，必须
        // 记录依据、原版本与恢复时间，绝不冒充原始派单快照；版本无法核对
        // 的部分在单头明示。领取仍走下面的唯一领取（新 attemptId）。
        const built = await buildTaskSheet(db, p, sh, r.videoQuality ?? job.videoQuality ?? p.defaultQuality);
        const recoveredAt = new Date(now()).toISOString();
        sheet = [
          `【恢复任务单 · 非原始派单快照】原版本 V${r.versionNumber}（resultId=${r.id}）的原始派单快照任务单缺失（历史导入记录，无单可依）。本单于 ${recoveredAt} 依据当前分镜（项目版本 v${p.version}、定稿标记：${p.locked === 1 ? "已锁版" : "未锁版（锁版为可选）"}、第 ${sh.sortOrder + 1} 镜现行内容）与当前人物档案重建，是关联这条旧记录的一次新恢复尝试；原始派单时的画质/参考口径若与现行内容不一致，已无法核对，不得把本单当作原始派单快照引用。`,
          `恢复依据：startGenerationExecution 对无任务单旧记录的恢复流程；恢复时间：${recoveredAt}；原版本：V${r.versionNumber}。`,
          "",
          built.text,
        ].join("\n");
        await db
          .update(schema.results)
          .set({ taskSheet: sheet, updatedAt: now() })
          .where(eq(schema.results.id, r.id));
        await db
          .update(schema.genJobs)
          .set({ detail: `${job.detail}｜恢复记录：原任务单缺失，于 ${recoveredAt} 按项目 v${p.version} 当前分镜快照重建恢复任务单（非原始派单快照），作为新恢复尝试领取。`, updatedAt: now() })
          .where(eq(schema.genJobs.id, job.id));
      }
      // 领取执行时同样按这一刻的实时分镜重新导出参照图像本身与时长，
      // 不沿用派单时的旧清单——分镜/档案在此期间改过就以当前为准。
      const pack3 = await exportShotVisualPack(ctx, p, sh, `r${r.id}`);
      const started = await startAssistantExecution(
        ctx, job, p.name, sh.sortOrder, sheet,
        { durationSec: sh.durationSec, visualFiles: pack3.files, visualMissing: pack3.missing },
      );
      await appendPackNoteToJob(db, job.id, pack3);
      ctx.invalidateQueries();
      if (!started.taskId)
        return {
          ok: false, jobStatus: "awaiting_assistant", assistantTaskId: null,
          error: `助手领取未启动：${started.error ?? "未知原因"}。任务仍为「待助手执行」，也可以在对话里让 Muse 领取待处理任务后手工回填。`,
        };
      return { ok: true, error: null, jobStatus: "generating", assistantTaskId: started.taskId };
    },
  }),

  releaseGenerationClaim: deskAction({
    request: z.object({
      resultId: z.number().int(),
      // 释放的前提是已核查并确认旧执行终止（或确认原产物不存在/已处理）；
      // 不确认就不释放，避免与仍在运行的旧执行竞态、重复生成。
      confirmTerminated: z.boolean(),
      note: z.string().max(1000).default(""),
    }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(), jobStatus: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return { ok: false, error: "结果版本不存在。", jobStatus: null };
      if (r.videoKey) return { ok: false, error: "该版本已有成片在版本卡上，无需释放领取；已有成片只做关联/质检，不要重新生成。", jobStatus: null };
      const jobs = (await db.select().from(schema.genJobs).where(eq(schema.genJobs.resultId, r.id))).sort((a, b) => b.createdAt - a.createdAt);
      const job = jobs[0];
      if (!job) return { ok: false, error: "该版本没有生成任务记录。", jobStatus: null };
      if (job.status !== "generating")
        return { ok: false, error: `本单当前状态是「${job.status}」，不是生成中，无需释放；待助手执行的单直接点「交给助手执行」领取即可。`, jobStatus: job.status };
      if (!args.confirmTerminated)
        return { ok: false, error: "未确认旧执行已终止，不能释放：无回填可能是原生成仍在运行或成片卡在上传。请先核查原执行、原产物与上传状态；已有成片只恢复上传/关联，不要重新生成。状态不明就保留未知。", jobStatus: "generating_stale_unknown" };
      const oldAttempt = job.attemptId ?? "无标识";
      await db
        .update(schema.genJobs)
        .set({
          status: "awaiting_assistant", attemptId: null,
          detail: `${job.detail}｜领取释放记录：已确认旧执行（尝试 ${oldAttempt}）终止${args.note ? `，核查说明：${args.note}` : ""}，于 ${new Date(now()).toISOString()} 释放回「待助手执行」；旧尝试标识已作废，其晚到回调将被拒绝。重新领取将发放新尝试标识。`,
          updatedAt: now(),
        })
        .where(eq(schema.genJobs.id, job.id));
      ctx.invalidateQueries();
      return { ok: true, error: null, jobStatus: "awaiting_assistant" };
    },
  }),

  // ---------- 视频分片回填（大体积成片的实际承载路径） ----------
  // 单次动作调用装不下整段视频 base64（5.6MB 成片约 750 万字符）。
  // 流程：beginVideoUpload 拿 uploadId → appendVideoChunk 逐片传 →
  // completeGenerationJob 传 uploadId，服务端按序拼装成完整视频 blob。

  beginVideoUpload: deskAction({
    request: z.object({ resultId: z.number().int() }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(), uploadId: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return { ok: false, error: "结果版本不存在。", uploadId: null };
      if (r.videoKey) return { ok: false, error: "该版本已有成片，无需再回填；如需新版本请重新派单。", uploadId: null };
      if (r.genStatus === "failed") return { ok: false, error: "该版本已标记生成失败，不能回填；请重新派单。", uploadId: null };
      const uploadId = `upl-${r.id}-${now().toString(36)}`;
      return { ok: true, error: null, uploadId };
    },
  }),

  appendVideoChunk: deskAction({
    request: z.object({
      uploadId: z.string().min(3).max(120),
      resultId: z.number().int(),
      index: z.number().int().min(0).max(400),
      // 每片原始字节建议 393216（base64 约 52 万字符）；上限留足余量。
      dataBase64: z.string().min(10).max(1400000),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return { ok: false, error: "结果版本不存在。" };
      if (r.videoKey) return { ok: false, error: "该版本已有成片，分片不再接受。" };
      // 同一分片重传即覆盖（按 uploadId＋序号精确删旧片），保证断点
      // 续传/重试不产生重复片、不影响其他分片。
      await db
        .delete(schema.videoUploadChunks)
        .where(and(
          eq(schema.videoUploadChunks.uploadId, args.uploadId),
          eq(schema.videoUploadChunks.idx, args.index),
        ));
      await db.insert(schema.videoUploadChunks).values({
        uploadId: args.uploadId, resultId: args.resultId,
        idx: args.index, data: args.dataBase64, createdAt: now(),
      });
      return { ok: true, error: null };
    },
  }),

  abortVideoUpload: deskAction({
    request: z.object({ uploadId: z.string().min(3).max(120) }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.videoUploadChunks)
        .where(eq(schema.videoUploadChunks.uploadId, args.uploadId));
      return { ok: true, error: null };
    },
  }),

  completeGenerationJob: deskAction({
    request: z.object({
      resultId: z.number().int(),
      attemptId: z.string().max(120).optional(),
      dataBase64: z.string().min(10).max(45000000).optional(),
      uploadId: z.string().min(3).max(120).optional(),
      mimeType: z.string().max(60).optional(),
      lastFrameBase64: z.string().min(10).max(16000000).optional(),
      lastFrameMimeType: z.string().max(60).optional(),
      error: z.string().max(4000).optional(),
      castCheck: castCheckSchema,
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return { ok: false, error: "结果版本不存在。" };
      // 尝试标识校验：任务已发放 attemptId 时，回调必须带同一标识；旧尝试
      // 的晚到回调（标识不符）直接拒绝，绝不覆盖新尝试的结果/状态。任务尚
      // 无标识（历史记录从未领取）时不拦截，兼容手工恢复路径。
      {
        const jobs0 = (await db.select().from(schema.genJobs).where(eq(schema.genJobs.resultId, r.id))).sort((a, b) => b.createdAt - a.createdAt);
        const curAttempt = jobs0[0]?.attemptId ?? null;
        if (curAttempt && args.attemptId !== curAttempt) {
          return { ok: false, error: `回填被拒绝：尝试标识不符（本单当前尝试 ${curAttempt}，回调带来 ${args.attemptId ?? "无标识"}）。这通常是已被释放/轮换的旧执行晚到回调，不能覆盖新尝试；请由当前尝试的执行方带正确 attemptId 回填。未做任何更改。` };
        }
      }
      if (args.error) {
        await db
          .update(schema.results)
          .set({ genStatus: "failed", genError: args.error, updatedAt: now() })
          .where(eq(schema.results.id, r.id));
        await db
          .update(schema.genJobs)
          .set({ status: "failed", error: args.error, updatedAt: now() })
          .where(eq(schema.genJobs.resultId, r.id));
        ctx.invalidateQueries();
        return { ok: true, error: null };
      }
      // 出镜自检门（成功回填路径统一生效）：本镜有出场人物时，没做
      // 抽帧逐人自检、有人未出镜或参照未喂全，拒绝按成功落卡；执行方
      // 应改走上方 error 分支标失败并写明「人物未出镜/参照未生效」。
      {
        const gateErr = castGateError(r.taskSheet, args.castCheck);
        if (gateErr) return { ok: false, error: gateErr };
      }
      // 严格链硬性要求：本镜后面还有连续镜、且项目严格模式开时，回填必须
      // 带真实尾帧图（lastFrameBase64 或本版已有尾帧），否则拒绝完成——
      // 先补尾帧再完成，保证尾帧自动填入下一镜不靠执行方自觉。
      if (!args.lastFrameBase64 && !r.actualLastFrameKey) {
        const [proj3] = await db.select().from(schema.projects).where(eq(schema.projects.id, r.projectId));
        if (proj3 && (proj3 as unknown as { chainStrict?: number }).chainStrict !== 0) {
          const shots3 = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, r.projectId))).sort((a, b) => a.sortOrder - b.sortOrder);
          const cur3 = shots3.find((x) => x.id === r.shotId);
          const nxt3 = cur3 ? shots3[shots3.findIndex((x) => x.id === cur3.id) + 1] : undefined;
          if (cur3 && nxt3 && !isSceneBreak(cur3, nxt3)) {
            return { ok: false, error: `回填未完成：第 ${cur3.sortOrder + 1} 镜后面还有第 ${nxt3.sortOrder + 1} 镜要严格承接，本次回填必须同时带成片真实最后一帧（lastFrameBase64），它将自动填入下一镜首帧。当前没带尾帧，未做任何更改（分片保留，可补传尾帧后重试完成）。` };
          }
        }
      }
      // 成片字节来源二选一：小文件直传 dataBase64；大文件走分片拼装。
      let videoBytes: Uint8Array | null = null;
      let viaChunks = 0;
      if (args.uploadId) {
        const rows = (await db
          .select()
          .from(schema.videoUploadChunks)
          .where(eq(schema.videoUploadChunks.uploadId, args.uploadId)))
          .sort((a, b) => a.idx - b.idx);
        if (rows.length === 0)
          return { ok: false, error: `分片回填失败：uploadId ${args.uploadId} 还没有任何分片，请先逐片调用 appendVideoChunk 上传，再完成回填。未做任何更改。` };
        if (rows.some((c) => c.resultId !== r.id))
          return { ok: false, error: "分片回填失败：这些分片不属于该结果版本，未做任何更改。" };
        for (let i = 0; i < rows.length; i++)
          if (rows[i]?.idx !== i)
            return { ok: false, error: `分片回填失败：缺少第 ${i} 片（已收到 ${rows.length} 片，序号不连续），请补传缺失分片后重试。未做任何更改。` };
        const parts = rows.map((c) => decodeB64(c.data));
        const total = parts.reduce((a, b) => a + b.length, 0);
        if (total < 1024)
          return { ok: false, error: `分片拼装后只有 ${total} 字节，不像完整视频，未做任何更改。` };
        if (total > 45000000)
          return { ok: false, error: `分片拼装后约 ${(total / 1048576).toFixed(1)}MB，超过台内可存上限，未做任何更改。` };
        videoBytes = new Uint8Array(total);
        let off = 0;
        for (const part of parts) { videoBytes.set(part, off); off += part.length; }
        viaChunks = rows.length;
      } else if (args.dataBase64) {
        videoBytes = decodeB64(args.dataBase64);
      }
      if (!videoBytes)
        return { ok: false, error: "回填缺少成片数据：请传 dataBase64（小文件）或 uploadId（分片回填），也没有失败原因，未做任何更改。" };
      const dupErr = await finalizeReturnedVideo(
        ctx, db, r, videoBytes, args.mimeType || "video/mp4",
        args.lastFrameBase64
          ? { bytes: decodeB64(args.lastFrameBase64), mimeType: args.lastFrameMimeType || "image/jpeg" }
          : null,
        `Muse 助手已回填成片到本结果版本（${viaChunks > 0 ? `分片回填 ${viaChunks} 片拼装 · ` : ""}约 ${(videoBytes.length / 1048576).toFixed(2)}MB）。`,
      );
      if (dupErr) return { ok: false, error: dupErr };
      await appendCastNoteToJob(db, r.id, args.castCheck);
      // 落卡成功后才清分片；被拒（如复用旧片）时保留分片也无意义之外的
      // 关键是：拒绝时明确未落卡，执行方须重新生成新成片再走新回填。
      if (args.uploadId)
        await db
          .delete(schema.videoUploadChunks)
          .where(eq(schema.videoUploadChunks.uploadId, args.uploadId));
      return { ok: true, error: null };
    },
  }),

  // 文件直读回填（秒回填主通道）：执行方只传工作区里成片文件的路径，
  // 服务端经特权层分块直读字节、校验完整性（字节数＋SHA-256＋视频文件
  // 头），并从成片本身截取真实最后一帧——全程没有任何大文本经执行方
  // 转录。成片只落回同一镜头版本卡（可播放/下载/删除/替换，不进资源
  // 库），状态「回填待审核」；严格链要求尾帧时截不到尾帧则拒绝完成。
  ingestGeneratedVideo: deskAction({
    request: z.object({
      resultId: z.number().int(),
      filePath: z.string().min(1).max(600),
      attemptId: z.string().max(120).optional(),
      castCheck: castCheckSchema,
    }),
    response: z.object({
      ok: z.boolean(), error: z.string().nullable(),
      bytes: z.number(), sha256: z.string().nullable(), hasLastFrame: z.boolean(),
    }),
    privileged: [privileged.readWorkspaceVideoChunk, privileged.extractVideoLastFrame, privileged.trimVideoToDuration],
    async handler(ctx, args): Promise<{ ok: boolean; error: string | null; bytes: number; sha256: string | null; hasLastFrame: boolean }> {
      const fail = (error: string) => ({ ok: false, error, bytes: 0, sha256: null, hasLastFrame: false });
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return fail("结果版本不存在。");
      if (r.videoKey) return fail("该版本已有成片，无需再回填；如需换片请在版本卡上用「替换成片」，或删除本版后重新派单。未做任何更改。");
      if (r.genStatus === "failed") return fail("该版本已标记生成失败，不能回填；请重新派单生成新版本。未做任何更改。");
      // 尝试标识校验与 completeGenerationJob 同口径：旧尝试晚到拒绝。
      {
        const jobs0 = (await db.select().from(schema.genJobs).where(eq(schema.genJobs.resultId, r.id))).sort((a, b) => b.createdAt - a.createdAt);
        const curAttempt = jobs0[0]?.attemptId ?? null;
        if (curAttempt && args.attemptId !== curAttempt) {
          return fail(`回填被拒绝：尝试标识不符（本单当前尝试 ${curAttempt}，本次带来 ${args.attemptId ?? "无标识"}）。这通常是已被释放/轮换的旧执行晚到，不能覆盖新尝试；请由当前尝试的执行方带正确 attemptId 回填。未做任何更改。`);
        }
      }
      // 出镜自检门：本镜有出场人物时，没做抽帧逐人自检、有人未出镜
      // 或参照未喂全，一律拒绝按成功回填（见 castGateError）。
      {
        const gateErr = castGateError(r.taskSheet, args.castCheck);
        if (gateErr) return fail(gateErr);
      }
      // 分块直读：每块 768KB 原始字节，经宿主本地通道传输，不经任何文本转录。
      const CHUNK = 786432;
      let assembled: Uint8Array | null = null;
      let total = -1;
      let mimeType = "video/mp4";
      let offset = 0;
      try {
        for (;;) {
          const part = await ctx.executePrivileged(privileged.readWorkspaceVideoChunk, {
            path: args.filePath, offset, maxBytes: CHUNK,
          });
          if (total < 0) {
            total = part.totalBytes;
            mimeType = part.mimeType || mimeType;
            if (total < 1024) return fail(`文件只有 ${total} 字节，不像完整视频，未做任何更改。`);
            if (total > 45000000) return fail(`文件约 ${(total / 1048576).toFixed(1)}MB，超过台内可存上限，未做任何更改。`);
            assembled = new Uint8Array(total);
          }
          if (part.bytesRead > 0 && assembled) {
            assembled.set(decodeB64(part.dataBase64), offset);
            offset += part.bytesRead;
          }
          if (part.eof) break;
          if (part.bytesRead === 0) return fail("读取成片文件中途无数据，文件可能仍在写入或已被移动，未做任何更改。");
        }
      } catch (e) {
        return fail(`读取成片文件失败：${e instanceof Error ? e.message : String(e)}。未做任何更改；请确认文件路径无误、文件确在工作区内。`);
      }
      if (!assembled || offset !== total)
        return fail(`成片读取不完整：应读 ${total} 字节、实读 ${offset} 字节，未做任何更改。`);
      // 文件头校验：MP4/MOV 须有 ftyp 盒，WebM 须有 EBML 头，防止把
      // 任意文件误当成片落卡。
      const head = assembled.subarray(0, 12);
      const isFtyp = head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
      const isEbml = head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
      if (!isFtyp && !isEbml)
        return fail("文件头不是可识别的视频格式（无 ftyp/EBML 标记），未做任何更改。");
      let sha = await sha256Hex(assembled);
      // 真实尾帧：从成片本身截取（服务端 ffmpeg），不由执行方提供。
      // extractVideoLastFrame 同时用 ffprobe 返回成片真实时长——回填
      // 时长校验就以这个 ffprobe 时长为准（见下方时长处理）。
      let lastFrame: { bytes: Uint8Array; mimeType: string } | null = null;
      let frameNote = "";
      let probedDurationSec = 0;
      try {
        const fr = await ctx.executePrivileged(privileged.extractVideoLastFrame, { path: args.filePath });
        probedDurationSec = fr.durationSec || 0;
        if (fr.frameBase64) {
          lastFrame = { bytes: decodeB64(fr.frameBase64), mimeType: fr.mimeType || "image/jpeg" };
        } else {
          frameNote = fr.error ?? "尾帧截取失败";
        }
      } catch (e) {
        frameNote = e instanceof Error ? e.message : String(e);
      }
      // 时长校验（ffprobe 实测 vs 本镜实时分镜时长）：与分镜时长差超
      // 容差时不得静默落卡——过长自动裁切到本镜时长并明示（裁后重读
      // 字节、重算 SHA、重截尾帧，落卡的是裁切后的片）；过短拒绝，
      // 请按本镜时长重新生成。实测事故：3.1 秒镜回填了 10 秒成片，
      // 此前任务单写了时长却没有任何一处在回填时核对。
      let durationNote = "";
      {
        const [shDur] = await db.select().from(schema.shots).where(eq(schema.shots.id, r.shotId));
        if (shDur && probedDurationSec > 0) {
          const target = shDur.durationSec;
          const tol = durationToleranceSec(target);
          if (probedDurationSec < target - tol) {
            return fail(`回填被拒绝：ffprobe 实测成片时长 ${probedDurationSec.toFixed(2)} 秒，比第 ${shDur.sortOrder + 1} 镜实时分镜时长 ${target} 秒短 ${(target - probedDurationSec).toFixed(2)} 秒（容差 ±${tol.toFixed(2)} 秒），太短不能当本镜成片。请按 ${target} 秒重新生成后回填。未做任何更改。`);
          }
          if (probedDurationSec > target + tol) {
            let trimmed: { error: string | null; outputPath: string | null; durationSec: number; totalBytes: number } | null = null;
            try {
              trimmed = await ctx.executePrivileged(privileged.trimVideoToDuration, {
                spaceDir: ctx.spaceDir, path: args.filePath, targetSec: target,
                workName: `trim-result${r.id}-${now()}`,
              });
            } catch (e) {
              return fail(`回填被拒绝：ffprobe 实测成片时长 ${probedDurationSec.toFixed(2)} 秒，与第 ${shDur.sortOrder + 1} 镜时长 ${target} 秒不符，且自动裁切调用失败（${e instanceof Error ? e.message : String(e)}）。请按 ${target} 秒重新生成后回填。未做任何更改。`);
            }
            if (!trimmed || trimmed.error || !trimmed.outputPath) {
              return fail(`回填被拒绝：ffprobe 实测成片时长 ${probedDurationSec.toFixed(2)} 秒，与第 ${shDur.sortOrder + 1} 镜时长 ${target} 秒不符，自动裁切失败（${trimmed?.error ?? "未产出裁切文件"}）。请按 ${target} 秒重新生成后回填。未做任何更改。`);
            }
            // 重读裁切后的文件字节（同一分块直读通道），重截其真实尾帧。
            const tPath = trimmed.outputPath;
            const CHUNK2 = 786432;
            let tAssembled: Uint8Array | null = null;
            let tTotal = -1;
            let tOffset = 0;
            try {
              for (;;) {
                const part = await ctx.executePrivileged(privileged.readWorkspaceVideoChunk, {
                  path: tPath, offset: tOffset, maxBytes: CHUNK2,
                });
                if (tTotal < 0) {
                  tTotal = part.totalBytes;
                  mimeType = part.mimeType || mimeType;
                  tAssembled = new Uint8Array(tTotal);
                }
                if (part.bytesRead > 0 && tAssembled) {
                  tAssembled.set(decodeB64(part.dataBase64), tOffset);
                  tOffset += part.bytesRead;
                }
                if (part.eof) break;
                if (part.bytesRead === 0) throw new Error("裁切后文件读取中断");
              }
            } catch (e) {
              return fail(`回填被拒绝：成片已裁切到 ${target} 秒，但重读裁切产物失败（${e instanceof Error ? e.message : String(e)}）。未做任何更改。`);
            }
            if (!tAssembled || tOffset !== tTotal) return fail("回填被拒绝：裁切产物读取不完整，未做任何更改。");
            assembled = tAssembled;
            sha = await sha256Hex(assembled);
            lastFrame = null;
            try {
              const fr2 = await ctx.executePrivileged(privileged.extractVideoLastFrame, { path: tPath });
              if (fr2.frameBase64) lastFrame = { bytes: decodeB64(fr2.frameBase64), mimeType: fr2.mimeType || "image/jpeg" };
              else frameNote = fr2.error ?? "裁切后尾帧截取失败";
            } catch (e) {
              frameNote = e instanceof Error ? e.message : String(e);
            }
            durationNote = `时长校验：ffprobe 实测原成片 ${probedDurationSec.toFixed(2)} 秒，与本镜 ${target} 秒不符，已按本镜时长自动裁切为 ${target} 秒后回填（不是静默接受错时长）。`;
          }
        }
      }
      if (!lastFrame && (await strictTailFrameRequired(db, r))) {
        return fail(`回填未完成：本镜后面还有连续镜，严格链要求带真实尾帧，但从成片截取尾帧失败（${frameNote}）。成片未落卡，请稍后重试本动作，或先在版本卡走人工回填并补尾帧。未做任何更改。`);
      }
      const dupErr = await finalizeReturnedVideo(
        ctx, db, r, assembled, mimeType, lastFrame,
        `成片已由服务端直读原文件回填到本结果版本（约 ${(assembled.length / 1048576).toFixed(2)}MB · SHA-256 ${sha.slice(0, 16)}… · 文件直读通道，无 base64 转录）。${durationNote}`,
      );
      if (dupErr) return fail(dupErr);
      await appendCastNoteToJob(db, r.id, args.castCheck);
      return { ok: true, error: null, bytes: assembled.length, sha256: sha, hasLastFrame: !!lastFrame };
    },
  }),

  attachResultVideo: deskAction({
    request: z.object({
      resultId: z.number().int(),
      dataBase64: z.string().min(10).max(45000000),
      mimeType: z.string().max(60),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return { ok: false, error: "结果版本不存在。" };
      const duplicateError = await finalizeReturnedVideo(ctx, db, r, decodeB64(args.dataBase64), args.mimeType, null, "本地上传或替换视频。");
      if (duplicateError) return { ok: false, error: duplicateError };
      return { ok: true, error: null };
    },
  }),

  markResultFailed: deskAction({
    request: z.object({ resultId: z.number().int(), error: z.string().min(1).max(4000) }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.results)
        .set({ genStatus: "failed", genError: args.error, updatedAt: now() })
        .where(eq(schema.results.id, args.resultId));
      await db
        .update(schema.genJobs)
        .set({ status: "failed", error: args.error, updatedAt: now() })
        .where(eq(schema.genJobs.resultId, args.resultId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  setResultLastFrame: deskAction({
    request: z.object({
      resultId: z.number().int(),
      dataBase64: z.string().min(10).max(16000000),
      mimeType: z.string().max(60),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return { ok: false, error: "结果版本不存在。" };
      const key = `result-${r.id}-lastframe-${now()}`;
      await ctx.blobs.put(key, decodeB64(args.dataBase64), { contentType: args.mimeType });
      await db
        .update(schema.results)
        .set({ actualLastFrameKey: key, lastFrameMissing: 0, updatedAt: now() })
        .where(eq(schema.results.id, r.id));
      // 补上尾帧即自动填入下一镜首帧，让下一段立刻能严格参照。
      await propagateTailToNext(db, r.projectId, r.shotId, key, `V${r.versionNumber}`);
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  updateResult: deskAction({
    request: z.object({
      resultId: z.number().int(),
      qcStatus: z.enum(["pending", "pass", "fail"]).optional(),
      qcNote: z.string().max(4000).optional(),
      adopted: z.boolean().optional(),
      includeInEdit: z.boolean().optional(),
      inPoint: z.number().min(0).max(3600).optional(),
      outPoint: z.number().min(0).max(3600).nullable().optional(),
      cutType: z.string().max(40).optional(),
      label: z.string().max(200).optional(),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [r] = await db.select().from(schema.results).where(eq(schema.results.id, args.resultId));
      if (!r) return { ok: false, error: "结果版本不存在。" };
      if (args.adopted === true) {
        if (!r.videoKey)
          return { ok: false, error: "该版本尚未回填成片，不能采用。先等成片回填到本版本，再质检采用。" };
        const effQc = args.qcStatus ?? r.qcStatus;
        if (effQc !== "pass")
          return { ok: false, error: "质检通过后才能采用：请先点「✓ 通过」（抽帧检查无误），再点「采用此版」。" };
        // 严格链采用门槛：后面还有连续镜时，本版必须有真实尾帧图，否则下一镜无图可严格参照。
        const [proj2] = await db.select().from(schema.projects).where(eq(schema.projects.id, r.projectId));
        if (proj2 && (proj2 as unknown as { chainStrict?: number }).chainStrict !== 0) {
          const shots2 = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, r.projectId))).sort((a, b) => a.sortOrder - b.sortOrder);
          const cur = shots2.find((x) => x.id === r.shotId);
          const nxt = cur ? shots2[shots2.findIndex((x) => x.id === cur.id) + 1] : undefined;
          if (cur && nxt && !isSceneBreak(cur, nxt) && !r.actualLastFrameKey) {
            return { ok: false, error: `严格链：第 ${cur.sortOrder + 1} 镜后面还有第 ${nxt.sortOrder + 1} 镜要承接，本版采用前必须先有真实尾帧图——请点「截取当前帧为尾帧」或「上传尾帧图」补齐，它会自动填入下一镜首帧。没有尾帧图不能采用，避免下一段只能按标签生成造成漂移。` };
          }
        }
      }
      if (args.adopted === true) {
        const siblings = await db.select().from(schema.results).where(eq(schema.results.shotId, r.shotId));
        for (const sib of siblings)
          if (sib.id !== r.id && sib.adopted === 1)
            await db.update(schema.results).set({ adopted: 0, updatedAt: now() }).where(eq(schema.results.id, sib.id));
      }
      const patch: Partial<typeof schema.results.$inferInsert> = { updatedAt: now() };
      if (args.qcStatus !== undefined) patch.qcStatus = args.qcStatus;
      if (args.qcNote !== undefined) patch.qcNote = args.qcNote;
      if (args.adopted !== undefined) patch.adopted = args.adopted ? 1 : 0;
      // 质检改判不通过时，同步取消采用，避免不通过版本留在拼接清单里。
      if (args.qcStatus === "fail" && args.adopted !== true) patch.adopted = 0;
      if (args.includeInEdit !== undefined) patch.includeInEdit = args.includeInEdit ? 1 : 0;
      if (args.inPoint !== undefined) patch.inPoint = args.inPoint;
      if (args.outPoint !== undefined) patch.outPoint = args.outPoint;
      if (args.cutType !== undefined) patch.cutType = args.cutType;
      if (args.label !== undefined) patch.label = args.label;
      await db.update(schema.results).set(patch).where(eq(schema.results.id, r.id));
      if (args.adopted === true && r.actualLastFrameKey) {
        await propagateTailToNext(db, r.projectId, r.shotId, r.actualLastFrameKey, `V${r.versionNumber} 已采用`);
      }
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  deleteResult: deskAction({
    request: z.object({ resultId: z.number().int() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.genJobs).where(eq(schema.genJobs.resultId, args.resultId));
      await db.delete(schema.videoUploadChunks).where(eq(schema.videoUploadChunks.resultId, args.resultId));
      await db.delete(schema.results).where(eq(schema.results.id, args.resultId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  confirmAssembly: deskAction({
    request: z.object({ projectId: z.number().int(), confirm: z.boolean() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.projectId));
      if (!p) return { ok: false, error: "项目不存在。" };
      if (args.confirm) {
        const shots = await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.projectId));
        const res = await db.select().from(schema.results).where(eq(schema.results.projectId, args.projectId));
        for (const sh of shots) {
          const adopted = res.find((r) => r.shotId === sh.id && r.adopted === 1 && r.includeInEdit === 1);
          if (!adopted)
            return {
              ok: false,
              error: `第 ${sh.sortOrder + 1} 镜还没有被采用并纳入剪辑的结果，先在质检页采用一版再确认拼接。`,
            };
        }
      }
      const history = [
        ...(JSON.parse(p.history) as string[]),
        logLine(p.version, args.confirm ? "确认拼接清单" : "取消拼接确认"),
      ];
      await db
        .update(schema.projects)
        .set({ assemblyConfirmed: args.confirm ? 1 : 0, history: JSON.stringify(history), updatedAt: now() })
        .where(eq(schema.projects.id, args.projectId));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  // 画布内导出最终完整品：按拼接清单（每镜采用版+入/出点+转场）在宿主侧
  // 用 ffmpeg 真拼接成一个 MP4，再分块直读回 blob 落到项目成品字段，
  // 画布成品节点直接播放/下载。不经聊天、不进资源库。
  exportFinalVideo: deskAction({
    request: z.object({ projectId: z.number().int() }),
    response: exportFinalResponse,
    privileged: [privileged.normalizeFinalSegment, privileged.assembleFinalVideo, privileged.deleteExportFiles, privileged.readWorkspaceVideoChunk],
    async handler(ctx, args): Promise<z.infer<typeof exportFinalResponse>> {
      const fail = (error: string): z.infer<typeof exportFinalResponse> => ({
        ok: false, error, videoKey: null, bytes: 0, durationSec: 0,
      });
      const db = ctx.db<typeof schema>();
      const [p] = await db.select().from(schema.projects).where(eq(schema.projects.id, args.projectId));
      if (!p) return fail("项目不存在。");
      const shots = (await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.projectId)))
        .sort((a, b) => a.sortOrder - b.sortOrder);
      if (shots.length === 0) return fail("项目还没有分镜，无法导出成品。");
      const res = await db.select().from(schema.results).where(eq(schema.results.projectId, args.projectId));
      const segments: Array<{ blobKey: string; inSec: number; outSec: number | null }> = [];
      const adoptedRows: Array<typeof schema.results.$inferSelect> = [];
      for (const sh of shots) {
        const adopted = res.find((r) => r.shotId === sh.id && r.adopted === 1 && r.includeInEdit === 1);
        if (!adopted)
          return fail(`第 ${sh.sortOrder + 1} 镜还没有采用并纳入剪辑的版本，先在质检页采用一版再导出。`);
        if (!adopted.videoKey || adopted.videoMissing === 1)
          return fail(`第 ${sh.sortOrder + 1} 镜采用版（V${adopted.versionNumber}）没有可用的成片文件，无法导出。`);
        segments.push({ blobKey: adopted.videoKey, inSec: adopted.inPoint, outSec: adopted.outPoint });
        adoptedRows.push(adopted);
      }
      const transitions = adoptedRows.slice(1).map((r) => r.cutType || "直切");
      const m = p.aspect.match(/(\d+)\s*[×xX]\s*(\d+)/);
      let width = m ? Number(m[1]) : 1280;
      let height = m ? Number(m[2]) : 720;
      if (!(width >= 16) || !(height >= 16)) { width = 1280; height = 720; }
      width -= width % 2;
      height -= height % 2;
      // 两段式拼接（宿主单次调用有约 30s 预算，整片一次编码会超时）：
      // 逐段归一化（一段一次调用）→ 合并（直切无损/转场 xfade）→ 直读回 blob。
      const workTag = `project-${p.id}-final-${now()}`;
      const segFiles: string[] = [];
      const segLens: number[] = [];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg) continue;
        let norm;
        try {
          norm = await ctx.executePrivileged(privileged.normalizeFinalSegment, {
            spaceDir: ctx.spaceDir,
            blobKey: seg.blobKey, inSec: seg.inSec, outSec: seg.outSec,
            width, height, fps: p.fps || 24,
            workName: `${workTag}-seg${i}`,
          });
        } catch (e) {
          return fail(`第 ${i + 1} 镜归一化失败：${e instanceof Error ? e.message : String(e)}`);
        }
        if (norm.error || !norm.fileName) return fail(`第 ${i + 1} 镜：${norm.error ?? "归一化失败。"}`);
        segFiles.push(norm.fileName);
        segLens.push(norm.lenSec);
      }
      let stitched;
      try {
        stitched = await ctx.executePrivileged(privileged.assembleFinalVideo, {
          spaceDir: ctx.spaceDir,
          files: segFiles, segLens, transitions,
          fps: p.fps || 24, outputName: workTag,
        });
      } catch (e) {
        return fail(`成品拼接失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (stitched.error || !stitched.outputPath) return fail(stitched.error ?? "成品拼接失败。");
      // 分块直读回成品文件并落 blob（与 ingestGeneratedVideo 同通道）。
      const CHUNK = 786432;
      let assembled: Uint8Array | null = null;
      let total = -1;
      let offset = 0;
      try {
        for (;;) {
          const part = await ctx.executePrivileged(privileged.readWorkspaceVideoChunk, {
            path: stitched.outputPath, offset, maxBytes: CHUNK,
          });
          if (total < 0) {
            total = part.totalBytes;
            if (total < 1024) return fail("成品文件体积异常，未保存。");
            if (total > 45000000) return fail(`成品约 ${(total / 1048576).toFixed(1)}MB，超过台内可存上限 45MB，未保存。`);
            assembled = new Uint8Array(total);
          }
          if (part.bytesRead > 0 && assembled) {
            assembled.set(decodeB64(part.dataBase64), offset);
            offset += part.bytesRead;
          }
          if (part.eof) break;
          if (part.bytesRead === 0) return fail("读取成品文件中途无数据，未保存。");
        }
      } catch (e) {
        return fail(`读取成品文件失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (!assembled || offset !== total) return fail("成品读取不完整，未保存。");
      // 成品已落 blob：清掉 exports/ 里的归一化段与成品文件副本，不留中转垃圾。
      void ctx.executePrivileged(privileged.deleteExportFiles, {
        spaceDir: ctx.spaceDir,
        names: [...segFiles, `${workTag}.mp4`],
      }).catch(() => undefined);
      const key = `project-${p.id}-final-${now()}`;
      await ctx.blobs.put(key, assembled, { contentType: "video/mp4" });
      const signature = assemblySignatureOf(shots, res);
      const history = [
        ...(JSON.parse(p.history) as string[]),
        logLine(p.version, `在画布导出最终完整品（${segments.length} 段拼接 · 约 ${(assembled.length / 1048576).toFixed(2)}MB${stitched.durationSec ? ` · ${stitched.durationSec.toFixed(1)}s` : ""}）`),
      ];
      await db
        .update(schema.projects)
        .set({
          finalVideoKey: key, finalExportedAt: now(), finalSignature: signature,
          assemblyConfirmed: 1, history: JSON.stringify(history), updatedAt: now(),
        })
        .where(eq(schema.projects.id, args.projectId));
      ctx.invalidateQueries();
      return { ok: true, error: null, videoKey: key, bytes: assembled.length, durationSec: stitched.durationSec };
    },
  }),

  // ---------- 画布 ----------

  saveNodePosition: deskAction({
    request: z.object({
      kind: z.enum(["character", "scene", "shot", "node"]),
      id: z.number().int(), x: z.number(), y: z.number(),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.kind === "character")
        await db.update(schema.characters).set({ canvasX: args.x, canvasY: args.y }).where(eq(schema.characters.id, args.id));
      else if (args.kind === "scene")
        await db.update(schema.scenes).set({ canvasX: args.x, canvasY: args.y }).where(eq(schema.scenes.id, args.id));
      else if (args.kind === "shot")
        await db.update(schema.shots).set({ canvasX: args.x, canvasY: args.y }).where(eq(schema.shots.id, args.id));
      else
        await db.update(schema.canvasNodes).set({ x: args.x, y: args.y, updatedAt: now() }).where(eq(schema.canvasNodes.id, args.id));
      return { ok: true, error: null };
    },
  }),

  createCanvasNode: deskAction({
    request: z.object({
      projectId: z.number().int(),
      kind: z.enum(["image", "video", "note"]).default("note"),
      title: z.string().max(120).default(""),
      note: z.string().max(2000).default(""),
      x: z.number().default(60), y: z.number().default(60),
      dataBase64: z.string().max(30000000).nullable().default(null),
      mimeType: z.string().max(60).nullable().default(null),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const t = now();
      let mediaKey: string | null = null;
      const [row] = await db
        .insert(schema.canvasNodes)
        .values({
          projectId: args.projectId, kind: args.kind, title: args.title,
          note: args.note, x: args.x, y: args.y, mimeType: args.mimeType,
          createdAt: t, updatedAt: t,
        })
        .returning({ id: schema.canvasNodes.id });
      if (!row) throw new Error("createCanvasNode failed");
      if (args.dataBase64) {
        mediaKey = `canvas-node-${row.id}-media-${t}`;
        await ctx.blobs.put(mediaKey, decodeB64(args.dataBase64), {
          contentType: args.mimeType ?? "application/octet-stream",
        });
        await db.update(schema.canvasNodes).set({ mediaKey }).where(eq(schema.canvasNodes.id, row.id));
      }
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateCanvasNode: deskAction({
    request: z.object({
      id: z.number().int(),
      title: z.string().max(120).optional(),
      note: z.string().max(2000).optional(),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const patch: Partial<typeof schema.canvasNodes.$inferInsert> = { updatedAt: now() };
      if (args.title !== undefined) patch.title = args.title;
      if (args.note !== undefined) patch.note = args.note;
      await db.update(schema.canvasNodes).set(patch).where(eq(schema.canvasNodes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  deleteCanvasNode: deskAction({
    request: z.object({ id: z.number().int() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const links = await db.select().from(schema.canvasLinks);
      for (const l of links)
        if ((l.fromKind === "node" && l.fromId === args.id) || (l.toKind === "node" && l.toId === args.id))
          await db.delete(schema.canvasLinks).where(eq(schema.canvasLinks.id, l.id));
      await db.delete(schema.canvasNodes).where(eq(schema.canvasNodes.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  createLink: deskAction({
    request: z.object({
      projectId: z.number().int(),
      fromKind: z.enum(["character", "scene", "shot", "node"]),
      fromId: z.number().int(),
      toKind: z.enum(["character", "scene", "shot", "node"]),
      toId: z.number().int(),
      role: z.string().max(40).default("reference"),
      note: z.string().max(500).default(""),
    }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.fromKind === args.toKind && args.fromId === args.toId)
        return { ok: false, error: "不能把节点连到它自己。" };
      const existing = await db.select().from(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, args.projectId));
      if (existing.some((l) => l.fromKind === args.fromKind && l.fromId === args.fromId && l.toKind === args.toKind && l.toId === args.toId && l.role === args.role))
        return { ok: false, error: "这条连线已存在。" };
      // 首帧/尾帧对同一镜头只能有一个来源：第二个来源会让任务口径含糊，直接拦下并指出已有来源。
      if ((args.role === "firstframe" || args.role === "lastframe") && args.toKind === "shot") {
        const clash = existing.find((l) => l.toKind === "shot" && l.toId === args.toId && l.role === args.role);
        if (clash) {
          const chars2 = await db.select().from(schema.characters).where(eq(schema.characters.projectId, args.projectId));
          const scns2 = await db.select().from(schema.scenes).where(eq(schema.scenes.projectId, args.projectId));
          const nodes2 = await db.select().from(schema.canvasNodes).where(eq(schema.canvasNodes.projectId, args.projectId));
          const shots2 = await db.select().from(schema.shots).where(eq(schema.shots.projectId, args.projectId));
          const titleOf = (kind: string, id: number) =>
            kind === "character" ? (chars2.find((x) => x.id === id)?.name ?? `人物 #${id}`) :
            kind === "scene" ? (scns2.find((x) => x.id === id)?.name ?? `场景 #${id}`) :
            kind === "node" ? (nodes2.find((x) => x.id === id)?.title || `参考节点 #${id}`) :
            `第 ${((shots2.find((x) => x.id === id)?.sortOrder ?? 0) + 1)} 镜`;
          const targetShot = shots2.find((x) => x.id === args.toId);
          return {
            ok: false,
            error: `第 ${((targetShot?.sortOrder ?? 0) + 1)} 镜已经有一条${args.role === "firstframe" ? "首帧" : "尾帧"}连线，来源是「${titleOf(clash.fromKind, clash.fromId)}」。一个镜头只能指定一个${args.role === "firstframe" ? "首帧" : "尾帧"}来源：请先在连线管理里删除旧连线，再连新的。`,
          };
        }
      }
      await db.insert(schema.canvasLinks).values({
        projectId: args.projectId, fromKind: args.fromKind, fromId: args.fromId,
        toKind: args.toKind, toId: args.toId, role: args.role, note: args.note,
        createdAt: now(),
      });
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),

  deleteLink: deskAction({
    request: z.object({ id: z.number().int() }),
    response: ok,
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.canvasLinks).where(eq(schema.canvasLinks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true, error: null };
    },
  }),
} satisfies ActionsModule;

// ---------- 脚本自动拆分镜 ----------

interface SplitDraft {
  action: string;
  durationSec: number;
  framing: string;
  cameraMove: string;
  /** 旧单值兼容字段：等于 characterNames 第一项（无则空）。 */
  characterName: string;
  /** 旧单值兼容字段：等于 sceneNames 第一项（无则空）。 */
  sceneName: string;
  /** 多选真源：一镜可关联多个人物/多个场景，预览校对可改、确认后全量写入。 */
  characterNames: string[];
  sceneNames: string[];
  startState: string;
  endState: string;
  handoffNote: string;
}

/** 收集脚本里的切分点：段/镜标记与时长标记。
 *  口径：脚本里出现几个时长标记就拆几个分镜，不限固定时长、不限位置——
 *  「……。第二段（10-20s）：……」这种写在一整段正文行中的标记同样是
 *  新镜起点，（3秒）、5s 这类单个时长标记也算。防误切三条：① 段标记
 *  必须紧跟时间段括号或冒号（「第一段往事」不切）；② 句中提到的时间
 *  （「他等了 5-10 秒」「停顿约 3 秒」「20 秒连续镜头」）不切——裸时长
 *  标记须在文首/行首/句末标点之后、且不与后面的正文粘连；③ 带括号的
 *  时长标注是明确的镜次标注，出现在句中也切。表格行（镜号+制表符+
 *  时长）的切分点并到行首，镜号归本镜所有。 */
function scriptSegmentBoundaries(text: string): number[] {
  const points = new Set<number>();
  const labelSpans: Array<[number, number]> = [];
  const labelRe =
    /第\s*[0-9０-９一二三四五六七八九十百]+\s*[段镜场幕]\s*(?:[（(]\s*\d+(?:\.\d+)?\s*[–—~\-]\s*\d+(?:\.\d+)?\s*(?:s|秒|sec)?\s*[)）]\s*[:：]?|[:：])|(?:镜头|分镜)\s*[0-9０-９一二三四五六七八九十]+\s*(?:[（(]\s*\d+(?:\.\d+)?\s*[–—~\-]\s*\d+(?:\.\d+)?\s*(?:s|秒|sec)?\s*[)）]\s*[:：]?|[:：])/g;
  for (const m of text.matchAll(labelRe)) {
    points.add(m.index);
    labelSpans.push([m.index, m.index + m[0].length]);
  }
  const inLabel = (i: number) => labelSpans.some(([a, b]) => i >= a && i < b);
  // 时长标记正前方紧贴段/镜标记文字时（如「第一段（3秒）」），切分点取标记开头。
  const labelTailRe =
    /(第\s*[0-9０-９一二三四五六七八九十百]+\s*[段镜场幕]|(?:镜头|分镜)\s*[0-9０-９一二三四五六七八九十]+)\s*$/;
  const labelTailPoint = (start: number): number | null => {
    const lt = text.slice(0, start).match(labelTailRe);
    return lt ? (lt.index ?? null) : null;
  };
  // 句首判定：标记前（略过空白）是文首、行首或句末标点。
  const atSentenceStart = (start: number): boolean => {
    const before = text.slice(0, start);
    if (!before.trim()) return true;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    if (!text.slice(lineStart, start).trim()) return true;
    const prev = before.replace(/\s+$/u, "").slice(-1);
    return "。！？；;".includes(prev);
  };
  // 同行行首只有镜号数字时（如表格行「1\t0-5s\t…」），切分点取行首。
  const adjustPoint = (start: number): number => {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    return /^[\s\t]*\d{1,3}[\s\t]*$/.test(text.slice(lineStart, start)) ? lineStart : start;
  };
  // 裸时长标记的切分资格：句首，或同行行首只有镜号数字（表格行）。
  const bareQualifies = (start: number): boolean => {
    if (atSentenceStart(start)) return true;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    return /^[\s\t]*\d{1,3}[\s\t]*$/.test(text.slice(lineStart, start));
  };

  // 时间段：0-10s / 0–5秒 / 0:00-0:10，带括号或裸写。
  const rangeRe =
    /[（(]\s*(?:\d{1,2}:\d{2}(?:\s*[–—~\-]\s*\d{1,2}:\d{2})?|\d+(?:\.\d+)?\s*[–—~\-]\s*\d+(?:\.\d+)?\s*(?:s|秒|sec))\s*[)）]|(?<![0-9:])\d{1,2}:\d{2}\s*[–—~\-]\s*\d{1,2}:\d{2}|(?<![0-9])\d+(?:\.\d+)?\s*[–—~\-]\s*\d+(?:\.\d+)?\s*(?:s|秒)/g;
  for (const m of text.matchAll(rangeRe)) {
    const start = m.index;
    if (inLabel(start)) continue;
    const lp = labelTailPoint(start);
    if (lp != null) { points.add(lp); continue; }
    const parenthesized = m[0].startsWith("（") || m[0].startsWith("(");
    if (parenthesized || bareQualifies(start)) points.add(adjustPoint(start));
  }
  // 单个时长：（3秒）/（5s）带括号，或句首裸写且后接冒号/逗号/空白
  // （「3秒，特写…」「5s：…」）；粘连正文的（「20秒连续镜头」）不算。
  const singleRe =
    /[（(]\s*\d+(?:\.\d+)?\s*(?:s|秒|sec)\s*[)）]|(?<![0-9])\d+(?:\.\d+)?\s*(?:s|秒|sec)(?![0-9])/g;
  for (const m of text.matchAll(singleRe)) {
    const start = m.index;
    if (inLabel(start)) continue;
    const lp = labelTailPoint(start);
    if (lp != null) { points.add(lp); continue; }
    if (!bareQualifies(start)) continue;
    const after = text.slice(start + m[0].length, start + m[0].length + 1);
    if (after && !"：:，、".includes(after) && !/\s/.test(after)) continue;
    points.add(adjustPoint(start));
  }
  return [...points].sort((a, b) => a - b);
}

/** 把脚本正文切成段：优先按段/镜标记与时间标注切分（行中出现也切），
 *  标记不足两个时回退到原有的空行分段。 */
function splitScriptSegments(scriptText: string): string[] {
  const text = scriptText.trim();
  if (!text) return [];
  const points = scriptSegmentBoundaries(text);
  if (points.length >= 2) {
    const segs: string[] = [];
    let from = 0;
    for (const pt of points) {
      const seg = text.slice(from, pt).trim();
      if (seg) segs.push(seg);
      from = pt;
    }
    const tail = text.slice(from).trim();
    if (tail) segs.push(tail);
    if (segs.length >= 2) return segs;
  }
  return text
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/** 从一段原文里读时长：以镜段标题为准——时间段（0-10s / 0–5秒 /
 *  0:00-0:10 时间戳）按起止差；单个时长只认段首/标题区标注（「第一段
 *  （3秒）：」「镜1 5秒」「镜2（6秒）」「时长：5秒」「5s：…」、表格行
 *  镜号后的「5s」），段中正文提到的「停顿 3 秒」不算本镜时长。范围与
 *  括号时长只在标题区（前 120 字）内查找，避免正文里的时长描写夺权。 */
function segmentDurationSec(text: string): number {
  const headZone = text.slice(0, 120);
  const ts = headZone.match(/(\d{1,2}):(\d{2})\s*[–—~\-]\s*(\d{1,2}):(\d{2})/);
  if (ts) {
    const start = Number(ts[1] ?? 0) * 60 + Number(ts[2] ?? 0);
    const end = Number(ts[3] ?? 0) * 60 + Number(ts[4] ?? 0);
    if (end > start) return end - start;
  }
  const m = headZone.match(/(\d+(?:\.\d+)?)\s*[–—~\-]\s*(\d+(?:\.\d+)?)\s*(?:s|秒|sec)/);
  if (m) {
    const d = parseFloat(m[2] ?? "0") - parseFloat(m[1] ?? "0");
    if (d > 0) return d;
  }
  // 标题区内显式写明的「时长：X秒 / 时长 X s」。
  const named = headZone.match(/时长\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:s|秒|sec)/);
  if (named) return parseFloat(named[1] ?? "0");
  // 标题区内的括号单个时长：「（3秒）」「(5s)」。
  const paren = text.slice(0, 60).match(/[（(]\s*(\d+(?:\.\d+)?)\s*(?:s|秒|sec)\s*[)）]/);
  if (paren) return parseFloat(paren[1] ?? "0");
  const head = text.replace(
    /^(?:#{1,4}\s*)?(?:\*\*)?\s*(第\s*[0-9０-９一二三四五六七八九十百]+\s*[段镜场幕]|(?:镜头|分镜)\s*[0-9０-９一二三四五六七八九十]+|镜\s*[0-9０-９]+|\d{1,3}[\s\t]+)\s*(?:\*\*)?\s*/,
    "",
  );
  const s = head.match(/^[（(]?\s*(\d+(?:\.\d+)?)\s*(?:s|秒|sec)\s*[)）]?\s*(?:[:：，、\s\t]|$)/);
  return s ? parseFloat(s[1] ?? "0") : 0;
}

/** 镜段标题的切分点：脚本里写了明确的镜段标题（第X镜/第X段/镜X/镜头X/
 *  分镜X/Shot X）时，只有这些标题段才是真正的分镜——标题之前的一切
 *  （项目概览、人物锁定、统一提示词、连续性说明、「分镜」总标题段等）
 *  都是非镜段落，一律不拆成镜。标题须在行首（可带 # 或 ** 修饰），
 *  避免正文里提到「镜子」「第3段回忆」之类误切。返回少于 2 个时不用。 */
function shotHeaderPoints(text: string): number[] {
  const re =
    /(?:^|\n)[ \t]*(?:#{1,4}[ \t]*)?(?:\*\*[ \t]*)?(?:第[ \t]*[0-9０-９一二三四五六七八九十]+[ \t]*[镜段场幕]|镜[ \t]*[0-9０-９]+|镜头[ \t]*[0-9０-９]+|分镜[ \t]*[0-9０-９]+|Shot[ \t]*[0-9]+)/gi;
  const points: number[] = [];
  for (const m of text.matchAll(re)) {
    let start = m.index;
    if (text[start] === "\n") start += 1;
    // 标题后必须紧跟标题分隔符（· : ： 、 （ 等）、时长数字或行尾：
    // 「镜2到镜8的首帧必须…」这类正文句子以动词续接，不是镜标题。
    const after = text.slice(m.index + m[0].length).replace(/^[ \t]+/, "");
    const c = after.charAt(0);
    if (c && !"·・:：、.。-—–~（(【[|｜".includes(c) && !/[0-9０-９]/.test(c) && c !== "\n" && c !== "\r") continue;
    points.push(start);
  }
  return points.sort((a, b) => a - b);
}

/** 非镜段落判定（回退分段路径用）：概览/锁定/设定/统一提示词/连续性
 *  说明/总标题这类段落不是镜头，即使里面写了总时长、统一秒数也不拆
 *  成镜。只认段首标题词或纯标题段，不误伤正文里提到这些词的真镜头。 */
function isNonShotSegment(seg: string): boolean {
  const t = seg.trim();
  if (!t) return true;
  const head = t.replace(/^(?:#{1,4}\s*)?(?:\*\*)?\s*/, "");
  // 强标题词：段首出现即是非镜章节（统一提示词结构、连续性铁律、
  // 人物与场景锁定之类，后缀词不影响判定）。
  if (
    /^(项目概览|概览|总览|人物锁定|角色锁定|人物与场景锁定|场景锁定|统一提示词|全局提示词|总提示词|连续性|衔接说明|制作说明|注意事项|总时长|镜头列表)/.test(head)
  ) return true;
  if (
    /^(基本信息|项目信息|人物设定|角色设定|人物档案|人物小传|人物介绍|主角设定|场景设定|场景卡|提示词|说明|备注|风格(?:要求|设定)?|画风|规格|参数|全片(?:信息|概览)?|分镜(?:脚本|列表|总表)?)(?:\*\*)?\s*(?:[:：\s]|$)/.test(head)
  ) return true;
  // 纯标题段：很短、带标题修饰或以冒号收尾、且含非镜标题关键词。
  if (
    t.length <= 30 &&
    /(概览|锁定|设定|提示词|连续性|分镜|脚本|标题|总览|说明)/.test(t) &&
    !/第\s*[0-9０-９一二三四五六七八九十]+\s*[镜段场]|镜\s*[0-9０-９]+\s*[（(]|镜头\s*[0-9０-９]/.test(t)
  ) return true;
  return false;
}

/** 纯解析：段落切分＋排除说明段＋时间标注时长。预览与正式拆分共用同一套规则，
 *  保证「预览看到什么，确认应用就写入什么」。 */
function parseScriptDrafts(
  scriptText: string,
  targetSeconds: number,
): { drafts: SplitDraft[]; excluded: string[] } {
  const text0 = scriptText.trim();
  const excluded: string[] = [];
  let segments: string[] = [];
  // 第一优先：明确镜段标题。有 2 个以上标题时，只拆标题段，标题之前
  // 与标题之间的非镜内容（概览、人物锁定、**分镜**总标题、统一提示
  // 词、连续性说明等）全部列入 excluded 明示，不拆成镜、不占时长。
  const hp = shotHeaderPoints(text0);
  if (hp.length >= 2) {
    const first = hp[0] ?? 0;
    const preamble = text0.slice(0, first).trim();
    if (preamble) excluded.push(preamble);
    for (let i = 0; i < hp.length; i++) {
      const from = hp[i] ?? 0;
      const to = i + 1 < hp.length ? (hp[i + 1] ?? text0.length) : text0.length;
      let seg = text0.slice(from, to).trim();
      if (!seg) continue;
      // 两标题之间夹着的非镜小段（如紧跟标题后的统一提示词块）不算镜。
      if (isNonShotSegment(seg) && !/第\s*[0-9０-９一二三四五六七八九十]+\s*[镜段场]|镜\s*[0-9０-９]+|镜头\s*[0-9０-９]+|分镜\s*[0-9０-９]+|Shot\s*[0-9]+/i.test(seg.slice(0, 40))) {
        excluded.push(seg);
        continue;
      }
      // 镜段尾部缀着的非镜章节（最后一镜后面的统一提示词/连续性说明
      // 等）：从第一个非镜空行块起截断，截下的部分列入 excluded，
      // 不并进本镜动作、不占本镜时长。
      {
        const blocks = seg.split(/\n\s*\n/);
        if (blocks.length > 1) {
          const cutAt = blocks.findIndex((b, bi) => bi > 0 && isNonShotSegment(b));
          if (cutAt > 0) {
            excluded.push(blocks.slice(cutAt).join("\n\n"));
            seg = blocks.slice(0, cutAt).join("\n\n").trim();
          }
        }
      }
      if (seg) segments.push(seg);
    }
  }
  if (segments.length === 0) {
    const paragraphs = splitScriptSegments(scriptText);
    for (const x of paragraphs) {
      if (/^(梗概|故事梗概|台词|对白|人物小传|人物介紹|人物介绍|场景设定|说明)[:：]/.test(x)) excluded.push(x);
      // 表格型脚本的表头行（镜号 时长 景别 画面内容…）不是镜头，排除并明示。
      else if (/^(镜号|序号|编号)[\s\t]/.test(x) && /(时长|景别|画面|运镜)/.test(x)) excluded.push(x);
      else if (isNonShotSegment(x)) excluded.push(x);
      else segments.push(x);
    }
    if (segments.length === 0) segments = paragraphs;
  }
  if (segments.length === 0) return { drafts: [], excluded };

  const drafts: SplitDraft[] = segments.map((text) => {
    const dur = segmentDurationSec(text);
    return {
      action: text, durationSec: dur > 0 ? Math.max(0.5, dur) : 0, framing: "", cameraMove: "",
      characterName: "", sceneName: "", characterNames: [], sceneNames: [], startState: "", endState: "",
      handoffNote: "自动拆分镜：首帧在制作这一段时定位，后续镜首帧走自动带入。",
    };
  });
  const noDur = drafts.filter((d) => d.durationSec <= 0);
  if (noDur.length > 0) {
    const known = drafts.filter((d) => d.durationSec > 0);
    if (known.length === 0) {
      // 全镜都没有时长标注：才按原口径把目标时长分给各镜。
      const each = Math.max(1, Math.round((targetSeconds / drafts.length) * 10) / 10);
      for (const d of noDur) d.durationSec = each;
    } else {
      // 已有镜段标题写明秒数时，严禁用目标时长平均摊派（那会把标题里
      // 的 5 秒镜摊成 3.1 秒）：已标注镜的时长逐字保留、总时长以标注
      // 之和为准；个别未标注镜只按已标注镜的平均时长暂填，校对时可改，
      // 但绝不改动任何一镜已标注的秒数。
      const avg = known.reduce((a, d) => a + d.durationSec, 0) / known.length;
      const fill = Math.max(0.5, Math.round(avg * 10) / 10);
      for (const d of noDur) d.durationSec = fill;
    }
  }
  return { drafts, excluded };
}

/** 用现有提炼能力补景别/运镜/人物/场景/起止状态；模型不可用时回退纯文本。 */
async function enrichDrafts(
  ctx: Ctx,
  projectId: number,
  drafts: SplitDraft[],
): Promise<void> {
  const db = ctx.db<typeof schema>();
  const chars = await db.select().from(schema.characters).where(eq(schema.characters.projectId, projectId));
  const scns = await db.select().from(schema.scenes).where(eq(schema.scenes.projectId, projectId));
  try {
    const out = await ctx.inference.complete(
      [
        "你在把一段短片脚本按段拆成分镜。下面每段将成为一镜，请为每段提炼：景别、运镜、出场人物（可多选：一段里同时出现多个人物就全部列出，只能从给定人物名单选，没有就留空数组）、场景（可多选：一段涉及多个场景就全部列出，只能从给定场景名单选，没有就留空数组）、开始状态、结束状态。characterName/sceneName 填多选名单的第一项作兼容（无则留空）。起止状态逐段相承：下一镜开始状态等于上一镜结束状态。只依据脚本原文提炼，不添加脚本里没有的情节。",
        `人物名单：${chars.map((c) => c.name).join("、") || "（无）"}`,
        `场景名单：${scns.map((x) => x.name).join("、") || "（无）"}`,
        ...drafts.map((d, i) => `第 ${i + 1} 段：${d.action}`),
      ].join("\n"),
      {
        schema: z.object({
          shots: z.array(
            z.object({
              framing: z.string(), cameraMove: z.string(),
              characterName: z.string(), sceneName: z.string(),
              characterNames: z.array(z.string()), sceneNames: z.array(z.string()),
              startState: z.string(), endState: z.string(),
            }),
          ),
        }),
      },
    );
    out.shots.forEach((enriched, i) => {
      const d = drafts[i];
      if (!d) return;
      d.framing = enriched.framing;
      d.cameraMove = enriched.cameraMove;
      // 多选名单只收本项目档案里真实存在的名字，不编造；单值字段同步第一项。
      const validCharNames = new Set(chars.map((c) => c.name));
      const validSceneNames = new Set(scns.map((x) => x.name));
      d.characterNames = [...new Set([...(enriched.characterNames ?? []), enriched.characterName].filter((n) => n && validCharNames.has(n)))];
      d.sceneNames = [...new Set([...(enriched.sceneNames ?? []), enriched.sceneName].filter((n) => n && validSceneNames.has(n)))];
      d.characterName = d.characterNames[0] ?? "";
      d.sceneName = d.sceneNames[0] ?? "";
      d.startState = enriched.startState;
      d.endState = enriched.endState;
    });
  } catch {
    // 模型不可用时回退纯文本拆分：起止状态逐段相承留空待填。
  }
  // 人物/场景兜底指定（多选口径，不编造，只用本项目已有档案）：镜文里
  // 提到多个人物/场景就全部关联（一镜多人同处一场景、多场景切换都靠
  // 这里全量匹配）；只提到一个时仍按原单人/单场景规则；本镜一个都没
  // 提到时，全稿只提到一个人物/场景才给每镜指定它，项目里只有一个人/
  // 一个场景时直接指定。留空会让派单读不到人物档案与场景卡、无法严格
  // 参照（实测事故：单人项目第 1 镜 characterId 为空，档案里明明有定版
  // 图却没被参照）。
  const allText = drafts.map((d) => d.action).join("\n");
  const mentionedChars = chars.filter((c) => c.name && allText.includes(c.name));
  const mentionedScenes = scns.filter((x) => (x.name && allText.includes(x.name)) || (x.location && allText.includes(x.location)));
  for (const d of drafts) {
    const hits = chars.filter((c) => c.name && d.action.includes(c.name)).map((c) => c.name);
    for (const h of hits) if (!d.characterNames.includes(h)) d.characterNames.push(h);
    if (d.characterNames.length === 0) {
      if (mentionedChars.length === 1 && mentionedChars[0]) d.characterNames = [mentionedChars[0].name];
      else if (chars.length === 1 && chars[0]) d.characterNames = [chars[0].name];
    }
    d.characterName = d.characterNames[0] ?? "";
    const sHits = scns.filter((x) => (x.name && d.action.includes(x.name)) || (x.location && d.action.includes(x.location))).map((x) => x.name);
    for (const h of sHits) if (!d.sceneNames.includes(h)) d.sceneNames.push(h);
    if (d.sceneNames.length === 0) {
      if (mentionedScenes.length === 1 && mentionedScenes[0]) d.sceneNames = [mentionedScenes[0].name];
      else if (scns.length === 1 && scns[0]) d.sceneNames = [scns[0].name];
    }
    d.sceneName = d.sceneNames[0] ?? "";
  }
  for (let i = 1; i < drafts.length; i++) {
    const d = drafts[i];
    const prev = drafts[i - 1];
    if (d && prev && !d.startState && prev.endState) d.startState = prev.endState;
  }
}

/** 把校对后的草稿逐镜写入。人物/场景名只按本项目档案名单匹配，匹配不上留空，不编造。 */
async function writeDrafts(
  ctx: Ctx,
  p: typeof schema.projects.$inferSelect,
  drafts: SplitDraft[],
): Promise<{ created: number }> {
  const db = ctx.db<typeof schema>();
  const chars = await db.select().from(schema.characters).where(eq(schema.characters.projectId, p.id));
  const scns = await db.select().from(schema.scenes).where(eq(schema.scenes.projectId, p.id));
  const t = now();
  let created = 0;
  // 人物/场景指定兜底（校对稿直写路径同样适用，不只自动提炼路径）：
  // 名字匹配不上时，先按镜文里出现的名字匹配，全稿只提到一个人物/
  // 场景时指定它，项目里只有一个人/一个场景时直接指定——不留空，
  // 留空会让派单与画布都读不到这镜的人物档案与场景卡参考。
  const allDraftText = drafts.map((d) => d.action).join("\n");
  const mentionedCharsW = chars.filter((c) => c.name && allDraftText.includes(c.name));
  const mentionedScenesW = scns.filter((x) => (x.name && allDraftText.includes(x.name)) || (x.location && allDraftText.includes(x.location)));
  // 多选解析：校对稿名单（characterNames/sceneNames，含旧单值第一项）
  // 逐个按名匹配本项目档案，再补镜文里出现的全部名字；一个都没匹配上
  // 时才回退原单值兜底（全稿只提到一个 / 项目只有一个）。
  const resolveCharIds = (d: SplitDraft): number[] => {
    const out: number[] = [];
    const names = [...new Set([...(d.characterNames ?? []), d.characterName].filter(Boolean))];
    for (const nm of names) {
      const c = chars.find((x) => x.name === nm);
      if (c && !out.includes(c.id)) out.push(c.id);
    }
    for (const c of chars) {
      if (c.name && d.action.includes(c.name) && !out.includes(c.id)) out.push(c.id);
    }
    if (out.length === 0) {
      if (mentionedCharsW.length === 1 && mentionedCharsW[0]) out.push(mentionedCharsW[0].id);
      else if (chars.length === 1 && chars[0]) out.push(chars[0].id);
    }
    return out;
  };
  const resolveSceneIds = (d: SplitDraft): number[] => {
    const out: number[] = [];
    const names = [...new Set([...(d.sceneNames ?? []), d.sceneName].filter(Boolean))];
    for (const nm of names) {
      const x = scns.find((y) => y.name === nm);
      if (x && !out.includes(x.id)) out.push(x.id);
    }
    for (const x of scns) {
      if (((x.name && d.action.includes(x.name)) || (x.location && d.action.includes(x.location))) && !out.includes(x.id)) out.push(x.id);
    }
    if (out.length === 0) {
      if (mentionedScenesW.length === 1 && mentionedScenesW[0]) out.push(mentionedScenesW[0].id);
      else if (scns.length === 1 && scns[0]) out.push(scns[0].id);
    }
    return out;
  };
  const createdShotIds: Array<{ id: number; characterIds: number[]; sceneIds: number[] }> = [];
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (!d) continue;
    const charIdsW = resolveCharIds(d);
    const sceneIdsW = resolveSceneIds(d);
    const [ins] = await db.insert(schema.shots).values({
      projectId: p.id, sortOrder: i, durationSec: Math.max(0.5, d.durationSec || 1),
      framing: d.framing, cameraMove: d.cameraMove,
      characterId: charIdsW[0] ?? null,
      sceneId: sceneIdsW[0] ?? null,
      characterIds: JSON.stringify(charIdsW),
      sceneIds: JSON.stringify(sceneIdsW),
      characterPosition: "",
      startState: d.startState, action: d.action, endState: d.endState,
      handoffNote:
        i === 0
          ? "拆镜校对确认：第一镜，首帧在制作这一段时定位。"
          : "拆镜校对确认：首帧走自动带入（上一镜真实尾帧）。",
      firstFrameLabel: i === 0 ? "首帧 · 第 1 段开场（制作时定位）" : "",
      lastFrameLabel: `尾帧 · 第 ${i + 1} 段结尾`,
      createdAt: t, updatedAt: t,
    }).returning({ id: schema.shots.id });
    if (ins) createdShotIds.push({ id: ins.id, characterIds: charIdsW, sceneIds: sceneIdsW });
    created++;
  }
  // 画布自动连线（全工具通用）：拆镜不能只落分镜行——每镜的人物/场景
  // 参考与镜序首尾帧链要同步连到画布上，保证分镜页、画布页、派单任务
  // 单三处看到的参考来源一致（分镜里有参考、画布上没线、派单读不到
  // 参考，就是实测过的事故形态）。已有同源同向同角色连线不重复建，
  // 用户手动改过的连线不覆盖、不删除；本函数只增不改。
  {
    const existingLinks = await db.select().from(schema.canvasLinks).where(eq(schema.canvasLinks.projectId, p.id));
    const hasLink = (fromKind: string, fromId: number, toId: number, role: string) =>
      existingLinks.some((l) => l.fromKind === fromKind && l.fromId === fromId && l.toKind === "shot" && l.toId === toId && l.role === role);
    const addLink = async (fromKind: "character" | "scene" | "shot", fromId: number, toId: number, role: string, note: string) => {
      if (hasLink(fromKind, fromId, toId, role)) return;
      // 首帧来源唯一：一镜已有任何首帧连线（用户手动连的）时不抢占。
      if (role === "firstframe" && existingLinks.some((l) => l.toKind === "shot" && l.toId === toId && l.role === "firstframe")) return;
      await db.insert(schema.canvasLinks).values({
        projectId: p.id, fromKind, fromId, toKind: "shot", toId, role, note, createdAt: now(),
      });
      existingLinks.push({
        id: -1, projectId: p.id, fromKind, fromId, toKind: "shot", toId, role, note, createdAt: now(),
      });
    };
    for (let i = 0; i < createdShotIds.length; i++) {
      const cs = createdShotIds[i];
      if (!cs) continue;
      for (const cid of cs.characterIds) await addLink("character", cid, cs.id, "reference", "自动拆镜连线：出场人物参考（人物档案定版图）");
      for (const sid of cs.sceneIds) await addLink("scene", sid, cs.id, "reference", "自动拆镜连线：场景参考（场景卡图）");
      const prev = createdShotIds[i - 1];
      if (prev) {
        // 多选换场景口径：两镜场景集合完全不相交才断链，共享任一场景仍承接。
        const sceneBreak = cs.sceneIds.length > 0 && prev.sceneIds.length > 0 && !cs.sceneIds.some((id) => prev.sceneIds.includes(id));
        if (!sceneBreak)
          await addLink("shot", prev.id, cs.id, "firstframe", "自动拆镜连线：上一镜尾帧 → 本镜首帧（链式承接，上一镜真实尾帧回填后自动带入本镜首帧）");
      }
    }
  }
  return { created };
}

async function doSplitScript(
  ctx: Ctx,
  p: typeof schema.projects.$inferSelect,
): Promise<{ created: number }> {
  const { drafts } = parseScriptDrafts(p.scriptText, p.targetSeconds);
  if (drafts.length === 0) return { created: 0 };
  await enrichDrafts(ctx, p.id, drafts);
  return writeDrafts(ctx, p, drafts);
}
