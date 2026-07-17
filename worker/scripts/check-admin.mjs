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

for (const id of ["nodeGrid", "watchLogRows", "traceEntry", "traceEgress", "dialogBackdrop"]) {
  assert.ok(idSet.has(id), `required visible surface is missing: ${id}`);
}
assert.match(html, /id="nodeEditorPanel" hidden/, "node editor must start hidden");
assert.match(html, /id="deployBody" hidden/, "deploy editor must start hidden");
assert.doesNotMatch(html, /id="nodeGrid"[^>]*\shidden(?:\s|>)/, "node cards must not be hidden");

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

console.log(`admin checks passed: ${ids.length} ids, ${tabs.size} pages, ${apiRoutes.size} API calls`);
