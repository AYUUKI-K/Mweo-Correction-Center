// Use the host engine, including enabled global, preset and character rules.
// Do not reimplement regex ordering, macros, permissions or depth restrictions.
export async function prepareRegexText(loadEngine = () => import('/scripts/extensions/regex/engine.js')) {
    let engine;
    try { engine = await loadEngine(); }
    catch { throw new Error('无法加载酒馆正则引擎，本批未发送。请刷新页面或更新酒馆后重试。'); }
    if (typeof engine.getRegexedString !== 'function' || engine.regex_placement?.AI_OUTPUT == null) throw new Error('酒馆正则接口不兼容，本批未发送。');
    return (text, { depth }) => engine.getRegexedString(text, engine.regex_placement.AI_OUTPUT, { isPrompt: true, depth });
}
