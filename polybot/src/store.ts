import fs from 'node:fs';
import path from 'node:path';
import type { Fill } from './exec/executor.js';

const DIR = process.env.DATA_DIR ?? path.resolve('data');
fs.mkdirSync(DIR, { recursive: true });

export type Settlement = {
  ts: number; mode: string; slug: string; asset: string; tf: string; winner: 'up' | 'down';
  upShares: number; downShares: number; cost: number; payout: number; pnl: number;
  pairs: number; pairCost: number | null; priceToBeat: number | null; finalPrice: number | null; source: string;
};

const file = (name: string, mode: string) => path.join(DIR, `${mode}-${name}.jsonl`);

export function appendFill(f: Fill) { fs.appendFileSync(file('fills', f.mode), JSON.stringify(f) + '\n'); }
export function appendSettlement(s: Settlement) { fs.appendFileSync(file('settlements', s.mode), JSON.stringify(s) + '\n'); }

function readJsonl<T>(p: string): T[] {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as T]; } catch { return []; } });
}
export const loadFills = (mode: string) => readJsonl<Fill>(file('fills', mode));
export const loadSettlements = (mode: string) => readJsonl<Settlement>(file('settlements', mode));
