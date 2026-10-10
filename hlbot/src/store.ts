import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR ?? path.resolve('data');
fs.mkdirSync(DIR, { recursive: true });

export type RoundTrip = {
  mode: string; coin: string; dir: 'long' | 'short'; openedAt: number; closedAt: number;
  sz: number; entryPx: number; exitPx: number; pnl: number; fees: number; net: number; exitReason: string; makerEntry: boolean;
};

const file = (name: string, mode: string) => path.join(DIR, `${mode}-${name}.jsonl`);
export const append = (name: string, mode: string, obj: unknown) => fs.appendFileSync(file(name, mode), JSON.stringify(obj) + '\n');
export function load<T>(name: string, mode: string): T[] {
  const p = file(name, mode);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}
