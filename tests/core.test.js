import test from 'node:test';
import assert from 'node:assert/strict';
import { KEY, DEFAULTS, newState, normalizeFeedback, revisionOf, currentFeedback, activeFeedback, buildInjection, parseResult, analysisInput, pendingFeedback, feedbackKey } from '../core.js';
import { createController } from '../controller.js';
import { callAnalyzer, completionUrl } from '../api.js';

function host() {
    const ctx = {
        chatId: 'save-a', characterId: 0, groupId: null,
        characters: [{ avatar: 'char.png', name: '测试角色', data: { description: '性格慢热，关心时克制。', personality: '慢热' } }],
        chat: [{ mes: '我有点冷。', is_user: true }, { mes: '他把围巾放到你旁边。', name: '测试角色', swipe_id: 0 }],
        chatMetadata: {}, extensionSettings: {},
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
    for (const confidence of ['explicit', 'repeated']) assert.equal(parseResult(result('f1', confidence), evidence).items[0].enabled, false);
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

test('无效模型输出可以重试；用户确认补充保留，撤销可恢复分析前状态', async () => {
    const h = host(); let bad = true;
    const ctl = h.make(async () => bad ? 'broken' : result(currentFeedback(h.ctx.chat[1]).id));
    await ctl.saveFeedback(1, { note: '用行动关心' });
    await assert.rejects(ctl.analyze(), /JSON/); assert.equal(ctl.state().consumed.length, 0);
    bad = false; await ctl.analyze();
    const id = ctl.state().profile[0].id;
    await ctl.editItem(id, '用户确认的补充', true);
    await ctl.saveFeedback(1, { note: '节奏放慢' }); await ctl.analyze();
    assert.equal(ctl.state().profile[0].text, '用户确认的补充');
    await ctl.clearProfile(); assert.equal(h.ctx.injection.text, '');
    await ctl.undo(); assert.match(h.ctx.injection.text, /用户确认的补充/);
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
    assert.deepEqual(payloads[0].feedback.map(f => f.index), [5, 7, 9]);
    assert.equal(ctl.state().consumed.length, 3);
    const target = currentFeedback(h.ctx.chat[1]).id;
    await ctl.analyze({ feedbackIds: [target] });
    assert.deepEqual(payloads[1].newFeedbackIds, [target]);
    assert.deepEqual(pendingFeedback(h.ctx.chat, ctl.state()).map(f => f.index), [3]);
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
    assert.equal(payload.feedback.length, 1); assert.equal(payload.feedback[0].index, 7);
    assert.equal(first.pending.length, 1);
    ctl.state().consumed.push(feedbackKey(first.pending[0]));
    assert.throws(() => analysisInput(h.ctx, ctl.state(), { ...settings, threshold: 4 }, { automatic: true }), /尚未累计/);
    const next = analysisInput(h.ctx, ctl.state(), settings, { automatic: true });
    assert.equal(next.pending[0].index, 5);
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
    assert.equal(ctl.state().version, 2); assert.equal(ctl.state().consumed[0], feedbackKey(f));
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
