const BUILD_VERSION = "0.1.0";
const DEFAULT_MAX_REWRITE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETRY_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_CLIENT_PROFILE = "yamby";
const DEFAULT_NODE_ICON = "🎬";
const IDENTITY_KEY = "system:upstream_identity";
const DEFAULT_DEVICE_NAME = "OnePlus-PKG110";
const EMBY_TICKS_PER_SECOND = 10000000;
const DEFAULT_SIMULATED_WATCH_SECONDS = 300;
const MIN_SIMULATED_WATCH_SECONDS = 180;
const MIN_PROGRESS_DELAY_SECONDS = 65;
const MAX_AUTO_SIMULATED_WATCHES_PER_CRON = 3;
const AUTO_WATCH_DAILY_PREFIX = "auto_watch_day:";
const DEFAULT_WATCH_COUNT_MIN_SECONDS = 60;
const DEFAULT_WATCH_SESSION_RETENTION_DAYS = 180;
const WATCH_SESSION_BUCKET_MS = 6 * 60 * 60 * 1000;
const CLIENT_PROFILES = [
  { id: "yamby", label: "Yamby Android", ua: "Yamby/2.0.4.3(Android", client: "Yamby", version: "2.0.4.3", device: DEFAULT_DEVICE_NAME, authStyle: "yamby", idFormat: "uuid" },
  { id: "hills_android", label: "Hills Android", ua: "Hills/1.7.1 (android; 15)", client: "Hills", version: "1.7.1", device: "OnePlus-PKG110", idLength: 16 },
  { id: "hills_windows", label: "Hills Windows", ua: "Hills Windows/1.2.4 (windows; 19041.vb_release.191206-1406)", client: "Hills Windows", version: "1.2.4", device: DEFAULT_DEVICE_NAME, idLength: 32 }
];

let schemaReady;
let identityStatePromise;
let traceEgressCache = { expires: 0, data: null };
let traceEgressPromise;
let nodeHostMapCache = { expires: 0, map: null };

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (err) {
      return json({ ok: false, error: errMessage(err) }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  }
};

async function handleScheduled(env) {
  await ensureSchema(env);
  return Promise.allSettled([
    cleanOldVisitorLogs(env),
    cleanOldWatchSessions(env),
    runAutomaticSimulatedWatches(env),
    sendKeepaliveReminders(env),
    sendTelegramDailyIfDue(env)
  ]);
}

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);

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
    return html(adminHTML(env));
  }
  if (url.pathname === "/api/tg-webhook" && request.method === "POST") {
    await ensureSchema(env);
    return handleTelegramWebhook(request, env);
  }
  if (url.pathname.startsWith("/api/")) {
    await ensureSchema(env);
    return handleAPI(request, env, ctx);
  }

  await ensureSchema(env);
  return handleProxy(request, env, ctx);
}

async function ensureSchema(env) {
  if (!env.DB) {
    throw new Error("D1 binding DB is not configured");
  }
  if (!schemaReady) {
    schemaReady = initializeSchema(env);
  }
  return schemaReady;
}

async function initializeSchema(env) {
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
    `CREATE TABLE IF NOT EXISTS watch_sessions (
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
    `CREATE INDEX IF NOT EXISTS idx_watch_sessions_day ON watch_sessions(day, counted)`,
    `CREATE INDEX IF NOT EXISTS idx_watch_sessions_last ON watch_sessions(last_ts)`
  ];
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
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
    renew_days: "INTEGER DEFAULT 0",
    remind_before_days: "INTEGER DEFAULT 0",
    keepalive_at: "TEXT DEFAULT ''",
    auto_watch: "INTEGER DEFAULT 0",
    watch_username: "TEXT DEFAULT ''",
    watch_password: "TEXT DEFAULT ''",
    watch_token: "TEXT DEFAULT ''",
    watch_user_id: "TEXT DEFAULT ''",
    watch_item_id: "TEXT DEFAULT ''",
    watch_seconds: "INTEGER DEFAULT 300",
    created_at: "INTEGER NOT NULL DEFAULT 0",
    updated_at: "INTEGER NOT NULL DEFAULT 0"
  });
  await ensureColumns(env, "visitor_logs", {
    ip: "TEXT DEFAULT ''",
    country: "TEXT DEFAULT ''",
    ua: "TEXT DEFAULT ''",
    method: "TEXT DEFAULT ''",
    path: "TEXT DEFAULT ''",
    status: "INTEGER DEFAULT 0"
  });
  await ensureColumns(env, "request_stats", {
    bytes: "INTEGER DEFAULT 0",
    updated_at: "INTEGER NOT NULL DEFAULT 0"
  });
  await ensureColumns(env, "watch_sessions", {
    user_id: "TEXT DEFAULT ''",
    item_id: "TEXT DEFAULT ''",
    play_session_id: "TEXT DEFAULT ''",
    device_id: "TEXT DEFAULT ''",
    max_position_seconds: "INTEGER DEFAULT 0",
    duration_seconds: "INTEGER DEFAULT 0",
    event_count: "INTEGER DEFAULT 0",
    counted: "INTEGER DEFAULT 0",
    synthetic: "INTEGER DEFAULT 0",
    updated_at: "INTEGER NOT NULL DEFAULT 0"
  });
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
    return json(await resetKeepalive(env, body));
  }
  if (url.pathname === "/api/simulated-watch" && request.method === "POST") {
    const body = await readJSON(request);
    return json(await runSimulatedWatch(env, body));
  }
  if (url.pathname === "/api/nodes" && request.method === "GET") {
    return json({ ok: true, nodes: await listNodesWithKeepalive(env) });
  }
  if (url.pathname === "/api/nodes" && request.method === "POST") {
    const body = await readJSON(request);
    const saved = await saveNode(env, body);
    return json({ ok: true, node: publicNode(saved) });
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
    return json({ ok: true, version: BUILD_VERSION, nodes: (await listNodes(env)).map(publicNode) });
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

  const node = await getNode(env, parsed.name);
  if (!node || !node.enabled) {
    return text("Node not found", 404);
  }

  const route = applyNodeSecret(parsed, node);
  if (!route.ok) {
    return text("Node not found", 404);
  }

  const bodyBuffer = await retryableBody(request);
  if (route.path.startsWith("/__raw__/")) {
    return handleRawProxy(request, env, ctx, node, route.path, bodyBuffer, inboundURL);
  }

  const targets = selectTargets(node, route.path);
  if (targets.length === 0) {
    return text("Node has no target", 502);
  }

  let lastError = "";
  let lastResponse;
  let lastResponseURL;
  for (const target of targets) {
    try {
      const targetURL = buildTargetURL(target, route.path, inboundURL.search);
      const shouldRedirect = shouldUseDirectStream(node, request, route.path);
      if (shouldRedirect) {
        ctx.waitUntil(recordRequest(env, request, node.name, route.path, 302, 0, "stream_direct", bodyBuffer));
        return Response.redirect(targetURL.toString(), 302);
      }

      const outbound = await buildOutboundRequest(request, targetURL, node, bodyBuffer, env);
      const cacheableImage = node.cacheImage && request.method === "GET" && isImageRequest(route.path);
      if (cacheableImage) {
        const cached = await caches.default.match(outbound);
        if (cached) {
          ctx.waitUntil(recordRequest(env, request, node.name, route.path, cached.status, contentLength(cached), "image", bodyBuffer));
          return cached;
        }
      }

      const upstream = await fetch(outbound);
      if (isRetryableStatus(upstream.status) && targets.length > 1) {
        lastResponse = upstream;
        lastResponseURL = targetURL;
        continue;
      }

      const response = await finishProxyResponse(upstream, request, node, targetURL, inboundURL, env);
      if (cacheableImage && response.ok) {
        ctx.waitUntil(caches.default.put(outbound, response.clone()));
      }
      return recordProxyResponse(ctx, env, request, node.name, route.path, response, requestKind(route.path, response, request), bodyBuffer);
    } catch (err) {
      lastError = errMessage(err);
    }
  }

  if (lastResponse) {
    return finishProxyResponse(lastResponse, request, node, lastResponseURL || buildTargetURL(targets[0], route.path, inboundURL.search), inboundURL, env);
  }
  return text("Line failover exhausted. Last Error: " + lastError, 502);
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
  const targets = path && isStreamingPath(path) && node.streamTarget
    ? splitTargets(node.streamTarget)
    : splitTargets(node.targets);
  return targets.filter((target) => /^https?:\/\//i.test(target));
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

async function handleRawProxy(request, env, ctx, node, routePath, bodyBuffer, inboundURL) {
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
  const targetURL = new URL(raw);
  if (request.url.includes("?") && !targetURL.search) {
    targetURL.search = new URL(request.url).search;
  }
  const upstream = await fetchRawWithRetries(request, targetURL, node, bodyBuffer, env);
  const response = await finishProxyResponse(upstream, request, node, targetURL, inboundURL, env);
  return recordProxyResponse(ctx, env, request, node.name, targetURL.pathname, response, requestKind(targetURL.pathname, response, request), bodyBuffer);
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
    const outbound = await buildOutboundRequest(request, targetURL, node, bodyBuffer, env, { directMode });
    last = await fetch(outbound);
    if (last.status !== 403 || !bodyCanRetry(bodyBuffer)) {
      return last;
    }
  }
  return last;
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

async function buildHeaders(request, targetURL, node, env, options = {}) {
  const headers = new Headers(request.headers);
  stripHopByHop(headers);
  const streaming = isPlaybackStreamRequest(request, targetURL);
  if (!streaming) {
    deleteHeaders(headers, ["Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User"]);
  }

  const clientIP = request.headers.get("cf-connecting-ip") || "";
  const mode = node.headerMode || "dual";
  if (mode === "realip_only" || mode === "dual" || mode === "strict") {
    if (clientIP) {
      headers.set("X-Real-IP", clientIP);
      headers.set("X-Forwarded-For", clientIP);
    }
    headers.set("X-Forwarded-Proto", "https");
  }

  if (node.impersonate !== false) {
    const identityState = await getIdentityState(env);
    applyClientProfileToURL(targetURL, headers, node.clientProfile || DEFAULT_CLIENT_PROFILE, identityState);
    applyClientProfile(headers, node.clientProfile || DEFAULT_CLIENT_PROFILE, true, identityState);
  }
  if (mode === "strict") {
    headers.set("Origin", targetURL.origin);
    headers.set("Referer", targetURL.origin + "/");
  }
  if (options.directMode) {
    applyDirectAdapterHeaders(headers, targetURL, options.directMode);
  }
  return headers;
}

function applyClientProfile(headers, profile, overwrite, identityState) {
  const values = profileSnapshot(profile, identityState);
  promoteAuthorizationTokenFromHeaders(headers);
  rewriteIdentityHeaders(headers, values);
  setHeader(headers, "User-Agent", values.ua, overwrite);
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
    device: DEFAULT_DEVICE_NAME,
    deviceId: state.deviceId || stableDeviceID(item),
    authStyle: item.authStyle || "quoted"
  };
}

function applyClientProfileToURL(targetURL, headers, profile, identityState) {
  const snap = profileSnapshot(profile, identityState);
  if (snap.authStyle === "yamby") {
    promoteYambyQueryAuth(targetURL, headers);
    promoteAuthorizationTokenFromHeaders(headers);
    return;
  }
  promoteQueryAuthorizationToken(targetURL, headers);
  rewriteIdentityQuery(targetURL, snap);
}

function rewriteIdentityHeaders(headers, snap) {
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
    identityStatePromise = loadIdentityState(env);
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
    await env.DB.prepare(`
      INSERT INTO system_config (k, v, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
    `).bind(IDENTITY_KEY, JSON.stringify(normalized), Date.now()).run();
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
  const deviceName = DEFAULT_DEVICE_NAME;
  let deviceId = cleanString(raw.deviceId || "").toLowerCase();
  if (!validDeviceID(profile, deviceId)) {
    deviceId = randomDeviceID(profile);
  }
  return { deviceName, deviceId };
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

async function finishProxyResponse(upstream, request, node, targetURL, inboundURL, env) {
  const headers = new Headers(upstream.headers);
  stripResponseHeaders(headers);
  rewriteLocation(headers, targetURL, inboundURL, node);
  rewriteSetCookie(headers, node);
  applyResponsePolicy(headers, upstream, request, targetURL);

  if (shouldRewriteBody(upstream, request)) {
    const length = Number(upstream.headers.get("content-length") || "0");
    if (!length || length <= DEFAULT_MAX_REWRITE_BYTES) {
      const textBody = await upstream.text();
      const rewritten = await rewriteResponseText(textBody, targetURL, inboundURL, node, env, headers);
      headers.delete("content-length");
      return new Response(rewritten, { status: upstream.status, statusText: upstream.statusText, headers });
    }
  }

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function shouldRewriteBody(response, request) {
  if (request.method === "HEAD" || !response.body) {
    return false;
  }
  const type = (response.headers.get("content-type") || "").toLowerCase();
  const uri = new URL(request.url).pathname.toLowerCase();
  return type.includes("application/json") ||
    type.includes("text/plain") ||
    type.includes("mpegurl") ||
    type.includes("dash+xml") ||
    uri.includes("/playbackinfo") ||
    uri.includes("/system/info");
}

async function rewriteResponseText(body, targetURL, inboundURL, node, env, headers) {
  if ((headers.get("content-type") || "").toLowerCase().includes("application/json") && isSystemInfoPath(new URL(inboundURL).pathname)) {
    return rewriteSystemInfo(body, publicNodeBase(inboundURL, node));
  }
  return rewriteBodyLinks(body, targetURL, inboundURL, node, env);
}

async function rewriteBodyLinks(body, targetURL, inboundURL, node, env) {
  const publicBase = publicNodeBase(inboundURL, node);
  const publicURL = new URL(publicBase);
  const currentHosts = new Set(splitTargets(node.targets).map((target) => {
    try {
      return new URL(target).host.toLowerCase();
    } catch {
      return "";
    }
  }).filter(Boolean));
  if (targetURL?.host) {
    currentHosts.add(targetURL.host.toLowerCase());
  }
  const hostMap = await nodeHostMap(env);
  const replacements = new Map();
  for (const full of uniqueMatches(body, /https?:\/\/[^\s"'<>\\]+/gi)) {
    let url;
    try {
      url = new URL(full);
    } catch {
      continue;
    }
    if (url.origin === inboundURL.origin && (url.pathname === new URL(publicBase).pathname || url.pathname.startsWith(new URL(publicBase).pathname + "/"))) {
      continue;
    }
    const host = url.host.toLowerCase();
    if (currentHosts.has(host)) {
      replacements.set(full, publicBase + url.pathname + url.search + url.hash);
    } else if (hostMap.has(host)) {
      const matched = hostMap.get(host);
      replacements.set(full, publicRouteBase(inboundURL.origin, matched) + url.pathname + url.search + url.hash);
    } else if (!node.directExternal) {
      replacements.set(full, publicBase + "/__raw__/" + encodeURIComponent(full));
    }
  }
  let out = body;
  for (const [from, to] of replacements) {
    out = out.split(from).join(to);
  }
  out = rewriteRelativeMediaPaths(out, publicURL.pathname, publicBase);
  return out;
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

function rewriteLocation(headers, targetURL, inboundURL, node) {
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
      headers.set("location", publicBase + "/__raw__/" + encodeURIComponent(abs.toString()));
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
    headers.delete("Vary");
    headers.set("Cache-Control", "public, max-age=2592000, s-maxage=2592000, immutable");
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
  // Auto mode is intentionally conservative in this first version.
  return Boolean(node.directExternal);
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
  if (isPlaybackControlPath(path)) {
    return "playback_event";
  }
  if (isPlaybackMetaPath(path)) {
    return "playback_meta";
  }
  if (isPlaybackStreamPath(path, request)) {
    return "stream_proxy";
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
  return request.arrayBuffer();
}

async function listNodes(env) {
  const { results } = await env.DB.prepare(`
    SELECT * FROM nodes ORDER BY sort_order ASC, name ASC
  `).all();
  return (results || []).map(rowToNode);
}

async function listNodesWithKeepalive(env) {
  const nodes = await listNodes(env);
  const statuses = await keepaliveStatusMap(env, nodes);
  return nodes.map((node) => publicNode({ ...node, keepalive: statuses.get(node.name) || null }));
}

async function getNode(env, name) {
  const row = await env.DB.prepare(`SELECT * FROM nodes WHERE name = ?`).bind(normalizeName(name)).first();
  return row ? rowToNode(row) : null;
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
  await env.DB.prepare(`
    INSERT INTO nodes (
      name, display_name, targets, stream_target, secret, client_profile, impersonate,
      header_mode, stream_mode, direct_external, cache_image, tag, remark,
      icon, sort_order, enabled, renew_days, remind_before_days, keepalive_at,
      auto_watch, watch_username, watch_password, watch_token, watch_user_id,
      watch_item_id, watch_seconds, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      renew_days = excluded.renew_days,
      remind_before_days = excluded.remind_before_days,
      keepalive_at = excluded.keepalive_at,
      auto_watch = excluded.auto_watch,
      watch_username = excluded.watch_username,
      watch_password = excluded.watch_password,
      watch_token = excluded.watch_token,
      watch_user_id = excluded.watch_user_id,
      watch_item_id = excluded.watch_item_id,
      watch_seconds = excluded.watch_seconds,
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
    node.renewDays,
    node.remindBeforeDays,
    node.keepaliveAt,
    node.autoWatch ? 1 : 0,
    node.watchUsername,
    node.watchPassword,
    node.watchToken,
    node.watchUserId,
    node.watchItemId,
    node.watchSeconds,
    current?.createdAt || now,
    now
  ).run();
  if (oldName && oldName !== node.name) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM nodes WHERE name = ?`).bind(oldName),
      env.DB.prepare(`DELETE FROM keepalive_state WHERE node = ?`).bind(node.name),
      env.DB.prepare(`UPDATE keepalive_state SET node = ? WHERE node = ?`).bind(node.name, oldName)
    ]);
  }
  await ensureKeepaliveState(env, node);
  invalidateNodeHostMapCache();
  return node;
}

async function deleteNode(env, name) {
  const nodeName = normalizeName(name);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM nodes WHERE name = ?`).bind(nodeName),
    env.DB.prepare(`DELETE FROM keepalive_state WHERE node = ?`).bind(nodeName)
  ]);
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
    directExternal: Boolean(row.direct_external),
    cacheImage: row.cache_image !== 0,
    tag: row.tag || "",
    remark: row.remark || "",
    icon: row.icon || "",
    sortOrder: Number(row.sort_order || 0),
    enabled: row.enabled !== 0,
    renewDays: Number(row.renew_days || 0),
    remindBeforeDays: Number(row.remind_before_days || 0),
    keepaliveAt: row.keepalive_at || "",
    autoWatch: Boolean(row.auto_watch),
    watchUsername: row.watch_username || "",
    watchPassword: row.watch_password || "",
    watchToken: row.watch_token || "",
    watchUserId: row.watch_user_id || "",
    watchItemId: row.watch_item_id || "",
    watchSeconds: Number(row.watch_seconds || DEFAULT_SIMULATED_WATCH_SECONDS),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  };
}

function publicNode(node) {
  return {
    ...node,
    watchPassword: "",
    watchToken: "",
    watchPasswordSet: Boolean(node.watchPassword),
    watchTokenSet: Boolean(node.watchToken),
    watchConfigured: hasSimulatedWatchCredentials(node)
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
    directExternal: boolValue(input.directExternal ?? input.direct_external ?? current?.directExternal ?? false),
    cacheImage: boolValue(input.cacheImage ?? input.cache_image ?? current?.cacheImage ?? true),
    tag: cleanString(input.tag ?? current?.tag ?? ""),
    remark: cleanString(input.remark ?? current?.remark ?? ""),
    icon: cleanString(input.icon ?? current?.icon ?? "") || DEFAULT_NODE_ICON,
    sortOrder: intValue(input.sortOrder ?? input.sort_order ?? current?.sortOrder ?? 0),
    enabled: boolValue(input.enabled ?? current?.enabled ?? true),
    renewDays: intValue(input.renewDays ?? input.renew_days ?? current?.renewDays ?? 0),
    remindBeforeDays: intValue(input.remindBeforeDays ?? input.remind_before_days ?? current?.remindBeforeDays ?? 0),
    keepaliveAt: cleanString(input.keepaliveAt ?? input.keepalive_at ?? current?.keepaliveAt ?? ""),
    autoWatch: boolValue(input.autoWatch ?? input.auto_watch ?? current?.autoWatch ?? false),
    watchUsername: cleanString(input.watchUsername ?? input.watch_username ?? current?.watchUsername ?? ""),
    watchPassword: credentialValue(input.watchPassword ?? input.watch_password, current?.watchPassword),
    watchToken: credentialValue(input.watchToken ?? input.watch_token, current?.watchToken),
    watchUserId: cleanString(input.watchUserId ?? input.watch_user_id ?? current?.watchUserId ?? ""),
    watchItemId: cleanString(input.watchItemId ?? input.watch_item_id ?? current?.watchItemId ?? ""),
    watchSeconds: clampNumber(input.watchSeconds ?? input.watch_seconds ?? current?.watchSeconds ?? DEFAULT_SIMULATED_WATCH_SECONDS, MIN_SIMULATED_WATCH_SECONDS, 7200),
    createdAt: current?.createdAt || now,
    updatedAt: now
  };
}

async function getStats(env) {
  const day = beijingDay();
  const rows = await env.DB.prepare(`
    SELECT node, kind, count, bytes FROM request_stats WHERE day = ? ORDER BY count DESC
  `).bind(day).all();
  const watches = await env.DB.prepare(`
    SELECT node, COUNT(*) AS count, MAX(last_ts) AS last_ts, SUM(max_position_seconds) AS seconds
    FROM watch_sessions
    WHERE day = ? AND counted = 1 AND synthetic = 0
    GROUP BY node
    ORDER BY count DESC
  `).bind(day).all();
  const recentWatches = await env.DB.prepare(`
    SELECT node, user_id, item_id, play_session_id, first_ts, last_ts, max_position_seconds
    FROM watch_sessions
    WHERE counted = 1 AND synthetic = 0
    ORDER BY last_ts DESC LIMIT 20
  `).all();
  const recent = await env.DB.prepare(`
    SELECT node, ts, ip, country, ua, method, path, status
    FROM visitor_logs ORDER BY ts DESC LIMIT 30
  `).all();
  return { day, today: rows.results || [], watches: watches.results || [], recentWatches: recentWatches.results || [], recent: recent.results || [] };
}

function recordProxyResponse(ctx, env, request, nodeName, path, response, kind, bodyBuffer) {
  if (kind === "stream_proxy" && response.body) {
    const counted = countResponseBytes(response);
    ctx.waitUntil(counted.bytesPromise
      .then((bytes) => recordRequest(env, request, nodeName, path, response.status, bytes, kind, bodyBuffer))
      .catch((err) => console.log("record stream bytes error", errMessage(err))));
    return counted.response;
  }
  ctx.waitUntil(recordRequest(env, request, nodeName, path, response.status, contentLength(response), kind, bodyBuffer));
  return response;
}

function countResponseBytes(response) {
  const reader = response.body.getReader();
  let total = 0;
  let settled = false;
  let settle;
  const bytesPromise = new Promise((resolve) => {
    settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
  });
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          settle(total);
          controller.close();
          return;
        }
        total += chunk.value?.byteLength || chunk.value?.length || 0;
        controller.enqueue(chunk.value);
      } catch (err) {
        settle(total);
        throw err;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle(total);
      }
    }
  });
  return {
    response: new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers)
    }),
    bytesPromise
  };
}

async function recordRequest(env, request, nodeName, path, status, bytes, kind, bodyBuffer) {
  const now = Date.now();
  const day = beijingDay(now);
  const ip = request.headers.get("cf-connecting-ip") || "";
  const country = request.headers.get("cf-ipcountry") || "";
  const ua = request.headers.get("user-agent") || "";
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO request_stats (node, day, kind, count, bytes, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(node, day, kind) DO UPDATE SET
        count = count + 1,
        bytes = bytes + excluded.bytes,
        updated_at = excluded.updated_at
    `).bind(nodeName, day, kind, bytes || 0, now),
    env.DB.prepare(`
      INSERT INTO visitor_logs (node, ts, ip, country, ua, method, path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(nodeName, now, ip, country, ua.slice(0, 300), request.method, path.slice(0, 500), status)
  ]);
  if (kind === "playback_event" && status < 400) {
    await recordWatchSession(env, request, nodeName, path, status, bodyBuffer, now);
  }
}

async function recordWatchSession(env, request, nodeName, path, status, bodyBuffer, now) {
  if (!env.DB || status >= 400 || !isPlaybackControlPath(path)) {
    return;
  }
  const event = parsePlaybackEvent(request, bodyBuffer, now);
  if (!event || !event.itemId) {
    return;
  }
  const day = beijingDay(now);
  const counted = event.positionSeconds >= watchCountMinSeconds(env) ? 1 : 0;
  await env.DB.prepare(`
    INSERT INTO watch_sessions (
      node, day, session_key, user_id, item_id, play_session_id, device_id,
      first_ts, last_ts, max_position_seconds, duration_seconds, event_count,
      counted, synthetic, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?)
    ON CONFLICT(node, day, session_key) DO UPDATE SET
      user_id = CASE WHEN excluded.user_id != '' THEN excluded.user_id ELSE watch_sessions.user_id END,
      item_id = CASE WHEN excluded.item_id != '' THEN excluded.item_id ELSE watch_sessions.item_id END,
      play_session_id = CASE WHEN excluded.play_session_id != '' THEN excluded.play_session_id ELSE watch_sessions.play_session_id END,
      device_id = CASE WHEN excluded.device_id != '' THEN excluded.device_id ELSE watch_sessions.device_id END,
      last_ts = MAX(watch_sessions.last_ts, excluded.last_ts),
      max_position_seconds = MAX(watch_sessions.max_position_seconds, excluded.max_position_seconds),
      duration_seconds = MAX(watch_sessions.duration_seconds, excluded.duration_seconds),
      event_count = watch_sessions.event_count + 1,
      counted = CASE WHEN watch_sessions.counted = 1 OR excluded.counted = 1 THEN 1 ELSE 0 END,
      updated_at = excluded.updated_at
  `).bind(
    nodeName,
    day,
    event.sessionKey,
    event.userId,
    event.itemId,
    event.playSessionId,
    event.deviceId,
    now,
    now,
    event.positionSeconds,
    event.durationSeconds,
    counted,
    now
  ).run();
  if (counted) {
    await markKeepalivePlayback(env, nodeName, now);
  }
}

function parsePlaybackEvent(request, bodyBuffer, now) {
  const body = parseJSONBody(bodyBuffer);
  const url = new URL(request.url);
  const headers = request.headers;
  const itemId = cleanString(
    body.ItemId || body.ItemID || body.itemId ||
    body.NowPlayingItem?.Id || body.Item?.Id ||
    (Array.isArray(body.ItemIds) ? body.ItemIds[0] : "") ||
    url.searchParams.get("ItemId")
  );
  const userId = cleanString(
    body.UserId || body.UserID || body.userId || body.User?.Id ||
    url.searchParams.get("UserId") ||
    headers.get("X-Emby-UserId") ||
    headers.get("X-MediaBrowser-UserId")
  );
  const playSessionId = cleanString(
    body.PlaySessionId || body.PlaySessionID || body.playSessionId ||
    url.searchParams.get("PlaySessionId")
  );
  const deviceId = cleanString(
    body.DeviceId || body.DeviceID || body.deviceId ||
    url.searchParams.get("DeviceId") ||
    headers.get("X-Emby-Device-Id") ||
    headers.get("X-Emby-DeviceId") ||
    headers.get("X-MediaBrowser-DeviceId")
  );
  if (!itemId && !playSessionId) {
    return null;
  }
  const positionSeconds = ticksToSeconds(body.PositionTicks ?? body.positionTicks ?? body.Position ?? body.position ?? 0);
  const durationSeconds = ticksToSeconds(
    body.RunTimeTicks ?? body.DurationTicks ?? body.Item?.RunTimeTicks ?? body.NowPlayingItem?.RunTimeTicks ?? 0
  );
  const actor = userId || deviceId || simpleHash(`${headers.get("user-agent") || ""}|${headers.get("cf-connecting-ip") || ""}`);
  const bucket = Math.floor(now / WATCH_SESSION_BUCKET_MS);
  const sessionKey = simpleHash([actor, itemId || "-", playSessionId || bucket].join("|"));
  return { itemId, userId, playSessionId, deviceId, positionSeconds, durationSeconds, sessionKey };
}

function parseJSONBody(bodyBuffer) {
  if (!bodyBuffer || !bodyBuffer.byteLength) {
    return {};
  }
  try {
    const textBody = new TextDecoder().decode(bodyBuffer);
    if (!/^\s*[\[{]/.test(textBody)) {
      return {};
    }
    return JSON.parse(textBody);
  } catch {
    return {};
  }
}

function ticksToSeconds(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.floor(n / EMBY_TICKS_PER_SECOND);
}

function simpleHash(value) {
  let hash = 2166136261;
  const textValue = String(value || "");
  for (let i = 0; i < textValue.length; i++) {
    hash ^= textValue.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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

async function ensureKeepaliveState(env, node) {
  if (!node?.name || !node.renewDays) {
    return;
  }
  await ensureKeepaliveTable(env);
  const anchor = parseKeepaliveAt(node.keepaliveAt) || node.createdAt || Date.now();
  await env.DB.prepare(`
    INSERT INTO keepalive_state (node, anchor_ts, last_play_ts, last_notify_day, notify_count)
    VALUES (?, ?, 0, '', 0)
    ON CONFLICT(node) DO UPDATE SET
      anchor_ts = CASE WHEN excluded.anchor_ts > 0 THEN excluded.anchor_ts ELSE keepalive_state.anchor_ts END
  `).bind(node.name, anchor).run();
}

async function markKeepalivePlayback(env, nodeName, ts) {
  await ensureKeepaliveTable(env);
  const node = await getNode(env, nodeName);
  const anchor = parseKeepaliveAt(node?.keepaliveAt) || node?.createdAt || ts;
  await env.DB.prepare(`
    INSERT INTO keepalive_state (node, anchor_ts, last_play_ts, last_notify_day, notify_count)
    VALUES (?, ?, ?, '', 0)
    ON CONFLICT(node) DO UPDATE SET
      last_play_ts = MAX(last_play_ts, excluded.last_play_ts)
  `).bind(normalizeName(nodeName), anchor, ts).run();
}

async function getKeepaliveStatuses(env) {
  return Array.from((await keepaliveStatusMap(env, await listNodes(env))).values());
}

async function keepaliveStatusMap(env, nodes) {
  await ensureKeepaliveTable(env);
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
      notifyCount: Number(current.notify_count || 0)
    });
  }
  return map;
}

async function resetKeepalive(env, body) {
  const name = normalizeName(body.name || "");
  if (!name) {
    return { ok: false, error: "missing node name" };
  }
  const ts = Number(body.ts || Date.now());
  await markKeepalivePlayback(env, name, Number.isFinite(ts) ? ts : Date.now());
  return { ok: true, node: name, ts };
}

async function runSimulatedWatch(env, body) {
  const name = normalizeName(body.node || body.name || "");
  if (!name) {
    return { ok: false, error: "missing node name" };
  }
  const node = await getNode(env, name);
  if (!node || !node.enabled) {
    return { ok: false, error: "node not found or disabled" };
  }
  const targets = selectTargets(node, "/");
  if (!targets.length) {
    return { ok: false, error: "node has no target" };
  }

  const identityState = await getIdentityState(env);
  const snap = profileSnapshot(node.clientProfile || DEFAULT_CLIENT_PROFILE, identityState);
  const requestedTarget = cleanString(body.target || "");
  const target = requestedTarget && targets.includes(requestedTarget) ? requestedTarget : targets[0];
  const watchInput = simulatedWatchInput(node, body);
  const watchSeconds = clampNumber(watchInput.seconds ?? watchInput.time ?? DEFAULT_SIMULATED_WATCH_SECONDS, MIN_SIMULATED_WATCH_SECONDS, 7200);
  const credentials = await resolveSimulatedWatchCredentials(target, snap, watchInput);
  if (!credentials.ok) {
    return credentials;
  }

  const requestedItemId = cleanString(watchInput.itemId || watchInput.item_id || watchInput.playId || watchInput.play_id);
  const item = requestedItemId
    ? await embyJSON(target, `/Users/${encodeURIComponent(credentials.userId)}/Items/${encodeURIComponent(requestedItemId)}`, {}, snap, credentials)
    : await pickSimulatedWatchItem(target, snap, credentials);
  if (!item?.Id) {
    return { ok: false, error: "no playable item found" };
  }

  const playback = await startSimulatedPlayback(target, snap, credentials, item, watchSeconds);
  if (playback.ok) {
    await markKeepalivePlayback(env, node.name, Date.now());
  }
  await recordSyntheticPlayback(env, node.name, `/Sessions/Playing/Progress`, playback.status, playback.bytes, snap.ua);
  return {
    ok: playback.ok,
    node: node.name,
    target,
    clientProfile: node.clientProfile,
    client: snap.client,
    device: snap.device,
    deviceId: snap.deviceId,
    item: { id: item.Id, name: item.Name || "" },
    seconds: watchSeconds,
    progressReports: playback.progressReports,
    actualDelaySeconds: playback.actualDelaySeconds,
    streamBytes: playback.bytes,
    status: playback.status
  };
}

function simulatedWatchInput(node, body = {}) {
  return {
    username: cleanString(body.username) || node.watchUsername || "",
    password: cleanString(body.password) || node.watchPassword || "",
    token: cleanString(body.token || body.accessToken || body.access_token) || node.watchToken || "",
    userId: cleanString(body.userId || body.user_id) || node.watchUserId || "",
    itemId: cleanString(body.itemId || body.item_id || body.playId || body.play_id) || node.watchItemId || "",
    seconds: body.seconds ?? body.time ?? node.watchSeconds ?? DEFAULT_SIMULATED_WATCH_SECONDS
  };
}

function hasSimulatedWatchCredentials(node) {
  return Boolean(node?.watchToken || (node?.watchUsername && node?.watchPassword));
}

async function runAutomaticSimulatedWatches(env) {
  if (!env.DB) {
    return { ok: false, skipped: true };
  }
  await ensureSchema(env);
  const nodes = await listNodes(env);
  const statuses = await keepaliveStatusMap(env, nodes);
  const day = beijingDay();
  let attempted = 0;
  const results = [];
  const attemptedNodes = new Set();
  for (const node of nodes) {
    if (attempted >= MAX_AUTO_SIMULATED_WATCHES_PER_CRON) {
      break;
    }
    if (attemptedNodes.has(node.name)) {
      continue;
    }
    const status = statuses.get(node.name);
    if (!node.enabled || !node.renewDays || !node.autoWatch || !status) {
      continue;
    }
    if (!["warn", "due"].includes(status.status) || !hasSimulatedWatchCredentials(node)) {
      continue;
    }
    const key = AUTO_WATCH_DAILY_PREFIX + node.name;
    const last = await getKV(env, key);
    if (last === day) {
      continue;
    }
    attempted++;
    attemptedNodes.add(node.name);
    try {
      const result = await runSimulatedWatch(env, { node: node.name, auto: true });
      if (result.ok) {
        await setKV(env, key, day);
      }
      results.push({ node: node.name, ok: result.ok, status: result.status, error: result.error || "" });
    } catch (err) {
      results.push({ node: node.name, ok: false, error: errMessage(err) });
    }
  }
  return { ok: true, attempted, results };
}

async function resolveSimulatedWatchCredentials(target, snap, body) {
  let token = cleanString(body.token || body.accessToken || body.access_token);
  let userId = cleanString(body.userId || body.user_id);
  const username = cleanString(body.username);
  const password = cleanString(body.password);
  if (!token && username && password) {
    const res = await embyRaw(target, "/Users/AuthenticateByName", {
      method: "POST",
      body: JSON.stringify({ Username: username, Pw: password })
    }, snap, { token: "", userId: "" });
    if (!res.ok) {
      return { ok: false, error: `login failed: ${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    token = cleanString(data.AccessToken);
    userId = cleanString(data.User?.Id || userId);
  }
  if (!token) {
    return { ok: false, error: "missing token or username/password" };
  }
  const credentials = { token, userId };
  if (!credentials.userId) {
    const me = await embyJSON(target, "/Users/Me", {}, snap, credentials).catch(() => null);
    credentials.userId = cleanString(me?.Id);
  }
  if (!credentials.userId) {
    return { ok: false, error: "missing userId and /Users/Me did not return one" };
  }
  return { ok: true, token: credentials.token, userId: credentials.userId };
}

async function pickSimulatedWatchItem(target, snap, credentials) {
  const userId = encodeURIComponent(credentials.userId);
  const views = await embyJSON(target, `/Users/${userId}/Views`, {
    params: { IncludeExternalContent: "false" }
  }, snap, credentials).catch(() => ({}));
  const collectionIds = (views.Items || [])
    .filter((item) => ["movies", "tvshows"].includes(String(item.CollectionType || "").toLowerCase()))
    .map((item) => item.Id)
    .filter(Boolean);
  const candidates = [];
  for (const parentId of collectionIds.slice(0, 8)) {
    const latest = await embyJSON(target, `/Users/${userId}/Items/Latest`, {
      params: {
        ParentId: parentId,
        Limit: "16",
        GroupItems: "true",
        EnableImageTypes: "Primary,Backdrop,Thumb",
        Fields: "PrimaryImageAspectRatio,BasicSyncInfo,ProductionYear,Status,EndDate,CanDelete"
      }
    }, snap, credentials).catch(() => []);
    candidates.push(...(Array.isArray(latest) ? latest : []));
  }
  if (!candidates.length) {
    const resume = await embyJSON(target, `/Users/${userId}/Items/Resume`, {
      params: {
        Limit: "12",
        MediaTypes: "Video",
        Recursive: "true",
        EnableImageTypes: "Primary,Backdrop,Thumb",
        Fields: "PrimaryImageAspectRatio,BasicSyncInfo,ProductionYear,CanDelete"
      }
    }, snap, credentials).catch(() => ({}));
    candidates.push(...(resume.Items || []));
  }
  if (!candidates.length && collectionIds.length) {
    const folder = await embyJSON(target, `/Users/${userId}/Items`, {
      params: {
        ParentId: collectionIds[0],
        IncludeItemTypes: "Movie",
        Limit: "50",
        Recursive: "true",
        SortBy: "SortName",
        SortOrder: "Ascending",
        Fields: "BasicSyncInfo,CanDelete,PrimaryImageAspectRatio,ProductionYear"
      }
    }, snap, credentials).catch(() => ({}));
    candidates.push(...(folder.Items || []));
  }
  const playable = candidates.filter((item) => item?.Id && String(item.MediaType || "Video") === "Video");
  return sample(playable, 1)[0] || null;
}

async function startSimulatedPlayback(target, snap, credentials, item, seconds) {
  const itemId = String(item.Id);
  const playbackInfoData = simulatedPlaybackInfoBody();
  await embyRaw(target, `/Videos/${encodeURIComponent(itemId)}/AdditionalParts`, {
    params: {
      Fields: "PrimaryImageAspectRatio,UserData,CanDelete",
      IncludeItemTypes: "Playlist,BoxSet",
      Recursive: "true",
      SortBy: "SortName"
    }
  }, snap, credentials).catch(() => null);

  const playbackInfo = await embyJSON(target, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
    method: "POST",
    params: {
      AutoOpenLiveStream: "false",
      IsPlayback: "false",
      MaxStreamingBitrate: "40000000",
      StartTimeTicks: "0",
      UserID: credentials.userId
    },
    body: playbackInfoData
  }, snap, credentials);
  const mediaSource = playbackInfo.MediaSources?.[0] || {};
  const mediaSourceId = mediaSource.Id || randomHex(32);
  const playSessionId = playbackInfo.PlaySessionId || randomUUID().toUpperCase();

  for (let i = 0; i < 3; i++) {
    await embyRaw(target, `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
      method: "POST",
      params: {
        AudioStreamIndex: "1",
        AutoOpenLiveStream: "true",
        IsPlayback: "true",
        MaxStreamingBitrate: "42000000",
        MediaSourceId: mediaSourceId,
        StartTimeTicks: "0",
        UserID: credentials.userId
      },
      body: playbackInfoData
    }, snap, credentials);
  }

  const bytes = await warmupSimulatedStream(target, itemId, mediaSource.DirectStreamUrl, playSessionId, snap, credentials);
  await embyRaw(target, "/Sessions/Playing", {
    method: "POST",
    body: playingStatePayload({ itemId, mediaSourceId, playSessionId, tick: 0 })
  }, snap, credentials);

  const progressPlan = simulatedProgressPlan(seconds);
  let progressReports = 0;
  let actualDelaySeconds = 0;
  for (const step of progressPlan) {
    await sleep(step.delaySeconds * 1000);
    actualDelaySeconds += step.delaySeconds;
    if (step.stop) {
      continue;
    }
    const res = await embyRaw(target, "/Sessions/Playing/Progress", {
      method: "POST",
      body: playingStatePayload({ itemId, mediaSourceId, playSessionId, tick: step.tick, update: true })
    }, snap, credentials);
    if (res.ok) {
      progressReports++;
    }
  }
  const stop = await embyRaw(target, "/Sessions/Playing/Progress", {
    method: "POST",
    body: playingStatePayload({
      itemId,
      mediaSourceId,
      playSessionId,
      tick: Math.floor(seconds * 0.98) * EMBY_TICKS_PER_SECOND,
      update: true,
      stop: true
    })
  }, snap, credentials);
  return { ok: stop.ok, status: stop.status, bytes, progressReports, actualDelaySeconds };
}

async function warmupSimulatedStream(target, itemId, directStreamURL, playSessionId, snap, credentials) {
  const path = directStreamURL || `/Videos/${encodeURIComponent(itemId)}/stream`;
  const res = await embyRaw(target, path, {
    headers: {
      Range: "bytes=0-1023",
      "X-Playback-Session-Id": playSessionId,
      "User-Agent": "VLC/3.0.21 LibVLC/3.0.21"
    }
  }, snap, credentials).catch(() => null);
  if (!res?.ok && res?.status !== 206) {
    return 0;
  }
  const body = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
  return body.byteLength;
}

async function embyJSON(target, path, options, snap, credentials) {
  const res = await embyRaw(target, path, options, snap, credentials);
  if (!res.ok) {
    throw new Error(`Emby request failed: ${res.status} ${path}`);
  }
  return res.json();
}

async function embyRaw(target, path, options = {}, snap, credentials) {
  const url = embyTargetURL(target, path, options.params);
  const headers = simulatedWatchHeaders(snap, credentials, options.headers);
  const init = {
    method: options.method || "GET",
    headers,
    redirect: "follow"
  };
  if (options.body !== undefined) {
    init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  return fetch(url.toString(), init);
}

function embyTargetURL(target, path, params) {
  const rawPath = String(path || "/");
  let url;
  if (/^https?:\/\//i.test(rawPath)) {
    url = new URL(rawPath);
  } else {
    const [pathname, search = ""] = rawPath.split("?", 2);
    url = buildTargetURL(target, pathname, search ? "?" + search : "");
  }
  const query = params && typeof params === "object" ? params : {};
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function simulatedWatchHeaders(snap, credentials, extra = {}) {
  const headers = new Headers(extra);
  if (!headers.get("User-Agent")) {
    headers.set("User-Agent", snap.ua);
  }
  if (!headers.get("Accept")) {
    headers.set("Accept", "*/*");
  }
  if (!headers.get("Accept-Language")) {
    headers.set("Accept-Language", "zh-CN,zh-Hans;q=0.9");
  }
  if (!headers.get("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("X-Emby-Authorization", simulatedAuthorization(snap, credentials));
  headers.set("X-MediaBrowser-Authorization", simulatedAuthorization(snap, credentials));
  if (credentials?.token) {
    headers.set("X-Emby-Token", sanitizeHeaderValue(credentials.token));
    headers.set("X-MediaBrowser-Token", sanitizeHeaderValue(credentials.token));
  }
  headers.set("X-Emby-Client", snap.client);
  headers.set("X-MediaBrowser-Client", snap.client);
  headers.set("X-Emby-Client-Version", snap.version);
  headers.set("X-MediaBrowser-Client-Version", snap.version);
  headers.set("X-Emby-Device-Name", snap.device);
  headers.set("X-MediaBrowser-Device-Name", snap.device);
  headers.set("X-Emby-Device-Id", snap.deviceId);
  headers.set("X-MediaBrowser-Device-Id", snap.deviceId);
  return headers;
}

function simulatedAuthorization(snap, credentials) {
  const fields = [
    ["Token", credentials?.token || ""],
    ["Emby UserId", credentials?.userId || ""],
    ["Client", snap.client],
    ["Device", snap.device],
    ["DeviceId", snap.deviceId],
    ["Version", snap.version]
  ];
  return "MediaBrowser " + fields
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}="${escapeAuthField(value)}"`)
    .join(", ");
}

function playingStatePayload({ itemId, mediaSourceId, playSessionId, tick, update = false, stop = false }) {
  const queue = stop ? [] : [{ Id: String(itemId), PlaylistItemId: "playlistItem0" }];
  return {
    SubtitleOffset: 0,
    MaxStreamingBitrate: 420000000,
    MediaSourceId: String(mediaSourceId),
    SubtitleStreamIndex: -1,
    VolumeLevel: 100,
    PlaybackRate: 1,
    PlaybackStartTimeTicks: Math.floor(Date.now() / 10000) * 10 * EMBY_TICKS_PER_SECOND,
    PositionTicks: Number(tick || 0),
    PlaySessionId: playSessionId,
    ...(update ? { EventName: "timeupdate" } : {}),
    PlaylistLength: 1,
    NowPlayingQueue: queue,
    IsMuted: false,
    PlaylistIndex: 0,
    ItemId: String(itemId),
    RepeatMode: "RepeatNone",
    AudioStreamIndex: -1,
    PlayMethod: "DirectStream",
    CanSeek: true,
    IsPaused: false
  };
}

function simulatedProgressPlan(seconds) {
  const total = Math.max(MIN_SIMULATED_WATCH_SECONDS, Number(seconds || DEFAULT_SIMULATED_WATCH_SECONDS));
  const maxRealDelay = Math.max(MIN_PROGRESS_DELAY_SECONDS + 20, Math.min(180, Math.floor(total / 2)));
  const reportCount = Math.max(1, Math.min(5, Math.floor(total / MIN_PROGRESS_DELAY_SECONDS) - 1));
  const steps = [];
  let elapsed = 0;
  for (let i = 0; i < reportCount; i++) {
    const remainingReports = reportCount - i;
    const maxForStep = Math.max(
      MIN_PROGRESS_DELAY_SECONDS,
      Math.min(maxRealDelay, Math.floor((total * 0.9 - elapsed - remainingReports * MIN_PROGRESS_DELAY_SECONDS) + MIN_PROGRESS_DELAY_SECONDS))
    );
    const delaySeconds = randomInt(MIN_PROGRESS_DELAY_SECONDS, maxForStep);
    elapsed += delaySeconds;
    const jitter = randomInt(-8, 12);
    const positionSeconds = Math.max(1, Math.min(Math.floor(total * 0.92), elapsed + jitter));
    steps.push({ delaySeconds, tick: positionSeconds * EMBY_TICKS_PER_SECOND });
  }
  steps.push({ delaySeconds: randomInt(MIN_PROGRESS_DELAY_SECONDS, maxRealDelay), stop: true });
  return steps;
}

function simulatedPlaybackInfoBody() {
  return {
    DeviceProfile: {
      CodecProfiles: [
        { Type: "Video", Codec: "h264" },
        { Type: "Video", Codec: "hevc" }
      ],
      SubtitleProfiles: [
        { Method: "Embed", Format: "ass" },
        { Method: "Embed", Format: "ssa" },
        { Method: "Embed", Format: "subrip" },
        { Method: "External", Format: "subrip" },
        { Method: "External", Format: "ass" },
        { Method: "External", Format: "vtt" }
      ],
      MaxStreamingBitrate: 40000000,
      DirectPlayProfiles: [
        {
          Container: "mov,mp4,mkv,webm",
          Type: "Video",
          VideoCodec: "h264,hevc,dvhe,dvh1,hev1,mpeg4,vp9",
          AudioCodec: "aac,mp3,wav,ac3,eac3,flac,truehd,dts,dca,opus"
        }
      ],
      TranscodingProfiles: [
        {
          MinSegments: 2,
          AudioCodec: "aac,mp3,wav,ac3,eac3,flac,opus",
          VideoCodec: "hevc,h264,mpeg4",
          BreakOnNonKeyFrames: true,
          Type: "Video",
          Protocol: "hls",
          MaxAudioChannels: "6",
          Container: "ts",
          Context: "Streaming"
        }
      ],
      ContainerProfiles: [],
      ResponseProfiles: [{ MimeType: "video/mp4", Container: "m4v", Type: "Video" }],
      MusicStreamingTranscodingBitrate: 40000000,
      MaxStaticBitrate: 40000000
    }
  };
}

async function recordSyntheticPlayback(env, nodeName, path, status, bytes, ua) {
  const now = Date.now();
  const day = beijingDay(now);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO request_stats (node, day, kind, count, bytes, updated_at)
      VALUES (?, ?, 'simulated_watch', 1, 0, ?)
      ON CONFLICT(node, day, kind) DO UPDATE SET
        count = count + 1,
        updated_at = excluded.updated_at
    `).bind(nodeName, day, now),
    env.DB.prepare(`
      INSERT INTO visitor_logs (node, ts, ip, country, ua, method, path, status)
      VALUES (?, ?, 'worker', 'SIM', ?, 'POST', ?, ?)
    `).bind(nodeName, now, String(ua || "").slice(0, 300), path, status || 0)
  ]);
}

function parseKeepaliveAt(value) {
  const raw = cleanString(value);
  if (!raw) {
    return 0;
  }
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    return n < 10000000000 ? n * 1000 : n;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function cleanOldVisitorLogs(env) {
  if (!env.DB) {
    return;
  }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM visitor_logs WHERE ts < ?`).bind(cutoff).run();
}

async function cleanOldWatchSessions(env) {
  if (!env.DB) {
    return;
  }
  const cutoff = Date.now() - watchSessionRetentionDays(env) * 24 * 60 * 60 * 1000;
  await env.DB.prepare(`DELETE FROM watch_sessions WHERE last_ts < ?`).bind(cutoff).run();
}

async function pingTarget(target) {
  if (!target || !/^https?:\/\//i.test(target)) {
    return { ok: false, error: "invalid target" };
  }
  const started = Date.now();
  try {
    const base = new URL(target);
    const candidates = ["/emby/System/Info/Public", "/System/Info/Public", "/"];
    let lastStatus = 0;
    for (const path of candidates) {
      const u = new URL(base);
      u.pathname = path;
      const res = await fetch(u.toString(), { method: "GET", redirect: "manual" });
      lastStatus = res.status;
      if (res.status < 500) {
        return { ok: true, status: res.status, ms: Date.now() - started };
      }
    }
    return { ok: false, status: lastStatus, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: errMessage(err), ms: Date.now() - started };
  }
}

async function pingTargetCompat(target) {
  if (!target || !/^https?:\/\//i.test(target)) {
    return { ms: -1 };
  }
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    await fetch(target.replace(/\/+$/, "") + "/", { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    return { ms: Date.now() - started };
  } catch {
    return { ms: -1 };
  }
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
      ua: row.ua
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
  const sameType = current.records.filter((r) => r.type === type);
  for (const record of sameType) {
    await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, { method: "DELETE" });
  }

  const created = [];
  for (const content of values) {
    const data = await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type, name, content, proxied: false, ttl: 1 })
    });
    if (!data.success) {
      return { ok: false, error: cfErrors(data), created };
    }
    created.push(data.result);
  }
  await recordDNSHistory(env, name, type, sameType.map((r) => r.content).join(","), values.join(","));
  return { ok: true, name, type, created };
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
  const workerManaged = current.records.some(isWorkerManagedDNSRecord);
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
  for (const record of current.records.filter((r) => ["A", "AAAA", "CNAME"].includes(r.type))) {
    await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, { method: "DELETE" });
  }
  const created = [];
  for (const content of ips) {
    const type = dnsTypeFor(content);
    const data = await cfJSON(env, `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type, name, content, proxied: false, ttl: 60 })
    });
    if (!data.success) {
      return { success: false, ok: false, error: cfErrors(data), created };
    }
    created.push(data.result);
  }
  await recordDNSHistory(env, name, "mixed", current.records.map((r) => r.content).join(","), ips.join(","));
  return { success: true, ok: true, name, message: "DNS 更新成功", created };
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

function randomInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.max(lo, Math.floor(max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const [traffic, nodes, keepalive, dns] = await Promise.all([
    getCFTraffic(env, "today").catch((err) => ({ ok: false, error: errMessage(err) })),
    listNodesWithKeepalive(env).catch(() => []),
    getKeepaliveStatuses(env).catch(() => []),
    getDNSRecordsCompat(env).catch((err) => ({ success: false, error: errMessage(err), result: [] }))
  ]);
  const rows = stats.today || [];
  const watchRows = stats.watches || [];
  const enabled = nodes.filter((node) => node.enabled).length;
  const byKind = (kind) => rows.filter((row) => row.kind === kind);
  const sum = (items, key) => items.reduce((n, row) => n + Number(row[key] || 0), 0);
  const playbackEventRows = byKind("playback_event");
  const playbackMetaRows = byKind("playback_meta");
  const streamRows = byKind("stream_proxy");
  const imageRows = byKind("image");
  const requestRows = byKind("request");
  const directRows = byKind("stream_direct");
  const simulatedRows = byKind("simulated_watch");
  const watchCount = sum(watchRows, "count");
  const playbackEventCount = sum(playbackEventRows, "count");
  const playbackMetaCount = sum(playbackMetaRows, "count");
  const streamCount = sum(streamRows, "count");
  const streamBytes = sum(streamRows, "bytes");
  const imageCount = sum(imageRows, "count");
  const imageBytes = sum(imageRows, "bytes");
  const requestCount = sum(requestRows, "count");
  const requestBytes = sum(requestRows, "bytes");
  const directCount = sum(directRows, "count");
  const simulatedCount = sum(simulatedRows, "count");
  const statusRows = stats.recent || [];
  const recentWatches = stats.recentWatches || [];
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
    `🎬 有效观看：${watchCount} 次`,
    `🧭 播放控制：${playbackEventCount} 次 · 信息 ${playbackMetaCount} 次`,
    `💾 中转视频：${streamCount} 次 · ${formatBytes(streamBytes)}`,
    `🚀 直连跳转：${directCount} 次`,
    traffic.ok ? `🌐 全站 CF 流量：${traffic.humanBytes}` : `🌐 全站 CF 流量：${traffic.error || "未配置"}`,
    `🖼️ 图片/海报：${imageCount} 次 · ${formatBytes(imageBytes)}`,
    `📦 普通请求：${requestCount} 次 · ${formatBytes(requestBytes)}`,
    `🤖 模拟观看：${simulatedCount} 次`
  ];

  sections.playback = ["🏆 今日有效观看 TOP 5"];
  pushWatchTopRows(sections.playback, watchRows);

  sections.traffic = ["💾 今日 Worker 中转视频流量 TOP 5"];
  pushTopRows(sections.traffic, streamRows, "bytes", false);
  sections.traffic.push("", "🚀 今日直连跳转 TOP 5");
  pushCountTopRows(sections.traffic, directRows);

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

  sections.recent = ["🧾 最近有效观看"];
  if (recentWatches.length) {
    recentWatches.slice(0, 5).forEach((row, index) => {
      sections.recent.push(`${index + 1}. ${row.node} · ${formatDuration(row.max_position_seconds)} · ${formatDateTime(row.last_ts).slice(11)} · ${row.item_id || "-"}`);
    });
  } else {
    sections.recent.push("暂无有效观看记录");
  }

  const header = [
    "📡 媒体线路日报",
    `📅 ${stats.day} · ${formatDateTime(Date.now()).slice(11)} 自动汇总`
  ];
  const sectionKeys = ["today", "playback", "traffic", "keepalive", "health", "dns", "recent"];
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
      { text: "🏆 观看排行", callback_data: "report:playback" }
    ],
    [
      { text: "💾 流量排行", callback_data: "report:traffic" },
      { text: "⏰ 观看提醒", callback_data: "report:keepalive" }
    ],
    [
      { text: "🚦 线路健康", callback_data: "report:health" },
      { text: "🧭 DNS 状态", callback_data: "report:dns" }
    ],
    [
      { text: "🧾 最近播放", callback_data: "report:recent" },
      { text: section === "full" ? "🔄 刷新日报" : "📡 完整日报", callback_data: "refresh_stats" }
    ]
  ];
  if (env.CF_DOMAIN) {
    keyboard.push([{ text: "🌐 打开控制台", url: "https://" + env.CF_DOMAIN + "/admin" }]);
  }
  return { inline_keyboard: keyboard };
}

function pushWatchTopRows(lines, rows) {
  const medals = ["🥇", "🥈", "🥉"];
  const top = [...rows].sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, 5);
  if (!top.length) {
    lines.push("暂无数据");
    return;
  }
  top.forEach((row, index) => {
    const prefix = medals[index] || `${index + 1}.`;
    lines.push(`${prefix} ${row.node}：${Number(row.count || 0)} 次 · ${formatDuration(row.seconds)}`);
  });
}

function pushCountTopRows(lines, rows) {
  const medals = ["🥇", "🥈", "🥉"];
  const top = aggregateNodeRows(rows).sort((a, b) => Number(b.count || 0) - Number(a.count || 0)).slice(0, 5);
  if (!top.length) {
    lines.push("暂无数据");
    return;
  }
  top.forEach((row, index) => {
    const prefix = medals[index] || `${index + 1}.`;
    lines.push(`${prefix} ${row.node}：${Number(row.count || 0)} 次`);
  });
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
  if (!env.TG_BOT_TOKEN || !telegramChatIds(env).length || !env.DB) {
    return { ok: false, skipped: true };
  }
  const day = beijingDay();
  const statuses = await getKeepaliveStatuses(env);
  const due = statuses.filter((item) => item.status === "due" || item.status === "warn")
    .filter((item) => item.lastNotifyDay !== day);
  if (!due.length) {
    return { ok: true, skipped: true, reason: "no reminders" };
  }
  const lines = ["观看提醒", `日期: ${day}`];
  for (const item of due) {
    const tag = item.status === "due" ? "已超期" : "即将到期";
    const last = item.lastPlayTs ? formatDateTime(item.lastPlayTs) : "无真实播放记录";
    lines.push(`- ${item.displayName}: ${tag}, 剩余 ${item.remainDays} 天, 上次观看 ${last}`);
  }
  const sent = await sendTelegramReportText(env, lines.join("\n"));
  if (sent.ok) {
    await ensureKeepaliveTable(env);
    await env.DB.batch(due.map((item) => env.DB.prepare(`
      UPDATE keepalive_state
      SET last_notify_day = ?, notify_count = notify_count + 1
      WHERE node = ?
    `).bind(day, item.node)));
  }
  return { ok: sent.ok, count: due.length, result: sent };
}

async function handleTelegramWebhook(request, env) {
  if (env.TG_WEBHOOK_SECRET) {
    const got = request.headers.get("x-telegram-bot-api-secret-token") || "";
    if (got !== env.TG_WEBHOOK_SECRET) {
      return text("Forbidden", 403);
    }
  }
  if (!env.TG_BOT_TOKEN) {
    return text("OK");
  }
  try {
    const body = await request.json();
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
  const payload = {
    url: webhookURL,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  };
  if (env.TG_WEBHOOK_SECRET) {
    payload.secret_token = env.TG_WEBHOOK_SECRET;
  }
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
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`).run();
}

async function getKV(env, key) {
  await ensureKVStore(env);
  const row = await env.DB.prepare(`SELECT value FROM kv_store WHERE key = ?`).bind(key).first();
  return cleanString(row?.value);
}

async function setKV(env, key, value) {
  await ensureKVStore(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`)
    .bind(key, String(value ?? "")).run();
}

async function getTelegramLastMessageId(env, chatId) {
  if (!env.DB || !chatId) {
    return "";
  }
  return getKV(env, `tg_last_msg_id_${chatId}`);
}

async function setTelegramLastMessageId(env, chatId, messageId) {
  if (!env.DB || !chatId || !messageId) {
    return;
  }
  await setKV(env, `tg_last_msg_id_${chatId}`, messageId);
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

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds || 0)));
  if (value >= 3600) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
  }
  if (value >= 60) {
    return `${Math.floor(value / 60)} 分钟`;
  }
  return `${value} 秒`;
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

function credentialValue(value, current = "") {
  if (value === undefined || value === null) {
    return cleanString(current);
  }
  const raw = cleanString(value);
  if (!raw) {
    return cleanString(current);
  }
  if (raw === "__clear__") {
    return "";
  }
  return raw;
}

function intValue(value) {
  const n = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.min(max, Math.max(min, n));
}

function envInt(env, key, fallback, min, max) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.floor(Math.min(max, Math.max(min, n)));
}

function watchCountMinSeconds(env) {
  return envInt(env, "WATCH_COUNT_MIN_SECONDS", DEFAULT_WATCH_COUNT_MIN_SECONDS, 10, 3600);
}

function watchSessionRetentionDays(env) {
  return envInt(env, "WATCH_SESSION_RETENTION_DAYS", DEFAULT_WATCH_SESSION_RETENTION_DAYS, 7, 3650);
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
  return status >= 500 || status === 403 || status === 404 || status === 416;
}

function stripResponseHeaders(headers) {
  for (const key of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
    headers.delete(key);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, Content-Type, Location");
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

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
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

function adminHTML(env = {}) {
  const labels = JSON.stringify(Object.fromEntries(CLIENT_PROFILES.map((item) => [item.id, item.label]))).replace(/</g, "\\u003c");
  const managementDomain = cleanString(env.CF_DOMAIN || "");
  const dispatchDomain = dnsDomain(env);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<title>媒体线路控制台</title>
<style>
:root{color-scheme:light;--primary:#007aff;--primary-hover:#0066d6;--bg:#f5f5f7;--card:rgba(255,255,255,.82);--text:#1d1d1f;--text-sec:#6e6e73;--border:rgba(60,60,67,.18);--danger:#ff3b30;--ok:#34c759;--warn:#ff9500;--violet:#5856d6;--cyan:#32ade6;--radius-card:12px;--shadow:0 8px 24px rgba(0,0,0,.06)}
body.dark{color-scheme:dark;--primary:#0a84ff;--primary-hover:#409cff;--bg:#111113;--card:rgba(28,28,30,.82);--text:#f5f5f7;--text-sec:#a1a1a6;--border:rgba(235,235,245,.16);--shadow:0 10px 30px rgba(0,0,0,.24)}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{min-height:100%;margin:0;background:var(--bg);color:var(--text);font:13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-text-size-adjust:100%}
body{padding:14px 14px 88px;transition:background-color .25s,color .25s;background:linear-gradient(180deg,#fbfbfd 0,#f5f5f7 42%,#f2f2f7 100%)}
body.dark{background:linear-gradient(180deg,#141416 0,#111113 100%)}
button,input,select,textarea{font:inherit}
button{cursor:pointer}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.login-shell{min-height:calc(100vh - 28px);display:grid;place-items:center}
.login-box{width:min(340px,100%);display:grid;gap:10px}
.login-shell input{width:100%;height:42px;border:1px solid var(--border);border-radius:11px;background:var(--card);color:var(--text);padding:0 14px;text-align:center;font-size:14px;box-shadow:var(--shadow);backdrop-filter:blur(16px)}
.login-shell .btn{width:100%;height:38px;border-radius:11px}
.login-error{display:none}
.login-shell input:focus,.search-input:focus,input:focus,select:focus,textarea:focus{outline:0;border-color:var(--primary);box-shadow:0 0 0 3px rgba(0,113,227,.16)}
.app{display:none}.authed .login-shell{display:none}.authed .app{display:block}
.container{width:min(1180px,100%);margin:0 auto;display:flex;flex-direction:column;gap:12px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.brand h1{margin:0;font-size:22px;letter-spacing:0;line-height:1.12}.brand p{margin:4px 0 0;color:var(--text-sec);font-size:12px}
.actions,.toolbar,.card-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{min-height:34px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.72);color:var(--text);padding:0 11px;font-weight:650;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:.16s;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,.03);backdrop-filter:blur(14px)}
body.dark .btn{background:rgba(44,44,46,.72)}
.btn:hover{border-color:rgba(0,122,255,.36);color:var(--primary);transform:translateY(-1px);box-shadow:0 5px 14px rgba(0,0,0,.07)}
.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff;box-shadow:0 5px 14px rgba(0,122,255,.22)}
.btn.green{background:rgba(52,199,89,.1);border-color:rgba(52,199,89,.28);color:var(--ok)}.btn.orange{background:rgba(255,149,0,.1);border-color:rgba(255,149,0,.3);color:var(--warn)}.btn.violet{background:rgba(88,86,214,.1);border-color:rgba(88,86,214,.28);color:var(--violet)}.btn.cyan{background:rgba(50,173,230,.1);border-color:rgba(50,173,230,.28);color:var(--cyan)}.btn.danger{color:var(--danger);border-color:rgba(255,59,48,.28);background:rgba(255,59,48,.08)}.btn.small{min-height:28px;padding:0 8px;font-size:12px;border-radius:8px}
.btn.icon{width:34px;padding:0;font-size:16px}
.status-pill{font-size:12px;font-weight:650;padding:7px 10px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.62);display:inline-flex;gap:7px;align-items:center;backdrop-filter:blur(14px)}
body.dark .status-pill{background:rgba(44,44,46,.62)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok)}
.notice{display:none}
.page-tabs{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:50;display:flex;gap:6px;align-items:center;flex-wrap:nowrap;border:1px solid rgba(255,255,255,.55);background:rgba(255,255,255,.62);padding:7px;border-radius:18px;box-shadow:0 16px 36px rgba(0,0,0,.14);backdrop-filter:blur(22px) saturate(1.4);-webkit-backdrop-filter:blur(22px) saturate(1.4);max-width:calc(100vw - 24px);overflow:auto}
body.dark .page-tabs{border-color:rgba(235,235,245,.12);background:rgba(30,30,32,.62)}
.page-tab{min-height:38px;border:1px solid transparent;border-radius:13px;background:transparent;color:var(--text-sec);padding:0 13px;font-weight:700;white-space:nowrap;transition:.16s}
.page-tab:hover{color:var(--text);background:rgba(118,118,128,.12)}
.page-tab.active{color:#fff;background:var(--primary);box-shadow:0 5px 16px rgba(0,122,255,.24)}
.page{display:none}.page.active{display:block}
.trace-grid.page.active,.metrics.page.active{display:grid}
#toast{position:fixed;top:-70px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:12px 22px;border-radius:30px;font-size:14px;font-weight:650;transition:top .28s;z-index:9999;max-width:90vw;text-align:center;word-break:break-word}#toast.show{top:20px}
.dialog-backdrop{position:fixed;inset:0;z-index:9998;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.18);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}.dialog-backdrop.show{display:flex}.dialog-card{width:min(390px,100%);border:1px solid rgba(255,255,255,.55);border-radius:18px;background:rgba(255,255,255,.84);box-shadow:0 24px 70px rgba(0,0,0,.22);padding:16px;transform:translateY(8px);animation:dialogIn .18s ease forwards}body.dark .dialog-card{background:rgba(30,30,32,.88);border-color:rgba(235,235,245,.12)}@keyframes dialogIn{to{transform:translateY(0)}}.dialog-title{font-size:16px;font-weight:750;margin:0 0 6px}.dialog-message{color:var(--text-sec);font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}.dialog-input{width:100%;min-height:160px;margin-top:12px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.72);color:var(--text);padding:10px;resize:vertical}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.dialog-actions .btn{min-width:74px}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-card);box-shadow:var(--shadow);padding:14px;position:relative;overflow:hidden;backdrop-filter:blur(18px)}
.card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.card-head h2{margin:0;font-size:16px}.card-head p{margin:3px 0 0;color:var(--text-sec);font-size:12px}
.trace-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.trace-box{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:11px 12px;display:flex;gap:10px;align-items:center;min-width:0;box-shadow:var(--shadow);backdrop-filter:blur(18px)}
.trace-icon{font-size:18px;line-height:1}.trace-label{color:var(--text-sec);font-size:11px}.trace-value{font-weight:650;font-size:13px;word-break:break-all}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.metric{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;box-shadow:var(--shadow);backdrop-filter:blur(18px)}.metric span{display:block;color:var(--text-sec);font-size:11px;font-weight:650}.metric b{display:block;margin-top:6px;font-size:22px;line-height:1;letter-spacing:0}
.form-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.node-form{grid-template-columns:repeat(12,minmax(0,1fr));gap:10px}.field{display:grid;gap:5px}.node-form .field{grid-column:span 3;align-items:stretch}.node-form .field.w2{grid-column:span 2}.node-form .field.w4{grid-column:span 4}.node-form .field.w6{grid-column:span 6}.node-form .field.full{grid-column:span 6}.node-form .field.w12{grid-column:1/-1}.field.span2{grid-column:span 2}.field.full{grid-column:1/-1}.field label{color:var(--text-sec);font-size:11px;font-weight:650;line-height:1.2}.field input,.field textarea,.field select{width:100%;border:1px solid var(--border);border-radius:9px;background:rgba(255,255,255,.74);color:var(--text);min-height:32px;padding:6px 9px}.field textarea{min-height:58px;resize:vertical}.node-form .field.full textarea{min-height:62px}.check{display:flex;align-items:center;gap:7px;min-height:32px;color:var(--text);font-weight:600}.option-row{grid-column:1/-1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;align-items:center}.option-row .check{min-height:30px}.check input,.ip-checkbox{width:16px;height:16px;accent-color:var(--primary)}
body.dark .field input,body.dark .field textarea,body.dark .field select{background:rgba(44,44,46,.74)}
.hint{color:var(--text-sec);font-size:11px;line-height:1.55}
.search-input{height:34px;min-width:220px;border:1px solid var(--border);border-radius:9px;background:rgba(255,255,255,.74);color:var(--text);padding:0 10px}
body.dark .search-input{background:rgba(44,44,46,.74)}
.node-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.emby-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:10px;transition:.16s;min-width:0;backdrop-filter:blur(18px)}
.emby-card:hover{box-shadow:0 10px 28px rgba(0,0,0,.09);transform:translateY(-1px)}
.card-header{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;border-bottom:1px solid var(--border);padding-bottom:9px}
.card-title-group{display:flex;align-items:center;gap:10px;min-width:0}.emby-icon{width:34px;height:34px;border-radius:9px;border:1px solid var(--border);background:rgba(118,118,128,.12);display:grid;place-items:center;overflow:hidden;flex:0 0 auto}.emby-icon img{width:100%;height:100%;object-fit:cover}.emby-icon span{font-size:18px}
.card-title{min-width:0}.card-title b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card-title small{display:block;color:var(--text-sec);font-size:11px;margin-top:1px}
.badge{min-height:22px;border-radius:999px;font-size:11px;font-weight:650;display:inline-flex;align-items:center;padding:0 8px;border:1px solid var(--border);background:rgba(118,118,128,.08);color:var(--text-sec)}.badge.ok{color:var(--ok);border-color:rgba(52,199,89,.28);background:rgba(52,199,89,.1)}.badge.warn{color:var(--warn);border-color:rgba(255,149,0,.28);background:rgba(255,149,0,.1)}
.info-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;font-size:12px}.info-label{color:var(--text-sec);font-weight:600;flex:0 0 70px}.info-value{min-width:0;text-align:right;word-break:break-all}.masked{letter-spacing:1px;color:var(--text-sec)}
.card-footer{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:9px;border-top:1px dashed var(--border)}
.table-wrapper{width:100%;border:1px solid var(--border);border-radius:10px;overflow:auto;background:var(--card);backdrop-filter:blur(18px)}table{width:100%;border-collapse:collapse;min-width:720px}th,td{padding:9px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:middle}th{color:var(--text-sec);font-weight:650;background:rgba(118,118,128,.08);font-size:11px}tr:last-child td{border-bottom:0}
.output{min-height:180px;max-height:420px;overflow:auto;margin:0;background:rgba(255,255,255,.62);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:10px;font-size:11px;white-space:pre-wrap;word-break:break-word}.empty{padding:26px;text-align:center;color:var(--text-sec);grid-column:1/-1}
body.dark .output{background:rgba(28,28,30,.62)}
.two-col{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(290px,.92fr);gap:12px}.dns-status{display:flex;gap:6px;flex-wrap:wrap}.modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px}.modal-head h2{margin:0;font-size:17px}.x{width:34px;height:34px;border:1px solid var(--border);border-radius:10px;background:rgba(255,255,255,.72);color:var(--text-sec);font-size:18px}
body.dark .x{background:rgba(44,44,46,.72)}
.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:12px}.chart-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;min-height:170px;backdrop-filter:blur(18px)}.chart-card h3{margin:0 0 10px;font-size:14px}.bar-row{display:grid;grid-template-columns:minmax(70px,130px) 1fr auto;gap:8px;align-items:center;margin:8px 0}.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-sec)}.bar-track{height:8px;border-radius:999px;background:rgba(118,118,128,.16);overflow:hidden}.bar-fill{height:100%;border-radius:999px;background:var(--primary)}.bar-value{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--text);font-size:11px}
@media(max-width:900px){body{padding:10px 10px 86px}.trace-grid,.metrics,.two-col,.chart-grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr 1fr}.node-form{grid-template-columns:repeat(2,minmax(0,1fr))}.node-form .field,.node-form .field.w2,.node-form .field.w4,.node-form .field.w6,.node-form .field.full,.node-form .field.w12{grid-column:span 1}.option-row{grid-template-columns:repeat(2,minmax(0,1fr))}.field.span2,.field.full{grid-column:1/-1}.topbar{align-items:flex-start}.actions,.toolbar,.card-actions{width:100%}.actions .btn:not(.icon),.toolbar .btn,.card-actions .btn{flex:1}.page-tabs{bottom:10px;width:calc(100vw - 16px);justify-content:flex-start}.page-tab{min-height:38px;padding:0 11px;font-size:12px}.search-input{width:100%;min-width:0}.node-grid{grid-template-columns:1fr}.info-row{display:grid}.info-value{text-align:left}}
@media(max-width:520px){.container{gap:10px}.card{padding:12px}.brand h1{font-size:20px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.metric b{font-size:20px}.form-grid,.node-form,.option-row{grid-template-columns:1fr}.node-form .field,.node-form .field.w2,.node-form .field.w4,.node-form .field.w6,.node-form .field.full,.node-form .field.w12{grid-column:1/-1}.node-grid{gap:10px}.topbar .actions{display:grid;grid-template-columns:1fr auto auto auto;gap:7px}.status-pill{min-width:0}.bar-row{grid-template-columns:80px 1fr}.bar-value{grid-column:2/3}.page-tabs{padding:6px;gap:4px}.page-tab{min-height:36px;padding:0 10px}.ip-table table,.ip-table thead,.ip-table tbody,.ip-table tr,.ip-table td{display:block;width:100%;min-width:0}.ip-table table{border-collapse:separate}.ip-table thead{display:none}.ip-table tr{position:relative;margin:10px 0;padding:12px;border:1px solid var(--border);border-radius:12px;background:rgba(255,255,255,.58);box-shadow:0 6px 18px rgba(0,0,0,.05)}body.dark .ip-table tr{background:rgba(44,44,46,.58)}.ip-table td{border:0;padding:4px 0}.ip-table td:first-child{position:absolute;right:12px;top:12px;width:auto}.ip-table .ip-text{display:block;max-width:calc(100% - 42px);font-size:13px;word-break:break-all}.ip-table .latency:before{content:"延迟 ";color:var(--text-sec);font-weight:650}.ip-table .speed:before{content:"状态 ";color:var(--text-sec);font-weight:650}.ip-table .loc:before{content:"归属 ";color:var(--text-sec);font-weight:650}.ip-table td:last-child{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}.ip-table td:last-child .btn{flex:1}.ip-table tr:not(.test-row) td{padding:16px 8px;text-align:center}.ip-table tr:not(.test-row) td:before{content:""}}
</style>

</head>
<body>
<div id="toast"></div>
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
  <div class="login-box">
    <input id="loginToken" type="password" placeholder="访问密码" autocomplete="current-password" autofocus>
    <button class="btn primary" id="loginBtn" type="button">进入</button>
    <div id="loginError" class="login-error"></div>
  </div>
</div>
<div id="app" class="app">
  <main class="container">
    <section class="topbar">
      <div class="brand">
        <h1>媒体线路控制台</h1>
        <p>v${BUILD_VERSION} · 管理 ${escapeHTML(managementDomain || "-")} · 调度 ${escapeHTML(dispatchDomain || "-")}</p>
      </div>
      <div class="actions">
        <div class="status-pill" title="浏览器到当前 Worker 的往返延迟"><span class="dot" id="rttDot"></span><span>RTT</span><b id="rttValue" class="mono">--</b></div>
        <button class="btn icon" id="themeBtn" title="切换深色模式">◐</button>
        <button class="btn" id="exportBtn">导出</button>
        <button class="btn" id="importBtn">导入</button>
        <button class="btn danger" id="logoutBtn">退出</button>
      </div>
    </section>
    <div id="notice" class="notice"></div>
	    <nav class="page-tabs">
	      <button class="page-tab active" data-page-tab="overview">总览</button>
	      <button class="page-tab" data-page-tab="nodes">线路配置</button>
	      <button class="page-tab" data-page-tab="network">测速与 DNS</button>
	      <button class="page-tab" data-page-tab="deploy">代码更新</button>
	      <button class="page-tab" data-page-tab="dashboard">数据大屏</button>
	    </nav>

	    <section class="trace-grid page active" data-page="overview">
	      <div class="trace-box">
	        <div class="trace-icon">⌖</div>
        <div><div class="trace-label">访客入口</div><div id="traceEntry" class="trace-value mono">读取中...</div></div>
      </div>
      <div class="trace-box">
        <div class="trace-icon">↗</div>
        <div><div class="trace-label">Worker 出口</div><div id="traceEgress" class="trace-value mono">读取中...</div></div>
      </div>
    </section>

    <section class="metrics page active" data-page="overview">
      <div class="metric"><span>节点总数</span><b id="metricNodes">0</b></div>
      <div class="metric"><span>已启用</span><b id="metricEnabled">0</b></div>
      <div class="metric"><span>有效观看</span><b id="metricRequests">0</b></div>
      <div class="metric"><span>中转流量</span><b id="metricBytes">0 B</b></div>
    </section>

    <section class="card page" data-page="deploy" style="border-left:4px solid var(--danger)">
      <div class="card-head">
        <div><h2>一键覆盖 / 更新核心代码</h2><p>仅接受已混淆的 Worker 模块代码。明文代码会被后端拒绝，避免直接上传明文到 Cloudflare。</p></div>
        <button class="btn danger" id="deployBtn">立即覆盖并重启</button>
      </div>
      <div class="field full"><label>混淆后的 Worker 代码</label><textarea id="codeArea" rows="6" placeholder="粘贴已经混淆后的 dist/index.js 内容"></textarea></div>
      <div class="toolbar" style="margin-top:12px">
        <input type="file" id="fileInput" accept=".js" style="max-width:100%">
        <span class="hint">本地推荐仍使用 npm run deploy；网页覆盖适合紧急替换混淆产物。</span>
      </div>
    </section>

    <section class="card page" data-page="nodes">
      <div class="card-head">
        <div><h2 id="formTitle">部署 / 编辑媒体线路</h2><p>接入地址由节点名和访问密钥组成，外部客户端访问接入地址即可进入对应线路。</p></div>
        <div class="card-actions"><button class="btn" id="resetBtn">清空表单</button><button class="btn primary" id="saveNodeBtn">保存部署</button></div>
      </div>
      <div class="form-grid node-form">
        <input type="hidden" id="editingName">
        <div class="field"><label>节点名</label><input id="name" placeholder="vip-1"></div>
        <div class="field"><label>显示名</label><input id="displayName" placeholder="VIP Emby"></div>
        <div class="field"><label>图标</label><input id="icon" placeholder="留空默认"></div>
        <div class="field"><label>密钥</label><input id="secret" placeholder="可空"></div>
        <div class="field full"><label>服务器线路</label><textarea id="targets" placeholder="https://media.example.com&#10;https://backup.example.com"></textarea></div>
        <div class="field full"><label>备注</label><textarea id="remark" placeholder="内部备注"></textarea></div>
        <div class="field w6"><label>视频线路</label><input id="streamTarget" placeholder="可空，留空使用主线路"></div>
        <div class="field"><label>模拟客户端</label><select id="clientProfile">${clientProfileOptionsHTML()}</select></div>
        <div class="field"><label>Header</label><select id="headerMode"><option value="off">保守 off</option><option value="realip_only">严格 realip_only</option><option value="dual">兼容 dual</option><option value="strict">强力 strict</option></select></div>
        <div class="field"><label>播放</label><select id="streamMode"><option value="proxy">中转播放</option><option value="direct">直连播放</option><option value="auto">自动</option></select></div>
        <div class="field"><label>标签</label><input id="tag" placeholder="客户、区域或线路"></div>
        <div class="field w2"><label>周期</label><input id="renewDays" type="number" min="0" step="1" placeholder="21"></div>
        <div class="field w2"><label>提醒</label><input id="remindBeforeDays" type="number" min="0" step="1" placeholder="3"></div>
        <div class="field w2"><label>起算</label><input id="keepaliveAt" placeholder="2026-07-07"></div>
        <div class="field w2"><label>模拟秒数</label><input id="watchSeconds" type="number" min="180" max="7200" step="1" placeholder="300"></div>
        <div class="field w4"><label>保活账号</label><input id="watchUsername" autocomplete="off" placeholder="可空，Token 优先"></div>
        <div class="field w4"><label>保活密码</label><input id="watchPassword" type="password" autocomplete="new-password" placeholder="留空保留，__clear__ 清空"></div>
        <div class="field w6"><label>保活 Token</label><input id="watchToken" autocomplete="off" placeholder="留空保留，Token 优先"></div>
        <div class="field w2"><label>User ID</label><input id="watchUserId" autocomplete="off" placeholder="可空"></div>
        <div class="field w4"><label>指定视频 ID</label><input id="watchItemId" autocomplete="off" placeholder="可空，留空自动选片"></div>
        <div class="option-row">
          <label class="check"><input id="impersonate" type="checkbox" checked>启用模拟客户端</label>
          <label class="check"><input id="autoWatch" type="checkbox">到期自动模拟观看</label>
          <label class="check"><input id="directExternal" type="checkbox">自动模式允许直链</label>
          <label class="check"><input id="cacheImage" type="checkbox" checked>海报及图片缓存</label>
          <label class="check"><input id="enabled" type="checkbox" checked>启用节点</label>
        </div>
      </div>
      <div class="hint" style="margin-top:12px">Header 策略只控制真实 IP、Origin、Referer 等请求头；模拟客户端由“启用模拟客户端”和“模拟客户端”选择控制。</div>
    </section>

    <section class="card page" data-page="network">
      <div class="card-head">
        <div><h2>专属线路测速与动态 DNS</h2><p>拉取优选 IP、维护调度域名 DNS 记录，也可以粘贴自定义 IP/CNAME。</p></div>
        <div class="toolbar">
          <select id="ipType" class="search-input" style="min-width:160px"><option value="all">综合混合源</option><option value="电信">电信专属</option><option value="联通">联通专属</option><option value="移动">移动专属</option><option value="多线">多线 BGP</option><option value="ipv6">IPv6 节点</option><option value="优选">顶尖优选库</option></select>
          <button class="btn cyan" id="preferredBtn">提取预设源并测速</button>
          <button class="btn orange" id="copyItdogBtn">复制去 ITDog</button>
          <button class="btn" id="clearIPsBtn">清空列表</button>
        </div>
      </div>
      <div class="two-col">
        <div>
          <div class="toolbar" style="margin-bottom:12px">
            <input id="customApiUrl" class="search-input" style="flex:1" value="https://ip.v2too.top/api/nodes" placeholder="自定义 JSON 或文本 API 链接">
            <button class="btn cyan" id="fetchCustomApiBtn">拉取 API 并测速</button>
          </div>
          <div class="field full"><label>自定义 IP、IPv6 或 CNAME</label><textarea id="customIps" placeholder="每行一个，也支持粘贴混杂文本自动提取"></textarea></div>
          <div class="toolbar" style="margin:12px 0"><button class="btn violet" id="testCustomBtn">测试粘贴的节点</button><button class="btn violet" id="directCnameBtn">直推 CNAME</button><button class="btn green" id="topDnsBtn">TOP3 写入 DNS</button><button class="btn primary" id="selectedDnsBtn">选中写入 DNS</button></div>
          <div id="statusText" class="hint">优选 IP 是 Cloudflare 边缘入口候选。实际体验还会受运营商、TLS、Worker 调度、线路距离影响。</div>
          <div class="table-wrapper ip-table" style="margin-top:14px">
            <table>
              <thead><tr><th style="width:44px"><input type="checkbox" id="selectAll" class="ip-checkbox"></th><th>专属节点</th><th>预估延迟</th><th>连通状态</th><th>记录/归属地</th><th>单节点操作</th></tr></thead>
              <tbody id="ipRows"><tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无数据，请拉取节点或输入自定义 IP/域名测试</td></tr></tbody>
            </table>
          </div>
        </div>
        <div>
          <div class="trace-box" style="margin-bottom:14px;display:block">
            <div class="trace-label">调度域名 DNS</div>
            <div id="dnsStatus" class="dns-status" style="margin-top:8px"><span class="badge">未查询</span></div>
          </div>
          <div class="form-grid" style="grid-template-columns:1fr 110px">
            <div class="field"><label>调度域名</label><input id="dnsName" value="${escapeHTML(dispatchDomain)}" placeholder="md.8899.qzz.io"></div>
            <div class="field"><label>类型</label><select id="dnsType"><option>A</option><option>AAAA</option><option>CNAME</option></select></div>
            <div class="field full"><label>记录值</label><textarea id="dnsValues" placeholder="一行一个记录值"></textarea></div>
          </div>
          <div class="toolbar" style="margin-top:12px"><button class="btn" id="dnsLoadBtn">查询 DNS</button><button class="btn primary" id="dnsUpdateBtn">更新 DNS</button></div>
          <pre id="dnsOut" class="output" style="margin-top:14px;min-height:180px"></pre>
        </div>
      </div>
    </section>

    <section class="card page" data-page="nodes">
      <div class="card-head">
        <div><h2>已配置的媒体线路</h2><p>卡片内可复制接入地址、隐藏/显示线路和密钥、测试连通性。</p></div>
        <div class="toolbar">
          <button class="btn cyan" id="pingAllBtn">全局测速</button>
          <button class="btn" id="purgeBtn">刷新海报缓存</button>
          <input id="search" class="search-input" placeholder="搜索备注、节点名或线路">
          <button class="btn" id="reloadNodesBtn">刷新</button>
        </div>
      </div>
      <div id="nodeGrid" class="node-grid"></div>
    </section>

    <section id="dashboardModal" class="card page" data-page="dashboard">
    <div class="modal-head">
      <div><h2>数据大屏</h2><div class="hint">D1 请求统计、最近访问记录和 Cloudflare 边缘流量。</div></div>
      <button class="x" id="closeDashboardBtn">×</button>
    </div>
    <section class="metrics" style="margin-bottom:16px">
      <div class="metric"><span>今天</span><b id="trafficToday">--</b></div>
      <div class="metric"><span>7 天</span><b id="traffic7d">--</b></div>
      <div class="metric"><span>30 天</span><b id="traffic30d">--</b></div>
      <div class="metric"><span>D1 日期</span><b id="statsDay" style="font-size:18px">--</b></div>
    </section>
    <div id="dashboardCharts" class="chart-grid"></div>
    <div class="table-wrapper" style="margin-bottom:12px">
      <table>
        <thead><tr><th>时间</th><th>节点</th><th>视频 ID</th><th>播放进度</th><th>用户</th><th>会话</th></tr></thead>
        <tbody id="watchRows"><tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无有效观看</td></tr></tbody>
      </table>
    </div>
    <div class="table-wrapper">
      <table>
        <thead><tr><th>时间</th><th>节点</th><th>IP</th><th>地区</th><th>状态</th><th>路径</th></tr></thead>
        <tbody id="logRows"><tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无数据</td></tr></tbody>
      </table>
    </div>
    <pre id="statsOut" class="output" style="margin-top:16px"></pre>
    </section>
  </main>
</div>
<script>
let nodes = [];
let stats = null;
let analytics = null;
const CLIENT_LABELS = ${labels};
const DEFAULT_NODE_ICON_CLIENT = ${JSON.stringify(DEFAULT_NODE_ICON)};
const DISPATCH_ORIGIN = ${JSON.stringify(dispatchDomain ? "https://" + dispatchDomain : "")};
const $ = (id) => document.getElementById(id);
const tokenKey = "embyproxy_cf_admin_token";
let adminToken = localStorage.getItem(tokenKey) || "";
if (localStorage.getItem("embyproxy_cf_theme") === "dark") document.body.classList.add("dark");
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
  localStorage.setItem(tokenKey, token);
  loadNodes({ quietAuth: true });
}
function logout(){
  adminToken = "";
  localStorage.removeItem(tokenKey);
  nodes = [];
  showLogin();
}
function showDialog(options = {}) {
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
      resolve(input && value ? input.value : value);
    };
    ok.onclick = () => cleanup(true);
    cancel.onclick = () => cleanup(false);
    backdrop.onclick = (event) => { if (event.target === backdrop) cleanup(false); };
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
function uiNotice(message, title = "提示") {
  return showDialog({ title, message, actions: false, autoCloseMs: 2000 });
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
    localStorage.removeItem(tokenKey);
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
  const q = $("search").value.trim().toLowerCase();
  const list = nodes.filter(n => !q || [n.name,n.displayName,n.tag,n.remark,(n.targets||[]).join(" ")].join(" ").toLowerCase().includes(q));
  $("nodeGrid").innerHTML = list.map((n, index) => {
    const url = proxyURL(n);
    const firstTarget = (n.targets || [])[0] || "";
    const icon = iconHTML(n);
    return '<article class="emby-card" data-search="' + attr([n.name,n.displayName,n.tag,n.remark,firstTarget].join(" ")) + '">' +
      '<div class="card-header"><div class="card-title-group"><div class="emby-icon">' + icon + '</div><div class="card-title"><b>' + esc(n.displayName || n.name) + '</b><small>' + esc(n.name) + (n.tag ? " · " + esc(n.tag) : "") + '</small></div></div><span class="badge ' + (n.enabled ? "ok" : "warn") + '">' + (n.enabled ? "启用" : "停用") + '</span></div>' +
      infoRow("接入地址", '<span class="mono masked" data-secret="' + attr(url) + '">••••••••••••</span> <button class="btn small" data-act="reveal" data-name="' + attr(n.name) + '">显示</button>') +
      infoRow("线路地址", '<span class="masked" data-secret="' + attr((n.targets || []).join("\\n")) + '">' + esc(firstTarget ? "••••••••••••" : "未配置") + '</span>') +
      infoRow("Header", esc(n.headerMode || "dual") + " / " + esc(n.streamMode || "proxy")) +
      infoRow("模拟", n.impersonate === false ? "关闭" : esc(CLIENT_LABELS[n.clientProfile] || n.clientProfile || "")) +
      infoRow("自动观看", autoWatchHTML(n)) +
      infoRow("观看提醒", keepaliveHTML(n)) +
      infoRow("密钥", n.secret ? '<span class="masked" data-secret="' + attr(n.secret) + '">••••••</span>' : "无") +
      '<div class="card-footer"><div class="card-actions"><button class="btn small" data-act="up" data-name="' + attr(n.name) + '" ' + (index === 0 ? "disabled" : "") + '>上移</button><button class="btn small" data-act="down" data-name="' + attr(n.name) + '" ' + (index === list.length - 1 ? "disabled" : "") + '>下移</button></div><div class="card-actions"><button class="btn small" data-act="copy" data-name="' + attr(n.name) + '">复制</button><button class="btn small" data-act="edit" data-name="' + attr(n.name) + '">编辑</button><button class="btn small" data-act="ping" data-name="' + attr(n.name) + '">测速</button><button class="btn small" data-act="simulate" data-name="' + attr(n.name) + '">模拟观看</button><button class="btn small" data-act="keepalive" data-name="' + attr(n.name) + '">已观看</button><button class="btn small danger" data-act="delete" data-name="' + attr(n.name) + '">删除</button></div></div>' +
    '</article>';
  }).join("") || '<div class="empty">暂无节点</div>';
}
function infoRow(label, value){ return '<div class="info-row"><div class="info-label">' + esc(label) + '</div><div class="info-value">' + value + '</div></div>'; }
function autoWatchHTML(n){
  if (!n.autoWatch) return '<span class="badge">关闭</span>';
  const ok = n.watchConfigured;
  const label = ok ? "已配置" : "缺少凭据";
  const detail = (n.watchUsername ? "账号 " + n.watchUsername : (n.watchTokenSet ? "Token" : "未配置")) + " · " + (n.watchSeconds || 300) + " 秒";
  return '<span class="badge ' + (ok ? "ok" : "warn") + '">' + label + '</span><div class="hint">' + esc(detail) + '</div>';
}
function keepaliveHTML(n){
  if (!n.renewDays) return '<span class="badge">关闭</span>';
  const k = n.keepalive || {};
  const cls = k.status === "due" ? "warn" : (k.status === "warn" ? "warn" : "ok");
  const text = k.status === "due" ? "已超期 " + Math.abs(k.remainDays || 0) + " 天" : "剩余 " + (k.remainDays ?? n.renewDays) + " 天";
  const last = k.lastPlayTs ? new Date(k.lastPlayTs).toLocaleString() : "无记录";
  return '<span class="badge ' + cls + '">' + esc(text) + '</span><div class="hint">周期 ' + esc(n.renewDays) + ' 天，最近 ' + esc(last) + '</div>';
}
function iconHTML(n){
  const icon = n.icon || DEFAULT_NODE_ICON_CLIENT;
  if (/^https?:\\/\\//i.test(icon)) return '<img src="' + attr(icon) + '" alt="">';
  return '<span>' + esc(icon || DEFAULT_NODE_ICON_CLIENT) + '</span>';
}
function renderMetrics(){
  $("metricNodes").textContent = nodes.length;
  $("metricEnabled").textContent = nodes.filter(n => n.enabled).length;
  if (stats && stats.today) {
    const watches = (stats.watches || []).reduce((n,r) => n + Number(r.count || 0), 0);
    const bytes = stats.today.filter(r => r.kind === "stream_proxy").reduce((n,r) => n + Number(r.bytes || 0), 0);
    $("metricRequests").textContent = watches;
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
    secret: $("secret").value,
    clientProfile: $("clientProfile").value,
    impersonate: $("impersonate").checked,
    headerMode: $("headerMode").value,
    streamMode: $("streamMode").value,
    directExternal: $("directExternal").checked,
    cacheImage: $("cacheImage").checked,
    enabled: $("enabled").checked,
    tag: $("tag").value,
    remark: $("remark").value,
    renewDays: Number($("renewDays").value || 0),
    remindBeforeDays: Number($("remindBeforeDays").value || 0),
    keepaliveAt: $("keepaliveAt").value,
    autoWatch: $("autoWatch").checked,
    watchUsername: $("watchUsername").value,
    watchPassword: $("watchPassword").value,
    watchToken: $("watchToken").value,
    watchUserId: $("watchUserId").value,
    watchItemId: $("watchItemId").value,
    watchSeconds: Number($("watchSeconds").value || 300)
  };
  try {
    await api("/api/nodes", { method:"POST", body: JSON.stringify(body) });
    resetForm();
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
function editNode(name){
  const n = nodes.find(x => x.name === name); if (!n) return;
  $("formTitle").textContent = "编辑节点 " + n.name;
  $("editingName").value = n.name;
  $("name").value = n.name; $("displayName").value = n.displayName || "";
  $("icon").value = n.icon || "";
  $("targets").value = (n.targets || []).join("\\n"); $("secret").value = n.secret || "";
  $("streamTarget").value = n.streamTarget || "";
  $("clientProfile").value = n.clientProfile || "yamby";
  $("impersonate").checked = n.impersonate !== false;
  $("headerMode").value = n.headerMode || "dual";
  $("streamMode").value = n.streamMode || "proxy";
  $("directExternal").checked = !!n.directExternal;
  $("cacheImage").checked = n.cacheImage !== false;
  $("enabled").checked = n.enabled !== false;
  $("renewDays").value = n.renewDays || "";
  $("remindBeforeDays").value = n.remindBeforeDays || "";
  $("keepaliveAt").value = n.keepaliveAt || "";
  $("autoWatch").checked = !!n.autoWatch;
  $("watchUsername").value = n.watchUsername || "";
  $("watchPassword").value = "";
  $("watchPassword").placeholder = n.watchPasswordSet ? "已保存，留空保留，__clear__ 清空" : "留空保留，__clear__ 清空";
  $("watchToken").value = "";
  $("watchToken").placeholder = n.watchTokenSet ? "已保存，留空保留，__clear__ 清空" : "留空保留，Token 优先";
  $("watchUserId").value = n.watchUserId || "";
  $("watchItemId").value = n.watchItemId || "";
  $("watchSeconds").value = n.watchSeconds || 300;
  $("tag").value = n.tag || ""; $("remark").value = n.remark || "";
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  try {
    const data = await api("/api/ping-node?url=" + encodeURIComponent(n.targets[0] || ""));
    if (!options.quiet) showToast(data.ms >= 0 ? "可用: " + data.ms + "ms" : "断连/超时");
    return data;
  } catch(e){ handleError(e); }
}
async function markWatched(name){
  try {
    await api("/api/keepalive/reset", { method:"POST", body: JSON.stringify({ name }) });
    showToast("已更新观看时间");
    loadNodes({ quietAuth: true });
  } catch(e){ handleError(e); }
}
async function simulateWatch(name){
  const raw = await uiPrompt('输入 Emby Token，或 JSON：{"token":"...","userId":"...","itemId":"...","seconds":300}\\n也可临时输入：{"username":"...","password":"...","seconds":300}', "模拟观看", "token 或 JSON");
  if (!raw) return;
  let body = { node: name, token: String(raw).trim() };
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("{")) {
    try {
      body = { node: name, ...JSON.parse(trimmed) };
    } catch (e) {
      return handleError(new Error("JSON 格式无效"));
    }
  }
  try {
    const data = await api("/api/simulated-watch", { method:"POST", body: JSON.stringify(body) });
    showToast("模拟完成：" + (data.item?.name || data.item?.id || name));
    await loadNodes({ quietAuth: true });
    await loadStats();
  } catch(e){ handleError(e); }
}
async function loadStats(){
  try {
    const data = await api("/api/stats");
    stats = data.stats;
    renderMetrics();
    $("statsOut").textContent = JSON.stringify(stats, null, 2);
    $("statsDay").textContent = stats.day || "--";
    renderWatchRows(stats.recentWatches || []);
    renderLogs(stats.recent || []);
    renderDashboardCharts();
  }
  catch(e){ handleError(e); }
}
async function loadAnalytics(){
  try {
    const data = await api("/api/analytics");
    analytics = data;
    $("trafficToday").textContent = data.trafficToday || "--";
    $("traffic7d").textContent = data.traffic7d || "--";
    $("traffic30d").textContent = data.traffic30d || "--";
    $("statsDay").textContent = stats?.day || new Date().toISOString().slice(0, 10);
    $("logRows").innerHTML = (data.recents || []).map(r => '<tr><td>' + esc(r.timestamp || "") + '</td><td>' + esc(r.prefix || "") + '</td><td class="mono">' + esc(r.ip || "") + '</td><td>' + esc(r.country || "") + '</td><td></td><td>' + esc(r.ua || "") + '</td></tr>').join("") || '<tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无数据</td></tr>';
    $("statsOut").textContent = JSON.stringify(data, null, 2);
    renderDashboardCharts();
  } catch(e){ handleError(e); }
}
function renderDashboardCharts(){
  const box = $("dashboardCharts");
  if (!box) return;
  const rows = stats?.today || [];
  const kindNames = {
    playback_event:"播放控制",
    playback_meta:"播放信息",
    stream_proxy:"中转视频",
    stream_direct:"直连跳转",
    simulated_watch:"模拟观看",
    playback:"旧播放",
    image:"图片",
    request:"普通",
    direct:"旧直达"
  };
  const kindRows = Object.values(rows.reduce((acc, row) => {
    const key = row.kind || "request";
    acc[key] = acc[key] || { label: kindNames[key] || key, value: 0 };
    acc[key].value += Number(row.count || 0);
    return acc;
  }, {}));
  const watchRows = (stats?.watches || []).map(row => ({ label: row.node || "-", value: Number(row.count || 0) })).sort((a,b) => b.value - a.value).slice(0, 6);
  const streamRows = rows.filter(row => row.kind === "stream_proxy");
  const trafficRows = aggregateForChart(streamRows, "bytes").slice(0, 6);
  const directRows = aggregateForChart(rows.filter(row => row.kind === "stream_direct"), "count").slice(0, 6);
  const trendRows = (analytics?.trend || []).map(row => ({ label: row.date || "-", value: Number(row.count || 0) })).slice(-7);
  const healthRows = (stats?.recent || []).reduce((acc, row) => {
    const key = Number(row.status || 0) >= 400 ? "异常" : "正常";
    acc[key] = acc[key] || { label: key, value: 0 };
    acc[key].value++;
    return acc;
  }, {});
  box.innerHTML =
    chartCard("请求类型分布", kindRows, item => item.value + " 次") +
    chartCard("有效观看节点", watchRows, item => item.value + " 次") +
    chartCard("中转视频流量", trafficRows, item => humanBytes(item.value)) +
    chartCard("直连跳转节点", directRows, item => item.value + " 次") +
    chartCard("7 日请求趋势", trendRows, item => item.value + " 次") +
    chartCard("最近状态", Object.values(healthRows), item => item.value + " 条");
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
function chartCard(title, rows, format){
  const list = rows.filter(row => Number(row.value || 0) > 0);
  if (!list.length) return '<section class="chart-card"><h3>' + esc(title) + '</h3><div class="empty" style="padding:40px 0">暂无数据</div></section>';
  const max = Math.max(...list.map(row => Number(row.value || 0)), 1);
  return '<section class="chart-card"><h3>' + esc(title) + '</h3>' + list.map(row => {
    const width = Math.max(4, Math.round(Number(row.value || 0) / max * 100));
    return '<div class="bar-row"><div class="bar-label" title="' + attr(row.label) + '">' + esc(row.label) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div><div class="bar-value">' + esc(format(row)) + '</div></div>';
  }).join("") + '</section>';
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
function renderWatchRows(rows){
  const body = $("watchRows");
  if (!body) return;
  body.innerHTML = rows.map(r => '<tr><td>' + esc(new Date(Number(r.last_ts || 0)).toLocaleString()) + '</td><td>' + esc(r.node || "") + '</td><td class="mono">' + esc(r.item_id || "") + '</td><td>' + esc(durationText(r.max_position_seconds)) + '</td><td class="mono">' + esc(r.user_id || "-") + '</td><td class="mono">' + esc(r.play_session_id || "-") + '</td></tr>').join("") || '<tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无有效观看</td></tr>';
}
function renderLogs(rows){
  $("logRows").innerHTML = rows.map(r => '<tr><td>' + esc(new Date(Number(r.ts || 0)).toLocaleString()) + '</td><td>' + esc(r.node || "") + '</td><td class="mono">' + esc(r.ip || "") + '</td><td>' + esc(r.country || "") + '</td><td>' + esc(r.status || "") + '</td><td>' + esc(r.path || "") + '</td></tr>').join("") || '<tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无数据</td></tr>';
}
function resetForm(){
  $("formTitle").textContent = "部署 / 编辑媒体线路";
  for (const id of ["editingName","name","displayName","icon","targets","streamTarget","secret","tag","remark","renewDays","remindBeforeDays","keepaliveAt","watchUsername","watchPassword","watchToken","watchUserId","watchItemId","watchSeconds"]) $(id).value = "";
  $("clientProfile").value = "yamby"; $("headerMode").value = "dual"; $("streamMode").value = "proxy";
  $("impersonate").checked = true; $("autoWatch").checked = false; $("directExternal").checked = false; $("cacheImage").checked = true; $("enabled").checked = true;
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
  return uiNotice(message, "提示");
}
function copyText(v){ navigator.clipboard.writeText(v || ""); showToast("复制成功"); }
function toggleTheme(){ document.body.classList.toggle("dark"); localStorage.setItem("embyproxy_cf_theme", document.body.classList.contains("dark") ? "dark" : "light"); }
function switchPage(page){
  document.querySelectorAll("[data-page]").forEach(el => el.classList.toggle("active", el.dataset.page === page));
  document.querySelectorAll("[data-page-tab]").forEach(el => el.classList.toggle("active", el.dataset.pageTab === page));
  if (page === "dashboard") { loadStats(); loadAnalytics(); }
  if (page === "network") loadDNS({ quiet: true });
  if (page === "overview") { loadTrace(); loadStats(); }
}
function openDashboard(){ switchPage("dashboard"); }
function closeDashboard(){ switchPage("overview"); }
async function loadTrace(){
  try {
    const data = await api("/api/trace");
    const entry = data.entry || {};
    const egress = data.egress || {};
    $("traceEntry").textContent = [entry.country, entry.colo, entry.city].filter(Boolean).join(" / ") || "--";
    $("traceEgress").textContent = [egress.loc, egress.colo, egress.ip].filter(Boolean).join(" / ") || egress.error || (egress.status === "updating" ? "检测中..." : "--");
    if (egress.status === "updating") setTimeout(loadTrace, 2200);
  } catch(e) { $("traceEntry").textContent = "--"; $("traceEgress").textContent = "--"; }
}
async function measureRTT(){
  const started = performance.now();
  try {
    await fetch("/__client_rtt__?t=" + Date.now(), { cache: "no-store" });
    const ms = Math.round(performance.now() - started);
    $("rttValue").textContent = ms + "ms";
    $("rttDot").style.background = ms < 180 ? "var(--ok)" : (ms < 450 ? "var(--warn)" : "var(--danger)");
  } catch { $("rttValue").textContent = "--"; }
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
    updateRowState(latTd, spdTd, Math.round(performance.now() - started), isIPv6 || isDomain);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") markTimeout(latTd, spdTd, tr);
    else updateRowState(latTd, spdTd, Math.round(performance.now() - started), isIPv6 || isDomain);
  }
}
function updateRowState(latTd, spdTd, rawLatency, keepRaw) {
  let latency = rawLatency;
  if (!keepRaw) {
    latency = rawLatency >= 500 ? rawLatency - 400 : Math.floor(40 + (rawLatency / 500) * 60) + Math.floor(Math.random() * 10);
  }
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
  let ok = 0;
  let fail = 0;
  for (const n of nodes) {
    const data = await pingNode(n.name, { quiet: true });
    if (data?.ms >= 0) ok++;
    else fail++;
  }
  showToast("全局测速完成：可用 " + ok + " 个，异常 " + fail + " 个");
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
function durationText(seconds){
  const value = Math.max(0, Math.floor(Number(seconds || 0)));
  if (value >= 3600) {
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return minutes ? hours + " 小时 " + minutes + " 分钟" : hours + " 小时";
  }
  if (value >= 60) return Math.floor(value / 60) + " 分钟";
  return value + " 秒";
}
function esc(v){ return String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function attr(v){ return esc(v).replace(/\\n/g, " "); }
$("loginToken").addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveToken();
});
$("loginBtn").addEventListener("click", saveToken);
document.querySelectorAll("[data-page-tab]").forEach(btn => btn.addEventListener("click", () => switchPage(btn.dataset.pageTab)));
$("reloadNodesBtn").addEventListener("click", () => loadNodes());
$("logoutBtn").addEventListener("click", logout);
$("exportBtn").addEventListener("click", exportNodes);
$("importBtn").addEventListener("click", importNodes);
$("saveNodeBtn").addEventListener("click", saveNode);
$("resetBtn").addEventListener("click", resetForm);
$("search").addEventListener("input", renderNodes);
$("preferredBtn").addEventListener("click", loadPreferredIPs);
$("dnsLoadBtn").addEventListener("click", loadDNS);
$("dnsUpdateBtn").addEventListener("click", updateDNS);
$("themeBtn").addEventListener("click", toggleTheme);
$("closeDashboardBtn").addEventListener("click", closeDashboard);
$("testCustomBtn").addEventListener("click", addCustomIPs);
$("fetchCustomApiBtn").addEventListener("click", fetchCustomApiAndTest);
$("directCnameBtn").addEventListener("click", directSubmitCname);
$("deployBtn").addEventListener("click", deployWorker);
$("copyItdogBtn").addEventListener("click", copyItdog);
$("clearIPsBtn").addEventListener("click", () => { $("ipRows").innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-sec)">暂无数据，请拉取节点或输入自定义 IP/域名测试</td></tr>'; $("selectAll").checked = false; });
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
$("nodeGrid").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-act]");
  if (!btn) return;
  const name = btn.dataset.name;
  if (btn.dataset.act === "copy") copyText(proxyURL(nodes.find(n => n.name === name) || {}));
  if (btn.dataset.act === "edit") editNode(name);
  if (btn.dataset.act === "ping") pingNode(name);
  if (btn.dataset.act === "simulate") simulateWatch(name);
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
  loadNodes({ quietAuth: true });
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
