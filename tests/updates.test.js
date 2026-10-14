import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION, CREDIT, LATEST_MANIFEST, compareVersions, extensionFolder, createUpdateManager } from '../updates.js';

const url = 'https://tavern.example/scripts/extensions/third-party/Tavern-RP-Preferences/index.js';
const ok = data => ({ ok: true, json: async () => data });

test('版本比较按数字；版本及署名与发布元数据一致', async () => {
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
    assert.equal(compareVersions(VERSION, VERSION), 0);
    assert.throws(() => compareVersions('<script>', VERSION), /版本信息/);
    assert.equal(extensionFolder(url), 'Tavern-RP-Preferences');
    assert.equal(extensionFolder('http://localhost/index.js'), null);
    assert.equal(extensionFolder('http://localhost/scripts/extensions/third-party/%2e%2e/index.js'), null);
    assert.equal(CREDIT, 'by-NUE-喵喵电波');
    for (const file of ['manifest.json', 'package.json']) assert.equal(JSON.parse(await readFile(new URL(`../${file}`, import.meta.url))).version, VERSION);
});

test('发现新版、更新正确的全局安装目录、成功后提示刷新；检查不传凭据', async () => {
    const calls = [];
    const manager = createUpdateManager({ moduleUrl: url, getContext: () => ({ getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token' }) }), fetchImpl: async (target, options) => {
        calls.push([target, options]);
        if (target === LATEST_MANIFEST) { assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined); return ok({ version: '0.8.0' }); }
        if (target === '/api/extensions/discover') return ok([{ name: 'third-party/Tavern-RP-Preferences', type: 'global' }]);
        assert.equal(target, '/api/extensions/update');
        assert.deepEqual(JSON.parse(options.body), { extensionName: 'Tavern-RP-Preferences', global: true });
        assert.equal(options.headers['X-CSRF-Token'], 'test-token');
        return ok({ isUpToDate: false });
    } });
    await manager.check(); assert.equal(manager.state.available, true);
    await manager.install(); assert.equal(manager.state.reload, true); assert.match(manager.state.message, /刷新/);
    assert.equal(calls.length, 3); manager.dispose();
});

test('检查失败不能声称最新，安装位置未知不发送更新，服务器拒绝不提示成功', async () => {
    const manager = createUpdateManager({ moduleUrl: url, getContext: () => ({ getRequestHeaders: () => ({}) }), fetchImpl: async target => target === LATEST_MANIFEST ? {ok:false,status:503} : ok([]) });
    await manager.check(); assert.match(manager.state.message, /503/); assert.equal(manager.state.available, false);
    await manager.install(); assert.match(manager.state.message, /安装位置/); assert.equal(manager.state.reload, false);
    manager.dispose();
    const denied = createUpdateManager({ moduleUrl: url, getContext: () => ({ getRequestHeaders: () => ({}) }), fetchImpl: async target => target === '/api/extensions/discover' ? ok([{name:'Tavern-RP-Preferences',type:'local'}]) : {ok:false,status:403} });
    await denied.install(); assert.match(denied.state.message, /403/); assert.equal(denied.state.reload, false); denied.dispose();
});

test('重复点击不并发检查，停用后丢弃迟到的更新提示', async () => {
    let finish, calls = 0, renders = 0;
    const manager = createUpdateManager({ moduleUrl: url, getContext: () => ({}), changed: () => { renders++; }, fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    const pending = manager.check(); await manager.check(); assert.equal(calls, 1);
    manager.dispose(); const before = renders;
    finish(ok({version:'0.8.0'})); await pending; assert.equal(renders, before);
});
