// Local-only preview. It never bypasses the deployed Worker.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { secure } from '../worker.js';
const root = fileURLToPath(new URL('../public/', import.meta.url));
const liveCopy = fileURLToPath(new URL('../collector/live.json', import.meta.url));
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.txt':'text/plain', '.json':'application/json' };
const port = Number(process.env.PORT || 8788);
async function liveFeed() {
  // The collector keeps its last result next to itself; serve it so the preview shows real readings.
  try {
    const data = JSON.parse(await readFile(liveCopy, 'utf8'));
    for (const provider of Object.values(data.providers || {})) if (provider && typeof provider === 'object') delete provider.raw;
    return { status: 'ok', ...data };
  } catch { return { status: 'not_connected', message: 'Run collector/collect.py once to see live readings in the local preview.' }; }
}
const server = createServer(async (req, res) => {
  let response;
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(req.headers.host)) response = new Response('Invalid host', { status: 403 });
    else if (url.pathname === '/api/session') response = Response.json({ mode:'local-preview' });
    else if (url.pathname === '/api/live') response = Response.json(await liveFeed());
    else {
      const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(root) || /\/(?:_|\.)/.test(url.pathname)) response = new Response('Not found', { status:404 });
      else response = new Response(await readFile(path), { headers:{ 'Content-Type':types[extname(path)] || 'application/octet-stream' } });
    }
  } catch { response = new Response('Not found', { status:404 }); }
  response = secure(response);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
server.on('error', error => { console.error(`Could not start local preview: ${error.message}`); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${port} (live feed from collector/live.json if present; loopback only)`));
