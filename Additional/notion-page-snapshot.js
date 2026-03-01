const fs = require('fs');
const path = require('path');
const https = require('https');
const { chromium } = require('playwright');

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

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

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            continue;
        }
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args[token.slice(2)] = true;
            continue;
        }
        args[token.slice(2)] = next;
        i += 1;
    }
    return args;
}

function notionRequest(pathname, token) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.notion.com',
            path: pathname,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${token}`,
                'Notion-Version': process.env.NOTION_API_VERSION || '2022-06-28',
                Accept: 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                raw += chunk;
            });
            res.on('end', () => {
                let json;
                try {
                    json = raw ? JSON.parse(raw) : {};
                } catch (error) {
                    reject(new Error(`Invalid JSON response (${res.statusCode}): ${raw.slice(0, 300)}`));
                    return;
                }

                if ((res.statusCode || 500) < 200 || (res.statusCode || 500) >= 300) {
                    const message = json && json.message ? json.message : raw.slice(0, 300);
                    reject(new Error(`Notion API error (${res.statusCode}): ${message}`));
                    return;
                }

                resolve(json);
            });
        });

        req.on('error', reject);
        req.end();
    });
}

async function fetchBlockChildren(blockId, token) {
    let hasMore = true;
    let cursor = undefined;
    const results = [];

    while (hasMore) {
        const qs = new URLSearchParams({ page_size: '100' });
        if (cursor) {
            qs.set('start_cursor', cursor);
        }
        const pathname = `/v1/blocks/${blockId}/children?${qs.toString()}`;
        const response = await notionRequest(pathname, token);
        const pageResults = Array.isArray(response.results) ? response.results : [];
        results.push(...pageResults);
        hasMore = Boolean(response.has_more);
        cursor = response.next_cursor || undefined;
    }

    for (const block of results) {
        if (block.has_children) {
            block.children = await fetchBlockChildren(block.id, token);
        }
    }

    return results;
}

function escapeHtml(input) {
    return String(input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function richTextToHtml(richText) {
    if (!Array.isArray(richText) || richText.length === 0) {
        return '';
    }
    return richText
        .map((item) => {
            const annotations = item.annotations || {};
            let text = '';
            if (item.type === 'text') {
                text = escapeHtml(item.text?.content || '');
                const href = item.href || item.text?.link?.url;
                if (href) {
                    text = `<a href="${escapeHtml(href)}">${text}</a>`;
                }
            } else if (item.type === 'equation') {
                text = `<code>${escapeHtml(item.equation?.expression || '')}</code>`;
            } else if (item.type === 'mention') {
                text = escapeHtml(item.plain_text || '');
            } else {
                text = escapeHtml(item.plain_text || '');
            }

            if (annotations.code) text = `<code>${text}</code>`;
            if (annotations.bold) text = `<strong>${text}</strong>`;
            if (annotations.italic) text = `<em>${text}</em>`;
            if (annotations.strikethrough) text = `<s>${text}</s>`;
            if (annotations.underline) text = `<u>${text}</u>`;

            return text;
        })
        .join('');
}

function blockText(block, fieldName = 'rich_text') {
    const typeData = block[block.type] || {};
    const value = typeData[fieldName] || [];
    return richTextToHtml(value);
}

function renderBlock(block) {
    const type = block.type;

    if (type === 'paragraph') {
        const text = blockText(block);
        return `<p>${text || '&nbsp;'}</p>`;
    }

    if (type === 'heading_1') {
        return `<h1>${blockText(block)}</h1>`;
    }

    if (type === 'heading_2') {
        return `<h2>${blockText(block)}</h2>`;
    }

    if (type === 'heading_3') {
        return `<h3>${blockText(block)}</h3>`;
    }

    if (type === 'bulleted_list_item') {
        return `<ul><li>${blockText(block)}${renderChildren(block.children || [], type)}</li></ul>`;
    }

    if (type === 'numbered_list_item') {
        return `<ol><li>${blockText(block)}${renderChildren(block.children || [], type)}</li></ol>`;
    }

    if (type === 'to_do') {
        const checked = Boolean(block.to_do?.checked);
        return `<p><input type="checkbox" ${checked ? 'checked' : ''} disabled /> ${blockText(block)}</p>`;
    }

    if (type === 'quote') {
        return `<blockquote>${blockText(block)}${renderChildren(block.children || [])}</blockquote>`;
    }

    if (type === 'callout') {
        const emoji = block.callout?.icon?.emoji || '💡';
        return `<div class="callout">${escapeHtml(emoji)} ${blockText(block)}${renderChildren(block.children || [])}</div>`;
    }

    if (type === 'code') {
        const language = block.code?.language || 'plain text';
        const code = blockText(block);
        return `<pre><code data-lang="${escapeHtml(language)}">${code}</code></pre>`;
    }

    if (type === 'divider') {
        return '<hr />';
    }

    if (type === 'image') {
        const image = block.image || {};
        const url = image.type === 'external' ? image.external?.url : image.file?.url;
        const caption = richTextToHtml(image.caption || []);
        if (!url) {
            return '<p class="muted">[image unavailable]</p>';
        }
        return `<figure><img src="${escapeHtml(url)}" alt="Notion image" /><figcaption>${caption}</figcaption></figure>`;
    }

    if (type === 'bookmark') {
        const url = block.bookmark?.url || '';
        return `<p>🔖 <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`;
    }

    if (type === 'unsupported') {
        return '<p class="muted">[unsupported block]</p>';
    }

    const genericText = blockText(block);
    if (genericText) {
        return `<p>${genericText}</p>`;
    }

    return `<p class="muted">[${escapeHtml(type)} block]</p>`;
}

function renderChildren(children) {
    if (!Array.isArray(children) || children.length === 0) {
        return '';
    }
    return children.map((block) => renderBlock(block)).join('\n');
}

function renderHtmlDocument(title, blocks, options) {
    const content = renderChildren(blocks);
    const width = Number(options.width) > 0 ? Number(options.width) : 1080;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --text: #111827;
      --muted: #6b7280;
      --bg: #ffffff;
      --border: #e5e7eb;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
    body {
      width: ${width}px;
      margin: 0 auto;
      padding: 48px 56px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      line-height: 1.65;
      font-size: 20px;
      word-break: break-word;
    }
    h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 0.4em; }
    h1 { font-size: 42px; }
    h2 { font-size: 34px; }
    h3 { font-size: 28px; }
    p, ul, ol, blockquote, pre, figure { margin: 0.6em 0; }
    ul, ol { padding-left: 1.3em; }
    blockquote {
      margin-left: 0;
      padding: 0.7em 1em;
      border-left: 4px solid var(--border);
      background: #f9fafb;
    }
    pre {
      overflow-x: auto;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #f8fafc;
      font-size: 16px;
      line-height: 1.5;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 0.92em;
    }
    hr {
      border: none;
      border-top: 1px solid var(--border);
      margin: 1.4em 0;
    }
    a { color: #2563eb; text-decoration: none; }
    img {
      max-width: 100%;
      border-radius: 12px;
      border: 1px solid var(--border);
      display: block;
    }
    figcaption {
      color: var(--muted);
      font-size: 0.85em;
      margin-top: 0.3em;
    }
    .callout {
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 0.8em 0.9em;
      background: #f8fafc;
    }
    .muted { color: var(--muted); }
    .meta {
      margin-bottom: 28px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
    }
    .meta h1 { margin: 0; font-size: 40px; }
    .meta p { margin: 8px 0 0; color: var(--muted); font-size: 16px; }
  </style>
</head>
<body>
  <header class="meta">
    <h1>${escapeHtml(title)}</h1>
    <p>Generated at ${escapeHtml(new Date().toISOString())}</p>
  </header>
  <main>
    ${content}
  </main>
</body>
</html>`;
}

function sanitizeName(input) {
    return String(input || '')
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^[_-]+|[_-]+$/g, '')
        .slice(0, 120);
}

function timestampCompact(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate()),
        '_',
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds())
    ].join('');
}

function buildOutputName(options) {
    const ext = options.format === 'jpg' || options.format === 'jpeg' ? 'jpg' : 'png';
    const title = sanitizeName(options.pageTitle || options.pageId || 'notion');
    const pageIdShort = sanitizeName((options.pageId || '').replace(/-/g, '').slice(0, 8) || 'page');
    const stamp = timestampCompact();

    const pattern = process.env.NOTION_SNAPSHOT_PATTERN || '{title}_{page}_{ts}';
    const baseName = pattern
        .replace('{title}', title || 'notion')
        .replace('{page}', pageIdShort)
        .replace('{ts}', stamp);

    return `${sanitizeName(baseName) || `notion_${stamp}`}.${ext}`;
}

async function saveSnapshot(html, outputFile, options) {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({
            viewport: {
                width: Number(options.width) > 0 ? Number(options.width) : 1080,
                height: 1000
            },
            deviceScaleFactor: Number(options.scale) > 0 ? Number(options.scale) : 2
        });

        await page.setContent(html, { waitUntil: 'networkidle' });
        await page.screenshot({
            path: outputFile,
            fullPage: true,
            type: options.format === 'jpg' || options.format === 'jpeg' ? 'jpeg' : 'png',
            quality: options.format === 'jpg' || options.format === 'jpeg'
                ? (Number(options.quality) > 0 ? Number(options.quality) : 88)
                : undefined
        });
    } finally {
        await browser.close();
    }
}

async function main() {
    loadEnv();
    const args = parseArgs(process.argv.slice(2));

    const notionToken = requireEnv('NOTION_TOKEN');
    const pageId = args.page || process.env.NOTION_PAGE_ID;
    if (!pageId) {
        throw new Error('Missing Notion page id. Use --page <id> or set NOTION_PAGE_ID in root .env');
    }

    const outputDir = args.output || process.env.NOTION_SNAPSHOT_OUTPUT || path.join(ROOT_DIR, 'Additional', 'output');
    const format = String(args.format || process.env.NOTION_SNAPSHOT_FORMAT || 'png').toLowerCase();
    const width = Number(args.width || process.env.NOTION_SNAPSHOT_WIDTH || 1080);
    const scale = Number(args.scale || process.env.NOTION_SNAPSHOT_SCALE || 2);

    fs.mkdirSync(outputDir, { recursive: true });

    const pageInfo = await notionRequest(`/v1/pages/${pageId}`, notionToken);
    const pageTitle = pageInfo.properties && Object.values(pageInfo.properties)
        .find((prop) => prop && prop.type === 'title')?.title;
    const title = richTextToHtml(pageTitle || [])
        .replace(/<[^>]*>/g, '')
        .trim() || `Notion Page ${pageId}`;

    const blocks = await fetchBlockChildren(pageId, notionToken);
    const html = renderHtmlDocument(title, blocks, { width });

    const outputName = buildOutputName({
        format,
        pageTitle: title,
        pageId
    });
    const imagePath = path.join(outputDir, outputName);
    const htmlPath = imagePath.replace(/\.(png|jpg)$/i, '.html');

    fs.writeFileSync(htmlPath, html, 'utf8');
    await saveSnapshot(html, imagePath, { format, width, scale, quality: args.quality });

    console.log(`Saved image: ${imagePath}`);
    console.log(`Saved html: ${htmlPath}`);
}

main().catch((error) => {
    console.error(`[notion-page-snapshot] ${error.message}`);
    process.exit(1);
});
