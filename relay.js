// POST /api/relay
//   { action:"send", tx, mint }  -> forwards ONE wallet-signed Cascade airdrop batch via Helius
//   { action:"status", sigs:[] } -> signature statuses + current block height
'use strict';
const { VersionedTransaction } = require('@solana/web3.js');
const L = require('./_lib');
const { verifyAirdropTx } = require('./_airdrop');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw L.httpError(405, 'POST only');
    const b = await L.readBody(req, 20_000);
    const conn = L.connection();
    if (b.action === 'status') {
      L.rateLimit(req, 'relay-status', 240, 60_000);
      const sigs = (Array.isArray(b.sigs) ? b.sigs : []).filter((s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{60,90}$/.test(s)).slice(0, 200);
      const [st, height] = await Promise.all([
        sigs.length ? conn.getSignatureStatuses(sigs, { searchTransactionHistory: true }) : { value: [] },
        conn.getBlockHeight('confirmed'),
      ]);
      return L.send(res, 200, {
        blockHeight: height,
        statuses: st.value.map((s, i) => ({ sig: sigs[i], status: s ? (s.err ? 'failed' : s.confirmationStatus || 'processed') : null, err: s && s.err ? JSON.stringify(s.err) : null })),
      });
    }
    if (b.action === 'send') {
      L.rateLimit(req, 'relay-send', 200, 60_000);
      const mint = L.asPubkey(b.mint);
      if (!mint) throw L.httpError(400, 'bad mint');
      let tx;
      try { tx = VersionedTransaction.deserialize(Buffer.from(String(b.tx || ''), 'base64')); } catch (_) { throw L.httpError(400, 'unreadable transaction'); }
      const v = verifyAirdropTx(tx, mint);
      if (!v.ok) throw L.httpError(400, 'not a Cascade airdrop batch: ' + v.why);
      try {
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
        return L.send(res, 200, { signature: sig });
      } catch (e) { throw L.httpError(400, String(e.message || e).split('\n')[0].slice(0, 240)); }
    }
    throw L.httpError(400, 'unknown action');
  } catch (e) { L.fail(res, e); }
};
