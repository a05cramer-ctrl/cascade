// POST /api/airdrop-tx { user, mint, recipients:[{owner, amount}] }
// -> batched unsigned airdrop txs (ATA-idempotent + transferChecked, Token-2022),
//    skipping recipients whose on-chain balance already shows their amount.
'use strict';
const { PublicKey } = require('@solana/web3.js');
const L = require('./_lib');
const { packAirdrop, ata } = require('./_airdrop');

async function balances(addrs) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += 100) {
    const chunk = addrs.slice(i, i + 100);
    const r = await L.rpc('getMultipleAccounts', [chunk, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    ((r && r.value) || []).forEach((v, j) => {
      const info = v && v.data && v.data.parsed && v.data.parsed.info;
      out.set(chunk[j], info ? BigInt(info.tokenAmount.amount) : 0n);
    });
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw L.httpError(405, 'POST only');
    L.rateLimit(req, 'airdrop-tx', 30, 60_000);
    const b = await L.readBody(req, 150_000);
    const user = L.asPubkey(b.user), mint = L.asPubkey(b.mint);
    if (!user || !mint) throw L.httpError(400, 'bad wallet or mint');
    const list = Array.isArray(b.recipients) ? b.recipients : [];
    if (!list.length || list.length > 520) throw L.httpError(400, 'between 1 and 520 recipients');
    const seen = new Set();
    const recipients = list.map((r) => {
      const o = L.asPubkey(r && r.owner);
      let a; try { a = BigInt(r.amount); } catch (_) { a = 0n; }
      if (!o || a <= 0n || seen.has(o.toBase58())) throw L.httpError(400, 'bad recipient row');
      seen.add(o.toBase58());
      return { owner: o.toBase58(), amount: a };
    });
    const conn = L.connection();
    const mintInfo = await conn.getParsedAccountInfo(mint, 'confirmed');
    const mi = mintInfo.value;
    if (!mi || !mi.owner.equals(L.TOKEN_2022)) throw L.httpError(400, 'mint not found (yet) or not a Token-2022 pump mint');
    const decimals = mi.data.parsed.info.decimals;
    const src = ata(mint, user).toBase58();
    const addrs = [src, ...recipients.map((r) => ata(mint, new PublicKey(r.owner)).toBase58())];
    const bal = await balances(addrs);
    const have = bal.get(src) || 0n;
    const done = [], todo = [];
    recipients.forEach((r, i) => ((bal.get(addrs[i + 1]) || 0n) >= r.amount ? done : todo).push(r));
    const need = todo.reduce((a, r) => a + r.amount, 0n);
    if (need > have) throw L.httpError(400, `your wallet holds ${have} base units of the new coin but the remaining airdrop needs ${need}`);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    const batches = packAirdrop({ user, mint, decimals, recipients: todo, blockhash });
    L.send(res, 200, {
      decimals, lastValidBlockHeight, balance: have.toString(),
      done: done.map((r) => r.owner),
      batches: batches.map((x) => ({ tx: Buffer.from(x.tx.serialize()).toString('base64'), owners: x.recipients.map((r) => r.owner), size: x.size })),
    });
  } catch (e) { L.fail(res, e); }
};
