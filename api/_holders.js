// Reads a mint's real holders from Helius and turns them into ranked wallets.
'use strict';
const { PublicKey } = require('@solana/web3.js');
const { bondingCurvePda } = require('@pump-fun/pump-sdk');
const L = require('./_lib');
const { mergeHolders } = require('./_split');

const PAGE = 1000;

function isWallet(owner) {
  try { return PublicKey.isOnCurve(new PublicKey(owner).toBytes()); } catch (_) { return false; }
}

/** DAS getTokenAccounts, page by page, up to `cap` accounts. */
async function readAccounts(mint, cap = 5000) {
  const out = [];
  let complete = false;
  for (let page = 1; out.length < cap; page++) {
    const r = await L.rpc('getTokenAccounts', { mint, page, limit: PAGE, options: { showZeroBalance: false } });
    const list = (r && r.token_accounts) || [];
    for (const a of list) out.push({ address: a.address, owner: a.owner, amount: a.amount });
    if (list.length < PAGE) { complete = true; break; }
  }
  return { accounts: out.slice(0, cap), complete };
}

/** Exact top-20 token accounts (with owners) so the biggest wallets are never missed on a partial read. */
async function largest(mint) {
  try {
    const top = await L.rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    const addrs = ((top && top.value) || []).map((x) => x.address);
    if (!addrs.length) return [];
    const infos = await L.rpc('getMultipleAccounts', [addrs, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    return ((infos && infos.value) || []).map((v, i) => {
      const info = v && v.data && v.data.parsed && v.data.parsed.info;
      return info ? { address: addrs[i], owner: info.owner, amount: info.tokenAmount.amount } : null;
    }).filter(Boolean);
  } catch (_) { return []; }
}

function curveFor(mint) {
  try { return bondingCurvePda(new PublicKey(mint)).toBase58(); } catch (_) { return null; }
}

/** -> { holders: merged & ranked, accountsRead, complete, dropped } */
async function holdersOf(mint, { decimals, cap = 5000, exclude = [] } = {}) {
  const { accounts, complete } = await readAccounts(mint, cap);
  const extra = complete ? [] : await largest(mint);
  const ex = new Set(exclude.filter(Boolean));
  const curve = curveFor(mint);
  if (curve) ex.add(curve);
  const holders = mergeHolders(accounts.concat(extra), { decimals, isWallet, exclude: ex });
  return { holders, accountsRead: accounts.length, complete, dropped: holders.dropped };
}

module.exports = { holdersOf, readAccounts, isWallet, curveFor };
