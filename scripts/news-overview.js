const fs = require('fs');
const path = require('path');
const https = require('https');
const Parser = require('rss-parser');
const { execFile } = require('child_process');
const { NEWS_SOURCES } = require('../news-sources');
const { applyContentFilter } = require('./content-filter');

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');
let feishuOverviewToken = null;
let feishuOverviewTokenExpiry = 0;

function getFeishuOverviewConfig() {
    return {
        appId: (process.env.FEISHU_APP_ID || '').trim(),
        appSecret: (process.env.FEISHU_APP_SECRET || '').replace(/\s+/g, ''),
        baseId: (process.env.FEISHU_BASE_ID || '').trim(),
        tableId: (process.env.FEISHU_TABLE_ID || '').trim()
    };
}

function loadEnv() {
    if (!fs.existsSync(ENV_PATH)) {
        return;
    }
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex === -1) {
            continue;
        }
        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required env var: ${name}`);
    }
    return value;
}

function requestJson(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
        const connectTimeout = String(options.connectTimeoutSec || process.env.HTTP_CONNECT_TIMEOUT_SEC || '15');
        const maxTime = String(options.maxTimeSec || process.env.HTTP_MAX_TIME_SEC || '90');
        const args = ['-sS', '-L', '--connect-timeout', connectTimeout, '--max-time', maxTime];
        if (proxy) {
            args.push('--proxy', proxy);
        }
        const method = options.method || 'GET';
        args.push('-X', method);
        const headers = options.headers || {};
        for (const [key, value] of Object.entries(headers)) {
            args.push('-H', `${key}: ${value}`);
        }
        if (body) {
            args.push('-d', body);
        }
        args.push(url);
        args.push('-w', '\n__STATUS__:%{http_code}\n');

        execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            const text = stdout.toString();
            const marker = '\n__STATUS__:';
            const idx = text.lastIndexOf(marker);
            if (idx === -1) {
                resolve({ status: 0, json: null, raw: text });
                return;
            }
            const raw = text.slice(0, idx).trim();
            const statusStr = text.slice(idx + marker.length).trim();
            const status = Number(statusStr) || 0;
            if (!raw) {
                resolve({ status, json: null, raw: '' });
                return;
            }
            try {
                const json = JSON.parse(raw);
                resolve({ status, json, raw });
            } catch (err) {
                resolve({ status, json: null, raw });
            }
        });
    });
}

function fetchViaCurl(url) {
    return new Promise((resolve, reject) => {
        const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
        const allProxy = process.env.ALL_PROXY || process.env.all_proxy;
        const baseArgs = ['-L', '--fail', '--silent', '--connect-timeout', '10', '--retry', '2', '--retry-delay', '1', url];
        const tryCurl = (args) => new Promise((resolveTry, rejectTry) => {
            execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    error.stderr = stderr ? stderr.toString() : '';
                    rejectTry(error);
                    return;
                }
                resolveTry(stdout);
            });
        });

        const proxyCandidates = [];
        if (allProxy) {
            proxyCandidates.push(allProxy);
        }
        if (httpsProxy && httpsProxy !== allProxy) {
            proxyCandidates.push(httpsProxy);
        }

        (async () => {
            // 1) Try curl with env-based proxy (no explicit --proxy)
            try {
                return resolve(await tryCurl(baseArgs));
            } catch (error) {
                // fall through to explicit proxy attempts
            }
            // 2) Try explicit proxies
            for (const proxy of proxyCandidates) {
                const withProxy = ['-L', '--fail', '--silent', '--connect-timeout', '10', '--retry', '2', '--retry-delay', '1', '--proxy', proxy, url];
                try {
                    return resolve(await tryCurl(withProxy));
                } catch (error) {
                    continue;
                }
            }
            reject(new Error('curl failed for all proxy modes'));
        })();
    });
}

function withTimeout(promise, ms, label) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}

function formatDateYMD(date, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

function getCurrentTimeInZone(timeZone) {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value || '00';

    const year = get('year');
    const month = get('month');
    const day = get('day');
    const hour = get('hour');
    const minute = get('minute');
    const second = get('second');
    const zonedUtcMs = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
    );
    const offsetMinutes = Math.round((zonedUtcMs - now.getTime()) / 60000);
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absMinutes = Math.abs(offsetMinutes);
    const offsetHour = String(Math.floor(absMinutes / 60)).padStart(2, '0');
    const offsetMinute = String(absMinutes % 60).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
}

function getFeishuMaxScan(defaultValue = 2000) {
    const parsed = parseInt(process.env.FEISHU_MAX_SCAN || defaultValue, 10);
    if (Number.isNaN(parsed)) return defaultValue;
    return Math.max(100, Math.min(parsed, 10000));
}

function parseFeishuSourceFilters() {
    const raw = String(process.env.FEISHU_SOURCE_FILTERS || '').trim();
    if (!raw) return new Set();
    return new Set(
        raw
            .split(/[\n,;|]+/)
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean)
    );
}

function getFeishuPerSourceLimit(fallback = 20) {
    const parsed = parseInt(process.env.FEISHU_PER_SOURCE_LIMIT || fallback, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.max(1, Math.min(parsed, 100));
}

function feishuGetFieldValue(fields, keys = []) {
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(fields, key) && fields[key] != null) {
            return fields[key];
        }
    }
    return null;
}

function feishuToText(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value).trim();
    }
    if (Array.isArray(value)) {
        return value.map(feishuToText).find(Boolean) || '';
    }
    if (typeof value === 'object') {
        if (value.text) return feishuToText(value.text);
        if (value.name) return feishuToText(value.name);
        if (value.title) return feishuToText(value.title);
        if (value.value) return feishuToText(value.value);
    }
    return '';
}

function feishuToUrl(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return /^https?:\/\//i.test(trimmed) ? trimmed : '';
    }
    if (Array.isArray(value)) {
        return value.map(feishuToUrl).find(Boolean) || '';
    }
    if (typeof value === 'object') {
        return feishuToUrl(value.url) || feishuToUrl(value.link) || feishuToUrl(value.href);
    }
    return '';
}

function feishuToDate(value, fallback) {
    const fallbackDate = fallback || new Date();
    if (value == null || value === '') return fallbackDate;
    if (Array.isArray(value)) return feishuToDate(value[0], fallbackDate);
    if (typeof value === 'number') {
        const ts = value > 9999999999 ? value : value * 1000;
        const date = new Date(ts);
        return Number.isNaN(date.getTime()) ? fallbackDate : date;
    }
    if (typeof value === 'object') {
        return feishuToDate(value.value || value.timestamp || value.text, fallbackDate);
    }
    if (typeof value === 'string') {
        const numeric = Number(value.trim());
        if (!Number.isNaN(numeric) && value.trim()) {
            const ts = numeric > 9999999999 ? numeric : numeric * 1000;
            const date = new Date(ts);
            return Number.isNaN(date.getTime()) ? fallbackDate : date;
        }
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return fallbackDate;
}

async function getFeishuOverviewToken() {
    const feishuConfig = getFeishuOverviewConfig();
    if (feishuOverviewToken && Date.now() < feishuOverviewTokenExpiry) {
        return feishuOverviewToken;
    }
    if (!feishuConfig.appId || !feishuConfig.appSecret) {
        throw new Error('Feishu app credentials are not configured for overview');
    }

    const response = await requestJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    }, JSON.stringify({
        app_id: feishuConfig.appId,
        app_secret: feishuConfig.appSecret
    }));

    if (response.status < 200 || response.status >= 300 || !response.json || response.json.code !== 0 || !response.json.tenant_access_token) {
        throw new Error(`Feishu auth failed for overview: HTTP ${response.status} ${String(response.raw || '').slice(0, 300)}`);
    }

    feishuOverviewToken = response.json.tenant_access_token;
    feishuOverviewTokenExpiry = Date.now() + Math.max((response.json.expire || 7200) - 60, 60) * 1000;
    return feishuOverviewToken;
}

async function fetchFeishuOverviewItems(source, options = {}) {
    const feishuConfig = getFeishuOverviewConfig();
    if (!feishuConfig.baseId || !feishuConfig.tableId) {
        return [];
    }

    const token = await getFeishuOverviewToken();
    const cutoffMs = options.cutoffMs || (Date.now() - 36 * 60 * 60 * 1000);
    const debug = Boolean(options.debug);
    const perSourceLimit = getFeishuPerSourceLimit(options.perSourceLimit || 20);
    const sourceFilters = parseFeishuSourceFilters();
    const maxScan = getFeishuMaxScan(2000);

    let pageToken = '';
    let scanned = 0;
    const allItems = [];

    while (scanned < maxScan) {
        const params = new URLSearchParams({ page_size: '100' });
        if (pageToken) params.set('page_token', pageToken);
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${feishuConfig.baseId}/tables/${feishuConfig.tableId}/records?${params.toString()}`;
        const response = await requestJson(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status < 200 || response.status >= 300 || !response.json || response.json.code !== 0 || !Array.isArray(response.json.data?.items)) {
            throw new Error(`Feishu records fetch failed for overview: HTTP ${response.status} ${String(response.raw || '').slice(0, 300)}`);
        }

        const records = response.json.data.items;
        if (records.length === 0) {
            break;
        }

        for (const record of records) {
            const fields = record.fields || {};
            const title = feishuToText(feishuGetFieldValue(fields, ['Text', '标题', 'Title', 'Name']));
            const link = feishuToUrl(feishuGetFieldValue(fields, ['URL', 'Link', '链接', '网址'])) || source.url || '';
            const sourceName = feishuToText(feishuGetFieldValue(fields, ['Source', '来源'])) || source.name || '飞书收藏';
            const date = feishuToDate(
                feishuGetFieldValue(fields, ['Published Date', '发布时间', 'Date', '发布于']),
                feishuToDate(record.created_time, new Date())
            );

            if (!title || !link) continue;
            if (date && date.getTime() < cutoffMs) continue;
            if (sourceFilters.size > 0 && !sourceFilters.has(String(sourceName).trim().toLowerCase())) {
                continue;
            }

            allItems.push({ title, link, source: sourceName, date: date || new Date() });
        }

        scanned += records.length;
        const hasMore = Boolean(response.json.data.has_more);
        const nextToken = response.json.data.page_token || '';
        if (!hasMore || !nextToken) {
            break;
        }
        pageToken = nextToken;
    }

    allItems.sort((a, b) => b.date.getTime() - a.date.getTime());

    const perSourceCount = new Map();
    const seen = new Set();
    const selected = [];
    for (const item of allItems) {
        const sourceName = String(item.source || source.name || '飞书收藏').trim() || '飞书收藏';
        const count = perSourceCount.get(sourceName) || 0;
        if (count >= perSourceLimit) continue;
        const key = `${item.link.toLowerCase()}|${item.title.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        perSourceCount.set(sourceName, count + 1);
        selected.push(item);
    }

    if (debug) {
        console.log(`[feishu] selected ${selected.length} items from ${allItems.length} candidates`);
    }

    return selected;
}

async function collectArticles(maxPerSource) {
    const parser = new Parser({
        timeout: 30000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*'
        },
        customFields: {
            item: ['media:content', 'media:thumbnail', 'enclosure']
        }
    });

    const items = [];
    const cutoffMs = Date.now() - 36 * 60 * 60 * 1000;
    const debug = String(process.env.DEBUG || '').toLowerCase() === '1';

    for (const source of Object.values(NEWS_SOURCES)) {
        if (source.fetcher === 'feishu') {
            try {
                const feishuItems = await fetchFeishuOverviewItems(source, {
                    cutoffMs,
                    debug,
                    perSourceLimit: getFeishuPerSourceLimit(20)
                });
                items.push(...feishuItems);
            } catch (error) {
                if (debug) {
                    console.log(`[feishu] Failed ${source.name}: ${error.message || error}`);
                }
            }
            continue;
        }

        const urlsToTry = [source.rssUrl, ...(source.alternativeUrls || [])];
        let feedItems = null;
        for (const url of urlsToTry) {
            try {
                const xml = await withTimeout(fetchViaCurl(url), 15000, `curl ${url}`);
                const feed = await parser.parseString(xml);
                if (feed.items && feed.items.length > 0) {
                    feedItems = feed.items;
                    break;
                }
                if (debug) {
                    console.log(`[rss] Empty items from ${source.name} via curl ${url}`);
                }
            } catch (error) {
                if (debug) {
                    console.log(`[rss] Curl failed ${source.name} ${url}: ${error.message || error}`);
                }
                try {
                    const feed = await withTimeout(parser.parseURL(url), 15000, `parseURL ${url}`);
                    if (feed.items && feed.items.length > 0) {
                        feedItems = feed.items;
                        break;
                    }
                    if (debug) {
                        console.log(`[rss] Empty items from ${source.name} via parseURL ${url}`);
                    }
                } catch (fallbackError) {
                    if (debug) {
                        console.log(`[rss] Failed ${source.name} ${url}: ${fallbackError.message || fallbackError}`);
                    }
                    continue;
                }
            }
        }
        if (!feedItems) {
            if (debug) {
                console.log(`[rss] No feed items for ${source.name}`);
            }
            continue;
        }
        const cap = Number.isFinite(maxPerSource) && maxPerSource > 0 ? maxPerSource : 8;
        for (const item of feedItems.slice(0, cap)) {
            const date = parseDate(item.pubDate || item.isoDate);
            if (date && date.getTime() < cutoffMs) {
                continue;
            }
            const title = (item.title || '').trim();
            const link = (item.link || '').trim();
            if (!title || !link) {
                continue;
            }
            items.push({
                title,
                link,
                source: source.name,
                date: date || new Date()
            });
        }
    }

    items.sort((a, b) => b.date.getTime() - a.date.getTime());
    return items.slice(0, 120);
}

async function fetchOtherItems() {
    const apiKey = process.env.THENEWSAPI_KEY;
    if (!apiKey) {
        return [];
    }
    const baseUrl = process.env.THENEWSAPI_ENDPOINT || 'https://api.thenewsapi.com/v1/news/top';
    const language = process.env.THENEWSAPI_LANGUAGE || 'en';
    const limit = process.env.THENEWSAPI_LIMIT || '10';

    const params = new URLSearchParams({
        api_token: apiKey,
        language,
        limit
    });
    if (process.env.THENEWSAPI_CATEGORIES) {
        params.set('categories', process.env.THENEWSAPI_CATEGORIES);
    }
    const url = `${baseUrl}?${params.toString()}`;
    const response = await requestJson(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
    if (response.status < 200 || response.status >= 300) {
        return [];
    }
    const data = response.json || {};
    const articles = data.data || data.articles || [];
    return articles.map((item) => ({
        title: item.title || 'No title',
        link: item.url || item.link || '',
        source: 'Other (Public API)',
        date: parseDate(item.published_at || item.published || item.date) || new Date()
    }));
}

function buildPrompt(items, options) {
    const lines = items.map((item, index) => {
        const ymd = formatDateYMD(item.date, options.timeZone);
        const signal = item.isMultiSource ? '多源确认' : '单源';
        return `${index + 1}. [${item.source}] (${signal}) ${item.title} (${ymd}) ${item.link}`;
    });
    const lineLengthRule = options.maxLineChars > 0
        ? `Each output line should be <= ${options.maxLineChars} characters when possible.`
        : 'Keep each line concise and avoid overly long sentences.';

    return [
        'You are a senior global news editor.',
        'Task: produce a high-signal quick scan from the candidate list.',
        'Selection policy:',
        '- Prioritize multi-source confirmed events and major market/geopolitical impact.',
        '- Keep critical single-source exclusives if they are clearly high impact.',
        '- Avoid near-duplicates and repeated angles of the same event.',
        'Output rules (must follow):',
        `- Output ${options.minLines} to ${options.maxLines} lines, one event per line.`,
        `- Each line MUST be a concise, high-signal summary (max 1 sentence) of the event.`,
        `- Total output should stay within ${options.maxChars} characters.`,
        `- ${lineLengthRule}`,
        '- Output ONLY the summary text. No intro, no bullet, no numbering, no source label, no date, no URL.',
        '- Maintain a professional editorial tone.',
        '- Keep original language OR translate to Chinese if requested (but original is safer for downstream translation).',
        '- Ensure each line is a COMPLETE sentence/thought.',
        '',
        'Candidate headlines:',
        ...lines
    ].join('\n');
}

function buildExpandPrompt(items, existingLines, options) {
    const lines = items.map((item, index) => {
        const ymd = formatDateYMD(item.date, options.timeZone);
        return `${index + 1}. [${item.source}] ${item.title} (${ymd}) ${item.link}`;
    });
    const lineLengthRule = options.maxLineChars > 0
        ? `Each added line should be <= ${options.maxLineChars} characters when possible.`
        : 'Keep each added line concise and avoid overly long sentences.';

    return [
        'You are a senior global news editor.',
        'Task: expand the quick scan list with additional non-duplicate events.',
        'Selection policy:',
        '- Add only new events not already covered by existing lines.',
        '- Prioritize high-impact events with broad relevance.',
        'Output rules (must follow):',
        `- Expand to ${options.minLines} to ${options.maxLines} total lines.`,
        `- Each new line MUST be a complete, concise summary.`,
        `- Total output should stay within ${options.maxChars} characters.`,
        `- ${lineLengthRule}`,
        '- Output ONLY newly added summary lines.',
        '- No intro, no bullet, no numbering, no source label, no date, no URL.',
        '- Ensure each line is a COMPLETE sentence/thought.',
        '',
        'Existing lines:',
        ...existingLines.map((line, index) => `${index + 1}. ${line}`),
        '',
        'Candidate headlines:',
        ...lines
    ].join('\n');
}

async function callGemini(prompt, apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const payload = JSON.stringify({
        contents: [
            {
                role: 'user',
                parts: [{ text: prompt }]
            }
        ],
        generationConfig: {
            temperature: 0.4,
            topP: 0.9,
            maxOutputTokens: 1024
        }
    });

    const response = await requestJson(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
        }
    }, payload);

    if (response.status < 200 || response.status >= 300) {
        const raw = response.raw || '';
        throw new Error(`Gemini API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
    }
    const text = response.json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        const raw = response.raw || '';
        throw new Error(`Gemini API returned empty response. Raw: ${raw.slice(0, 500)}`);
    }
    return text.trim();
}

function normalizeContentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') {
                    if (typeof part.text === 'string') return part.text;
                    if (part.type === 'text' && typeof part.content === 'string') return part.content;
                }
                return '';
            })
            .join('');
    }
    return '';
}

async function callBailianText(prompt, apiKey, model) {
    const endpoint = process.env.BAILIAN_TEXT_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    const connectTimeoutSec = Number(process.env.BAILIAN_TEXT_CONNECT_TIMEOUT_SEC || process.env.HTTP_CONNECT_TIMEOUT_SEC || 20);
    const maxTimeSec = Number(process.env.BAILIAN_TEXT_MAX_TIME_SEC || process.env.HTTP_MAX_TIME_SEC || 120);
    const payload = JSON.stringify({
        model,
        messages: [
            { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        top_p: 0.9,
        max_tokens: 1024
    });
    const response = await requestJson(endpoint, {
        method: 'POST',
        connectTimeoutSec,
        maxTimeSec,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        }
    }, payload);
    if (response.status < 200 || response.status >= 300) {
        const raw = response.raw || '';
        throw new Error(`Bailian text API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
    }
    const content = response.json?.choices?.[0]?.message?.content;
    const text = normalizeContentToText(content).trim();
    if (!text) {
        const raw = response.raw || '';
        throw new Error(`Bailian text API returned empty response. Raw: ${raw.slice(0, 500)}`);
    }
    return text;
}

async function callSummaryModel(prompt, options = {}) {
    const provider = String(options.provider || '').trim().toLowerCase();
    const model = options.model;
    if (provider === 'gemini') {
        return callGemini(prompt, options.apiKey, model);
    }
    return callBailianText(prompt, options.apiKey, model);
}

function normalizeBrief(text, maxChars) {
    let cleaned = text.replace(/\r\n/g, '\n').trim();
    if (cleaned.length > maxChars) {
        cleaned = cleaned.slice(0, maxChars);
    }
    return cleaned;
}

function clampWithEllipsis(text, maxChars = 15) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxChars) return normalized;
    if (maxChars <= 1) return '…';
    return `${normalized.slice(0, maxChars - 1)}…`;
}

function splitBriefLines(brief) {
    if (!brief) return [];

    // 1. Unify inline numbering into newlines.
    let processed = brief.replace(/(\s+\(?(?:\d+|[a-zA-Z])[\.)\uff0e\uff09]\s+)/g, '\n');

    // 2. Initial split by newlines
    let lines = processed
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    // 3. Initial cleaning
    lines = stripMetaLines(lines);

    // 4. If we have very few lines, it might be a single block of text.
    // Use a regex that keeps the delimiters to avoid "harsh truncation" (missing periods).
    if (lines.length < 3) {
        let punctuated = [];
        for (const line of lines) {
            // Split while KEEPING the delimiters: [。；;!?]
            const parts = line.split(/([。；;!?\n])\s*/g);
            let currentPath = '';
            for (let i = 0; i < parts.length; i++) {
                const part = (parts[i] || '').trim();
                if (!part) continue;

                // If it's a delimiter, attach it to the previous part
                if (/^[。；;!?\n]$/.test(part)) {
                    if (punctuated.length > 0) {
                        punctuated[punctuated.length - 1] += part;
                    }
                } else {
                    punctuated.push(part);
                }
            }
        }
        // Only switch to punctuated if it actually gave us more useful content
        const cleanedPunctuated = stripMetaLines(punctuated).filter(p => p.length > 6);
        if (cleanedPunctuated.length >= lines.length) {
            lines = cleanedPunctuated;
        }
    }

    return lines;
}

function softClampLineLengths(lines, maxLineChars) {
    if (!maxLineChars || maxLineChars <= 0) return lines;
    const softLimit = Math.max(1, maxLineChars);
    const hardLimit = softLimit + 6;
    return lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed.length <= hardLimit) {
            return trimmed;
        }
        const sliceTo = Math.max(0, softLimit - 3);
        return `${trimmed.slice(0, sliceTo)}...`;
    });
}

function enforceLineRules(lines, maxLineChars, minLines, fallbackItems) {
    let output = softClampLineLengths(lines, maxLineChars)
        .map((line) => line.replace(/^关注[:：]\s*/g, '').trim())
        .filter((line) => line.length > 0);
    if (output.length < minLines && Array.isArray(fallbackItems)) {
        for (const item of fallbackItems) {
            if (output.length >= minLines) break;
            const text = `${item.title || ''}`.trim();
            if (!text) continue;
            // Avoid duplicates
            if (output.some(l => l.includes(text) || text.includes(l))) continue;
            output.push(text);
        }
    }
    return softClampLineLengths(output, maxLineChars);
}

function stripMetaLines(lines) {
    const bannedPrefixes = [
        '作为资深编辑',
        '作为资深新闻编辑',
        '去除重复',
        '已为你整合',
        '新闻速览',
        '重点条目',
        '为您整理',
        '以下是',
        'Here is',
        'Here are',
        'Summary:',
        'Brief:',
        '选出的内容',
        '主要新闻'
    ];

    return lines
        .map((line) => {
            return line
                .replace(/^关注[:：]\s*/g, '')
                // Remove Markdown bolding
                .replace(/^\*\*|\*\*$/g, '')
                // Remove leading numbers: "1. ", "1) ", "1．", "1）", "(1) ", "A. "
                .replace(/^(\(?(?:\d+|[a-zA-Z])[\s.)\uff0e\uff09]+\s*)/, '')
                // Remove leading bullets and heading symbols: "- ", "* ", "• ", "· ", "### "
                .replace(/^[\s\-\*\u2022\u00b7#]+\s*/, '')
                .trim();
        })
        .filter((line) => line.length > 0)
        .filter((line) => !bannedPrefixes.some((prefix) =>
            line.toLowerCase().startsWith(prefix.toLowerCase())
        ));
}

function groupSourcesByPublication(items, limitPerSource = 3) {
    const map = new Map();
    for (const item of items) {
        if (!map.has(item.source)) {
            map.set(item.source, []);
        }
        const list = map.get(item.source);
        if (list.length < limitPerSource) {
            list.push(item);
        }
    }
    return map;
}

function normalizeTitleForSimilarity(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleTokens(title) {
    const normalized = normalizeTitleForSimilarity(title);
    if (!normalized) return [];
    const hasCjk = /[\u4e00-\u9fff]/.test(normalized);
    const tokens = new Set();
    if (hasCjk) {
        const compact = normalized.replace(/\s+/g, '');
        for (let i = 0; i < compact.length - 1; i += 1) {
            tokens.add(compact.slice(i, i + 2));
        }
    }
    normalized.split(' ').forEach((word) => {
        if (word.length >= 3) {
            tokens.add(word);
        }
    });
    return Array.from(tokens);
}

function jaccardSimilarity(a, b) {
    if (!a.length || !b.length) return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token)) intersection += 1;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

function clusterItems(items, threshold = 0.6) {
    const clusters = [];
    for (const item of items) {
        const tokens = titleTokens(item.title);
        let matched = false;
        for (const cluster of clusters) {
            const score = jaccardSimilarity(tokens, cluster.tokens);
            if (score >= threshold) {
                cluster.items.push(item);
                cluster.sources.add(item.source);
                matched = true;
                break;
            }
        }
        if (!matched) {
            clusters.push({ tokens, items: [item], sources: new Set([item.source]) });
        }
    }
    return clusters;
}

function selectFromClusters(clusters, maxPerEvent = 2, minSingletons = 8) {
    const multiSource = [];
    const singleSource = [];

    for (const cluster of clusters) {
        const sorted = cluster.items.sort((a, b) => b.date.getTime() - a.date.getTime());
        if (cluster.sources.size > 1) {
            multiSource.push({
                items: sorted.slice(0, maxPerEvent),
                sources: cluster.sources,
                isMultiSource: true
            });
        } else {
            singleSource.push({
                items: sorted.slice(0, 1),
                sources: cluster.sources,
                isMultiSource: false
            });
        }
    }

    multiSource.sort((a, b) => b.items[0].date.getTime() - a.items[0].date.getTime());
    singleSource.sort((a, b) => b.items[0].date.getTime() - a.items[0].date.getTime());

    const selected = [];
    for (const cluster of multiSource) {
        selected.push(...cluster.items.map((item) => ({ ...item, isMultiSource: true })));
    }
    for (const cluster of singleSource.slice(0, minSingletons)) {
        selected.push(...cluster.items.map((item) => ({ ...item, isMultiSource: false })));
    }

    return selected;
}

function toGroupedSourcesArray(grouped) {
    const output = [];
    for (const [sourceName, items] of grouped.entries()) {
        output.push({
            source: sourceName,
            items: items.map((item) => ({
                title: item.title,
                link: item.link,
                date: item.date ? item.date.toISOString() : null
            }))
        });
    }
    return output;
}

function parseCliArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            continue;
        }
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[key] = true;
            continue;
        }
        args[key] = next;
        i += 1;
    }
    return args;
}

function parseBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function resolveChannels(rawValue) {
    const defaultChannels = new Set(['notion', 'telegram', 'json', 'render']);
    const wechatOfficialAccountReady = Boolean(
        process.env.WECHAT_OFFICIAL_ACCOUNT_APP_ID
        && process.env.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET
    );
    if (wechatOfficialAccountReady) {
        defaultChannels.add('wechat_official_account');
    }
    if (!rawValue) {
        return defaultChannels;
    }

    const normalized = String(rawValue).trim().toLowerCase();
    if (!normalized || normalized === 'all') {
        return defaultChannels;
    }

    const aliases = {
        publish: ['notion', 'telegram'],
        local: ['json', 'render'],
        render: ['json', 'render']
    };

    const output = new Set();
    for (const part of normalized.split(/[\s,;|]+/).filter(Boolean)) {
        if (aliases[part]) {
            aliases[part].forEach((name) => output.add(name));
            continue;
        }
        if (['notion', 'telegram', 'json', 'render', 'wechat_official_account'].includes(part)) {
            output.add(part);
        }
    }

    return output.size > 0 ? output : defaultChannels;
}

function renderWechatArticleHtml(payload, options = {}) {
    const lang = options.lang || 'zh';
    const locale = getLocale(lang);
    const briefBlocks = (payload.briefLines || [])
        .map((line, index) => {
            const safeLine = escapeHtml(line);
            return `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.8;color:#3f3f3f;">${index + 1}. ${safeLine}</p>`;
        })
        .join('\n');

    const sourceBlocks = (payload.sources || [])
        .map((group) => {
            const sourceName = escapeHtml(localizeSourceName(group.source || 'Unknown Source', lang));
            const items = (group.items || [])
                .map((item) => `<p style="margin:0 0 10px 0;font-size:15px;line-height:1.8;color:#3f3f3f;">- ${escapeHtml(item.title || '')}</p>`)
                .join('\n');
            return `<h3 style="margin:18px 0 10px 0;font-size:16px;font-weight:700;border-left:4px solid #1aad19;padding-left:10px;color:#1f1f1f;">${sourceName}</h3>\n${items}`;
        })
        .join('\n');

    return [
        '<div style="padding:6px 2px 2px 2px;">',
        `<h3 style="margin:0 0 10px 0;font-size:16px;font-weight:700;border-left:4px solid #1aad19;padding-left:10px;color:#1f1f1f;">${escapeHtml(locale.overview)}</h3>`,
        briefBlocks || '<p style="margin:0 0 12px 0;font-size:15px;color:#3f3f3f;">（暂无内容）</p>',
        '<div style="height:12px;"></div>',
        `<h3 style="margin:0 0 10px 0;font-size:16px;font-weight:700;border-left:4px solid #1aad19;padding-left:10px;color:#1f1f1f;">${escapeHtml(locale.sources)}</h3>`,
        sourceBlocks || '<p style="margin:0 0 12px 0;font-size:15px;color:#3f3f3f;">（暂无内容）</p>',
        '</div>'
    ].join('\n');
}

function readOverviewSnapshot(snapshotPath) {
    if (!fs.existsSync(snapshotPath)) {
        throw new Error(`Snapshot JSON not found: ${snapshotPath}`);
    }
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const json = JSON.parse(raw);
    if (!json || !Array.isArray(json.briefLines) || !Array.isArray(json.sources)) {
        throw new Error(`Invalid snapshot JSON structure: ${snapshotPath}`);
    }
    return json;
}

function warnIfSnapshotStale(snapshotPath, maxAgeHours = 24) {
    if (!fs.existsSync(snapshotPath)) {
        return;
    }
    const maxHours = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? maxAgeHours : 24;
    try {
        const stat = fs.statSync(snapshotPath);
        const ageMs = Date.now() - stat.mtimeMs;
        const thresholdMs = maxHours * 60 * 60 * 1000;
        if (ageMs > thresholdMs) {
            const ageHours = (ageMs / (60 * 60 * 1000)).toFixed(1);
            console.warn(`[snapshot-stale-warning] ${path.basename(snapshotPath)} is ${ageHours}h old (> ${maxHours}h).`);
        }
    } catch (error) {
        console.warn(`[snapshot-stale-warning] failed to check snapshot freshness: ${error.message || error}`);
    }
}

function flattenGroupedSources(groups) {
    const output = [];
    for (const group of groups || []) {
        const sourceName = group && group.source ? group.source : 'Unknown Source';
        for (const item of group.items || []) {
            output.push({
                source: sourceName,
                title: item.title || '',
                link: item.link || '',
                date: parseDate(item.date) || new Date()
            });
        }
    }
    return output;
}

async function translateTextsViaAzure(texts, to = 'zh-Hans') {
    const key = process.env.AZURE_TRANSLATOR_KEY;
    const region = process.env.AZURE_TRANSLATOR_REGION;
    const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';
    if (!key || !region) {
        throw new Error('Azure Translator not configured. Set AZURE_TRANSLATOR_KEY and AZURE_TRANSLATOR_REGION');
    }
    if (!Array.isArray(texts) || texts.length === 0) {
        return [];
    }

    const params = new URLSearchParams({ 'api-version': '3.0', to });
    const url = `${endpoint.replace(/\/$/, '')}/translate?${params.toString()}`;
    const payload = JSON.stringify(texts.map((text) => ({ Text: text })));

    const response = await requestJson(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': key,
            'Ocp-Apim-Subscription-Region': region
        }
    }, payload);

    if (response.status < 200 || response.status >= 300) {
        const raw = response.raw || '';
        throw new Error(`Azure Translator API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
    }

    return (response.json || []).map((item) => item?.translations?.[0]?.text || '');
}

async function applyZhTranslationToPayload(jsonPayload) {
    const briefTexts = (jsonPayload.briefLines || []).map((line) => String(line || ''));
    const sourceTitles = (jsonPayload.sources || [])
        .flatMap((group) => (group.items || []).map((item) => String(item.title || '')));
    const allTexts = [...briefTexts, ...sourceTitles];

    if (allTexts.length === 0) {
        return jsonPayload;
    }

    const translated = await translateTextsViaAzure(allTexts, 'zh-Hans');
    const briefTranslated = translated.slice(0, briefTexts.length);
    const sourceTranslated = translated.slice(briefTexts.length);

    let index = 0;
    const newSources = (jsonPayload.sources || []).map((group) => {
        const items = (group.items || []).map((item) => {
            const translatedTitle = sourceTranslated[index] || item.title;
            index += 1;
            return { ...item, title: translatedTitle };
        });
        return { ...group, items };
    });

    return {
        ...jsonPayload,
        briefLines: briefTranslated.length ? briefTranslated : jsonPayload.briefLines,
        sources: newSources
    };
}

function escapeHtml(input) {
    return String(input || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 多语言框架
const LOCALES = {
    en: {
        defaultTitle: 'International Brief',
        generated: 'Generated',
        timeZone: 'Time Zone',
        overview: 'Brief Highlights',
        sources: 'Sources',
        // 新闻源名称（英文保持原样）
        sourceNames: {},
        // 时区显示名称
        timeZoneNames: {
            'Asia/Shanghai': 'Beijing Time (UTC+8)',
            'America/New_York': 'Eastern Time (UTC-5/-4)',
            'UTC': 'UTC'
        }
    },
    zh: {
        defaultTitle: '国际简报',
        generated: '生成时间',
        timeZone: '时区',
        overview: '简报速览',
        sources: '信息来源',
        // 新闻源中文名称
        sourceNames: {
            'The Economist': '经济学人',
            'Financial Times': '金融时报',
            'Bloomberg': '彭博社',
            'The New York Times': '纽约时报',
            'BBC News': 'BBC新闻',
            'Reuters': '路透社',
            'South China Morning Post': '南华早报',
            'MIT Technology Review': '麻省理工科技评论',
            'The New Yorker': '纽约客',
            'The Guardian': '卫报',
            'Wall Street Journal': '华尔街日报',
            'Other (Public API)': '其他来源'
        },
        // 时区显示名称（中文）
        timeZoneNames: {
            'Asia/Shanghai': '北京时间',
            'Asia/Chongqing': '北京时间',
            'Asia/Harbin': '北京时间',
            'Asia/Urumqi': '新疆时间',
            'America/New_York': '美国东部时间',
            'America/Los_Angeles': '美国西部时间',
            'Europe/London': '英国时间',
            'UTC': '世界协调时间'
        }
    }
};

function getLocale(lang) {
    return LOCALES[lang] || LOCALES.en;
}

function localizeSourceName(name, lang) {
    const locale = getLocale(lang);
    return (locale.sourceNames && locale.sourceNames[name]) || name;
}

function localizeTimeZoneName(timeZone, lang) {
    const locale = getLocale(lang);
    return (locale.timeZoneNames && locale.timeZoneNames[timeZone]) || timeZone;
}

function renderOverviewHtml(payload, options = {}) {
    const pageWidth = Number(options.width) > 0 ? Number(options.width) : 1080;
    const lang = options.lang || 'en';
    const locale = getLocale(lang);
    const briefHtml = (payload.briefLines || [])
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('\n');

    const sourcesHtml = (payload.sources || [])
        .map((group) => {
            const itemsHtml = (group.items || [])
                .map((item) => `<li><a href="${escapeHtml(item.link || '#')}" target="_blank" rel="noopener">${escapeHtml(item.title || '')}</a></li>`)
                .join('\n');
            const localizedSourceName = localizeSourceName(group.source || '', lang);
            return `<section class="source-group"><h3>${escapeHtml(localizedSourceName)}</h3><ul>${itemsHtml}</ul></section>`;
        })
        .join('\n');

    return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(payload.title || locale.defaultTitle)}</title>
    <style>
        :root {
            --bg: #f8fafc;
            --card: #ffffff;
            --ink: #0f172a;
            --muted: #475569;
            --line: #e2e8f0;
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: var(--bg); color: var(--ink); }
        body {
            width: ${pageWidth}px;
            margin: 0 auto;
            padding: 40px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            line-height: 1.6;
            font-size: 20px;
        }
        .card {
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 24px;
            margin-bottom: 20px;
        }
        h1 { margin: 0 0 12px; font-size: 38px; line-height: 1.25; }
        h2 { margin: 0 0 14px; font-size: 28px; }
        h3 { margin: 0 0 10px; font-size: 22px; }
        p.meta { margin: 0; color: var(--muted); font-size: 16px; }
        ul { margin: 0; padding-left: 1.2em; }
        li { margin: 0.35em 0; }
        .source-group { margin-bottom: 18px; }
        a { color: #1d4ed8; text-decoration: none; }
    </style>
</head>
<body>
    <section class="card">
        <h1>${escapeHtml(payload.title || locale.defaultTitle)}</h1>
        <p class="meta">${locale.generated}: ${escapeHtml(payload.generatedAt || '--')} | ${locale.timeZone}: ${escapeHtml(localizeTimeZoneName(payload.timeZone || '', lang))}</p>
    </section>
    <section class="card">
        <h2>${locale.overview}</h2>
        <ul>${briefHtml}</ul>
    </section>
    <section class="card">
        <h2>${locale.sources}</h2>
        ${sourcesHtml}
    </section>
</body>
</html>`;
}

function syncXiaohongshuAliasFiles(outputDir, imageExt, enabled) {
    if (!enabled) {
        return;
    }

    const allFiles = fs.readdirSync(outputDir);
    const ext = String(imageExt || 'jpg').toLowerCase();
    const coverName = `news-overview.latest.cover.${ext}`;
    const fullName = `news-overview.latest.${ext}`;
    const partRegex = new RegExp(`^news-overview\\.latest\\.part(\\d+)\\.${ext}$`);

    const partFiles = allFiles
        .map((name) => {
            const match = name.match(partRegex);
            if (!match) return null;
            return { name, idx: Number(match[1]) };
        })
        .filter(Boolean)
        .sort((a, b) => a.idx - b.idx)
        .map((item) => item.name);

    const coverCandidate = allFiles.includes(coverName)
        ? coverName
        : (partFiles[0] || (allFiles.includes(fullName) ? fullName : null));

    const bodyCandidates = partFiles.length > 0
        ? partFiles.filter((name) => name !== coverCandidate)
        : (allFiles.includes(fullName) && fullName !== coverCandidate ? [fullName] : []);

    const aliasRegex = new RegExp(`^xhs_\\d{2}(?:_cover)?\\.${ext}$`);
    for (const name of allFiles) {
        if (aliasRegex.test(name)) {
            fs.unlinkSync(path.join(outputDir, name));
        }
    }

    if (!coverCandidate) {
        return;
    }

    let aliasIndex = 1;
    const coverAlias = `xhs_${String(aliasIndex).padStart(2, '0')}_cover.${ext}`;
    fs.copyFileSync(path.join(outputDir, coverCandidate), path.join(outputDir, coverAlias));
    aliasIndex += 1;

    for (const sourceName of bodyCandidates) {
        const bodyAlias = `xhs_${String(aliasIndex).padStart(2, '0')}.${ext}`;
        fs.copyFileSync(path.join(outputDir, sourceName), path.join(outputDir, bodyAlias));
        aliasIndex += 1;
    }
}

async function saveOverviewRenderArtifacts(payload, options = {}) {
    const renderHtmlEnabled = !['0', 'false', 'no', 'off'].includes(String(process.env.NEWS_OVERVIEW_RENDER_HTML || '1').toLowerCase());
    const renderImageEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.NEWS_OVERVIEW_RENDER_IMAGE || '').toLowerCase());
    if (!renderHtmlEnabled && !renderImageEnabled) {
        return;
    }

    const renderProfile = String(process.env.NEWS_OVERVIEW_RENDER_PROFILE || '').toLowerCase();
    let profileDefaults = {
        width: 1080,
        scale: 2,
        format: 'png',
        quality: 88,
        split: false,
        segmentHeight: 0,
        overlap: 0,
        coverSquare: false
    };
    if (renderProfile === 'wechat_official_account') {
        profileDefaults = { width: 900, scale: 2, format: 'jpg', quality: 86, split: true, segmentHeight: 2200, overlap: 80, coverSquare: false };
    } else if (renderProfile === 'xiaohongshu') {
        profileDefaults = { width: 1080, scale: 2, format: 'jpg', quality: 87, split: true, segmentHeight: 1800, overlap: 100, coverSquare: false };
    } else if (renderProfile === 'xiaohongshu-square') {
        profileDefaults = { width: 1080, scale: 2, format: 'jpg', quality: 88, split: true, segmentHeight: 1080, overlap: 80, coverSquare: true };
    }

    const outputDir = path.join(ROOT_DIR, process.env.NEWS_OVERVIEW_RENDER_DIR || 'logs');
    fs.mkdirSync(outputDir, { recursive: true });

    const width = Number(process.env.NEWS_OVERVIEW_RENDER_WIDTH || profileDefaults.width);
    const scale = Number(process.env.NEWS_OVERVIEW_RENDER_SCALE || profileDefaults.scale);
    const html = renderOverviewHtml(payload, { width, lang: options.lang });
    const htmlPath = path.join(outputDir, 'news-overview.latest.html');

    if (renderHtmlEnabled || renderImageEnabled) {
        fs.writeFileSync(htmlPath, html, 'utf8');
    }

    if (!renderImageEnabled) {
        return;
    }

    const format = String(process.env.NEWS_OVERVIEW_RENDER_FORMAT || profileDefaults.format).toLowerCase();
    const quality = Number(process.env.NEWS_OVERVIEW_RENDER_QUALITY || profileDefaults.quality);
    const imageExt = format === 'jpg' || format === 'jpeg' ? 'jpg' : 'png';
    const imagePath = path.join(outputDir, `news-overview.latest.${imageExt}`);
    const splitEnabled = parseBool(process.env.NEWS_OVERVIEW_RENDER_SPLIT, profileDefaults.split);
    const segmentHeight = Number(process.env.NEWS_OVERVIEW_RENDER_SEGMENT_HEIGHT || profileDefaults.segmentHeight || 2200);
    const overlap = Math.max(0, Number(process.env.NEWS_OVERVIEW_RENDER_SEGMENT_OVERLAP || profileDefaults.overlap || 0));
    const coverSquareEnabled = parseBool(process.env.NEWS_OVERVIEW_RENDER_COVER_SQUARE, profileDefaults.coverSquare);
    const xhsAliasEnabled = parseBool(
        process.env.NEWS_OVERVIEW_RENDER_XHS_ALIAS,
        renderProfile === 'xiaohongshu' || renderProfile === 'xiaohongshu-square'
    );
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (error) {
        throw new Error('playwright is required for NEWS_OVERVIEW_RENDER_IMAGE=1. Run: npm install && npx playwright install chromium');
    }

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({
            viewport: {
                width: Number.isFinite(width) && width > 0 ? width : 1080,
                height: 1000
            },
            deviceScaleFactor: Number.isFinite(scale) && scale > 0 ? scale : 2
        });
        await page.setContent(html, { waitUntil: 'networkidle' });
        await page.screenshot({
            path: imagePath,
            fullPage: true,
            type: imageExt === 'jpg' ? 'jpeg' : 'png',
            quality: imageExt === 'jpg' ? quality : undefined
        });

        const scrollHeight = await page.evaluate(() => {
            const bodyHeight = document.body ? document.body.scrollHeight : 0;
            const docHeight = document.documentElement ? document.documentElement.scrollHeight : 0;
            return Math.max(bodyHeight, docHeight);
        });

        if (coverSquareEnabled) {
            const coverSize = Number.isFinite(width) && width > 0 ? width : 1080;
            const coverHeight = Math.max(1, Math.min(coverSize, scrollHeight));
            const coverPath = path.join(outputDir, `news-overview.latest.cover.${imageExt}`);
            await page.screenshot({
                path: coverPath,
                type: imageExt === 'jpg' ? 'jpeg' : 'png',
                quality: imageExt === 'jpg' ? quality : undefined,
                captureBeyondViewport: true,
                clip: {
                    x: 0,
                    y: 0,
                    width: coverSize,
                    height: coverHeight
                }
            });
        }

        if (splitEnabled) {
            const totalHeight = Math.max(1, scrollHeight);
            const step = Math.max(1, segmentHeight - overlap);
            const baseWidth = Number.isFinite(width) && width > 0 ? width : 1080;
            let viewportHeight = Math.max(1, Math.min(segmentHeight, totalHeight));
            await page.setViewportSize({ width: baseWidth, height: viewportHeight });
            let index = 1;
            for (let y = 0; y < totalHeight; y += step) {
                const clipHeight = Math.min(segmentHeight, totalHeight - y);
                if (clipHeight <= 0) break;
                if (clipHeight !== viewportHeight) {
                    viewportHeight = clipHeight;
                    await page.setViewportSize({ width: baseWidth, height: viewportHeight });
                }
                await page.evaluate((scrollY) => {
                    window.scrollTo(0, scrollY);
                }, y);
                await page.waitForTimeout(50);
                const segmentName = `news-overview.latest.part${String(index).padStart(2, '0')}.${imageExt}`;
                const segmentPath = path.join(outputDir, segmentName);
                await page.screenshot({
                    path: segmentPath,
                    type: imageExt === 'jpg' ? 'jpeg' : 'png',
                    quality: imageExt === 'jpg' ? quality : undefined
                });
                index += 1;
            }
        }
    } finally {
        await browser.close();
    }

    syncXiaohongshuAliasFiles(outputDir, imageExt, xhsAliasEnabled);
}

async function createNotionPage({ token, parentPageId, title, briefLines, sources }) {
    const url = 'https://api.notion.com/v1/pages';
    const notionVersion = process.env.NOTION_VERSION || '2022-06-28';

    const children = [];
    children.push({
        object: 'block',
        type: 'heading_2',
        heading_2: {
            rich_text: [{ type: 'text', text: { content: 'News Overview' } }]
        }
    });
    for (const line of briefLines) {
        children.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: {
                rich_text: [{ type: 'text', text: { content: line } }]
            }
        });
    }

    if (sources.length > 0) {
        children.push({
            object: 'block',
            type: 'heading_2',
            heading_2: {
                rich_text: [{ type: 'text', text: { content: 'Sources' } }]
            }
        });
        const grouped = groupSourcesByPublication(sources, 3);
        for (const [sourceName, items] of grouped.entries()) {
            children.push({
                object: 'block',
                type: 'heading_3',
                heading_3: {
                    rich_text: [{ type: 'text', text: { content: sourceName } }]
                }
            });
            for (const item of items) {
                children.push({
                    object: 'block',
                    type: 'bulleted_list_item',
                    bulleted_list_item: {
                        rich_text: [{
                            type: 'text',
                            text: {
                                content: item.title,
                                link: { url: item.link }
                            }
                        }]
                    }
                });
            }
        }
    }

    const payload = JSON.stringify({
        parent: {
            type: 'page_id',
            page_id: parentPageId
        },
        properties: {
            title: [
                {
                    type: 'text',
                    text: { content: title }
                }
            ]
        },
        children
    });

    const response = await requestJson(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Notion-Version': notionVersion
        }
    }, payload);

    if (response.status < 200 || response.status >= 300) {
        const raw = response.raw || '';
        throw new Error(`Notion API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
    }
    return response.json;
}

async function sendTelegramBrief({ token, chatId, text }) {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
    });
    const response = await requestJson(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    }, payload);
    if (response.status < 200 || response.status >= 300) {
        const raw = response.raw || '';
        throw new Error(`Telegram API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
    }
    return response.json;
}

async function fetchWechatAccessToken({ appId, appSecret }) {
    const params = new URLSearchParams({
        grant_type: 'client_credential',
        appid: appId,
        secret: appSecret
    });
    const url = `https://api.weixin.qq.com/cgi-bin/token?${params.toString()}`;
    const response = await requestJson(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
    const body = response.json || {};
    if (response.status < 200 || response.status >= 300 || !body.access_token) {
        const raw = response.raw || '';
        throw new Error(`WeChat token API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
    }
    return body.access_token;
}

async function createWechatDraft({ accessToken, article }) {
    const url = `https://api.weixin.qq.com/cgi-bin/draft/add?access_token=${encodeURIComponent(accessToken)}`;
    const payload = JSON.stringify({
        articles: [article]
    });
    const response = await requestJson(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    }, payload);
    const body = response.json || {};
    if (response.status < 200 || response.status >= 300 || body.errcode) {
        const raw = response.raw || '';
        throw new Error(`WeChat draft API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
    }
    return body;
}

async function resolveWechatCoverFromRenderFlow(payload, options = {}) {
    const outputDir = path.join(ROOT_DIR, process.env.NEWS_OVERVIEW_RENDER_DIR || 'logs');
    fs.mkdirSync(outputDir, { recursive: true });
    const standaloneCoverPath = path.join(outputDir, 'news-overview.wechat.cover.jpg');
    if (fs.existsSync(standaloneCoverPath)) {
        fs.unlinkSync(standaloneCoverPath);
    }

    const modelFirst = parseBool(process.env.WECHAT_COVER_USE_MODEL, true);
    if (modelFirst) {
        try {
            const modelPath = await renderWechatCoverViaBailian(payload, standaloneCoverPath);
            return { path: modelPath, mode: 'wan2.6-image' };
        } catch (error) {
            console.warn(`[wechat_official_account] model cover failed, fallback to standalone render: ${error.message}`);
        }
    }

    const standalonePath = await renderStandaloneWechatCover(payload, standaloneCoverPath);
    return { path: standalonePath, mode: 'standalone_render' };
}

async function downloadFileViaCurl(url, filePath) {
    return new Promise((resolve, reject) => {
        const args = ['-sS', '-L', '--connect-timeout', '15', '--max-time', '60', url, '-o', filePath];
        const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
        if (proxy) {
            args.splice(4, 0, '--proxy', proxy);
        }
        execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(filePath);
        });
    });
}

function extractDashscopeImageUrl(taskJson) {
    const output = taskJson?.output || {};
    const choices = output.choices || [];
    for (const choice of choices) {
        const message = choice?.message || {};
        const content = Array.isArray(message.content) ? message.content : [];
        for (const part of content) {
            if (part && typeof part === 'object') {
                if (typeof part.image === 'string' && part.image.trim()) {
                    return part.image.trim();
                }
                if (typeof part.url === 'string' && part.url.trim()) {
                    return part.url.trim();
                }
            }
        }
    }
    return '';
}

async function pollDashscopeTaskResult(taskId, apiKey) {
    const maxTries = Number(process.env.BAILIAN_IMAGE_TASK_MAX_TRIES || 20);
    const intervalMs = Number(process.env.BAILIAN_IMAGE_TASK_POLL_MS || 2000);
    const pollUrl = `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`;

    for (let i = 0; i < Math.max(1, maxTries); i += 1) {
        if (i > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.max(300, intervalMs)));
        }
        const pollResp = await requestJson(pollUrl, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${apiKey}`
            }
        });
        if (pollResp.status < 200 || pollResp.status >= 300) {
            const raw = pollResp.raw || '';
            throw new Error(`Bailian task query failed: HTTP ${pollResp.status} ${raw.slice(0, 500)}`);
        }
        const output = pollResp.json?.output || {};
        const status = String(output.task_status || '').toUpperCase();
        if (status === 'SUCCEEDED' || status === 'SUCCESS') {
            return pollResp.json;
        }
        if (status === 'FAILED' || status === 'CANCELED') {
            const raw = pollResp.raw || '';
            throw new Error(`Bailian image task ${status}: ${raw.slice(0, 500)}`);
        }
    }

    throw new Error('Bailian image task timeout');
}

async function getDashscopeTask(taskId, apiKey) {
    const pollUrl = `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`;
    const resp = await requestJson(pollUrl, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`
        }
    });
    if (resp.status < 200 || resp.status >= 300) {
        const raw = resp.raw || '';
        throw new Error(`Bailian task query failed: HTTP ${resp.status} ${raw.slice(0, 500)}`);
    }
    return resp.json || {};
}

async function renderWechatCoverViaBailian(payload, filePath) {
    const apiKey = process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
        throw new Error('Missing BAILIAN_API_KEY or DASHSCOPE_API_KEY for wechat cover image model');
    }
    const model = process.env.BAILIAN_IMAGE_MODEL || 'wan2.6-image';
    const isQwenImagePlus = /^qwen-image-plus/i.test(model);
    const endpoint = isQwenImagePlus
        ? (process.env.BAILIAN_MM_IMAGE_ENDPOINT || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
        : (process.env.BAILIAN_IMAGE_ENDPOINT || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation');
    const timeZone = payload.timeZone || 'Asia/Shanghai';
    const dateLabel = formatDateYMD(new Date(), timeZone);
    const defaultPrompt = `Design a clean Chinese business-news cover image with title "国际简报 - ${dateLabel}", blue gradient background, professional style, no watermark, high readability.`;
    const prompt = process.env.WECHAT_COVER_IMAGE_PROMPT || defaultPrompt;
    const imageSize = String(process.env.WECHAT_COVER_IMAGE_SIZE || '1280*1280').replace('x', '*');

    const isOfficialAsync = !isQwenImagePlus && endpoint.includes('/api/v1/services/aigc/image-generation/generation');

    if (isQwenImagePlus) {
        const payloadBody = JSON.stringify({
            model,
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [{ text: prompt }]
                    }
                ]
            },
            parameters: {
                result_format: 'message',
                watermark: false,
                prompt_extend: true,
                negative_prompt: '',
                size: imageSize
            }
        });

        const response = await requestJson(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            }
        }, payloadBody);

        if (response.status < 200 || response.status >= 300) {
            const raw = response.raw || '';
            throw new Error(`Bailian multimodal image API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
        }

        const imageUrl = extractDashscopeImageUrl(response.json || {});
        if (!imageUrl) {
            const raw = response.raw || '';
            throw new Error(`Bailian multimodal image API returned no image url. Raw: ${raw.slice(0, 500)}`);
        }
        await downloadFileViaCurl(imageUrl, filePath);
    } else if (isOfficialAsync) {
        const payloadBody = JSON.stringify({
            model,
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [{ text: prompt }]
                    }
                ]
            },
            parameters: {
                n: Number(process.env.WECHAT_COVER_IMAGE_N || 1),
                size: imageSize,
                enable_interleave: true
            }
        });

        const submitResp = await requestJson(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'X-DashScope-Async': 'enable'
            }
        }, payloadBody);

        if (submitResp.status < 200 || submitResp.status >= 300) {
            const raw = submitResp.raw || '';
            throw new Error(`Bailian image submit failed: HTTP ${submitResp.status} ${raw.slice(0, 500)}`);
        }

        const taskId = submitResp.json?.output?.task_id || submitResp.json?.task_id || submitResp.json?.data?.task_id;
        if (!taskId) {
            const raw = submitResp.raw || '';
            throw new Error(`Bailian image task_id missing: ${raw.slice(0, 500)}`);
        }

        let taskJson = await pollDashscopeTaskResult(taskId, apiKey);
        let imageUrl = extractDashscopeImageUrl(taskJson);
        if (!imageUrl) {
            const settleRetries = Number(process.env.BAILIAN_IMAGE_RESULT_RETRIES || 6);
            const settleIntervalMs = Number(process.env.BAILIAN_IMAGE_RESULT_POLL_MS || 1500);
            for (let i = 0; i < Math.max(1, settleRetries) && !imageUrl; i += 1) {
                await new Promise((resolve) => setTimeout(resolve, Math.max(300, settleIntervalMs)));
                taskJson = await getDashscopeTask(taskId, apiKey);
                imageUrl = extractDashscopeImageUrl(taskJson);
            }
        }
        if (!imageUrl) {
            const raw = JSON.stringify(taskJson || {}).slice(0, 500);
            throw new Error(`Bailian image task succeeded but image url missing: ${raw}`);
        }
        await downloadFileViaCurl(imageUrl, filePath);
    } else {
        const payloadBody = JSON.stringify({
            model,
            prompt,
            size: String(process.env.WECHAT_COVER_IMAGE_SIZE || '1024x1024')
        });

        const response = await requestJson(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            }
        }, payloadBody);

        if (response.status < 200 || response.status >= 300) {
            const raw = response.raw || '';
            throw new Error(`Bailian image API error: HTTP ${response.status} ${raw.slice(0, 500)}`);
        }

        const imageUrl = response.json?.data?.[0]?.url || response.json?.output?.results?.[0]?.url;
        const b64 = response.json?.data?.[0]?.b64_json || response.json?.output?.results?.[0]?.image_base64;

        if (imageUrl) {
            await downloadFileViaCurl(imageUrl, filePath);
        } else if (b64) {
            fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
        } else {
            const raw = response.raw || '';
            throw new Error(`Bailian image API returned no image url/base64. Raw: ${raw.slice(0, 500)}`);
        }
    }

    if (!fs.existsSync(filePath)) {
        throw new Error(`Bailian image output not found: ${filePath}`);
    }
    return filePath;
}

async function renderStandaloneWechatCover(payload, filePath) {
    const timeZone = payload.timeZone || 'Asia/Shanghai';
    const coverTitle = `国际简报 - ${formatDateYMD(new Date(), timeZone)}`;
    const generatedAt = escapeHtml(payload.generatedAt || new Date().toISOString());
    const coverHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { margin: 0; padding: 0; }
    body {
      width: 900px;
      height: 383px;
      background: linear-gradient(135deg, #0b1f3a 0%, #143a6f 55%, #1f5fa8 100%);
      color: #ffffff;
      font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
      overflow: hidden;
    }
    .wrap {
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      padding: 34px 42px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .tag {
      display: inline-block;
      font-size: 18px;
      letter-spacing: 1px;
      padding: 6px 14px;
      border: 1px solid rgba(255,255,255,0.4);
      border-radius: 999px;
      width: fit-content;
    }
    .title {
      font-size: 48px;
      line-height: 1.18;
      font-weight: 700;
      text-shadow: 0 6px 20px rgba(0,0,0,0.25);
    }
    .meta {
      font-size: 17px;
      opacity: 0.92;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="tag">On the way 365</div>
    <div class="title">${escapeHtml(coverTitle)}</div>
    <div class="meta">生成时间：${generatedAt}</div>
  </div>
</body>
</html>`;

    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (error) {
        throw new Error('playwright is required for standalone wechat cover rendering. Run: npm install && npx playwright install chromium');
    }

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({
            viewport: { width: 900, height: 383 },
            deviceScaleFactor: 2
        });
        await page.setContent(coverHtml, { waitUntil: 'networkidle' });
        await page.screenshot({
            path: filePath,
            type: 'jpeg',
            quality: 90
        });
    } finally {
        await browser.close();
    }
    if (!fs.existsSync(filePath)) {
        throw new Error(`Standalone wechat cover render failed: ${filePath}`);
    }
    return filePath;
}

async function uploadWechatImageMaterial({ accessToken, filePath }) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`WeChat cover file not found: ${filePath}`);
    }
    const url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${encodeURIComponent(accessToken)}&type=image`;
    return new Promise((resolve, reject) => {
        const args = [
            '-sS',
            '-L',
            '--connect-timeout', '15',
            '--max-time', '60',
            '-X', 'POST',
            '-F', `media=@${filePath}`,
            url,
            '-w', '\n__STATUS__:%{http_code}\n'
        ];
        const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
        if (proxy) {
            args.splice(4, 0, '--proxy', proxy);
        }
        execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            const text = stdout.toString();
            const marker = '\n__STATUS__:';
            const idx = text.lastIndexOf(marker);
            const raw = idx === -1 ? text.trim() : text.slice(0, idx).trim();
            const statusStr = idx === -1 ? '' : text.slice(idx + marker.length).trim();
            const status = Number(statusStr) || 0;
            let json;
            try {
                json = JSON.parse(raw || '{}');
            } catch (parseErr) {
                reject(new Error(`WeChat material API parse failed: ${raw.slice(0, 500)}`));
                return;
            }
            if (status < 200 || status >= 300 || json.errcode) {
                reject(new Error(`WeChat material API error: HTTP ${status} ${raw.slice(0, 500)}`));
                return;
            }
            if (!json.media_id) {
                reject(new Error(`WeChat material API missing media_id: ${raw.slice(0, 500)}`));
                return;
            }
            resolve(json.media_id);
        });
    });
}

async function main() {
    loadEnv();

    const cliArgs = parseCliArgs(process.argv.slice(2));
    const channels = resolveChannels(cliArgs.channels || process.env.NEWS_OVERVIEW_CHANNELS);
    const defaultUseSnapshot = true;
    const useSnapshot = parseBool(
        cliArgs.snapshot ? '1' : (cliArgs.live ? '0' : process.env.NEWS_OVERVIEW_USE_JSON_SNAPSHOT),
        defaultUseSnapshot
    );
    const snapshotMaxAgeHours = Number(process.env.NEWS_OVERVIEW_SNAPSHOT_MAX_AGE_HOURS || 24);
    const translateToZh = parseBool(cliArgs.zh ? '1' : process.env.NEWS_OVERVIEW_TRANSLATE_TO_ZH, false);
    const snapshotPath = path.resolve(ROOT_DIR, cliArgs.snapshotPath || process.env.NEWS_OVERVIEW_JSON_SNAPSHOT_PATH || 'news-overview.json');

    const summaryProvider = String(process.env.NEWS_OVERVIEW_SUMMARY_PROVIDER || 'bailian').toLowerCase();
    const summaryModel = process.env.NEWS_OVERVIEW_SUMMARY_MODEL
        || process.env.BAILIAN_TEXT_MODEL
        || process.env.GEMINI_MODEL
        || 'glm-5';
    const summaryMaxChars = Number(process.env.SUMMARY_MAX_CHARS || 900);
    const summaryMaxLineChars = Number(process.env.SUMMARY_MAX_LINE_CHARS || 0);
    const telegramMaxChars = Number(process.env.TELEGRAM_MAX_CHARS || process.env.BRIEF_MAX_CHARS || 300);
    const minLines = Number(process.env.BRIEF_MIN_LINES || 10);
    const maxLines = Number(process.env.BRIEF_MAX_LINES || 12);
    const timeZone = process.env.TIME_ZONE || 'America/New_York';
    const dedupeThreshold = Number(process.env.DEDUPE_SIM_THRESHOLD || 0.6);
    const dedupeMaxPerEvent = Number(process.env.DEDUPE_MAX_PER_EVENT || 2);
    const maxPerSource = Number(process.env.SOURCE_MAX_ITEMS || 5);
    const minSingletons = Number(process.env.DEDUPE_MIN_SINGLETONS || 8);

    let jsonPayload;
    let notionSourceItems = [];

    if (useSnapshot) {
        warnIfSnapshotStale(snapshotPath, snapshotMaxAgeHours);
        const snapshot = readOverviewSnapshot(snapshotPath);
        jsonPayload = {
            generatedAt: getCurrentTimeInZone(timeZone),
            timeZone: snapshot.timeZone || timeZone,
            title: snapshot.title || `News Overview - ${formatDateYMD(new Date(), timeZone)}`,
            briefLines: Array.isArray(snapshot.briefLines) ? snapshot.briefLines : [],
            sources: Array.isArray(snapshot.sources) ? snapshot.sources : []
        };
        notionSourceItems = flattenGroupedSources(jsonPayload.sources);
    } else {
        const summaryApiKey = summaryProvider === 'gemini'
            ? requireEnv('GEMINI_API_KEY')
            : (process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || requireEnv('BAILIAN_API_KEY'));
        const items = await collectArticles(maxPerSource);
        const otherItems = await fetchOtherItems();
        const combinedItems = items.concat(otherItems);
        if (combinedItems.length === 0) {
            throw new Error('No news items collected');
        }

        const clusters = clusterItems(combinedItems, dedupeThreshold);
        const selectedItems = selectFromClusters(clusters, dedupeMaxPerEvent, minSingletons);
        const prompt = buildPrompt(selectedItems, { minLines, maxLines, maxChars: summaryMaxChars, maxLineChars: summaryMaxLineChars, timeZone });
        const rawBrief = await callSummaryModel(prompt, {
            provider: summaryProvider,
            apiKey: summaryApiKey,
            model: summaryModel
        });
        const brief = normalizeBrief(rawBrief, summaryMaxChars);
        let briefLines = enforceLineRules(
            splitBriefLines(brief),
            summaryMaxLineChars,
            minLines,
            selectedItems
        );
        if (briefLines.length < minLines) {
            const expandPrompt = buildExpandPrompt(items, briefLines, { minLines, maxChars: summaryMaxChars, maxLineChars: summaryMaxLineChars, timeZone });
            const expanded = normalizeBrief(await callSummaryModel(expandPrompt, {
                provider: summaryProvider,
                apiKey: summaryApiKey,
                model: summaryModel
            }), summaryMaxChars);
            briefLines = enforceLineRules(
                splitBriefLines(expanded),
                summaryMaxLineChars,
                minLines,
                selectedItems
            );
        }
        briefLines = briefLines.slice(0, Math.max(minLines, Math.min(maxLines, briefLines.length)));

        const dateLabel = formatDateYMD(new Date(), timeZone);
        const title = `News Overview - ${dateLabel}`;
        const grouped = groupSourcesByPublication(items, 3);
        jsonPayload = {
            generatedAt: getCurrentTimeInZone(timeZone),
            timeZone,
            title,
            briefLines,
            sources: toGroupedSourcesArray(grouped)
        };
        notionSourceItems = items;
    }

    // Apply content filter (before translation)
    jsonPayload = applyContentFilter(jsonPayload);

    if (translateToZh) {
        jsonPayload = await applyZhTranslationToPayload(jsonPayload);
        // 本地化标题
        if (jsonPayload.title) {
            jsonPayload.title = jsonPayload.title.replace(/^News Overview/i, '国际简报').replace(/^International Brief/i, '国际简报');
        }
        notionSourceItems = flattenGroupedSources(jsonPayload.sources);
    }

    if (channels.has('notion')) {
        const notionToken = requireEnv('NOTION_TOKEN');
        const notionParentPageId = requireEnv('NOTION_PARENT_PAGE_ID');
        await createNotionPage({
            token: notionToken,
            parentPageId: notionParentPageId,
            title: jsonPayload.title,
            briefLines: jsonPayload.briefLines,
            sources: notionSourceItems
        });
    }

    if (channels.has('json')) {
        fs.writeFileSync(path.join(ROOT_DIR, 'news-overview.json'), JSON.stringify(jsonPayload, null, 2));
    }
    if (channels.has('render')) {
        await saveOverviewRenderArtifacts(jsonPayload, { lang: translateToZh ? 'zh' : 'en' });
    }

    if (channels.has('telegram')) {
        const telegramToken = requireEnv('TELEGRAM_BOT_TOKEN');
        const telegramChatId = requireEnv('TELEGRAM_CHAT_ID');
        const telegramText = normalizeBrief((jsonPayload.briefLines || []).join('\n'), telegramMaxChars);
        await sendTelegramBrief({
            token: telegramToken,
            chatId: telegramChatId,
            text: telegramText
        });
    }

    if (channels.has('wechat_official_account')) {
        const appId = requireEnv('WECHAT_OFFICIAL_ACCOUNT_APP_ID');
        const appSecret = requireEnv('WECHAT_OFFICIAL_ACCOUNT_APP_SECRET');
        const accessToken = await fetchWechatAccessToken({ appId, appSecret });
        const coverResult = await resolveWechatCoverFromRenderFlow(jsonPayload, { lang: translateToZh ? 'zh' : 'en' });
        console.log(`[wechat_official_account] cover_mode=${coverResult.mode} cover_path=${coverResult.path}`);
        const thumbMediaId = await uploadWechatImageMaterial({ accessToken, filePath: coverResult.path });
        const articleTitle = process.env.WECHAT_OFFICIAL_ACCOUNT_TITLE
            || '简报速览';
        const author = process.env.WECHAT_OFFICIAL_ACCOUNT_AUTHOR || 'AI助手';
        const rawDigest = process.env.WECHAT_OFFICIAL_ACCOUNT_DIGEST
            || normalizeBrief((jsonPayload.briefLines || []).join('；'), 120);
        const digest = clampWithEllipsis(rawDigest, 15);
        const article = {
            title: articleTitle,
            author,
            digest,
            content: renderWechatArticleHtml(jsonPayload, { lang: translateToZh ? 'zh' : 'en' }),
            thumb_media_id: thumbMediaId,
            show_cover_pic: parseBool(process.env.WECHAT_OFFICIAL_ACCOUNT_SHOW_COVER_PIC, true) ? 1 : 0,
            need_open_comment: parseBool(process.env.WECHAT_OFFICIAL_ACCOUNT_NEED_OPEN_COMMENT, false) ? 1 : 0,
            only_fans_can_comment: parseBool(process.env.WECHAT_OFFICIAL_ACCOUNT_ONLY_FANS_CAN_COMMENT, false) ? 1 : 0
        };
        await createWechatDraft({ accessToken, article });
    }

    console.log(`Daily brief completed. channels=${Array.from(channels).join(',')} mode=${useSnapshot ? 'snapshot' : 'live'} zh=${translateToZh ? 'on' : 'off'}`);
}

main().catch((error) => {
    const message = error && error.message ? error.message : String(error || '');
    console.error('Daily brief failed:', message);
    if (error && error.stack) {
        console.error(error.stack);
    }
    process.exit(1);
});
