// GET /api/snapshot?mint=<CA>&n=<25..500>&exclude=<wallet>
// -> the target coin's info + its real top-N wallet holders (Helius DAS).
'use strict';
const L = require('./_lib');
const { holdersOf } = require('./_holders');

const cache = new Map(); // mint -> { at, data }
const TTL = 60_000;

async function snap(mint) {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const info = await L.tokenInfo(mint);
  const r = await holdersOf(mint, { decimals: info.decimals, cap: 5000 });
  const supply = BigInt(info.supply || '0');
  const data = {
    token: info,
    accountsRead: r.accountsRead, complete: r.complete, eligible: r.holders.length, dropped: r.dropped,
    holders: r.holders.slice(0, 500).map((h, i) => ({
      rank: i + 1, owner: h.owner, amount: h.amount.toString(),
      pctSupply: supply > 0n ? Number((h.amount * 1_000_000n) / supply) / 10_000 : null,
    })),
    at: Date.now(),
  };
  cache.set(mint, { at: Date.now(), data });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return data;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') throw L.httpError(405, 'GET only');
    L.rateLimit(req, 'snapshot', 30, 60_000);
    const q = L.query(req);
    const mint = String(q.get('mint') || '').trim();
    if (!L.asPubkey(mint)) throw L.httpError(400, 'paste a Solana token address (CA)');
    const n = L.N_CHOICES.includes(+q.get('n')) ? +q.get('n') : 500;
    const ex = L.asPubkey(String(q.get('exclude') || '')) ? String(q.get('exclude')) : null;
    const d = await snap(mint);
    const list = d.holders.filter((h) => h.owner !== ex).slice(0, n);
    const top = list.reduce((a, h) => a + BigInt(h.amount), 0n);
    L.send(res, 200, {
      ...d, n, holders: list.map((h) => ({ ...h, pctTop: top > 0n ? Number((BigInt(h.amount) * 1_000_000n) / top) / 10_000 : 0 })),
    }, { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=60' });
  } catch (e) { L.fail(res, e); }
};
