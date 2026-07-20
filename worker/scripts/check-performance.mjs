import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
const moduleURL = `data:text/javascript;base64,${Buffer.from(`${source}\nexport { getProxyNode, invalidateProxyNodeCache, shouldRewriteBody, withServerTiming, orderTargetsByHealth, recordTargetOutcome, fetchWithHeaderTimeout, fetchConfiguredTarget, shouldRecordVisitorLog, readStreamTextLimited, readStreamBytesLimited, BodyLimitError, shouldUseDirectStream, performanceHistogram, histogramPercentile, targetHeaderTimeoutMs, trackTargetOutcome, saveNode, performanceMetricStatement, linePerformanceStatement, profileSnapshot, normalizeDeviceState, getClientProfile, isAuthenticationIdentityRequest, buildHeaders, logClientIdentity, playbackRouteResult, markPlaybackRoute, pingTarget, pingTargetCompat, replaceDNSRecordsSafely, recoverStaleWatchSessions };`).toString("base64")}`;
const performanceModule = await import(moduleURL);
const {
  default: worker,
  getProxyNode,
  invalidateProxyNodeCache,
  shouldRewriteBody,
  withServerTiming,
  orderTargetsByHealth,
  recordTargetOutcome,
  fetchWithHeaderTimeout,
  fetchConfiguredTarget,
  shouldRecordVisitorLog,
  readStreamTextLimited,
  readStreamBytesLimited,
  BodyLimitError,
  shouldUseDirectStream,
  performanceHistogram,
  histogramPercentile,
  targetHeaderTimeoutMs,
  trackTargetOutcome,
  saveNode,
  performanceMetricStatement,
  linePerformanceStatement,
  profileSnapshot,
  normalizeDeviceState,
  getClientProfile,
  isAuthenticationIdentityRequest,
  buildHeaders,
  logClientIdentity,
  playbackRouteResult,
  markPlaybackRoute,
  pingTarget,
  pingTargetCompat,
  replaceDNSRecordsSafely,
  recoverStaleWatchSessions
} = performanceModule;

assert.doesNotMatch(
  source,
  /await ensureSchema\(env\);\s*return handleProxy\(request, env, ctx\)/,
  "proxy requests must not wait for full schema migration"
);
assert.match(source, /schemaVersionIsCurrent\(env\)/, "admin cold starts must use a schema version fast path");
assert.match(source, /env\.DB\.batch\(statements\.map/, "fallback schema migration must batch table creation");
assert.match(source, /url\.pathname === "\/api\/health"[\s\S]*?return json\(\{ ok: true, version: BUILD_VERSION \}\)/, "health checks must not depend on D1");
assert.doesNotMatch(source, /device:\s*"diting"/, "Hills Android must not use an unrelated hard-coded device name");
for (const column of ["outbound_profile", "outbound_ua", "outbound_device"]) {
  assert.match(source, new RegExp(`${column} TEXT DEFAULT ''`), `runtime visitor logs must include ${column}`);
  assert.match(schema, new RegExp(`${column} TEXT DEFAULT ''`), `D1 schema must include ${column}`);
}
assert.match(source, /INSERT INTO visitor_logs \([\s\S]*?outbound_profile, outbound_ua, outbound_device/, "visitor logs must persist the outbound identity snapshot");
assert.match(source, /CREATE TABLE IF NOT EXISTS playback_route_state/, "runtime schema must persist the latest actual playback route");
assert.match(schema, /CREATE TABLE IF NOT EXISTS playback_route_state/, "D1 schema must persist the latest actual playback route");
assert.match(source, /playbackRoute: routes\.get\(node\.name\) \|\| null/, "node cards must receive their latest actual playback route");
assert.match(source, /excluded\.ts - playback_route_state\.ts >= \$\{PLAYBACK_AUX_WRITE_INTERVAL_MS\}/, "D1 must enforce playback route write throttling across isolates");

const incomingYambyHeaders = new Headers({
  "User-Agent": "Yamby/2.0.4.6(Android",
  "X-Emby-Authorization": 'Emby Client=Yamby,Device=Pixel 9,DeviceId=real-device-123,Version=2.0.4.6'
});
const incomingSnapshot = profileSnapshot("hills_android", {
  profiles: { hills_android: { deviceName: "stale-device-name", deviceId: "0123456789abcdef" } }
}, incomingYambyHeaders, new URL("https://origin.example.com/Users/AuthenticateByName"));
assert.equal(incomingSnapshot.device, "OnePlus-PKG110", "the selected profile must control the simulated device name");
assert.equal(incomingSnapshot.deviceId, "0123456789abcdef", "the selected profile must control the simulated device id");
assert.equal(getClientProfile("yamby").device, "OnePlus-PKG110", "Yamby Android must use the expected device name");
assert.equal(getClientProfile("hills_android").device, "OnePlus-PKG110", "Hills Android must use the expected device name");
assert.equal(
  normalizeDeviceState(getClientProfile("hills_android"), { deviceName: "Pixel 9", deviceId: "0123456789abcdef" }).deviceName,
  "OnePlus-PKG110",
  "saved Hills Android identity must normalize to the configured simulated device"
);
assert.equal(isAuthenticationIdentityRequest(new URL("https://origin.example.com/Users/AuthenticateByName")), true);
const identityDB = {
  prepare() {
    return {
      bind() { return this; },
      async first() {
        return { v: JSON.stringify({ profiles: { hills_android: { deviceName: "OnePlus-PKG110", deviceId: "0123456789abcdef" } } }) };
      },
      async run() { return { success: true }; }
    };
  }
};
const loginTarget = new URL("https://origin.example.com/Users/AuthenticateByName");
const loginHeaders = await buildHeaders(
  new Request("https://proxy.example.com/zz/Users/AuthenticateByName", { method: "POST", headers: incomingYambyHeaders }),
  loginTarget,
  { name: "zz", targets: ["https://origin.example.com"], clientProfile: "hills_android", impersonate: true, headerMode: "off" },
  { DB: identityDB }
);
assert.match(loginHeaders.get("User-Agent") || "", /^Hills\//);
assert.match(loginHeaders.get("X-Emby-Authorization") || "", /Client="Hills"/);
assert.match(loginHeaders.get("X-Emby-Authorization") || "", /Device="OnePlus-PKG110"/);
assert.match(loginHeaders.get("X-Emby-Authorization") || "", /DeviceId="0123456789abcdef"/);
const cleanLoginHeaders = await buildHeaders(
  new Request("https://proxy.example.com/zz/Users/AuthenticateByName", {
    method: "POST",
    headers: {
      ...Object.fromEntries(incomingYambyHeaders),
      "CF-Connecting-IP": "203.0.113.8",
      "Cookie": "worker_session=wrong-origin",
      "Origin": "https://proxy.example.com"
    }
  }),
  new URL(loginTarget),
  { name: "zz", targets: ["https://origin.example.com"], clientProfile: "hills_android", impersonate: true, headerMode: "dual" },
  { DB: identityDB },
  { compatibilityRetry: true, directMode: "retry-no-origin", cleanAuthentication: true }
);
assert.match(cleanLoginHeaders.get("User-Agent") || "", /^Yamby\//, "clean login retry must preserve the inbound client identity");
assert.match(cleanLoginHeaders.get("X-Emby-Authorization") || "", /Client=Yamby/, "clean login retry must preserve inbound Emby authorization");
assert.equal(cleanLoginHeaders.get("X-Forwarded-For"), null, "clean login retry must not forward the client IP");
assert.equal(cleanLoginHeaders.get("X-Real-IP"), null, "clean login retry must not send a conflicting real IP");
assert.equal(cleanLoginHeaders.get("Cookie"), null, "clean login retry must not leak Worker-origin cookies upstream");
assert.equal(cleanLoginHeaders.get("Origin"), null, "clean login retry must not send the Worker origin upstream");

const forwardedRequest = new Request("https://proxy.example.com/zz/System/Info/Public", {
  headers: {
    "CF-Connecting-IP": "203.0.113.8",
    "CF-Ray": "test-ray",
    "CDN-Loop": "cloudflare; loops=1",
    "Origin": "https://client.example.com"
  }
});
const forwardedTarget = new URL("https://origin.example.com/System/Info/Public");
const normalForwardedHeaders = await buildHeaders(
  forwardedRequest,
  new URL(forwardedTarget),
  { name: "zz", targets: ["https://origin.example.com"], clientProfile: "hills_android", impersonate: true, headerMode: "dual" },
  { DB: identityDB }
);
assert.equal(normalForwardedHeaders.get("CF-Ray"), null, "Cloudflare internal headers must not leak upstream");
assert.equal(normalForwardedHeaders.get("CDN-Loop"), null, "Cloudflare loop headers must not leak upstream");
assert.equal(normalForwardedHeaders.get("X-Forwarded-For"), "203.0.113.8", "normal dual mode must retain the derived client IP");
const compatibilityHeaders = await buildHeaders(
  forwardedRequest,
  new URL(forwardedTarget),
  { name: "zz", targets: ["https://origin.example.com"], clientProfile: "hills_android", impersonate: true, headerMode: "dual" },
  { DB: identityDB },
  { compatibilityRetry: true, directMode: "retry-no-origin" }
);
assert.match(compatibilityHeaders.get("User-Agent") || "", /^Hills\//, "compatibility retries must preserve the selected Hills identity");
assert.equal(compatibilityHeaders.get("X-Forwarded-For"), null, "compatibility retries must remove forwarded client identity");
assert.equal(compatibilityHeaders.get("Origin"), null, "compatibility retries must remove origin restrictions");

const yambySnapshot = profileSnapshot("yamby", {
  profiles: { yamby: { deviceName: "OnePlus-PKG110", deviceId: "12345678-1234-4234-8234-123456789abc" } }
});
assert.equal(yambySnapshot.client, "Yamby");
assert.equal(yambySnapshot.device, "OnePlus-PKG110");
assert.equal(yambySnapshot.deviceId, "12345678-1234-4234-8234-123456789abc");

const loggedHills = logClientIdentity({ clientProfile: "hills_android", impersonate: true }, {
  profiles: { hills_android: { deviceName: "stale-device-name", deviceId: "0123456789abcdef" } }
}, "Yamby/2.0.4.6(Android");
assert.deepEqual(loggedHills, {
  profile: "hills_android",
  ua: "Hills/1.7.2 (android; 15)",
  device: "OnePlus-PKG110"
}, "logs must distinguish inbound Yamby from the selected outbound Hills identity");
assert.deepEqual(
  logClientIdentity({ clientProfile: "hills_android", impersonate: false }, null, "Yamby/2.0.4.6(Android"),
  { profile: "disabled", ua: "Yamby/2.0.4.6(Android", device: "" },
  "disabled impersonation must be explicit in visitor logs"
);

assert.deepEqual(playbackRouteResult("direct", 302, 1000), { mode: "direct", ts: 1000, status: 302 });
assert.deepEqual(playbackRouteResult("playback", 206, 2000), { mode: "proxy", ts: 2000, status: 206 });
assert.equal(playbackRouteResult("playback", 502, 3000), null, "failed playback must not replace the last successful route");
assert.equal(playbackRouteResult("request", 200, 4000), null, "ordinary API traffic must not replace the playback route");
const routeWrites = [];
const routeEnv = {
  DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return { async run() { routeWrites.push({ sql, args }); } };
        }
      };
    }
  }
};
await markPlaybackRoute(routeEnv, "route-card-test", "direct", 1000, 302);
await markPlaybackRoute(routeEnv, "route-card-test", "direct", 2000, 302);
await markPlaybackRoute(routeEnv, "route-card-test", "proxy", 3000, 206);
assert.equal(routeWrites.length, 2, "the same route must be throttled while a mode change is written immediately");
assert.deepEqual(routeWrites.map((item) => item.args[1]), ["direct", "proxy"]);

let nodeReads = 0;
const row = {
  name: "performance-node",
  targets: JSON.stringify(["https://origin.example.com"]),
  stream_target: "",
  secret: "route-secret",
  client_profile: "hills_android",
  impersonate: 0,
  header_mode: "dual",
  stream_mode: "proxy",
  direct_external: 0,
  cache_image: 1,
  enabled: 1,
  emby_user: "must-not-be-cached",
  emby_password: "must-not-be-cached",
  emby_access_token: "must-not-be-cached"
};
const env = {
  DB: {
    prepare(sql) {
      assert.match(sql, /SELECT \* FROM nodes WHERE name = \?/, "proxy cache must use the scoped node query");
      return {
        bind() { return this; },
        async first() {
          nodeReads++;
          return row;
        }
      };
    }
  }
};

invalidateProxyNodeCache(row.name);
const first = await getProxyNode(env, row.name);
const second = await getProxyNode(env, row.name);
assert.equal(nodeReads, 1, "warm proxy requests must reuse the node cache");
assert.deepEqual(first, second);
assert.equal(first.embyUser, undefined, "proxy cache must not retain Emby usernames");
assert.equal(first.embyPassword, undefined, "proxy cache must not retain Emby passwords");
assert.equal(first.embyAccessToken, undefined, "proxy cache must not retain Emby tokens");
invalidateProxyNodeCache(row.name);
await getProxyNode(env, row.name);
assert.equal(nodeReads, 2, "node updates must invalidate the proxy cache");

const jsonResponse = () => new Response('{"Items":[]}', { headers: { "Content-Type": "application/json" } });
assert.equal(
  shouldRewriteBody(jsonResponse(), new Request("https://proxy.example.com/node/Items")),
  false,
  "ordinary API JSON must stream without full-body rewriting"
);
assert.equal(
  shouldRewriteBody(jsonResponse(), new Request("https://proxy.example.com/node/Items/1/PlaybackInfo")),
  true,
  "PlaybackInfo must still rewrite media URLs"
);
assert.equal(
  shouldRewriteBody(
    new Response("#EXTM3U", { headers: { "Content-Type": "application/vnd.apple.mpegurl" } }),
    new Request("https://proxy.example.com/node/video/master.m3u8")
  ),
  true,
  "stream manifests must still rewrite media URLs"
);

const ranged = withServerTiming(new Response("abc", {
  status: 206,
  headers: {
    "Content-Range": "bytes 0-2/10",
    "Content-Length": "3",
    "Accept-Ranges": "bytes"
  }
}), { started: performance.now() - 8, node: 1.2, upstream: 5.4, rewrite: 0.3 });
assert.equal(ranged.status, 206);
assert.equal(ranged.headers.get("Content-Range"), "bytes 0-2/10");
assert.equal(ranged.headers.get("Content-Length"), "3");
assert.match(ranged.headers.get("Server-Timing") || "", /node;dur=1\.2, upstream;dur=5\.4, rewrite;dur=0\.3, total;dur=/);
assert.equal(await ranged.text(), "abc", "timing instrumentation must preserve the stream body");

assert.deepEqual(performanceHistogram(99), [1, 0, 0, 0, 0, 0, 0]);
assert.deepEqual(performanceHistogram(250), [0, 0, 1, 0, 0, 0, 0]);
assert.deepEqual(performanceHistogram(6000), [0, 0, 0, 0, 0, 0, 1]);
assert.equal(histogramPercentile([0, 4, 5, 1, 0, 0, 0], 0.5), 500);
assert.equal(targetHeaderTimeoutMs({ streamTimeoutMs: 9000 }, "/Videos/1/stream.mp4", {}), 9000);
const trackedTiming = { targetOutcomes: [] };
trackTargetOutcome(trackedTiming, "https://video.example.com/private/path", "success", 123, "/Videos/1/stream.mp4");
assert.equal(trackedTiming.targetOutcomes[0].label, "video.example.com");
assert.equal(trackedTiming.targetOutcomes[0].kind, "stream");
assert.doesNotMatch(trackedTiming.targetOutcomes[0].label, /private/);

let proxyNodeReads = 0;
let upstreamFetches = 0;
let playbackStatStatements = 0;
let playbackVisitorStatements = 0;
let playbackKeepaliveUpserts = 0;
const proxyRow = {
  ...row,
  name: "stream-performance-node",
  targets: JSON.stringify(["https://stream-origin.example.com"]),
  secret: "",
  cache_image: 0
};
const proxyEnv = {
  DB: {
    prepare(sql) {
      return {
        sql,
        bind() { return this; },
        async first() {
          if (/SELECT \* FROM nodes/.test(sql)) {
            proxyNodeReads++;
            return proxyRow;
          }
          if (/SELECT v FROM system_config/.test(sql)) return null;
          return null;
        },
        async run() {
          if (/INSERT INTO keepalive_state/.test(sql)) playbackKeepaliveUpserts++;
          return { success: true };
        }
      };
    },
    async batch(statements) {
      playbackStatStatements += statements.filter((item) => /INSERT INTO request_stats/.test(item.sql)).length;
      playbackVisitorStatements += statements.filter((item) => /INSERT INTO visitor_logs/.test(item.sql)).length;
      return [];
    }
  }
};
const waits = [];
const ctx = { waitUntil(promise) { waits.push(Promise.resolve(promise)); } };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (request) => {
  upstreamFetches++;
  assert.equal(new URL(request.url).host, "stream-origin.example.com");
  assert.equal(request.headers.get("Range"), "bytes=0-2");
  return new Response("abc", {
    status: 206,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": "bytes 0-2/10",
      "Content-Length": "3",
      "Accept-Ranges": "bytes"
    }
  });
};
try {
  invalidateProxyNodeCache(proxyRow.name);
  for (let i = 0; i < 2; i++) {
    const response = await worker.fetch(
      new Request(`https://proxy.example.com/${proxyRow.name}/video.mp4`, { headers: { Range: "bytes=0-2" } }),
      proxyEnv,
      ctx
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 0-2/10");
    assert.match(response.headers.get("Server-Timing") || "", /node;dur=.*upstream;dur=.*rewrite;dur=.*total;dur=/);
    assert.equal(await response.text(), "abc");
  }
  await Promise.all(waits);
} finally {
  globalThis.fetch = originalFetch;
}
assert.equal(proxyNodeReads, 1, "consecutive stream requests must share one D1 node lookup");
assert.equal(upstreamFetches, 2, "each stream request must still reach the upstream");
assert.equal(playbackStatStatements, 2, "request and byte statistics must remain exact");
assert.equal(playbackVisitorStatements, 1, "successful playback visitor logs must be sampled once per minute");
assert.equal(playbackKeepaliveUpserts, 1, "playback keepalive must update at most once per minute");
assert.equal(shouldRecordVisitorLog("playback", 500, "error-node", "1.1.1.1", 1000), true, "playback errors must never be sampled away");

await assert.rejects(
  readStreamTextLimited(new Response("1234").body, 3),
  (err) => err instanceof BodyLimitError && err.limit === 3,
  "unknown-length rewrite bodies must enforce the byte limit"
);
await assert.rejects(
  readStreamBytesLimited(new Response("1234").body, 3),
  (err) => err instanceof BodyLimitError && err.limit === 3,
  "unknown-length request bodies must enforce the retry byte limit"
);
assert.equal(
  new TextDecoder().decode(await readStreamBytesLimited(new Response("1234").body, 4)),
  "1234",
  "request body limiting must preserve bodies within the cap"
);
assert.match(
  source,
  /err instanceof BodyLimitError[\s\S]*?new Response\(passthrough/,
  "oversized rewrite candidates must fall back to the original response stream"
);

const autoNode = { streamMode: "auto", directExternal: true };
assert.equal(
  shouldUseDirectStream(autoNode, new Request("https://proxy.example.com/node/video.mp4"), "/video.mp4"),
  true,
  "public media may use explicitly enabled automatic direct mode"
);
assert.equal(
  shouldUseDirectStream(autoNode, new Request("https://proxy.example.com/node/video.mp4", { headers: { "X-Emby-Token": "secret" } }), "/video.mp4"),
  false,
  "automatic direct mode must not drop header-only authentication"
);
assert.equal(
  shouldUseDirectStream(autoNode, new Request("https://proxy.example.com/node/video.mp4?api_key=portable", { headers: { "X-Emby-Token": "secret" } }), "/video.mp4"),
  true,
  "URL-carried authentication may survive an automatic redirect"
);
assert.equal(
  shouldUseDirectStream(autoNode, new Request("https://proxy.example.com/node/master.m3u8?api_key=portable"), "/master.m3u8"),
  false,
  "automatic direct mode must keep manifests on the proxy path"
);
assert.equal(
  shouldUseDirectStream({ streamMode: "direct", directExternal: false }, new Request("https://proxy.example.com/node/master.m3u8"), "/master.m3u8"),
  true,
  "explicit direct mode must remain an administrator override"
);

let missingTable = true;
let migrationWrites = 0;
const fallbackRow = { ...proxyRow, name: "schema-fallback-node" };
const fallbackEnv = {
  DB: {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (/SELECT \* FROM nodes/.test(sql)) {
            if (missingTable) {
              missingTable = false;
              throw new Error("D1_ERROR: no such table: nodes");
            }
            return fallbackRow;
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          migrationWrites++;
          return { success: true };
        }
      };
    }
  }
};
invalidateProxyNodeCache(fallbackRow.name);
const recovered = await getProxyNode(fallbackEnv, fallbackRow.name);
assert.equal(recovered.name, fallbackRow.name, "an uninitialized database must recover transparently");
assert.ok(migrationWrites > 0, "schema migration must only run after a missing-table error");

const healthNode = "health-order-node";
const healthPath = "/Videos/1/stream.mp4";
const primary = "https://primary.example.com";
const backup = "https://backup.example.com";
recordTargetOutcome(healthNode, healthPath, primary, "failure", 900, 1000);
recordTargetOutcome(healthNode, healthPath, backup, "success", 120, 1000);
assert.deepEqual(
  orderTargetsByHealth(healthNode, healthPath, [primary, backup], 1001),
  [backup, primary],
  "a healthy backup must move ahead of a recently failed primary"
);

const strategyNode = "strategy-node";
recordTargetOutcome(strategyNode, healthPath, primary, "success", 300, 2000);
recordTargetOutcome(strategyNode, healthPath, backup, "success", 50, 2000);
assert.deepEqual(
  orderTargetsByHealth(strategyNode, healthPath, [primary, backup], 2001, "auto"),
  [backup, primary],
  "automatic video strategy must prefer the faster healthy line"
);
assert.deepEqual(
  orderTargetsByHealth(strategyNode, healthPath, [primary, backup], 2001, "priority"),
  [primary, backup],
  "priority video strategy must preserve configured order while lines are healthy"
);

assert.match(source, /CREATE TABLE IF NOT EXISTS performance_metrics/, "runtime schema must persist performance aggregates");
assert.match(source, /CREATE TABLE IF NOT EXISTS line_performance/, "runtime schema must persist line outcomes");
assert.match(source, /failover_count = failover_count \+ excluded\.failover_count/, "performance metrics must count real failovers");
for (const column of ["transfer_count", "transfer_bytes", "transfer_ms_sum", "last_bps"]) {
  assert.match(source, new RegExp(`${column} (?:INTEGER|REAL) DEFAULT 0`), `runtime schema must include ${column}`);
  assert.match(schema, new RegExp(`${column} (?:INTEGER|REAL) DEFAULT 0`), `D1 schema must include ${column}`);
}
assert.match(schema, /INSERT INTO system_config[\s\S]*?ON CONFLICT\(k\) DO NOTHING/, "offline schema setup must not skip runtime migrations on an existing database");
assert.doesNotMatch(
  source.match(/async function ensureWatchSessionsTable[\s\S]*?\n}/)?.[0] || "",
  /CREATE TABLE|PRAGMA|CREATE INDEX|UPDATE sim_watch_sessions/,
  "watch-session hot paths must not repeat schema discovery or migration writes"
);
assert.doesNotMatch(
  source.match(/async function keepaliveStatusMap[\s\S]*?\n}/)?.[0] || "",
  /ensureKeepaliveTable|CREATE TABLE/,
  "keepalive reads must not execute schema DDL on every request"
);
assert.match(
  source,
  /if \(oldName && oldName !== node\.name\) \{[\s\S]*?await env\.DB\.batch\(\[\s*upsertNode,[\s\S]*?DELETE FROM nodes WHERE name = \?[\s\S]*?\]\);/,
  "node rename must write the replacement, migrate dependent state, and delete the old row in one D1 batch"
);
assert.match(
  source,
  /INSERT INTO line_performance[\s\S]*?SELECT \?, bucket_ts[\s\S]*?ON CONFLICT\(node, bucket_ts, kind, line_key\) DO UPDATE SET/,
  "node rename must merge conflicting performance buckets instead of losing history"
);
assert.match(
  source.match(/async function deleteNode[\s\S]*?\n}/)?.[0] || "",
  /UPDATE sim_watch_sessions[\s\S]*?status IN \('starting', 'running', 'notify_pending'\)/,
  "deleting a node must terminate all active or pending simulated sessions"
);
assert.match(
  source,
  /if \(isRetryableStatus\(upstream\.status\)\) \{[\s\S]*?recordTargetOutcome\([^\n]+"failure"[\s\S]*?if \(targets\.length > 1\)/,
  "a retryable status must be recorded as a failure even when no backup line exists"
);

assert.doesNotMatch(source, /response\.body\.tee\(|measureProxyStream|recordStreamTransfer|updateStreamSpeedSample/, "playback responses must not be read or wrapped for throughput sampling");

const originalFetchForHealth = globalThis.fetch;
let healthCalls = 0;
const healthRequests = [];
globalThis.fetch = async (input, init = {}) => {
  const request = new Request(input, init);
  healthCalls++;
  healthRequests.push({ method: request.method, path: new URL(request.url).pathname });
  return new Response("forbidden", { status: 403 });
};
try {
  const denied = await pingTarget("https://denied.example.com");
  assert.equal(denied.ok, false, "403 probes must not mark a video line healthy");
  assert.equal(denied.status, 403);
  assert.equal(healthCalls, 3, "a denied public endpoint must not prevent trying compatible paths");
  assert.equal((await pingTargetCompat("https://denied.example.com")).ms, -1, "card latency must reject HTTP errors");
  assert.equal(healthCalls, 6, "card latency must reuse all compatible Emby health paths");
  assert.deepEqual(
    healthRequests.slice(3),
    [
      { method: "GET", path: "/emby/System/Info/Public" },
      { method: "GET", path: "/System/Info/Public" },
      { method: "GET", path: "/" }
    ],
    "card latency must use GET health probes instead of a short HEAD request"
  );
} finally {
  globalThis.fetch = originalFetchForHealth;
}

const staleWrites = [];
await recoverStaleWatchSessions({
  DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return { async run() { staleWrites.push({ sql, args }); return { success: true }; } };
        }
      };
    }
  }
}, 123456, "stale-node");
assert.equal(staleWrites.length, 1);
assert.match(staleWrites[0].sql, /status = 'starting' AND next_tick_at <= \?/);
assert.deepEqual(staleWrites[0].args, [123456, 123456, "stale-node"]);

const dnsCalls = [];
const originalFetchForDNS = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  dnsCalls.push({ url: String(url), method: init.method || "GET", body });
  if (init.method === "POST") {
    return Response.json({ success: false, errors: [{ message: "create failed" }] });
  }
  return Response.json({ success: true, result: { id: "old-id", ...(body || {}) } });
};
try {
  const replaced = await replaceDNSRecordsSafely(
    { CF_API_TOKEN: "test", CF_ZONE_ID: "zone" },
    "media.example.com",
    [{ id: "old-id", type: "A", content: "1.1.1.1", proxied: false, ttl: 60 }],
    [{ type: "A", content: "2.2.2.2" }, { type: "A", content: "3.3.3.3" }],
    60
  );
  assert.equal(replaced.ok, false);
} finally {
  globalThis.fetch = originalFetchForDNS;
}
assert.deepEqual(dnsCalls.map((call) => call.method), ["PUT", "POST", "PUT"], "a failed staged DNS replacement must restore the original record");
assert.equal(dnsCalls.at(-1).body.content, "1.1.1.1");

const seekProxyRow = {
  ...row,
  name: "seek-proxy-node",
  targets: JSON.stringify(["https://seek-primary.example.com", "https://seek-backup.example.com"]),
  stream_target: "https://seek-primary.example.com\nhttps://seek-backup.example.com",
  stream_strategy: "auto",
  stream_mode: "proxy",
  secret: "",
  impersonate: 0,
  cache_image: 0
};
const seekProxyWaits = [];
const seekProxyCalls = [];
const seekProxyEnv = {
  DB: {
    prepare(sql) {
      return {
        sql,
        bind() { return this; },
        async first() { return /SELECT \* FROM nodes/.test(sql) ? seekProxyRow : null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; }
      };
    },
    async batch() { return []; }
  }
};
const originalFetchForSeek = globalThis.fetch;
globalThis.fetch = async (request) => {
  seekProxyCalls.push(new URL(request.url).host);
  const range = request.headers.get("Range") || "bytes=0-1048575";
  const [start, end] = range.replace("bytes=", "").split("-").map(Number);
  const length = end - start + 1;
  if (seekProxyCalls.length === 1) {
    return new Response(new ReadableStream({ cancel() {} }), {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": `bytes ${start}-${end}/4194304`,
        "Content-Length": String(length),
        "Accept-Ranges": "bytes"
      }
    });
  }
  return new Response("xyz", {
    status: 206,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes ${start}-${start + 2}/4194304`,
      "Content-Length": "3",
      "Accept-Ranges": "bytes"
    }
  });
};
try {
  invalidateProxyNodeCache(seekProxyRow.name);
  const seekCtx = { waitUntil(promise) { seekProxyWaits.push(Promise.resolve(promise)); } };
  const firstSeekResponse = await worker.fetch(
    new Request(`https://proxy.example.com/${seekProxyRow.name}/Videos/1/stream.mp4?PlaySessionId=same-session`, {
      headers: { Range: "bytes=0-1048575" }
    }),
    seekProxyEnv,
    seekCtx
  );
  const firstSeekReader = firstSeekResponse.body.getReader();
  const firstSeekRead = firstSeekReader.read();
  await firstSeekReader.cancel("seek to new offset");
  const cancelledSeekRead = await firstSeekRead;
  assert.equal(Number(cancelledSeekRead.value?.byteLength || 0), 0, "the cancelled range must not deliver stale media bytes");
  const secondSeekResponse = await worker.fetch(
    new Request(`https://proxy.example.com/${seekProxyRow.name}/Videos/1/stream.mp4?PlaySessionId=same-session`, {
      headers: { Range: "bytes=2097152-3145727" }
    }),
    seekProxyEnv,
    seekCtx
  );
  assert.equal(secondSeekResponse.status, 206);
  assert.equal(secondSeekResponse.headers.get("Content-Range"), "bytes 2097152-2097154/4194304");
  assert.equal(await secondSeekResponse.text(), "xyz");
  await Promise.all(seekProxyWaits);
} finally {
  globalThis.fetch = originalFetchForSeek;
}
assert.deepEqual(
  seekProxyCalls,
  ["seek-primary.example.com", "seek-primary.example.com"],
  "cancelling an old range for seeking must not switch the new range to an unmeasured relay"
);

const rangeFallbackRow = {
  ...row,
  name: "range-fallback-node",
  targets: JSON.stringify(["https://range-origin.example.com"]),
  stream_target: "",
  stream_strategy: "auto",
  stream_mode: "proxy",
  secret: "",
  impersonate: 0,
  cache_image: 0
};
const rangeFallbackWaits = [];
let rangeFallbackCancels = 0;
const rangeFallbackEnv = {
  DB: {
    prepare(sql) {
      return {
        sql,
        bind() { return this; },
        async first() { return /SELECT \* FROM nodes/.test(sql) ? rangeFallbackRow : null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; }
      };
    },
    async batch() { return []; }
  }
};
const originalFetchForRangeFallback = globalThis.fetch;
globalThis.fetch = async (request) => {
  const url = new URL(request.url);
  if (url.host === "range-origin.example.com") {
    return Response.redirect("https://signed-cdn.example.com/video.mp4?signature=test", 302);
  }
  assert.equal(url.host, "signed-cdn.example.com");
  assert.equal(request.headers.get("Range"), currentFallbackRange);
  return new Response(new ReadableStream({ cancel() { rangeFallbackCancels++; } }), {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": "4194304",
      "Accept-Ranges": "bytes"
    }
  });
};
let currentFallbackRange = "bytes=2097152-3145727";
try {
  invalidateProxyNodeCache(rangeFallbackRow.name);
  const fallbackCtx = { waitUntil(promise) { rangeFallbackWaits.push(Promise.resolve(promise)); } };
  const fallbackResponse = await worker.fetch(
    new Request(`https://proxy.example.com/${rangeFallbackRow.name}/Videos/1/stream.mp4`, {
      headers: { Range: currentFallbackRange }
    }),
    rangeFallbackEnv,
    fallbackCtx
  );
  assert.equal(fallbackResponse.status, 307, "an external CDN that ignores a non-zero Range must fall back to direct seek");
  assert.equal(fallbackResponse.headers.get("Location"), "https://signed-cdn.example.com/video.mp4?signature=test");
  assert.equal(rangeFallbackCancels, 1, "the useless full-file CDN response must be cancelled");

  currentFallbackRange = "bytes=0-1048575";
  const initialResponse = await worker.fetch(
    new Request(`https://proxy.example.com/${rangeFallbackRow.name}/Videos/1/stream.mp4`, {
      headers: { Range: currentFallbackRange }
    }),
    rangeFallbackEnv,
    fallbackCtx
  );
  assert.equal(initialResponse.status, 200, "an initial range may remain proxied when the CDN returns the full stream");
  await initialResponse.body?.cancel();
  await Promise.all(rangeFallbackWaits);
} finally {
  globalThis.fetch = originalFetchForRangeFallback;
}

function bindingCheckedDB() {
  return {
    prepare(sql) {
      return {
        sql,
        bind(...args) {
          assert.equal(args.length, (sql.match(/\?/g) || []).length, `SQL binding count mismatch: ${sql.slice(0, 60)}`);
          this.args = args;
          return this;
        },
        async first() { return null; },
        async run() { return { success: true }; }
      };
    }
  };
}

const bindingEnv = { DB: bindingCheckedDB() };
await saveNode(bindingEnv, { name: "binding-check", targets: ["https://origin.example.com"] });
performanceMetricStatement(bindingEnv, "binding-check", "playback", 206, {
  node: 2,
  upstream: 80,
  rewrite: 1,
  total: 85,
  attempts: 2
}, Date.now());
linePerformanceStatement(bindingEnv, "binding-check", {
  kind: "stream",
  key: "line-key",
  label: "origin.example.com",
  result: "success",
  latencyMs: 80
}, Date.now());
const originalFetchForTimeout = globalThis.fetch;
globalThis.fetch = (request) => new Promise((resolve, reject) => {
  request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
});
try {
  await assert.rejects(
    fetchWithHeaderTimeout(new Request("https://timeout.example.com"), 20),
    /upstream header timeout after 20ms/,
    "header timeout must abort a stalled fetch"
  );
} finally {
  globalThis.fetch = originalFetchForTimeout;
}

const compatibilityCalls = [];
const originalFetchForCompatibility = globalThis.fetch;
globalThis.fetch = async (request) => {
  compatibilityCalls.push(request);
  const credentialAuthentication = new URL(request.url).pathname.toLowerCase().includes("/users/authenticate");
  if (credentialAuthentication) {
    const authAttempts = compatibilityCalls.filter((item) => new URL(item.url).pathname.toLowerCase().includes("/users/authenticate")).length;
    return authAttempts === 1
      ? new Response("upstream authentication rejected", { status: 403, headers: { "Server": "cloudflare", "CF-Ray": "upstream-ray" } })
      : new Response("authenticated", { status: 200 });
  }
  const getAttempts = compatibilityCalls.filter((item) => item.method === "GET").length;
  return request.method === "POST" || getAttempts === 1
    ? new Response("upstream compatibility failure", { status: 500 })
    : new Response("recovered", { status: 200 });
};
try {
  const compatible = await fetchConfiguredTarget(
    new Request("https://proxy.example.com/zz/System/Info/Public", {
      headers: { "CF-Connecting-IP": "203.0.113.9", "CF-Ray": "test-ray" }
    }),
    new URL("https://origin.example.com/System/Info/Public"),
    { name: "zz", targets: ["https://origin.example.com"], clientProfile: "hills_android", impersonate: true, headerMode: "dual" },
    undefined,
    { DB: identityDB },
    0
  );
  assert.equal(compatible.response.status, 200);
  assert.equal(compatible.attempts, 2, "403/500 responses must receive one sanitized compatibility retry");
  const hillsQuery = new URL(compatibilityCalls[0].url).searchParams;
  assert.match(hillsQuery.get("X-Emby-Authorization") || "", /Device="OnePlus-PKG110"/);
  assert.equal(hillsQuery.has("X-Emby-Device-Name"), false, "Hills identity must not duplicate the device name outside its authorization value");
  assert.equal(hillsQuery.has("X-Emby-Device-Id"), false, "Hills identity must not duplicate the device id outside its authorization value");
  assert.match(compatibilityCalls[1].headers.get("User-Agent") || "", /^Hills\//);
  assert.equal(compatibilityCalls[1].headers.get("X-Forwarded-For"), null);
  assert.equal(compatibilityCalls[1].headers.get("CF-Ray"), null);
  const authenticationBody = JSON.stringify({ Username: "demo", Pw: "secret" });
  const authentication = await fetchConfiguredTarget(
    new Request("https://proxy.example.com/zz/Users/AuthenticateByName", {
      method: "POST",
      headers: {
        ...Object.fromEntries(incomingYambyHeaders),
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.9",
        "Cookie": "worker_session=wrong-origin"
      },
      body: authenticationBody
    }),
    new URL("https://origin.example.com/Users/AuthenticateByName"),
    { name: "zz", targets: ["https://origin.example.com"], clientProfile: "hills_android", impersonate: true, headerMode: "dual" },
    new TextEncoder().encode(authenticationBody).buffer,
    { DB: identityDB },
    0
  );
  assert.equal(authentication.response.status, 200);
  assert.equal(authentication.attempts, 2, "a rejected credential login must receive one clean compatibility retry");
  const authenticationCalls = compatibilityCalls.filter((item) => new URL(item.url).pathname.toLowerCase().includes("/users/authenticate"));
  assert.equal(authenticationCalls.length, 2);
  assert.match(authenticationCalls[0].headers.get("User-Agent") || "", /^Hills\//, "the normal login attempt must retain configured impersonation");
  assert.match(authenticationCalls[1].headers.get("User-Agent") || "", /^Yamby\//, "the clean retry must restore the inbound client identity");
  assert.match(authenticationCalls[1].headers.get("X-Emby-Authorization") || "", /Client=Yamby/);
  assert.equal(authenticationCalls[1].headers.get("X-Forwarded-For"), null);
  assert.equal(authenticationCalls[1].headers.get("Cookie"), null);
  const nonIdempotent = await fetchConfiguredTarget(
    new Request("https://proxy.example.com/zz/Sessions/Playing", { method: "POST", body: "{}" }),
    new URL("https://origin.example.com/Sessions/Playing"),
    { name: "zz", targets: ["https://origin.example.com"], clientProfile: "hills_android", impersonate: true, headerMode: "dual" },
    new TextEncoder().encode("{}").buffer,
    { DB: identityDB },
    0
  );
  assert.equal(nonIdempotent.response.status, 500);
  assert.equal(nonIdempotent.attempts, 1, "a 500 response must not replay a non-idempotent request");
} finally {
  globalThis.fetch = originalFetchForCompatibility;
}

const singleFailureRow = {
  ...row,
  name: "single-failure-node",
  targets: JSON.stringify(["https://single-failure.example.com"]),
  stream_target: "",
  stream_mode: "proxy",
  secret: "",
  impersonate: 0,
  cache_image: 0
};
const singleFailureStatements = [];
const singleFailureWaits = [];
const singleFailureEnv = {
  DB: {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return /SELECT \* FROM nodes/.test(sql) ? singleFailureRow : null; },
        async all() { return { results: [] }; },
        async run() { return { success: true }; }
      };
    },
    async batch(statements) {
      singleFailureStatements.push(...statements);
      return statements.map(() => ({ success: true }));
    }
  }
};
const originalFetchForSingleFailure = globalThis.fetch;
globalThis.fetch = async () => new Response("failed", { status: 500 });
try {
  invalidateProxyNodeCache(singleFailureRow.name);
  const response = await worker.fetch(
    new Request(`https://proxy.example.com/${singleFailureRow.name}/Videos/1/stream.mp4`),
    singleFailureEnv,
    { waitUntil(promise) { singleFailureWaits.push(Promise.resolve(promise)); } }
  );
  assert.equal(response.status, 500);
  await response.text();
  await Promise.all(singleFailureWaits);
} finally {
  globalThis.fetch = originalFetchForSingleFailure;
}
const singleFailureLine = singleFailureStatements.find((statement) => /INSERT INTO line_performance/.test(statement.sql));
assert.ok(singleFailureLine, "single-line failures must be persisted in line performance");
assert.equal(singleFailureLine.args[5], 0, "a terminal 500 must not increment line successes");
assert.equal(singleFailureLine.args[6], 1, "a terminal 500 must increment line failures");
const singleFailureMetric = singleFailureStatements.find((statement) => /INSERT INTO performance_metrics/.test(statement.sql));
assert.equal(singleFailureMetric.args[5], 0, "a compatibility retry on the same line must not count as a failover");

let failoverNodeReads = 0;
const failoverRow = {
  ...proxyRow,
  name: "runtime-failover-node",
  targets: JSON.stringify(["https://fail-primary.example.com", "https://fast-backup.example.com"]),
  stream_target: "",
  secret: "",
  cache_image: 0
};
const failoverEnv = {
  UPSTREAM_HEADER_TIMEOUT_MS: "50",
  DB: {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (/SELECT \* FROM nodes/.test(sql)) {
            failoverNodeReads++;
            return failoverRow;
          }
          return null;
        },
        async run() { return { success: true }; }
      };
    },
    async batch() { return []; }
  }
};
const failoverWaits = [];
const failoverCtx = { waitUntil(promise) { failoverWaits.push(Promise.resolve(promise)); } };
const failoverCalls = [];
const originalFetchForFailover = globalThis.fetch;
globalThis.fetch = async (request) => {
  const host = new URL(request.url).host;
  failoverCalls.push(host);
  if (host === "fail-primary.example.com") return new Response("unavailable", { status: 503 });
  return new Response("abc", {
    status: 206,
    headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-2/10", "Content-Length": "3", "Accept-Ranges": "bytes" }
  });
};
try {
  invalidateProxyNodeCache(failoverRow.name);
  for (let i = 0; i < 2; i++) {
    const response = await worker.fetch(
      new Request(`https://proxy.example.com/${failoverRow.name}/video.mp4`, { headers: { Range: "bytes=0-2" } }),
      failoverEnv,
      failoverCtx
    );
    assert.equal(response.status, 206);
    assert.equal(await response.text(), "abc");
  }
  await Promise.all(failoverWaits);
} finally {
  globalThis.fetch = originalFetchForFailover;
}
assert.deepEqual(
  failoverCalls,
  ["fail-primary.example.com", "fast-backup.example.com", "fast-backup.example.com"],
  "subsequent stream requests must skip a recently failed primary"
);
assert.equal(failoverNodeReads, 1, "failover requests must retain the node cache benefit");

console.log("performance checks passed");
