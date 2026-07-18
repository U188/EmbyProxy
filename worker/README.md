# Worker 子工程

Worker 源码、D1 表结构和部署工具均位于本目录。

当前版本包含真实代理性能汇总、多独立视频线路自动切换，以及带执行窗口、每日限额和失败退避的模拟观看策略。升级已有部署时必须先执行下面的 D1 初始化命令，再部署新版 Worker。

常用命令：

```bash
npm install                 # 安装依赖
npm run setup               # 首次交互式安装、建库、配置、部署和验证
npm test                    # 检查 Worker 和内嵌管理后台
npm run preview:admin       # 生成本地后台预览
npm run build:obfuscate     # 生成 dist/index.js
npx wrangler deploy --dry-run
npm run deploy              # 构建并部署
```

`npm run setup` 会选择或创建 D1、生成 Git 忽略的 `wrangler.local.toml`、初始化表结构、引导设置 Worker Secrets，并在部署后检查两个生产域名。已有配置可以直接复用。手工配置方法见根目录 README。

远程 D1 初始化或升级：

```bash
npx wrangler d1 execute <database_name> --remote --file=./schema.sql --config wrangler.local.toml
```

完整的 Token 权限、D1、域名、Secrets、Telegram、Cron 和验证步骤见根目录 [README](../README.md)。
