import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const allowed = new Set(['index.html', 'app.js', 'conversation-manager.js', 'knowledge-manager.js', 'styles.css', 'favicon.svg', 'lib/chat.js', 'lib/conversations.js', 'lib/markdown.js', 'lib/knowledge.js', 'lib/md5.js', 'lib/config.js']);
for (const file of ['wechat.html', 'wechat-app.js', 'wechat-config.js', 'wechat.css']) allowed.add(file);
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const port = Number(process.env.PORT || 4173);
createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1) || 'index.html';
    if (!allowed.has(path) || !['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const data = await readFile(fileURLToPath(new URL(path, root)));
    res.writeHead(200, { 'Content-Type': types[path.split('.').pop()], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(400); res.end('Bad request'); }
}).listen(port, '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${port}`));
