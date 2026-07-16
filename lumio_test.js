#!/usr/bin/env node
/**
 * Lumio test harness — mirrors Spendly's spendly_test.js discipline.
 *
 * Run before every delivery: `node lumio_test.js /path/to/index.html`
 * Any FAIL blocks delivery. Tests accumulate — never delete a passing test
 * to make a build go green; fix the code instead.
 *
 * Categories:
 *   1. SYNTAX     — every <script> block must compile (node vm syntax check)
 *   2. STATIC     — version/timestamp format, version actually bumped/consistent,
 *                   no duplicate function declarations anywhere in the file
 *   3. FUNCTION   — executes real functions from the file in a mocked-browser
 *                   sandbox (vm context) to test actual runtime behaviour
 *   4. REGRESSION — one test per historical bug fix, permanent
 *
 * IMPORTANT: test() is async and every call site MUST be awaited. A test
 * whose fn() returns a promise that later rejects (an async assertion
 * failure) will be silently reported as a PASS if it isn't awaited — this
 * bit us once already (the initLock state-machine test passed against
 * broken code because its rejection wasn't caught). Always `await test(...)`.
 */

const fs = require('fs');
const vm = require('vm');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node lumio_test.js /path/to/index.html');
  process.exit(1);
}
const html = fs.readFileSync(filePath, 'utf8');

let pass = 0, fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function makeElementStub() {
  return {
    style: {}, classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    textContent: '', value: '', innerHTML: '', disabled: false,
    addEventListener(){}, removeEventListener(){}, appendChild(){}, click(){},
    getElementById: () => makeElementStub(),
  };
}

function buildSandbox(mainScript) {
  const store = {};
  const sessStore = {};
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k => delete store[k]); },
    get length() { return Object.keys(store).length; },
    key: i => Object.keys(store)[i],
  };
  const sessionStorage = {
    getItem: k => (k in sessStore ? sessStore[k] : null),
    setItem: (k, v) => { sessStore[k] = String(v); },
    removeItem: k => { delete sessStore[k]; },
    clear: () => { Object.keys(sessStore).forEach(k => delete sessStore[k]); },
  };
  const documentStub = {
    readyState: 'loading', // prevents auto-init from firing during load
    addEventListener(){}, removeEventListener(){},
    getElementById: () => makeElementStub(),
    querySelector: () => makeElementStub(),
    querySelectorAll: () => [],
    createElement: () => makeElementStub(),
    head: { appendChild(){} },
    documentElement: { style: {} },
    body: { style: {} },
  };
  const sandbox = {
    console,
    localStorage, sessionStorage,
    document: documentStub,
    window: {},
    navigator: {},
    location: { hostname: 'cirosotomonte-eng.github.io', hash: '', pathname: '/Lumio/', href: '' },
    history: { replaceState(){} },
    crypto: { getRandomValues: arr => arr },
    URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => setTimeout(fn, 0),
    confirm: () => true, alert: () => {},
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    fetch: undefined, // set per-test
  };
  sandbox.window = sandbox; // window.X resolves to global sandbox X
  vm.createContext(sandbox);
  new vm.Script(mainScript, { filename: 'lumio-main.js' }).runInContext(sandbox);
  return sandbox;
}

async function main() {
  console.log(`\n=== Lumio test harness — ${filePath} ===\n`);

  // ───────────────────────────────────────────────────────────────────────
  // 1. SYNTAX — every inline <script> block must compile
  // ───────────────────────────────────────────────────────────────────────
  console.log('-- syntax --');
  const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert(scriptBlocks.length >= 2, 'expected at least 2 inline <script> blocks in index.html');
  for (let i = 0; i < scriptBlocks.length; i++) {
    const code = scriptBlocks[i];
    await test(`script[${i}] compiles (${code.length} chars)`, () => {
      new vm.Script(code, { filename: `script-${i}.js` });
    });
  }

  // The main app script is the largest block — everything below assumes this.
  const mainScript = scriptBlocks.reduce((a, b) => (b.length > a.length ? b : a), '');

  // ───────────────────────────────────────────────────────────────────────
  // 2. STATIC — version/timestamp/duplicate-declaration checks
  // ───────────────────────────────────────────────────────────────────────
  console.log('-- static --');

  await test('BUILD_VERSION / BUILD_DISPLAY / BUILD constants are present', () => {
    assert(/const BUILD_VERSION = 'v[\d.]+'/.test(mainScript), 'BUILD_VERSION missing or malformed');
    assert(/const BUILD_DISPLAY = '[^']+AEDT'/.test(mainScript), 'BUILD_DISPLAY missing or malformed');
    assert(/const BUILD = 'v[\d.]+ · [^']+AEDT'/.test(mainScript), 'BUILD missing or malformed');
  });

  await test('all three version/timestamp displays agree with each other', () => {
    const bv = mainScript.match(/const BUILD_VERSION = '([^']+)'/)[1];
    const bd = mainScript.match(/const BUILD_DISPLAY = '([^']+)'/)[1];
    const settingsNum = html.match(/id="settings-version-num">Lumio (v[\d.]+)</)[1];
    const settingsTime = html.match(/id="settings-version-time">([^<]+)</)[1];
    const footer = html.match(/Lumio (v[\d.]+) · ([^<]+)</);
    assert(footer, 'footer build-info line not found');
    assert(bv === settingsNum, `BUILD_VERSION (${bv}) != settings-version-num (${settingsNum})`);
    assert(bv === footer[1], `BUILD_VERSION (${bv}) != footer version (${footer[1]})`);
    assert(bd === settingsTime, `BUILD_DISPLAY (${bd}) != settings-version-time (${settingsTime})`);
    assert(bd === footer[2], `BUILD_DISPLAY (${bd}) != footer timestamp (${footer[2]})`);
  });

  await test('no duplicate top-level function declarations', () => {
    const names = [...mainScript.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)/gm)].map(m => m[1]);
    const counts = {};
    names.forEach(n => { counts[n] = (counts[n] || 0) + 1; });
    const dupes = Object.entries(counts).filter(([, c]) => c > 1);
    // NOTE: renderShoppingList is a pre-existing duplicate unrelated to auth,
    // tracked separately — not blocking this harness until addressed.
    const known = new Set(['renderShoppingList']);
    const unexpected = dupes.filter(([n]) => !known.has(n));
    assert(unexpected.length === 0, `unexpected duplicate function declarations: ${unexpected.map(([n, c]) => `${n} (x${c})`).join(', ')}`);
  });

  await test('REGRESSION (blank screen after login): auth-screen no longer contains dead, never-updated hardcoded version text', () => {
    // "Lumio · 13 Jul 2026 4:46 PM AEDT" sat inside the login screen itself,
    // completely disconnected from BUILD_VERSION/BUILD_DISPLAY, so every
    // version bump left it stale — and it duplicated the correct, always-
    // current footer build-info line already visible on the same screen
    // (that line lives outside #app, at the very bottom of <body>, so it
    // shows on the login screen too). Users saw two different version
    // strings on one screen. Fails against the old markup; passes once the
    // dead line is gone.
    assert(!/Lumio · \d{1,2} \w{3} \d{4}/.test(html), 'a second, hand-typed "Lumio · <date>" string still exists somewhere in the markup — should be the single dynamic footer line only');
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3 & 4. FUNCTION BEHAVIOUR + REGRESSION SUITE
  // Mocked-browser sandbox: run the real script, then exercise real functions.
  // ───────────────────────────────────────────────────────────────────────
  console.log('-- function behaviour & regression --');

  await test('REGRESSION (session-restore race): init() no longer manually re-parses the SDK\'s own sb-*-auth-token key and calls refreshSession/setSession on it a second time', () => {
    // This is the exact bug that caused a full email/password login on every
    // normal reopen: a hand-rolled refresh racing the SDK's own internal
    // refresh could present an already-rotated refresh token, which Supabase
    // treats as reuse and can invalidate the whole session.
    // Fails against the old code (which had this block); passes against the fix.
    const hasManualReparse = /startsWith\('sb-'\)\s*&&\s*\w*\.endsWith\('-auth-token'\)/.test(mainScript);
    assert(!hasManualReparse, 'init() still manually re-parses the sb-*-auth-token localStorage key — reintroduces the refresh-token-reuse race');
  });

  await test('REGRESSION (duplicate handleSetNewPassword): exactly one definition exists, and it uses the SDK (not a stray authToken variable)', () => {
    const defs = [...mainScript.matchAll(/async function handleSetNewPassword/g)];
    assert(defs.length === 1, `expected exactly 1 handleSetNewPassword definition, found ${defs.length}`);
    assert(!/\bauthToken\b/.test(mainScript), 'stray `authToken` reference found — the broken duplicate password-reset handler may have returned');
    const body = mainScript.slice(mainScript.indexOf('async function handleSetNewPassword'));
    const bodyEnd = body.indexOf('\n}\n');
    const fnBody = body.slice(0, bodyEnd);
    assert(/getSB\(\)\.auth\.updateUser/.test(fnBody), 'handleSetNewPassword no longer calls the SDK\'s auth.updateUser()');
  });

  await test('REGRESSION (401 silent-swallow): authFetch exists and is used by both loadFromSupabase and saveToSupabase', () => {
    assert(/async function authFetch\(/.test(mainScript), 'authFetch() helper is missing');
    const loadBody = mainScript.slice(mainScript.indexOf('async function loadFromSupabase'), mainScript.indexOf('async function saveToSupabase'));
    const saveBody = mainScript.slice(mainScript.indexOf('async function saveToSupabase'));
    assert(/authFetch\(/.test(loadBody), 'loadFromSupabase does not use authFetch — a 401 will silently fail with no retry');
    assert(/authFetch\(/.test(saveBody.slice(0, saveBody.indexOf('\n}\n'))), 'saveToSupabase does not use authFetch — a 401 will silently fail with no retry');
  });

  await test('FUNCTION (authFetch behaviour): retries once with a refreshed token on a 401, and returns the retried response', async () => {
    const sandbox = buildSandbox(mainScript);

    let fetchCallCount = 0;
    let lastAuthHeader = null;
    sandbox.fetch = async (url, opts) => {
      fetchCallCount++;
      lastAuthHeader = opts.headers && opts.headers.Authorization;
      if (fetchCallCount === 1) {
        return { status: 401, json: async () => ({ message: 'JWT expired' }) };
      }
      return { status: 200, json: async () => ([{ data: { ok: true } }]) };
    };

    sandbox.window.supabase = {
      createClient: () => ({
        auth: {
          onAuthStateChange: () => {},
          refreshSession: async () => ({
            data: { session: { access_token: 'refreshed-token-123', user: { id: 'user-1' } } },
            error: null,
          }),
        },
      }),
    };

    const res = await sandbox.authFetch('https://example.supabase.co/rest/v1/lumio_data', { headers: { Authorization: 'Bearer stale-token' } });
    assert(fetchCallCount === 2, `expected fetch to be called twice (original + retry), got ${fetchCallCount}`);
    assert(res.status === 200, `expected final response status 200, got ${res.status}`);
    assert(lastAuthHeader === 'Bearer refreshed-token-123', `expected retry to use the refreshed token, got ${lastAuthHeader}`);
  });

  await test('FUNCTION (authFetch behaviour): a non-401 response is returned as-is with a single fetch call', async () => {
    const sandbox = buildSandbox(mainScript);
    let fetchCallCount = 0;
    sandbox.fetch = async () => { fetchCallCount++; return { status: 200, json: async () => ([]) }; };
    sandbox.window.supabase = { createClient: () => ({ auth: { onAuthStateChange(){}, refreshSession: async () => ({ data: {}, error: null }) } }) };

    const res = await sandbox.authFetch('https://example.supabase.co/rest/v1/lumio_data', { headers: {} });
    assert(fetchCallCount === 1, `expected exactly 1 fetch call for a healthy response, got ${fetchCallCount}`);
    assert(res.status === 200, 'expected status 200 to pass through untouched');
  });

  await test('FUNCTION (proactive expiry refresh): init() refreshes a session whose access token expires within 60s before proceeding', () => {
    // Static check — the runtime path depends on network timing we can't
    // safely simulate end-to-end here, so this asserts the guard exists with
    // the correct threshold rather than driving init() itself.
    const initBody = mainScript.slice(mainScript.indexOf('async function init('), mainScript.indexOf('function waitForSupabaseThenInit'));
    assert(/session\.expires_at.*1000.*Date\.now\(\)/.test(initBody), 'proactive expiry-refresh guard missing from init()');
    assert(/60000/.test(initBody), 'proactive expiry-refresh guard does not use the expected 60s threshold');
  });

  await test('REGRESSION (Today tab stuck on "Loading today\'s quote"): checkForUpdate() must not block renderQuote()/renderToday() in onAuthSuccess', () => {
    // checkForUpdate() fetches the entire deployed index.html from a
    // different origin with no timeout. It used to be `await`-ed BEFORE
    // renderQuote()/renderToday(), so any slowness reaching GitHub Pages (or
    // a hung request) stalled the whole Today page — quote stuck on
    // "Loading today's quote…", stats/habits empty, for as long as that
    // fetch took. Fails against the old ordering; passes against the fix.
    const body = mainScript.slice(mainScript.indexOf('async function onAuthSuccess'), mainScript.indexOf('function seedDefaultRoutine'));
    assert(!/await checkForUpdate\(\)/.test(body), 'checkForUpdate() is awaited in onAuthSuccess — it can block the whole UI on a slow/hung cross-origin fetch');
    const quoteIdx = body.indexOf('renderQuote()');
    const todayIdx = body.indexOf('renderToday()');
    const updateIdx = body.indexOf('checkForUpdate()');
    assert(quoteIdx !== -1, 'renderQuote() call missing from onAuthSuccess');
    assert(todayIdx !== -1, 'renderToday() call missing from onAuthSuccess');
    assert(updateIdx !== -1, 'checkForUpdate() call missing from onAuthSuccess');
    assert(quoteIdx < updateIdx, 'renderQuote() must run before the background checkForUpdate() call, not after');
    assert(todayIdx < updateIdx, 'renderToday() must run before the background checkForUpdate() call, not after');
  });

  await test('REGRESSION (update-check timeout): checkForUpdate() and checkForUpdateManual() both use an AbortController so a hung fetch can never block indefinitely', () => {
    const fns = ['async function checkForUpdate(', 'async function checkForUpdateManual('];
    fns.forEach(marker => {
      const start = mainScript.indexOf(marker);
      assert(start !== -1, `${marker} not found`);
      const body = mainScript.slice(start, mainScript.indexOf('\n}\n', start));
      assert(/AbortController/.test(body), `${marker.trim()} does not use AbortController — a hung request has no timeout`);
      assert(/signal:\s*controller\.signal/.test(body), `${marker.trim()} does not pass the abort signal to fetch`);
    });
  });

  await test('REGRESSION (data visible/scrollable behind lock screen): onAuthSuccess() must not reveal #app before initLock() decides whether a lock is needed', () => {
    // showApp() used to run at the top of onAuthSuccess(), well before
    // initLock(). That meant the real, already-rendered app sat in the DOM
    // the whole time the PIN/Face ID screen was "covering" it, and since
    // nothing disabled background scroll, a user could scroll straight past
    // the lock screen and see their real data while supposedly locked out.
    // Fails against the old code (which calls showApp() here); passes once
    // showApp() is only reachable through actual unlock paths.
    const start = mainScript.indexOf('async function onAuthSuccess');
    const end = mainScript.indexOf('function seedDefaultRoutine');
    assert(start !== -1 && end !== -1 && end > start, 'could not locate onAuthSuccess()/seedDefaultRoutine() boundaries in source');
    const body = mainScript.slice(start, end);
    const initLockIdx = body.indexOf('initLock(');
    assert(initLockIdx !== -1, 'onAuthSuccess() no longer calls initLock() at all');
    const beforeInitLock = body.slice(0, initLockIdx);
    assert(!/\bshowApp\(\);/.test(beforeInitLock), 'onAuthSuccess() calls showApp() before initLock() runs — #app can be revealed before the lock screen has decided whether it should show. (A showApp() call is fine AFTER initLock() starts, e.g. as its own .catch() fallback — but not before.)');
  });

  await test('REGRESSION (bypassed lock never reveals app): initLock()\'s early-return (password login this session) must call showApp() itself', () => {
    // Since onAuthSuccess() no longer reveals #app, the one path where no
    // lock screen ever appears (fresh password login, pin bypassed for this
    // session) must take responsibility for showing the app — otherwise the
    // user would be stuck staring at a blank/hidden #app forever.
    const start = mainScript.indexOf('async function initLock(');
    const bypassLine = mainScript.slice(start, mainScript.indexOf('\n', start + 1) + 400);
    assert(/lumio_pin_bypassed/.test(bypassLine), 'initLock() early-return guard for lumio_pin_bypassed not found where expected');
    assert(/showApp\(\)/.test(bypassLine), 'initLock() bypass path does not call showApp() — app would stay hidden after a fresh password login');
  });

  await test('REGRESSION (scroll-lock defense in depth): showLockScreen()/hideLockScreen() toggle body scroll so nothing behind a full-screen fixed overlay can ever be scrolled to', () => {
    const showBody = mainScript.slice(mainScript.indexOf('function showLockScreen()'), mainScript.indexOf('function hideLockScreen()'));
    const hideBody = mainScript.slice(mainScript.indexOf('function hideLockScreen()'), mainScript.indexOf('function showPinPad()'));
    assert(/document\.body\.style\.overflow\s*=\s*'hidden'/.test(showBody), 'showLockScreen() does not lock body scroll');
    assert(/document\.body\.style\.overflow\s*=\s*''/.test(hideBody), 'hideLockScreen() does not restore body scroll');
  });

  await test('REGRESSION (Today tab empty until manual refresh): onAuthStateChange must not clear _sbSession on SIGNED_OUT — handleSignOut() already does that explicitly', () => {
    // A SIGNED_OUT event firing from this listener during the SDK's own
    // session-restore settling (a known timing quirk right after
    // createClient()) could null out a session loadFromSupabase() was about
    // to use, making it silently no-op and leave the Today tab empty until
    // a manual refresh ran later once the SDK had settled. handleSignOut()
    // already clears _sbSession/currentUser itself when the user actually
    // signs out, so this listener doing it again only adds risk.
    // Fails against the old code (which had this branch); passes against the fix.
    const getSBBody = mainScript.slice(mainScript.indexOf('function getSB('), mainScript.indexOf('function authHeaders('));
    assert(!/SIGNED_OUT['"]?\)\s*\{\s*\n?\s*_sbSession\s*=\s*null/.test(getSBBody), 'onAuthStateChange still nulls _sbSession on SIGNED_OUT — reintroduces the race with loadFromSupabase()');
    const signOutBody = mainScript.slice(mainScript.indexOf('async function handleSignOut'), mainScript.indexOf('async function handleSetNewPassword'));
    assert(/_sbSession\s*=\s*null;\s*currentUser\s*=\s*null;/.test(signOutBody), 'handleSignOut() no longer explicitly clears _sbSession/currentUser — sign-out would leave a stale session');
  });

  await test('REGRESSION (Today tab empty until manual refresh): onAuthSuccess() retries loadFromSupabase() once if it silently no-op\'d', () => {
    const body = mainScript.slice(mainScript.indexOf('async function onAuthSuccess'), mainScript.indexOf('function seedDefaultRoutine'));
    assert(/_hasLoadedFromSupabase/.test(body), 'onAuthSuccess() does not check _hasLoadedFromSupabase after the first loadFromSupabase() call');
    const retryIdx = body.indexOf('_hasLoadedFromSupabase');
    const afterGuard = body.slice(retryIdx);
    assert(/loadFromSupabase\(\)/.test(afterGuard.slice(afterGuard.indexOf('{'))), 'onAuthSuccess() does not retry loadFromSupabase() when the initial call silently no-opped');
  });

  await test('REGRESSION (blank screen after login): initLock() has an explicit branch for every (hasPin, skipped) combination — no silent no-op', () => {
    // initLock() used to be: `if (!hasPin && !skipped) {...; return;}` then
    // `if (hasPin) {...}` with NO else. A user who had previously tapped
    // "Skip for now" during PIN setup (skipped=true) and never set a PIN
    // (hasPin=false) matched neither branch — the function did nothing at
    // all, and since showApp() was removed from onAuthSuccess() (the
    // v5.14 lock-screen security fix), #app stayed display:none forever.
    // Login would "succeed" into a permanently blank screen.
    // Fails against the old code; passes once every combination is handled.
    const start = mainScript.indexOf('async function initLock(');
    const end = mainScript.indexOf('async function setupFaceId');
    assert(start !== -1 && end !== -1 && end > start, 'could not locate initLock()/setupFaceId() boundaries in source');
    const body = mainScript.slice(start, end);
    assert(/if\s*\(hasPin\)/.test(body), 'initLock() no longer branches on hasPin');
    assert(/if\s*\(!skipped\)/.test(body), 'initLock() no longer branches on !skipped for first-time setup');
    // The critical case: hasPin=false AND skipped=true must be reachable and
    // must call showApp() — i.e. there must be an unconditional showApp()
    // call after both the hasPin and !skipped branches have `return`ed.
    const hasPinReturns = /if\s*\(hasPin\)\s*\{[\s\S]*?return;\s*\}/.test(body);
    const skippedSetupReturns = /if\s*\(!skipped\)\s*\{[\s\S]*?return;\s*\}/.test(body);
    assert(hasPinReturns, 'the hasPin branch does not return, so the no-pin-configured fallthrough below it is unreachable in that case');
    assert(skippedSetupReturns, 'the !skipped (first-time setup) branch does not return, so the fallthrough below it is unreachable in that case');
    const tail = body.slice(body.lastIndexOf('return;') + 'return;'.length);
    assert(/showApp\(\)/.test(tail), 'no unconditional showApp() after the hasPin/!skipped branches — the hasPin=false && skipped=true case falls through to nothing, leaving #app hidden forever');
  });

  await test('FUNCTION (initLock state machine): all four (hasPin, skipped) combinations resolve to either the lock screen or a visible app — never silently do nothing', async () => {
    const sandbox = buildSandbox(mainScript);
    sandbox.window.supabase = { createClient: () => ({ auth: { onAuthStateChange(){}, refreshSession: async () => ({ data: {}, error: null }) } }) };

    const cases = [
      { hasPin: false, skipped: false, label: 'first login ever (offer PIN setup)' },
      { hasPin: false, skipped: true,  label: 'previously skipped, no PIN (the bug case)' },
      { hasPin: true,  skipped: false, label: 'returning user with a PIN' },
      { hasPin: true,  skipped: true,  label: 'PIN set (skipped flag stale/irrelevant)' },
    ];

    for (const c of cases) {
      sandbox.localStorage.clear();
      sandbox.sessionStorage.clear();
      if (c.hasPin) sandbox.localStorage.setItem('lumio_pin_hash', 'deadbeef');
      if (c.skipped) sandbox.localStorage.setItem('lumio_pin_skipped', '1');

      let appShown = false, lockShown = false;
      const realGetElementById = sandbox.document.getElementById;
      sandbox.document.getElementById = (id) => {
        const el = makeElementStub();
        if (id === 'app') {
          Object.defineProperty(el.style, 'display', {
            get() { return this._d; },
            set(v) { this._d = v; if (v === 'block') appShown = true; },
          });
        }
        if (id === 'lock-screen') {
          Object.defineProperty(el, 'style', { value: new Proxy({}, { set(t, k, v) { if (k === 'display' && v === 'flex') lockShown = true; t[k] = v; return true; } }) });
        }
        return el;
      };
      sandbox.document.querySelector = () => makeElementStub();

      await sandbox.initLock();
      assert(appShown || lockShown, `${c.label}: initLock() left the app neither shown nor locked — a silent no-op (blank screen)`);
      sandbox.document.getElementById = realGetElementById;
    }
  });

  await test('REGRESSION (blank screen, any future cause): onAuthSuccess() wraps the render/init chain so an unrelated exception can never again abort before initLock() runs', () => {
    // onAuthSuccess() calls auth-screen.classList.remove('visible') at the
    // very top, before anything else. If ANY later step throws uncaught,
    // the function aborts right there — auth-screen already hidden,
    // showApp()/showLockScreen() never reached — leaving nothing visible
    // at all. This happened once already (the initLock branch-coverage
    // bug); the fix there addressed that one cause, but the same class of
    // bug can recur from any future change to initSettings/initFood/
    // renderToday/initPomo/initRoutine/renderRSSEpisodes. This test checks
    // the structural guard exists so ANY exception in that chain is safe,
    // not just the one we already found.
    const body = mainScript.slice(mainScript.indexOf('async function onAuthSuccess'), mainScript.indexOf('function seedDefaultRoutine'));
    const tryIdx = body.indexOf('try {');
    const catchIdx = body.indexOf('} catch(e) {', tryIdx);
    assert(tryIdx !== -1 && catchIdx !== -1, 'no try/catch wraps the render/init chain in onAuthSuccess()');
    const guarded = body.slice(tryIdx, catchIdx);
    ['initSettings()', 'initFood()', 'renderToday()', 'initPomo()', 'initRoutine()'].forEach(call => {
      assert(guarded.includes(call), `${call} is not inside the protective try block — an exception there would still abort before initLock()`);
    });
    const afterCatch = body.slice(catchIdx);
    assert(/initLock\(\)/.test(afterCatch), 'initLock() is not called after the guarded block — it must run regardless of whether the try block threw');
  });

  await test('REGRESSION (blank screen, last resort): initLock() is called with a .catch() that forces showApp() if initLock() itself throws', () => {
    const body = mainScript.slice(mainScript.indexOf('async function onAuthSuccess'), mainScript.indexOf('function seedDefaultRoutine'));
    // Search for the actual call site, not just any textual mention of
    // "initLock()" — a nearby comment referencing the function name by
    // itself would otherwise satisfy a looser substring search.
    const idx = body.indexOf('initLock().catch(');
    assert(idx !== -1, 'initLock() is not called with a .catch() — if initLock() throws, nothing shows and there is no fallback');
    const tail = body.slice(idx, idx + 250);
    assert(/showApp\(\)/.test(tail), 'the initLock().catch() handler does not call showApp() as a last resort');
  });

  await test('FUNCTION (blank screen safety net): a throwing renderToday() still results in the app or lock screen becoming visible', async () => {
    const sandbox = buildSandbox(mainScript);
    sandbox.window.supabase = { createClient: () => ({ auth: { onAuthStateChange(){}, refreshSession: async () => ({ data: {}, error: null }) } }) };
    sandbox.fetch = async () => ({ status: 200, json: async () => ([{ data: { habits: [], habitLog: {}, kb: [], pomoLog: {}, settings: {}, focus: '', todos: [], rssEpisodes: [], routine: [{id:'x'}] } }]) });
    sandbox.localStorage.setItem('lumio_pin_skipped', '1'); // no PIN, previously skipped -> should reveal the app directly

    // Sabotage a real render function to simulate an unrelated future bug.
    sandbox.renderToday = () => { throw new Error('simulated bug in an unrelated feature'); };

    let appShown = false;
    const realGetElementById = sandbox.document.getElementById;
    sandbox.document.getElementById = (id) => {
      const el = makeElementStub();
      if (id === 'app') {
        Object.defineProperty(el.style, 'display', { get(){ return this._d; }, set(v){ this._d = v; if (v === 'block') appShown = true; } });
      }
      return el;
    };
    sandbox._sbSession = { access_token: 'tok', expires_at: Math.floor(Date.now()/1000) + 3600, user: { id: 'u1' } };
    sandbox.currentUser = sandbox._sbSession.user;

    await sandbox.onAuthSuccess();
    await new Promise(r => setTimeout(r, 500)); // allow the retry/settle timers to run
    sandbox.document.getElementById = realGetElementById;
    assert(appShown, 'renderToday() throwing left the app permanently hidden — the safety net did not kick in');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  // Function-level tests run real onAuthSuccess()/initLock() code in sandboxed
  // vm contexts, which can register real setInterval timers (e.g. the 30-
  // minute update-check poll). Those are harmless inside a throwaway vm
  // context, but they keep Node's event loop alive — force an explicit exit
  // once results are in rather than waiting on timers that will never matter.
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('\nHARNESS CRASHED (not a test failure — the runner itself broke):');
  console.error(e);
  process.exit(1);
});
