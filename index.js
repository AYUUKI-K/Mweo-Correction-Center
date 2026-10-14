import { KEY, DEFAULTS, CATEGORIES, activeFeedback, pendingFeedback, currentFeedback, revisionOf, eligible, usableItems, sourcesActive, feedbackKey } from './core.js';
import { createController } from './controller.js';
import { callAnalyzer } from './api.js';

let controller, panel, workbench, home, status, profileList, stats, preview, sessionApiKey = '', observer;
let floatingButton, floatingWindow, floatingFeedback, floatingHeading, floatingPreview, floatingStatus, renderedMetadata, focusedFloor;
let visibleFloorTimer;
let categoryTabs, categoryInfo, categoryAssessment, analysisSummary, analysisSummaryDetails, injectionInfo, manualInput, manualDetails, activeCategory = 'interaction';
const CATEGORY_UI = {
    interaction: { title: '角色相处', description: '在人设允许的范围内，补充 char 与 user 的互动方式。也会显示在角色描述与开场白之间。' },
    plot: { title: '剧情走向', description: '剧情类型、冲突处理、关系发展与推进节奏。' },
    expression: { title: '表达细节', description: '文风、动作描写、对白比例，以及 user 的自主权。' },
};
const feedbackDrafts = new WeakMap();
const floorBindings = new WeakMap();
const itemDrafts = new Map();
const manualDrafts = new Map();
const subscriptions = [];
let renderTimer;
let fieldCounter = 0;
let nativeHostState;
let mainTabs, recordsList, activePage = 'overview';
let automaticOptions, analysisModeHelp, bulkAnalysisHelp;
const pages = {};
const MAIN_TABS = { overview: ['概览', 'book'], settings: ['设置', 'sliders'], prompts: ['提示词', 'pen'], records: ['记录', 'archive'] };

function icon(name) {
    const shapes = {
        book: ['M12 5c-3-2-7-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V4c-2-1-6-1-9 1Z', 'M12 5v14'],
        sliders: ['M4 6h16M4 12h16M4 18h16', 'M8 3v6M16 9v6M10 15v6'],
        pen: ['m4 16 11-11 4 4-11 11-5 1Z', 'm13 7 4 4'],
        archive: ['M4 7h16v13H4ZM3 3h18v4H3Z', 'M9 11h6'],
        cat: ['M5 8 4 3l6 3h4l6-3-1 5c4 8 0 13-7 13S1 16 5 8Z', 'M8 12h.1M16 12h.1M10 16l2 1 2-1M3 14l4 1M17 15l4-1'],
        chevron: ['m6 9 6 6 6-6'],
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.6'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.classList.add('rpp-icon');
    for (const d of shapes[name] ?? []) { const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); svg.append(path); }
    return svg;
}

function choosePage(name) {
    activePage = name;
    for (const [key, page] of Object.entries(pages)) page.hidden = key !== name;
    for (const tab of mainTabs?.querySelectorAll('[role=tab]') ?? []) {
        const selected = tab.dataset.page === name;
        selectTab(tab, selected);
    }
}

function selectTab(tab, selected) {
    tab.classList.toggle('rpp-is-active', selected);
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    // Theme CSS (including stale styles after extension updates) must not pin a
    // visual selection to the first button. Synchronize appearance with state.
    tab.style.setProperty('background', selected ? 'var(--rpp-wash)' : 'transparent', 'important');
    tab.style.setProperty('box-shadow', selected ? 'inset 0 -2px 0 var(--rpp-accent)' : 'none', 'important');
    tab.style.setProperty('font-weight', selected ? '600' : '400', 'important');
    tab.style.setProperty('border-color', selected ? 'var(--rpp-accent)' : 'var(--rpp-rule)', 'important');
}

function navigationTab(action) {
    // Navigation is not a host menu_button; do not invoke host/theme handlers.
    const tab = el('button', 'rpp-button'); tab.type = 'button';
    tab.addEventListener('click', event => { event.stopPropagation(); action(); });
    return tab;
}

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
    if (floatingStatus) { floatingStatus.textContent = text; floatingStatus.classList.toggle('rpp-error', error); }
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
    if (key !== 'feedbackMode') controller.cancel();
    controller.settings()[key] = value;
    if (key === 'feedbackMode' && value !== 'floating') closeFloating(false);
    controller.context().saveSettingsDebounced(); controller.refresh();
    if ((key === 'autoAnalyze' && value) || key === 'threshold') controller.scheduleAuto();
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
    const title = el('summary', 'rpp-title standoutHeader'); const chevron = icon('chevron'); chevron.classList.add('rpp-chevron');
    title.append(icon('cat'), el('b', '', '喵喵修正中心'), el('small', 'rpp-version', 'v0.6.0'), chevron); drawer.append(title);
    const body = el('div', 'rpp-body');
    const entranceField = el('fieldset', 'rpp-entrance'); entranceField.append(el('legend', '', '反馈入口（二选一）'));
    for (const [value, label] of [['floors', '楼层反馈'], ['floating', '悬浮球']]) {
        const choice = el('label', 'rpp-entrance-choice');
        const input = el('input'); input.type = 'radio'; input.name = 'rpp-feedback-mode'; input.value = value;
        input.checked = controller.settings().feedbackMode === value;
        input.addEventListener('change', () => { if (input.checked) saveSetting('feedbackMode', value); });
        choice.append(input, document.createTextNode(label)); entranceField.append(choice);
    }
    home = el('div', 'rpp-home'); workbench = el('div', 'rpp-workbench'); home.append(workbench); body.append(home);
    const topline = el('div', 'rpp-topline');
    const master = checkbox('启用', controller.settings().enabled, value => saveSetting('enabled', value)); master.classList.add('rpp-switch');
    const masterInput = master.querySelector('input'); master.replaceChildren(el('span', '', '启用'), masterInput, el('span', 'rpp-switch-track'));
    topline.append(el('p', 'rpp-tagline', '听见偏好，让故事更合心意。'), master); workbench.append(topline);
    mainTabs = el('div', 'rpp-main-tabs'); mainTabs.setAttribute('role', 'tablist'); mainTabs.setAttribute('aria-label', '喵喵修正中心');
    for (const [key, [label, glyph]] of Object.entries(MAIN_TABS)) {
        const tab = navigationTab(() => choosePage(key)); tab.classList.add('rpp-main-tab'); tab.id = `rpp-main-${key}`; tab.dataset.page = key;
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `rpp-page-${key}`); tab.append(icon(glyph), el('span', '', label));
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const keys = Object.keys(MAIN_TABS), index = keys.indexOf(activePage);
            const next = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (event.key === 'ArrowLeft' ? -1 : 1) + keys.length) % keys.length];
            choosePage(next); document.querySelector(`#rpp-main-${next}`).focus();
        });
        mainTabs.append(tab);
    }
    workbench.append(mainTabs);
    for (const key of Object.keys(MAIN_TABS)) {
        const page = el('section', 'rpp-page'); page.id = `rpp-page-${key}`; page.setAttribute('role', 'tabpanel'); page.setAttribute('aria-labelledby', `rpp-main-${key}`);
        pages[key] = page; workbench.append(page);
    }
    stats = el('div', 'rpp-overview'); stats.setAttribute('aria-live', 'polite'); stats.setAttribute('aria-atomic', 'true'); pages.overview.append(stats);
    const feedbackSection = el('section', 'rpp-step'); feedbackSection.id = 'rpp-feedback-step'; feedbackSection.append(el('h3', 'rpp-step-title', '反馈与分析'));
    feedbackSection.append(el('p', 'rpp-help', '剧情、角色表现分别评分，也可以只写短评。'));
    const floorHint = el('p', 'rpp-help', '楼层模式：在角色回复下展开“反馈”填写。'); floorHint.id = 'rpp-floor-hint'; feedbackSection.append(floorHint);
    automaticOptions = el('div', 'rpp-automatic-options'); automaticOptions.id = 'rpp-automatic-options';
    automaticOptions.append(settingInput('每累计多少条新评价自动分析', 'threshold', 'number', 1, 20));
    automaticOptions.append(el('p', 'rpp-help', '累计 N 条就按提交顺序分析一批新评价。相同评价不会重复计数；新版修正整体替换旧版。'));
    analysisModeHelp = el('p', 'rpp-help');
    pages.settings.append(entranceField, checkbox('累计反馈后自动分析', controller.settings().autoAnalyze, value => saveSetting('autoAnalyze', value)), automaticOptions, analysisModeHelp);
    const actions = el('div', 'rpp-actions');
    const cancel = button('取消本次应用', () => { controller.cancel(); announce('已取消本次应用。酒馆当前 API 请求可能仍需等待结束。'); }); cancel.id = 'rpp-cancel';
    actions.append(cancel); feedbackSection.append(actions);
    status = el('p', 'rpp-status', '当前存档已就绪。'); status.setAttribute('role', 'status'); workbench.insertBefore(status, pages.overview);
    analysisSummaryDetails = el('details', 'rpp-analysis-details'); analysisSummaryDetails.append(el('summary', '', '查看本次分析说明'));
    analysisSummary = el('p', 'rpp-analysis-summary'); analysisSummaryDetails.append(analysisSummary); pages.records.append(analysisSummaryDetails);
    feedbackSection.append(button('查看偏好补充', () => choosePage('prompts')));
    pages.overview.append(feedbackSection);
    bulkAnalysisHelp = el('p', 'rpp-help'); feedbackSection.append(bulkAnalysisHelp);
    const profileSection = el('section', 'rpp-step'); profileSection.id = 'rpp-profile-step'; profileSection.append(el('h3', 'rpp-step-title', '当前档偏好补充'));
    profileSection.append(el('p', 'rpp-help', '一次分析整理三类偏好。待确认条目保存启用后才会注入。'));
    const chatSwitch = checkbox('应用当前存档的偏好补充', true, value => perform(() => controller.setChatEnabled(value)));
    chatSwitch.querySelector('input').id = 'rpp-chat-enabled'; profileSection.append(chatSwitch);
    categoryTabs = el('div', 'rpp-category-tabs'); categoryTabs.setAttribute('role', 'tablist'); categoryTabs.setAttribute('aria-label', '三类偏好');
    for (const [key, info] of Object.entries(CATEGORY_UI)) {
        const tab = navigationTab(() => { activeCategory = key; renderProfile(); }); tab.textContent = info.title;
        tab.setAttribute('role', 'tab'); tab.id = `rpp-tab-${key}`; tab.dataset.category = key;
        tab.setAttribute('aria-controls', 'rpp-category-panel');
        tab.addEventListener('keydown', event => {
            const keys = Object.keys(CATEGORY_UI), index = keys.indexOf(activeCategory);
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); activeCategory = event.key === 'Home' ? keys[0] : event.key === 'End' ? keys.at(-1) : keys[(index + (event.key === 'ArrowLeft' ? -1 : 1) + keys.length) % keys.length];
            renderProfile(); document.querySelector(`#rpp-tab-${activeCategory}`).focus();
        });
        categoryTabs.append(tab);
    }
    const categoryPanel = el('div', 'rpp-category-panel'); categoryPanel.id = 'rpp-category-panel'; categoryPanel.setAttribute('role', 'tabpanel');
    categoryInfo = el('p', 'rpp-category-info'); categoryAssessment = el('p', 'rpp-category-assessment'); profileList = el('div', 'rpp-profile-list');
    manualDetails = el('details', 'rpp-manual'); manualDetails.append(el('summary', '', '手动添加偏好'));
    manualInput = el('textarea', 'text_pole'); manualInput.maxLength = 500; manualInput.rows = 3;
    manualInput.addEventListener('input', () => manualDrafts.set(activeCategory, manualInput.value));
    manualDetails.append(field('手动补充（保存后立即应用于当前存档）', manualInput));
    const add = button('保存手动补充', async () => { const category = activeCategory; await controller.addItem(category, manualInput.value); manualDrafts.delete(category); renderProfile(); }); add.dataset.mutation = 'true'; manualDetails.append(add);
    categoryPanel.append(categoryInfo, categoryAssessment, profileList, manualDetails); profileSection.append(categoryTabs, categoryPanel);
    const historyActions = el('div', 'rpp-actions');
    for (const [label, action] of [['撤销上次更新', () => controller.undo()], ['清空补充', () => controller.clearProfile()]]) {
        const control = button(label, action); control.dataset.mutation = 'true'; historyActions.append(control);
    }
    recordsList = el('div', 'rpp-records'); pages.records.append(el('h3', 'rpp-step-title', '当前档反馈记录'), recordsList, historyActions);
    pages.prompts.append(profileSection);
    const settingsSection = el('section', 'rpp-step'); settingsSection.id = 'rpp-settings-step'; settingsSection.append(el('h3', 'rpp-step-title', '实际注入'));
    injectionInfo = el('p', 'rpp-injection-info'); settingsSection.append(injectionInfo);
    const injectionDetails = el('details', 'rpp-section'); injectionDetails.append(el('summary', '', '查看实际注入的提示词'));
    preview = el('textarea', 'text_pole rpp-preview'); preview.readOnly = true; preview.rows = 7; preview.setAttribute('aria-label', '当前实际注入的提示词'); injectionDetails.append(preview); settingsSection.append(injectionDetails);
    const config = el('div', 'rpp-section'); config.append(el('h3', 'rpp-step-title', '分析 API'));
    settingsSection.append(settingInput('注入深度（距聊天末尾的消息条数）', 'depth', 'number', 0, 20));
    const mode = select([['main', '酒馆当前 API'], ['custom', '独立兼容 API']], controller.settings().apiMode);
    const custom = el('div', 'rpp-custom');
    mode.addEventListener('change', () => { saveSetting('apiMode', mode.value); custom.hidden = mode.value !== 'custom'; });
    config.append(field('使用的接口', mode));
    custom.hidden = mode.value !== 'custom';
    custom.append(settingInput('API 基础地址（含 /v1，或完整 completions 地址）', 'endpoint'));
    custom.append(settingInput('模型名称', 'model'));
    const key = el('input', 'text_pole'); key.type = 'password'; key.autocomplete = 'off'; key.placeholder = '仅保留在本次页面内存';
    key.addEventListener('input', () => { sessionApiKey = key.value; controller.cancel(); }); custom.append(field('API 密钥（可选）', key));
    custom.append(el('p', 'rpp-help', '独立 API 需支持浏览器跨域。密钥不会写入聊天、设置或导出文件，刷新后需重新填写。'));
    config.append(custom, el('p', 'rpp-help', '每条新评价只携带对应楼层正文，并附原角色设定及上次分析结论。使用当前 API 时继承酒馆模型和回复长度；若 JSON 被截断，请提高回复长度。'));
    pages.settings.append(config); pages.prompts.append(settingsSection);
    choosePage(activePage);
    drawer.append(body); panel.append(drawer); target.append(panel); return true;
}

function renderProfile() {
    const ctx = controller.context();
    manualInput.value = manualDrafts.get(activeCategory) ?? '';
    for (const tab of categoryTabs.querySelectorAll('[role=tab]')) {
        const selected = tab.dataset.category === activeCategory;
        selectTab(tab, selected);
    }
    profileList.parentElement.setAttribute('aria-labelledby', `rpp-tab-${activeCategory}`);
    categoryInfo.textContent = CATEGORY_UI[activeCategory].description;
    injectionInfo.textContent = `注入位置：聊天消息中 · system 角色 · 深度 ${controller.settings().depth}（从末尾计数）。角色页的补充栏是展示入口，不会写入原角色描述。`;
    if (!controller.supported(ctx)) {
        stats.textContent = '请打开角色的单人聊天。第一版暂不支持群聊。';
        profileList.replaceChildren(el('p', 'rpp-help', '打开聊天存档后，可在这里查看它的偏好。')); preview.value = '';
        recordsList.replaceChildren(el('p', 'rpp-empty', '打开单人存档后可查看反馈记录。'));
        workbench.querySelector('#rpp-chat-enabled').disabled = true;
        analysisSummaryDetails.hidden = true;
        categoryAssessment.hidden = true;
        for (const tab of categoryTabs.querySelectorAll('[role=tab]')) tab.textContent = CATEGORY_UI[tab.dataset.category].title;
        return;
    }
    const state = controller.state(), valid = activeFeedback(ctx.chat), usable = usableItems(ctx.chat, state);
    const processed = new Set(state.consumed);
    recordsList.replaceChildren(...(valid.length ? [...valid].reverse().map(feedback => {
        const label = processed.has(feedbackKey(feedback)) || processed.has(feedback.id) ? '已处理' : '待分析';
        const row = el('article', 'rpp-record'); row.append(el('strong', '', `第 ${feedback.index} 层 · 剧情 ${feedback.plot ?? '—'} / 角色 ${feedback.character ?? '—'} · ${label}`));
        row.append(el('p', '', feedback.note || '仅评分，无短评。')); return row;
    }) : [el('p', 'rpp-empty', '当前档还没有有效反馈记录。')]));
    const pending = pendingFeedback(ctx.chat, state, controller.settings()).length;
    const report = state.categoryReports?.[activeCategory];
    categoryAssessment.hidden = !state.analyzedAt;
    const reportLabels = { updated: '本轮已更新', unchanged: '保留上次结论', insufficient: '本轮证据不足' };
    categoryAssessment.textContent = report ? `${reportLabels[report.status]}：${report.reason}` : '旧版分析未记录这类偏好的判断说明；下次有新评价时会补齐。';
    const name = el('p', 'rpp-chat-label', `${ctx.characters[ctx.characterId].name} · 当前存档`);
    const saveName = el('p', 'rpp-save-name', String(ctx.chatId ?? ctx.getCurrentChatId()));
    const counts = el('div', 'rpp-counts');
    for (const [label, count] of [['有效反馈', valid.length], ['待分析', pending], ['正在应用', state.enabled && controller.settings().enabled ? usable.length : 0]]) {
        const tile = el('div', 'rpp-count'); tile.append(el('strong', '', String(count)), el('span', '', label)); counts.append(tile);
    }
    stats.replaceChildren(name, saveName, counts);
    const chatToggle = workbench.querySelector('#rpp-chat-enabled'); chatToggle.checked = state.enabled; chatToggle.disabled = controller.busy;
    analysisSummary.textContent = state.summary; analysisSummaryDetails.hidden = !state.summary;
    for (const tab of categoryTabs.querySelectorAll('[role=tab]')) {
        const key = tab.dataset.category, group = state.profile.filter(item => item.category === key);
        const enabled = group.filter(item => usable.includes(item)).length;
        const candidates = group.filter(item => !item.enabled && item.confidence === 'tentative').length;
        tab.replaceChildren(el('span', '', CATEGORY_UI[key].title), el('small', '', `${enabled} 启用 · ${candidates} 待确认`));
    }
    const content = [];
    if (!state.profile.some(item => item.category === activeCategory)) content.push(el('p', 'rpp-empty', `还没有${CATEGORY_UI[activeCategory].title}补充。分析后会归入这里，也可以手动添加。`));
    for (const item of state.profile.filter(item => item.category === activeCategory)) {
        const row = el('article', 'rpp-item');
        const stale = !sourcesActive(item, ctx.chat);
        const confidence = { explicit: '明确反馈', repeated: '多次支持', tentative: '待确认推测', manual: '用户确认' }[item.confidence];
        row.append(el('p', 'rpp-item-title', `${stale ? '已失效' : item.enabled ? '已启用' : item.confidence === 'tentative' ? '待确认' : '已停用'} · ${confidence}${stale ? ' · 来源回复已变化' : ''}`));
        const input = el('textarea', 'text_pole'); input.rows = 3; input.maxLength = 500;
        const draft = itemDrafts.get(item.id) ?? { text: item.text, enabled: item.enabled };
        input.value = draft.text;
        input.addEventListener('input', () => { draft.text = input.value; itemDrafts.set(item.id, draft); });
        row.append(field('偏好补充内容', input));
        row.append(checkbox('启用这条补充', draft.enabled, value => { draft.enabled = value; itemDrafts.set(item.id, draft); }));
        const sources = item.sourceIds.map(id => valid.find(f => f.id === id)).filter(Boolean).map(f => `第 ${f.index} 层`).join('、');
        row.append(el('p', 'rpp-help', item.manual ? '你保存的修改会交给下一轮分析，AI 可结合新评价保留、改写或删除。' : `反馈来源：${sources || (item.userAnchored ? '上一版用户补充' : '原回复版本已变化')}。此条会参与后续整份修正。`));
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
    details.dataset.feedbackKey = feedback ? feedbackKey(feedback) : '';
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
    async function submit() {
        try {
            checkVersion(); await controller.saveFeedback(index, draft); feedbackDrafts.delete(message);
        } catch (error) { localStatus.textContent = error.message; localStatus.classList.add('rpp-error'); announce(error.message, true); }
    }
    const actions = el('div', 'rpp-actions');
    const save = button('保存反馈', submit, true);
    const remove = button('移除反馈', async () => { checkVersion(); await controller.removeFeedback(index); feedbackDrafts.delete(message); });
    remove.hidden = !feedback;
    actions.append(save, remove); form.append(actions, localStatus);
    form.addEventListener('submit', event => { event.preventDefault(); perform(submit); });
    details.append(form); return details;
}

function closeFloating(restoreFocus = true) {
    if (!floatingWindow || floatingWindow.hidden) return;
    floatingWindow.hidden = true;
    floatingButton?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !floatingButton?.hidden) floatingButton.focus();
}

function openWorkbench(category) {
    if (category) { activeCategory = category; choosePage('prompts'); renderProfile(); }
    panel.querySelector('.rpp-drawer').open = true;
    workbench.scrollIntoView?.({ block: 'start', behavior: 'auto' });
}

function openFloating() {
    mountFloating(); floatingWindow.hidden = false;
    floatingButton.setAttribute('aria-expanded', 'true');
    renderFloatingFeedback(); floatingWindow.querySelector('button').focus();
}

function positionFloating() {
    if (!floatingButton || !controller) return;
    const saved = controller.settings().floatingPosition;
    const right = Math.max(8, Math.min(Number(saved?.right) || 18, Math.max(8, window.innerWidth - 64)));
    const bottom = Math.max(8, Math.min(Number(saved?.bottom) || 110, Math.max(8, window.innerHeight - 64)));
    floatingButton.style.right = `${right}px`; floatingButton.style.bottom = `${bottom}px`;
}

function mountFloating() {
    if (floatingButton) return;
    floatingButton = button('修正', () => {
        if (floatingWindow.hidden) openFloating(); else closeFloating();
    });
    floatingButton.className = 'rpp-floating-button'; floatingButton.id = 'rpp-floating-button';
    floatingButton.setAttribute('aria-label', '评价当前浏览楼层'); floatingButton.setAttribute('aria-expanded', 'false'); floatingButton.setAttribute('aria-controls', 'rpp-floating-window');
    floatingWindow = el('section', 'rpp-floating-window'); floatingWindow.id = 'rpp-floating-window'; floatingWindow.hidden = true;
    floatingWindow.setAttribute('role', 'dialog'); floatingWindow.setAttribute('aria-modal', 'false'); floatingWindow.setAttribute('aria-label', '当前楼层评价');
    const header = el('div', 'rpp-floating-header');
    const toolbar = el('div', 'rpp-floating-toolbar'); floatingHeading = el('strong', 'rpp-brand', '当前楼层评价'); toolbar.append(floatingHeading, button('关闭', () => closeFloating()));
    header.append(toolbar); floatingWindow.append(header);
    floatingPreview = el('p', 'rpp-floor-preview');
    floatingFeedback = el('div', 'rpp-floating-feedback');
    floatingStatus = el('p', 'rpp-status'); floatingStatus.setAttribute('role', 'status');
    const cancel = button('取消本次分析', () => { controller.cancel(); announce('已取消本次分析应用。'); }); cancel.id = 'rpp-floating-cancel'; cancel.hidden = true;
    floatingWindow.append(floatingPreview, floatingFeedback, floatingStatus, cancel);
    floatingWindow.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); closeFloating(); } });
    // Pointer drag changes only entry position; it does not modify or cancel analysis.
    let drag = null, suppressClick = false;
    floatingButton.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        drag = { x: event.clientX, y: event.clientY, right: parseFloat(floatingButton.style.right), bottom: parseFloat(floatingButton.style.bottom), moved: false };
        floatingButton.setPointerCapture?.(event.pointerId);
    });
    floatingButton.addEventListener('pointermove', event => {
        if (!drag) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
        if (Math.hypot(dx, dy) > 6) drag.moved = true;
        if (!drag.moved) return;
        floatingButton.style.right = `${Math.max(8, Math.min(drag.right - dx, window.innerWidth - 64))}px`;
        floatingButton.style.bottom = `${Math.max(8, Math.min(drag.bottom - dy, window.innerHeight - 64))}px`;
    });
    floatingButton.addEventListener('pointerup', () => {
        if (drag?.moved) {
            suppressClick = true;
            controller.settings().floatingPosition = { right: parseFloat(floatingButton.style.right), bottom: parseFloat(floatingButton.style.bottom) };
            controller.context().saveSettingsDebounced();
        }
        drag = null;
    });
    floatingButton.addEventListener('pointercancel', () => { drag = null; suppressClick = false; });
    floatingButton.addEventListener('click', event => { if (suppressClick) { event.stopImmediatePropagation(); event.preventDefault(); suppressClick = false; } }, true);
    document.body.append(floatingButton, floatingWindow); positionFloating();
}

function visibleReply(ctx) {
    const chatNode = document.querySelector('#chat');
    if (!chatNode) return null;
    const area = chatNode.getBoundingClientRect();
    const top = Math.max(0, area.top), bottom = Math.min(window.innerHeight, area.bottom);
    const left = Math.max(0, area.left), right = Math.min(window.innerWidth, area.right);
    if (bottom <= top || right <= left) return null;
    const middle = (top + bottom) / 2;
    const visible = [...chatNode.querySelectorAll('.mes[mesid]')].flatMap(node => {
        const index = Number(node.getAttribute('mesid')), message = ctx.chat[index];
        if (!Number.isInteger(index) || !eligible(message)) return [];
        const rect = node.getBoundingClientRect(), style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0 || rect.bottom <= top || rect.top >= bottom || rect.right <= left || rect.left >= right) return [];
        return [{ node, message, index, distance: Math.max(rect.top - middle, middle - rect.bottom, 0), visibleHeight: Math.min(rect.bottom, bottom) - Math.max(rect.top, top) }];
    });
    return visible.find(entry => entry.node === focusedFloor) ?? visible.sort((a, b) => a.distance - b.distance || b.visibleHeight - a.visibleHeight)[0] ?? null;
}

function renderFloatingFeedback() {
    if (!floatingWindow || floatingWindow.hidden) return;
    const ctx = controller.context(), target = controller.supported(ctx) ? visibleReply(ctx) : null;
    if (!target) {
        floatingHeading.textContent = '当前楼层评价'; floatingPreview.textContent = '';
        floatingFeedback.replaceChildren(el('p', 'rpp-empty', '请将要评价的角色回复滚动到聊天可见区域。'));
        return;
    }
    const { message, index } = target, revision = revisionOf(message), feedback = currentFeedback(message);
    floatingHeading.textContent = `第 ${index} 楼 · 评价`;
    floatingPreview.textContent = String(message.mes).replace(/\s+/g, ' ').slice(0, 140);
    const old = floatingFeedback.querySelector('.rpp-feedback');
    const binding = old && floorBindings.get(old);
    if (!old || binding?.chat !== ctx.chat || binding?.message !== message || old.dataset.revision !== revision || old.dataset.feedbackKey !== (feedback ? feedbackKey(feedback) : '') || old.dataset.index !== String(index)) {
        const row = createFeedbackRow(message, index, ctx.chat); row.open = true;
        floorBindings.set(row, { chat: ctx.chat, message }); floatingFeedback.replaceChildren(row);
        floatingStatus.textContent = '';
    }
    for (const input of floatingFeedback.querySelectorAll('button, select, textarea')) input.disabled = controller.busy;
    floatingWindow.querySelector('#rpp-floating-cancel').hidden = !controller.busy;
}

function viewportChanged(event) {
    if (event?.target?.closest?.('#rpp-floating-window, #rpp-panel')) return;
    focusedFloor = null;
    clearTimeout(visibleFloorTimer);
    visibleFloorTimer = setTimeout(renderFloatingFeedback, 80);
}
function focusReadingFloor(event) {
    focusedFloor = event.target?.closest?.('#chat .mes[mesid]') ?? focusedFloor;
    renderFloatingFeedback();
}

function renderCharacterSupplement() {
    const anchor = document.querySelector('#firstMessageWrapper') ?? document.querySelector('#first_message_div');
    const description = document.querySelector('#description_textarea');
    if (!anchor || !description) return;
    let block = document.querySelector('#rpp-character-supplement');
    if (!block) {
        block = el('section', 'rpp-character-supplement'); block.id = 'rpp-character-supplement';
        block.append(el('h3', 'rpp-step-title', '角色相处补充 · 当前存档'));
        const name = el('p', 'rpp-character-chat');
        const text = el('textarea', 'text_pole'); text.readOnly = true; text.rows = 5; text.setAttribute('aria-label', '当前存档角色相处补充');
        const help = el('p', 'rpp-help', '原角色描述优先。这里仅展示当前存档已启用的相处偏好，不改写角色卡。');
        const edit = button('编辑此档角色补充', () => openWorkbench('interaction'));
        block.append(name, text, help, edit);
    }
    if (block.nextElementSibling !== anchor) anchor.before(block);
    const ctx = controller.context(), avatar = document.querySelector('#avatar_url_pole')?.value;
    const current = controller.supported(ctx) && (!avatar || avatar === ctx.characters[ctx.characterId]?.avatar);
    block.hidden = !controller.settings().enabled;
    const name = block.querySelector('.rpp-character-chat'), text = block.querySelector('textarea');
    block.querySelector('button').disabled = !current;
    if (!current) { name.textContent = '尚未打开此角色的单人聊天存档'; text.value = '打开对应存档后，这里会显示该存档的角色相处补充。'; return; }
    const state = controller.state(), items = usableItems(ctx.chat, state).filter(item => item.category === 'interaction');
    const candidates = state.profile.filter(item => item.category === 'interaction' && !item.enabled).length;
    name.textContent = `${ctx.chatId ?? ctx.getCurrentChatId()} · ${items.length} 条已启用${candidates ? ` · ${candidates} 条待确认（见偏好面板）` : ''}${state.enabled ? '' : ' · 当前暂停注入'}`;
    text.value = items.map(item => item.text).join('\n\n') || '此档还没有已启用的角色相处补充。可通过反馈分析，或在偏好面板手动添加。';
}

function renderFloors() {
    const ctx = controller.context();
    const active = controller.settings().enabled && controller.settings().feedbackMode === 'floors' && controller.supported(ctx);
    for (const floor of document.querySelectorAll('#chat .mes[mesid]')) {
        const index = Number(floor.getAttribute('mesid')), message = ctx.chat[index];
        let existing = floor.querySelector('.rpp-feedback');
        if (!active || !eligible(message)) { existing?.remove(); continue; }
        const revision = revisionOf(message), feedback = currentFeedback(message);
        const binding = existing && floorBindings.get(existing);
        if (!existing || binding?.chat !== ctx.chat || binding?.message !== message || existing.dataset.revision !== revision || existing.dataset.feedbackKey !== (feedback ? feedbackKey(feedback) : '') || existing.dataset.index !== String(index)) {
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
    if (!controller) return;
    if (!panel && !mountPanel()) return;
    if (renderedMetadata !== controller.context().chatMetadata) {
        renderedMetadata = controller.context().chatMetadata; itemDrafts.clear(); manualDrafts.clear();
        announce(controller.busy ? '已切换存档，上一次分析不会跨档应用。' : '当前存档已就绪。');
    }
    mountFloating();
    const settings = controller.settings();
    automaticOptions.hidden = !settings.autoAnalyze;
    analysisModeHelp.textContent = settings.autoAnalyze ? `保存即可：每累计 ${settings.threshold} 条新评价自动修订整份补充，包含角色、剧情与文笔。` : '自动分析已暂停，保存的评价仍会保留，开启后再按累计数量分析。';
    const waiting = controller.supported(controller.context()) ? pendingFeedback(controller.context().chat, controller.state()).length : 0;
    bulkAnalysisHelp.textContent = `待分析 ${waiting} 条 / 累计 ${settings.threshold} 条自动触发。每轮用新评价及对应正文修订上一版全部补充，包括你手动编辑的内容。`;
    choosePage(activePage);
    const floating = controller.settings().feedbackMode === 'floating';
    floatingButton.hidden = !controller.settings().enabled || !floating;
    if (floatingButton.hidden) closeFloating(false);
    workbench.querySelector('#rpp-floor-hint').textContent = floating ? '悬浮球模式：滚动到要评价的回复，点击悬浮球填写该楼层评价。' : '楼层模式：在角色回复下展开“反馈”填写。';
    renderProfile(); renderFloors(); renderCharacterSupplement();
    if (floating) renderFloatingFeedback(); else floatingFeedback.replaceChildren();
    floatingButton.setAttribute('aria-label', '评价当前浏览楼层');
    for (const control of workbench.querySelectorAll('[data-mutation]')) control.disabled = controller.busy || !controller.supported(controller.context());
    workbench.querySelector('#rpp-cancel').disabled = !controller.busy;
    workbench.querySelector('#rpp-cancel').hidden = !controller.busy;
}
function deferRefresh() { clearTimeout(renderTimer); renderTimer = setTimeout(() => controller?.refresh(), 60); }

export function initialize() {
    if (controller || !globalThis.SillyTavern?.getContext) return;
    controller = createController({ getContext: () => SillyTavern.getContext(), isGenerating: () => {
        if (typeof nativeHostState?.isGenerating === 'function') return nativeHostState.isGenerating();
        return typeof nativeHostState?.is_send_press === 'boolean' ? nativeHostState.is_send_press : undefined;
    }, notify: announce, changed: render,
        analyzer: (ctx, settings, prompt, options) => callAnalyzer(ctx, settings, prompt, { ...options, apiKey: options.apiKey || sessionApiKey }) });
    const settingsBeforeUpgrade = controller.settings();
    const upgradeAnalysis = !settingsBeforeUpgrade.analysisFlowVersion;
    Object.assign(controller.settings(), { ...DEFAULTS, ...settingsBeforeUpgrade });
    if (upgradeAnalysis) { controller.settings().autoAnalyze = true; controller.settings().analysisFlowVersion = 1; controller.context().saveSettingsDebounced(); }
    delete controller.settings().feedbackBatchSize;
    delete controller.settings().recentUserTurns; delete controller.settings().contextWindow;
    const ctx = controller.context(), types = ctx.eventTypes ?? ctx.event_types;
    function on(name, handler) { if (types?.[name]) { ctx.eventSource.on(types[name], handler); subscriptions.push([types[name], handler]); } }
    on('APP_READY', deferRefresh);
    on('GENERATION_STARTED', (...args) => controller.generationStarted(...args));
    on('GENERATION_ENDED', () => controller.generationEnded());
    on('GENERATION_STOPPED', () => controller.generationEnded());
    for (const name of ['CHAT_CHANGED', 'CHAT_LOADED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPE_DELETED', 'CHARACTER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED']) on(name, () => controller.refresh());
    on('CHAT_COMPLETION_PROMPT_READY', () => controller.inject());
    for (const name of ['CHARACTER_PAGE_LOADED', 'CHARACTER_EDITOR_OPENED', 'CHARACTER_EDITED']) on(name, () => controller.refresh());
    observer = new MutationObserver(records => {
        // Ignore our own UI mutations and streaming text. Watch host-added message nodes only.
        if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches?.('.mes[mesid], #chat, #extensions_settings2, #firstMessageWrapper, #first_message_div, #description_textarea') || node.querySelector?.('.mes[mesid], #firstMessageWrapper, #first_message_div'))))) deferRefresh();
    });
    window.addEventListener('resize', positionFloating);
    window.addEventListener('resize', viewportChanged);
    document.addEventListener('scroll', viewportChanged, true);
    document.addEventListener('click', focusReadingFloor);
    observer.observe(document.body, { childList: true, subtree: true }); controller.refresh();
    // Version adaptation: getContext is preferred; legacy hosts export the live flag here.
    import('/script.js').then(module => { nativeHostState = module; }).catch(() => {});
}

export function onDisable() {
    controller?.dispose(); observer?.disconnect(); clearTimeout(renderTimer);
    const ctx = controller?.context();
    for (const [type, handler] of subscriptions) ctx?.eventSource.removeListener(type, handler);
    subscriptions.length = 0;
    ctx?.setExtensionPrompt(KEY, '', 1, 0, false, 0);
    window.removeEventListener('resize', positionFloating);
    window.removeEventListener('resize', viewportChanged);
    document.removeEventListener('scroll', viewportChanged, true);
    document.removeEventListener('click', focusReadingFloor);
    clearTimeout(visibleFloorTimer);
    document.querySelectorAll('.rpp-feedback, #rpp-panel, #rpp-floating-button, #rpp-floating-window, #rpp-character-supplement').forEach(node => node.remove());
    panel = null; floatingButton = null; floatingWindow = null; floatingFeedback = null; floatingStatus = null; focusedFloor = null; controller = null; itemDrafts.clear(); manualDrafts.clear(); renderedMetadata = null;
}

export const onEnable = initialize;

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
