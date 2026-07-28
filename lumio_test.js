#!/usr/bin/env node
// Lumio regression harness
// Usage: node lumio_test.js path/to/index.html
// Extracts the app's <script> blocks, pulls out pure-logic functions, and asserts behaviour.
// Hand this file back at the start of each session so accumulated tests persist.

const fs = require('fs');
const path = process.argv[2] || '/home/claude/lumio.html';
const html = fs.readFileSync(path, 'utf8');

let pass = 0, fail = 0;
const fails = [];
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); }
}

// ── Layer 1: every <script> block compiles ─────────────────────────────
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map(m => m[1]).filter(s => !/src=/.test(s.slice(0,60)) && s.trim().length > 10);
let allCompile = true;
scripts.forEach((s, i) => {
  try { new Function(s); } catch (e) { allCompile = false; fails.push(`script block ${i} syntax: ${e.message}`); fail++; }
});
if (allCompile) { pass++; }

const mainScript = scripts.sort((a,b)=>b.length-a.length)[0] || '';

// ── Layer 2: static checks ─────────────────────────────────────────────
check('version bumped past 5.29', /const BUILD_VERSION = 'v5\.(3\d|[4-9]\d)'/.test(html) || /v5\.30/.test(html));
check('BUILD_TIME present', /const BUILD = 'v5\.\d+ · .+AEST'/.test(html) || /const BUILD = 'v5\.\d+ · .+AEDT'/.test(html));
check('scaleIngredient present', /function scaleIngredient/.test(mainScript));
check('renderGymInsights present', /function renderGymInsights/.test(mainScript));
check('renderSuggestions present', /function renderSuggestions/.test(mainScript));
check('openAddToDay present', /function openAddToDay/.test(mainScript));
check('daily calorie total present', /totalCal/.test(mainScript));
check('suitableFor filtering present', /suitableFor/.test(mainScript));
check('scraper writes scrapedPool (Lumio reads it)', /scrapedPool/.test(mainScript));
check('servings open-state preserved', /openIds/.test(mainScript));
check('isSuggestionSaved dedup present', /function isSuggestionSaved/.test(mainScript));
check('normRecipeName helper present', /function _normRecipeName/.test(mainScript));
check('save stores sourceId for dedup', /sourceId:/.test(mainScript));
check('dairy detection helper present', /function isDairyIngredient/.test(mainScript));
check('shopping delete present', /function deleteShopItem/.test(mainScript));
check('shopping clear-all present', /function clearShoppingList/.test(mainScript));
check('add recipe to shopping present', /function addRecipeToShopping/.test(mainScript));

// isDairyIngredient behaviour
try {
  const fn = extractFn('isDairyIngredient', mainScript);
  const kw = mainScript.match(/const DAIRY_KW = \[[^\]]*\];/);
  const dairy = new Function(kw[0] + '\n' + fn + '\nreturn isDairyIngredient;')();
  check('dairy: ricotta is dairy', dairy('12 oz ricotta') === true);
  check('dairy: parmesan is dairy', dairy('grated parmesan') === true);
  check('dairy: lactose-free milk is NOT dairy', dairy('150ml lactose-free milk') === false);
  check('dairy: chicken is NOT dairy', dairy('9 oz chicken breast') === false);
} catch(e) { fails.push('dairy extraction: ' + e.message); fail++; }

// ── Layer 3: extract & test pure functions in a sandbox ────────────────
// Pull the scaler helpers out and eval them in isolation.
function extractFn(name, src) {
  const re = new RegExp(`function ${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = src.match(re);
  if (!m) return null;
  let i = src.indexOf('{', m.index), depth = 0, start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(m.index, i);
}

const sandbox = {};
try {
  const fracConst = mainScript.match(/const _UNICODE_FRAC = \{[^}]*\};/);
  const code = [
    fracConst ? fracConst[0] : '',
    extractFn('_normalizeQty', mainScript),
    extractFn('_fmtWeight', mainScript),
    extractFn('_fmtVol', mainScript),
    extractFn('convertToMetric', mainScript),
    extractFn('scaleMetric', mainScript),
    extractFn('formatIngredient', mainScript),
    extractFn('_normRecipeName', mainScript),
    'return { convertToMetric, scaleMetric, formatIngredient, _normRecipeName };'
  ].join('\n');
  Object.assign(sandbox, new Function(code)());
} catch (e) {
  fails.push('scaler extraction: ' + e.message); fail++;
}

if (sandbox.formatIngredient) {
  const F = sandbox.formatIngredient;
  const C = sandbox.convertToMetric;
  // Metric conversion (no scaling)
  check('convert "1 lb 5 oz" -> "595 g"', C('1 lb 5 oz sweet potato') === '595 g sweet potato');
  check('convert "16 oz" -> "455 g"', C('16 oz ground turkey') === '455 g ground turkey');
  check('convert "5 fl oz" -> "150 ml"', C('5 fl oz vegetable stock') === '150 ml vegetable stock');
  check('convert "1½ cups" -> "355 ml"', C('1½ cups quinoa') === '355 ml quinoa');
  check('convert keeps tbs', C('2 tbs lime juice') === '2 tbs lime juice');
  check('convert keeps whole items', C('2 garlic cloves') === '2 garlic cloves');
  check('convert keeps existing grams', C('50g sourdough') === '50 g sourdough' || C('50g sourdough') === '50g sourdough');
  // Scaling applied exactly once (the double-scale bug regression)
  check('scale "1 lb 5 oz" x2 = "1.19 kg" (once, not 8x)', F('1 lb 5 oz beef', 2) === '1.19 kg beef');
  check('scale "16 oz" x3 = "1.37 kg"', F('16 oz turkey', 3) === '1.37 kg turkey');
  check('scale "5 fl oz" x2 = "300 ml"', F('5 fl oz stock', 2) === '300 ml stock');
  check('scale "2 eggs" x2 = "4 eggs"', F('2 eggs', 2) === '4 eggs');
  check('scale "2 tbs" x2 = "4 tbs"', F('2 tbs lime juice', 2) === '4 tbs lime juice');
  check('scale unquantified unchanged', F('salt & pepper to taste', 2) === 'salt & pepper to taste');
  check('factor 1 leaves metric (no double)', F('16 oz turkey', 1) === '455 g turkey');
}

if (sandbox._normRecipeName) {
  const N = sandbox._normRecipeName;
  check('normName strips (fat-loss) suffix', N('Sweet Potato Cottage Pie (fat-loss)') === N('Sweet Potato Cottage Pie'));
  check('normName strips (dairy-free)', N('Eggplant Lasagne (dairy-free, fat-loss)') === 'eggplant lasagne');
  check('normName lowercases + trims punctuation', N('6-ingredient Turkey Nourish Bowl!') === '6 ingredient turkey nourish bowl');
}

// ── Report ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed (${pass+fail} total)\n`);
if (fail) {
  console.log('FAILURES:');
  fails.forEach(f => console.log('  ❌ ' + f));
  console.log('\n❌ Regressions detected — do not deliver.');
  process.exit(1);
} else {
  console.log('✅ All checks passed — safe to deliver.');
}
