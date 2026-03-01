# 项目迁移到新设备（实操文档）

适用目录：`News_dashboard`

## 0. 迁移目标

把项目完整搬到新设备后，能够：

- 本地启动服务并访问页面
- 使用 `news-overview.json` 快照出图/发布
- 按需切到 `--live` 抓取 + Gemini

---

## 1. 源设备打包/拷贝

建议拷贝整个项目目录（包含 `news-overview.json` 快照）。

建议排除可再生文件：

- `node_modules/`
- `logs/`（可选，通常不需要）

示例（在源设备）：

```bash
cd /path/to
rsync -av --exclude node_modules --exclude logs News_dashboard/ user@new-device:/path/to/
```

---

## 2. 新设备基础环境

- Node.js >= 16（建议 20+）
- npm 可用

检查：

```bash
node -v
npm -v
```

---

## 3. 安装依赖

在新设备项目根目录执行：

```bash
npm install
```

安装 Playwright 浏览器（用于截图）：

```bash
npx playwright install chromium
```

> 如果遇到 `EPERM symlink`（常见于某些移动盘/文件系统），改用：

```bash
npm install --no-bin-links
node node_modules/playwright/cli.js install chromium
```

---

## 4. 配置 `.env`

### 4.1 复制旧设备 `.env`（推荐）

直接把旧设备 `.env` 一并拷到新设备。

### 4.2 若手动新建 `.env`

```bash
cp .env.example .env
```

然后填写真实密钥：

- `NOTION_TOKEN`
- `NOTION_PARENT_PAGE_ID`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `GEMINI_API_KEY`
- （可选）`AZURE_TRANSLATOR_KEY` / `AZURE_TRANSLATOR_REGION`

### 4.3 用脚本补齐新键（不会覆盖已有值）

```bash
./scripts/sync-env.sh .env .env.example --check
./scripts/sync-env.sh .env .env.example --apply
```

---

## 5. 首次自检（推荐顺序）

### 5.1 语法检查

```bash
node --check server.js
node --check scripts/news-overview.js
```

### 5.2 快照模式（默认）测试

```bash
NEWS_OVERVIEW_CHANNELS=json NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1 node scripts/news-overview.js
```

### 5.3 渲染测试（仅本地产物）

```bash
NEWS_OVERVIEW_CHANNELS=local NEWS_OVERVIEW_RENDER_IMAGE=1 node scripts/news-overview.js
```

### 5.4 启动服务

```bash
npm start
```

浏览器打开：

- `http://localhost:3000/news-overview.html`

---

## 6. 运行模式速查

### 快照优先（稳定、可复现）

```bash
NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1 NEWS_OVERVIEW_CHANNELS=local node scripts/news-overview.js
```

### 临时在线更新（抓取 + Gemini）

```bash
NEWS_OVERVIEW_CHANNELS=json node scripts/news-overview.js --live
```

### 发布（Notion + Telegram）

```bash
NEWS_OVERVIEW_CHANNELS=publish NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1 node scripts/news-overview.js
```

---

## 7. 常见问题

### 端口 3000 被占用（`EADDRINUSE`）

```bash
lsof -i :3000
kill -9 <PID>
npm start
```

### 本地接口返回异常（代理影响 localhost）

临时禁用代理再请求：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy curl http://127.0.0.1:3000/api/health
```

### 截图失败（Playwright 未安装）

按第 3 步重新安装 `playwright + chromium`。

---

## 8. 建议迁移后固定配置

- `NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1`
- `NEWS_OVERVIEW_CHANNELS=local`（日常本地生成）
- 需要发布时再切 `publish`
- 需要更新快照时再用 `--live`

2026-01-12,迁移到新设备更新如下
 修复的问题：
  1. NODE_BIN - 注释掉了 Linux 路径
  2. HTTP_PROXY - 注释掉了代理配置（代理未运行）
  3. NEWS_OVERVIEW_CHANNELS=local - 设置仅本地模式，跳过 Notion/Telegram
  4. 安装了 Playwright Chromium 浏览器 v1208

  当前配置：
  - 服务器运行在 http://localhost:3000
  - 图片格式：PNG（可在 .env 设置 NEWS_OVERVIEW_RENDER_FORMAT=jpg 改为 JPG）

  可用接口：
  GET  http://localhost:3000/api/news-overview        # JSON 数据
  GET  http://localhost:3000/api/news-overview-html   # HTML 页面
  GET  http://localhost:3000/api/news-overview-image  # 图片
  POST http://localhost:3000/api/send-brief           # 触发刷新

  现在可以从你的微信自动化脚本调用了。