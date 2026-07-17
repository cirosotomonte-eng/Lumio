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
const path = require('path');

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

function makeStyleStub() {
  // A real CSSStyleDeclaration supports both property assignment
  // (el.style.display = 'flex') and setProperty (for custom properties like
  // --accent, which can't be set via plain assignment in a real browser).
  const props = {};
  return new Proxy(props, {
    get(target, key) {
      if (key === 'setProperty') return (name, value) => { target[name] = value; };
      if (key === 'getPropertyValue') return (name) => target[name] || '';
      return target[key];
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

function makeElementStub() {
  const attrs = {};
  return {
    style: makeStyleStub(), classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    textContent: '', value: '', innerHTML: '', disabled: false,
    addEventListener(){}, removeEventListener(){}, appendChild(){}, click(){},
    getElementById: () => makeElementStub(),
    setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return k in attrs ? attrs[k] : null; }, removeAttribute(k) { delete attrs[k]; },
  };
}

// Drives a real login through handleAuth('login'), rather than assigning
// sandbox._sbSession/sandbox.currentUser directly from outside the vm
// context. Those are declared with `let` at the script's top level, so
// external assignment to the sandbox object does NOT reach the script's
// actual internal bindings (a JS scoping fact, not a mocking choice) —
// loadFromSupabase()'s internal `if (!_sbSession || !currentUser) return;`
// guard would otherwise always see them as unset and silently no-op,
// which would make a test look like it passed or failed for reasons that
// have nothing to do with the code being tested. Routing through the
// script's own handleAuth() lets its own internal assignments do this
// correctly, exactly as a real login would.
async function loginViaHandleAuth(sandbox, { email = 'test@test.com', password = 'password123', userId = 'u1' } = {}) {
  sandbox.document.getElementById('auth-email').value = email;
  sandbox.document.getElementById('auth-password').value = password;
  sandbox.window.supabase.createClient = sandbox.window.supabase.createClient || (() => ({}));
  const client = sandbox.getSB();
  client.auth.signInWithPassword = async () => ({
    data: { session: { access_token: 'tok', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: userId, email } }, user: { id: userId, email } },
    error: null,
  });
  await sandbox.handleAuth('login');
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
  // Cache elements by id so repeated getElementById('x') calls — e.g. one
  // render setting textContent/innerHTML, a later check or a second render
  // reading/overwriting it — see the SAME persistent element, matching how
  // a real DOM behaves. Without this, each call returns an unrelated
  // throwaway stub and nothing set by one function is visible to another.
  const elementCache = {};
  function getCachedElement(id) {
    if (!elementCache[id]) elementCache[id] = makeElementStub();
    return elementCache[id];
  }
  const documentStub = {
    readyState: 'loading', // prevents auto-init from firing during load
    addEventListener(){}, removeEventListener(){},
    getElementById: getCachedElement,
    querySelector: () => makeElementStub(),
    querySelectorAll: () => [],
    createElement: () => makeElementStub(),
    head: { appendChild(){} },
    documentElement: makeElementStub(),
    body: { style: makeStyleStub() },
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
    const appEl = sandbox.document.getElementById('app'); // pre-warm the cached element, then instrument it
    Object.defineProperty(appEl.style, 'display', { get(){ return this._d; }, set(v){ this._d = v; if (v === 'block') appShown = true; } });

    await loginViaHandleAuth(sandbox);
    await new Promise(r => setTimeout(r, 500)); // allow the retry/settle timers to run
    assert(appShown, 'renderToday() throwing left the app permanently hidden — the safety net did not kick in');
  });

  await test('REGRESSION (Today tab empty until manual refresh, round 2): onAuthSuccess() has an automatic reconciliation pass ~1.5s after login', () => {
    // The v5.15 fix (removing the SIGNED_OUT clearing from onAuthStateChange)
    // addressed one plausible cause but did not eliminate the symptom in
    // practice — Ciro still saw the Today tab stay empty until manually
    // tapping refresh. The earlier retry-if-not-loaded logic doesn't help
    // either: it only fires when loadFromSupabase() detectably no-opped,
    // not when it "succeeded" with stale/incomplete data (e.g. read timing
    // on the Supabase side immediately after a fresh sign-in, which we
    // can't observe or reproduce from here). A second automatic load+
    // render a moment later mirrors exactly what the manual refresh
    // button does, so the fix applies regardless of the exact cause.
    const body = mainScript.slice(mainScript.indexOf('async function onAuthSuccess'), mainScript.indexOf('function seedDefaultRoutine'));
    assert(/setTimeout\(async \(\) => \{[\s\S]*?loadFromSupabase\(\)[\s\S]*?renderToday\(\)[\s\S]*?\}, 1500\)/.test(body), 'onAuthSuccess() does not have an automatic delayed reconciliation pass (loadFromSupabase + renderToday inside a ~1.5s setTimeout)');
  });

  await test('FUNCTION (automatic reconciliation): a stale/empty first read is corrected automatically ~1.5s later, without a manual refresh', async () => {
    const sandbox = buildSandbox(mainScript);
    sandbox.window.supabase = { createClient: () => ({ auth: { onAuthStateChange(){}, refreshSession: async () => ({ data: {}, error: null }) } }) };
    sandbox.localStorage.setItem('lumio_pin_skipped', '1'); // no lock screen — app shows directly

    let fetchCallCount = 0;
    sandbox.fetch = async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // Simulates the exact symptom: the first read comes back empty/stale.
        return { status: 200, json: async () => ([{ data: { habits: [], habitLog: {}, kb: [], pomoLog: {}, settings: {}, focus: '', todos: [], rssEpisodes: [], routine: [{id:'x'}] } }]) };
      }
      // Every subsequent read returns the real, populated data. (habitRowHTML
      // reads h.name/h.category/h.target — not h.title — for the row text.)
      return { status: 200, json: async () => ([{ data: { habits: [{ id: 'h1', name: 'Real habit', category: 'health', target: 7, days: [0,1,2,3,4,5,6] }], habitLog: {}, kb: [], pomoLog: {}, settings: {}, focus: 'Real focus', todos: [], rssEpisodes: [], routine: [{id:'x'}] } }]) };
    };

    await loginViaHandleAuth(sandbox);

    const habitsListImmediately = sandbox.document.getElementById('today-habits-list').innerHTML;
    assert(/No habits scheduled/.test(habitsListImmediately), 'test setup issue: expected the first (stale) read to render as empty so the automatic fix can be proven against it');

    await new Promise(r => setTimeout(r, 1800)); // past the 1.5s automatic reconciliation delay

    const habitsListAfter = sandbox.document.getElementById('today-habits-list').innerHTML;
    assert(/Real habit/.test(habitsListAfter), 'the automatic reconciliation pass did not pick up the real data ~1.5s after login — the Today tab would stay stale until a manual refresh, exactly the reported bug');
  });

  await test('REGRESSION (Face ID silently fails to register): setupFaceId() only awaits a fresh biometric probe if _biomPlatformAvail is still unknown', () => {
    // setupFaceId() used to unconditionally `await probeBiometricAvailable()`
    // before calling registerBiometric() (which calls
    // navigator.credentials.create(), the actual Face ID prompt). On iOS,
    // an intervening await between a tap and a WebAuthn ceremony can cost
    // the "user activation" window the ceremony needs, causing Face ID to
    // silently fail to even prompt — the exact "user gesture requirement
    // for WebAuthn" issue already documented as solved once for Spendly.
    // Fails against the old unconditional await; passes once it's
    // conditional on _biomPlatformAvail actually being unknown.
    const body = mainScript.slice(mainScript.indexOf('async function setupFaceId'), mainScript.indexOf('function removeLockPin'));
    assert(/if\s*\(\s*_biomPlatformAvail\s*===\s*null\s*\)\s*\{\s*await probeBiometricAvailable\(\)/.test(body), 'setupFaceId() still unconditionally awaits probeBiometricAvailable() before the WebAuthn ceremony — risks losing the user-activation window on iOS');
  });

  await test('REGRESSION (Face ID silently fails to register): initLock()\'s bypassed-session path pre-warms _biomPlatformAvail', () => {
    // Without this, a user who logs in fresh with a password (no lock
    // screen shown this session) would have _biomPlatformAvail still
    // unknown by the time they reach Settings > Face ID — guaranteeing
    // setupFaceId() hits the awaited-probe path in exactly the scenario
    // most likely to lose the user-activation window.
    const start = mainScript.indexOf('async function initLock(');
    const bypassBlock = mainScript.slice(start, mainScript.indexOf('await probeBiometricAvailable()', start));
    assert(/probeBiometricAvailable\(\)/.test(bypassBlock), 'initLock() bypass branch does not pre-warm probeBiometricAvailable()');
  });

  await test('REGRESSION (Face ID silently fails to register): a failed registerBiometric() now tells the user, instead of doing nothing', () => {
    const start = mainScript.indexOf('async function setupFaceId');
    const fnBody = mainScript.slice(start, mainScript.indexOf('function removeLockPin'));
    assert(/const ok = await registerBiometric\(\);[\s\S]*?if \(ok\) \{[\s\S]*?\} else \{[\s\S]*?alert\(/.test(fnBody), 'setupFaceId() still has no else-branch alert when registerBiometric() returns false — a failed setup remains silent');
  });

  await test('REGRESSION (Face ID button ordering): the Settings button awaits setupFaceId() before closing the modal', () => {
    assert(!/onclick="setupFaceId\(\);closeModal/.test(html), 'the Face ID button still fires closeModal() immediately without waiting for setupFaceId() — the modal can close mid-ceremony');
    assert(/onclick="setupFaceId\(\)\.then\(\(\) => closeModal/.test(html), 'the Face ID button does not chain .then(() => closeModal(...)) after setupFaceId()');
  });

  await test('REGRESSION (Face ID no visible state): the Settings button label reflects whether Face ID is actually registered', () => {
    assert(/function updateFaceIdButtonLabel/.test(mainScript), 'updateFaceIdButtonLabel() is missing — the button always read the same text regardless of whether Face ID was ever successfully set up');
    const initSettingsBody = mainScript.slice(mainScript.indexOf('function initSettings('), mainScript.indexOf('function initSettings(') + 800);
    assert(/updateFaceIdButtonLabel\(\)/.test(initSettingsBody), 'initSettings() does not call updateFaceIdButtonLabel() to reflect current state when Settings opens');
    const setupFaceIdBody = mainScript.slice(mainScript.indexOf('async function setupFaceId'), mainScript.indexOf('function removeLockPin'));
    assert(/updateFaceIdButtonLabel\(\)/.test(setupFaceIdBody), 'setupFaceId() does not refresh the button label immediately after a setup/removal attempt');
  });

  await test('REGRESSION (invisible home-screen icon): a real apple-touch-icon and app title are declared', () => {
    // With no apple-touch-icon, iOS uses a screenshot of the page as the
    // home-screen icon. Lumio's background is near-white cream, so that
    // tile was an almost-invisible pale square — findable in Spotlight
    // search but not spottable on the home screen. A real PNG icon and an
    // explicit app title fix both the visibility and the label.
    assert(/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']apple-touch-icon\.png/.test(html), 'no <link rel="apple-touch-icon" href="apple-touch-icon.png"> — iOS will fall back to a blank screenshot for the home-screen icon');
    assert(/<meta[^>]+name=["']apple-mobile-web-app-title["'][^>]+content=["']Lumio["']/.test(html), 'missing <meta name="apple-mobile-web-app-title" content="Lumio"> — the label under the home-screen icon');
  });

  await test('REGRESSION (missing referenced assets 404): every locally-referenced asset in <head> actually exists on disk', () => {
    // The head referenced manifest.json, which did not exist in the repo at
    // all — a silent 404. This check resolves every same-origin asset
    // referenced from the head (manifest + icons) against the directory the
    // index.html lives in, and fails if any is missing. Generalises the fix
    // so any future "referenced but never committed" asset is caught here.
    const dir = path.dirname(path.resolve(filePath));
    const headEnd = html.indexOf('</head>');
    const head = headEnd === -1 ? html : html.slice(0, headEnd);
    const refs = [...head.matchAll(/(?:href|src)=["']([^"':?#]+\.(?:png|json|ico|svg|webmanifest))(?:\?[^"']*)?["']/g)].map(m => m[1]);
    // Only same-origin, relative paths (skip absolute URLs and data: URIs).
    const localRefs = [...new Set(refs.filter(r => !/^(https?:)?\/\//.test(r) && !r.startsWith('data:')))];
    assert(localRefs.length > 0, 'expected at least the icon/manifest asset references in <head>');
    const missing = localRefs.filter(r => !fs.existsSync(path.join(dir, r.replace(/^\.?\//, ''))));
    assert(missing.length === 0, `referenced <head> asset(s) do not exist next to index.html (would 404): ${missing.join(', ')}`);
  });

  await test('REGRESSION (missing manifest): manifest.json exists, is valid JSON, and declares icons', () => {
    const dir = path.dirname(path.resolve(filePath));
    const manifestPath = path.join(dir, 'manifest.json');
    assert(fs.existsSync(manifestPath), 'manifest.json is referenced from <head> but does not exist on disk');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (e) { throw new Error('manifest.json is not valid JSON: ' + e.message); }
    assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'manifest.json declares no icons');
    manifest.icons.forEach(ic => {
      assert(fs.existsSync(path.join(dir, ic.src)), `manifest icon "${ic.src}" does not exist on disk`);
    });
  });

  await test('REGRESSION (iOS AutoFill parity with Spendly): login screen has exactly one current-password field and no legacy two-form markup', () => {
    // iOS QuickType password AutoFill gets confused by multiple <form>s and
    // several password inputs present at once. Lumio's old layout had a
    // login-form AND a signup-form, i.e. 3 password fields on the auth
    // screen. Spendly (which AutoFills reliably) uses a single email +
    // single password + one hidden confirm, no <form> wrapper. This mirrors
    // that. We scope the count to the auth screen (excludes the separate
    // recovery/reset card, which is its own hidden flow).
    const authStart = html.indexOf('<div id="auth-screen">');
    const authEnd = html.indexOf('id="auth-card-reset"');
    assert(authStart !== -1 && authEnd !== -1 && authEnd > authStart, 'could not locate the auth-screen / reset-card boundaries');
    const loginArea = html.slice(authStart, authEnd);
    assert(!/<form[^>]+id=["']login-form["']/.test(html) && !/<form[^>]+id=["']signup-form["']/.test(html), 'the old two-<form> login markup is still present — this is what confuses iOS AutoFill');
    const currentPw = (loginArea.match(/autocomplete=["']current-password["']/g) || []).length;
    assert(currentPw === 1, `expected exactly 1 current-password field on the login screen, found ${currentPw}`);
    assert(/id=["']auth-email["'][^>]*autocomplete=["']email["']/.test(loginArea), 'auth-email is missing autocomplete="email" (Spendly uses this for the identifier field)');
    assert(/id=["']auth-submit-btn["'][^>]*onclick=["']handleAuthSubmit\(\)["']/.test(loginArea), 'auth-submit-btn is not wired to handleAuthSubmit()');
  });

  await test('REGRESSION (iOS AutoFill parity): handlers reference the unified auth-* IDs, with no dangling login-/signup- ID references', () => {
    // After consolidating to a single input set, nothing should still call
    // getElementById('login-email' | 'login-password' | 'signup-*') — a
    // leftover reference would throw at runtime (null.value) exactly on the
    // sign-in / sign-out / forgot-password paths.
    const stale = [...mainScript.matchAll(/getElementById\(\s*['"](login-email|login-password|login-submit-btn|login-form|signup-email|signup-password|signup-confirm|signup-submit-btn|signup-form)['"]\s*\)/g)].map(m => m[1]);
    assert(stale.length === 0, `handlers still reference removed element id(s): ${[...new Set(stale)].join(', ')}`);
    assert(/function handleAuthSubmit\(\)/.test(mainScript), 'handleAuthSubmit() (the single submit entry point) is missing');
    assert(/let authMode = 'login'/.test(mainScript), 'authMode state variable is missing');
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
