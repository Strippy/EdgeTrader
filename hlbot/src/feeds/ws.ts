import WebSocket from 'ws';
import { log } from '../bus.js';

/** WebSocket with exponential-backoff reconnect and an optional app-level heartbeat. */
export class ReconnectingWS {
  ws: WebSocket | null = null;
  connected = false;
  lastMsgAt = 0;
  private backoff = 500;
  private hb: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private name: string,
    private url: () => string,
    private handlers: {
      onOpen?: (ws: WebSocket) => void;
      onMessage: (data: string) => void;
      heartbeat?: { everyMs: number; payload: string };
      /** reconnect if no message for this long */
      silenceMs?: number;
    },
  ) {}

  start() { this.connect(); return this; }

  send(s: string) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s); }

  stop() { this.closed = true; this.cleanup(); this.ws?.close(); }

  private cleanup() {
    if (this.hb) clearInterval(this.hb);
    if (this.watchdog) clearInterval(this.watchdog);
    this.hb = this.watchdog = null;
    this.connected = false;
  }

  private connect() {
    const url = this.url();
    const ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoff = 500;
      this.lastMsgAt = Date.now();
      log('info', this.name, `connected ${url.slice(0, 90)}`);
      if (this.handlers.heartbeat) {
        const { everyMs, payload } = this.handlers.heartbeat;
        this.hb = setInterval(() => this.send(payload), everyMs);
      }
      if (this.handlers.silenceMs) {
        const lim = this.handlers.silenceMs;
        this.watchdog = setInterval(() => {
          if (Date.now() - this.lastMsgAt > lim) { log('warn', this.name, `silent ${lim}ms, reconnecting`); ws.terminate(); }
        }, Math.min(lim, 5000));
      }
      this.handlers.onOpen?.(ws);
    });
    ws.on('message', (buf) => {
      this.lastMsgAt = Date.now();
      const s = buf.toString();
      try { this.handlers.onMessage(s); } catch (e) { log('error', this.name, `handler: ${(e as Error).message}`); }
    });
    ws.on('ping', () => ws.pong());
    ws.on('error', (e) => log('warn', this.name, `ws error: ${e.message}`));
    ws.on('close', (code) => {
      this.cleanup();
      if (this.closed) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 15000);
      log('warn', this.name, `closed (${code}); reconnect in ${wait}ms`);
      setTimeout(() => this.connect(), wait);
    });
  }
}
