# Notion 页面整页长图导出

这个脚本会把 Notion 页面内容自动导出为整页长图，链路如下：

1. 调 Notion API 递归读取 page blocks
2. blocks 渲染为 HTML
3. 用 Playwright 渲染 HTML 并截图为长图

## 1) 安装依赖

在项目根目录执行：

```bash
npm install
npx playwright install chromium
```

## 2) 配置环境变量（根目录 `.env`）

至少要有：

```env
NOTION_TOKEN=secret_xxx
NOTION_PAGE_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

可选项：

```env
# 默认 png，可改成 jpg
NOTION_SNAPSHOT_FORMAT=png

# 默认输出到 Additional/output
NOTION_SNAPSHOT_OUTPUT=Additional/output

# 规则命名，支持占位符：{title} {page} {ts}
NOTION_SNAPSHOT_PATTERN={title}_{page}_{ts}

# 输出宽度和缩放（文字为主建议）
NOTION_SNAPSHOT_WIDTH=1080
NOTION_SNAPSHOT_SCALE=2
```

## 3) 执行

```bash
npm run notion:snapshot
```

也可以临时覆盖参数：

```bash
node Additional/notion-page-snapshot.js --page <page_id> --format png --width 1080 --scale 2
```

## 命名规则说明

文件名来自 `NOTION_SNAPSHOT_PATTERN`，默认：

```text
{title}_{page}_{ts}.png
```

示例：

```text
Weekly_Brief_6f2c9a10_20260212_193015.png
```

这样命名适合后续自动化脚本按前缀、page 短 ID、时间戳解析。

## PNG / JPG 选择建议

- 文字类内容优先 `png`（边缘更清晰）
- 想更小体积可用 `jpg`（会有轻微压缩损失）

当前脚本默认使用 `png`。
