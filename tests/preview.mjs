// A fake host for UI review. No real model calls, credentials or user chats.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('./preview.html', import.meta.url));
const allowed = new Set(['index.js', 'core.js', 'controller.js', 'api.js', 'style.css']);
const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const file = pathname.slice(1);
    if (!allowed.has(file)) { res.writeHead(404); res.end(); return; }
    try {
        res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        res.end(await readFile(new URL(`../${file}`, import.meta.url)));
    } catch { res.writeHead(404); res.end(); }
});
server.listen(Number(process.argv[2] ?? 8791), '127.0.0.1', () => console.log('UI fixture: http://127.0.0.1:' + server.address().port));
