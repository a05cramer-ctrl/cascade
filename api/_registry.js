// Cascade registry, read from chain: every launch pays CASCADE_TREASURY and
// carries the memo "CASCADE <targetMint> <N> <mode> <newMint>".
// getSignaturesForAddress returns each signature's memo, so no per-tx fetch.
// A memo only counts once the new mint's pump bonding curve exists.
'use strict';
const { PublicKey } = require('@solana/web3.js');
const { bondingCurvePda } = require('@pump-fun/pump-sdk');
const L = require('./_lib');
const { isWallet } = require('./_holders');

const TTL = 30_000;
let cache = null, inflight = null;

async function signatures(treasury) {
  const out = [];
  let before;
  for (let page = 0; page < 3; page++) {
    const opts = { limit: 1000, commitment: 'confirmed' };
    if (before) opts.before = before;
    const batch = await L.rpc('getSignaturesForAddress', [treasury, opts]);
    out.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
    await L.sleep(1000);
  }
  return out;
}

async function existingCurves(mints) {
  const ok = new Set();
  for (let i = 0; i < mints.length; i += 100) {
    if (i) await L.sleep(1000);
    const chunk = mints.slice(i, i + 100);
    const r = await L.rpc('getMultipleAccounts', [chunk.map((m) => bondingCurvePda(new PublicKey(m)).toBase58()), { encoding: 'base64', dataSlice: { offset: 0, length: 8 } }]);
    ((r && r.value) || []).forEach((v, j) => { if (v && v.owner === L.PUMP_PROGRAM_ID.toBase58()) ok.add(chunk[j]); });
  }
  return ok;
}

async function assets(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    if (i) await L.sleep(1000);
    try {
      const res = await L.rpc('getAssetBatch', { ids: ids.slice(i, i + 100) });
      for (const a of res || []) {
        if (!a || !a.id) continue;
        const md = (a.content && a.content.metadata) || {};
        const links = (a.content && a.content.links) || {};
        out.set(a.id, { name: md.name || null, symbol: (md.symbol || (a.token_info && a.token_info.symbol) || '').trim() || null, image: links.image || null });
      }
    } catch (_) { /* names are decoration */ }
  }
  return out;
}

/** Wallet holders of each new mint: getTokenAccounts in JSON-array batches (<=20, 1/s). */
async function holderCounts(mints) {
  const res = await L.rpcBatch(mints.map((m) => ({ method: 'getTokenAccounts', params: { mint: m, page: 1, limit: 1000, options: { showZeroBalance: false } } })));
  const out = new Map();
  res.forEach((r, i) => {
    if (r.error || !r.result) return;
    const curve = bondingCurvePda(new PublicKey(mints[i])).toBase58();
    const owners = new Set();
    for (const a of r.result.token_accounts || []) if (BigInt(a.amount) > 0n && a.owner !== curve && isWallet(a.owner)) owners.add(a.owner);
    out.set(mints[i], { holders: owners.size, capped: (r.result.token_accounts || []).length >= 1000 });
  });
  return out;
}

async function build(treasury) {
  const sigs = await signatures(treasury);
  const seen = new Set(), raw = [];
  for (const s of sigs) {
    if (s.err) continue;
    const m = L.parseMemo(s.memo);
    if (!m || seen.has(m.mint)) continue;
    seen.add(m.mint);
    raw.push({ ...m, sig: s.signature, time: s.blockTime || null });
  }
  const live = await existingCurves(raw.map((r) => r.mint).slice(0, 300));
  const list = raw.filter((r) => live.has(r.mint));
  const ids = [...new Set(list.flatMap((r) => [r.mint, r.target]))];
  const meta = await assets(ids);
  const counts = await holderCounts(list.slice(0, 40).map((r) => r.mint));
  const cascades = list.map((r) => ({
    ...r,
    coin: meta.get(r.mint) || {}, targetCoin: meta.get(r.target) || {},
    holders: counts.has(r.mint) ? counts.get(r.mint).holders : null,
    holdersCapped: counts.has(r.mint) ? counts.get(r.mint).capped : false,
  })).sort((a, b) => (b.time || 0) - (a.time || 0));
  return { treasury, cascades: cascades.slice(0, 200), updated: Date.now() };
}

async function getCascades() {
  const t = L.treasury();
  if (!t) return { treasury: null, cascades: [], updated: Date.now() };
  const key = t.toBase58();
  if (cache && cache.key === key && Date.now() - cache.at < TTL) return cache.data;
  if (inflight && inflight.key === key) return inflight.p;
  const p = build(key).then((data) => { cache = { key, at: Date.now(), data }; return data; }).finally(() => { inflight = null; });
  inflight = { key, p };
  try { return await p; } catch (e) { if (cache && cache.key === key) return cache.data; throw e; }
}

module.exports = { getCascades, _reset: () => { cache = null; inflight = null; } };
