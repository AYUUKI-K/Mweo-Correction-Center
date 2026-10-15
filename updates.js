export const VERSION = '0.7.1';
export const CREDIT = 'by-NUE-喵喵电波';
export const REPOSITORY = 'https://github.com/AYUUKI-K/Mweo-Correction-Center';
export const LATEST_MANIFEST = 'https://raw.githubusercontent.com/AYUUKI-K/Mweo-Correction-Center/main/manifest.json';

export function compareVersions(a, b) {
    const parts = value => {
        if (typeof value !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value)) throw new Error('版本信息格式不正确。');
        return value.split('.').map(Number);
    };
    const left = parts(a), right = parts(b);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
    return 0;
}

export function extensionFolder(moduleUrl) {
    const match = new URL(moduleUrl).pathname.match(/\/scripts\/extensions\/third-party\/([^/]+)\/[^/]+\.js$/);
    const folder = match && decodeURIComponent(match[1]);
    return folder && folder !== '.' && folder !== '..' && !/[\/\\\x00-\x1f]/.test(folder) ? folder : null;
}

export function createUpdateManager({ moduleUrl, getContext, fetchImpl = globalThis.fetch, changed = () => {} }) {
    const state = { busy: false, latest: '', available: false, reload: false, message: '正在检查更新…' };
    let disposed = false, activeRequest;
    const publish = patch => { if (!disposed) { Object.assign(state, patch); changed(state); } };
    async function run(action, label) {
        if (state.busy || disposed) return;
        activeRequest = new AbortController();
        const timer = setTimeout(() => activeRequest?.abort(), 30000);
        publish({ busy: true, message: label });
        try { await action(activeRequest.signal); }
        catch (error) { publish({ message: error.name === 'AbortError' ? '连接超时，可重新检查。' : error.message }); }
        finally { clearTimeout(timer); activeRequest = null; publish({ busy: false }); }
    }
    function check() {
        return run(async signal => {
            const response = await fetchImpl(LATEST_MANIFEST, { cache: 'no-store', credentials: 'omit', signal });
            if (!response.ok) throw new Error(`检查更新失败（${response.status}），可以稍后重试。`);
            const manifest = await response.json(), available = compareVersions(manifest.version, VERSION) > 0;
            publish({ latest: manifest.version, available, message: available ? `发现新版 v${manifest.version}` : '暂无新版本' });
        }, '正在检查更新…');
    }
    function install() {
        return run(async signal => {
            const ctx = getContext(), folder = extensionFolder(moduleUrl);
            if (!folder || typeof ctx.getRequestHeaders !== 'function') throw new Error('当前宿主不支持快捷更新，请在酒馆扩展管理中更新。');
            const discovered = await fetchImpl('/api/extensions/discover', { credentials: 'same-origin', signal });
            if (!discovered.ok) throw new Error('无法读取安装信息，请在酒馆扩展管理中更新。');
            const entries = await discovered.json();
            const entry = Array.isArray(entries) && entries.find(item => (item.name === `third-party/${folder}` || item.name === folder) && ['local', 'global'].includes(item.type));
            if (!entry) throw new Error('无法确认本插件的安装位置，请在酒馆扩展管理中更新。');
            const response = await fetchImpl('/api/extensions/update', {
                method: 'POST', credentials: 'same-origin', signal,
                headers: { ...ctx.getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ extensionName: folder, global: entry.type === 'global' }),
            });
            if (!response.ok) throw new Error(`更新失败（${response.status}），请检查连接或在扩展管理中更新。`);
            const result = await response.json();
            if (typeof result.isUpToDate !== 'boolean') throw new Error('宿主未确认更新结果，请在扩展管理中检查。');
            publish({ reload: true, available: false, message: '文件已更新，刷新页面后生效。' });
        }, '正在更新插件…');
    }
    return { state, check, install, dispose() { disposed = true; activeRequest?.abort(); } };
}
