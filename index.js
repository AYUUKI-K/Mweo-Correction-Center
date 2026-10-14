import { KEY, DEFAULTS, CATEGORIES, activeFeedback, pendingFeedback, currentFeedback, revisionOf, eligible, usableItems } from './core.js';
import { createController } from './controller.js';
import { callAnalyzer } from './api.js';

let controller, panel, status, profileList, stats, preview, sessionApiKey = '', observer;
const feedbackDrafts = new WeakMap();
const floorBindings = new WeakMap();
const itemDrafts = new Map();
const subscriptions = [];
let renderTimer;
let fieldCounter = 0;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function button(text, action, primary = false) {
    const node = el('button', `menu_button rpp-button${primary ? ' rpp-primary' : ''}`, text);
    node.type = 'button'; node.addEventListener('click', () => perform(action));
    return node;
}
async function perform(action) {
    try { await action(); } catch (error) { announce(error?.message || '操作失败，请检查连接后重试。', true); }
}
function announce(text, error = false) {
    if (status) { status.textContent = text; status.classList.toggle('rpp-error', error); }
}
function field(labelText, input) {
    const wrapper = el('div', 'rpp-field');
    input.id ||= `rpp-field-${++fieldCounter}`;
    const label = el('label', '', labelText); label.htmlFor = input.id;
    wrapper.append(label, input); return wrapper;
}
function checkbox(labelText, checked, onChange) {
    const node = el('input'); node.type = 'checkbox'; node.checked = checked;
    node.addEventListener('change', () => onChange(node.checked));
    const label = el('label', 'rpp-check'); label.append(node, document.createTextNode(labelText)); return label;
}
function select(options, value) {
    const node = el('select', 'text_pole');
    for (const [key, text] of options) { const option = el('option', '', text); option.value = key; node.append(option); }
    node.value = value ?? ''; return node;
}
function saveSetting(key, value) {
    controller.cancel(); controller.settings()[key] = value;
    controller.context().saveSettingsDebounced(); controller.refresh();
}
function settingInput(label, key, type = 'text', min, max) {
    const input = el('input', 'text_pole'); input.type = type; input.value = controller.settings()[key];
    if (min !== undefined) { input.min = min; input.max = max; input.step = 1; }
    input.addEventListener('change', () => {
        const value = type === 'number' ? Number(input.value) : input.value.trim();
        if (type === 'number' && (!Number.isInteger(value) || value < min || value > max)) {
            input.value = controller.settings()[key]; announce(`${label}须为 ${min}～${max} 的整数。`, true); return;
        }
        saveSetting(key, value);
    });
    return field(label, input);
}

function mountPanel() {
    const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
    if (!target) return false;
    panel = el('section', 'rpp-panel'); panel.id = 'rpp-panel';
    const drawer = el('details', 'rpp-drawer');
    drawer.append(el('summary', 'rpp-title', '相处手记 · RP 偏好'));
    const body = el('div', 'rpp-body');
    body.append(el('p', 'rpp-help', '评分与补充仅属于当前存档。原角色卡保持不变。'));
    body.append(checkbox('启用插件与楼层反馈', controller.settings().enabled, value => saveSetting('enabled', value)));
    const chatSwitch = checkbox('应用当前存档的偏好补充', true, value => perform(() => controller.setChatEnabled(value)));
    chatSwitch.querySelector('input').id = 'rpp-chat-enabled'; body.append(chatSwitch);
    stats = el('p', 'rpp-stats'); stats.setAttribute('aria-live', 'polite'); stats.setAttribute('aria-atomic', 'true'); body.append(stats);
    const actions = el('div', 'rpp-actions');
    const analyze = button('分析并应用', () => controller.analyze({ apiKey: sessionApiKey }), true); analyze.dataset.mutation = 'true';
    const cancel = button('取消本次应用', () => { controller.cancel(); announce('已取消本次应用。酒馆当前 API 请求可能仍需等待结束。'); }); cancel.id = 'rpp-cancel';
    actions.append(analyze, cancel); body.append(actions);
    status = el('p', 'rpp-status', '在角色回复下展开“反馈”，保存评分或调整说明。'); status.setAttribute('role', 'status'); body.append(status);
    const profileDetails = el('details', 'rpp-section'); profileDetails.open = true;
    profileDetails.append(el('summary', '', '当前存档的偏好补充'));
    profileList = el('div', 'rpp-profile-list'); profileDetails.append(profileList);
    const historyActions = el('div', 'rpp-actions');
    for (const [label, action] of [['撤销上次更新', () => controller.undo()], ['清空补充', () => controller.clearProfile()]]) {
        const control = button(label, action); control.dataset.mutation = 'true'; historyActions.append(control);
    }
    profileDetails.append(historyActions); body.append(profileDetails);
    const injectionDetails = el('details', 'rpp-section'); injectionDetails.append(el('summary', '', '查看实际注入的提示词'));
    preview = el('textarea', 'text_pole rpp-preview'); preview.readOnly = true; preview.rows = 7; preview.setAttribute('aria-label', '当前实际注入的提示词'); injectionDetails.append(preview); body.append(injectionDetails);
    const config = el('details', 'rpp-section'); config.append(el('summary', '', '分析与 API 设置'));
    config.append(checkbox('累计反馈后自动分析', controller.settings().autoAnalyze, value => saveSetting('autoAnalyze', value)));
    config.append(settingInput('自动分析：累计反馈条数', 'threshold', 'number', 1, 20));
    config.append(settingInput('分析：最近上下文楼层数', 'contextWindow', 'number', 2, 50));
    config.append(settingInput('提示词插入深度', 'depth', 'number', 0, 20));
    const mode = select([['main', '酒馆当前 API'], ['custom', '独立兼容 API']], controller.settings().apiMode);
    const custom = el('div', 'rpp-custom');
    mode.addEventListener('change', () => { saveSetting('apiMode', mode.value); custom.hidden = mode.value !== 'custom'; });
    config.append(field('分析 API', mode));
    custom.hidden = mode.value !== 'custom';
    custom.append(settingInput('API 基础地址（含 /v1，或完整 completions 地址）', 'endpoint'));
    custom.append(settingInput('模型名称', 'model'));
    const key = el('input', 'text_pole'); key.type = 'password'; key.autocomplete = 'off'; key.placeholder = '仅保留在本次页面内存';
    key.addEventListener('input', () => { sessionApiKey = key.value; controller.cancel(); }); custom.append(field('API 密钥（可选）', key));
    custom.append(el('p', 'rpp-help', '独立 API 需支持浏览器跨域。密钥不会写入聊天、设置或导出文件，刷新后需重新填写。'));
    config.append(custom, el('p', 'rpp-help', '分析会发送原角色设定、有效反馈及相关聊天片段到所选 API。使用当前 API 时继承酒馆模型和回复长度；若 JSON 被截断，请提高回复长度。'));
    body.append(config);
    drawer.append(body); panel.append(drawer); target.append(panel); return true;
}

function renderProfile() {
    const ctx = controller.context();
    if (!controller.supported(ctx)) {
        stats.textContent = '请打开角色的单人聊天。第一版暂不支持群聊。';
        profileList.replaceChildren(el('p', 'rpp-help', '打开聊天存档后，可在这里查看它的偏好。')); preview.value = ''; return;
    }
    const state = controller.state(), valid = activeFeedback(ctx.chat), usable = usableItems(ctx.chat, state);
    const pending = pendingFeedback(ctx.chat, state).length;
    stats.textContent = `${ctx.characters[ctx.characterId].name} · ${ctx.chatId ?? ctx.getCurrentChatId()}｜有效反馈 ${valid.length} 条，待分析 ${pending} 条，启用补充 ${usable.length} 条`;
    const chatToggle = panel.querySelector('#rpp-chat-enabled'); chatToggle.checked = state.enabled; chatToggle.disabled = controller.busy;
    const content = [];
    if (state.summary) content.push(el('p', 'rpp-analysis-summary', state.summary));
    if (!state.profile.length) content.push(el('p', 'rpp-help', '还没有偏好补充。先保存几条反馈，再点击“分析并应用”。'));
    const activeIds = new Set(valid.map(f => f.id));
    for (const item of state.profile) {
        const row = el('article', 'rpp-item');
        const stale = !item.manual && item.sourceIds.some(id => !activeIds.has(id));
        const confidence = { explicit: '明确反馈', repeated: '多次支持', tentative: '待确认推测', manual: '用户确认' }[item.confidence];
        row.append(el('p', 'rpp-item-title', `${CATEGORIES[item.category]} · ${confidence}${stale ? ' · 来源已变化，停止注入' : ''}`));
        const input = el('textarea', 'text_pole'); input.rows = 3; input.maxLength = 500;
        const draft = itemDrafts.get(item.id) ?? { text: item.text, enabled: item.enabled };
        input.value = draft.text;
        input.addEventListener('input', () => { draft.text = input.value; itemDrafts.set(item.id, draft); });
        row.append(field('补充内容', input));
        row.append(checkbox('启用这条补充', draft.enabled, value => { draft.enabled = value; itemDrafts.set(item.id, draft); }));
        const sources = item.sourceIds.map(id => valid.find(f => f.id === id)).filter(Boolean).map(f => `第 ${f.index} 层`).join('、');
        row.append(el('p', 'rpp-help', item.manual ? '用户确认的补充会保留，后续分析不会自动改写。' : `反馈来源：${sources || '原回复版本已变化'}。保存修改后视为用户确认。`));
        const actions = el('div', 'rpp-actions');
        const save = button('保存修改', async () => { await controller.editItem(item.id, input.value, draft.enabled); itemDrafts.delete(item.id); renderProfile(); });
        const remove = button('删除', async () => { await controller.deleteItem(item.id); itemDrafts.delete(item.id); });
        save.disabled = remove.disabled = controller.busy; actions.append(save, remove); row.append(actions); content.push(row);
    }
    profileList.replaceChildren(...content);
    preview.value = controller.inject() || '当前没有注入偏好补充。';
}

function createFeedbackRow(message, index, chat) {
    const revision = revisionOf(message), feedback = currentFeedback(message);
    const details = el('details', 'rpp-feedback'); details.dataset.revision = revision;
    details.dataset.feedback = feedback?.id ?? ''; details.dataset.index = index;
    details.append(el('summary', '', feedback ? `反馈已保存 · 剧情 ${feedback.plot ?? '—'} / 角色 ${feedback.character ?? '—'}` : '反馈 · 剧情与角色表现'));
    const form = el('form', 'rpp-feedback-form');
    const stored = feedbackDrafts.get(message);
    const draft = stored?.revision === revision ? stored : { revision, plot: feedback?.plot ?? '', character: feedback?.character ?? '', note: feedback?.note ?? '' };
    const choices = [['', '不评分'], ...[1, 2, 3, 4, 5].map(n => [String(n), `${n} 分${n === 1 ? ' · 不满意' : n === 5 ? ' · 很满意' : ''}`])];
    const ratings = el('div', 'rpp-ratings');
    for (const [key, label] of [['plot', '剧情满意度'], ['character', '角色表现满意度']]) {
        const input = select(choices, String(draft[key]));
        input.addEventListener('change', () => { draft[key] = input.value; feedbackDrafts.set(message, draft); }); ratings.append(field(label, input));
    }
    const note = el('textarea', 'text_pole'); note.rows = 2; note.maxLength = 2000; note.value = draft.note;
    note.placeholder = '例如：喜欢克制的关心，但关系推进太快。';
    note.addEventListener('input', () => { draft.note = note.value; feedbackDrafts.set(message, draft); });
    form.append(ratings, field('希望如何调整（可只写短评）', note));
    const localStatus = el('p', 'rpp-help'); localStatus.setAttribute('role', 'status');
    function checkVersion() {
        if (controller.context().chat !== chat || chat[index] !== message || revisionOf(message) !== revision) throw new Error('回复版本或聊天已变化，请重新展开反馈。');
    }
    async function submit(apply) {
        try {
            checkVersion(); await controller.saveFeedback(index, draft); feedbackDrafts.delete(message);
            if (apply && pendingFeedback(controller.context().chat, controller.state()).length) await controller.analyze({ apiKey: sessionApiKey });
        } catch (error) { localStatus.textContent = error.message; localStatus.classList.add('rpp-error'); announce(error.message, true); }
    }
    const actions = el('div', 'rpp-actions');
    const save = button('保存反馈', () => submit(false));
    const apply = button('保存并分析', () => submit(true), true);
    const remove = button('移除反馈', async () => { checkVersion(); await controller.removeFeedback(index); feedbackDrafts.delete(message); });
    remove.hidden = !feedback;
    actions.append(save, apply, remove); form.append(actions, localStatus);
    form.addEventListener('submit', event => { event.preventDefault(); perform(() => submit(false)); });
    details.append(form); return details;
}

function renderFloors() {
    const ctx = controller.context();
    const active = controller.settings().enabled && controller.supported(ctx);
    for (const floor of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(floor.getAttribute('mesid')), message = ctx.chat[index];
        let existing = floor.querySelector('.rpp-feedback');
        if (!active || !eligible(message)) { existing?.remove(); continue; }
        const revision = revisionOf(message), feedback = currentFeedback(message);
        const binding = existing && floorBindings.get(existing);
        if (!existing || binding?.chat !== ctx.chat || binding?.message !== message || existing.dataset.revision !== revision || existing.dataset.feedback !== (feedback?.id ?? '') || existing.dataset.index !== String(index)) {
            const open = existing?.open ?? false;
            const next = createFeedbackRow(message, index, ctx.chat); next.open = open;
            floorBindings.set(next, { chat: ctx.chat, message });
            if (existing) existing.replaceWith(next);
            else (floor.querySelector('.mes_block') ?? floor).append(next);
            existing = next;
        }
        for (const node of existing.querySelectorAll('button, select, textarea')) node.disabled = controller.busy;
    }
}
function render() {
    if (!panel && !mountPanel()) return;
    renderProfile(); renderFloors();
    for (const control of panel.querySelectorAll('[data-mutation]')) control.disabled = controller.busy || !controller.supported(controller.context());
    panel.querySelector('#rpp-cancel').disabled = !controller.busy;
}
function deferRefresh() { clearTimeout(renderTimer); renderTimer = setTimeout(() => controller.refresh(), 60); }

export function initialize() {
    if (controller || !globalThis.SillyTavern?.getContext) return;
    controller = createController({ getContext: () => SillyTavern.getContext(), notify: announce, changed: render,
        analyzer: (ctx, settings, prompt, options) => callAnalyzer(ctx, settings, prompt, { ...options, apiKey: options.apiKey || sessionApiKey }) });
    Object.assign(controller.settings(), { ...DEFAULTS, ...controller.settings() });
    const ctx = controller.context(), types = ctx.eventTypes ?? ctx.event_types;
    function on(name, handler) { if (types?.[name]) { ctx.eventSource.on(types[name], handler); subscriptions.push([types[name], handler]); } }
    on('APP_READY', deferRefresh);
    on('GENERATION_STARTED', () => controller.generationStarted());
    on('GENERATION_ENDED', () => controller.generationEnded());
    on('GENERATION_STOPPED', () => controller.generationEnded());
    for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'CHARACTER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED']) on(name, () => controller.refresh());
    on('CHAT_COMPLETION_PROMPT_READY', () => controller.inject());
    observer = new MutationObserver(records => {
        // Ignore our own UI mutations and streaming text. Watch host-added message nodes only.
        if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches?.('.mes[mesid], #chat, #extensions_settings2') || node.querySelector?.('.mes[mesid]'))))) deferRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true }); controller.refresh();
}

export function onDisable() {
    controller?.cancel(); observer?.disconnect(); clearTimeout(renderTimer);
    const ctx = controller?.context();
    for (const [type, handler] of subscriptions) ctx?.eventSource.removeListener(type, handler);
    subscriptions.length = 0;
    ctx?.setExtensionPrompt(KEY, '', 1, 0, false, 0);
    document.querySelectorAll('.rpp-feedback, #rpp-panel').forEach(node => node.remove());
    panel = null; controller = null; itemDrafts.clear();
}

export const onEnable = initialize;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
