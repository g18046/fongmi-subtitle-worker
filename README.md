# FongMi Subtitle Worker

这是一个专为 **FongMi TV**（及其他支持自定义字幕接口的播放器）设计的轻量级、高性能 Cloudflare Worker。它通过直接请求与正则解析 `subtitlecat.com` 网站，为媒体播放器提供稳定、极速的字幕搜索与下载代理 API。

相比于传统的无头浏览器（Puppeteer）方案，该版本采用纯 `fetch` 与轻量级正则匹配，**无需配置复杂的云端浏览器绑定，运行速度极快，且彻底根除了 Cloudflare Worker 常见的一系列运行时异常（如 Error 1101）**。

---

## 🌟 核心特性

1. **纯 `fetch` 与正则解析**：无需依赖 Cloudflare Browser Rendering，轻量、高效，毫秒级响应。
2. **KV 智能缓存**：支持绑定 Cloudflare KV（`SUB_KV`），对搜索结果和 `.srt` 字幕内容进行缓存，减少对目标源站的请求压力，实现秒开。
3. **完美适配 FongMi TV**：输出标准的字幕 API 数据结构，开箱即用。

---

## 🔌 API 接口说明

### 1. 获取字幕列表
* **请求路径**：`/api/subs?kw=<关键词>` 或 `/api/subs?wd=<关键词>`
* **请求方法**：`GET`
* **功能描述**：根据输入的关键词在 `subtitlecat.com` 中进行搜索，过滤并提取出简体中文（`zh-CN`）字幕的下载代理链接。
* **请求示例**：
  ```text
  https://your-worker.workers.dev/api/subs?kw=ipx-596
  ```
* **返回示例**：
  ```json
  {
    "subs": [
      {
        "url": "https://your-worker.workers.dev/api/download-sub?url=...",
        "name": "简体中文",
        "lang": "zh-CN",
        "format": "text/srt",
        "flag": 0
      }
    ]
  }
  ```

### 2. 下载代理字幕文件
* **请求路径**：`/api/download-sub?url=<目标字幕直链>`
* **请求方法**：`GET`
* **功能描述**：代理下载上游的 `.srt` 字幕文本内容，支持 KV 缓存，并返回给播放器。

---

## 🚀 部署与配置指南

1. **创建 Worker**：
   * 登录 Cloudflare 控制台，进入 **Workers & Pages**，创建一个新的 JavaScript Worker。
   * 将你的 `worker.js` 代码完整粘贴进去。

2. **绑定 KV 缓存（可选但推荐）**：
   * 在 Cloudflare 中创建一个 KV 命名空间（命名如 `SUB_KV`）。
   * 进入你的 Worker 设置 -> **变量与密钥 (Variables)** -> **KV 命名空间绑定**。
   * 变量名填写：`SUB_KV`，并关联你刚才创建的 KV 命名空间。

3. **保存并发布**：
   * 点击右上角的 **保存并部署 (Save and Deploy)**，你的专属字幕后端即搭建完成！