import { useEffect, useMemo, useState } from "react";
import {
ASSET_LABELS, DropImage, Field, Notice, btnCls, btnPrimary, btnSmall,
fileToB64, flashById, inputCls, mediaSrc, useDeskMutation,
type Character, type NavTarget, type ProjectFull,
} from "../shared";
import { api } from "../api";

const SECTIONS: Array<{ title: string; fields: Array<[string, string, number?]> }> = [
  {
    title: "身份锁（逐项）",
    fields: [
      ["lockFace", "脸型骨骼"], ["lockEyes", "眼睛"], ["lockFeatures", "眉鼻嘴"],
      ["lockHair", "发型"], ["lockSkin", "肌肤"], ["lockBuild", "体态"],
      ["lockProportions", "身材比例"], ["lockMarks", "标志特征"],
      ["variableNotes", "可变清单"], ["visualAnchor", "视觉锚点（一句话）"],
    ],
  },
  {
    title: "表情 · 姿势 · 接触",
    fields: [
      ["expressions", "表情库（文字）"], ["expressionLimits", "表现红线"],
      ["poses", "姿势库"], ["posesToAvoid", "禁止姿势"],
      ["contactRules", "接触规矩（哪只手能碰人、哪只留身侧）"],
    ],
  },
  {
    title: "服装",
    fields: [
      ["wardrobe", "整套一句话"], ["wardrobeDetails", "逐件拆解"],
      ["wardrobeVersions", "服装版本列表"],
    ],
  },
  { title: "持续特征", fields: [["persistentFeatures", "持续特征（部位 / 静止状态 / 绝不能变成什么 / 分离规则）", 5]] },
  {
    title: "声音与台词",
    fields: [["voice", "声音描述"], ["dialogueRules", "台词规矩"]],
  },
  {
    title: "提示词（锁定措辞）",
    fields: [
      ["masterPrompt", "主提示词", 4], ["identityPrompt", "身份锁提示词（派单原文整段带入，不得改写）", 4],
      ["negativePrompt", "负面提示词", 3],
    ],
  },
];

const GROUPS: Array<[string, string]> = [
  ["body", "全身五角度"], ["face", "脸部五角度"], ["closeup", "局部特写"],
  ["expression", "表情图"], ["custom", "自定义格"],
];

export function CharactersTab({ data, navTarget }: { data: ProjectFull; navTarget: NavTarget | null }) {
  const project = data.project;
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  // 缺项导航落点：打开指定人物，再滚动到主肖像或具体参考格并高亮。
  useEffect(() => {
    if (!navTarget?.characterId) return;
    setSelectedId(navTarget.characterId);
    const t = window.setTimeout(() => {
      if (navTarget.slotKey) flashById(`ref-slot-${navTarget.characterId}-${navTarget.slotKey}`);
      else if (navTarget.field === "master") flashById(`character-master-${navTarget.characterId}`);
      else flashById(`character-detail-${navTarget.characterId}`);
    }, 200);
    return () => window.clearTimeout(t);
  }, [navTarget]);
  const create = useDeskMutation(
    (name: string) => api.createCharacter({ projectId: project?.id ?? 0, name }),
    setNotice,
    (res) => {
      setNewName("");
      if ("id" in res) setSelectedId(res.id as number);
    },
  );
  if (!project) return null;
  const selected = data.characters.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-3">
      <Notice msg={notice} />
      {selected ? (
        <CharacterDetail
          key={selected.id}
          character={selected}
          onBack={() => setSelectedId(null)}
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {data.characters.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-label={`打开人物档案：${c.name}`}
                className="flex gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-left"
                onClick={() => setSelectedId(c.id)}
              >
                {mediaSrc(c.imageKey) ? (
                  <img src={mediaSrc(c.imageKey) ?? ""} alt={`${c.name}主定版肖像`} className="h-20 w-16 shrink-0 rounded object-cover" />
                ) : (
                  <div className="flex h-20 w-16 shrink-0 items-center justify-center rounded border border-dashed border-[var(--border)] text-xs text-[var(--dim)]">无肖像</div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-base font-bold">{c.name || "（未命名）"}</span>
                    {c.archiveStatus === "locked" ? <span className="stamp">档案已锁 v{c.archiveVersion}</span> : <span className="text-xs text-[var(--dim)]">草稿 v{c.archiveVersion}</span>}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-[var(--dim)]">{c.fields.identity || "身份未填"}</p>
                  <p className="mt-1 text-xs">
                    参考集定版 <strong>{c.refsFilled}/{c.refsTotal}</strong>
                    {c.refsFilled < c.refsTotal ? (
                      <span className="text-[var(--amber)]"> · 缺 {c.refsTotal - c.refsFilled} 项</span>
                    ) : (
                      <span style={{ color: "#3d7a3a" }}> · 已齐</span>
                    )}
                  </p>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-[var(--surface2)]">
                    <div
                      className="h-full"
                      style={{ width: `${c.refsTotal ? (c.refsFilled / c.refsTotal) * 100 : 0}%`, background: "var(--accent)" }}
                    />
                  </div>
                </div>
              </button>
            ))}
            {data.characters.length === 0 ? (
              <p className="text-sm text-[var(--dim)]">本项目还没有人物档案，在下方新建。</p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <input
              aria-label="新人物姓名"
              className={inputCls}
              placeholder="新人物姓名"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button
              type="button" className={btnPrimary} aria-label="新建人物档案"
              disabled={!newName.trim() || create.isPending}
              onClick={() => create.mutate(newName.trim())}
            >
              新建人物
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CharacterDetail({
  character: c, onBack,
}: {
  character: Character;
  onBack: () => void;
}) {
  const locked = c.archiveStatus === "locked";
  const [name, setName] = useState(c.name);
  const [fields, setFields] = useState<Record<string, string>>({ ...c.fields });
  const [notice, setNotice] = useState<string | null>(null);
  const [unlockReason, setUnlockReason] = useState("");
  const [newSlotLabel, setNewSlotLabel] = useState("");
  const [voiceName, setVoiceName] = useState("");

  const save = useDeskMutation(
    () => api.updateCharacter({ id: c.id, name: name.trim() || c.name, fields }),
    setNotice,
  );
  const del = useDeskMutation(() => api.deleteCharacter({ id: c.id }), setNotice, onBack);
  const uploadMaster = useDeskMutation(
    async (f: File) => api.uploadMasterImage({ characterId: c.id, dataBase64: await fileToB64(f), mimeType: f.type || "image/jpeg" }),
    setNotice,
  );
  const [masterPrompt, setMasterPrompt] = useState("");
  const genMaster = useDeskMutation(
    () => api.generateRefImage({ characterId: c.id, slotKey: null, prompt: masterPrompt.trim() }),
    setNotice,
  );
  const reviewMaster = useDeskMutation(
    (approve: boolean) => api.reviewRefImage({ characterId: c.id, slotKey: null, approve }),
    setNotice,
  );
  const autoLock = useDeskMutation(
    () => api.autoFillAndLockIdentity({ characterId: c.id }),
    setNotice,
    (res) => {
      if (res.ok && "note" in res && res.note) setNotice(`身份锁已锁定。${res.note as string}`);
    },
  );
  const unlock = useDeskMutation(
    (reason: string) => api.unlockCharacter({ characterId: c.id, reason }),
    setNotice,
  );
  const addSlot = useDeskMutation(
    (label: string) => api.addRefSlot({ characterId: c.id, label }),
    setNotice,
    () => setNewSlotLabel(""),
  );
  const uploadVoice = useDeskMutation(
    async (f: File) =>
      api.uploadVoiceRef({
        characterId: c.id,
        name: voiceName.trim() || f.name,
        dataBase64: await fileToB64(f),
        mimeType: f.type || "audio/mpeg",
      }),
    setNotice,
    () => setVoiceName(""),
  );
  const saveVoices = useDeskMutation(
    (voiceRefs: Character["voiceRefs"]) => api.updateVoiceRefs({ characterId: c.id, voiceRefs }),
    setNotice,
  );

  const missingByGroup = useMemo(() => {
    const out: string[] = [];
    for (const [gk, gl] of GROUPS) {
      const slots = c.refs.filter((r) => r.groupKey === gk);
      // 缺 = 没有真实图片：未定版，或只有定版记录、原图缺失。
      const missing = slots.filter((r) => !r.filled || r.mediaMissing || !r.imageKey).length;
      if (slots.length && missing) out.push(`${gl}缺 ${missing}（按真实图片计）`);
    }
    if (!c.imageKey) out.push("主肖像缺");
    return out;
  }, [c]);

  const baselineCount = c.identityBaselineCount;
  const filledTotal = c.refsFilled;
  const lockBtnLabel =
    c.identityBaselineVersion == null
      ? "自动填入身份锁并锁定"
      : filledTotal > baselineCount
        ? "更新身份锁并重新锁定"
        : "自动填入身份锁并锁定";

  const masterImg = mediaSrc(c.imageKey);
  const masterCandidate = mediaSrc(c.masterCandidateKey);

  return (
    <div className="space-y-4" id={`character-detail-${c.id}`}>
      <div className="flex items-center gap-2">
        <button type="button" className={btnCls + " px-2 py-1 text-xs"} aria-label="返回人物列表" onClick={onBack}>
          ← 人物列表
        </button>
        {locked ? <span className="stamp">档案已锁 v{c.archiveVersion}</span> : <span className="text-xs text-[var(--dim)]">草稿 v{c.archiveVersion}</span>}
        {c.identityBaselineVersion != null ? (
          <span className="text-xs text-[var(--dim)]">
            身份锁 v{c.identityBaselineVersion} · 基准定版图 {baselineCount} 张
            {filledTotal > baselineCount ? <span className="text-[var(--amber)]"> · 锁后新增 {filledTotal - baselineCount} 张（派单会提示身份锁已过期）</span> : null}
          </span>
        ) : (
          <span className="text-xs text-[var(--amber)]">身份锁未锁定（派单时会提示）</span>
        )}
      </div>
      <Notice msg={notice} />
      <div className="rounded-lg border-2 px-3 py-2" style={{ borderColor: "#3d7a3a", background: "var(--surface)" }} aria-label="人物档案是身份唯一来源说明">
        <p className="text-xs leading-relaxed">
          <strong>这里是身份唯一来源：</strong>脸、发型长度与样式、发色、服装、体型都以本档案的主定版肖像、定版参考图和身份锁原文为准。分镜里的脚本提示词只决定每镜的动作、场景、运镜、光线与情绪，<strong>不决定身份</strong>——脚本写了与档案冲突的身份描述（如脚本长发、档案短发），派单时会被检测出来、明示并从生成提示词中剥离，成片仍按档案走。
          要换成新身份（如改成长发），就在这里改身份文字、重新生成主肖像和参考图并定版，之后派单的生成指令才会按新身份走；不要靠分镜提示词临时改身份。
        </p>
      </div>

      {/* 主肖像 + 完整度 */}
      <div className="flex flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 sm:flex-row">
        <div className="w-full shrink-0 sm:w-64" id={`character-master-${c.id}`}>
          <h3 className="font-display mb-1.5 text-sm font-bold">{c.name} 主定版肖像（一致性锚点）</h3>
          {masterCandidate ? (
            <>
              <img src={masterCandidate} alt="主肖像候选图" className="w-full rounded border-2 border-[var(--amber)] object-cover" />
              <p className="mt-1 text-center text-xs text-[var(--amber)]">候选图 · 未定版不得被引用</p>
              {!locked ? (
                <div className="mt-1 flex gap-1">
                  <button type="button" className={btnSmall + " flex-1"} aria-label="主肖像候选图通过定版" onClick={() => reviewMaster.mutate(true)}>通过 · 定版</button>
                  <button type="button" className={btnSmall + " flex-1"} aria-label="主肖像候选图重拍丢弃" onClick={() => reviewMaster.mutate(false)}>重拍</button>
                </div>
              ) : null}
            </>
          ) : masterImg ? (
            <img src={masterImg} alt={`${c.name}主定版肖像`} className="w-full rounded object-cover" />
          ) : (
            <div className="flex aspect-[3/4] items-center justify-center rounded border border-dashed border-[var(--border)] text-xs text-[var(--dim)]">{c.imageKey ? "主定版肖像（原文件未提供）" : "主定版肖像（未定版）"}</div>
          )}
          {c.imageKey?.startsWith("asset:") ? (
            <p className="mt-1 text-center text-xs text-[var(--dim)]">{ASSET_LABELS[c.imageKey]}</p>
          ) : null}
          {!locked ? (
            <div className="mt-1.5 space-y-1.5">
              <DropImage
                label="换一张"
                className="h-9 w-full cursor-pointer rounded border border-[var(--border)] bg-[var(--surface2)]"
                onFile={(f) => uploadMaster.mutate(f)}
              />
              <textarea
                aria-label="主肖像生成提示词"
                className={inputCls + " resize-y"}
                rows={2}
                placeholder="生成提示词（可空）：如 想要的表情、角度、光线——与身份锁冲突时以身份锁和锚点图为准"
                value={masterPrompt}
                onChange={(e) => setMasterPrompt(e.target.value)}
              />
              <button
                type="button"
                className="inline-flex w-full items-center justify-center rounded px-3 py-2 text-sm font-semibold disabled:opacity-40"
                style={{ background: "var(--ink)", color: "var(--ink-text)" }}
                aria-label="再生成一张主肖像"
                disabled={genMaster.isPending || c.masterGenStatus === "running"}
                onClick={() => genMaster.mutate(undefined)}
              >
                {genMaster.isPending || c.masterGenStatus === "running" ? "生成中…" : "再生成一张主肖像"}
              </button>
              <p className="text-xs leading-relaxed text-[var(--dim)]">
                这张主肖像是全档案的一致性锚点：下面每个参考格生成时，都会把这张锚点图本身作为第一张图片参照传入（不是只按文字描述），身份、脸、发型、体型、服装都以锚点图为准；重新生成主肖像时同样以现有锚点图与全部定版图为参照。生成的图先是候选，通过后才替换定版。
              </p>
              <p className="text-xs text-[var(--amber)]">图像生成通道已接通（状态：已接通 · 待首次真实生成验证）：无参照时走平台原生生图，有锚点时走参照图助手生成；结果先作候选图待审核，生成失败会如实报错、不会假成功。</p>
              {c.masterGenNote ? <p className="text-xs leading-relaxed text-[var(--dim)]">{c.masterGenNote}</p> : null}
              {c.masterGenStatus === "running" && !genMaster.isPending ? (
                <>
                  <p className="text-xs text-[var(--amber)]">
                    主肖像正在生成中{c.masterGenStartedAt ? `（始于 ${new Date(c.masterGenStartedAt).toLocaleString("zh-CN", { hour12: false })}）` : ""}，完成后会以候选图出现在此处待审核。
                  </p>
                  {c.masterGenStaleUnknown ? (
                    <ReleaseStuckRefGen characterId={c.id} slotKey={null} label="主定版肖像" onNotice={setNotice} />
                  ) : null}
                </>
              ) : null}
              {c.masterGenStatus === "failed" ? <p className="text-xs text-[var(--accent)]">生成失败：{c.masterGenError}</p> : null}
            </div>
          ) : null}
          {c.extraAssets.map((a) => (
            <figure key={a} className="mt-2">
              {mediaSrc(a) ? (
                <img src={mediaSrc(a) ?? ""} alt={ASSET_LABELS[a] ?? a} className="w-full rounded" />
              ) : (
                <div className="rounded border border-dashed border-[var(--border)] p-3 text-center text-xs text-[var(--dim)]">原参考图未提供，请补充对应原文件。</div>
              )}
              <figcaption className="mt-0.5 text-center text-xs text-[var(--dim)]">{ASSET_LABELS[a]}</figcaption>
            </figure>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="角色名">
              <input aria-label="人物姓名" className={inputCls} value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="身份">
              <input aria-label={`${c.name}的身份`} className={inputCls} value={fields.identity ?? ""} disabled={locked} onChange={(e) => setFields((prev) => ({ ...prev, identity: e.target.value }))} />
            </Field>
            <Field label="年龄与年龄感">
              <input aria-label={`${c.name}的年龄与年龄感`} className={inputCls} value={fields.ageImpression ?? ""} disabled={locked} onChange={(e) => setFields((prev) => ({ ...prev, ageImpression: e.target.value }))} />
            </Field>
            <Field label="性格（一句话）">
              <input aria-label={`${c.name}的性格`} className={inputCls} value={fields.personality ?? ""} disabled={locked} onChange={(e) => setFields((prev) => ({ ...prev, personality: e.target.value }))} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="时代 / 地域 / 社会背景">
                <textarea aria-label={`${c.name}的时代地域社会背景`} className={inputCls + " resize-y"} rows={2} value={fields.background ?? ""} disabled={locked} onChange={(e) => setFields((prev) => ({ ...prev, background: e.target.value }))} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="与其他角色的关系与称呼">
                <textarea aria-label={`${c.name}的与其他角色的关系与称呼`} className={inputCls + " resize-y"} rows={2} value={fields.relationships ?? ""} disabled={locked} onChange={(e) => setFields((prev) => ({ ...prev, relationships: e.target.value }))} />
              </Field>
            </div>
            <div className="sm:col-span-2">
              <Field label="备注">
                <textarea aria-label={`${c.name}的备注`} className={inputCls + " resize-y"} rows={1} value={fields.notes ?? ""} disabled={locked} onChange={(e) => setFields((prev) => ({ ...prev, notes: e.target.value }))} />
              </Field>
            </div>
          </div>
          <p className="mt-2 font-display text-2xl font-black">
            {c.refsFilled}<span className="text-base text-[var(--dim)]">/{c.refsTotal} 项有真实图片（主肖像 1 ＋ 参考格 {c.refsTotal - 1}，只有定版记录、原图缺失的不计）</span>
          </p>
          <div className="mt-1 h-2 w-full overflow-hidden rounded bg-[var(--surface2)]">
            <div className="h-full" style={{ width: `${c.refsTotal ? (c.refsFilled / c.refsTotal) * 100 : 0}%`, background: "var(--accent)" }} />
          </div>
          <p className="mt-1 text-xs text-[var(--dim)]">
            {missingByGroup.length ? `缺项：${missingByGroup.join("、")}` : "参考集已齐"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {!locked ? (
              <>
                <button type="button" className={btnPrimary} aria-label={lockBtnLabel} disabled={autoLock.isPending} onClick={() => autoLock.mutate(undefined)}>
                  {autoLock.isPending ? "处理中…" : lockBtnLabel}
                </button>
                <button type="button" className={btnCls} aria-label="保存档案文字" disabled={save.isPending} onClick={() => save.mutate(undefined)}>
                  保存档案
                </button>
                <button type="button" className={btnCls} aria-label={`删除人物${c.name}`} onClick={() => del.mutate(undefined)}>
                  删除人物
                </button>
              </>
            ) : (
              <div className="flex w-full flex-wrap items-center gap-2">
                <input
                  aria-label="解锁档案原因"
                  className={inputCls + " min-w-44 flex-1"}
                  placeholder="解锁原因（必填，自动升版并记入变更日志）"
                  value={unlockReason}
                  onChange={(e) => setUnlockReason(e.target.value)}
                />
                <button type="button" className={btnPrimary} aria-label="解锁档案" disabled={!unlockReason.trim()} onClick={() => unlock.mutate(unlockReason.trim())}>
                  解锁档案
                </button>
              </div>
            )}
          </div>
          {locked ? <p className="mt-2 text-xs text-[var(--amber)]">档案已锁版：修改与生图已被拦截，解锁需填写原因、自动升版。</p> : null}
        </div>
      </div>

      {/* 文字段落 */}
      {SECTIONS.map((sec) => (
        <section key={sec.title} className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
          <h3 className="font-display mb-2 text-sm font-bold tracking-wide">{sec.title}</h3>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {sec.fields.map(([key, label, rows]) => (
              <div key={key} className={rows && rows > 2 ? "sm:col-span-2" : ""}>
                <Field
                  label={label}
                  hint={c.autoFilledFields.includes(key) && fields[key] === c.fields[key] ? "自动生成，可改" : undefined}
                >
                  <textarea
                    aria-label={`${c.name}的${label}`}
                    className={inputCls + " resize-y"}
                    rows={rows ?? 2}
                    value={fields[key] ?? ""}
                    disabled={locked}
                    onChange={(e) => setFields((prev) => ({ ...prev, [key]: e.target.value }))}
                  />
                </Field>
              </div>
            ))}
          </div>
        </section>
      ))}
      {!locked ? (
        <button type="button" className={btnPrimary + " w-full"} aria-label="保存全部档案文字" disabled={save.isPending} onClick={() => save.mutate(undefined)}>
          保存档案
        </button>
      ) : null}

      {/* 参考集 */}
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="font-display mb-1 text-sm font-bold tracking-wide">定版图参考集</h3>
        <p className="mb-2 text-xs text-[var(--dim)]">每个槽位一张定版图：可以上传（换图），也可以在导演台生成——生成时把主定版肖像（一致性锚点）的图片本身作为第一参照、其余定版图随后全量传入，不是只按文字描述；没有锚点图时参考格生成会被拦下，先定版主肖像。候选图通过后才算定版，未通过的候选图不得被任何生成引用。</p>
        {GROUPS.map(([gk, gl]) => {
          const slots = c.refs.filter((r) => r.groupKey === gk);
          if (slots.length === 0 && gk !== "custom") return null;
          return (
            <div key={gk} className="mt-3">
              <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-[var(--dim)]">
                {gl}（{slots.filter((r) => r.filled).length}/{slots.length}）
              </h4>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4">
                {slots.map((slot) => (
                  <RefTile key={slot.slotKey} character={c} slotKey={slot.slotKey} locked={locked} onNotice={setNotice} />
                ))}
              </div>
            </div>
          );
        })}
        {!locked ? (
          <div className="mt-3 flex gap-2">
            <input
              aria-label="自定义参考格名称"
              className={inputCls}
              placeholder="新增自定义格名称"
              value={newSlotLabel}
              onChange={(e) => setNewSlotLabel(e.target.value)}
            />
            <button type="button" className={btnCls} aria-label="新增自定义参考格" disabled={!newSlotLabel.trim()} onClick={() => addSlot.mutate(newSlotLabel.trim())}>
              新增格
            </button>
          </div>
        ) : null}
      </section>

      {/* 声音参考 */}
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="font-display mb-1 text-sm font-bold tracking-wide">声音参考</h3>
        <p className="mb-2 text-xs text-[var(--dim)]">供台词/配音环节参照；任务单清点区会列出主声音参考（视频生成通道本身不吃音频输入）。</p>
        <div className="space-y-2">
          {c.voiceRefs.map((v) => (
            <div key={v.id} className="flex flex-wrap items-center gap-2 rounded border border-[var(--border)] p-2">
              <input
                aria-label={`声音参考名称：${v.name}`}
                className="w-36 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
                defaultValue={v.name}
                disabled={locked}
                onBlur={(e) => {
                  if (e.target.value !== v.name)
                    saveVoices.mutate(c.voiceRefs.map((x) => (x.id === v.id ? { ...x, name: e.target.value } : x)));
                }}
              />
              <audio src={mediaSrc(v.key) ?? ""} controls className="h-8 max-w-full flex-1" aria-label={`试听声音参考：${v.name}`} />
              {v.isMain ? (
                <span className="stamp">主声音参考</span>
              ) : !locked ? (
                <button
                  type="button" className={btnSmall} aria-label={`设为主声音参考：${v.name}`}
                  onClick={() => saveVoices.mutate(c.voiceRefs.map((x) => ({ ...x, isMain: x.id === v.id })))}
                >
                  设为主参考
                </button>
              ) : null}
              {!locked ? (
                <button
                  type="button" className={btnSmall} aria-label={`删除声音参考：${v.name}`}
                  onClick={() => saveVoices.mutate(c.voiceRefs.filter((x) => x.id !== v.id))}
                >
                  删除
                </button>
              ) : null}
            </div>
          ))}
          {c.voiceRefs.length === 0 ? <p className="text-xs text-[var(--dim)]">尚无声音参考。</p> : null}
        </div>
        {!locked ? (
          <div className="mt-2 flex gap-2">
            <input
              aria-label="新声音参考名称"
              className={inputCls}
              placeholder="声音参考名称（可空，用文件名）"
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
            />
            <DropImage
              label="上传声音参考（音频）"
              accept="audio/*"
              className="h-10 w-44 shrink-0 cursor-pointer rounded border border-[var(--border)] bg-[var(--surface2)]"
              onFile={(f) => uploadVoice.mutate(f)}
            />
          </div>
        ) : null}
      </section>

      {/* 变更日志 */}
      <section className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <h3 className="font-display mb-1 text-sm font-bold tracking-wide">档案变更日志</h3>
        <pre className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--dim)]">{c.changeLog || "（暂无记录）"}</pre>
      </section>
    </div>
  );
}

/** 参考图生成卡住时的释放区：与镜头视频同一口径——超时未回填只是
 * 「状态待核查」，不自动重新生成；核查并确认旧执行已终止后才释放，
 * 释放后旧尝试的晚到回填会被服务端拒绝。 */
function ReleaseStuckRefGen({
  characterId, slotKey, label, onNotice,
}: {
  characterId: number;
  slotKey: string | null;
  label: string;
  onNotice: (m: string | null) => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const release = useDeskMutation(
    () => api.releaseRefImageClaim({ characterId, slotKey, confirmTerminated: confirmed, note: note.trim() }),
    onNotice,
  );
  return (
    <div className="mt-1 rounded px-2 py-1.5 text-left" style={{ background: "var(--accent-soft)", border: "1px solid var(--accent)" }}>
      <p className="text-[11px] leading-relaxed text-[var(--text)]">
        ⏳ 「{label}」已「生成中」超过 30 分钟未回填——<strong>状态待核查，不等于已中断</strong>：可能原生成仍在运行，也可能图已生成、只是回填卡住。
        请先核查原执行；只有确认旧执行已终止后才能释放并重新生成，释放会作废旧尝试标识，旧回填晚到会被拒绝。
      </p>
      <label className="mt-1 flex items-start gap-1.5 text-[11px] text-[var(--text)]">
        <input
          type="checkbox"
          aria-label={`确认${label}的旧生成已终止`}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已核查并确认旧生成已终止
      </label>
      <input
        aria-label={`${label}释放核查说明`}
        className={inputCls + " mt-1 h-7 text-xs"}
        placeholder="核查说明（可空）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        type="button"
        className={btnSmall + " mt-1 w-full"}
        aria-label={`释放${label}卡住的生成`}
        disabled={!confirmed || release.isPending}
        onClick={() => release.mutate(undefined)}
      >
        释放卡住的生成
      </button>
    </div>
  );
}

function RefTile({
  character: c, slotKey, locked, onNotice,
}: {
  character: Character;
  slotKey: string;
  locked: boolean;
  onNotice: (m: string | null) => void;
}) {
  const slot = c.refs.find((r) => r.slotKey === slotKey);
  const upload = useDeskMutation(
    async (f: File) => api.uploadRefImage({ characterId: c.id, slotKey, dataBase64: await fileToB64(f), mimeType: f.type || "image/jpeg" }),
    onNotice,
  );
  const [slotPrompt, setSlotPrompt] = useState("");
  const gen = useDeskMutation(
    () => api.generateRefImage({ characterId: c.id, slotKey, prompt: slotPrompt.trim() }),
    onNotice,
  );
  const review = useDeskMutation((approve: boolean) => api.reviewRefImage({ characterId: c.id, slotKey, approve }), onNotice);
  const clear = useDeskMutation(() => api.clearRefSlot({ characterId: c.id, slotKey }), onNotice);
  const del = useDeskMutation(() => api.deleteRefSlot({ characterId: c.id, slotKey }), onNotice);
  if (!slot) return null;
  const img = mediaSrc(slot.imageKey);
  const cand = mediaSrc(slot.candidateKey);
  const inBaseline = c.identityBaselineVersion != null && slot.filled &&
    (c.refsFilled > 0) && slot.imageKey != null;
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface2)] p-1.5" id={`ref-slot-${c.id}-${slot.slotKey}`}>
      <div className="mb-1 flex items-center justify-between gap-1">
        <p className="text-xs font-medium leading-tight">{slot.label}</p>
        {cand ? (
          <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold text-black" style={{ background: "var(--amber)" }}>候选待审</span>
        ) : slot.filled && slot.mediaMissing ? (
          <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold text-black" style={{ background: "var(--amber-soft)", color: "var(--amber)", border: "1px solid var(--amber)" }}>定版记录 · 原图缺失</span>
        ) : slot.filled ? (
          <span className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold" style={{ background: "#dcead3", color: "#3d7a3a" }}>已定版</span>
        ) : null}
      </div>
      <div className="relative">
        {cand ? (
          <img src={cand} alt={`${slot.label}候选图`} className="aspect-square w-full rounded border-2 border-[var(--amber)] object-cover" />
        ) : img ? (
          <img src={img} alt={`${slot.label}定版图`} className="aspect-square w-full rounded object-cover" />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center rounded border border-dashed border-[var(--border)] px-1 text-center text-xs text-[var(--dim)]">
            {slot.filled ? "已定版（原台内图未随包提供）" : "未定版"}
          </div>
        )}
      </div>
      {slot.genStatus === "running" ? (
        <>
          <p className="mt-1 text-center text-[10px] font-medium text-[var(--amber)]">
            生成中…（以主定锚点图为第一参照）{slot.genStartedAt ? ` · 始于 ${new Date(slot.genStartedAt).toLocaleString("zh-CN", { hour12: false })}` : ""}
          </p>
          {slot.genStaleUnknown && !locked ? (
            <ReleaseStuckRefGen characterId={c.id} slotKey={slot.slotKey} label={slot.label} onNotice={onNotice} />
          ) : null}
        </>
      ) : null}
      {slot.genNote ? <p className="mt-1 break-words text-center text-[10px] leading-relaxed text-[var(--dim)]">{slot.genNote}</p> : null}
      {slot.genStatus === "done" && cand ? <p className="mt-1 text-center text-[10px] text-[var(--amber)]">候选图待审核 · 通过后才定版</p> : null}
      {slot.genStatus === "failed" ? <p className="mt-1 break-words text-center text-[10px] text-[var(--accent)]">生成失败{slot.genError ? `：${slot.genError}` : ""}</p> : null}
      {!locked ? (
        <div className="mt-1.5">
          {cand ? (
            <div className="flex gap-1">
              <button type="button" className={btnSmall + " h-7 flex-1"} aria-label={`${slot.label}候选图通过定版`} onClick={() => review.mutate(true)}>通过·定版</button>
              <button type="button" className={btnSmall + " h-7 flex-1"} aria-label={`${slot.label}候选图重拍`} onClick={() => review.mutate(false)}>重拍</button>
            </div>
          ) : (
            <div className="space-y-1">
              <input
                aria-label={`${slot.label}生成提示词`}
                className="h-7 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 text-xs text-[var(--text)]"
                placeholder="生成提示词（可空）"
                value={slotPrompt}
                onChange={(e) => setSlotPrompt(e.target.value)}
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  className="inline-flex h-7 flex-1 items-center justify-center rounded px-1 text-xs font-medium disabled:opacity-40"
                  style={{ background: "var(--ink)", color: "var(--ink-text)" }}
                  aria-label={`再生成一张${slot.label}`}
                  disabled={gen.isPending || slot.genStatus === "running"}
                  onClick={() => gen.mutate(undefined)}
                >
                  {gen.isPending || slot.genStatus === "running" ? "生成中…" : "再生成一张"}
                </button>
                <DropImage
                  label="换图"
                  className="h-7 flex-1 cursor-pointer rounded border border-[var(--border)] bg-[var(--surface)]"
                  onFile={(f) => upload.mutate(f)}
                />
                {slot.filled ? (
                  <button type="button" className={btnSmall + " h-7"} aria-label={`清空${slot.label}定版图`} onClick={() => clear.mutate(undefined)}>清空</button>
                ) : null}
              </div>
              {slot.custom ? (
                <button type="button" className={btnSmall + " w-full"} aria-label={`删除自定义格${slot.label}`} onClick={() => del.mutate(undefined)}>删除格</button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {inBaseline ? <p className="sr-only">已纳入身份基准</p> : null}
    </div>
  );
}
