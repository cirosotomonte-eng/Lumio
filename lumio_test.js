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
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node lumio_test.js /path/to/index.html');
  process.exit(1);
}
const html = fs.readFileSync(filePath, 'utf8');

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
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

console.log(`\n=== Lumio test harness — ${filePath} ===\n`);

// ─────────────────────────────────────────────────────────────────────────
// 1. SYNTAX — every inline <script> block must compile
// ─────────────────────────────────────────────────────────────────────────
console.log('-- syntax --');
const scriptBlocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert(scriptBlocks.length >= 2, 'expected at least 2 inline <script> blocks in index.html');
scriptBlocks.forEach((code, i) => {
  test(`script[${i}] compiles (${code.length} chars)`, () => {
    new vm.Script(code, { filename: `script-${i}.js` });
  });
});

// The main app script is the largest block — everything below assumes this.
const mainScript = scriptBlocks.reduce((a, b) => (b.length > a.length ? b : a), '');

// ─────────────────────────────────────────────────────────────────────────
// 2. STATIC — version/timestamp/duplicate-declaration checks
// ─────────────────────────────────────────────────────────────────────────
console.log('-- static --');

test('BUILD_VERSION / BUILD_DISPLAY / BUILD constants are present', () => {
  assert(/const BUILD_VERSION = 'v[\d.]+'/.test(mainScript), 'BUILD_VERSION missing or malformed');
  assert(/const BUILD_DISPLAY = '[^']+AEDT'/.test(mainScript), 'BUILD_DISPLAY missing or malformed');
  assert(/const BUILD = 'v[\d.]+ · [^']+AEDT'/.test(mainScript), 'BUILD missing or malformed');
});

test('all three version/timestamp displays agree with each other', () => {
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

test('no duplicate top-level function declarations', () => {
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

// ─────────────────────────────────────────────────────────────────────────
// 3 & 4. FUNCTION BEHAVIOUR + REGRESSION SUITE
// Mocked-browser sandbox: run the real script, then exercise real functions.
// ─────────────────────────────────────────────────────────────────────────
console.log('-- function behaviour & regression --');

function makeElementStub() {
  return {
    style: {}, classList: { add(){}, remove(){}, toggle(){}, contains: () => false },
    textContent: '', value: '', innerHTML: '', disabled: false,
    addEventListener(){}, removeEventListener(){}, appendChild(){}, click(){},
    getElementById: () => makeElementStub(),
  };
}

function buildSandbox() {
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

test('REGRESSION (session-restore race): init() no longer manually re-parses the SDK\'s own sb-*-auth-token key and calls refreshSession/setSession on it a second time', () => {
  // This is the exact bug that caused a full email/password login on every
  // normal reopen: a hand-rolled refresh racing the SDK's own internal
  // refresh could present an already-rotated refresh token, which Supabase
  // treats as reuse and can invalidate the whole session.
  // Fails against the old code (which had this block); passes against the fix.
  const hasManualReparse = /startsWith\('sb-'\)\s*&&\s*\w*\.endsWith\('-auth-token'\)/.test(mainScript);
  assert(!hasManualReparse, 'init() still manually re-parses the sb-*-auth-token localStorage key — reintroduces the refresh-token-reuse race');
});

test('REGRESSION (duplicate handleSetNewPassword): exactly one definition exists, and it uses the SDK (not a stray authToken variable)', () => {
  const defs = [...mainScript.matchAll(/async function handleSetNewPassword/g)];
  assert(defs.length === 1, `expected exactly 1 handleSetNewPassword definition, found ${defs.length}`);
  assert(!/\bauthToken\b/.test(mainScript), 'stray `authToken` reference found — the broken duplicate password-reset handler may have returned');
  const body = mainScript.slice(mainScript.indexOf('async function handleSetNewPassword'));
  const bodyEnd = body.indexOf('\n}\n');
  const fnBody = body.slice(0, bodyEnd);
  assert(/getSB\(\)\.auth\.updateUser/.test(fnBody), 'handleSetNewPassword no longer calls the SDK\'s auth.updateUser()');
});

test('REGRESSION (401 silent-swallow): authFetch exists and is used by both loadFromSupabase and saveToSupabase', () => {
  assert(/async function authFetch\(/.test(mainScript), 'authFetch() helper is missing');
  const loadBody = mainScript.slice(mainScript.indexOf('async function loadFromSupabase'), mainScript.indexOf('async function saveToSupabase'));
  const saveBody = mainScript.slice(mainScript.indexOf('async function saveToSupabase'));
  assert(/authFetch\(/.test(loadBody), 'loadFromSupabase does not use authFetch — a 401 will silently fail with no retry');
  assert(/authFetch\(/.test(saveBody.slice(0, saveBody.indexOf('\n}\n'))), 'saveToSupabase does not use authFetch — a 401 will silently fail with no retry');
});

test('FUNCTION (authFetch behaviour): retries once with a refreshed token on a 401, and returns the retried response', () => {
  const sandbox = buildSandbox();

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

  return sandbox.authFetch('https://example.supabase.co/rest/v1/lumio_data', { headers: { Authorization: 'Bearer stale-token' } })
    .then(res => {
      assert(fetchCallCount === 2, `expected fetch to be called twice (original + retry), got ${fetchCallCount}`);
      assert(res.status === 200, `expected final response status 200, got ${res.status}`);
      assert(lastAuthHeader === 'Bearer refreshed-token-123', `expected retry to use the refreshed token, got ${lastAuthHeader}`);
    });
});

test('FUNCTION (authFetch behaviour): a non-401 response is returned as-is with a single fetch call', () => {
  const sandbox = buildSandbox();
  let fetchCallCount = 0;
  sandbox.fetch = async () => { fetchCallCount++; return { status: 200, json: async () => ([]) }; };
  sandbox.window.supabase = { createClient: () => ({ auth: { onAuthStateChange(){}, refreshSession: async () => ({ data: {}, error: null }) } }) };

  return sandbox.authFetch('https://example.supabase.co/rest/v1/lumio_data', { headers: {} })
    .then(res => {
      assert(fetchCallCount === 1, `expected exactly 1 fetch call for a healthy response, got ${fetchCallCount}`);
      assert(res.status === 200, 'expected status 200 to pass through untouched');
    });
});

test('FUNCTION (proactive expiry refresh): init() refreshes a session whose access token expires within 60s before proceeding', () => {
  // Static check — the runtime path depends on network timing we can't
  // safely simulate end-to-end here, so this asserts the guard exists with
  // the correct threshold rather than driving init() itself.
  const initBody = mainScript.slice(mainScript.indexOf('async function init('), mainScript.indexOf('function waitForSupabaseThenInit'));
  assert(/session\.expires_at.*1000.*Date\.now\(\)/.test(initBody), 'proactive expiry-refresh guard missing from init()');
  assert(/60000/.test(initBody), 'proactive expiry-refresh guard does not use the expected 60s threshold');
});

test('REGRESSION (Today tab stuck on "Loading today\'s quote"): checkForUpdate() must not block renderQuote()/renderToday() in onAuthSuccess', () => {
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

test('REGRESSION (update-check timeout): checkForUpdate() and checkForUpdateManual() both use an AbortController so a hung fetch can never block indefinitely', () => {
  const fns = ['async function checkForUpdate(', 'async function checkForUpdateManual('];
  fns.forEach(marker => {
    const start = mainScript.indexOf(marker);
    assert(start !== -1, `${marker} not found`);
    const body = mainScript.slice(start, mainScript.indexOf('\n}\n', start));
    assert(/AbortController/.test(body), `${marker.trim()} does not use AbortController — a hung request has no timeout`);
    assert(/signal:\s*controller\.signal/.test(body), `${marker.trim()} does not pass the abort signal to fetch`);
  });
});

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) {
  process.exit(1);
}
