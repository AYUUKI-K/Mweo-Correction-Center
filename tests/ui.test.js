import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { KEY } from '../core.js';

test('实际插件界面：反馈保存、分析、候选确认、切换存档、无 HTML 注入、停用重启', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings2"></div><div id="chat"></div><form id="character-form"><div id="descriptionWrapper"><textarea id="description_textarea" name="description">原角色描述</textarea></div><div id="firstMessageWrapper"><div id="first_message_div">开场白</div><textarea id="firstmessage_textarea" name="first_mes">原开场白</textarea></div><input id="avatar_url_pole" type="hidden" value="test.png"></form></body>', { url: 'http://localhost/' });
    for (const name of ['window', 'document', 'MutationObserver']) globalThis[name] = dom.window[name];
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
    function drawChat() { document.querySelector('#chat').innerHTML = ctx.chat.map((m, index) => `<div class="mes" mesid="${index}"><div class="mes_block"></div></div>`).join(''); }
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
    assert.equal(document.querySelector('#rpp-automatic-options').hidden, true);
    assert.equal(document.querySelector('.rpp-reading-options').open, false);
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
    findButton('分析并应用').click(); await tick();
    document.querySelector('#rpp-tab-plot').click();
    assert.equal(document.querySelector('#rpp-tab-interaction').classList.contains('rpp-is-active'), false);
    assert.equal(document.querySelector('#rpp-tab-plot').classList.contains('rpp-is-active'), true);
    assert.equal(calls, 1); assert.match(document.querySelector('.rpp-item-title').textContent, /待确认/);
    assert.equal(ctx.prompt, '');
    assert.equal(document.querySelectorAll('.rpp-analysis-summary img').length, 0);
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
    const entrance = document.querySelector('#rpp-page-settings select');
    entrance.value = 'floating'; entrance.dispatchEvent(new window.Event('change')); await tick();
    assert.equal(document.querySelectorAll('#chat .rpp-feedback').length, 0);
    assert.equal(document.querySelector('#rpp-floating-button').hidden, false);
    document.querySelector('#rpp-floating-button').click();
    document.querySelector('#rpp-main-overview').click();
    assert.equal(document.querySelector('#rpp-floating-window').hidden, false);
    assert.equal(document.querySelector('#rpp-floating-window .rpp-workbench') !== null, true);
    const floatNote = document.querySelector('.rpp-floating-feedback textarea'); floatNote.value = '悬浮球短评'; floatNote.dispatchEvent(new window.Event('input'));
    findButton('保存反馈').click(); await tick();
    assert.match(document.querySelector('.rpp-floating-feedback summary').textContent, /已保存/);
    const current = ctx.chat[1]; ctx.chat.push({ mes: '另一个回复' }); drawChat(); eventSource.emit('CHARACTER_MESSAGE_RENDERED'); await tick();
    assert.equal(document.querySelector('.rpp-floating-feedback textarea').value, '');
    const chooser = document.querySelector('#rpp-floating-fields select'); chooser.value = '1'; chooser.dispatchEvent(new window.Event('change'));
    assert.equal(document.querySelector('.rpp-floating-feedback textarea').value, '悬浮球短评');
    assert.equal(ctx.chat[1], current);
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
    entrance.value = 'floors'; entrance.dispatchEvent(new window.Event('change')); await tick();
    assert.equal(document.querySelector('#rpp-floating-button').hidden, true);
    assert.equal(document.querySelectorAll('#chat .rpp-feedback').length, 2);
    module.onDisable(); assert.equal(document.querySelector('#rpp-panel'), null); assert.equal(ctx.prompt, '');
    assert.equal(document.querySelector('#rpp-character-supplement'), null);
    assert.equal(document.querySelector('#rpp-floating-button'), null);
    module.onEnable(); await tick(); assert.equal(document.querySelectorAll('#rpp-panel').length, 1);
    assert.equal(document.querySelectorAll('.rpp-main-tabs .rpp-is-active').length, 1);
    module.onDisable(); dom.window.close();
});
