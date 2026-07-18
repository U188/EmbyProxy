import assert from "node:assert/strict";
import worker from "../src/index.js";

const response = await worker.fetch(
  new Request("https://admin.test/admin"),
  {},
  { waitUntil() {} }
);
const html = await response.text();

assert.equal(response.status, 200, "admin page must render");

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.equal(scripts.length, 1, "admin page must contain one inline script");
new Function(scripts[0]);

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "DOM ids must be unique");

const idSet = new Set(ids);
const staticRefs = [...scripts[0].matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]);
const missingRefs = [...new Set(staticRefs.filter((id) => !idSet.has(id)))];
assert.deepEqual(missingRefs, [], `missing DOM ids: ${missingRefs.join(", ")}`);

const pages = new Set([...html.matchAll(/data-page="([^"]+)"/g)].map((match) => match[1]));
const tabs = new Set([...html.matchAll(/data-page-tab="([^"]+)"/g)].map((match) => match[1]));
assert.deepEqual([...tabs].sort(), [...pages].sort(), "page tabs and page panels must match");

for (const id of ["nodeGrid", "watchLogRows", "traceEntry", "traceEgress", "mobileTraceEntry", "mobileTraceEgress", "mobileRttValue", "dialogBackdrop"]) {
  assert.ok(idSet.has(id), `required visible surface is missing: ${id}`);
}
for (const id of ["streamStrategy", "streamTimeoutMs", "watchContentType", "watchWindowStart", "performanceNodeRows", "performanceLineRows"]) {
  assert.ok(idSet.has(id), `new operational control is missing: ${id}`);
}
for (const id of ["streamConfigSection", "watchStrategySection"]) {
  assert.ok(idSet.has(id), `mobile shortcut target is missing: ${id}`);
}
assert.ok(html.indexOf('id="perfRequests"') < html.indexOf('id="trafficToday"'), "real performance must appear before legacy traffic cards");
assert.match(html, /data-act="stream-edit"[\s\S]*?data-act="watch-edit"/, "node cards must expose video and watch shortcuts");
assert.match(scripts[0], /editNodeSection\(name, "streamConfigSection"\)/, "video shortcut must open the video section");
assert.match(scripts[0], /editNodeSection\(name, "watchStrategySection"\)/, "watch shortcut must open the watch section");
assert.match(html, /id="nodeEditorPanel" hidden/, "node editor must start hidden");
assert.match(html, /id="deployBody" hidden/, "deploy editor must start hidden");
assert.doesNotMatch(html, /id="nodeGrid"[^>]*\shidden(?:\s|>)/, "node cards must not be hidden");
assert.doesNotMatch(html, /边缘延迟见侧栏|<p>管理\s/, "header must not expose configured domains");
assert.match(
  html,
  /@media\(max-width:980px\)\{[\s\S]*?\.hero-bar>div:first-child\{display:none\}/,
  "mobile header content must stay collapsed"
);
assert.match(html, /@media\(max-width:980px\)\{[\s\S]*?\.sidebar\{display:none\}/, "mobile status sidebar must not consume the first viewport");
assert.match(html, /@media\(max-width:980px\)\{[\s\S]*?\.mobile-edge-bar\{[\s\S]*?display:grid/, "mobile edge status must remain visible");
assert.match(html, /\.hero-bar\{[\s\S]*?z-index:1000;[\s\S]*?overflow:visible/, "more menu parent must stay above page panels");
assert.match(html, /\.icon-menu\[open\]\{z-index:1100\}/, "open more menu must create a top layer");
assert.match(html, /class="network-workspace"/, "network results and DNS must use the dedicated workspace layout");
assert.match(html, /class="panel network-results"/, "speed test results must have a dedicated panel");
assert.match(html, /class="panel network-dns"/, "DNS controls must have a dedicated panel");
assert.match(html, /<details class="dns-details">[\s\S]*?id="dnsOut"/, "raw DNS response must be collapsed by default");
assert.match(html, /<tr class="ip-empty-row">/, "speed test empty state must have a dedicated mobile layout");
assert.match(scripts[0], /querySelector\("\.ip-empty-row"\)\?\.remove\(\)/, "speed test data must replace the empty state");

const functions = [...scripts[0].matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)]
  .map((match) => match[1]);
const duplicates = [...new Set(functions.filter((name, index) => functions.indexOf(name) !== index))];
assert.deepEqual(duplicates, [], `duplicate client functions: ${duplicates.join(", ")}`);

const apiRoutes = new Set(
  [...html.matchAll(/api\(["'](\/api\/[^"'?]+)/g)].map((match) => match[1])
);
for (const required of ["/api/nodes", "/api/watch-logs", "/api/keepalive/reset", "/api/ping-node"]) {
  assert.ok(apiRoutes.has(required), `required client API call is missing: ${required}`);
}
for (const required of ["/api/performance", "/api/stream-health"]) {
  assert.ok(apiRoutes.has(required), `new operational API call is missing: ${required}`);
}

console.log(`admin checks passed: ${ids.length} ids, ${tabs.size} pages, ${apiRoutes.size} API calls`);
