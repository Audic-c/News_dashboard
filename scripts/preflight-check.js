const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');

const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

function loadEnv() {
    if (!fs.existsSync(ENV_PATH)) {
        return;
    }
    const content = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}

function mask(value, left = 4, right = 3) {
    const text = String(value || '');
    if (!text) return 'empty';
    if (text.length <= left + right) return `${text.slice(0, 1)}***`;
    return `${text.slice(0, left)}***${text.slice(-right)}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const req = https.request({
            method,
            hostname: parsed.hostname,
            path: parsed.pathname + parsed.search,
            headers,
            timeout
        }, (resp) => {
            let data = '';
            resp.on('data', (chunk) => {
                data += chunk;
            });
            resp.on('end', () => {
                const status = resp.statusCode || 0;
                let json = null;
                try {
                    json = data ? JSON.parse(data) : null;
                } catch (error) {
                    json = null;
                }
                resolve({ status, json, raw: data });
            });
        });
        req.on('timeout', () => req.destroy(new Error('Request timeout')));
        req.on('error', reject);
        if (body) {
            req.write(body);
        }
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
            const resp = await requestJson(url, { timeout: 8000 });
            if (resp.status >= 200 && resp.status < 300 && resp.json) {
                const ip = resp.json.ip || resp.json.ip_addr;
                if (ip) return ip;
            }
        } catch (error) {
            continue;
        }
    }
    return '';
}

async function checkPort() {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        return {
            name: '端口',
            ok: false,
            detail: `PORT 无效: ${process.env.PORT || ''}`
        };
    }

    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', (error) => {
            if (error && error.code === 'EADDRINUSE') {
                resolve({
                    name: '端口',
                    ok: true,
                    detail: `端口 ${port} 已被占用（通常是 API 服务正在运行，视为正常）`
                });
                return;
            }
            resolve({
                name: '端口',
                ok: false,
                detail: `端口 ${port} 不可用: ${error.code || error.message}`
            });
        });
        server.listen(port, '0.0.0.0', () => {
            server.close(() => {
                resolve({
                    name: '端口',
                    ok: true,
                    detail: `端口 ${port} 可监听（仍需在 ECS 安全组/防火墙放行）`
                });
            });
        });
    });
}

function extractImageUrlFromTask(taskJson) {
    const output = taskJson?.output || {};
    const choices = output.choices || [];
    for (const choice of choices) {
        const content = choice?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
            if (item && typeof item === 'object' && typeof item.image === 'string' && item.image) {
                return item.image;
            }
        }
    }
    return '';
}

async function checkBailian() {
    const apiKey = (process.env.BAILIAN_API_KEY || process.env.DASHSCOPE_API_KEY || '').trim();
    const textEndpoint = process.env.BAILIAN_TEXT_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    const textModel = process.env.NEWS_OVERVIEW_SUMMARY_MODEL || process.env.BAILIAN_TEXT_MODEL || 'glm-5';
    const imageModel = process.env.BAILIAN_IMAGE_MODEL || 'wan2.6-image';
    const isQwenImagePlus = /^qwen-image-plus/i.test(imageModel);
    const imageEndpoint = isQwenImagePlus
        ? (process.env.BAILIAN_MM_IMAGE_ENDPOINT || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
        : (process.env.BAILIAN_IMAGE_ENDPOINT || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation');
    const imageSize = String(process.env.WECHAT_COVER_IMAGE_SIZE || '1280*1280').replace('x', '*');

    if (!apiKey) {
        return {
            name: '百炼',
            ok: false,
            detail: '缺少 BAILIAN_API_KEY / DASHSCOPE_API_KEY'
        };
    }

    const textPayload = JSON.stringify({
        model: textModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16
    });
    const textResp = await requestJson(textEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`
        },
        body: textPayload
    });
    const textOk = textResp.status >= 200 && textResp.status < 300 && Array.isArray(textResp.json?.choices);
    if (!textOk) {
        return {
            name: '百炼',
            ok: false,
            detail: `文本模型失败(${textModel}) HTTP ${textResp.status} ${String(textResp.raw || '').slice(0, 160)}`
        };
    }

    if (isQwenImagePlus) {
        const mmPayload = JSON.stringify({
            model: imageModel,
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [{ text: 'A clean blue gradient cover image, no text' }]
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
        const mmResp = await requestJson(imageEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
            },
            body: mmPayload
        });
        if (!(mmResp.status >= 200 && mmResp.status < 300)) {
            return {
                name: '百炼',
                ok: false,
                detail: `生图提交失败(${imageModel}) HTTP ${mmResp.status} ${String(mmResp.raw || '').slice(0, 160)}`
            };
        }
        const imageUrl = extractImageUrlFromTask(mmResp.json || {});
        if (!imageUrl) {
            return {
                name: '百炼',
                ok: false,
                detail: `生图响应成功但未返回图片URL (${imageModel})`
            };
        }
    } else {
        const imagePayload = JSON.stringify({
            model: imageModel,
            input: {
                messages: [
                    {
                        role: 'user',
                        content: [{ text: 'A clean blue gradient cover image, no text' }]
                    }
                ]
            },
            parameters: {
                n: 1,
                size: imageSize,
                enable_interleave: true
            }
        });
        const imageSubmit = await requestJson(imageEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
                'X-DashScope-Async': 'enable'
            },
            body: imagePayload
        });
        if (!(imageSubmit.status >= 200 && imageSubmit.status < 300)) {
            return {
                name: '百炼',
                ok: false,
                detail: `生图提交失败(${imageModel}) HTTP ${imageSubmit.status} ${String(imageSubmit.raw || '').slice(0, 160)}`
            };
        }

        const taskId = imageSubmit.json?.output?.task_id || imageSubmit.json?.task_id;
        if (!taskId) {
            return {
                name: '百炼',
                ok: false,
                detail: `生图提交成功但无 task_id (${imageModel})`
            };
        }

        const pollUrl = `https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`;
        let status = '';
        let hasImageUrl = false;
        for (let i = 0; i < 8; i += 1) {
            await sleep(1500);
            const pollResp = await requestJson(pollUrl, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${apiKey}`
                }
            });
            if (!(pollResp.status >= 200 && pollResp.status < 300)) {
                return {
                    name: '百炼',
                    ok: false,
                    detail: `生图轮询失败 HTTP ${pollResp.status} ${String(pollResp.raw || '').slice(0, 160)}`
                };
            }
            status = String(pollResp.json?.output?.task_status || '').toUpperCase();
            const imageUrl = extractImageUrlFromTask(pollResp.json || {});
            if (imageUrl) {
                hasImageUrl = true;
                break;
            }
            if (status === 'FAILED' || status === 'CANCELED') {
                break;
            }
        }

        if (status === 'FAILED' || status === 'CANCELED') {
            return {
                name: '百炼',
                ok: false,
                detail: `生图任务状态异常: ${status}`
            };
        }

        if (!hasImageUrl && status === 'SUCCEEDED') {
            return {
                name: '百炼',
                ok: true,
                detail: `文本(${textModel})连通成功，生图(${imageModel})任务已成功但图片URL返回延迟（task_id=${taskId}）`
            };
        }

        if (!hasImageUrl) {
            return {
                name: '百炼',
                ok: false,
                detail: `生图任务(${taskId})未在预检窗口返回图片URL，可稍后复测`
            };
        }
    }

    return {
        name: '百炼',
        ok: true,
        detail: `文本(${textModel}) + 生图(${imageModel})连通成功, key=${mask(apiKey)}`
    };
}

async function checkWechat(egressIp) {
    const skipWechat = String(process.env.PREFLIGHT_SKIP_WECHAT || '').trim() === '1';
    if (skipWechat) {
        return {
            name: '微信',
            ok: true,
            detail: '已跳过（PREFLIGHT_SKIP_WECHAT=1）'
        };
    }

    const appId = String(process.env.WECHAT_OFFICIAL_ACCOUNT_APP_ID || '').trim();
    const appSecret = String(process.env.WECHAT_OFFICIAL_ACCOUNT_APP_SECRET || '').trim();
    if (!appId || !appSecret) {
        return {
            name: '微信',
            ok: false,
            detail: '缺少 WECHAT_OFFICIAL_ACCOUNT_APP_ID / WECHAT_OFFICIAL_ACCOUNT_APP_SECRET'
        };
    }

    const params = new URLSearchParams({
        grant_type: 'client_credential',
        appid: appId,
        secret: appSecret
    });
    const url = `https://api.weixin.qq.com/cgi-bin/token?${params.toString()}`;
    const resp = await requestJson(url, { method: 'GET' });
    const body = resp.json || {};

    if (resp.status >= 200 && resp.status < 300 && body.access_token) {
        return {
            name: '微信',
            ok: true,
            detail: `凭证可用, expires_in=${body.expires_in || '-'}s`
        };
    }

    const errcode = body.errcode;
    const errmsg = body.errmsg || body.message || String(resp.raw || '').slice(0, 120);
    if (errcode === 40164) {
        return {
            name: '微信',
            ok: false,
            detail: `IP 白名单拦截(40164). egress_ip=${egressIp || 'unknown'}, errmsg=${errmsg}`
        };
    }
    if (errcode === 40125) {
        return {
            name: '微信',
            ok: false,
            detail: `AppSecret 无效/不匹配(40125). errmsg=${errmsg}`
        };
    }

    return {
        name: '微信',
        ok: false,
        detail: `token 请求失败 HTTP ${resp.status}, errcode=${errcode}, errmsg=${errmsg}`
    };
}

async function getFeishuTenantToken({ appId, appSecret }) {
    const resp = await requestJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            app_id: appId,
            app_secret: appSecret.replace(/\s+/g, '')
        })
    });
    const body = resp.json || {};
    if (resp.status < 200 || resp.status >= 300 || body.code !== 0 || !body.tenant_access_token) {
        return {
            ok: false,
            detail: `飞书鉴权失败 HTTP ${resp.status}, code=${body.code}, msg=${body.msg || String(resp.raw || '').slice(0, 120)}`
        };
    }
    return {
        ok: true,
        token: body.tenant_access_token
    };
}

async function checkFeishu() {
    const appId = String(process.env.FEISHU_APP_ID || '').trim();
    const appSecret = String(process.env.FEISHU_APP_SECRET || '').trim();
    const baseId = String(process.env.FEISHU_BASE_ID || '').trim();
    const tableId = String(process.env.FEISHU_TABLE_ID || '').trim();

    if (!appId || !appSecret || !baseId || !tableId) {
        return {
            name: '飞书',
            ok: false,
            detail: '缺少 FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BASE_ID / FEISHU_TABLE_ID'
        };
    }

    const tokenResp = await getFeishuTenantToken({ appId, appSecret });
    if (!tokenResp.ok) {
        return {
            name: '飞书',
            ok: false,
            detail: tokenResp.detail
        };
    }

    const recordsUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(baseId)}/tables/${encodeURIComponent(tableId)}/records?page_size=1`;
    const listResp = await requestJson(recordsUrl, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${tokenResp.token}`,
            'Content-Type': 'application/json'
        }
    });
    const body = listResp.json || {};
    if (listResp.status < 200 || listResp.status >= 300 || body.code !== 0) {
        return {
            name: '飞书',
            ok: false,
            detail: `Bitable 读表失败 HTTP ${listResp.status}, code=${body.code}, msg=${body.msg || String(listResp.raw || '').slice(0, 120)}`
        };
    }

    const count = Array.isArray(body.data?.items) ? body.data.items.length : 0;
    return {
        name: '飞书',
        ok: true,
        detail: `鉴权+读表成功（示例读取 ${count} 条）`
    };
}

async function main() {
    loadEnv();
    console.log('=== Cloud Preflight Check ===');

    const egressIp = await detectEgressIp();
    console.log(`egress_ip=${egressIp || 'unknown'}`);

    const results = [];
    results.push(await checkPort());
    results.push(await checkBailian());
    results.push(await checkWechat(egressIp));
    results.push(await checkFeishu());

    let failed = 0;
    for (const result of results) {
        const icon = result.ok ? '✅' : '❌';
        console.log(`${icon} ${result.name}: ${result.detail}`);
        if (!result.ok) failed += 1;
    }

    if (failed > 0) {
        console.error(`\nPreflight failed: ${failed} check(s) failed.`);
        process.exitCode = 1;
        return;
    }

    console.log('\nPreflight passed: all checks are ready for cloud startup.');
    process.exitCode = 0;
}

main().catch((error) => {
    console.error(`Preflight crashed: ${error.message}`);
    process.exitCode = 1;
});
