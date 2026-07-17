# Worker 子工程

Worker 源码、D1 表结构和部署工具均位于本目录。

常用命令：

```bash
npm install                 # 安装依赖
cp wrangler.toml wrangler.local.toml  # 创建 Git 忽略的本机配置
npm test                    # 检查 Worker 和内嵌管理后台
npm run preview:admin       # 生成本地后台预览
npm run build:obfuscate     # 生成 dist/index.js
npx wrangler deploy --dry-run
npm run deploy              # 构建并部署
```

远程 D1 初始化或升级：

```bash
npx wrangler d1 execute <database_name> --remote --file=./schema.sql --config wrangler.local.toml
```

完整的 Token 权限、D1、域名、Secrets、Telegram、Cron 和验证步骤见根目录 [README](../README.md)。
