import { useEffect, useState } from "react";
import {
GEN_LABEL, GenerateVideo, Notice, ResultCard, btnCls, btnPrimary,
flashById, inputCls, useDeskMutation, type NavTarget, type ProjectFull, type Result,
} from "../shared";
import { api } from "../api";

export function QcTab({ data, navTarget }: { data: ProjectFull; navTarget: NavTarget | null }) {
  const project = data.project;

  // 缺项导航落点：滚动到指定结果版本卡（或镜头区）并高亮。
  useEffect(() => {
    if (!navTarget) return;
    const t = window.setTimeout(() => {
      if (navTarget.resultId) flashById(`result-card-${navTarget.resultId}`);
      else if (navTarget.shotId) flashById(`qc-shot-${navTarget.shotId}`);
    }, 120);
    return () => window.clearTimeout(t);
  }, [navTarget]);

  if (!project) return null;
  const totalResults = data.shots.reduce((a, s) => a + s.results.length, 0);
  const resultById = new Map(data.shots.flatMap((x) => x.results).map((r) => [r.id, r]));
  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-[var(--dim)]">
        生成状态链如实推进：派单冻结任务单 → 待助手执行 → 生成中 → 回填待审核 → 质检通过 → 采用；「已派单」不等于已生成。
        成片回填后抽帧检查（可截取当前帧为真实尾帧）、通过/重拍、采用（未回填或未通过不能采用）。采用版的真实尾帧会供下一镜自动带入。
        质检不通过要重拍时：在该版写清质检备注、点「✕ 不通过（判重拍）」，再点版本卡上的「新派单重拍」——它会新建版本、把你的质检意见写进一张不同的新任务单并要求与上一版明显不同，不是重播旧片；回填与旧版完全相同的成片会被服务端拒绝。
        当前共 {totalResults} 个结果版本。
      </p>
      {data.shots.map((shot) => (
        <section key={shot.id} className="space-y-2" id={`qc-shot-${shot.id}`}>
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ink)] font-display text-xs font-black text-[var(--ink-text)]">
              {shot.sortOrder + 1}
            </span>
            <h3 className="text-sm font-bold">
              第 {shot.sortOrder + 1} 镜 · {shot.durationSec}s · {shot.framing || "景别未填"}
            </h3>
            <span className="text-xs text-[var(--dim)]">{shot.results.length} 个版本</span>
          </div>
          <GenerateVideo project={project} shot={shot} />
          {shot.results.length === 0 ? (
            <p className="text-xs text-[var(--dim)]">暂无生成结果。用上方「生成视频」派单，或等待生成通道回填。</p>
          ) : (
            shot.results.map((r) => <ResultCard key={r.id} result={r} shot={shot} editable />)
          )}
        </section>
      ))}
      {data.shots.length === 0 ? <p className="text-sm text-[var(--dim)]">项目还没有分镜。</p> : null}

      {/* 生成任务记录 */}
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="font-display mb-2 text-sm font-bold">生成任务记录</h3>
        {data.jobs.length === 0 ? (
          <p className="text-xs text-[var(--dim)]">尚无任务记录。</p>
        ) : (
          <ul className="space-y-1.5">
            {data.jobs.slice(0, 30).map((j) => {
              const rv = j.resultId ? resultById.get(j.resultId) : undefined;
              return (
              <li key={j.id} className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className="font-medium">
                  {j.kind === "refimage" ? "人物配图" : "视频生成"}
                  {j.shotId ? ` · 镜头 #${data.shots.find((x) => x.id === j.shotId)?.sortOrder != null ? (data.shots.find((x) => x.id === j.shotId)?.sortOrder ?? 0) + 1 : "?"}` : ""}
                  {rv ? ` · 结果 V${rv.versionNumber}` : ""}
                  {j.characterId ? ` · ${data.characters.find((x) => x.id === j.characterId)?.name ?? ""}` : ""}
                </span>
                <span className="text-[var(--dim)]">{j.staleUnknown ? "生成中超时 · 状态待核查（不等于已中断）" : GEN_LABEL[j.status] ?? j.status}{j.videoQuality ? ` · ${j.videoQuality}` : ""}{j.attemptId ? ` · 尝试 ${j.attemptId}` : ""}</span>
                <span className="text-[var(--dim)]">{new Date(j.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                {j.detail ? <span className="w-full text-[var(--dim)]">{j.detail}</span> : null}
                {j.error ? <span className="w-full text-[var(--accent)]">{j.error}</span> : null}
              </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export function AssemblyTab({ data }: { data: ProjectFull }) {
  const project = data.project;
  const [notice, setNotice] = useState<string | null>(null);
  const confirm = useDeskMutation(
    (c: boolean) => api.confirmAssembly({ projectId: project?.id ?? 0, confirm: c }),
    setNotice,
  );
  if (!project) return null;

  const rows = data.shots.map((shot) => {
    const adopted = shot.results.find((r) => r.adopted && r.includeInEdit) ?? null;
    return { shot, adopted };
  });
  const missing = rows.filter((r) => !r.adopted);
  const totalEdit = rows.reduce((a, r) => {
    if (!r.adopted) return a;
    const end = r.adopted.outPoint ?? r.shot.durationSec;
    return a + Math.max(0, end - r.adopted.inPoint);
  }, 0);

  return (
    <div className="space-y-3">
      <Notice msg={notice} />
      <section className="rounded-lg p-3" style={{ background: "var(--ink)", color: "var(--ink-text)" }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-base font-bold">拼接确认</span>
          {project.assemblyConfirmed ? <span className="stamp" style={{ borderColor: "#e05a3a", color: "#ff9a83" }}>已确认拼接</span> : <span className="text-sm opacity-80">未确认</span>}
          <span className="text-xs opacity-70">
            剪辑总时长 {totalEdit.toFixed(1)}s · 导出规格 {project.exportSpec} · {project.fps}fps
          </span>
          <span className="ml-auto flex gap-2">
            {!project.assemblyConfirmed ? (
              <button type="button" className={btnPrimary} aria-label="确认拼接清单" disabled={confirm.isPending} onClick={() => confirm.mutate(true)}>
                确认拼接
              </button>
            ) : (
              <button type="button" className={btnCls} aria-label="取消拼接确认" onClick={() => confirm.mutate(false)}>
                取消确认
              </button>
            )}
          </span>
        </div>
        <p className="mt-1 text-xs opacity-70">
          全部镜头都有采用并纳入剪辑的结果后才能确认；确认后按此清单拼接导出（{project.exportSpec}）。
        </p>
      </section>

      {missing.length > 0 ? (
        <Notice msg={`还有 ${missing.length} 镜没有采用结果：第 ${missing.map((m) => m.shot.sortOrder + 1).join("、")} 镜。先去质检页采用一版。`} tone="info" />
      ) : null}

      <div className="space-y-2">
        {rows.map(({ shot, adopted }, i) => (
          <div key={shot.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ink)] font-display text-xs font-black text-[var(--ink-text)]">{shot.sortOrder + 1}</span>
              <span className="text-sm font-bold">第 {shot.sortOrder + 1} 镜</span>
              {i > 0 ? <span className="text-xs text-[var(--dim)]">← 与上一镜{adopted?.cutType ?? "直切"}</span> : null}
              {adopted ? (
                <span className="text-xs text-[var(--dim)]">采用 V{adopted.versionNumber}（{adopted.label}）</span>
              ) : (
                <span className="text-xs text-[var(--amber)]">未采用任何版本</span>
              )}
            </div>
            {adopted ? <EditControls key={adopted.id} result={adopted} shotDuration={shot.durationSec} onNotice={setNotice} /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function EditControls({
  result, shotDuration, onNotice,
}: {
  result: Result;
  shotDuration: number;
  onNotice: (m: string | null) => void;
}) {
  const [inP, setInP] = useState(String(result.inPoint));
  const [outP, setOutP] = useState(result.outPoint != null ? String(result.outPoint) : "");
  const [cut, setCut] = useState(result.cutType);
  const [include, setInclude] = useState(result.includeInEdit);
  const save = useDeskMutation(
    () =>
      api.updateResult({
        resultId: result.id,
        inPoint: Number(inP) || 0,
        outPoint: outP.trim() ? Number(outP) : null,
        cutType: cut, includeInEdit: include,
      }),
    onNotice,
  );
  const eff = Math.max(0, (outP.trim() ? Number(outP) : shotDuration) - (Number(inP) || 0));
  return (
    <div className="mt-2 flex flex-wrap items-end gap-2">
      <label className="block w-24">
        <span className="mb-1 block text-xs text-[var(--dim)]">入点（秒）</span>
        <input aria-label={`V${result.versionNumber}入点`} type="number" min={0} step={0.1} className={inputCls} value={inP} onChange={(e) => setInP(e.target.value)} />
      </label>
      <label className="block w-24">
        <span className="mb-1 block text-xs text-[var(--dim)]">出点（秒，空=全长）</span>
        <input aria-label={`V${result.versionNumber}出点`} type="number" min={0} step={0.1} className={inputCls} value={outP} onChange={(e) => setOutP(e.target.value)} placeholder={String(shotDuration)} />
      </label>
      <label className="block w-28">
        <span className="mb-1 block text-xs text-[var(--dim)]">转场</span>
        <select aria-label={`V${result.versionNumber}转场`} className={inputCls} value={cut} onChange={(e) => setCut(e.target.value)}>
          <option value="直切">直切</option>
          <option value="叠化">叠化</option>
          <option value="淡入淡出">淡入淡出</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 pb-2 text-sm">
        <input
          type="checkbox" aria-label={`V${result.versionNumber}纳入剪辑`}
          checked={include}
          onChange={(e) => setInclude(e.target.checked)}
        />
        纳入剪辑
      </label>
      <span className="pb-2 text-xs text-[var(--dim)]">有效时长 {eff.toFixed(1)}s</span>
      <button type="button" className={btnPrimary + " px-3 py-1.5 text-xs"} aria-label={`保存 V${result.versionNumber} 剪辑点`} disabled={save.isPending} onClick={() => save.mutate(undefined)}>
        保存剪辑点
      </button>
    </div>
  );
}
