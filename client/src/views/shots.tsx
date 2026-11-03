import { useEffect, useState } from "react";
import {
DropImage, Field, GenerateVideo, Notice, ResultCard, btnCls, btnPrimary,
btnSmall, fileToB64, flashById, inputCls, mediaSrc, useDeskMutation,
type NavTarget, type ProjectFull, type Shot,
} from "../shared";
import { api } from "../api";

const PREP_LEVEL: Record<Shot["prep"]["level"], { label: string; color: string }> = {
  ok: { label: "可继续", color: "#3d7a3a" },
  blocked: { label: "存在阻塞", color: "var(--accent)" },
  warn: { label: "有提示", color: "var(--amber)" },
};

export function ShotsTab({
  data, navTarget, onGo,
}: {
  data: ProjectFull;
  navTarget: NavTarget | null;
  onGo: (t: Omit<NavTarget, "nonce">) => void;
}) {
  const project = data.project;
  const [notice, setNotice] = useState<string | null>(null);
  const create = useDeskMutation(
    () => api.createShot({ projectId: project?.id ?? 0 }),
    setNotice,
  );

  // 缺项导航落点：跳到指定镜头卡或具体字段并高亮。
  useEffect(() => {
    if (!navTarget?.shotId) return;
    const id = navTarget.field
      ? `shot-field-${navTarget.shotId}-${navTarget.field}`
      : `shot-card-${navTarget.shotId}`;
    const t = window.setTimeout(() => flashById(id), 120);
    return () => window.clearTimeout(t);
  }, [navTarget]);

  if (!project) return null;
  return (
    <div className="space-y-3">
      <Notice msg={notice} />
      <ChainPanel data={data} onNotice={setNotice} />
      <PrepPanel data={data} onGo={onGo} />
      {data.shots.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border)] p-4 text-center">
          <p className="text-sm text-[var(--dim)]">还没有分镜。可以去脚本页把脚本标为「可进入分镜」自动拆分，或手动添加第一镜。</p>
        </div>
      ) : null}
      <div className="relative space-y-3">
        {data.shots.map((shot, i) => (
          <div key={shot.id} className="relative">
            {i === 0 ? (
              <div
                className="mx-auto -mt-1 mb-2 flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-full px-2.5 py-1 text-[11px]"
                style={{ background: "var(--ink)", color: "var(--ink-text)" }}
              >
                🎬 第一镜 · 无上一镜尾帧
                {shot.chain?.mode === "uploaded" ? " · 方式 A：上传图为开场锚点 ✓" : " · 方式 B：脚本＋人物档案＋场景卡严格生成"}
              </div>
            ) : null}
            {i > 0 ? (
              <div
                className="mx-auto -mt-1 mb-2 flex w-fit max-w-full flex-wrap items-center justify-center gap-1 rounded-full px-2.5 py-1 text-[11px]"
                style={shot.chain?.status.startsWith("blocked")
                  ? { background: "var(--accent)", color: "#fff" }
                  : shot.chain?.status === "auto_filled" || shot.chain?.status === "ready_chained"
                    ? { background: "#3d7a3a", color: "#fff" }
                    : { background: "var(--ink)", color: "var(--ink-text)" }}
              >
                ⛓ 严格链：本镜首帧 ← 第 {i} 镜真实尾帧
                {shot.chain?.status === "auto_filled" ? " · 已自动填入 ✓ 严格以图生成"
                  : shot.chain?.status === "ready_chained" ? " · 真实尾帧就绪 ✓"
                  : shot.chain?.status === "scene_break" ? " · 换场景重置 · 独立定位首帧"
                  : shot.chain?.status.startsWith("blocked") ? " · 阻塞：缺真实尾帧图，不得按标签生成"
                  : shot.resolvedFirstFrame.source === "own" ? " · 本镜自有首帧"
                  : " · 等上一镜真实尾帧"}
              </div>
            ) : null}
            <ShotCard data={data} shot={shot} onNotice={setNotice} onGo={onGo} />
          </div>
        ))}
      </div>
      {!project.locked ? (
        <button type="button" className={btnPrimary + " w-full"} aria-label="添加镜头" disabled={create.isPending} onClick={() => create.mutate(undefined)}>
          ＋ 添加镜头
        </button>
      ) : (
        <p className="text-center text-xs text-[var(--amber)]">项目已锁版，分镜已冻结（画质仍可在每镜卡上调整）。</p>
      )}
    </div>
  );
}

/** 长片严格链总览：一段生成完→真实尾帧自动填入下一段→下一段严格以该图为首帧。
 *  缺真实尾帧图就阻塞，不认标签/规划图。顶部可一键生成下一段、可开关严格链。 */
function ChainPanel({ data, onNotice }: { data: ProjectFull; onNotice: (m: string | null) => void }) {
  const project = data.project;
  const [msg, setMsg] = useState<string | null>(null);
  const nextSeg = useDeskMutation(
    () => api.dispatchNextSegment({ projectId: project?.id ?? 0 }),
    (m) => { setMsg(m); onNotice(m); },
    (res) => { if (res.ok) setMsg(`已派单：下一段是第 ${(res.shotOrder ?? 0) + 1} 镜，派单快照已冻结（按派单时刻当前分镜，生成中改分镜不影响这一单）${res.jobStatus === "generating" ? "，助手生成中" : "，待助手执行"}。成片回填时必须带真实尾帧，它会自动填入再下一镜。`); },
  );
  const toggleStrict = useDeskMutation(
    (v: boolean) => api.updateProjectSettings({ id: project?.id ?? 0, chainStrict: v }),
    setMsg,
  );
  if (!project || data.shots.length === 0) return null;
  const adoptedCount = data.shots.filter((s) => s.results.some((r) => r.adopted)).length;
  const nextShot = data.shots.find((s) => !s.results.some((r) => r.adopted));
  const nextBlocked = !!nextShot?.chain?.status.startsWith("blocked");
  return (
    <section className="rounded-lg border-2 bg-[var(--surface)] p-3" style={{ borderColor: "#3d7a3a" }} aria-label="长片严格链式生成">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-base font-bold">长片严格链 · 尾帧接首帧</h3>
        <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ background: project.chainStrict ? "#3d7a3a" : "var(--dim)", color: "#fff" }}>
          {project.chainStrict ? "严格模式开" : "严格模式关"}
        </span>
        <span className="text-xs text-[var(--dim)]">已采用 {adoptedCount} / {data.shots.length} 段</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs">
          <input type="checkbox" aria-label="开启严格链模式" checked={!!project.chainStrict} onChange={(e) => toggleStrict.mutate(e.target.checked)} />
          严格链（关掉后才允许只按标签生成，不推荐）
        </label>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
        规则是严格的，不是快速参照：生成完一段，它的<strong>真实尾帧图像</strong>会自动填入下一段的首帧；下一段生成时必须<strong>严格以这张尾帧图本身</strong>为第一帧——身份、姿势、站位、构图、光线、服装、断臂等硬规则都以图为准，不得只按标签或文字另行想象。上一段尾帧图缺失（未回填、只有记录、只有目标尾帧规划图）时，下一段会被明确阻塞并提示补图。换场景的镜头链条重置、独立定位首帧。为某镜上传自有首帧可解除它对上一镜的链式依赖。<strong>只有第一镜本来就没有尾帧可参考，不按缺尾帧阻塞</strong>：方式 A 上传首帧参考图、以该图为开场锚点；方式 B 不上传，严格按文字脚本＋人物档案角色参考图＋场景卡参考生成，人物/场景图会实际传入，不许纯文字想象。第一镜之外的镜头（含换场景）不走方式 B：连续镜头缺真实尾帧仍阻塞，换场景镜头独立定位首帧。<strong>但每一镜派单时都会同时带三类参照，互不替代</strong>：首尾帧链（首帧约束＋尾帧要求）、本镜所选全部人物的定版图＋身份锁文字、本镜所选全部场景的场景图——后续镜不是只带尾帧，尾帧只是参照清单的第 1 项（首帧），人物与场景参照每一镜都重新按本镜所选逐个读取并传入。
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="链路进度">
        {data.shots.map((s, i) => (
          <span key={s.id} className="flex items-center gap-1.5">
            {i > 0 ? <span className="text-xs" style={{ color: s.chain?.status.startsWith("blocked") ? "var(--accent)" : "#3d7a3a" }}>{s.chain?.sceneBreak ? "✂ 换场景" : s.chain?.status === "auto_filled" || s.chain?.status === "ready_chained" ? "—尾帧图→" : "—缺尾帧图✕→"}</span> : null}
            <span className="rounded-md border px-2 py-1 text-xs font-medium" style={{ borderColor: s.results.some((r) => r.adopted) ? "#3d7a3a" : s.chain?.status.startsWith("blocked") ? "var(--accent)" : "var(--border)", background: "var(--surface2)" }}>
              第 {i + 1} 段{s.results.some((r) => r.adopted) ? " · 已采用" : s.chain?.status === "auto_filled" ? " · 首帧已填入" : s.chain?.status.startsWith("blocked") ? " · 阻塞" : i === 0 ? (s.chain?.mode === "uploaded" ? " · 首镜方式 A" : " · 首镜方式 B") : ""}
            </span>
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary + " px-3 py-1.5 text-xs"} aria-label="生成下一段（自动取上段尾帧严格生成）" disabled={nextSeg.isPending || !nextShot} onClick={() => nextSeg.mutate(undefined)}>
          {nextSeg.isPending ? "派单中…" : nextShot ? `▶ 生成下一段：第 ${nextShot.sortOrder + 1} 镜（严格取上段尾帧）` : "全部段落已采用"}
        </button>
        {!project.locked ? <span className="text-xs text-[var(--amber)]">未锁版也能链式生成（锁版是可选定稿）：派单时自动冻结当前分镜快照，生成中改分镜不影响这一单，下一单才用新版。</span> : null}
        {nextShot && nextBlocked ? <span className="text-xs font-medium text-[var(--accent)]">下一段当前被严格链阻塞：{nextShot.chain.detail}</span> : null}
        {nextShot && !nextBlocked ? <span className="text-xs text-[var(--dim)]">下一段首帧状态：{nextShot.chain.detail}</span> : null}
      </div>
      {msg ? <p className="mt-1.5 rounded bg-[var(--surface2)] px-2 py-1.5 text-xs leading-relaxed">{msg}</p> : null}
    </section>
  );
}

/** 生成准备检查 / 待补内容：逐镜列出阻塞与提示，每条都能跳到要补的地方。
 *  检查是只读的（数据随项目一起从服务端算好），不改内容、不触发任何生成。 */
function PrepPanel({
  data, onGo,
}: {
  data: ProjectFull;
  onGo: (t: Omit<NavTarget, "nonce">) => void;
}) {
  const shots = data.shots;
  if (shots.length === 0) return null;
  const okCount = shots.filter((x) => x.prep.level === "ok").length;
  const blockedCount = shots.filter((x) => x.prep.level === "blocked").length;
  const warnCount = shots.filter((x) => x.prep.level === "warn").length;
  return (
    <section className="rounded-lg border-2 border-[var(--accent)] bg-[var(--surface)] p-3" aria-label="生成准备检查与待补内容">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-base font-bold">生成准备检查 / 待补内容</h3>
        <span className="text-xs text-[var(--dim)]">
          {okCount} 镜可继续 · {blockedCount} 镜存在阻塞 · {warnCount} 镜有提示
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
        按现有生成规则逐镜检查：动作缺失、首帧未定位、等上镜尾帧、指定参考实际无图、首尾帧来源冲突、身份冲突（脚本身份描述与人物档案不一致，如脚本写长发、档案是短发——本镜身份以档案为准，冲突词派单时剥离、不进入生成提示词，想改身份先更新档案并重新定版参考图）、已有任务进行中，都会写明是哪一镜、卡在哪、去哪补；未锁版只作可选定稿提示，不拦派单。
        注意：这里的「阻塞」只指生成派单——首尾帧是生成时的一致性承接，缺失只拦生成、不拦锁版；锁版是可选的定稿标记，不点不拦派单，派单时服务端自动冻结当前脚本、分镜、人物档案参考、场景卡参考与首尾帧链快照，生成中再改分镜不会影响已派单、下一单才用新版。
        参考集没凑满 28 项只是完整度显示，不是生成门槛，不列为待补。本检查只读，不改动项目、不触发生成；补齐后回到本页即可看到提示消除。
      </p>
      <div className="mt-2 space-y-2">
        {shots.map((shot) => {
          const lv = PREP_LEVEL[shot.prep.level];
          const n = shot.sortOrder + 1;
          return (
            <div key={shot.id} className="rounded-md border border-[var(--border)] bg-[var(--surface2)] px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ink)] font-display text-[11px] font-black text-[var(--ink-text)]">{n}</span>
                <span className="text-sm font-bold">第 {n} 镜</span>
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-semibold"
                  style={{ border: `1.5px solid ${lv.color}`, color: lv.color }}
                >
                  {lv.label}
                </span>
                {shot.prep.level === "ok" ? (
                  <span className="text-xs text-[var(--dim)]">本镜内容与引用已就绪，可派单生成{data.project?.locked ? "" : "（未锁版，派单自动冻结快照）"}。</span>
                ) : null}
              </div>
              {shot.prep.issues.length > 0 ? (
                <ul className="mt-1.5 space-y-1.5">
                  {shot.prep.issues.map((issue) => (
                    <li key={issue.code + issue.message} className="flex flex-wrap items-start gap-2">
                      <span
                        className="mt-0.5 shrink-0 rounded px-1.5 py-px text-[11px] font-semibold"
                        style={
                          issue.severity === "blocked"
                            ? { background: "var(--accent)", color: "#fff" }
                            : { background: "var(--amber-soft)", color: "var(--amber)", border: "1px solid var(--amber)" }
                        }
                      >
                        {issue.severity === "blocked" ? "阻塞" : "提示"}
                      </span>
                      <span className="min-w-0 flex-1 text-xs leading-relaxed">{issue.message}</span>
                      <button
                        type="button"
                        className={btnCls + " shrink-0 px-2 py-1 text-xs"}
                        aria-label={`${issue.actionLabel}（第 ${n} 镜）`}
                        onClick={() => onGo({ ...issue.target })}
                      >
                        {issue.actionLabel} →
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FrameBox({
  shot, which, onNotice,
}: {
  shot: Shot;
  which: "first" | "last";
  onNotice: (m: string | null) => void;
}) {
  const setFrame = useDeskMutation(
    async (f: File | null) =>
      api.setShotFrame({
        shotId: shot.id, which,
        dataBase64: f ? await fileToB64(f) : null,
        mimeType: f?.type || "image/jpeg",
      }),
    onNotice,
  );
  const n = shot.sortOrder + 1;
  if (which === "first") {
    const rf = shot.resolvedFirstFrame;
    if (shot.firstFrameKey) {
      const auto = !!shot.chain?.autoFilled;
      return (
        <div>
          {mediaSrc(shot.firstFrameKey) ? (
            <img src={mediaSrc(shot.firstFrameKey) ?? ""} alt={`第 ${n} 镜首帧${auto ? "（上一镜真实尾帧自动填入）" : "（自有）"}`} className="aspect-video w-full rounded border object-cover" style={{ borderColor: auto ? "#3d7a3a" : "var(--border)", borderWidth: auto ? 2 : 1 }} />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded border border-dashed border-[var(--border)] p-2 text-xs text-[var(--dim)]">首帧原文件未提供</div>
          )}
          <p className="mt-0.5 text-xs" style={{ color: auto ? "#3d7a3a" : "var(--dim)", fontWeight: auto ? 600 : 400 }}>
            {auto ? `✓ 自动填入 · ${shot.firstFrameLabel}——生成时严格以此图为首帧` : shot.chain?.isFirst ? `方式 A · 上传首帧锚点${shot.firstFrameLabel ? ` · ${shot.firstFrameLabel}` : ""}——第一镜无上一镜尾帧，生成时严格以此图为开场首帧` : `自有首帧${shot.firstFrameLabel ? ` · ${shot.firstFrameLabel}` : ""}`}
          </p>
          <button type="button" className={btnSmall + " mt-1"} aria-label={`清除第 ${n} 镜自有首帧`} onClick={() => setFrame.mutate(null)}>{auto ? "清除自动填入（恢复等待上一镜尾帧）" : "清除自有图（恢复自动带入）"}</button>
        </div>
      );
    }
    if (shot.firstFrameMissing) {
      return (
        <div>
          <div className="flex aspect-video w-full items-center justify-center rounded border border-[var(--border)] px-2 text-center text-xs text-[var(--dim)]">
            自有首帧（原台内图未随数据包提供）{shot.firstFrameLabel ? ` · ${shot.firstFrameLabel}` : ""}
          </div>
          <DropImage label="重新上传首帧" className="mt-1 h-7 w-full cursor-pointer rounded border border-[var(--border)] bg-[var(--surface2)]" onFile={(f) => setFrame.mutate(f)} />
        </div>
      );
    }
    if (rf.source) {
      const img = mediaSrc(rf.key);
      return (
        <div className="frame-dashed rounded p-1.5">
          {img ? (
            <img src={img} alt={`第 ${n} 镜自动带入首帧`} className="aspect-video w-full rounded object-cover" />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center rounded px-2 text-center text-xs text-[var(--dim)]">
              自动带入的尾帧图未随包提供，按来源定位
            </div>
          )}
          <p className="mt-1 text-xs font-medium" style={{ color: "var(--amber)" }}>
            自动带入 · 来源：第 {(rf.fromShotOrder ?? 0) + 1} 镜
            {rf.source === "adopted" ? "已采用结果真实尾帧" : rf.source === "latest" ? "最新回填结果真实尾帧" : "目标尾帧"}
          </p>
          <DropImage label="拖入/点选自有首帧覆盖带入" className="mt-1 h-7 w-full cursor-pointer rounded border border-[var(--border)] bg-[var(--surface)]" onFile={(f) => setFrame.mutate(f)} />
        </div>
      );
    }
    const noTail = !!shot.chain?.isFirst;
    return (
      <div>
        <DropImage
          label={noTail ? "方式 A：拖入/点选上传首帧参考图（不上传则走方式 B）" : "无可带入尾帧：拖入/点选上传首帧"}
          className="flex aspect-video w-full cursor-pointer rounded border border-dashed border-[var(--border)]"
          onFile={(f) => setFrame.mutate(f)}
        />
        {noTail ? (
          <p className="mt-1 rounded bg-[var(--surface2)] px-1.5 py-1 text-xs leading-relaxed text-[var(--text)]">
            本镜没有上一镜尾帧可参考，两种方式二选一：<strong>方式 A</strong> 上传一张首帧参考图，生成严格以该图为开场锚点；<strong>方式 B</strong> 不上传，派单时严格按文字脚本＋人物档案角色参考图＋场景卡参考生成（本镜可读：人物真实参考图 {shot.chain?.charRefCount ?? 0} 张、场景图{shot.chain?.sceneHasImage ? "有" : "无，只有场景卡文字"}），不等尾帧、不纯文字想象。
          </p>
        ) : null}
        {shot.firstFrameLabel ? <p className="mt-0.5 text-xs text-[var(--dim)]">标签：{shot.firstFrameLabel}</p> : null}
      </div>
    );
  }
  // last frame （目标尾帧）
  return (
    <div>
      {shot.lastFrameKey ? (
        <>
          {mediaSrc(shot.lastFrameKey) ? (
            <img src={mediaSrc(shot.lastFrameKey) ?? ""} alt={`第 ${n} 镜目标尾帧`} className="aspect-video w-full rounded border border-[var(--border)] object-cover" />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded border border-dashed border-[var(--border)] p-2 text-xs text-[var(--dim)]">目标尾帧原文件未提供</div>
          )}
          <p className="mt-0.5 text-xs text-[var(--dim)]">目标尾帧{shot.lastFrameLabel ? ` · ${shot.lastFrameLabel}` : ""}</p>
          <button type="button" className={btnSmall + " mt-1"} aria-label={`清除第 ${n} 镜目标尾帧`} onClick={() => setFrame.mutate(null)}>清除</button>
        </>
      ) : shot.lastFrameMissing ? (
        <>
          <div className="flex aspect-video w-full items-center justify-center rounded border border-[var(--border)] px-2 text-center text-xs text-[var(--dim)]">
            目标尾帧（原台内图未随数据包提供）{shot.lastFrameLabel ? ` · ${shot.lastFrameLabel}` : ""}
          </div>
          <DropImage label="重新上传目标尾帧" className="mt-1 h-7 w-full cursor-pointer rounded border border-[var(--border)] bg-[var(--surface2)]" onFile={(f) => setFrame.mutate(f)} />
        </>
      ) : (
        <>
          <DropImage label="拖入/点选上传目标尾帧" className="flex aspect-video w-full cursor-pointer rounded border border-dashed border-[var(--border)]" onFile={(f) => setFrame.mutate(f)} />
          {shot.lastFrameLabel ? <p className="mt-0.5 text-xs text-[var(--dim)]">标签：{shot.lastFrameLabel}</p> : null}
        </>
      )}
    </div>
  );
}

/** 多选控件（人物/场景共用）：已选名单以标签呈现、可逐个移除；下方勾选
 *  列表一键增减。与页面现有表单风格一致，保存后重开名单不丢。 */
function MultiPick({
  label, ariaBase, options, selected, disabled, onChange, emptyText,
}: {
  label: string;
  ariaBase: string;
  options: Array<{ id: number; name: string }>;
  selected: number[];
  disabled: boolean;
  onChange: (ids: number[]) => void;
  emptyText: string;
}) {
  const toggle = (id: number, on: boolean) =>
    onChange(on ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <div>
      <span className="mb-1 block text-xs font-medium tracking-wide text-[var(--dim)]">{label}</span>
      {selected.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selected.map((id) => {
            const o = options.find((x) => x.id === id);
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface2)] px-2 py-0.5 text-xs font-medium">
                {o?.name ?? `#${id}`}
                {!disabled ? (
                  <button type="button" className="px-0.5 font-bold" aria-label={`移除${ariaBase}：${o?.name ?? id}`} onClick={() => toggle(id, false)}>×</button>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : (
        <p className="mb-1.5 text-xs text-[var(--amber)]">{emptyText}</p>
      )}
      {options.length > 0 ? (
        <div className="max-h-36 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1">
          {options.map((o) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                aria-label={`${ariaBase}：${o.name}`}
                checked={selected.includes(o.id)}
                disabled={disabled}
                onChange={(e) => toggle(o.id, e.target.checked)}
              />
              <span>{o.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--dim)]">暂无可选项，先去对应页面新建。</p>
      )}
    </div>
  );
}

function ShotCard({
  data, shot, onNotice, onGo,
}: {
  data: ProjectFull;
  shot: Shot;
  onNotice: (m: string | null) => void;
  onGo: (t: Omit<NavTarget, "nonce">) => void;
}) {
  const project = data.project;
  const locked = project?.locked ?? false;
  const n = shot.sortOrder + 1;
  const initCharIds = shot.characterIds?.length ? [...shot.characterIds] : shot.characterId ? [shot.characterId] : [];
  const initSceneIds = shot.sceneIds?.length ? [...shot.sceneIds] : shot.sceneId ? [shot.sceneId] : [];
  const [draft, setDraft] = useState({
    durationSec: String(shot.durationSec),
    framing: shot.framing, cameraMove: shot.cameraMove,
    characterIds: initCharIds,
    sceneIds: initSceneIds,
    characterPosition: shot.characterPosition,
    startState: shot.startState, action: shot.action, endState: shot.endState,
    handoffNote: shot.handoffNote, firstFrameLabel: shot.firstFrameLabel,
    lastFrameLabel: shot.lastFrameLabel,
  });
  // 服务端名单变化（保存回读、拆镜写入、旧单值数据迁移呈现）时同步多选，
  // 只依赖名单本身，不覆盖用户正在编辑的其他字段。
  const charKey = (shot.characterIds ?? []).join(",");
  const sceneKey = (shot.sceneIds ?? []).join(",");
  useEffect(() => {
    setDraft((d) => ({ ...d, characterIds: shot.characterIds?.length ? [...shot.characterIds] : shot.characterId ? [shot.characterId] : [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [charKey]);
  useEffect(() => {
    setDraft((d) => ({ ...d, sceneIds: shot.sceneIds?.length ? [...shot.sceneIds] : shot.sceneId ? [shot.sceneId] : [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneKey]);
  const save = useDeskMutation(
    () =>
      api.updateShot({
        id: shot.id,
        durationSec: Number(draft.durationSec) || shot.durationSec,
        framing: draft.framing, cameraMove: draft.cameraMove,
        characterIds: draft.characterIds,
        sceneIds: draft.sceneIds,
        characterId: draft.characterIds[0] ?? null,
        sceneId: draft.sceneIds[0] ?? null,
        characterPosition: draft.characterPosition,
        startState: draft.startState, action: draft.action, endState: draft.endState,
        handoffNote: draft.handoffNote, firstFrameLabel: draft.firstFrameLabel,
        lastFrameLabel: draft.lastFrameLabel,
      }),
    onNotice,
  );
  const del = useDeskMutation(() => api.deleteShot({ id: shot.id }), onNotice);
  const move = useDeskMutation(
    (direction: "up" | "down") => api.moveShot({ id: shot.id, direction }),
    onNotice,
  );
  if (!project) return null;

  return (
    <article id={`shot-card-${shot.id}`} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3" aria-label={`第 ${n} 镜`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ink)] font-display text-sm font-black text-[var(--ink-text)]">{n}</span>
        <span className="text-sm font-medium">{shot.durationSec}s</span>
        <span className="text-xs text-[var(--dim)]">{shot.framing || "景别未填"} · {shot.cameraMove || "运镜未填"}</span>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-semibold"
          style={{ border: `1.5px solid ${PREP_LEVEL[shot.prep.level].color}`, color: PREP_LEVEL[shot.prep.level].color }}
        >
          准备：{PREP_LEVEL[shot.prep.level].label}
        </span>
        {shot.results.some((r) => r.adopted) ? <span className="stamp">有采用版</span> : null}
        {!locked ? (
          <span className="ml-auto flex gap-1">
            <button type="button" className={btnSmall} aria-label={`第 ${n} 镜上移`} onClick={() => move.mutate("up")}>↑</button>
            <button type="button" className={btnSmall} aria-label={`第 ${n} 镜下移`} onClick={() => move.mutate("down")}>↓</button>
            <button type="button" className={btnSmall} aria-label={`删除第 ${n} 镜`} onClick={() => del.mutate(undefined)}>删除</button>
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
        出场人物（{draft.characterIds.length}）：{draft.characterIds.length ? draft.characterIds.map((id) => data.characters.find((c) => c.id === id)?.name ?? `#${id}`).join("、") : "未指定"}
        {" · "}场景（{draft.sceneIds.length}）：{draft.sceneIds.length ? draft.sceneIds.map((id) => data.scenes.find((x) => x.id === id)?.name ?? `#${id}`).join("、") : "未指定"}
      </p>

      {/* 身份区与提示词区分开显示：档案决定身份，分镜提示词只决定动作 */}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-md border-2 px-2 py-1.5" style={{ borderColor: "#3d7a3a", background: "var(--surface2)" }} aria-label={`第 ${n} 镜人物档案身份区`}>
          <p className="text-xs font-bold">人物档案身份区 · 身份唯一来源（决定脸 / 发型 / 发色 / 服装 / 体型）</p>
          {(() => {
            const ids = new Set<number>();
            if (shot.characterId) ids.add(shot.characterId);
            for (const cid of shot.characterIds ?? []) ids.add(cid);
            for (const r of shot.references) if (r.kind === "character") ids.add(r.refId);
            const chars = data.characters.filter((c) => ids.has(c.id));
            if (chars.length === 0) return <p className="mt-0.5 text-xs text-[var(--amber)]">本镜未指定出场人物：没有档案身份可依，请在下方先多选出场人物。</p>;
            return chars.map((c) => (
              <div key={c.id} className="mt-1 text-xs leading-relaxed">
                <p><strong>{c.name}</strong>{c.fields.lockHair ? ` · 发型（档案）：${c.fields.lockHair}` : ""}{c.fields.wardrobe ? ` · 服装（档案）：${c.fields.wardrobe}` : ""}</p>
                {c.fields.visualAnchor ? <p className="text-[var(--dim)]">视觉锚点：{c.fields.visualAnchor}</p> : null}
                <button
                  type="button" className={btnSmall + " mt-1"} aria-label={`去更新人物档案：${c.name}（改身份后重新生成参考图）`}
                  onClick={() => onGo({ tab: "characters", characterId: c.id, field: "master" })}
                >
                  更新档案为新身份（改身份＋重新生成参考图并定版）→
                </button>
              </div>
            ));
          })()}
          <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">想换发型/服装等身份特征，必须先在这里对应的档案里改好并重新定版参考图，再派单；不能靠右边分镜提示词临时改。</p>
        </div>
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface2)] px-2 py-1.5" aria-label={`第 ${n} 镜分镜提示词区说明`}>
          <p className="text-xs font-bold">分镜提示词区 · 只决定本镜动作 / 场景 / 运镜 / 光线 / 情绪（不决定身份）</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">下方「开始状态 / 一个动作 / 结束状态 / 人物与站位」就是本镜提示词：写动作与画面调度，不要在里面改人物身份。</p>
          {shot.identityConflicts && shot.identityConflicts.length > 0 ? (
            <div className="mt-1 rounded px-1.5 py-1" style={{ background: "var(--accent-soft)", border: "1px solid var(--accent)" }}>
              {shot.identityConflicts.map((cf) => (
                <p key={`${cf.characterId}-${cf.field}`} className="text-xs leading-relaxed">
                  本镜身份以档案为准，脚本里与档案冲突的身份描述已剥离：<strong>{cf.scriptValue}→档案{cf.archiveValue}</strong>（人物「{cf.characterName}」{cf.field}）。派单时生成指令身份段只有档案的「{cf.archiveValue}」。
                </p>
              ))}
            </div>
          ) : (
            <p className="mt-0.5 text-xs text-[var(--dim)]">本镜提示词与档案身份未检出冲突。</p>
          )}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div id={`shot-field-${shot.id}-firstframe`}>
          <p className="mb-1 text-xs font-medium text-[var(--dim)]">首帧</p>
          <FrameBox shot={shot} which="first" onNotice={onNotice} />
        </div>
        <div id={`shot-field-${shot.id}-lastframe`}>
          <p className="mb-1 text-xs font-medium text-[var(--dim)]">尾帧（目标）</p>
          <FrameBox shot={shot} which="last" onNotice={onNotice} />
        </div>
      </div>

      <div className="mt-2 rounded-md border border-[var(--border)] bg-[var(--surface2)] px-2 py-1.5">
        <p className="text-xs font-medium">本镜引用（出场设置＋画布连线，派单时写入任务单）</p>
        {shot.references.length === 0 ? (
          <p className="mt-0.5 text-xs text-[var(--amber)]">暂无引用：在下方选出场人物/场景，或在画布把人物、场景、参考图连到本镜。</p>
        ) : (
          <ul className="mt-0.5 flex flex-wrap gap-1.5">
            {shot.references.map((rf) => (
              <li key={`${rf.kind}-${rf.refId}-${rf.role}`} className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-xs">
                {rf.role === "firstframe" ? "首帧" : rf.role === "lastframe" ? "尾帧" : "参考"} · {rf.title}
                {rf.mediaMissing ? <span className="text-[var(--accent)]">（缺图）</span> : null}
              </li>
            ))}
          </ul>
        )}
        {shot.references.filter((rf) => rf.role === "firstframe").length > 1 ? (
          <p className="mt-1 text-xs text-[var(--accent)]">首帧冲突：有多个首帧来源，派单会警告；请在画布连线管理里只保留一个。</p>
        ) : null}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Field label="时长（秒）">
          <input aria-label={`第 ${n} 镜时长`} type="number" min={0.5} step={0.5} className={inputCls} value={draft.durationSec} disabled={locked} onChange={(e) => setDraft({ ...draft, durationSec: e.target.value })} />
        </Field>
        <Field label="景别">
          <input aria-label={`第 ${n} 镜景别`} className={inputCls} value={draft.framing} disabled={locked} onChange={(e) => setDraft({ ...draft, framing: e.target.value })} />
        </Field>
        <Field label="运镜">
          <input aria-label={`第 ${n} 镜运镜`} className={inputCls} value={draft.cameraMove} disabled={locked} onChange={(e) => setDraft({ ...draft, cameraMove: e.target.value })} />
        </Field>
        <div id={`shot-field-${shot.id}-character`} className="col-span-2">
          <MultiPick
            label="出场人物（可多选）"
            ariaBase={`第 ${n} 镜出场人物`}
            options={data.characters.map((c) => ({ id: c.id, name: c.name }))}
            selected={draft.characterIds}
            disabled={locked}
            emptyText="未指定出场人物（可勾选多个人物同处一镜）"
            onChange={(ids) => setDraft({ ...draft, characterIds: ids })}
          />
        </div>
        <div id={`shot-field-${shot.id}-scene`} className="col-span-2">
          <MultiPick
            label="场景（可多选）"
            ariaBase={`第 ${n} 镜场景`}
            options={data.scenes.map((x) => ({ id: x.id, name: x.name }))}
            selected={draft.sceneIds}
            disabled={locked}
            emptyText="未指定场景（可勾选多个场景）"
            onChange={(ids) => setDraft({ ...draft, sceneIds: ids })}
          />
        </div>
        <div className="col-span-2 sm:col-span-4">
          <Field label="人物与站位" hint="多个人物时可逐个写明站位，如：老兵在左侧、儿子在右侧；多场景时可注明各场景在本镜的切换顺序。">
            <input aria-label={`第 ${n} 镜人物与站位`} className={inputCls} value={draft.characterPosition} disabled={locked} onChange={(e) => setDraft({ ...draft, characterPosition: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2.5">
        <Field label="开始状态">
          <textarea aria-label={`第 ${n} 镜开始状态`} className={inputCls + " resize-y"} rows={2} value={draft.startState} disabled={locked} onChange={(e) => setDraft({ ...draft, startState: e.target.value })} />
        </Field>
        <div id={`shot-field-${shot.id}-action`}>
          <Field label="一个动作">
            <textarea aria-label={`第 ${n} 镜动作`} className={inputCls + " resize-y"} rows={3} value={draft.action} disabled={locked} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
          </Field>
        </div>
        <Field label="结束状态">
          <textarea aria-label={`第 ${n} 镜结束状态`} className={inputCls + " resize-y"} rows={2} value={draft.endState} disabled={locked} onChange={(e) => setDraft({ ...draft, endState: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          <Field label="交接备注">
            <input aria-label={`第 ${n} 镜交接备注`} className={inputCls} value={draft.handoffNote} disabled={locked} onChange={(e) => setDraft({ ...draft, handoffNote: e.target.value })} />
          </Field>
          <Field label="首帧标签">
            <input aria-label={`第 ${n} 镜首帧标签`} className={inputCls} value={draft.firstFrameLabel} disabled={locked} onChange={(e) => setDraft({ ...draft, firstFrameLabel: e.target.value })} />
          </Field>
          <Field label="尾帧标签">
            <input aria-label={`第 ${n} 镜尾帧标签`} className={inputCls} value={draft.lastFrameLabel} disabled={locked} onChange={(e) => setDraft({ ...draft, lastFrameLabel: e.target.value })} />
          </Field>
        </div>
      </div>
      {!locked ? (
        <button type="button" className={btnPrimary + " mt-2"} aria-label={`保存第 ${n} 镜`} disabled={save.isPending} onClick={() => save.mutate(undefined)}>
          保存本镜
        </button>
      ) : null}

      <div className="mt-3">
        <GenerateVideo project={project} shot={shot} />
      </div>

      {shot.results.length > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-[var(--dim)]">
            本镜结果版本（{shot.results.length}）· 抽帧质检与采用在「质检」页
          </summary>
          <div className="mt-2 space-y-2">
            {shot.results.map((r) => (
              <ResultCard key={r.id} result={r} shot={shot} />
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}
