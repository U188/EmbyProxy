import assert from "node:assert/strict";
import test from "node:test";

import {
  buildImageCacheKey,
  canForwardRawProxyRequest,
  directFallbackForBlockedUpstream,
  embyRaw,
  isAuthorizedTelegramChat,
  isValidTelegramWebhookSecret,
  isValidDNSRecordContent,
  reconcileDNSRecords,
  requestHasCredentials,
  signRawProxyTarget,
  stripSensitiveRequestHeaders,
  verifyRawProxyTarget,
  workerBindings
} from "../src/index.js";

test("raw proxy signatures bind the target URL and node", async () => {
  const env = { RAW_PROXY_SIGNING_KEY: "test-signing-key" };
  const node = { name: "node-a" };
  const raw = "https://cdn.example.test/video.m3u8?sig=abc";
  const signature = await signRawProxyTarget(env, node, raw);

  assert.equal(await verifyRawProxyTarget(env, node, raw, signature), true);
  assert.equal(await verifyRawProxyTarget(env, { name: "node-b" }, raw, signature), false);
  assert.equal(await verifyRawProxyTarget(env, node, raw + "&extra=1", signature), false);
});

test("external raw proxy targets only accept read methods", () => {
  const node = { targets: ["https://emby.example.test"], streamTarget: "" };
  const external = new URL("https://cdn.example.test/license");
  const trusted = new URL("https://emby.example.test/license");

  assert.equal(canForwardRawProxyRequest(new Request(external, { method: "GET" }), node, external), true);
  assert.equal(canForwardRawProxyRequest(new Request(external, { method: "POST" }), node, external), false);
  assert.equal(canForwardRawProxyRequest(new Request(trusted, { method: "POST" }), node, trusted), true);
});

test("cross-origin forwarding removes credentials and Emby identity headers", () => {
  const headers = new Headers({
    Authorization: "Bearer secret",
    "Api-Key": "api-secret",
    Cookie: "session=secret",
    Origin: "https://proxy.example.test",
    Referer: "https://proxy.example.test/node-secret/Videos/1/stream",
    "Sec-Fetch-Site": "same-origin",
    "X-Csrf-Token": "csrf-secret",
    "X-Emby-Token": "emby-token",
    "X-MediaBrowser-Authorization": "Emby Token=token",
    "X-Real-IP": "203.0.113.1",
    "User-Agent": "allowed"
  });
  stripSensitiveRequestHeaders(headers);

  assert.equal(headers.has("Authorization"), false);
  assert.equal(headers.has("Api-Key"), false);
  assert.equal(headers.has("Cookie"), false);
  assert.equal(headers.has("Origin"), false);
  assert.equal(headers.has("Referer"), false);
  assert.equal(headers.has("Sec-Fetch-Site"), false);
  assert.equal(headers.has("X-Csrf-Token"), false);
  assert.equal(headers.has("X-Emby-Token"), false);
  assert.equal(headers.has("X-MediaBrowser-Authorization"), false);
  assert.equal(headers.has("X-Real-IP"), false);
  assert.equal(headers.get("User-Agent"), "allowed");
});

test("authenticated image requests are not cacheable under a shared key", () => {
  const authenticated = new Request("https://proxy.example.test/node/Items/1/Images/Primary?api_key=secret", {
    headers: { "X-MediaBrowser-Authorization": 'MediaBrowser Token="secret"' }
  });
  const headerAuthenticated = new Request("https://proxy.example.test/node/Items/1/Images/Primary", {
    headers: { "X-Emby-Token": "secret" }
  });
  const anonymous = new Request("https://proxy.example.test/node/Items/1/Images/Primary");
  const identityOnly = new Request("https://proxy.example.test/node/Items/1/Images/Primary", {
    headers: { "X-Emby-Client": "Yamby" }
  });
  const routeStateOnly = new Request("https://proxy.example.test/node/Items/1/Images/Primary", {
    headers: { Cookie: "__ep_direct_abc=1; __ep_proxy_xyz=proxy" }
  });
  const outbound = new Request("https://upstream.example.test/Items/1/Images/Primary");
  const webpOutbound = new Request(outbound.url, { headers: { Accept: "image/webp,image/*" } });

  assert.equal(requestHasCredentials(authenticated), true);
  assert.equal(requestHasCredentials(headerAuthenticated), true);
  assert.equal(requestHasCredentials(anonymous), false);
  assert.equal(requestHasCredentials(identityOnly), false);
  assert.equal(requestHasCredentials(routeStateOnly), false);
  assert.notEqual(
    buildImageCacheKey(outbound, { name: "node-a" }).url,
    buildImageCacheKey(outbound, { name: "node-b" }).url
  );
  assert.notEqual(
    buildImageCacheKey(outbound, { name: "node-a" }).url,
    buildImageCacheKey(webpOutbound, { name: "node-a" }).url
  );
});

test("Cloudflare 403 fallback only redirects playback streams", () => {
  const blocked = new Response("<html>blocked</html>", {
    status: 403,
    headers: {
      server: "cloudflare",
      "content-type": "text/html",
      "cf-ray": "abc"
    }
  });
  const node = { directExternal: true };
  const apiRequest = new Request("https://proxy.example.test/node/Users/AuthenticateByName", { method: "POST" });
  const streamRequest = new Request("https://proxy.example.test/node/Videos/1/stream", {
    headers: { Range: "bytes=0-1" }
  });
  const target = new URL("https://upstream.example.test/Videos/1/stream");
  const opaqueCDNTarget = new URL("https://cdn.example.test/download?id=abc");

  assert.equal(directFallbackForBlockedUpstream(apiRequest, blocked, target, node), null);
  assert.equal(directFallbackForBlockedUpstream(streamRequest, blocked, target, node)?.status, 302);
  assert.equal(directFallbackForBlockedUpstream(streamRequest, blocked, opaqueCDNTarget, node)?.status, 302);
});

test("simulated watch redirects do not leak auth or POST bodies cross-origin", async () => {
  const originalFetch = globalThis.fetch;
  const snap = {
    ua: "Yamby/Test",
    client: "Yamby",
    version: "1",
    device: "Android",
    deviceId: "device-id"
  };
  const credentials = { token: "emby-secret", userId: "user-id" };
  const calls = [];

  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body });
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.test/media/file" }
        });
      }
      return new Response("ok");
    };
    const readResponse = await embyRaw(
      "https://emby.example.test",
      "/Videos/1/stream",
      { headers: { Referer: "https://proxy.example.test/node-secret/" } },
      snap,
      credentials
    );

    assert.equal(readResponse.status, 200);
    assert.equal(calls[0].headers.get("X-Emby-Token"), "emby-secret");
    assert.equal(calls[1].headers.has("X-Emby-Token"), false);
    assert.equal(calls[1].headers.has("X-Emby-Authorization"), false);
    assert.equal(calls[1].headers.has("Referer"), false);

    calls.length = 0;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body });
      return new Response(null, {
        status: 307,
        headers: { location: "https://cdn.example.test/collect" }
      });
    };
    const postResponse = await embyRaw(
      "https://emby.example.test",
      "/Users/AuthenticateByName",
      { method: "POST", body: { Username: "user", Pw: "password" } },
      snap,
      credentials
    );

    assert.equal(postResponse.status, 307);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Telegram reports only accept configured chats", () => {
  const env = { TG_CHAT_ID: "100", TG_CHAT_ID_2: "200" };
  assert.equal(isAuthorizedTelegramChat(env, 100), true);
  assert.equal(isAuthorizedTelegramChat(env, "200"), true);
  assert.equal(isAuthorizedTelegramChat(env, "300"), false);
  assert.equal(isValidTelegramWebhookSecret("a_secure-secret_123"), true);
  assert.equal(isValidTelegramWebhookSecret("base64+/="), false);
});

test("DNS content validation rejects malformed records before mutation", () => {
  assert.equal(isValidDNSRecordContent("A", "203.0.113.10"), true);
  assert.equal(isValidDNSRecordContent("A", "999.0.0.1"), false);
  assert.equal(isValidDNSRecordContent("AAAA", "2001:db8::1"), true);
  assert.equal(isValidDNSRecordContent("AAAA", "2001:::1"), false);
  assert.equal(isValidDNSRecordContent("CNAME", "edge.example.com"), true);
  assert.equal(isValidDNSRecordContent("CNAME", "https://edge.example.com/path"), false);
});

test("DNS reconciliation patches proxy state without recreating identical content", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: JSON.parse(init.body || "{}") });
    return new Response(JSON.stringify({
      success: true,
      result: {
        id: "record-1",
        type: "A",
        content: "203.0.113.10",
        proxied: false,
        ttl: 60
      }
    }), { headers: { "content-type": "application/json" } });
  };

  try {
    const current = [{
      id: "record-1",
      type: "A",
      content: "203.0.113.10",
      proxied: true,
      ttl: 1
    }];
    const result = await reconcileDNSRecords(
      { CF_API_TOKEN: "token", CF_ZONE_ID: "zone" },
      "media.example.test",
      current,
      current,
      [{ type: "A", content: "203.0.113.10", proxied: false, ttl: 60 }]
    );

    assert.equal(result.ok, true);
    assert.equal(result.updated.length, 1);
    assert.deepEqual(calls.map((call) => call.method), ["PATCH"]);
    assert.deepEqual(calls[0].body, {
      type: "A",
      name: "media.example.test",
      content: "203.0.113.10",
      proxied: false,
      ttl: 60
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DNS reconciliation rolls back completed updates after a later failure", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init = {}) => {
    const method = init.method || "GET";
    const body = JSON.parse(init.body || "{}");
    calls.push({ method, body });
    if (method === "POST") {
      return new Response(JSON.stringify({
        success: false,
        errors: [{ message: "creation denied" }]
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      success: true,
      result: {
        id: "record-1",
        type: "A",
        content: "203.0.113.10",
        proxied: body.proxied,
        ttl: body.ttl
      }
    }), { headers: { "content-type": "application/json" } });
  };

  try {
    const current = [{
      id: "record-1",
      type: "A",
      content: "203.0.113.10",
      proxied: true,
      ttl: 1
    }];
    const result = await reconcileDNSRecords(
      { CF_API_TOKEN: "token", CF_ZONE_ID: "zone" },
      "media.example.test",
      current,
      current,
      [
        { type: "A", content: "203.0.113.10", proxied: false, ttl: 60 },
        { type: "A", content: "203.0.113.11", proxied: false, ttl: 60 }
      ]
    );

    assert.equal(result.ok, false);
    assert.match(result.error, /变更已回滚/);
    assert.deepEqual(calls.map((call) => call.method), ["PATCH", "POST", "PATCH"]);
    assert.equal(calls[2].body.proxied, true);
    assert.equal(calls[2].body.ttl, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("self-deploy bindings preserve D1 and hydrate runtime text values", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    result: [
      { name: "DB", type: "d1", id: "database-id" },
      { name: "ADMIN_TOKEN", type: "secret_text" },
      { name: "CF_API_TOKEN", type: "secret_text" },
      { name: "CUSTOM_TEXT", type: "plain_text", text: "stale" },
      { name: "CF_DOMAIN", type: "secret_text" },
      { name: "CF_ACCOUNT_ID", type: "plain_text", text: "stale-account" }
    ]
  }), { headers: { "content-type": "application/json" } });

  try {
    const bindings = await workerBindings({
      DB: {},
      ADMIN_TOKEN: "admin-secret",
      CF_API_TOKEN: "cf-secret",
      CF_ACCOUNT_ID: "account-id",
      CF_WORKER_NAME: "worker-name",
      CF_DOMAIN: "private.example.test",
      CUSTOM_TEXT: "current"
    });
    const byName = new Map(bindings.map((binding) => [binding.name, binding]));

    assert.equal(byName.get("DB").id, "database-id");
    assert.equal(byName.get("ADMIN_TOKEN").text, "admin-secret");
    assert.equal(byName.get("CF_API_TOKEN").text, "cf-secret");
    assert.equal(byName.get("CUSTOM_TEXT").text, "current");
    assert.equal(byName.get("CF_ACCOUNT_ID").text, "account-id");
    assert.equal(byName.get("CF_DOMAIN").type, "secret_text");
    assert.equal(byName.get("CF_DOMAIN").text, "private.example.test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("self-deploy bindings reject an incomplete D1 binding", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    result: [
      { name: "DB", type: "d1" },
      { name: "ADMIN_TOKEN", type: "secret_text" },
      { name: "CF_API_TOKEN", type: "secret_text" }
    ]
  }), { headers: { "content-type": "application/json" } });

  try {
    await assert.rejects(
      workerBindings({
        DB: {},
        ADMIN_TOKEN: "admin-secret",
        CF_API_TOKEN: "cf-secret",
        CF_ACCOUNT_ID: "account-id",
        CF_WORKER_NAME: "worker-name"
      }),
      /D1 binding .*数据库 ID/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
