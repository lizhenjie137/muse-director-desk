import { useEffect, useState } from "react";
import {
ASSET_LABELS, DropImage, Field, Notice, btnCls, btnPrimary, btnSmall, fileToB64,
flashById, inputCls, mediaSrc, useDeskMutation, type Character, type NavTarget, type ProjectFull, type Scene,
} from "../shared";
import { api } from "../api";

export function ScenesTab({ data, navTarget }: { data: ProjectFull; navTarget: NavTarget | null }) {
  const [newName, setNewName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // 缺项导航落点：滚动到指定场景卡并高亮。
  useEffect(() => {
    if (!navTarget?.sceneId) return;
    const t = window.setTimeout(() => flashById(`scene-card-${navTarget.sceneId}`), 120);
    return () => window.clearTimeout(t);
  }, [navTarget]);
  const create = useDeskMutation(
    (name: string) => api.createScene({ projectId: data.project?.id ?? 0, name }),
    setNotice,
    () => setNewName(""),
  );
  return (
    <div className="space-y-3">
      <Notice msg={notice} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {data.scenes.map((sc) => (
          <SceneCard key={sc.id} scene={sc} characters={data.characters} onNotice={setNotice} />
        ))}
      </div>
      {data.scenes.length === 0 ? <p className="text-sm text-[var(--dim)]">本项目还没有场景卡。</p> : null}
      <div className="flex gap-2">
        <input
          aria-label="新场景名称"
          className={inputCls}
          placeholder="新场景名称"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button" className={btnPrimary} aria-label="新建场景卡"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate(newName.trim())}
        >
          新建场景
        </button>
      </div>
    </div>
  );
}

function SceneCard({ scene: sc, characters, onNotice }: { scene: Scene; characters: Character[]; onNotice: (m: string | null) => void }) {
  const [draft, setDraft] = useState({
    name: sc.name, location: sc.location, timeOfDay: sc.timeOfDay,
    lighting: sc.lighting, atmosphere: sc.atmosphere, palette: sc.palette, notes: sc.notes,
  });
  const save = useDeskMutation(
    () => api.updateScene({ id: sc.id, ...draft }),
    onNotice,
  );
  const del = useDeskMutation(() => api.deleteScene({ id: sc.id }), onNotice);
  const upload = useDeskMutation(
    async (f: File) => api.uploadSceneImage({ sceneId: sc.id, dataBase64: await fileToB64(f), mimeType: f.type || "image/jpeg" }),
    onNotice,
  );
  const [genPromptText, setGenPromptText] = useState(sc.genPrompt);
  const [selectedChars, setSelectedChars] = useState<number[]>(sc.genCharIds);
  const gen = useDeskMutation(
    () => api.generateSceneImage({ sceneId: sc.id, prompt: genPromptText.trim(), characterIds: selectedChars }),
    onNotice,
  );
  const review = useDeskMutation(
    (approve: boolean) => api.reviewSceneImage({ sceneId: sc.id, approve }),
    onNotice,
  );
  const toggleChar = (id: number) =>
    setSelectedChars((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const charHasImage = (c: Character) => c.imageKey != null || c.refs.some((r) => r.imageKey != null);
  const img = mediaSrc(sc.imageKey);
  const cand = mediaSrc(sc.candidateKey);
  const genRunning = sc.genStatus === "running";
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3" id={`scene-card-${sc.id}`}>
      <div className="relative mb-2">
        {img ? (
          <img src={img} alt={`${sc.name}场景定版图`} className="aspect-[16/8] w-full rounded object-cover" />
        ) : (
          <DropImage
            label={`为场景「${sc.name}」上传场景图（点选或拖放）`}
            className="flex aspect-[16/8] w-full cursor-pointer rounded border border-dashed border-[var(--border)]"
            onFile={(f) => upload.mutate(f)}
          />
        )}
        {img ? (
          <div className="absolute bottom-1.5 right-1.5">
            <DropImage
              label={`更换场景「${sc.name}」的场景图`}
              className="block h-7 w-20 cursor-pointer rounded bg-black/60 text-white"
              onFile={(f) => upload.mutate(f)}
            />
          </div>
        ) : null}
      </div>
      {sc.imageKey?.startsWith("asset:") ? (
        <p className="-mt-1 mb-2 text-xs text-[var(--dim)]">{ASSET_LABELS[sc.imageKey]}</p>
      ) : null}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Field label="场景名">
          <input aria-label={`场景名：${sc.name}`} className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </Field>
        <Field label="时段">
          <input aria-label={`${sc.name}的时段`} className={inputCls} value={draft.timeOfDay} onChange={(e) => setDraft({ ...draft, timeOfDay: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="地点">
            <textarea aria-label={`${sc.name}的地点`} className={inputCls + " resize-y"} rows={2} value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
          </Field>
        </div>
        <Field label="光线">
          <textarea aria-label={`${sc.name}的光线`} className={inputCls + " resize-y"} rows={2} value={draft.lighting} onChange={(e) => setDraft({ ...draft, lighting: e.target.value })} />
        </Field>
        <Field label="氛围">
          <textarea aria-label={`${sc.name}的氛围`} className={inputCls + " resize-y"} rows={2} value={draft.atmosphere} onChange={(e) => setDraft({ ...draft, atmosphere: e.target.value })} />
        </Field>
        <Field label="色板">
          <textarea aria-label={`${sc.name}的色板`} className={inputCls + " resize-y"} rows={2} value={draft.palette} onChange={(e) => setDraft({ ...draft, palette: e.target.value })} />
        </Field>
        <Field label="备注">
          <textarea aria-label={`${sc.name}的备注`} className={inputCls + " resize-y"} rows={2} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
        </Field>
      </div>
      {/* 场景图生成：纯场景提示词生成，或勾选人物做结合生成 */}
      <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface2)] p-2.5">
        <h4 className="font-display text-sm font-bold">场景图生成</h4>
        <p className="mt-0.5 text-xs text-[var(--amber)]">图像生成通道已接通（状态：已接通 · 待首次真实生成验证）：纯场景走平台原生生图，勾选人物时走参照图助手结合生成；结果先作候选图待审核，生成失败会如实报错、不会假成功。</p>
        <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
          输入提示词直接生成场景图；也可以勾选一个或多个人物，生成「人物在这个场景里」的结合图——所选人物的已定版主肖像与参考图会作为图片参照实际传入（身份以其定版图为准、身份锁原文不变）。生成结果先落为候选图待审核，通过后才设为场景图，不会直接覆盖上面的场景图。
        </p>
        {characters.length > 0 ? (
          <fieldset className="mt-2">
            <legend className="text-xs font-medium text-[var(--dim)]">参照人物（可多选，不选＝纯场景）</legend>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {characters.map((c) => {
                const has = charHasImage(c);
                const on = selectedChars.includes(c.id);
                return (
                  <label
                    key={c.id}
                    className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                    style={{
                      borderColor: on ? "var(--ink)" : "var(--border)",
                      background: on ? "var(--ink)" : "var(--surface)",
                      color: on ? "var(--ink-text)" : "var(--text)",
                      opacity: has ? 1 : 0.55,
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`结合生成参照人物：${c.name}`}
                      checked={on}
                      disabled={!has || genRunning}
                      onChange={() => toggleChar(c.id)}
                    />
                    {c.name}
                    {has ? "" : "（无定版图）"}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-[var(--dim)]">没有定版图的人物不能作身份基准（先在人物档案定版至少主肖像）。</p>
          </fieldset>
        ) : (
          <p className="mt-1.5 text-xs text-[var(--dim)]">本项目还没有人物档案，只能做纯场景生成；建人物并定版主肖像后，这里可以勾选人物做结合生成。</p>
        )}
        <textarea
          aria-label={`场景「${sc.name}」生成提示词`}
          className={inputCls + " mt-2 resize-y"}
          rows={3}
          placeholder="场景生成提示词：如 黄昏时分，人物站在院子中央看向门口，暖色夕阳……（纯场景可只写环境）"
          value={genPromptText}
          onChange={(e) => setGenPromptText(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center justify-center rounded px-3 py-2 text-sm font-semibold disabled:opacity-40"
            style={{ background: "var(--ink)", color: "var(--ink-text)" }}
            aria-label={`生成场景「${sc.name}」的图`}
            disabled={gen.isPending || genRunning || !!cand}
            onClick={() => gen.mutate(undefined)}
          >
            {gen.isPending || genRunning
              ? "生成中…"
              : cand
                ? "先处理待审核候选图"
                : selectedChars.length > 0
                  ? `生成结合图（已选 ${selectedChars.length} 人）`
                  : "生成场景图"}
          </button>
          {sc.genStartedAt && genRunning ? (
            <span className="text-xs text-[var(--dim)]">始于 {new Date(sc.genStartedAt).toLocaleString("zh-CN", { hour12: false })}</span>
          ) : null}
        </div>
        {sc.genNote ? <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">{sc.genNote}</p> : null}
        {genRunning && !sc.genStaleUnknown ? (
          <p className="mt-1 text-xs text-[var(--amber)]">正在生成中，成图会回到本卡作候选图待审核；请勿重复提交。</p>
        ) : null}
        {genRunning && sc.genStaleUnknown ? (
          <ReleaseStuckSceneGen sceneId={sc.id} sceneName={sc.name} onNotice={onNotice} />
        ) : null}
        {sc.genStatus === "failed" ? <p className="mt-1 text-xs text-[var(--accent)]">生成失败：{sc.genError}</p> : null}
        {cand ? (
          <div className="mt-2">
            <img src={cand} alt={`场景「${sc.name}」生成候选图`} className="aspect-[16/8] w-full rounded border-2 border-[var(--amber)] object-cover" />
            <p className="mt-1 text-xs text-[var(--amber)]">
              生成候选图 · 待审核{sc.genCharIds.length ? `（结合人物：${sc.genCharIds.map((id) => characters.find((c) => c.id === id)?.name ?? `#${id}`).join("、")}）` : "（纯场景）"}——通过后才设为场景图，原场景图在此之前保持不变。
            </p>
            <div className="mt-1 flex gap-1.5">
              <button type="button" className={btnSmall + " flex-1"} aria-label={`场景「${sc.name}」候选图通过设为场景图`} disabled={review.isPending} onClick={() => review.mutate(true)}>
                通过 · 设为场景图
              </button>
              <button type="button" className={btnSmall + " flex-1"} aria-label={`丢弃场景「${sc.name}」生成候选图`} disabled={review.isPending} onClick={() => review.mutate(false)}>
                丢弃候选
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-2 flex gap-2">
        <button type="button" className={btnPrimary} aria-label={`保存场景：${sc.name}`} disabled={save.isPending} onClick={() => save.mutate(undefined)}>
          保存场景
        </button>
        <button type="button" className={btnCls} aria-label={`删除场景：${sc.name}`} onClick={() => del.mutate(undefined)}>
          删除场景
        </button>
      </div>
    </section>
  );
}

/** 场景图生成卡住时的释放区：与人物参考图同一口径——超时未回填只是
 * 「状态待核查」，不自动重新生成；核查并确认旧执行已终止后才释放。 */
function ReleaseStuckSceneGen({
  sceneId, sceneName, onNotice,
}: {
  sceneId: number;
  sceneName: string;
  onNotice: (m: string | null) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const release = useDeskMutation(
    () => api.releaseSceneGenClaim({ sceneId, confirmTerminated: confirmed, note: note.trim() }),
    onNotice,
  );
  return (
    <div className="mt-1.5 rounded px-2 py-1.5 text-left" style={{ background: "var(--accent-soft)", border: "1px solid var(--accent)" }}>
      <p className="text-[11px] leading-relaxed text-[var(--text)]">
        ⏳ 场景「{sceneName}」已「生成中」超过 30 分钟未回填——<strong>状态待核查，不等于已中断</strong>：可能原生成仍在运行，也可能图已生成、只是回填卡住。
        请先核查原执行；只有确认旧执行已终止后才能释放并重新生成，释放会作废旧尝试标识，旧回填晚到会被拒绝。
      </p>
      <label className="mt-1 flex items-start gap-1.5 text-[11px] text-[var(--text)]">
        <input
          type="checkbox"
          aria-label={`确认场景「${sceneName}」的旧生成已终止`}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已核查并确认旧生成已终止
      </label>
      <input
        aria-label={`场景「${sceneName}」释放核查说明`}
        className={inputCls + " mt-1 h-7 text-xs"}
        placeholder="核查说明（可空）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        type="button"
        className={btnSmall + " mt-1 w-full"}
        aria-label={`释放场景「${sceneName}」卡住的生成`}
        disabled={!confirmed || release.isPending}
        onClick={() => release.mutate(undefined)}
      >
        释放卡住的生成
      </button>
    </div>
  );
}
