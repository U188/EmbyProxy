import assert from "node:assert/strict";
import {
  buildWranglerConfig,
  normalizeDomain,
  normalizeWorkerName,
  parseCreatedDatabase,
  parseD1List,
  parseLocalConfig,
  parseWhoami,
  validateReusableConfig,
} from "./setup.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const zoneId = "fedcba9876543210fedcba9876543210";
const databaseId = "12345678-1234-4234-9234-123456789abc";

assert.deepEqual(parseWhoami({ accounts: [{ id: accountId, name: "Example" }] }), [
  { id: accountId, name: "Example" },
]);
assert.deepEqual(parseWhoami({ memberships: [{ account: { id: accountId, name: "Example" } }] }), [
  { id: accountId, name: "Example" },
]);
assert.deepEqual(parseWhoami({ loggedIn: true }), []);
assert.deepEqual(parseD1List({ result: [{ uuid: databaseId, name: "media_gateway" }] }), [
  { id: databaseId, name: "media_gateway" },
]);
assert.deepEqual(parseCreatedDatabase(`database_name = "media_gateway"\ndatabase_id = "${databaseId}"`), {
  id: databaseId,
  name: "media_gateway",
});

assert.equal(normalizeDomain("Admin.Example.com."), "admin.example.com");
assert.equal(normalizeWorkerName("emby-proxy-1"), "emby-proxy-1");
assert.throws(() => normalizeDomain("https://admin.example.com/path"));
assert.throws(() => normalizeWorkerName("Emby_Proxy"));

const config = buildWranglerConfig({
  workerName: "embyproxy",
  accountId,
  zoneId,
  adminDomain: "admin.example.com",
  dispatchDomain: "media.example.com",
  zoneName: "example.com",
  databaseName: "media_gateway",
  databaseId,
  reportHour: 9,
  preferredIpsUrl: "https://example.com/ips.txt",
});
assert.match(config, new RegExp(`account_id = "${accountId}"`));
assert.match(config, /pattern = "admin\.example\.com", custom_domain = true/);
assert.match(config, /pattern = "media\.example\.com\/\*", zone_name = "example\.com"/);
assert.match(config, /crons = \["\* \* \* \* \*"\]/);
assert.match(config, /AUTO_WATCH_MAX_CONCURRENCY = "2"/);
assert.match(config, new RegExp(`database_id = "${databaseId}"`));
assert.doesNotMatch(config, /ADMIN_TOKEN|CF_API_TOKEN|TG_BOT_TOKEN|secret/i);
assert.throws(() => buildWranglerConfig({
  workerName: "embyproxy",
  accountId,
  zoneId,
  adminDomain: "admin.example.com",
  dispatchDomain: "media.example.com",
  zoneName: "example.com",
  databaseName: "invalid name",
  databaseId,
  reportHour: 9,
}));

const parsed = parseLocalConfig(config);
assert.equal(parsed.workerName, "embyproxy");
assert.equal(parsed.accountId, accountId);
assert.equal(parsed.zoneId, zoneId);
assert.equal(parsed.adminDomain, "admin.example.com");
assert.equal(parsed.dispatchDomain, "media.example.com");
assert.equal(parsed.databaseName, "media_gateway");
assert.equal(parsed.databaseId, databaseId);
assert.equal(validateReusableConfig(parsed), parsed);
assert.throws(() => validateReusableConfig({ ...parsed, adminDomain: "https://admin.example.com" }));

console.log("Setup wizard checks passed.");
