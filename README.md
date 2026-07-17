# EmbyProxy for Cloudflare Workers

基于 Cloudflare Workers 和 D1 的 Emby 多线路代理。项目包含代理入口、节点管理后台、真实模拟观看、测速与动态 DNS、流量统计和 Telegram 通知。

当前版本：`0.4.7`

## 功能

- 多 Emby 节点分流，支持节点密钥、备用上游和独立视频线路
- 全代理、直连、自动播放模式及请求 Header 策略
- Yamby、Hills Android、Hills Windows 客户端模拟
- 后台管理节点、测速、排序、导入导出、优选 IP 和 Cloudflare DNS
- D1 保存节点、访问统计、观看状态和最近 3 天模拟观看记录
- 使用节点保存的 Emby 账号真实开播，持续约 5-7.5 分钟并按分钟上报进度
- 模拟观看完成或失败后发送 Telegram 通知，支持定时日报和 Bot 菜单
- 源码本地维护，部署前自动生成混淆后的 Worker 文件

## 项目结构

```text
worker/
  src/index.js              # Worker 和管理后台明文源码
  dist/index.js             # 混淆部署产物，不提交 Git
  schema.sql                # D1 完整表结构
  wrangler.toml             # Worker、D1、域名、Cron 和普通变量
  obfuscator.config.json    # JavaScript 混淆配置
  scripts/check-admin.mjs   # 管理后台静态回归检查
  scripts/export-admin.mjs  # 生成本地后台预览
```

## 部署准备

需要：

- Node.js 20 或更高版本
- npm
- Cloudflare 账号
- 一个由 Cloudflare 托管的域名
- 可选：Telegram Bot

克隆并安装依赖：

```bash
git clone https://github.com/U188/EmbyProxy.git
cd EmbyProxy/worker
npm install
```

## 1. 创建 Cloudflare API Token

进入 Cloudflare：

```text
My Profile -> API Tokens -> Create Token -> Custom token
```

部署和完整后台功能建议授予：

```text
Account / Workers Scripts / Edit
Account / D1 / Edit
Zone / Workers Routes / Edit
Zone / DNS / Edit
Zone / Zone / Read
User / User Details / Read
```

Zone Resources 必须包含实际使用的根域名；否则 Worker 虽然能上传，但更新 `域名/*` 路由时会提示 `Some triggers failed to deploy`。

这里有两种不同用途的 Token，不要混淆：

| 名称 | 保存位置 | 用途 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 本地环境变量或 CI Secret | Wrangler 登录、创建 D1、部署 Worker |
| `CF_API_TOKEN` | Cloudflare Worker Secret | 后台查询/更新 DNS、查询流量、网页紧急覆盖代码 |

先为本地 Wrangler 设置部署 Token：

```bash
export CLOUDFLARE_API_TOKEN="你的部署 Token"
npx wrangler whoami
```

不要把 Token 写入 `wrangler.toml`、README 或提交到 Git。

## 2. 创建并初始化 D1

新建数据库：

```bash
cd worker
npx wrangler d1 create media_gateway
```

命令会返回 `database_id`。把数据库名和 ID 写入 `worker/wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "media_gateway"
database_id = "你的 database_id"
```

初始化远程数据库：

```bash
npx wrangler d1 execute media_gateway --remote --file=./schema.sql
```

更新已有部署时也可以重复执行该命令，SQL 使用 `IF NOT EXISTS`，不会删除现有节点和记录。Worker 启动时还会自动补齐缺失的表和列。

## 3. 配置 Worker、域名和 Cron

编辑 `worker/wrangler.toml`。下面是可用模板：

```toml
name = "你的-worker-name"
main = "dist/index.js"
compatibility_date = "2026-07-06"

workers_dev = true
routes = [
  { pattern = "admin.example.com", custom_domain = true },
  { pattern = "media.example.com/*", zone_name = "example.com" }
]

[triggers]
crons = ["* * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "media_gateway"
database_id = "你的 database_id"

[vars]
CF_ACCOUNT_ID = "你的 Account ID"
CF_ZONE_ID = "你的 Zone ID"
CF_DOMAIN = "admin.example.com"
CF_DNS_DOMAIN = "media.example.com"
CF_WORKER_NAME = "你的-worker-name"
TG_REPORT_HOUR = "9"
PREFERRED_IPS_URL = "https://example.com/ips.txt"
```

关键配置说明：

- `CF_DOMAIN`：管理后台和 Telegram Webhook 使用的管理域名。
- `CF_DNS_DOMAIN`：客户端访问节点的调度域名。
- 管理域名使用 Worker Custom Domain；调度域名使用 `域名/*` Worker Route。
- `crons = ["* * * * *"]` 必须保留。真实模拟观看依赖每分钟 Cron 上报进度和结束会话。
- `TG_REPORT_HOUR` 按北京时间设置，默认每天 `9` 点发送日报。
- `PREFERRED_IPS_URL` 可省略，代码内有默认数据源。

Account ID 可在 Workers & Pages 概览查看；Zone ID 可在对应域名 Overview 页面查看。

## 4. 设置 Worker Secrets

管理后台密码：

```bash
npx wrangler secret put ADMIN_TOKEN
```

后台需要操作 Cloudflare DNS、流量 API 或网页紧急更新时设置：

```bash
npx wrangler secret put CF_API_TOKEN
```

Telegram 为可选功能：

```bash
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler secret put TG_CHAT_ID_2       # 可选，第二个接收者
npx wrangler secret put TG_WEBHOOK_SECRET  # 推荐
```

`TG_WEBHOOK_SECRET` 可这样生成：

```bash
openssl rand -hex 24
```

所有 `wrangler secret put` 命令都会等待你交互输入值，不会把 Secret 写入仓库。

## 5. 配置 Telegram Webhook

部署完成后调用 Telegram API：

```bash
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://admin.example.com/api/tg-webhook",
    "secret_token": "你的 TG_WEBHOOK_SECRET"
  }'
```

检查结果：

```bash
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/getWebhookInfo"
```

不用 Telegram 时可以跳过本节和所有 `TG_*` Secrets。

## 6. 部署前检查

项目提供了管理后台回归检查，会验证最终生成的内嵌浏览器脚本、DOM ID、页面映射、隐藏边界、重复函数和关键 API 调用：

```bash
cd worker
npm test
```

完整构建检查：

```bash
npm run build:obfuscate
node --check dist/index.js
npx wrangler deploy --dry-run
```

`dist/index.js` 是生成文件并已被 Git 忽略。不要直接修改它。

## 7. 正式部署

确认当前终端仍有 Wrangler Token：

```bash
export CLOUDFLARE_API_TOKEN="你的部署 Token"
npx wrangler whoami
```

构建混淆产物并上传：

```bash
cd worker
npm run deploy
```

`npm run deploy` 等价于：

```bash
npm run build:obfuscate
npx wrangler deploy
```

部署成功后，Wrangler 应列出：

- Worker 名称
- 管理 Custom Domain
- 调度 Worker Route
- `schedule: * * * * *`

如果只看到 `Uploaded ...`，随后出现路由权限错误，说明脚本已经上传，但 Token 没有目标 Zone 的 `Workers Routes / Edit` 权限。补齐权限后重新运行部署；现有路由通常不会被删除。

## 8. 验证部署

健康检查：

```bash
curl https://admin.example.com/api/health
curl https://media.example.com/api/health
```

预期返回：

```json
{"ok":true,"version":"0.4.7"}
```

后台地址：

```text
https://admin.example.com/admin
```

节点播放地址：

```text
https://media.example.com/节点名/
https://media.example.com/节点名/节点密钥/
```

再检查以下项目：

1. 使用 `ADMIN_TOKEN` 登录后台。
2. 新建节点并确认卡片正常出现。
3. 单卡或全局测速后，卡片显示延迟值。
4. 进入数据大屏，确认统计图加载。
5. 配置 Emby 账号的节点点击“已观看”，确认开始弹窗。
6. 等待约 5-7.5 分钟，确认 Emby 播放记录、网页记录和 TG 通知。

## 真实模拟观看

每个需要模拟观看的节点必须配置：

- Emby 用户名
- Emby 密码，或数据库中已有可复用 Access Token
- 可选：指定条目 ID；为空时自动选择可播放内容
- 自动任务还需要周期天数和提前提醒天数

流程如下：

1. 登录上游 Emby 并选择内容。
2. 获取 PlaybackInfo 和媒体源。
3. 发送 `Sessions/Playing`。
4. 每分钟发送 `Sessions/Playing/Progress`。
5. 实际达到目标时长后发送 `Stopped` 和 PlayedItems。
6. 写入最近 3 天观看记录并发送 TG 完成通知。

同一节点已有运行中会话时不会重复启动。失败也会写入失败记录并发送 TG 失败通知。

## 更新已有部署

```bash
git pull
cd worker
npm install
npm test
npx wrangler d1 execute 你的数据库名 --remote --file=./schema.sql
npm run deploy
```

更新代码不会覆盖 `wrangler secret`、D1 数据或已有节点。部署前仍应检查自己的 `wrangler.toml`，避免上游仓库配置覆盖域名、数据库 ID 或 Worker 名称。

## 常见问题

### Wrangler 提示需要 `CLOUDFLARE_API_TOKEN`

非交互环境无法自动打开浏览器登录。先执行：

```bash
export CLOUDFLARE_API_TOKEN="你的部署 Token"
```

该变量只对当前 Shell 生效。

### `Some triggers failed to deploy`

通常是 Token 缺少目标域名的 `Zone / Workers Routes / Edit`，或 Zone Resources 没包含该域名。Worker 代码可能已经上传，应先用 `/api/health` 核对版本，再修正 Token 权限并重新部署。

### `workers.dev` 返回 1101

优先检查配置的 Custom Domain 和 Worker Route。生产访问应使用 `CF_DOMAIN` / `CF_DNS_DOMAIN`，不要只依赖 `workers.dev` 地址。

### 模拟观看不执行

检查节点是否保存了有效 Emby 账号、Cron 是否为每分钟、Worker 能否访问上游，以及 D1 中是否已有该节点的运行中会话。

### 没有 Telegram 通知

检查 `TG_BOT_TOKEN`、至少一个 `TG_CHAT_ID`、Webhook 地址及 Secret。完成通知只在模拟会话真正结束后发送。

## 安全说明

- 不要提交 `.env`、`.dev.vars`、API Token、管理密码或 Telegram Token。
- Emby 密码和 Access Token 保存在 D1；应限制 `ADMIN_TOKEN` 的传播范围。
- 导出的节点 JSON 可能包含敏感配置，应按凭据文件保管。
- 生产部署建议使用本地 `npm run deploy`，网页代码覆盖仅用于紧急处理。
