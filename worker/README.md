# CF Worker

这是项目的 Cloudflare Worker 子工程。明文源码在 `src/index.js`，部署文件由混淆命令生成到 `dist/index.js`。

## 安装

```bash
npm install
```

## 初始化 D1

```bash
npx wrangler d1 create media_gateway
npx wrangler d1 execute media_gateway --file=./schema.sql
```

把创建出来的 `database_id` 写入 `wrangler.toml` 的 `[[d1_databases]]`。

## 设置 Secret

```bash
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler secret put TG_CHAT_ID_2
npx wrangler secret put TG_WEBHOOK_SECRET
```

Telegram 不需要时可以不设置 `TG_*`。

## 检查和部署

```bash
node --check src/index.js
npm run build:obfuscate
node --check dist/index.js
npx wrangler deploy --dry-run
npm run deploy
```

`npm run deploy` 会先执行混淆，再通过 Wrangler 上传 `dist/index.js`。

完整说明见根目录 `README.md`。
