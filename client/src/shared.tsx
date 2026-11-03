import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fileToBase64, localAssetUrl } from "../local-sdk";
import { api, type ApiResponse } from "./api";

export type Project = ApiResponse<typeof api, "listProjects">["projects"][number];
export type ProjectFull = ApiResponse<typeof api, "getProject">;
export type Character = ProjectFull["characters"][number];
export type RefSlot = Character["refs"][number];
export type Scene = ProjectFull["scenes"][number];
export type Shot = ProjectFull["shots"][number];
export type Result = Shot["results"][number];
export type Job = ProjectFull["jobs"][number];
export type CanvasNodeT = ProjectFull["nodes"][number];
export type CanvasLink = ProjectFull["links"][number];

// These private originals were not captured. Resolve only an explicitly
// supplied local original; the absent default keeps the existing placeholders.
const ASSET_KEYS = new Set([
  "asset:father-v7", "asset:son-a", "asset:son-b", "asset:yard",
  "asset:tractor-man", "asset:tractor-field",
]);

export const ASSET_LABELS: Record<string, string> = {
  "asset:father-v7": "历史参考素材1（需自行配置）",
  "asset:son-a": "历史参考素材2（需自行配置）",
  "asset:son-b": "历史参考素材3（需自行配置）",
  "asset:yard": "历史参考素材4（需自行配置）",
  "asset:tractor-man": "历史参考素材5（需自行配置）",
  "asset:tractor-field": "历史参考素材6（需自行配置）",
};

/** 媒体键 → 可渲染地址。私有原图未配置时返回 null，明确保留缺图状态。 */
export function mediaSrc(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.startsWith("asset:")) return ASSET_KEYS.has(key) ? localAssetUrl(key) : null;
  return `./blobs/${key}`;
}

export async function fileToB64(file: File): Promise<string> {
  const { dataBase64 } = await fileToBase64(file);
  return dataBase64;
}

/** 跨页缺项导航目标：准备检查里每个问题都带一个，点按钮跳到对应页签的元素并高亮。 */
export interface NavTarget {
  tab: string;
  shotId?: number | null;
  characterId?: number | null;
  sceneId?: number | null;
  slotKey?: string | null;
  field?: string | null;
  resultId?: number | null;
  nonce: number;
}

/** 滚动到元素并短暂高亮（样式见 theme.css 的 .flash-target）。 */
export function flashElement(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("flash-target");
  window.setTimeout(() => el.classList.remove("flash-target"), 2800);
}

export function flashById(id: string) {
  flashElement(document.getElementById(id));
}

export function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["projects"] });
    void qc.invalidateQueries({ queryKey: ["project"] });
  };
}

/** 统一处理 {ok,error} 风格的动作结果：失败时把中文原因交给回调展示。 */
export function useDeskMutation<TArgs, TRes>(
  fn: (args: TArgs) => Promise<TRes>,
  onError: (msg: string) => void,
  onDone?: (res: TRes) => void,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      const r = res as { ok?: boolean; error?: string | null };
      if (r && r.ok === false && r.error) onError(r.error);
      else {
        invalidate();
        onDone?.(res);
      }
    },
    onError: (e) => onError(e instanceof Error ? e.message : String(e)),
  });
}

export function Notice({ msg, tone = "error" }: { msg: string | null; tone?: "error" | "info" }) {
  if (!msg) return null;
  return (
    <div
      role="alert"
      className="rounded-md px-3 py-2 text-sm"
      style={{
        background: tone === "error" ? "var(--accent-soft)" : "var(--amber-soft)",
        color: tone === "error" ? "var(--accent)" : "var(--text)",
        border: `1px solid ${tone === "error" ? "var(--accent)" : "var(--amber)"}`,
      }}
    >
      {msg}
    </div>
  );
}

export function Field({
  label, children, hint,
}: {
  label: string; children: ReactNode; hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium tracking-wide text-[var(--dim)]">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-[var(--dim)]">{hint}</span> : null}
    </label>
  );
}

export const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]";
export const btnCls =
  "inline-flex items-center justify-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)] active:opacity-70 disabled:opacity-40";
export const btnPrimary =
  "inline-flex items-center justify-center gap-1 rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-white active:opacity-80 disabled:opacity-40";
export const btnSmall =
  "inline-flex items-center justify-center rounded px-2 py-1 text-xs font-medium border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] active:opacity-70 disabled:opacity-40";

export function DropImage({
  onFile, label, className, accept = "image/*",
}: {
  onFile: (f: File) => void;
  label: string;
  className?: string;
  accept?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      className={className}
      style={over ? { outline: "2px solid var(--accent)", outlineOffset: -2 } : undefined}
      onClick={() => ref.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") ref.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="hidden"
        aria-label={label}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <span className="pointer-events-none flex h-full w-full items-center justify-center text-center text-xs text-[var(--dim)]">
        {label}
      </span>
    </div>
  );
}

/** 生成视频组件：分镜卡、画布、质检页共用同一实现。 */
export function GenerateVideo({
  project, shot,
}: {
  project: NonNullable<ProjectFull["project"]>;
  shot: Shot;
}) {
  const [quality, setQuality] = useState(shot.videoQuality ?? project.defaultQuality);
  const [msg, setMsg] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const [execNote, setExecNote] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const invalidate = useInvalidate();
  const activeResult = shot.results.find(
    (r) => !r.videoKey && r.genStatus === "running" &&
      (r.jobStatus === "awaiting_assistant" || r.jobStatus === "generating" || r.jobStatus === "generating_stale_unknown" || r.jobStatus === "dispatched"),
  );
  const chainBlocked = !!project.chainStrict && !!shot.chain?.status.startsWith("blocked");
  const chainThumb = mediaSrc(shot.chain?.autoFilled ? shot.firstFrameKey : shot.resolvedFirstFrame.key);
  const dispatch = useMutation({
    mutationFn: () => api.dispatchGeneration({ shotId: shot.id, quality: quality as "480P" | "720P" | "1080P" }),
    onSuccess: (res) => {
      if (!res.ok) {
        setMsg(res.error);
        // 被防重复拦截时服务端会带回已有任务的冻结任务单：展示它，让用户看到任务仍在原版本上。
        setSheet(res.taskSheet ?? null);
        setExecNote(res.resultId ? "上面是已在进行中的那一单（未新建版本）。重试 = 到质检页对该版本点「交给助手执行」，不会产生新版本。" : null);
        setWarnings([]);
      } else {
        setMsg(null);
        setSheet(res.taskSheet);
        setWarnings(res.warnings);
        setExecNote(
          res.assistantTaskId
            ? "已派单，派单快照已冻结（按派单时刻的当前脚本/分镜/人物档案参考/场景卡参考/首尾帧链）：生成中再改分镜不会影响这一单，下一单才用新版。Muse 助手已领取执行（生成中），成片将回填到本镜的新版本，状态变为「回填待审核」后请到质检页审核采用。"
            : "已派单，派单快照已冻结（按派单时刻的当前脚本/分镜/人物档案参考/场景卡参考/首尾帧链）：生成中再改分镜不会影响这一单，下一单才用新版。当前状态为「待助手执行」（助手自动领取未启动，不等于已生成）。成片由 Muse 助手生成后回填到本镜的新版本；也可在质检页对该版本点「交给助手执行」重新启动。",
        );
        invalidate();
      }
    },
    onError: (e) => setMsg(e instanceof Error ? e.message : String(e)),
  });
  const setQ = useMutation({
    mutationFn: (q: string) =>
      api.setShotQuality({ shotId: shot.id, quality: q as "480P" | "720P" | "1080P" }),
    onSuccess: invalidate,
  });
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--surface2)] p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold tracking-wide text-[var(--dim)]">生成视频</span>
        <div className="flex overflow-hidden rounded border border-[var(--border)]" role="group" aria-label={`第 ${shot.sortOrder + 1} 镜画质选择`}>
          {(["480P", "720P", "1080P"] as const).map((q) => (
            <button
              key={q}
              type="button"
              aria-label={`${q}${q === (shot.videoQuality ?? project.defaultQuality) ? "（生效）" : ""}`}
              aria-pressed={quality === q}
              className="px-2 py-1 text-xs font-medium"
              style={
                quality === q
                  ? { background: "var(--ink)", color: "var(--ink-text)" }
                  : { background: "var(--surface)", color: "var(--text)" }
              }
              onClick={() => {
                setQuality(q);
                setQ.mutate(q);
              }}
            >
              {q}
            </button>
          ))}
        </div>
        <span className="text-xs text-[var(--dim)]">
          生效画质 {shot.videoQuality ?? `${project.defaultQuality}（项目默认）`}
        </span>
        <button
          type="button"
          className={btnPrimary + " ml-auto px-3 py-1.5 text-xs"}
          aria-label={`生成第 ${shot.sortOrder + 1} 镜视频`}
          disabled={dispatch.isPending || !!activeResult || chainBlocked}
          onClick={() => dispatch.mutate(undefined)}
        >
          {dispatch.isPending ? "派单中…" : activeResult ? `V${activeResult.versionNumber} 进行中 · 勿重复派单` : chainBlocked ? "严格链阻塞 · 等上段尾帧" : "▶ 生成视频"}
        </button>
      </div>
      {shot.chain ? (
        <div className="mt-1.5 flex items-start gap-2 rounded px-2 py-1.5" style={{ background: chainBlocked ? "var(--accent-soft)" : shot.chain.status === "auto_filled" || shot.chain.status === "ready_chained" ? "#e6f0e0" : "var(--surface)", border: `1px solid ${chainBlocked ? "var(--accent)" : "var(--border)"}` }}>
          {chainThumb ? <img src={chainThumb} alt={`第 ${shot.sortOrder + 1} 镜严格首帧${shot.chain.mode === "uploaded" ? "（用户上传的首帧参考图）" : "（上一镜真实尾帧）"}`} className="h-10 w-16 shrink-0 rounded object-cover" /> : null}
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--text)]">
            <span className="font-semibold">{project.chainStrict ? "严格链 · " : ""}{shot.chain.status === "auto_filled" ? "尾帧已自动填入本镜首帧" : shot.chain.status === "ready_chained" ? "上一镜真实尾帧可严格衔接" : chainBlocked ? "严格链阻塞" : shot.chain.mode === "uploaded" ? "第一镜 · 方式 A 上传图锚点" : shot.chain.mode === "archive_scene" ? "第一镜 · 方式 B 档案＋场景严格生成" : "链式衔接"}</span>
            {"："}{shot.chain.detail}
            {!chainBlocked && (shot.chain.status === "auto_filled" || shot.chain.status === "ready_chained") ? " 生成时该图是参照清单第 1 项（首帧），第一帧须与它完全一致；其后还有本镜所选人物的定版图＋身份锁与所选场景的场景图逐张传入——尾帧只是首帧约束，不替代人物/场景参照。" : ""}
          </p>
        </div>
      ) : null}
      {activeResult ? (
        <p className="mt-1.5 rounded bg-[var(--amber-soft)] px-2 py-1.5 text-xs leading-relaxed text-[var(--text)]">
          本镜已有进行中的任务：版本 V{activeResult.versionNumber} · {activeResult.jobStatus === "generating" ? "生成中（助手执行中）" : "待助手执行"} · 任务单已冻结，结果将回到 V{activeResult.versionNumber}。
          刷新或切换页面不会重复派单；助手未启动时，到质检页对该版本点「交给助手执行」即可（重试领取，不产生新版本）。
        </p>
      ) : null}
      {shot.identityConflicts && shot.identityConflicts.length > 0 ? (
        <div className="mt-1.5 rounded px-2 py-1.5" style={{ background: "var(--accent-soft)", border: "1px solid var(--accent)" }} role="alert" aria-label={`第 ${shot.sortOrder + 1} 镜身份冲突提示`}>
          <p className="text-xs font-semibold leading-relaxed text-[var(--text)]">身份冲突 · 本镜身份以人物档案为准（派单前提示）</p>
          <ul className="mt-0.5 space-y-0.5">
            {shot.identityConflicts.map((cf) => (
              <li key={`${cf.characterId}-${cf.field}`} className="text-xs leading-relaxed text-[var(--text)]">
                人物「{cf.characterName}」{cf.field}：脚本里与档案冲突的身份描述已剥离：<strong>{cf.scriptValue}→档案{cf.archiveValue}</strong>。生成指令的身份段只写档案的「{cf.archiveValue}」，脚本的「{cf.scriptValue}」不进入生成提示词，只保留动作/场景/运镜。
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text)]">
            如果你其实想要脚本里的样子，不要靠提示词临时改身份：请先到「人物档案」更新该人物的身份（改发型/服装等）、重新生成主肖像和参考图并定版，再回来派单——档案更新为新身份后，生成指令才会按新身份走。
          </p>
        </div>
      ) : (
        <p className="mt-1.5 rounded bg-[var(--surface)] px-2 py-1.5 text-xs leading-relaxed text-[var(--dim)]">
          身份与动作是分开的：本镜人物身份只以人物档案为准（主定版肖像＋定版参考图＋身份锁原文，决定脸、发型、服装、体型）；分镜提示词只决定本镜动作、场景、运镜、光线与情绪，不决定身份。脚本身份描述若与档案冲突，派单时会被检测出来、明示并剥离。
        </p>
      )}
      <div className="mt-1.5 rounded bg-[var(--surface)] px-2 py-1.5">
        <p className="text-xs font-medium text-[var(--text)]">
          本镜引用（派单将按当前内容冻结快照：动作「{shot.action ? shot.action.slice(0, 40) : "未填"}」· {shot.durationSec}s · {project.aspect} · 画质 {quality}）
        </p>
        {shot.references.length === 0 ? (
          <p className="mt-0.5 text-xs text-[var(--amber)]">尚无引用：未指定出场人物/场景，画布也没有连线到本镜。{shot.chain.mode === "archive_scene" ? "本镜是无尾帧首镜的方式 B，现无人物档案/场景卡可读，派单会如实警告依据缺失。" : "派单将只有分镜文字与首帧。"}</p>
        ) : (
          <ul className="mt-0.5 space-y-0.5">
            {shot.references.map((rf) => (
              <li key={`${rf.kind}-${rf.refId}-${rf.role}`} className="text-xs leading-relaxed">
                <span className="font-medium">{rf.role === "firstframe" ? "首帧" : rf.role === "lastframe" ? "尾帧" : "参考"}</span>
                {" · "}{rf.title}
                <span className="text-[var(--dim)]">（{rf.detail}）</span>
                {rf.mediaMissing ? <span className="text-[var(--accent)]"> · 缺图：该来源没有可用图片，派单会明确警告、不会悄悄忽略</span> : <span style={{ color: "#3d7a3a" }}> · 有图</span>}
              </li>
            ))}
          </ul>
        )}
        {shot.references.filter((rf) => rf.role === "firstframe").length > 1 ? (
          <p className="mt-0.5 text-xs text-[var(--accent)]">首帧冲突：本镜有 {shot.references.filter((rf) => rf.role === "firstframe").length} 个首帧来源，请在画布连线管理里删到只剩一个再派单。</p>
        ) : null}
        {shot.references.filter((rf) => rf.role === "lastframe").length > 1 ? (
          <p className="mt-0.5 text-xs text-[var(--accent)]">尾帧冲突：本镜有 {shot.references.filter((rf) => rf.role === "lastframe").length} 个尾帧来源，请在画布连线管理里删到只剩一个再派单。</p>
        ) : null}
      </div>
      <p className="mt-1.5 rounded bg-[var(--amber-soft)] px-2 py-1.5 text-xs leading-relaxed text-[var(--text)]">
        {project.locked
          ? "项目已锁版（可选定稿）。本次派单将按当前分镜冻结：派单时自动冻结当前脚本、分镜、人物档案参考、场景卡参考与首尾帧链快照，生成中再改分镜不会影响这一单，下一单才用新版。"
          : "项目未锁版也没关系——锁版是可选定稿，不点也能派单。本次派单将按当前分镜冻结：派单时自动冻结当前脚本、分镜、人物档案参考、场景卡参考与首尾帧链快照，生成中再改分镜不会影响这一单，下一单才用新版。"}
      </p>
      <Notice msg={msg} />
      {execNote ? (
        <p className="mt-1.5 rounded bg-[var(--amber-soft)] px-2 py-1.5 text-xs leading-relaxed text-[var(--text)]">{execNote}</p>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {warnings.map((w) => (
            <li key={w} className="text-xs leading-relaxed text-[var(--amber)]">{w}</li>
          ))}
        </ul>
      ) : null}
      {sheet ? (
        <details className="mt-2" open>
          <summary className="cursor-pointer text-xs font-medium text-[var(--accent)]">
            本单任务单（派单快照已冻结：派单时刻的脚本＋分镜＋身份锁原文＋全部定版参考＋场景参考＋首尾帧链＋版本＋画质；之后改分镜不影响本单）
          </summary>
          <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface)] p-2 text-xs leading-relaxed text-[var(--text)]">
            {sheet}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

export const QC_LABEL: Record<string, string> = {
  pending: "待质检",
  pass: "质检通过",
  fail: "质检不通过 · 需重拍",
};
export const GEN_LABEL: Record<string, string> = {
  none: "未生成",
  running: "已派单 · 待执行",
  done: "已回填成片",
  failed: "生成失败",
  dispatched: "待助手执行",
  awaiting_assistant: "待助手执行",
  generating: "生成中 · 助手执行中",
  generating_stale_unknown: "生成中超时 · 状态待核查（不等于已中断）",
  returned: "已回填 · 待质检",
};

/** 结果版本所处阶段：派单后的状态链在界面上如实显示，不把「已准备」当完成。 */
export function resultPhase(r: Result): { label: string; color: string } {
  if (r.adopted) return { label: "已采用", color: "#3d7a3a" };
  if (r.genStatus === "failed") return { label: "生成失败 · 需重新派单", color: "var(--accent)" };
  if (r.videoKey) {
    if (r.qcStatus === "pass") return { label: "质检通过 · 待采用", color: "#3d7a3a" };
    if (r.qcStatus === "fail") return { label: "质检不通过 · 需重拍", color: "var(--accent)" };
    return { label: "回填待审核 · 待质检", color: "var(--amber)" };
  }
  if (r.videoMissing) return { label: "原台内成片未随包提供", color: "var(--dim)" };
  if (r.jobStatus === "generating_stale_unknown") return { label: "生成中超时 · 状态待核查", color: "var(--accent)" };
  if (r.jobStatus === "generating") return { label: "生成中 · 助手执行中", color: "var(--amber)" };
  if (r.jobStatus === "awaiting_assistant" || r.jobStatus === "dispatched" || r.genStatus === "running")
    return { label: "待助手执行", color: "var(--amber)" };
  return { label: "尚未回填成片", color: "var(--dim)" };
}

/** 结果版本卡：质检页与拼接页共用展示，质检页带操作。 */
/** 生成中超时待核查面板：超时≠中断。先核查原执行/原产物/上传状态；
 *  已有成片只恢复上传；只有勾选确认旧执行已终止，服务端才释放领取并作废旧尝试标识。 */
function StaleClaimPanel({ resultId, versionNumber, onNotice }: { resultId: number; versionNumber: number; onNotice: (m: string | null) => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const release = useDeskMutation(
    () => api.releaseGenerationClaim({ resultId, confirmTerminated: confirmed, note: note.trim() }),
    onNotice,
  );
  return (
    <div className="rounded px-2 py-1.5" style={{ background: "var(--accent-soft)", border: "1px solid var(--accent)" }}>
      <p className="text-xs leading-relaxed text-[var(--text)]">
        ⏳ V{versionNumber} 已「生成中」超过 30 分钟未回填——<strong>状态待核查，不等于已中断</strong>：可能原生成仍在运行，也可能成片已生成、只是上传卡住。
        请先核查原执行、原产物文件与上传状态：<strong>已有成片只恢复它的上传/关联到本版本，不要再次生成</strong>（可用下方「回填成片到本版本卡」直接关联已有文件）。
        只有确认旧执行已终止后，才能释放领取重新执行；释放会作废旧尝试标识，旧回调晚到会被拒绝。
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <label className="flex items-center gap-1.5 text-xs text-[var(--text)]">
          <input type="checkbox" aria-label={`确认 V${versionNumber} 旧执行已终止`} checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          我已核查并确认旧执行已终止（且无待恢复的原成片）
        </label>
        <input
          aria-label={`V${versionNumber} 释放核查说明`}
          className="min-w-36 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
          placeholder="核查说明（可选，如：原任务已结束无产物）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button" className={btnSmall} aria-label={`释放 V${versionNumber} 领取（确认旧执行已终止）`}
          disabled={!confirmed || release.isPending}
          onClick={() => release.mutate(undefined)}
        >
          {release.isPending ? "释放中…" : "释放领取（回到待助手执行）"}
        </button>
      </div>
    </div>
  );
}

export function ResultCard({
  result, shot, editable,
}: {
  result: Result;
  shot: Shot;
  editable?: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mut = useDeskMutation(
    (args: Parameters<typeof api.updateResult>[0]) => api.updateResult(args),
    setNotice,
  );
  const attachVideo = useDeskMutation(
    async (f: File) => {
      if (f.size > 30 * 1024 * 1024) return { ok: false, error: "视频文件超过 30MB，请压缩后再回填。" };
      const b64 = await fileToB64(f);
      return api.attachResultVideo({ resultId: result.id, dataBase64: b64, mimeType: f.type || "video/mp4" });
    },
    setNotice,
  );
  const attachFrame = useDeskMutation(
    async (f: File) => {
      const b64 = await fileToB64(f);
      return api.setResultLastFrame({ resultId: result.id, dataBase64: b64, mimeType: f.type || "image/jpeg" });
    },
    setNotice,
  );
  const del = useDeskMutation((id: number) => api.deleteResult({ resultId: id }), setNotice);
  const fail = useDeskMutation(
    (error: string) => api.markResultFailed({ resultId: result.id, error }),
    setNotice,
  );
  const startExec = useDeskMutation(
    (id: number) => api.startGenerationExecution({ resultId: id }),
    setNotice,
  );
  const [reshootMsg, setReshootMsg] = useState<string | null>(null);
  // 新派单重拍：不是重播本版旧片——服务端据本版质检意见生成一张不同的
  // 新任务单（写入不满意原因＋强制变化要求＋新变化标识），建新版本并派
  // 新尝试执行；回填与同镜其他版本完全相同的成片会被服务端按 SHA 拒绝。
  const reshoot = useDeskMutation(
    () =>
      api.dispatchGeneration({
        shotId: shot.id,
        quality: (result.videoQuality ?? shot.videoQuality ?? "720P") as "480P" | "720P" | "1080P",
        reshootFromResultId: result.id,
        qcNote,
      }),
    setNotice,
    (res) => {
      if (res.ok)
        setReshootMsg(`已新派单重拍：新版本已建（见本镜最新版本卡），新任务单已写入本版质检意见并要求与上一版明显不同，${res.assistantTaskId ? "新尝试执行中" : "当前待助手执行（尚未开始生成）"}；成片回填到新版本卡待你质检，不会覆盖、也不会重播本版旧片。`);
    },
  );
  const phase = resultPhase(result);
  const canAdopt = result.qcStatus === "pass" && !!result.videoKey;
  const [failText, setFailText] = useState("");
  const [qcNote, setQcNote] = useState(result.qcNote);
  const video = mediaSrc(result.videoKey);
  const lastFrame = mediaSrc(result.actualLastFrameKey);

  const captureFrame = async () => {
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth || 1280;
    canvas.height = v.videoHeight || 720;
    const g = canvas.getContext("2d");
    if (!g) return;
    g.drawImage(v, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.9));
    if (!blob) return;
    const f = new File([blob], "lastframe.jpg", { type: "image/jpeg" });
    attachFrame.mutate(f);
  };

  return (
    <div
      id={`result-card-${result.id}`}
      className="rounded-md border p-3"
      style={{
        borderColor: result.adopted ? "var(--accent)" : "var(--border)",
        background: "var(--surface)",
        borderWidth: result.adopted ? 2 : 1,
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-sm font-bold">V{result.versionNumber}</span>
        <span className="text-xs text-[var(--dim)]">{result.label}</span>
        {result.videoQuality ? (
          <span className="rounded bg-[var(--ink)] px-1.5 py-0.5 text-xs font-semibold text-[var(--ink-text)]">
            {result.videoQuality}
          </span>
        ) : null}
        <span className="text-xs text-[var(--dim)]">{GEN_LABEL[result.genStatus] ?? result.genStatus}</span>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-semibold"
          style={{ border: `1px solid ${phase.color}`, color: phase.color }}
        >
          {phase.label}
        </span>
        <span
          className="text-xs font-medium"
          style={{ color: result.qcStatus === "pass" ? "#3d7a3a" : result.qcStatus === "fail" ? "var(--accent)" : "var(--amber)" }}
        >
          {QC_LABEL[result.qcStatus] ?? result.qcStatus}
        </span>
        {result.adopted ? <span className="stamp">已采用</span> : null}
        <span className="ml-auto text-xs text-[var(--dim)]">
          {new Date(result.createdAt).toLocaleString("zh-CN", { hour12: false })}
        </span>
      </div>

      {result.genError ? (
        <p className="mt-2 whitespace-pre-wrap rounded bg-[var(--accent-soft)] px-2 py-1.5 text-xs leading-relaxed text-[var(--text)]">
          {result.genError}
        </p>
      ) : null}

      {video ? (
        <>
          <video
            ref={videoRef}
            src={video}
            controls
            className="mt-2 w-full rounded bg-black"
            aria-label={`第 ${shot.sortOrder + 1} 镜 V${result.versionNumber} 成片`}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <a
              href={video}
              download={`第${shot.sortOrder + 1}镜-V${result.versionNumber}.mp4`}
              className={btnSmall + " no-underline"}
              aria-label={`下载 V${result.versionNumber} 成片`}
            >
              ⬇ 下载成片
            </a>
            <span className="text-xs text-[var(--dim)]">成片就在本版本卡上：直接播放、下载；替换/删除在下方操作区（质检页），不用去资源库找。</span>
          </div>
        </>
      ) : result.videoMissing ? (
        <p className="mt-2 rounded border border-dashed border-[var(--border)] px-2 py-3 text-center text-xs text-[var(--dim)]">
          原台内成片未随数据包提供（包内只有数据与参考图原件）
        </p>
      ) : (
        <p className="mt-2 rounded border border-dashed border-[var(--border)] px-2 py-3 text-center text-xs text-[var(--dim)]">
          尚未回填成片 · 当前阶段：{phase.label}{editable ? "（成片由 Muse 助手生成后回填到本版本，或在下方手工回填）" : ""}
        </p>
      )}

      <div className="mt-2 flex items-start gap-2">
        <div className="w-28 shrink-0">
          <p className="mb-1 text-xs text-[var(--dim)]">真实尾帧</p>
          {lastFrame ? (
            <img src={lastFrame} alt={`V${result.versionNumber} 真实尾帧`} className="w-full rounded border border-[var(--border)]" />
          ) : result.lastFrameMissing ? (
            <p className="rounded border border-dashed border-[var(--border)] px-1 py-2 text-center text-xs text-[var(--dim)]">原台内尾帧未随包提供</p>
          ) : (
            <p className="rounded border border-dashed border-[var(--border)] px-1 py-2 text-center text-xs text-[var(--dim)]">未截取</p>
          )}
        </div>
        <div className="min-w-0 flex-1 text-xs leading-relaxed text-[var(--dim)]">
          <p>本镜采用后，本版本的真实尾帧会成为下一镜的自动带入首帧，下一镜严格以该图为首帧生成。</p>
          {video && !lastFrame && !result.lastFrameMissing ? (
            <p className="mt-1 rounded bg-[var(--accent-soft)] px-2 py-1.5 font-medium text-[var(--text)]">⚠ 还没有真实尾帧：下一连续镜会被严格阻塞、本版也无法采用（后面还有下一镜时）。请用下方「截取当前帧为尾帧」截到成片最后一帧，或「上传尾帧图」补齐——补上后会自动填入下一镜首帧。</p>
          ) : null}
          {lastFrame ? <p className="mt-1" style={{ color: "#3d7a3a" }}>✓ 真实尾帧已就绪，已自动填入下一镜首帧（下一镜生成时严格参照此图）。</p> : null}
          {result.taskSheet ? (
            <details>
              <summary className="cursor-pointer font-medium text-[var(--accent)]">查看本单任务单</summary>
              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface2)] p-2 text-xs text-[var(--text)]">{result.taskSheet}</pre>
            </details>
          ) : null}
        </div>
      </div>

      {editable ? (
        <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-2">
          {(result.jobStatus === "awaiting_assistant" || result.jobStatus === "dispatched") && !video && result.genStatus !== "failed" ? (
            <div className="flex flex-wrap items-center gap-2 rounded bg-[var(--amber-soft)] px-2 py-1.5">
              <span className="text-xs text-[var(--text)]">本单已冻结，尚待 Muse 助手执行生成（未生成）。</span>
              <button
                type="button" className={btnSmall} aria-label={`交给助手执行 V${result.versionNumber} 生成`}
                disabled={startExec.isPending}
                onClick={() => startExec.mutate(result.id)}
              >
                {startExec.isPending ? "启动中…" : "交给助手执行生成"}
              </button>
            </div>
          ) : null}
          {result.jobStatus === "generating" && !video ? (
            <p className="rounded bg-[var(--amber-soft)] px-2 py-1.5 text-xs text-[var(--text)]">
              Muse 助手正在执行本单（生成中），成片回填到本版本后状态会变为「回填待审核」，再由你质检采用。
            </p>
          ) : null}
          {result.jobStatus === "generating_stale_unknown" && !video ? (
            <StaleClaimPanel resultId={result.id} versionNumber={result.versionNumber} onNotice={setNotice} />
          ) : null}
          {result.qcStatus === "fail" ? (
            <div className="rounded px-2 py-1.5" style={{ background: "var(--accent-soft)", border: "1px solid var(--accent)" }}>
              <p className="text-xs leading-relaxed text-[var(--text)]">
                本版已判<strong>质检不通过</strong>。重拍请用下面这个按钮：它会<strong>新派一单</strong>——新建一个版本、生成一张<strong>不同的新任务单</strong>（把你在下方质检备注里写的不满意原因写进任务单，并明确要求避开该问题、在动作节奏/表情幅度/镜头微动上与本版明显不同）、发放新尝试标识重新生成；<strong>不是重播本版这条旧片</strong>，回填与旧版完全相同的成片也会被服务端拒绝。
              </p>
              <p className="mt-1 text-xs text-[var(--amber)]">视频生成通道已接通（状态：已接通 · 待首次真实生成验证）：重拍会新建版本并派 Muse 助手执行原生视频生成、按尝试标识回填；执行失败会如实报错，不会拿旧片冒充新成片。</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button" className={btnPrimary + " px-3 py-1.5 text-xs"} aria-label={`新派单重拍 V${result.versionNumber}（生成不一样的新版本）`}
                  disabled={reshoot.isPending}
                  onClick={() => reshoot.mutate(undefined)}
                >
                  {reshoot.isPending ? "派单中…" : `↻ 新派单重拍（据 V${result.versionNumber} 质检意见生成新版本）`}
                </button>
                <span className="text-xs text-[var(--dim)]">派单前请先在下方「质检备注」写清本版哪里不满意——写得越具体，新任务单的变化要求越对症。</span>
              </div>
              {reshootMsg ? (
                <p className="mt-1.5 rounded bg-[var(--amber-soft)] px-2 py-1.5 text-xs leading-relaxed text-[var(--text)]">{reshootMsg}</p>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <DropImage
              label={video ? "替换成片（点选/拖放新视频，换掉本版）" : "回填成片到本版本卡（点选/拖放视频）"}
              accept="video/*"
              className="h-9 flex-1 cursor-pointer rounded border border-[var(--border)] bg-[var(--surface2)] px-2"
              onFile={(f) => attachVideo.mutate(f)}
            />
            <DropImage
              label="上传尾帧图"
              accept="image/*"
              className="h-9 flex-1 cursor-pointer rounded border border-[var(--border)] bg-[var(--surface2)] px-2"
              onFile={(f) => attachFrame.mutate(f)}
            />
            {video ? (
              <button type="button" className={btnSmall + " h-9"} aria-label={`截取 V${result.versionNumber} 当前画面为真实尾帧`} onClick={captureFrame}>
                截取当前帧为尾帧
              </button>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button" className={btnSmall} aria-label={`V${result.versionNumber} 质检通过`}
              onClick={() => mut.mutate({ resultId: result.id, qcStatus: "pass", qcNote })}
            >
              ✓ 通过
            </button>
            <button
              type="button" className={btnSmall} aria-label={`V${result.versionNumber} 质检不通过需重拍`}
              onClick={() => mut.mutate({ resultId: result.id, qcStatus: "fail", qcNote })}
            >
              ✕ 不通过（判重拍）
            </button>
            <button
              type="button" className={btnSmall} aria-label={result.adopted ? `取消采用 V${result.versionNumber}` : `采用 V${result.versionNumber}`}
              style={result.adopted ? { background: "var(--accent)", color: "#fff", borderColor: "var(--accent)" } : undefined}
              disabled={!result.adopted && !canAdopt}
              onClick={() => mut.mutate({ resultId: result.id, adopted: !result.adopted })}
            >
              {result.adopted ? "已采用（点击取消）" : "采用此版"}
            </button>
            {!result.adopted && !canAdopt ? (
              <span className="w-full text-xs text-[var(--dim)]">
                采用条件：先有成片回填，再点「✓ 通过」，最后才能采用（服务端也会拦截）。
              </span>
            ) : null}
            <input
              aria-label={`V${result.versionNumber} 质检备注`}
              className="min-w-40 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
              placeholder="质检备注（抽帧检查结论）"
              value={qcNote}
              onChange={(e) => setQcNote(e.target.value)}
              onBlur={() => {
                if (qcNote !== result.qcNote) mut.mutate({ resultId: result.id, qcNote });
              }}
            />
            <button
              type="button" className={btnSmall} aria-label={`删除 V${result.versionNumber}`}
              onClick={() => del.mutate(result.id)}
            >
              删除
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              aria-label={`V${result.versionNumber} 失败原因`}
              className="min-w-40 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
              placeholder="生成失败时填写原因（如通道错误、违反硬规则）"
              value={failText}
              onChange={(e) => setFailText(e.target.value)}
            />
            <button
              type="button" className={btnSmall} aria-label={`标记 V${result.versionNumber} 生成失败`}
              disabled={!failText.trim()}
              onClick={() => fail.mutate(failText.trim())}
            >
              标记生成失败
            </button>
          </div>
          <p className="text-xs leading-relaxed text-[var(--dim)]">
            换掉/重做本版：质检不满意时，先写质检备注再点「✕ 不通过（判重拍）」，然后用上方出现的「新派单重拍」按钮重新派单——新版本、新任务单（带质检意见与变化要求）、新尝试，不会再生成和本版一样的一条。也可以用上方「替换成片」直接换文件（质检与采用会重置、需重新审核；与同镜其他版本完全相同的文件会被拒绝）。成片始终只落在本版本卡，不进资源库。
          </p>
          <Notice msg={notice} />
        </div>
      ) : null}
    </div>
  );
}
