// Pure transaction builders for a Cascade launch. No network in here: callers
// pass the blockhash and pump's Global (+ FeeConfig) for the dev-buy quote.
'use strict';
const BN = require('bn.js');
const { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const { NATIVE_MINT } = require('@solana/spl-token');
const { PUMP_SDK, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
const L = require('./_lib');

const MIN_DEV_BUY = 10_000_000; // 0.01 SOL: something has to be split
const MAX_DEV_BUY = 50 * 1e9;

const clean = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

/** Tokens a fresh curve gives for `lamports` (the exact `amount` the buy asks for). */
function quoteDevBuy(global, feeConfig, lamports) {
  return getBuyTokenAmountFromSolAmount({
    global, feeConfig: feeConfig || null, mintSupply: null, bondingCurve: null, amount: new BN(lamports), quoteMint: NATIVE_MINT,
  });
}

/**
 * -> { create: VersionedTransaction (user + mint sign), buy: VersionedTransaction (user signs), tokens: BN }
 * tx1: compute budget + create_v2 (creator = user) + 0.01 SOL fee + memo
 * tx2: user's Token-2022 ATA + the dev buy. pump's create_v2 + buy don't fit
 *      one legacy-sized message without a lookup table, so they are two txs
 *      signed in one wallet prompt; tx2 is sent once tx1 confirms.
 */
async function buildLaunchTxs(p) {
  const name = clean(p.name, 32), symbol = clean(p.symbol, 10).toUpperCase(), uri = clean(p.uri, 200);
  if (!name || !symbol || !uri) throw L.httpError(400, 'name, ticker and metadata are required');
  if (!L.N_CHOICES.includes(+p.n)) throw L.httpError(400, 'N must be one of ' + L.N_CHOICES.join(', '));
  if (!L.MODES.includes(p.mode)) throw L.httpError(400, 'mode must be prorata or equal');
  if (!(p.target instanceof PublicKey)) throw L.httpError(400, 'bad target mint');
  const dev = Math.floor(Number(p.devBuyLamports) || 0);
  if (dev < MIN_DEV_BUY || dev > MAX_DEV_BUY) throw L.httpError(400, 'dev buy must be between 0.01 and 50 SOL');
  if (!p.global) throw L.httpError(500, 'pump global state missing');

  const memo = L.launchMemo(p.target.toBase58(), +p.n, p.mode, p.mint.toBase58());
  const create = toTx(p, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }),
    await PUMP_SDK.createV2Instruction({ mint: p.mint, name, symbol, uri, creator: p.user, user: p.user, mayhemMode: false }),
    L.feeIx(p.user, p.treasury),
    L.memoIx(memo),
  ]);
  const solAmount = new BN(dev);
  const tokens = quoteDevBuy(p.global, p.feeConfig, dev);
  const both = await PUMP_SDK.createV2AndBuyInstructions({
    global: p.global, mint: p.mint, name, symbol, uri, creator: p.user, user: p.user, amount: tokens, solAmount, mayhemMode: false,
  });
  const buy = toTx(p, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }),
    ...both.slice(1), // drop the create: keep the user's ATA + the first buy
  ]);
  return { create, buy, tokens, memo };
}

function toTx(p, ixs) {
  const msg = new TransactionMessage({ payerKey: p.user, recentBlockhash: p.blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  let size;
  try { size = tx.serialize().length; } catch (_) { size = 1e9; }
  if (size > 1232) throw L.httpError(400, 'transaction too large: shorten the name, ticker or metadata');
  return tx;
}

/** Re-check a wallet-signed create tx before the server adds the mint signature. */
function verifyCreateTx(tx, { mint, treasury, user, target, n, mode }) {
  const m = tx.message;
  const keys = m.staticAccountKeys;
  const payer = keys[0];
  const want = L.launchMemo(target, n, mode, mint.toBase58());
  let hasCreate = false, hasFee = false, hasMemo = false, foreign = false;
  for (const ix of m.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    const acc = ix.accountKeyIndexes.map((i) => keys[i]);
    const d = Buffer.from(ix.data);
    if (prog.equals(L.PUMP_PROGRAM_ID)) {
      if (!acc[0] || !acc[0].equals(mint)) { foreign = true; continue; }
      let o = 8;
      try { for (let i = 0; i < 3; i++) o += 4 + d.readUInt32LE(o); } catch (_) { continue; }
      if (new PublicKey(d.subarray(o, o + 32)).equals(user)) hasCreate = true;
    } else if (prog.equals(SystemProgram.programId)) {
      if (d.length >= 12 && d.readUInt32LE(0) === 2 && acc[0].equals(payer) && acc[1] && acc[1].equals(treasury) && Number(d.readBigUInt64LE(4)) >= L.FEE_LAMPORTS) hasFee = true;
      else foreign = true; // no other SOL moves in the create tx
    } else if (prog.equals(L.MEMO_PROGRAM_ID)) {
      if (d.toString('utf8') === want) hasMemo = true;
    } else if (!prog.equals(ComputeBudgetProgram.programId)) foreign = true;
  }
  const ok = hasCreate && hasFee && hasMemo && !foreign && payer.equals(user) && m.header.numRequiredSignatures === 2;
  return { ok, hasCreate, hasFee, hasMemo, foreign, payer };
}

module.exports = { buildLaunchTxs, verifyCreateTx, quoteDevBuy, MIN_DEV_BUY, MAX_DEV_BUY };
