// Pure holder + split math, shared by the API and the browser bundle (no deps).
// All token amounts are BigInt base units.
'use strict';

const BURN = new Set([
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111',
  '1111111111111111111111111111111111111111111',
  'deaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
]);

/**
 * accounts: [{ address, owner, amount }] (amount: string|number|bigint, base units)
 * opts.isWallet(owner) -> false for program-owned / off-curve owners (pools, curves, vaults)
 * opts.exclude: Set of owners/accounts to drop (bonding curve PDA, the launcher...)
 * opts.decimals: drop holders with < 1 whole token
 * -> [{ owner, amount: bigint, accounts }] sorted by amount desc, ties by owner
 */
function mergeHolders(accounts, { decimals = 0, isWallet = () => true, exclude = new Set() } = {}) {
  const one = 10n ** BigInt(decimals);
  const seen = new Set();
  const by = new Map();
  let dropped = { offCurve: 0, burn: 0, excluded: 0, dust: 0 };
  for (const a of accounts || []) {
    if (!a || !a.owner) continue;
    if (a.address) { if (seen.has(a.address)) continue; seen.add(a.address); }
    let amt; try { amt = BigInt(a.amount); } catch (_) { continue; }
    if (amt <= 0n) continue;
    if (BURN.has(a.owner)) { dropped.burn++; continue; }
    if (exclude.has(a.owner) || (a.address && exclude.has(a.address))) { dropped.excluded++; continue; }
    if (!isWallet(a.owner)) { dropped.offCurve++; continue; }
    const h = by.get(a.owner) || { owner: a.owner, amount: 0n, accounts: 0 };
    h.amount += amt; h.accounts++;
    by.set(a.owner, h);
  }
  const out = [];
  for (const h of by.values()) { if (h.amount >= one) out.push(h); else dropped.dust++; }
  out.sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : x.owner < y.owner ? -1 : 1));
  out.dropped = dropped;
  return out;
}

/** Largest-remainder apportionment: sum(result) === total exactly, no dust lost. */
function proRata(total, weights) {
  total = BigInt(total);
  const w = weights.map((x) => BigInt(x));
  const sum = w.reduce((a, b) => a + b, 0n);
  if (!w.length) return [];
  if (sum <= 0n) return equal(total, w.length);
  const base = w.map((x) => (total * x) / sum);
  const rem = w.map((x, i) => ({ i, r: (total * x) % sum }));
  let left = total - base.reduce((a, b) => a + b, 0n);
  rem.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (let k = 0; left > 0n; k = (k + 1) % rem.length, left--) base[rem[k].i] += 1n;
  return base;
}

function equal(total, n) {
  total = BigInt(total);
  if (n <= 0) return [];
  const each = total / BigInt(n);
  let left = total - each * BigInt(n);
  const out = new Array(n).fill(each);
  for (let i = 0; left > 0n; i++, left--) out[i] += 1n;
  return out;
}

/**
 * Turn the dev buy into the exact airdrop table.
 * holders: top-N list from mergeHolders/snapshot ({owner, amount})
 * keepBps: share the launcher keeps (0..2000)
 * -> { rows: [{owner, weight, amount}], keep, total } with sum(rows)+keep === total.
 * Rows that would get 0 base units are dropped and their part re-split.
 */
function planSplit(total, holders, mode = 'prorata', keepBps = 0) {
  total = BigInt(total);
  const kb = BigInt(Math.max(0, Math.min(2000, Math.floor(Number(keepBps) || 0))));
  const keep = (total * kb) / 10000n;
  const pot = total - keep;
  let list = holders.slice();
  for (let guard = 0; guard < 8; guard++) {
    const amts = mode === 'equal' ? equal(pot, list.length) : proRata(pot, list.map((h) => h.amount));
    const zero = amts.some((a) => a === 0n);
    if (!zero || !list.length) {
      return { total, keep, rows: list.map((h, i) => ({ owner: h.owner, weight: BigInt(h.amount), amount: amts[i] })) };
    }
    list = list.filter((_, i) => amts[i] > 0n);
  }
  throw new Error('split did not converge');
}

/** Format base units with decimals, trimming trailing zeros; groups thousands. */
function fmtUnits(v, decimals, maxFrac = 2) {
  v = BigInt(v);
  const neg = v < 0n; if (neg) v = -v;
  const d = 10n ** BigInt(decimals);
  const whole = (v / d).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let frac = decimals ? (v % d).toString().padStart(decimals, '0').slice(0, maxFrac).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}

module.exports = { BURN, mergeHolders, proRata, equal, planSplit, fmtUnits };
