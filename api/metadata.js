// POST /api/metadata {name,symbol,description,website,twitter,telegram,image:dataURL,targetSymbol,n}
// -> proxies to pump.fun's IPFS endpoint (multipart), returns { metadataUri }.
'use strict';
const L = require('./_lib');
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function description(b) {
  const tick = String(b.targetSymbol || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 12) || 'the target coin';
  const n = L.N_CHOICES.includes(+b.n) ? +b.n : null;
  const tail = `Airdropped at birth to the top ${n || 'N'} holders of ${tick === 'the target coin' ? tick : '$' + tick} via Cascade`;
  const own = String(b.description || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 420);
  return own ? own + '\n\n' + tail : tail;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw L.httpError(405, 'POST only');
    L.rateLimit(req, 'metadata', 8, 60_000);
    const b = await L.readBody(req, 3_500_000);
    const name = String(b.name || '').trim().slice(0, 32);
    const symbol = String(b.symbol || '').trim().toUpperCase().slice(0, 10);
    if (!name || !symbol) throw L.httpError(400, 'name and ticker are required');
    if (!L.N_CHOICES.includes(+b.n)) throw L.httpError(400, 'bad N');
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image || ''));
    if (!m) throw L.httpError(400, 'add a png, jpg, gif or webp image');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 2_000_000) throw L.httpError(413, 'image larger than 2 MB');
    const url = (s) => { s = String(s || '').trim(); return /^https:\/\/[^\s]{3,200}$/.test(s) ? s : ''; };
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: m[1] }), 'image.' + TYPES[m[1]]);
    fd.append('name', name);
    fd.append('symbol', symbol);
    fd.append('description', description(b));
    fd.append('twitter', url(b.twitter));
    fd.append('telegram', url(b.telegram));
    fd.append('website', url(b.website));
    fd.append('showName', 'true');
    const r = await fetch(process.env.CASCADE_IPFS_URL_OVERRIDE || 'https://pump.fun/api/ipfs', { method: 'POST', body: fd, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    if (!r.ok) throw L.httpError(502, 'pump.fun IPFS returned ' + r.status);
    let j; try { j = JSON.parse(text); } catch (_) { throw L.httpError(502, 'pump.fun IPFS returned non-JSON'); }
    if (!j.metadataUri) throw L.httpError(502, 'pump.fun IPFS returned no metadataUri');
    L.send(res, 200, { metadataUri: j.metadataUri, image: (j.metadata && j.metadata.image) || null, description: description(b) });
  } catch (e) { L.fail(res, e); }
};
module.exports.description = description;
