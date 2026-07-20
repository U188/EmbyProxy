const BUILD_VERSION = "0.5.13";
const DEFAULT_MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETRY_BODY_BYTES = 16 * 1024 * 1024;
const PROXY_NODE_CACHE_TTL_MS = 10000;
const DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS = 2500;
const TARGET_HEALTH_SUCCESS_TTL_MS = 5 * 60 * 1000;
const TARGET_HEALTH_FAILURE_TTL_MS = 30 * 1000;
const PLAYBACK_AUX_WRITE_INTERVAL_MS = 60 * 1000;
const SENSITIVE_QUERY_KEYS = new Set([
  "api_key", "apikey", "token", "access_token",
  "authorization", "x-authorization", "x-emby-authorization", "x-mediabrowser-authorization",
  "x-emby-token", "x-mediabrowser-token"
]);
const DEFAULT_CLIENT_PROFILE = "yamby";
const DEFAULT_NODE_ICON = "🎬";
const IDENTITY_KEY = "system:upstream_identity";
const SCHEMA_VERSION_KEY = "system:schema_version";
const SCHEMA_VERSION = "0.5.13";
const ANDROID_DEVICE_NAME = "OnePlus-PKG110";
const SIMULATED_WATCH_DURATION_MIN_SEC = 300;
// The minute cron can add almost 60 seconds before the stop event is sent.
const SIMULATED_WATCH_DURATION_MAX_SEC = 390;
const AUTO_WATCH_FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;
const DEFAULT_AUTO_WATCH_MAX_CONCURRENCY = 2;
const PERFORMANCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLIENT_PROFILES = [
  { id: "yamby", label: "Yamby Android", ua: "Yamby/2.0.4.6(Android", client: "Yamby", version: "2.0.4.6", device: ANDROID_DEVICE_NAME, authStyle: "yamby", idFormat: "uuid" },
  { id: "hills_android", label: "Hills Android", ua: "Hills/1.7.2 (android; 15)", client: "Hills", version: "1.7.2", device: ANDROID_DEVICE_NAME, authStyle: "hills", idLength: 16 },
  { id: "hills_windows", label: "Hills Windows", ua: "Hills Windows/1.3.1 (windows; 19041.vb_release.191206-1406)", client: "Hills Windows", version: "1.3.1", device: "", authStyle: "hills", idLength: 32, devicePrefix: "DESKTOP-" }
];

let schemaReady;
let identityStatePromise;
let traceEgressCache = { expires: 0, data: null };
let traceEgressPromise;
let nodeHostMapCache = { expires: 0, map: null };
const proxyNodeCache = new Map();
const targetHealthCache = new Map();
const playbackVisitorSampleCache = new Map();
const playbackKeepaliveWriteCache = new Map();
const playbackRouteWriteCache = new Map();

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (err) {
      return json({ ok: false, error: errMessage(err) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledTasks(env));
  }
};

async function runScheduledTasks(env, now = Date.now()) {
  await ensureSchema(env);
  const minute = new Date(now + 8 * 60 * 60 * 1000).getUTCMinutes();
  const tasks = [processWatchSessions(env, now)];
  if (minute === 0) {
    tasks.push(
      cleanOldVisitorLogs(env),
      cleanOldWatchLogs(env),
      cleanOldWatchSessions(env),
      cleanOldPerformanceMetrics(env),
      runAutoSimulatedWatches(env),
      sendTelegramDailyIfDue(env)
    );
  } else if (minute % 10 === 0) {
    tasks.push(runAutoSimulatedWatches(env));
  }
  return Promise.all(tasks);
}

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  const surface = requestSurface(url, env);

  if (url.pathname === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/__client_rtt__") {
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "no-store" }
    });
  }
  if (url.pathname === "/" || url.pathname === "/admin" || url.pathname === "/admin/") {
    if (!surface.admin) return text("Not found", 404);
    const nonce = randomHex(32);
    return adminPage(adminHTML(env, nonce), nonce);
  }
  if (url.pathname === "/api/tg-webhook" && request.method === "POST") {
    if (!surface.admin) return text("Not found", 404);
    await ensureSchema(env);
    return handleTelegramWebhook(request, env);
  }
  if (url.pathname === "/api/health") {
    return json({ ok: true, version: BUILD_VERSION });
  }
  if (url.pathname.startsWith("/api/")) {
    if (!surface.admin) return json({ ok: false, error: "API not found" }, 404);
    await ensureSchema(env);
    return handleAPI(request, env, ctx);
  }

  if (!surface.proxy) return text("Not found", 404);
  return handleProxy(request, env, ctx);
}

function requestSurface(url, env = {}) {
  const host = cleanString(url?.hostname).toLowerCase().replace(/\.$/, "");
  const adminHost = cleanString(env.CF_DOMAIN).toLowerCase().replace(/\.$/, "");
  const dispatchHost = cleanString(env.CF_DNS_DOMAIN).toLowerCase().replace(/\.$/, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const separated = Boolean(adminHost && dispatchHost && adminHost !== dispatchHost);
  if (local || !separated) return { admin: true, proxy: true };
  return { admin: host === adminHost, proxy: host === dispatchHost };
}

async function ensureSchema(env) {
  if (!env.DB) {
    throw new Error("D1 binding DB is not configured");
  }
  if (!schemaReady) {
    schemaReady = initializeSchema(env).catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  }
  return schemaReady;
}

async function initializeSchema(env) {
  if (await schemaVersionIsCurrent(env)) {
    return;
  }
  const statements = [
    `CREATE TABLE IF NOT EXISTS nodes (
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
      stream_strategy TEXT DEFAULT 'auto',
      stream_timeout_ms INTEGER DEFAULT 2500,
      watch_window_start INTEGER DEFAULT 0,
      watch_window_end INTEGER DEFAULT 24,
      watch_daily_limit INTEGER DEFAULT 1,
      watch_content_type TEXT DEFAULT 'mixed',
      watch_failure_backoff_min INTEGER DEFAULT 360,
      watch_duration_min_sec INTEGER DEFAULT 300,
      watch_duration_max_sec INTEGER DEFAULT 390,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS system_config (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS request_stats (
      node TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER DEFAULT 0,
      bytes INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (node, day, kind)
    )`,
    `CREATE TABLE IF NOT EXISTS visitor_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node TEXT NOT NULL,
      ts INTEGER NOT NULL,
      ip TEXT DEFAULT '',
      country TEXT DEFAULT '',
      ua TEXT DEFAULT '',
      outbound_profile TEXT DEFAULT '',
      outbound_ua TEXT DEFAULT '',
      outbound_device TEXT DEFAULT '',
      method TEXT DEFAULT '',
      path TEXT DEFAULT '',
      status INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS keepalive_state (
      node TEXT PRIMARY KEY,
      anchor_ts INTEGER NOT NULL,
      last_play_ts INTEGER DEFAULT 0,
      last_notify_day TEXT DEFAULT '',
      notify_count INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS playback_route_state (
      node TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS watch_logs (
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
    )`,
    `CREATE TABLE IF NOT EXISTS sim_watch_sessions (
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
    )`,
    `CREATE TABLE IF NOT EXISTS performance_metrics (
      node TEXT NOT NULL,
      bucket_ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      request_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      failover_count INTEGER DEFAULT 0,
      node_ms_sum REAL DEFAULT 0,
      upstream_ms_sum REAL DEFAULT 0,
      rewrite_ms_sum REAL DEFAULT 0,
      total_ms_sum REAL DEFAULT 0,
      total_ms_max REAL DEFAULT 0,
      b100 INTEGER DEFAULT 0,
      b250 INTEGER DEFAULT 0,
      b500 INTEGER DEFAULT 0,
      b1000 INTEGER DEFAULT 0,
      b2500 INTEGER DEFAULT 0,
      b5000 INTEGER DEFAULT 0,
      bslow INTEGER DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (node, bucket_ts, kind)
    )`,
    `CREATE TABLE IF NOT EXISTS line_performance (
      node TEXT NOT NULL,
      bucket_ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      line_key TEXT NOT NULL,
      line_label TEXT DEFAULT '',
      attempts INTEGER DEFAULT 0,
      successes INTEGER DEFAULT 0,
      failures INTEGER DEFAULT 0,
      latency_ms_sum REAL DEFAULT 0,
      last_latency_ms REAL DEFAULT 0,
      transfer_count INTEGER DEFAULT 0,
      transfer_bytes INTEGER DEFAULT 0,
      transfer_ms_sum REAL DEFAULT 0,
      last_bps REAL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (node, bucket_ts, kind, line_key)
    )`,
    `CREATE TABLE IF NOT EXISTS dns_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      name TEXT NOT NULL,
      record_type TEXT NOT NULL,
      old_value TEXT DEFAULT '',
      new_value TEXT DEFAULT '',
      operator TEXT DEFAULT 'admin'
    )`,
    `CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_nodes_sort ON nodes(sort_order, name)`,
    `CREATE INDEX IF NOT EXISTS idx_visitor_logs_ts ON visitor_logs(ts)`,
    `CREATE INDEX IF NOT EXISTS idx_request_stats_day ON request_stats(day)`,
    `CREATE INDEX IF NOT EXISTS idx_watch_logs_ts ON watch_logs(ts)`,
    `CREATE INDEX IF NOT EXISTS idx_watch_logs_node_ts ON watch_logs(node, ts)`,
    `CREATE INDEX IF NOT EXISTS idx_performance_metrics_bucket ON performance_metrics(bucket_ts)`,
    `CREATE INDEX IF NOT EXISTS idx_line_performance_bucket ON line_performance(bucket_ts)`,
    `CREATE INDEX IF NOT EXISTS idx_line_performance_node_kind_updated ON line_performance(node, kind, updated_at)`
  ];
  if (typeof env.DB.batch === "function") {
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  } else {
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }
  }
  await ensureColumns(env, "nodes", {
    display_name: "TEXT DEFAULT ''",
    targets: "TEXT NOT NULL DEFAULT '[]'",
    stream_target: "TEXT DEFAULT ''",
    secret: "TEXT DEFAULT ''",
    client_profile: "TEXT DEFAULT 'yamby'",
    impersonate: "INTEGER DEFAULT 1",
    header_mode: "TEXT DEFAULT 'dual'",
    stream_mode: "TEXT DEFAULT 'proxy'",
    direct_external: "INTEGER DEFAULT 0",
    cache_image: "INTEGER DEFAULT 1",
    tag: "TEXT DEFAULT ''",
    remark: "TEXT DEFAULT ''",
    icon: "TEXT DEFAULT ''",
    sort_order: "INTEGER DEFAULT 0",
    enabled: "INTEGER DEFAULT 1",
    auto_watch: "INTEGER DEFAULT 0",
    renew_days: "INTEGER DEFAULT 0",
    remind_before_days: "INTEGER DEFAULT 0",
    keepalive_at: "TEXT DEFAULT ''",
    emby_user: "TEXT DEFAULT ''",
    emby_password: "TEXT DEFAULT ''",
    emby_user_id: "TEXT DEFAULT ''",
    emby_access_token: "TEXT DEFAULT ''",
    emby_auth_profile: "TEXT DEFAULT ''",
    emby_play_id: "TEXT DEFAULT ''",
    stream_strategy: "TEXT DEFAULT 'auto'",
    stream_timeout_ms: "INTEGER DEFAULT 2500",
    watch_window_start: "INTEGER DEFAULT 0",
    watch_window_end: "INTEGER DEFAULT 24",
    watch_daily_limit: "INTEGER DEFAULT 1",
    watch_content_type: "TEXT DEFAULT 'mixed'",
    watch_failure_backoff_min: "INTEGER DEFAULT 360",
    watch_duration_min_sec: "INTEGER DEFAULT 300",
    watch_duration_max_sec: "INTEGER DEFAULT 390",
    created_at: "INTEGER NOT NULL DEFAULT 0",
    updated_at: "INTEGER NOT NULL DEFAULT 0"
  });
  await ensureColumns(env, "visitor_logs", {
    ip: "TEXT DEFAULT ''",
    country: "TEXT DEFAULT ''",
    ua: "TEXT DEFAULT ''",
    outbound_profile: "TEXT DEFAULT ''",
    outbound_ua: "TEXT DEFAULT ''",
    outbound_device: "TEXT DEFAULT ''",
    method: "TEXT DEFAULT ''",
    path: "TEXT DEFAULT ''",
    status: "INTEGER DEFAULT 0"
  });
  await ensureColumns(env, "request_stats", {
    bytes: "INTEGER DEFAULT 0",
    updated_at: "INTEGER NOT NULL DEFAULT 0"
  });
  await ensureColumns(env, "line_performance", {
    transfer_count: "INTEGER DEFAULT 0",
    transfer_bytes: "INTEGER DEFAULT 0",
    transfer_ms_sum: "REAL DEFAULT 0",
    last_bps: "REAL DEFAULT 0"
  });
  await ensureColumns(env, "watch_logs", {
    display_name: "TEXT DEFAULT ''",
    source: "TEXT DEFAULT 'manual'",
    note: "TEXT DEFAULT ''",
    duration_sec: "INTEGER DEFAULT 0",
    started_at: "INTEGER DEFAULT 0",
    ended_at: "INTEGER DEFAULT 0",
    title: "TEXT DEFAULT ''",
    item_id: "TEXT DEFAULT ''"
  });
  await ensureColumns(env, "sim_watch_sessions", {
    display_name: "TEXT DEFAULT ''",
    source: "TEXT DEFAULT 'manual'",
    note: "TEXT DEFAULT ''",
    title: "TEXT DEFAULT ''",
    item_id: "TEXT DEFAULT ''",
    media_source_id: "TEXT DEFAULT ''",
    play_session_id: "TEXT DEFAULT ''",
    base_url: "TEXT DEFAULT ''",
    access_token: "TEXT DEFAULT ''",
    user_id: "TEXT DEFAULT ''",
    device_id: "TEXT DEFAULT ''",
    device_name: "TEXT DEFAULT ''",
    client_profile: "TEXT DEFAULT ''",
    target_duration_sec: "INTEGER DEFAULT 300",
    last_tick_at: "INTEGER DEFAULT 0",
    next_tick_at: "INTEGER DEFAULT 0",
    tick_count: "INTEGER DEFAULT 0",
    status: "TEXT DEFAULT 'running'",
    error: "TEXT DEFAULT ''",
    notify_attempts: "INTEGER DEFAULT 0",
    remain_days: "INTEGER DEFAULT 0",
    renew_days: "INTEGER DEFAULT 0"
  });
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sim_watch_sessions_status_next ON sim_watch_sessions(status, next_tick_at)`).run();
  await env.DB.prepare(`
    UPDATE sim_watch_sessions
    SET status = 'failed', error = 'duplicate active session removed during migration', access_token = ''
    WHERE status IN ('starting', 'running')
      AND id NOT IN (
        SELECT MAX(id) FROM sim_watch_sessions
        WHERE status IN ('starting', 'running')
        GROUP BY node
      )
  `).run();
  await env.DB.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_watch_sessions_one_active_node
    ON sim_watch_sessions(node)
    WHERE status IN ('starting', 'running')
  `).run();
  await env.DB.prepare(`
    INSERT INTO system_config (k, v, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
  `).bind(SCHEMA_VERSION_KEY, SCHEMA_VERSION, Date.now()).run();
}

async function schemaVersionIsCurrent(env) {
  try {
    const row = await env.DB.prepare(`SELECT v FROM system_config WHERE k = ?`).bind(SCHEMA_VERSION_KEY).first();
    return row?.v === SCHEMA_VERSION;
  } catch {
    return false;
  }
}

async function ensureColumns(env, table, columns) {
  const existing = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  const names = new Set((existing.results || []).map((row) => row.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (names.has(name)) {
      continue;
    }
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
  }
}

async function handleAPI(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/api/health") {
    return json({ ok: true, version: BUILD_VERSION });
  }

  const auth = checkAdmin(request, env);
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, auth.status);
  }

  if (url.pathname === "/api/trace" && request.method === "GET") {
    return json(await getTraceInfo(request, env, ctx));
  }
  if (url.pathname === "/api/analytics" && request.method === "GET") {
    return json(await getAnalytics(env));
  }
  if (url.pathname === "/api/deploy" && request.method === "POST") {
    const body = await readJSON(request);
    return json(await deployWorkerCode(env, body));
  }
  if (url.pathname === "/api/get-dns" && request.method === "GET") {
    return json(await getDNSRecordsCompat(env));
  }
  if (url.pathname === "/api/update-dns" && request.method === "POST") {
    const body = await readJSON(request);
    return json(await updateDNSRecordsCompat(env, body));
  }
  if (url.pathname === "/api/get-custom-api-ips" && request.method === "GET") {
    return json(await getCustomAPIIPs(url.searchParams.get("url") || ""));
  }
  if (url.pathname === "/api/get-remote-ips" && request.method === "GET") {
    return json(await getRemoteIPs(env, url.searchParams.get("type") || "all"));
  }
  if (url.pathname === "/api/keepalive" && request.method === "GET") {
    return json({ ok: true, items: await getKeepaliveStatuses(env) });
  }
  if (url.pathname === "/api/keepalive/reset" && request.method === "POST") {
    const body = await readJSON(request);
    return json(await resetKeepalive(env, body, ctx));
  }
  if (url.pathname === "/api/watch-logs" && request.method === "GET") {
    const days = Number(url.searchParams.get("days") || 3);
    const limit = Number(url.searchParams.get("limit") || 100);
    return json({ ok: true, items: await listWatchLogs(env, { days, limit }) });
  }
  if (url.pathname === "/api/nodes" && request.method === "GET") {
    return json({ ok: true, nodes: await listNodesWithKeepalive(env) });
  }
  if (url.pathname === "/api/nodes" && request.method === "POST") {
    const body = await readJSON(request);
    const saved = await saveNode(env, body);
    return json({ ok: true, node: saved });
  }
  if (url.pathname.startsWith("/api/nodes/") && request.method === "DELETE") {
    const name = decodeURIComponent(url.pathname.slice("/api/nodes/".length));
    await deleteNode(env, name);
    return json({ ok: true });
  }
  if (url.pathname === "/api/nodes/reorder" && request.method === "POST") {
    const body = await readJSON(request);
    await reorderNodes(env, Array.isArray(body.names) ? body.names : []);
    return json({ ok: true });
  }
  if (url.pathname === "/api/export" && request.method === "GET") {
    return json({ ok: true, version: BUILD_VERSION, nodes: await listNodes(env) });
  }
  if (url.pathname === "/api/import" && request.method === "POST") {
    const body = await readJSON(request);
    const nodes = Array.isArray(body.nodes) ? body.nodes : [];
    for (const node of nodes) {
      await saveNode(env, node);
    }
    return json({ ok: true, count: nodes.length });
  }
  if (url.pathname === "/api/stats" && request.method === "GET") {
    return json({ ok: true, stats: await getStats(env) });
  }
  if (url.pathname === "/api/performance" && request.method === "GET") {
    const hours = Number(url.searchParams.get("hours") || 24);
    return json({ ok: true, performance: await getPerformanceMetrics(env, hours) });
  }
  if (url.pathname === "/api/stream-health" && request.method === "POST") {
    const body = await readJSON(request);
    return json(await checkNodeStreamHealth(env, body.name));
  }
  if (url.pathname === "/api/ping-node" && request.method === "GET") {
    return json(await pingTargetCompat(url.searchParams.get("url") || ""));
  }
  if (url.pathname === "/api/ping-node" && request.method === "POST") {
    const body = await readJSON(request);
    return json(await pingTarget(body.target));
  }
  if (url.pathname === "/api/preferred-ips" && request.method === "GET") {
    return json(await getPreferredIPs(env));
  }
  if (url.pathname === "/api/dns-records" && request.method === "GET") {
    return json(await getDNSRecords(env, url.searchParams.get("name") || dnsDomain(env)));
  }
  if (url.pathname === "/api/dns-records" && request.method === "POST") {
    const body = await readJSON(request);
    return json(await updateDNSRecords(env, body));
  }
  if (url.pathname === "/api/cf-traffic" && request.method === "GET") {
    return json(await getCFTraffic(env, url.searchParams.get("range") || "today"));
  }
  if (url.pathname === "/api/telegram/test" && request.method === "POST") {
    return json(await sendTelegramReport(env));
  }
  if (url.pathname === "/api/telegram/webhook/setup" && request.method === "POST") {
    return json(await setupTelegramWebhook(env));
  }
  if (url.pathname === "/api/purge-cache" && request.method === "POST") {
    return json(await purgeZoneCache(env));
  }

  return json({ ok: false, error: "API not found" }, 404);
}

async function handleProxy(request, env, ctx) {
  const inboundURL = new URL(request.url);
  const parsed = parseProxyRoute(inboundURL);
  if (!parsed.name) {
    return text("Missing node name", 400);
  }

  const timing = createProxyTiming();
  const nodeStarted = performanceNow();
  const identityWarmup = getIdentityState(env).catch(() => null);
  const node = await getProxyNode(env, parsed.name);
  timing.node = performanceNow() - nodeStarted;
  if (!node || !node.enabled) {
    return text("Node not found", 404);
  }
  if (node.impersonate !== false) {
    await identityWarmup;
  }

  const route = applyNodeSecret(parsed, node);
  if (!route.ok) {
    return text("Node not found", 404);
  }

  const bodyBuffer = await retryableBody(request);
  if (route.path.startsWith("/__raw__/")) {
    return handleRawProxy(request, env, ctx, node, route.path, bodyBuffer, inboundURL, timing);
  }

  const targets = selectTargets(node, route.path);
  if (targets.length === 0) {
    return text("Node has no target", 502);
  }

  let lastError = "";
  let lastResponse;
  let lastResponseURL;
  for (const target of targets) {
    const targetStarted = performanceNow();
    let outcomeRecorded = false;
    try {
      const targetURL = buildTargetURL(target, route.path, inboundURL.search);
      const shouldRedirect = shouldUseDirectStream(node, request, route.path);
      if (shouldRedirect) {
        trackTargetOutcome(timing, target, "success", 0, route.path);
        return completeProxyResponse(ctx, env, request, node, route.path, Response.redirect(targetURL.toString(), 302), "direct", timing);
      }

      const cacheableImage = node.cacheImage && request.method === "GET" && isImageRequest(route.path) && !hasSensitiveRequestAuth(request);
      const imageCacheKey = cacheableImage ? new Request(inboundURL.toString(), { method: "GET" }) : null;
      if (cacheableImage) {
        const cached = await caches.default.match(imageCacheKey);
        if (cached) {
          return completeProxyResponse(ctx, env, request, node, route.path, cached, "image", timing);
        }
      }

      const upstreamStarted = performanceNow();
      const fetched = await fetchConfiguredTarget(
        request,
        targetURL,
        node,
        bodyBuffer,
        env,
        targets.length > 1 && ["GET", "HEAD"].includes(request.method) ? targetHeaderTimeoutMs(node, route.path, env) : 0
      );
      // Compatibility retries stay on the same line and must not count as failovers.
      timing.attempts++;
      const upstream = fetched.response;
      timing.upstream += performanceNow() - upstreamStarted;
      if (isRetryableStatus(upstream.status)) {
        recordTargetOutcome(node.name, route.path, target, "failure", performanceNow() - targetStarted);
        trackTargetOutcome(timing, target, "failure", performanceNow() - targetStarted, route.path);
        outcomeRecorded = true;
        if (targets.length > 1) {
          discardResponseBody(lastResponse);
          lastResponse = upstream;
          lastResponseURL = targetURL;
          continue;
        }
      }

      const redirectStarted = performanceNow();
      const streamRedirect = await followProxyStreamRedirect(request, upstream, targetURL, node, bodyBuffer, env);
      timing.upstream += performanceNow() - redirectStarted;
      if (streamRedirect) {
        if (streamRedirect.directRangeFallbackURL) {
          if (!outcomeRecorded) {
            recordTargetOutcome(node.name, route.path, target, "success", performanceNow() - targetStarted);
            trackTargetOutcome(timing, target, "success", performanceNow() - targetStarted, route.path);
            outcomeRecorded = true;
          }
          discardResponseBody(streamRedirect.upstream);
          return completeProxyResponse(
            ctx,
            env,
            request,
            node,
            route.path,
            Response.redirect(streamRedirect.directRangeFallbackURL, 307),
            "direct",
            timing
          );
        }
        if (isRetryableStatus(streamRedirect.upstream.status)) {
          if (!outcomeRecorded) {
            recordTargetOutcome(node.name, route.path, target, "failure", performanceNow() - targetStarted);
            trackTargetOutcome(timing, target, "failure", performanceNow() - targetStarted, route.path);
            outcomeRecorded = true;
          }
          if (targets.length > 1) {
            discardResponseBody(lastResponse);
            lastResponse = streamRedirect.upstream;
            lastResponseURL = streamRedirect.targetURL;
            continue;
          }
        }
        if (!outcomeRecorded) {
          recordTargetOutcome(node.name, route.path, target, "success", performanceNow() - targetStarted);
          trackTargetOutcome(timing, target, "success", performanceNow() - targetStarted, route.path);
          outcomeRecorded = true;
        }
        discardResponseBody(lastResponse);
        lastResponse = undefined;
        const response = await timedFinishProxyResponse(streamRedirect.upstream, request, node, streamRedirect.targetURL, inboundURL, env, timing);
        return completeProxyResponse(ctx, env, request, node, route.path, response, requestKind(route.path, response, request), timing);
      }

      if (!outcomeRecorded) {
        recordTargetOutcome(node.name, route.path, target, "success", performanceNow() - targetStarted);
        trackTargetOutcome(timing, target, "success", performanceNow() - targetStarted, route.path);
        outcomeRecorded = true;
      }
      discardResponseBody(lastResponse);
      lastResponse = undefined;
      const response = await timedFinishProxyResponse(upstream, request, node, targetURL, inboundURL, env, timing);
      if (cacheableImage && response.ok) {
        ctx.waitUntil(caches.default.put(imageCacheKey, response.clone()));
      }
      return completeProxyResponse(ctx, env, request, node, route.path, response, requestKind(route.path, response, request), timing);
    } catch (err) {
      if (!outcomeRecorded) {
        recordTargetOutcome(node.name, route.path, target, "failure", performanceNow() - targetStarted);
        trackTargetOutcome(timing, target, "failure", performanceNow() - targetStarted, route.path);
      }
      lastError = errMessage(err);
    }
  }

  if (lastResponse) {
    const response = await timedFinishProxyResponse(lastResponse, request, node, lastResponseURL || buildTargetURL(targets[0], route.path, inboundURL.search), inboundURL, env, timing);
    return completeProxyResponse(ctx, env, request, node, route.path, response, requestKind(route.path, response, request), timing);
  }
  const exhausted = text("Line failover exhausted. Last Error: " + lastError, 502);
  return completeProxyResponse(
    ctx,
    env,
    request,
    node,
    route.path,
    exhausted,
    requestKind(route.path, exhausted, request),
    timing
  );
}

function discardResponseBody(response) {
  if (!response?.body) return;
  try {
    const cancelled = response.body.cancel();
    if (cancelled?.catch) cancelled.catch(() => {});
  } catch {
    // Ignore cleanup failures for discarded failover responses.
  }
}

function parseProxyRoute(url) {
  const raw = url.pathname.split("/").filter(Boolean);
  const segments = raw.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return "";
    }
  });
  const name = normalizeName(segments[0] || "");
  return { segments, name };
}

function applyNodeSecret(parsed, node) {
  let strip = 1;
  if (node.secret) {
    if (parsed.segments[1] !== node.secret) {
      return { ok: false };
    }
    strip = 2;
  }
  const rest = parsed.segments.slice(strip).map(encodeURIComponent).join("/");
  return { ok: true, path: "/" + rest };
}

function selectTargets(node, path) {
  const streaming = Boolean(path && isPlaybackStreamPath(path));
  const targets = streaming && node.streamTarget
    ? splitTargets(node.streamTarget)
    : splitTargets(node.targets);
  const strategy = streaming ? node.streamStrategy : "auto";
  return orderTargetsByHealth(node.name, path, targets.filter((target) => /^https?:\/\//i.test(target)), Date.now(), strategy);
}

function orderTargetsByHealth(nodeName, path, targets, now = Date.now(), strategy = "auto") {
  const kind = isPlaybackStreamPath(path) ? "stream" : "api";
  return targets.map((target, index) => {
    const health = targetHealthCache.get(targetHealthKey(nodeName, kind, target)) || {};
    let group = 1;
    if (Number(health.failureUntil || 0) > now) group = 4;
    else if (strategy === "auto" && kind !== "stream" && Number(health.successUntil || 0) > now) group = 0;
    return {
      target,
      index,
      group,
      latency: Number(health.latency || Number.MAX_SAFE_INTEGER)
    };
  }).sort((a, b) => a.group - b.group ||
      (strategy === "auto" ? a.latency - b.latency : 0) ||
      a.index - b.index)
    .map((item) => item.target);
}

function configuredTargetForURL(node, targetURL) {
  const configured = splitTargets(node?.streamTarget || node?.targets || []);
  const matching = configured.find((target) => {
    try {
      return new URL(target).origin === targetURL.origin;
    } catch {
      return false;
    }
  });
  return matching || targetURL.origin;
}

function targetHeaderTimeoutMs(node, path, env) {
  if (isPlaybackStreamPath(path)) {
    return Math.max(500, Math.min(10000, Number(node?.streamTimeoutMs || DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS)));
  }
  return upstreamHeaderTimeoutMs(env);
}

function targetLineIdentity(target) {
  try {
    const url = new URL(target);
    const label = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    return { key: String(fnv1a(url.origin + url.pathname)).padStart(10, "0"), label };
  } catch {
    const value = cleanString(target).slice(0, 120);
    return { key: String(fnv1a(value)).padStart(10, "0"), label: value || "unknown" };
  }
}

function trackTargetOutcome(timing, target, result, latencyMs, path) {
  if (!timing) return;
  const identity = targetLineIdentity(target);
  const item = {
    ...identity,
    kind: isPlaybackStreamPath(path) ? "stream" : "api",
    result: result === "success" ? "success" : "failure",
    latencyMs: Math.max(0, Number(latencyMs || 0))
  };
  timing.targetOutcomes = [...(timing.targetOutcomes || []), item];
  if (item.result === "success") {
    timing.selectedLine = item.label;
    timing.selectedTarget = target;
  }
}

function recordTargetOutcome(nodeName, path, target, result, latencyMs, now = Date.now()) {
  const kind = isPlaybackStreamPath(path) ? "stream" : "api";
  const key = targetHealthKey(nodeName, kind, target);
  const previous = targetHealthCache.get(key) || {};
  if (result === "success") {
    const latency = Number.isFinite(previous.latency)
      ? previous.latency * 0.7 + Math.max(0, latencyMs) * 0.3
      : Math.max(0, latencyMs);
    targetHealthCache.set(key, { latency, successUntil: now + TARGET_HEALTH_SUCCESS_TTL_MS, failureUntil: 0 });
  } else {
    targetHealthCache.set(key, {
      latency: Number(previous.latency || Number.MAX_SAFE_INTEGER),
      successUntil: 0,
      failureUntil: now + TARGET_HEALTH_FAILURE_TTL_MS
    });
  }
  trimTargetHealthCache(now);
}

function targetHealthKey(nodeName, kind, target) {
  return `${normalizeName(nodeName)}\n${kind}\n${String(target)}`;
}

function invalidateTargetHealth(nodeName) {
  const prefix = normalizeName(nodeName || "") + "\n";
  if (prefix === "\n") return;
  for (const key of targetHealthCache.keys()) {
    if (key.startsWith(prefix)) targetHealthCache.delete(key);
  }
}

function trimTargetHealthCache(now = Date.now()) {
  if (targetHealthCache.size <= 512) return;
  for (const [key, value] of targetHealthCache) {
    if (Number(value.successUntil || 0) <= now && Number(value.failureUntil || 0) <= now) {
      targetHealthCache.delete(key);
    }
  }
  while (targetHealthCache.size > 512) {
    targetHealthCache.delete(targetHealthCache.keys().next().value);
  }
}

function buildTargetURL(target, path, search) {
  const base = new URL(target);
  const basePath = trimSlash(base.pathname);
  let nextPath = trimSlash(path || "/");
  if (basePath.toLowerCase() === "emby" && nextPath.toLowerCase().startsWith("emby/")) {
    nextPath = nextPath.slice(5);
  }
  base.pathname = "/" + [basePath, nextPath].filter(Boolean).join("/");
  base.search = search || "";
  return base;
}

async function handleRawProxy(request, env, ctx, node, routePath, bodyBuffer, inboundURL, timing) {
  const encoded = routePath.slice("/__raw__/".length);
  let raw = "";
  try {
    raw = decodeURIComponent(encoded);
  } catch {
    raw = encoded;
  }
  if (!/^https?:\/\//i.test(raw)) {
    return text("Bad raw URL", 400);
  }
  const signature = inboundURL.searchParams.get("__ep_sig") || "";
  if (!await verifyRawProxySignature(env, node, raw, signature)) {
    return text("Invalid raw URL signature", 403);
  }
  const targetURL = new URL(raw);
  const upstreamStarted = performanceNow();
  const upstream = await fetchRawWithRetries(request, targetURL, node, bodyBuffer, env);
  const streamRedirect = await followProxyStreamRedirect(request, upstream, targetURL, node, bodyBuffer, env);
  timing.upstream += performanceNow() - upstreamStarted;
  const finalUpstream = streamRedirect?.upstream || upstream;
  const finalURL = streamRedirect?.targetURL || targetURL;
  if (isPlaybackStreamRequest(request, finalURL) && finalUpstream.status >= 200 && finalUpstream.status < 400) {
    timing.selectedTarget = configuredTargetForURL(node, finalURL);
  }
  const response = await timedFinishProxyResponse(finalUpstream, request, node, finalURL, inboundURL, env, timing);
  return completeProxyResponse(ctx, env, request, node, finalURL.pathname, response, requestKind(finalURL.pathname, response, request), timing);
}

async function fetchRawWithRetries(request, targetURL, node, bodyBuffer, env) {
  let last;
  for (const directMode of ["normal", "retry-no-origin", "retry-browserish"]) {
    if (last) {
      try {
        last.body?.cancel?.();
      } catch {
        // Ignore body cleanup errors on retry.
      }
    }
    const outbound = await buildOutboundRequest(request, new URL(targetURL), node, bodyBuffer, env, {
      directMode,
      rawExternal: true,
      compatibilityRetry: directMode !== "normal"
    });
    last = await fetch(outbound);
    if (last.status !== 403 || !bodyCanRetry(bodyBuffer)) {
      return last;
    }
  }
  return last;
}

async function followProxyStreamRedirect(request, upstream, targetURL, node, bodyBuffer, env) {
  if (!upstream || !isRedirectStatus(upstream.status) || !isPlaybackStreamRequest(request, targetURL)) {
    return null;
  }
  if ((node.streamMode || "proxy") !== "proxy" || !["GET", "HEAD"].includes(request.method)) {
    return null;
  }
  let currentResponse = upstream;
  let currentURL = targetURL;
  for (let i = 0; i < 3; i++) {
    const location = currentResponse.headers.get("location");
    if (!location) {
      return null;
    }
    let nextURL;
    try {
      nextURL = new URL(location, currentURL);
    } catch {
      return null;
    }
    if (!["http:", "https:"].includes(nextURL.protocol)) {
      return null;
    }
    try {
      currentResponse.body?.cancel?.();
    } catch {
      // Ignore body cleanup errors while following stream redirects.
    }
    currentURL = nextURL;
    currentResponse = await fetchRawWithRetries(request, currentURL, node, bodyBuffer, env);
    if (!isRedirectStatus(currentResponse.status)) {
      return {
        upstream: currentResponse,
        targetURL: currentURL,
        directRangeFallbackURL: shouldDirectRangeFallback(request, currentResponse, targetURL, currentURL)
          ? currentURL.toString()
          : ""
      };
    }
  }
  return { upstream: currentResponse, targetURL: currentURL };
}

function shouldDirectRangeFallback(request, response, initialURL, finalURL) {
  if (!request || request.method !== "GET" || !response || !initialURL || !finalURL) return false;
  if (initialURL.origin === finalURL.origin) return false;
  const match = String(request.headers.get("range") || "").trim().match(/^bytes=(\d+)-/i);
  if (!match || Number(match[1]) <= 0) return false;
  return response.status === 200 && !response.headers.get("content-range");
}

function bodyCanRetry(bodyBuffer) {
  return !bodyBuffer || bodyBuffer.byteLength <= DEFAULT_RETRY_BODY_BYTES;
}

async function buildOutboundRequest(request, targetURL, node, bodyBuffer, env, options = {}) {
  const headers = await buildHeaders(request, targetURL, node, env, options);
  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = bodyBuffer;
  }
  return new Request(targetURL.toString(), init);
}

async function fetchConfiguredTarget(request, targetURL, node, bodyBuffer, env, timeoutMs) {
  let response;
  let attempts = 0;
  const credentialAuthentication = request.method === "POST" && isCredentialAuthenticationRequest(targetURL);
  for (const compatibilityRetry of [false, true]) {
    if (response) discardResponseBody(response);
    const outbound = await buildOutboundRequest(request, new URL(targetURL), node, bodyBuffer, env, {
      compatibilityRetry,
      directMode: compatibilityRetry ? "retry-no-origin" : "",
      cleanAuthentication: credentialAuthentication && compatibilityRetry
    });
    attempts++;
    response = await fetchWithHeaderTimeout(outbound, timeoutMs);
    const retrySafeRead = ["GET", "HEAD"].includes(request.method) && [403, 500].includes(response.status);
    const retryRejectedAuthentication = credentialAuthentication && response.status === 403;
    if (!compatibilityRetry && (retrySafeRead || retryRejectedAuthentication)) {
      if (retryRejectedAuthentication) {
        console.warn("authentication upstream rejected; retrying with clean client identity", {
          node: node.name,
          status: response.status,
          server: response.headers.get("server") || "",
          cfRay: response.headers.get("cf-ray") || "",
          contentType: response.headers.get("content-type") || ""
        });
      }
      continue;
    }
    return { response, attempts };
  }
  return { response, attempts };
}

async function fetchWithHeaderTimeout(request, timeoutMs) {
  const wait = Math.max(0, Number(timeoutMs || 0));
  if (!wait) return fetch(request);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, wait);
  try {
    return await fetch(new Request(request, { signal: controller.signal }));
  } catch (err) {
    if (timedOut) throw new Error(`upstream header timeout after ${wait}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function upstreamHeaderTimeoutMs(env) {
  const configured = Number(env?.UPSTREAM_HEADER_TIMEOUT_MS || DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS);
  return Math.max(500, Math.min(10000, Number.isFinite(configured) ? configured : DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS));
}

async function buildHeaders(request, targetURL, node, env, options = {}) {
  const headers = new Headers(request.headers);
  const clientIP = headers.get("cf-connecting-ip") || "";
  const cleanAuthentication = Boolean(options.cleanAuthentication && isCredentialAuthenticationRequest(targetURL));
  stripHopByHop(headers);
  stripCloudflareForwardingHeaders(headers);
  if (options.rawExternal && !isConfiguredNodeOrigin(node, targetURL)) {
    deleteHeaders(headers, [
      "Authorization", "Cookie", "X-Emby-Token", "X-MediaBrowser-Token",
      "X-Emby-Authorization", "X-MediaBrowser-Authorization", "X-Authorization"
    ]);
  }
  const streaming = isPlaybackStreamRequest(request, targetURL);
  if (!streaming) {
    deleteHeaders(headers, ["Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User"]);
  }
  if ((!streaming || isManifestRequestPath(targetURL.pathname)) && !isImageRequest(targetURL.pathname)) {
    headers.set("Accept-Encoding", "identity");
  }

  const mode = node.headerMode || "dual";
  if (!cleanAuthentication && (mode === "realip_only" || mode === "dual" || mode === "strict")) {
    if (clientIP) {
      headers.set("X-Real-IP", clientIP);
      headers.set("X-Forwarded-For", clientIP);
    }
    headers.set("X-Forwarded-Proto", "https");
  }

  if (node.impersonate !== false && !cleanAuthentication) {
    const identityState = await getIdentityState(env);
    const profile = node.clientProfile || DEFAULT_CLIENT_PROFILE;
    const snapshot = profileSnapshot(profile, identityState);
    const resourceIdentity = isResourceIdentityRequest(request, targetURL);
    if (resourceIdentity) {
      applyClientProfileToResourceURL(targetURL, headers, profile, identityState, snapshot);
    } else {
      applyClientProfileToURL(targetURL, headers, profile, identityState, snapshot);
    }
    applyClientProfile(headers, profile, true, identityState, {
      snapshot,
      hillsHeaders: resourceIdentity || isAuthenticationIdentityRequest(targetURL)
    });
  }
  if (options.compatibilityRetry) {
    deleteHeaders(headers, ["Origin", "Referer", "X-Real-IP", "X-Forwarded-For", "X-Forwarded-Proto"]);
  }
  if (cleanAuthentication) {
    sanitizeAuthenticationRetryHeaders(headers);
  }
  if (mode === "strict" && !cleanAuthentication) {
    headers.set("Origin", targetURL.origin);
    headers.set("Referer", targetURL.origin + "/");
  }
  if (options.directMode) {
    applyDirectAdapterHeaders(headers, targetURL, options.directMode);
  }
  return headers;
}

function stripCloudflareForwardingHeaders(headers) {
  for (const key of [...headers.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("cf-") || normalized === "cdn-loop" || normalized === "true-client-ip") {
      headers.delete(key);
    }
  }
}

function hasSensitiveRequestAuth(request) {
  const url = new URL(request.url);
  return Boolean(
    request.headers.get("authorization") ||
    request.headers.get("cookie") ||
    request.headers.get("x-emby-token") ||
    request.headers.get("x-mediabrowser-token") ||
    [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEYS.has(key.toLowerCase()))
  );
}

function isConfiguredNodeOrigin(node, targetURL) {
  return [...splitTargets(node.targets), ...splitTargets(node.streamTarget)].some((target) => {
    try {
      return new URL(target).origin === targetURL.origin;
    } catch {
      return false;
    }
  });
}

async function rawProxySignature(env, node, raw) {
  const secret = cleanString(env.ADMIN_TOKEN || "");
  if (!secret || !globalThis.crypto?.subtle) return "";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const payload = `${normalizeName(node.name)}\n${String(raw)}`;
  const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  let binary = "";
  for (const byte of signed) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function verifyRawProxySignature(env, node, raw, received) {
  const expected = await rawProxySignature(env, node, raw);
  if (!expected || expected.length !== received.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return mismatch === 0;
}

async function signedRawProxyURL(publicBase, raw, env, node) {
  const signature = await rawProxySignature(env, node, raw);
  if (!signature) return "";
  return publicBase + "/__raw__/" + encodeURIComponent(raw) + "?__ep_sig=" + encodeURIComponent(signature);
}

function applyClientProfile(headers, profile, overwrite, identityState, options = {}) {
  const values = options.snapshot || profileSnapshot(profile, identityState);
  const token = identityTokenFromHeaders(headers);
  rewriteIdentityHeaders(headers, values);
  setHeader(headers, "User-Agent", values.ua, overwrite);
  if (values.authStyle === "hills") {
    if (options.hillsHeaders) {
      headers.set("X-Emby-Authorization", rewriteMediaBrowserAuthorization("Emby", values));
    }
    if (token) {
      headers.set("X-Emby-Token", token);
    }
    return;
  }
  if (token) {
    headers.set("X-Emby-Token", token);
  }
  if (values.authStyle !== "yamby") {
    setHeader(headers, "X-Emby-Client", values.client, overwrite);
    setHeader(headers, "X-MediaBrowser-Client", values.client, overwrite);
    setHeader(headers, "X-Emby-Client-Version", values.version, overwrite);
    setHeader(headers, "X-MediaBrowser-Client-Version", values.version, overwrite);
    setHeader(headers, "X-Emby-Device-Name", values.device, overwrite);
    setHeader(headers, "X-MediaBrowser-Device-Name", values.device, overwrite);
    setHeader(headers, "X-Emby-Device-Id", values.deviceId, overwrite);
    setHeader(headers, "X-MediaBrowser-Device-Id", values.deviceId, overwrite);
  }
}

function getClientProfile(profile) {
  const normalized = String(profile || DEFAULT_CLIENT_PROFILE).toLowerCase();
  return CLIENT_PROFILES.find((item) => item.id === normalized) || CLIENT_PROFILES.find((item) => item.id === DEFAULT_CLIENT_PROFILE) || CLIENT_PROFILES[0];
}

function setHeader(headers, key, value, overwrite) {
  if (overwrite || !headers.get(key)) {
    headers.set(key, value);
  }
}

function applyDirectAdapterHeaders(headers, targetURL, mode) {
  const adapter = directAdapter(targetURL);
  if (mode === "retry-no-origin") {
    headers.delete("Origin");
    headers.delete("Referer");
    return;
  }
  if (adapter.referer && (!adapter.keepReferer || !headers.get("Referer"))) {
    headers.set("Referer", adapter.referer);
  }
  if (!adapter.keepOrigin) {
    headers.delete("Origin");
  } else if (adapter.referer) {
    try {
      const ref = new URL(adapter.referer);
      headers.set("Origin", ref.origin);
    } catch {
      // Ignore invalid adapter referer.
    }
  }
  if (mode === "retry-browserish") {
    if (!headers.get("Accept")) {
      headers.set("Accept", "*/*");
    }
    if (!headers.get("Accept-Language")) {
      headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
    }
  }
}

function directAdapter(targetURL) {
  const rules = [
    { name: "tianyi", keywords: ["cloud.189.cn", "189.cn", "ctyun", "e.189.cn", "ctyunxs.cn"], referer: "https://cloud.189.cn/" },
    { name: "115", keywords: ["115.com", "anxia.com", "115cdn"] },
    { name: "pikpak", keywords: ["mypikpak.com", "pikpak"] },
    { name: "aliyun", keywords: ["aliyundrive", "alipan"] },
    { name: "quark", keywords: ["quark", "uc.cn"] },
    { name: "baidu", keywords: ["pan.baidu.com", "baidupcs"] },
    { name: "google-drive", keywords: ["drive.google.com", "googleusercontent.com", "googledrive", "gvt1.com"] },
    { name: "onedrive", keywords: ["onedrive.live.com", "1drv.ms", "sharepoint.com", "sharepoint-df.com"] },
    { name: "generic-pan", keywords: ["123684.com"] }
  ];
  const hay = `${targetURL.host}${targetURL.pathname}?${targetURL.search}`.toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.some((keyword) => hay.includes(keyword))) {
      return { keepOrigin: false, keepReferer: false, ...rule };
    }
  }
  if (isPanURL(targetURL)) {
    return { name: "generic-pan", keepOrigin: false, keepReferer: false };
  }
  return { name: "generic", keepOrigin: false, keepReferer: false };
}

function isPanURL(targetURL) {
  const host = targetURL.hostname.toLowerCase();
  const keywords = [
    "aliyundrive", "alipan", "quark", "baidupcs", "pan.baidu.com",
    "115.com", "123684.com", "uc.cn", "drive.google.com",
    "googleusercontent.com", "1drv.ms", "onedrive.live.com", "sharepoint.com"
  ];
  return keywords.some((keyword) => {
    const key = keyword.toLowerCase();
    return host === key || host.endsWith("." + key) || (!key.includes(".") && host.includes(key));
  });
}

function profileSnapshot(profile, identityState) {
  const item = getClientProfile(profile);
  const state = identityState?.profiles?.[item.id] || {};
  return {
    ...item,
    device: isAndroidClientProfile(item) ? ANDROID_DEVICE_NAME : state.deviceName || defaultProfileDeviceName(item),
    deviceId: state.deviceId || stableDeviceID(item),
    authStyle: item.authStyle || "quoted"
  };
}

function applyClientProfileToURL(targetURL, headers, profile, identityState, snapshot = null) {
  const snap = snapshot || profileSnapshot(profile, identityState);
  if (snap.authStyle === "yamby") {
    promoteYambyQueryAuth(targetURL, headers);
    promoteAuthorizationTokenFromHeaders(headers);
    return;
  }
  if (snap.authStyle === "hills") {
    applyHillsQueryIdentityToURL(targetURL, headers, snap);
    return;
  }
  promoteQueryAuthorizationToken(targetURL, headers);
  rewriteIdentityQuery(targetURL, snap);
}

function applyClientProfileToResourceURL(targetURL, headers, profile, identityState, snapshot = null) {
  const snap = snapshot || profileSnapshot(profile, identityState);
  if (snap.authStyle === "yamby") {
    promoteYambyQueryAuth(targetURL, headers);
    promoteAuthorizationTokenFromHeaders(headers);
    return;
  }
  if (snap.authStyle === "hills") {
    applyHillsResourceIdentityToURL(targetURL, headers);
    return;
  }
  promoteQueryAuthorizationToken(targetURL, headers);
  rewriteIdentityQuery(targetURL, snap);
}

function rewriteIdentityHeaders(headers, snap) {
  if (snap.authStyle === "hills") {
    stripImpersonationHeaders(headers);
    return;
  }
  const dropIdentity = snap.authStyle === "yamby";
  const updates = [];
  headers.forEach((value, key) => {
    const nk = normalizeIdentityKey(key);
    if (["xembyclient", "xmediabrowserclient"].includes(nk)) {
      updates.push([key, snap.client, dropIdentity]);
    } else if (["xembyclientversion", "xmediabrowserclientversion"].includes(nk)) {
      updates.push([key, snap.version, dropIdentity]);
    } else if (["xembydevicename", "xmediabrowserdevicename"].includes(nk)) {
      updates.push([key, snap.device, dropIdentity]);
    } else if (["xembydeviceid", "xmediabrowserdeviceid"].includes(nk)) {
      updates.push([key, snap.deviceId, dropIdentity]);
    } else if (["xembyauthorization", "xmediabrowserauthorization", "xauthorization"].includes(nk)) {
      updates.push([key, rewriteMediaBrowserAuthorization(value, snap), false]);
    } else if (nk === "xapplication") {
      updates.push([key, `${snap.client}/${snap.version}`, false]);
    }
  });
  for (const [key, value, drop] of updates) {
    if (drop) {
      headers.delete(key);
    } else {
      headers.set(key, value);
    }
  }
  for (const key of ["Authorization", "X-Emby-Authorization", "X-MediaBrowser-Authorization", "X-Authorization"]) {
    const value = headers.get(key);
    if (value && isEmbyAuthorization(value)) {
      headers.set(key, rewriteMediaBrowserAuthorization(value, snap));
    }
  }
}

function stripImpersonationHeaders(headers) {
  for (const key of [...headers.keys()]) {
    const nk = normalizeIdentityKey(key);
    if (nk === "xembytoken") {
      if (key !== "X-Emby-Token") {
        headers.delete(key);
      }
      continue;
    }
    if (nk === "xembyauthorization" ||
      nk.startsWith("xmediabrowser") ||
      nk === "xauthorization" ||
      nk === "xapplication" ||
      ["xembyclient", "xembyclientversion", "xembydevicename", "xembydeviceid", "xembylanguage"].includes(nk)) {
      headers.delete(key);
      continue;
    }
    if (nk === "authorization" && isEmbyAuthorization(headers.get(key))) {
      headers.delete(key);
    }
  }
}

function promoteYambyQueryAuth(targetURL, headers) {
  const promoted = {
    authorization: "Authorization",
    xauthorization: "X-Authorization",
    xembyauthorization: "X-Emby-Authorization",
    xembytoken: "X-Emby-Token",
    xmediabrowserauthorization: "X-MediaBrowser-Authorization",
    xmediabrowsertoken: "X-MediaBrowser-Token"
  };
  const params = targetURL.searchParams;
  const deleteKeys = [];
  for (const [key, value] of params.entries()) {
    const nk = normalizeIdentityKey(key);
    const headerName = promoted[nk];
    if (headerName && !headerHasValue(headers, headerName)) {
      headers.set(headerName, sanitizeHeaderValue(value));
    }
    if (headerName || isYambyQueryIdentityKey(nk)) {
      deleteKeys.push(key);
    }
  }
  for (const key of deleteKeys) {
    params.delete(key);
  }
}

function promoteQueryAuthorizationToken(targetURL, headers) {
  if (headerHasValue(headers, "X-Emby-Token")) {
    return;
  }
  for (const [key, value] of targetURL.searchParams.entries()) {
    if (!["authorization", "xauthorization", "xembyauthorization", "xmediabrowserauthorization"].includes(normalizeIdentityKey(key))) {
      continue;
    }
    const token = authTokenFromValue(value);
    if (token) {
      headers.set("X-Emby-Token", sanitizeHeaderValue(token));
      return;
    }
  }
}

function applyHillsQueryIdentityToURL(targetURL, headers, snap) {
  const token = hillsTokenForURL(targetURL, headers);
  const params = targetURL.searchParams;
  removeHillsQueryIdentity(params);
  params.set("X-Emby-Authorization", rewriteMediaBrowserAuthorization("Emby", snap));
  params.set("X-Emby-Client", snap.client);
  params.set("X-Emby-Client-Version", snap.version);
  params.set("X-Emby-Language", hillsLanguageForURL(targetURL));
  if (token) {
    params.set("X-Emby-Token", token);
    headers.set("X-Emby-Token", token);
  }
}

function applyHillsResourceIdentityToURL(targetURL, headers) {
  const token = hillsTokenForURL(targetURL, headers);
  removeHillsQueryIdentity(targetURL.searchParams);
  if (token) {
    headers.set("X-Emby-Token", token);
  }
}

function removeHillsQueryIdentity(params) {
  const deleteKeys = [];
  for (const [key, value] of params.entries()) {
    if (isHillsQueryIdentityParam(normalizeIdentityKey(key), value)) {
      deleteKeys.push(key);
    }
  }
  for (const key of deleteKeys) {
    params.delete(key);
  }
}

function isHillsQueryIdentityParam(normalizedKey, value) {
  if (normalizedKey.startsWith("xemby") || normalizedKey.startsWith("xmediabrowser")) {
    return true;
  }
  if (["authorization", "xauthorization"].includes(normalizedKey)) {
    return isEmbyAuthorization(value);
  }
  return false;
}

function hillsTokenForURL(targetURL, headers) {
  return firstNonEmpty(
    headers.get("X-Emby-Token"),
    headers.get("X-MediaBrowser-Token"),
    firstQueryValueByNormalizedKey(targetURL, "xembytoken"),
    firstQueryValueByNormalizedKey(targetURL, "xmediabrowsertoken"),
    authTokenFromURL(targetURL),
    authTokenFromHeaders(headers)
  );
}

function authTokenFromURL(targetURL) {
  for (const [key, value] of targetURL.searchParams.entries()) {
    if (!["authorization", "xauthorization", "xembyauthorization", "xmediabrowserauthorization"].includes(normalizeIdentityKey(key))) {
      continue;
    }
    const token = authTokenFromValue(value);
    if (token) {
      return sanitizeHeaderValue(token);
    }
  }
  return "";
}

function authTokenFromHeaders(headers) {
  for (const key of ["X-Emby-Authorization", "X-MediaBrowser-Authorization", "Authorization", "X-Authorization"]) {
    const token = authTokenFromValue(headers.get(key) || "");
    if (token) {
      return sanitizeHeaderValue(token);
    }
  }
  return "";
}

function firstQueryValueByNormalizedKey(targetURL, normalizedKey) {
  for (const [key, value] of targetURL.searchParams.entries()) {
    if (normalizeIdentityKey(key) === normalizedKey && String(value || "").trim()) {
      return sanitizeHeaderValue(value);
    }
  }
  return "";
}

function identityTokenFromHeaders(headers) {
  return firstNonEmpty(
    headers.get("X-Emby-Token"),
    headers.get("X-MediaBrowser-Token"),
    authTokenFromHeaders(headers)
  );
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const clean = sanitizeHeaderValue(value || "").trim();
    if (clean) {
      return clean;
    }
  }
  return "";
}

function hillsLanguageForURL(targetURL) {
  return isUsersRootPath(targetURL) ? "en-us" : "zh-cn";
}

function isUsersRootPath(targetURL) {
  const parts = trimSlash(targetURL?.pathname || "").split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toLowerCase() === "users") {
      return i + 2 === parts.length && Boolean(parts[i + 1]);
    }
  }
  return false;
}

function rewriteIdentityQuery(targetURL, snap) {
  const params = targetURL.searchParams;
  const updates = [];
  for (const [key, value] of params.entries()) {
    const nk = normalizeIdentityKey(key);
    if (["xembyclient", "xmediabrowserclient"].includes(nk)) {
      updates.push([key, snap.client]);
    } else if (["xembyclientversion", "xmediabrowserclientversion"].includes(nk)) {
      updates.push([key, snap.version]);
    } else if (["xembydevicename", "xmediabrowserdevicename", "devicename"].includes(nk)) {
      updates.push([key, snap.device]);
    } else if (["xembydeviceid", "xmediabrowserdeviceid", "deviceid"].includes(nk)) {
      updates.push([key, snap.deviceId]);
    } else if (["xembyauthorization", "xmediabrowserauthorization", "xauthorization", "authorization"].includes(nk)) {
      updates.push([key, rewriteMediaBrowserAuthorization(value, snap)]);
    }
  }
  for (const [key, value] of updates) {
    params.set(key, value);
  }
}

function promoteAuthorizationTokenFromHeaders(headers) {
  if (headerHasValue(headers, "X-Emby-Token")) {
    return;
  }
  for (const key of ["X-Emby-Authorization", "X-MediaBrowser-Authorization", "Authorization", "X-Authorization"]) {
    const token = authTokenFromValue(headers.get(key) || "");
    if (token) {
      headers.set("X-Emby-Token", sanitizeHeaderValue(token));
      return;
    }
  }
}

function rewriteMediaBrowserAuthorization(value, snap) {
  if (!isEmbyAuthorization(value)) {
    return value;
  }
  if (snap.authStyle === "yamby") {
    return `Emby Client=${snap.client},Device=${snap.device},DeviceId=${snap.deviceId},Version=${snap.version}`;
  }
  return `Emby Client="${escapeAuthField(snap.client)}", Device="${escapeAuthField(snap.device)}", DeviceId="${escapeAuthField(snap.deviceId)}", Version="${escapeAuthField(snap.version)}"`;
}

function isEmbyAuthorization(value) {
  return /^(?:MediaBrowser|Emby)(?:\s|$)/i.test(String(value || "").trim());
}

function authTokenFromValue(value) {
  const match = String(value || "").trim().match(/^(?:MediaBrowser|Emby)(?:\s|$).*?\bToken\s*=\s*("[^"]*"|[^,\s]+)/i);
  if (!match) {
    return "";
  }
  return unquoteAuthField(match[1]);
}

function unquoteAuthField(value) {
  const raw = String(value || "").trim();
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return raw;
}

function escapeAuthField(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeIdentityKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isYambyQueryIdentityKey(normalizedKey) {
  return normalizedKey.startsWith("xemby") ||
    normalizedKey.startsWith("xmediabrowser") ||
    normalizedKey === "deviceid" ||
    normalizedKey === "devicename";
}

function headerHasValue(headers, key) {
  const value = headers.get(key);
  return value !== null && String(value).trim() !== "";
}

function sanitizeHeaderValue(value) {
  return String(value ?? "").replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

async function getIdentityState(env) {
  if (!identityStatePromise) {
    identityStatePromise = loadIdentityState(env).catch((err) => {
      identityStatePromise = undefined;
      throw err;
    });
  }
  return identityStatePromise;
}

async function loadIdentityState(env) {
  let saved = {};
  try {
    const row = await env.DB.prepare(`SELECT v FROM system_config WHERE k = ?`).bind(IDENTITY_KEY).first();
    saved = row?.v ? JSON.parse(row.v) : {};
  } catch {
    saved = {};
  }
  const normalized = normalizeIdentityState(saved);
  if (JSON.stringify(saved) !== JSON.stringify(normalized)) {
    try {
      await env.DB.prepare(`
        INSERT INTO system_config (k, v, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
      `).bind(IDENTITY_KEY, JSON.stringify(normalized), Date.now()).run();
    } catch {
      // A fresh database may still be initializing; the normalized identity is usable in-memory.
    }
  }
  return normalized;
}

function normalizeIdentityState(saved) {
  const profiles = {};
  const savedProfiles = saved?.profiles && typeof saved.profiles === "object" ? saved.profiles : {};
  for (const profile of CLIENT_PROFILES) {
    profiles[profile.id] = normalizeDeviceState(profile, savedProfiles[profile.id]);
  }
  const current = CLIENT_PROFILES[0];
  return {
    clientName: current.client,
    clientVersion: current.version,
    userAgent: current.ua,
    profiles
  };
}

function normalizeDeviceState(profile, saved) {
  const raw = saved && typeof saved === "object" ? saved : {};
  let deviceName = cleanString(raw.deviceName || "");
  if (isAndroidClientProfile(profile)) {
    deviceName = ANDROID_DEVICE_NAME;
  } else if (!deviceName) {
    deviceName = defaultProfileDeviceName(profile);
  }
  let deviceId = cleanString(raw.deviceId || "").toLowerCase();
  if (!validDeviceID(profile, deviceId)) {
    deviceId = randomDeviceID(profile);
  }
  return { deviceName, deviceId };
}

function isAndroidClientProfile(profile) {
  return profile?.id === "yamby" || profile?.id === "hills_android";
}

function defaultProfileDeviceName(profile) {
  const name = cleanString(profile.device || "");
  if (name) {
    return name;
  }
  if (profile.devicePrefix) {
    return profile.devicePrefix + randomHex(6).toUpperCase();
  }
  return ANDROID_DEVICE_NAME;
}

function validDeviceID(profile, value) {
  if (profile.idFormat === "uuid") {
    return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  }
  return new RegExp(`^[a-f0-9]{${Number(profile.idLength || 32)}}$`, "i").test(value);
}

function randomDeviceID(profile) {
  if (profile.idFormat === "uuid") {
    return randomUUID();
  }
  return randomHex(Number(profile.idLength || 32));
}

function randomUUID() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomHex(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

function stableDeviceID(profile) {
  const seed = fnv1a(`${profile.id}:${profile.client}:${profile.version}`);
  if (profile.idFormat === "uuid") {
    const hex = (seed + fnv1a(seed) + fnv1a(seed + profile.id) + fnv1a(profile.ua)).slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  const length = Number(profile.idLength || 32);
  return (seed + fnv1a(seed) + fnv1a(seed + profile.id) + fnv1a(profile.ua)).slice(0, length);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < String(value).length; i++) {
    hash ^= String(value).charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function stripHopByHop(headers) {
  deleteHeaders(headers, [
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "cf-connecting-ip",
    "cf-connecting-o2o",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cdn-loop",
    "true-client-ip",
    "x-forwarded-host",
    "x-forwarded-server",
    "x-original-forwarded-for",
    "x-real-ip",
    "forwarded",
    "forwarded-for",
    "x-forwarded",
    "x-forwarded-for-original",
    "x-forwarded-for-proxy-protocol",
    "x-forwarded-ip",
    "x-forwarded-client-ip",
    "x-forward-for",
    "x-envoy-external-address",
    "client-ip",
    "clientip",
    "client-real-ip",
    "real-ip",
    "real-client-ip",
    "x-client-ip",
    "x-client-real-ip",
    "x-cluster-client-ip",
    "x-originating-ip",
    "x-original-ip",
    "x-original-remote-addr",
    "x-real-client-ip",
    "x-remote-ip",
    "x-remote-addr",
    "proxy-client-ip",
    "wl-proxy-client-ip",
    "x-proxyuser-ip",
    "x-appengine-user-ip",
    "remote-addr",
    "remote-host",
    "http-client-ip",
    "http-x-forwarded-for",
    "http-x-forwarded",
    "http-x-real-ip",
    "http-x-cluster-client-ip",
    "http-forwarded-for",
    "http-forwarded",
    "http_client_ip",
    "http_x_forwarded_for",
    "http_x_forwarded",
    "http_x_real_ip",
    "http_x_cluster_client_ip",
    "http_forwarded_for",
    "http_forwarded",
    "remote_addr",
    "x-forwarded-proto",
    "x-forwarded-port",
    "via",
    "ali-cdn-real-ip",
    "ali-real-client-ip",
    "x-forward-port",
    "x-forwarded-ssl",
    "x-cache",
    "x-cache-hits",
    "x-served-by",
    "x-timer",
    "x-varnish"
  ]);
  for (const key of [...headers.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("cf-") ||
      lower.startsWith("cloudfront-") ||
      lower.startsWith("x-amz-cf-") ||
      lower.startsWith("x-edge-") ||
      lower.startsWith("fastly-") ||
      lower.startsWith("x-fastly-") ||
      lower.startsWith("x-azure-") ||
      lower.startsWith("x-fd-") ||
      lower.startsWith("akamai-") ||
      lower.startsWith("x-vercel-") ||
      lower.startsWith("fly-")) {
      headers.delete(key);
    }
  }
}

function deleteHeaders(headers, keys) {
  for (const key of keys) {
    headers.delete(key);
  }
}

async function timedFinishProxyResponse(upstream, request, node, targetURL, inboundURL, env, timing) {
  const started = performanceNow();
  try {
    return await finishProxyResponse(upstream, request, node, targetURL, inboundURL, env);
  } finally {
    timing.rewrite += performanceNow() - started;
  }
}

async function finishProxyResponse(upstream, request, node, targetURL, inboundURL, env) {
  const headers = new Headers(upstream.headers);
  stripResponseHeaders(headers);
  await rewriteLocation(headers, targetURL, inboundURL, node, env);
  rewriteSetCookie(headers, node);
  applyResponsePolicy(headers, upstream, request, targetURL);

  if (shouldRewriteBody(upstream, request)) {
    const length = Number(upstream.headers.get("content-length") || "0");
    if (length > 0 && length <= DEFAULT_MAX_REWRITE_BYTES) {
      const textBody = await upstream.text();
      const rewritten = await rewriteResponseText(textBody, targetURL, inboundURL, node, env, headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("content-md5");
      headers.delete("etag");
      return new Response(rewritten, { status: upstream.status, statusText: upstream.statusText, headers });
    }
    if (!length && upstream.body) {
      const [candidate, passthrough] = upstream.body.tee();
      try {
        const textBody = await readStreamTextLimited(candidate, DEFAULT_MAX_REWRITE_BYTES);
        discardStream(passthrough);
        const rewritten = await rewriteResponseText(textBody, targetURL, inboundURL, node, env, headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        headers.delete("content-md5");
        headers.delete("etag");
        return new Response(rewritten, { status: upstream.status, statusText: upstream.statusText, headers });
      } catch (err) {
        if (err instanceof BodyLimitError) {
          return new Response(passthrough, { status: upstream.status, statusText: upstream.statusText, headers });
        }
        discardStream(passthrough);
        throw err;
      }
    }
  }

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

class BodyLimitError extends Error {
  constructor(limit) {
    super(`body exceeds ${limit} byte limit`);
    this.name = "BodyLimitError";
    this.limit = limit;
  }
}

async function readStreamTextLimited(stream, limit) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > limit) throw new BodyLimitError(limit);
      output += decoder.decode(chunk, { stream: true });
    }
    return output + decoder.decode();
  } catch (err) {
    try {
      const cancelled = reader.cancel(err);
      if (cancelled?.catch) cancelled.catch(() => {});
    } catch {}
    throw err;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function discardStream(stream) {
  if (!stream) return;
  try {
    const cancelled = stream.cancel();
    if (cancelled?.catch) cancelled.catch(() => {});
  } catch {}
}

function shouldRewriteBody(response, request) {
  if (request.method === "HEAD" || !response.body) {
    return false;
  }
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const uri = new URL(request.url).pathname.toLowerCase();
  return isSystemInfoPath(uri) ||
    isPlaybackMetaPath(uri) ||
    type.includes("mpegurl") ||
    type.includes("dash+xml") ||
    /\.(m3u8|mpd)$/i.test(uri);
}

async function rewriteResponseText(body, targetURL, inboundURL, node, env, headers) {
  if ((headers.get("content-type") || "").toLowerCase().includes("application/json") && isSystemInfoPath(new URL(inboundURL).pathname)) {
    return rewriteSystemInfo(body, publicNodeBase(inboundURL, node));
  }
  const mediaSourceBody = await rewriteMediaSourceJSON(body, targetURL, inboundURL, node, env);
  return rewriteBodyLinks(mediaSourceBody || body, targetURL, inboundURL, node, env);
}

async function rewriteMediaSourceJSON(body, targetURL, inboundURL, node, env) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return "";
  }
  const sources = Array.isArray(payload?.MediaSources) ? payload.MediaSources : null;
  if (!sources) {
    return "";
  }
  const currentHosts = currentNodeHosts(node, targetURL);
  const hostMap = await nodeHostMap(env);
  let changed = false;
  for (const source of sources) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of ["DirectStreamUrl", "TranscodingUrl", "StreamUrl"]) {
      if (typeof source[key] !== "string") {
        continue;
      }
      const rewritten = await rewriteMediaSourceURL(source[key], inboundURL, node, currentHosts, hostMap, env);
      if (rewritten && rewritten !== source[key]) {
        source[key] = rewritten;
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(payload) : "";
}

async function rewriteMediaSourceURL(raw, inboundURL, node, currentHosts, hostMap, env) {
  const value = String(raw || "").trim();
  if (!value || node.directExternal) {
    return "";
  }
  const publicBase = publicNodeBase(inboundURL, node);
  const publicBasePath = new URL(publicBase).pathname;
  if (value.startsWith("/")) {
    return "";
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return "";
  }
  if (url.origin === inboundURL.origin && isKnownPublicRoutePath(url.pathname, publicBasePath, hostMap)) {
    return "";
  }
  const host = url.host.toLowerCase();
  if (currentHosts.has(host)) {
    return publicBasePath + url.pathname + url.search + url.hash;
  }
  if (hostMap.has(host)) {
    return new URL(publicRouteBase(inboundURL.origin, hostMap.get(host))).pathname + url.pathname + url.search + url.hash;
  }
  return signedRawProxyURL(publicBasePath, url.toString(), env, node);
}

async function rewriteBodyLinks(body, targetURL, inboundURL, node, env) {
  const publicBase = publicNodeBase(inboundURL, node);
  const publicURL = new URL(publicBase);
  const currentHosts = currentNodeHosts(node, targetURL);
  const hostMap = await nodeHostMap(env);
  const replacements = new Map();
  for (const full of uniqueMatches(body, /https?:\/\/[^\s"'<>\\]+/gi)) {
    let url;
    try {
      url = new URL(full);
    } catch {
      continue;
    }
    if (url.origin === inboundURL.origin && isKnownPublicRoutePath(url.pathname, publicURL.pathname, hostMap)) {
      continue;
    }
    const host = url.host.toLowerCase();
    if (currentHosts.has(host)) {
      replacements.set(full, publicBase + url.pathname + url.search + url.hash);
    } else if (hostMap.has(host)) {
      const matched = hostMap.get(host);
      replacements.set(full, publicRouteBase(inboundURL.origin, matched) + url.pathname + url.search + url.hash);
    } else if (!node.directExternal) {
      const signed = await signedRawProxyURL(publicBase, full, env, node);
      if (signed) replacements.set(full, signed);
    }
  }
  let out = body;
  for (const [from, to] of replacements) {
    out = out.split(from).join(to);
  }
  out = rewriteRelativeMediaPaths(out, publicURL.pathname, publicBase);
  return out;
}

function currentNodeHosts(node, targetURL) {
  const hosts = new Set(splitTargets(node.targets).map((target) => {
    try {
      return new URL(target).host.toLowerCase();
    } catch {
      return "";
    }
  }).filter(Boolean));
  if (targetURL?.host) {
    hosts.add(targetURL.host.toLowerCase());
  }
  return hosts;
}

function isKnownPublicRoutePath(path, currentPublicBasePath, hostMap) {
  if (path === currentPublicBasePath || path.startsWith(currentPublicBasePath + "/")) {
    return true;
  }
  for (const node of hostMap.values()) {
    const routePath = new URL(publicRouteBase("https://example.invalid", node)).pathname;
    if (path === routePath || path.startsWith(routePath + "/")) {
      return true;
    }
  }
  return false;
}

function rewriteRelativeMediaPaths(body, publicBasePath, publicBase) {
  const pattern = /(^|["'\s(])((?:\/img\/|\/emby\/Items\/[^"'\s)]+\/Images\/|\/Items\/[^"'\s)]+\/Images\/)[^"'\s)]*)/ig;
  return body.replace(pattern, (match, prefix, path) => {
    if (publicBasePath && (path === publicBasePath || path.startsWith(publicBasePath + "/"))) {
      return match;
    }
    return prefix + publicBase + path;
  });
}

async function nodeHostMap(env) {
  const now = Date.now();
  if (nodeHostMapCache.map && nodeHostMapCache.expires > now) {
    return nodeHostMapCache.map;
  }
  const map = new Map();
  try {
    for (const item of await listNodes(env)) {
      for (const target of item.targets || []) {
        try {
          const url = new URL(target);
          if (url.host) {
            map.set(url.host.toLowerCase(), item);
          }
        } catch {
          // Ignore invalid target.
        }
      }
    }
  } catch {
    // Host index is best-effort on Workers.
  }
  nodeHostMapCache = { expires: now + 30000, map };
  return map;
}

function invalidateNodeHostMapCache() {
  nodeHostMapCache = { expires: 0, map: null };
}

function publicRouteBase(origin, node) {
  const parts = [encodeURIComponent(node.name)];
  if (node.secret) {
    parts.push(encodeURIComponent(node.secret));
  }
  return origin + "/" + parts.join("/");
}

function isSystemInfoPath(path) {
  const value = trimSlash(path).toLowerCase();
  return value === "system/info" || value === "system/info/public" || value.endsWith("/system/info") || value.endsWith("/system/info/public");
}

function rewriteSystemInfo(body, publicBase) {
  try {
    const payload = JSON.parse(body);
    let changed = false;
    for (const key of Object.keys(payload)) {
      if (!["localaddress", "wanaddress", "serveraddress", "remoteaddress", "manualaddress", "internaladdress"].includes(key.toLowerCase())) {
        continue;
      }
      if (typeof payload[key] === "string") {
        payload[key] = publicBase;
        changed = true;
      } else if (Array.isArray(payload[key])) {
        payload[key] = [publicBase];
        changed = true;
      }
    }
    return changed ? JSON.stringify(payload) : body;
  } catch {
    return body;
  }
}

async function rewriteLocation(headers, targetURL, inboundURL, node, env) {
  const location = headers.get("location");
  if (!location) {
    return;
  }
  try {
    const abs = new URL(location, targetURL);
    if (abs.origin === targetURL.origin) {
      const publicBase = publicNodeBase(inboundURL, node);
      headers.set("location", publicBase + abs.pathname + abs.search + abs.hash);
    } else if (!node.directExternal) {
      const publicBase = publicNodeBase(inboundURL, node);
      const signed = await signedRawProxyURL(publicBase, abs.toString(), env, node);
      if (signed) headers.set("location", signed);
    }
  } catch {
    // Ignore invalid upstream Location.
  }
}

function rewriteSetCookie(headers, node) {
  const cookie = headers.get("set-cookie");
  if (!cookie) {
    return;
  }
  const prefix = "/" + [encodeURIComponent(node.name), node.secret ? encodeURIComponent(node.secret) : ""].filter(Boolean).join("/");
  const rewritten = cookie
    .replace(/;\s*domain=[^;]+/gi, "")
    .replace(/;\s*path=[^;]+/gi, "; Path=" + prefix);
  headers.set("set-cookie", /;\s*path=/i.test(cookie) ? rewritten : rewritten + "; Path=" + prefix);
}

function applyResponsePolicy(headers, upstream, request, targetURL) {
  const streaming = isPlaybackStreamRequest(request, targetURL);
  if (streaming) {
    fillContentLengthFromContentRange(headers);
    if (upstream.status === 206 || headers.get("content-range") || /bytes/i.test(headers.get("accept-ranges") || "")) {
      headers.set("Accept-Ranges", "bytes");
    } else {
      headers.delete("Accept-Ranges");
    }
    headers.set("Cache-Control", "no-store, no-transform");
    if (/\.m3u8$/i.test(targetURL.pathname)) {
      headers.set("Content-Type", "application/vnd.apple.mpegurl");
    }
  }
  if (isImageRequest(targetURL.pathname)) {
    headers.delete("Set-Cookie");
    if (hasSensitiveRequestAuth(request)) {
      headers.set("Cache-Control", "private, no-store");
    } else {
      headers.set("Cache-Control", "public, max-age=2592000, s-maxage=2592000, immutable");
    }
  }
}

function fillContentLengthFromContentRange(headers) {
  if (headers.get("content-length")) {
    return;
  }
  const match = String(headers.get("content-range") || "").match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!match) {
    return;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    headers.set("Content-Length", String(end - start + 1));
  }
}

function publicNodeBase(inboundURL, node) {
  const parts = [encodeURIComponent(node.name)];
  if (node.secret) {
    parts.push(encodeURIComponent(node.secret));
  }
  return inboundURL.origin + "/" + parts.join("/");
}

function shouldUseDirectStream(node, request, path) {
  const mode = node.streamMode || "proxy";
  if (mode === "proxy") {
    return false;
  }
  if (!isStreamingPath(path, request) || request.method !== "GET") {
    return false;
  }
  if (mode === "direct") {
    return true;
  }
  if (!node.directExternal || isManifestRequestPath(path)) {
    return false;
  }
  const targetHasPortableAuth = [...new URL(request.url).searchParams.keys()]
    .some((key) => SENSITIVE_QUERY_KEYS.has(key.toLowerCase()));
  const requestUsesHeaderAuth = Boolean(
    request.headers.get("authorization") ||
    request.headers.get("cookie") ||
    request.headers.get("x-emby-token") ||
    request.headers.get("x-mediabrowser-token")
  );
  return !requestUsesHeaderAuth || targetHasPortableAuth;
}

function isStreamingPath(path, request) {
  return isPlaybackStreamPath(path, request);
}

function isPlaybackPath(path) {
  return isPlaybackControlPath(path) || isPlaybackMetaPath(path) || isPlaybackStreamPath(path);
}

function isPlaybackControlPath(path) {
  const value = normalizedEmbyAPIPath(path);
  return value.includes("/sessions/playing");
}

function isPlaybackMetaPath(path) {
  const value = normalizedEmbyAPIPath(path);
  return value.includes("/playbackinfo") || value.includes("/additionalparts");
}

function isPlaybackStreamPath(path, request) {
  const value = normalizedEmbyAPIPath(path);
  if (isPlaybackControlPath(value) || isPlaybackMetaPath(value)) {
    return false;
  }
  return value.includes("/smartstrm") ||
    value.includes("/playback/") ||
    (value.includes("/items/") && (value.includes("/download") || value.includes("/stream") || value.includes("/file"))) ||
    value.includes("/audio/") ||
    value.includes("/hls/") ||
    value.includes("/hls1/") ||
    value.includes("/dash/") ||
    (value.includes("/videos/") && (!request || request.headers.get("Range") !== null || value.includes("/stream") || value.includes("/original"))) ||
    /\.(mp4|m4v|m4s|m4a|ogv|webm|mkv|mov|avi|wmv|flv|ts|m3u8|mpd)$/i.test(value) ||
    /\.(flac|mp3|aac)(\?|$)/i.test(value);
}

function isPlaybackStreamRequest(request, targetURL) {
  if (!request || !targetURL || !["GET", "HEAD"].includes(request.method)) {
    return false;
  }
  return isPlaybackStreamPath(targetURL.pathname, request);
}

function isManifestRequestPath(path) {
  return /\.(m3u8|mpd)$/i.test(String(path || "").toLowerCase());
}

function isResourceIdentityRequest(request, targetURL) {
  if (!targetURL) {
    return false;
  }
  const path = targetURL.pathname || "/";
  return isPlaybackStreamRequest(request, targetURL) ||
    isImageRequest(path) ||
    normalizedEmbyAPIPath(path).includes("/additionalparts");
}

function isAuthenticationIdentityRequest(targetURL) {
  const path = normalizedEmbyAPIPath(targetURL?.pathname || "/");
  return path.includes("/users/authenticate") || path.startsWith("/quickconnect/");
}

function isCredentialAuthenticationRequest(targetURL) {
  const path = normalizedEmbyAPIPath(targetURL?.pathname || "/");
  return path.includes("/users/authenticate");
}

function sanitizeAuthenticationRetryHeaders(headers) {
  const allowed = new Set([
    "accept", "accept-encoding", "accept-language", "content-type", "user-agent",
    "x-emby-authorization", "x-mediabrowser-authorization",
    "x-emby-client", "x-mediabrowser-client",
    "x-emby-client-version", "x-mediabrowser-client-version",
    "x-emby-device-name", "x-mediabrowser-device-name",
    "x-emby-device-id", "x-mediabrowser-device-id",
    "x-emby-language", "x-mediabrowser-language",
    "x-emby-token", "x-mediabrowser-token"
  ]);
  for (const key of [...headers.keys()]) {
    if (!allowed.has(key.toLowerCase())) {
      headers.delete(key);
    }
  }
}

function normalizedEmbyAPIPath(path) {
  let value = "/" + trimSlash(String(path || "/")).toLowerCase();
  if (value === "/emby") {
    return "/";
  }
  if (value.startsWith("/emby/")) {
    value = value.slice(5);
  }
  return value;
}

function isImageRequest(path) {
  const value = String(path || "").toLowerCase();
  return /\/emby\/items\/.+\/images\//i.test(value) ||
    /\/images\/|\/icons\/|\/branding\/|\/emby\/covers\//i.test(value) ||
    /\.(jpg|jpeg|png|webp|gif|svg|ico)(\?|$)/i.test(value);
}

function requestKind(path, response, request) {
  if (isPlaybackStreamPath(path, request)) {
    return "playback";
  }
  const type = response.headers.get("content-type") || "";
  if (type.startsWith("image/")) {
    return "image";
  }
  return "request";
}

async function retryableBody(request) {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }
  const length = Number(request.headers.get("content-length") || "0");
  if (length > DEFAULT_RETRY_BODY_BYTES) {
    throw new Error("request body is too large for retry");
  }
  if (length > 0) return request.arrayBuffer();
  return readStreamBytesLimited(request.body, DEFAULT_RETRY_BODY_BYTES);
}

async function readStreamBytesLimited(stream, limit) {
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > limit) throw new BodyLimitError(limit);
      chunks.push(chunk);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output.buffer;
  } catch (err) {
    try { await reader.cancel(err); } catch {}
    throw err;
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function listNodes(env) {
  const { results } = await env.DB.prepare(`
    SELECT * FROM nodes ORDER BY sort_order ASC, name ASC
  `).all();
  return (results || []).map(rowToNode);
}

async function listNodesWithKeepalive(env) {
  const nodes = await listNodes(env);
  const [statuses, routes] = await Promise.all([
    keepaliveStatusMap(env, nodes),
    playbackRouteStateMap(env)
  ]);
  return nodes.map((node) => ({
    ...node,
    keepalive: statuses.get(node.name) || null,
    playbackRoute: routes.get(node.name) || null
  }));
}

async function getNode(env, name) {
  const row = await env.DB.prepare(`SELECT * FROM nodes WHERE name = ?`).bind(normalizeName(name)).first();
  return row ? rowToNode(row) : null;
}

async function getProxyNode(env, name) {
  const key = normalizeName(name);
  const now = Date.now();
  const cached = proxyNodeCache.get(key);
  if (cached && cached.expires > now) {
    return Object.prototype.hasOwnProperty.call(cached, "value") ? cached.value : cached.promise;
  }

  const promise = getNode(env, key)
    .catch(async (err) => {
      if (!isMissingSchemaError(err)) throw err;
      await ensureSchema(env);
      return getNode(env, key);
    })
    .then((node) => node ? proxyNodeFromNode(node) : null)
    .then((value) => {
      proxyNodeCache.set(key, { value, expires: Date.now() + PROXY_NODE_CACHE_TTL_MS });
      return value;
    })
    .catch((err) => {
      proxyNodeCache.delete(key);
      throw err;
    });

  proxyNodeCache.set(key, { promise, expires: now + PROXY_NODE_CACHE_TTL_MS });
  return promise;
}

function proxyNodeFromNode(node) {
  return {
    name: node.name,
    targets: [...(node.targets || [])],
    streamTarget: node.streamTarget || "",
    secret: node.secret || "",
    clientProfile: node.clientProfile || DEFAULT_CLIENT_PROFILE,
    impersonate: node.impersonate !== false,
      headerMode: node.headerMode || "dual",
      streamMode: node.streamMode || "proxy",
      streamStrategy: node.streamStrategy || "auto",
      streamTimeoutMs: Number(node.streamTimeoutMs || DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS),
      directExternal: Boolean(node.directExternal),
    cacheImage: node.cacheImage !== false,
    enabled: node.enabled !== false,
    keepaliveAt: node.keepaliveAt || "",
    createdAt: Number(node.createdAt || 0)
  };
}

function invalidateProxyNodeCache(...names) {
  for (const name of names) {
    const key = normalizeName(name || "");
    if (key) proxyNodeCache.delete(key);
  }
}

function isMissingSchemaError(err) {
  return /no such table:|table\s+\w+\s+does not exist|no column named|has no column named/i.test(errMessage(err));
}

async function saveNode(env, input) {
  const now = Date.now();
  const oldName = normalizeName(input.oldName || input.old_name || "");
  const nextName = normalizeName(input.name || "") || nameFromDisplay(input.displayName ?? input.display_name ?? "") || `node-${now.toString(36)}`;
  if (oldName && nextName && oldName !== nextName) {
    const existing = await getNode(env, nextName);
    if (existing) {
      throw new Error("node name already exists");
    }
  }
  const current = await getNode(env, oldName || nextName);
  const node = normalizeNode({ ...input, name: nextName }, current, now);
  if (current) {
    const credentialScopeChanged = current.clientProfile !== node.clientProfile ||
      current.embyUser !== node.embyUser ||
      current.name !== node.name ||
      nodeCredentialScope(current) !== nodeCredentialScope(node);
    const suppliedToken = cleanString(input.embyAccessToken ?? input.emby_access_token ?? "");
    const suppliedUserId = cleanString(input.embyUserId ?? input.emby_user_id ?? "");
    const suppliedProfile = cleanString(input.embyAuthProfile ?? input.emby_auth_profile ?? "");
    const hasMatchingImportedCredential = suppliedToken && suppliedUserId && suppliedProfile === node.clientProfile;
    if (credentialScopeChanged && !hasMatchingImportedCredential) {
      node.embyUserId = "";
      node.embyAccessToken = "";
      node.embyAuthProfile = "";
    }
  }
  const upsertNode = env.DB.prepare(`
    INSERT INTO nodes (
      name, display_name, targets, stream_target, secret, client_profile, impersonate,
      header_mode, stream_mode, direct_external, cache_image, tag, remark,
      icon, sort_order, enabled, auto_watch, renew_days, remind_before_days, keepalive_at,
      emby_user, emby_password, emby_user_id, emby_access_token, emby_auth_profile, emby_play_id,
      stream_strategy, stream_timeout_ms, watch_window_start, watch_window_end, watch_daily_limit,
      watch_content_type, watch_failure_backoff_min, watch_duration_min_sec, watch_duration_max_sec,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      display_name = excluded.display_name,
      targets = excluded.targets,
      stream_target = excluded.stream_target,
      secret = excluded.secret,
      client_profile = excluded.client_profile,
      impersonate = excluded.impersonate,
      header_mode = excluded.header_mode,
      stream_mode = excluded.stream_mode,
      direct_external = excluded.direct_external,
      cache_image = excluded.cache_image,
      tag = excluded.tag,
      remark = excluded.remark,
      icon = excluded.icon,
      sort_order = excluded.sort_order,
      enabled = excluded.enabled,
      auto_watch = excluded.auto_watch,
      renew_days = excluded.renew_days,
      remind_before_days = excluded.remind_before_days,
      keepalive_at = excluded.keepalive_at,
      emby_user = excluded.emby_user,
      emby_password = excluded.emby_password,
      emby_user_id = excluded.emby_user_id,
      emby_access_token = excluded.emby_access_token,
      emby_auth_profile = excluded.emby_auth_profile,
      emby_play_id = excluded.emby_play_id,
      stream_strategy = excluded.stream_strategy,
      stream_timeout_ms = excluded.stream_timeout_ms,
      watch_window_start = excluded.watch_window_start,
      watch_window_end = excluded.watch_window_end,
      watch_daily_limit = excluded.watch_daily_limit,
      watch_content_type = excluded.watch_content_type,
      watch_failure_backoff_min = excluded.watch_failure_backoff_min,
      watch_duration_min_sec = excluded.watch_duration_min_sec,
      watch_duration_max_sec = excluded.watch_duration_max_sec,
      updated_at = excluded.updated_at
  `).bind(
    node.name,
    node.displayName,
    JSON.stringify(node.targets),
    node.streamTarget,
    node.secret,
    node.clientProfile,
    node.impersonate ? 1 : 0,
    node.headerMode,
    node.streamMode,
    node.directExternal ? 1 : 0,
    node.cacheImage ? 1 : 0,
    node.tag,
    node.remark,
    node.icon,
    node.sortOrder,
    node.enabled ? 1 : 0,
    node.autoWatch ? 1 : 0,
    node.renewDays,
    node.remindBeforeDays,
    node.keepaliveAt,
    node.embyUser,
    node.embyPassword,
    node.embyUserId,
    node.embyAccessToken,
    node.embyAuthProfile,
    node.embyPlayId,
    node.streamStrategy,
    node.streamTimeoutMs,
    node.watchWindowStart,
    node.watchWindowEnd,
    node.watchDailyLimit,
    node.watchContentType,
    node.watchFailureBackoffMin,
    node.watchDurationMinSec,
    node.watchDurationMaxSec,
    current?.createdAt || now,
    now
  );
  if (oldName && oldName !== node.name) {
    await env.DB.batch([
      upsertNode,
      env.DB.prepare(`DELETE FROM keepalive_state WHERE node = ?`).bind(node.name),
      env.DB.prepare(`UPDATE keepalive_state SET node = ? WHERE node = ?`).bind(node.name, oldName),
      env.DB.prepare(`DELETE FROM playback_route_state WHERE node = ?`).bind(node.name),
      env.DB.prepare(`UPDATE playback_route_state SET node = ? WHERE node = ?`).bind(node.name, oldName),
      env.DB.prepare(`
        INSERT INTO line_performance (
          node, bucket_ts, kind, line_key, line_label, attempts, successes, failures,
          latency_ms_sum, last_latency_ms, transfer_count, transfer_bytes,
          transfer_ms_sum, last_bps, updated_at
        )
        SELECT ?, bucket_ts, kind, line_key, line_label, attempts, successes, failures,
               latency_ms_sum, last_latency_ms, transfer_count, transfer_bytes,
               transfer_ms_sum, last_bps, updated_at
        FROM line_performance WHERE node = ?
        ON CONFLICT(node, bucket_ts, kind, line_key) DO UPDATE SET
          attempts = attempts + excluded.attempts,
          successes = successes + excluded.successes,
          failures = failures + excluded.failures,
          latency_ms_sum = latency_ms_sum + excluded.latency_ms_sum,
          last_latency_ms = CASE WHEN excluded.updated_at >= updated_at THEN excluded.last_latency_ms ELSE last_latency_ms END,
          transfer_count = transfer_count + excluded.transfer_count,
          transfer_bytes = transfer_bytes + excluded.transfer_bytes,
          transfer_ms_sum = transfer_ms_sum + excluded.transfer_ms_sum,
          last_bps = CASE WHEN excluded.updated_at >= updated_at THEN excluded.last_bps ELSE last_bps END,
          updated_at = MAX(updated_at, excluded.updated_at)
      `).bind(node.name, oldName),
      env.DB.prepare(`DELETE FROM line_performance WHERE node = ?`).bind(oldName),
      env.DB.prepare(`
        UPDATE sim_watch_sessions
        SET status = 'failed', error = 'replaced by renamed node', access_token = ''
        WHERE node = ? AND status IN ('starting', 'running')
      `).bind(node.name),
      env.DB.prepare(`
        UPDATE sim_watch_sessions SET node = ?, display_name = ?
        WHERE node = ? AND status IN ('starting', 'running', 'notify_pending')
      `).bind(node.name, node.displayName || node.name, oldName),
      env.DB.prepare(`UPDATE visitor_logs SET node = ? WHERE node = ?`).bind(node.name, oldName),
      env.DB.prepare(`UPDATE watch_logs SET node = ?, display_name = ? WHERE node = ?`)
        .bind(node.name, node.displayName || node.name, oldName),
      env.DB.prepare(`DELETE FROM nodes WHERE name = ?`).bind(oldName)
    ]);
  } else {
    await upsertNode.run();
  }
  await ensureKeepaliveState(env, node);
  invalidateProxyNodeCache(oldName, node.name);
  invalidateTargetHealth(oldName);
  invalidateTargetHealth(node.name);
  invalidateNodeHostMapCache();
  return node;
}

function nodeCredentialScope(node) {
  const target = cleanString((node?.targets || [])[0] || node?.streamTarget || "");
  if (!target) return "";
  try {
    const url = new URL(target.includes("://") ? target : `https://${target}`);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return target.replace(/\/+$/, "");
  }
}

async function deleteNode(env, name) {
  const nodeName = normalizeName(name);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM nodes WHERE name = ?`).bind(nodeName),
    env.DB.prepare(`DELETE FROM keepalive_state WHERE node = ?`).bind(nodeName),
    env.DB.prepare(`DELETE FROM playback_route_state WHERE node = ?`).bind(nodeName),
    env.DB.prepare(`
      UPDATE sim_watch_sessions
      SET status = 'failed', error = 'node deleted', access_token = '', next_tick_at = ?
      WHERE node = ? AND status IN ('starting', 'running', 'notify_pending')
    `).bind(Date.now(), nodeName)
  ]);
  invalidateProxyNodeCache(nodeName);
  invalidateTargetHealth(nodeName);
  invalidateNodeHostMapCache();
}

async function reorderNodes(env, names) {
  let index = 0;
  for (const name of names) {
    await env.DB.prepare(`UPDATE nodes SET sort_order = ?, updated_at = ? WHERE name = ?`)
      .bind(index++, Date.now(), normalizeName(name))
      .run();
  }
  invalidateNodeHostMapCache();
}

function rowToNode(row) {
  return {
    name: row.name,
    displayName: row.display_name || "",
    targets: parseTargets(row.targets),
    streamTarget: row.stream_target || "",
    secret: row.secret || "",
    clientProfile: normalizeClientProfile(row.client_profile),
    impersonate: row.impersonate !== 0,
    headerMode: row.header_mode || "dual",
    streamMode: row.stream_mode || "proxy",
    streamStrategy: row.stream_strategy || "auto",
    streamTimeoutMs: Number(row.stream_timeout_ms || DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS),
    directExternal: Boolean(row.direct_external),
    cacheImage: row.cache_image !== 0,
    tag: row.tag || "",
    remark: row.remark || "",
    icon: row.icon || "",
    sortOrder: Number(row.sort_order || 0),
    enabled: row.enabled !== 0,
    autoWatch: Boolean(row.auto_watch),
    renewDays: Number(row.renew_days || 0),
    remindBeforeDays: Number(row.remind_before_days || 0),
    keepaliveAt: row.keepalive_at || "",
    embyUser: row.emby_user || "",
    embyPassword: row.emby_password || "",
    embyUserId: row.emby_user_id || "",
    embyAccessToken: row.emby_access_token || "",
    embyAuthProfile: row.emby_auth_profile ? normalizeClientProfile(row.emby_auth_profile) : "",
    embyPlayId: row.emby_play_id || "",
    watchWindowStart: Number(row.watch_window_start ?? 0),
    watchWindowEnd: Number(row.watch_window_end ?? 24),
    watchDailyLimit: Number(row.watch_daily_limit ?? 1),
    watchContentType: row.watch_content_type || "mixed",
    watchFailureBackoffMin: Number(row.watch_failure_backoff_min ?? 360),
    watchDurationMinSec: Number(row.watch_duration_min_sec ?? SIMULATED_WATCH_DURATION_MIN_SEC),
    watchDurationMaxSec: Number(row.watch_duration_max_sec ?? SIMULATED_WATCH_DURATION_MAX_SEC),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  };
}

function normalizeNode(input, current, now) {
  const name = normalizeName(input.name || "") || nameFromDisplay(input.displayName ?? input.display_name ?? current?.displayName ?? "") || current?.name || `node-${now.toString(36)}`;
  if (!name) {
    throw new Error("节点名不能为空。节点名只支持英文、数字、短横线和下划线。");
  }
  const targets = parseTargets(input.targets ?? input.target ?? current?.targets ?? []);
  if (targets.length === 0) {
    throw new Error("node target is required");
  }
  const watchWindowStart = clampInt(input.watchWindowStart ?? input.watch_window_start ?? current?.watchWindowStart ?? 0, 0, 23);
  const watchWindowEnd = Math.max(watchWindowStart + 1, clampInt(input.watchWindowEnd ?? input.watch_window_end ?? current?.watchWindowEnd ?? 24, 1, 24));
  const watchDurationMinSec = clampInt(input.watchDurationMinSec ?? input.watch_duration_min_sec ?? current?.watchDurationMinSec ?? SIMULATED_WATCH_DURATION_MIN_SEC, 60, 3600);
  const watchDurationMaxSec = Math.max(watchDurationMinSec, clampInt(input.watchDurationMaxSec ?? input.watch_duration_max_sec ?? current?.watchDurationMaxSec ?? SIMULATED_WATCH_DURATION_MAX_SEC, 60, 3600));
  return {
    name,
    displayName: cleanString(input.displayName ?? input.display_name ?? current?.displayName ?? name),
    targets,
    streamTarget: splitTargets(input.streamTarget ?? input.stream_target ?? current?.streamTarget ?? "").join("\n"),
    secret: cleanString(input.secret ?? current?.secret ?? ""),
    clientProfile: enumValue(input.clientProfile ?? input.client_profile ?? current?.clientProfile, CLIENT_PROFILES.map((item) => item.id), DEFAULT_CLIENT_PROFILE),
    impersonate: boolDefault(input.impersonate ?? current?.impersonate, true),
    headerMode: enumValue(input.headerMode ?? input.header_mode ?? current?.headerMode, ["off", "realip_only", "dual", "strict"], "dual"),
    streamMode: enumValue(input.streamMode ?? input.stream_mode ?? current?.streamMode, ["proxy", "direct", "auto"], "proxy"),
    streamStrategy: enumValue(input.streamStrategy ?? input.stream_strategy ?? current?.streamStrategy, ["auto", "priority"], "auto"),
    streamTimeoutMs: clampInt(input.streamTimeoutMs ?? input.stream_timeout_ms ?? current?.streamTimeoutMs ?? DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS, 500, 10000),
    directExternal: boolValue(input.directExternal ?? input.direct_external ?? current?.directExternal ?? false),
    cacheImage: boolValue(input.cacheImage ?? input.cache_image ?? current?.cacheImage ?? true),
    tag: cleanString(input.tag ?? current?.tag ?? ""),
    remark: cleanString(input.remark ?? current?.remark ?? ""),
    icon: cleanString(input.icon ?? current?.icon ?? "") || DEFAULT_NODE_ICON,
    sortOrder: intValue(input.sortOrder ?? input.sort_order ?? current?.sortOrder ?? 0),
    enabled: boolValue(input.enabled ?? current?.enabled ?? true),
    autoWatch: boolValue(input.autoWatch ?? input.auto_watch ?? current?.autoWatch ?? false),
    renewDays: intValue(input.renewDays ?? input.renew_days ?? current?.renewDays ?? 0),
    remindBeforeDays: intValue(input.remindBeforeDays ?? input.remind_before_days ?? current?.remindBeforeDays ?? 0),
    keepaliveAt: cleanString(input.keepaliveAt ?? input.keepalive_at ?? current?.keepaliveAt ?? ""),
    embyUser: cleanString(input.embyUser ?? input.emby_user ?? current?.embyUser ?? ""),
    embyPassword: cleanString(input.embyPassword ?? input.emby_password ?? current?.embyPassword ?? ""),
    embyUserId: cleanString(input.embyUserId ?? input.emby_user_id ?? current?.embyUserId ?? ""),
    embyAccessToken: cleanString(input.embyAccessToken ?? input.emby_access_token ?? current?.embyAccessToken ?? ""),
    embyAuthProfile: cleanString(input.embyAuthProfile ?? input.emby_auth_profile ?? current?.embyAuthProfile ?? ""),
    embyPlayId: cleanString(input.embyPlayId ?? input.emby_play_id ?? current?.embyPlayId ?? ""),
    watchWindowStart,
    watchWindowEnd,
    watchDailyLimit: clampInt(input.watchDailyLimit ?? input.watch_daily_limit ?? current?.watchDailyLimit ?? 1, 1, 20),
    watchContentType: enumValue(input.watchContentType ?? input.watch_content_type ?? current?.watchContentType, ["mixed", "movie", "episode"], "mixed"),
    watchFailureBackoffMin: clampInt(input.watchFailureBackoffMin ?? input.watch_failure_backoff_min ?? current?.watchFailureBackoffMin ?? 360, 10, 1440),
    watchDurationMinSec,
    watchDurationMaxSec,
    createdAt: current?.createdAt || now,
    updatedAt: now
  };
}

async function getStats(env) {
  const day = beijingDay();
  const rows = await env.DB.prepare(`
    SELECT node, kind, count, bytes FROM request_stats WHERE day = ? ORDER BY count DESC
  `).bind(day).all();
  const recent = await env.DB.prepare(`
    SELECT node, ts, ip, country, ua, outbound_profile, outbound_ua, outbound_device, method, path, status
    FROM visitor_logs ORDER BY ts DESC LIMIT 30
  `).all();
  return { day, today: rows.results || [], recent: recent.results || [] };
}

async function getPerformanceMetrics(env, requestedHours = 24) {
  const hours = [1, 6, 24, 168].includes(Number(requestedHours)) ? Number(requestedHours) : 24;
  const since = Date.now() - hours * 60 * 60 * 1000;
  const [metricRows, lineRows] = await Promise.all([
    env.DB.prepare(`
      SELECT * FROM performance_metrics WHERE bucket_ts >= ? ORDER BY bucket_ts ASC
    `).bind(since).all(),
    env.DB.prepare(`
      SELECT node, kind, line_key, line_label,
             SUM(attempts) AS attempts, SUM(successes) AS successes, SUM(failures) AS failures,
             SUM(latency_ms_sum) AS latency_ms_sum, MAX(updated_at) AS updated_at
      FROM line_performance WHERE bucket_ts >= ?
      GROUP BY node, kind, line_key, line_label
      ORDER BY attempts DESC
    `).bind(since).all()
  ]);
  const rows = metricRows.results || [];
  const byNode = new Map();
  const summary = emptyPerformanceAggregate("all");
  const timeline = new Map();
  for (const row of rows) {
    mergePerformanceAggregate(summary, row);
    const node = row.node || "-";
    if (!byNode.has(node)) byNode.set(node, emptyPerformanceAggregate(node));
    mergePerformanceAggregate(byNode.get(node), row);
    const bucket = Number(row.bucket_ts || 0);
    if (!timeline.has(bucket)) timeline.set(bucket, emptyPerformanceAggregate(String(bucket)));
    mergePerformanceAggregate(timeline.get(bucket), row);
  }
  return {
    hours,
    generatedAt: Date.now(),
    summary: finishPerformanceAggregate(summary),
    nodes: [...byNode.values()].map(finishPerformanceAggregate).sort((a, b) => b.requests - a.requests),
    lines: (lineRows.results || []).map((row) => {
      const attempts = Number(row.attempts || 0);
      const successes = Number(row.successes || 0);
      const failures = Number(row.failures || 0);
      return {
        node: row.node || "-",
        kind: row.kind || "api",
        key: row.line_key || "",
        label: row.line_label || "-",
        attempts,
        successes,
        failures,
        successRate: attempts ? Number((successes * 100 / attempts).toFixed(1)) : 0,
        avgMs: attempts ? Number((Number(row.latency_ms_sum || 0) / attempts).toFixed(1)) : 0,
        updatedAt: Number(row.updated_at || 0)
      };
    }),
    timeline: [...timeline.entries()].map(([bucket, item]) => ({ bucket, ...finishPerformanceAggregate(item) })).slice(-120)
  };
}

function emptyPerformanceAggregate(name) {
  return {
    node: name,
    requests: 0,
    successes: 0,
    errors: 0,
    failovers: 0,
    nodeMs: 0,
    upstreamMs: 0,
    rewriteMs: 0,
    totalMs: 0,
    maxMs: 0,
    histogram: Array(7).fill(0)
  };
}

function mergePerformanceAggregate(target, row) {
  target.requests += Number(row.request_count || 0);
  target.successes += Number(row.success_count || 0);
  target.errors += Number(row.error_count || 0);
  target.failovers += Number(row.failover_count || 0);
  target.nodeMs += Number(row.node_ms_sum || 0);
  target.upstreamMs += Number(row.upstream_ms_sum || 0);
  target.rewriteMs += Number(row.rewrite_ms_sum || 0);
  target.totalMs += Number(row.total_ms_sum || 0);
  target.maxMs = Math.max(target.maxMs, Number(row.total_ms_max || 0));
  ["b100", "b250", "b500", "b1000", "b2500", "b5000", "bslow"].forEach((key, index) => {
    target.histogram[index] += Number(row[key] || 0);
  });
  return target;
}

function finishPerformanceAggregate(item) {
  const requests = Math.max(0, Number(item.requests || 0));
  const average = (value) => requests ? Number((Number(value || 0) / requests).toFixed(1)) : 0;
  return {
    node: item.node,
    requests,
    successes: Number(item.successes || 0),
    errors: Number(item.errors || 0),
    errorRate: requests ? Number((Number(item.errors || 0) * 100 / requests).toFixed(2)) : 0,
    failovers: Number(item.failovers || 0),
    avgNodeMs: average(item.nodeMs),
    avgUpstreamMs: average(item.upstreamMs),
    avgRewriteMs: average(item.rewriteMs),
    avgTotalMs: average(item.totalMs),
    p50Ms: histogramPercentile(item.histogram, 0.5),
    p95Ms: histogramPercentile(item.histogram, 0.95),
    maxMs: Number(Number(item.maxMs || 0).toFixed(1))
  };
}

function histogramPercentile(histogram, percentile) {
  const values = Array.isArray(histogram) ? histogram : [];
  const total = values.reduce((sum, value) => sum + Number(value || 0), 0);
  if (!total) return 0;
  const target = Math.max(1, Math.ceil(total * percentile));
  const limits = [100, 250, 500, 1000, 2500, 5000, 7500];
  let cumulative = 0;
  for (let index = 0; index < values.length; index++) {
    cumulative += Number(values[index] || 0);
    if (cumulative >= target) return limits[index];
  }
  return limits.at(-1);
}

async function cleanOldPerformanceMetrics(env) {
  if (!env.DB) return;
  const cutoff = Date.now() - PERFORMANCE_RETENTION_MS;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM performance_metrics WHERE bucket_ts < ?`).bind(cutoff),
    env.DB.prepare(`DELETE FROM line_performance WHERE bucket_ts < ?`).bind(cutoff)
  ]);
}

function recordProxyResponse(ctx, env, request, node, path, response, kind, timing = null) {
  const bytes = kind === "playback" ? streamByteEstimate(response) : contentLength(response);
  ctx.waitUntil(recordRequest(env, request, node, path, response.status, bytes, kind, timing));
  return response;
}

function completeProxyResponse(ctx, env, request, node, path, response, kind, timing) {
  const finished = withServerTiming(response, timing);
  return recordProxyResponse(ctx, env, request, node, path, finished, kind, timing);
}

function createProxyTiming() {
  return { started: performanceNow(), node: 0, upstream: 0, rewrite: 0, attempts: 0, total: 0, targetOutcomes: [] };
}

function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function withServerTiming(response, timing) {
  const total = Math.max(0, performanceNow() - Number(timing?.started || 0));
  if (timing) timing.total = total;
  const entries = [
    ["node", Number(timing?.node || 0)],
    ["upstream", Number(timing?.upstream || 0)],
    ["rewrite", Number(timing?.rewrite || 0)],
    ["total", total]
  ].filter(([, duration]) => Number.isFinite(duration) && duration >= 0)
    .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`);
  const headers = new Headers(response.headers);
  const attempts = Math.max(0, Number(timing?.attempts || 0));
  headers.set("Server-Timing", entries.concat(`attempts;desc=\"${attempts}\"`).join(", "));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function streamByteEstimate(response) {
  const match = String(response.headers.get("content-range") || "").match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (match) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return end - start + 1;
    }
  }
  return contentLength(response);
}

async function recordRequest(env, request, node, path, status, bytes, kind, timing = null) {
  const now = Date.now();
  const day = beijingDay(now);
  const nodeName = node?.name || "";
  const ip = request.headers.get("cf-connecting-ip") || "";
  const country = request.headers.get("cf-ipcountry") || "";
  const ua = request.headers.get("user-agent") || "";
  const statements = [env.DB.prepare(`
      INSERT INTO request_stats (node, day, kind, count, bytes, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(node, day, kind) DO UPDATE SET
        count = count + 1,
        bytes = bytes + excluded.bytes,
        updated_at = excluded.updated_at
    `).bind(nodeName, day, kind, bytes || 0, now)];
  if (timing) {
    statements.push(performanceMetricStatement(env, nodeName, kind, status, timing, now));
    for (const outcome of timing.targetOutcomes || []) {
      statements.push(linePerformanceStatement(env, nodeName, outcome, now));
    }
  }
  if (shouldRecordVisitorLog(kind, status, nodeName, ip, now)) {
    let identityState = null;
    if (node?.impersonate !== false) {
      try {
        identityState = await getIdentityState(env);
      } catch {
        // Logging still records the configured profile when identity storage is unavailable.
      }
    }
    const outbound = logClientIdentity(node, identityState, ua);
    statements.push(env.DB.prepare(`
      INSERT INTO visitor_logs (
        node, ts, ip, country, ua, outbound_profile, outbound_ua, outbound_device, method, path, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      nodeName, now, ip, country, ua.slice(0, 300),
      outbound.profile, outbound.ua.slice(0, 300), outbound.device.slice(0, 128),
      request.method, path.slice(0, 500), status
    ));
  }
  await env.DB.batch(statements);
  const route = playbackRouteResult(kind, status, now);
  if (route) {
    await markPlaybackRoute(env, nodeName, route.mode, route.ts, route.status);
  }
  if (kind === "playback" && status < 400 && isKeepalivePlaybackPath(path)) {
    await markKeepalivePlayback(env, nodeName, now);
  }
}

function playbackRouteResult(kind, status, ts = Date.now()) {
  const code = Number(status || 0);
  if (code < 200 || code >= 400) return null;
  if (kind === "direct") return { mode: "direct", ts, status: code };
  if (kind === "playback") return { mode: "proxy", ts, status: code };
  return null;
}

async function markPlaybackRoute(env, nodeName, mode, ts, status) {
  const node = normalizeName(nodeName);
  const routeMode = mode === "direct" ? "direct" : "proxy";
  if (!node) return;
  const now = Date.now();
  const cached = playbackRouteWriteCache.get(node);
  if (cached?.mode === routeMode && Number(cached.expires || 0) > now) return;
  const statement = () => env.DB.prepare(`
    INSERT INTO playback_route_state (node, mode, ts, status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(node) DO UPDATE SET
      mode = excluded.mode,
      ts = excluded.ts,
      status = excluded.status
    WHERE playback_route_state.mode != excluded.mode
       OR excluded.ts - playback_route_state.ts >= ${PLAYBACK_AUX_WRITE_INTERVAL_MS}
  `).bind(node, routeMode, ts, status);
  try {
    await statement().run();
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    await ensurePlaybackRouteTable(env);
    await statement().run();
  }
  playbackRouteWriteCache.set(node, { mode: routeMode, expires: now + PLAYBACK_AUX_WRITE_INTERVAL_MS });
  trimPlaybackRouteWriteCache(now);
}

function trimPlaybackRouteWriteCache(now = Date.now()) {
  if (playbackRouteWriteCache.size <= 512) return;
  for (const [key, value] of playbackRouteWriteCache) {
    if (Number(value?.expires || 0) <= now) playbackRouteWriteCache.delete(key);
  }
  while (playbackRouteWriteCache.size > 512) {
    playbackRouteWriteCache.delete(playbackRouteWriteCache.keys().next().value);
  }
}

async function ensurePlaybackRouteTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS playback_route_state (
      node TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status INTEGER DEFAULT 0
    )
  `).run();
}

async function playbackRouteStateMap(env) {
  let rows;
  try {
    rows = await env.DB.prepare(`SELECT node, mode, ts, status FROM playback_route_state`).all();
  } catch (err) {
    if (!isMissingSchemaError(err)) throw err;
    await ensurePlaybackRouteTable(env);
    rows = await env.DB.prepare(`SELECT node, mode, ts, status FROM playback_route_state`).all();
  }
  return new Map((rows.results || []).map((row) => [row.node, {
    mode: row.mode === "direct" ? "direct" : "proxy",
    ts: Number(row.ts || 0),
    status: Number(row.status || 0)
  }]));
}

function logClientIdentity(node, identityState, inboundUA = "") {
  if (node?.impersonate === false) {
    return { profile: "disabled", ua: cleanString(inboundUA).slice(0, 300), device: "" };
  }
  const profile = getClientProfile(node?.clientProfile || DEFAULT_CLIENT_PROFILE);
  const snapshot = profileSnapshot(profile.id, identityState);
  return {
    profile: profile.id,
    ua: cleanString(snapshot.ua).slice(0, 300),
    device: cleanString(snapshot.device).slice(0, 128)
  };
}

function performanceMetricStatement(env, nodeName, kind, status, timing, now) {
  const bucketTs = Math.floor(now / 60000) * 60000;
  const total = Math.max(0, Number(timing?.total || 0));
  const histogram = performanceHistogram(total);
  const failovers = Math.max(0, Number(timing?.attempts || 0) - 1);
  return env.DB.prepare(`
    INSERT INTO performance_metrics (
      node, bucket_ts, kind, request_count, success_count, error_count, failover_count,
      node_ms_sum, upstream_ms_sum, rewrite_ms_sum, total_ms_sum, total_ms_max,
      b100, b250, b500, b1000, b2500, b5000, bslow, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(node, bucket_ts, kind) DO UPDATE SET
      request_count = request_count + 1,
      success_count = success_count + excluded.success_count,
      error_count = error_count + excluded.error_count,
      failover_count = failover_count + excluded.failover_count,
      node_ms_sum = node_ms_sum + excluded.node_ms_sum,
      upstream_ms_sum = upstream_ms_sum + excluded.upstream_ms_sum,
      rewrite_ms_sum = rewrite_ms_sum + excluded.rewrite_ms_sum,
      total_ms_sum = total_ms_sum + excluded.total_ms_sum,
      total_ms_max = MAX(total_ms_max, excluded.total_ms_max),
      b100 = b100 + excluded.b100,
      b250 = b250 + excluded.b250,
      b500 = b500 + excluded.b500,
      b1000 = b1000 + excluded.b1000,
      b2500 = b2500 + excluded.b2500,
      b5000 = b5000 + excluded.b5000,
      bslow = bslow + excluded.bslow,
      updated_at = excluded.updated_at
  `).bind(
    nodeName, bucketTs, kind,
    Number(status) < 400 ? 1 : 0,
    Number(status) >= 400 ? 1 : 0,
    failovers,
    Math.max(0, Number(timing?.node || 0)),
    Math.max(0, Number(timing?.upstream || 0)),
    Math.max(0, Number(timing?.rewrite || 0)),
    total,
    total,
    ...histogram,
    now
  );
}

function performanceHistogram(totalMs) {
  const limits = [100, 250, 500, 1000, 2500, 5000];
  const buckets = Array(7).fill(0);
  const index = limits.findIndex((limit) => totalMs < limit);
  buckets[index < 0 ? 6 : index] = 1;
  return buckets;
}

function linePerformanceStatement(env, nodeName, outcome, now) {
  const bucketTs = Math.floor(now / 60000) * 60000;
  const success = outcome.result === "success" ? 1 : 0;
  const failure = success ? 0 : 1;
  return env.DB.prepare(`
    INSERT INTO line_performance (
      node, bucket_ts, kind, line_key, line_label, attempts, successes, failures,
      latency_ms_sum, last_latency_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(node, bucket_ts, kind, line_key) DO UPDATE SET
      line_label = excluded.line_label,
      attempts = attempts + 1,
      successes = successes + excluded.successes,
      failures = failures + excluded.failures,
      latency_ms_sum = latency_ms_sum + excluded.latency_ms_sum,
      last_latency_ms = excluded.last_latency_ms,
      updated_at = MAX(updated_at, excluded.updated_at)
  `).bind(
    nodeName,
    bucketTs,
    outcome.kind || "api",
    outcome.key,
    outcome.label,
    success,
    failure,
    Math.max(0, Number(outcome.latencyMs || 0)),
    Math.max(0, Number(outcome.latencyMs || 0)),
    now
  );
}

function shouldRecordVisitorLog(kind, status, nodeName, ip, now = Date.now()) {
  if (kind !== "playback" || Number(status) >= 400) return true;
  const key = `${normalizeName(nodeName)}\n${String(ip || "-")}`;
  if (Number(playbackVisitorSampleCache.get(key) || 0) > now) return false;
  playbackVisitorSampleCache.set(key, now + PLAYBACK_AUX_WRITE_INTERVAL_MS);
  trimExpiryCache(playbackVisitorSampleCache, now, 2048);
  return true;
}

function trimExpiryCache(cache, now, maxSize) {
  if (cache.size <= maxSize) return;
  for (const [key, expires] of cache) {
    if (Number(expires || 0) <= now) cache.delete(key);
  }
  while (cache.size > maxSize) cache.delete(cache.keys().next().value);
}

function isKeepalivePlaybackPath(path) {
  const value = normalizedEmbyAPIPath(path);
  if (value.includes("/playbackinfo") || value.includes("/sessions/playing") || value.includes("/additionalparts")) {
    return false;
  }
  return isPlaybackStreamPath(value);
}

async function ensureKeepaliveTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS keepalive_state (
      node TEXT PRIMARY KEY,
      anchor_ts INTEGER NOT NULL,
      last_play_ts INTEGER DEFAULT 0,
      last_notify_day TEXT DEFAULT '',
      notify_count INTEGER DEFAULT 0
    )
  `).run();
}


function parseKeepaliveAt(value) {
  const raw = cleanString(value);
  if (!raw) return 0;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return n < 10000000000 ? n * 1000 : n;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function ensureKeepaliveState(env, node) {
  if (!node?.name || !node.renewDays) {
    return;
  }
  const anchor = parseKeepaliveAt(node.keepaliveAt) || node.createdAt || Date.now();
  await env.DB.prepare(`
    INSERT INTO keepalive_state (node, anchor_ts, last_play_ts, last_notify_day, notify_count)
    VALUES (?, ?, 0, '', 0)
    ON CONFLICT(node) DO UPDATE SET
      anchor_ts = CASE WHEN excluded.anchor_ts > 0 THEN excluded.anchor_ts ELSE keepalive_state.anchor_ts END
  `).bind(node.name, anchor).run();
}

async function markKeepalivePlayback(env, nodeName, ts) {
  const key = normalizeName(nodeName);
  const now = Date.now();
  if (Number(playbackKeepaliveWriteCache.get(key) || 0) > now) return;
  playbackKeepaliveWriteCache.set(key, now + PLAYBACK_AUX_WRITE_INTERVAL_MS);
  trimExpiryCache(playbackKeepaliveWriteCache, now, 512);
  const node = await getProxyNode(env, nodeName);
  const anchor = parseKeepaliveAt(node?.keepaliveAt) || node?.createdAt || ts;
  const statement = () => env.DB.prepare(`
    INSERT INTO keepalive_state (node, anchor_ts, last_play_ts, last_notify_day, notify_count)
    VALUES (?, ?, ?, '', 0)
    ON CONFLICT(node) DO UPDATE SET
      last_play_ts = MAX(last_play_ts, excluded.last_play_ts)
  `).bind(key, anchor, ts);
  try {
    await statement().run();
  } catch (err) {
    if (isMissingSchemaError(err)) {
      await ensureKeepaliveTable(env);
      await statement().run();
      return;
    }
    playbackKeepaliveWriteCache.delete(key);
    throw err;
  }
}

async function getKeepaliveStatuses(env) {
  return Array.from((await keepaliveStatusMap(env, await listNodes(env))).values());
}

async function keepaliveStatusMap(env, nodes) {
  const rows = await env.DB.prepare(`SELECT * FROM keepalive_state`).all();
  const state = new Map((rows.results || []).map((row) => [row.node, row]));
  const now = Date.now();
  const map = new Map();
  for (const node of nodes) {
    if (!node.renewDays) {
      continue;
    }
    const current = state.get(node.name) || {};
    const anchor = parseKeepaliveAt(node.keepaliveAt) || Number(current.anchor_ts || 0) || node.createdAt || now;
    const lastPlay = Number(current.last_play_ts || 0);
    const base = Math.max(anchor, lastPlay);
    const elapsedDays = Math.max(0, Math.floor((now - base) / 86400000));
    const remainDays = node.renewDays - elapsedDays;
    const status = remainDays <= 0 ? "due" : (remainDays <= Math.max(0, node.remindBeforeDays) ? "warn" : "ok");
    map.set(node.name, {
      node: node.name,
      displayName: node.displayName || node.name,
      renewDays: node.renewDays,
      remindBeforeDays: node.remindBeforeDays,
      anchorTs: anchor,
      lastPlayTs: lastPlay,
      effectiveTs: base,
      elapsedDays,
      remainDays,
      status,
      lastNotifyDay: current.last_notify_day || "",
      notifyCount: Number(current.notify_count || 0),
      enabled: node.enabled !== false
    });
  }
  return map;
}

async function resetKeepalive(env, body, ctx = null) {
  const name = normalizeName(body.name || "");
  if (!name) return { ok: false, error: "missing node name" };
  const node = await getNode(env, name);
  if (!node) return { ok: false, error: "node not found" };
  if (!node.embyUser || !(node.embyPassword || node.embyAccessToken)) {
    return { ok: false, error: "请先在节点配置 Emby 用户名和密码（或 AccessToken）" };
  }
  const work = async () => {
    try {
      return await startWatchSession(env, {
        node,
        source: body.source || "manual",
        note: body.note || "手动真实模拟观看",
        remainDays: null,
        renewDays: node.renewDays
      });
    } catch (err) {
      const error = errMessage(err);
      try {
        await insertWatchLog(env, {
          node: name,
          displayName: node.displayName || name,
          ts: Date.now(),
          source: body.source || "manual",
          note: `启动失败：${error}`.slice(0, 300),
          durationSec: 0,
          startedAt: Date.now(),
          endedAt: Date.now(),
          title: "（启动失败）",
          itemId: ""
        });
      } catch {}
      if (body.notify !== false) {
        try {
          await notifySimulatedWatchFailure(env, {
            node: name,
            displayName: node.displayName || name,
            source: body.source || "manual",
            error,
            endedAt: Date.now()
          }, {});
        } catch {}
      }
      throw err;
    }
  };
  if (ctx) {
    // 启动会话是短任务；进度由分钟 cron 推进
    const started = await work();
    return {
      ok: true,
      accepted: true,
      pending: true,
      sessionId: started.sessionId,
      node: name,
      displayName: node.displayName || name,
      title: started.title,
      itemId: started.itemId,
      durationSec: started.targetDurationSec,
      startedAt: started.startedAt,
      message: `真实模拟已开始：${started.title || "条目"}\n预计 5-7.5 分钟内结束，期间按真实墙钟上报进度；完成后通知 TG。`
    };
  }
  const started = await work();
  return { ok: true, pending: true, ...started, node: name, displayName: node.displayName || name };
}

function randomSimulatedWatchDurationSec(node = null) {
  const min = Math.max(60, Number(node?.watchDurationMinSec || SIMULATED_WATCH_DURATION_MIN_SEC));
  const max = Math.max(min, Number(node?.watchDurationMaxSec || SIMULATED_WATCH_DURATION_MAX_SEC));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function formatDurationSec(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min <= 0) {
    return `${sec} 秒`;
  }
  return `${min} 分 ${String(sec).padStart(2, "0")} 秒`;
}

function sleepMs(ms) {
  const wait = Math.max(0, Number(ms || 0));
  return new Promise((resolve) => setTimeout(resolve, wait));
}

function randomUUIDLike() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function embyTicks(seconds) {
  return Math.max(0, Math.round(Number(seconds || 0) * 10000000));
}

function nodeUpstreamBase(node) {
  const target = cleanString((node.targets || [])[0] || node.streamTarget || "");
  if (!target) {
    throw new Error("节点未配置上游地址");
  }
  const url = new URL(target.includes("://") ? target : `https://${target}`);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function buildEmbyAuthHeader(profile, device, deviceId, token = "", userId = "") {
  const client = profile?.client || "Emby";
  const version = profile?.version || "4.8.0";
  const parts = [
    `MediaBrowser Client="${String(client).replace(/"/g, "")}"`,
    `Device="${String(device || profile?.device || "Android").replace(/"/g, "")}"`,
    `DeviceId="${String(deviceId).replace(/"/g, "")}"`,
    `Version="${String(version).replace(/"/g, "")}"`
  ];
  if (token) parts.push(`Token="${String(token).replace(/"/g, "")}"`);
  if (userId) parts.push(`UserId="${String(userId).replace(/"/g, "")}"`);
  return parts.join(", ");
}

function embyDeviceProfile() {
  return {
    MaxStreamingBitrate: 40000000,
    MaxStaticBitrate: 40000000,
    MusicStreamingTranscodingBitrate: 192000,
    DirectPlayProfiles: [
      { Container: "mp4,m4v,mkv,webm,ts,mov", Type: "Video", VideoCodec: "h264,hevc,vp8,vp9,av1", AudioCodec: "aac,mp3,ac3,eac3,flac,opus" }
    ],
    TranscodingProfiles: [
      { Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac", Protocol: "hls", EstimateContentLength: false, EnableMpegtsM2TsMode: false, TranscodeSeekInfo: "Auto", CopyTimestamps: false, Context: "Streaming", MaxAudioChannels: "6" }
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: [
      { Format: "srt", Method: "External" },
      { Format: "ass", Method: "External" },
      { Format: "vtt", Method: "External" }
    ],
    ResponseProfiles: []
  };
}


async function embyFetchJSON(base, path, { method = "GET", headers = {}, body, timeoutMs = 20000, tryPrefixes = true } = {}) {
  const prefixes = tryPrefixes ? ["", "/emby", "/Mediabrowser"] : [""];
  let lastErr = null;
  for (const prefix of prefixes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const url = base.replace(/\/+$/, "") + prefix + path;
      const res = await fetch(url, {
        method,
        headers,
        body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
        signal: controller.signal,
        cf: { cacheTtl: 0, cacheEverything: false }
      });
      const textBody = await res.text();
      let data = null;
      try {
        data = textBody ? JSON.parse(textBody) : null;
      } catch {
        data = textBody;
      }
      if (!res.ok) {
        const msg = (data && (data.Message || data.message || data.error)) || (typeof data === "string" ? data.slice(0, 180) : "") || res.statusText;
        lastErr = new Error(`Emby ${method} ${prefix}${path} -> ${res.status} ${msg}`);
        if (res.status === 404 || res.status === 502 || res.status === 503) continue;
        // auth errors: still try other prefixes once
        if (res.status === 401 || res.status === 403) continue;
        throw lastErr;
      }
      return data;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (String(lastErr.message || "").includes("abort")) {
        lastErr = new Error(`Emby ${method} ${prefix}${path} 超时`);
      }
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`Emby ${method} ${path} 失败`);
}

function embyProfileDeviceName(profile, nodeName) {
  if (profile?.devicePrefix) {
    return `${profile.devicePrefix}${String(nodeName || "NODE").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "DEVICE"}`;
  }
  return profile?.device || profile?.client || "Android";
}

async function embyLogin(node) {
  const base = nodeUpstreamBase(node);
  const profile = getClientProfile(node.clientProfile || DEFAULT_CLIENT_PROFILE);
  const device = embyProfileDeviceName(profile, node.name);
  const deviceId = `ep-${normalizeName(node.name)}-${(fnv1a(String(profile.id || "p") + "|" + node.name) >>> 0).toString(16)}`;
  const headersBase = {
    "content-type": "application/json",
    "accept": "application/json",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent": profile.ua || "Emby/4.8.0",
    "x-emby-authorization": buildEmbyAuthHeader(profile, device, deviceId)
  };

  if (node.embyAccessToken && node.embyUserId && node.embyAuthProfile === profile.id) {
    return {
      base,
      token: node.embyAccessToken,
      userId: node.embyUserId,
      deviceId,
      profile,
      device,
      reused: true
    };
  }

  if (!node.embyUser || !node.embyPassword) {
    throw new Error("缺少 Emby 用户名或密码");
  }

  let data = null;
  let lastErr = null;
  for (const body of [
    { Username: node.embyUser, Pw: node.embyPassword },
    { Username: node.embyUser, Password: node.embyPassword },
    { Username: node.embyUser, Pw: node.embyPassword, Password: node.embyPassword }
  ]) {
    try {
      data = await embyFetchJSON(base, "/Users/AuthenticateByName", {
        method: "POST",
        headers: headersBase,
        body,
        timeoutMs: 25000
      });
      if (data) break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!data) throw lastErr || new Error("登录失败");
  const token = data?.AccessToken || data?.accessToken;
  const userId = data?.User?.Id || data?.user?.id;
  if (!token || !userId) throw new Error("登录成功但未返回 AccessToken/UserId");
  return { base, token, userId, deviceId, profile, device, reused: false, raw: data };
}

async function persistEmbyCredentials(env, nodeName, auth) {
  if (!auth?.token || !auth?.userId) {
    return;
  }
  await env.DB.prepare(`
    UPDATE nodes
    SET emby_user_id = ?, emby_access_token = ?, emby_auth_profile = ?, updated_at = ?
    WHERE name = ?
  `).bind(auth.userId, auth.token, auth.profile?.id || "", Date.now(), normalizeName(nodeName)).run();
}


function embyAuthHeaders(auth) {
  return {
    "content-type": "application/json",
    "accept": "application/json",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    "user-agent": auth.profile?.ua || "Emby/4.8.0",
    "x-emby-token": auth.token,
    "x-emby-authorization": buildEmbyAuthHeader(auth.profile, auth.device, auth.deviceId, auth.token, auth.userId)
  };
}

async function embyPickPlayItem(auth, node) {
  const headers = embyAuthHeaders(auth);
  if (node.embyPlayId) {
    const item = await embyFetchJSON(auth.base, `/Users/${auth.userId}/Items/${encodeURIComponent(node.embyPlayId)}`, { headers });
    if (!item?.Id) {
      throw new Error("指定 embyPlayId 无效");
    }
    return item;
  }

  const allowedTypes = node.watchContentType === "movie"
    ? ["Movie"]
    : node.watchContentType === "episode" ? ["Episode"] : ["Movie", "Episode"];
  const includeTypes = allowedTypes.join(",");
  const queries = [
    `/Users/${auth.userId}/Items/Resume?Limit=12&MediaTypes=Video&IncludeItemTypes=${includeTypes}&Fields=BasicSyncInfo,RunTimeTicks,UserData,MediaSources`,
    `/Users/${auth.userId}/Items/Latest?Limit=20&IncludeItemTypes=${includeTypes}&Fields=BasicSyncInfo,RunTimeTicks,UserData`,
    `/Users/${auth.userId}/Items?SortBy=DateCreated&SortOrder=Descending&IncludeItemTypes=${includeTypes}&Recursive=true&Limit=30&Fields=BasicSyncInfo,RunTimeTicks,UserData`
  ];
  const candidates = [];
  for (const path of queries) {
    try {
      const data = await embyFetchJSON(auth.base, path, { headers });
      const items = Array.isArray(data) ? data : (data?.Items || []);
      for (const item of items) {
        if (!item?.Id) continue;
        if (item.Type && !allowedTypes.includes(item.Type)) continue;
        candidates.push(item);
      }
      if (candidates.length >= 5) break;
    } catch (err) {
      console.log("pick item query failed", path, errMessage(err));
    }
  }
  if (!candidates.length) {
    throw new Error("上游未找到可播放视频条目");
  }
  // 随机挑一个
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function itemDisplayTitle(item) {
  if (!item) return "";
  if (item.Type === "Episode") {
    const show = item.SeriesName || item.Album || "";
    const ep = item.Name || "";
    const sn = item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : "";
    const en = item.IndexNumber != null ? `E${item.IndexNumber}` : "";
    return [show, sn + en, ep].filter(Boolean).join(" ");
  }
  return item.Name || item.Path || item.Id || "";
}

async function embyPlaybackInfo(auth, itemId) {
  const headers = embyAuthHeaders(auth);
  const qs = new URLSearchParams({
    UserId: auth.userId,
    StartTimeTicks: "0",
    IsPlayback: "true",
    AutoOpenLiveStream: "true",
    MaxStreamingBitrate: "40000000"
  });
  const data = await embyFetchJSON(auth.base, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo?${qs}`, {
    method: "POST",
    headers,
    body: {
      DeviceProfile: embyDeviceProfile(),
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true
    }
  });
  const media = (data?.MediaSources || [])[0] || {};
  return {
    playSessionId: data?.PlaySessionId || randomUUIDLike(),
    mediaSourceId: media.Id || itemId,
    directStreamUrl: media.DirectStreamUrl || "",
    runTimeTicks: Number(media.RunTimeTicks || 0)
  };
}

async function embyPostSession(auth, path, payload) {
  await embyFetchJSON(auth.base, path, {
    method: "POST",
    headers: embyAuthHeaders(auth),
    body: payload,
    timeoutMs: 15000
  });
}

function buildPlayingPayload(auth, item, session, positionTicks, { stop = false } = {}) {
  const nowTicks = embyTicks(Date.now() / 1000);
  return {
    ItemId: item.Id,
    MediaSourceId: session.mediaSourceId,
    PlaySessionId: session.playSessionId,
    PositionTicks: positionTicks,
    IsPaused: false,
    IsMuted: false,
    PlaybackRate: 1,
    VolumeLevel: 100,
    PlayMethod: "DirectStream",
    CanSeek: true,
    RepeatMode: "RepeatNone",
    SubtitleStreamIndex: -1,
    AudioStreamIndex: -1,
    PlaylistIndex: 0,
    PlaylistLength: stop ? 0 : 1,
    NowPlayingQueue: stop ? [] : [{ Id: item.Id, PlaylistItemId: "playlistItem0" }],
    MaxStreamingBitrate: 420000000,
    PlaybackStartTimeTicks: nowTicks
  };
}

async function embyPullStreamSample(auth, session, itemId) {
  // 轻量拉一点流，证明真有播放行为；失败不阻断会话上报
  try {
    const url = session.directStreamUrl
      ? new URL(session.directStreamUrl, auth.base.replace(/\/+$/, "") + "/").toString()
      : `${auth.base.replace(/\/+$/, "")}/Videos/${encodeURIComponent(itemId)}/stream?Static=true&MediaSourceId=${encodeURIComponent(session.mediaSourceId)}&PlaySessionId=${encodeURIComponent(session.playSessionId)}`;
    const streamURL = new URL(url);
    const authOrigin = new URL(auth.base).origin;
    const requestHeaders = {
      range: "bytes=0-65535",
      "user-agent": auth.profile?.ua || "Emby/4.8.0"
    };
    if (streamURL.origin === authOrigin) {
      Object.assign(requestHeaders, embyAuthHeaders(auth));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("stream-timeout"), 12000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: requestHeaders,
        signal: controller.signal,
        cf: { cacheTtl: 0, cacheEverything: false }
      });
      // 读最多 64KB
      if (res.body) {
        const reader = res.body.getReader();
        let total = 0;
        while (total < 65536) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value?.byteLength || 0;
        }
        try { await reader.cancel(); } catch {}
        return { ok: res.ok, bytes: total, status: res.status };
      }
      return { ok: res.ok, bytes: 0, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

async function embyPlayItem(auth, item, durationSec) {
  // 已弃用长等待路径：真实模拟改为 sim_watch_sessions + 分钟心跳
  const session = await embyPlaybackInfo(auth, item.Id);
  await embyPostSession(auth, "/Sessions/Playing", buildPlayingPayload(auth, item, session, 0));
  return {
    title: itemDisplayTitle(item),
    itemId: item.Id,
    durationSec: Number(durationSec || 0),
    playSessionId: session.playSessionId,
    mediaSourceId: session.mediaSourceId,
    stream: await embyPullStreamSample(auth, session, item.Id)
  };
}


async function ensureWatchSessionsTable(env) {
  await ensureSchema(env);
}

async function cleanOldWatchSessions(env) {
  if (!env.DB) return;
  await ensureWatchSessionsTable(env);
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM sim_watch_sessions WHERE started_at < ? AND status != 'running'`).bind(cutoff).run();
}

async function recoverStaleWatchSessions(env, now = Date.now(), nodeName = "") {
  const node = normalizeName(nodeName || "");
  const whereNode = node ? " AND node = ?" : "";
  const statement = env.DB.prepare(`
    UPDATE sim_watch_sessions
    SET status = 'failed', error = 'startup reservation expired', access_token = '', last_tick_at = ?
    WHERE status = 'starting' AND next_tick_at <= ?${whereNode}
  `);
  return node
    ? statement.bind(now, now, node).run()
    : statement.bind(now, now).run();
}

function authFromSession(row) {
  const profile = getClientProfile(row.client_profile || DEFAULT_CLIENT_PROFILE);
  return {
    base: row.base_url,
    token: row.access_token,
    userId: row.user_id,
    deviceId: row.device_id,
    device: row.device_name || embyProfileDeviceName(profile, row.node),
    profile
  };
}

async function hasRunningWatchSession(env, nodeName) {
  await ensureWatchSessionsTable(env);
  const row = await env.DB.prepare(
    `SELECT id FROM sim_watch_sessions WHERE node = ? AND status IN ('starting', 'running') LIMIT 1`
  ).bind(normalizeName(nodeName)).first();
  return Boolean(row?.id);
}

async function startWatchSession(env, { node, source = "manual", note = "", remainDays = null, renewDays = null } = {}) {
  if (!node?.name) throw new Error("missing node");
  if (!node.embyUser || !(node.embyPassword || node.embyAccessToken)) {
    throw new Error("节点未配置 Emby 账号密码，无法真实模拟观看");
  }
  const targetDurationSec = randomSimulatedWatchDurationSec(node);
  await ensureWatchSessionsTable(env);
  const reservedAt = Date.now();
  await recoverStaleWatchSessions(env, reservedAt, node.name);
  let reservation;
  try {
    reservation = await env.DB.prepare(`
      INSERT INTO sim_watch_sessions (
        node, display_name, source, note, target_duration_sec, started_at,
        last_tick_at, next_tick_at, status, error, remain_days, renew_days
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting', '', ?, ?)
    `).bind(
      node.name,
      node.displayName || node.name,
      source,
      note || "",
      targetDurationSec,
      reservedAt,
      reservedAt,
      reservedAt + 10 * 60 * 1000,
      Number.isFinite(Number(remainDays)) ? Number(remainDays) : 0,
      Number.isFinite(Number(renewDays)) ? Number(renewDays) : Number(node.renewDays || 0)
    ).run();
  } catch (err) {
    if (/unique|constraint/i.test(errMessage(err))) {
      throw new Error("该节点已有进行中的模拟观看，请等待完成后再试");
    }
    throw err;
  }

  const sessionId = Number(reservation?.meta?.last_row_id || 0);
  let auth = null;
  let item = null;
  let sessionMeta = null;
  let playingStarted = false;
  try {
    auth = await embyLogin(node);
    if (auth.reused) {
      try {
        await embyFetchJSON(auth.base, `/Users/${auth.userId}`, { headers: embyAuthHeaders(auth), timeoutMs: 12000 });
      } catch {
        node.embyAccessToken = "";
        node.embyUserId = "";
        node.embyAuthProfile = "";
        auth = await embyLogin(node);
      }
    }
    await persistEmbyCredentials(env, node.name, auth);
    item = await embyPickPlayItem(auth, node);
    sessionMeta = await embyPlaybackInfo(auth, item.Id);
    const streamInfo = await embyPullStreamSample(auth, sessionMeta, item.Id);
    await sleepMs(200 + Math.floor(Math.random() * 300));
    const startedAt = Date.now();
    await embyPostSession(auth, "/Sessions/Playing", buildPlayingPayload(auth, item, sessionMeta, 0));
    playingStarted = true;

    const title = itemDisplayTitle(item);
    const nextTickAt = startedAt + 60 * 1000;
    const activated = await env.DB.prepare(`
      UPDATE sim_watch_sessions SET
        title = ?, item_id = ?, media_source_id = ?, play_session_id = ?,
        base_url = ?, access_token = ?, user_id = ?, device_id = ?, device_name = ?, client_profile = ?,
        started_at = ?, last_tick_at = ?, next_tick_at = ?, tick_count = 0, status = 'running', error = ''
      WHERE id = ? AND status = 'starting'
    `).bind(
      title,
      item.Id || "",
      sessionMeta.mediaSourceId || "",
      sessionMeta.playSessionId || "",
      auth.base || "",
      auth.token || "",
      auth.userId || "",
      auth.deviceId || "",
      auth.device || "",
      auth.profile?.id || node.clientProfile || "",
      startedAt,
      startedAt,
      nextTickAt,
      sessionId
    ).run();
    if (Number(activated?.meta?.changes || 0) !== 1) {
      throw new Error("模拟观看会话占位已失效");
    }

    return { sessionId, title, itemId: item.Id, targetDurationSec, startedAt, stream: streamInfo };
  } catch (err) {
    if (playingStarted && auth && item && sessionMeta) {
      try {
        await embyPostSession(auth, "/Sessions/Playing/Stopped", buildPlayingPayload(auth, item, sessionMeta, 0, { stop: true }));
      } catch {}
    }
    await env.DB.prepare(`UPDATE sim_watch_sessions SET status = 'failed', error = ?, access_token = '', last_tick_at = ? WHERE id = ?`)
      .bind(errMessage(err).slice(0, 500), Date.now(), sessionId).run();
    throw err;
  }
}

async function processWatchSessions(env, now = Date.now()) {
  if (!env.DB) return { ok: false, skipped: true };
  await ensureWatchSessionsTable(env);
  await recoverStaleWatchSessions(env, now);
  const rows = await env.DB.prepare(`
    SELECT * FROM sim_watch_sessions
    WHERE status IN ('running', 'notify_pending') AND next_tick_at <= ?
    ORDER BY next_tick_at ASC
    LIMIT 5
  `).bind(now).all();
  const list = rows.results || [];
  if (!list.length) return { ok: true, count: 0 };
  const results = [];
  for (const row of list) {
    if (row.status === "notify_pending") {
      results.push(await retryWatchCompletionNotification(env, row, now));
      continue;
    }
    try {
      results.push(await tickWatchSession(env, row, now));
    } catch (err) {
      const error = errMessage(err);
      try {
        const auth = authFromSession(row);
        const elapsedSec = Math.max(0, Math.floor((now - Number(row.started_at || now)) / 1000));
        await embyPostSession(
          auth,
          "/Sessions/Playing/Stopped",
          buildPlayingPayload(auth, { Id: row.item_id }, {
            mediaSourceId: row.media_source_id,
            playSessionId: row.play_session_id
          }, embyTicks(elapsedSec), { stop: true })
        );
      } catch {}
      await env.DB.prepare(`UPDATE sim_watch_sessions SET status = 'failed', error = ?, access_token = '', last_tick_at = ? WHERE id = ?`)
        .bind(error.slice(0, 500), now, row.id).run();
      try {
        await insertWatchLog(env, {
          node: row.node,
          displayName: row.display_name || row.node,
          ts: now,
          source: row.source || "manual",
          note: `进行中失败：${error}`.slice(0, 300),
          durationSec: Math.max(0, Math.round((now - Number(row.started_at || now)) / 1000)),
          startedAt: Number(row.started_at || now),
          endedAt: now,
          title: row.title ? `${row.title}（失败）` : "（失败）",
          itemId: row.item_id || ""
        });
      } catch {}
      try {
        await notifySimulatedWatchFailure(env, {
          node: row.node,
          displayName: row.display_name || row.node,
          source: row.source || "manual",
          error,
          endedAt: now
        }, { remainDays: row.remain_days, renewDays: row.renew_days });
      } catch {}
      results.push({ ok: false, id: row.id, error });
    }
  }
  return { ok: true, count: results.length, results };
}

async function tickWatchSession(env, row, now = Date.now()) {
  const startedAt = Number(row.started_at || now);
  const target = Math.max(60, Number(row.target_duration_sec || 300));
  const elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000));
  const auth = authFromSession(row);
  const item = { Id: row.item_id };
  const sessionMeta = {
    mediaSourceId: row.media_source_id,
    playSessionId: row.play_session_id
  };

  if (elapsedSec >= target) {
    const actualDurationSec = elapsedSec;
    const stopPos = embyTicks(actualDurationSec * (0.96 + Math.random() * 0.03));
    try {
      await embyPostSession(auth, "/Sessions/Playing/Progress", {
        ...buildPlayingPayload(auth, item, sessionMeta, stopPos, { stop: true }),
        EventName: "timeupdate"
      });
    } catch {}
    await embyPostSession(auth, "/Sessions/Playing/Stopped", buildPlayingPayload(auth, item, sessionMeta, stopPos, { stop: true }));
    try {
      await embyFetchJSON(auth.base, `/Users/${auth.userId}/PlayedItems/${encodeURIComponent(item.Id)}`, {
        method: "POST",
        headers: embyAuthHeaders(auth),
        body: {}
      });
    } catch {}

    const endedAt = now;
    await markKeepalivePlayback(env, row.node, endedAt);
    const log = await insertWatchLog(env, {
      node: row.node,
      displayName: row.display_name || row.node,
      ts: endedAt,
      source: row.source || "manual",
      note: row.note || "真实模拟观看完成",
      durationSec: actualDurationSec,
      startedAt,
      endedAt,
      title: row.title || "",
      itemId: row.item_id || ""
    });
    await env.DB.prepare(`
      UPDATE sim_watch_sessions
      SET status = 'notify_pending', last_tick_at = ?, next_tick_at = ?, tick_count = tick_count + 1,
          notify_attempts = 0, error = '', access_token = ''
      WHERE id = ?
    `).bind(endedAt, endedAt, row.id).run();
    return retryWatchCompletionNotification(env, {
      ...row,
      status: "notify_pending",
      last_tick_at: endedAt,
      next_tick_at: endedAt,
      notify_attempts: 0,
      note: log.note
    }, endedAt);
  }

  const ratio = Math.min(0.95, elapsedSec / target);
  const pos = embyTicks(target * ratio);
  await embyPostSession(auth, "/Sessions/Playing/Progress", {
    ...buildPlayingPayload(auth, item, sessionMeta, pos),
    EventName: "timeupdate"
  });
  if (Number(row.tick_count || 0) % 2 === 0) {
    try { await embyPullStreamSample(auth, sessionMeta, item.Id); } catch {}
  }
  const nextTickAt = now + 60 * 1000;
  await env.DB.prepare(`
    UPDATE sim_watch_sessions
    SET last_tick_at = ?, next_tick_at = ?, tick_count = tick_count + 1
    WHERE id = ?
  `).bind(now, nextTickAt, row.id).run();
  return { ok: true, id: row.id, done: false, elapsedSec, target };
}

function telegramDeliverySucceeded(result) {
  return Boolean(result?.ok || result?.skipped);
}

async function retryWatchCompletionNotification(env, row, now = Date.now()) {
  const endedAt = Number(row.last_tick_at || now);
  const durationSec = Math.max(0, Math.round((endedAt - Number(row.started_at || endedAt)) / 1000));
  let delivery;
  try {
    delivery = await notifySimulatedWatch(env, {
      ok: true,
      node: row.node,
      displayName: row.display_name || row.node,
      source: row.source || "manual",
      note: row.note || "真实模拟观看完成",
      durationSec,
      startedAt: Number(row.started_at || endedAt),
      endedAt,
      title: row.title || "",
      itemId: row.item_id || "",
      ts: endedAt
    }, {
      remainDays: row.remain_days,
      renewDays: row.renew_days
    });
  } catch (err) {
    delivery = { ok: false, error: errMessage(err) };
  }

  if (telegramDeliverySucceeded(delivery)) {
    await env.DB.prepare(`
      UPDATE sim_watch_sessions SET status = 'done', next_tick_at = ?, error = '' WHERE id = ?
    `).bind(now, row.id).run();
    return { ok: true, id: row.id, done: true, notified: !delivery?.skipped, title: row.title };
  }

  const attempts = Number(row.notify_attempts || 0) + 1;
  const exhausted = attempts >= 5;
  const error = cleanString(delivery?.error || delivery?.result?.description || "Telegram notification failed").slice(0, 500);
  await env.DB.prepare(`
    UPDATE sim_watch_sessions
    SET status = ?, notify_attempts = ?, next_tick_at = ?, error = ?
    WHERE id = ?
  `).bind(exhausted ? "done" : "notify_pending", attempts, now + Math.min(attempts, 5) * 60 * 1000, error, row.id).run();
  return { ok: false, id: row.id, done: exhausted, notifyPending: !exhausted, error };
}

async function performSimulatedWatch(env, options = {}) {
  const name = normalizeName(options.name || options.node || "");
  const node = options.node || await getNode(env, name);
  if (!node) return { ok: false, error: "node not found" };
  try {
    const started = await startWatchSession(env, {
      node,
      source: options.source || "manual",
      note: options.note || "",
      remainDays: options.remainDays,
      renewDays: options.renewDays
    });
    return {
      ok: true,
      pending: true,
      accepted: true,
      ...started,
      node: node.name,
      displayName: node.displayName || node.name
    };
  } catch (err) {
    const endedAt = Date.now();
    const failed = {
      ok: false,
      node: node.name,
      displayName: node.displayName || node.name,
      source: options.source || "manual",
      error: errMessage(err),
      startedAt: Number(options.startedAt || endedAt),
      endedAt,
      title: "",
      durationSec: 0
    };
    try {
      await insertWatchLog(env, {
        node: node.name,
        displayName: node.displayName || node.name,
        ts: endedAt,
        source: options.source || "manual",
        note: `失败：${failed.error}`.slice(0, 300),
        durationSec: 0,
        startedAt: failed.startedAt,
        endedAt,
        title: "（失败）",
        itemId: ""
      });
    } catch {}
    if (options.notify !== false) {
      try { failed.notify = await notifySimulatedWatchFailure(env, failed, options); } catch {}
    }
    return failed;
  }
}

async function notifySimulatedWatch(env, watch, options = {}) {
  if (!env.TG_BOT_TOKEN || !telegramChatIds(env).length) {
    return { ok: false, skipped: true };
  }
  const sourceLabel = watch.source === "auto" ? "自动模拟" : "手动模拟";
  const lines = [
    "👀 模拟观看完成",
    `站点：${watch.displayName || watch.node}`,
    `节点：${watch.node}`,
    `内容：${watch.title || "未知条目"}`,
    `开始：${formatDateTime(watch.startedAt || watch.ts)}`,
    `结束：${formatDateTime(watch.endedAt || watch.ts)}`,
    `时长：${formatDurationSec(watch.durationSec)}`,
    `来源：${sourceLabel}`
  ];
  if (watch.itemId) lines.push(`条目ID：${watch.itemId}`);
  if (options.remainDays != null && Number.isFinite(Number(options.remainDays))) {
    lines.push(`触发时剩余：${Number(options.remainDays)} 天`);
  }
  if (options.renewDays != null && Number.isFinite(Number(options.renewDays))) {
    lines.push(`周期：${Number(options.renewDays)} 天`);
  }
  if (watch.note) lines.push(`备注：${watch.note}`);
  return sendTelegramReportText(env, lines.join("\n"));
}

async function notifySimulatedWatchFailure(env, watch, options = {}) {
  if (!env.TG_BOT_TOKEN || !telegramChatIds(env).length) {
    return { ok: false, skipped: true };
  }
  const sourceLabel = watch.source === "auto" ? "自动模拟" : "手动模拟";
  const lines = [
    "⚠️ 模拟观看失败",
    `站点：${watch.displayName || watch.node}`,
    `节点：${watch.node}`,
    `来源：${sourceLabel}`,
    `时间：${formatDateTime(watch.endedAt || Date.now())}`,
    `原因：${watch.error || "unknown"}`
  ];
  return sendTelegramReportText(env, lines.join("\n"));
}

async function runAutoSimulatedWatches(env) {
  if (!env.DB) return { ok: false, skipped: true, reason: "missing DB" };
  const statuses = await getKeepaliveStatuses(env);
  const targets = statuses.filter((item) => item.enabled !== false && (item.status === "due" || item.status === "warn"));
  if (!targets.length) return { ok: true, skipped: true, reason: "no due nodes", count: 0 };
  await ensureWatchSessionsTable(env);
  const concurrency = Math.max(1, Math.min(10, Number(env.AUTO_WATCH_MAX_CONCURRENCY || DEFAULT_AUTO_WATCH_MAX_CONCURRENCY)));
  const activeRow = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM sim_watch_sessions WHERE status IN ('starting', 'running')
  `).first();
  let available = Math.max(0, concurrency - Number(activeRow?.count || 0));
  const results = [];
  for (const item of targets) {
    try {
      const node = await getNode(env, item.node);
      if (!node) {
        results.push({ ok: false, node: item.node, error: "node not found" });
        continue;
      }
      if (!canNodeAutoWatch(node)) {
        results.push(await notifyKeepaliveDue(env, item, node));
        continue;
      }
      const window = autoWatchWindowDecision(node);
      if (!window.eligible) {
        results.push({ ok: true, node: item.node, skipped: true, reason: "outside watch window", scheduledMinute: window.scheduledMinute });
        continue;
      }
      if (await autoWatchSuccessCountToday(env, item.node) >= node.watchDailyLimit) {
        results.push({ ok: true, node: item.node, skipped: true, reason: "daily limit" });
        continue;
      }
      if (await hasRecentAutoWatchFailure(env, item.node, node.watchFailureBackoffMin)) {
        results.push({ ok: true, node: item.node, skipped: true, reason: "failure backoff" });
        continue;
      }
      if (await hasRunningWatchSession(env, item.node)) {
        results.push({ ok: true, node: item.node, skipped: true, reason: "already running" });
        continue;
      }
      if (available <= 0) {
        results.push({ ok: true, node: item.node, skipped: true, reason: "concurrency limit" });
        continue;
      }
      const note = item.status === "due"
        ? `自动真实模拟：已超期 ${Math.abs(item.remainDays)} 天`
        : `自动真实模拟：剩余 ${item.remainDays} 天触发`;
      const started = await startWatchSession(env, {
        node,
        source: "auto",
        note,
        remainDays: item.remainDays,
        renewDays: item.renewDays
      });
      available--;
      results.push({ ok: true, node: item.node, ...started });
    } catch (err) {
      const error = errMessage(err);
      await recordAutoWatchFailure(env, item, error);
      results.push({ ok: false, node: item.node, error });
    }
  }
  return { ok: results.every((item) => item.ok), count: results.length, results };
}

function autoWatchWindowDecision(node, now = Date.now()) {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  const currentMinute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  const start = Math.max(0, Math.min(23, Number(node?.watchWindowStart ?? 0))) * 60;
  const end = Math.max(start + 60, Math.min(24, Number(node?.watchWindowEnd ?? 24)) * 60);
  const span = Math.max(1, end - start);
  const scheduledMinute = start + (parseInt(fnv1a(`${beijingDay(now)}|${normalizeName(node?.name || "node")}`), 16) % span);
  return {
    eligible: currentMinute >= scheduledMinute && currentMinute < end,
    currentMinute,
    scheduledMinute,
    startMinute: start,
    endMinute: end
  };
}

function beijingDayStartMs(now = Date.now()) {
  const shifted = new Date(now + 8 * 60 * 60 * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 60 * 60 * 1000;
}

async function autoWatchSuccessCountToday(env, nodeName, now = Date.now()) {
  await ensureWatchLogsTable(env);
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count FROM watch_logs
    WHERE node = ? AND source = 'auto' AND ts >= ?
      AND item_id != '' AND title NOT LIKE '%失败%' AND note NOT LIKE '%失败%'
  `).bind(normalizeName(nodeName), beijingDayStartMs(now)).first();
  return Number(row?.count || 0);
}

function canNodeAutoWatch(node) {
  return Boolean(node?.autoWatch && node.embyUser && node.embyPassword);
}

async function notifyKeepaliveDue(env, item, node) {
  const day = beijingDay();
  if (item.lastNotifyDay === day) {
    return { ok: true, node: item.node, skipped: true, reason: "reminder already sent today" };
  }
  const state = item.status === "due"
    ? `已超期 ${Math.abs(item.remainDays)} 天`
    : `剩余 ${item.remainDays} 天`;
  const reason = node.autoWatch ? "账号密码不完整" : "未启用自动模拟观看";
  let delivery;
  try {
    delivery = await sendTelegramReportText(env, [
      "⏰ 观看到期提醒",
      `站点：${item.displayName || item.node}`,
      `节点：${item.node}`,
      `状态：${state}`,
      `周期：${item.renewDays} 天`,
      `处理：仅提醒（${reason}）`
    ].join("\n"));
  } catch (err) {
    delivery = { ok: false, error: errMessage(err) };
  }
  if (!telegramDeliverySucceeded(delivery)) {
    return { ok: false, node: item.node, error: delivery?.error || "keepalive reminder failed" };
  }
  await env.DB.prepare(`
    UPDATE keepalive_state
    SET last_notify_day = ?, notify_count = notify_count + 1
    WHERE node = ?
  `).bind(day, item.node).run();
  return { ok: true, node: item.node, reminded: !delivery?.skipped, skipped: Boolean(delivery?.skipped) };
}

async function hasRecentAutoWatchFailure(env, nodeName, backoffMinutes = AUTO_WATCH_FAILURE_BACKOFF_MS / 60000) {
  await ensureWatchLogsTable(env);
  const row = await env.DB.prepare(`
    SELECT id FROM watch_logs
    WHERE node = ? AND source = 'auto'
      AND (note LIKE '自动启动失败：%' OR note LIKE '进行中失败：%')
      AND ts >= ?
    ORDER BY ts DESC LIMIT 1
  `).bind(
    normalizeName(nodeName),
    Date.now() - Math.max(10, Math.min(1440, Number(backoffMinutes || 360))) * 60 * 1000
  ).first();
  return Boolean(row?.id);
}

async function recordAutoWatchFailure(env, item, error) {
  const endedAt = Date.now();
  try {
    await insertWatchLog(env, {
      node: item.node,
      displayName: item.displayName || item.node,
      ts: endedAt,
      source: "auto",
      note: `自动启动失败：${error}`.slice(0, 300),
      durationSec: 0,
      startedAt: endedAt,
      endedAt,
      title: "（失败）",
      itemId: ""
    });
  } catch {}
  try {
    await notifySimulatedWatchFailure(env, {
      node: item.node,
      displayName: item.displayName || item.node,
      source: "auto",
      error,
      endedAt
    }, { remainDays: item.remainDays, renewDays: item.renewDays });
  } catch {}
}

async function ensureWatchLogsTable(env) {
  await ensureSchema(env);
}

async function insertWatchLog(env, entry) {
  await ensureWatchLogsTable(env);
  const node = normalizeName(entry.node || "");
  const displayName = cleanString(entry.displayName || entry.display_name || node);
  const ts = Number(entry.ts || Date.now());
  const source = cleanString(entry.source || "manual") || "manual";
  const note = cleanString(entry.note || "");
  const durationSec = Math.max(0, Math.round(Number(entry.durationSec ?? entry.duration_sec ?? 0)));
  const startedAt = Number(entry.startedAt ?? entry.started_at ?? 0) || 0;
  const endedAt = Number(entry.endedAt ?? entry.ended_at ?? ts) || ts;
  const title = cleanString(entry.title || "");
  const itemId = cleanString(entry.itemId || entry.item_id || "");
  const result = await env.DB.prepare(`
    INSERT INTO watch_logs (node, display_name, ts, source, note, duration_sec, started_at, ended_at, title, item_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(node, displayName, ts, source, note, durationSec, startedAt, endedAt, title, itemId).run();
  return {
    id: Number(result?.meta?.last_row_id || 0),
    node,
    displayName,
    ts,
    source,
    note,
    durationSec,
    startedAt,
    endedAt,
    title,
    itemId
  };
}

async function listWatchLogs(env, options = {}) {
  if (!env.DB) {
    return [];
  }
  await ensureWatchLogsTable(env);
  const days = Math.max(1, Math.min(30, Number(options.days || 3) || 3));
  const limit = Math.max(1, Math.min(200, Number(options.limit || 100) || 100));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = await env.DB.prepare(`
    SELECT id, node, display_name, ts, source, note, duration_sec, started_at, ended_at, title, item_id
    FROM watch_logs
    WHERE ts >= ?
    ORDER BY ts DESC
    LIMIT ?
  `).bind(cutoff, limit).all();
  return (rows.results || []).map((row) => ({
    id: Number(row.id || 0),
    node: row.node || "",
    displayName: row.display_name || row.node || "",
    ts: Number(row.ts || 0),
    source: row.source || "manual",
    note: row.note || "",
    durationSec: Number(row.duration_sec || 0),
    startedAt: Number(row.started_at || 0),
    endedAt: Number(row.ended_at || row.ts || 0),
    title: row.title || "",
    itemId: row.item_id || "",
    durationText: formatDurationSec(row.duration_sec || 0),
    time: formatDateTime(row.ts)
  }));
}

async function cleanOldVisitorLogs(env) {
  if (!env.DB) {
    return;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM visitor_logs WHERE ts < ?`).bind(cutoff).run();
}

async function cleanOldWatchLogs(env) {
  if (!env.DB) {
    return;
  }
  await ensureWatchLogsTable(env);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM watch_logs WHERE ts < ?`).bind(cutoff).run();
}

async function pingTarget(target) {
  if (!target || !/^https?:\/\//i.test(target)) {
    return { ok: false, error: "invalid target" };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const base = new URL(target);
    const candidates = ["/emby/System/Info/Public", "/System/Info/Public", "/"];
    let lastStatus = 0;
    for (const path of candidates) {
      const u = new URL(base);
      u.pathname = path;
      const res = await fetch(u.toString(), { method: "GET", redirect: "manual", signal: controller.signal });
      lastStatus = res.status;
      discardResponseBody(res);
      if (res.status >= 200 && res.status < 400) {
        return { ok: true, status: res.status, ms: Date.now() - started };
      }
    }
    return { ok: false, status: lastStatus, error: lastStatus ? `HTTP ${lastStatus}` : "unreachable", ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: errMessage(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkNodeStreamHealth(env, name) {
  const node = await getNode(env, normalizeName(name || ""));
  if (!node) return { ok: false, error: "node not found" };
  const configured = splitTargets(node.streamTarget || node.targets);
  if (!configured.length) return { ok: false, error: "node has no video target" };
  const checked = await Promise.all(configured.map(async (target, index) => {
    const result = await pingTarget(target);
    const latency = Math.max(0, Number(result.ms || 0));
    recordTargetOutcome(node.name, "/Videos/probe/stream.mp4", target, result.ok ? "success" : "failure", latency);
    return {
      index: index + 1,
      target,
      label: targetLineIdentity(target).label,
      ok: Boolean(result.ok),
      status: Number(result.status || 0),
      ms: latency,
      error: result.error || ""
    };
  }));
  const ordered = orderTargetsByHealth(node.name, "/Videos/probe/stream.mp4", configured, Date.now(), node.streamStrategy);
  return {
    ok: checked.some((item) => item.ok),
    node: node.name,
    strategy: node.streamStrategy,
    timeoutMs: node.streamTimeoutMs,
    preferred: targetLineIdentity(ordered[0] || configured[0]).label,
    lines: checked
  };
}

async function pingTargetCompat(target) {
  const result = await pingTarget(target);
  return result.ok
    ? { ms: result.ms, status: result.status }
    : { ms: -1, status: result.status || 0, error: result.error || "unreachable" };
}

async function getTraceInfo(request, env, ctx) {
  const entry = {
    ip: request.headers.get("cf-connecting-ip") || "",
    country: request.headers.get("cf-ipcountry") || "",
    colo: request.cf?.colo || "",
    asn: request.cf?.asn || "",
    city: request.cf?.city || "",
    region: request.cf?.region || ""
  };
  const now = Date.now();
  if (traceEgressCache.data && traceEgressCache.expires > now) {
    return { ok: true, entry, egress: traceEgressCache.data };
  }
  const saved = await readTraceEgressCache(env);
  if (saved?.data && saved.expires > now) {
    traceEgressCache = saved;
    return { ok: true, entry, egress: saved.data };
  }
  const refresh = refreshTraceEgress(env);
  if (ctx?.waitUntil) {
    ctx.waitUntil(refresh);
  } else {
    refresh.catch(() => {});
  }
  const staleData = traceEgressCache.data || saved?.data;
  const stale = staleData ? { ...staleData, stale: true, status: "updating" } : { status: "updating" };
  return { ok: true, entry, egress: stale };
}

function refreshTraceEgress(env) {
  if (!traceEgressPromise) {
    traceEgressPromise = fetchTraceEgress()
      .then((data) => {
        traceEgressCache = { expires: Date.now() + 60000, data };
        return writeTraceEgressCache(env, traceEgressCache).then(() => data);
      })
      .catch((err) => {
        const data = { error: errMessage(err), fetchedAt: Date.now() };
        traceEgressCache = { expires: Date.now() + 15000, data };
        return writeTraceEgressCache(env, traceEgressCache).then(() => data);
      })
      .catch((err) => {
        const data = { error: errMessage(err), fetchedAt: Date.now() };
        traceEgressCache = { expires: Date.now() + 15000, data };
        return data;
      })
      .finally(() => {
        traceEgressPromise = null;
      });
  }
  return traceEgressPromise;
}

async function readTraceEgressCache(env) {
  try {
    await ensureKVStore(env);
    const row = await env.DB.prepare(`SELECT value FROM kv_store WHERE key = ?`).bind("trace_egress_cache").first();
    const saved = row?.value ? JSON.parse(row.value) : null;
    if (saved?.data && Number(saved.expires || 0) > 0) {
      return { expires: Number(saved.expires), data: saved.data };
    }
  } catch {
    return null;
  }
  return null;
}

async function writeTraceEgressCache(env, cache) {
  if (!env.DB || !cache?.data) {
    return;
  }
  await ensureKVStore(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`)
    .bind("trace_egress_cache", JSON.stringify(cache)).run();
}

async function fetchTraceEgress() {
  let timeout;
  const controller = new AbortController();
  try {
    timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("https://1.1.1.1/cdn-cgi/trace", {
      headers: { "user-agent": "MediaRoute-CF/" + BUILD_VERSION },
      cf: { cacheTtl: 60, cacheEverything: true },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error("trace returned " + res.status);
    }
    const textBody = await res.text();
    const data = Object.fromEntries(textBody.trim().split("\n").map((line) => {
      const index = line.indexOf("=");
      return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : ["", ""];
    }).filter((item) => item[0]));
    return { ...data, fetchedAt: Date.now() };
  } finally {
    clearTimeout(timeout);
  }
}

async function getPreferredIPs(env) {
  const source = env.PREFERRED_IPS_URL || "https://raw.githubusercontent.com/ZhiXuanWang/cf-speed-dns/refs/heads/main/ipTop10.html";
  const res = await fetch(source, {
    headers: { "user-agent": "MediaRoute-CF/" + BUILD_VERSION },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!res.ok) {
    return { ok: false, error: "preferred IP source returned " + res.status };
  }
  const body = await res.text();
  const ips = extractIPs(body);
  return { ok: true, source, ipv4: ips.ipv4, ipv6: ips.ipv6, updatedAt: Date.now() };
}

async function getAnalytics(env) {
  const stats = await getStats(env);
  const [trafficToday, traffic7d, traffic30d] = await Promise.all([
    getCFTraffic(env, "today").catch((err) => ({ ok: false, error: errMessage(err) })),
    getCFTraffic(env, "7d").catch((err) => ({ ok: false, error: errMessage(err) })),
    getCFTraffic(env, "30d").catch((err) => ({ ok: false, error: errMessage(err) }))
  ]);
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const trendRows = await env.DB.prepare(`
    SELECT substr(day, 6, 5) AS date, SUM(count) AS count
    FROM request_stats
    WHERE updated_at >= ?
    GROUP BY day
    ORDER BY day ASC
  `).bind(since).all();
  const locationRows = await env.DB.prepare(`
    SELECT country, COUNT(*) AS count
    FROM visitor_logs
    WHERE ts >= ?
    GROUP BY country
    ORDER BY count DESC
    LIMIT 12
  `).bind(since).all();
  return {
    success: true,
    ok: true,
    trend: trendRows.results || [],
    locations: locationRows.results || [],
    recents: (stats.recent || []).map((row) => ({
      prefix: row.node,
      timestamp: new Date(Number(row.ts || 0)).toISOString(),
      ip: row.ip,
      country: row.country,
      ua: row.ua,
      outboundProfile: row.outbound_profile || "",
      outboundUa: row.outbound_ua || "",
      outboundDevice: row.outbound_device || ""
    })),
    trafficToday: trafficLabel(trafficToday),
    traffic7d: trafficLabel(traffic7d),
    traffic30d: trafficLabel(traffic30d)
  };
}

function trafficLabel(data) {
  if (!data || data.ok === false) {
    return data?.error || "获取异常";
  }
  return data.humanBytes || formatBytes(data.bytes || 0);
}

function extractIPs(body) {
  const ipv4 = uniqueMatches(body, /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g);
  const ipv6 = uniqueMatches(body, /\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/gi);
  return { ipv4, ipv6 };
}

function uniqueMatches(body, re) {
  return [...new Set(String(body || "").match(re) || [])].slice(0, 50);
}

async function getDNSRecords(env, name) {
  const cfg = cloudflareConfig(env, ["CF_API_TOKEN", "CF_ZONE_ID"]);
  if (!cfg.ok) {
    return cfg;
  }
  name = cleanString(name);
  if (!name) {
    return { ok: false, error: "missing DNS name" };
  }
  const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?name=${encodeURIComponent(name)}`;
  const data = await cfJSON(env, url);
  if (!data.success) {
    return { ok: false, error: cfErrors(data) };
  }
  return { ok: true, records: data.result || [] };
}

async function updateDNSRecords(env, body) {
  const cfg = cloudflareConfig(env, ["CF_API_TOKEN", "CF_ZONE_ID"]);
  if (!cfg.ok) {
    return cfg;
  }
  const name = cleanString(body.name || dnsDomain(env));
  const type = cleanString(body.type || "A").toUpperCase();
  const values = Array.isArray(body.values) ? body.values.map(cleanString).filter(Boolean) : [];
  if (!["A", "AAAA", "CNAME"].includes(type)) {
    return { ok: false, error: "record type must be A, AAAA or CNAME" };
  }
  if (type === "CNAME" && values.length > 1) {
    return { ok: false, error: "CNAME record only supports one value" };
  }
  if (!name || values.length === 0) {
    return { ok: false, error: "missing DNS name or values" };
  }

  const current = await getDNSRecords(env, name);
  if (!current.ok) {
    return current;
  }
  const addressRecords = current.records.filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
  const relevant = addressRecords.filter((record) =>
    record.type === type || (type === "CNAME" && ["A", "AAAA"].includes(record.type)) || record.type === "CNAME"
  );
  if (relevant.some(isWorkerManagedDNSRecord)) {
    return { ok: false, error: "当前域名包含 Worker 托管记录，不能由 DNS 工具覆盖。" };
  }
  const replaced = await replaceDNSRecordsSafely(
    env,
    name,
    relevant,
    values.map((content) => ({ type, content })),
    1
  );
  if (!replaced.ok) {
    return replaced;
  }
  await recordDNSHistory(env, name, type, relevant.map((r) => r.content).join(","), values.join(","));
  return { ok: true, name, type, created: replaced.records };
}

async function getDNSRecordsCompat(env) {
  const name = dnsDomain(env);
  const data = await getDNSRecords(env, name);
  if (!data.ok) {
    return { success: false, ok: false, error: data.error, name, managementName: env.CF_DOMAIN || "" };
  }
  return { success: true, ok: true, name, managementName: env.CF_DOMAIN || "", result: data.records };
}

async function updateDNSRecordsCompat(env, body) {
  const ips = Array.isArray(body.ips) ? body.ips.map(cleanDNSValue).filter(Boolean) : [];
  const name = cleanString(body.name || dnsDomain(env));
  if (!name || ips.length === 0) {
    return { success: false, ok: false, error: "missing DNS domain or values" };
  }
  const current = await getDNSRecords(env, name);
  if (!current.ok) {
    return { success: false, ok: false, error: current.error };
  }
  const relevant = current.records.filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
  const workerManaged = relevant.some(isWorkerManagedDNSRecord);
  if (workerManaged) {
    return {
      success: false,
      ok: false,
      name,
      error: "当前域名是 Worker 托管记录，不能直接覆盖。请把 CF_DNS_DOMAIN 设置为独立调度域名。"
    };
  }
  const cnameValues = ips.filter((item) => dnsTypeFor(item) === "CNAME");
  if (cnameValues.length && ips.length > 1) {
    return { success: false, ok: false, error: "CNAME 记录不能和 A/AAAA 或多个 CNAME 同名共存，请只提交一个 CNAME。" };
  }
  const replaced = await replaceDNSRecordsSafely(
    env,
    name,
    relevant,
    ips.map((content) => ({ type: dnsTypeFor(content), content })),
    60
  );
  if (!replaced.ok) {
    return { success: false, ...replaced };
  }
  await recordDNSHistory(env, name, "mixed", relevant.map((r) => r.content).join(","), ips.join(","));
  return { success: true, ok: true, name, message: "DNS 更新成功", created: replaced.records };
}

function dnsRecordKey(record) {
  const type = cleanString(record?.type).toUpperCase();
  let content = cleanDNSValue(record?.content || "");
  if (type === "CNAME") content = content.toLowerCase().replace(/\.$/, "");
  return `${type}\n${content}`;
}

async function replaceDNSRecordsSafely(env, name, currentRecords, desiredRecords, ttl) {
  const current = (currentRecords || []).filter((record) => record?.id);
  const desired = [...new Map((desiredRecords || []).map((record) => [dnsRecordKey(record), {
    type: cleanString(record.type).toUpperCase(),
    content: cleanDNSValue(record.content)
  }])).values()];
  if (!desired.length) return { ok: false, error: "missing DNS values", records: [] };

  const desiredKeys = new Set(desired.map(dnsRecordKey));
  const retainedIds = new Set();
  const establishedKeys = new Set();
  const records = [];
  for (const record of current) {
    const key = dnsRecordKey(record);
    if (desiredKeys.has(key) && !establishedKeys.has(key)) {
      retainedIds.add(record.id);
      establishedKeys.add(key);
      records.push(record);
    }
  }

  const missing = desired.filter((record) => !establishedKeys.has(dnsRecordKey(record)));
  const createdIds = [];
  let pivot = null;
  if (missing.length && current.length && retainedIds.size === 0) {
    const previous = current[0];
    const next = missing.shift();
    const updated = await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${previous.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...next, name, proxied: false, ttl })
    });
    if (!updated.success) return { ok: false, error: cfErrors(updated), records: [] };
    pivot = { previous, next };
    retainedIds.add(previous.id);
    establishedKeys.add(dnsRecordKey(next));
    records.push(updated.result || { id: previous.id, ...next });
  }

  for (const record of missing) {
    const created = await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ ...record, name, proxied: false, ttl })
    });
    if (!created.success) {
      await rollbackDNSReplacement(env, name, createdIds, pivot, ttl);
      return { ok: false, error: cfErrors(created), records: [] };
    }
    if (created.result?.id) createdIds.push(created.result.id);
    records.push(created.result || record);
  }

  const obsolete = current.filter((record) => !retainedIds.has(record.id));
  for (const record of obsolete) {
    const removed = await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, { method: "DELETE" });
    if (!removed.success) {
      return {
        ok: false,
        partial: true,
        error: `新记录已生效，但旧记录 ${record.content || record.id} 清理失败：${cfErrors(removed)}`,
        records
      };
    }
  }
  return { ok: true, records };
}

async function rollbackDNSReplacement(env, name, createdIds, pivot, ttl) {
  for (const id of createdIds) {
    try {
      await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${id}`, { method: "DELETE" });
    } catch {}
  }
  if (!pivot?.previous?.id) return;
  try {
    await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${pivot.previous.id}`, {
      method: "PUT",
      body: JSON.stringify({
        type: pivot.previous.type,
        name,
        content: pivot.previous.content,
        proxied: Boolean(pivot.previous.proxied),
        ttl: Number(pivot.previous.ttl || ttl)
      })
    });
  } catch {}
}

function dnsDomain(env) {
  return cleanString(env.CF_DNS_DOMAIN || env.CF_DOMAIN || "");
}

function isWorkerManagedDNSRecord(record) {
  return Boolean(record?.meta?.origin_worker_id || record?.meta?.read_only || record?.read_only);
}

function cleanDNSValue(value) {
  return cleanString(value).replace(/^\[/, "").replace(/\]$/, "");
}

function dnsTypeFor(value) {
  if (String(value).includes(":")) {
    return "AAAA";
  }
  if (/[a-z]/i.test(String(value))) {
    return "CNAME";
  }
  return "A";
}

async function getCustomAPIIPs(apiURL) {
  if (!/^https?:\/\//i.test(apiURL)) {
    return { success: false, ok: false, error: "missing url", ips: [], totalCount: 0 };
  }
  const response = await fetch(apiURL, { headers: { "user-agent": "Mozilla/5.0" } });
  const textBody = await response.text();
  const values = extractPreferredValues(textBody);
  return { success: true, ok: true, ips: sample(values, 15), totalCount: values.length };
}

async function getRemoteIPs(env, type) {
  const reqType = String(type || "all").toLowerCase();
  const values = new Set();
  if (["all", "电信", "联通", "移动", "多线", "ipv6"].includes(reqType)) {
    try {
      const res = await fetch("https://api.uouin.com/cloudflare.html", { headers: { "user-agent": "Mozilla/5.0" } });
      if (res.ok) {
        const cleanBody = (await res.text()).replace(/<[^>]+>/g, " ");
        const re = /(电信|联通|移动|多线|ipv6)\s+((?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-fA-F0-9]{1,4}:)+[a-fA-F0-9]{1,4})/gi;
        let match;
        while ((match = re.exec(cleanBody))) {
          const lineType = match[1].toLowerCase();
          let value = match[2];
          if (value.includes(":") && !value.startsWith("[")) {
            value = `[${value}]`;
          }
          if (reqType === "all" || reqType === lineType) {
            values.add(value);
          }
        }
      }
    } catch {
      // Secondary public sources are best-effort.
    }
  }
  if (["all", "优选"].includes(reqType)) {
    try {
      const source = env.PREFERRED_IPS_URL || "https://raw.githubusercontent.com/ZhiXuanWang/cf-speed-dns/refs/heads/main/ipTop10.html";
      const res = await fetch(source, { headers: { "user-agent": "Mozilla/5.0" }, cf: { cacheTtl: 300 } });
      if (res.ok) {
        for (const value of extractPreferredValues(await res.text())) {
          values.add(value);
        }
      }
    } catch {
      // Keep any values already found.
    }
  }
  const list = Array.from(values);
  return { success: true, ok: true, ips: sample(list, 10), totalCount: list.length };
}

function extractPreferredValues(textBody) {
  const values = new Set();
  try {
    const jsonBody = JSON.parse(textBody);
    const rows = Array.isArray(jsonBody) ? jsonBody : (Array.isArray(jsonBody?.data) ? jsonBody.data : []);
    for (const row of rows) {
      const value = row?.ip || row?.host || row?.address || row?.content;
      if (value) {
        values.add(formatCandidateValue(value));
      }
    }
  } catch {
    // Fall through to regex extraction.
  }
  for (const ip of String(textBody || "").match(/\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g) || []) {
    if (!ip.startsWith("10.") && !ip.startsWith("192.168.") && !ip.startsWith("127.")) {
      values.add(ip);
    }
  }
  for (const ip of String(textBody || "").match(/(?:[A-F0-9]{1,4}:){7}[A-F0-9]{1,4}|(?:[A-F0-9]{1,4}:)*:[A-F0-9]{1,4}(?::[A-F0-9]{1,4})*/gi) || []) {
    if (ip.length > 7 && !ip.startsWith("::1")) {
      values.add(formatCandidateValue(ip));
    }
  }
  return Array.from(values);
}

function formatCandidateValue(value) {
  const textValue = cleanString(value);
  return textValue.includes(":") && !textValue.startsWith("[") ? `[${textValue}]` : textValue;
}

function sample(items, limit) {
  const list = items.slice();
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list.slice(0, limit);
}

async function purgeZoneCache(env) {
  const cfg = cloudflareConfig(env, ["CF_API_TOKEN", "CF_ZONE_ID"]);
  if (!cfg.ok) {
    return { success: false, ok: false, error: cfg.error };
  }
  const data = await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`, {
    method: "POST",
    body: JSON.stringify({ purge_everything: true })
  });
  if (!data.success) {
    return { success: false, ok: false, error: cfErrors(data) };
  }
  return { success: true, ok: true };
}

async function deployWorkerCode(env, body) {
  const cfg = cloudflareConfig(env, ["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_WORKER_NAME"]);
  if (!cfg.ok) {
    return { success: false, ok: false, error: cfg.error };
  }
  const code = String(body.newCode || "");
  if (!code.trim()) {
    return { success: false, ok: false, error: "code is empty" };
  }
  if (!looksObfuscated(code)) {
    return {
      success: false,
      ok: false,
      error: "拒绝部署明文代码。请先用指定混淆工具生成混淆代码，或走本地 npm run deploy 流程。"
    };
  }
  const service = await cfJSON(env, `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/services/${env.CF_WORKER_NAME}`);
  let compatibilityDate = "2026-07-06";
  let compatibilityFlags;
  let placement;
  const scriptInfo = service.result?.default_environment?.script || service.result?.script;
  if (scriptInfo) {
    compatibilityDate = scriptInfo.compatibility_date || compatibilityDate;
    compatibilityFlags = scriptInfo.compatibility_flags;
    placement = scriptInfo.placement;
  }
  const bindings = await workerBindings(env);
  const metadata = {
    main_module: "worker.js",
    bindings,
    compatibility_date: compatibilityDate
  };
  if (compatibilityFlags) {
    metadata.compatibility_flags = compatibilityFlags;
  }
  if (placement) {
    metadata.placement = placement;
  }
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  form.append("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${env.CF_WORKER_NAME}`, {
    method: "PUT",
    headers: { authorization: "Bearer " + env.CF_API_TOKEN },
    body: form
  });
  const data = await res.json();
  if (!data.success) {
    return { success: false, ok: false, error: cfErrors(data), raw: data.errors };
  }
  return { success: true, ok: true, msg: "代码更新成功，已保留绑定和兼容配置。" };
}

function looksObfuscated(code) {
  const textValue = String(code || "");
  const plaintextSignals = [
    "function admin" + "HTML",
    "const CLIENT" + "_PROFILES",
    "async function handle" + "API"
  ];
  return textValue.includes("_0x") ||
    textValue.includes("javascript-obfuscator") ||
    /\\x[0-9a-f]{2}/i.test(textValue) ||
    textValue.length > 200000 && !plaintextSignals.some((signal) => textValue.includes(signal));
}

async function workerBindings(env) {
  const preserved = [];
  for (const key of ["CF_ACCOUNT_ID", "CF_ZONE_ID", "CF_DOMAIN", "CF_DNS_DOMAIN", "CF_WORKER_NAME", "TG_REPORT_HOUR", "PREFERRED_IPS_URL"]) {
    if (typeof env[key] === "string") {
      preserved.push({ name: key, type: "plain_text", text: env[key] });
    }
  }
  try {
    const data = await cfJSON(env, `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${env.CF_WORKER_NAME}/bindings`);
    if (data.success && Array.isArray(data.result)) {
      for (const binding of data.result) {
        if (preserved.some((item) => item.name === binding.name)) {
          continue;
        }
        if (binding.type === "secret_text" && typeof env[binding.name] === "string") {
          preserved.push({ ...binding, text: env[binding.name] });
        } else {
          preserved.push(binding);
        }
      }
    }
  } catch {
    // Fall back to known plain text bindings.
  }
  return preserved;
}

async function recordDNSHistory(env, name, type, oldValue, newValue) {
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS dns_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        name TEXT NOT NULL,
        record_type TEXT NOT NULL,
        old_value TEXT DEFAULT '',
        new_value TEXT DEFAULT '',
        operator TEXT DEFAULT 'admin'
      )
    `).run();
    await env.DB.prepare(`
      INSERT INTO dns_history (ts, name, record_type, old_value, new_value, operator)
      VALUES (?, ?, ?, ?, ?, 'admin')
    `).bind(Date.now(), name, type, oldValue, newValue).run();
  } catch {
    // DNS update should not fail because history persistence failed.
  }
}

async function getCFTraffic(env, range) {
  const cfg = cloudflareConfig(env, ["CF_API_TOKEN", "CF_ZONE_ID"]);
  if (!cfg.ok) {
    return cfg;
  }
  const now = new Date();
  let start;
  if (range === "7d") {
    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  } else if (range === "30d") {
    start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    bj.setUTCHours(0, 0, 0, 0);
    start = new Date(bj.getTime() - 8 * 60 * 60 * 1000);
  }
  const chunks = trafficTimeChunks(start, now);
  const total = { bytes: 0, requests: 0 };
  for (const chunk of chunks) {
    const part = await queryCFTrafficInterval(env, chunk.start, chunk.end);
    if (!part.ok) {
      return { ok: false, range, start: start.toISOString(), end: now.toISOString(), error: part.error };
    }
    total.bytes += part.bytes;
    total.requests += part.requests;
  }
  return { ok: true, range, start: start.toISOString(), end: now.toISOString(), chunks: chunks.length, ...total, humanBytes: formatBytes(total.bytes) };
}

function trafficTimeChunks(start, end) {
  const chunks = [];
  const maxMs = 23 * 60 * 60 * 1000 + 55 * 60 * 1000;
  let cursor = new Date(start);
  const finish = new Date(end);
  while (cursor < finish) {
    const next = new Date(Math.min(cursor.getTime() + maxMs, finish.getTime()));
    chunks.push({ start: new Date(cursor), end: next });
    cursor = new Date(next.getTime() + 1);
  }
  return chunks;
}

async function queryCFTrafficInterval(env, start, end) {
  const query = `
    query Traffic($zone: string, $start: Time, $end: Time) {
      viewer {
        zones(filter: { zoneTag: $zone }) {
          httpRequestsAdaptiveGroups(
            limit: 100,
            filter: { datetime_geq: $start, datetime_leq: $end }
          ) {
            count
            sum { edgeResponseBytes }
          }
        }
      }
    }
  `;
  const data = await cfJSON(env, "https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    body: JSON.stringify({
      query,
      variables: { zone: env.CF_ZONE_ID, start: start.toISOString(), end: end.toISOString() }
    })
  });
  if (data.errors?.length) {
    return { ok: false, error: data.errors[0].message || "GraphQL error" };
  }
  const groups = data.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups || [];
  const total = groups.reduce((acc, item) => {
    acc.bytes += Number(item.sum?.edgeResponseBytes || 0);
    acc.requests += Number(item.count || 0);
    return acc;
  }, { bytes: 0, requests: 0 });
  return { ok: true, bytes: total.bytes, requests: total.requests };
}

async function sendTelegramReport(env, options = {}) {
  if (!env.TG_BOT_TOKEN) {
    if (options.silentIfUnconfigured) {
      return { ok: false, skipped: true };
    }
    return { ok: false, error: "missing TG_BOT_TOKEN" };
  }
  const chatIds = telegramChatIds(env, options.chatId);
  if (!chatIds.length) {
    if (options.silentIfUnconfigured) {
      return { ok: false, skipped: true };
    }
    return { ok: false, error: "missing TG_CHAT_ID" };
  }
  const report = await buildTelegramReport(env, options.section || "full");
  const results = [];
  for (const chatId of chatIds) {
    const messageId = options.editMessageId || (options.replaceLast === false ? "" : await getTelegramLastMessageId(env, chatId));
    let sent = messageId ? await editTelegramMessage(env, chatId, messageId, report.text, report.keyboard) : null;
    if (!sent?.ok) {
      sent = await sendTelegramMessage(env, chatId, report.text, report.keyboard);
    }
    const newMessageId = sent?.result?.result?.message_id || sent?.result?.result?.message?.message_id || messageId;
    if (sent.ok && newMessageId) {
      await setTelegramLastMessageId(env, chatId, newMessageId);
    }
    results.push({ chatId, ...sent });
  }
  return results.length === 1 ? results[0] : { ok: results.every((item) => item.ok), results };
}

async function buildTelegramReport(env, section = "full") {
  const stats = await getStats(env);
  const [traffic, nodes, keepalive, dns, watchLogs] = await Promise.all([
    getCFTraffic(env, "today").catch((err) => ({ ok: false, error: errMessage(err) })),
    listNodesWithKeepalive(env).catch(() => []),
    getKeepaliveStatuses(env).catch(() => []),
    getDNSRecordsCompat(env).catch((err) => ({ success: false, error: errMessage(err), result: [] })),
    listWatchLogs(env, { days: 3, limit: 20 }).catch(() => [])
  ]);
  const rows = stats.today || [];
  const enabled = nodes.filter((node) => node.enabled).length;
  const byKind = (kind) => rows.filter((row) => row.kind === kind);
  const sum = (items, key) => items.reduce((n, row) => n + Number(row[key] || 0), 0);
  const playbackRows = byKind("playback");
  const imageRows = byKind("image");
  const requestRows = byKind("request");
  const directRows = byKind("direct");
  const playbackCount = sum(playbackRows, "count");
  const playbackBytes = sum(playbackRows, "bytes");
  const imageCount = sum(imageRows, "count");
  const imageBytes = sum(imageRows, "bytes");
  const requestCount = sum(requestRows, "count");
  const requestBytes = sum(requestRows, "bytes");
  const directCount = sum(directRows, "count");
  const statusRows = stats.recent || [];
  const failures = statusRows.filter((row) => Number(row.status || 0) >= 400).slice(0, 3);
  const dnsRecords = (dns.result || []).filter((record) => ["A", "AAAA", "CNAME"].includes(record.type));
  const dnsCounts = dnsRecords.reduce((acc, record) => {
    acc[record.type] = (acc[record.type] || 0) + 1;
    return acc;
  }, {});
  const keepWarn = keepalive.filter((item) => item.status === "due" || item.status === "warn");

  const sections = {};
  sections.today = [
    "📊 今日概况",
    `🟢 节点：${enabled} 启用 / ${nodes.length} 总数`,
    `🎬 播放请求：${playbackCount} 次`,
    `💾 播放流量：${formatBytes(playbackBytes)}`,
    traffic.ok ? `🌐 全站 CF 流量：${traffic.humanBytes}` : `🌐 全站 CF 流量：${traffic.error || "未配置"}`,
    `🖼️ 图片/海报：${imageCount} 次 · ${formatBytes(imageBytes)}`,
    `📦 普通请求：${requestCount} 次 · ${formatBytes(requestBytes)}`,
    `🚀 直达跳转：${directCount} 次`
  ];

  sections.playback = ["🏆 今日播放 TOP 5"];
  pushTopRows(sections.playback, playbackRows, "count", true);

  sections.traffic = ["💾 今日流量 TOP 5"];
  pushTopRows(sections.traffic, rows, "bytes", false);

  sections.keepalive = ["⏰ 观看提醒"];
  if (keepWarn.length) {
    for (const item of keepWarn.slice(0, 6)) {
      const icon = item.status === "due" ? "🔴" : "🟡";
      const state = item.status === "due" ? `已超期 ${Math.abs(item.remainDays)} 天` : `剩余 ${item.remainDays} 天`;
      const last = item.lastPlayTs ? formatDateTime(item.lastPlayTs) : "无真实播放记录";
      sections.keepalive.push(`${icon} ${item.displayName}：${state}`);
      sections.keepalive.push(`   最近观看：${last} · 周期 ${item.renewDays} 天`);
    }
  } else {
    sections.keepalive.push("🟢 暂无即将到期节点");
  }

  sections.health = ["🚦 线路健康"];
  if (failures.length) {
    sections.health.push(`⚠️ 最近异常：${failures.length} 条`);
    for (const row of failures) {
      sections.health.push(`❌ ${row.node} · ${row.status} · ${String(row.path || "").slice(0, 48)}`);
    }
  } else {
    sections.health.push("✅ 最近记录未发现 4xx/5xx 异常");
  }

  sections.dns = ["🧭 DNS / 优选 IP", `🌐 调度域名：${dnsDomain(env) || "-"}`];
  if (dns.success) {
    sections.dns.push(`✅ A：${dnsCounts.A || 0} 条 · AAAA：${dnsCounts.AAAA || 0} 条 · CNAME：${dnsCounts.CNAME || 0} 条`);
    for (const record of dnsRecords.slice(0, 4)) {
      sections.dns.push(`   ${record.type} ${record.content}`);
    }
  } else {
    sections.dns.push(`⚠️ DNS 获取失败：${dns.error || "未知错误"}`);
  }

  sections.recent = ["🧾 最近播放记录"];
  const recentPlayback = statusRows.filter((row) => row.kind === "playback" || isKeepalivePlaybackPath(row.path || "")).slice(0, 5);
  if (recentPlayback.length) {
    recentPlayback.forEach((row, index) => {
      sections.recent.push(`${index + 1}. ${row.node} · ${row.country || "-"} · ${formatDateTime(row.ts).slice(11)} · ${row.status}`);
    });
  } else {
    sections.recent.push("暂无播放记录");
  }

  sections.watch = ["👀 最近 3 天模拟观看"];
  if (watchLogs.length) {
    watchLogs.slice(0, 12).forEach((item, index) => {
      const site = item.displayName || item.node || "-";
      const title = item.title || "未知内容";
      const time = item.time || formatDateTime(item.ts);
      const source = item.source === "auto" ? "自动" : "手动";
      const duration = item.durationText || formatDurationSec(item.durationSec || 0);
      sections.watch.push(`${index + 1}. ${site} · ${title} · ${time} · ${duration} · ${source}`);
    });
  } else {
    sections.watch.push("暂无模拟观看记录");
  }

  const header = [
    "📡 媒体线路日报",
    `📅 ${stats.day} · ${formatDateTime(Date.now()).slice(11)} 自动汇总`
  ];
  const sectionKeys = ["today", "playback", "traffic", "keepalive", "watch", "health", "dns", "recent"];
  const selected = section === "full" || !sections[section] ? sectionKeys : [section];
  const lines = [...header];
  for (const key of selected) {
    lines.push("", ...sections[key]);
  }
  const keyboard = buildTelegramKeyboard(env, section);
  return { text: lines.join("\n").slice(0, 3900), keyboard };
}

function buildTelegramKeyboard(env, section = "full") {
  const keyboard = [
    [
      { text: "📊 今日概况", callback_data: "report:today" },
      { text: "🏆 播放排行", callback_data: "report:playback" }
    ],
    [
      { text: "💾 流量排行", callback_data: "report:traffic" },
      { text: "⏰ 观看提醒", callback_data: "report:keepalive" }
    ],
    [
      { text: "👀 模拟观看", callback_data: "report:watch" },
      { text: "🧾 最近播放", callback_data: "report:recent" }
    ],
    [
      { text: "🚦 线路健康", callback_data: "report:health" },
      { text: "🧭 DNS 状态", callback_data: "report:dns" }
    ],
    [
      { text: section === "full" ? "🔄 刷新日报" : "📡 完整日报", callback_data: "refresh_stats" }
    ]
  ];
  if (env.CF_DOMAIN) {
    keyboard.push([{ text: "🌐 打开控制台", url: "https://" + env.CF_DOMAIN + "/admin" }]);
  }
  return { inline_keyboard: keyboard };
}

function pushTopRows(lines, rows, sortKey, playbackOnly) {
  const medals = ["🥇", "🥈", "🥉"];
  const top = aggregateNodeRows(rows).sort((a, b) => Number(b[sortKey] || 0) - Number(a[sortKey] || 0)).slice(0, 5);
  if (!top.length) {
    lines.push("暂无数据");
    return;
  }
  top.forEach((row, index) => {
    const prefix = medals[index] || `${index + 1}.`;
    const suffix = playbackOnly
      ? `${row.count} 次 · ${formatBytes(row.bytes)}`
      : `${formatBytes(row.bytes)} · ${row.count} 次`;
    lines.push(`${prefix} ${row.node}：${suffix}`);
  });
}

function aggregateNodeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const current = map.get(row.node) || { node: row.node, count: 0, bytes: 0 };
    current.count += Number(row.count || 0);
    current.bytes += Number(row.bytes || 0);
    map.set(row.node, current);
  }
  return Array.from(map.values());
}

async function sendKeepaliveReminders(env) {
  // 兼容旧调用：按节点配置选择自动观看或每日到期提醒
  return runAutoSimulatedWatches(env);
}

async function handleTelegramWebhook(request, env) {
  if (!env.TG_WEBHOOK_SECRET) {
    return text("Telegram webhook secret is not configured", 503);
  }
  const got = request.headers.get("x-telegram-bot-api-secret-token") || "";
  if (got !== env.TG_WEBHOOK_SECRET) {
    return text("Forbidden", 403);
  }
  if (!env.TG_BOT_TOKEN) {
    return text("OK");
  }
  try {
    const body = await request.json();
    const incomingChatId = body.message?.chat?.id ?? body.callback_query?.message?.chat?.id;
    const allowedChats = new Set(telegramChatIds(env));
    if (!incomingChatId || !allowedChats.has(cleanString(incomingChatId))) {
      return text("Forbidden", 403);
    }
    const messageText = cleanTelegramCommand(body.message?.text);
    if (["/start", "/help", "/stats", "/report"].includes(messageText)) {
      await sendTelegramReport(env, { chatId: body.message.chat.id, replaceLast: false });
      return text("OK");
    }
    const query = body.callback_query;
    if (query) {
      const data = String(query.data || "");
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      if (!chatId || !messageId) {
        return text("OK");
      }
      await telegramAPI(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: data === "refresh_stats" || data === "report:refresh" ? "🔄 正在刷新数据..." : "📊 正在切换报表..."
      });
      const section = data.startsWith("report:") ? data.slice("report:".length) : "full";
      await sendTelegramReport(env, {
        chatId,
        editMessageId: messageId,
        section: section === "refresh" ? "full" : section
      });
    }
  } catch (err) {
    console.log("telegram webhook error", errMessage(err));
  }
  return text("OK");
}

function cleanTelegramCommand(value) {
  const first = cleanString(value).split(/\s+/)[0].toLowerCase();
  return first.replace(/@[a-z0-9_]+$/i, "");
}

async function setupTelegramWebhook(env) {
  if (!env.TG_BOT_TOKEN) {
    return { ok: false, error: "missing TG_BOT_TOKEN" };
  }
  const webhookURL = cleanString(env.TG_WEBHOOK_URL) || (env.CF_DOMAIN ? `https://${env.CF_DOMAIN}/api/tg-webhook` : "");
  if (!webhookURL) {
    return { ok: false, error: "missing TG_WEBHOOK_URL or CF_DOMAIN" };
  }
  if (!env.TG_WEBHOOK_SECRET) {
    return { ok: false, error: "missing TG_WEBHOOK_SECRET" };
  }
  const payload = {
    url: webhookURL,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  };
  payload.secret_token = env.TG_WEBHOOK_SECRET;
  const res = await telegramAPI(env, "setWebhook", payload);
  return { ok: res.ok, webhookURL, result: res.result };
}

function telegramChatIds(env, explicit) {
  const ids = explicit ? [explicit] : [env.TG_CHAT_ID, env.TG_CHAT_ID_2];
  return [...new Set(ids.map((id) => cleanString(id)).filter(Boolean))];
}

async function sendTelegramReportText(env, textBody) {
  if (!env.TG_BOT_TOKEN) {
    return { ok: false, skipped: true };
  }
  const chatIds = telegramChatIds(env);
  if (!chatIds.length) {
    return { ok: false, skipped: true };
  }
  const results = [];
  for (const chatId of chatIds) {
    results.push(await sendTelegramMessage(env, chatId, textBody));
  }
  return results.length === 1 ? results[0] : { ok: results.every((item) => item.ok), results };
}

async function sendTelegramMessage(env, chatId, textBody, replyMarkup) {
  return telegramAPI(env, "sendMessage", {
    chat_id: chatId,
    text: textBody,
    reply_markup: replyMarkup
  });
}

async function editTelegramMessage(env, chatId, messageId, textBody, replyMarkup) {
  const result = await telegramAPI(env, "editMessageText", {
    chat_id: chatId,
    message_id: Number(messageId),
    text: textBody,
    reply_markup: replyMarkup
  });
  const description = String(result.result?.description || "");
  if (!result.ok && description.includes("message is not modified")) {
    return { ...result, ok: true };
  }
  return result;
}

async function telegramAPI(env, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok !== false, status: res.status, result: data };
}

async function ensureKVStore(env) {
  await ensureSchema(env);
}

async function getTelegramLastMessageId(env, chatId) {
  if (!env.DB || !chatId) {
    return "";
  }
  await ensureKVStore(env);
  const row = await env.DB.prepare(`SELECT value FROM kv_store WHERE key = ?`).bind(`tg_last_msg_id_${chatId}`).first();
  return cleanString(row?.value);
}

async function setTelegramLastMessageId(env, chatId, messageId) {
  if (!env.DB || !chatId || !messageId) {
    return;
  }
  await ensureKVStore(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`)
    .bind(`tg_last_msg_id_${chatId}`, String(messageId)).run();
}

function formatDateTime(ts) {
  return new Date(Number(ts || 0) + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 16);
}

async function sendTelegramDailyIfDue(env) {
  if (!env.TG_BOT_TOKEN || !telegramChatIds(env).length || !env.DB) {
    return { ok: false, skipped: true };
  }
  const hour = Number.parseInt(env.TG_REPORT_HOUR || "9", 10);
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  if (now.getUTCHours() !== hour) {
    return { ok: false, skipped: true, reason: "not due" };
  }
  const day = beijingDay();
  const key = "telegram_report_day";
  const row = await env.DB.prepare(`SELECT v FROM system_config WHERE k = ?`).bind(key).first();
  if (row?.v === day) {
    return { ok: false, skipped: true, reason: "already sent" };
  }
  const sent = await sendTelegramReport(env, { silentIfUnconfigured: true });
  if (sent.ok) {
    await env.DB.prepare(`
      INSERT INTO system_config (k, v, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
    `).bind(key, day, Date.now()).run();
  }
  return sent;
}

function cloudflareConfig(env, keys) {
  const missing = keys.filter((key) => !cleanString(env[key]));
  if (missing.length) {
    return { ok: false, error: "missing " + missing.join(", ") };
  }
  return { ok: true };
}

async function cfJSON(env, url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("authorization", "Bearer " + env.CF_API_TOKEN);
  if (init.body && !headers.get("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  return res.json();
}

function cfErrors(data) {
  return (data.errors || []).map((err) => err.message).filter(Boolean).join("; ") || "Cloudflare API error";
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes || 0);
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function checkAdmin(request, env) {
  const expected = String(env.ADMIN_TOKEN || "").trim();
  if (!expected || expected === "change-me-please") {
    return { ok: false, status: 500, error: "Access secret is not configured" };
  }
  const auth = request.headers.get("authorization") || "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : request.headers.get("x-admin-token");
  if (token !== expected) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

function parseTargets(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((v) => v.trim()).filter(Boolean);
  }
  if (typeof value !== "string") {
    return [];
  }
  const raw = value.trim();
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parseTargets(parsed);
    }
  } catch {
    // Fall through to separator parsing.
  }
  return splitTargets(raw);
}

function splitTargets(value) {
  return String(value || "")
    .replace(/\\r\\n|\\n/g, "\n")
    .split(/\n|[;,，；|]+/)
    .map((v) => v.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function normalizeName(name) {
  return nameToSlug(name);
}

function nameFromDisplay(value) {
  return nameToSlug(value);
}

function nameToSlug(value) {
  const parts = [];
  for (const char of String(value || "").trim().toLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      parts.push(char);
      continue;
    }
    if (char === "-" || char === "_") {
      parts.push(char);
      continue;
    }
    const py = PINYIN_WORDS[char] || chineseInitial(char);
    if (py) {
      parts.push(py);
    }
  }
  return parts.join("").replace(/-+/g, "-").replace(/_+/g, "_").replace(/^[-_]+|[-_]+$/g, "");
}

const PINYIN_WORDS = {
  "阿":"a","啊":"a","爱":"ai","安":"an","按":"an","奥":"ao",
  "八":"ba","白":"bai","百":"bai","版":"ban","半":"ban","包":"bao","备":"bei","北":"bei","本":"ben","比":"bi","标":"biao","播":"bo",
  "测":"ce","层":"ceng","查":"cha","常":"chang","超":"chao","车":"che","成":"cheng","城":"cheng","池":"chi","出":"chu","传":"chuan","窗":"chuang","春":"chun","词":"ci","次":"ci","从":"cong",
  "大":"da","带":"dai","单":"dan","到":"dao","的":"de","登":"deng","低":"di","地":"di","点":"dian","电":"dian","端":"duan","短":"duan","队":"dui","对":"dui","多":"duo",
  "俄":"e","额":"e","二":"er",
  "发":"fa","番":"fan","方":"fang","防":"fang","访":"fang","非":"fei","分":"fen","服":"fu","复":"fu",
  "港":"gang","高":"gao","个":"ge","更":"geng","公":"gong","共":"gong","广":"guang","国":"guo",
  "海":"hai","韩":"han","好":"hao","合":"he","黑":"hei","红":"hong","后":"hou","湖":"hu","华":"hua","缓":"huan","换":"huan","黄":"huang","回":"hui",
  "级":"ji","加":"jia","家":"jia","节":"jie","接":"jie","今":"jin","京":"jing","精":"jing","旧":"jiu",
  "开":"kai","客":"ke","空":"kong","快":"kuai",
  "来":"lai","蓝":"lan","老":"lao","类":"lei","冷":"leng","力":"li","连":"lian","联":"lian","链":"lian","良":"liang","量":"liang","列":"lie","临":"lin","流":"liu","龙":"long","路":"lu","录":"lu","绿":"lv",
  "美":"mei","门":"men","密":"mi","名":"ming","模":"mo",
  "南":"nan","内":"nei","你":"ni","年":"nian","宁":"ning","牛":"niu","农":"nong",
  "欧":"ou",
  "排":"pai","盘":"pan","配":"pei","频":"pin","平":"ping","普":"pu",
  "七":"qi","期":"qi","启":"qi","强":"qiang","清":"qing","轻":"qing","求":"qiu","全":"quan","群":"qun",
  "日":"ri","容":"rong","入":"ru","软":"ruan",
  "三":"san","色":"se","山":"shan","上":"shang","少":"shao","设":"she","深":"shen","生":"sheng","省":"sheng","时":"shi","视":"shi","试":"shi","首":"shou","数":"shu","双":"shuang","水":"shui","私":"si","速":"su",
  "台":"tai","态":"tai","泰":"tai","探":"tan","特":"te","天":"tian","条":"tiao","通":"tong","同":"tong","图":"tu",
  "外":"wai","网":"wang","微":"wei","文":"wen","我":"wo","五":"wu",
  "西":"xi","下":"xia","线":"xian","显":"xian","香":"xiang","详":"xiang","小":"xiao","新":"xin","信":"xin","星":"xing","修":"xiu","需":"xu",
  "亚":"ya","严":"yan","验":"yan","样":"yang","页":"ye","一":"yi","移":"yi","影":"ying","用":"yong","优":"you","友":"you","有":"you","源":"yuan","月":"yue","云":"yun",
  "再":"zai","站":"zhan","账":"zhang","者":"zhe","正":"zheng","中":"zhong","终":"zhong","主":"zhu","专":"zhuan","转":"zhuan","装":"zhuang","资":"zi","自":"zi","总":"zong","组":"zu","最":"zui"
};

function chineseInitial(char) {
  const code = char.charCodeAt(0);
  if (code < 0x4e00 || code > 0x9fff) {
    return "";
  }
  const ranges = [
    [0x554a,"a"],[0x516b,"b"],[0x64e6,"c"],[0x54d2,"d"],[0x59f6,"e"],[0x53d1,"f"],[0x560e,"g"],[0x54c8,"h"],[0x51fb,"j"],[0x5580,"k"],[0x5783,"l"],[0x5988,"m"],[0x62ff,"n"],[0x5662,"o"],[0x5991,"p"],[0x4e03,"q"],[0x7136,"r"],[0x6492,"s"],[0x584c,"t"],[0x6316,"w"],[0x5915,"x"],[0x538b,"y"],[0x531d,"z"]
  ];
  let result = "z";
  for (const [start, initial] of ranges) {
    if (code >= start) {
      result = initial;
    }
  }
  return result;
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function boolValue(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const s = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

function boolDefault(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return boolValue(value);
}

function intValue(value) {
  const n = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, intValue(value)));
}

function enumValue(value, allowed, fallback) {
  const s = String(value || "").trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function normalizeClientProfile(value) {
  return enumValue(value, CLIENT_PROFILES.map((item) => item.id), DEFAULT_CLIENT_PROFILE);
}

function trimSlash(path) {
  return String(path || "").replace(/^\/+|\/+$/g, "");
}

function isRetryableStatus(status) {
  return status >= 500 || status === 403 || status === 404 || status === 408 || status === 429;
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function stripResponseHeaders(headers) {
  for (const key of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
    headers.delete(key);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, Content-Type, Location, Server-Timing");
}

function contentLength(response) {
  const n = Number(response.headers.get("content-length") || "0");
  return Number.isFinite(n) ? n : 0;
}

function beijingDay(ts = Date.now()) {
  return new Date(ts + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("invalid JSON body");
  }
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function adminPage(body, nonce) {
  return html(body, 200, {
    "content-security-policy": `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

function clientProfileOptionsHTML() {
  return CLIENT_PROFILES.map((profile) => `<option value="${profile.id}">${escapeHTML(profile.label)}</option>`).join("");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function adminHTML(env = {}, nonce = "") {
  const labels = JSON.stringify(Object.fromEntries(CLIENT_PROFILES.map((item) => [item.id, item.label]))).replace(/</g, "\\u003c");
  const dispatchDomain = dnsDomain(env);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>媒体线路控制台</title>
<style>
:root{
  /* Trust / Professional default */
  --bg0:#F8FAFC;
  --bg1:#FFFFFF;
  --bg-glow-a:rgba(37,99,235,.10);
  --bg-glow-b:rgba(14,165,233,.08);
  --ink:#1E293B;          /* deep slate, not pure black */
  --ink-2:#334155;
  --muted:#64748B;
  --line:rgba(15,23,42,.10);
  --line-strong:rgba(15,23,42,.16);
  --glass:rgba(255,255,255,.72);
  --glass-strong:rgba(255,255,255,.88);
  --glass-soft:rgba(248,250,252,.66);
  --highlight:rgba(255,255,255,.9);
  --shadow:0 10px 28px rgba(15,23,42,.06);
  --shadow-lg:0 22px 50px rgba(15,23,42,.10);
  --accent:#2563EB;       /* Klein blue */
  --accent-2:#3B82F6;
  --accent-ink:#1D4ED8;
  --accent-soft:rgba(37,99,235,.12);
  --neon:#2563EB;
  --neon-2:#06B6D4;
  --ok:#059669;
  --warn:#D97706;
  --danger:#E11D48;
  --grad-accent:linear-gradient(135deg,#2563EB 0%,#3B82F6 55%,#06B6D4 100%);
  --grad-text:linear-gradient(90deg,#1E293B 0%,#2563EB 100%);
  --grad-border:linear-gradient(135deg,rgba(37,99,235,.55),rgba(6,182,212,.45));
  --radius:18px;
  --radius-sm:12px;
  --font:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --blur:20px;
  --ease:cubic-bezier(.22,1,.36,1);
  --grid-line:rgba(15,23,42,.035);
  color-scheme:light;
}

/* Cyber dark */
body.theme-cyber{
  color-scheme:dark;
  --bg0:#0B0B0C;
  --bg1:#0B0B0C;
  --bg-glow-a:rgba(0,245,212,.10);
  --bg-glow-b:rgba(255,0,122,.08);
  --ink:#E8EEF5;          /* soft off-white, not pure white */
  --ink-2:#C7D0DB;
  --muted:#9AA6B2;
  --line:rgba(255,255,255,.08);
  --line-strong:rgba(255,255,255,.14);
  --glass:rgba(30,31,34,.78);     /* #1E1F22 */
  --glass-strong:rgba(30,31,34,.92);
  --glass-soft:rgba(30,31,34,.62);
  --highlight:rgba(255,255,255,.08);
  --shadow:0 12px 36px rgba(0,0,0,.45);
  --shadow-lg:0 28px 70px rgba(0,0,0,.55);
  --accent:#00F5D4;
  --accent-2:#FF007A;
  --accent-ink:#00F5D4;
  --accent-soft:rgba(0,245,212,.12);
  --neon:#00F5D4;
  --neon-2:#FF007A;
  --ok:#00F5D4;
  --warn:#FBBF24;
  --danger:#FF007A;
  --grad-accent:linear-gradient(135deg,#00F5D4 0%,#22D3EE 45%,#FF007A 100%);
  --grad-text:linear-gradient(90deg,#E8EEF5 0%,#00F5D4 55%,#FF007A 100%);
  --grad-border:linear-gradient(135deg,rgba(0,245,212,.7),rgba(255,0,122,.55));
  --grid-line:rgba(0,245,212,.045);
}

/* Trust / professional explicit (also default :root) */
body.theme-trust{
  color-scheme:light;
  --bg0:#F8FAFC;
  --bg1:#FFFFFF;
  --bg-glow-a:rgba(37,99,235,.10);
  --bg-glow-b:rgba(37,99,235,.05);
  --ink:#1E293B;
  --ink-2:#334155;
  --muted:#64748B;
  --line:rgba(15,23,42,.10);
  --line-strong:rgba(15,23,42,.16);
  --glass:rgba(255,255,255,.76);
  --glass-strong:rgba(255,255,255,.92);
  --glass-soft:rgba(248,250,252,.7);
  --highlight:rgba(255,255,255,.95);
  --shadow:0 10px 28px rgba(15,23,42,.06);
  --shadow-lg:0 22px 50px rgba(15,23,42,.10);
  --accent:#2563EB;
  --accent-2:#3B82F6;
  --accent-ink:#1D4ED8;
  --accent-soft:rgba(37,99,235,.12);
  --neon:#2563EB;
  --neon-2:#3B82F6;
  --ok:#059669;
  --warn:#D97706;
  --danger:#E11D48;
  --grad-accent:linear-gradient(135deg,#1D4ED8 0%,#2563EB 50%,#38BDF8 100%);
  --grad-text:linear-gradient(90deg,#0F172A 10%,#2563EB 100%);
  --grad-border:linear-gradient(135deg,rgba(37,99,235,.5),rgba(56,189,248,.4));
  --grid-line:rgba(15,23,42,.035);
}

*{box-sizing:border-box}
html,body{margin:0;padding:0}
html{scroll-behavior:smooth;background:var(--bg0)}
html:has(body.theme-cyber){background:#0B0B0C}
body{
  min-height:100vh;
  font-family:var(--font);
  color:var(--ink);
  background:
    radial-gradient(900px 480px at 8% -8%, var(--bg-glow-a), transparent 55%),
    radial-gradient(700px 420px at 100% 0%, var(--bg-glow-b), transparent 50%),
    linear-gradient(180deg,var(--bg1),var(--bg0));
  background-attachment:fixed;
  padding:18px 18px 96px;
  line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
body:before{
  content:"";
  position:fixed;inset:0;pointer-events:none;z-index:0;
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size:48px 48px;
  mask-image:radial-gradient(ellipse at center, #000 18%, transparent 75%);
}
body.theme-cyber:after{
  content:"";
  position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(600px 280px at 15% 20%, rgba(0,245,212,.06), transparent 60%),
    radial-gradient(500px 260px at 85% 15%, rgba(255,0,122,.05), transparent 60%);
}
button,input,select,textarea{font:inherit}
button{cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
a{color:var(--accent-ink)}
.mono{font-family:var(--mono)}

/* micro-gradient text utility */
.grad-text{
  background:var(--grad-text);
  -webkit-background-clip:text;background-clip:text;
  color:transparent;
}
.grad-border{
  position:relative;
}
.grad-border:before{
  content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;
  background:var(--grad-border);
  -webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;
  pointer-events:none;
}

.app{display:none;position:relative;z-index:1}
body.authed .app{display:block}
body.authed .login-shell{display:none}
.login-shell{position:relative;z-index:1;min-height:calc(100vh - 36px);display:grid;place-items:center;padding:18px}
.glass{
  background:var(--glass);
  border:1px solid var(--line);
  box-shadow:var(--shadow), inset 0 1px 0 var(--highlight);
  backdrop-filter:blur(var(--blur)) saturate(1.25);
  -webkit-backdrop-filter:blur(var(--blur)) saturate(1.25);
}
.login-box{
  width:min(420px,100%);
  padding:28px 24px 22px;
  border-radius:24px;
  display:grid;gap:12px;
  animation:rise .5s var(--ease) both;
}
.login-visual{
  width:52px;height:52px;border-radius:16px;
  background:
    linear-gradient(135deg, rgba(255,255,255,.45), transparent 42%),
    var(--grad-accent);
  box-shadow:0 14px 34px color-mix(in srgb, var(--accent) 28%, transparent), inset 0 1px 0 rgba(255,255,255,.45);
}
.login-box h1{margin:0;font-size:22px;letter-spacing:-.02em;color:var(--ink)}
.login-box p{margin:0;color:var(--muted);font-size:13px;line-height:1.55}
.login-box input{
  width:100%;height:46px;border-radius:14px;border:1px solid var(--line);
  background:var(--glass-strong);color:var(--ink);padding:0 14px;
  box-shadow:inset 0 1px 0 var(--highlight);
  transition:border-color .18s var(--ease), box-shadow .18s var(--ease);
}
.login-box input:focus{outline:none;border-color:color-mix(in srgb, var(--accent) 55%, transparent);box-shadow:0 0 0 4px var(--accent-soft), inset 0 1px 0 var(--highlight)}
.login-box .btn{width:100%;height:46px;border-radius:14px}
.login-error{color:var(--danger);font-size:12px;min-height:18px}

.app-shell{
  position:relative;z-index:1;
  display:grid;grid-template-columns:252px minmax(0,1fr);gap:16px;
  width:min(1380px,100%);margin:0 auto;align-items:start;
}
.sidebar{
  position:sticky;top:16px;display:flex;flex-direction:column;gap:14px;
  padding:16px;border-radius:24px;min-height:calc(100vh - 32px);
  animation:rise .45s var(--ease) both;
}
.side-brand{display:flex;gap:12px;align-items:center;padding:4px 2px 10px}
.side-logo{
  width:44px;height:44px;border-radius:15px;flex:0 0 auto;
  background:
    linear-gradient(135deg, rgba(255,255,255,.42), transparent 42%),
    var(--grad-accent);
  box-shadow:0 12px 28px color-mix(in srgb, var(--accent) 26%, transparent), inset 0 1px 0 rgba(255,255,255,.45);
}
.side-brand b{display:block;font-size:13px;letter-spacing:-.01em;color:var(--ink);font-weight:720}
.side-brand small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.side-nav{display:grid;gap:6px}
.side-link{
  display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;
  border:1px solid transparent;border-radius:14px;background:transparent;
  color:var(--muted);font-weight:720;text-align:left;
  transition:transform .18s var(--ease), background .18s var(--ease), color .18s var(--ease), box-shadow .18s var(--ease), border-color .18s var(--ease);
}
.side-link:hover{background:var(--glass-soft);color:var(--ink);transform:translateX(2px)}
.side-link.active{
  color:#fff;border-color:transparent;
  background:
    linear-gradient(135deg, rgba(255,255,255,.2), transparent 42%),
    var(--grad-accent);
  box-shadow:0 12px 28px color-mix(in srgb, var(--accent) 26%, transparent), inset 0 1px 0 rgba(255,255,255,.28);
}
body.theme-cyber .side-link.active{
  color:#0B0B0C;
  text-shadow:none;
  box-shadow:0 0 0 1px rgba(0,245,212,.25), 0 12px 28px rgba(0,245,212,.12), 0 0 24px rgba(255,0,122,.08);
}
.side-link .ico{width:18px;text-align:center;opacity:.95}
.side-meta{margin-top:auto;display:grid;gap:8px;padding-top:12px;border-top:1px solid var(--line)}
.side-stat{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted)}
.side-stat b{color:var(--ink);font-variant-numeric:tabular-nums}
.side-stat b.compact-value{max-width:148px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}

.main-panel{position:relative;z-index:2;display:grid;gap:14px;min-width:0}
.hero-bar{
  position:relative;z-index:1000;overflow:visible;
  display:flex;justify-content:space-between;align-items:center;gap:14px;
  padding:18px;border-radius:24px;
  animation:rise .5s var(--ease) both;
}
.hero-bar h1{margin:0;font-size:18px;letter-spacing:-.02em;color:var(--ink);font-weight:760}
.hero-bar p{margin:6px 0 0;color:var(--muted);font-size:12px}
.hero-actions,.toolbar-inline,.actions,.toolbar,.card-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

/* top-right style switcher */
.theme-switch{
  display:inline-flex;align-items:center;gap:4px;padding:4px;
  border-radius:14px;border:1px solid var(--line);
  background:var(--glass-soft);
  box-shadow:inset 0 1px 0 var(--highlight);
}
.theme-switch button{
  min-height:32px;border:0;border-radius:10px;padding:0 12px;
  background:transparent;color:var(--muted);font-size:12px;font-weight:760;
  transition:all .16s var(--ease);
}
.theme-switch button.active{
  color:#fff;
  background:var(--grad-accent);
  box-shadow:0 8px 18px color-mix(in srgb, var(--accent) 24%, transparent);
}
body.theme-cyber .theme-switch button.active{color:#0B0B0C}

.section-kicker{
  display:inline-flex;align-items:center;gap:6px;
  font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  margin-bottom:4px;opacity:.72;
  color:var(--muted);
  background:none;-webkit-background-clip:initial;background-clip:initial;
}
.btn{
  min-height:38px;border:1px solid var(--line);border-radius:12px;
  background:var(--glass-strong);color:var(--ink);padding:0 13px;
  font-weight:720;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  box-shadow:inset 0 1px 0 var(--highlight), 0 1px 2px rgba(15,23,42,.04);
  backdrop-filter:blur(14px);
  transition:transform .16s var(--ease), box-shadow .16s var(--ease), filter .16s var(--ease);
  white-space:nowrap;
}
.btn:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(15,23,42,.10), inset 0 1px 0 var(--highlight)}
.btn:active{transform:translateY(0)}
.btn.primary{
  color:#fff;border-color:transparent;
  background:var(--grad-accent);
  box-shadow:0 12px 26px color-mix(in srgb, var(--accent) 26%, transparent), inset 0 1px 0 rgba(255,255,255,.28);
}
body.theme-cyber .btn.primary{color:#0B0B0C}
.btn.danger{
  color:#fff;border-color:transparent;
  background:linear-gradient(135deg,#FB7185,#E11D48);
  box-shadow:0 12px 24px rgba(225,29,72,.22), inset 0 1px 0 rgba(255,255,255,.22);
}
body.theme-cyber .btn.danger{
  background:linear-gradient(135deg,#FF4D9D,#FF007A);
  box-shadow:0 0 0 1px rgba(255,0,122,.25), 0 12px 28px rgba(255,0,122,.18);
}
.btn.cyan{
  color:#fff;border-color:transparent;
  background:linear-gradient(135deg,#22D3EE,#0891B2);
  box-shadow:0 12px 24px rgba(8,145,178,.22), inset 0 1px 0 rgba(255,255,255,.22);
}
body.theme-cyber .btn.cyan{
  color:#0B0B0C;
  background:linear-gradient(135deg,#00F5D4,#22D3EE);
  box-shadow:0 0 0 1px rgba(0,245,212,.25), 0 12px 28px rgba(0,245,212,.14);
}
.btn.small{min-height:32px;padding:0 10px;font-size:12px;border-radius:10px}
.btn.icon{width:38px;padding:0}

.page,
.panel-stack.page{display:none !important}
.page.active,
.panel-stack.page.active{display:grid !important;gap:14px;animation:rise .35s var(--ease) both}
.panel,.stat-tile,.chart-card,.emby-card{
  background:var(--glass);
  border:1px solid var(--line);
  box-shadow:var(--shadow), inset 0 1px 0 var(--highlight);
  backdrop-filter:blur(var(--blur)) saturate(1.2);
  -webkit-backdrop-filter:blur(var(--blur)) saturate(1.2);
}
body.theme-cyber .panel,
body.theme-cyber .stat-tile,
body.theme-cyber .chart-card,
body.theme-cyber .emby-card{
  background:var(--glass);
  box-shadow:var(--shadow), inset 0 1px 0 rgba(255,255,255,.04), 0 0 0 1px rgba(0,245,212,.04);
}
.panel{border-radius:22px;overflow:hidden}
.panel-head{
  display:flex;justify-content:space-between;align-items:flex-start;gap:12px;
  padding:16px 16px 12px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg, var(--glass-soft), transparent);
}
.panel-head h2{margin:0;font-size:16px;letter-spacing:-.01em;color:var(--ink)}
.panel-head p,.hint{margin:4px 0 0;color:var(--muted);font-size:12px;line-height:1.55}
.panel-body{padding:16px}
.panel-body.tight{padding:12px 16px 16px}
.panel-stack{display:grid;gap:14px}
.form-section{display:grid;gap:10px;margin:0 0 14px;padding:0 0 14px;border-bottom:1px dashed var(--line)}
.form-section:last-child{margin:0;padding:0;border:0}
.form-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px}
.form-section-title b{font-size:13px;color:var(--ink)}
.form-section-title span{color:var(--muted);font-size:11px}
.form-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.node-form{grid-template-columns:repeat(12,minmax(0,1fr));gap:10px}
.field{display:grid;gap:6px}
.node-form .field{grid-column:span 3}
.node-form .field.w2{grid-column:span 2}
.node-form .field.w3{grid-column:span 3}
.node-form .field.w4{grid-column:span 4}
.node-form .field.w6{grid-column:span 6}
.node-form .field.full,.node-form .field.w12,.field.full{grid-column:1/-1}
.field label{color:var(--muted);font-size:11px;font-weight:760}
.field input,.field textarea,.field select,.search-input{
  width:100%;border:1px solid var(--line);border-radius:12px;
  background:var(--glass-strong);color:var(--ink);min-height:38px;padding:8px 12px;
  box-shadow:inset 0 1px 0 var(--highlight);
  transition:border-color .16s var(--ease), box-shadow .16s var(--ease);
}
.field input:focus,.field textarea:focus,.field select:focus,.search-input:focus{
  outline:none;border-color:color-mix(in srgb, var(--accent) 50%, transparent);
  box-shadow:0 0 0 4px var(--accent-soft), inset 0 1px 0 var(--highlight)
}
.field textarea{min-height:72px;resize:vertical}
.option-row{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.check{display:flex;align-items:center;gap:8px;min-height:36px;color:var(--ink);font-weight:640;font-size:13px}
.check input,.ip-checkbox{width:16px;height:16px;accent-color:var(--accent)}
.search-input{height:38px;min-width:220px}
.chip-row{display:flex;flex-wrap:wrap;gap:6px}
.chip{
  min-height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--line);
  background:var(--glass-soft);color:var(--muted);font-size:11px;font-weight:760;
  display:inline-flex;align-items:center;gap:6px;
  box-shadow:inset 0 1px 0 var(--highlight);
}
.chip.ok{color:var(--ok);background:color-mix(in srgb, var(--ok) 12%, transparent);border-color:color-mix(in srgb, var(--ok) 28%, transparent)}
.chip.warn{color:var(--warn);background:color-mix(in srgb, var(--warn) 12%, transparent);border-color:color-mix(in srgb, var(--warn) 28%, transparent)}
.chip.primary{color:var(--accent-ink);background:var(--accent-soft);border-color:color-mix(in srgb, var(--accent) 28%, transparent)}
body.theme-cyber .chip.primary{color:var(--accent);box-shadow:0 0 12px rgba(0,245,212,.08)}
.badge{
  min-height:24px;border-radius:999px;font-size:11px;font-weight:760;display:inline-flex;align-items:center;
  padding:0 9px;border:1px solid var(--line);background:var(--glass-soft);color:var(--muted)
}
.badge.ok{color:var(--ok);border-color:color-mix(in srgb, var(--ok) 30%, transparent);background:color-mix(in srgb, var(--ok) 12%, transparent)}
.badge.warn{color:var(--warn);border-color:color-mix(in srgb, var(--warn) 30%, transparent);background:color-mix(in srgb, var(--warn) 12%, transparent)}

.node-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;align-items:start}
.emby-card{
  position:relative;overflow:hidden;padding:0;border-radius:18px;min-width:0;perspective:1200px;
  transition:transform .2s var(--ease), box-shadow .2s var(--ease);
}
.card-flip-shell{
  display:grid;min-width:0;transform-style:preserve-3d;will-change:transform;
  transition:transform .38s cubic-bezier(.22,.74,.22,1)
}
.emby-card.is-flipped .card-flip-shell{transform:rotateY(180deg)}
.card-face{
  grid-area:1/1;min-width:0;display:flex;flex-direction:column;
  backface-visibility:hidden;-webkit-backface-visibility:hidden
}
.card-front{pointer-events:auto}
.card-back{transform:rotateY(180deg);pointer-events:none}
.emby-card.is-flipped .card-front{pointer-events:none}
.emby-card.is-flipped .card-back{pointer-events:auto}
.emby-card:before{
  content:"";position:absolute;inset:0 auto 0 0;width:3px;
  background:var(--grad-accent);
}
.emby-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg), inset 0 1px 0 var(--highlight)}
.emby-card.is-pressed{transform:translateY(-1px) scale(.992)}
body.theme-cyber .emby-card:hover{
  box-shadow:0 0 0 1px rgba(0,245,212,.16), 0 18px 40px rgba(0,0,0,.45), 0 0 30px rgba(255,0,122,.06);
}
.emby-card .card-top{
  display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:14px 14px 12px;border-bottom:1px solid var(--line);
  background:color-mix(in srgb, var(--accent) 5%, transparent);
}
.card-top-actions{display:flex;align-items:center;gap:7px;flex:0 0 auto}
.card-flip-btn{
  width:30px;height:30px;min-height:30px;padding:0;border:1px solid var(--line);border-radius:10px;
  display:inline-grid;place-items:center;background:var(--glass-soft);color:var(--muted);
  font-size:16px;line-height:1;cursor:pointer;transition:transform .16s var(--ease),color .16s var(--ease),background .16s var(--ease)
}
.card-flip-btn:hover{color:var(--ink);background:var(--accent-soft);transform:rotate(20deg)}
.card-title-group{display:flex;align-items:center;gap:10px;min-width:0}
.emby-icon{
  width:42px;height:42px;border-radius:14px;border:1px solid var(--line);
  background:var(--glass-strong);display:grid;place-items:center;overflow:hidden;flex:0 0 auto;
  box-shadow:inset 0 1px 0 var(--highlight);
}
.emby-icon img{width:100%;height:100%;object-fit:cover}
.emby-icon span{font-size:18px}
.card-title{min-width:0}
.card-title b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
.card-title small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.emby-card .card-body{display:grid;gap:12px;padding:12px 14px 14px}
.route-summary{
  display:grid;grid-template-columns:minmax(0,1.35fr) minmax(150px,.65fr);gap:10px;
  padding:12px;border:1px solid var(--line);border-radius:14px;background:var(--glass-soft)
}
.route-current{display:grid;align-content:center;gap:5px;min-width:0}
.route-eyebrow{color:var(--muted);font-size:10px;font-weight:760}
.route-value{display:flex;align-items:center;gap:8px;min-height:28px}
.route-value i{width:9px;height:9px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 4px color-mix(in srgb,var(--muted) 15%,transparent)}
.route-value b{font-size:20px;line-height:1.15;letter-spacing:0;color:var(--ink)}
.route-current.direct .route-value i{background:#10B981;box-shadow:0 0 0 4px rgba(16,185,129,.14)}
.route-current.proxy .route-value i{background:#0EA5E9;box-shadow:0 0 0 4px rgba(14,165,233,.14)}
.route-current small{color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.route-facts{display:grid;grid-template-columns:1fr;gap:7px;border-left:1px solid var(--line);padding-left:10px}
.route-fact{display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:11px}
.route-fact span{color:var(--muted)}
.route-fact b{color:var(--ink);font-size:11px;text-align:right}
.route-latency{font-variant-numeric:tabular-nums}
.route-latency.good{color:var(--ok)}
.route-latency.mid{color:var(--warn)}
.route-latency.bad{color:var(--danger)}
.route-latency.pending{color:var(--muted)}
.card-meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.card-meta-item{min-width:0;padding:9px 10px;border-top:1px solid var(--line)}
.card-meta-item span{display:block;color:var(--muted);font-size:10px;font-weight:720}
.card-meta-item b{display:block;margin-top:4px;color:var(--ink);font-size:12px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-meta-item small{display:block;margin-top:2px;color:var(--muted);font-size:10px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card-back .card-body{gap:14px}
.card-back-heading{display:grid;gap:3px}
.card-back-heading b{font-size:13px;color:var(--ink)}
.card-back-heading small{font-size:10px;color:var(--muted)}
.card-back-section{display:grid;gap:9px;padding:10px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.card-back-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
.card-back-actions .btn{width:100%;min-width:0}
.card-back-footer{display:grid;grid-template-columns:1fr;gap:7px;margin-top:auto;padding:11px 14px;border-top:1px solid var(--line);background:var(--glass-soft)}
.emby-card .card-footer{
  display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;
  margin-top:auto;padding:11px 14px;border-top:1px solid var(--line);background:var(--glass-soft)
}
.emby-card .card-footer .btn{width:100%;min-width:0;padding:0 7px}
.info-row{display:grid;grid-template-columns:78px 1fr;gap:8px;align-items:start;font-size:12px}
.info-label{color:var(--muted);font-weight:760}
.info-value{min-width:0;text-align:left;word-break:break-all;color:var(--ink)}
.masked{letter-spacing:1px;color:var(--muted)}
.split-2{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:14px}
.network-source-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:0}
.network-source-block{display:grid;align-content:start;gap:10px;min-width:0;padding-right:16px}
.network-source-block+.network-source-block{padding:0 0 0 16px;border-left:1px solid var(--line)}
.network-block-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.network-block-head b{font-size:13px;color:var(--ink)}
.network-block-head span{font-size:11px;color:var(--muted)}
.network-workspace{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(320px,.75fr);gap:14px;align-items:start}
.network-results,.network-dns{min-width:0}
.network-dns{position:sticky;top:14px}
.network-dns .panel-head{display:grid}
.network-dns .dns-status{margin-top:8px}
.dns-details{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}
.dns-details summary{cursor:pointer;color:var(--muted);font-size:12px;font-weight:720;list-style-position:inside}
.dns-details[open] summary{margin-bottom:10px;color:var(--ink)}
.dns-details .output{min-height:120px;max-height:280px}
.table-wrapper{
  width:100%;border:1px solid var(--line);border-radius:16px;overflow:auto;
  background:var(--glass-soft);box-shadow:inset 0 1px 0 var(--highlight)
}
.log-client{display:grid;gap:3px;min-width:150px;max-width:260px}
.log-client b{font-size:12px;color:var(--ink);letter-spacing:0}
.log-client small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:10px;font-family:var(--mono)}
table{width:100%;border-collapse:collapse;min-width:720px}
th,td{padding:12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle;color:var(--ink)}
th{
  color:var(--muted);font-weight:780;font-size:11px;letter-spacing:.03em;
  background:color-mix(in srgb, var(--accent) 7%, transparent)
}
tr:last-child td{border-bottom:0}
tr{transition:background .15s var(--ease)}
tr:hover td{background:color-mix(in srgb, var(--accent) 5%, transparent)}
.output{
  min-height:180px;max-height:420px;overflow:auto;margin:0;
  background:var(--glass-soft);color:var(--ink);border:1px solid var(--line);
  border-radius:16px;padding:12px;font-size:11px;white-space:pre-wrap;word-break:break-word;
  font-family:var(--mono);box-shadow:inset 0 1px 0 var(--highlight)
}
.empty{padding:34px 18px;text-align:center;color:var(--muted);grid-column:1/-1}
.stat-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.stat-tile{
  position:relative;overflow:hidden;padding:14px;border-radius:18px;
  transition:transform .18s var(--ease), box-shadow .18s var(--ease);
}
.stat-tile:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg), inset 0 1px 0 var(--highlight)}
.stat-tile:before{
  content:"";position:absolute;right:-18px;top:-18px;width:86px;height:86px;border-radius:50%;
  background:radial-gradient(circle, color-mix(in srgb, var(--accent) 18%, transparent), transparent 70%);
}
.stat-tile span{display:block;color:var(--muted);font-size:11px;font-weight:780}
.stat-tile b{display:block;margin-top:8px;font-size:22px;letter-spacing:-.03em;color:var(--ink)}
.stat-tile em{display:block;margin-top:4px;font-style:normal;color:var(--muted);font-size:11px}
.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:12px}
.chart-card{border-radius:18px;padding:14px;min-height:170px}
.chart-card h3{margin:0 0 10px;font-size:14px;color:var(--ink)}
.bar-row{display:grid;grid-template-columns:minmax(70px,130px) 1fr auto;gap:8px;align-items:center;margin:8px 0}
.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.bar-track{height:8px;border-radius:999px;background:color-mix(in srgb, var(--muted) 18%, transparent);overflow:hidden}
.bar-fill{
  height:100%;border-radius:999px;background:var(--grad-accent);
  box-shadow:0 0 12px color-mix(in srgb, var(--accent) 35%, transparent);
  transition:width .45s var(--ease);
}
.bar-value{font-family:var(--mono);color:var(--ink);font-size:11px}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}
.dialog-backdrop{
  position:fixed;inset:0;z-index:9998;display:none;align-items:center;justify-content:center;padding:18px;
  background:rgba(15,23,42,.28);backdrop-filter:blur(14px) saturate(1.15)
}
body.theme-cyber .dialog-backdrop{background:rgba(0,0,0,.55)}
.dialog-backdrop.show{display:flex}
.dialog-card{
  width:min(420px,100%);border-radius:22px;padding:18px;
  background:var(--glass-strong);border:1px solid var(--line);
  box-shadow:var(--shadow-lg), inset 0 1px 0 var(--highlight);
  backdrop-filter:blur(24px) saturate(1.25);
  animation:rise .22s var(--ease) both;
}
.dialog-title{font-size:16px;font-weight:800;margin:0 0 6px;color:var(--ink)}
.dialog-message{color:var(--muted);font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.dialog-input{
  width:100%;min-height:160px;margin-top:12px;border:1px solid var(--line);border-radius:14px;
  background:var(--glass);color:var(--ink);padding:10px;resize:vertical
}
.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.dialog-actions .btn{min-width:78px}
.dialog-actions[hidden]{display:none !important}
.toast{
  position:fixed;left:50%;bottom:22px;z-index:10000;max-width:min(520px,calc(100vw - 28px));
  padding:10px 14px;border-radius:12px;border:1px solid var(--line);
  background:var(--glass-strong);color:var(--ink);box-shadow:var(--shadow-lg);
  backdrop-filter:blur(18px);font-size:13px;line-height:1.45;white-space:pre-wrap;
  opacity:0;transform:translate(-50%,12px);pointer-events:none;
  transition:opacity .18s var(--ease),transform .18s var(--ease)
}
.toast.show{opacity:1;transform:translate(-50%,0)}
.notice{display:none}
.page-tabs{display:none !important}
.mobile-nav{
  display:none;position:relative;z-index:200;
  gap:6px;padding:7px;border-radius:18px;width:100%;overflow:auto;
  background:var(--glass-strong);border:1px solid var(--line);
  box-shadow:var(--shadow-lg), inset 0 1px 0 var(--highlight);
  backdrop-filter:blur(22px) saturate(1.25);
}
.mobile-nav .side-link{min-height:36px;padding:0 12px;font-size:12px;flex:0 0 auto}
.mobile-edge-bar{display:none}
.mobile-edge-item{min-width:0;display:grid;gap:2px}
.mobile-edge-item span{color:var(--muted);font-size:10px}
.mobile-edge-item b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-size:11px}
.dns-status{display:flex;gap:6px;flex-wrap:wrap}
.x{
  width:36px;height:36px;border:1px solid var(--line);border-radius:12px;
  background:var(--glass-strong);color:var(--muted);font-size:18px
}
.status-pill{
  display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:0 10px;
  border-radius:999px;border:1px solid var(--line);background:var(--glass-soft);
  color:var(--muted);font-size:12px;font-weight:720
}
.status-pill .dot,.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb, var(--ok) 18%, transparent)}
@keyframes rise{
  from{opacity:0;transform:translateY(10px) scale(.992)}
  to{opacity:1;transform:none}
}
@media (prefers-reduced-motion: reduce){
  *{animation:none !important;transition:none !important}
  .card-flip-shell{transform:none !important}
  .card-face{backface-visibility:visible;-webkit-backface-visibility:visible}
  .card-back{display:none;transform:none}
  .emby-card.is-flipped .card-front{display:none}
  .emby-card.is-flipped .card-back{display:flex}
}
@media(max-width:980px){
  body{padding:12px}
  .app-shell{grid-template-columns:1fr}
  .sidebar{display:none}
  .main-panel{padding-top:42px}
  .mobile-edge-bar{
    display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) auto;gap:10px;
    padding:9px 10px;border:1px solid var(--line);border-radius:12px;
    background:var(--glass-strong);box-shadow:var(--shadow);backdrop-filter:blur(18px)
  }
  .side-nav{display:none}
  .mobile-nav{display:flex}
  .mobile-nav .side-link{flex:1 1 0;justify-content:center;padding:0 8px}
  .stat-strip,.metrics,.chart-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .split-2{grid-template-columns:1fr}
  .network-workspace{grid-template-columns:1fr}
  .network-dns{position:static}
  .form-grid{grid-template-columns:1fr 1fr}
  .node-form{grid-template-columns:repeat(2,minmax(0,1fr))}
  .node-form .field,.node-form .field.w2,.node-form .field.w3,.node-form .field.w4,.node-form .field.w6{grid-column:span 1}
  .option-row{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:560px){
  .hero-bar{flex-direction:column;align-items:flex-start}
  .panel-head{flex-direction:column;align-items:stretch}
  .form-section-title{align-items:flex-start;flex-direction:column;gap:3px}
  .panel-head>.toolbar-inline{width:100%}
  .hero-actions,.toolbar-inline{width:100%}
  .hero-actions .btn,.toolbar-inline .btn{flex:1}
  .theme-switch{width:100%;justify-content:space-between}
  .theme-switch button{flex:1}
  .stat-strip,.metrics{grid-template-columns:1fr 1fr}
  .chart-grid{grid-template-columns:1fr}
  .node-grid{grid-template-columns:1fr}
  .emby-card:hover{transform:none}
  .route-summary{grid-template-columns:minmax(0,1.2fr) minmax(118px,.8fr);padding:10px}
  .route-value b{font-size:18px}
  .route-facts{padding-left:9px}
  .card-meta-item{padding:8px 6px}
  .emby-card .card-footer{grid-template-columns:repeat(2,minmax(0,1fr))}
  .form-grid,.node-form,.option-row{grid-template-columns:1fr}
  .network-source-grid{grid-template-columns:1fr}
  .network-source-block{padding:0 0 14px}
  .network-source-block+.network-source-block{padding:14px 0 0;border-left:0;border-top:1px solid var(--line)}
  .network-block-head{align-items:flex-start;flex-direction:column;gap:2px}
  .node-form .field,.node-form .field.w2,.node-form .field.w3,.node-form .field.w4,.node-form .field.w6,.node-form .field.full,.node-form .field.w12{grid-column:1/-1}
  .ip-table table,.ip-table thead,.ip-table tbody,.ip-table tr,.ip-table td{display:block;width:100%;min-width:0}
  .ip-table thead{display:none}
  .ip-table tr{
    position:relative;margin:10px 0;padding:12px;border:1px solid var(--line);border-radius:14px;
    background:var(--glass);box-shadow:var(--shadow)
  }
  .ip-table td{border:0;padding:4px 0}
  .ip-table td:first-child{position:absolute;right:12px;top:12px;width:auto}
  .ip-table .ip-text{display:block;max-width:calc(100% - 42px);font-size:13px;word-break:break-all}
  .ip-table td:last-child{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
  .ip-table td:last-child .btn{flex:1}
  .ip-table tr.ip-empty-row{margin:0;padding:22px 12px;border:0;background:transparent;box-shadow:none}
  .ip-table tr.ip-empty-row td{position:static;display:block;width:100%;max-width:none;padding:0;text-align:center}
  .visitor-table{border:0;background:transparent;overflow:visible}
  .visitor-table table,.visitor-table tbody,.visitor-table tr,.visitor-table td{display:block;width:100%;min-width:0}
  .visitor-table thead{display:none}
  .visitor-table tbody{display:grid;gap:10px}
  .visitor-table tr{padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:var(--glass-soft);box-shadow:inset 0 1px 0 var(--highlight)}
  .visitor-table td{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px;border:0;padding:5px 0;align-items:start;word-break:break-word}
  .visitor-table td::before{content:attr(data-label);color:var(--muted);font-size:10px;font-weight:760}
  .visitor-table .log-client{min-width:0;max-width:none}
  .visitor-table .log-client small{overflow:visible;text-overflow:clip;white-space:normal;word-break:break-all;line-height:1.45}
  .visitor-table .visitor-empty{display:block;text-align:center;padding:18px 0;color:var(--text-sec)}
  .visitor-table .visitor-empty::before{display:none}
}

/* compact top actions */
.hero-actions{gap:6px}
.icon-menu{position:relative;z-index:1}
.icon-menu[open]{z-index:1100}
.icon-menu summary{
  list-style:none;min-height:34px;min-width:34px;border:1px solid var(--line);border-radius:11px;
  background:var(--glass-strong);color:var(--ink);display:inline-flex;align-items:center;justify-content:center;
  padding:0 10px;font-weight:760;cursor:pointer;box-shadow:inset 0 1px 0 var(--highlight)
}
.icon-menu summary::-webkit-details-marker{display:none}
.icon-menu[open] summary{border-color:color-mix(in srgb, var(--accent) 40%, var(--line))}
.icon-menu .menu-pop{
  position:absolute;right:0;top:calc(100% + 6px);z-index:1101;min-width:168px;
  padding:6px;border-radius:14px;border:1px solid var(--line);background:var(--glass-strong);
  box-shadow:var(--shadow-lg), inset 0 1px 0 var(--highlight);
  backdrop-filter:blur(18px);display:grid;gap:4px;pointer-events:auto
}
.icon-menu .menu-pop button,.icon-menu .menu-pop .menu-item{
  width:100%;min-height:34px;border:0;border-radius:10px;background:transparent;color:var(--ink);
  text-align:left;padding:0 10px;font-weight:680;cursor:pointer
}
.icon-menu .menu-pop button:hover,.icon-menu .menu-pop .menu-item:hover{background:var(--accent-soft)}
.theme-switch.compact{padding:2px;gap:2px}
.theme-switch.compact button{min-height:28px;padding:0 8px;font-size:11px}
.theme-icon-btn{
  width:34px;height:34px;min-height:34px;padding:0;border-radius:11px;
  border:1px solid var(--line);background:var(--glass-strong);color:var(--ink);
  display:inline-flex;align-items:center;justify-content:center;
  box-shadow:inset 0 1px 0 var(--highlight);font-size:15px;line-height:1;
}
.theme-icon-btn:hover{transform:translateY(-1px)}
.menu-pop .theme-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;color:var(--muted);font-size:12px}
.login-theme-float{position:fixed;top:12px;right:12px;z-index:5}
#nodeEditorPanel[hidden],#deployBody[hidden]{display:none !important}
.pie-wrap{display:grid;grid-template-columns:140px 1fr;gap:12px;align-items:center;min-height:150px}
.pie-svg{width:140px;height:140px;filter:drop-shadow(0 8px 16px rgba(0,0,0,.12))}
.pie-legend{display:grid;gap:8px}
.pie-legend-row{display:grid;grid-template-columns:12px 1fr auto;gap:8px;align-items:center;font-size:12px}
.pie-dot{width:10px;height:10px;border-radius:50%}
.pie-name{color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pie-val{color:var(--muted);font-family:var(--mono);font-size:11px}
.chart-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
@media(max-width:900px){.pie-wrap{grid-template-columns:120px 1fr}.pie-svg{width:120px;height:120px}}
@media(max-width:560px){.chart-grid{grid-template-columns:1fr}.pie-wrap{grid-template-columns:1fr;justify-items:center}.pie-legend{width:100%}}
@media(max-width:980px){
  .hero-bar{
    position:fixed;top:10px;right:10px;z-index:1200;width:auto;padding:0;
    display:block;border:0;background:transparent;box-shadow:none;
    backdrop-filter:none;-webkit-backdrop-filter:none;animation:none
  }
  .hero-bar>div:first-child{display:none}
  .hero-bar .hero-actions{width:auto;display:block}
}
</style>
</head>
<body class="theme-cyber">
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<div id="dialogBackdrop" class="dialog-backdrop" role="dialog" aria-modal="true">
  <div class="dialog-card">
    <div id="dialogTitle" class="dialog-title">提示</div>
    <div id="dialogMessage" class="dialog-message"></div>
    <div class="dialog-actions">
      <button class="btn" id="dialogCancel" type="button">取消</button>
      <button class="btn primary" id="dialogOk" type="button">确定</button>
    </div>
  </div>
</div>

<div id="loginShell" class="login-shell">
  <button type="button" class="theme-icon-btn login-theme-float" id="loginThemeBtn" title="切换风格" aria-label="切换风格">◐</button>
  <div class="login-box glass" id="loginModal">
    <div class="login-visual"></div>
    <h1>媒体线路控制台</h1>
    <p>管理节点、真实模拟观看、测速与 DNS。输入访问密码进入。</p>
    <input id="loginToken" type="password" placeholder="访问密码" autocomplete="current-password" autofocus>
    <button class="btn primary" id="loginBtn" type="button">进入控制台</button>
    <div id="loginError" class="login-error"></div>
  </div>
</div>

<div id="app" class="app">
  <div class="app-shell">
    <aside class="sidebar glass">
      <div class="side-brand">
        <div class="side-logo"></div>
        <div>
          <b>线路控制台</b>
          <small>v${BUILD_VERSION}</small>
        </div>
      </div>
      <nav class="side-nav">
        <button class="side-link active" data-page-tab="nodes" type="button"><span class="ico">▣</span>线路配置</button>
        <button class="side-link" data-page-tab="network" type="button"><span class="ico">⌁</span>测速与 DNS</button>
        <button class="side-link" data-page-tab="dashboard" type="button"><span class="ico">◈</span>性能与数据</button>
        <button class="side-link" data-page-tab="deploy" type="button"><span class="ico">⬆</span>代码更新</button>
      </nav>
      <div class="side-meta">
        <div class="side-stat"><span>节点</span><b id="metricNodes">0</b></div>
        <div class="side-stat"><span>启用</span><b id="metricEnabled">0</b></div>
        <div class="side-stat"><span>今日请求</span><b id="metricRequests">0</b></div>
        <div class="side-stat"><span>今日流量</span><b id="metricBytes">0 B</b></div>
        <div class="side-stat"><span>访客入口</span><b id="traceEntry" class="compact-value mono">--</b></div>
        <div class="side-stat"><span>Worker 出口</span><b id="traceEgress" class="compact-value mono">--</b></div>
        <div class="side-stat"><span><i id="rttDot" class="dot" style="display:inline-block;vertical-align:middle;margin-right:5px"></i>RTT</span><b id="rttValue" class="mono">--</b></div>
      </div>
    </aside>

    <div class="main-panel">
      <div class="mobile-edge-bar" aria-label="边缘状态">
        <div class="mobile-edge-item"><span>接入点</span><b id="mobileTraceEntry" class="mono">--</b></div>
        <div class="mobile-edge-item"><span>出口</span><b id="mobileTraceEgress" class="mono">--</b></div>
        <div class="mobile-edge-item"><span><i id="mobileRttDot" class="dot" style="display:inline-block;vertical-align:middle;margin-right:4px"></i>RTT</span><b id="mobileRttValue" class="mono">--</b></div>
      </div>
      <nav class="mobile-nav">
        <button class="side-link active" data-page-tab="nodes" type="button">线路</button>
        <button class="side-link" data-page-tab="network" type="button">网络</button>
        <button class="side-link" data-page-tab="dashboard" type="button">性能</button>
        <button class="side-link" data-page-tab="deploy" type="button">更新</button>
      </nav>
      <header class="hero-bar glass">
        <div>
          <div class="section-kicker">控制台</div>
          <h1 id="pageTitle">线路配置</h1>
        </div>
        <div class="hero-actions">
          <details class="icon-menu" id="moreMenu">
            <summary title="更多">···</summary>
            <div class="menu-pop">
              <div class="menu-row theme-row">
                <span>风格</span>
                <button type="button" class="theme-icon-btn" id="themeToggleBtn" title="切换风格" aria-label="切换风格">◐</button>
              </div>
              <button type="button" id="exportBtn">导出节点</button>
              <button type="button" id="importBtn">导入节点</button>
              <button type="button" id="newNodeBtn">新建节点</button>
              <button type="button" id="logoutBtn" style="color:var(--danger)">退出登录</button>
            </div>
          </details>
        </div>
      </header>
      <div id="notice" class="notice"></div>

      <!-- NODES -->
      <section class="panel-stack page active" data-page="nodes">
        <section class="panel" id="nodeEditorPanel" hidden>
          <div class="panel-head">
            <div>
              <div class="section-kicker">编辑</div>
              <h2 id="formTitle">部署 / 编辑媒体线路</h2>
              <p>接入地址由节点名 + 密钥组成；真实模拟观看需要 Emby 账号。</p>
            </div>
            <div class="toolbar-inline">
              <button class="btn" id="cancelEditBtn" type="button">取消</button>
              <button class="btn" id="resetBtn" type="button">清空</button>
              <button class="btn primary" id="saveNodeBtn" type="button">保存</button>
            </div>
          </div>
          <div class="panel-body">
            <input type="hidden" id="editingName">
            <div class="form-section">
              <div class="form-section-title"><b>基础信息</b><span>名称 / 接入</span></div>
              <div class="form-grid node-form">
                <div class="field w4"><label>节点名</label><input id="name" placeholder="vip-1"></div>
                <div class="field w4"><label>显示名</label><input id="displayName" placeholder="VIP Emby"></div>
                <div class="field w2"><label>图标</label><input id="icon" placeholder="留空默认"></div>
                <div class="field w2"><label>密钥</label><input id="secret" placeholder="可空"></div>
                <div class="field w6"><label>标签</label><input id="tag" placeholder="客户、区域或线路"></div>
                <div class="field w6"><label>备注</label><input id="remark" placeholder="内部备注"></div>
              </div>
            </div>
            <div class="form-section" id="streamConfigSection">
              <div class="form-section-title"><b>上游线路</b><span>媒体服务器地址</span></div>
              <div class="form-grid node-form">
                <div class="field full w12"><label>服务器线路</label><textarea id="targets" placeholder="https://media.example.com&#10;https://backup.example.com"></textarea></div>
                <div class="field w12"><label>独立视频线路（每行一条）</label><textarea id="streamTarget" placeholder="https://stream-a.example.com&#10;https://stream-b.example.com&#10;留空使用服务器线路"></textarea></div>
                <div class="field w4"><label>中转视频选线</label><select id="streamStrategy"><option value="auto">响应与健康择优</option><option value="priority">严格配置顺序，故障后切换</option></select></div>
                <div class="field w4"><label>视频首包超时（毫秒）</label><input id="streamTimeoutMs" type="number" min="500" max="10000" step="100" value="2500"></div>
                <div class="field w4"><label>线路诊断</label><button class="btn" id="testEditedStreamBtn" type="button">测试所有视频线路</button></div>
              </div>
            </div>
            <div class="form-section">
              <div class="form-section-title"><b>代理策略</b><span>客户端与播放模式</span></div>
              <div class="form-grid node-form">
                <div class="field w4"><label>模拟客户端</label><select id="clientProfile">${clientProfileOptionsHTML()}</select></div>
                <div class="field w4"><label>Header</label><select id="headerMode"><option value="off">保守 off</option><option value="realip_only">严格 realip_only</option><option value="dual">兼容 dual</option><option value="strict">强力 strict</option></select></div>
                <div class="field w4"><label>播放方式</label><select id="streamMode"><option value="proxy">中转播放（默认）</option><option value="direct">媒体流直连</option><option value="auto">媒体流条件直连</option></select></div>
                <div class="option-row">
                  <label class="check"><input id="impersonate" type="checkbox" checked>启用模拟客户端</label>
                  <label class="check"><input id="directExternal" type="checkbox">条件直连时允许外部直链</label>
                  <label class="check"><input id="cacheImage" type="checkbox" checked>海报及图片缓存</label>
                  <label class="check"><input id="enabled" type="checkbox" checked>启用节点</label>
                </div>
                <div class="hint" style="grid-column:1/-1">不读取视频正文测速。条件直连只判断请求与鉴权能否安全直链；多条中转线路按响应耗时和近期失败状态选择。</div>
              </div>
            </div>
            <div class="form-section" id="watchStrategySection">
              <div class="form-section-title"><b>观看保活</b><span>周期提醒 + 真实模拟账号</span></div>
              <div class="form-grid node-form">
                <div class="option-row" style="grid-column:1/-1">
                  <label class="check"><input id="autoWatch" type="checkbox">到期自动模拟观看</label>
                </div>
                <div class="field w3" style="grid-column:span 3"><label>周期（天）</label><input id="renewDays" type="number" min="0" step="1" placeholder="21"></div>
                <div class="field w3" style="grid-column:span 3"><label>提前提醒（天）</label><input id="remindBeforeDays" type="number" min="0" step="1" placeholder="3"></div>
                <div class="field w3" style="grid-column:span 3"><label>起算日期</label><input id="keepaliveAt" placeholder="2026-07-07"></div>
                <div class="field w3" style="grid-column:span 3"><label>指定条目 ID</label><input id="embyPlayId" placeholder="可空，自动选片"></div>
                <div class="field w3"><label>内容类型</label><select id="watchContentType"><option value="mixed">电影和剧集</option><option value="movie">仅电影</option><option value="episode">仅剧集</option></select></div>
                <div class="field w3"><label>随机窗口开始（时）</label><input id="watchWindowStart" type="number" min="0" max="23" step="1" value="0"></div>
                <div class="field w3"><label>随机窗口结束（时）</label><input id="watchWindowEnd" type="number" min="1" max="24" step="1" value="24"></div>
                <div class="field w3"><label>每日成功上限</label><input id="watchDailyLimit" type="number" min="1" max="20" step="1" value="1"></div>
                <div class="field w4"><label>失败退避（分钟）</label><input id="watchFailureBackoffMin" type="number" min="10" max="1440" step="10" value="360"></div>
                <div class="field w4"><label>最短观看（秒）</label><input id="watchDurationMinSec" type="number" min="60" max="3600" step="30" value="300"></div>
                <div class="field w4"><label>最长观看（秒）</label><input id="watchDurationMaxSec" type="number" min="60" max="3600" step="30" value="390"></div>
                <div class="field w6"><label>Emby 用户名</label><input id="embyUser" placeholder="真实模拟观看账号"></div>
                <div class="field w6"><label>Emby 密码</label><input id="embyPassword" type="password" placeholder="保存后用于登录上游"></div>
              </div>
              <div class="hint" style="margin-top:8px">自动任务在北京时间窗口内为每个节点生成稳定随机时刻，并受每日上限、全局并发和失败退避限制；手动“已观看”不受这些策略限制。</div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="section-kicker">节点</div>
              <h2>已配置线路</h2>
              <p>复制接入、测速、真实模拟观看、排序。</p>
            </div>
            <div class="toolbar-inline">
              <button class="btn primary" id="newNodeBtn2" type="button">新建</button>
              <button class="btn cyan" id="pingAllBtn" type="button">全局测速</button>
              <button class="btn" id="purgeBtn" type="button">清海报缓存</button>
              <input id="search" class="search-input" placeholder="搜索节点">
              <button class="btn" id="reloadNodesBtn" type="button">刷新</button>
            </div>
          </div>
          <div class="panel-body tight">
            <div id="nodeGrid" class="node-grid"></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="section-kicker">观看记录</div>
              <h2>最近 3 天模拟观看</h2>
              <p>站点 · 内容 · 时长 · 自动/手动</p>
            </div>
            <div class="toolbar-inline">
              <button class="btn" id="reloadWatchLogsBtn">刷新记录</button>
            </div>
          </div>
          <div class="panel-body tight">
            <div class="table-wrapper">
              <table>
                <thead><tr><th>站点</th><th>内容</th><th>节点</th><th>观看时间</th><th>时长</th><th>来源</th></tr></thead>
                <tbody id="watchLogRows"><tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无模拟观看记录</td></tr></tbody>
              </table>
            </div>
          </div>
        </section>
      </section>

      <!-- NETWORK -->
      <section class="panel-stack page" data-page="network">
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="section-kicker">网络</div>
              <h2>专属线路测速与动态 DNS</h2>
              <p>拉取优选 IP、测速，并更新调度域名解析。</p>
            </div>
            <div class="toolbar-inline">
              <select id="ipType" class="search-input" style="min-width:150px"><option value="all">综合混合源</option><option value="电信">电信专属</option><option value="联通">联通专属</option><option value="移动">移动专属</option><option value="多线">多线 BGP</option><option value="ipv6">IPv6 节点</option><option value="优选">顶尖优选库</option></select>
              <button class="btn cyan" id="preferredBtn">提取预设源并测速</button>
              <button class="btn" id="copyItdogBtn">复制去 ITDog</button>
              <button class="btn" id="clearIPsBtn">清空列表</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="network-source-grid">
              <div class="network-source-block">
                <div class="network-block-head"><b>远程数据源</b><span>JSON 或纯文本节点列表</span></div>
                <div class="toolbar-inline">
                  <input id="customApiUrl" class="search-input" style="flex:1" value="https://ip.v2too.top/api/nodes" placeholder="自定义 JSON 或文本 API 链接">
                  <button class="btn cyan" id="fetchCustomApiBtn">拉取 API 并测速</button>
                </div>
              </div>
              <div class="network-source-block">
                <div class="network-block-head"><b>手动输入</b><span>自动识别 IP、IPv6 与域名</span></div>
                <div class="field full"><label>自定义 IP、IPv6 或 CNAME</label><textarea id="customIps" placeholder="每行一个，也支持粘贴混杂文本自动提取"></textarea></div>
                <div class="toolbar-inline">
                  <button class="btn" id="testCustomBtn">测试粘贴的节点</button>
                  <button class="btn" id="directCnameBtn">直推 CNAME</button>
                </div>
              </div>
            </div>
            <div id="statusText" class="hint" style="margin-top:12px">优选 IP 是 Cloudflare 边缘入口候选。实际体验还会受运营商、TLS、Worker 调度影响。</div>
          </div>
        </section>

        <div class="network-workspace">
          <section class="panel network-results">
            <div class="panel-head">
              <div>
                <div class="section-kicker">测速结果</div>
                <h2>候选节点</h2>
                <p>按延迟排序，勾选后可直接写入 DNS。</p>
              </div>
              <div class="toolbar-inline">
                <button class="btn" id="topDnsBtn">TOP3 写入 DNS</button>
                <button class="btn primary" id="selectedDnsBtn">选中写入 DNS</button>
              </div>
            </div>
            <div class="panel-body tight">
                <div class="table-wrapper ip-table" style="margin-top:14px">
                  <table>
                    <thead><tr><th style="width:44px"><input type="checkbox" id="selectAll" class="ip-checkbox"></th><th>专属节点</th><th>预估延迟</th><th>连通状态</th><th>记录/归属地</th><th>单节点操作</th></tr></thead>
                    <tbody id="ipRows"><tr class="ip-empty-row"><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无数据，请拉取节点或输入自定义 IP/域名测试</td></tr></tbody>
                  </table>
                </div>
            </div>
          </section>

          <section class="panel network-dns">
            <div class="panel-head">
              <div>
                <div class="section-kicker">DNS</div>
                <h2>调度域名解析</h2>
                <p>查询现有记录，确认后再更新。</p>
              </div>
              <div id="dnsStatus" class="dns-status"><span class="badge">未查询</span></div>
            </div>
            <div class="panel-body">
                <div class="form-grid" style="grid-template-columns:1fr 110px">
                  <div class="field"><label>调度域名</label><input id="dnsName" value="${escapeHTML(dispatchDomain)}" placeholder="media.example.com"></div>
                  <div class="field"><label>类型</label><select id="dnsType"><option>A</option><option>AAAA</option><option>CNAME</option></select></div>
                  <div class="field full"><label>记录值</label><textarea id="dnsValues" placeholder="一行一个记录值"></textarea></div>
                </div>
                <div class="toolbar-inline" style="margin-top:12px">
                  <button class="btn" id="dnsLoadBtn">查询 DNS</button>
                  <button class="btn primary" id="dnsUpdateBtn">更新 DNS</button>
                </div>
                <details class="dns-details">
                  <summary>查看接口响应</summary>
                  <pre id="dnsOut" class="output"></pre>
                </details>
            </div>
          </section>
            </div>
      </section>

      <!-- DASHBOARD -->
      <section class="panel-stack page" data-page="dashboard" id="dashboardModal">
        <section class="panel">
          <div class="panel-head">
            <div>
              <div class="section-kicker">数据</div>
              <h2>性能与数据</h2>
              <p>D1 请求统计、最近访问与 Cloudflare 边缘流量。</p>
            </div>
            <div class="toolbar-inline">
              <select id="performanceHours" class="search-input" style="min-width:120px"><option value="1">最近 1 小时</option><option value="6">最近 6 小时</option><option value="24" selected>最近 24 小时</option><option value="168">最近 7 天</option></select>
              <button class="btn" id="reloadPerformanceBtn">刷新性能</button>
              <button class="btn" id="closeDashboardBtn">返回线路</button>
            </div>
          </div>
          <div class="panel-body">
            <div class="form-section-title" style="margin:4px 0 10px"><b>真实性能</b><span>统计响应建立耗时、成功率与线路切换；不读取视频正文测速</span></div>
            <div class="stat-strip" style="margin-bottom:14px">
              <div class="stat-tile"><span>代理请求</span><b id="perfRequests">--</b><em id="perfWindow">最近 24 小时</em></div>
              <div class="stat-tile"><span>P50 / P95</span><b id="perfPercentiles" style="font-size:18px">--</b><em>响应建立耗时</em></div>
              <div class="stat-tile"><span>平均上游</span><b id="perfUpstream">--</b><em>首包与重定向</em></div>
              <div class="stat-tile"><span>错误 / 切线</span><b id="perfFailures" style="font-size:18px">--</b><em>真实请求累计</em></div>
            </div>
            <div class="table-wrapper" style="margin-bottom:12px">
              <table>
                <thead><tr><th>节点</th><th>请求</th><th>P50</th><th>P95</th><th>平均 D1</th><th>平均上游</th><th>错误率</th><th>切线</th></tr></thead>
                <tbody id="performanceNodeRows"><tr><td colspan="8" style="text-align:center;color:var(--text-sec)">暂无性能数据</td></tr></tbody>
              </table>
            </div>
            <div class="table-wrapper" style="margin-bottom:14px">
              <table>
                <thead><tr><th>节点</th><th>类型</th><th>实际线路</th><th>尝试</th><th>成功率</th><th>平均响应</th><th>最近活动</th></tr></thead>
                <tbody id="performanceLineRows"><tr><td colspan="7" style="text-align:center;color:var(--text-sec)">暂无线路数据</td></tr></tbody>
              </table>
            </div>
            <div class="form-section-title" style="margin:4px 0 10px"><b>流量概览</b><span>Cloudflare 与 D1 汇总</span></div>
            <div class="stat-strip" style="margin-bottom:14px">
              <div class="stat-tile"><span>今天流量</span><b id="trafficToday">--</b><em>Cloudflare</em></div>
              <div class="stat-tile"><span>7 天</span><b id="traffic7d">--</b><em>Cloudflare</em></div>
              <div class="stat-tile"><span>30 天</span><b id="traffic30d">--</b><em>Cloudflare</em></div>
              <div class="stat-tile"><span>D1 日期</span><b id="statsDay" style="font-size:18px">--</b><em>北京时间</em></div>
            </div>
            <div id="dashboardCharts" class="chart-grid"></div>
            <div class="table-wrapper visitor-table" style="margin-top:12px">
              <table>
                <thead><tr><th>时间</th><th>节点</th><th>IP / 地区</th><th>状态</th><th>入站客户端</th><th>出站模拟客户端</th><th>路径</th></tr></thead>
                <tbody id="logRows"><tr><td class="visitor-empty" colspan="7">暂无数据</td></tr></tbody>
              </table>
            </div>
            <pre id="statsOut" class="output" style="margin-top:14px"></pre>
          </div>
        </section>
      </section>

      <!-- DEPLOY -->
      <section class="panel-stack page" data-page="deploy">
        <section class="panel" style="border:1px solid rgba(225,29,72,.25)">
          <div class="panel-head">
            <div>
              <div class="section-kicker">更新</div>
              <h2>一键覆盖 / 更新核心代码</h2>
              <p>默认收起。仅在需要紧急替换混淆产物时展开。</p>
            </div>
            <div class="toolbar-inline">
              <button class="btn" id="toggleDeployBtn" type="button">展开编辑</button>
            </div>
          </div>
          <div class="panel-body" id="deployBody" hidden>
            <div class="field full"><label>混淆后的 Worker 代码</label><textarea id="codeArea" rows="8" placeholder="粘贴已经混淆后的 dist/index.js 内容"></textarea></div>
            <div class="toolbar-inline" style="margin-top:12px">
              <input type="file" id="fileInput" accept=".js" style="max-width:100%">
              <span class="hint">本地推荐仍使用 npm run deploy；网页覆盖适合紧急替换混淆产物。</span>
              <button class="btn danger" id="deployBtn" type="button">覆盖并重启</button>
            </div>
          </div>
        </section>
      </section>
    </div>
  </div>

</div>

<script nonce="${escapeHTML(nonce)}">
let nodes = [];
let latencyMap = {};
let stats = null;
let analytics = null;
let performanceData = null;
let watchLogs = [];
let activeDialogClose = null;
let toastTimer = null;
const watchStarting = new Set();
const CLIENT_LABELS = ${labels};
const DEFAULT_NODE_ICON_CLIENT = ${JSON.stringify(DEFAULT_NODE_ICON)};
const DISPATCH_ORIGIN = ${JSON.stringify(dispatchDomain ? "https://" + dispatchDomain : "")};
const $ = (id) => document.getElementById(id);
const tokenKey = "embyproxy_cf_admin_token";
localStorage.removeItem(tokenKey);
let adminToken = sessionStorage.getItem(tokenKey) || "";
function showLogin(){
  document.body.classList.remove("authed");
  $("loginToken").value = "";
  $("loginError").textContent = "";
  setTimeout(() => $("loginToken").focus(), 0);
}
function showApp(){
  document.body.classList.add("authed");
}
function saveToken(){
  const token = $("loginToken").value.trim();
  if (!token) return showToast("请输入访问密码");
  $("loginError").textContent = "";
  adminToken = token;
  sessionStorage.setItem(tokenKey, token);
  document.body.classList.add("authed");
  switchPage("nodes");
  loadNodes({ quietAuth: true });
  loadWatchLogs({ quiet: true });
  loadStats();
  loadPerformance();
  loadTrace();
}
function logout(){
  adminToken = "";
  sessionStorage.removeItem(tokenKey);
  nodes = [];
  document.body.classList.remove("authed");
  showLogin();
}
function showDialog(options = {}) {
  if (activeDialogClose) activeDialogClose(false);
  const backdrop = $("dialogBackdrop");
  const cancel = $("dialogCancel");
  const ok = $("dialogOk");
  const actions = ok.parentElement;
  const card = actions.parentElement;
  const oldInput = card.querySelector(".dialog-input");
  if (oldInput) oldInput.remove();
  $("dialogTitle").textContent = options.title || "提示";
  $("dialogMessage").textContent = options.message || "";
  let input = null;
  if (options.input) {
    input = document.createElement("textarea");
    input.className = "dialog-input";
    input.placeholder = options.placeholder || "";
    input.value = options.value || "";
    actions.before(input);
  }
  actions.hidden = options.actions === false;
  cancel.hidden = options.cancel === false;
  cancel.textContent = options.cancelText || "取消";
  ok.textContent = options.okText || "确定";
  backdrop.classList.add("show");
  if (input) input.focus();
  else if (!actions.hidden) ok.focus();
  return new Promise((resolve) => {
    let timer = null;
    const cleanup = (value) => {
      if (timer) clearTimeout(timer);
      backdrop.classList.remove("show");
      actions.hidden = false;
      ok.onclick = null;
      cancel.onclick = null;
      backdrop.onclick = null;
      document.removeEventListener("keydown", onKeydown);
      if (activeDialogClose === cleanup) activeDialogClose = null;
      resolve(input && value ? input.value : value);
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") cleanup(false);
      if (event.key === "Enter" && !input && !actions.hidden) cleanup(true);
    };
    activeDialogClose = cleanup;
    ok.onclick = () => cleanup(true);
    cancel.onclick = () => cleanup(false);
    backdrop.onclick = (event) => { if (event.target === backdrop) cleanup(false); };
    document.addEventListener("keydown", onKeydown);
    if (options.autoCloseMs) timer = setTimeout(() => cleanup(true), options.autoCloseMs);
  });
}
function uiAlert(message, title = "提示") {
  return showDialog({ title, message, cancel: false });
}
function uiConfirm(message, title = "确认操作") {
  return showDialog({ title, message, okText: "确认", cancelText: "取消" });
}
function uiPrompt(message, title = "输入内容", placeholder = "") {
  return showDialog({ title, message, input: true, placeholder, okText: "导入", cancelText: "取消" });
}
function setNotice(message = "", isError = false) {
  if (!message) return;
  if (isError) uiAlert(message, "操作未完成");
  else showToast(message);
}
function handleError(error, quietAuth = false) {
  const message = error?.message || String(error);
  if (error?.status === 401) {
    const wasAuthed = document.body.classList.contains("authed");
    adminToken = "";
    sessionStorage.removeItem(tokenKey);
    showLogin();
    if (!quietAuth) uiAlert(wasAuthed ? "登录已失效，请重新输入访问密码。" : "访问密码不正确。", "需要重新登录");
    return;
  }
  uiAlert(message, "操作未完成");
}
async function api(path, options = {}) {
  if (!adminToken) {
    const error = new Error("请先输入访问密码。");
    error.status = 401;
    throw error;
  }
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", "Bearer " + adminToken);
  if (options.body && !headers.get("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const error = new Error(data.error || res.statusText);
    error.status = res.status;
    throw error;
  }
  return data;
}
async function loadNodes(options = {}){
  try {
    const data = await api("/api/nodes");
    nodes = data.nodes || [];
    renderNodes();
    renderMetrics();
    showApp();
    if (!options.quietAuth) setNotice("已加载 " + nodes.length + " 个节点。");
  } catch(e) { handleError(e, options.quietAuth); }
}
function renderNodes(){
  const q = ($("search")?.value || "").trim().toLowerCase();
  const list = nodes.filter(n => !q || [n.name,n.displayName,n.tag,n.remark,(n.targets||[]).join(" "),n.embyUser].join(" ").toLowerCase().includes(q));
  $("nodeGrid").innerHTML = list.map((n, index) => {
    const url = proxyURL(n);
    const firstTarget = (n.targets || [])[0] || "";
    const icon = iconHTML(n);
    const keep = cardKeepaliveSummary(n);
    const videoLines = String(n.streamTarget || "").split(/\\n+/).map(v => v.trim()).filter(Boolean);
    const videoCount = videoLines.length || (n.targets || []).length;
    const lat = latencyMap[n.name];
    const latencyText = lat?.pending ? "测速中…" : (lat?.ms >= 0 ? lat.ms + " ms" : (lat?.ms < 0 ? "超时" : "未测速"));
    const route = n.playbackRoute || {};
    const routeMode = route.mode === "direct" ? "direct" : (route.mode === "proxy" ? "proxy" : "empty");
    const routeLabel = routeMode === "direct"
      ? (Number(route.status || 0) === 307 ? "拖动直连回退" : "直连重定向")
      : (routeMode === "proxy" ? "中转响应" : "暂无记录");
    const routeDetail = route.ts
      ? relativeTimeClient(route.ts) + (route.status ? " · HTTP " + route.status : "") + (routeMode === "direct" ? " · 不代表客户端已播成功" : "")
      : "出现中转响应或直连重定向后显示";
    const configuredMode = n.streamMode === "direct" ? "媒体流直连" : (n.streamMode === "auto" ? "媒体流条件直连" : "固定中转");
    const recentStatusText = route.status ? ("HTTP " + route.status) : "暂无记录";
    const lineStrategyDetail = n.streamStrategy === "priority"
      ? "按配置顺序使用，当前线路失败后切换"
      : "按响应耗时与近期失败状态选择，不读取视频正文测速";
    const simulatedClient = n.impersonate === false ? "未启用" : (CLIENT_LABELS[n.clientProfile] || n.clientProfile || "未知");
    const simulatedDevice = n.impersonate === false ? "保留入站身份" : (n.clientProfile === "hills_windows" ? "Windows 设备" : "设备 OnePlus-PKG110");
    const watchAutomatic = Boolean(n.autoWatch && n.embyUser && n.embyPassword);
    const watchLabel = watchAutomatic ? "到期自动观看" : "仅到期提醒";
    const watchDetail = n.embyUser ? ("账号 " + n.embyUser) : "未配置观看账号";
    const cardLabel = (n.displayName || n.name) + "，点击查看连接与更多操作";
    return '<article class="emby-card" tabindex="0" aria-expanded="false" aria-label="' + attr(cardLabel) + '" data-name="' + attr(n.name) + '" data-search="' + attr([n.name,n.displayName,n.tag,n.remark,firstTarget].join(" ")) + '">' +
      '<div class="card-flip-shell">' +
        '<section class="card-face card-front" aria-hidden="false">' +
          '<div class="card-top"><div class="card-title-group"><div class="emby-icon">' + icon + '</div><div class="card-title"><b>' + esc(n.displayName || n.name) + '</b><small>' + esc(n.name) + (n.tag ? " · " + esc(n.tag) : "") + '</small></div></div><div class="card-top-actions"><span class="badge ' + (n.enabled ? "ok" : "warn") + '">' + (n.enabled ? "启用" : "停用") + '</span><button class="card-flip-btn" type="button" data-act="flip" title="查看连接与更多操作" aria-label="查看连接与更多操作">↻</button></div></div>' +
          '<div class="card-body">' +
            '<div class="route-summary">' +
              '<div class="route-current ' + routeMode + '"><span class="route-eyebrow">最近播放路径</span><div class="route-value"><i></i><b>' + esc(routeLabel) + '</b></div><small title="' + attr(routeDetail) + '">' + esc(routeDetail) + '</small></div>' +
              '<div class="route-facts"><div class="route-fact"><span>配置</span><b>' + esc(configuredMode) + '</b></div><div class="route-fact"><span>延迟</span><b class="route-latency" data-latency-for="' + attr(n.name) + '">' + esc(latencyText) + '</b></div><div class="route-fact"><span>最近响应</span><b title="' + attr(routeDetail) + '">' + esc(recentStatusText) + '</b></div></div>' +
            '</div>' +
            '<div class="card-meta-grid">' +
              cardMetaItem("模拟身份", simulatedClient, simulatedDevice) +
              cardMetaItem("中转视频线路", videoCount + " 条 · " + (n.streamStrategy === "priority" ? "配置顺序" : "响应择优"), lineStrategyDetail) +
              cardMetaItem("观看保活", keep.label, keep.detail) +
              cardMetaItem("模拟观看", watchLabel, watchDetail) +
            '</div>' +
          '</div>' +
          '<div class="card-footer"><button class="btn small" data-act="copy" data-name="' + attr(n.name) + '">复制</button><button class="btn small" data-act="edit" data-name="' + attr(n.name) + '">编辑</button><button class="btn small" data-act="ping" data-name="' + attr(n.name) + '">测速</button><button class="btn small primary" data-act="keepalive" data-name="' + attr(n.name) + '">已观看</button></div>' +
        '</section>' +
        '<section class="card-face card-back" aria-hidden="true" inert>' +
          '<div class="card-top"><div class="card-title-group"><div class="emby-icon">' + icon + '</div><div class="card-title"><b>' + esc(n.displayName || n.name) + '</b><small>连接与管理</small></div></div><button class="card-flip-btn" type="button" data-act="flip" title="返回状态" aria-label="返回状态">↻</button></div>' +
          '<div class="card-body">' +
            '<div class="card-back-heading"><b>接入与上游</b><small>敏感信息默认隐藏</small></div>' +
            '<div class="card-back-section">' +
              infoRow("接入", '<span class="mono masked" data-secret="' + attr(url) + '">••••••••••••</span> <button class="btn small" data-act="reveal" data-name="' + attr(n.name) + '">显示</button>') +
              infoRow("上游", '<span class="masked" data-secret="' + attr((n.targets || []).join("\\n")) + '">' + esc(firstTarget ? "••••••••••••" : "未配置") + '</span>') +
              (n.secret ? infoRow("密钥", '<span class="masked" data-secret="' + attr(n.secret) + '">••••••</span>') : '') +
            '</div>' +
            '<div class="card-back-heading"><b>线路与管理</b><small>配置、排序和删除</small></div>' +
            '<div class="card-back-actions">' +
              '<button class="btn small" data-act="stream" data-name="' + attr(n.name) + '">线路诊断</button>' +
              '<button class="btn small" data-act="stream-edit" data-name="' + attr(n.name) + '">视频配置</button>' +
              '<button class="btn small" data-act="watch-edit" data-name="' + attr(n.name) + '">观看策略</button>' +
              '<button class="btn small" data-act="up" data-name="' + attr(n.name) + '" ' + (index === 0 ? "disabled" : "") + '>上移</button>' +
              '<button class="btn small" data-act="down" data-name="' + attr(n.name) + '" ' + (index === list.length - 1 ? "disabled" : "") + '>下移</button>' +
              '<button class="btn small danger" data-act="delete" data-name="' + attr(n.name) + '">删除</button>' +
            '</div>' +
          '</div>' +
          '<div class="card-back-footer"><button class="btn small" type="button" data-act="flip">返回状态</button></div>' +
        '</section>' +
      '</div>' +
    '</article>';
  }).join("") || '<div class="empty">暂无节点。点右上角 ··· 或「新建」添加线路。</div>';
}

function infoRow(label, value){ return '<div class="info-row"><div class="info-label">' + esc(label) + '</div><div class="info-value">' + value + '</div></div>'; }
function cardMetaItem(label, value, detail){
  return '<div class="card-meta-item"><span>' + esc(label) + '</span><b title="' + attr(value || "") + '">' + esc(value || "-") + '</b><small title="' + attr(detail || "") + '">' + esc(detail || "-") + '</small></div>';
}
function relativeTimeClient(ts){
  const seconds = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
  return Math.floor(seconds / 86400) + " 天前";
}
function cardKeepaliveSummary(n){
  if (!n.renewDays) return { label:"未启用", detail:"未设置观看周期" };
  const k = n.keepalive || {};
  const label = k.status === "due" ? ("已超期 " + Math.abs(k.remainDays || 0) + " 天") : ("剩余 " + (k.remainDays ?? n.renewDays) + " 天");
  const detail = k.lastPlayTs ? ("最近 " + relativeTimeClient(k.lastPlayTs)) : ("周期 " + n.renewDays + " 天 · 无播放记录");
  return { label, detail };
}
function setCardFlipped(card, flipped){
  if (!card) return;
  const next = Boolean(flipped);
  card.classList.toggle("is-flipped", next);
  card.setAttribute("aria-expanded", String(next));
  const front = card.querySelector(".card-front");
  const back = card.querySelector(".card-back");
  if (front) {
    front.setAttribute("aria-hidden", String(next));
    front.inert = next;
  }
  if (back) {
    back.setAttribute("aria-hidden", String(!next));
    back.inert = !next;
  }
}
function toggleCardFlipped(card){
  setCardFlipped(card, !card?.classList.contains("is-flipped"));
}
function isCardInteractiveTarget(target){
  return Boolean(target?.closest?.("button,a,input,select,textarea,label,summary,[role=button]"));
}
function iconHTML(n){
  const icon = n.icon || DEFAULT_NODE_ICON_CLIENT;
  if (/^https?:\\/\\//i.test(icon)) return '<img src="' + attr(icon) + '" alt="">';
  return '<span>' + esc(icon || DEFAULT_NODE_ICON_CLIENT) + '</span>';
}
function renderMetrics(){
  if (!$("metricNodes")) return;
  $("metricNodes").textContent = nodes.length;
  $("metricEnabled").textContent = nodes.filter(n => n.enabled).length;
  if (stats && stats.today) {
    const requests = stats.today.reduce((n,r) => n + Number(r.count || 0), 0);
    const bytes = stats.today.reduce((n,r) => n + Number(r.bytes || 0), 0);
    $("metricRequests").textContent = requests;
    $("metricBytes").textContent = humanBytes(bytes);
  }
}
function proxyURL(n){
  const origin = DISPATCH_ORIGIN || location.origin;
  return origin.replace(/\\/+$/, "") + "/" + encodeURIComponent(n.name) + (n.secret ? "/" + encodeURIComponent(n.secret) : "") + "/";
}
async function saveNode(){
  const typedName = $("name").value.trim();
  const normalizedName = typedName ? normalizeNodeName(typedName) : normalizeNodeName($("displayName").value);
  if (!typedName) {
    $("name").value = normalizedName || ("node-" + Date.now().toString(36));
    if (normalizedName) showToast("已根据显示名生成节点名 " + normalizedName);
  } else if ($("name").value !== normalizedName) {
    $("name").value = normalizedName;
    showToast("节点名已自动规范为 " + normalizedName);
  }
  const body = {
    oldName: $("editingName").value,
    name: $("name").value,
    displayName: $("displayName").value,
    icon: $("icon").value.trim() || DEFAULT_NODE_ICON_CLIENT,
    targets: $("targets").value.split(/\\n|[;,，；|]+/).map(v => v.trim()).filter(Boolean),
    streamTarget: $("streamTarget").value,
    streamStrategy: $("streamStrategy").value,
    streamTimeoutMs: Number($("streamTimeoutMs").value || 2500),
    secret: $("secret").value,
    clientProfile: $("clientProfile").value,
    impersonate: $("impersonate").checked,
    headerMode: $("headerMode").value,
    streamMode: $("streamMode").value,
    directExternal: $("directExternal").checked,
    cacheImage: $("cacheImage").checked,
    enabled: $("enabled").checked,
    autoWatch: $("autoWatch").checked,
    tag: $("tag").value,
    remark: $("remark").value,
    renewDays: Number($("renewDays").value || 0),
    remindBeforeDays: Number($("remindBeforeDays").value || 0),
    keepaliveAt: $("keepaliveAt").value,
    embyUser: $("embyUser").value,
    embyPassword: $("embyPassword").value,
    embyPlayId: $("embyPlayId").value,
    watchContentType: $("watchContentType").value,
    watchWindowStart: Number($("watchWindowStart").value || 0),
    watchWindowEnd: Number($("watchWindowEnd").value || 24),
    watchDailyLimit: Number($("watchDailyLimit").value || 1),
    watchFailureBackoffMin: Number($("watchFailureBackoffMin").value || 360),
    watchDurationMinSec: Number($("watchDurationMinSec").value || 300),
    watchDurationMaxSec: Number($("watchDurationMaxSec").value || 390)
  };
  try {
    await api("/api/nodes", { method:"POST", body: JSON.stringify(body) });
    resetForm({ keepOpen: false });
    hideNodeEditor();
    await loadNodes({ quietAuth: true });
    showToast("节点已保存");
  }
  catch(e){ handleError(e); }
}
function normalizeNodeName(value){
  const parts = [];
  for (const char of String(value || "").trim().toLowerCase()) {
    if (/[a-z0-9]/.test(char)) { parts.push(char); continue; }
    if (char === "-" || char === "_") { parts.push(char); continue; }
    const py = PINYIN_WORDS_CLIENT[char] || chineseInitialClient(char);
    if (py) parts.push(py);
  }
  return parts.join("").replace(/-+/g, "-").replace(/_+/g, "_").replace(/^[-_]+|[-_]+$/g, "");
}
const PINYIN_WORDS_CLIENT = ${JSON.stringify({
  "阿":"a","啊":"a","爱":"ai","安":"an","按":"an","奥":"ao",
  "八":"ba","白":"bai","百":"bai","版":"ban","半":"ban","包":"bao","备":"bei","北":"bei","本":"ben","比":"bi","标":"biao","播":"bo",
  "测":"ce","层":"ceng","查":"cha","常":"chang","超":"chao","车":"che","成":"cheng","城":"cheng","池":"chi","出":"chu","传":"chuan","窗":"chuang","春":"chun","词":"ci","次":"ci","从":"cong",
  "大":"da","带":"dai","单":"dan","到":"dao","的":"de","登":"deng","低":"di","地":"di","点":"dian","电":"dian","端":"duan","短":"duan","队":"dui","对":"dui","多":"duo",
  "俄":"e","额":"e","二":"er",
  "发":"fa","番":"fan","方":"fang","防":"fang","访":"fang","非":"fei","分":"fen","服":"fu","复":"fu",
  "港":"gang","高":"gao","个":"ge","更":"geng","公":"gong","共":"gong","广":"guang","国":"guo",
  "海":"hai","韩":"han","好":"hao","合":"he","黑":"hei","红":"hong","后":"hou","湖":"hu","华":"hua","缓":"huan","换":"huan","黄":"huang","回":"hui",
  "级":"ji","加":"jia","家":"jia","节":"jie","接":"jie","今":"jin","京":"jing","精":"jing","旧":"jiu",
  "开":"kai","客":"ke","空":"kong","快":"kuai",
  "来":"lai","蓝":"lan","老":"lao","类":"lei","冷":"leng","力":"li","连":"lian","联":"lian","链":"lian","良":"liang","量":"liang","列":"lie","临":"lin","流":"liu","龙":"long","路":"lu","录":"lu","绿":"lv",
  "美":"mei","门":"men","密":"mi","名":"ming","模":"mo",
  "南":"nan","内":"nei","你":"ni","年":"nian","宁":"ning","牛":"niu","农":"nong",
  "欧":"ou",
  "排":"pai","盘":"pan","配":"pei","频":"pin","平":"ping","普":"pu",
  "七":"qi","期":"qi","启":"qi","强":"qiang","清":"qing","轻":"qing","求":"qiu","全":"quan","群":"qun",
  "日":"ri","容":"rong","入":"ru","软":"ruan",
  "三":"san","色":"se","山":"shan","上":"shang","少":"shao","设":"she","深":"shen","生":"sheng","省":"sheng","时":"shi","视":"shi","试":"shi","首":"shou","数":"shu","双":"shuang","水":"shui","私":"si","速":"su",
  "台":"tai","态":"tai","泰":"tai","探":"tan","特":"te","天":"tian","条":"tiao","通":"tong","同":"tong","图":"tu",
  "外":"wai","网":"wang","微":"wei","文":"wen","我":"wo","五":"wu",
  "西":"xi","下":"xia","线":"xian","显":"xian","香":"xiang","详":"xiang","小":"xiao","新":"xin","信":"xin","星":"xing","修":"xiu","需":"xu",
  "亚":"ya","严":"yan","验":"yan","样":"yang","页":"ye","一":"yi","移":"yi","影":"ying","用":"yong","优":"you","友":"you","有":"you","源":"yuan","月":"yue","云":"yun",
  "再":"zai","站":"zhan","账":"zhang","者":"zhe","正":"zheng","中":"zhong","终":"zhong","主":"zhu","专":"zhuan","转":"zhuan","装":"zhuang","资":"zi","自":"zi","总":"zong","组":"zu","最":"zui"
})};
function chineseInitialClient(char){
  const code = char.charCodeAt(0);
  if (code < 0x4e00 || code > 0x9fff) return "";
  const ranges = [[0x554a,"a"],[0x516b,"b"],[0x64e6,"c"],[0x54d2,"d"],[0x59f6,"e"],[0x53d1,"f"],[0x560e,"g"],[0x54c8,"h"],[0x51fb,"j"],[0x5580,"k"],[0x5783,"l"],[0x5988,"m"],[0x62ff,"n"],[0x5662,"o"],[0x5991,"p"],[0x4e03,"q"],[0x7136,"r"],[0x6492,"s"],[0x584c,"t"],[0x6316,"w"],[0x5915,"x"],[0x538b,"y"],[0x531d,"z"]];
  let result = "z";
  for (const [start, initial] of ranges) if (code >= start) result = initial;
  return result;
}

function showNodeEditor(mode){
  const panel = $("nodeEditorPanel");
  if (!panel) return;
  panel.hidden = false;
  if (mode === "create") {
    $("formTitle").textContent = "新建媒体线路";
  }
  try { panel.scrollIntoView({ behavior: "instant", block: "start" }); } catch {}
}
function hideNodeEditor(){
  const panel = $("nodeEditorPanel");
  if (!panel) return;
  panel.hidden = true;
}
function openCreateNode(){
  resetForm({ keepOpen: true });
  showNodeEditor("create");
}
function cancelNodeEditor(){
  resetForm({ keepOpen: false });
  hideNodeEditor();
  showToast("已取消编辑");
}

function editNode(name){
  const n = nodes.find(x => x.name === name); if (!n) return;
  $("formTitle").textContent = "编辑节点 " + n.name;
  $("editingName").value = n.name;
  $("name").value = n.name; $("displayName").value = n.displayName || "";
  $("icon").value = n.icon || "";
  $("targets").value = (n.targets || []).join("\\n"); $("secret").value = n.secret || "";
  $("streamTarget").value = n.streamTarget || "";
  $("streamStrategy").value = n.streamStrategy || "auto";
  $("streamTimeoutMs").value = n.streamTimeoutMs || 2500;
  $("clientProfile").value = n.clientProfile || "yamby";
  $("impersonate").checked = n.impersonate !== false;
  $("headerMode").value = n.headerMode || "dual";
  $("streamMode").value = n.streamMode || "proxy";
  $("directExternal").checked = !!n.directExternal;
  $("cacheImage").checked = n.cacheImage !== false;
  $("enabled").checked = n.enabled !== false;
  $("autoWatch").checked = !!n.autoWatch;
  $("renewDays").value = n.renewDays || "";
  $("remindBeforeDays").value = n.remindBeforeDays || "";
  $("keepaliveAt").value = n.keepaliveAt || "";
  $("embyUser").value = n.embyUser || "";
  $("embyPassword").value = n.embyPassword || "";
  $("embyPlayId").value = n.embyPlayId || "";
  $("watchContentType").value = n.watchContentType || "mixed";
  $("watchWindowStart").value = n.watchWindowStart ?? 0;
  $("watchWindowEnd").value = n.watchWindowEnd ?? 24;
  $("watchDailyLimit").value = n.watchDailyLimit || 1;
  $("watchFailureBackoffMin").value = n.watchFailureBackoffMin || 360;
  $("watchDurationMinSec").value = n.watchDurationMinSec || 300;
  $("watchDurationMaxSec").value = n.watchDurationMaxSec || 390;
  $("tag").value = n.tag || ""; $("remark").value = n.remark || "";
  showNodeEditor("edit");
}
function editNodeSection(name, sectionId){
  editNode(name);
  requestAnimationFrame(() => {
    const section = $(sectionId);
    if (section) section.scrollIntoView({ behavior: "instant", block: "start" });
  });
}
async function deleteNode(name){
  if (!await uiConfirm("删除后该线路配置将不可恢复。\\n节点：" + name, "删除节点")) return;
  try {
    await api("/api/nodes/" + encodeURIComponent(name), { method:"DELETE" });
    await loadNodes({ quietAuth: true });
    showToast("节点已删除");
  }
  catch(e){ handleError(e); }
}
async function pingNode(name, options = {}){
  const n = nodes.find(x => x.name === name); if (!n) return;
  latencyMap[name] = { ...(latencyMap[name] || {}), pending: true };
  updateLatencyChip(name);
  try {
    const data = await api("/api/ping-node?url=" + encodeURIComponent(n.targets[0] || ""));
    latencyMap[name] = { ms: Number(data.ms), at: Date.now(), pending: false };
    updateLatencyChip(name);
    if (!options.quiet) showToast(data.ms >= 0 ? (n.displayName || name) + " · " + data.ms + "ms" : (n.displayName || name) + " · 断连/超时");
    return data;
  } catch(e){
    latencyMap[name] = { ms: -1, at: Date.now(), pending: false };
    updateLatencyChip(name);
    if (!options.quiet) handleError(e);
  }
}
async function diagnoseStreamLines(name = ""){
  try {
    let data;
    const saved = name || $("editingName")?.value || "";
    if (saved) {
      data = await api("/api/stream-health", { method:"POST", body: JSON.stringify({ name: saved }) });
    } else {
      const lines = $("streamTarget").value.split(/\\n|[;,，；|]+/).map(v => v.trim()).filter(Boolean);
      if (!lines.length) return showToast("请先填写独立视频线路或保存节点");
      const results = await Promise.all(lines.map(async (target, index) => {
        const result = await api("/api/ping-node", { method:"POST", body: JSON.stringify({ target }) });
        return { index:index + 1, target, label:target, ...result };
      }));
      data = { ok:results.some(item => item.ok), preferred:"未保存", lines:results };
    }
    const text = (data.lines || []).map((line) => "#" + line.index + " " + (line.label || line.target || "-") + " · " + (line.ok ? (Number(line.ms || 0) + "ms") : (line.error || "不可用"))).join("\\n");
    await uiAlert("当前优先：" + (data.preferred || "-") + "\\n\\n" + (text || "没有可测试线路"), "视频线路诊断");
  } catch(e){ handleError(e); }
}
function updateLatencyChip(name){
  const key = String(name || '');
  let el = null;
  document.querySelectorAll('[data-latency-for]').forEach((node) => {
    if (!el && node.getAttribute('data-latency-for') === key) el = node;
  });
  if (!el) {
    if ($('nodeGrid')) renderNodes();
    return;
  }
  const lat = latencyMap[name];
  el.className = 'route-latency';
  if (!lat || lat.pending) {
    el.classList.add('pending');
    el.textContent = lat && lat.pending ? '测速中…' : '未测速';
    return;
  }
  if (lat.ms >= 0) {
    el.classList.add(lat.ms < 180 ? 'good' : (lat.ms < 450 ? 'mid' : 'bad'));
    el.textContent = lat.ms + ' ms';
  } else {
    el.classList.add('bad');
    el.textContent = '超时';
  }
}

async function markWatched(name){
  if (watchStarting.has(name)) return showToast("该节点正在启动模拟观看，请稍候。");
  const node = nodes.find(item => item.name === name);
  const label = node?.displayName || name;
  const confirmed = await uiConfirm(
    "节点：" + label + "\\n\\n将登录保存的 Emby 账号并真实播放，通常持续 5-7.5 分钟。确定开始吗？",
    "开始模拟观看"
  );
  if (!confirmed) return;
  watchStarting.add(name);
  setWatchButtonState(name, true);
  showToast("正在登录上游并选择播放内容…");
  try {
    const data = await api("/api/keepalive/reset", { method:"POST", body: JSON.stringify({ name, source: "manual" }) });
    if (data.pending) {
      await uiAlert(
        data.message || ("真实模拟观看已开始：" + (data.displayName || name) + "\\n预计 5-7.5 分钟内完成，完成后通知 TG。"),
        "模拟观看已开始"
      );
      // 后台任务完成后自动刷新记录
      setTimeout(() => {
        loadWatchLogs({ quiet: true });
        loadNodes({ quietAuth: true });
      }, 70000);
      setTimeout(() => {
        loadWatchLogs({ quiet: true });
        loadNodes({ quietAuth: true });
      }, 390000);
      setTimeout(() => {
        loadWatchLogs({ quiet: true });
        loadNodes({ quietAuth: true });
      }, 480000);
    } else {
      showToast("已记录模拟观看：" + (data.displayName || name) + (data.durationSec ? (" · " + formatDurationClient(data.durationSec)) : "") + (data.title ? (" · " + data.title) : ""));
      await Promise.all([
        loadNodes({ quietAuth: true }),
        loadWatchLogs({ quiet: true })
      ]);
    }
  } catch(e){ handleError(e); }
  finally {
    watchStarting.delete(name);
    setWatchButtonState(name, false);
  }
}
function setWatchButtonState(name, pending){
  document.querySelectorAll('button[data-act="keepalive"]').forEach((button) => {
    if (button.getAttribute("data-name") !== name) return;
    button.disabled = pending;
    button.textContent = pending ? "启动中…" : "已观看";
  });
}
function formatDurationClient(seconds){
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min <= 0) return sec + " 秒";
  return min + " 分 " + String(sec).padStart(2, "0") + " 秒";
}
async function loadWatchLogs(options = {}){
  try {
    const data = await api("/api/watch-logs?days=3&limit=100");
    watchLogs = data.items || [];
    renderWatchLogs();
    if (!options.quiet) showToast("已刷新模拟观看记录");
  } catch(e){
    if (!options.quiet) handleError(e);
  }
}
function renderWatchLogs(){
  const rows = $("watchLogRows");
  if (!rows) return;
  rows.innerHTML = watchLogs.map((item) => {
    const site = item.displayName || item.node || "-";
    const title = item.title || "-";
    const time = item.time || (item.ts ? new Date(Number(item.ts)).toLocaleString() : "-");
    const duration = item.durationText || formatDurationClient(item.durationSec || 0);
    const source = item.source === "auto" ? "自动" : (item.source === "manual" ? "手动" : esc(item.source || "手动"));
    return '<tr><td>' + esc(site) + '</td><td>' + esc(title) + '</td><td class="mono">' + esc(item.node || "") + '</td><td>' + esc(time) + '</td><td>' + esc(duration) + '</td><td>' + source + '</td></tr>';
  }).join("") || '<tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无模拟观看记录</td></tr>';
}
async function loadStats(){
  try {
    const data = await api("/api/stats");
    stats = data.stats;
    renderMetrics();
    $("statsOut").textContent = JSON.stringify(stats, null, 2);
    $("statsDay").textContent = stats.day || "--";
    renderLogs(stats.recent || []);
    renderDashboardCharts();
  }
  catch(e){ handleError(e); }
}
async function loadPerformance(){
  try {
    const hours = Number($("performanceHours")?.value || 24);
    const data = await api("/api/performance?hours=" + hours);
    performanceData = data.performance || null;
    renderPerformance();
  } catch(e){ handleError(e); }
}
function formatPerformanceMs(value){
  const ms = Number(value || 0);
  if (!ms) return "--";
  return ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : Math.round(ms) + "ms";
}
function renderPerformance(){
  const data = performanceData || {};
  const summary = data.summary || {};
  if ($("perfRequests")) $("perfRequests").textContent = Number(summary.requests || 0).toLocaleString();
  if ($("perfWindow")) $("perfWindow").textContent = "最近 " + Number(data.hours || 24) + " 小时";
  if ($("perfPercentiles")) $("perfPercentiles").textContent = formatPerformanceMs(summary.p50Ms) + " / " + formatPerformanceMs(summary.p95Ms);
  if ($("perfUpstream")) $("perfUpstream").textContent = formatPerformanceMs(summary.avgUpstreamMs);
  if ($("perfFailures")) $("perfFailures").textContent = Number(summary.errors || 0) + " / " + Number(summary.failovers || 0);
  if ($("performanceNodeRows")) {
    $("performanceNodeRows").innerHTML = (data.nodes || []).map((row) => '<tr><td>' + esc(row.node || "-") + '</td><td>' + Number(row.requests || 0).toLocaleString() + '</td><td>' + formatPerformanceMs(row.p50Ms) + '</td><td>' + formatPerformanceMs(row.p95Ms) + '</td><td>' + formatPerformanceMs(row.avgNodeMs) + '</td><td>' + formatPerformanceMs(row.avgUpstreamMs) + '</td><td>' + Number(row.errorRate || 0).toFixed(2) + '%</td><td>' + Number(row.failovers || 0) + '</td></tr>').join("") || '<tr><td colspan="8" style="text-align:center;color:var(--text-sec)">暂无性能数据</td></tr>';
  }
  if ($("performanceLineRows")) {
    $("performanceLineRows").innerHTML = (data.lines || []).map((row) => '<tr><td>' + esc(row.node || "-") + '</td><td>' + esc(row.kind === "stream" ? "中转视频" : "API") + '</td><td class="mono">' + esc(row.label || "-") + '</td><td>' + Number(row.attempts || 0) + '</td><td>' + Number(row.successRate || 0).toFixed(1) + '%</td><td>' + formatPerformanceMs(row.avgMs) + '</td><td>' + (row.updatedAt ? esc(new Date(Number(row.updatedAt)).toLocaleString()) : "-") + '</td></tr>').join("") || '<tr><td colspan="7" style="text-align:center;color:var(--text-sec)">暂无线路数据</td></tr>';
  }
}
async function loadAnalytics(){
  try {
    const data = await api("/api/analytics");
    analytics = data;
    $("trafficToday").textContent = data.trafficToday || "--";
    $("traffic7d").textContent = data.traffic7d || "--";
    $("traffic30d").textContent = data.traffic30d || "--";
    $("statsDay").textContent = stats?.day || new Date().toISOString().slice(0, 10);
    $("statsOut").textContent = JSON.stringify(data, null, 2);
    renderDashboardCharts();
  } catch(e){ handleError(e); }
}
function renderDashboardCharts(){
  const box = $("dashboardCharts");
  if (!box) return;
  const rows = stats?.today || [];
  const kindNames = { playback:"播放", image:"图片", request:"普通", direct:"直达" };
  const kindRows = Object.values(rows.reduce((acc, row) => {
    const key = row.kind || "request";
    acc[key] = acc[key] || { label: kindNames[key] || key, value: 0 };
    acc[key].value += Number(row.count || 0);
    return acc;
  }, {}));
  const playbackRows = aggregateForChart(rows.filter(row => row.kind === "playback"), "count").slice(0, 6);
  const trafficRows = aggregateForChart(rows, "bytes").slice(0, 6);
  // 7 日趋势：用总量做成占比饼（各天占 7 日合计）
  const trendRows = (analytics?.trend || []).map(row => ({ label: row.date || "-", value: Number(row.count || 0) })).slice(-7);
  const healthRows = Object.values((stats?.recent || []).reduce((acc, row) => {
    const key = Number(row.status || 0) >= 400 ? "异常" : "正常";
    acc[key] = acc[key] || { label: key, value: 0 };
    acc[key].value++;
    return acc;
  }, {}));
  box.innerHTML =
    pieCard("请求类型分布", kindRows, item => item.value + " 次") +
    pieCard("播放最多节点", playbackRows, item => item.value + " 次") +
    pieCard("节点流量占比", trafficRows, item => humanBytes(item.value)) +
    pieCard("7 日请求占比", trendRows, item => item.value + " 次") +
    pieCard("最近状态", healthRows, item => item.value + " 条");
}

function aggregateForChart(rows, key){
  const map = {};
  for (const row of rows) {
    const name = row.node || "-";
    map[name] = map[name] || { label: name, value: 0 };
    map[name].value += Number(row[key] || 0);
  }
  return Object.values(map).sort((a,b) => b.value - a.value);
}
function pieColors(n){
  const base = ["#38bdf8","#22d3ee","#34d399","#fbbf24","#fb7185","#a3e635","#818cf8","#f472b6"];
  return Array.from({ length: Math.max(n, 1) }, (_, i) => base[i % base.length]);
}
function pieCard(title, rows, format){
  const list = (rows || []).map(r => ({ label: r.label || "-", value: Number(r.value || 0) })).filter(r => r.value > 0);
  if (!list.length) {
    return '<section class="chart-card"><h3>' + esc(title) + '</h3><div class="empty" style="padding:40px 0">暂无数据</div></section>';
  }
  const total = list.reduce((s, r) => s + r.value, 0) || 1;
  const colors = pieColors(list.length);
  let angle = -Math.PI / 2;
  const cx = 60, cy = 60, r = 52;
  let slices = "";
  if (list.length === 1) {
    slices = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + colors[0] + '"></circle>';
  } else {
    slices = list.map((item, idx) => {
      const portion = item.value / total;
      const sweep = portion * Math.PI * 2;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      angle += sweep;
      const x2 = cx + r * Math.cos(angle);
      const y2 = cy + r * Math.sin(angle);
      const large = sweep > Math.PI ? 1 : 0;
      const d = ["M", cx, cy, "L", x1, y1, "A", r, r, 0, large, 1, x2, y2, "Z"].join(" ");
      return '<path d="' + d + '" fill="' + colors[idx] + '" stroke="rgba(0,0,0,.14)" stroke-width="1"></path>';
    }).join("");
  }
  // 内圆做成甜甜圈，更现代
  slices += '<circle cx="' + cx + '" cy="' + cy + '" r="28" fill="rgba(15,23,42,.55)"></circle>';
  const legend = list.map((item, idx) => {
    const pct = Math.round(item.value / total * 100);
    return '<div class="pie-legend-row"><span class="pie-dot" style="background:' + colors[idx] + '"></span><span class="pie-name" title="' + attr(item.label) + '">' + esc(item.label) + '</span><span class="pie-val">' + esc(format(item)) + ' · ' + pct + '%</span></div>';
  }).join("");
  return '<section class="chart-card"><h3>' + esc(title) + '</h3><div class="pie-wrap"><svg class="pie-svg" viewBox="0 0 120 120" role="img" aria-label="' + attr(title) + '">' + slices + '</svg><div class="pie-legend">' + legend + '</div></div></section>';
}
function chartCard(title, rows, format){
  return pieCard(title, rows, format);
}

async function loadPreferredIPs(){
  const btn = $("preferredBtn");
  const type = $("ipType").value;
  const label = $("ipType").options[$("ipType").selectedIndex].text;
  btn.disabled = true; btn.textContent = "正在提取...";
  $("statusText").innerHTML = "正在拉取 <strong>" + esc(label) + "</strong> 数据...";
  try {
    const data = await api("/api/get-remote-ips?type=" + encodeURIComponent(type));
    await addAndTestRows(data.ips || [], label);
    showToast("成功提取 " + (data.totalCount || 0) + " 个，抽取 " + (data.ips || []).length + " 个测速");
  } catch(e){ handleError(e); }
  finally { btn.disabled = false; btn.textContent = "提取预设源并测速"; }
}
async function loadDNS(options = {}){
  try {
    const data = await api("/api/get-dns");
    if (data.name) $("dnsName").value = data.name;
    $("dnsOut").textContent = JSON.stringify(data, null, 2);
    const records = (data.result || []).filter(r => ["A","AAAA","CNAME"].includes(r.type));
    const managed = records.some(r => r?.meta?.origin_worker_id || r?.meta?.read_only || r?.read_only);
    $("dnsStatus").innerHTML = records.length
      ? records.map(r => '<span class="badge' + (managed ? " warn" : "") + '">' + esc(r.type) + " | " + esc(r.content) + (r?.meta?.origin_worker_id ? " | Worker 托管" : "") + '</span>').join("")
      : '<span class="badge warn">暂无解析记录</span>';
    if (!options.quiet) showToast("DNS 查询完成");
  } catch(e){ handleError(e); }
}
async function updateDNS(){
  try {
    const ips = $("dnsValues").value.split(/\\n|[;,，；|]+/).map(v => v.trim()).filter(Boolean);
    if (!ips.length) return showToast("请先填写 DNS 记录值");
    const name = $("dnsName").value.trim();
    if (!await uiConfirm("即将更新调度域名 DNS：\\n" + name + "\\n\\n记录值：\\n" + ips.join("\\n"), "更新 DNS")) return;
    const data = await api("/api/update-dns", { method:"POST", body: JSON.stringify({ name, ips }) });
    $("dnsOut").textContent = JSON.stringify(data, null, 2);
    showToast(data.success ? "DNS 更新成功" : (data.error || "DNS 更新失败"));
    loadDNS({ quiet: true });
  } catch(e){ handleError(e); }
}
function logClientCell(label, ua, device){
  const details = [ua, device].filter(Boolean).join(" · ");
  return '<div class="log-client"><b>' + esc(label || "未知") + '</b>' + (details ? '<small title="' + esc(details) + '">' + esc(details) + '</small>' : '') + '</div>';
}
function inboundClientLabel(ua){
  const value = String(ua || "");
  if (/yamby/i.test(value)) return "Yamby";
  if (/hills windows/i.test(value)) return "Hills Windows";
  if (/hills/i.test(value)) return "Hills";
  if (/emby/i.test(value)) return "Emby";
  return value.split(/[\\s\/(]/).filter(Boolean)[0] || "未知";
}
function renderLogs(rows){
  $("logRows").innerHTML = rows.map(r => {
    const outboundLabel = r.outbound_profile === "disabled" ? "未启用模拟" : (CLIENT_LABELS[r.outbound_profile] || (r.outbound_profile ? r.outbound_profile : "历史未记录"));
    return '<tr><td data-label="时间">' + esc(new Date(Number(r.ts || 0)).toLocaleString()) + '</td><td data-label="节点">' + esc(r.node || "") + '</td><td data-label="IP / 地区"><div><div class="mono">' + esc(r.ip || "") + '</div><small>' + esc(r.country || "") + '</small></div></td><td data-label="状态">' + esc(r.status || "") + '</td><td data-label="入站客户端">' + logClientCell(inboundClientLabel(r.ua), r.ua || "", "") + '</td><td data-label="出站模拟">' + logClientCell(outboundLabel, r.outbound_ua || "", r.outbound_device || "") + '</td><td data-label="路径" class="mono">' + esc(r.path || "") + '</td></tr>';
  }).join("") || '<tr><td class="visitor-empty" colspan="7">暂无数据</td></tr>';
}
function resetForm(options = {}){
  $("formTitle").textContent = "部署 / 编辑媒体线路";
  for (const id of ["editingName","name","displayName","icon","targets","streamTarget","secret","tag","remark","renewDays","remindBeforeDays","keepaliveAt","embyUser","embyPassword","embyPlayId"]) if ($(id)) $(id).value = "";
  if ($("clientProfile")) $("clientProfile").value = "yamby";
  if ($("headerMode")) $("headerMode").value = "dual";
  if ($("streamMode")) $("streamMode").value = "proxy";
  if ($("streamStrategy")) $("streamStrategy").value = "auto";
  if ($("streamTimeoutMs")) $("streamTimeoutMs").value = "2500";
  if ($("watchContentType")) $("watchContentType").value = "mixed";
  if ($("watchWindowStart")) $("watchWindowStart").value = "0";
  if ($("watchWindowEnd")) $("watchWindowEnd").value = "24";
  if ($("watchDailyLimit")) $("watchDailyLimit").value = "1";
  if ($("watchFailureBackoffMin")) $("watchFailureBackoffMin").value = "360";
  if ($("watchDurationMinSec")) $("watchDurationMinSec").value = "300";
  if ($("watchDurationMaxSec")) $("watchDurationMaxSec").value = "390";
  if ($("impersonate")) $("impersonate").checked = true;
  if ($("directExternal")) $("directExternal").checked = false;
  if ($("cacheImage")) $("cacheImage").checked = true;
  if ($("enabled")) $("enabled").checked = true;
  if ($("autoWatch")) $("autoWatch").checked = false;
  if (!options.keepOpen) hideNodeEditor();
}
async function importNodes(){
  const raw = await uiPrompt("粘贴导出的 JSON 内容。", "导入节点", "{\\n  \\"nodes\\": []\\n}");
  if (!raw) return;
  try {
    const body = JSON.parse(raw);
    const data = await api("/api/import", { method:"POST", body: JSON.stringify(body) });
    await loadNodes({ quietAuth: true });
    showToast("已导入 " + data.count + " 个节点");
  } catch(e){ handleError(e); }
}
function exportNodes(){ location.href = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify({ nodes }, null, 2)); }
function showToast(message){
  const toast = $("toast");
  if (!toast) return;
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = String(message || "");
  toast.classList.add("show");
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    toastTimer = null;
  }, 2600);
}
function copyText(v){ navigator.clipboard.writeText(v || ""); showToast("复制成功"); }
function applyTheme(theme){
  const next = (theme === "trust") ? "trust" : "cyber";
  document.body.classList.remove("theme-trust", "theme-cyber", "dark");
  document.body.classList.add(next === "cyber" ? "theme-cyber" : "theme-trust");
  if (next === "cyber") document.body.classList.add("dark");
  localStorage.setItem("embyproxy_ui_theme", next);
  // 小图标：赛博用月亮，信任用太阳
  const icon = next === "cyber" ? "☾" : "☀";
  document.querySelectorAll("#themeToggleBtn, #loginThemeBtn").forEach((btn) => {
    if (btn) {
      btn.textContent = icon;
      btn.title = next === "cyber" ? "当前：赛博暗黑（点击切换专业信任）" : "当前：专业信任（点击切换赛博暗黑）";
    }
  });
  document.querySelectorAll("[data-theme]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-theme") === next);
  });
}
function toggleTheme(){
  const cur = localStorage.getItem("embyproxy_ui_theme") || "cyber";
  applyTheme(cur === "cyber" ? "trust" : "cyber");
}

function switchPage(page){
  const next = String(page || "nodes");
  document.querySelectorAll("[data-page]").forEach((el) => {
    const on = (el.getAttribute("data-page") || "") === next;
    el.classList.toggle("active", on);
    // 双保险：避免 CSS 优先级导致多页同时显示
    el.style.display = on ? "grid" : "none";
  });
  document.querySelectorAll("[data-page-tab]").forEach((el) => {
    const tab = el.getAttribute("data-page-tab") || el.dataset.pageTab || "";
    el.classList.toggle("active", tab === next);
  });
  const titles = { nodes: "线路配置", network: "测速与 DNS", dashboard: "数据大屏", deploy: "代码更新" };
  if ($("pageTitle")) $("pageTitle").textContent = titles[next] || "控制台";
  try {
    if (next === "dashboard") { loadStats(); loadAnalytics(); loadPerformance(); }
    if (next === "network") loadDNS({ quiet: true });
    if (next === "nodes") loadWatchLogs({ quiet: true });
    else hideNodeEditor();
  } catch (err) {
    console.log("switchPage side effect", err);
  }
  try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {}
}

function openDashboard(){ switchPage("dashboard"); }
function closeDashboard(){ switchPage("nodes"); }
async function loadTrace(){
  try {
    const data = await api("/api/trace");
    const entry = data.entry || {};
    const egress = data.egress || {};
    const entryText = [entry.country, entry.colo, entry.city].filter(Boolean).join(" / ") || "--";
    const egressText = [egress.loc, egress.colo, egress.ip].filter(Boolean).join(" / ") || egress.error || (egress.status === "updating" ? "检测中..." : "--");
    $("traceEntry").textContent = entryText;
    $("traceEgress").textContent = egressText;
    $("mobileTraceEntry").textContent = [entry.colo, entry.country].filter(Boolean).join(" / ") || "--";
    $("mobileTraceEgress").textContent = egress.ip || [egress.colo, egress.loc].filter(Boolean).join(" / ") || egress.error || (egress.status === "updating" ? "检测中..." : "--");
    if (egress.status === "updating") setTimeout(loadTrace, 2200);
  } catch(e) {
    for (const id of ["traceEntry", "traceEgress", "mobileTraceEntry", "mobileTraceEgress"]) $(id).textContent = "--";
  }
}
async function measureRTT(){
  const started = performance.now();
  try {
    await fetch("/__client_rtt__?t=" + Date.now(), { cache: "no-store" });
    const ms = Math.round(performance.now() - started);
    $("rttValue").textContent = ms + "ms";
    $("mobileRttValue").textContent = ms + "ms";
    const color = ms < 180 ? "var(--ok)" : (ms < 450 ? "var(--warn)" : "var(--danger)");
    $("rttDot").style.background = color;
    $("mobileRttDot").style.background = color;
  } catch {
    $("rttValue").textContent = "--";
    $("mobileRttValue").textContent = "--";
  }
}
async function addCustomIPs(){
  const found = extractInputRecords($("customIps").value);
  if (!found.length) return showToast("未识别到合法的 IP 或域名");
  await addAndTestRows(found, "自定义节点");
}
function extractInputRecords(text){
  const values = [];
  const re = /((?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?:\\.(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)){3})|([a-f0-9]{1,4}(?::[a-f0-9]{1,4}){2,7})|([a-z0-9][a-z0-9.-]*\\.[a-z]{2,})/ig;
  let m;
  while ((m = re.exec(text || ""))) values.push(formatIPCandidate(m[0]));
  return Array.from(new Set(values.filter(Boolean)));
}
function formatIPCandidate(value){
  const v = String(value || "").trim();
  return v.includes(":") && !v.startsWith("[") ? "[" + v + "]" : v;
}
function recordType(value){
  const clean = String(value || "").replace(/[\\[\\]]/g, "");
  return clean.includes(":") ? "AAAA" : (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(clean) ? "A" : "CNAME");
}
async function addAndTestRows(values, sourceLabel){
  const tbody = $("ipRows");
  tbody.querySelector(".ip-empty-row")?.remove();
  if (tbody.innerHTML.includes("暂无数据")) tbody.innerHTML = "";
  const existing = new Set(Array.from(tbody.querySelectorAll(".ip-text")).map(el => el.textContent));
  const rows = [];
  for (const value of values) {
    if (!value || existing.has(value)) continue;
    const tr = document.createElement("tr");
    tr.className = "test-row";
    tr.innerHTML = '<td style="text-align:center"><input type="checkbox" class="ip-checkbox row-checkbox" value="' + attr(value) + '"></td>' +
      '<td><strong class="ip-text mono" style="color:var(--primary);cursor:pointer" title="点击复制">' + esc(value) + '</strong></td>' +
      '<td class="latency" data-ms="9999" style="font-weight:650;color:var(--text-sec)">测算中...</td>' +
      '<td class="speed" style="color:var(--text-sec)">-</td>' +
      '<td class="loc" style="color:var(--text-sec)">等待解析</td>' +
      '<td><button class="btn small btn-dns" disabled data-single-dns="' + attr(value) + '">唯一解析</button> <button class="btn small danger" data-ip-remove>删除</button></td>';
    tbody.insertBefore(tr, tbody.firstChild);
    rows.push(tr);
  }
  await Promise.all(rows.map(tr => doLocalPing(tr.querySelector(".ip-text").textContent, tr, sourceLabel)));
  sortTableByLatency();
  document.querySelectorAll(".btn-dns").forEach(btn => btn.disabled = false);
  $("statusText").textContent = "测速完毕，可以勾选后更新 DNS。";
}
function markTimeout(latTd, spdTd, tr) {
  latTd.textContent = "超时抛弃";
  latTd.setAttribute("data-ms", "9999");
  latTd.style.color = "var(--danger)";
  spdTd.textContent = "超时 (>2000ms)";
  spdTd.style.color = "var(--danger)";
  const cb = tr.querySelector(".row-checkbox");
  if (cb) cb.disabled = true;
}
async function doLocalPing(value, tr, sourceLabel) {
  const latTd = tr.querySelector(".latency");
  const spdTd = tr.querySelector(".speed");
  const locTd = tr.querySelector(".loc");
  const query = value.replace(/[\\[\\]]/g, "");
  const isIPv6 = query.includes(":");
  const isDomain = /[a-z]/i.test(query) && !isIPv6;
  if (isDomain) {
    locTd.innerHTML = '<span class="badge">CNAME</span> ' + esc(sourceLabel) + " | 优选域名";
  } else {
    const typeBadge = isIPv6 ? '<span class="badge">AAAA</span>' : '<span class="badge">A</span>';
    fetch("https://api.ip.sb/geoip/" + encodeURIComponent(query)).then(r => r.json()).then(data => {
      locTd.innerHTML = typeBadge + " " + esc(sourceLabel) + " | " + esc(data.country || "未知");
    }).catch(() => { locTd.innerHTML = typeBadge + " " + esc(sourceLabel) + " | 解析失败"; });
  }
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch("https://" + value + "/cdn-cgi/trace", { mode: "no-cors", signal: controller.signal });
    clearTimeout(timer);
    updateRowState(latTd, spdTd, Math.round(performance.now() - started));
  } catch (err) {
    clearTimeout(timer);
    markTimeout(latTd, spdTd, tr);
  }
}
function updateRowState(latTd, spdTd, rawLatency) {
  const latency = Math.max(0, Number(rawLatency || 0));
  latTd.textContent = latency + " ms";
  latTd.setAttribute("data-ms", String(latency));
  if (latency < 300) {
    latTd.style.color = "var(--ok)"; spdTd.textContent = "极佳"; spdTd.style.color = "var(--ok)";
  } else if (latency <= 500) {
    latTd.style.color = "var(--primary)"; spdTd.textContent = "正常"; spdTd.style.color = "var(--primary)";
  } else {
    latTd.style.color = "var(--warn)"; spdTd.textContent = "较高"; spdTd.style.color = "var(--warn)";
  }
}
function sortTableByLatency(){
  const tbody = $("ipRows");
  Array.from(tbody.querySelectorAll(".test-row"))
    .sort((a,b) => Number(a.querySelector(".latency").dataset.ms || 9999) - Number(b.querySelector(".latency").dataset.ms || 9999))
    .forEach(row => tbody.appendChild(row));
}
function selectedIPs(){
  return Array.from(document.querySelectorAll(".row-checkbox:checked")).map(cb => cb.value);
}
function writeSelectedToForm(values){
  const list = values || selectedIPs();
  $("dnsType").value = list[0] ? recordType(list[0]) : "A";
  $("dnsValues").value = list.join("\\n");
}
async function selectedToDNS(){
  const ips = selectedIPs();
  if (!ips.length) return showToast("请先勾选节点");
  if (!await uiConfirm("将应用勾选的 " + ips.length + " 个节点：\\n" + ips.join("\\n"), "更新调度域名 DNS")) return;
  await sendDNSRequest(ips);
}
async function topToDNS(){
  const rows = Array.from(document.querySelectorAll("#ipRows .test-row"));
  const top = [];
  for (const row of rows) {
    const ms = Number(row.querySelector(".latency").dataset.ms || 9999);
    if (ms < 2000) top.push(row.querySelector(".ip-text").textContent);
    if (top.length === 3) break;
  }
  if (!top.length) return showToast("没找到可用节点，请先测速");
  if (!await uiConfirm("将为你分发当前最快的 " + top.length + " 个节点：\\n" + top.join("\\n"), "TOP3 写入 DNS")) return;
  await sendDNSRequest(top);
}
async function sendDNSRequest(ips){
  try {
    writeSelectedToForm(ips);
    const data = await api("/api/update-dns", { method:"POST", body: JSON.stringify({ name: $("dnsName").value.trim(), ips }) });
    $("dnsOut").textContent = JSON.stringify(data, null, 2);
    showToast(data.success ? "DNS 更新成功" : (data.error || "DNS 更新失败"));
    loadDNS({ quiet: true });
  } catch(e){ handleError(e); }
}
function copyItdog(){
  const ips = Array.from(document.querySelectorAll("#ipRows .ip-text")).map(el => el.textContent.replace(/[\\[\\]]/g, ""));
  if (!ips.length) return showToast("请先提取节点");
  copyText(ips.join("\\n"));
  window.open("https://www.itdog.cn/batch_tcping/", "_blank");
}
async function purgeCache(){
  try {
    const data = await api("/api/purge-cache", { method:"POST", body:"{}" });
    $("dnsOut").textContent = JSON.stringify(data, null, 2);
    showToast(data.success ? "缓存刷新成功" : (data.error || "缓存刷新失败"));
  }
  catch(e){ handleError(e); }
}
async function fetchCustomApiAndTest(){
  const btn = $("fetchCustomApiBtn");
  const apiURL = $("customApiUrl").value.trim();
  if (!apiURL) return showToast("请先填入自定义 API 链接");
  btn.disabled = true; btn.textContent = "拉取中...";
  try {
    const data = await api("/api/get-custom-api-ips?url=" + encodeURIComponent(apiURL));
    await addAndTestRows(data.ips || [], "自定义 API");
    showToast("提取 " + (data.totalCount || 0) + " 个，抽取 " + (data.ips || []).length + " 个测速");
  } catch(e){ handleError(e); }
  finally { btn.disabled = false; btn.textContent = "拉取 API 并测速"; }
}
async function directSubmitCname(){
  const domains = extractInputRecords($("customIps").value).filter(v => recordType(v) === "CNAME");
  if (!domains.length) return showToast("没有提取到合法域名");
  if (!await uiConfirm("确定要直接将以下域名设为 CNAME 记录吗？\\n" + domains.join("\\n"), "直推 CNAME")) return;
  await sendDNSRequest(domains);
}
async function deployWorker(){
  let code = $("codeArea").value;
  if ($("fileInput").files.length) {
    code = await $("fileInput").files[0].text();
  }
  if (!code.trim()) return showToast("请先粘贴或选择混淆后的 JS 文件");
  if (!await uiConfirm("即将覆盖当前 Worker 代码。\\n请确认这是混淆后的可运行模块代码。", "覆盖核心代码")) return;
  const btn = $("deployBtn");
  btn.disabled = true; btn.textContent = "部署中...";
  try {
    const data = await api("/api/deploy", { method:"POST", body: JSON.stringify({ newCode: code }) });
    if (data.success) {
      showToast("部署成功，页面即将刷新");
      setTimeout(() => location.reload(), 1200);
    } else {
      showToast(data.error || "部署失败");
    }
  } catch(e){ handleError(e); }
  finally { btn.disabled = false; btn.textContent = "立即覆盖并重启"; }
}
async function pingAllNodes(){
  if (!nodes.length) return showToast("暂无节点");
  showToast("开始全局测速…");
  let ok = 0;
  let fail = 0;
  // 并发限制 4，避免打爆
  const queue = nodes.map(n => n.name);
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const name = queue.shift();
      const data = await pingNode(name, { quiet: true });
      if (data?.ms >= 0) ok++;
      else fail++;
    }
  });
  await Promise.all(workers);
  renderNodes();
  showToast("全局测速完成：可用 " + ok + " · 异常 " + fail);
}
async function moveNode(name, dir){
  const index = nodes.findIndex(n => n.name === name);
  const next = index + dir;
  if (index < 0 || next < 0 || next >= nodes.length) return;
  const reordered = nodes.slice();
  const temp = reordered[index]; reordered[index] = reordered[next]; reordered[next] = temp;
  try {
    await api("/api/nodes/reorder", { method:"POST", body: JSON.stringify({ names: reordered.map(n => n.name) }) });
    nodes = reordered;
    renderNodes();
  } catch(e){ handleError(e); }
}
function humanBytes(bytes){
  const units = ["B","KB","MB","GB","TB"]; let v = Number(bytes || 0), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 2 : 0) + " " + units[i];
}
function esc(v){ return String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function attr(v){ return esc(v).replace(/\\n/g, " "); }
if ($("loginToken")) $("loginToken").addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveToken();
});
if ($("loginBtn")) $("loginBtn").addEventListener("click", saveToken);
document.querySelectorAll("[data-page-tab]").forEach((btn) => {
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    const tab = btn.getAttribute("data-page-tab") || btn.dataset.pageTab || "nodes";
    switchPage(tab);
  });
});
$("reloadNodesBtn").addEventListener("click", () => loadNodes());
$("reloadWatchLogsBtn").addEventListener("click", () => loadWatchLogs());
$("logoutBtn").addEventListener("click", logout);
$("exportBtn").addEventListener("click", exportNodes);
$("importBtn").addEventListener("click", importNodes);
$("saveNodeBtn").addEventListener("click", saveNode);
$("resetBtn").addEventListener("click", () => resetForm({ keepOpen: true }));
if ($("cancelEditBtn")) $("cancelEditBtn").addEventListener("click", cancelNodeEditor);
if ($("newNodeBtn")) $("newNodeBtn").addEventListener("click", openCreateNode);
if ($("newNodeBtn2")) $("newNodeBtn2").addEventListener("click", openCreateNode);
if ($("toggleDeployBtn")) $("toggleDeployBtn").addEventListener("click", () => {
  const body = $("deployBody");
  if (!body) return;
  body.hidden = !body.hidden;
  $("toggleDeployBtn").textContent = body.hidden ? "展开编辑" : "收起编辑";
});
// 点击菜单外关闭
document.addEventListener("click", (e) => {
  const menu = $("moreMenu");
  if (menu && !menu.contains(e.target)) menu.open = false;
});
$("search").addEventListener("input", renderNodes);
$("preferredBtn").addEventListener("click", loadPreferredIPs);
$("dnsLoadBtn").addEventListener("click", loadDNS);
$("dnsUpdateBtn").addEventListener("click", updateDNS);
if ($("themeToggleBtn")) $("themeToggleBtn").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleTheme(); });
if ($("loginThemeBtn")) $("loginThemeBtn").addEventListener("click", (e) => { e.preventDefault(); toggleTheme(); });
document.querySelectorAll("[data-theme]").forEach((btn) => {
  btn.addEventListener("click", () => applyTheme(btn.getAttribute("data-theme")));
});
applyTheme(localStorage.getItem("embyproxy_ui_theme") || "cyber");
$("closeDashboardBtn").addEventListener("click", closeDashboard);
$("reloadPerformanceBtn").addEventListener("click", loadPerformance);
$("performanceHours").addEventListener("change", loadPerformance);
$("testEditedStreamBtn").addEventListener("click", () => diagnoseStreamLines());
$("testCustomBtn").addEventListener("click", addCustomIPs);
$("fetchCustomApiBtn").addEventListener("click", fetchCustomApiAndTest);
$("directCnameBtn").addEventListener("click", directSubmitCname);
$("deployBtn").addEventListener("click", deployWorker);
$("copyItdogBtn").addEventListener("click", copyItdog);
$("clearIPsBtn").addEventListener("click", () => { $("ipRows").innerHTML = '<tr class="ip-empty-row"><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无数据，请拉取节点或输入自定义 IP/域名测试</td></tr>'; $("selectAll").checked = false; });
$("selectedDnsBtn").addEventListener("click", selectedToDNS);
$("topDnsBtn").addEventListener("click", topToDNS);
$("pingAllBtn").addEventListener("click", pingAllNodes);
$("purgeBtn").addEventListener("click", purgeCache);
$("selectAll").addEventListener("change", () => document.querySelectorAll(".row-checkbox").forEach(input => { if (!input.disabled) input.checked = $("selectAll").checked; }));
$("ipRows").addEventListener("click", async (event) => {
  const text = event.target.closest(".ip-text");
  const single = event.target.closest("button[data-single-dns]");
  const remove = event.target.closest("button[data-ip-remove]");
  if (text) copyText(text.textContent);
  if (single && await uiConfirm("确定要将调度域名解析到：\\n" + single.dataset.singleDns + "\\n\\n这会覆盖当前记录。", "唯一解析")) sendDNSRequest([single.dataset.singleDns]);
  if (remove) remove.closest("tr").remove();
});
let cardPointerState = null;
$("nodeGrid").addEventListener("pointerdown", (event) => {
  const card = event.target.closest(".emby-card");
  if (!card || isCardInteractiveTarget(event.target)) return;
  cardPointerState = { card, pointerId:event.pointerId, x:event.clientX, y:event.clientY, moved:false };
  card.classList.add("is-pressed");
});
$("nodeGrid").addEventListener("pointermove", (event) => {
  const state = cardPointerState;
  if (!state || state.pointerId !== event.pointerId) return;
  if (Math.hypot(event.clientX - state.x, event.clientY - state.y) > 10) {
    state.moved = true;
    state.card.classList.remove("is-pressed");
  }
});
function finishCardPointer(event){
  const state = cardPointerState;
  if (!state || (event.pointerId != null && state.pointerId !== event.pointerId)) return;
  state.card.classList.remove("is-pressed");
  if (state.moved) state.card.dataset.suppressFlipUntil = String(Date.now() + 350);
  cardPointerState = null;
}
$("nodeGrid").addEventListener("pointerup", finishCardPointer);
$("nodeGrid").addEventListener("pointercancel", finishCardPointer);
$("nodeGrid").addEventListener("keydown", (event) => {
  const card = event.target.closest(".emby-card");
  if (!card || event.target !== card || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  toggleCardFlipped(card);
});
$("nodeGrid").addEventListener("click", (event) => {
  const card = event.target.closest(".emby-card");
  const btn = event.target.closest("button[data-act]");
  if (btn?.dataset.act === "flip") {
    toggleCardFlipped(card);
    return;
  }
  if (!btn && card && !isCardInteractiveTarget(event.target)) {
    if (Number(card.dataset.suppressFlipUntil || 0) > Date.now()) {
      return;
    }
    if (!String(window.getSelection?.() || "")) toggleCardFlipped(card);
    return;
  }
  if (!btn) return;
  const name = btn.dataset.name;
  if (btn.dataset.act === "copy") copyText(proxyURL(nodes.find(n => n.name === name) || {}));
  if (btn.dataset.act === "edit") editNode(name);
  if (btn.dataset.act === "stream-edit") editNodeSection(name, "streamConfigSection");
  if (btn.dataset.act === "watch-edit") editNodeSection(name, "watchStrategySection");
  if (btn.dataset.act === "ping") pingNode(name);
  if (btn.dataset.act === "stream") diagnoseStreamLines(name);
  if (btn.dataset.act === "keepalive") markWatched(name);
  if (btn.dataset.act === "delete") deleteNode(name);
  if (btn.dataset.act === "up") moveNode(name, -1);
  if (btn.dataset.act === "down") moveNode(name, 1);
  if (btn.dataset.act === "reveal") {
    const card = btn.closest(".emby-card");
    card.querySelectorAll("[data-secret]").forEach(el => el.textContent = el.dataset.secret);
    btn.remove();
  }
});
if (adminToken.trim()) {
  document.body.classList.add("authed");
  switchPage("nodes");
  loadNodes({ quietAuth: true });
  loadWatchLogs({ quiet: true });
  loadStats();
  loadTrace();
} else {
  showLogin();
}
measureRTT();
setInterval(measureRTT, 30000);
</script>
</body>
</html>`;
}
