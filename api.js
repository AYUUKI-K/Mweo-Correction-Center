import { SYSTEM_PROMPT } from './core.js';

export function completionUrl(endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('请填写完整的 API 地址，例如 https://example.com/v1。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址须为 HTTP(S) 地址，不含账号、查询参数或片段。');
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
    return url.href;
}

export async function callAnalyzer(context, settings, prompt, { signal, apiKey = '', fetchImpl = fetch } = {}) {
    if (settings.apiMode === 'main') {
        if (typeof context.generateRaw !== 'function') throw new Error('当前酒馆缺少 generateRaw 接口，请更新酒馆或使用独立 API。');
        // Raw generation receives ONLY our explicit input; no chat reply or card is written.
        // ST 1.12.x exposes six positional parameters; newer hosts use an options object.
        if (context.generateRaw.length >= 2) return await context.generateRaw(prompt, null, false, false, SYSTEM_PROMPT, null);
        return await context.generateRaw({ prompt, systemPrompt: SYSTEM_PROMPT, trimNames: false });
    }
    if (!settings.model.trim()) throw new Error('请填写独立 API 的模型名称。');
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;
    let response;
    try {
        response = await fetchImpl(completionUrl(settings.endpoint), {
            method: 'POST', headers, signal, credentials: 'omit',
            body: JSON.stringify({ model: settings.model.trim(), stream: false, temperature: 0.3, max_tokens: 2200,
                messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: prompt }] }),
        });
    } catch (error) {
        if (signal?.aborted) throw new Error('分析已取消或超时，反馈已保留。');
        throw new Error('独立 API 连接失败，请检查地址及浏览器跨域（CORS）支持，或改用酒馆当前 API。');
    }
    if (!response.ok) throw new Error(`API 返回 HTTP ${response.status}，请检查密钥、模型和服务状态。`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('API 返回了空内容，未应用任何补充。');
    return content;
}
