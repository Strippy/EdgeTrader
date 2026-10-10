import { EventEmitter } from 'node:events';

/** Ring buffer of raw wire events for the dashboard's wire inspector + console log. */
export type WireEvent = { t: number; src: string; kind: string; msg: string };

class Bus extends EventEmitter {
  wire: WireEvent[] = [];
  counts: Record<string, number> = {};
  bytes = 0;
  wireEvent(src: string, kind: string, msg: string, bytes = 0, count = true) {
    if (count) this.counts[src] = (this.counts[src] ?? 0) + 1;
    this.bytes += bytes;
    const e = { t: Date.now(), src, kind, msg: msg.length > 160 ? msg.slice(0, 157) + '…' : msg };
    this.wire.push(e);
    if (this.wire.length > 300) this.wire.splice(0, this.wire.length - 300);
  }
}
export const bus = new Bus();
bus.setMaxListeners(50);

export function log(level: 'info' | 'warn' | 'error', src: string, msg: string) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${src}] ${msg}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  bus.wireEvent(src, level, msg, 0, false);
}
