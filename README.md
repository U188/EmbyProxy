# CF Media Gateway

这是纯 Cloudflare Worker 版本，只保留 CF 部署所需代码。旧 VPS、Docker、Go 服务端代码已经移除。

## 目录结构

```text
worker/
  src/index.js              # 明文源码，所有功能修改都在这里做
  dist/index.js             # 混淆后的部署文件，由 npm run build:obfuscate 生成
  schema.sql                # D1 数据库表结构
  wrangler.toml             # Worker、D1、域名、变量配置
  obfuscator.config.json    # JS 混淆配置
  package.json              # 构建和部署脚本
```

## 功能范围

- Cloudflare Worker 代理入口
- D1 保存节点、统计、播放记录、观看提醒状态
- 管理后台：节点新增、编辑、删除、导出、测速、DNS 更新
- 播放入口：按节点名分流，支持节点密钥
- 节点播放模式：全代理、直链、自动
- 请求 Header 策略和客户端模拟
- 默认节点图标、节点延迟、流量统计、播放统计
- 优选 IP 拉取、调度域名 DNS 更新
- Telegram 定时报告、手动报告、观看提醒
- 前端弹窗式交互提醒
- 部署前自动混淆，只上传 `worker/dist/index.js`

## 准备环境

需要本机安装：

```bash
node -v
npm -v
```

首次使用 Wrangler：

```bash
cd worker
npm install
npx wrangler login
```

如果服务器环境不能打开浏览器，也可以用 API Token：

```bash
export CLOUDFLARE_API_TOKEN="你的 Cloudflare API Token"
```

## Cloudflare 参数获取

### Account ID

进入 Cloudflare 后台：

```text
Workers & Pages -> 右侧或概览页 -> Account ID
```

把它填到 `worker/wrangler.toml`：

```toml
CF_ACCOUNT_ID = "你的 Account ID"
```

### Zone ID

进入你的域名页面：

```text
Websites -> 选择域名 -> Overview -> 右侧 API 区域 -> Zone ID
```

把它填到：

```toml
CF_ZONE_ID = "你的 Zone ID"
```

### API Token

进入：

```text
右上角头像 -> My Profile -> API Tokens -> Create Token -> Custom token
```

推荐权限：

```text
Account / D1 / Edit
Account / Workers Scripts / Edit
Account / Workers Routes / Edit
Zone / DNS / Edit
Zone / Zone / Read
User / User Details / Read
```

如果后台没有完全相同的中文名字，按英文权限搜索即可。`Analytics` 只用于读取统计数据，不是必须；没有对应权限时，后台里的 Cloudflare 实际流量可能无法查询，但节点本地统计仍可用。

创建后把 Token 设置为 Secret，不要写进 `wrangler.toml`：

```bash
cd worker
npx wrangler secret put CF_API_TOKEN
```

## 创建 D1 数据库

创建新数据库：

```bash
cd worker
npx wrangler d1 create media_gateway
```

Cloudflare 会输出 `database_id`，把数据库名和 ID 写进 `worker/wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "media_gateway"
database_id = "这里填 database_id"
```

初始化表结构：

```bash
npx wrangler d1 execute media_gateway --file=./schema.sql
```

如果数据库名不是 `media_gateway`，命令里的名字要改成你自己的。

## 配置域名

建议分两个域名：

```text
管理域名：用于登录后台，例如 hu.fuck.8899.qzz.io
调度域名：用于节点播放和优选 IP，例如 md.8899.qzz.io
```

在 `worker/wrangler.toml` 中配置：

```toml
routes = [
  { pattern = "你的管理域名", custom_domain = true },
  { pattern = "你的调度域名/*", zone_name = "你的根域名" }
]

[vars]
CF_DOMAIN = "你的管理域名"
CF_DNS_DOMAIN = "你的调度域名"
```

说明：

- `CF_DOMAIN` 是管理后台、Telegram 按钮、Webhook 默认地址。
- `CF_DNS_DOMAIN` 是后台展示和节点使用的播放调度域名。
- 调度域名用来做优选 IP 时，DNS 记录通常是灰云 `DNS only`；Worker 通过路由匹配这个域名。
- 管理域名如果作为 Worker 自定义域名，需要 Cloudflare 托管。

## 设置管理密码和 Telegram

管理密码：

```bash
cd worker
npx wrangler secret put ADMIN_TOKEN
```

Telegram 可选，不用 Telegram 可以跳过：

```bash
npx wrangler secret put TG_BOT_TOKEN
npx wrangler secret put TG_CHAT_ID
npx wrangler secret put TG_CHAT_ID_2
npx wrangler secret put TG_WEBHOOK_SECRET
```

`TG_WEBHOOK_SECRET` 可以自己生成一串随机字符：

```bash
openssl rand -base64 24
```

部署后设置 Telegram Webhook：

```bash
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://你的管理域名/api/tg-webhook","secret_token":"你的 TG_WEBHOOK_SECRET"}'
```

## 本地检查

```bash
cd worker
node --check src/index.js
npm run build:obfuscate
node --check dist/index.js
npx wrangler deploy --dry-run
```

## 部署

部署命令会先混淆源码，再上传混淆后的 `dist/index.js`：

```bash
cd worker
npm run deploy
```

不要直接把 `src/index.js` 上传到 Cloudflare。源码只用于本地维护，部署文件必须是混淆后的 `dist/index.js`。

## 后台入口

管理后台：

```text
https://你的管理域名/admin
```

播放入口：

```text
https://你的调度域名/节点名/
https://你的调度域名/节点名/节点密钥/
```

如果后台填写节点时节点名为空，会根据显示名自动生成拼音节点名，例如：

```text
美国线路 -> meiguoxianlu
```

已有节点名不会被覆盖，只会做安全字符规范化。

## 一键覆盖代码

后台的一键覆盖功能用于把新代码提交到当前 Worker。生产环境仍建议使用本地命令：

```bash
cd worker
npm run deploy
```

这样可以保证每次部署前都会重新混淆，并能通过 `wrangler deploy --dry-run` 先检查配置。

## 版本发布

建议每次整理后执行：

```bash
git status --short
git add README.md .gitignore worker
git commit -m "release: cf worker version"
git tag cf-v1.0.0
```

如果要推送到自己的仓库，需要先设置自己的远程地址：

```bash
git remote add origin https://github.com/你的账号/你的仓库.git
git push -u origin main
git push origin cf-v1.0.0
```
