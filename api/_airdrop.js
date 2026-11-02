// Airdrop batch builder + verifier. Each recipient costs two instructions:
// createAssociatedTokenAccountIdempotent + transferChecked (Token-2022).
// Recipients are packed greedily while the signed tx stays <= 1,232 bytes.
'use strict';
const { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} = require('@solana/spl-token');

const PACKET = 1232;
const MAX_PER_TX = 12; // compute stays well under budget
const CU_PER_RECIPIENT = 42_000; // Token-2022 idempotent ATA create (~25-30k) + transferChecked (~6k)
const CU_BASE = 6_000;
const PRIORITY_MICROLAMPORTS = 60_000;
const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

function batchIxs(user, mint, decimals, list) {
  const src = ata(mint, user);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CU_BASE + CU_PER_RECIPIENT * list.length }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }),
  ];
  for (const r of list) {
    const owner = new PublicKey(r.owner);
    const dst = ata(mint, owner);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(user, dst, owner, mint, TOKEN_2022_PROGRAM_ID));
    ixs.push(createTransferCheckedInstruction(src, mint, dst, user, BigInt(r.amount), decimals, [], TOKEN_2022_PROGRAM_ID));
  }
  return ixs;
}
function compile(user, blockhash, ixs) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
}
const signedSize = (tx) => tx.serialize().length; // unsigned slots are zero-filled, so the length equals the signed length

/**
 * recipients: [{owner, amount}] -> [{ tx, recipients, size }]
 * Every tx is signed only by `user` (fee payer + token authority).
 */
function packAirdrop({ user, mint, decimals, recipients, blockhash }) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const tx = compile(user, blockhash, batchIxs(user, mint, decimals, cur));
    out.push({ tx, recipients: cur, size: signedSize(tx) });
    cur = [];
  };
  for (const r of recipients) {
    const next = cur.concat([r]);
    let fits = next.length <= MAX_PER_TX;
    if (fits) { try { fits = signedSize(compile(user, blockhash, batchIxs(user, mint, decimals, next))) <= PACKET; } catch (_) { fits = false; } }
    if (!fits) { flush(); cur = [r]; } else cur = next;
  }
  flush();
  return out;
}

/** Fee one batch tx pays: base signature fee + priority (CU limit x price). */
function batchFeeLamports(count) {
  return 5000 + Math.ceil(((CU_BASE + CU_PER_RECIPIENT * count) * PRIORITY_MICROLAMPORTS) / 1e6);
}

/**
 * The relay only forwards txs shaped exactly like a Cascade airdrop batch:
 * payer = only signer; compute budget, ATA-idempotent creates paid by the payer,
 * and Token-2022 transferChecked from the payer's ATA of `mint`.
 */
function verifyAirdropTx(tx, mint) {
  const m = tx.message;
  if (m.addressTableLookups && m.addressTableLookups.length) return { ok: false, why: 'lookup tables not expected' };
  if (m.header.numRequiredSignatures !== 1) return { ok: false, why: 'one signer expected' };
  const keys = m.staticAccountKeys;
  const payer = keys[0];
  const src = ata(mint, payer);
  let transfers = 0;
  for (const ix of m.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    const acc = ix.accountKeyIndexes.map((i) => keys[i]);
    const d = Buffer.from(ix.data);
    if (prog.equals(ComputeBudgetProgram.programId)) continue;
    if (prog.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (!(d.length === 1 && d[0] === 1 && acc[0].equals(payer) && acc[3].equals(mint) && acc[5].equals(TOKEN_2022_PROGRAM_ID))) return { ok: false, why: 'bad ATA instruction' };
      continue;
    }
    if (prog.equals(TOKEN_2022_PROGRAM_ID)) {
      if (!(d.length === 10 && d[0] === 12 && acc[0].equals(src) && acc[1].equals(mint) && acc[3].equals(payer))) return { ok: false, why: 'bad transfer instruction' };
      transfers++;
      continue;
    }
    return { ok: false, why: 'unexpected program ' + prog.toBase58() };
  }
  return { ok: transfers > 0, why: transfers ? '' : 'no transfers', payer, transfers };
}

module.exports = { packAirdrop, verifyAirdropTx, batchFeeLamports, ata, PACKET, MAX_PER_TX };
