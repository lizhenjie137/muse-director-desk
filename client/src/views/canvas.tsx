import { useEffect, useRef, useState } from "react";
import {
GenerateVideo, Notice, btnCls, btnPrimary, btnSmall, inputCls, mediaSrc,
useDeskMutation, type CanvasLink, type ProjectFull, type Result,
} from "../shared";
import { api } from "../api";

type Kind = "character" | "scene" | "shot" | "node" | "final";
type LinkKind = Exclude<Kind, "final">;
type NavTab = "characters" | "scenes" | "shots" | "qc";

interface GItem {
  kind: Kind;
  id: number;
  key: string;
  x: number;
  y: number;
  title: string;
}

const NODE_W = 248;
const GOLD = "#d9a441";
const KIND_LABEL: Record<string, string> = {
  character: "人物档案", scene: "场景卡", shot: "镜头", node: "参考节点", final: "最终成品",
};
const ROLE_LABEL: Record<string, string> = {
  reference: "参考", firstframe: "首帧", lastframe: "尾帧",
  style: "画风参考", chain: "链式衔接",
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Gesture =
  | { type: "pan"; pid: number }
  | { type: "pinch" }
  | { type: "node"; pid: number; key: string; kind: Kind; id: number; startWX: number; startWY: number; origX: number; origY: number }
  | { type: "port"; pid: number; fromKey: string };

function parseKey(key: string): { kind: LinkKind; id: number } | null {
  const [k, idStr] = key.split(":");
  const id = Number(idStr);
  if (!k || !id) return null;
  if (k !== "character" && k !== "scene" && k !== "shot" && k !== "node") return null;
  return { kind: k, id };
}

export function CanvasTab({ data, onNavigate }: { data: ProjectFull; onNavigate: (t: NavTab) => void }) {
  const project = data.project;
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState({ x: 24, y: 24, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [local, setLocal] = useState<Record<string, { x: number; y: number }>>({});
  const localRef = useRef<Record<string, { x: number; y: number }>>({});
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [boardSize, setBoardSize] = useState({ w: 800, h: 500 });
  const [linkStart, setLinkStart] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<{ from: { kind: LinkKind; id: number }; to: { kind: LinkKind; id: number } } | null>(null);
  const [linkRole, setLinkRole] = useState("reference");
  const [temp, setTemp] = useState<{ fromKey: string; x: number; y: number } | null>(null);
  const [expandedShot, setExpandedShot] = useState<number | null>(null);
  const [linkFrom, setLinkFrom] = useState("shot:");
  const [linkTo, setLinkTo] = useState("shot:");
  const [linkRoleForm, setLinkRoleForm] = useState("reference");

  const boardRef = useRef<HTMLDivElement>(null);
  const nodeEls = useRef(new Map<string, HTMLDivElement>());
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);
  const fittedRef = useRef(false);

  const savePos = useDeskMutation(
    (args: Parameters<typeof api.saveNodePosition>[0]) => api.saveNodePosition(args),
    setNotice,
  );
  const createLink = useDeskMutation(
    (args: Parameters<typeof api.createLink>[0]) => api.createLink(args),
    setNotice,
    () => { setPendingLink(null); setLinkStart(null); },
  );
  const delLink = useDeskMutation((id: number) => api.deleteLink({ id }), setNotice);
  const updateNode = useDeskMutation(
    (args: Parameters<typeof api.updateCanvasNode>[0]) => api.updateCanvasNode(args),
    setNotice,
  );
  const delNode = useDeskMutation((id: number) => api.deleteCanvasNode({ id }), setNotice);

  const centerWorld = () => {
    const b = boardRef.current;
    const v = viewRef.current;
    const w = b?.clientWidth ?? 600;
    const h = b?.clientHeight ?? 400;
    return {
      x: Math.max(16, Math.round((-v.x + w / 2) / v.k - NODE_W / 2)),
      y: Math.max(16, Math.round((-v.y + h / 2) / v.k - 60)),
    };
  };
  const createNote = useDeskMutation(
    () => {
      const c = centerWorld();
      return api.createCanvasNode({
        projectId: project?.id ?? 0, kind: "note", title: "文字便签",
        note: "", x: c.x, y: c.y, dataBase64: null, mimeType: null,
      });
    },
    setNotice,
  );
  const createMediaNode = useDeskMutation(
    async (f: File) => {
      const { fileToB64 } = await import("../shared");
      const b64 = await fileToB64(f);
      const c = centerWorld();
      return api.createCanvasNode({
        projectId: project?.id ?? 0,
        kind: f.type.startsWith("video") ? "video" : "image",
        title: f.name, note: "", x: c.x, y: c.y,
        dataBase64: b64, mimeType: f.type || null,
      });
    },
    setNotice,
  );

  // 滚轮缩放（原生监听以便 preventDefault）
  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = board.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const k2 = clamp(v.k * Math.exp(-e.deltaY * 0.0012), 0.25, 2);
        const wx = (mx - v.x) / v.k;
        const wy = (my - v.y) / v.k;
        return { k: k2, x: mx - wx * k2, y: my - wy * k2 };
      });
    };
    board.addEventListener("wheel", onWheel, { passive: false });
    return () => board.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const measure = () => setBoardSize({ w: board.clientWidth, h: board.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(board);
    return () => ro.disconnect();
  }, []);

  // 测节点真实高度，连线端口位置才准
  useEffect(() => {
    const next: Record<string, number> = {};
    nodeEls.current.forEach((el, k) => { next[k] = el.offsetHeight; });
    setHeights((prev) => {
      const keys = Object.keys(next);
      if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) return prev;
      return next;
    });
  });

  if (!project) return null;

  const items: GItem[] = [];
  data.characters.forEach((c, i) =>
    items.push({
      kind: "character", id: c.id, key: `character:${c.id}`,
      x: c.canvasX ?? 40 + (i % 3) * 270, y: c.canvasY ?? 420, title: c.name,
    }),
  );
  data.scenes.forEach((sc, i) =>
    items.push({
      kind: "scene", id: sc.id, key: `scene:${sc.id}`,
      x: sc.canvasX ?? 40 + (i % 3) * 270, y: sc.canvasY ?? 60, title: sc.name,
    }),
  );
  data.shots.forEach((sh, i) =>
    items.push({
      kind: "shot", id: sh.id, key: `shot:${sh.id}`,
      x: sh.canvasX ?? 340 + i * 280, y: sh.canvasY ?? 60,
      title: `第 ${sh.sortOrder + 1} 镜`,
    }),
  );
  data.nodes.forEach((n) =>
    items.push({
      kind: "node", id: n.id, key: `node:${n.id}`,
      x: n.x, y: n.y, title: n.title || "未命名节点",
    }),
  );
  // 最终成品节点：固定排在最后一镜右侧，是画布上拼接导出的终点。
  if (data.shots.length > 0) {
    const shotItems = items.filter((i) => i.kind === "shot");
    const maxShotX = shotItems.reduce((a, i) => Math.max(a, i.x), 340);
    const firstShotY = shotItems[0]?.y ?? 60;
    items.push({
      kind: "final", id: 0, key: "final:0",
      x: maxShotX + 320, y: firstShotY, title: "最终成品 · 导出",
    });
  }

  const posOf = (it: GItem) => local[it.key] ?? { x: it.x, y: it.y };
  const itemByKey = (key: string) => items.find((i) => i.key === key);
  const nameOf = (kind: string, id: number) =>
    itemByKey(`${kind}:${id}`)?.title ?? `${KIND_LABEL[kind] ?? kind} #${id}`;
  const portOut = (it: GItem) => {
    const p = posOf(it);
    return { x: p.x + NODE_W, y: p.y + (heights[it.key] ?? 180) / 2 };
  };
  const portIn = (it: GItem) => {
    const p = posOf(it);
    return { x: p.x, y: p.y + (heights[it.key] ?? 180) / 2 };
  };
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  let worldW = 1600;
  let worldH = 1200;
  for (const it of items) {
    const p = posOf(it);
    worldW = Math.max(worldW, p.x + NODE_W + 200);
    worldH = Math.max(worldH, p.y + (heights[it.key] ?? 180) + 200);
  }

  const toWorld = (clientX: number, clientY: number) => {
    const rect = boardRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - (rect?.left ?? 0) - v.x) / v.k,
      y: (clientY - (rect?.top ?? 0) - v.y) / v.k,
    };
  };

  const fit = () => {
    const board = boardRef.current;
    if (!board || items.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    for (const it of items) {
      const p = posOf(it);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + (heights[it.key] ?? 180));
    }
    const bw = board.clientWidth;
    const bh = board.clientHeight;
    const pad = 28;
    const k = clamp(Math.min((bw - pad * 2) / (maxX - minX), (bh - pad * 2) / (maxY - minY)), 0.25, 1.25);
    setView({
      k,
      x: pad - minX * k + Math.max(0, (bw - pad * 2 - (maxX - minX) * k) / 2),
      y: pad - minY * k,
    });
  };
  if (!fittedRef.current && items.length > 0 && boardSize.w > 0) {
    fittedRef.current = true;
    // 首次进入自动适应一次（下一帧执行，等高度测好）
    setTimeout(fit, 60);
  }
  const zoomStep = (factor: number) => {
    const board = boardRef.current;
    if (!board) return;
    const mx = board.clientWidth / 2;
    const my = board.clientHeight / 2;
    setView((v) => {
      const k2 = clamp(v.k * factor, 0.25, 2);
      const wx = (mx - v.x) / v.k;
      const wy = (my - v.y) / v.k;
      return { k: k2, x: mx - wx * k2, y: my - wy * k2 };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement;
    const portOutEl = target.closest<HTMLElement>("[data-port-out]");
    if (portOutEl?.dataset.portOut) {
      const fromKey = portOutEl.dataset.portOut;
      gesture.current = { type: "port", pid: e.pointerId, fromKey };
      setLinkStart(fromKey);
      const w = toWorld(e.clientX, e.clientY);
      setTemp({ fromKey, x: w.x, y: w.y });
      return;
    }
    if (target.closest("[data-port-in]")) return;
    const header = target.closest<HTMLElement>("[data-node-header]");
    if (header?.dataset.nodeHeader) {
      const it = itemByKey(header.dataset.nodeHeader);
      if (!it) return;
      const p = posOf(it);
      const w = toWorld(e.clientX, e.clientY);
      gesture.current = {
        type: "node", pid: e.pointerId, key: it.key, kind: it.kind, id: it.id,
        startWX: w.x, startWY: w.y, origX: p.x, origY: p.y,
      };
      return;
    }
    if (target.closest("[data-node-card]") || target.closest("button, input, textarea, select, a, label, summary")) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const pts = [...pointers.current.values()];
      const a = pts[0];
      const b = pts[1];
      if (a && b) {
        pinchRef.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        gesture.current = { type: "pinch" };
      }
    } else {
      gesture.current = { type: "pan", pid: e.pointerId };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    if (g.type === "node" && e.pointerId === g.pid) {
      const w = toWorld(e.clientX, e.clientY);
      const nx = Math.max(0, Math.round(g.origX + (w.x - g.startWX)));
      const ny = Math.max(0, Math.round(g.origY + (w.y - g.startWY)));
      localRef.current = { ...localRef.current, [g.key]: { x: nx, y: ny } };
      setLocal(localRef.current);
    } else if (g.type === "port" && e.pointerId === g.pid) {
      const w = toWorld(e.clientX, e.clientY);
      setTemp({ fromKey: g.fromKey, x: w.x, y: w.y });
    } else if (g.type === "pan" || g.type === "pinch") {
      const prevPt = pointers.current.get(e.pointerId);
      if (!prevPt) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.type === "pan") {
        const dx = e.clientX - prevPt.x;
        const dy = e.clientY - prevPt.y;
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      } else {
        const pr = pinchRef.current;
        const pts = [...pointers.current.values()];
        const a = pts[0];
        const b = pts[1];
        const rect = boardRef.current?.getBoundingClientRect();
        if (!pr || !a || !b || !rect || pr.dist === 0) return;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        setView((v) => {
          const k2 = clamp(v.k * (d / pr.dist), 0.25, 2);
          const wmx = (pr.mid.x - rect.left - v.x) / v.k;
          const wmy = (pr.mid.y - rect.top - v.y) / v.k;
          return { k: k2, x: m.x - rect.left - wmx * k2, y: m.y - rect.top - wmy * k2 };
        });
        pinchRef.current = { dist: d, mid: m };
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(e.pointerId);
    if (!g) return;
    if (g.type === "node" && e.pointerId === g.pid) {
      const p = localRef.current[g.key];
      // 最终成品节点位置由布局计算，只在本地拖动、不落库。
      if (p && g.kind !== "final") {
        savePos.mutate({ kind: g.kind as "character" | "scene" | "shot" | "node", id: g.id, x: p.x, y: p.y });
      }
      gesture.current = null;
    } else if (g.type === "port" && e.pointerId === g.pid) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-port-in]");
      const toKey = el?.dataset.portIn;
      setTemp(null);
      if (toKey && toKey !== g.fromKey) {
        const f = parseKey(g.fromKey);
        const t = parseKey(toKey);
        if (f && t) setPendingLink({ from: f, to: t });
      }
      gesture.current = null;
    } else if (g.type === "pan" || g.type === "pinch") {
      if (pointers.current.size === 0) gesture.current = null;
      else if (g.type === "pinch") {
        const remain = [...pointers.current.keys()][0];
        if (remain != null) gesture.current = { type: "pan", pid: remain };
      }
    }
  };

  const options: Array<{ value: string; label: string }> = items
    .filter((i) => i.kind !== "final")
    .map((i) => ({
      value: i.key,
      label: `${KIND_LABEL[i.kind]} · ${i.title}`,
    }));
  const dot = 22 * view.k;
  const pct = Math.round(view.k * 100);
  // 小地图
  const mmW = 132;
  const mmH = 92;
  const ms = Math.min(mmW / worldW, mmH / worldH);
  const vp = {
    x: -view.x / view.k,
    y: -view.y / view.k,
    w: boardSize.w / view.k,
    h: boardSize.h / view.k,
  };
  const mmColor: Record<Kind, string> = { character: GOLD, scene: "#7a9e7e", shot: "#ece7dd", node: "#8a8f98", final: "#e8762d" };

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-display text-2xl font-black">画布工具</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-[var(--dim)]">
          人物、场景、镜头、参考都是节点：拖标题栏移动，拖空白处平移，滚轮 / 双指缩放，从节点右侧圆点拖线到另一节点左侧圆点连线（触屏可先点出口再点入口）；连线可标「参考 / 首帧 / 尾帧」，标成「首帧 / 尾帧」的图，生成时就是那一镜的指定首帧 / 尾帧（会写进该镜的任务单）。最后一镜右侧的橙色「最终成品」节点是整条链的终点：拼接清单、连播预览和最终完整品导出都在下方导出站完成，不再有单独的拼接页。
        </p>
      </div>
      <Notice msg={notice} />

      <div
        ref={boardRef}
        className="relative h-[68vh] min-h-[460px] overflow-hidden rounded-lg border border-[var(--border)]"
        style={{
          background: "#101114",
          backgroundImage: "radial-gradient(circle, #34373f 1.1px, transparent 1.1px)",
          backgroundSize: `${dot}px ${dot}px`,
          backgroundPosition: `${view.x % dot}px ${view.y % dot}px`,
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* 世界层 */}
        <div
          className="absolute left-0 top-0"
          style={{
            width: worldW, height: worldH,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
            transformOrigin: "0 0",
          }}
        >
          <svg className="pointer-events-none absolute inset-0" width={worldW} height={worldH} aria-hidden>
            {data.links.map((l: CanvasLink) => {
              const a = itemByKey(`${l.fromKind}:${l.fromId}`);
              const b = itemByKey(`${l.toKind}:${l.toId}`);
              if (!a || !b) return null;
              const pa = portOut(a);
              const pb = portIn(b);
              return (
                <g key={l.id}>
                  <path d={curve(pa.x, pa.y, pb.x, pb.y)} fill="none" stroke={GOLD} strokeWidth={1.6 / view.k + 0.6} opacity={0.9} />
                  <text x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2 - 4} fill={GOLD} fontSize={11} textAnchor="middle">
                    {ROLE_LABEL[l.role] ?? l.role}
                  </text>
                </g>
              );
            })}
            {(() => {
              const fin = itemByKey("final:0");
              const lastShot = [...data.shots].sort((a, b) => a.sortOrder - b.sortOrder).at(-1);
              const from = lastShot ? itemByKey(`shot:${lastShot.id}`) : undefined;
              if (!fin || !from) return null;
              const pa = portOut(from);
              const pb = portIn(fin);
              return (
                <g>
                  <path d={curve(pa.x, pa.y, pb.x, pb.y)} fill="none" stroke="#e8762d" strokeWidth={2} strokeDasharray="8 5" opacity={0.95} />
                  <text x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2 - 4} fill="#e8762d" fontSize={11} textAnchor="middle">
                    拼接导出
                  </text>
                </g>
              );
            })()}
            {temp ? (() => {
              const from = itemByKey(temp.fromKey);
              if (!from) return null;
              const pa = portOut(from);
              return <path d={curve(pa.x, pa.y, temp.x, temp.y)} fill="none" stroke={GOLD} strokeWidth={1.6} strokeDasharray="6 4" />;
            })() : null}
          </svg>

          {items.map((it) => {
            const p = posOf(it);
            const char = it.kind === "character" ? data.characters.find((c) => c.id === it.id) : undefined;
            const scene = it.kind === "scene" ? data.scenes.find((x) => x.id === it.id) : undefined;
            const shot = it.kind === "shot" ? data.shots.find((x) => x.id === it.id) : undefined;
            const node = it.kind === "node" ? data.nodes.find((x) => x.id === it.id) : undefined;
            return (
              <div
                key={it.key}
                data-node-card
                ref={(el) => {
                  if (el) nodeEls.current.set(it.key, el);
                  else nodeEls.current.delete(it.key);
                }}
                className="absolute rounded-lg border bg-[var(--surface)] shadow-md"
                style={{
                  left: p.x, top: p.y, width: NODE_W,
                  borderColor: it.kind === "final" ? "#e8762d" : "var(--border)",
                  borderWidth: it.kind === "final" ? 2 : 1,
                }}
              >
                {it.kind !== "final" ? (
                <>
                <button
                  type="button"
                  data-port-in={it.key}
                  aria-label={`${it.title}连线入口（点此作为连线终点）`}
                  className="absolute -left-2 top-1/2 z-20 h-4 w-4 -translate-y-1/2 rounded-full"
                  style={{ background: "#17181c", border: `2px solid ${GOLD}` }}
                  onClick={() => {
                    if (linkStart && linkStart !== it.key) {
                      const f = parseKey(linkStart);
                      const t = parseKey(it.key);
                      if (f && t) setPendingLink({ from: f, to: t });
                    }
                  }}
                />
                <button
                  type="button"
                  data-port-out={it.key}
                  aria-label={`从${it.title}连线（出口，拖到另一节点入口或点选后点入口）`}
                  className="absolute -right-2 top-1/2 z-20 h-4 w-4 -translate-y-1/2 rounded-full"
                  style={
                    linkStart === it.key
                      ? { background: GOLD, border: "2px solid #fff" }
                      : { background: "#17181c", border: `2px solid ${GOLD}` }
                  }
                  onClick={() => setLinkStart(it.key)}
                />
                </>
                ) : null}
                <div
                  data-node-header={it.key}
                  className="flex cursor-grab items-center gap-1.5 rounded-t-lg bg-[var(--surface2)] px-2 py-1.5 active:cursor-grabbing"
                  style={{ touchAction: "none" }}
                >
                  <span className="shrink-0 rounded bg-[var(--ink)] px-1 py-px text-[10px] font-semibold text-[var(--ink-text)]">
                    {KIND_LABEL[it.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs font-bold">{it.title}</span>
                  {shot ? (
                    <span className="shrink-0 rounded bg-[var(--ink)] px-1 py-px text-[10px] text-[var(--ink-text)]">{shot.durationSec}s</span>
                  ) : null}
                  <span className="shrink-0 text-[10px] text-[var(--dim)]">拖动移动</span>
                </div>
                <div className="p-2">
                  {it.kind === "final" ? (
                    <>
                      {mediaSrc(project.finalVideoKey) ? (
                        <video
                          src={mediaSrc(project.finalVideoKey) ?? ""}
                          controls
                          preload="metadata"
                          className="aspect-video w-full rounded bg-black"
                          aria-label="最终成品预览"
                        />
                      ) : (
                        <div className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-[var(--border)] px-2 text-center text-[11px] text-[var(--dim)]">
                          全部镜头采用后，在下方导出站一键拼成最终完整品
                        </div>
                      )}
                      <p className="mt-1 text-[11px] leading-tight text-[var(--dim)]">
                        已采用 {data.shots.filter((sh) => sh.results.some((r) => r.adopted && r.includeInEdit)).length}/{data.shots.length} 镜
                        {project.assemblyConfirmed ? " · 拼接已确认" : " · 待确认拼接"}
                        {project.finalVideoKey ? (project.finalStale ? " · 成品已过期（清单有改动）" : " · 成品已导出") : " · 尚未导出"}
                      </p>
                      {project.finalExportedAt ? (
                        <p className="mt-0.5 text-[11px] leading-tight text-[var(--dim)]">
                          导出于 {new Date(project.finalExportedAt).toLocaleString("zh-CN", { hour12: false })}
                        </p>
                      ) : null}
                      <button
                        type="button" className={btnSmall + " mt-1.5 w-full"}
                        aria-label="去画布下方成品导出站"
                        onClick={() => document.getElementById("canvas-final-export")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      >
                        去成品导出站（拼接 / 预览 / 下载）
                      </button>
                    </>
                  ) : null}
                  {char ? (
                    <>
                      {mediaSrc(char.imageKey) ? (
                        <img src={mediaSrc(char.imageKey) ?? ""} alt={`${char.name}定版图`} className="h-28 w-full rounded object-cover" draggable={false} />
                      ) : (
                        <div className="flex h-16 items-center justify-center rounded border border-dashed border-[var(--border)] text-xs text-[var(--dim)]">无主肖像</div>
                      )}
                      <p className="mt-1 text-[11px] leading-tight text-[var(--dim)]">
                        {char.archiveStatus === "locked" ? `档案已锁 v${char.archiveVersion}` : `档案草稿 v${char.archiveVersion}`} · 参考 {char.refsFilled}/{char.refsTotal}
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-[var(--dim)]">{char.fields.identity || "身份未填"}</p>
                      <button type="button" className={btnSmall + " mt-1.5 w-full"} aria-label={`去人物档案编辑：${char.name}`} onClick={() => onNavigate("characters")}>
                        去人物档案编辑
                      </button>
                    </>
                  ) : null}
                  {scene ? (
                    <>
                      {mediaSrc(scene.imageKey) ? (
                        <img src={mediaSrc(scene.imageKey) ?? ""} alt={`${scene.name}场景图`} className="h-24 w-full rounded object-cover" draggable={false} />
                      ) : (
                        <div className="flex h-16 items-center justify-center rounded border border-dashed border-[var(--border)] text-xs text-[var(--dim)]">无场景图</div>
                      )}
                      <p className="mt-1 line-clamp-2 text-[11px] leading-tight text-[var(--dim)]">
                        {[scene.location, scene.timeOfDay, scene.lighting].filter(Boolean).join(" · ") || "场景信息未填"}
                      </p>
                      <button type="button" className={btnSmall + " mt-1.5 w-full"} aria-label={`去场景卡编辑：${scene.name}`} onClick={() => onNavigate("scenes")}>
                        去场景卡编辑
                      </button>
                    </>
                  ) : null}
                  {shot ? (
                    <>
                      <div className="grid grid-cols-3 gap-1">
                        <div>
                          <p className="mb-0.5 text-[10px] font-medium text-[var(--dim)]">首帧</p>
                          {mediaSrc(shot.firstFrameKey) ?? mediaSrc(shot.resolvedFirstFrame.key) ? (
                            <img src={(mediaSrc(shot.firstFrameKey) ?? mediaSrc(shot.resolvedFirstFrame.key)) ?? ""} alt={`第 ${shot.sortOrder + 1} 镜首帧`} className="aspect-video w-full rounded object-cover" draggable={false} />
                          ) : (
                            <div className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-[var(--border)] px-0.5 text-center text-[10px] text-[var(--dim)]">
                              {shot.chain.mode === "archive_scene" ? "方式 B · 无上传图：脚本＋人物档案＋场景卡生成" : shot.firstFrameLabel || (shot.resolvedFirstFrame.source ? "自动带入" : "未定位")}
                            </div>
                          )}
                        </div>
                        <div>
                          <p className="mb-0.5 text-[10px] font-medium text-[var(--dim)]">第一段动作</p>
                          <p className="line-clamp-4 text-[10px] leading-tight text-[var(--dim)]">{shot.action || "还没有写动作"}</p>
                        </div>
                        <div>
                          <p className="mb-0.5 text-[10px] font-medium text-[var(--dim)]">尾帧</p>
                          {mediaSrc(shot.lastFrameKey) ? (
                            <img src={mediaSrc(shot.lastFrameKey) ?? ""} alt={`第 ${shot.sortOrder + 1} 镜尾帧`} className="aspect-video w-full rounded object-cover" draggable={false} />
                          ) : (
                            <div className="flex aspect-video w-full items-center justify-center rounded border border-dashed border-[var(--border)] px-0.5 text-center text-[10px] text-[var(--dim)]">
                              {shot.lastFrameLabel || "未定位"}
                            </div>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 text-[11px] leading-tight text-[var(--dim)]">
                        多选名单：人物 {(shot.characterIds?.length ? shot.characterIds : shot.characterId ? [shot.characterId] : []).map((id) => data.characters.find((c) => c.id === id)?.name ?? `#${id}`).join("、") || "未指定"}
                        {" · "}场景 {(shot.sceneIds?.length ? shot.sceneIds : shot.sceneId ? [shot.sceneId] : []).map((id) => data.scenes.find((x) => x.id === id)?.name ?? `#${id}`).join("、") || "未指定"}
                      </p>
                      {shot.references.length > 0 ? (
                        <p className="mt-1 text-[11px] leading-tight text-[var(--dim)]">
                          引用：{shot.references.map((rf) => `${rf.role === "firstframe" ? "首帧" : rf.role === "lastframe" ? "尾帧" : "参考"}·${rf.title}${rf.mediaMissing ? "（缺图）" : ""}`).join("、")}
                        </p>
                      ) : (
                        <p className="mt-1 text-[11px] leading-tight text-[var(--amber)]">无引用：未连人物/场景/参考图到本镜</p>
                      )}
                      <p className="mt-1 text-[11px] leading-tight text-[var(--dim)]">
                        {shot.chain.isFirst
                          ? shot.chain.mode === "uploaded"
                            ? "第一镜方式 A：无上一镜尾帧，上传图为开场锚点，严格以图生成"
                            : "第一镜方式 B：无上一镜尾帧，按脚本＋人物档案＋场景卡严格生成"
                          : shot.chain.sceneBreak
                            ? "换场景：链条重置，本镜首帧独立定位（不走第一镜方式 B）"
                            : shot.chain.status.startsWith("blocked")
                              ? "严格链阻塞：缺上一镜真实尾帧图"
                              : "严格链：首帧承接上一镜真实尾帧"}
                      </p>
                      <p className="mt-1 text-[11px] leading-tight text-[var(--dim)]">
                        {shot.results.length > 0
                          ? `${shot.results.length} 个生成版本 · ${shot.results.some((r) => r.adopted) ? "已有采用版" : "未采用"}`
                          : "尚无生成版本 · 未采用"}
                      </p>
                      <div className="mt-1.5 flex gap-1">
                        <button type="button" className={btnSmall + " flex-1"} aria-label={`编辑第 ${shot.sortOrder + 1} 镜`} onClick={() => onNavigate("shots")}>
                          编辑此镜
                        </button>
                        <button type="button" className={btnSmall + " flex-1"} aria-label={`第 ${shot.sortOrder + 1} 镜质检与采用`} onClick={() => onNavigate("qc")}>
                          质检与采用
                        </button>
                        <button
                          type="button" className={btnSmall + " flex-1"}
                          aria-label={`${it.title}在画布上生成视频`}
                          onClick={() => setExpandedShot(expandedShot === it.id ? null : it.id)}
                        >
                          {expandedShot === it.id ? "收起" : "生成视频"}
                        </button>
                      </div>
                      {expandedShot === it.id ? (
                        <div className="mt-1.5 border-t border-[var(--border)] pt-1.5">
                          <GenerateVideo project={project} shot={shot} />
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  {node ? (
                    <>
                      {mediaSrc(node.mediaKey) ? (
                        node.mimeType?.startsWith("video") ? (
                          <video src={mediaSrc(node.mediaKey) ?? ""} className="h-24 w-full rounded bg-black object-cover" muted preload="metadata" aria-label={`参考视频节点：${node.title}`} />
                        ) : (
                          <img src={mediaSrc(node.mediaKey) ?? ""} alt={`参考节点：${node.title}`} className="h-24 w-full rounded object-cover" draggable={false} />
                        )
                      ) : node.mediaKey ? (
                        <div className="flex h-24 items-center justify-center rounded border border-dashed border-[var(--border)] p-2 text-center text-xs text-[var(--dim)]">参考素材原文件未提供</div>
                      ) : null}
                      <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] leading-tight text-[var(--dim)]">
                        {node.note || (node.kind === "note" ? "在下方「自由节点编辑」里写便签内容。" : "参考节点（图/视频）")}
                      </p>
                      <button type="button" className={btnSmall + " mt-1.5 w-full"} aria-label={`删除节点：${node.title}`} onClick={() => delNode.mutate(node.id)}>
                        删除节点
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>

        {/* 右上：新增节点 */}
        <div className="absolute right-3 top-3 z-30 flex gap-2">
          <label
            className="inline-flex cursor-pointer items-center justify-center rounded-md px-3 py-2 text-sm font-semibold text-white active:opacity-80"
            style={{ background: "#e8762d" }}
          >
            ＋ 参考节点（图/视频）
            <input
              type="file" accept="image/*,video/*" className="hidden" aria-label="上传参考节点（图或视频）"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) createMediaNode.mutate(f);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-md border border-white/25 bg-black/70 px-3 py-2 text-sm font-semibold text-white active:opacity-80"
            aria-label="新建文字便签节点"
            onClick={() => createNote.mutate(undefined)}
          >
            ＋ 文字便签
          </button>
        </div>

        {/* 连线待确认 / 已选出口提示 */}
        {pendingLink ? (
          <div className="absolute left-1/2 top-3 z-30 flex -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-md bg-black/85 px-2.5 py-2 text-xs text-white shadow-lg">
            <span>
              连线：{nameOf(pendingLink.from.kind, pendingLink.from.id)} → {nameOf(pendingLink.to.kind, pendingLink.to.id)} · 用途
            </span>
            {(["reference", "firstframe", "lastframe"] as const).map((r) => (
              <button
                key={r} type="button"
                aria-label={`连线用途：${ROLE_LABEL[r]}`}
                aria-pressed={linkRole === r}
                className="rounded px-2 py-1 font-medium"
                style={linkRole === r ? { background: GOLD, color: "#17181c" } : { background: "#2a2c33", color: "#ece7dd" }}
                onClick={() => setLinkRole(r)}
              >
                {ROLE_LABEL[r]}
              </button>
            ))}
            <button
              type="button" className="rounded bg-[#e8762d] px-2 py-1 font-semibold text-white"
              aria-label="确认创建连线"
              onClick={() => createLink.mutate({
                projectId: project.id,
                fromKind: pendingLink.from.kind, fromId: pendingLink.from.id,
                toKind: pendingLink.to.kind, toId: pendingLink.to.id,
                role: linkRole, note: "",
              })}
            >
              确认连线
            </button>
            <button
              type="button" className="rounded bg-[#2a2c33] px-2 py-1 text-[#ece7dd]"
              aria-label="取消连线"
              onClick={() => { setPendingLink(null); setLinkStart(null); }}
            >
              取消
            </button>
          </div>
        ) : linkStart ? (
          <div className="absolute bottom-14 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-md bg-black/85 px-2.5 py-1.5 text-xs text-white shadow-lg">
            <span>已选出口：{itemByKey(linkStart)?.title ?? linkStart}，请点另一节点左侧圆点作为入口，或拖线过去。</span>
            <button type="button" className="rounded bg-[#2a2c33] px-2 py-0.5" aria-label="取消已选出口" onClick={() => setLinkStart(null)}>
              取消
            </button>
          </div>
        ) : null}

        {/* 左下：缩放控制 */}
        <div className="absolute bottom-3 left-3 z-30 flex items-center gap-1 rounded-md bg-black/85 px-1.5 py-1 text-white shadow-lg">
          <button type="button" className="rounded px-2 py-1 text-base leading-none" aria-label="缩小画布" onClick={() => zoomStep(1 / 1.2)}>−</button>
          <button type="button" className="min-w-12 rounded px-1 py-1 text-center text-xs" aria-label={`当前缩放 ${pct}%，点击适应全部节点`} onClick={fit}>
            {pct}%
          </button>
          <button type="button" className="rounded px-2 py-1 text-base leading-none" aria-label="放大画布" onClick={() => zoomStep(1.2)}>＋</button>
          <button type="button" className="rounded px-2 py-1 text-xs" aria-label="适应画布（显示全部节点）" onClick={fit}>适应</button>
          <button type="button" className="rounded px-2 py-1 text-xs" aria-label="重置画布视图" onClick={() => setView({ x: 24, y: 24, k: 1 })}>重置</button>
        </div>

        {/* 右下：小地图 */}
        <div className="absolute bottom-3 right-3 z-30 rounded-md bg-black/70 p-1.5 shadow-lg">
          <div className="relative" style={{ width: mmW, height: mmH }} aria-hidden>
            {items.map((it) => {
              const p = posOf(it);
              return (
                <div
                  key={it.key}
                  className="absolute rounded-[2px]"
                  style={{
                    left: p.x * ms, top: p.y * ms,
                    width: Math.max(4, NODE_W * ms), height: Math.max(3, (heights[it.key] ?? 180) * ms),
                    background: mmColor[it.kind], opacity: 0.85,
                  }}
                />
              );
            })}
            <div
              className="absolute rounded-[2px]"
              style={{
                left: vp.x * ms, top: vp.y * ms,
                width: Math.max(6, vp.w * ms), height: Math.max(6, vp.h * ms),
                border: "1.5px solid #e8762d", background: "transparent",
              }}
            />
          </div>
          <p className="mt-1 text-center text-[10px] text-white/70">小地图 · 橙框为当前视图</p>
        </div>
      </div>

      {/* 最终成品 · 拼接导出站（拼接环节就在画布工具内完成） */}
      <FinalExportStation data={data} onNavigate={onNavigate} onNotice={setNotice} />

      {/* 自由节点编辑 */}
      {data.nodes.length > 0 ? (
        <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          <h3 className="font-display mb-2 text-sm font-bold">自由节点编辑（参考节点 / 文字便签）</h3>
          <div className="space-y-2">
            {data.nodes.map((n) => (
              <NodeRow key={n.id} id={n.id} title={n.title} note={n.note} onSave={(t, note) => updateNode.mutate({ id: n.id, title: t, note })} onNotice={setNotice} />
            ))}
          </div>
        </section>
      ) : null}

      {/* 连线管理（表单兜底 + 列表删除） */}
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="font-display mb-2 text-sm font-bold">连线管理（写入任务单）</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-36 flex-1">
            <span className="mb-1 block text-xs text-[var(--dim)]">从</span>
            <select aria-label="连线起点" className={inputCls} value={linkFrom} onChange={(e) => setLinkFrom(e.target.value)}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="block min-w-36 flex-1">
            <span className="mb-1 block text-xs text-[var(--dim)]">连到</span>
            <select aria-label="连线终点" className={inputCls} value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="block w-32">
            <span className="mb-1 block text-xs text-[var(--dim)]">用途</span>
            <select aria-label="连线用途" className={inputCls} value={linkRoleForm} onChange={(e) => setLinkRoleForm(e.target.value)}>
              <option value="reference">参考</option>
              <option value="firstframe">首帧</option>
              <option value="lastframe">尾帧</option>
              <option value="style">画风参考</option>
              <option value="chain">链式衔接</option>
            </select>
          </label>
          <button
            type="button" className={btnPrimary} aria-label="添加连线"
            onClick={() => {
              const f = parseKey(linkFrom);
              const t = parseKey(linkTo);
              if (f && t) createLink.mutate({ projectId: project.id, fromKind: f.kind, fromId: f.id, toKind: t.kind, toId: t.id, role: linkRoleForm, note: "" });
            }}
          >
            添加连线
          </button>
        </div>
        <ul className="mt-2 space-y-1">
          {data.links.map((l) => (
            <li key={l.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1">
                {nameOf(l.fromKind, l.fromId)} <span className="text-[var(--amber)]">—{ROLE_LABEL[l.role] ?? l.role}→</span> {nameOf(l.toKind, l.toId)}
              </span>
              <button type="button" className={btnSmall} aria-label={`删除连线：${nameOf(l.fromKind, l.fromId)}到${nameOf(l.toKind, l.toId)}`} onClick={() => delLink.mutate(l.id)}>
                删除
              </button>
            </li>
          ))}
          {data.links.length === 0 ? <li className="text-xs text-[var(--dim)]">暂无连线。在画布上从节点右侧圆点拖到另一节点左侧圆点即可连线。</li> : null}
        </ul>
      </section>
    </div>
  );
}

function NodeRow({
  id, title, note, onSave,
}: {
  id: number;
  title: string;
  note: string;
  onSave: (t: string, n: string) => void;
  onNotice: (m: string | null) => void;
}) {
  const [t, setT] = useState(title);
  const [n, setN] = useState(note);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label={`节点 ${id} 标题`} className={inputCls + " w-44"} value={t} onChange={(e) => setT(e.target.value)} />
      <input aria-label={`节点 ${id} 备注`} className={inputCls + " min-w-40 flex-1"} value={n} onChange={(e) => setN(e.target.value)} placeholder="备注（用途说明，会进任务单）" />
      <button type="button" className={btnSmall} aria-label={`保存节点 ${id}`} onClick={() => onSave(t, n)}>保存</button>
    </div>
  );
}

/** 最终成品导出站：拼接环节就在画布工具内——清单（采用版+剪辑点+转场）、
 *  按剪辑点连播预览、确认拼接、一键真拼接导出 MP4、成品播放/下载/重导。 */
function FinalExportStation({
  data, onNavigate, onNotice,
}: {
  data: ProjectFull;
  onNavigate: (t: NavTab) => void;
  onNotice: (m: string | null) => void;
}) {
  const project = data.project;
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [playIdx, setPlayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const previewRef = useRef<HTMLVideoElement>(null);
  const confirm = useDeskMutation(
    (c: boolean) => api.confirmAssembly({ projectId: project?.id ?? 0, confirm: c }),
    onNotice,
  );
  const doExport = useDeskMutation(
    () => api.exportFinalVideo({ projectId: project?.id ?? 0 }),
    onNotice,
    (res) => {
      if (res.ok) {
        setExportInfo(
          `最终完整品已导出：约 ${(res.bytes / 1048576).toFixed(2)}MB${res.durationSec ? ` · ${res.durationSec.toFixed(1)}s` : ""}，已回到画布成品节点与下方成品区，可直接播放、下载。`,
        );
      }
    },
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
  const playable = rows.filter((r) => r.adopted?.videoKey);
  const cur = playable[Math.min(playIdx, Math.max(0, playable.length - 1))];
  const finalSrc = mediaSrc(project.finalVideoKey);

  const advance = () => {
    if (playIdx + 1 < playable.length) setPlayIdx(playIdx + 1);
    else setPlaying(false);
  };

  return (
    <section id="canvas-final-export" className="rounded-lg p-3" style={{ background: "var(--ink)", color: "var(--ink-text)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-base font-bold">最终成品 · 拼接导出</span>
        {project.assemblyConfirmed ? (
          <span className="stamp" style={{ borderColor: "#e05a3a", color: "#ff9a83" }}>已确认拼接</span>
        ) : (
          <span className="text-sm opacity-80">未确认拼接</span>
        )}
        {project.finalVideoKey ? (
          project.finalStale ? (
            <span className="rounded px-1.5 py-0.5 text-xs font-semibold" style={{ background: "#b97e22", color: "#fff" }}>成品已过期 · 清单有改动</span>
          ) : (
            <span className="rounded px-1.5 py-0.5 text-xs font-semibold" style={{ background: "#3d7a3a", color: "#fff" }}>成品已导出</span>
          )
        ) : null}
        <span className="text-xs opacity-70">
          剪辑总时长 {totalEdit.toFixed(1)}s · {project.aspect} · {project.fps}fps · 导出规格 {project.exportSpec}
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          {!project.assemblyConfirmed ? (
            <button type="button" className={btnPrimary} aria-label="在画布确认拼接清单" disabled={confirm.isPending || missing.length > 0} onClick={() => confirm.mutate(true)}>
              确认拼接
            </button>
          ) : (
            <button type="button" className={btnCls} aria-label="在画布取消拼接确认" onClick={() => confirm.mutate(false)}>
              取消确认
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center justify-center gap-1 rounded-md px-3 py-2 text-sm font-semibold text-white active:opacity-80 disabled:opacity-40"
            style={{ background: "#e8762d" }}
            aria-label="导出最终完整品 MP4"
            disabled={doExport.isPending || missing.length > 0 || data.shots.length === 0}
            onClick={() => { setExportInfo(null); doExport.mutate(undefined); }}
          >
            {doExport.isPending ? "正在拼接导出…（按段数与时长耗时）" : project.finalVideoKey ? "重新导出最终完整品" : "导出最终完整品（MP4）"}
          </button>
        </span>
      </div>
      <p className="mt-1 text-xs opacity-70">
        拼接就在画布里完成：每镜采用版按下方入/出点与转场，在服务端真拼接成一个 MP4 成品（直切直接合并；叠化/淡入淡出用交叉淡化），成品只回到画布成品节点，不经聊天、不进资源库。导出会自动确认拼接；清单再改动后成品会标「已过期」，重新导出即可。
      </p>
      {exportInfo ? <p className="mt-2 rounded bg-white/10 px-2 py-1.5 text-xs leading-relaxed">{exportInfo}</p> : null}
      {missing.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded bg-white/10 px-2 py-1.5">
          <span className="text-xs">还有 {missing.length} 镜没有采用结果：第 {missing.map((mm) => mm.shot.sortOrder + 1).join("、")} 镜。先去质检页采用一版，成品才能拼齐。</span>
          <button type="button" className={btnSmall} aria-label="去质检页采用版本" onClick={() => onNavigate("qc")}>去质检与采用</button>
        </div>
      ) : null}

      {/* 连播预览：按剪辑点顺序逐段播放采用版，段界按入/出点跳段 */}
      {playable.length > 0 ? (
        <div className="mt-3 rounded-lg bg-black/40 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">完整预览（按剪辑点连播）</span>
            <span className="text-xs opacity-70">
              {cur ? `正在预览第 ${cur.shot.sortOrder + 1} 镜 · V${cur.adopted?.versionNumber}（${(cur.adopted?.inPoint ?? 0).toFixed(1)}s → ${cur.adopted?.outPoint != null ? `${cur.adopted.outPoint.toFixed(1)}s` : "结尾"}）` : ""}
              {" · "}共 {playable.length} 段
            </span>
            <span className="ml-auto flex gap-1.5">
              <button
                type="button" className={btnSmall} aria-label="从头连播预览完整品"
                onClick={() => { setPlayIdx(0); setPlaying(true); }}
              >
                ▶ 从头连播
              </button>
              <button type="button" className={btnSmall} aria-label="停止连播预览" onClick={() => setPlaying(false)}>停止</button>
            </span>
          </div>
          {cur?.adopted ? (
            <video
              key={`${cur.adopted.id}-${playing ? "play" : "idle"}`}
              ref={previewRef}
              src={mediaSrc(cur.adopted.videoKey) ?? ""}
              controls
              className="mt-2 w-full rounded bg-black"
              aria-label={`完整预览：第 ${cur.shot.sortOrder + 1} 镜采用版`}
              autoPlay={playing}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (cur.adopted && cur.adopted.inPoint > 0) v.currentTime = cur.adopted.inPoint;
                if (playing) void v.play().catch(() => undefined);
              }}
              onTimeUpdate={(e) => {
                const out = cur.adopted?.outPoint;
                if (playing && out != null && e.currentTarget.currentTime >= out) advance();
              }}
              onEnded={() => { if (playing) advance(); }}
            />
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {playable.map((r, i) => (
              <button
                key={r.shot.id} type="button"
                className="rounded px-2 py-1 text-xs font-medium"
                style={i === Math.min(playIdx, playable.length - 1) ? { background: "#e8762d", color: "#fff" } : { background: "#2a2c33", color: "#ece7dd" }}
                aria-label={`预览跳到第 ${r.shot.sortOrder + 1} 镜`}
                aria-pressed={i === playIdx}
                onClick={() => { setPlayIdx(i); setPlaying(true); }}
              >
                第 {r.shot.sortOrder + 1} 镜 · V{r.adopted?.versionNumber}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 成品区：已导出的最终完整品就在这里播放/下载 */}
      {finalSrc ? (
        <div className="mt-3 rounded-lg bg-black/40 p-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold">最终完整品</span>
            {project.finalExportedAt ? (
              <span className="text-xs opacity-70">导出于 {new Date(project.finalExportedAt).toLocaleString("zh-CN", { hour12: false })}</span>
            ) : null}
            {project.finalStale ? <span className="text-xs" style={{ color: "#ffcf7d" }}>清单已改动，这版成品不是最新清单——请重新导出。</span> : null}
            <a
              href={finalSrc}
              download={`${project.name}-最终完整品.mp4`}
              className={btnSmall + " ml-auto no-underline"}
              aria-label="下载最终完整品 MP4"
            >
              ⬇ 下载最终完整品
            </a>
          </div>
          <video src={finalSrc} controls className="mt-2 w-full rounded bg-black" aria-label="最终完整品播放" />
        </div>
      ) : null}

      {/* 拼接清单：逐镜采用版 + 剪辑点（与原拼接页同一套 updateResult） */}
      <div className="mt-3 space-y-2">
        {rows.map(({ shot, adopted }, i) => (
          <div key={shot.id} className="rounded-lg p-3" style={{ background: "var(--surface)", color: "var(--text)" }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ink)] font-display text-xs font-black text-[var(--ink-text)]">{shot.sortOrder + 1}</span>
              <span className="text-sm font-bold">第 {shot.sortOrder + 1} 镜</span>
              {i > 0 ? <span className="text-xs text-[var(--dim)]">← 与上一镜{adopted?.cutType ?? "直切"}</span> : null}
              {adopted ? (
                <span className="text-xs text-[var(--dim)]">采用 V{adopted.versionNumber}（{adopted.label}）{adopted.videoKey ? "" : " · 成片缺失，导出会被拦下"}</span>
              ) : (
                <span className="text-xs text-[var(--amber)]">未采用任何版本</span>
              )}
            </div>
            {adopted ? <FinalEditRow key={adopted.id} result={adopted} shotDuration={shot.durationSec} onNotice={onNotice} /> : null}
          </div>
        ))}
        {rows.length === 0 ? <p className="text-sm opacity-80">项目还没有分镜。</p> : null}
      </div>
    </section>
  );
}

function FinalEditRow({
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
        <input aria-label={`画布导出 V${result.versionNumber}入点`} type="number" min={0} step={0.1} className={inputCls} value={inP} onChange={(e) => setInP(e.target.value)} />
      </label>
      <label className="block w-28">
        <span className="mb-1 block text-xs text-[var(--dim)]">出点（秒，空=全长）</span>
        <input aria-label={`画布导出 V${result.versionNumber}出点`} type="number" min={0} step={0.1} className={inputCls} value={outP} onChange={(e) => setOutP(e.target.value)} placeholder={String(shotDuration)} />
      </label>
      <label className="block w-28">
        <span className="mb-1 block text-xs text-[var(--dim)]">转场</span>
        <select aria-label={`画布导出 V${result.versionNumber}转场`} className={inputCls} value={cut} onChange={(e) => setCut(e.target.value)}>
          <option value="直切">直切</option>
          <option value="叠化">叠化</option>
          <option value="淡入淡出">淡入淡出</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 pb-2 text-sm">
        <input
          type="checkbox" aria-label={`画布导出 V${result.versionNumber}纳入剪辑`}
          checked={include}
          onChange={(e) => setInclude(e.target.checked)}
        />
        纳入剪辑
      </label>
      <span className="pb-2 text-xs text-[var(--dim)]">有效时长 {eff.toFixed(1)}s</span>
      <button type="button" className={btnPrimary + " px-3 py-1.5 text-xs"} aria-label={`保存画布导出 V${result.versionNumber} 剪辑点`} disabled={save.isPending} onClick={() => save.mutate(undefined)}>
        保存剪辑点
      </button>
    </div>
  );
}
