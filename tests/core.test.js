import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, DEFAULTS, newState, normalizeFeedback, revisionOf, currentFeedback, activeFeedback, buildInjection, parseResult, analysisInput, pendingFeedback, feedbackKey, migrateState } from '../core.js';
import { createController } from '../controller.js';
import { callAnalyzer, completionUrl } from '../api.js';
import { prepareRegexText } from '../text.js';
import { presentProfile } from '../core.js';

function host() {
    const ctx = {
        chatId: 'save-a', characterId: 0, groupId: null,
        characters: [{ avatar: 'char.png', name: '测试角色', data: { description: '性格慢热，关心时克制。', personality: '慢热' } }],
        chat: [{ mes: '我有点冷。', is_user: true }, { mes: '他把围巾放到你旁边。', name: '测试角色', swipe_id: 0 }],
        chatMetadata: {}, extensionSettings: { [KEY]: { ...DEFAULTS, autoAnalyze: false } },
        async saveChat() {}, saveSettingsDebounced() {},
        setExtensionPrompt(key, text, position, depth, scan, role) { this.injection = { key, text, position, depth, scan, role }; },
    };
    let current = ctx;
    const messages = [];
    return { ctx, messages, switchChat: next => { current = next; }, make: analyzer => createController({ getContext: () => current, notify: (...args) => messages.push(args), analyzer }) };
}
const reports = { interaction: { status: 'updated', reason: '有互动方式反馈。' }, plot: { status: 'insufficient', reason: '没有剧情走向证据。' }, expression: { status: 'insufficient', reason: '没有表达习惯证据。' } };
const result = (id, confidence = 'explicit') => JSON.stringify({ summary: '用户喜欢克制的关心。', categoryReports: reports, items: [{ category: 'interaction', text: '用细微行动表达关心。', confidence, sourceIds: [id] }] });

test('反馈随消息移动；切换/编辑回复后只认当前版本，回来可恢复', () => {
    const reply = { mes: '旧回复', swipe_id: 0 };
    const oldRevision = revisionOf(reply), feedback = normalizeFeedback({ plot: 4, note: '喜欢' });
    reply.extra = { [KEY]: { versions: { [oldRevision]: feedback } } };
    assert.equal(activeFeedback([{ mes: '插入', is_user: true }, reply])[0].index, 1);
    reply.mes = '新回复'; reply.swipe_id = 1; assert.equal(currentFeedback(reply), null);
    reply.mes = '旧回复'; reply.swipe_id = 0; assert.equal(currentFeedback(reply).id, feedback.id);
    reply.mes = '编辑后'; assert.equal(currentFeedback(reply), null);
});

test('单次评分不能成为可靠偏好；错误来源或 JSON 不改变状态', () => {
    const evidence = [{ id: 'f1', index: 1, note: '' }];
    for (const confidence of ['explicit', 'repeated']) {
        const item = parseResult(result('f1', confidence), evidence).items[0];
        assert.equal(item.confidence, 'tentative'); assert.equal(item.enabled, true);
    }
    assert.throws(() => parseResult(result('invented'), evidence), /来源/);
    assert.throws(() => parseResult('not json', evidence), /JSON/);
    assert.throws(() => normalizeFeedback({ plot: 9 }), /1～5/);
    assert.throws(() => normalizeFeedback({}), /至少/);
});

test('补充绑定存档、保留人设边界，旧反馈失效立即移除注入', async () => {
    const h = host(), original = structuredClone(h.ctx.characters);
    const ctl = h.make(async () => result(currentFeedback(h.ctx.chat[1]).id));
    await ctl.saveFeedback(1, { plot: 5, note: '喜欢动作关心，别突然表白。' });
    await ctl.analyze();
    assert.match(h.ctx.injection.text, /细微行动/);
    assert.match(h.ctx.injection.text, /以原人设为准/);
    assert.equal(h.ctx.injection.scan, false);
    assert.deepEqual(h.ctx.characters, original);
    assert.equal(h.ctx.chat.length, 2);
    h.ctx.chat[1].mes = '新的版本'; ctl.refresh(); assert.equal(h.ctx.injection.text, '');
    const second = { ...h.ctx, chatId: 'save-b', chatMetadata: {}, chat: [{ mes: '另一存档' }] };
    h.switchChat(second); ctl.refresh(); assert.equal(second.injection.text, ''); assert.deepEqual(ctl.state().profile, []);
});

test('分析时切换存档不串写；取消后保留待分析反馈', async () => {
    let finish;
    const h = host(), ctl = h.make(() => new Promise(resolve => { finish = resolve; }));
    await ctl.saveFeedback(1, { note: '慢一点' });
    const feedbackId = currentFeedback(h.ctx.chat[1]).id;
    const promise = ctl.analyze();
    assert.equal(ctl.busy, true);
    const second = { ...h.ctx, chatId: 'save-b', chatMetadata: {}, chat: [] };
    h.switchChat(second); ctl.refresh(); finish(result(feedbackId)); await promise;
    assert.equal(h.ctx.chatMetadata[KEY].profile.length, 0);
    assert.equal(second.chatMetadata[KEY].profile.length, 0);
    h.switchChat(h.ctx); ctl.refresh(); assert.equal(ctl.state().consumed.length, 0);
});

test('分析期间原回复被修改，结果不能应用；请求结束前不能重复分析', async () => {
    let finish;
    const h = host(), ctl = h.make(() => new Promise(resolve => { finish = resolve; }));
    await ctl.saveFeedback(1, { note: '喜欢' });
    const id = currentFeedback(h.ctx.chat[1]).id;
    const promise = ctl.analyze();
    await assert.rejects(ctl.analyze(), /正在进行/);
    h.ctx.chat[1].mes = '编辑回复'; finish(result(id)); await promise;
    assert.equal(ctl.state().profile.length, 0); assert.equal(ctl.busy, false);
});

test('保存失败回滚评分和偏好；无效楼层不会永久锁住插件', async () => {
    const h = host(), ctl = h.make(async () => result(currentFeedback(h.ctx.chat[1]).id));
    await assert.rejects(ctl.saveFeedback(999, { note: '测试' }), /有效/);
    assert.equal(ctl.busy, false);
    h.ctx.saveChat = async () => { throw new Error('断网'); };
    await assert.rejects(ctl.saveFeedback(1, { note: '测试' }), /断网/);
    assert.equal(currentFeedback(h.ctx.chat[1]), null);
    h.ctx.saveChat = async () => {};
    await ctl.saveFeedback(1, { note: '测试' });
    h.ctx.saveChat = async () => false;
    await assert.rejects(ctl.analyze(), /保存失败/);
    assert.equal(ctl.state().profile.length, 0); assert.equal(ctl.state().consumed.length, 0);
});

test('无效模型输出可以重试；新版整体替换用户编辑补充，撤销可恢复上一版', async () => {
    const h = host(); let bad = true;
    const ctl = h.make(async () => bad ? 'broken' : result(currentFeedback(h.ctx.chat[1]).id));
    await ctl.saveFeedback(1, { note: '用行动关心' });
    await assert.rejects(ctl.analyze(), /JSON/); assert.equal(ctl.state().consumed.length, 0);
    bad = false; await ctl.analyze();
    const id = ctl.state().profile[0].id;
    await ctl.editItem(id, '用户确认的补充', true);
    await ctl.saveFeedback(1, { note: '节奏放慢' }); await ctl.analyze();
    assert.equal(ctl.state().profile[0].text, '用细微行动表达关心。');
    await ctl.clearProfile(); assert.equal(h.ctx.injection.text, '');
    await ctl.undo(); assert.match(h.ctx.injection.text, /细微行动/);
    await ctl.setChatEnabled(false); assert.equal(h.ctx.injection.text, '');
});

test('评价与对应楼层正文绑定，不夹带附近消息或聊天末尾无关文本', () => {
    const h = host(), feedback = normalizeFeedback({ plot: 5 });
    h.ctx.chat[1].extra = { [KEY]: { versions: { [revisionOf(h.ctx.chat[1])]: feedback } } };
    h.ctx.chat.push(...Array.from({ length: 30 }, (_, i) => ({ mes: `后续 ${i}`, is_user: i % 2 === 0 })));
    const data = JSON.parse(analysisInput(h.ctx, newState(), { ...DEFAULTS, contextWindow: 2, recentUserTurns: 50 }).prompt);
    assert.deepEqual(data.transcript, [{ feedbackId: feedback.id, floor: 1, speaker: 'char', text: h.ctx.chat[1].mes }]);
    assert.equal(data.feedback[0].id, feedback.id);
});

test('自定义 API 请求结构、错误处理、密钥不进入分析数据', async () => {
    assert.equal(completionUrl('https://api.example/v1/'), 'https://api.example/v1/chat/completions');
    assert.equal(completionUrl('http://localhost:8080/v1/chat/completions'), 'http://localhost:8080/v1/chat/completions');
    assert.throws(() => completionUrl('javascript:alert(1)'), /HTTP/);
    const settings = { apiMode: 'custom', endpoint: 'https://api.example/v1', model: 'test-model' };
    const output = await callAnalyzer({}, settings, '反馈数据', { apiKey: 'test-key', fetchImpl: async (url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer test-key');
        assert.equal(init.credentials, 'omit');
        const body = JSON.parse(init.body);
        assert.equal(body.stream, false); assert.equal(body.messages[1].content, '反馈数据');
        assert.equal(init.body.includes('test-key'), false);
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    } });
    assert.equal(output, '{}');
    await assert.rejects(callAnalyzer({}, settings, '', { fetchImpl: async () => ({ ok: false, status: 401 }) }), /401/);
});

test('普通生成期间不发起分析，群聊不注入', async () => {
    const h = host(), ctl = h.make(async () => { throw new Error('不应调用'); });
    await ctl.saveFeedback(1, { plot: 4 });
    ctl.generationStarted(); await assert.rejects(ctl.analyze(), /生成完成/); ctl.generationEnded();
    h.ctx.groupId = 'group'; ctl.refresh(); assert.equal(h.ctx.injection.text, '');
    await assert.rejects(ctl.analyze(), /单人/);
});

test('兼容 1.12.x 主 API 的位置参数及新版对象参数，不调整共享回复长度', async () => {
    let legacy, modern;
    await callAnalyzer({ generateRaw: async function (prompt, api, instructOverride, quietToLoud, systemPrompt, responseLength) {
        legacy = { prompt, systemPrompt, responseLength }; return '{}';
    } }, { apiMode: 'main' }, '测试数据');
    assert.equal(legacy.prompt, '测试数据'); assert.match(legacy.systemPrompt, /不续写/); assert.equal(legacy.responseLength, null);
    await callAnalyzer({ generateRaw: async function ({ prompt, systemPrompt, responseLength }) {
        modern = { prompt, systemPrompt, responseLength }; return '{}';
    } }, { apiMode: 'main' }, '测试数据');
    assert.equal(modern.prompt, '测试数据'); assert.equal(modern.responseLength, undefined);
});

test('自动分析累计阈值只触发一次；删掉的同文字偏好不会重新出现', async () => {
    const h = host(); let calls = 0;
    const ctl = h.make(async (ctx, settings, prompt) => {
        calls++; const input = JSON.parse(prompt);
        return result(input.newFeedbackIds[0]);
    });
    ctl.settings().autoAnalyze = true;
    for (let i = 0; i < 3; i++) {
        if (i > 0) h.ctx.chat.push({ mes: `用户 ${i}`, is_user: true }, { mes: `回复 ${i}` });
        await ctl.saveFeedback(i * 2 + 1, { note: '通过行动关心' });
    }
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1); assert.equal(ctl.state().consumed.length, 3);
    await ctl.deleteItem(ctl.state().profile[0].id);
    await ctl.saveFeedback(1, { note: '再试一次' }); await ctl.analyze();
    assert.equal(ctl.state().profile.length, 0);
    ctl.settings().autoAnalyze = false;
});

test('自动分析积压仍只处理 N 条，楼层手动分析不会顺带消耗其他评价', async () => {
    const h = host(), payloads = [];
    const ctl = h.make(async (ctx, settings, prompt) => {
        const payload = JSON.parse(prompt); payloads.push(payload);
        return result(payload.newFeedbackIds[0]);
    });
    for (let i = 0; i < 5; i++) {
        if (i) h.ctx.chat.push({ mes: `user ${i}`, is_user: true }, { mes: `char ${i}` });
        await ctl.saveFeedback(i * 2 + 1, { note: '希望更克制' });
    }
    ctl.settings().threshold = 3; ctl.settings().feedbackBatchSize = 1;
    await ctl.analyze({ automatic: true });
    assert.deepEqual(payloads[0].feedback.map(f => f.index), [1, 3, 5]);
    assert.equal(ctl.state().consumed.length, 3);
    const target = currentFeedback(h.ctx.chat[7]).id;
    await ctl.analyze({ feedbackIds: [target] });
    assert.deepEqual(payloads[1].newFeedbackIds, [target]);
    assert.deepEqual(pendingFeedback(h.ctx.chat, ctl.state()).map(f => f.index), [9]);
});

test('手动角色相处补充仅写当前档，可撤销，角色描述及开场白不变', async () => {
    const h = host(); h.ctx.characters[0].data.first_mes = '原开场白';
    const original = structuredClone(h.ctx.characters);
    const ctl = h.make();
    await ctl.addItem('interaction', '通过行动关心，保持慢热。');
    assert.match(h.ctx.injection.text, /通过行动关心/);
    assert.equal(ctl.state().profile[0].manual, true);
    assert.deepEqual(h.ctx.characters, original);
    await ctl.undo(); assert.equal(h.ctx.injection.text, '');
    await assert.rejects(ctl.addItem('unknown', '无效'), /补充/);
});

test('停用插件后正在进行的分析不能重新恢复提示词注入', async () => {
    const h = host(); let finish;
    const ctl = h.make(() => new Promise(resolve => { finish = resolve; }));
    await ctl.addItem('interaction', '用户确认的相处方式');
    await ctl.saveFeedback(1, { note: '喜欢' });
    const id = currentFeedback(h.ctx.chat[1]).id, pending = ctl.analyze();
    ctl.dispose(); assert.equal(h.ctx.injection.text, '');
    finish(result(id)); await pending;
    assert.equal(h.ctx.injection.text, '');
    await assert.rejects(ctl.addItem('plot', '不应保存'), /停用/);
});

test('正常结束的流式回复保持 isStopped=false 时仍可保存反馈及分析', async () => {
    const h = host(), ctl = h.make(async () => result(currentFeedback(h.ctx.chat[1]).id));
    h.ctx.streamingProcessor = { isStopped: false, isFinished: true };
    ctl.generationStarted(); // even an unmatched old start cannot override terminal stream state
    await ctl.saveFeedback(1, { plot: 5, character: 3, note: '希望少一点黏人' });
    assert.equal(currentFeedback(h.ctx.chat[1]).character, 3);
    await ctl.analyze(); assert.equal(ctl.state().profile.length, 1);
});

test('dry-run 不锁定保存，不取消正在进行的偏好分析', async () => {
    const h = host(); let finish;
    const ctl = h.make(() => new Promise(resolve => { finish = resolve; }));
    ctl.generationStarted('normal', {}, true);
    await ctl.saveFeedback(1, { note: '喜欢' });
    const id = currentFeedback(h.ctx.chat[1]).id, pending = ctl.analyze();
    ctl.generationStarted('normal', {}, true);
    finish(result(id)); await pending;
    assert.equal(ctl.state().profile.length, 1);
});

test('真实生成仍阻止保存和分析；live host 空闲信号解除遗留事件锁', async () => {
    const h = host(); let generating = false;
    const ctl = createController({ getContext: () => h.ctx, isGenerating: () => generating });
    await ctl.saveFeedback(1, { note: '喜欢' });
    generating = true; ctl.generationStarted();
    await assert.rejects(ctl.saveFeedback(1, { plot: 5 }), /生成完成/);
    await assert.rejects(ctl.analyze(), /生成完成/);
    generating = false; // early aborted generation has no GENERATION_ENDED
    await ctl.saveFeedback(1, { plot: 5 }); assert.equal(currentFeedback(h.ctx.chat[1]).plot, 5);
});

test('加载插件时流仍在输出，缺少 host live 接口也不能提前保存', async () => {
    const h = host(), ctl = h.make();
    h.ctx.streamingProcessor = { isStopped: false, isFinished: false };
    await assert.rejects(ctl.saveFeedback(1, { plot: 5 }), /生成完成/);
    h.ctx.streamingProcessor.isFinished = true;
    await ctl.saveFeedback(1, { plot: 5 }); assert.equal(currentFeedback(h.ctx.chat[1]).plot, 5);
});

test('相同评价不重存、不重分析，修改保留 ID，每个内容版本只处理一次', async () => {
    const h = host(); let calls = 0, saves = 0;
    h.ctx.saveChat = async () => { saves++; };
    const ctl = h.make(async () => { calls++; return result(currentFeedback(h.ctx.chat[1]).id); });
    const original = { plot: 5, character: 3, note: '保持慢热' };
    await ctl.saveFeedback(1, original); const id = currentFeedback(h.ctx.chat[1]).id;
    await ctl.analyze(); const saved = saves;
    await ctl.saveFeedback(1, original); assert.equal(saves, saved);
    await assert.rejects(ctl.analyze(), /没有新的/); assert.equal(calls, 1);
    await ctl.saveFeedback(1, { ...original, note: '关心更主动一点' });
    assert.equal(currentFeedback(h.ctx.chat[1]).id, id);
    assert.equal(h.ctx.injection.text, ''); // old conclusion cannot follow an edited rating
    await ctl.analyze(); assert.equal(calls, 2);
    await ctl.saveFeedback(1, original); await assert.rejects(ctl.analyze(), /没有新的/);
    assert.equal(ctl.state().consumed.length, 2);
});

test('切回旧回复、删除后重加、撤销和清空不会让已处理评价重新进入队列', async () => {
    const h = host(), ctl = h.make(async () => result(currentFeedback(h.ctx.chat[1]).id));
    const input = { note: '保持慢热' }, reply = h.ctx.chat[1], oldText = reply.mes;
    await ctl.saveFeedback(1, input); const id = currentFeedback(reply).id; await ctl.analyze();
    reply.mes = '另一个回复'; reply.swipe_id = 1; ctl.refresh();
    reply.mes = oldText; reply.swipe_id = 0; ctl.refresh();
    assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 0);
    await ctl.removeFeedback(1); await ctl.saveFeedback(1, input);
    assert.equal(currentFeedback(reply).id, id); await assert.rejects(ctl.analyze(), /没有新的/);
    await ctl.undo(); assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 0);
    await ctl.clearProfile(); assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 0);
});

test('自动累计数就是批次大小，旧范围设置不影响评价与楼层绑定', async () => {
    const h = host(), ctl = h.make();
    for (let i = 0; i < 4; i++) {
        if (i) h.ctx.chat.push({ mes: `user ${i}`, is_user: true }, { mes: `char ${i}` });
        await ctl.saveFeedback(i * 2 + 1, { note: `偏好 ${i}` });
    }
    const settings = { ...DEFAULTS, recentUserTurns: 2, threshold: 1, feedbackBatchSize: 1 };
    assert.equal(analysisInput(h.ctx, ctl.state(), settings).pending.length, 4); // ignore old range and cap
    const targeted = analysisInput(h.ctx, ctl.state(), settings, { feedbackIds: [currentFeedback(h.ctx.chat[1]).id] });
    assert.deepEqual(targeted.pending.map(f => f.index), [1]);
    assert.equal(JSON.parse(targeted.prompt).transcript[0].text, h.ctx.chat[1].mes);
    const first = analysisInput(h.ctx, ctl.state(), settings, { automatic: true }), payload = JSON.parse(first.prompt);
    assert.equal(payload.feedback.length, 1); assert.equal(payload.feedback[0].index, 1);
    assert.equal(first.pending.length, 1);
    ctl.state().consumed.push(feedbackKey(first.pending[0]));
    assert.throws(() => analysisInput(h.ctx, ctl.state(), { ...settings, threshold: 4 }, { automatic: true }), /尚未累计/);
    const next = analysisInput(h.ctx, ctl.state(), settings, { automatic: true });
    assert.equal(next.pending[0].index, 3);
    ctl.state().consumed.push(feedbackKey(next.pending[0]));
    assert.equal(analysisInput(h.ctx, ctl.state(), settings).pending.length, 2);
    assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 2);
});

test('增量分析携带上次完整结论，只发送新评价；保留旧来源的结论可以更新', async () => {
    const h = host(); const payloads = [];
    const ctl = h.make(async (ctx, settings, prompt) => {
        const payload = JSON.parse(prompt); payloads.push(payload);
        if (!payload.previousAnalysis) return result(payload.newFeedbackIds[0]);
        const data = JSON.parse(result(payload.newFeedbackIds[0], 'repeated'));
        data.items[0].sourceIds = [payload.previousAnalysis.items[0].sourceIds[0], payload.newFeedbackIds[0]];
        return JSON.stringify(data);
    });
    await ctl.saveFeedback(1, { note: '保持克制' }); const oldId = currentFeedback(h.ctx.chat[1]).id;
    await ctl.analyze();
    h.ctx.chat.push({ is_user: true, mes: '下一轮' }, { mes: '下一轮角色回复' });
    await ctl.saveFeedback(3, { note: '还喜欢克制的关心' }); await ctl.analyze();
    const incremental = payloads[1];
    assert.equal(incremental.feedback.length, 1); assert.notEqual(incremental.feedback[0].id, oldId);
    assert.equal(incremental.previousAnalysis.summary, '用户喜欢克制的关心。');
    assert.equal(incremental.previousAnalysis.items[0].sourceIds[0], oldId);
    assert.equal(ctl.state().profile[0].sourceKeys.length, 2); assert.equal(ctl.state().consumed.length, 2);
    assert.equal(ctl.state().lastAnalysis.newFeedbackKeys.length, 1);
});

test('旧版处理 ID 迁移不重复，编辑旧评价仍能产生一个新版本', async () => {
    const h = host(), f = normalizeFeedback({ note: '旧偏好' });
    h.ctx.chat[1].extra = { [KEY]: { versions: { [revisionOf(h.ctx.chat[1])]: f } } };
    h.ctx.chatMetadata[KEY] = { ...newState(), version: 1, consumed: [f.id] };
    const ctl = h.make();
    assert.equal(ctl.state().version, 3); assert.equal(ctl.state().consumed[0], feedbackKey(f));
    assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 0);
    await ctl.saveFeedback(1, { note: '修改后的偏好' });
    assert.equal(currentFeedback(h.ctx.chat[1]).id, f.id);
    assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 1);
});

test('三类说明完整才应用结果，没有相关证据可以保持空分类', async () => {
    const h = host(), data = JSON.parse(result('f1'));
    const parsed = parseResult(JSON.stringify(data), [{ id: 'f1', index: 1, note: '互动反馈' }]);
    assert.equal(parsed.categoryReports.plot.status, 'insufficient');
    assert.equal(parsed.items.filter(item => item.category === 'plot').length, 0);
    delete data.categoryReports.expression;
    assert.throws(() => parseResult(JSON.stringify(data), [{ id: 'f1', note: '互动反馈' }]), /三类/);
});

test('注入使用单一修正 XML 根节点，内容中的 XML 符号不会逃出包裹', async () => {
    const h = host(), ctl = h.make();
    await ctl.addItem('expression', '偏好 <短句> & 动作，也不要写 </修正>。');
    assert.equal(h.ctx.injection.text.startsWith('<修正>\n'), true);
    assert.equal(h.ctx.injection.text.endsWith('\n</修正>'), true);
    assert.match(h.ctx.injection.text, /&lt;短句&gt; &amp;/);
    assert.equal((h.ctx.injection.text.match(/<\/修正>/g) ?? []).length, 1);
});

test('123 自动得到 A，456 加完整 A 得到 B；B 整体替换且可改删用户编辑条目', async () => {
    const h = host(), payloads = [];
    const ctl = h.make(async (ctx, settings, prompt) => {
        const p = JSON.parse(prompt); payloads.push(p);
        const first = !p.previousAnalysis;
        return JSON.stringify({ summary: first ? 'A：三类偏好初稿' : 'B：改相处，删剧情，保留表达', categoryReports: reports, items: first ? [
            { category: 'interaction', text: 'A 相处', confidence: 'explicit', sourceIds: p.newFeedbackIds },
            { category: 'plot', text: 'A 剧情候选', confidence: 'tentative', sourceIds: p.newFeedbackIds },
            { category: 'expression', text: 'A 文笔候选', confidence: 'tentative', sourceIds: p.newFeedbackIds },
        ] : [
            { category: 'interaction', text: 'B 相处：主动但克制', confidence: 'explicit', sourceIds: p.newFeedbackIds, previousItemIds: [p.previousAnalysis.items.find(x => x.category === 'interaction').id] },
            { category: 'expression', text: 'A 文笔候选', confidence: 'tentative', sourceIds: [], previousItemIds: [p.previousAnalysis.items.find(x => x.category === 'expression').id] },
        ] });
    });
    ctl.settings().autoAnalyze = true;
    const submitRound = async start => {
        for (let n = start; n < start + 3; n++) {
            if (n > 1) h.ctx.chat.push({ is_user: true, mes: `user ${n}` }, { mes: `回复 ${n}` });
            await ctl.saveFeedback(h.ctx.chat.length - 1, { plot: 4, character: 5, note: `评价 ${n}` });
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    };
    await submitRound(1);
    assert.equal(payloads.length, 1); assert.equal(ctl.state().profile.length, 3);
    await ctl.editItem(ctl.state().profile.find(x => x.category === 'interaction').id, '用户改过的 A 相处', true);
    await ctl.addItem('plot', '用户手动添加但允许 AI 删除');
    const a = structuredClone(ctl.state().profile);
    await submitRound(4);
    assert.equal(payloads.length, 2);
    assert.deepEqual(payloads[1].feedback.map(x => x.note), ['评价 4', '评价 5', '评价 6']);
    assert.equal(payloads[1].previousAnalysis.items.length, 4);
    assert.equal(payloads[1].previousAnalysis.items.every(x => x.editable), true);
    assert.equal(payloads[1].previousAnalysis.items.find(x => x.category === 'interaction').text, '用户改过的 A 相处');
    assert.equal(payloads[1].confirmedPreferences, undefined);
    assert.deepEqual(ctl.state().profile.map(x => x.text), ['B 相处：主动但克制', 'A 文笔候选']);
    assert.equal(ctl.state().profile[1].enabled, true);
    assert.equal(ctl.state().profile[1].sourceIds.length, 3);
    assert.equal(ctl.state().consumed.length, 6);
    await ctl.undo(); assert.deepEqual(ctl.state().profile, a);
    assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 0);
});

test('无评分来源的用户补充可通过历史 ID 保留，伪造历史来源会拒绝，失败保留 A', async () => {
    const h = host(); let invalid = false;
    const ctl = h.make(async (ctx, settings, prompt) => {
        const p = JSON.parse(prompt), old = p.previousAnalysis.items[0];
        return JSON.stringify({ summary: '保留用户补充', categoryReports: reports, items: [{ category: old.category, text: old.text, confidence: 'explicit', sourceIds: [], previousItemIds: [invalid ? '不存在的历史条目' : old.id] }] });
    });
    await ctl.addItem('expression', '减少空泛抒情');
    await ctl.saveFeedback(1, { note: '继续保持' }); await ctl.analyze();
    assert.match(h.ctx.injection.text, /减少空泛抒情/);
    assert.equal(ctl.state().profile[0].userAnchored, true);
    const previous = structuredClone(ctl.state().profile);
    h.ctx.chat.push({ mes: 'user', is_user: true }, { mes: '新回复' });
    await ctl.saveFeedback(3, { note: '新评价' }); invalid = true;
    await assert.rejects(ctl.analyze(), /反馈来源或历史条目 ID 不存在/);
    assert.deepEqual(ctl.state().profile, previous);
    assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 1);
});

test('旧候选自动生效，手动停用保留，历史快照同步迁移且不重复分析', async () => {
    const h = host(), ctl = h.make(async () => result(currentFeedback(h.ctx.chat[1]).id, 'tentative'));
    await ctl.saveFeedback(1, { plot: 5 }); await ctl.analyze();
    const old = ctl.state(); old.version = 2; old.profile[0].enabled = false;
    old.profile.push({ id: 'paused', category: 'plot', text: '手动停用', confidence: 'manual', manual: true, sourceIds: [], enabled: false });
    old.history = [{ profile: structuredClone(old.profile) }];
    const migrated = migrateState(h.ctx.chat, old);
    assert.equal(migrated.profile[0].enabled, true); assert.equal(migrated.profile[1].enabled, false);
    assert.equal(migrated.history[0].profile[0].enabled, true);
    assert.match(buildInjection(h.ctx.chat, migrated), /细微行动/);
    assert.doesNotMatch(buildInjection(h.ctx.chat, migrated), /手动停用/);
    assert.equal(pendingFeedback(h.ctx.chat, migrated).length, 0);
});

test('旧手动条目原样返回可保留；来源字段只接受已知精确 ID', () => {
    const previous = [{ id: 'old-item', category: 'expression', text: '减少空泛抒情', manual: true, confidence: 'manual', enabled: false, sourceIds: [] }];
    const data = { summary: '保留旧条目', categoryReports: reports, items: [{ ...previous[0], sourceIds: [] }] };
    const parsed = parseResult(JSON.stringify(data), [], { previousItems: previous });
    assert.equal(parsed.items[0].userAnchored, true);
    assert.equal(parsed.items[0].confidence, 'manual');
    assert.equal(parsed.items[0].enabled, false);
    data.items[0] = { category: '表达细节', text: '减少空泛抒情', confidence: 'manual', sourceIds: 'old-item', previousItemIds: 'new-feedback' };
    const swapped = parseResult(JSON.stringify(data), [{ id: 'new-feedback', note: '少一点抒情' }], { previousItems: previous });
    assert.deepEqual(swapped.items[0].sourceIds, ['new-feedback']);
    data.items[0].sourceIds = 'unknown';
    assert.throws(() => parseResult(JSON.stringify(data), [{ id: 'new-feedback' }], { previousItems: previous }), /第 1 条补充.*ID 不存在/);
    const fresh = parseResult(result('f1', 'manual'), [{ id: 'f1', note: '关心克制些' }]).items[0];
    assert.equal(fresh.manual, false);
    assert.equal(fresh.confidence, 'tentative');
});

test('调试台保留两次原文；一次格式修复成功只消费一次评价，清空不影响存档', async () => {
    const h = host(), prompts = [];
    const invalid = '<img src=x onerror=alert(1)> invalid JSON';
    const ctl = h.make(async (ctx, settings, prompt) => {
        prompts.push(JSON.parse(prompt));
        return prompts.length === 1 ? invalid : result(currentFeedback(ctx.chat[1]).id);
    });
    await ctl.saveFeedback(1, { note: '行动表达关心' });
    ctl.settings().threshold = 1;
    await ctl.analyze({ automatic: true });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[1].responseRepair.invalidResponse, invalid);
    assert.deepEqual(prompts[1].feedback, prompts[0].feedback);
    assert.equal(ctl.state().consumed.length, 1);
    assert.equal(ctl.analysisAttempt.status, 'applied');
    assert.equal(ctl.analysisAttempt.repairAttempts, 1);
    assert.equal(ctl.analysisDebug[0].requests[0].response, invalid);
    assert.match(ctl.analysisDebug[0].requests[0].validationError, /JSON/);
    assert.equal(ctl.analysisDebug[0].requests[1].response, result(currentFeedback(h.ctx.chat[1]).id));
    assert.equal(JSON.stringify(h.ctx.chatMetadata).includes(invalid), false);
    const saved = structuredClone(h.ctx.chatMetadata);
    ctl.clearDebug();
    assert.deepEqual(ctl.analysisDebug, []);
    assert.deepEqual(ctl.analysisAttempt.requests, []);
    assert.deepEqual(h.ctx.chatMetadata, saved);
});

test('格式修复仍失败只调用两次，保留 A 和待分析评价，错误及原文可查', async () => {
    const h = host(); let calls = 0;
    const ctl = h.make(async () => { calls++; return result('invented-feedback'); });
    await ctl.addItem('expression', '旧修正 A');
    await ctl.saveFeedback(1, { note: '新评价' });
    ctl.settings().threshold = 1;
    const before = structuredClone(ctl.state());
    await assert.rejects(ctl.analyze({ automatic: true }), /本批未应用.*第 1 条补充.*ID 不存在/);
    assert.equal(calls, 2);
    assert.deepEqual(ctl.state(), before);
    assert.equal(pendingFeedback(h.ctx.chat, ctl.state()).length, 1);
    assert.equal(ctl.analysisAttempt.status, 'failed');
    assert.equal(ctl.analysisDebug[0].requests.length, 2);
    for (const request of ctl.analysisDebug[0].requests) {
        assert.equal(request.response, result('invented-feedback'));
        assert.match(request.validationError, /ID 不存在/);
    }
});

test('格式修复期间切换存档不写入任一存档，调试记录随存档隔离', async () => {
    const h = host(); let finish, calls = 0;
    const ctl = h.make(async () => { calls++; return calls === 1 ? 'invalid' : new Promise(resolve => { finish = resolve; }); });
    await ctl.saveFeedback(1, { note: '偏好' });
    const id = currentFeedback(h.ctx.chat[1]).id;
    const pending = ctl.analyze();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 2);
    const second = { ...h.ctx, chatId: 'save-b', chatMetadata: {}, chat: [] };
    h.switchChat(second); ctl.refresh();
    assert.deepEqual(ctl.analysisDebug, []);
    finish(result(id)); await pending;
    assert.equal(second.chatMetadata[KEY].profile.length, 0);
    h.switchChat(h.ctx); ctl.refresh();
    assert.equal(ctl.state().consumed.length, 0);
    assert.equal(ctl.analysisDebug[0].status, 'cancelled');
});

test('调试历史仅保留最近十批；API 请求异常也记录原因', async () => {
    const h = host(), ctl = h.make(async () => { throw new Error('模拟 API 503'); });
    await ctl.saveFeedback(1, { note: '偏好' });
    for (let i = 0; i < 11; i++) await assert.rejects(ctl.analyze(), /API 503/);
    assert.equal(ctl.analysisDebug.length, 10);
    assert.equal(ctl.analysisDebug.at(-1).requests.length, 1);
    assert.equal(ctl.analysisDebug.at(-1).requests[0].error, '模拟 API 503');
    assert.equal(ctl.state().consumed.length, 0);
});

test('发送前用酒馆 AI_OUTPUT 正则处理对应楼层，深度排除系统楼层，原文及评分身份不变', async () => {
    const h = host(), calls = [];
    h.ctx.chat[1].mes = '主线正文<snow>独立小剧场 ABO</snow>';
    h.ctx.chat.push({ is_system: true, mes: '系统消息' }, { is_user: true, mes: '后续用户' }, { mes: '后续回复' });
    const original = h.ctx.chat[1].mes;
    const ctl = createController({ getContext: () => h.ctx,
        prepareText: () => prepareRegexText(async () => ({ regex_placement: { AI_OUTPUT: 2 }, getRegexedString(text, placement, options) {
            calls.push({ placement, options }); return text.replace(/<snow>[\s\S]*?<\/snow>/g, '');
        } })),
        analyzer: async (ctx, settings, prompt) => {
            const input = JSON.parse(prompt);
            assert.deepEqual(input.transcript.map(item => item.text), ['主线正文']);
            assert.equal(input.transcript[0].floor, 1);
            assert.match(input.transcriptProcessing, /正则/);
            return result(input.newFeedbackIds[0]);
        },
    });
    await ctl.saveFeedback(1, { note: '只评价主线' }); const identity = feedbackKey(currentFeedback(h.ctx.chat[1]));
    await ctl.analyze();
    assert.deepEqual(calls, [{ placement: 2, options: { isPrompt: true, depth: 2 } }]);
    assert.equal(h.ctx.chat[1].mes, original);
    assert.deepEqual(ctl.state().consumed, [identity]);
    assert.equal(JSON.parse(ctl.analysisDebug[0].requests[0].prompt).transcript[0].text, '主线正文');
});

test('正则加载失败或清空正文时不发送原文，不消费评价；超长小剧场过滤后允许发送', async () => {
    const h = host(); let calls = 0, mode = 'failed';
    h.ctx.chat[1].mes = '主线<snow>' + '小剧场'.repeat(32000) + '</snow>';
    const ctl = createController({ getContext: () => h.ctx,
        prepareText: () => prepareRegexText(async () => {
            if (mode === 'failed') throw new Error('加载失败');
            return { regex_placement: { AI_OUTPUT: 2 }, getRegexedString: text => mode === 'empty' ? '' : text.replace(/<snow>[\s\S]*?<\/snow>/g, '') };
        }),
        analyzer: async (ctx, settings, prompt) => { calls++; const input = JSON.parse(prompt); assert.equal(input.transcript[0].text, '主线'); return result(input.newFeedbackIds[0]); },
    });
    await ctl.addItem('expression', '已有补充'); await ctl.saveFeedback(1, { note: '只看主线' });
    const before = structuredClone(ctl.state());
    await assert.rejects(ctl.analyze(), /本批未发送.*无法加载/);
    assert.equal(ctl.analysisAttempt.requestCount, 0);
    mode = 'empty'; await assert.rejects(ctl.analyze(), /没有可分析正文/);
    assert.equal(calls, 0); assert.deepEqual(ctl.state(), before);
    mode = 'valid'; await ctl.analyze(); assert.equal(calls, 1); assert.equal(ctl.state().consumed.length, 1);
});

test('等待正则加载时切换存档，不能发送原存档正文', async () => {
    const h = host(); let finish, calls = 0;
    const ctl = createController({ getContext: () => current, prepareText: () => new Promise(resolve => { finish = resolve; }), analyzer: async () => { calls++; return '{}'; } });
    let current = h.ctx;
    await ctl.saveFeedback(1, { note: '偏好' });
    const pending = ctl.analyze();
    current = { ...h.ctx, chatId: 'b', chatMetadata: {}, chat: [] }; ctl.refresh();
    finish(text => text); await pending;
    assert.equal(calls, 0); assert.equal(h.ctx.chatMetadata[KEY].consumed.length, 0);
});

test('本轮新增、修订、沿用、移除可准确识别；失败与撤销保留变化记录', async () => {
    const h = host(); let round = 0;
    const ctl = h.make(async (ctx, settings, prompt) => {
        const p = JSON.parse(prompt); round++;
        const item = (text, previousItemIds = []) => ({ category: 'interaction', text, confidence: 'explicit', sourceIds: p.newFeedbackIds, previousItemIds });
        return JSON.stringify({ summary: '更新偏好', categoryReports: reports, items: round === 1 ? [item('保留这条'), item('修订前'), item('待删除')] : [
            item('保留这条', [p.previousAnalysis.items[0].id]), item('修订后', [p.previousAnalysis.items[1].id]), item('新增这条'),
        ] });
    });
    await ctl.saveFeedback(1, { note: '初次评价' }); await ctl.analyze();
    const first = structuredClone(ctl.state());
    assert.deepEqual(first.lastAnalysis.changes, { added: 3, revised: 0, retained: 0, removed: 0 });
    h.ctx.chat.push({is_user:true,mes:'下一轮'}, {mes:'新回复'});
    await ctl.saveFeedback(3, { note: '修订评价' }); await ctl.analyze();
    assert.deepEqual(ctl.state().lastAnalysis.changes, { added: 1, revised: 1, retained: 1, removed: 1 });
    assert.deepEqual(ctl.state().profile.map(item => item.changeKind), ['retained','revised','added']);
    assert.equal(ctl.state().profile[0].updatedAt, first.profile[0].updatedAt);
    await ctl.undo(); assert.deepEqual(ctl.state().lastAnalysis, first.lastAnalysis);
});

test('旧版可用真实历史快照补出最新标记，缺少记录不猜测，不修改原偏好', () => {
    const old = { id:'old',category:'plot',text:'旧偏好',sourceIds:[] };
    const kept = { ...old, id:'kept', previousItemIds:['old'] };
    const added = { id:'new',category:'plot',text:'新增偏好',sourceIds:[],previousItemIds:[] };
    const state = { ...newState(), analyzedAt:'2026-10-15T12:00:00Z', profile:[kept,added], lastAnalysis:{items:[kept,added]}, history:[{profile:[old],analyzedAt:'2026-10-15T11:00:00Z'}] };
    const before = structuredClone(state), presented = presentProfile(state);
    assert.deepEqual(presented.items.map(item=>item.changeKind), ['retained','added']);
    assert.deepEqual(presented.changes, {added:1,revised:0,retained:1,removed:0});
    assert.equal(presented.items[0].updatedAt, undefined);
    assert.deepEqual(state, before);
    state.history = [];
    assert.equal(presentProfile(state).changes, null);
    assert.equal(presentProfile(state).items[1].changeKind, undefined);
});
