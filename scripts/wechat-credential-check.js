const fs = require('fs');
const path = require('path');
const https = require('https');

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

function mask(text, left = 4, right = 3) {
    const value = String(text || '');
    if (value.length <= left + right) {
        return `${value.slice(0, 1)}***`;
    }
    return `${value.slice(0, left)}***${value.slice(-right)}`;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            method: 'GET',
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'news-dashboard/wechat-credential-check'
            },
            timeout: 10000
        }, (resp) => {
            let data = '';
            resp.on('data', (chunk) => {
                data += chunk;
            });
            resp.on('end', () => {
                const status = resp.statusCode || 0;
                try {
                    resolve({ status, json: JSON.parse(data || '{}'), raw: data });
                } catch (error) {
                    resolve({ status, json: null, raw: data });
                }
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('Request timeout'));
        });
        req.on('error', reject);
        req.end();
    });
}

async function detectEgressIp() {
    const providers = [
        'https://api.ipify.org?format=json',
        'https://ifconfig.me/all.json',
        'https://ipinfo.io/json'
    ];
    for (const url of providers) {
        try {
            const resp = await requestJson(url);
            if (resp.status >= 200 && resp.status < 300 && resp.json) {
                const ip = resp.json.ip || resp.json.ip_addr;
                if (ip) {
                    return ip;
                }
            }
        } catch (error) {
            continue;
        }
    }
    return '';
}

async function main() {
    loadEnv();

    const appId = String(process.env.WECHAT_OFFICIAL_ACCOUNT_APP_ID || '').trim();
    const appSecret = String(process.env.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET || '').trim();

    console.log('[wechat-check] Starting credential self-check (no publish)...');
    console.log(`[wechat-check] APP_ID=${mask(appId)} APP_SECRET=${mask(appSecret)}`);

    if (!appId || !appSecret) {
        console.error('[wechat-check] Missing WECHAT_OFFICIAL_ACCOUNT_APP_ID or WECHAT_OFFICIAL_ACCOUNT_APP_SECRET in env');
        process.exitCode = 2;
        return;
    }

    const egressIp = await detectEgressIp();
    if (egressIp) {
        console.log(`[wechat-check] Detected egress IP: ${egressIp}`);
    } else {
        console.log('[wechat-check] Egress IP detection skipped/failed');
    }

    const params = new URLSearchParams({
        grant_type: 'client_credential',
        appid: appId,
        secret: appSecret
    });
    const tokenUrl = `https://api.weixin.qq.com/cgi-bin/token?${params.toString()}`;

    const resp = await requestJson(tokenUrl);
    const body = resp.json || {};

    if (resp.status >= 200 && resp.status < 300 && body.access_token) {
        console.log('[wechat-check] ✅ Token request succeeded');
        console.log(`[wechat-check] expires_in=${body.expires_in || '-'} seconds`);
        process.exitCode = 0;
        return;
    }

    const errcode = body.errcode;
    const errmsg = body.errmsg || body.message || resp.raw || 'unknown error';
    console.error(`[wechat-check] ❌ Token request failed: HTTP ${resp.status}, errcode=${errcode}, errmsg=${errmsg}`);

    if (errcode === 40164) {
        console.error('[wechat-check] Hint: This is usually IP whitelist rejection. Add current server egress IP to WeChat platform whitelist.');
        if (egressIp) {
            console.error(`[wechat-check] Whitelist candidate IP: ${egressIp}`);
        }
    } else if (errcode === 40125) {
        console.error('[wechat-check] Hint: appsecret mismatch/invalid for this appid, or wrong公众号应用类型。请核对 AppID 与 AppSecret 是否同一账号下配对。');
    }

    process.exitCode = 1;
}

main().catch((error) => {
    console.error(`[wechat-check] Unexpected error: ${error.message}`);
    process.exitCode = 1;
});
