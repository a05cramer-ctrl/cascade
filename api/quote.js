// GET /api/quote?sol=<dev buy SOL> -> exact dev-buy token amount from pump's live
// Global/FeeConfig, Token-2022 ATA rent per recipient, and the fixed fee.
'use strict';
const L = require('./_lib');
const { pumpState, rents } = require('./_pump');
const { quoteDevBuy, MIN_DEV_BUY, MAX_DEV_BUY } = require('./_launch');
const { batchFeeLamports, MAX_PER_TX } = require('./_airdrop');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') throw L.httpError(405, 'GET only');
    L.rateLimit(req, 'quote', 60, 60_000);
    const sol = Number(L.query(req).get('sol'));
    const lamports = Math.round(sol * 1e9);
    if (!(lamports >= MIN_DEV_BUY && lamports <= MAX_DEV_BUY)) throw L.httpError(400, 'dev buy must be between 0.01 and 50 SOL');
    const [{ global, feeConfig }, rent] = await Promise.all([pumpState(), rents()]);
    const tokens = quoteDevBuy(global, feeConfig, lamports);
    L.send(res, 200, {
      devBuyLamports: lamports, maxDevBuyLamports: Math.ceil(lamports * 1.01), tokens: tokens.toString(), decimals: 6,
      ataRentLamports: rent.ata, createRentEstimateLamports: rent.createEstimate, feeLamports: L.FEE_LAMPORTS,
      launchTxFeesLamports: 10_000 + 37_500 + 5_000 + 30_000, // tx1: 2 sigs + 250k CU @150k uL; tx2: 1 sig + 200k CU @150k uL
      batchFeeLamports: batchFeeLamports(MAX_PER_TX), perTxMax: MAX_PER_TX,
    }, { 'cache-control': 'public, s-maxage=15' });
  } catch (e) { L.fail(res, e); }
};
