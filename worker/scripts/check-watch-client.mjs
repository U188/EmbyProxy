import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");

assert.match(source, /emby_auth_profile TEXT DEFAULT ''/, "runtime schema must track the token profile");
assert.match(schema, /emby_auth_profile TEXT DEFAULT ''/, "D1 schema must track the token profile");
assert.match(
  source,
  /node\.embyAccessToken && node\.embyUserId && node\.embyAuthProfile === profile\.id/,
  "cached Emby tokens must only be reused by the profile that created them"
);
assert.match(
  source,
  /SET emby_user_id = \?, emby_access_token = \?, emby_auth_profile = \?, updated_at = \?/,
  "successful login must persist its client profile"
);
assert.match(
  source,
  /"user-agent": auth\.profile\?\.ua \|\| "Emby\/4\.8\.0"/,
  "stream samples must use the selected client user agent"
);
assert.doesNotMatch(source, /VLC\/3\.0\.18|LibVLC/, "simulated watch must not identify as VLC");
assert.match(source, /current\.embyUser !== node\.embyUser/, "changing Emby users must invalidate cached credentials");
assert.match(source, /nodeCredentialScope\(current\) !== nodeCredentialScope\(node\)/, "changing upstreams must invalidate cached credentials");
assert.match(source, /status IN \('starting', 'running'\)/, "active sessions must include startup reservations");
assert.match(source, /idx_sim_watch_sessions_one_active_node/, "runtime schema must enforce one active session per node");
assert.match(schema, /idx_sim_watch_sessions_one_active_node/, "D1 schema must enforce one active session per node");
assert.match(source, /status = 'notify_pending'/, "completion notifications must be retryable");
assert.match(source, /retryWatchCompletionNotification/, "completion notification retry handler must exist");
assert.match(source, /item\.enabled !== false/, "disabled nodes must not be auto-watched");
assert.match(source, /AUTO_WATCH_FAILURE_BACKOFF_MS/, "automatic failures must have retry backoff");
assert.match(source, /auto_watch INTEGER DEFAULT 0/, "runtime schema must default automatic watching to off");
assert.match(schema, /auto_watch INTEGER DEFAULT 0/, "D1 schema must persist the automatic watch switch");
assert.match(source, /node\?\.autoWatch && node\.embyUser && node\.embyPassword/, "automatic watching must require the switch, username and password");
assert.match(source, /notifyKeepaliveDue\(env, item, node\)/, "nodes without complete automatic-watch configuration must use reminders");
assert.match(source, /last_notify_day = \?, notify_count = notify_count \+ 1/, "reminders must be deduplicated per day");
assert.match(source, /id="autoWatch" type="checkbox"/, "the node editor must expose the automatic-watch switch");
assert.doesNotMatch(source, /节点未配置 Emby 用户名\/密码，无法真实模拟观看/, "missing credentials must not be reported as an automatic-watch failure");

const moduleURL = `data:text/javascript;base64,${Buffer.from(`${source}\nexport { canNodeAutoWatch, notifyKeepaliveDue };`).toString("base64")}`;
const { canNodeAutoWatch, notifyKeepaliveDue } = await import(moduleURL);
assert.equal(canNodeAutoWatch({ autoWatch: false, embyUser: "alice", embyPassword: "pw" }), false);
assert.equal(canNodeAutoWatch({ autoWatch: true, embyUser: "alice", embyPassword: "" }), false);
assert.equal(canNodeAutoWatch({ autoWatch: true, embyUser: "alice", embyPassword: "pw" }), true);

const updates = [];
const reminderEnv = {
  DB: {
    prepare(sql) {
      return {
        bind(...args) {
          return { async run() { updates.push({ sql, args }); } };
        }
      };
    }
  }
};
const reminderItem = {
  node: "reminder-node",
  displayName: "Reminder Node",
  status: "due",
  remainDays: -1,
  renewDays: 21,
  lastNotifyDay: ""
};
const reminder = await notifyKeepaliveDue(reminderEnv, reminderItem, { autoWatch: false });
assert.equal(reminder.ok, true);
assert.equal(reminder.skipped, true, "unconfigured Telegram should not create a retry storm");
assert.equal(updates.length, 1, "the reminder day must be persisted once");
const reminderDay = updates[0].args[0];
const duplicate = await notifyKeepaliveDue(reminderEnv, { ...reminderItem, lastNotifyDay: reminderDay }, { autoWatch: false });
assert.equal(duplicate.reason, "reminder already sent today");
assert.equal(updates.length, 1, "the same reminder must not be persisted twice in one day");

console.log("watch client checks passed");
