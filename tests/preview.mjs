// A fake host for UI review. No real model calls, credentials or user chats.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('./preview.html', import.meta.url));
const allowed = new Set(['index.js', 'core.js', 'controller.js', 'api.js', 'updates.js', 'debug-config.js', 'style.css']);
const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/fixture-update-manifest') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ version: '0.7.1' })); return; }
    if (pathname === '/api/extensions/discover') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{name:'third-party/Mweo-Correction-Center',type:'local'}])); return; }
    if (pathname === '/api/extensions/update') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({isUpToDate:false,shortCommitHash:'fixture'})); return; }
    if (pathname === '/script.js') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end('export const isGenerating = () => false;'); return; }
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const prefix = '/scripts/extensions/third-party/Mweo-Correction-Center/';
    const file = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname.slice(1);
    if (!allowed.has(file)) { res.writeHead(404); res.end(); return; }
    try {
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        res.end(await readFile(new URL(`../${file}`, import.meta.url)));
    } catch { res.writeHead(404); res.end(); }
});
server.listen(Number(process.argv[2] ?? 8791), '127.0.0.1', () => console.log('UI fixture: http://127.0.0.1:' + server.address().port));
