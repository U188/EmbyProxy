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
  auto_watch INTEGER DEFAULT 0,
  renew_days INTEGER DEFAULT 0,
  remind_before_days INTEGER DEFAULT 0,
  keepalive_at TEXT DEFAULT '',
  emby_user TEXT DEFAULT '',
  emby_password TEXT DEFAULT '',
  emby_user_id TEXT DEFAULT '',
  emby_access_token TEXT DEFAULT '',
  emby_auth_profile TEXT DEFAULT '',
  emby_play_id TEXT DEFAULT '',
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

CREATE TABLE IF NOT EXISTS watch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  ts INTEGER NOT NULL,
  source TEXT DEFAULT 'manual',
  note TEXT DEFAULT '',
  duration_sec INTEGER DEFAULT 0,
  started_at INTEGER DEFAULT 0,
  ended_at INTEGER DEFAULT 0,
  title TEXT DEFAULT '',
  item_id TEXT DEFAULT ''
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

CREATE INDEX IF NOT EXISTS idx_nodes_sort ON nodes(sort_order, name);
CREATE INDEX IF NOT EXISTS idx_visitor_logs_ts ON visitor_logs(ts);
CREATE INDEX IF NOT EXISTS idx_request_stats_day ON request_stats(day);
CREATE INDEX IF NOT EXISTS idx_watch_logs_ts ON watch_logs(ts);
CREATE INDEX IF NOT EXISTS idx_watch_logs_node_ts ON watch_logs(node, ts);


CREATE TABLE IF NOT EXISTS sim_watch_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  source TEXT DEFAULT 'manual',
  note TEXT DEFAULT '',
  title TEXT DEFAULT '',
  item_id TEXT DEFAULT '',
  media_source_id TEXT DEFAULT '',
  play_session_id TEXT DEFAULT '',
  base_url TEXT DEFAULT '',
  access_token TEXT DEFAULT '',
  user_id TEXT DEFAULT '',
  device_id TEXT DEFAULT '',
  device_name TEXT DEFAULT '',
  client_profile TEXT DEFAULT '',
  target_duration_sec INTEGER DEFAULT 300,
  started_at INTEGER NOT NULL,
  last_tick_at INTEGER DEFAULT 0,
  next_tick_at INTEGER DEFAULT 0,
  tick_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'running',
  error TEXT DEFAULT '',
  notify_attempts INTEGER DEFAULT 0,
  remain_days INTEGER DEFAULT 0,
  renew_days INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sim_watch_sessions_status_next ON sim_watch_sessions(status, next_tick_at);
UPDATE sim_watch_sessions
SET status = 'failed', error = 'duplicate active session removed during migration'
WHERE status IN ('starting', 'running')
  AND id NOT IN (
    SELECT MAX(id) FROM sim_watch_sessions
    WHERE status IN ('starting', 'running')
    GROUP BY node
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_watch_sessions_one_active_node
ON sim_watch_sessions(node)
WHERE status IN ('starting', 'running');
