// POST /api/launch-tx { user, target, n, mode, name, symbol, uri, devBuySol }
// -> two unsigned txs (create + dev buy) for one wallet prompt, plus a sealed
//    ticket holding the server-generated mint key (2-minute expiry).
'use strict';
const { Keypair, PublicKey } = require('@solana/web3.js');
const L = require('./_lib');
const { pumpState } = require('./_pump');
const { buildLaunchTxs } = require('./_launch');

async function simulateCost(conn, tx, user) {
  try {
    const [bal, sim] = await Promise.all([
      conn.getBalance(user, 'confirmed'),
      conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [user.toBase58()] } }),
    ]);
    const v = sim.value;
    if (v.err) return { error: JSON.stringify(v.err).slice(0, 200), balance: bal, logs: (v.logs || []).slice(-4) };
    const post = v.accounts && v.accounts[0] ? v.accounts[0].lamports : null;
    return { balance: bal, createCostLamports: post === null ? null : bal - post };
  } catch (e) { return { error: 'simulation unavailable' }; }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw L.httpError(405, 'POST only');
    L.rateLimit(req, 'launch-tx', 12, 60_000);
    const b = await L.readBody(req, 20_000);
    const treasury = L.treasury();
    if (!treasury) throw L.httpError(503, 'The pad opens when the Cascade treasury address is set.');
    const user = L.asPubkey(b.user);
    if (!user) throw L.httpError(400, 'connect a wallet first');
    const target = L.asPubkey(b.target);
    if (!target) throw L.httpError(400, 'bad target coin address');
    const uri = String(b.uri || '');
    if (!/^https:\/\/[^\s]{8,200}$/.test(uri)) throw L.httpError(400, 'metadata upload missing');
    await L.tokenInfo(target.toBase58()); // the target must be a real fungible token
    const conn = L.connection();
    const [{ blockhash, lastValidBlockHeight }, { global, feeConfig }] = await Promise.all([conn.getLatestBlockhash('confirmed'), pumpState()]);
    const mint = Keypair.generate();
    const { create, buy, tokens, memo } = await buildLaunchTxs({
      user, mint: mint.publicKey, treasury, target, n: +b.n, mode: b.mode, name: b.name, symbol: b.symbol, uri,
      devBuyLamports: Math.round(Number(b.devBuySol) * 1e9), blockhash, global, feeConfig,
    });
    const sim = await simulateCost(conn, create, user);
    const ticket = L.seal({
      k: Buffer.from(mint.secretKey).toString('base64'), user: user.toBase58(), target: target.toBase58(),
      n: +b.n, mode: b.mode, treasury: treasury.toBase58(), lvbh: lastValidBlockHeight, exp: Date.now() + 120_000,
    });
    L.send(res, 200, {
      txs: [create, buy].map((t) => Buffer.from(t.serialize()).toString('base64')),
      mint: mint.publicKey.toBase58(), tokens: tokens.toString(), memo, ticket, lastValidBlockHeight, simulation: sim,
    });
  } catch (e) { L.fail(res, e); }
};
