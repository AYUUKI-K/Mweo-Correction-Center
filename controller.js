import { KEY, DEFAULTS, newState, normalizeFeedback, revisionOf, eligible, activeFeedback, pendingFeedback, buildInjection, analysisInput, parseResult, checkpoint } from './core.js';
import { callAnalyzer } from './api.js';

export function createController({ getContext, notify = () => {}, changed = () => {}, analyzer = callAnalyzer }) {
    let busy = false, task = null, generationActive = false, sessionKey = '';
    const context = () => getContext();
    function supported(ctx) { return !ctx.groupId && ctx.characterId != null && ctx.characters?.[ctx.characterId] && (ctx.chatId || ctx.getCurrentChatId?.()); }
    function settings() { const ctx = context(); return ctx.extensionSettings[KEY] ??= { ...DEFAULTS }; }
    function state(ctx = context()) { return ctx.chatMetadata[KEY] ??= newState(); }
    function key(ctx) { return `${ctx.characters?.[ctx.characterId]?.avatar ?? ctx.characterId}\0${ctx.chatId ?? ctx.getCurrentChatId?.() ?? ''}`; }
    function inject() {
        const ctx = context();
        const text = settings().enabled && supported(ctx) ? buildInjection(ctx.chat, state(ctx)) : '';
        ctx.setExtensionPrompt(KEY, text, 1, Number(settings().depth) || 0, false, 0);
        return text;
    }
    function refresh() {
        const ctx = context(), nextKey = key(ctx);
        if (sessionKey !== nextKey) { cancel(); sessionKey = nextKey; }
        inject(); changed();
    }
    function cancel() { if (task) { task.cancelled = true; task.abort.abort(); } }
    function ensureWritable(ctx) {
        if (!supported(ctx)) throw new Error('请先打开一个角色的单人聊天存档。');
        if (busy) throw new Error('分析或保存正在进行，请等待完成，或取消本次应用。');
        if (generationActive || ctx.streamingProcessor?.isStopped === false) throw new Error('请等待当前回复生成完成。');
        if (typeof ctx.saveChat !== 'function') throw new Error('酒馆缺少聊天保存接口，请更新酒馆。');
    }
    async function transact(change, success) {
        const ctx = context(); ensureWritable(ctx);
        const previous = structuredClone(state(ctx));
        busy = true;
        let rollback;
        try {
            rollback = change(ctx, state(ctx));
            changed();
            state(ctx).epoch++;
            const result = await ctx.saveChat();
            if (result === false) throw new Error('聊天存档保存失败，请检查酒馆连接后重试。');
            notify(success);
        } catch (error) {
            ctx.chatMetadata[KEY] = previous;
            rollback?.();
            throw error;
        } finally { busy = false; refresh(); }
    }
    async function saveFeedback(index, input) {
        const value = normalizeFeedback(input);
        await transact((ctx) => {
            const message = ctx.chat[index];
            if (!eligible(message)) throw new Error('这个楼层不是有效的角色回复。');
            const oldExtra = structuredClone(message.extra ?? {});
            message.extra ??= {};
            const store = message.extra[KEY] ??= { versions: {} };
            store.versions[revisionOf(message)] = value;
            return () => { message.extra = oldExtra; };
        }, '反馈已保存到当前存档。');
        if (settings().enabled && settings().autoAnalyze && pendingFeedback(context().chat, state()).length >= settings().threshold) scheduleAuto();
    }
    async function removeFeedback(index) {
        await transact(ctx => {
            const message = ctx.chat[index];
            if (!message) throw new Error('楼层已不存在。');
            const old = structuredClone(message.extra ?? {});
            if (message.extra?.[KEY]?.versions) delete message.extra[KEY].versions[revisionOf(message)];
            return () => { message.extra = old; };
        }, '当前回复版本的反馈已移除，相关补充不再注入。');
    }
    async function analyze({ apiKey = '', automatic = false } = {}) {
        const ctx = context(); ensureWritable(ctx);
        if (!settings().enabled) throw new Error('请先启用相处手记。');
        const originState = state(ctx), epoch = originState.epoch;
        const input = analysisInput(ctx, originState, settings());
        const originChat = ctx.chat, originMetadata = ctx.chatMetadata, originKey = key(ctx);
        const pendingIds = input.pending.map(f => f.id);
        const run = { abort: new AbortController(), cancelled: false };
        busy = true; task = run; changed();
        notify(automatic ? '正在分析累计反馈…' : '正在分析反馈与相关上下文…');
        const timer = setTimeout(() => { run.cancelled = true; run.abort.abort(); notify('分析等待超过两分钟，结果将不再应用。请检查 API；反馈已保留。', true); }, 120000);
        try {
            const raw = await analyzer(ctx, { ...DEFAULTS, ...settings() }, input.prompt, { apiKey, signal: run.abort.signal });
            const current = context();
            const activeIds = new Set(activeFeedback(current.chat).map(f => f.id));
            if (run.cancelled || key(current) !== originKey || current.chat !== originChat || current.chatMetadata !== originMetadata || state(current) !== originState || originState.epoch !== epoch || input.evidence.some(f => !activeIds.has(f.id))) {
                notify('聊天或反馈已变化，本次结果未应用。反馈已保留，可以重新分析。'); return;
            }
            const result = parseResult(raw, input.evidence);
            const previous = structuredClone(originState);
            checkpoint(originState);
            const confirmed = originState.profile.filter(item => item.manual);
            const excluded = new Set([...(originState.dismissed ?? []), ...confirmed.map(item => `${item.category}\0${item.text}`)]);
            originState.profile = [...confirmed, ...result.items.filter(item => !excluded.has(`${item.category}\0${item.text}`)).slice(0, Math.max(0, 18 - confirmed.length))];
            originState.consumed = [...new Set([...originState.consumed, ...pendingIds])].filter(id => activeIds.has(id));
            originState.summary = result.summary;
            originState.analyzedAt = new Date().toISOString(); originState.epoch++;
            try {
                if (await ctx.saveChat() === false) throw new Error('聊天存档保存失败。');
            } catch (error) { Object.assign(originState, previous); throw error; }
            notify('分析完成：可靠偏好已应用，待确认推测保留为候选。');
        } finally { clearTimeout(timer); if (task === run) task = null; busy = false; refresh(); }
    }
    async function editItem(id, text, enabled) {
        const trimmed = String(text).trim();
        if (!trimmed || trimmed.length > 500) throw new Error('每条补充请填写 1～500 字。');
        await transact((ctx, data) => {
            const item = data.profile.find(item => item.id === id);
            if (!item) throw new Error('补充已发生变化，请重新打开。');
            checkpoint(data);
            Object.assign(item, { text: trimmed, enabled: Boolean(enabled), manual: true, confidence: 'manual' });
        }, '补充已保存为用户确认的偏好。');
    }
    async function deleteItem(id) {
        await transact((ctx, data) => {
            const item = data.profile.find(item => item.id === id);
            if (!item) throw new Error('补充已不存在。');
            checkpoint(data);
            data.dismissed = [...new Set([...(data.dismissed ?? []), `${item.category}\0${item.text}`])].slice(-100);
            data.profile = data.profile.filter(item => item.id !== id);
        }, '补充已删除，可以撤销。');
    }
    async function undo() {
        if (!state().history.length) throw new Error('还没有可撤销的偏好更新。');
        await transact((ctx, data) => { Object.assign(data, data.history.pop()); }, '已撤销上一次偏好更新。');
    }
    async function setChatEnabled(value) { await transact((ctx, data) => { data.enabled = Boolean(value); }, value ? '当前存档补充已开启。' : '当前存档补充已暂停。'); }
    async function clearProfile() {
        await transact((ctx, data) => { checkpoint(data); data.profile = []; data.consumed = []; data.dismissed = []; data.summary = ''; data.analyzedAt = ''; }, '偏好补充已清空，评分保留，可以撤销。');
    }
    function scheduleAuto() {
        // Never await a generation inside an awaited host event callback.
        const expectedKey = key(context());
        setTimeout(() => {
            const ctx = context();
            if (expectedKey !== key(ctx) || busy || generationActive || !settings().enabled || !settings().autoAnalyze || !supported(ctx) || pendingFeedback(ctx.chat, state()).length < settings().threshold) return;
            analyze({ automatic: true }).catch(error => notify(error.message, true));
        }, 0);
    }
    function generationStarted() { generationActive = true; cancel(); inject(); }
    function generationEnded() { generationActive = false; refresh(); scheduleAuto(); }
    return { context, settings, state, supported, inject, refresh, saveFeedback, removeFeedback, analyze, editItem, deleteItem, undo, clearProfile, setChatEnabled, cancel, scheduleAuto, generationStarted, generationEnded, get busy() { return busy; } };
}
