# WeChat Official Account Channel Memo

## 置顶命令（睡前一键）
- 实时更新后本地产物：`node scripts/news-overview.js --live --channels local`
- 最终公众号推送：`node scripts/news-overview.js --channels wechat_official_account`

更新时间：2026-02-13

## 模块目标
- 把 `news-overview` 的结果稳定发布到微信公众号草稿箱。
- 优先保证可发布、可复现、可维护，不再在该模块内承载超链接实验。

## 模块边界
- 输入：`jsonPayload`（`title`、`briefLines`、`sources`、`generatedAt`、`timeZone`）。
- 输出：微信公众号草稿（`draft/add`）。
- 不负责：正文可点击外链能力验证、阅读原文跳转策略。

## 核心链路
1. `fetchWechatAccessToken`：获取 `access_token`。
2. `resolveWechatCoverFromRenderFlow`：固定走单独封面渲染。
3. `uploadWechatImageMaterial`：上传封面图到素材库，拿 `media_id`。
4. `renderWechatArticleHtml`：组装正文（纯文本速览 + 纯文本信源标题）。
5. `createWechatDraft`：提交草稿。

## 缝合位置（主项目内）
- 通道入口：`scripts/news-overview.js` 的 `resolveChannels`。
- 主流程挂载：`main()` 内 `channels.has('wechat_official_account')` 分支。
- 渲染能力缝合：复用 Playwright 运行环境与 `logs` 目录约定。
- 多语言缝合：正文分节标题与信源中文名复用 `LOCALES` + `localizeSourceName`。

## 当前实现约束（已固化）
- 封面：蓝色渐变单独渲染，中心文案为 `国际简报 - YYYY-MM-DD`。
- 图文标题：默认 `简报速览`（可用 `WECHAT_OFFICIAL_ACCOUNT_TITLE` 覆盖）。
- 正文：不显示更新时间；不插入任何超链接。
- 发布接口：仅使用 `draft/add`。

## 配置项（保留）
- `WECHAT_OFFICIAL_ACCOUNT_APP_ID`
- `WECHAT_OFFICIAL_ACCOUNT_APP_SECRET`
- `WECHAT_OFFICIAL_ACCOUNT_TITLE`
- `WECHAT_OFFICIAL_ACCOUNT_AUTHOR`
- `WECHAT_OFFICIAL_ACCOUNT_DIGEST`
- `WECHAT_OFFICIAL_ACCOUNT_SHOW_COVER_PIC`
- `WECHAT_OFFICIAL_ACCOUNT_NEED_OPEN_COMMENT`
- `WECHAT_OFFICIAL_ACCOUNT_ONLY_FANS_CAN_COMMENT`

## 变更结论
- 本模块已从“功能探索态”收敛到“稳定发布态”。
- 后续若重启超链接能力，应新开实验模块，不在当前发布模块里混做。
