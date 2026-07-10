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

Telegram 不需要时可以不设置 `TG_*`。启用 Telegram 时必须设置 `TG_WEBHOOK_SECRET`，Webhook 只接受 `TG_CHAT_ID` / `TG_CHAT_ID_2`。

`RAW_PROXY_SIGNING_KEY` 可选；未设置时会自动在 D1 中生成。也可以手动设置：

```bash
npx wrangler secret put RAW_PROXY_SIGNING_KEY
```

外部 `__raw__` 地址使用 HMAC 签名，跨源请求只允许 `GET` / `HEAD`，且不会转发认证、Cookie、真实 IP、Origin 或 Referer Header。

## 播放性能

播放请求不会执行 Schema 迁移。节点配置默认在当前 Worker isolate 缓存 30 秒，可通过 `NODE_CACHE_TTL_SECONDS` 调整为 5-300 秒；节点写操作会主动清理当前 isolate 的缓存。

多个视频线路会根据真实请求的失败状态和首字节耗时被动调整顺序，不发起额外的视频竞速请求。响应中的 `Server-Timing` 可用于查看节点读取、上游首字节、重定向、重试和 Worker 总处理时间。

自动模式启用“优先直连”时，首次视频请求返回 302；同一客户端、视频和 Range 在 45 秒内重试时，Worker 将其视为直连失败并改走反代。显式直连和显式中转模式不受影响。

## 检查和部署

```bash
npm test
node --check src/index.js
npm run build:obfuscate
node --check dist/index.js
npx wrangler deploy --dry-run
npm run deploy
```

`npm run deploy` 会先执行混淆，再通过 Wrangler 上传 `dist/index.js`。

完整说明见根目录 `README.md`。
