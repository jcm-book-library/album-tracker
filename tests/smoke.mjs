// Smoke test for app.html (Sleeves & Grooves).
// Loads the page in headless Chromium at laptop and phone widths, with a stubbed
// window.claude.use('mcp') backed by an in-memory copy of the 🎸 sheet tabs.
//
// Usage:  npm test            (from tests/)
// Env:    APP_HTML=/path/to/page.html   test a different page (used for harness checks)
//         CHROMIUM_PATH=/path/to/chromium   override the browser binary
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(process.env.APP_HTML || join(here, '..', 'app.html'));
const OUT = join(here, 'out');
const FIXTURE = JSON.parse(readFileSync(join(here, 'fixture-albums.json'), 'utf8'));
const VIEWPORTS = [
  { name: 'laptop', width: 1280, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

// ---------- seed data for the stub sheet ----------
function isoDay(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function buildSeed() {
  const albums = FIXTURE.values;                 // [header, ...rows]; id is column J (index 9)
  const picks = [1, 4, 8, 14, 20];               // fixture rows used for the Log sample
  const offsets = [9, 7, 5, 2, 0];               // days ago: spread over the last 10 days
  const plays = ['1', '1', '2', '1', '3'];
  const notes = ['', 'first spin', '', '', 'side B on repeat'];
  const log = [['date', 'albumId', 'title', 'artist', 'plays', 'loggedAt', 'source', 'note']];
  picks.forEach((ri, i) => {
    const r = albums[ri];
    const date = isoDay(offsets[i]);
    log.push([date, r[9], r[0], r[2], plays[i], `${date}T20:00:00`, 'seed', notes[i]]);
  });
  return {
    '🎸': albums,
    '🎸 Log': log,
    '🎸 Settings': [
      ['key', 'value'],
      ['yearGoalAlbums', '52'],
      ['rotationDays', '14'],
      ['upNextSize', '10'],
      ['albumOfDayMin', '8'],
    ],
  };
}

// ---------- stub, runs in the page before any page script ----------
// Mirrors the bootstrap in the book app: window.claude.use('mcp') resolves to an
// object whose callTool(server, tool, args, opts) resolves to { payload }.
function installStub(seed) {
  const PREFIX = '🎸';
  const tabs = {};
  for (const [name, rows] of Object.entries(seed)) {
    tabs[name] = rows.map(r => r.map(c => (c == null ? '' : String(c))));
  }
  const firstTab = Object.keys(seed)[0];
  window.__writes = [];
  window.__forbidden = [];
  window.__errors = [];
  window.__sheet = tabs;

  // Stage 2 sample data, applied here (not in the fixture): a "Buy link" column (P), a plan with
  // Up next 1..3 (numbered against sheet order), two Soon, and one Someday planned long ago.
  {
    const t = tabs['🎸'], rows = t.slice(1);
    while (t[0].length < 16) t[0].push('');
    t[0][15] = 'Buy link';
    for (const r of rows) while (r.length < 16) r.push('');
    const listen = rows.filter(r => r[3] === 'Listen' && !r[1]);
    const purchaseNew = rows.filter(r => r[3] === 'Purchase' && !r[1]);
    const purchaseRated = rows.filter(r => r[3] === 'Purchase' && r[1]);
    [[listen[0], 3], [listen[1], 2], [listen[2], 1]].forEach(([r, n]) => { r[10] = 'Up next'; r[11] = String(n); r[14] = '2026-10-01'; });
    listen[1][12] = 'Heard it is a classic';
    listen[3][10] = 'Soon'; listen[3][14] = '2026-10-02';
    listen[4][10] = 'Soon'; listen[4][14] = '2026-10-02';
    listen[4][15] = 'https://' + 'verylonghostname'.repeat(8) + '.example.com/' + 'x'.repeat(120);
    listen[5][10] = 'Someday'; listen[5][14] = '2025-01-01';
    listen[6][15] = 'javascript:alert(1)';
    const shops = ['https://www.jbhifi.com.au/products/test-1', 'https://www.ebay.com.au/itm/123456', 'https://www.warnermusic.com.au/shop/test-3', 'https://midlandrecords.com.au/products/test-4', 'https://www.jbhifi.com.au/products/test-5'];
    [...purchaseNew.slice(0, 3), ...purchaseRated.slice(0, 2)].forEach((r, i) => { r[15] = shops[i]; });
    window.__plan = { someday: listen[5][0], upNextRows: [listen[2][0], listen[1][0], listen[0][0]] };
  }

  const colToNum = s => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const numToCol = n => { let s = ''; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  // Parse "'Tab'!A1:O300", "Tab!J:J", "A1:O", "A1" into a 0-based box on one tab.
  function parse(range) {
    const text = String(range || '');
    let sheet = firstTab;
    let cells = text;
    const bang = text.lastIndexOf('!');
    if (bang >= 0) {
      let s = text.slice(0, bang);
      cells = text.slice(bang + 1);
      if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) s = s.slice(1, -1).replace(/''/g, "'");
      sheet = s;
    }
    const m = /^\$?([A-Za-z]*)\$?(\d*)(?::\$?([A-Za-z]*)\$?(\d*))?$/.exec(cells.trim());
    if (!m) throw new Error(`Unsupported range: ${text}`);
    const colon = cells.includes(':');
    const [, c1, r1, c2, r2] = m;
    return { text, sheet, colon, c1, r1, c2: c2 || '', r2: r2 || '' };
  }

  // Guard + locate the tab. Anything outside the 🎸 tabs is refused and recorded.
  function target(range, tool) {
    const p = parse(range);
    if (typeof p.sheet !== 'string' || !p.sheet.startsWith(PREFIX)) {
      window.__forbidden.push({ tool, range: p.text, sheet: p.sheet });
      throw new Error(`Access denied: tab ${JSON.stringify(p.sheet)} is outside the 🎸 tabs`);
    }
    if (!(p.sheet in tabs)) {
      window.__errors.push({ tool, range: p.text, sheet: p.sheet });
      throw new Error(`No such tab: ${JSON.stringify(p.sheet)}`);
    }
    const rows = tabs[p.sheet];
    const maxRow = Math.max(rows.length - 1, 0);
    const maxCol = Math.max(0, ...rows.map(r => r.length - 1));
    const sc = p.c1 ? colToNum(p.c1) : 0;
    const sr = p.r1 ? parseInt(p.r1, 10) - 1 : 0;
    const ec = p.c2 ? colToNum(p.c2) : (p.colon ? maxCol : sc);
    const er = p.r2 ? parseInt(p.r2, 10) - 1 : (p.colon ? maxRow : sr);
    return { ...p, rows, sc, sr, ec, er };
  }

  function setCell(rows, r, c, v) {
    while (rows.length <= r) rows.push([]);
    const row = rows[r];
    while (row.length <= c) row.push('');
    row[c] = v;
  }

  const mcp = {
    async callTool(server, tool, args = {}, opts) {
      if (server !== 'Google Sheets') {
        window.__errors.push({ tool, server });
        throw new Error(`Unknown server: ${server}`);
      }
      if (tool === 'get_values') {
        const t = target(args.range, tool);
        const last = Math.min(t.er, t.rows.length - 1);
        let values = [];
        for (let r = t.sr; r <= last; r++) {
          values.push((t.rows[r] || []).slice(t.sc, t.ec + 1));
        }
        // Like Sheets: trim trailing empty cells per row, then trailing empty rows.
        values = values.map(row => { let n = row.length; while (n > 0 && row[n - 1] === '') n--; return row.slice(0, n); });
        while (values.length && values[values.length - 1].length === 0) values.pop();
        return { payload: { range: args.range, majorDimension: 'ROWS', values } };
      }
      if (tool === 'update_values') {
        const t = target(args.range, tool);
        const vals = Array.isArray(args.values) ? args.values : [];
        vals.forEach((row, i) => (Array.isArray(row) ? row : [row]).forEach((v, j) => setCell(t.rows, t.sr + i, t.sc + j, v == null ? '' : String(v))));
        window.__writes.push({ tool, range: args.range, sheet: t.sheet, values: JSON.parse(JSON.stringify(vals)) });
        return { payload: { spreadsheetId: args.spreadsheetId, updatedRange: args.range, updatedCells: vals.reduce((n, r) => n + (Array.isArray(r) ? r.length : 1), 0) } };
      }
      if (tool === 'append_values') {
        const t = target(args.range, tool);
        let last = -1;
        t.rows.forEach((r, i) => { if (r.some(c => c !== '')) last = i; });
        const start = last + 1;
        const vals = Array.isArray(args.values) ? args.values : [];
        vals.forEach((row, i) => (Array.isArray(row) ? row : [row]).forEach((v, j) => setCell(t.rows, start + i, t.sc + j, v == null ? '' : String(v))));
        window.__writes.push({ tool, range: args.range, sheet: t.sheet, appendedAtRow: start + 1, values: JSON.parse(JSON.stringify(vals)) });
        return { payload: { spreadsheetId: args.spreadsheetId, updates: { updatedRange: `'${t.sheet}'!A${start + 1}`, updatedRows: vals.length } } };
      }
      window.__errors.push({ tool });
      throw new Error(`Unsupported tool in stub: ${tool}`);
    },
  };

  window.claude = {
    use: async name => (name === 'mcp' ? mcp : null),
  };
}

// ---------- page helpers ----------
const wrap = appHtml => `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"></head><body>${appHtml}</body></html>`;

// Find the top-level pill bar: role=tablist, or a small element with "tabs"/"pill" in its class.
// Tab buttons are role=tab if present, otherwise every button in the bar.
const DISCOVER = () => {
  const visible = el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const pool = new Set([
    ...document.querySelectorAll('[role="tablist"]'),
    ...document.querySelectorAll('[class*="tabs" i], [class*="pill" i]'),
  ]);
  let best = null;
  for (const el of pool) {
    if (!visible(el) || el.getBoundingClientRect().height > 160) continue;
    const roleTabs = [...el.querySelectorAll('[role="tab"]')].filter(visible);
    const buttons = roleTabs.length ? roleTabs : [...el.querySelectorAll('button')].filter(visible);
    if (buttons.length < 2) continue;
    if (!best || buttons.length > best.buttons.length) best = { buttons, usingRoleTab: roleTabs.length > 0 };
  }
  if (!best) return { found: false, tabs: [] };
  best.buttons.forEach((b, i) => b.setAttribute('data-smoke-tab', String(i)));
  return {
    found: true,
    usingRoleTab: best.usingRoleTab,
    tabs: best.buttons.map((b, i) => ({ i, label: (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim() })),
  };
};

// After clicking tab i, find its panel and report whether it is visible.
const PANEL_STATE = i => {
  const btn = document.querySelector(`[data-smoke-tab="${i}"]`);
  const shown = el => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const cv = el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : true;
    return cv && r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.hidden;
  };
  let panel = null;
  let method = '';
  const controls = btn.getAttribute('aria-controls');
  if (controls) { panel = document.getElementById(controls); method = 'aria-controls'; }
  if (!panel) {
    const key = btn.dataset.tab || btn.dataset.view || btn.dataset.panel || btn.dataset.target;
    if (key) {
      const k = JSON.stringify(key);
      panel = document.querySelector(`[data-panel=${k}],[data-view=${k}],[data-tab-panel=${k}],[data-tab=${k}]:not(button),#${CSS.escape(key)},#panel-${CSS.escape(key)},#tab-${CSS.escape(key)}`);
      method = 'data-attribute';
    }
  }
  if (panel) return { method, visible: shown(panel), selected: btn.getAttribute('aria-selected') };
  const panels = [...document.querySelectorAll('[role="tabpanel"]')];
  return { method: 'tabpanel fallback', visible: panels.some(shown), selected: btn.getAttribute('aria-selected') };
};

const overflow = () => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth });

// ---------- Plan tab ----------
const sheetRow = (id) => window.__sheet['🎸'].findIndex((r, i) => i > 0 && r[9] === id) + 1;
const waitSaved = page => page.waitForFunction(() => document.getElementById('statusText').textContent === 'Plan saved', null, { timeout: 8000 });

async function planTests(page, vp) {
  const n = vp.name;
  await page.locator('#tab-plan').click();
  await page.waitForTimeout(200);

  // Up next renders in Up next # order, not sheet order
  const up = await page.evaluate(() => [...document.querySelectorAll('#upList > li')].map(li => ({ n: li.querySelector('.n').textContent, t: li.querySelector('.t').textContent })));
  const want = await page.evaluate(() => window.__plan.upNextRows);
  record(n, 'Plan: Up next lists albums in Up next # order', JSON.stringify(up.map(x => x.t)) === JSON.stringify(want) && up.map(x => x.n).join() === '1,2,3', JSON.stringify(up));
  const note = await page.locator('#upNote').textContent();
  record(n, 'Plan: Up next shows "3 of 10"', note.trim() === '3 of 10', note);
  const whyShown = await page.locator('#upList .why').allTextContents();
  record(n, 'Plan: Up next shows the Why text', whyShown.some(t => t.includes('Heard it is a classic')));
  const counts = await page.evaluate(() => ({ soon: document.querySelectorAll('#soonList > li:not(.empty)').length, wish: document.querySelectorAll('#wishList > li:not(.empty)').length, bl: document.querySelectorAll('#blList > li:not(.empty)').length }));
  record(n, 'Plan: Soon, wish list and backlog all render', counts.soon === 2 && counts.wish > 0 && counts.bl > 10, JSON.stringify(counts));

  // Buy links are real, safe anchors; non-http values never become links
  const buys = await page.evaluate(() => [...document.querySelectorAll('#view-plan a.buy')].map(a => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent })));
  record(n, 'Plan: Buy links open in a new tab with rel=noopener', buys.length > 0 && buys.every(b => b.target === '_blank' && /noopener/.test(b.rel) && /^https?:/.test(b.href)), `${buys.length} link(s)`);
  record(n, 'Plan: Buy links are labelled by shop', buys.some(b => /JB Hi-Fi/.test(b.text)) && buys.some(b => /eBay/.test(b.text)), buys.slice(0, 3).map(b => b.text).join(' | '));
  const bad = await page.evaluate(() => [...document.querySelectorAll('a[href^="javascript:"]')].length);
  record(n, 'Plan: javascript: values never become links', bad === 0);

  // No sideways scroll with a very long URL on screen
  let o = await page.evaluate(overflow);
  record(n, 'Plan: no sideways scroll (long Buy link on screen)', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);

  // Deck: tapping Up next writes exactly K, L and O of that album's row
  const deckId = await page.locator('#deckBody .deck-card').getAttribute('data-id');
  const row = await page.evaluate(sheetRow, deckId);
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#deckBody .deck-btns button[data-t="Up next"]').click();
  await waitSaved(page);
  const w1 = await page.evaluate(() => window.__writes.map(w => ({ sheet: w.sheet, range: w.range, values: w.values })));
  const wantRanges = [`K${row}`, `L${row}`, `O${row}`].sort();
  const gotRanges = w1.map(w => w.range.replace("'🎸'!", '')).sort();
  record(n, 'Plan: deck "Up next" writes only K, L and O of that album row', JSON.stringify(gotRanges) === JSON.stringify(wantRanges) && w1.every(w => w.sheet === '🎸'), JSON.stringify(w1.map(w => [w.range, w.values[0][0]])));
  const cells = await page.evaluate(r => { const x = window.__sheet['🎸'][r - 1]; return [x[10], x[11], x[14]]; }, row);
  const todayIso = await page.evaluate(() => today());
  record(n, 'Plan: deck "Up next" stores Plan, Up next #4 and Planned=today', cells[0] === 'Up next' && cells[1] === '4' && cells[2] === todayIso, JSON.stringify(cells));

  // Move item 3 up: Up next # is written for the two swapped rows only
  const ids = await page.evaluate(() => [...document.querySelectorAll('#upList > li')].map(li => li.dataset.id));
  const rows = await Promise.all(ids.map(id => page.evaluate(sheetRow, id)));
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#upList > li:nth-child(3) button[aria-label^="Move up"]').click();
  await waitSaved(page);
  const w2 = await page.evaluate(() => window.__writes.map(w => ({ sheet: w.sheet, range: w.range, v: w.values[0][0] })));
  const want2 = [`L${rows[1]}`, `L${rows[2]}`].sort();
  record(n, 'Plan: moving item 3 up writes Up next # for the two swapped rows only', JSON.stringify(w2.map(w => w.range.replace("'🎸'!", '')).sort()) === JSON.stringify(want2), JSON.stringify(w2.map(w => [w.range, w.v])));
  const order2 = await page.evaluate(() => [...document.querySelectorAll('#upList > li')].map(li => li.dataset.id));
  record(n, 'Plan: moved item swaps places on screen', order2[1] === ids[2] && order2[2] === ids[1], order2.join());
  const nums = await page.evaluate(() => [...document.querySelectorAll('#upList .n')].map(e => e.textContent).join());
  record(n, 'Plan: Up next stays numbered 1..N', nums === '1,2,3,4', nums);

  // Remove from Up next renumbers, writing only the numbers that changed
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#upList > li:nth-child(1) button[aria-label^="Remove"]').click();
  await waitSaved(page);
  const w3 = await page.evaluate(() => window.__writes.map(w => w.range.replace("'🎸'!", '')));
  record(n, 'Plan: removing the first Up next clears Plan/# and renumbers the rest (K, L + 3 renumbers)', w3.filter(r => r[0] === 'K').length === 1 && w3.filter(r => r[0] === 'L').length === 4 && !w3.some(r => r[0] === 'O'), w3.join());

  // Resurfaced Someday album comes back in the deck (skip with key 4)
  const someday = await page.evaluate(() => window.__plan.someday);
  let found = false;
  for (let i = 0; i < 200 && !found; i++) {
    const h = await page.locator('#deckBody h3').textContent().catch(() => '');
    if (h === someday) { found = true; break; }
    await page.keyboard.press('4');
  }
  const label = found ? await page.locator('#deckBody .m').textContent() : '';
  record(n, 'Plan: resurfaced Someday album appears in the deck as "Back from Someday"', found && /Back from Someday/.test(label), label);
  const wr = await page.evaluate(() => window.__writes.length);
  record(n, 'Plan: skipping deck cards writes nothing', wr === w3.length, `${wr} writes`);

  // Keyboard shortcut 2 sends the card to Soon
  if (found) {
    await page.evaluate(() => { window.__writes.length = 0; });
    await page.keyboard.press('2');
    await waitSaved(page);
    const w4 = await page.evaluate(() => window.__writes.map(w => w.range.replace("'🎸'!", '')));
    record(n, 'Plan: key 2 on the deck writes Plan and Planned only (no Up next #)', w4.length === 2 && w4.every(r => /^[KO]\d+$/.test(r)), w4.join());
  }

  // Dates read like "19 Oct 26"
  await page.locator('#tab-log').click();
  const rec = await page.locator('#recentList').textContent();
  record(n, 'Dates: Log shows "d Mon yy" for older entries', /(^|[^\d])\d{1,2} [A-Z][a-z]{2} \d{2}(?!\d)/.test(rec), rec.slice(0, 80));
  await page.locator('#tab-plan').click();

  o = await page.evaluate(overflow);
  record(n, 'Plan: no sideways scroll after interactions', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  const wAll = await page.evaluate(() => window.__writes.concat([]).every(w => w.sheet.startsWith('🎸')));
  record(n, 'Plan: every write stays on a 🎸 tab', wAll);
  await page.screenshot({ path: join(OUT, `${n}-plan.png`), fullPage: true });
}

// ---------- runner ----------
const results = [];
const record = (vp, name, ok, detail = '') => {
  results.push({ vp, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};

async function runViewport(browser, vp, seed, wrapperUrl) {
  console.log(`\n[${vp.name} ${vp.width}x${vp.height}]`);
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  let externalBlocked = 0;
  await context.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    externalBlocked++;               // no network in the test: CDN scripts and fonts are refused
    return route.abort();
  });
  await context.addInitScript(installStub, seed);
  const page = await context.newPage();

  const problems = [];
  page.on('pageerror', e => problems.push(`uncaught: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // Requests blocked above surface as generic resource errors; they are not app errors.
    if (externalBlocked > 0 && /^Failed to load resource/.test(text)) return;
    problems.push(`console: ${text}`);
  });

  await page.goto(wrapperUrl);
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(300);

  const load = await page.evaluate(overflow);
  record(vp.name, 'page loads without console errors or uncaught exceptions', problems.length === 0,
    problems.length ? problems.slice(0, 3).join(' | ') : `${externalBlocked} external request(s) refused`);
  record(vp.name, 'no sideways scroll on load', load.sw <= load.iw, `scrollWidth ${load.sw} vs innerWidth ${load.iw}`);

  const bar = await page.evaluate(DISCOVER);
  record(vp.name, 'tab pill bar discovered', bar.found && bar.tabs.length > 0,
    bar.found ? `${bar.tabs.length} tabs${bar.usingRoleTab ? ' (role=tab)' : ' (all buttons in bar)'}: ${bar.tabs.map(t => t.label).join(', ')}` : 'no tab bar found');

  const seenSlugs = new Set();
  for (const tab of bar.tabs) {
    const slugBase = tab.label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `tab-${tab.i + 1}`;
    let slug = slugBase;
    for (let n = 2; seenSlugs.has(slug); n++) slug = `${slugBase}-${n}`;
    seenSlugs.add(slug);

    let clickErr = '';
    await page.locator(`[data-smoke-tab="${tab.i}"]`).click({ timeout: 5000 }).catch(e => { clickErr = e.message.split('\n')[0]; });
    if (clickErr) {
      record(vp.name, `tab "${tab.label}" can be clicked`, false, clickErr);
      continue;
    }
    await page.waitForTimeout(250);
    const panel = await page.evaluate(PANEL_STATE, tab.i);
    record(vp.name, `tab "${tab.label}" shows its panel`, panel.visible, `via ${panel.method}`);
    const o = await page.evaluate(overflow);
    if (o.sw > o.iw) record(vp.name, `no sideways scroll on tab "${tab.label}"`, false, `scrollWidth ${o.sw} vs ${o.iw}`);
    await page.screenshot({ path: join(OUT, `${vp.name}-${slug}.png`), fullPage: true });
  }
  if (bar.tabs.length) {
    const o = await page.evaluate(overflow);
    record(vp.name, 'no sideways scroll after visiting all tabs', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  }

  await planTests(page, vp);

  const forbidden = await page.evaluate(() => window.__forbidden);
  record(vp.name, 'no access outside 🎸 tabs (window.__forbidden empty)', forbidden.length === 0,
    forbidden.length ? JSON.stringify(forbidden.slice(0, 3)) : '');
  const finalProblems = problems.length;
  record(vp.name, 'no console errors or uncaught exceptions during the run', finalProblems === 0,
    problems.length ? problems.slice(0, 3).join(' | ') : '');

  const writes = await page.evaluate(() => window.__writes);
  console.log(`  info  ${writes.length} sheet write call(s) recorded during the run`);
  await context.close();
}

async function main() {
  if (!existsSync(APP)) {
    console.error(`FAIL: app page not found at ${APP} (set APP_HTML to test another page)`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'sg-smoke-'));
  const wrapperPath = join(tmp, 'app-under-test.html');
  writeFileSync(wrapperPath, wrap(readFileSync(APP, 'utf8')), 'utf8');

  const browser = await chromium.launch({
    // Playwright's bundled build is not installed here; fall back to the provided Chromium.
    executablePath: process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
    args: ['--no-sandbox'],          // container runs as root
  });
  try {
    const seed = buildSeed();
    for (const vp of VIEWPORTS) {
      await runViewport(browser, vp, seed, pathToFileURL(wrapperPath).href);
    }
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length} passed, ${failed.length} failed`);
  for (const r of failed) console.log(`  FAIL [${r.vp}] ${r.name}${r.detail ? ` (${r.detail})` : ''}`);
  console.log(failed.length ? 'RESULT: FAIL' : 'RESULT: PASS');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch(e => { console.error('FAIL: harness error:', e); process.exit(1); });
