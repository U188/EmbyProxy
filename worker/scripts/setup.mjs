import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_CONFIG = path.join(ROOT, "wrangler.local.toml");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const UUID_VALUE_PATTERN = new RegExp(`^${UUID_PATTERN.source}$`, "i");
const ID_PATTERN = /^[a-zA-Z0-9_-]{16,64}$/;
const DEFAULT_IPS_URL = "https://raw.githubusercontent.com/ZhiXuanWang/cf-speed-dns/refs/heads/main/ipTop10.html";

export function parseWhoami(value) {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  const candidates = [];
  const add = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const id = String(entry.id || entry.account_id || entry.accountId || "").trim();
    if (!ID_PATTERN.test(id) || candidates.some((item) => item.id === id)) return;
    candidates.push({ id, name: String(entry.name || entry.account_name || entry.accountName || id) });
  };
  if (Array.isArray(data?.accounts)) data.accounts.forEach(add);
  if (Array.isArray(data?.memberships)) data.memberships.forEach((item) => add(item?.account || item));
  add(data?.account);
  add(data);
  return candidates;
}

export function parseD1List(value) {
  const data = typeof value === "string" ? JSON.parse(value) : value;
  const rows = Array.isArray(data) ? data : Array.isArray(data?.result) ? data.result : [];
  return rows
    .map((row) => ({
      id: String(row?.uuid || row?.id || row?.database_id || "").trim(),
      name: String(row?.name || row?.database_name || "").trim(),
    }))
    .filter((row) => UUID_VALUE_PATTERN.test(row.id) && row.name);
}

export function parseCreatedDatabase(output, requestedName = "media_gateway") {
  const text = String(output || "");
  const id = text.match(/database_id\s*=\s*["']([^"']+)["']/i)?.[1] || text.match(UUID_PATTERN)?.[0] || "";
  const name = text.match(/database_name\s*=\s*["']([^"']+)["']/i)?.[1] || requestedName;
  if (!UUID_VALUE_PATTERN.test(id)) throw new Error("Wrangler 已创建数据库，但无法从输出中识别 database_id。");
  return { id, name };
}

export function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (
    domain.length > 253 ||
    domain.includes("://") ||
    domain.includes("/") ||
    !domain.includes(".") ||
    !domain.split(".").every((part) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(part))
  ) {
    throw new Error("请输入纯域名，例如 admin.example.com（不要包含 https:// 或路径）。");
  }
  return domain;
}

export function normalizeWorkerName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error("Worker 名称只能包含小写字母、数字和连字符，且不能以连字符开头或结尾。");
  }
  return name;
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, "")}"`;
}

export function buildWranglerConfig(settings) {
  const workerName = normalizeWorkerName(settings.workerName);
  const adminDomain = normalizeDomain(settings.adminDomain);
  const dispatchDomain = normalizeDomain(settings.dispatchDomain);
  const zoneName = normalizeDomain(settings.zoneName);
  if (!ID_PATTERN.test(settings.accountId)) throw new Error("Account ID 格式无效。");
  if (!ID_PATTERN.test(settings.zoneId)) throw new Error("Zone ID 格式无效。");
  if (!UUID_VALUE_PATTERN.test(settings.databaseId)) throw new Error("D1 database_id 格式无效。");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(settings.databaseName)) throw new Error("D1 数据库名称格式无效。");
  const reportHour = Number(settings.reportHour);
  if (!Number.isInteger(reportHour) || reportHour < 0 || reportHour > 23) throw new Error("日报小时必须为 0-23。");

  const preferredUrl = String(settings.preferredIpsUrl || "").trim();
  if (preferredUrl && !/^https:\/\//i.test(preferredUrl)) throw new Error("优选 IP 数据源必须使用 https://。");
  const optionalPreferred = preferredUrl ? `\nPREFERRED_IPS_URL = ${tomlString(preferredUrl)}` : "";

  return `name = ${tomlString(workerName)}
main = "dist/index.js"
compatibility_date = "2026-07-06"
account_id = ${tomlString(settings.accountId)}

workers_dev = true
routes = [
  { pattern = ${tomlString(adminDomain)}, custom_domain = true },
  { pattern = ${tomlString(`${dispatchDomain}/*`)}, zone_name = ${tomlString(zoneName)} }
]

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = ${tomlString(settings.databaseName)}
database_id = ${tomlString(settings.databaseId)}

[vars]
CF_ACCOUNT_ID = ${tomlString(settings.accountId)}
CF_ZONE_ID = ${tomlString(settings.zoneId)}
CF_DOMAIN = ${tomlString(adminDomain)}
CF_DNS_DOMAIN = ${tomlString(dispatchDomain)}
CF_WORKER_NAME = ${tomlString(workerName)}
TG_REPORT_HOUR = ${tomlString(reportHour)}
AUTO_WATCH_MAX_CONCURRENCY = "2"${optionalPreferred}
`;
}

export function parseLocalConfig(content) {
  const find = (key) => content.match(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m"))?.[1] || "";
  return {
    workerName: find("name"),
    accountId: find("account_id") || find("CF_ACCOUNT_ID"),
    zoneId: find("CF_ZONE_ID"),
    adminDomain: find("CF_DOMAIN"),
    dispatchDomain: find("CF_DNS_DOMAIN"),
    databaseName: find("database_name"),
    databaseId: find("database_id"),
  };
}

export function validateReusableConfig(settings) {
  normalizeWorkerName(settings.workerName);
  normalizeDomain(settings.adminDomain);
  normalizeDomain(settings.dispatchDomain);
  if (!ID_PATTERN.test(settings.accountId)) throw new Error("Account ID 格式无效。");
  if (!ID_PATTERN.test(settings.zoneId)) throw new Error("Zone ID 格式无效。");
  if (!UUID_VALUE_PATTERN.test(settings.databaseId)) throw new Error("D1 database_id 格式无效。");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(settings.databaseName)) throw new Error("D1 数据库名称格式无效。");
  return settings;
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    const detail = capture ? String(result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} ${args.join(" ")} 执行失败${detail ? `：${detail}` : ""}`);
  }
  return result;
}

function wrangler(args, options) {
  return run(NPX, ["wrangler", ...args], options);
}

async function ask(rl, label, defaultValue = "", validator = (value) => value) {
  while (true) {
    const suffix = defaultValue !== "" ? ` [${defaultValue}]` : "";
    const raw = (await rl.question(`${label}${suffix}: `)).trim();
    const value = raw || String(defaultValue);
    try {
      return validator(value);
    } catch (error) {
      console.error(`  ${error.message}`);
    }
  }
}

async function confirm(rl, label, defaultValue = true) {
  const hint = defaultValue ? "Y/n" : "y/N";
  while (true) {
    const answer = (await rl.question(`${label} [${hint}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    if (["y", "yes", "是"].includes(answer)) return true;
    if (["n", "no", "否"].includes(answer)) return false;
    console.error("  请输入 y 或 n。");
  }
}

async function choose(rl, label, options) {
  console.log(`\n${label}`);
  options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
  const index = await ask(rl, "请选择", "1", (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > options.length) throw new Error("选项无效。");
    return number - 1;
  });
  return options[index].value;
}

function defaultZone(domain) {
  const parts = domain.split(".");
  return parts.slice(-2).join(".");
}

function validateDatabaseId(value) {
  const id = String(value || "").trim();
  if (!UUID_VALUE_PATTERN.test(id)) throw new Error("D1 database_id 应为完整 UUID。");
  return id;
}

function validateDatabaseName(value) {
  const name = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("数据库名称只能包含字母、数字、下划线和连字符。");
  return name;
}

async function lookupZoneId(zoneName, accountId) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return "";
  try {
    const query = new URLSearchParams({ name: zoneName, "account.id": accountId });
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json();
    return response.ok && data?.success && data.result?.length === 1 ? String(data.result[0].id) : "";
  } catch {
    return "";
  }
}

async function lookupAccountsFromApi() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) return [];
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=50", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = await response.json();
    return response.ok && data?.success ? parseWhoami({ accounts: data.result }) : [];
  } catch {
    return [];
  }
}

async function verifyHealth(domain) {
  const url = `https://${domain}/api/health`;
  let lastError = "";
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const text = await response.text();
      if (response.ok) {
        let version = "";
        try {
          version = JSON.parse(text)?.version || "";
        } catch {}
        return { ok: true, status: response.status, version };
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { ok: false, error: lastError };
}

async function writeSetupConfig(settings) {
  if (existsSync(LOCAL_CONFIG)) {
    const backupDir = path.join(ROOT, ".wrangler", "setup-backups");
    await mkdir(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(LOCAL_CONFIG, path.join(backupDir, `wrangler.local.${timestamp}.toml`));
  }
  await writeFile(LOCAL_CONFIG, buildWranglerConfig(settings), { mode: 0o600 });
  await chmod(LOCAL_CONFIG, 0o600);
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`需要 Node.js 20 或更高版本，当前为 ${process.version}。`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("安装向导需要交互式终端。CI 部署请按 README 配置 Secrets 后运行 npm run deploy。");
  }

  console.log("\nEmbyProxy Cloudflare 安装向导");
  console.log("真实 ID 仅写入 Git 忽略的 wrangler.local.toml；Secret 直接提交给 Cloudflare。\n");

  let rl = createInterface({ input: process.stdin, output: process.stdout });
  let auth = wrangler(["whoami", "--json"], { capture: true, allowFailure: true });
  if (auth.status !== 0) {
    const loginNow = await confirm(rl, "Wrangler 尚未登录，现在打开 Cloudflare 登录", true);
    if (!loginNow) {
      rl.close();
      throw new Error("请先运行 npx wrangler login，或设置 CLOUDFLARE_API_TOKEN 后重试。");
    }
    rl.close();
    const login = wrangler(["login"], { allowFailure: true });
    if (login.status !== 0) throw new Error("Wrangler 登录失败。");
    rl = createInterface({ input: process.stdin, output: process.stdout });
    auth = wrangler(["whoami", "--json"], { capture: true });
  }

  const accounts = parseWhoami(auth.stdout);
  const environmentAccountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  if (ID_PATTERN.test(environmentAccountId) && !accounts.some((item) => item.id === environmentAccountId)) {
    accounts.push({ id: environmentAccountId, name: "CLOUDFLARE_ACCOUNT_ID" });
  }
  if (!accounts.length) accounts.push(...await lookupAccountsFromApi());

  let settings;
  let reused = false;
  if (existsSync(LOCAL_CONFIG)) {
    const action = await choose(rl, "检测到 wrangler.local.toml", [
      { label: "复用现有配置（适合升级或修复部署）", value: "reuse" },
      { label: "重新生成（旧配置会自动备份）", value: "replace" },
      { label: "退出", value: "exit" },
    ]);
    if (action === "exit") {
      rl.close();
      return;
    }
    if (action === "reuse") {
      settings = parseLocalConfig(await readFile(LOCAL_CONFIG, "utf8"));
      const required = ["workerName", "accountId", "zoneId", "adminDomain", "dispatchDomain", "databaseName", "databaseId"];
      const missing = required.filter((key) => !settings[key]);
      if (missing.length) {
        console.log(`现有配置缺少 ${missing.join(", ")}，将重新生成。`);
      } else {
        try {
          validateReusableConfig(settings);
          reused = true;
        } catch (error) {
          console.log(`现有配置无法复用：${error.message} 将重新生成。`);
        }
      }
    }
  }

  const temporaryDir = await mkdtemp(path.join(tmpdir(), "embyproxy-setup-"));
  try {
    if (!reused) {
      let account;
      if (!accounts.length) {
        const accountId = await ask(rl, "Cloudflare Account ID", "", (value) => {
          if (!ID_PATTERN.test(value)) throw new Error("Account ID 格式无效，可在 Workers & Pages 概览查看。");
          return value;
        });
        account = { id: accountId, name: accountId };
      } else {
        account = accounts.length === 1
          ? accounts[0]
          : await choose(rl, "选择 Cloudflare 账号", accounts.map((item) => ({ label: `${item.name} (${item.id})`, value: item })));
      }
      const temporaryConfig = path.join(temporaryDir, "wrangler.toml");
      await writeFile(temporaryConfig, `name = "embyproxy-setup"\ncompatibility_date = "2026-07-06"\naccount_id = ${tomlString(account.id)}\n`);

      let databases = [];
      const listed = wrangler(["d1", "list", "--json", "--config", temporaryConfig], { capture: true, allowFailure: true });
      if (listed.status === 0) {
        databases = parseD1List(listed.stdout);
      } else if (!process.env.CLOUDFLARE_API_TOKEN) {
        console.log("\n浏览器登录模式下，Wrangler 将直接显示 D1 列表；使用已有数据库时需粘贴一次名称和 UUID。");
        wrangler(["d1", "list", "--config", temporaryConfig]);
      } else {
        const detail = String(listed.stderr || listed.stdout || "").trim();
        throw new Error(`读取 D1 列表失败${detail ? `：${detail}` : ""}`);
      }
      const databaseChoice = await choose(rl, "选择 D1 数据库", [
        ...databases.map((item) => ({ label: `${item.name} (${item.id})`, value: item })),
        ...(databases.length ? [] : [{ label: "使用上面列表中的已有数据库", value: "manual" }]),
        { label: "创建新数据库", value: null },
      ]);
      let database = databaseChoice;
      if (database === "manual") {
        const name = await ask(rl, "已有数据库名称", "media_gateway", validateDatabaseName);
        const id = await ask(rl, "已有数据库 UUID", "", validateDatabaseId);
        database = { name, id };
      }
      if (!database) {
        const databaseName = await ask(rl, "新数据库名称", "media_gateway", validateDatabaseName);
        const location = await choose(rl, "选择 D1 主位置", [
          { label: "亚太 (apac)", value: "apac" },
          { label: "西欧 (weur)", value: "weur" },
          { label: "东欧 (eeur)", value: "eeur" },
          { label: "大洋洲 (oc)", value: "oc" },
          { label: "北美西部 (wnam)", value: "wnam" },
          { label: "北美东部 (enam)", value: "enam" },
        ]);
        console.log("\n正在创建 D1 数据库...");
        const createArgs = [
          "d1", "create", databaseName, "--location", location,
          "--binding", "DB", "--update-config", "--config", temporaryConfig,
        ];
        if (process.env.CLOUDFLARE_API_TOKEN) {
          const created = wrangler(createArgs, { capture: true });
          database = parseCreatedDatabase(`${created.stdout}\n${created.stderr}`, databaseName);
        } else {
          wrangler(createArgs);
          const createdConfig = parseLocalConfig(await readFile(temporaryConfig, "utf8"));
          database = { name: createdConfig.databaseName || databaseName, id: validateDatabaseId(createdConfig.databaseId) };
        }
      }

      const workerName = await ask(rl, "Worker 名称", "embyproxy", normalizeWorkerName);
      const adminDomain = await ask(rl, "管理域名", "", normalizeDomain);
      const dispatchDomain = await ask(rl, "调度域名", "", normalizeDomain);
      const zoneName = await ask(rl, "Cloudflare 根域名 (Zone)", defaultZone(dispatchDomain), normalizeDomain);
      const detectedZoneId = await lookupZoneId(zoneName, account.id);
      if (detectedZoneId) console.log(`已自动识别 Zone ID：${detectedZoneId}`);
      const zoneId = detectedZoneId || await ask(rl, "Zone ID", "", (value) => {
        if (!ID_PATTERN.test(value)) throw new Error("Zone ID 格式无效，可在域名 Overview 页面查看。");
        return value;
      });
      const reportHour = await ask(rl, "Telegram 日报小时（北京时间 0-23）", "9", (value) => {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 0 || number > 23) throw new Error("请输入 0-23。");
        return number;
      });
      const preferredIpsUrl = await ask(rl, "优选 IP 数据源", DEFAULT_IPS_URL, (value) => {
        if (value && !/^https:\/\//i.test(value)) throw new Error("必须使用 https:// 地址。");
        return value;
      });
      settings = {
        workerName,
        accountId: account.id,
        zoneId,
        adminDomain,
        dispatchDomain,
        zoneName,
        databaseName: database.name,
        databaseId: database.id,
        reportHour,
        preferredIpsUrl,
      };
      await writeSetupConfig(settings);
      console.log("\n已生成 wrangler.local.toml（权限 0600）。");
    }

    const initializeDatabase = await confirm(rl, "初始化/升级远程 D1 表结构", true);
    const setAdminToken = reused ? await confirm(rl, "更新 ADMIN_TOKEN 管理密码", false) : true;
    const setCloudflareToken = await confirm(rl, "设置 CF_API_TOKEN（后台 DNS 和流量功能需要）", !reused);
    const setTelegram = await confirm(rl, "配置 Telegram 通知", false);
    let setSecondChat = false;
    let setWebhook = false;
    if (setTelegram) {
      setSecondChat = await confirm(rl, "设置第二个 Telegram 接收者", false);
      setWebhook = await confirm(rl, "设置 Telegram Webhook Secret", true);
    }
    const runTests = await confirm(rl, "运行完整测试和混淆构建", true);
    const deploy = await confirm(rl, "测试通过后立即部署", true);
    rl.close();

    if (initializeDatabase) {
      console.log("\n[1/4] 初始化远程 D1...");
      wrangler(["d1", "execute", "DB", "--remote", "--yes", "--file=./schema.sql", "--config", LOCAL_CONFIG]);
    }

    const secrets = [];
    if (setAdminToken) secrets.push("ADMIN_TOKEN");
    if (setCloudflareToken) secrets.push("CF_API_TOKEN");
    if (setTelegram) secrets.push("TG_BOT_TOKEN", "TG_CHAT_ID");
    if (setSecondChat) secrets.push("TG_CHAT_ID_2");
    if (setWebhook) secrets.push("TG_WEBHOOK_SECRET");
    if (secrets.length) {
      console.log("\n[2/4] 设置 Worker Secrets（输入内容不会写入本机配置）...");
      for (const secret of secrets) {
        console.log(`\n设置 ${secret}`);
        wrangler(["secret", "put", secret, "--config", LOCAL_CONFIG]);
      }
    }

    if (runTests || deploy) {
      console.log(`\n[3/4] ${runTests ? "运行测试并" : ""}生成混淆部署产物...`);
      if (runTests) run(process.platform === "win32" ? "npm.cmd" : "npm", ["test"]);
      run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:obfuscate"]);
      run(process.execPath, ["--check", "dist/index.js"]);
    }

    if (!deploy) {
      console.log("\n配置已完成。稍后可运行 npm run deploy。");
      return;
    }

    console.log("\n[4/4] 部署 Worker...");
    const deployed = wrangler(["deploy", "--config", LOCAL_CONFIG], { allowFailure: true });
    if (deployed.status !== 0) {
      console.error("\n部署命令返回失败。若输出包含 Some triggers failed to deploy，通常是 Token 缺少 Zone / Workers Routes / Edit 权限。");
    }

    console.log("\n验证生产健康接口...");
    const source = await readFile(path.join(ROOT, "src", "index.js"), "utf8");
    const expectedVersion = source.match(/const\s+BUILD_VERSION\s*=\s*["']([^"']+)["']/)?.[1] || "";
    const [adminHealth, dispatchHealth] = await Promise.all([
      verifyHealth(settings.adminDomain),
      verifyHealth(settings.dispatchDomain),
    ]);
    const printHealth = (label, domain, result) => {
      if (result.ok && (!expectedVersion || result.version === expectedVersion)) {
        console.log(`  ${label}: https://${domain}/api/health -> ${result.status}${result.version ? ` / ${result.version}` : ""}`);
      } else if (result.ok) {
        console.error(`  ${label}: https://${domain}/api/health -> ${result.status} / ${result.version || "无版本"}（期望 ${expectedVersion}）`);
      }
      else console.error(`  ${label}: https://${domain}/api/health -> 失败 (${result.error})`);
    };
    printHealth("管理域名", settings.adminDomain, adminHealth);
    printHealth("调度域名", settings.dispatchDomain, dispatchHealth);

    const healthMatches = (result) => result.ok && (!expectedVersion || result.version === expectedVersion);
    if (deployed.status !== 0 || !healthMatches(adminHealth) || !healthMatches(dispatchHealth)) {
      process.exitCode = 1;
      console.error("\n安装未完全通过验证。配置和数据库已保留，修正 Token 权限或 DNS 后重新运行 npm run deploy。");
      return;
    }
    console.log(`\n安装完成：管理后台 https://${settings.adminDomain}/admin`);
  } finally {
    rl.close();
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`\n安装失败：${error.message}`);
    process.exitCode = 1;
  });
}
