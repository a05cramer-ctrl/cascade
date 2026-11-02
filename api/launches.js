// GET /api/launches -> real cascades read from the treasury's signatures (30 s cache).
'use strict';
const L = require('./_lib');
const { getCascades } = require('./_registry');

module.exports = async (req, res) => {
  try {
    L.rateLimit(req, 'launches', 60, 60_000);
    L.send(res, 200, await getCascades(), { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=60' });
  } catch (e) { L.fail(res, e); }
};
