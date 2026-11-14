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

check('skills feature present', /function renderSkills/.test(mainScript) && /function addSkill/.test(mainScript));
check('skills in state model', /skills: \[\]/.test(mainScript));
check('skills target date present', /targetDate/.test(mainScript));
check('skills overdue nudge present', /Overdue/.test(mainScript));
check('suggestions meal sections present', /🌅 Breakfast/.test(mainScript));
check('my recipes New badge present', /savedAt && \(Date\.now\(\) - recipe\.savedAt\)/.test(mainScript));
check('save stamps savedAt', /savedAt: Date\.now\(\)/.test(mainScript));
check('image backfill present', /function backfillRecipeImages/.test(mainScript));
check('image resolver present', /function recipeImage/.test(mainScript));
check('photo upload present', /function triggerRecipePhoto/.test(mainScript));
check('image compression present', /function compressImage/.test(mainScript));
check('section placeholder present', /Select section…/.test(mainScript));
check('update check surfaces a banner proactively', /function checkForUpdate\(\)/.test(mainScript) && /update-banner'\)\.style\.display = 'block'/.test(mainScript) && /setInterval\(checkForUpdate, 5 \* 60 \* 1000\)/.test(mainScript));
check('cache-control meta present', /Cache-Control.*no-cache/.test(html));
check('meal-list helpers present', /function getMealList/.test(mainScript) && /function addMealToDay/.test(mainScript) && /function removeMealFromDay/.test(mainScript));
check('This Week section headers present', /meal-section-header/.test(mainScript));
check('auto-plan feature present', /function autoPlanWeek/.test(mainScript) && /function applyAutoPlan/.test(mainScript));
check('auto-plan uses Spendly worker', /spendly-ai-proxy\.cirosotomonte\.workers\.dev/.test(mainScript));
check('auto-plan preview before apply', /function showAutoPlanPreview/.test(mainScript));
check('week navigation present', /function foodChangeWeek/.test(mainScript) && /foodWeekOffset/.test(mainScript));
check('this week bases on current week not scraper week', /const startMon = foodMondayOfCurrentWeek\(\);/.test(mainScript) && !/const planWeek = state\.food && state\.food\.shoppingListWeek;[\s\S]{0,120}startMon = new Date/.test(mainScript));
check('no navigation into past weeks', /foodWeekOffset = Math\.max\(0, foodWeekOffset \+ delta\)/.test(mainScript));
check('week offset applied to dates', /startMon\.setDate\(startMon\.getDate\(\) \+ \(foodWeekOffset \* 7\)\)/.test(mainScript));
check('add-to-day servings spread present', /function placeRecipeAcrossDays/.test(mainScript) && /addToDayServings/.test(mainScript));
check('add-to-day picker shows recipe images', /function openAddToDay/.test(mainScript) && /recipeImage\(r\)/.test(mainScript));
check('shopping scales by placement count', /counts\[recipe\.id\] = \(counts\[recipe\.id\] \|\| 0\) \+ 1/.test(mainScript) && /factor = servings \/ base/.test(mainScript));
check('single-slot skip logic present', /if \(list\.length > 0\) continue/.test(mainScript));
check('complete delete removes from planned days', /function removeSavedRecipe/.test(mainScript) && /Remove from every planned day/.test(mainScript));
check('adding to a day auto-adds to shopping', /recipe\.addedToShop = true; \/\/ adding to a day/.test(mainScript));
check('servings adjustable from day card', /function spreadRecipeAdjust/.test(mainScript) && /function countRecipeSpread/.test(mainScript));
// Superseded at v5.77: this asserted the blanket baseServings = 1 self-heal,
// which was the bug. Per-recipe bases are covered in Layer 8.
check('no hardcoded per-recipe servings map', !/'saved-cottage-pie':3/.test(mainScript));
check('fraction formatter present', /function _fmtNum/.test(mainScript));
check('day card shows recipe image', /const imgSrc = recipeImage\(recipe\);/.test(mainScript) && /meal-card-banner/.test(mainScript));
// Superseded at v5.77: the display default is now each recipe's own base, not a
// global 2. See Layer 8.
check('recipe servings stepper present', /function setRecipeServings/.test(mainScript));
check('suggestions show 2-serving ingredients', /formatIngredient\(ing,2\)/.test(mainScript));
check('shopping combines shared ingredients', /function combineIngredientParts/.test(mainScript) && /function normalizeIngredientName/.test(mainScript));
check('pomodoro alarm volume 0.5 + vibration', /linearRampToValueAtTime\(0\.5,/.test(mainScript) && /navigator\.vibrate\(\[250, 120, 250\]\)/.test(mainScript));
check('pomodoro cycle persists across reloads, resets on new day', /pomoCycle/.test(mainScript) && /state\.pomoCycle = \{ round: pomoState\.round, date: todayDateKey\(\) \}/.test(mainScript) && /state\.pomoCycle\.date === today/.test(mainScript));
check('logPomoSession intact', /function logPomoSession\(\)/.test(mainScript) && /state\.pomoLog\[key\]\+\+/.test(mainScript));
check('global sticky header present', /id="app-header"/.test(html) && /#app-header \{[^}]*position: sticky/.test(html));
check('page-food is inside #app (no 110px padding gap)', html.indexOf('id="page-food"') < html.indexOf('</div><!-- /app -->') && html.indexOf('</div><!-- /app -->') !== -1);
check('todo Add opens modal (no quick-add input)', /onclick="openTodoModal\('work'\)"/.test(html) && !/id="todo-work-input"/.test(html));
check('todo modal has due date + created date', /function _todoModal/.test(mainScript) && /id="td-detail-due" type="date"/.test(mainScript) && /Created \$\{_todoFmtDate\(item\.createdAt\)\}/.test(mainScript));
check('todo save captures dueDate + createdAt', /function saveTodoModal/.test(mainScript) && /dueDate: due, createdAt: todayDateKey\(\)/.test(mainScript));
check('todo due-date chip present', /function todoDueChip/.test(mainScript) && /Overdue · /.test(mainScript));
check('focus items carry full info + are openable', /function openFocusDetail/.test(mainScript) && /function saveFocusDetail/.test(mainScript) && /taskCreatedAt: item\.createdAt/.test(mainScript));
check('due-today todos auto-move to focus', /function autoMoveDueTodos/.test(mainScript) && /t\.dueDate && t\.dueDate <= today/.test(mainScript) && /autoMoveDueTodos\(\);   \/\/ surface/.test(mainScript));
check('3-column Today grid present', /@media \(min-width: 1200px\)/.test(html) && /grid-template-columns: 1fr 1fr 1fr/.test(html) && /id="today-left-top"/.test(html));
check('desktop layout present', /@media \(min-width: 900px\)/.test(html) && /columns: 2/.test(html));
check('daily routine block removed', !/id="routine-card"/.test(html) && !/id="routine-timeline"/.test(html));
check('moveTodoToFocus still removes from todos', (mainScript.match(/state\.todos = state\.todos\.filter\(i => i\.id !== id\)/g) || []).length >= 1);
check('Focus/Upcoming toggle present', /id="today-focus-view"/.test(html) && /id="today-upcoming-view"/.test(html) && /function setTodayView/.test(mainScript));
check('Upcoming agenda buckets present', /function renderUpcoming/.test(mainScript) && /overdue: \[\], today: \[\], tomorrow: \[\], week: \[\], month: \[\]/.test(mainScript));
check('page-header centers (icon buttons dont push title down)', /\.page-header \{[\s\S]*?align-items: center;[\s\S]*?\}/.test(html) && !/\.page-header \{[\s\S]*?align-items: baseline/.test(html));
check('tab switch scrolls to top', /function showPage/.test(mainScript) && /window\.scrollTo\(0, 0\); \/\/ anchor to the top/.test(mainScript));
check('manual update applies immediately', /function checkForUpdateManual[\s\S]*?setTimeout\(\(\) => doUpdate\(\), 400\)/.test(mainScript));

// Ingredient combining behaviour
try {
  const uf = mainScript.match(/const _UNICODE_FRAC = \{[^}]*\};/)[0];
  const fmt = extractFn('_fmtNum', mainScript);
  const su = mainScript.match(/const _SHOP_UNITS = '[^']*';/)[0];
  const sp = mainScript.match(/const _SHOP_PREP = \[[^\]]*\];/)[0];
  const parse = extractFn('parseIngredient', mainScript);
  const norm = extractFn('normalizeIngredientName', mainScript);
  const comb = extractFn('combineIngredientParts', mainScript);
  const F = new Function(uf+'\n'+fmt+'\n'+su+'\n'+sp+'\n'+parse+'\n'+norm+'\n'+comb+'\nreturn {parseIngredient,normalizeIngredientName,combineIngredientParts};')();
  const nk = s => F.normalizeIngredientName(F.parseIngredient(s).name);
  check('combine: salt&pepper variants merge', nk('salt & pepper, to taste') === nk('pepper & salt to taste'));
  check('combine: red cabbage prep-variants merge', nk('160 ml red cabbage finely shredded (or green cabbage)') === nk('80 ml red cabbage'));
  check('combine: sums same unit', F.combineIngredientParts([F.parseIngredient('80 ml red cabbage'), F.parseIngredient('80 ml red cabbage')]) === '160 ml red cabbage');
  check('combine: lists un-summable units', F.combineIngredientParts([F.parseIngredient('2 tsp sauce'), F.parseIngredient('1 tbs sauce')]) === '2 tsp + 1 tbs sauce');
  check('combine: sums fractions ½+¼=¾', F.combineIngredientParts([F.parseIngredient('½ avocado'), F.parseIngredient('¼ avocado')]) === '¾ avocado');
} catch(e) { fails.push('combine extraction: ' + e.message); fail++; }
check('day card has prominent corner remove btn', /class="meal-remove-btn"/.test(mainScript));
check('servings adjust keeps card open', /function renderFoodWeekPlanKeepingOpen/.test(mainScript) && (mainScript.match(/renderFoodWeekPlanKeepingOpen\(\)/g) || []).length >= 2);

// Dairy swap correctness
try {
  const swapFn = extractFn('swapDairyIngredient', mainScript);
  const dairyKw = mainScript.match(/const DAIRY_KW = \[[^\]]*\];/);
  const isDairy = extractFn('isDairyIngredient', mainScript);
  const swapMap = mainScript.match(/const DAIRY_SWAP_MAP = \[[\s\S]*?\];/);
  const swap = new Function(dairyKw[0] + '\n' + swapMap[0] + '\n' + isDairy + '\n' + swapFn + '\nreturn swapDairyIngredient;')();
  check('swap: ricotta → lactose-free ricotta', swap('12 oz ricotta').text.includes('lactose-free ricotta'));
  check('swap: parmesan → nutritional yeast', swap('grated parmesan').text.includes('nutritional yeast'));
  check('swap: milk → lactose-free milk', swap('200ml milk').text.includes('lactose-free milk'));
  check('swap: chicken unchanged', swap('200g chicken breast').swapped === false);
  check('swap: lactose-free milk not double-swapped', swap('200ml lactose-free milk').swapped === false);
} catch(e) { fails.push('swapDairy extraction: ' + e.message); fail++; }
check('exclude/strikethrough removed from meal card', !/excludeRecipe/.test(mainScript));

// getMealList + add/remove behaviour (multi vs single)
try {
  const multi = mainScript.match(/const MULTI_MEALS = \[[^\]]*\];/);
  const gml = extractFn('getMealList', mainScript);
  const getMealList = new Function(multi[0] + '\n' + gml + '\nreturn getMealList;')();
  check('getMealList wraps single recipe', JSON.stringify(getMealList({lunch:{id:1}}, 'lunch')) === '[{"id":1}]');
  check('getMealList passes array through', getMealList({breakfast:[{id:1},{id:2}]}, 'breakfast').length === 2);
  check('getMealList empty for missing', getMealList({}, 'dinner').length === 0);
} catch(e) { fails.push('getMealList extraction: ' + e.message); fail++; }

// categoriseShopItem: the ground-turkey bug regression
try {
  const cats = mainScript.match(/const SHOP_CATEGORIES = \{[\s\S]*?\n\};/);
  const fn = extractFn('categoriseShopItem', mainScript);
  const cat = new Function(cats[0] + '\n' + fn + '\nreturn categoriseShopItem;')();
  check('category: ground turkey is Protein (not Pantry)', cat('16 oz ground turkey') === 'Protein');
  check('category: chicken breast is Protein', cat('9 oz chicken breast') === 'Protein');
  check('category: avocado is Produce', cat('1 avocado') === 'Produce');
  check('category: sourdough is Pantry', cat('50g sourdough bread') === 'Pantry');
} catch(e) { fails.push('categoriser extraction: ' + e.message); fail++; }

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
    extractFn('_fmtNum', mainScript),
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
  // Fraction display: decimals render as nice fractions, and scale correctly
  check('quarter avocado shows ¼', F('0.25 avocado sliced', 1) === '¼ avocado sliced');
  check('quarter avocado x2 shows ½', F('0.25 avocado sliced', 2) === '½ avocado sliced');
  check('half tsp shows ½', F('0.5 tsp sesame seeds', 1) === '½ tsp sesame seeds');
  check('unicode ¼ normalises then displays ¼', F('¼ avocado', 1) === '¼ avocado');
  check('scale unquantified unchanged', F('salt & pepper to taste', 2) === 'salt & pepper to taste');
  check('factor 1 leaves metric (no double)', F('16 oz turkey', 1) === '455 g turkey');
}

if (sandbox._normRecipeName) {
  const N = sandbox._normRecipeName;
  check('normName strips (fat-loss) suffix', N('Sweet Potato Cottage Pie (fat-loss)') === N('Sweet Potato Cottage Pie'));
  check('normName strips (dairy-free)', N('Eggplant Lasagne (dairy-free, fat-loss)') === 'eggplant lasagne');
  check('normName lowercases + trims punctuation', N('6-ingredient Turkey Nourish Bowl!') === '6 ingredient turkey nourish bowl');
}

// ── Layer 5: desktop Today layout (added v5.74-v5.76) ──────────────────
// Context: the >=1200px Today grid was rebuilt so cards size to their content
// instead of scrolling inside fixed 460px rows. These checks pin the pieces
// that broke, or nearly broke, during that rebuild.

const desktopBlock = (html.match(/@media \(min-width: 1200px\)\s*\{[\s\S]*?\n\}/) || [''])[0];
const gridCellRule = /#today-left-top, #todo-work-card, #focus-card, #todo-personal-card, #today-habits-card \{([^}]*)\}/;
const gridCellDecls = (html.match(gridCellRule) || ['',''])[1];

check('>=1200px Today block present', desktopBlock.length > 0);
check('Today rows auto-sized, not fixed height', /grid-template-rows:\s*auto auto auto/.test(desktopBlock));
check('no --trh fixed row variable remains', !/--trh/.test(html));
check('Today cells do not scroll internally', !/overflow-y:\s*auto/.test(gridCellDecls));

// THE v5.75 REGRESSION. Swapping overflow-y:auto for overflow:visible removed
// the scroll container, so each grid item's automatic minimum size reverted to
// its min-content width. One pasted URL then set the floor for a whole column,
// pushed the grid past #app's 1040px cap, and produced a page-level horizontal
// scrollbar. min-width:0 restores the zero floor. Do not remove it.
check('grid cells declare min-width: 0 (horizontal overflow guard)', /min-width:\s*0/.test(gridCellDecls));

// Second half of the same guard: min-width:0 lets the column shrink, but long
// unbreakable text still needs somewhere to go.
const focusTextRule = (html.match(/\.focus-item-text \{([^}]*)\}/) || ['',''])[1];
check('focus item text breaks long strings', /overflow-wrap:\s*anywhere/.test(focusTextRule));
check('focus item text can shrink', /min-width:\s*0/.test(focusTextRule));
check('pasted URLs still truncate with ellipsis', (html.match(/white-space:nowrap;overflow:hidden;text-overflow:ellipsis/g) || []).length >= 2);

// Grid placement must survive edits to the block above it.
['#today-left-top', '#todo-work-card', '#focus-card', '#todo-personal-card', '#today-habits-card']
  .forEach(id => check(`grid placement kept for ${id}`, new RegExp(id + '\\s+\\{?[^\\n]*grid-column').test(desktopBlock)));

// Shell centring (v5.75) and the widths it depends on.
check('shell offset variable defined', /--shell-left: max\(240px, calc\(240px \+ \(100% - 1280px\) \/ 2\)\)/.test(html));
check('#app uses the shell offset, not a hardcoded left pin', /#app \{ margin-left: var\(--shell-left\)/.test(html) && !/#app \{ margin-left: 240px/.test(html));
check('user bar tracks the same offset', /#user-bar, #update-banner \{ margin-left: var\(--shell-left\); \}/.test(html));
check('1040px content cap retained', /#app \{ margin-left: var\(--shell-left\); margin-right: auto; max-width: 1040px/.test(html));
check('view toggle width capped', /\.today-view-toggle \{[^}]*max-width: 340px/.test(html));

// Pomodoro header collided with its mode pills in a ~336px column (v5.74).
check('pomo header wraps instead of colliding', /\.pomo-header \{[^}]*flex-wrap: wrap/.test(html));
check('pomo pills do not break mid-label', /\.pomo-mode-pill \{[^}]*white-space: nowrap/.test(html));

// ── Layer 6: auth is sacred ────────────────────────────────────────────
check('no auth bypass flag', !/(AUTH_DISABLED|SKIP_AUTH|BYPASS_AUTH)\s*=\s*true/.test(html));
check('session token persistence retained', /localStorage/.test(html));

// ── Layer 7: build stamp consistent across all three locations ─────────
const _bv = (html.match(/const BUILD_VERSION = '([^']+)'/) || [])[1];
const _bd = (html.match(/const BUILD_DISPLAY = '([^']+)'/) || [])[1];
const _bb = (html.match(/const BUILD = '([^']+)'/) || [])[1];
check('BUILD combines version + display', _bb === `${_bv} · ${_bd}`);
check('footer stamp matches constants', html.includes(`Lumio ${_bv} · ${_bd}</div>`));
check('settings stamp matches version', html.includes(`id="settings-version-num">Lumio ${_bv}<`));

// ── Known ceiling ──────────────────────────────────────────────────────
// These are static assertions against source text. They prove a declaration is
// present; they cannot prove the page lays out. v5.75 passed every check in
// this file and still shipped a horizontal scrollbar. Catching that class of
// bug needs a headless browser measuring scrollWidth against clientWidth.

// ── Layer 8: per-recipe baseServings (added v5.77) ─────────────────────
// Bug: a self-heal forced every saved recipe's baseServings to 1, on the
// assumption that Centr lists ingredients per single serving. It doesn't — the
// count is stated as the first method line ("based on 2 servings"). Of 48 saved
// recipes, 25 declare 2, one 3, two 4, one 5, and 19 declare nothing (1).
// Forcing 1 doubled every 2-serving recipe's displayed quantities.

check('blanket baseServings self-heal removed', !/baseServings !== 1/.test(html));
check('DEFAULT_RECIPE_SERVINGS constant removed', !/DEFAULT_RECIPE_SERVINGS/.test(html));
check('deriveBaseServings() exists', /function deriveBaseServings\s*\(/.test(html));
check('migrateRecipeBaseServings() exists', /function migrateRecipeBaseServings\s*\(/.test(html));
check('migration is version-guarded', /recipeBaseMigration \|\| 0\) >= RECIPE_BASE_MIGRATION/.test(html));
check('migration runs from renderSavedRecipes', /migrateRecipeBaseServings\(\);/.test(html));
check('stepper defaults to the recipe base', !/recipeServings\[recipe\.id\] != null \? recipeServings\[recipe\.id\] : \d/.test(html));

const derive = extractFn('deriveBaseServings', mainScript);
if (!derive) { check('deriveBaseServings extractable', false); }
else {
  const D = new Function(derive + '\nreturn deriveBaseServings;')();
  const m = (...lines) => ({ method: lines });
  // Real markers taken verbatim from the 14 Nov export.
  check('derive: "based on 2 servings" -> 2', D(m('based on 2 servings', 'Heat a skillet.')) === 2);
  check('derive: "Makes 3 portions." -> 3', D(m('Makes 3 portions.')) === 3);
  check('derive: "based on 4 servings" -> 4', D(m('based on 4 servings')) === 4);
  check('derive: "based on 5 servings" -> 5', D(m('based on 5 servings')) === 5);
  check('derive: unmarked breakfast -> 1', D(m('Toast the bread.', 'Poach the eggs.')) === 1);
  check('derive: no method at all -> 1', D({}) === 1);
  check('derive: empty method -> 1', D(m()) === 1);
  check('derive: case-insensitive', D(m('BASED ON 2 SERVINGS')) === 2);
  check('derive: absurd count clamped to 1', D(m('based on 99 servings')) === 1);
  check('derive: ignores unrelated numbers', D(m('Cook for 2 minutes, then rest 3 minutes.')) === 1);
}

// End-to-end: the turkey bowl is written for 2 servings. At the stepper's
// default the quantity must equal what Centr printed, not double it.
if (sandbox.formatIngredient) {
  const F = sandbox.formatIngredient;
  const base = 2, servings = 2;                 // default stepper === base
  check('turkey at default servings stays 455 g', F('16 oz ground turkey', servings / base) === '455 g ground turkey');
  check('turkey halved for one serving', F('16 oz ground turkey', 1 / base) === '230 g ground turkey');
  check('turkey doubled for four servings', F('16 oz ground turkey', 4 / base) === '910 g ground turkey');
  check('single-serve recipe unscaled at default', F('3 large eggs', 1 / 1) === '3 large eggs');
}

// ── Layer 9: week-plan / shopping-list base resolution (added v5.78) ───
// v5.77 stamped baseServings onto savedRecipes only. weekPlan holds a detached
// snapshot of each recipe with no baseServings at all, so the shopping list fell
// back to 1 and billed a whole multi-serve recipe to a single day.

check('recipeBase() helper exists', /function recipeBase\s*\(/.test(html));
// The single permitted fallback lives inside recipeBase() itself, for recipes
// with no method text. Call sites must not reimplement it.
check('only recipeBase() falls back to a raw baseServings', (html.match(/baseServings \|\| 1/g) || []).length === 1);
check('shopping list resolves base via helper', /counts\[rid\] \/ recipeBase\(recipe\)/.test(html));
check('saved card resolves base via helper', /const base = recipeBase\(recipe\);/.test(html));
check('stepper resolves base via helper', /const base = recipeBase\(r\);/.test(html));

const rb = extractFn('recipeBase', mainScript);
const dv = extractFn('deriveBaseServings', mainScript);
if (!rb || !dv) { check('recipeBase extractable', false); }
else {
  const B = new Function(dv + '\n' + rb + '\nreturn recipeBase;')();
  // A weekPlan snapshot: carries method, never carries baseServings.
  const snap = (...lines) => ({ name: 'snap', method: lines });
  check('base: weekPlan snapshot derives 2 from its method', B(snap('based on 2 servings', 'Cook.')) === 2);
  check('base: weekPlan snapshot derives 3 portions', B(snap('Makes 3 portions.')) === 3);
  check('base: unmarked snapshot is 1', B(snap('Toast the bread.')) === 1);
  // Precedence is deliberate: the declared marker beats a stamped value, because
  // weekPlan snapshots carry stale stamps that contradict the recipe (four of
  // five stamped snapshots in the 14 Nov export did). A stamp is only used when
  // there is no method text to read.
  check('base: declared marker beats a stale stamp', B({ baseServings: 1, method: ['based on 2 servings'] }) === 2);
  check('base: unmarked method beats a stale stamp of 2', B({ baseServings: 2, method: ['Poach the eggs.'] }) === 1);
  check('base: stamp used when there is no method', B({ baseServings: 3 }) === 3);
  check('base: stamp used when method is empty', B({ baseServings: 4, method: [] }) === 4);
  check('base: null recipe is 1', B(null) === 1);
  check('base: no method and no stamp is 1', B({ name: 'bare' }) === 1);
}

// The arithmetic the shopping list performs: factor = days planned / base.
if (sandbox.formatIngredient) {
  const F = sandbox.formatIngredient;
  const base = 2; // turkey bowl, declared "based on 2 servings"
  check('plan: 2-serve recipe on 1 day buys half', F('16 oz ground turkey', 1 / base) === '230 g ground turkey');
  check('plan: 2-serve recipe on 2 days buys the full amount', F('16 oz ground turkey', 2 / base) === '455 g ground turkey');
  check('plan: 2-serve recipe on 4 days buys double', F('16 oz ground turkey', 4 / base) === '910 g ground turkey');
}

// ── Layer 10: day-card servings (added v5.79) ──────────────────────────
// The week-plan day card rendered ingredients with a hardcoded factor of 1, so
// it printed the full multi-serve quantities under a "Per serving" heading.
// A day card is one serving of the recipe.

check('day card scales by 1/recipeBase', /const dayFactor = 1 \/ recipeBase\(recipe\);/.test(html));
check('day card uses dayFactor, not a hardcoded 1', /formatIngredient\(ing, dayFactor\)/.test(html));
check('no hardcoded formatIngredient(ing,1) remains', !/formatIngredient\(ing,\s*1\)/.test(html));
check('day card labels its serving count', /Ingredients \(1 serving\)/.test(html));

if (sandbox.formatIngredient) {
  const F = sandbox.formatIngredient;
  // Turkey bowl declares 2 servings; one day card must show half.
  check('day card: 2-serve turkey shows 230 g', F('16 oz ground turkey', 1 / 2) === '230 g ground turkey');
  check('day card: 3-serve recipe shows a third', F('15 oz beef', 1 / 3) === '140 g beef');
  check('day card: 1-serve recipe is unchanged', F('3 large eggs', 1 / 1) === '3 large eggs');
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
