CREATE TABLE IF NOT EXISTS nodes (
  name TEXT PRIMARY KEY,
  display_name TEXT DEFAULT '',
  targets TEXT NOT NULL,
  stream_target TEXT DEFAULT '',
  secret TEXT DEFAULT '',
  client_profile TEXT DEFAULT 'yamby',
  impersonate INTEGER DEFAULT 1,
  header_mode TEXT DEFAULT 'dual',
  stream_mode TEXT DEFAULT 'proxy',
  direct_external INTEGER DEFAULT 0,
  cache_image INTEGER DEFAULT 1,
  tag TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  icon TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  renew_days INTEGER DEFAULT 0,
  remind_before_days INTEGER DEFAULT 0,
  keepalive_at TEXT DEFAULT '',
  auto_watch INTEGER DEFAULT 0,
  watch_username TEXT DEFAULT '',
  watch_password TEXT DEFAULT '',
  watch_token TEXT DEFAULT '',
  watch_user_id TEXT DEFAULT '',
  watch_item_id TEXT DEFAULT '',
  watch_seconds INTEGER DEFAULT 300,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_stats (
  node TEXT NOT NULL,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  bytes INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node, day, kind)
);

CREATE TABLE IF NOT EXISTS visitor_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ip TEXT DEFAULT '',
  country TEXT DEFAULT '',
  ua TEXT DEFAULT '',
  method TEXT DEFAULT '',
  path TEXT DEFAULT '',
  status INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS keepalive_state (
  node TEXT PRIMARY KEY,
  anchor_ts INTEGER NOT NULL,
  last_play_ts INTEGER DEFAULT 0,
  last_notify_day TEXT DEFAULT '',
  notify_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watch_sessions (
  node TEXT NOT NULL,
  day TEXT NOT NULL,
  session_key TEXT NOT NULL,
  user_id TEXT DEFAULT '',
  item_id TEXT DEFAULT '',
  play_session_id TEXT DEFAULT '',
  device_id TEXT DEFAULT '',
  first_ts INTEGER NOT NULL,
  last_ts INTEGER NOT NULL,
  max_position_seconds INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  event_count INTEGER DEFAULT 0,
  counted INTEGER DEFAULT 0,
  synthetic INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node, day, session_key)
);

CREATE TABLE IF NOT EXISTS dns_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  name TEXT NOT NULL,
  record_type TEXT NOT NULL,
  old_value TEXT DEFAULT '',
  new_value TEXT DEFAULT '',
  operator TEXT DEFAULT 'admin'
);

CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_sort ON nodes(sort_order, name);
CREATE INDEX IF NOT EXISTS idx_visitor_logs_ts ON visitor_logs(ts);
CREATE INDEX IF NOT EXISTS idx_request_stats_day ON request_stats(day);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_day ON watch_sessions(day, counted);
CREATE INDEX IF NOT EXISTS idx_watch_sessions_last ON watch_sessions(last_ts);
