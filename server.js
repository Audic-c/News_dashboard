const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { NEWS_SOURCES } = require('./news-sources');

function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        return;
    }
    const content = fs.readFileSync(envPath, 'utf8');
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

loadEnv();

const app = express();
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

// Enable CORS for frontend
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('.')); // Serve static files from current directory

// In-memory cache
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const TRANSLATION_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours
const otherCache = new Map();
const OTHER_CACHE_TTL = 60 * 60 * 1000; // 60 minutes for public news API

const FEISHU_CONFIG = {
    appId: (process.env.FEISHU_APP_ID || '').trim(),
    appSecret: (process.env.FEISHU_APP_SECRET || '').replace(/\s+/g, ''),
    baseId: (process.env.FEISHU_BASE_ID || '').trim(),
    tableId: (process.env.FEISHU_TABLE_ID || '').trim()
};
const API_KEY = (process.env.NEWS_API_KEY || process.env.API_KEY || '').trim();
let feishuToken = null;
let feishuTokenExpiry = 0;

const NEWS_OVERVIEW_FILE = path.join(__dirname, 'news-overview.json');
const NEWS_OVERVIEW_SCRIPT = path.join(__dirname, 'scripts', 'news-overview.js');
const NEWS_OVERVIEW_RENDER_DIR = path.join(__dirname, process.env.NEWS_OVERVIEW_RENDER_DIR || 'logs');
const NEWS_OVERVIEW_RENDER_HTML_FILE = path.join(NEWS_OVERVIEW_RENDER_DIR, 'news-overview.latest.html');
const NEWS_OVERVIEW_AUTO_REFRESH = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.NEWS_OVERVIEW_AUTO_REFRESH || '').toLowerCase()
);
const NEWS_OVERVIEW_TTL_MS = Number(process.env.NEWS_OVERVIEW_TTL_MIN || 30) * 60 * 1000;
let newsOverviewRefreshPromise = null;

function getNewsOverviewRenderImageFile() {
    const format = String(process.env.NEWS_OVERVIEW_RENDER_FORMAT || 'png').toLowerCase();
    const ext = format === 'jpg' || format === 'jpeg' ? 'jpg' : 'png';
    return path.join(NEWS_OVERVIEW_RENDER_DIR, `news-overview.latest.${ext}`);
}

function runNewsOverviewScript() {
    if (!newsOverviewRefreshPromise) {
        newsOverviewRefreshPromise = new Promise((resolve, reject) => {
            const nodeBin = process.env.NODE_BIN || process.execPath;
            execFile(nodeBin, [NEWS_OVERVIEW_SCRIPT], { cwd: __dirname, env: process.env }, (err) => {
                if (err) {
                    console.error('News overview refresh failed:', err);
                    reject(err);
                    return;
                }
                resolve();
            });
        }).finally(() => {
            newsOverviewRefreshPromise = null;
        });
    }
    return newsOverviewRefreshPromise;
}

function needsNewsOverviewRefresh() {
    if (!fs.existsSync(NEWS_OVERVIEW_FILE)) {
        return true;
    }
    if (!NEWS_OVERVIEW_AUTO_REFRESH) {
        return false;
    }
    try {
        const stat = fs.statSync(NEWS_OVERVIEW_FILE);
        return Date.now() - stat.mtimeMs > NEWS_OVERVIEW_TTL_MS;
    } catch (error) {
        return true;
    }
}

async function refreshNewsOverviewIfNeeded() {
    if (!NEWS_OVERVIEW_AUTO_REFRESH) {
        return;
    }
    if (!needsNewsOverviewRefresh()) {
        return;
    }
    await runNewsOverviewScript();
}

// News sources configuration (IDs match frontend)

// Get cached data or fetch fresh
async function getCachedOrFetch(key, fetchFn, fallbackFn, sampleData) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`Using cached data for ${key}`);
        return cached.data;
    }

    console.log(`Fetching fresh data for ${key}...`);
    let data = await fetchFn();

    // If direct parsing fails, try fallback
    if (data.status === 'error' && fallbackFn) {
        console.log(`Direct parsing failed for ${key}, trying fallback...`);
        data = await fallbackFn();
    }

    // If fallback also fails, use sample data if available
    if (data.status === 'error' && sampleData) {
        console.log(`Fallback failed for ${key}, using sample data`);
        data = { status: 'ok', items: sampleData };
    }

    cache.set(key, { data, timestamp: Date.now() });
    return data;
}

// Parse RSS feed with fallback to alternative URLs
async function fetchRSS(url, useAPI = false, alternativeUrls = []) {
    // Try all URLs in order: primary first, then alternatives
    const urlsToTry = [url, ...alternativeUrls];

    for (const currentUrl of urlsToTry) {
        // If useAPI is true, directly use rss2json API
        if (useAPI) {
            const result = await fetchRSSViaAPI(currentUrl);
            if (result.status === 'ok' && result.items && result.items.length > 0) {
                return result;
            }
            continue;
        }

        try {
            const feed = await parser.parseURL(currentUrl);
            if (feed.items && feed.items.length > 0) {
                return {
                    status: 'ok',
                    feed: {
                        title: feed.title,
                        link: feed.link,
                        description: feed.description
                    },
                    items: feed.items.map(item => ({
                        title: item.title || 'No title',
                        link: item.link || '#',
                        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
                        description: item.contentSnippet || item.content || '',
                        thumbnail: item.enclosure?.url || item['media:content']?.url || item['media:thumbnail']?.url || extractImage(item.content) || null,
                        categories: item.categories || []
                    }))
                };
            }
        } catch (error) {
            console.error(`Error fetching RSS from ${currentUrl}:`, error.message);
            // Continue to next URL
        }
    }

    return { status: 'error', message: 'All URLs failed', items: [] };
}

// Fallback: Use multiple RSS to JSON APIs
async function fetchRSSViaAPI(url) {
    const apis = [
        `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`,
        `https://r2rss.org/api?url=${encodeURIComponent(url)}`
    ];

    for (const apiUrl of apis) {
        try {
            console.log(`Trying API: ${apiUrl.split('?')[0]}...`);
            const response = await fetch(apiUrl);
            const data = await response.json();

            if (data.status === 'ok' && data.items && data.items.length > 0) {
                return {
                    status: 'ok',
                    feed: {
                        title: data.feed.title,
                        link: data.feed.link,
                        description: data.feed.description
                    },
                    items: data.items.map(item => ({
                        title: item.title || 'No title',
                        link: item.link || '#',
                        pubDate: item.pubDate || new Date().toISOString(),
                        description: item.description || '',
                        thumbnail: item.thumbnail || item.enclosure?.link || null,
                        categories: item.categories || []
                    }))
                };
            }
        } catch (error) {
            console.warn(`API ${apiUrl.split('?')[0]} failed:`, error.message);
            continue;
        }
    }

    console.error(`All APIs failed for ${url}`);
    return { status: 'error', message: 'All APIs failed', items: [] };
}

// Extract image from content
function extractImage(content) {
    if (!content) return null;
    const match = content.match(/<img[^>]+src="([^">]+)"/);
    return match ? match[1] : null;
}

function normalizeTextKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeUrlKey(rawUrl) {
    const input = String(rawUrl || '').trim();
    if (!input) return '';
    try {
        const parsed = new URL(input);
        const blockedParams = new Set([
            'utm_source',
            'utm_medium',
            'utm_campaign',
            'utm_term',
            'utm_content',
            'gclid',
            'fbclid',
            'spm',
            'from'
        ]);
        for (const key of Array.from(parsed.searchParams.keys())) {
            if (blockedParams.has(key.toLowerCase())) {
                parsed.searchParams.delete(key);
            }
        }
        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
        const search = parsed.searchParams.toString();
        return `${host}${pathname}${search ? `?${search}` : ''}`;
    } catch (error) {
        return input.toLowerCase();
    }
}

function dedupeCombinedItems(items) {
    const seenUrls = new Set();
    const seenTitles = new Set();
    const output = [];

    for (const item of items) {
        const urlKey = normalizeUrlKey(item.link || '');
        const titleKey = normalizeTextKey(item.title || '');

        if (urlKey && seenUrls.has(urlKey)) {
            continue;
        }
        if (titleKey && seenTitles.has(titleKey)) {
            continue;
        }

        if (urlKey) {
            seenUrls.add(urlKey);
        }
        if (titleKey) {
            seenTitles.add(titleKey);
        }

        output.push(item);
    }

    return output;
}

function getFieldValue(fields, keys = []) {
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(fields, key) && fields[key] != null) {
            return fields[key];
        }
    }
    return null;
}

function toText(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value).trim();
    }
    if (Array.isArray(value)) {
        return value.map(toText).find(Boolean) || '';
    }
    if (typeof value === 'object') {
        if (value.text) return toText(value.text);
        if (value.name) return toText(value.name);
        if (value.title) return toText(value.title);
        if (value.value) return toText(value.value);
        return '';
    }
    return '';
}

function sanitizeTransportText(value) {
    if (value == null) return '';
    try {
        return String(value)
            .normalize('NFC')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .trim();
    } catch (error) {
        return String(value)
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .trim();
    }
}

function toUrl(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return /^https?:\/\//i.test(trimmed) ? trimmed : '';
    }
    if (Array.isArray(value)) {
        return value.map(toUrl).find(Boolean) || '';
    }
    if (typeof value === 'object') {
        return toUrl(value.url) || toUrl(value.link) || toUrl(value.href);
    }
    return '';
}

function toIsoDate(value, fallbackDate) {
    const fallback = fallbackDate || new Date().toISOString();
    if (value == null || value === '') return fallback;

    if (Array.isArray(value)) {
        return toIsoDate(value[0], fallback);
    }
    if (typeof value === 'number') {
        const ts = value > 9999999999 ? value : value * 1000;
        return new Date(ts).toISOString();
    }
    if (typeof value === 'object') {
        return toIsoDate(value.value || value.timestamp || value.text, fallback);
    }
    if (typeof value === 'string') {
        const numeric = Number(value.trim());
        if (!Number.isNaN(numeric) && value.trim()) {
            const ts = numeric > 9999999999 ? numeric : numeric * 1000;
            return new Date(ts).toISOString();
        }
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }

    return fallback;
}

function normalizeCategories(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.map(toText).filter(Boolean);
    }
    if (typeof value === 'object') {
        return [toText(value)].filter(Boolean);
    }
    return [String(value)].filter(Boolean);
}

function getFeishuLimit(limit = 20) {
    const parsed = parseInt(limit, 10);
    if (Number.isNaN(parsed)) return 20;
    return Math.max(1, Math.min(parsed, 100));
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

function normalizeFeishuRecord(record, source) {
    const fields = record.fields || {};
    const title = sanitizeTransportText(toText(getFieldValue(fields, ['Text', '标题', 'Title', 'Name']))) || '无标题';
    const link = toUrl(getFieldValue(fields, ['URL', 'Link', '链接', '网址'])) || source.url || '#';
    const description = sanitizeTransportText(toText(getFieldValue(fields, ['Summary', '摘要', 'Description', 'Content', '正文']))) || '';
    const thumbnail = toUrl(getFieldValue(fields, ['Cover', 'Image', '封面', '图片']));
    const categoryL1 = getFieldValue(fields, ['Category L1', '分类1', '一级分类']);
    const categoryL2 = getFieldValue(fields, ['Category L2', '分类2', '二级分类']);
    const sourceName = sanitizeTransportText(toText(getFieldValue(fields, ['Source', '来源']))) || '飞书收藏';
    const pubDate = toIsoDate(
        getFieldValue(fields, ['Published Date', '发布时间', 'Date', '发布于']),
        toIsoDate(record.created_time, new Date().toISOString())
    );

    return {
        title,
        link,
        pubDate,
        description,
        thumbnail: thumbnail || null,
        categories: [...normalizeCategories(categoryL1), ...normalizeCategories(categoryL2)],
        source: sourceName
    };
}

async function getFeishuToken() {
    if (feishuToken && Date.now() < feishuTokenExpiry) {
        return feishuToken;
    }

    if (!FEISHU_CONFIG.appId || !FEISHU_CONFIG.appSecret) {
        throw new Error('Feishu app credentials are not configured');
    }

    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            app_id: FEISHU_CONFIG.appId,
            app_secret: FEISHU_CONFIG.appSecret
        })
    });

    const data = await response.json();
    if (data.code !== 0 || !data.tenant_access_token) {
        throw new Error(`Feishu auth failed: ${data.msg || 'unknown error'}`);
    }

    feishuToken = data.tenant_access_token;
    feishuTokenExpiry = Date.now() + Math.max((data.expire || 7200) - 60, 60) * 1000;
    return feishuToken;
}

async function fetchFeishuArticles(source, limit = 20) {
    if (!FEISHU_CONFIG.baseId || !FEISHU_CONFIG.tableId) {
        throw new Error('Feishu base/table is not configured');
    }

    const token = await getFeishuToken();
    const requestLimit = getFeishuLimit(limit || 20);
    const pageSize = getFeishuLimit(100);
    const perSourceLimit = getFeishuLimit(process.env.FEISHU_PER_SOURCE_LIMIT || 20);
    const sourceFilters = parseFeishuSourceFilters();
    const maxScan = getFeishuMaxScan(2000);
    const allRecords = [];
    let scanned = 0;
    let pageToken = '';

    while (scanned < maxScan) {
        const params = new URLSearchParams({ page_size: String(pageSize) });
        if (pageToken) {
            params.set('page_token', pageToken);
        }
        const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${FEISHU_CONFIG.baseId}/tables/${FEISHU_CONFIG.tableId}/records?${params.toString()}`;

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();
        if (data.code !== 0 || !data.data || !Array.isArray(data.data.items)) {
            throw new Error(`Feishu API error: ${data.msg || 'invalid response'}`);
        }

        const items = data.data.items;
        if (items.length === 0) {
            break;
        }

        allRecords.push(...items);
        scanned += items.length;

        const hasMore = Boolean(data.data.has_more);
        const nextToken = data.data.page_token || '';
        if (!hasMore || !nextToken) {
            break;
        }
        pageToken = nextToken;
    }

    const normalized = allRecords
        .map((record) => normalizeFeishuRecord(record, source))
        .filter((item) => {
            if (sourceFilters.size === 0) return true;
            return sourceFilters.has(String(item.source || '').trim().toLowerCase());
        })
        .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    const perSourceCount = new Map();
    const seenKeys = new Set();
    const selected = [];

    for (const item of normalized) {
        const sourceName = String(item.source || '飞书收藏').trim() || '飞书收藏';
        const count = perSourceCount.get(sourceName) || 0;
        if (count >= perSourceLimit) {
            continue;
        }
        const key = `${String(item.link || '').trim().toLowerCase()}|${String(item.title || '').trim().toLowerCase()}`;
        if (seenKeys.has(key)) {
            continue;
        }
        seenKeys.add(key);
        perSourceCount.set(sourceName, count + 1);
        selected.push(item);
    }

    return {
        status: 'ok',
        feed: {
            title: source.name || '飞书收藏',
            link: source.url || '',
            description: '从飞书 Bitable 同步的文章（按 Source 分组限流）'
        },
        items: selected.slice(0, requestLimit)
    };
}

async function fetchSourceData(sourceId, source, options = {}) {
    const limit = getFeishuLimit(options.limit || 20);
    if (source.fetcher === 'feishu') {
        const cacheKey = `${sourceId}:limit=${limit}`;
        return getCachedOrFetch(
            cacheKey,
            async () => {
                try {
                    return await fetchFeishuArticles(source, limit);
                } catch (error) {
                    return { status: 'error', message: error.message, items: [] };
                }
            },
            null,
            source.sampleData
        );
    }

    return getCachedOrFetch(
        sourceId,
        () => fetchRSS(source.rssUrl, source.useAPI, source.alternativeUrls || []),
        () => fetchRSSViaAPI(source.rssUrl),
        source.sampleData
    );
}

function extractApiKey(req) {
    const headerKey = String(req.headers['x-api-key'] || '').trim();
    if (headerKey) return headerKey;

    const authHeader = String(req.headers.authorization || '').trim();
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }

    return String(req.query.api_key || '').trim();
}

function requireApiKey(req, res, next) {
    if (!API_KEY) {
        return next();
    }

    if (req.path === '/health') {
        return next();
    }

    const provided = extractApiKey(req);
    if (!provided || provided !== API_KEY) {
        return res.status(401).json({
            status: 'error',
            message: 'Unauthorized: invalid API key'
        });
    }

    return next();
}

app.use('/api', requireApiKey);

// API: Get single source
app.get('/api/feed/:source', async (req, res) => {
    const source = NEWS_SOURCES[req.params.source];
    if (!source) {
        return res.status(404).json({ error: 'Source not found' });
    }

    try {
        const data = await fetchSourceData(req.params.source, source, { limit: req.query.limit });
        res.json({
            source: {
                id: req.params.source,
                name: source.name,
                color: source.color,
                textColor: source.textColor || '#fff',
                logo: source.logo,
                category: source.category
            },
            ...data
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Get all sources
app.get('/api/feeds', async (req, res) => {
    try {
        const results = await Promise.all(
            Object.entries(NEWS_SOURCES).map(async ([id, source]) => {
                try {
                    const data = await fetchSourceData(id, source);
                    return {
                        source: {
                            id,
                            name: source.name,
                            color: source.color,
                            textColor: source.textColor || '#fff',
                            logo: source.logo,
                            category: source.category
                        },
                        ...data
                    };
                } catch (error) {
                    console.error(`Failed to fetch ${id}:`, error.message);
                    return {
                        source: {
                            id,
                            name: source.name,
                            color: source.color,
                            textColor: source.textColor || '#fff',
                            logo: source.logo,
                            category: source.category
                        },
                        status: 'error',
                        message: error.message,
                        items: []
                    };
                }
            })
        );
        res.json({ feeds: results, timestamp: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Get latest items from all sources combined
app.get('/api/latest', async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;

    try {
        const allItems = [];

        await Promise.all(
            Object.entries(NEWS_SOURCES).map(async ([id, source]) => {
                const data = await fetchSourceData(id, source);
                if (data.items) {
                    data.items.forEach(item => {
                        allItems.push({
                            ...item,
                            source: {
                                id,
                                name: source.name,
                                color: source.color,
                                textColor: source.textColor || '#fff',
                                logo: source.logo,
                                category: source.category
                            }
                        });
                    });
                }
            })
        );

        // Sort first to keep latest item in duplicates, then dedupe globally
        allItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
        const dedupedItems = dedupeCombinedItems(allItems);

        res.json({
            items: dedupedItems.slice(0, limit),
            total: dedupedItems.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: List available sources
app.get('/api/sources', (req, res) => {
    res.json({
        sources: Object.entries(NEWS_SOURCES).map(([id, source]) => ({
            id,
            name: source.name,
            color: source.color,
            endpoint: `/api/feed/${id}`
        }))
    });
});

// API: Clear cache
app.post('/api/cache/clear', (req, res) => {
    cache.clear();
    res.json({ message: 'Cache cleared', timestamp: new Date().toISOString() });
});

// API: Cache status
app.get('/api/cache/status', (req, res) => {
    const status = {};
    for (const [key, value] of cache.entries()) {
        status[key] = {
            cached: true,
            age: Math.round((Date.now() - value.timestamp) / 1000) + 's',
            expires: Math.round((CACHE_TTL - (Date.now() - value.timestamp)) / 1000) + 's'
        };
    }
    res.json({ cache: status, ttl: CACHE_TTL / 1000 + 's' });
});

const translationCache = new Map();

function buildTranslationCacheKey({ texts, to, from }) {
    return JSON.stringify({ texts, to: to || 'zh-Hans', from: from || '' });
}

function getTranslationCache(key) {
    const cached = translationCache.get(key);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > TRANSLATION_CACHE_TTL) {
        translationCache.delete(key);
        return null;
    }
    return cached.value;
}

function setTranslationCache(key, value) {
    translationCache.set(key, { value, timestamp: Date.now() });
}

function requestJson(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const requestOptions = {
            method: options.method || 'GET',
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: options.headers || {}
        };
        const req = https.request(requestOptions, (resp) => {
            let data = '';
            resp.on('data', (chunk) => {
                data += chunk;
            });
            resp.on('end', () => {
                const status = resp.statusCode || 0;
                if (!data) {
                    return resolve({ status, json: null, raw: '' });
                }
                try {
                    const json = JSON.parse(data);
                    resolve({ status, json, raw: data });
                } catch (error) {
                    resolve({ status, json: null, raw: data });
                }
            });
        });
        req.on('error', reject);
        if (body) {
            req.write(body);
        }
        req.end();
    });
}

// API: Daily brief JSON
app.get('/api/news-overview', async (req, res) => {
    try {
        await refreshNewsOverviewIfNeeded();
        if (!fs.existsSync(NEWS_OVERVIEW_FILE)) {
            return res.status(404).json({ error: 'news-overview.json not found' });
        }
        const raw = fs.readFileSync(NEWS_OVERVIEW_FILE, 'utf8');
        const data = JSON.parse(raw);
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API: Daily brief rendered HTML artifact
app.get('/api/news-overview-html', async (req, res) => {
    try {
        await refreshNewsOverviewIfNeeded();
        if (!fs.existsSync(NEWS_OVERVIEW_RENDER_HTML_FILE)) {
            await runNewsOverviewScript();
        }
        if (!fs.existsSync(NEWS_OVERVIEW_RENDER_HTML_FILE)) {
            return res.status(404).json({
                error: 'Rendered HTML not found. Ensure NEWS_OVERVIEW_RENDER_HTML=1 and run news-overview script.'
            });
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(fs.readFileSync(NEWS_OVERVIEW_RENDER_HTML_FILE, 'utf8'));
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// API: Daily brief rendered image artifact
app.get('/api/news-overview-image', async (req, res) => {
    try {
        await refreshNewsOverviewIfNeeded();
        const imageFile = getNewsOverviewRenderImageFile();
        if (!fs.existsSync(imageFile)) {
            await runNewsOverviewScript();
        }
        if (!fs.existsSync(imageFile)) {
            return res.status(404).json({
                error: 'Rendered image not found. Ensure NEWS_OVERVIEW_RENDER_IMAGE=1 and run news-overview script.'
            });
        }
        return res.sendFile(imageFile);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// API: Other (public news API) feed with caching
app.get('/api/other', async (req, res) => {
    const apiKey = process.env.THENEWSAPI_KEY;
    const baseUrl = process.env.THENEWSAPI_ENDPOINT || 'https://api.thenewsapi.com/v1/news/top';
    const language = process.env.THENEWSAPI_LANGUAGE || 'en';
    const limit = process.env.THENEWSAPI_LIMIT || '10';

    if (!apiKey) {
        return res.status(400).json({ error: 'THENEWSAPI_KEY not configured' });
    }

    const cacheKey = `${language}:${limit}:${process.env.THENEWSAPI_CATEGORIES || ''}`;
    const cached = otherCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < OTHER_CACHE_TTL) {
        return res.json(cached.data);
    }

    try {
        const params = new URLSearchParams({
            api_token: apiKey,
            language,
            limit
        });
        if (process.env.THENEWSAPI_CATEGORIES) {
            params.set('categories', process.env.THENEWSAPI_CATEGORIES);
        }
        const url = `${baseUrl}?${params.toString()}`;
        const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) {
            return res.status(500).json({ error: `Other API error: HTTP ${response.status}` });
        }
        const data = await response.json();
        const articles = data.data || data.articles || [];
        const items = articles.map((item) => ({
            title: item.title || 'No title',
            link: item.url || item.link || '',
            pubDate: item.published_at || item.published || item.date || new Date().toISOString(),
            categories: item.categories || (item.category ? [item.category] : [])
        }));
        const payload = { status: 'ok', items };
        otherCache.set(cacheKey, { data: payload, timestamp: Date.now() });
        res.json(payload);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Other API failed' });
    }
});

// API: Translate text via Azure Translator
app.post('/api/translate', async (req, res) => {
    const key = process.env.AZURE_TRANSLATOR_KEY;
    const region = process.env.AZURE_TRANSLATOR_REGION;
    const endpoint = process.env.AZURE_TRANSLATOR_ENDPOINT || 'https://api.cognitive.microsofttranslator.com';

    if (!key || !region) {
        return res.status(400).json({ error: 'Azure Translator not configured' });
    }

    const { texts, to, from } = req.body || {};
    if (!Array.isArray(texts) || texts.length === 0) {
        return res.status(400).json({ error: 'texts must be a non-empty array' });
    }

    const cacheKey = buildTranslationCacheKey({ texts, to, from });
    const cached = getTranslationCache(cacheKey);
    if (cached) {
        return res.json({ translations: cached, cached: true });
    }

    const params = new URLSearchParams({ 'api-version': '3.0', to: to || 'zh-Hans' });
    if (from) {
        params.set('from', from);
    }

    const url = `${endpoint.replace(/\/$/, '')}/translate?${params.toString()}`;
    const payload = JSON.stringify(texts.map((text) => ({ Text: text })));

    try {
        const response = await requestJson(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Ocp-Apim-Subscription-Key': key,
                'Ocp-Apim-Subscription-Region': region
            }
        }, payload);

        if (response.status < 200 || response.status >= 300) {
            return res.status(500).json({ error: response.raw || 'Translation failed' });
        }

        const translations = (response.json || []).map((item) => item?.translations?.[0]?.text || '');
        setTranslationCache(cacheKey, translations);
        res.json({ translations, cached: false });
    } catch (error) {
        res.status(500).json({ error: error.message || 'Translation failed' });
    }
});

// API: Trigger daily brief with optional channels override
app.post('/api/send-brief', (req, res) => {
    const nodeBin = process.env.NODE_BIN || process.execPath;
    const scriptPath = path.join(__dirname, 'scripts', 'news-overview.js');
    const rawChannels = (req.body && req.body.channels) || req.query.channels;
    const channels = rawChannels ? String(rawChannels).trim() : '';
    const args = [scriptPath];
    if (channels) {
        if (!/^[a-zA-Z0-9,;|\s_-]+$/.test(channels)) {
            return res.status(400).json({ error: 'Invalid channels format' });
        }
        args.push('--channels', channels);
    }
    execFile(nodeBin, args, { timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ error: error.message, stderr: stderr?.toString?.() || '' });
        }
        res.json({ status: 'ok', channels: channels || 'default', output: stdout?.toString?.() || '' });
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        auth: API_KEY ? 'api-key-enabled' : 'disabled',
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`RSS Proxy Server running on http://localhost:${PORT}`);
    console.log(`API key auth: ${API_KEY ? 'enabled' : 'disabled'}`);
    console.log(`\nAvailable endpoints:`);
    console.log(`  GET  /api/sources      - List all available sources`);
    console.log(`  GET  /api/feeds        - Get all feeds`);
    console.log(`  GET  /api/feed/:source - Get specific source feed`);
    console.log(`  GET  /api/latest       - Get latest items from all sources`);
    console.log(`  GET  /api/news-overview-html  - Get rendered overview HTML`);
    console.log(`  GET  /api/news-overview-image - Get rendered overview image`);
    console.log(`  GET  /api/cache/status - View cache status`);
    console.log(`  POST /api/cache/clear  - Clear cache`);
});
