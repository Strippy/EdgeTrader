import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { Engine } from './engine.js';
import { CFG } from './config.js';
import { log } from './bus.js';

/** Serves the dashboard and pushes engine snapshots over WebSocket at 4 Hz. Binds to localhost unless HOST is set. */
export function startServer(engine: Engine) {
  const html = path.resolve('public/index.html');
  const server = http.createServer((req, res) => {
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(engine.snapshot()));
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(html));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  setInterval(() => {
    if (!wss.clients.size) return;
    const payload = JSON.stringify(engine.snapshot());
    for (const c of wss.clients) if (c.readyState === 1 && c.bufferedAmount < 2e6) c.send(payload);
  }, 250);
  const host = process.env.HOST ?? '127.0.0.1';
  server.listen(CFG.port, host, () => log('info', 'server', `dashboard http://${host}:${CFG.port}`));
}
