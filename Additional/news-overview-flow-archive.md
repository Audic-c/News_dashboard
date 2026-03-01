# News Overview 流程图存档

> 更新时间：2026-02-13
> 说明：当前流程为“JSON 快照优先”，支持 `--live` 临时切换到抓取+Gemini。

```mermaid
flowchart TD
    A[Start: node scripts/news-overview.js] --> B[Load .env + CLI args]
    B --> C[Resolve channels<br/>all/publish/local/custom]
    C --> D{Use snapshot mode?<br/>NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1<br/>or --snapshot}

    D -->|Yes| E[Read snapshot JSON<br/>news-overview.json or custom path]
    D -->|No (--live)| F[Fetch feeds + public API]
    F --> G[Deduplicate / cluster events]
    G --> H[Build prompt]
    H --> I[Call Gemini]
    I --> J[Normalize + line rules]
    J --> K[Build jsonPayload]

    E --> L{Translate to zh?<br/>NEWS_OVERVIEW_TRANSLATE_TO_ZH=1<br/>or --zh}
    K --> L

    L -->|Yes| M[Azure Translator post-process<br/>briefLines + source titles]
    L -->|No| N[Keep original text]
    M --> O[Final jsonPayload]
    N --> O

    O --> P{channels include json?}
    P -->|Yes| Q[Write news-overview.json]
    P -->|No| R[Skip json write]

    O --> S{channels include render?}
    S -->|Yes| T[Render HTML]
    T --> U{Render image enabled?}
    U -->|Yes| V[Playwright screenshot<br/>full/cover/segments]
    V --> W[Optional XHS aliases<br/>xhs_01_cover, xhs_02...]
    U -->|No| X[HTML only]
    S -->|No| Y[Skip render]

    O --> Z{channels include notion?}
    Z -->|Yes| AA[Create Notion page]
    Z -->|No| AB[Skip Notion]

    O --> AC{channels include telegram?}
    AC -->|Yes| AD[Send Telegram message]
    AC -->|No| AE[Skip Telegram]

    Q --> AF[Done]
    R --> AF
    W --> AF
    X --> AF
    Y --> AF
    AA --> AF
    AB --> AF
    AD --> AF
    AE --> AF
```

## 关键参数速记

- 模式
  - `NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1`：默认快照模式
  - `--live`：临时在线抓取 + Gemini
- 通道
  - `NEWS_OVERVIEW_CHANNELS=all|publish|local|notion,telegram,json,render`
- 翻译
  - `NEWS_OVERVIEW_TRANSLATE_TO_ZH=1`
- 渲染
  - `NEWS_OVERVIEW_RENDER_PROFILE=wechat|xiaohongshu|xiaohongshu-square`
  - `NEWS_OVERVIEW_RENDER_IMAGE=1`
- 小红书别名
  - `NEWS_OVERVIEW_RENDER_XHS_ALIAS=1`

## 推荐执行模板

- 本地稳定出图（不触发外部发布）

```bash
NEWS_OVERVIEW_CHANNELS=local NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1 node scripts/news-overview.js
```

- 临时更新快照（抓取+Gemini）

```bash
NEWS_OVERVIEW_CHANNELS=json node scripts/news-overview.js --live
```

- 发布到 Notion + Telegram（使用快照）

```bash
NEWS_OVERVIEW_CHANNELS=publish NEWS_OVERVIEW_USE_JSON_SNAPSHOT=1 node scripts/news-overview.js
```

## `.env` 与 `.env.example` 同步

新增脚本：`scripts/sync-env.sh`

- 仅检查差异（不改文件）：

```bash
./scripts/sync-env.sh .env .env.example --check
```

- 自动补齐缺失键（会先备份 `.env`）：

```bash
./scripts/sync-env.sh .env .env.example --apply
```

说明：

- 该脚本只“补缺失键”，不会覆盖你已有值（例如 token、chat id）。
- 会额外报告 `.env` 里存在但 `.env.example` 没有的键，方便清理历史项。
