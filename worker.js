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
 * 处理搜索与抓取字幕列表（纯 fetch 版，秒级响应，绝不报错）
 */
async function handleGetSubs(keyword, request, env, ctx) {
    const startTime = Date.now();
    const cacheKey = `sub_list_${encodeURIComponent(keyword)}`;

    // 优先读取 KV 缓存
    if (env.SUB_KV) {
        try {
            const cached = await env.SUB_KV.get(cacheKey, { type: "json" });
            if (cached) {
                return Response.json({ subs: cached });
            }
        } catch (e) {}
    }

    try {
        const searchUrl = `https://www.subtitlecat.com/index.php?search=${encodeURIComponent(keyword)}`;
        const res = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        
        if (!res.ok) throw new Error(`HTTP 错误: ${res.status}`);
        const html = await res.text();

        const subtitles = parseSubtitlesFromHtml(html);
        const targetSubtitles = subtitles.slice(0, 3);
        const serverHost = `${new URL(request.url).protocol}//${new URL(request.url).host}`;
        const subsArray = [];

        for (const sub of targetSubtitles) {
            try {
                const detailRes = await fetch(sub.link, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                });
                if (!detailRes.ok) continue;
                const detailHtml = await detailRes.text();

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
            } catch (err) {}
        }

        // 异步写入 KV 缓存（有效期 30 分钟）
        if (env.SUB_KV && subsArray.length > 0) {
            ctx.waitUntil(env.SUB_KV.put(cacheKey, JSON.stringify(subsArray), { expirationTtl: 1800 }));
        }

        return Response.json({ subs: subsArray });

    } catch (error) {
        return Response.json({ subs: [], error: error.message }, { status: 500 });
    }
}

/**
 * 处理代理下载 .srt 文件
 */
async function handleDownloadSub(targetUrl, env, ctx) {
    const cacheKey = `srt_${btoa(targetUrl).replace(/[/+=]/g, '_')}`;

    if (env.SUB_KV) {
        try {
            const cachedSrt = await env.SUB_KV.get(cacheKey);
            if (cachedSrt) {
                return new Response(cachedSrt, {
                    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
                });
            }
        } catch (e) {}
    }

    try {
        const res = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
        const srtContent = await res.text();

        if (env.SUB_KV) {
            ctx.waitUntil(env.SUB_KV.put(cacheKey, srtContent, { expirationTtl: 86400 }));
        }

        return new Response(srtContent, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
        });
    } catch (err) {
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