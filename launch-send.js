// POST /api/launch-send
//   { phase:"create", txs:[create, buy], ticket } -> re-verifies the wallet-signed
//       create (payer, fee, memo, creator), adds the mint signature, sends via Helius
//       and waits for confirmation.
//   { phase:"buy", txs:[create, buy], ticket } -> verifies and sends the dev buy.
'use strict';
const { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const L = require('./_lib');
const { verifyCreateTx } = require('./_launch');

async function waitFor(conn, sig, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const s = value[0];
    if (s && s.err) throw L.httpError(400, 'transaction failed on-chain: ' + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return true;
    await L.sleep(700);
  }
  return false;
}

function verifyBuyTx(tx, user, mint) {
  const keys = tx.message.staticAccountKeys;
  if (!keys[0].equals(user) || tx.message.header.numRequiredSignatures !== 1) return false;
  let buy = false;
  for (const ix of tx.message.compiledInstructions) {
    const p = keys[ix.programIdIndex];
    if (p.equals(ComputeBudgetProgram.programId) || p.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;
    if (p.equals(L.PUMP_PROGRAM_ID) && ix.accountKeyIndexes.some((i) => keys[i].equals(mint))) { buy = true; continue; }
    return false;
  }
  return buy;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw L.httpError(405, 'POST only');
    L.rateLimit(req, 'launch-send', 20, 60_000);
    const b = await L.readBody(req, 20_000);
    const t = L.unseal(b.ticket);
    if (!t) throw L.httpError(400, 'launch ticket expired (2 minutes): start the launch again');
    if (!Array.isArray(b.txs) || b.txs.length !== 2) throw L.httpError(400, 'both signed transactions are required');
    const mint = Keypair.fromSecretKey(Buffer.from(t.k, 'base64'));
    const user = new PublicKey(t.user);
    const [create, buy] = b.txs.map((s) => VersionedTransaction.deserialize(Buffer.from(String(s), 'base64')));
    const v = verifyCreateTx(create, { mint: mint.publicKey, treasury: new PublicKey(t.treasury), user, target: t.target, n: t.n, mode: t.mode });
    if (!v.ok) throw L.httpError(400, 'launch transaction failed verification');
    if (!verifyBuyTx(buy, user, mint.publicKey)) throw L.httpError(400, 'dev buy transaction failed verification');
    const conn = L.connection();
    if (b.phase === 'buy') {
      const sig = await conn.sendRawTransaction(buy.serialize(), { skipPreflight: false, maxRetries: 5 });
      return L.send(res, 200, { signature: sig, mint: mint.publicKey.toBase58() });
    }
    create.sign([mint]);
    const sig = await conn.sendRawTransaction(create.serialize(), { skipPreflight: false, maxRetries: 5 });
    const confirmed = await waitFor(conn, sig, 20_000);
    L.send(res, 200, { signature: sig, confirmed, mint: mint.publicKey.toBase58() });
  } catch (e) {
    if (!e.status && /simulation failed|insufficient|blockhash/i.test(String(e.message))) { e.status = 400; e.message = String(e.message).split('\n')[0].slice(0, 240); }
    L.fail(res, e);
  }
};
