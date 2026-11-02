// Shared server helpers for Cascade's Vercel functions.
// Files starting with "_" in /api are not routes on Vercel.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Connection, PublicKey, SystemProgram, TransactionInstruction } = require('@solana/web3.js');

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const FEE_LAMPORTS = 10_000_000; // 0.01 SOL Cascade fee -> treasury
const N_CHOICES = [25, 50, 100, 200, 500];
const MODES = ['prorata', 'equal'];
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MEMO_RE = /CASCADE ([1-9A-HJ-NP-Za-km-z]{32,44}) (\d{1,3}) (prorata|equal) ([1-9A-HJ-NP-Za-km-z]{32,44})/;

// ---------- config.js (source of truth for the treasury) ----------
let cfgCache = null;
function readConfig() {
  if (cfgCache) return cfgCache;
  for (const f of [path.join(__dirname, '..', 'config.js'), path.join(process.cwd(), 'config.js')]) {
    try {
      const sandbox = { window: {} };
      vm.runInNewContext(fs.readFileSync(f, 'utf8'), sandbox, { timeout: 50 });
      if (sandbox.window.CASCADE_CFG) { cfgCache = sandbox.window.CASCADE_CFG; return cfgCache; }
    } catch (_) { /* next */ }
  }
  cfgCache = {};
  return cfgCache;
}
function asPubkey(s) {
  if (typeof s !== 'string' || !B58.test(s)) return null;
  try { return new PublicKey(s); } catch (_) { return null; }
}
function treasury() { return asPubkey(readConfig().CASCADE_TREASURY || ''); }

// ---------- memo ----------
function memoIx(text) { return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, 'utf8') }); }
function launchMemo(target, n, mode, mint) { return `CASCADE ${target} ${n} ${mode} ${mint}`; }
function parseMemo(memo) {
  const m = MEMO_RE.exec(String(memo || ''));
  if (!m) return null;
  const n = +m[2];
  if (!N_CHOICES.includes(n)) return null;
  return { target: m[1], n, mode: m[3], mint: m[4] };
}
function feeIx(from, to) { return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: FEE_LAMPORTS }); }

// ---------- Helius RPC ----------
function rpcUrl() {
  const k = process.env.HELIUS_API_KEY;
  if (!k) throw httpError(503, 'HELIUS_API_KEY is not set on the server');
  return (process.env.CASCADE_RPC_URL_OVERRIDE || 'https://mainnet.helius-rpc.com/') + '?api-key=' + encodeURIComponent(k);
}
let conn = null, connUrl = '';
function connection() {
  const u = rpcUrl();
  if (!conn || connUrl !== u) { conn = new Connection(u, { commitment: 'confirmed' }); connUrl = u; }
  return conn;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function post(body, label) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch(rpcUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    } catch (e) { if (e.status) throw e; last = httpError(502, label + ': network error'); await sleep(300 * (attempt + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { last = httpError(r.status === 429 ? 429 : 502, label + ': Helius ' + (r.status === 429 ? 'rate limit' : 'HTTP ' + r.status)); await sleep(500 * (attempt + 1)); continue; }
    if (r.status === 401 || r.status === 403) throw httpError(502, 'Helius rejected the API key');
    let j; try { j = await r.json(); } catch (_) { throw httpError(502, label + ': unreadable response'); }
    return j;
  }
  throw last;
}
async function rpc(method, params) {
  const j = await post({ jsonrpc: '2.0', id: 1, method, params }, method);
  if (j.error) throw httpError(502, method + ': ' + String(j.error.message || 'rpc error').slice(0, 160));
  return j.result;
}
// JSON-array batches of <= 20 calls, one batch per second (Helius 429s faster bursts).
let nextBatchAt = 0;
async function rpcBatch(calls) {
  const out = new Array(calls.length);
  for (let i = 0; i < calls.length; i += 20) {
    const chunk = calls.slice(i, i + 20);
    await sleep(nextBatchAt - Date.now());
    nextBatchAt = Date.now() + 1000;
    let body;
    try { body = await post(chunk.map((c, j) => ({ jsonrpc: '2.0', id: j, method: c.method, params: c.params })), chunk[0].method + ' x' + chunk.length); }
    catch (e) { chunk.forEach((_, j) => { out[i + j] = { error: e.message }; }); continue; }
    const byId = new Map((Array.isArray(body) ? body : []).map((x) => [x.id, x]));
    chunk.forEach((_, j) => {
      const x = byId.get(j);
      out[i + j] = !x ? { error: 'missing in batch' } : x.error ? { error: String(x.error.message || 'rpc error') } : { result: x.result };
    });
  }
  return out;
}

// ---------- token info (DAS getAsset) ----------
async function tokenInfo(mint) {
  const a = await rpc('getAsset', { id: mint, options: { showFungible: true } });
  if (!a) throw httpError(404, 'token not found');
  const ti = a.token_info || {};
  if (ti.decimals === undefined || ti.decimals === null) throw httpError(400, 'that address is not a fungible token mint');
  const md = (a.content && a.content.metadata) || {};
  const links = (a.content && a.content.links) || {};
  const files = (a.content && a.content.files) || [];
  return {
    mint, name: md.name || ti.symbol || 'Unknown', symbol: (md.symbol || ti.symbol || '').trim(), decimals: ti.decimals,
    supply: String(ti.supply || '0'), tokenProgram: ti.token_program || null,
    image: links.image || (files[0] && (files[0].cdn_uri || files[0].uri)) || null,
    priceUsd: (ti.price_info && ti.price_info.price_per_token) || null,
  };
}

// ---------- HTTP ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
function fail(res, e) {
  const status = e.status || 500;
  send(res, status, { error: e.status ? e.message : 'internal error' });
  if (!e.status) console.error(e);
}
async function readBody(req, limit = 200_000) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body || '{}'); } catch (_) { throw httpError(400, 'invalid JSON'); } }
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, 'body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { throw httpError(400, 'invalid JSON'); }
}
function query(req) { return new URL(req.url, 'http://x').searchParams; }
const hits = new Map();
function rateLimit(req, key, max, windowMs) {
  const ip = String((req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || 'x').split(',')[0].trim();
  const k = key + ':' + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw httpError(429, 'slow down a little');
  arr.push(now); hits.set(k, arr);
  if (hits.size > 5000) hits.clear();
}

// ---------- sealed tickets (AES-256-GCM + HMAC, keys derived from SESSION_SECRET) ----------
function keys() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw httpError(503, 'SESSION_SECRET missing or shorter than 32 chars');
  return { enc: crypto.createHmac('sha256', s).update('cascade:enc').digest(), mac: crypto.createHmac('sha256', s).update('cascade:mac').digest() };
}
function seal(obj) {
  const { enc, mac } = keys();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', enc, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const body = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', mac).update(body).digest('base64url');
}
function unseal(token, now = Date.now()) {
  if (typeof token !== 'string' || token.split('.').length !== 2) return null;
  const { enc, mac } = keys();
  const [body, sig] = token.split('.');
  const want = crypto.createHmac('sha256', mac).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const raw = Buffer.from(body, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', enc, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const obj = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    if (!obj.exp || obj.exp < now) return null;
    return obj;
  } catch (_) { return null; }
}

module.exports = {
  PUMP_PROGRAM_ID, MEMO_PROGRAM_ID, TOKEN_2022, FEE_LAMPORTS, N_CHOICES, MODES, B58,
  readConfig, asPubkey, treasury, memoIx, launchMemo, parseMemo, feeIx,
  rpcUrl, connection, rpc, rpcBatch, sleep, tokenInfo,
  httpError, send, fail, readBody, query, rateLimit, seal, unseal,
};
