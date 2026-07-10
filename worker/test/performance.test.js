import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  directStreamDecision,
  invalidateTargetHealth,
  orderTargetsByHealth,
  recordTargetHealth,
  stripInternalProxyCookies
} from "../src/index.js";

function nodeRow(name = "fast-node", overrides = {}) {
  return {
    name,
    display_name: "Fast Node",
    targets: JSON.stringify(["https://api.example.test"]),
    stream_target: "https://video.example.test",
    secret: "",
    client_profile: "yamby",
    impersonate: 0,
    header_mode: "off",
    stream_mode: "proxy",
    direct_external: 0,
    cache_image: 0,
    sort_order: 0,
    enabled: 1,
    created_at: 1,
    updated_at: 1,
    ...overrides
  };
}

function mockDatabase(row) {
  const sql = [];
  let nodeReads = 0;
  let nodeListReads = 0;
  return {
    sql,
    get nodeReads() {
      return nodeReads;
    },
    get nodeListReads() {
      return nodeListReads;
    },
    prepare(statement) {
      sql.push(statement);
      const prepared = {
        bind() {
          return prepared;
        },
        async first() {
          if (/SELECT \* FROM nodes WHERE name = \?/i.test(statement)) {
            nodeReads++;
            return row;
          }
          return null;
        },
        async all() {
          if (/SELECT \* FROM nodes ORDER BY/i.test(statement)) {
            nodeListReads++;
            return { results: [row] };
          }
          return { results: [] };
        },
        async run() {
          return { success: true };
        }
      };
      return prepared;
    },
    async batch() {
      return [];
    }
  };
}

function executionContext() {
  return {
    waitUntil(promise) {
      Promise.resolve(promise).catch(() => {});
    }
  };
}

test("playback requests skip schema migration and reuse the node cache", async () => {
  const originalFetch = globalThis.fetch;
  const db = mockDatabase(nodeRow());
  const env = { DB: db, NODE_CACHE_TTL_SECONDS: "30" };
  const request = () => new Request("https://proxy.example.test/fast-node/Videos/1/stream.mp4", {
    headers: { Range: "bytes=0-3" }
  });

  try {
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 206,
      headers: {
        "content-type": "video/mp4",
        "content-length": "4",
        "content-range": "bytes 0-3/100",
        "accept-ranges": "bytes"
      }
    });

    const first = await worker.fetch(request(), env, executionContext());
    assert.equal(first.status, 206);
    assert.match(first.headers.get("server-timing") || "", /ep-node;dur=.*desc="d1"/);
    assert.match(first.headers.get("server-timing") || "", /ep-upstream;dur=.*desc="1 request"/);
    await first.arrayBuffer();

    const second = await worker.fetch(request(), env, executionContext());
    assert.equal(second.status, 206);
    assert.match(second.headers.get("server-timing") || "", /ep-node;dur=.*desc="cache"/);
    await second.arrayBuffer();

    assert.equal(db.nodeReads, 1);
    assert.equal(db.sql.some((statement) => /\bCREATE TABLE\b|\bPRAGMA table_info\b/i.test(statement)), false);
  } finally {
    globalThis.fetch = originalFetch;
    invalidateTargetHealth("fast-node");
  }
});

test("playback metadata rewriting does not query the full node table", async () => {
  const originalFetch = globalThis.fetch;
  const db = mockDatabase(nodeRow("metadata-node"));
  const env = { DB: db };

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ MediaSources: [] }), {
      headers: { "content-type": "application/json" }
    });
    const response = await worker.fetch(
      new Request("https://proxy.example.test/metadata-node/Items/1/PlaybackInfo"),
      env,
      executionContext()
    );
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(db.nodeReads, 1);
    assert.equal(db.nodeListReads, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream targets preserve configured order until health is known", () => {
  const node = "adaptive-order";
  const primary = "https://primary.example.test";
  const secondary = "https://secondary.example.test";
  invalidateTargetHealth(node);

  recordTargetHealth(node, primary, 300, 200, false, 1000);
  assert.deepEqual(
    orderTargetsByHealth(node, [primary, secondary], 1001),
    [primary, secondary]
  );

  recordTargetHealth(node, secondary, 80, 200, false, 1000);
  assert.deepEqual(
    orderTargetsByHealth(node, [primary, secondary], 1001),
    [secondary, primary]
  );

  invalidateTargetHealth(node);
});

test("retryable stream target failures enter cooldown", () => {
  const node = "adaptive-failure";
  const primary = "https://primary.example.test";
  const secondary = "https://secondary.example.test";
  invalidateTargetHealth(node);

  recordTargetHealth(node, primary, 500, 503, false, 1000);
  assert.deepEqual(
    orderTargetsByHealth(node, [primary, secondary], 1001),
    [secondary, primary]
  );
  assert.deepEqual(
    orderTargetsByHealth(node, [primary, secondary], 1000 + 30001),
    [primary, secondary]
  );

  invalidateTargetHealth(node);
});

test("auto mode proxies a repeated direct attempt within the retry window", () => {
  const node = {
    name: "auto-retry-node",
    streamMode: "auto",
    directExternal: true
  };
  const url = "https://proxy.example.test/auto-retry-node/Videos/1/stream.mkv";
  const firstRequest = new Request(url, {
    headers: {
      "cf-connecting-ip": "203.0.113.10",
      "user-agent": "Yamby/Test",
      range: "bytes=0-"
    }
  });
  const first = directStreamDecision(node, firstRequest, "/Videos/1/stream.mkv", 1000);
  assert.equal(first.redirect, true);
  assert.match(first.retryCookie, /^__ep_direct_[a-z0-9]+=1;/);

  const cookieRetry = new Request(url, {
    headers: {
      cookie: first.retryCookie.split(";")[0],
      "cf-connecting-ip": "203.0.113.11",
      "user-agent": "Yamby/Test",
      range: "bytes=0-"
    }
  });
  assert.equal(
    directStreamDecision(node, cookieRetry, "/Videos/1/stream.mkv", 1001).redirect,
    false
  );
  assert.equal(
    directStreamDecision(node, firstRequest, "/Videos/1/stream.mkv", 1002).redirect,
    false
  );
  assert.equal(
    directStreamDecision(node, firstRequest, "/Videos/1/stream.mkv", 1000 + 45001).redirect,
    true
  );
});

test("auto mode returns an uncached redirect before proxying a retry", async () => {
  const originalFetch = globalThis.fetch;
  const db = mockDatabase(nodeRow("auto-integration", {
    stream_mode: "auto",
    direct_external: 1
  }));
  const env = { DB: db };
  const request = () => new Request("https://proxy.example.test/auto-integration/Videos/2/stream.mkv", {
    headers: {
      "cf-connecting-ip": "203.0.113.20",
      "user-agent": "Yamby/Integration",
      range: "bytes=0-3"
    }
  });
  let upstreamCalls = 0;

  try {
    globalThis.fetch = async () => {
      upstreamCalls++;
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: {
          "content-type": "video/x-matroska",
          "content-length": "4",
          "content-range": "bytes 0-3/100"
        }
      });
    };

    const direct = await worker.fetch(request(), env, executionContext());
    assert.equal(direct.status, 302);
    assert.equal(direct.headers.get("cache-control"), "no-store");
    assert.match(direct.headers.get("set-cookie") || "", /^__ep_direct_/);
    assert.equal(upstreamCalls, 0);

    const proxied = await worker.fetch(request(), env, executionContext());
    assert.equal(proxied.status, 206);
    assert.equal(upstreamCalls, 1);
    await proxied.arrayBuffer();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("explicit direct and proxy modes keep their configured behavior", () => {
  const request = new Request("https://proxy.example.test/node/Videos/1/stream.mkv");
  assert.equal(
    directStreamDecision({ name: "node", streamMode: "direct" }, request, "/Videos/1/stream.mkv").redirect,
    true
  );
  assert.equal(
    directStreamDecision({ name: "node", streamMode: "proxy", directExternal: true }, request, "/Videos/1/stream.mkv").redirect,
    false
  );
});

test("auto direct markers are not forwarded to upstream servers", () => {
  const headers = new Headers({
    Cookie: "session=allowed; __ep_direct_abc=1; preference=dark"
  });
  stripInternalProxyCookies(headers);
  assert.equal(headers.get("cookie"), "session=allowed; preference=dark");
});
