// Cached pump.fun Global + FeeConfig and rent figures (all read live from chain).
'use strict';
const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');
const L = require('./_lib');

let pumpCache = null; // { at, global, feeConfig }
async function pumpState() {
  if (pumpCache && Date.now() - pumpCache.at < 300_000) return pumpCache;
  const sdk = new OnlinePumpSdk(L.connection());
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig().catch(() => null)]);
  pumpCache = { at: Date.now(), global, feeConfig };
  return pumpCache;
}

// Token-2022 ATA = 165 base + 1 account-type byte + ImmutableOwner TLV (4) = 170 bytes.
const ATA_2022_SIZE = 170;
const CURVE_SIZE = 166;     // pump BondingCurve (BONDING_CURVE_SIZE in pump-sdk 4.3.1)
const MINT_2022_EST = 520;  // Token-2022 mint + metadata pointer + on-mint metadata (name/symbol/uri)
let rentCache = null;
async function rents() {
  if (rentCache && Date.now() - rentCache.at < 3_600_000) return rentCache;
  const r = await L.rpcBatch([ATA_2022_SIZE, CURVE_SIZE, MINT_2022_EST].map((n) => ({ method: 'getMinimumBalanceForRentExemption', params: [n] })));
  if (r.some((x) => x.error)) throw L.httpError(502, 'could not read rent: ' + (r.find((x) => x.error).error));
  const [ata, curve, mint] = r.map((x) => Number(x.result));
  rentCache = { at: Date.now(), ata, createEstimate: ata * 2 + curve + mint };
  return rentCache;
}

module.exports = { pumpState, rents, ATA_2022_SIZE };
