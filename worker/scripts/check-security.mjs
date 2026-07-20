import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/index.js";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");
const rootIgnore = await readFile(new URL("../../.gitignore", import.meta.url), "utf8");

assert.match(source, /verifyRawProxySignature\(env, node, raw, signature\)/, "raw proxy URLs must be signed");
assert.match(source, /rawExternal: true/, "raw proxy requests must use the external-header policy");
assert.match(source, /"Authorization", "Cookie", "X-Emby-Token"/, "external raw requests must strip sensitive headers");
assert.match(source, /!hasSensitiveRequestAuth\(request\)/, "authenticated image responses must not enter shared cache");
assert.match(source, /headers\.set\("Cache-Control", "private, no-store"\)/, "authenticated image responses must not be publicly cacheable");
assert.match(source, /new Request\(inboundURL\.toString\(\), \{ method: "GET" \}\)/, "image cache keys must remain node scoped");
assert.match(source, /if \(!env\.TG_WEBHOOK_SECRET\)/, "Telegram webhooks must require a secret");
assert.match(source, /allowedChats\.has\(cleanString\(incomingChatId\)\)/, "Telegram webhooks must enforce chat allowlists");
for (const marker of [
  "admin.example.com",
  "media.example.com",
  "replace-with-account-id",
  "replace-with-zone-id",
  "replace-with-d1-database-id"
]) {
  assert.ok(config.includes(marker), `tracked Wrangler config must retain template marker: ${marker}`);
}
const configuredDomains = [...config.matchAll(/(?:pattern|CF_DOMAIN|CF_DNS_DOMAIN)\s*=\s*"([^"]+)"/g)]
  .map((match) => match[1]);
assert.ok(configuredDomains.every((value) => value.includes("example.com")), "tracked Wrangler config must only contain example domains");
assert.match(rootIgnore, /worker\/wrangler\.local\.toml/, "local Wrangler config must be ignored");

const isolatedEnv = {
  CF_DOMAIN: "admin.example.com",
  CF_DNS_DOMAIN: "media.example.com",
  ADMIN_TOKEN: "test-admin-token"
};
const context = { waitUntil() {} };
const adminPage = await worker.fetch(new Request("https://admin.example.com/admin"), isolatedEnv, context);
assert.equal(adminPage.status, 200);
assert.match(adminPage.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
assert.equal(
  (await worker.fetch(new Request("https://media.example.com/admin"), isolatedEnv, context)).status,
  404,
  "the dispatch host must not expose the admin page"
);
assert.equal(
  (await worker.fetch(new Request("https://admin.example.com/a-node/System/Info"), isolatedEnv, context)).status,
  404,
  "the management host must not serve upstream proxy content"
);
assert.equal(
  (await worker.fetch(new Request("https://media.example.com/api/nodes", {
    headers: { authorization: "Bearer test-admin-token" }
  }), isolatedEnv, context)).status,
  404,
  "the dispatch host must not expose management APIs"
);
assert.equal((await worker.fetch(new Request("https://media.example.com/api/health"), isolatedEnv, context)).status, 200);

console.log("security checks passed");
