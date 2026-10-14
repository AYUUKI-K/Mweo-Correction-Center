import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { KEY } from '../core.js';

test('实际插件界面：反馈保存、分析、候选确认、切换存档、无 HTML 注入、停用重启', async () => {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings2"></div><div id="chat"></div></body>', { url: 'http://localhost/' });
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
        async saveChat() {}, saveSettingsDebounced() {}, setExtensionPrompt(key, text) { ctx.prompt = text; },
        async generateRaw({ prompt }) {
            calls++;
            const payload = JSON.parse(prompt);
            return JSON.stringify({ summary: '<img src=x onerror=alert(1)> 只是文字', items: [{ category: 'plot', text: '放慢剧情推进', confidence: 'tentative', sourceIds: payload.newFeedbackIds }] });
        },
    };
    globalThis.SillyTavern = { getContext: () => ({ ...ctx }) };
    function drawChat() { document.querySelector('#chat').innerHTML = ctx.chat.map((m, index) => `<div class="mes" mesid="${index}"><div class="mes_block"></div></div>`).join(''); }
    const tick = () => new Promise(resolve => setTimeout(resolve, 15));
    const findButton = text => [...document.querySelectorAll('button')].find(node => node.textContent === text);
    drawChat();
    const module = await import('../index.js');
    await tick();
    assert.equal(document.querySelectorAll('.rpp-feedback').length, 1);
    const feedback = document.querySelector('.rpp-feedback'); feedback.open = true;
    const rating = feedback.querySelector('select'); rating.value = '4'; rating.dispatchEvent(new window.Event('change'));
    const note = feedback.querySelector('textarea'); note.value = '这段希望慢一点'; note.dispatchEvent(new window.Event('input'));
    findButton('保存反馈').click(); await tick();
    assert.match(document.querySelector('.rpp-feedback summary').textContent, /已保存/);
    assert.equal(calls, 0);
    findButton('分析并应用').click(); await tick();
    assert.equal(calls, 1); assert.match(document.querySelector('.rpp-item-title').textContent, /待确认/);
    assert.equal(ctx.prompt, '');
    assert.equal(document.querySelectorAll('.rpp-analysis-summary img').length, 0);
    const enabled = document.querySelector('.rpp-item input'); enabled.checked = true; enabled.dispatchEvent(new window.Event('change'));
    findButton('保存修改').click(); await tick(); assert.match(ctx.prompt, /放慢剧情/);
    assert.equal(ctx.chatMetadata[KEY].profile[0].manual, true);
    // Reuse identical DOM and reply text across chats: closure must bind new chat.
    const oldChat = ctx.chat;
    ctx.chat = [{ mes: '用户', is_user: true }, { mes: '回复' }]; ctx.chatMetadata = {}; ctx.chatId = 'b';
    eventSource.emit('CHAT_CHANGED'); await tick();
    assert.equal(ctx.prompt, '');
    const nextNote = document.querySelector('.rpp-feedback textarea'); nextNote.value = '新存档偏好'; nextNote.dispatchEvent(new window.Event('input'));
    findButton('保存反馈').click(); await tick();
    assert.equal(ctx.chat[1].extra[KEY].versions[Object.keys(ctx.chat[1].extra[KEY].versions)[0]].note, '新存档偏好');
    assert.notEqual(oldChat[1].extra[KEY].versions[Object.keys(oldChat[1].extra[KEY].versions)[0]].note, '新存档偏好');
    ctx.chat[1].mes = '重生成回复'; eventSource.emit('MESSAGE_SWIPED'); await tick();
    assert.doesNotMatch(document.querySelector('.rpp-feedback summary').textContent, /已保存/);
    assert.equal(document.querySelector('.rpp-feedback textarea').value, '');
    module.onDisable(); assert.equal(document.querySelector('#rpp-panel'), null); assert.equal(ctx.prompt, '');
    module.onEnable(); await tick(); assert.equal(document.querySelectorAll('#rpp-panel').length, 1);
    module.onDisable(); dom.window.close();
});
