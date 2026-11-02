// GET /api/coin?mint=<new coin> -> the cascade behind it (target, N, mode, time)
// plus the coin's real current wallet-holder count and top holders.
'use strict';
const L = require('./_lib');
const { getCascades } = require('./_registry');
const { holdersOf } = require('./_holders');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') throw L.httpError(405, 'GET only');
    L.rateLimit(req, 'coin', 40, 60_000);
    const mint = String(L.query(req).get('mint') || '');
    if (!L.asPubkey(mint)) throw L.httpError(400, 'bad mint');
    const reg = await getCascades().catch(() => ({ cascades: [] }));
    const cascade = reg.cascades.find((c) => c.mint === mint) || null;
    const token = await L.tokenInfo(mint);
    const [h, target] = await Promise.all([
      holdersOf(mint, { decimals: 0, cap: 3000 }),
      cascade ? L.tokenInfo(cascade.target).catch(() => null) : null,
    ]);
    const supply = BigInt(token.supply || '0');
    L.send(res, 200, {
      token, cascade, target,
      holders: h.holders.length, complete: h.complete,
      top: h.holders.slice(0, 25).map((x, i) => ({ rank: i + 1, owner: x.owner, amount: x.amount.toString(), pctSupply: supply > 0n ? Number((x.amount * 1_000_000n) / supply) / 10_000 : null })),
    }, { 'cache-control': 'public, s-maxage=20, stale-while-revalidate=40' });
  } catch (e) { L.fail(res, e); }
};
