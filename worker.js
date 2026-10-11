export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        // 1. 路由：获取字幕列表 (/api/subs?kw=...)
        if (pathname === '/api/subs') {
            const keyword = url.searchParams.get('kw') || url.searchParams.get('wd');
            if (!keyword) {
                return Response.json({ error: "缺少 kw 或 wd 参数" }, { status: 400 });
            }
            return await handleGetSubs(keyword, request);
        }

        // 2. 路由：伪静态字幕下载接口 (例如: /api/sub/IPX-243/简体中文.srt)
        if (pathname.startsWith('/api/sub/')) {
            const targetUrl = url.searchParams.get('url');
            if (!targetUrl) {
                return new Response("缺少目标地址", { status: 400 });
            }
            const fullUrl = `https://www.subtitlecat.com${targetUrl}`;
            return await handleDownloadSub(fullUrl);
        }

        return new Response("Not Found", { status: 404 });
    }
};

/**
 * 处理搜索与实时抓取字幕列表（无 KV 缓存，每次直连目标站）
 */
async function handleGetSubs(keyword, request) {
    try {
        const searchUrl = `https://www.subtitlecat.com/index.php?search=${encodeURIComponent(keyword)}`;
        const res = await fetch(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!res.ok) throw new Error(`HTTP 错误: ${res.status}`);
        const html = await res.text();

        const subtitles = parseSubtitlesFromHtml(html);
        const targetSubtitles = subtitles.slice(0, 3);
        
        const hostHeader = request.headers.get('host');
        const proto = request.headers.get('x-forwarded-proto') || 'https';
        const serverHost = `${proto}://${hostHeader}`;

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
                    const cleanKeyword = keyword.replace(/[^a-zA-Z0-9-_]/g, '_');
                    const prettyPath = `/api/sub/${cleanKeyword}/zh-CN.srt?url=${zhCnUrl}`;

                    subsArray.push({
                        url: `${serverHost}${prettyPath}`,
                        name: `简体中文 (${keyword})`,
                        lang: "zh-CN",
                        format: "text/srt",
                        flag: 0
                    });
                }
            } catch (err) {}
        }

        return Response.json({ subs: subsArray });

    } catch (error) {
        return Response.json({ subs: [], error: error.message }, { status: 500 });
    }
}

/**
 * 实时代理下载 .srt 文件
 */
async function handleDownloadSub(targetUrl) {
    try {
        const res = await fetch(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
        const srtContent = await res.text();

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