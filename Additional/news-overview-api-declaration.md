# News Overview 调用与运维说明

这份文档不是纯 API 列表，而是给人看的“怎么用、什么时候用、出了问题怎么判断”的说明。

你现在已经有一条完整链路：

1. 聚合新闻并调用 Gemini 生成 `briefLines`
2. 产出 `news-overview.json`
3. 直接渲染为 HTML
4. 按 profile 生成整图 / 分段图 / 封面图（可选）

---

## 快速理解（先看这个）

- 你想拿“结构化数据”给程序继续处理：用 `/api/news-overview`
- 你想拿“可阅读页面”：用 `/api/news-overview-html`
- 你想拿“可直接发平台的图片”：用 `/api/news-overview-image`
- 你想强制刷新一轮（重跑生成）：用 `/api/send-brief`

Base URL：`http://localhost:3000`

当前默认是 **JSON 快照优先**：

- 脚本默认直接读取 `news-overview.json`，不跑抓取 + Gemini。
- 如需临时在线更新（抓取+Gemini），用 `--live` 覆盖。

---

## JSON 快照模式（推荐）

核心变量：

```env
NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1
NEWS_OVERVIEW_JSON_SNAPSHOT_PATH=news-overview.json
NEWS_OVERVIEW_TRANSLATE_TO_ZH=0
```

说明：

- 快照里 `briefLines` 就是摘要正文来源（可以是此前 Gemini 结果，也可以人工维护）。
- 快照模式不会重新抓取，也不会调用 Gemini。
- 打开 `NEWS_OVERVIEW_TRANSLATE_TO_ZH=1` 时，会在发送/渲染前做英译中后处理（Azure Translator）。

临时切回在线模式：

```bash
node scripts/news-overview.js --live --channels json
```

---

## API 调用清单

### 1) 获取简报 JSON（给程序）

- Method: `GET`
- Path: `/api/news-overview`

```bash
curl -s http://localhost:3000/api/news-overview
```

典型用途：自动化脚本二次加工、入库、转发。

### 2) 获取渲染 HTML（给预览或二次截图）

- Method: `GET`
- Path: `/api/news-overview-html`

```bash
curl -s http://localhost:3000/api/news-overview-html
```

典型用途：浏览器预览、其他截图服务输入。

### 3) 获取长图（给发布）

- Method: `GET`
- Path: `/api/news-overview-image`

```bash
curl -s http://localhost:3000/api/news-overview-image -o news-overview.latest.png
```

说明：如果返回 404，优先检查 `.env` 是否开启 `NEWS_OVERVIEW_RENDER_IMAGE=1`。

### 4) 触发一次生成（手动刷新）

- Method: `POST`
- Path: `/api/send-brief`

```bash
curl -s -X POST http://localhost:3000/api/send-brief
```

带 channel 覆盖参数（推荐）：

```bash
curl -s -X POST http://localhost:3000/api/send-brief \
	-H 'Content-Type: application/json' \
	-d '{"channels":"publish"}'
```

---

## 返回约定（便于排障）

- `200`：成功
- `404`：目标产物不存在，通常是未开启对应渲染开关
- `500`：生成或服务执行失败（看服务端日志）

---

## 按场景选 Profile

## Channel 模式（流程优化）

`NEWS_OVERVIEW_CHANNELS` 用来决定一次执行里要跑哪些环节：

- `notion`：写入 Notion
- `telegram`：发送 Telegram
- `json`：落地 `news-overview.json`
- `render`：生成 HTML/图片

可写成逗号列表，或用别名：

- `all`（默认）：`notion,telegram,json,render`
- `publish`：`notion,telegram`
- `local`：`json,render`

示例：

```env
NEWS_OVERVIEW_CHANNELS=local
```

也可以命令行覆盖：

```bash
node scripts/news-overview.js --channels json,render
```

这样可以把 Notion/Telegram 从一次运行中完全剥离，减少不必要外部调用。

---

### A. 微信聊天发送（推荐）

```env
NEWS_OVERVIEW_RENDER_PROFILE=wechat
NEWS_OVERVIEW_RENDER_IMAGE=1
```

可选：分段图，便于多张发送与阅读。

```env
NEWS_OVERVIEW_RENDER_SPLIT=1
NEWS_OVERVIEW_RENDER_SEGMENT_HEIGHT=2200
NEWS_OVERVIEW_RENDER_SEGMENT_OVERLAP=80
```

### B. 小红书常规图文（推荐）

```env
NEWS_OVERVIEW_RENDER_PROFILE=xiaohongshu
NEWS_OVERVIEW_RENDER_IMAGE=1
```

可选：多图切分。

```env
NEWS_OVERVIEW_RENDER_SPLIT=1
NEWS_OVERVIEW_RENDER_SEGMENT_HEIGHT=1800
NEWS_OVERVIEW_RENDER_SEGMENT_OVERLAP=100
```

### C. 小红书封面友好版（1:1）

```env
NEWS_OVERVIEW_RENDER_PROFILE=xiaohongshu-square
NEWS_OVERVIEW_RENDER_IMAGE=1
```

该模式会额外产出封面图：

- `logs/news-overview.latest.cover.jpg`（正方形 1:1）

可选参数：

```env
NEWS_OVERVIEW_RENDER_COVER_SQUARE=1
NEWS_OVERVIEW_RENDER_SPLIT=1
NEWS_OVERVIEW_RENDER_SEGMENT_HEIGHT=1080
NEWS_OVERVIEW_RENDER_SEGMENT_OVERLAP=80
```

### D. 小红书上传顺序命名（自动）

如果你希望文件名直接按发布顺序给运营同学使用，可开启：

```env
NEWS_OVERVIEW_RENDER_XHS_ALIAS=1
```

开启后会在 `logs/` 额外复制出一组别名文件（不覆盖原文件）：

- `xhs_01_cover.jpg`（优先取封面图）
- `xhs_02.jpg`
- `xhs_03.jpg` ...

说明：

- 在 `xiaohongshu` / `xiaohongshu-square` profile 下，默认会自动开启该别名导出。
- 如果你不希望生成这组别名，可手动设为 `NEWS_OVERVIEW_RENDER_XHS_ALIAS=0`。

---

## 常见文件产物

- `news-overview.json`：结构化简报
- `logs/news-overview.latest.html`：可读 HTML
- `logs/news-overview.latest.jpg/png`：整页图
- `logs/news-overview.latest.part01.jpg` ...：分段图
- `logs/news-overview.latest.cover.jpg`：封面图（在封面模式或开关开启时）

---

## 给 Agent/MCP 的机器声明

- 扁平 manifest：`Additional/news-overview-agent-manifest.json`
- 推荐流水线：`buildThenFetchImage`、`fetchAllArtifacts`
