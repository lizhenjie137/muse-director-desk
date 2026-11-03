DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_seconds REAL NOT NULL DEFAULT 30,
  aspect TEXT NOT NULL DEFAULT '1392×640',
  fps INTEGER NOT NULL DEFAULT 24,
  export_spec TEXT NOT NULL DEFAULT 'H.264 yuv420p · 恒定帧率 · 可导入剪映',
  default_quality TEXT NOT NULL DEFAULT '720P',
  locked INTEGER NOT NULL DEFAULT 0,
  locked_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  script_title TEXT NOT NULL DEFAULT '',
  script_text TEXT NOT NULL DEFAULT '',
  script_notes TEXT NOT NULL DEFAULT '',
  script_status TEXT NOT NULL DEFAULT 'draft',
  rules TEXT NOT NULL DEFAULT '',
  assembly_confirmed INTEGER NOT NULL DEFAULT 0,
  final_video_key TEXT,
  final_exported_at INTEGER,
  final_signature TEXT NOT NULL DEFAULT '',
  chain_strict INTEGER NOT NULL DEFAULT 1,
  history TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  archive_status TEXT NOT NULL DEFAULT 'draft',
  archive_version INTEGER NOT NULL DEFAULT 1,
  refs_filled INTEGER NOT NULL DEFAULT 0,
  refs_total INTEGER NOT NULL DEFAULT 28,
  image_key TEXT,
  canvas_x REAL,
  canvas_y REAL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE scenes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  time_of_day TEXT NOT NULL DEFAULT '',
  lighting TEXT NOT NULL DEFAULT '',
  atmosphere TEXT NOT NULL DEFAULT '',
  palette TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  image_key TEXT,
  candidate_key TEXT,
  gen_status TEXT NOT NULL DEFAULT 'none',
  gen_error TEXT NOT NULL DEFAULT '',
  gen_attempt_id TEXT,
  gen_started_at INTEGER,
  gen_note TEXT NOT NULL DEFAULT '',
  gen_prompt TEXT NOT NULL DEFAULT '',
  gen_char_ids TEXT NOT NULL DEFAULT '[]',
  canvas_x REAL,
  canvas_y REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 10,
  framing TEXT NOT NULL DEFAULT '',
  camera_move TEXT NOT NULL DEFAULT '',
  character_id INTEGER,
  scene_id INTEGER,
  character_position TEXT NOT NULL DEFAULT '',
  start_state TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  end_state TEXT NOT NULL DEFAULT '',
  handoff_note TEXT NOT NULL DEFAULT '',
  first_frame_label TEXT NOT NULL DEFAULT '',
  first_frame_key TEXT,
  first_frame_missing INTEGER NOT NULL DEFAULT 0,
  last_frame_label TEXT NOT NULL DEFAULT '',
  last_frame_key TEXT,
  last_frame_missing INTEGER NOT NULL DEFAULT 0,
  video_quality TEXT,
  prompt_en TEXT NOT NULL DEFAULT '',
  canvas_x REAL,
  canvas_y REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  shot_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT '',
  gen_status TEXT NOT NULL DEFAULT 'none',
  gen_error TEXT NOT NULL DEFAULT '',
  video_key TEXT,
  video_sha TEXT,
  video_missing INTEGER NOT NULL DEFAULT 0,
  actual_last_frame_key TEXT,
  last_frame_missing INTEGER NOT NULL DEFAULT 0,
  qc_status TEXT NOT NULL DEFAULT 'pending',
  qc_note TEXT NOT NULL DEFAULT '',
  adopted INTEGER NOT NULL DEFAULT 0,
  include_in_edit INTEGER NOT NULL DEFAULT 1,
  in_point REAL NOT NULL DEFAULT 0,
  out_point REAL,
  cut_type TEXT NOT NULL DEFAULT '直切',
  video_quality TEXT,
  task_sheet TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE gen_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  shot_id INTEGER,
  result_id INTEGER,
  character_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'video',
  status TEXT NOT NULL DEFAULT 'dispatched',
  video_quality TEXT,
  detail TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  attempt_id TEXT,
  attempt_no INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE video_upload_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id TEXT NOT NULL,
  result_id INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE canvas_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'image',
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  media_key TEXT,
  mime_type TEXT,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE canvas_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  from_kind TEXT NOT NULL,
  from_id INTEGER NOT NULL,
  to_kind TEXT NOT NULL,
  to_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'reference',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
