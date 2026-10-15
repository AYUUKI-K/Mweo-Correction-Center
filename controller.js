import { KEY, DEFAULTS, newState, normalizeFeedback, revisionOf, eligible, activeFeedback, pendingFeedback, buildInjection, analysisInput, parseResult, checkpoint, uid, CATEGORIES, usableItems, feedbackKey, sameFeedback, migrateState, AnalysisValidationError, profileEvolution } from './core.js';
import { callAnalyzer } from './api.js';
import { DEBUG_ENABLED } from './debug-config.js';

export function createController({ getContext, isGenerating, notify = () => {}, changed = () => {}, analyzer = callAnalyzer, prepareText }) {
    let busy = false, task = null, generationActive = false, sessionKey = '', disposed = false;
    const attempts = new WeakMap();
    const debugHistory = new WeakMap();
    const context = () => getContext();
    function supported(ctx) { return !ctx.groupId && ctx.characterId != null && ctx.characters?.[ctx.characterId] && (ctx.chatId || ctx.getCurrentChatId?.()); }
    function settings() { const ctx = context(); return ctx.extensionSettings[KEY] ??= { ...DEFAULTS }; }
    function state(ctx = context()) { return migrateState(ctx.chat, ctx.chatMetadata[KEY] ??= newState()); }
    function key(ctx) { return `${ctx.characters?.[ctx.characterId]?.avatar ?? ctx.characterId}\0${ctx.chatId ?? ctx.getCurrentChatId?.() ?? ''}`; }
    function inject() {
        const ctx = context();
        const text = !disposed && settings().enabled && supported(ctx) ? buildInjection(ctx.chat, state(ctx)) : '';
        ctx.setExtensionPrompt(KEY, text, 1, Number(settings().depth) || 0, false, 0);
        return text;
    }
    function refresh() {
        if (disposed) return;
        const ctx = context(), nextKey = key(ctx);
        if (sessionKey !== nextKey) { cancel(); sessionKey = nextKey; }
        inject(); changed();
    }
    function cancel() { if (task) { task.cancelled = true; task.abort.abort(); } }
    function dispose() { cancel(); disposed = true; inject(); }
    function generationIsActive(ctx = context()) {
        // Live host flags override event latches left by aborted/preflight generations.
        const live = typeof ctx.isGenerating === 'function' ? ctx.isGenerating() : isGenerating?.(ctx);
        if (typeof live === 'boolean') return live;
        const stream = ctx.streamingProcessor;
        // isStopped means user cancellation, NOT normal completion.
        if (stream?.isFinished === true || stream?.isStopped === true) return false;
        if (stream?.isStopped === false && stream?.isFinished === false) return true;
        return generationActive;
    }
    function ensureWritable(ctx) {
        if (disposed) throw new Error('喵喵修正中心已停用。');
        if (!supported(ctx)) throw new Error('请先打开一个角色的单人聊天存档。');
        if (busy) throw new Error('分析或保存正在进行，请等待完成，或取消本次应用。');
        if (generationIsActive(ctx)) throw new Error('请等待当前回复生成完成。');
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
        const before = context(); ensureWritable(before); state(before);
        const messageBefore = before.chat[index];
        const oldFeedback = messageBefore?.extra?.[KEY]?.versions?.[revisionOf(messageBefore)];
        if (sameFeedback(oldFeedback, value)) { notify('评价内容没有变化，无需重复保存或分析。'); return; }
        await transact((ctx) => {
            const message = ctx.chat[index];
            if (!eligible(message)) throw new Error('这个楼层不是有效的角色回复。');
            const oldExtra = structuredClone(message.extra ?? {});
            message.extra ??= {};
            const store = message.extra[KEY] ??= { versions: {} };
            const revision = revisionOf(message);
            store.ids ??= {};
            value.id = oldFeedback?.id ?? store.ids[revision] ?? value.id;
            store.ids[revision] = value.id;
            value.version = (oldFeedback?.version ?? 0) + 1;
            store.versions[revisionOf(message)] = value;
            return () => { message.extra = oldExtra; };
        }, '反馈已保存到当前存档。');
        if (settings().enabled && settings().autoAnalyze && pendingFeedback(context().chat, state(), settings()).length >= settings().threshold) scheduleAuto();
    }
    async function removeFeedback(index) {
        await transact(ctx => {
            const message = ctx.chat[index];
            if (!message) throw new Error('楼层已不存在。');
            const old = structuredClone(message.extra ?? {});
            const store = message.extra?.[KEY], revision = revisionOf(message);
            if (store?.versions?.[revision]) {
                store.ids ??= {}; store.ids[revision] = store.versions[revision].id;
                delete store.versions[revision];
            }
            return () => { message.extra = old; };
        }, '当前回复版本的反馈已移除，相关补充不再注入。');
    }
    async function analyze({ apiKey = '', automatic = false, feedbackIds } = {}) {
        const ctx = context(); ensureWritable(ctx);
        if (!settings().enabled) throw new Error('请先启用喵喵修正中心。');
        const originState = state(ctx), epoch = originState.epoch;
        let input = analysisInput(ctx, originState, settings(), { automatic, feedbackIds, deferTextProcessing: Boolean(prepareText) });
        const originChat = ctx.chat, originMetadata = ctx.chatMetadata, originKey = key(ctx);
        const pendingKeys = input.pending.map(feedbackKey);
        const run = { abort: new AbortController(), cancelled: false };
        const attempt = { status: 'running', batchSize: input.pending.length, repairAttempts: 0, requestCount: 0, error: '', startedAt: new Date().toISOString(), requests: [] };
        attempts.set(originMetadata, attempt);
        if (DEBUG_ENABLED) debugHistory.set(originMetadata, [...(debugHistory.get(originMetadata) ?? []), attempt].slice(-10));
        busy = true; task = run; changed();
        notify(automatic ? '正在分析累计反馈…' : '正在分析反馈与相关上下文…');
        let didApply = false;
        const originUnchanged = () => {
            const current = context();
            if (run.cancelled || key(current) !== originKey || current.chat !== originChat || current.chatMetadata !== originMetadata || state(current) !== originState || originState.epoch !== epoch) return false;
            const activeKeys = new Set(activeFeedback(current.chat).map(feedbackKey));
            return input.evidence.every(f => activeKeys.has(feedbackKey(f)));
        };
        const ask = async (prompt, label) => {
            attempt.requestCount++;
            const entry = DEBUG_ENABLED ? { label, prompt, response: '', error: '', validationError: '' } : null;
            if (entry) { attempt.requests.push(entry); changed(); }
            try {
                const raw = await analyzer(ctx, { ...DEFAULTS, ...settings() }, prompt, { apiKey, signal: run.abort.signal });
                if (entry) entry.response = String(raw);
                return raw;
            } catch (error) { if (entry) entry.error = error.message; throw error; }
        };
        const timer = setTimeout(() => { run.cancelled = true; run.abort.abort(); notify('分析等待超过两分钟，结果将不再应用。请检查 API；反馈已保留。', true); }, 120000);
        try {
            if (prepareText) {
                const transformText = await prepareText();
                if (!originUnchanged()) { attempt.status = 'cancelled'; return; }
                input = analysisInput(ctx, originState, settings(), { automatic, feedbackIds, transformText });
            }
            let raw = await ask(input.prompt, '首次分析');
            if (!originUnchanged()) {
                attempt.status = 'cancelled'; notify('聊天或反馈已变化，本次结果未应用。反馈已保留，可以重新分析。'); return;
            }
            let result;
            try { result = parseResult(raw, input.evidence, { previousItems: input.previousItems }); }
            catch (error) {
                if (!(error instanceof AnalysisValidationError)) throw error;
                if (DEBUG_ENABLED) attempt.requests.at(-1).validationError = error.message;
                attempt.repairAttempts = 1;
                notify('自动分析已触发，返回未通过校验，正在自动修复一次格式或来源引用…');
                const repairPrompt = JSON.stringify({ ...JSON.parse(input.prompt), responseRepair: { error: error.message, invalidResponse: String(raw).slice(0, 16000), instruction: '精确复制有效 ID，返回三类说明和完整新版 items；仅修复输出结构及引用，不发明证据。' } });
                raw = await ask(repairPrompt, '自动格式修复');
                if (!originUnchanged()) { attempt.status = 'cancelled'; notify('聊天或反馈已变化，格式修复结果未应用。评价已保留。'); return; }
                result = parseResult(raw, input.evidence, { previousItems: input.previousItems });
            }
            const previous = structuredClone(originState);
            checkpoint(originState);
            const excluded = new Set(originState.dismissed ?? []);
            // B replaces A atomically, including entries the user edited. Omitted
            // entries are deleted; never append protected old entries to B.
            const updatedAt = new Date().toISOString();
            const evolution = profileEvolution(result.items.filter(item => !excluded.has(`${item.category}\0${item.text}`)), originState.profile, updatedAt, originState.analyzedAt);
            originState.profile = evolution.items;
            originState.consumed = [...new Set([...originState.consumed, ...pendingKeys])];
            originState.summary = result.summary;
            originState.categoryReports = result.categoryReports;
            originState.analyzedAt = updatedAt; originState.epoch++;
            originState.lastAnalysis = { summary: result.summary, categoryReports: result.categoryReports, items: structuredClone(originState.profile), analyzedAt: originState.analyzedAt, newFeedbackKeys: pendingKeys,
                changes: evolution.changes };
            try {
                if (await ctx.saveChat() === false) throw new Error('聊天存档保存失败。');
            } catch (error) { Object.assign(originState, previous); throw error; }
            didApply = true;
            attempt.status = 'applied';
            const applied = originState.enabled ? usableItems(ctx.chat, originState).length : 0;
            notify(`自动修正完成：${applied} 条补充已生效${attempt.repairAttempts ? '（已自动修复返回格式）' : ''}，后续评价会继续修订。`);
        } catch (error) {
            attempt.status = run.cancelled ? 'cancelled' : 'failed'; attempt.error = error.message;
            if (DEBUG_ENABLED && error instanceof AnalysisValidationError && attempt.requests.length) attempt.requests.at(-1).validationError = error.message;
            throw new Error(`${attempt.requestCount ? '自动分析已触发，但本批未应用' : '分析准备失败，本批未发送'}：${error.message} 旧修正及 ${input.pending.length} 条评价已保留。`);
        } finally { clearTimeout(timer); if (task === run) task = null; busy = false; refresh(); if ((didApply && automatic) || key(context()) !== originKey) scheduleAuto(); }
    }
    async function editItem(id, text, enabled) {
        const trimmed = String(text).trim();
        if (!trimmed || trimmed.length > 500) throw new Error('每条补充请填写 1～500 字。');
        await transact((ctx, data) => {
            const item = data.profile.find(item => item.id === id);
            if (!item) throw new Error('补充已发生变化，请重新打开。');
            checkpoint(data);
            Object.assign(item, { text: trimmed, enabled: Boolean(enabled), manual: true, confidence: 'manual', changeKind: 'manual', updatedAt: new Date().toISOString() });
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
    async function addItem(category, text) {
        const trimmed = String(text).trim();
        if (!Object.hasOwn(CATEGORIES, category) || !trimmed || trimmed.length > 500) throw new Error('请填写 1～500 字的偏好补充。');
        await transact((ctx, data) => {
            if (data.profile.length >= 18) throw new Error('当前补充已达 18 条，请先删除不需要的补充。');
            checkpoint(data);
            data.profile.push({ id: uid(), category, text: trimmed, enabled: true, manual: true, confidence: 'manual', sourceIds: [], changeKind: 'manual', updatedAt: new Date().toISOString() });
        }, '手动偏好已保存到当前存档。');
    }
    async function undo() {
        if (!state().history.length) throw new Error('还没有可撤销的偏好更新。');
        await transact((ctx, data) => {
            const processed = data.consumed;
            Object.assign(data, data.history.pop());
            data.consumed = [...new Set([...processed, ...data.consumed])];
        }, '已撤销上一次偏好更新，已处理的评价不会重复分析。');
    }
    async function setChatEnabled(value) { await transact((ctx, data) => { data.enabled = Boolean(value); }, value ? '当前存档补充已开启。' : '当前存档补充已暂停。'); }
    async function clearProfile() {
        await transact((ctx, data) => { checkpoint(data); data.profile = []; data.dismissed = []; data.summary = ''; data.analyzedAt = ''; data.lastAnalysis = null; data.categoryReports = {}; }, '偏好补充已清空，已处理评价不会重复分析，可以撤销。');
    }
    function scheduleAuto() {
        // Never await a generation inside an awaited host event callback.
        const expectedKey = key(context());
        setTimeout(() => {
            const ctx = context();
            if (disposed || expectedKey !== key(ctx) || busy || generationIsActive(ctx) || !settings().enabled || !settings().autoAnalyze || !supported(ctx) || pendingFeedback(ctx.chat, state(), settings()).length < settings().threshold) return;
            analyze({ automatic: true }).catch(error => notify(error.message, true));
        }, 0);
    }
    function generationStarted(type, options, dryRun = false) {
        if (dryRun) return;
        generationActive = true; cancel(); inject();
    }
    function generationEnded() { generationActive = false; refresh(); scheduleAuto(); }
    function clearDebug() {
        if (busy) throw new Error('分析完成后可清空调试记录。');
        const metadata = context().chatMetadata;
        debugHistory.delete(metadata);
        const latest = attempts.get(metadata);
        if (latest) latest.requests = [];
        changed();
    }
    return { context, settings, state, supported, inject, refresh, saveFeedback, removeFeedback, analyze, editItem, deleteItem, addItem, undo, clearProfile, setChatEnabled, cancel, dispose, scheduleAuto, generationStarted, generationEnded, clearDebug, get busy() { return busy; }, get analysisAttempt() { return attempts.get(context().chatMetadata) ?? null; }, get analysisDebug() { return DEBUG_ENABLED ? debugHistory.get(context().chatMetadata) ?? [] : []; } };
}
