import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import {
Notice, btnCls, btnPrimary, inputCls, type NavTarget, type Project,
} from "./shared";
import { LicensesButton } from "./licenses";

// 页签视图按需懒加载：初始包只含应用外壳与项目列表，让入口文档的
// 内联脚本体积与执行时间尽量小，DOMContentLoaded（平台帧握手与首屏
// 呈现都等它）不被全部视图代码拖住。点开某个页签时才加载该视图。
const ScriptTab = lazy(() => import("./views/script").then((m) => ({ default: m.ScriptTab })));
const CharactersTab = lazy(() => import("./views/characters").then((m) => ({ default: m.CharactersTab })));
const ScenesTab = lazy(() => import("./views/scenes").then((m) => ({ default: m.ScenesTab })));
const ShotsTab = lazy(() => import("./views/shots").then((m) => ({ default: m.ShotsTab })));
const CanvasTab = lazy(() => import("./views/canvas").then((m) => ({ default: m.CanvasTab })));
const QcTab = lazy(() => import("./views/qc").then((m) => ({ default: m.QcTab })));

// 拼接不再是独立页签：拼接清单、连播预览与最终成品导出都在画布工具内
// （画布上的「最终成品」节点 + 画布下方导出站）完成。
const TABS = [
  ["canvas", "画布工具"],
  ["script", "脚本 · 拆镜校对"],
  ["characters", "人物档案"],
  ["scenes", "场景卡"],
  ["shots", "分镜 · 准备检查"],
  ["qc", "质检"],
] as const;
type Tab = (typeof TABS)[number][0];

export function App() {
  const [projectId, setProjectId] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("canvas");
  const [navTarget, setNavTarget] = useState<NavTarget | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const importTried = useRef(false);
  const qc = useQueryClient();

  /** 缺项导航：切到目标页签并把定位信息交给目标页（滚动＋高亮）。 */
  const goTo = (t: Omit<NavTarget, "nonce">) => {
    setNavTarget({ ...t, nonce: Date.now() });
    setTab(t.tab as Tab);
  };

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects({}),
  });

  const doImport = useMutation({
    mutationFn: () => api.importPackage({}),
    onSuccess: (result) => {
      setImportNotice(!result.imported && result.projectCount === 0 ? "尚未配置可导入的数据包。可以先在下方新建项目。" : null);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["project"] });
    },
  });

  useEffect(() => {
    if (projects.data && projects.data.projects.length === 0 && !importTried.current) {
      importTried.current = true;
      doImport.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.data]);

  const full = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.getProject({ id: projectId ?? 0 }),
    enabled: projectId != null,
  });

  if (projectId == null) {
    return (
      <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
        <main className="mx-auto max-w-3xl px-4 pb-10 pt-6">
          <header className="mb-4 flex items-end justify-between gap-3">
            <div>
              <h1 className="font-display text-3xl font-black tracking-wide">导演台</h1>
              <p className="mt-1 text-sm text-[var(--dim)]">写脚本 · 建档锁脸 · 排分镜 · 链式生成 · 质检拼接</p>
            </div>
            <span className="flex items-center gap-2"><span className="hidden text-xs text-[var(--dim)] sm:block">项目 {projects.data?.projects.length ?? 0} 个</span><LicensesButton /></span>
          </header>
          {projects.data?.channels ? (
            <section aria-label="生成通道状态" className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3.5">
              <h2 className="font-display text-base font-bold">生成通道状态</h2>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed">
                {([
                  ["图像", projects.data.channels.image],
                  ["视频", projects.data.channels.video],
                  ["模型推理", projects.data.channels.inference],
                  ["媒体处理（FFmpeg）", projects.data.channels.media],
                ] as const).map(([name, ch]) => (
                  <li key={name} className="flex flex-wrap gap-x-2">
                    <span className="font-semibold">{name}：{ch.label}</span>
                    <span className="text-[var(--dim)]">{ch.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {projects.isPending || doImport.isPending ? (
            <p className="py-10 text-center text-sm text-[var(--dim)]">正在载入项目…</p>
          ) : projects.isError ? (
            <Notice msg={`项目载入失败：${projects.error instanceof Error ? projects.error.message : String(projects.error)}`} />
          ) : (
            <>
              <div className="space-y-2.5">
                {(projects.data?.projects ?? []).map((p) => (
                  <ProjectCard key={p.id} p={p} onOpen={() => { setProjectId(p.id); setTab("canvas"); }} />
                ))}
              </div>
              {(projects.data?.projects.length ?? 0) === 0 ? (
                <div className="mt-4 rounded-lg border border-dashed border-[var(--border)] p-4 text-center">
                  <p className="text-sm text-[var(--dim)]">还没有项目。可以导入已配置的导演台数据包，或在下方新建。</p>
                  <button type="button" className={btnPrimary + " mt-2"} aria-label="从数据包导入项目" onClick={() => doImport.mutate()}>
                    从已配置的数据包导入
                  </button>
                  <Notice msg={importNotice} />
                </div>
              ) : null}
              <NewProject onCreated={(id) => { setProjectId(id); setTab("script"); }} />
            </>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg)]/95 pt-safe backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-3 py-2">
          <button type="button" className={btnCls + " px-2 py-1 text-xs"} aria-label="返回项目列表" onClick={() => setProjectId(null)}>
            ← 项目
          </button>
          <span className="font-display truncate text-lg font-black">
            {full.data?.project?.name ?? "…"}
          </span>
          {full.data?.project?.locked ? (
            <span className="stamp shrink-0">已锁版</span>
          ) : (
            <span className="shrink-0 text-xs text-[var(--dim)]">未锁版（可选定稿）</span>
          )}
          <span className="ml-auto hidden shrink-0 text-xs text-[var(--dim)] sm:block">
            {full.data?.project ? `${full.data.project.shotCount} 镜 · ${full.data.project.totalShotSeconds}s · 已采用 ${full.data.project.adoptedCount}` : ""}
          </span>
          <LicensesButton />
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 pb-2" aria-label="工作台分区">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-label={`打开${label}页`}
              aria-pressed={tab === key}
              className="shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium"
              style={
                tab === key
                  ? { background: "#e8762d", color: "#fff", border: "1px solid #e8762d" }
                  : { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }
              }
              onClick={() => setTab(key)}
            >
              {label}
              {key === "characters" && full.data ? ` ${full.data.characters.length}` : ""}
              {key === "scenes" && full.data ? ` ${full.data.scenes.length}` : ""}
              {key === "shots" && full.data ? ` ${full.data.shots.length}` : ""}
            </button>
          ))}
        </nav>
      </div>
      <main className="mx-auto max-w-5xl px-3 pb-12 pt-3">
        {full.isPending ? (
          <p className="py-10 text-center text-sm text-[var(--dim)]">正在载入项目…</p>
        ) : full.isError ? (
          <Notice msg={`项目载入失败：${full.error instanceof Error ? full.error.message : String(full.error)}`} />
        ) : full.data && full.data.project ? (
          <Suspense
            fallback={
              <p className="py-10 text-center text-sm text-[var(--dim)]" role="status">
                正在载入该页签…
              </p>
            }
          >
            {tab === "script" ? <ScriptTab key={`s${full.data.project.version}-${full.data.project.locked}`} data={full.data} /> : null}
            {tab === "characters" ? <CharactersTab data={full.data} navTarget={navTarget} /> : null}
            {tab === "scenes" ? <ScenesTab data={full.data} navTarget={navTarget} /> : null}
            {tab === "shots" ? <ShotsTab data={full.data} navTarget={navTarget} onGo={goTo} /> : null}
            {tab === "canvas" ? <CanvasTab data={full.data} onNavigate={(t) => setTab(t)} /> : null}
            {tab === "qc" ? <QcTab data={full.data} navTarget={navTarget} /> : null}
          </Suspense>
        ) : (
          <Notice msg="项目不存在或已被删除。" />
        )}
      </main>
    </div>
  );
}

function ProjectCard({ p, onOpen }: { p: Project; onOpen: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteProject({ id: p.id }),
    onSuccess: (res) => {
      if (!res.ok) setNotice(res.error);
      else void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3.5">
      <div className="flex items-start gap-3">
        <button type="button" aria-label={`打开项目：${p.name}`} className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-display text-xl font-black">{p.name}</span>
            {p.locked ? <span className="stamp">已锁版</span> : <span className="text-xs text-[var(--amber)]">未锁版（可选定稿）</span>}
            {p.assemblyConfirmed ? <span className="text-xs font-medium" style={{ color: "#3d7a3a" }}>拼接已确认</span> : null}
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-[var(--dim)]">
            {p.scriptTitle || p.scriptText.slice(0, 80) || "尚无脚本"}
          </p>
          <p className="mt-1.5 text-xs text-[var(--dim)]">
            {p.shotCount} 镜 · 分镜共 {p.totalShotSeconds}s / 目标 {p.targetSeconds}s · 人物 {p.characterCount} · 场景 {p.sceneCount} · 已采用 {p.adoptedCount} · 默认 {p.defaultQuality}
          </p>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            更新于 {new Date(p.updatedAt).toLocaleString("zh-CN", { hour12: false })}
          </p>
        </button>
        {confirming ? (
          <span className="flex shrink-0 flex-col gap-1">
            <button type="button" className="rounded bg-[var(--accent)] px-2 py-1 text-xs font-semibold text-white" aria-label={`确认删除项目：${p.name}`} onClick={() => del.mutate()}>
              确认删除
            </button>
            <button type="button" className={btnCls + " px-2 py-1 text-xs"} aria-label="取消删除" onClick={() => setConfirming(false)}>
              取消
            </button>
          </span>
        ) : (
          <button type="button" className={btnCls + " shrink-0 px-2 py-1 text-xs"} aria-label={`删除项目：${p.name}`} onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>
      <Notice msg={notice} />
    </div>
  );
}

function NewProject({ onCreated }: { onCreated: (id: number) => void }) {
  const [name, setName] = useState("");
  const [seconds, setSeconds] = useState("30");
  const [quality, setQuality] = useState("720P");
  const [notice, setNotice] = useState<string | null>(null);
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      api.createProject({
        name: name.trim(),
        targetSeconds: Number(seconds) || 30,
        defaultQuality: quality as "480P" | "720P" | "1080P",
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onCreated(res.id);
    },
    onError: (e) => setNotice(e instanceof Error ? e.message : String(e)),
  });
  return (
    <section className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3.5">
      <h2 className="font-display mb-2 text-base font-bold">新建项目</h2>
      <div className="flex flex-wrap gap-2">
        <input aria-label="新项目名称" className={inputCls + " min-w-44 flex-1"} placeholder="项目名称" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="新项目目标时长秒" type="number" min={1} className={inputCls + " w-24"} value={seconds} onChange={(e) => setSeconds(e.target.value)} />
        <select aria-label="新项目默认画质" className={inputCls + " w-28"} value={quality} onChange={(e) => setQuality(e.target.value)}>
          <option value="480P">480P</option>
          <option value="720P">720P</option>
          <option value="1080P">1080P</option>
        </select>
        <button type="button" className={btnPrimary} aria-label="创建新项目" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
          新建
        </button>
      </div>
      <Notice msg={notice} />
    </section>
  );
}
