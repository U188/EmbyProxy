import { writeFile } from "node:fs/promises";
import worker from "../src/index.js";

const env = {
  CF_DOMAIN: process.env.CF_DOMAIN || "admin.example.com",
  CF_DNS_DOMAIN: process.env.CF_DNS_DOMAIN || "dispatch.example.com"
};
const response = await worker.fetch(
  new Request(`https://${env.CF_DOMAIN}/admin`),
  env,
  { waitUntil() {} }
);

if (!response.ok) {
  throw new Error(`admin preview failed with HTTP ${response.status}`);
}

const target = new URL("../review-admin.html", import.meta.url);
await writeFile(target, await response.text(), "utf8");
console.log(`wrote ${target.pathname}`);
