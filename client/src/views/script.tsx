import { useState } from "react";
import {
Field, Notice, btnCls, btnPrimary, inputCls, useDeskMutation,
type ProjectFull,
} from "../shared";
import { api, type ApiResponse } from "../api";

type SplitPreview = ApiResponse<typeof api, "previewSplit">;
type SplitRow = SplitPreview["shots"][number];

/** 拆镜校对多选（按名字）：一镜可关联多个人物/多个场景，勾选即改校对稿，
 *  确认应用后才写入分镜。与分镜页多选同一口径。 */
function MultiNamePick({
  label, ariaBase, options, selected, onChange,
}: {
  label: string;
  ariaBase: string;
  options: string[];
  selected: string[];
  onChange: (names: string[]) => void;
}) {
  const toggle = (name: string, on: boolean) =>
    onChange(on ? [...selected, name] : selected.filter((x) => x !== name));
  return (
    <div>
      <span className="mb-1 block text-xs font-medium tracking-wide text-[var(--dim)]">{label}</span>
      {selected.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {selected.map((name) => (
            <span key={name} className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-xs font-medium">
              {name}
              <button type="button" className="px-0.5 font-bold" aria-label={`移除${ariaBase}：${name}`} onClick={() => toggle(name, false)}>×</button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mb-1.5 text-xs text-[var(--amber)]">未指定（可多选）</p>
      )}
      {options.length > 0 ? (
        <div className="max-h-32 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1">
          {options.map((name) => (
            <label key={name} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
              <input
                type="checkbox"
                aria-label={`${ariaBase}：${name}`}
                checked={selected.includes(name)}
                onChange={(e) => toggle(name, e.target.checked)}
              />
              <span>{name}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-[var(--dim)]">暂无可选项。</p>
      )}
    </div>
  );
}

export function ScriptTab({ data }: { data: ProjectFull }) {
  const p = data.project;
  const [title, setTitle] = useState(p?.scriptTitle ?? "");
  const [text, setText] = useState(p?.scriptText ?? "");
  const [notes, setNotes] = useState(p?.scriptNotes ?? "");
  const [rules, setRules] = useState(p?.rules ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [unlockReason, setUnlockReason] = useState("");

  const save = useDeskMutation(
    (st: string) =>
      api.updateScript({
        id: p?.id ?? 0, scriptTitle: title, scriptText: text,
        scriptNotes: notes, rules, scriptStatus: st as "draft" | "ready",
      }),
    setNotice,
    (res) => {
      if (res.autoSplit > 0)
        setInfo(`脚本已保存并标为可进入分镜，自动拆出 ${res.autoSplit} 个镜头，去分镜页查看。`);
      else setInfo("脚本已保存。");
    },
  );
  const [preview, setPreview] = useState<SplitPreview | null>(null);
  const [rows, setRows] = useState<SplitRow[]>([]);
  const [confirmApply, setConfirmApply] = useState(false);
  const previewMut = useDeskMutation(
    () => api.previewSplit({ id: p?.id ?? 0, scriptText: text }),
    setNotice,
    (res) => {
      setPreview(res);
      setRows(res.shots.map((r) => ({ ...r })));
      setConfirmApply(false);
      if (res.ok) setInfo(`拆镜预览已生成：共 ${res.shots.length} 镜 · 总时长 ${res.totalSeconds}s。预览没有改动任何现有分镜，校对后点「确认应用」才写入。`);
    },
  );
  const applyMut = useDeskMutation(
    (force: boolean) =>
      api.splitScript({
        id: p?.id ?? 0, force,
        drafts: rows.map((r) => ({
          action: r.action, durationSec: Number(r.durationSec) || 1,
          framing: r.framing, cameraMove: r.cameraMove,
          characterName: r.characterNames?.[0] ?? r.characterName,
          sceneName: r.sceneNames?.[0] ?? r.sceneName,
          characterNames: r.characterNames ?? (r.characterName ? [r.characterName] : []),
          sceneNames: r.sceneNames ?? (r.sceneName ? [r.sceneName] : []),
          startState: r.startState, endState: r.endState,
        })),
      }),
    setNotice,
    (res) => {
      if (res.ok) {
        setInfo(`已按校对稿应用 ${res.created} 个镜头。去「分镜 · 准备检查」页看逐镜待补内容。`);
        setPreview(null);
        setRows([]);
        setConfirmApply(false);
      }
    },
  );
  const lock = useDeskMutation(() => api.lockProject({ id: p?.id ?? 0 }), setNotice);
  const unlock = useDeskMutation(
    (reason: string) => api.unlockProject({ id: p?.id ?? 0, reason }),
    setNotice,
  );
  const settings = useDeskMutation(
    (args: Parameters<typeof api.updateProjectSettings>[0]) => api.updateProjectSettings(args),
    setNotice,
  );
  if (!p) return null;
  const locked = p.locked;

  return (
    <div className="space-y-3">
      <Notice msg={notice} />
      {info ? <Notice msg={info} tone="info" /> : null}

      {/* 锁版（可选定稿）：不是派单前置，派单自动冻结快照 */}
      <section className="rounded-lg p-3" style={{ background: "var(--ink)", color: "var(--ink-text)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-base font-bold">{p.name}</span>
          {locked ? <span className="stamp" style={{ borderColor: "#e05a3a", color: "#ff9a83" }}>已锁版（定稿） v{p.version}</span> : <span className="text-sm opacity-80">未锁版（可选定稿，未点不拦派单） · v{p.version}</span>}
          <span className="text-xs opacity-70">
            {locked && p.lockedAt ? `锁定于 ${new Date(p.lockedAt).toLocaleString("zh-CN", { hour12: false })} · ` : ""}
            目标 {p.targetSeconds}s · {p.aspect} · {p.fps}fps · 默认画质 {p.defaultQuality}
          </span>
          <span className="ml-auto flex gap-2">
            {!locked ? (
              <button type="button" className={btnPrimary} aria-label="锁版（可选定稿标记，不点也能派单）" disabled={lock.isPending} onClick={() => lock.mutate(undefined)}>
                锁版（可选定稿）
              </button>
            ) : null}
          </span>
        </div>
        <p className="mt-1.5 rounded px-2 py-1.5 text-xs leading-relaxed" style={{ background: "rgba(255,255,255,0.08)" }}>
          本次派单将按当前分镜冻结：派单时服务端自动冻结当前脚本、分镜、人物档案参考、场景卡参考与首尾帧链的快照并生成任务单，生成中再改分镜不会影响这一单，下一单才用新版。
        </p>
        {locked ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              aria-label="解锁项目原因"
              className="min-w-52 flex-1 rounded border border-white/25 bg-transparent px-2 py-1.5 text-sm text-[var(--ink-text)] placeholder:text-white/40"
              placeholder="解锁原因（必填，自动升版并记入版本历史）"
              value={unlockReason}
              onChange={(e) => setUnlockReason(e.target.value)}
            />
            <button
              type="button" className={btnPrimary} aria-label="解锁项目"
              disabled={!unlockReason.trim() || unlock.isPending}
              onClick={() => unlock.mutate(unlockReason.trim())}
            >
              解锁项目
            </button>
            <p className="w-full text-xs opacity-70">已锁版是你主动点的可选定稿：脚本与分镜按原纪律冻结（画质与人物档案除外），派单照常按派单时刻快照冻结；已锁版的历史版本与状态保持不变，不会因为锁版改可选就自动解锁。</p>
          </div>
        ) : (
          <p className="mt-1 text-xs leading-relaxed opacity-70">锁版只是可选的「定稿」标记：想把当前脚本与分镜定下来就点一下，不点不拦——不点锁版也能直接派单。人物一致性和首尾帧对齐靠派单冻结的参考图和首尾帧链，不靠手动锁版。真要锁版时只看脚本与分镜是否定好（有分镜、每镜动作定好即可）；首尾帧是否定位不算锁版条件，缺失只会在派单生成时按生成规则提示/拦截。</p>
        )}
        {p.history.length ? (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs opacity-80">版本历史</summary>
            <pre className="mt-1 whitespace-pre-wrap text-xs opacity-80">{p.history.join("\n")}</pre>
          </details>
        ) : null}
      </section>

      {/* 项目设置 */}
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="font-display mb-2 text-sm font-bold">项目设置</h3>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <Field label="项目名称">
            <input aria-label="项目名称" className={inputCls} defaultValue={p.name} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== p.name) settings.mutate({ id: p.id, name: e.target.value.trim() }); }} />
          </Field>
          <Field label="目标时长（秒）">
            <input aria-label="目标时长秒" type="number" min={1} className={inputCls} defaultValue={p.targetSeconds} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== p.targetSeconds) settings.mutate({ id: p.id, targetSeconds: v }); }} />
          </Field>
          <Field label="默认视频画质（锁版后仍可改）">
            <select aria-label="项目默认视频画质" className={inputCls} value={p.defaultQuality} onChange={(e) => settings.mutate({ id: p.id, defaultQuality: e.target.value as "480P" | "720P" | "1080P" })}>
              <option value="480P">480P</option>
              <option value="720P">720P</option>
              <option value="1080P">1080P</option>
            </select>
          </Field>
          <Field label="画幅">
            <input aria-label="画幅" className={inputCls} defaultValue={p.aspect} onBlur={(e) => { if (e.target.value !== p.aspect) settings.mutate({ id: p.id, aspect: e.target.value }); }} />
          </Field>
          <Field label="帧率 fps">
            <input aria-label="帧率" type="number" min={1} className={inputCls} defaultValue={p.fps} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== p.fps) settings.mutate({ id: p.id, fps: v }); }} />
          </Field>
          <Field label="导出规格">
            <input aria-label="导出规格" className={inputCls} defaultValue={p.exportSpec} onBlur={(e) => { if (e.target.value !== p.exportSpec) settings.mutate({ id: p.id, exportSpec: e.target.value }); }} />
          </Field>
        </div>
      </section>

      {/* 脚本 */}
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="font-display text-sm font-bold">脚本</h3>
          <span className="text-xs text-[var(--dim)]">状态：{p.scriptStatus === "ready" ? "可进入分镜（ready）" : "草稿（draft）"}</span>
        </div>
        <div className="space-y-2.5">
          <Field label="脚本标题">
            <input aria-label="脚本标题" className={inputCls} value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="脚本正文（只写剧情与动作，人物身份以人物档案为准）" hint="贴上脚本即可自动拆镜：脚本里有几个时长标记就拆几个分镜——「（0–10s）」「（3秒）」「5s」「0:00–0:10」都算，几秒都行、不要求整十秒；也可以用空行分段或「第X段：」「第X镜：」段标记。写成一整段、标记在行中也照样拆。每镜时长按标记算，没有时长标记的段落按原段落规则保留、按剩余目标时长分配。标为 ready 保存后，若项目还没有分镜，将自动按此拆分镜。注意区分：脚本/分镜提示词只决定动作、场景、运镜、光线与情绪，不决定人物身份——身份只以人物档案（定版图＋身份锁）为准；脚本里与档案冲突的身份描述（如长发 vs 档案短发）派单时会被明示并剥离，不会进入生成提示词，想改身份请先更新人物档案并重新定版参考图。">
            <textarea aria-label="脚本正文" className={inputCls + " resize-y"} rows={12} value={text} disabled={locked} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Field label="项目规矩（全项目硬约束，单独成段，派单原文带入）">
            <textarea aria-label="项目规矩" className={inputCls + " resize-y"} rows={6} value={rules} disabled={locked} onChange={(e) => setRules(e.target.value)} />
          </Field>
          <Field label="备注">
            <textarea aria-label="脚本备注" className={inputCls + " resize-y"} rows={3} value={notes} disabled={locked} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        {!locked ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btnCls} aria-label="保存脚本草稿" disabled={save.isPending} onClick={() => save.mutate("draft")}>
              保存草稿
            </button>
            <button type="button" className={btnPrimary} aria-label="保存脚本并标为可进入分镜" disabled={save.isPending} onClick={() => save.mutate("ready")}>
              保存并标为「可进入分镜」
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-[var(--amber)]">项目已锁版（你主动点的可选定稿），脚本已冻结；如需修改请先解锁项目。未锁版的项目不走这一步也能派单，派单时自动冻结快照。</p>
        )}
      </section>

      {/* 拆镜预览 / 校对 */}
      <section className="rounded-lg border-2 border-[var(--accent)] bg-[var(--surface)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-display text-base font-bold">拆镜预览 / 校对（脚本 → 分镜，先看后拆）</h3>
          <span className="rounded-full bg-[var(--ink)] px-2 py-0.5 text-xs font-medium text-[var(--ink-text)]">
            当前分镜 {data.shots.length} 镜
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
          预览沿用自动拆分规则：有几个时长标记就拆几个分镜（时间段、单个时长、时间戳都算，任意秒数），段标记（第X段/第X镜）与空行分段同样有效，写成一整段也能拆；每镜时长按标记算、无标记段落按剩余目标时长分配，人物/场景只从已有档案名单里匹配。
          预览用的是上方编辑框里的当前文本（不必先保存），<strong>只预览、不写入</strong>：逐镜核对镜号、时长、原文、人物、场景、动作与首尾帧描述，可直接在预览里改，点「确认应用」后才按这份校对稿生成分镜。原始脚本不会被预览改动。
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button" className={btnPrimary} aria-label="生成拆镜预览"
            disabled={previewMut.isPending || !text.trim()}
            onClick={() => previewMut.mutate(undefined)}
          >
            {previewMut.isPending ? "正在生成预览…" : "生成拆镜预览（不改动现有分镜）"}
          </button>
          {preview ? (
            <button type="button" className={btnCls} aria-label="关闭拆镜预览" onClick={() => { setPreview(null); setRows([]); }}>
              关闭预览
            </button>
          ) : null}
        </div>

        {preview ? (
          <div className="mt-3 space-y-2.5">
            <p className="text-sm font-medium">
              预览结果：共 {rows.length} 镜 · 总时长 {rows.reduce((a, r) => a + (Number(r.durationSec) || 0), 0)}s（项目目标 {p.targetSeconds}s）· 现有分镜 {preview.existingShots} 镜保持不变
            </p>
            {preview.excluded.length > 0 ? (
              <div className="rounded bg-[var(--surface2)] px-2 py-1.5 text-xs leading-relaxed text-[var(--dim)]">
                以下段落按梗概 / 人物介绍 / 说明处理，<strong>不会</strong>变成镜头：
                <ul className="mt-0.5 list-inside list-disc">
                  {preview.excluded.map((x, i) => (
                    <li key={i} className="line-clamp-1">{x}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {rows.map((r, i) => (
              <article key={i} className="rounded-md border border-[var(--border)] bg-[var(--surface2)] p-2.5" aria-label={`拆镜预览第 ${i + 1} 镜`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ink)] font-display text-xs font-black text-[var(--ink-text)]">{i + 1}</span>
                  <span className="text-sm font-bold">第 {i + 1} 镜</span>
                  <label className="flex items-center gap-1 text-xs text-[var(--dim)]">
                    时长
                    <input
                      aria-label={`预览第 ${i + 1} 镜时长秒`}
                      type="number" min={0.5} step={0.5}
                      className="w-20 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
                      value={r.durationSec}
                      onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, durationSec: Number(e.target.value) } : x)))}
                    />
                    s
                  </label>
                  <span className="text-xs text-[var(--dim)]">{r.firstFrameDesc}</span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap rounded bg-[var(--surface)] px-2 py-1.5 text-xs leading-relaxed">
                  <span className="font-medium text-[var(--dim)]">原文片段（本镜唯一动作来源）：</span>{r.action}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="col-span-2 sm:col-span-1">
                  <MultiNamePick
                    label="出场人物（可多选）"
                    ariaBase={`预览第 ${i + 1} 镜出场人物`}
                    options={data.characters.map((c) => c.name)}
                    selected={r.characterNames ?? (r.characterName ? [r.characterName] : [])}
                    onChange={(names) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, characterNames: names, characterName: names[0] ?? "" } : x)))}
                  />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                  <MultiNamePick
                    label="场景（可多选）"
                    ariaBase={`预览第 ${i + 1} 镜场景`}
                    options={data.scenes.map((x) => x.name)}
                    selected={r.sceneNames ?? (r.sceneName ? [r.sceneName] : [])}
                    onChange={(names) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, sceneNames: names, sceneName: names[0] ?? "" } : x)))}
                  />
                  </div>
                  <Field label="景别">
                    <input
                      aria-label={`预览第 ${i + 1} 镜景别`}
                      className={inputCls}
                      value={r.framing}
                      onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, framing: e.target.value } : x)))}
                    />
                  </Field>
                  <Field label="运镜">
                    <input
                      aria-label={`预览第 ${i + 1} 镜运镜`}
                      className={inputCls}
                      value={r.cameraMove}
                      onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, cameraMove: e.target.value } : x)))}
                    />
                  </Field>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Field label="首帧描述（开始状态）">
                    <textarea
                      aria-label={`预览第 ${i + 1} 镜首帧描述`}
                      className={inputCls + " resize-y"} rows={2}
                      value={r.startState}
                      onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, startState: e.target.value } : x)))}
                    />
                  </Field>
                  <Field label="尾帧描述（结束状态）">
                    <textarea
                      aria-label={`预览第 ${i + 1} 镜尾帧描述`}
                      className={inputCls + " resize-y"} rows={2}
                      value={r.endState}
                      onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, endState: e.target.value } : x)))}
                    />
                  </Field>
                </div>
                <p className="mt-1 text-xs text-[var(--dim)]">{r.lastFrameDesc}</p>
              </article>
            ))}

            {preview.blockedReason ? (
              <p className="rounded bg-[var(--amber-soft)] px-2 py-1.5 text-xs leading-relaxed text-[var(--text)]">
                本次预览不能应用：{preview.blockedReason}（预览与检查都是只读的，不会解锁、不会重拆、不会触发任何生成。）
              </p>
            ) : preview.needsConfirm ? (
              <div className="flex flex-wrap items-center gap-2">
                {!confirmApply ? (
                  <button type="button" className={btnPrimary} aria-label="应用拆镜校对稿将替换现有分镜" onClick={() => setConfirmApply(true)}>
                    确认应用（将替换现有 {preview.existingShots} 镜）
                  </button>
                ) : (
                  <>
                    <span className="text-xs text-[var(--accent)]">应用会删除现有 {preview.existingShots} 镜（它们没有生成版本/任务，已通过服务端保护检查），按校对稿重新生成。</span>
                    <button type="button" className={btnPrimary} aria-label="确认替换现有分镜并应用校对稿" disabled={applyMut.isPending} onClick={() => applyMut.mutate(true)}>
                      {applyMut.isPending ? "应用中…" : "确认替换并应用"}
                    </button>
                    <button type="button" className={btnCls} aria-label="取消应用拆镜校对稿" onClick={() => setConfirmApply(false)}>
                      再想想
                    </button>
                  </>
                )}
              </div>
            ) : (
              <button type="button" className={btnPrimary} aria-label="确认应用拆镜校对稿" disabled={applyMut.isPending} onClick={() => applyMut.mutate(false)}>
                {applyMut.isPending ? "应用中…" : `确认应用拆分（写入 ${rows.length} 镜）`}
              </button>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
