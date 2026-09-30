'use strict';
// THE CONTROL WRITE PATH — validation, refusal, and the authentication around it.
//
// This is the first authenticated surface on this server, and what it guards can change what trades with real
// money. The properties that matter:
//   - a typo is refused AT WRITE TIME, not left to govern nothing until somebody reads /health
//   - an unparseable existing file is never overwritten — it may hold a halt someone is relying on
//   - a stale cache is never written back, or it would silently revert someone else's change
//   - the write returns the state the ENGINE will act on, including a live -> paper downgrade
//   - no token configured means the endpoint is OFF, not open
//
// Run: node server/tests/unit/candle-spread-control-write.test.js
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const SC = require('../../src/candle-spread/strategy-control');
const ROSTER = ['v7-10', 'v6-20', 'v9-20'];
const KEY = 'runs/_control/strategy-control.json';
const quiet = { log: () => {}, warn: () => {} };

function fakeArchive(initial, behaviour = {}) {
  const store = new Map(initial ? [[KEY, initial]] : []);
  const puts = [];
  return { store, puts, PREFIX: 'runs', BUCKET: 'b', enabled: () => behaviour.disabled !== true,
    async getObjectRaw(key) {
      if (behaviour.readFails) return { ok: false, error: 'AccessDenied' };
      if (!store.has(key)) return { ok: false, missing: true };
      return { ok: true, body: store.get(key) };
    },
    async putObjectRaw(key, body) {
      if (behaviour.writeFails) return { ok: false, error: 'AccessDenied' };
      puts.push(body); store.set(key, body); return { ok: true };
    } };
}

(async () => {
  // ── 1. A FIRST WRITE CREATES THE FILE ─────────────────────────────────────────────────────────────
  {
    SC._reset();
    const A = fakeArchive(null);
    const r = await SC.applyPatch({ variant: 'v7-10', mode: 'paper', note: 'first week', by: 'tdriscoll' },
      { archive: A, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(r.ok === true && r.status === 200, `a valid patch writes (${r.status} ${r.error || ''})`);
    const written = JSON.parse(A.puts[0]);
    ok(written.variants['v7-10'].mode === 'paper', 'the entry is stored');
    ok(written.updatedBy === 'tdriscoll' && !!written.updatedAt, 'with provenance for the audit trail');
    ok(A.puts[0].includes('\n  '), 'and pretty-printed, because it is meant to be hand-edited next');
    ok(SC.dryRunFor('v7-10') === 'test', 'the in-process state is refreshed, not left stale');
  }

  // ── 2. A TYPO IS REFUSED AT WRITE TIME ────────────────────────────────────────────────────────────
  // The read path warns about an off-roster name; refusing the WRITE is better, because the operator is still
  // there to see it. Silently accepting "v7-1O" is how "I thought I halted it" happens.
  {
    SC._reset();
    const A = fakeArchive(null);
    const r = await SC.applyPatch({ variant: 'v7-1O', mode: 'live' },
      { archive: A, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(r.ok === false && r.status === 400, `an off-roster variant is refused (${r.status})`);
    ok(/not on the roster/.test(r.error || ''), 'with a reason naming the problem');
    ok(A.puts.length === 0, 'and NOTHING is written');
  }
  {
    SC._reset();
    const A = fakeArchive(null);
    const r = await SC.applyPatch({ variants: { 'v7-10': { mode: 'lives' } } },
      { archive: A, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(r.ok === false && A.puts.length === 0, 'an unusable mode in a whole-file replace is refused too');
    ok((r.rejected || []).length === 1, 'and the offending entry is named back to the caller');
  }

  // ── 3. AN UNPARSEABLE EXISTING FILE IS NEVER OVERWRITTEN ──────────────────────────────────────────
  // It may hold a halt someone is relying on. Replacing it with our own view would silently drop it.
  {
    SC._reset();
    const A = fakeArchive('{ "variants": { "v6-20": { "mode": ');
    const r = await SC.applyPatch({ variant: 'v7-10', mode: 'paper' },
      { archive: A, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(r.ok === false && r.status === 409, `a corrupt existing file blocks the write (${r.status})`);
    ok(/refusing to overwrite/.test(r.error || ''), 'and says so explicitly');
    ok(A.puts.length === 0, 'nothing written');
  }

  // ── 4. THE MERGE STARTS FROM THE BUCKET, NOT THE CACHE ────────────────────────────────────────────
  // Writing a stale view back would silently revert a change someone else made.
  {
    SC._reset();
    const A = fakeArchive(JSON.stringify({ variants: { 'v6-20': { mode: 'simulate', restrict: 'halt' } } }));
    await SC.refresh({ archive: A, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    // someone edits the bucket directly, behind our cache
    A.store.set(KEY, JSON.stringify({ variants: { 'v9-20': { mode: 'paper' } } }));
    const r = await SC.applyPatch({ variant: 'v7-10', mode: 'paper' },
      { archive: A, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    const w = JSON.parse(A.puts[0]);
    ok(r.ok === true, 'the patch applies');
    ok(!!w.variants['v9-20'], "the OTHER editor's entry survives — the merge read the bucket");
    ok(!w.variants['v6-20'], 'and the entry only our stale cache knew about is gone, as it should be');
  }

  // ── 5. REMOVE PUTS A VARIANT BACK TO SIMULATE ─────────────────────────────────────────────────────
  {
    SC._reset();
    const A = fakeArchive(JSON.stringify({ variants: { 'v7-10': { mode: 'live' }, 'v6-20': { mode: 'paper' } } }));
    const r = await SC.applyPatch({ variant: 'v7-10', remove: true, by: 'tdriscoll' },
      { archive: A, knownVariants: ROSTER, liveAllowed: true, ...quiet });
    const w = JSON.parse(A.puts[0]);
    ok(r.ok === true && !w.variants['v7-10'], 'remove deletes the entry');
    ok(!!w.variants['v6-20'], 'leaving the others alone');
    ok(SC.forVariant('v7-10').mode === 'simulate', 'so the variant is back to simulation');
  }

  // ── 6. THE RESPONSE REPORTS WHAT THE ENGINE WILL DO, NOT WHAT WAS ASKED ───────────────────────────
  // liveAllowed:false must surface the downgrade, or a caller is told 'live' and gets paper.
  {
    SC._reset();
    const A = fakeArchive(null);
    const r = await SC.applyPatch({ variant: 'v6-20', mode: 'live' },
      { archive: A, knownVariants: ROSTER, liveAllowed: false, ...quiet });
    ok(r.ok === true, 'storing the intent is allowed');
    ok(JSON.parse(A.puts[0]).variants['v6-20'].mode === 'live', "and the FILE records 'live' as asked");
    ok(r.state.live.length === 0 && r.state.paper.join() === 'v6-20',
      'but the returned state shows it running as paper');
    ok((r.state.downgraded || []).length === 1, 'with the downgrade explained');
  }

  // ── 7. FAILURES ARE REPORTED, NOT SWALLOWED ───────────────────────────────────────────────────────
  {
    SC._reset();
    let r = await SC.applyPatch({ variant: 'v7-10', mode: 'paper' },
      { archive: fakeArchive(null, { writeFails: true }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(r.ok === false && r.status === 502, `a failed write reports 502 (${r.status})`);
    r = await SC.applyPatch({ variant: 'v7-10', mode: 'paper' },
      { archive: fakeArchive(null, { readFails: true }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(r.ok === false && r.status === 502, 'an unreadable current file reports 502 rather than clobbering');
    r = await SC.applyPatch({ variant: 'v7-10', mode: 'paper' },
      { archive: fakeArchive(null, { disabled: true }), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(r.ok === false && r.status === 503, 'no archive configured reports 503');
    r = await SC.applyPatch({}, { archive: fakeArchive(null), knownVariants: ROSTER, liveAllowed: true, ...quiet });
    ok(r.ok === false && r.status === 400, 'an empty patch is a 400, not a silent no-op');
  }

  // ── 8. AUTHENTICATION ─────────────────────────────────────────────────────────────────────────────
  // Exercised through the real handler, with a fake req, so the auth logic is the thing under test.
  {
    const saved = process.env.CANDLE_SPREAD_CONTROL_TOKEN;
    const mkReq = (token, body) => ({ get: (h) => (h.toLowerCase() === 'x-control-token' ? token : undefined), body });
    const load = () => { delete require.cache[require.resolve('../../src/candle-spread/index')];
      const _l = console.log, _w = console.warn; console.log = () => {}; console.warn = () => {};
      const I = require('../../src/candle-spread/index'); console.log = _l; console.warn = _w; return I; };

    // NO TOKEN CONFIGURED = OFF, NOT OPEN. A default secret on a box that can place real orders is worse than
    // having no endpoint.
    delete process.env.CANDLE_SPREAD_CONTROL_TOKEN;
    let I = load();
    let out = await I.handleControlWrite(mkReq(undefined, { variant: 'v7-10', mode: 'live' }));
    ok(out.status === 503, `no token configured -> 503 disabled, not 200 (${out.status})`);
    out = await I.handleControlWrite(mkReq('anything', { variant: 'v7-10', mode: 'live' }));
    ok(out.status === 503, 'and no token can be guessed into working while it is unset');

    process.env.CANDLE_SPREAD_CONTROL_TOKEN = 'correct-horse-battery-staple';
    I = load();
    out = await I.handleControlWrite(mkReq(undefined, { variant: 'v7-10', mode: 'live' }));
    ok(out.status === 401, `a missing header is 401 (${out.status})`);
    out = await I.handleControlWrite(mkReq('wrong', { variant: 'v7-10', mode: 'live' }));
    ok(out.status === 401, 'a wrong token is 401');
    ok(!JSON.stringify(out.body).includes('correct-horse'), 'and the response never echoes the real token');
    // A PREFIX MUST NOT PASS. Digest comparison means a correct prefix is no closer than a wrong one.
    out = await I.handleControlWrite(mkReq('correct-horse-battery-stapl', {}));
    ok(out.status === 401, 'a token that is right except for the last character is still 401');

    if (saved == null) delete process.env.CANDLE_SPREAD_CONTROL_TOKEN;
    else process.env.CANDLE_SPREAD_CONTROL_TOKEN = saved;
    delete require.cache[require.resolve('../../src/candle-spread/index')];
  }

  SC._reset();
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
