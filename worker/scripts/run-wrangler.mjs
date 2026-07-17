import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: node scripts/run-wrangler.mjs <wrangler arguments>");
  process.exit(2);
}

const config = existsSync("wrangler.local.toml") ? "wrangler.local.toml" : "wrangler.toml";
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["wrangler", ...args, "--config", config], { stdio: "inherit" });
process.exit(result.status ?? 1);
