// 导演台数据模型。projects / characters / scenes / shots / results /
// gen_jobs / canvas_nodes / canvas_links。
// 人物档案字段多且随版本扩展：核心列（姓名、档案状态、版本、参考完整度）
// 单独成列供列表查询，其余档案原文以 JSON 存 characters.data，不改写。

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  targetSeconds: real("target_seconds").notNull().default(30),
  aspect: text("aspect").notNull().default("1392×640"),
  fps: integer("fps").notNull().default(24),
  exportSpec: text("export_spec")
    .notNull()
    .default("H.264 yuv420p · 恒定帧率 · 可导入剪映"),
  defaultQuality: text("default_quality").notNull().default("720P"),
  locked: integer("locked").notNull().default(0),
  lockedAt: integer("locked_at"),
  version: integer("version").notNull().default(1),
  scriptTitle: text("script_title").notNull().default(""),
  scriptText: text("script_text").notNull().default(""),
  scriptNotes: text("script_notes").notNull().default(""),
  scriptStatus: text("script_status").notNull().default("draft"),
  rules: text("rules").notNull().default(""),
  assemblyConfirmed: integer("assembly_confirmed").notNull().default(0),
  finalVideoKey: text("final_video_key"),
  finalExportedAt: integer("final_exported_at"),
  finalSignature: text("final_signature").notNull().default(""),
  chainStrict: integer("chain_strict").notNull().default(1),
  history: text("history").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const characters = sqliteTable("characters", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull().default(""),
  archiveStatus: text("archive_status").notNull().default("draft"),
  archiveVersion: integer("archive_version").notNull().default(1),
  refsFilled: integer("refs_filled").notNull().default(0),
  refsTotal: integer("refs_total").notNull().default(28),
  imageKey: text("image_key"),
  canvasX: real("canvas_x"),
  canvasY: real("canvas_y"),
  data: text("data").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const scenes = sqliteTable("scenes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  name: text("name").notNull().default(""),
  location: text("location").notNull().default(""),
  timeOfDay: text("time_of_day").notNull().default(""),
  lighting: text("lighting").notNull().default(""),
  atmosphere: text("atmosphere").notNull().default(""),
  palette: text("palette").notNull().default(""),
  notes: text("notes").notNull().default(""),
  imageKey: text("image_key"),
  // 场景图生成（纯场景 / 参照人物结合生成）：候选图待审核，通过后才
  // 设为场景图，绝不直接覆盖；生成状态/尝试标识/参照说明与人物参考图
  // 生成同一口径（超时未回填只标待核查，确认终止后显式释放）。
  candidateKey: text("candidate_key"),
  genStatus: text("gen_status").notNull().default("none"),
  genError: text("gen_error").notNull().default(""),
  genAttemptId: text("gen_attempt_id"),
  genStartedAt: integer("gen_started_at"),
  genNote: text("gen_note").notNull().default(""),
  genPrompt: text("gen_prompt").notNull().default(""),
  genCharIds: text("gen_char_ids").notNull().default("[]"),
  canvasX: real("canvas_x"),
  canvasY: real("canvas_y"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const shots = sqliteTable("shots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  durationSec: real("duration_sec").notNull().default(10),
  framing: text("framing").notNull().default(""),
  cameraMove: text("camera_move").notNull().default(""),
  characterId: integer("character_id"),
  sceneId: integer("scene_id"),
  // 分镜多选真源（JSON 数组）：同一镜可多选人物同处一场景被参照、
  // 也可多选场景，不同分镜各自独立组合。characterId/sceneId 保留为
  // 数组第一项的同步镜像，供画布连线与旧逻辑兼容读取，不再是真源。
  characterIds: text("character_ids").notNull().default("[]"),
  sceneIds: text("scene_ids").notNull().default("[]"),
  characterPosition: text("character_position").notNull().default(""),
  startState: text("start_state").notNull().default(""),
  action: text("action").notNull().default(""),
  endState: text("end_state").notNull().default(""),
  handoffNote: text("handoff_note").notNull().default(""),
  firstFrameLabel: text("first_frame_label").notNull().default(""),
  firstFrameKey: text("first_frame_key"),
  firstFrameMissing: integer("first_frame_missing").notNull().default(0),
  lastFrameLabel: text("last_frame_label").notNull().default(""),
  lastFrameKey: text("last_frame_key"),
  lastFrameMissing: integer("last_frame_missing").notNull().default(0),
  videoQuality: text("video_quality"),
  promptEn: text("prompt_en").notNull().default(""),
  canvasX: real("canvas_x"),
  canvasY: real("canvas_y"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const results = sqliteTable("results", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  shotId: integer("shot_id").notNull(),
  versionNumber: integer("version_number").notNull().default(1),
  label: text("label").notNull().default(""),
  genStatus: text("gen_status").notNull().default("none"),
  genError: text("gen_error").notNull().default(""),
  videoKey: text("video_key"),
  // 成片字节的 SHA-256（回填时落库）：重拍回填若与同镜任一其他版本的
  // 成片 SHA 完全相同，判定为复用旧片并拒绝，防止「重拍还是同一条片」。
  videoSha: text("video_sha"),
  videoMissing: integer("video_missing").notNull().default(0),
  actualLastFrameKey: text("actual_last_frame_key"),
  lastFrameMissing: integer("last_frame_missing").notNull().default(0),
  qcStatus: text("qc_status").notNull().default("pending"),
  qcNote: text("qc_note").notNull().default(""),
  adopted: integer("adopted").notNull().default(0),
  includeInEdit: integer("include_in_edit").notNull().default(1),
  inPoint: real("in_point").notNull().default(0),
  outPoint: real("out_point"),
  cutType: text("cut_type").notNull().default("直切"),
  videoQuality: text("video_quality"),
  taskSheet: text("task_sheet"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const genJobs = sqliteTable("gen_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  shotId: integer("shot_id"),
  resultId: integer("result_id"),
  characterId: integer("character_id"),
  kind: text("kind").notNull().default("video"),
  status: text("status").notNull().default("dispatched"),
  videoQuality: text("video_quality"),
  detail: text("detail").notNull().default(""),
  error: text("error").notNull().default(""),
  attemptId: text("attempt_id"),
  attemptNo: integer("attempt_no").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// 视频分片回填暂存：助手生成的大体积成片无法用单次 base64 调用传完，
// 按片存入此表（每片一段 base64），completeGenerationJob 按 upload_id
// 顺序拼装成完整视频 blob 后删除分片行。
export const videoUploadChunks = sqliteTable("video_upload_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  uploadId: text("upload_id").notNull(),
  resultId: integer("result_id").notNull(),
  idx: integer("idx").notNull(),
  data: text("data").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const canvasNodes = sqliteTable("canvas_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  kind: text("kind").notNull().default("image"),
  title: text("title").notNull().default(""),
  note: text("note").notNull().default(""),
  mediaKey: text("media_key"),
  mimeType: text("mime_type"),
  x: real("x").notNull().default(0),
  y: real("y").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const canvasLinks = sqliteTable("canvas_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  fromKind: text("from_kind").notNull(),
  fromId: integer("from_id").notNull(),
  toKind: text("to_kind").notNull(),
  toId: integer("to_id").notNull(),
  role: text("role").notNull().default("reference"),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at").notNull(),
});
