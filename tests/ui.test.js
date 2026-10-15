import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { KEY } from '../core.js';
import { VERSION } from '../updates.js';

test('实际插件界面：自动生效、可选编辑、署名与更新提示、切换存档、停用重启', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings2"></div><div id="chat"></div><form id="character-form"><div id="descriptionWrapper"><textarea id="description_textarea" name="description">原角色描述</textarea></div><div id="firstMessageWrapper"><div id="first_message_div">开场白</div><textarea id="firstmessage_textarea" name="first_mes">原开场白</textarea></div><input id="avatar_url_pole" type="hidden" value="test.png"></form></body>', { url: 'http://localhost/' });
    for (const name of ['window', 'document', 'MutationObserver']) globalThis[name] = dom.window[name];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: VERSION }) });
    const handlers = new Map();
    const eventTypes = Object.fromEntries(['APP_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED', 'MESSAGE_EDITED'].map(name => [name, name]));
    const eventSource = {
        on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
        removeListener(name, handler) { handlers.set(name, handlers.get(name).filter(fn => fn !== handler)); },
        emit(name) { for (const handler of handlers.get(name) ?? []) handler(); },
    };
    let calls = 0;
    const ctx = {
        characters: [{ name: '角色', avatar: 'test.png', data: { personality: '慢热' } }], characterId: 0, chatId: 'a',
        chat: [{ mes: '用户', is_user: true }, { mes: '回复' }], chatMetadata: {}, extensionSettings: {}, eventSource, eventTypes,
        streamingProcessor: { isStopped: false, isFinished: true },
        async saveChat() {}, saveSettingsDebounced() {}, setExtensionPrompt(key, text) { ctx.prompt = text; },
        async generateRaw({ prompt }) {
            calls++;
            const payload = JSON.parse(prompt);
            return JSON.stringify({ summary: '<img src=x onerror=alert(1)> 只是文字', categoryReports: { interaction: { status: 'insufficient', reason: '未反馈角色相处。' }, plot: { status: 'updated', reason: '希望推进慢一点。' }, expression: { status: 'insufficient', reason: '未反馈表达细节。' } }, items: [{ category: 'plot', text: '放慢剧情推进', confidence: 'tentative', sourceIds: payload.newFeedbackIds }] });
        },
    };
    globalThis.SillyTavern = { getContext: () => ({ ...ctx }) };
    let viewedIndex = 1;
    const rect = (top, bottom) => ({ top, bottom, left: 0, right: 600, width: 600, height: bottom - top });
    document.querySelector('#chat').getBoundingClientRect = () => rect(0, 600);
    function drawChat() {
        document.querySelector('#chat').innerHTML = ctx.chat.map((m, index) => `<div class="mes" mesid="${index}"><div class="mes_block"></div></div>`).join('');
        for (const floor of document.querySelectorAll('#chat .mes')) {
            const index = Number(floor.getAttribute('mesid'));
            floor.getBoundingClientRect = () => rect(100 + (index - viewedIndex) * 700, 500 + (index - viewedIndex) * 700);
        }
    }
    const scrollToFloor = async index => { viewedIndex = index; document.querySelector('#chat').dispatchEvent(new window.Event('scroll')); await new Promise(resolve => setTimeout(resolve, 100)); };
    const tick = () => new Promise(resolve => setTimeout(resolve, 15));
    const findButton = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
    let hostTabClicks = 0;
    document.addEventListener('click', event => {
        if (event.target.closest('[role=tab]')) { hostTabClicks++; document.querySelector('#rpp-main-overview').classList.add('rpp-is-active'); }
    });
    drawChat();
    const module = await import('../index.js');
    await tick();
    assert.equal(document.querySelector('#rpp-character-supplement').previousElementSibling.id, 'descriptionWrapper');
    assert.equal(document.querySelector('#rpp-character-supplement').nextElementSibling.id, 'firstMessageWrapper');
    assert.equal(document.querySelectorAll('.rpp-main-tabs [role=tab]').length, 4);
    assert.equal(document.querySelectorAll('.rpp-category-tabs [role=tab]').length, 3);
    assert.equal(document.querySelector('#rpp-page-overview').hidden, false);
    assert.equal(document.querySelector('#rpp-page-settings').hidden, true);
    document.querySelector('#rpp-main-prompts').click(); assert.equal(document.querySelector('#rpp-page-prompts').hidden, false);
    document.querySelector('#rpp-main-settings').click();
    assert.equal(document.querySelector('#rpp-main-settings').classList.contains('rpp-is-active'), true);
    assert.equal(document.querySelector('#rpp-main-overview').classList.contains('rpp-is-active'), false);
    assert.equal(document.querySelectorAll('.rpp-main-tabs .rpp-is-active').length, 1);
    assert.equal(hostTabClicks, 0);
    assert.equal(document.querySelector('#rpp-main-settings').classList.contains('menu_button'), false);
    assert.equal(document.querySelector('#rpp-main-settings').style.getPropertyPriority('background'), 'important');
    assert.equal(document.querySelector('#rpp-main-overview').style.background, 'transparent');
    assert.equal(document.querySelector('#rpp-main-overview').style.boxShadow, 'none');
    assert.equal(document.querySelector('#rpp-automatic-options').hidden, false);
    assert.equal(document.querySelector('.rpp-reading-options'), null);
    assert.equal(document.querySelector('.rpp-title').classList.contains('standoutHeader'), true);
    const auto = [...document.querySelectorAll('label')].find(label => label.textContent === '累计反馈后自动分析').querySelector('input');
    auto.checked = true; auto.dispatchEvent(new window.Event('change'));
    assert.equal(document.querySelector('#rpp-automatic-options').hidden, false);
    auto.checked = false; auto.dispatchEvent(new window.Event('change'));
    assert.equal(document.querySelector('#rpp-automatic-options').hidden, true);
    assert.equal([...document.querySelectorAll('label')].some(label => label.textContent.includes('每次最多处理')), false);
    document.querySelector('#rpp-main-overview').click();
    assert.equal(document.querySelectorAll('.rpp-feedback').length, 1);
    const feedback = document.querySelector('.rpp-feedback'); feedback.open = true;
    const rating = feedback.querySelector('select'); rating.value = '4'; rating.dispatchEvent(new window.Event('change'));
    const note = feedback.querySelector('textarea'); note.value = '这段希望慢一点'; note.dispatchEvent(new window.Event('input'));
    findButton('保存反馈').click(); await tick();
    assert.match(document.querySelector('.rpp-feedback summary').textContent, /已保存/);
    assert.equal(calls, 0);
    assert.equal(findButton('保存并分析'), undefined); assert.equal(findButton('分析并应用'), undefined);
    const threshold = [...document.querySelectorAll('label')].find(label => label.textContent === '每累计多少条新评价自动分析').nextElementSibling;
    threshold.value = '1'; threshold.dispatchEvent(new window.Event('change'));
    auto.checked = true; auto.dispatchEvent(new window.Event('change')); await tick();
    document.querySelector('#rpp-tab-plot').click();
    assert.equal(document.querySelector('#rpp-tab-interaction').classList.contains('rpp-is-active'), false);
    assert.equal(document.querySelector('#rpp-tab-plot').classList.contains('rpp-is-active'), true);
    assert.equal(calls, 1); assert.match(document.querySelector('.rpp-item-title').textContent, /已生效.*推测/);
    assert.match(ctx.prompt, /放慢剧情/);
    assert.equal(document.querySelector('.rpp-item-edit').open, false);
    assert.match(document.querySelector('.rpp-credit').textContent, /by-NUE-喵喵电波/);
    assert.match(document.querySelector('.rpp-version').textContent, new RegExp(VERSION.replaceAll('.', '\\.')));
    assert.equal(document.querySelector('.rpp-update-status').textContent, '暂无新版本');
    assert.doesNotMatch(document.querySelector('#rpp-profile-step').textContent, /待确认/);
    assert.equal(document.querySelectorAll('.rpp-analysis-summary img').length, 0);
    assert.equal(document.querySelector('.rpp-debug-console').open, false);
    findButton('打开调试台').click(); await tick();
    assert.equal(document.querySelector('#rpp-page-records').hidden, false);
    assert.equal(document.querySelector('.rpp-debug-console').open, true);
    const rawResponse = document.querySelector('textarea[aria-label="第 1 次 AI 原始返回"]');
    assert.match(rawResponse.value, /<img src=x onerror=alert\(1\)>/);
    assert.equal(rawResponse.readOnly, true);
    assert.equal(document.querySelectorAll('.rpp-debug-console img').length, 0);
    assert.match(document.querySelector('textarea[aria-label="第 1 次分析输入"]').value, /这段希望慢一点/);
    findButton('清空调试记录').click(); await tick();
    assert.match(document.querySelector('.rpp-debug-records').textContent, /本页尚无分析记录/);
    assert.match(ctx.prompt, /放慢剧情/);
    const enabled = document.querySelector('.rpp-item input'); enabled.checked = true; enabled.dispatchEvent(new window.Event('change'));
    findButton('保存修改').click(); await tick(); assert.match(ctx.prompt, /放慢剧情/);
    assert.equal(ctx.chatMetadata[KEY].profile[0].manual, true);
    document.querySelector('#rpp-tab-interaction').click();
    const manual = document.querySelector('.rpp-manual textarea'); manual.value = '用行动表达关心，不违背慢热人设。'; manual.dispatchEvent(new window.Event('input'));
    findButton('保存手动补充').click(); await tick();
    assert.match(document.querySelector('#rpp-character-supplement textarea').value, /用行动表达关心/);
    assert.equal(document.querySelector('#description_textarea').value, '原角色描述');
    assert.equal(document.querySelector('#firstmessage_textarea').value, '原开场白');
    assert.equal(document.querySelector('#rpp-character-supplement textarea').name, '');
    // Reuse identical DOM and reply text across chats: closure must bind new chat.
    const oldChat = ctx.chat;
    ctx.chat = [{ mes: '用户', is_user: true }, { mes: '回复' }]; ctx.chatMetadata = {}; ctx.chatId = 'b';
    eventSource.emit('CHAT_CHANGED'); await tick();
    assert.equal(ctx.prompt, '');
    assert.doesNotMatch(document.querySelector('#rpp-character-supplement textarea').value, /用行动表达关心/);
    assert.doesNotMatch(document.querySelector('.rpp-status').textContent, /当前应用 1/);
    const nextNote = document.querySelector('.rpp-feedback textarea'); nextNote.value = '新存档偏好'; nextNote.dispatchEvent(new window.Event('input'));
    findButton('保存反馈').click(); await tick();
    assert.equal(ctx.chat[1].extra[KEY].versions[Object.keys(ctx.chat[1].extra[KEY].versions)[0]].note, '新存档偏好');
    assert.notEqual(oldChat[1].extra[KEY].versions[Object.keys(oldChat[1].extra[KEY].versions)[0]].note, '新存档偏好');
    ctx.chat[1].mes = '重生成回复'; eventSource.emit('MESSAGE_SWIPED'); await tick();
    assert.doesNotMatch(document.querySelector('.rpp-feedback summary').textContent, /已保存/);
    assert.equal(document.querySelector('.rpp-feedback textarea').value, '');
    const entrance = document.querySelector('[name=rpp-feedback-mode][value=floating]');
    entrance.checked = true; entrance.dispatchEvent(new window.Event('change')); await tick();
    assert.equal(document.querySelectorAll('#chat .rpp-feedback').length, 0);
    assert.equal(document.querySelector('#rpp-floating-button').hidden, false);
    document.querySelector('#rpp-floating-button').click();
    document.querySelector('#rpp-main-overview').click();
    assert.equal(document.querySelector('#rpp-floating-window').hidden, false);
    assert.equal(document.querySelector('#rpp-floating-window .rpp-workbench'), null);
    assert.equal(document.querySelector('#rpp-panel .rpp-workbench') !== null, true);
    assert.equal(document.querySelector('#rpp-floating-window [role=tab]'), null);
    assert.match(document.querySelector('.rpp-floating-toolbar').textContent, /第 1 楼/);
    const floatNote = document.querySelector('.rpp-floating-feedback textarea'); floatNote.value = '悬浮球短评'; floatNote.dispatchEvent(new window.Event('input'));
    findButton('保存反馈').click(); await tick();
    assert.match(document.querySelector('.rpp-floating-feedback summary').textContent, /已保存/);
    const current = ctx.chat[1]; ctx.chat.push({ mes: '另一个回复' }); drawChat(); eventSource.emit('CHARACTER_MESSAGE_RENDERED'); await tick();
    assert.equal(document.querySelector('.rpp-floating-feedback textarea').value, '悬浮球短评'); // a new last reply must not steal the target
    await scrollToFloor(2);
    assert.equal(document.querySelector('.rpp-floating-feedback textarea').value, '');
    const unsaved = document.querySelector('.rpp-floating-feedback textarea'); unsaved.value = '未保存草稿'; unsaved.dispatchEvent(new window.Event('input'));
    await scrollToFloor(1);
    assert.equal(document.querySelector('.rpp-floating-feedback textarea').value, '悬浮球短评');
    assert.equal(ctx.chat[1], current);
    await scrollToFloor(2); assert.equal(document.querySelector('.rpp-floating-feedback textarea').value, '未保存草稿');
    await scrollToFloor(9999); assert.equal(document.querySelector('.rpp-floating-feedback textarea'), null);
    // The chat may contain 1000 floors while only floor 997 is being read.
    ctx.chat = Array.from({ length: 1000 }, (_, i) => ({ mes: `消息 ${i}`, is_user: i % 2 === 0 }));
    ctx.chatMetadata = {}; ctx.chatId = 'many'; viewedIndex = 997; drawChat(); eventSource.emit('CHAT_CHANGED'); await tick();
    assert.match(document.querySelector('.rpp-floating-toolbar').textContent, /第 997 楼/);
    const farNote = document.querySelector('.rpp-floating-feedback textarea'); farNote.value = '只评价 997'; farNote.dispatchEvent(new window.Event('input'));
    assert.equal([...document.querySelectorAll('.rpp-floating-feedback button')].some(b => b.textContent === '保存并分析'), false);
    [...document.querySelectorAll('.rpp-floating-feedback button')].find(b => b.textContent === '保存反馈').click(); await tick();
    assert.equal(ctx.chat[997].extra[KEY].versions[Object.keys(ctx.chat[997].extra[KEY].versions)[0]].note, '只评价 997');
    assert.equal(ctx.chat[999].extra, undefined);
    const longReply = ctx.chat[997], longText = longReply.mes;
    longReply.mes = '重生成的 997'; eventSource.emit('MESSAGE_SWIPED'); await tick();
    assert.equal(document.querySelector('.rpp-floating-feedback textarea').value, '');
    longReply.mes = longText; eventSource.emit('MESSAGE_SWIPED'); await tick();
    assert.equal(document.querySelector('.rpp-floating-feedback textarea').value, '只评价 997');
    document.querySelector('#rpp-floating-window').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.querySelector('#rpp-floating-window').hidden, true);
    assert.equal(document.querySelector('#rpp-panel .rpp-workbench') !== null, true);
    const ball = document.querySelector('#rpp-floating-button');
    function pointer(type, x, y) {
        const event = new window.Event(type, { bubbles: true }); Object.assign(event, { button: 0, pointerId: 1, clientX: x, clientY: y }); ball.dispatchEvent(event);
    }
    pointer('pointerdown', 900, 500); pointer('pointermove', 820, 500); pointer('pointerup', 820, 500);
    assert.equal(ctx.extensionSettings[KEY].floatingPosition.right, 98);
    ball.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }));
    assert.equal(document.querySelector('#rpp-floating-window').hidden, true);
    const floorEntrance = document.querySelector('[name=rpp-feedback-mode][value=floors]'); floorEntrance.checked = true; floorEntrance.dispatchEvent(new window.Event('change')); await tick();
    assert.equal(document.querySelector('#rpp-floating-button').hidden, true);
    assert.equal(document.querySelectorAll('#chat .rpp-feedback').length, 500);
    module.onDisable(); assert.equal(document.querySelector('#rpp-panel'), null); assert.equal(ctx.prompt, '');
    assert.equal(document.querySelector('#rpp-character-supplement'), null);
    assert.equal(document.querySelector('#rpp-floating-button'), null);
    module.onEnable(); await tick(); assert.equal(document.querySelectorAll('#rpp-panel').length, 1);
    assert.equal(document.querySelectorAll('.rpp-main-tabs .rpp-is-active').length, 1);
    module.onDisable(); globalThis.fetch = previousFetch; dom.window.close();
});
