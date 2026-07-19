import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const moduleURL = `data:text/javascript;base64,${Buffer.from(`${source}\nexport { getProxyNode, invalidateProxyNodeCache, shouldRewriteBody, withServerTiming, orderTargetsByHealth, recordTargetOutcome, fetchWithHeaderTimeout, shouldRecordVisitorLog, readStreamTextLimited, readStreamBytesLimited, BodyLimitError, shouldUseDirectStream, performanceHistogram, histogramPercentile, targetHeaderTimeoutMs, trackTargetOutcome, saveNode, performanceMetricStatement, linePerformanceStatement, profileSnapshot, normalizeDeviceState, getClientProfile, isAuthenticationIdentityRequest, buildHeaders };`).toString("base64")}`;
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
  buildHeaders
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

const incomingHillsHeaders = new Headers({
  "User-Agent": "Hills/1.7.2 (android; 15)",
  "X-Emby-Authorization": 'MediaBrowser Client="Hills", Device="Pixel 9", DeviceId="real-device-123", Version="1.7.2"'
});
const incomingSnapshot = profileSnapshot("hills_android", {
  profiles: { hills_android: { deviceName: "EmbyProxy Android", deviceId: "0123456789abcdef" } }
}, incomingHillsHeaders, new URL("https://origin.example.com/Users/AuthenticateByName"));
assert.equal(incomingSnapshot.device, "Pixel 9", "proxying must preserve the real client device name");
assert.equal(incomingSnapshot.deviceId, "real-device-123", "proxying must preserve the real client device id");
assert.equal(
  normalizeDeviceState(getClientProfile("hills_android"), { deviceName: "diting", deviceId: "0123456789abcdef" }).deviceName,
  "EmbyProxy Android",
  "legacy Hills identity state must migrate away from diting"
);
assert.equal(isAuthenticationIdentityRequest(new URL("https://origin.example.com/Users/AuthenticateByName")), true);
const identityDB = {
  prepare() {
    return {
      bind() { return this; },
      async first() { return null; },
      async run() { return { success: true }; }
    };
  }
};
const loginTarget = new URL("https://origin.example.com/Users/AuthenticateByName");
const loginHeaders = await buildHeaders(
  new Request("https://proxy.example.com/zz/Users/AuthenticateByName", { method: "POST", headers: incomingHillsHeaders }),
  loginTarget,
  { name: "zz", targets: ["https://origin.example.com"], clientProfile: "hills_android", impersonate: true, headerMode: "off" },
  { DB: identityDB }
);
assert.match(loginHeaders.get("X-Emby-Authorization") || "", /Device="Pixel 9"/);
assert.match(loginHeaders.get("X-Emby-Authorization") || "", /DeviceId="real-device-123"/);

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
