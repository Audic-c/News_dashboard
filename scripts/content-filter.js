/**
 * Content Filter Module - 敏感词过滤
 *
 * 用法：
 *   NEWS_OVERVIEW_CONTENT_FILTER=1  启用过滤
 *   NEWS_OVERVIEW_CONTENT_FILTER=0  禁用过滤
 *
 * 移除方式：
 *   1. 删除此文件
 *   2. 在 news-overview.js 中移除相关 require 和调用
 */

// 替换文本（统一遮盖，可通过环境变量覆盖）
const MASK_TEXT = process.env.NEWS_OVERVIEW_CONTENT_FILTER_MASK || '**';

// 中文名字的分隔符容错（用于匹配如“习-近-平”“习 近 平”等写法）
const CJK_SEP = '[\\s\\-_.·]*';

function buildCjkFlexiblePattern(term) {
    const chars = Array.from(term).map(ch => escapeRegex(ch));
    return new RegExp(chars.join(CJK_SEP), 'g');
}

function buildAsciiWordPattern(term) {
    return new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
}

// 敏感规则库（按中国语境常见高敏词做覆盖，可按需增删）
const SENSITIVE_RULES = [
    // 人名/称谓（中英文）
    { label: '习近平', pattern: buildCjkFlexiblePattern('习近平') },
    { label: '习主席', pattern: buildCjkFlexiblePattern('习主席') },
    { label: '习总书记', pattern: buildCjkFlexiblePattern('习总书记') },
    { label: '习大大', pattern: buildCjkFlexiblePattern('习大大') },
    { label: 'Xi Jinping', pattern: buildAsciiWordPattern('Xi Jinping') },
    { label: 'Xi Jin Ping', pattern: buildAsciiWordPattern('Xi Jin Ping') },
    { label: 'President Xi', pattern: buildAsciiWordPattern('President Xi') },
    { label: 'Chairman Xi', pattern: buildAsciiWordPattern('Chairman Xi') },
    { label: 'XJP', pattern: buildAsciiWordPattern('XJP') },
    { label: 'X i J i n p i n g', pattern: /x[\s._-]*i[\s._-]*j[\s._-]*i[\s._-]*n[\s._-]*p[\s._-]*i[\s._-]*n[\s._-]*g/gi },

    // 政治敏感事件/组织（中英文）
    { label: '六四', pattern: buildCjkFlexiblePattern('六四') },
    { label: '天安门事件', pattern: buildCjkFlexiblePattern('天安门事件') },
    { label: '八九民运', pattern: buildCjkFlexiblePattern('八九民运') },
    { label: '法轮功', pattern: buildCjkFlexiblePattern('法轮功') },
    { label: 'Falun Gong', pattern: buildAsciiWordPattern('Falun Gong') },
    { label: '台湾独立', pattern: buildCjkFlexiblePattern('台湾独立') },
    { label: '台独', pattern: buildCjkFlexiblePattern('台独') },
    { label: '港独', pattern: buildCjkFlexiblePattern('港独') },
    { label: '藏独', pattern: buildCjkFlexiblePattern('藏独') },
    { label: '疆独', pattern: buildCjkFlexiblePattern('疆独') },
    { label: '新疆集中营', pattern: buildCjkFlexiblePattern('新疆集中营') },
    { label: 'Hong Kong independence', pattern: buildAsciiWordPattern('Hong Kong independence') },
    { label: 'Taiwan independence', pattern: buildAsciiWordPattern('Taiwan independence') },
    { label: 'Tibet independence', pattern: buildAsciiWordPattern('Tibet independence') },
    { label: 'Xinjiang camp', pattern: buildAsciiWordPattern('Xinjiang camp') },
];

/**
 * 构建正则表达式（忽略大小写）
 */
function buildPatterns() {
    return SENSITIVE_RULES.map(rule => ({
        pattern: rule.pattern,
        original: rule.label
    }));
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const patterns = buildPatterns();

/**
 * 过滤单个文本 - 将敏感词替换为 **
 */
function filterText(text) {
    if (!text || typeof text !== 'string') return text;
    let result = text;
    for (const { pattern } of patterns) {
        result = result.replace(pattern, MASK_TEXT);
    }
    return result;
}

/**
 * 过滤 JSON Payload 中的所有文本内容
 * @param {Object} payload - news-overview 的 JSON payload
 * @returns {Object} - 过滤后的 payload
 */
function filterPayload(payload) {
    if (!payload) return payload;

    const filtered = { ...payload };

    // 过滤 briefLines
    if (Array.isArray(filtered.briefLines)) {
        filtered.briefLines = filtered.briefLines.map(line => filterText(line));
    }

    // 过滤 title
    if (filtered.title) {
        filtered.title = filterText(filtered.title);
    }

    // 过滤 sources 中的标题
    if (Array.isArray(filtered.sources)) {
        filtered.sources = filtered.sources.map(group => ({
            ...group,
            items: (group.items || []).map(item => ({
                ...item,
                title: filterText(item.title)
            }))
        }));
    }

    return filtered;
}

/**
 * 检查是否启用过滤
 */
function isFilterEnabled() {
    const value = process.env.NEWS_OVERVIEW_CONTENT_FILTER;
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

/**
 * 主入口：根据配置决定是否过滤
 * @param {Object} payload - news-overview 的 JSON payload
 * @returns {Object} - 处理后的 payload
 */
function applyContentFilter(payload) {
    if (!isFilterEnabled()) {
        return payload;
    }
    return filterPayload(payload);
}

module.exports = {
    applyContentFilter,
    filterText,
    filterPayload,
    isFilterEnabled,
    SENSITIVE_WORDS: SENSITIVE_RULES.map(rule => rule.label)
};
