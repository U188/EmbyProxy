import assert from "node:assert/strict";
import worker from "../src/index.js";

const response = await worker.fetch(
  new Request("https://admin.test/admin"),
  {},
  { waitUntil() {} }
);
const html = await response.text();

assert.equal(response.status, 200, "admin page must render");

const scripts = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.equal(scripts.length, 1, "admin page must contain one inline script");
new Function(scripts[0]);
assert.match(response.headers.get("content-security-policy") || "", /script-src 'nonce-[0-9a-f]+'/i, "admin scripts must use a per-response CSP nonce");

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
assert.match(html, /<th>入站客户端<\/th><th>出站模拟客户端<\/th>/, "visitor logs must distinguish inbound and outbound clients");
assert.match(scripts[0], /CLIENT_LABELS\[r\.outbound_profile\]/, "outbound profile ids must render as client labels");
assert.equal((scripts[0].match(/\$\("logRows"\)\.innerHTML/g) || []).length, 1, "only the stats response may render visitor rows");
assert.match(html, /@media\(max-width:560px\)\{[\s\S]*?\.visitor-table td\{display:grid/, "mobile visitor logs must render as readable cards");
assert.match(scripts[0], /data-label="入站客户端"[\s\S]*?data-label="出站模拟"/, "mobile visitor cards must label both identities");
assert.match(html, /class="route-summary"/, "node cards must prioritize the latest actual playback route");
assert.match(html, /<span>最近响应<\/span>/, "node cards must expose the latest observed playback response");
assert.match(html, /最近播放路径/, "route cards must describe the observable routing decision");
assert.match(scripts[0], /不代表客户端已播成功/, "direct redirects must not be presented as confirmed playback");
assert.match(scripts[0], /拖动直连回退/, "range fallback redirects must be identified separately on node cards");
assert.match(scripts[0], /中转响应/, "proxied response headers must not be presented as completed playback");
assert.match(html, /不读取视频正文测速/, "the admin must state that playback bodies are not sampled for speed");
assert.doesNotMatch(html, /上游读取吞吐|个读取样本|近 1 小时均速/, "retired playback speed metrics must not remain visible");
assert.match(html, /条件直连（鉴权兼容时）/, "conditional direct mode must describe its actual decision rule");
assert.match(html, /多条中转线路按响应耗时和近期失败状态选择/, "the playback editor must explain health-based line selection");
assert.doesNotMatch(html, /<option value="auto">自动<\/option>|自动模式允许直链|自动判断/, "ambiguous direct-mode copy must be removed");
assert.match(scripts[0], /sessionStorage\.getItem\(tokenKey\)/, "admin credentials must be scoped to the current tab");
assert.doesNotMatch(scripts[0], /localStorage\.setItem\(tokenKey/, "admin credentials must not persist in localStorage");
assert.doesNotMatch(scripts[0], /rawLatency\s*>=\s*500|rawLatency\s*-\s*400/, "browser latency must not be cosmetically rewritten");
assert.match(scripts[0], /catch \(err\) \{[\s\S]*?markTimeout\(latTd, spdTd, tr\)/, "network and certificate failures must remain unavailable");
assert.match(html, /class="card-meta-grid"/, "node cards must group operational metadata for scanning");
assert.match(html, /class="card-flip-shell"/, "node cards must provide a stable two-sided surface");
assert.match(html, /class="card-face card-front"[\s\S]*?class="card-face card-back" aria-hidden="true" inert/, "the hidden card face must not expose interactive controls");
assert.match(scripts[0], /Math\.hypot\([\s\S]*?> 10/, "card scrolling must cross a movement threshold before suppressing a flip");
assert.match(scripts[0], /front\.inert = next[\s\S]*?back\.inert = !next/, "flipping must keep only the visible face interactive");
assert.match(html, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.card-flip-shell\{transform:none !important\}/, "reduced motion must replace 3D rotation with a static face swap");
for (const action of ["copy", "edit", "ping", "keepalive", "stream", "stream-edit", "watch-edit", "up", "down", "delete"]) {
  assert.match(scripts[0], new RegExp(`data-act="${action}"`), `relaid node cards must preserve ${action}`);
}

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
