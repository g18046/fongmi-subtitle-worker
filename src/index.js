import puppeteer from "@cloudflare/puppeteer";

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // 1. 路由：获取字幕列表
        if (pathname === '/api/subs') {
            const keyword = url.searchParams.get('kw') || url.searchParams.get('wd');
            if (!keyword) {
                return Response.json({ error: "缺少 kw 或 wd 参数" }, { status: 400 });
            }
            return await handleGetSubs(keyword, request, env, ctx);
        }

        // 2. 路由：代理下载并返回 SRT 字幕文本
        if (pathname === '/api/download-sub') {
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
                return new Response("缺少 targetUrl", { status: 400 });
            }
            return await handleDownloadSub(targetUrl, env, ctx);
        }

        return new Response("Not Found", { status: 404 });
    }
};

/**
 * 处理搜索与抓取字幕列表
 */
async function handleGetSubs(keyword, request, env, ctx) {
    const startTime = Date.now();
    const cacheKey = `sub_list_${encodeURIComponent(keyword)}`;

    // 优先读取 KV 缓存
    if (env.SUB_KV) {
        try {
            const cached = await env.SUB_KV.get(cacheKey, { type: "json" });
            if (cached) {
                console.log(`[KV 缓存命中] 关键词: "${keyword}" | 耗时: ${Date.now() - startTime}ms`);
                return Response.json({ subs: cached });
            }
        } catch (e) {
            console.error('[KV 读取失败]', e);
        }
    }

    console.log(`[开始抓取] 关键词: "${keyword}"`);
    const browser = await puppeteer.launch(env.MYBROWSER);
    
    try {
        const page = await browser.newPage();
        const searchUrl = `https://www.subtitlecat.com/index.php?search=${encodeURIComponent(keyword)}`;

        await page.goto(searchUrl, { waitUntil: 'load', timeout: 30000 });
        const searchHtml = await page.content();
        await page.close();

        const subtitles = parseSubtitlesFromHtml(searchHtml);
        const targetSubtitles = subtitles.slice(0, 3);
        const serverHost = `${new URL(request.url).protocol}//${new URL(request.url).host}`;
        const subsArray = [];

        for (const sub of targetSubtitles) {
            const detailPage = await browser.newPage();
            try {
                await detailPage.goto(sub.link, { waitUntil: 'load', timeout: 15000 });
                const detailHtml = await detailPage.content();
                await detailPage.close();

                const zhCnUrl = extractZhCnDownloadLink(detailHtml);
                if (zhCnUrl) {
                    const originalSubtitleUrl = `https://www.subtitlecat.com${zhCnUrl}`;
                    subsArray.push({
                        url: `${serverHost}/api/download-sub?url=${encodeURIComponent(originalSubtitleUrl)}`,
                        name: `简体中文`,
                        lang: "zh-CN",
                        format: "text/srt",
                        flag: 0
                    });
                }
            } catch (err) {
                await detailPage.close().catch(() => {});
            }
        }

        await browser.close();

        // 异步写入 KV 缓存（有效期 30 分钟 = 1800 秒）
        if (env.SUB_KV && subsArray.length > 0) {
            ctx.waitUntil(env.SUB_KV.put(cacheKey, JSON.stringify(subsArray), { expirationTtl: 1800 }));
        }

        console.log(`[抓取成功] 关键词: "${keyword}" | 有效字幕: ${subsArray.length} 条 | 耗时: ${Date.now() - startTime}ms`);
        return Response.json({ subs: subsArray });

    } catch (error) {
        await browser.close().catch(() => {});
        console.error(`[抓取异常]`, error.message);
        return Response.json({ subs: [] });
    }
}

/**
 * 处理代理下载 .srt 文件
 */
async function handleDownloadSub(targetUrl, env, ctx) {
    const cacheKey = `srt_${btoa(targetUrl).replace(/[/+=]/g, '_')}`;

    // 优先读取 KV 中缓存的 SRT 文本
    if (env.SUB_KV) {
        try {
            const cachedSrt = await env.SUB_KV.get(cacheKey);
            if (cachedSrt) {
                console.log(`[SRT KV缓存命中]`);
                return new Response(cachedSrt, {
                    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
                });
            }
        } catch (e) {
            console.error('[SRT KV 读取失败]', e);
        }
    }

    console.log(`[代理下载字幕] 目标地址: ${targetUrl}`);
    const browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();

    try {
        await page.goto('https://www.subtitlecat.com/', { waitUntil: 'domcontentloaded', timeout: 10000 });
        const srtContent = await page.evaluate(async (url) => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP 错误! 状态码: ${res.status}`);
            return await res.text();
        }, targetUrl);

        await page.close();
        await browser.close();

        // 异步将 SRT 文本写入 KV（缓存 1 天 = 86400 秒）
        if (env.SUB_KV) {
            ctx.waitUntil(env.SUB_KV.put(cacheKey, srtContent, { expirationTtl: 86400 }));
        }

        return new Response(srtContent, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });

    } catch (err) {
        await browser.close().catch(() => {});
        return new Response("字幕下载失败: " + err.message, { status: 500 });
    }
}

/**
 * 正则解析搜索列表
 */
function parseSubtitlesFromHtml(html) {
    const subtitles = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
        const row = match[1];
        const linkMatch = row.match(/<td[^>]*>\s*<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
        if (linkMatch) {
            subtitles.push({
                link: `https://www.subtitlecat.com/${linkMatch[1]}`,
                title: linkMatch[2].trim()
            });
        }
    }
    return subtitles;
}

/**
 * 正则提取中文下载链接
 */
function extractZhCnDownloadLink(html) {
    const singleRegex = /<div[^>]*class="sub-single"[^>]*>([\s\S]*?)<\/div>/g;
    let match;
    while ((match = singleRegex.exec(html)) !== null) {
        const block = match[1];
        if (block.includes('alt="zh-CN"') || block.includes("alt='zh-CN'")) {
            const dlMatch = block.match(/href="([^"]+)"[^>]*class="green-link"/i);
            if (dlMatch) {
                return dlMatch[1];
            }
        }
    }
    return null;
}