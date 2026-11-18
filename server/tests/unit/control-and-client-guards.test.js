'use strict';
// STATIC GUARDS (2026-11-18) for wiring that no runtime unit can reach without a browser or a live server.
//   - the Schwab token route is registered BEFORE the /control/:preset route (which would otherwise swallow it as a
//     preset name) and goes through the shared control-token check;
//   - the index page's Schwab hand-off passes the code in the URL HASH (never a query string, which gets logged) to
//     /control, and the control page reads it from the hash and clears it;
//   - every polling loop in client/lib skips its turn while the tab is hidden (a746989: tabs left open across
//     browsers were a steady load on the 2 GB box). A new setInterval poll must do the same.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

// 1) route order and auth
const proxy = read('server/src/proxy-server-sdk.js');
const iTok = proxy.indexOf("app.post('/api/v1/candle-spread/control/schwab-token'");
const iPreset = proxy.indexOf("app.post('/api/v1/candle-spread/control/:preset'");
ok(iTok > 0 && iPreset > 0 && iTok < iPreset, 'schwab-token route is registered before the :preset route');
ok(/schwabTokenStore\.handleUpdate\(req, \{\s*authOk: candleSpread\.controlAuthOk/.test(proxy), 'the token route uses the shared control-token check');
const iApply = proxy.indexOf('schwabTokenStore.applyStoredTokenSync()');
const iFirstClient = proxy.indexOf("require('./persistence/candle-analyzer')");
ok(iApply > 0 && iApply < iFirstClient, 'the stored token is applied before any module builds a Schwab client');

// 2) the hand-off
const handoff = read('client/lib/schwab-code-handoff.js');
ok(/\/control#schwab-code=\$\{encodeURIComponent\(code\)\}/.test(handoff), 'index -> /control hands the code over in the URL hash');
ok(!/\/control\?/.test(handoff), 'the code is never put in a query string');
ok(read('index.html').indexOf('schwab-api.js') < read('index.html').indexOf('schwab-code-handoff.js'), 'hand-off loads after schwab-api.js (PROXY_URL)');
const control = read('server/src/pages/control.html');
ok(/schwab-code=/.test(control) && /history\.replaceState/.test(control), 'control page reads the code from the hash and clears it');
ok(/API \+ '\/schwab-token'/.test(control) && /'x-control-token': tok/.test(control), 'control page posts the code with the control token');

// 3) hidden tabs do not poll
const libDir = path.join(ROOT, 'client', 'lib');
for (const f of fs.readdirSync(libDir).filter((x) => x.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(libDir, f), 'utf8').replace(/\/\/.*$/gm, '');
  if (/setInterval\s*\(/.test(src)) ok(/document\.hidden/.test(src), `${f}: has a setInterval poll, so it must check document.hidden`);
}
ok(/if \(document\.hidden\) \{\s*liveDataLoopActive = false;/.test(read('client/lib/oc.js')), 'oc.js live loop parks while hidden');
ok(/visibilitychange[\s\S]{0,200}startLiveDataUpdates\(\)/.test(read('client/lib/oc.js')), 'oc.js restarts the live loop when the tab is shown');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
