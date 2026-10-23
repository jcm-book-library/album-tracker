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

const S4 = { onDay: [], quiet: '', stale: '', release: 'Test Album 060 LP' };
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
  // Stage 4 sample log rows: the same month-day in two earlier years (On this day), and a first listen
  // that has gone quiet (played once 20 days ago, never rated) for the Nudges.
  const now = new Date(), p2 = n => String(n).padStart(2, '0'), md = `${p2(now.getMonth() + 1)}-${p2(now.getDate())}`, Y = now.getFullYear();
  [[32, 1, 1], [33, 2, 2]].forEach(([ri, back, pl]) => {
    const r = albums[ri], date = `${Y - back}-${md}`;
    log.push([date, r[9], r[0], r[2], String(pl), `${date}T20:00:00`, 'seed', '']);
    S4.onDay.push({ title: r[0], back });
  });
  const quietRow = albums.slice(1).filter(r => r[3] === 'Listen' && !r[1])[10];
  log.push([isoDay(20), quietRow[9], quietRow[0], quietRow[2], '1', `${isoDay(20)}T20:00:00`, 'seed', '']);
  S4.quiet = quietRow[0];
  S4.stale = albums.slice(1).filter(r => r[3] === 'Listen' && !r[1])[2][0];
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
    // Tracks: two albums, some copied, and one fully blank row in the middle like a deleted track
    '🎸 Tracks': [
      ['id', 'albumId', 'album', 'side', 'no', 'title', 'length', 'copied', 'note'],
      ['5001', '1001', 'Test Album 001 LP', 'A', '1', 'Opening Night', '5:12', isoDay(3), ''],
      ['5002', '1001', 'Test Album 001 LP', 'A', '2', 'Second Wind', '4:01', isoDay(3), 'live take'],
      ['5003', '1001', 'Test Album 001 LP', 'A', '3', 'Third Rail', '3:45', '', ''],
      ['', '', '', '', '', '', '', '', ''],
      ['5004', '1001', 'Test Album 001 LP', 'B', '1', 'Flip Side', '6:20', '', ''],
      ['5005', '1001', 'Test Album 001 LP', 'B', '2', 'Closer, with a very long title that has to wrap properly on a narrow phone screen without any sideways scroll', '2:58', '', ''],
      ['5006', '1002', 'Test Album 002 LP', 'A', '1', 'Prelude', '1:30', isoDay(2), ''],
      ['5007', '1002', 'Test Album 002 LP', 'A', '2', 'Postlude', '2:10', isoDay(1), ''],
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
  window.__reads = [];
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
    // Stage 4 sample data: one Up next album planned 100 days ago and never played (Nudges), and one release
    // date on today's month-day, seven years back (On this day).
    const q = new Date(), z = n => String(n).padStart(2, '0');
    const back = new Date(q.getFullYear(), q.getMonth(), q.getDate() - 100);
    listen[2][14] = `${back.getFullYear()}-${z(back.getMonth() + 1)}-${z(back.getDate())}`;
    const rel = rows.find(r => r[0] === 'Test Album 060 LP');
    rel[6] = `${q.getFullYear() - 7}-${z(q.getMonth() + 1)}-${z(q.getDate())}`;
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
        window.__reads.push(args.range);
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
        // Like Google Sheets: the table starts at the range's first row and ends at the first fully blank row;
        // new rows go there and overwrite whatever follows (so a blank row mid-table is a trap for A1 appends).
        let start = t.sr;
        while (t.rows[start] && t.rows[start].some(c => c !== '')) start++;
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

// ---------- Dashboard tab ----------
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COL = { title: 0, rating: 1, artist: 2, status: 3, genre: 4, format: 5, year: 7, id: 9 };
const fxRows = () => FIXTURE.values.slice(1);
const fxHeard = r => (parseFloat(r[COL.rating]) > 0) || r[COL.status] === 'Listened' || r[COL.status] === 'Owned';
const waitFrame = page => page.waitForTimeout(150);
const drillTitles = page => page.evaluate(() => [...document.querySelectorAll('#drillList .t')].map(e => e.textContent));
async function closeDrill(page) { await page.locator('#drillClose').click(); await page.waitForFunction(() => !document.getElementById('drillDlg').open); }
const sortedJson = a => JSON.stringify([...a].sort());

async function dashTests(page, vp, seed) {
  const n = vp.name;
  await page.locator('#tab-dashboard').click();
  await waitFrame(page);
  await page.evaluate(() => { window.__writes.length = 0; });

  // Tiles
  const tiles = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#dashTiles .stat')].map(s => [s.dataset.tile, { num: s.querySelector('.num').textContent, sub: s.querySelector('.sub').textContent }])));
  const heardCount = fxRows().filter(fxHeard).length;
  record(n, 'Dashboard: renders 9 tiles', Object.keys(tiles).length === 9, Object.keys(tiles).join());
  record(n, 'Dashboard: "Albums heard" equals the count computed from the fixture', tiles.heard && tiles.heard.num === String(heardCount), `${tiles.heard && tiles.heard.num} vs ${heardCount}`);
  const rated = fxRows().filter(r => fxHeard(r) && parseFloat(r[COL.rating]) > 0).map(r => parseFloat(r[COL.rating]));
  const avg = (rated.reduce((a, b) => a + b, 0) / rated.length).toFixed(1);
  record(n, 'Dashboard: average rating matches the fixture (1 decimal)', tiles.avg && tiles.avg.num === avg, `${tiles.avg && tiles.avg.num} vs ${avg}`);
  const nowYear = String(new Date().getFullYear());
  const log = seed['🎸 Log'].slice(1).filter(r => r[0].startsWith(nowYear));
  const playsSum = log.reduce((s, r) => s + Number(r[4]), 0);
  record(n, 'Dashboard: listens this year sums the seeded plays', tiles.plays && tiles.plays.num === String(playsSum), `${tiles.plays && tiles.plays.num} vs ${playsSum}`);
  record(n, 'Dashboard: albums logged this year counts distinct albums', tiles.logged && tiles.logged.num === String(new Set(log.map(r => r[1])).size), tiles.logged && tiles.logged.num);
  const ownedN = fxRows().filter(r => ['Vinyl (Owned)', 'CD', 'Digital'].includes(r[COL.format]) || r[COL.status] === 'Owned').length;
  record(n, 'Dashboard: owned tile matches the fixture', tiles.owned && tiles.owned.num === String(ownedN), `${tiles.owned && tiles.owned.num} vs ${ownedN}`);
  const periodChips = await page.locator('#dashPeriods .chip').allTextContents();
  record(n, 'Dashboard: year picker lists this year and All time', periodChips.includes(nowYear) && periodChips.includes('All time'), periodChips.join());
  record(n, 'Dashboard: this year is selected by default', await page.locator(`#dashPeriods .chip[data-p="${nowYear}"]`).getAttribute('aria-pressed') === 'true');

  // Ratings bar drill-down (mouse), then keyboard
  const want9 = fxRows().filter(r => parseFloat(r[COL.rating]) === 9).map(r => r[COL.title]);
  await page.locator('#ratBars button.hbar[data-label="9"]').click();
  await waitFrame(page);
  const t9 = await page.locator('#drillTitle').textContent();
  const got9 = await drillTitles(page);
  record(n, 'Dashboard: clicking the "9" ratings bar titles the drill-down "Rated 9 · N albums"', t9 === `Rated 9 · ${want9.length} albums`, t9);
  record(n, 'Dashboard: ratings drill-down lists exactly the albums rated 9', sortedJson(got9) === sortedJson(want9), `${got9.length} vs ${want9.length}`);
  const hasChips = await page.evaluate(() => document.querySelectorAll('#drillList li .pill').length > 0 && document.querySelectorAll('#drillList .rating').length > 0);
  record(n, 'Dashboard: drill-down rows show rating and chips', hasChips);
  // tapping a row opens the existing album dialog (and nothing is written)
  await page.locator('#drillList .dr-main').first().click();
  await page.waitForFunction(() => document.getElementById('albumDlg').open);
  const dlgTitle = await page.locator('#dlgTitle').textContent();
  record(n, 'Dashboard: tapping a drill-down album opens the edit dialog', dlgTitle === 'Edit album' && !(await page.evaluate(() => document.getElementById('drillDlg').open)), dlgTitle);
  await page.locator('#dlgClose').click();

  const want8 = fxRows().filter(r => parseFloat(r[COL.rating]) === 8).length;
  await page.locator('#ratBars button.hbar[data-label="8"]').focus();
  await page.keyboard.press('Enter');
  await waitFrame(page);
  record(n, 'Dashboard: bars work from the keyboard (Enter on a focused bar)', (await page.locator('#drillTitle').textContent()) === `Rated 8 · ${want8} albums`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('drillDlg').open);
  const zero = await page.evaluate(() => { const b = document.querySelector('#ratBars .hbar[data-label="1"]'); return b ? b.tagName : 'none'; });
  record(n, 'Dashboard: an empty ratings row is not clickable', zero === 'DIV', zero);

  // Other panels drill down to the matching albums
  const gen = fxRows().filter(r => fxHeard(r) && r[COL.genre] === 'Rock').map(r => r[COL.title]);
  await page.locator('#genBars button.hbar[data-label="Rock"]').click();
  record(n, 'Dashboard: genre bar lists heard albums of that genre', sortedJson(await drillTitles(page)) === sortedJson(gen), `${gen.length} expected`);
  await closeDrill(page);
  const noGenre = await page.locator('#genBars .hbar[data-label="No genre"]').count();
  record(n, 'Dashboard: genres include "No genre"', noGenre === 1);
  const dec = fxRows().filter(r => Math.floor(parseFloat(r[COL.year]) / 10) === 199).map(r => r[COL.title]);
  await page.locator('#decBars button.hbar[data-label="1990s"]').click();
  record(n, 'Dashboard: decade bar lists every album from that decade', sortedJson(await drillTitles(page)) === sortedJson(dec), `${dec.length} expected`);
  await closeDrill(page);
  const wanted = fxRows().filter(r => r[COL.format] === 'Vinyl (Wanted)').map(r => r[COL.title]);
  await page.locator('#fmtBars button.hbar[data-label="Vinyl (Wanted)"]').click();
  record(n, 'Dashboard: format bar lists albums in that format', sortedJson(await drillTitles(page)) === sortedJson(wanted), `${wanted.length} expected`);
  await closeDrill(page);
  const labels = await page.locator('#fmtBars .lab').allTextContents();
  record(n, 'Dashboard: formats panel lists all six rows', labels.join() === 'Vinyl (Owned),Vinyl (Wanted),CD,Digital,Streaming,No format', labels.join());
  const topName = await page.locator('#artHeard li:first-child .nm').textContent();
  await page.locator('#artHeard li:first-child button').click();
  const artTitles = await drillTitles(page);
  const artWant = fxRows().filter(r => r[COL.artist] === topName).length;
  record(n, 'Dashboard: top artist opens that artist\'s albums', artTitles.length === artWant && artWant > 0, `${topName}: ${artTitles.length}/${artWant}`);
  await closeDrill(page);
  const playRows = await page.locator('#artPlays li button').count();
  record(n, 'Dashboard: top artists by plays shows the seeded log', playRows > 0 && playRows <= 10, `${playRows} rows`);

  // Monthly chart and strip
  const byMonth = new Map();
  for (const r of log) { const m = r[0].slice(0, 7); (byMonth.get(m) || byMonth.set(m, []).get(m)).push(r); }
  const lastMonth = [...byMonth.keys()].sort().pop();
  const mRows = byMonth.get(lastMonth), mi = Number(lastMonth.slice(5, 7)) - 1;
  const mTitles = [...new Set(mRows.map(r => r[2]))];
  const mTitle = `${MONTH_NAMES[mi]} ${nowYear} · ${mTitles.length} album${mTitles.length === 1 ? '' : 's'}`;
  await page.locator(`#monthStrip button[data-m="${mi}"]`).click();
  record(n, 'Dashboard: month button opens that month\'s albums', (await page.locator('#drillTitle').textContent()) === mTitle && sortedJson(await drillTitles(page)) === sortedJson(mTitles), mTitle);
  const mPlays = mRows.reduce((s, r) => s + Number(r[4]), 0);
  const firstMeta = await page.locator('#drillList .m').first().textContent();
  record(n, 'Dashboard: month drill-down shows play counts', /\d+ plays?/.test(firstMeta) && (await page.locator('#drillSub').textContent()).includes(`${mPlays} play`), firstMeta);
  await closeDrill(page);
  if (HAVE_CHART) {
    const hasChart = await page.evaluate(() => !!(window.Chart && Chart.getChart('monthChart')));
    record(n, 'Dashboard: monthly Chart.js bar chart is drawn', hasChart);
    await page.locator('#monthChart').scrollIntoViewIfNeeded();
    const pos = await page.evaluate(i => { const c = Chart.getChart('monthChart'), r = c.canvas.getBoundingClientRect(), p = c.getDatasetMeta(0).data[i].getProps(['x', 'y', 'base'], true); return { x: r.left + p.x, y: r.top + (p.y + p.base) / 2 }; }, mi);
    await page.mouse.click(pos.x, pos.y);
    await waitFrame(page);
    record(n, 'Dashboard: clicking a monthly bar lists that month\'s entries', await page.locator('#drillDlg').evaluate(d => d.open) && (await page.locator('#drillTitle').textContent()) === mTitle && sortedJson(await drillTitles(page)) === sortedJson(mTitles), await page.locator('#drillTitle').textContent());
    await closeDrill(page);
  } else console.log('  info  Chart.js not in node_modules: skipped canvas bar click');

  // Calendar heatmap: tap today
  const todayIso = await page.evaluate(() => today());
  const dRows = seed['🎸 Log'].slice(1).filter(r => r[0] === todayIso);
  if (todayIso.startsWith(nowYear) && dRows.length) {
    await page.locator(`#heat [data-d="${todayIso}"]`).click();
    const dT = [...new Set(dRows.map(r => r[2]))];
    record(n, 'Dashboard: tapping a heatmap day lists that day\'s albums', sortedJson(await drillTitles(page)) === sortedJson(dT) && /· \d+ albums?$/.test(await page.locator('#drillTitle').textContent()), await page.locator('#drillTitle').textContent());
    await closeDrill(page);
  }
  const heatScroll = await page.evaluate(() => { const h = document.getElementById('heatScroll'); return { sw: h.scrollWidth, cw: h.clientWidth }; });
  if (vp.width < 600) record(n, 'Dashboard: heatmap scrolls inside its own container on a phone', heatScroll.sw > heatScroll.cw, `${heatScroll.sw} vs ${heatScroll.cw}`);

  // Year picker: All time and a year with no entries
  await page.locator('#dashPeriods .chip[data-p="all"]').click();
  const allPlays = await page.locator('#dashTiles [data-tile="plays"] .num').textContent();
  record(n, 'Dashboard: All time sums every logged play', allPlays === String(seed['🎸 Log'].slice(1).reduce((s, r) => s + Number(r[4]), 0)), allPlays);
  await page.locator(`#dashPeriods .chip[data-p="${nowYear}"]`).click();

  // No writes, no sideways scroll, screenshot
  const w = await page.evaluate(() => window.__writes.length);
  record(n, 'Dashboard: never writes to the sheet (window.__writes unchanged)', w === 0, `${w} write(s)`);
  const o = await page.evaluate(overflow);
  record(n, 'Dashboard: no sideways scroll', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  await page.screenshot({ path: join(OUT, `${n}-dashboard.png`), fullPage: true });
}

// Same page, but the stub's 🎸 Log has only its header
async function dashEmptyLogTest(browser, vp, seed, url) {
  const n = vp.name;
  const empty = { ...seed, '🎸 Log': [seed['🎸 Log'][0]] };
  const { context, page, problems } = await openContext(browser, vp, empty);
  await page.goto(url);
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
  await page.locator('#tab-dashboard').click();
  await waitFrame(page);
  const t = await page.evaluate(() => ({
    month: document.getElementById('monthEmpty').textContent, monthShown: !document.getElementById('monthEmpty').hidden,
    heat: document.getElementById('heatEmpty').textContent, heatShown: !document.getElementById('heatEmpty').hidden,
    plays: document.getElementById('artPlays').textContent, tiles: document.querySelectorAll('#dashTiles .stat').length,
    playsTile: document.querySelector('#dashTiles [data-tile="plays"] .num').textContent,
    chart: !!(window.Chart && Chart.getChart('monthChart')), heard: document.querySelector('#dashTiles [data-tile="heard"] .num').textContent
  }));
  const msg = 'No listens logged yet. Log one from the Log tab and this fills in.';
  record(n, 'Dashboard (empty log): monthly, calendar and top-plays panels show the friendly empty state', t.monthShown && t.heatShown && t.month === msg && t.heat === msg && t.plays.includes(msg), `${t.month} | ${t.heat}`);
  record(n, 'Dashboard (empty log): library panels still work and nothing throws', t.tiles === 9 && t.playsTile === '0' && !t.chart && t.heard === String(fxRows().filter(fxHeard).length) && problems.length === 0, problems.slice(0, 2).join(' | '));
  const o = await page.evaluate(overflow);
  record(n, 'Dashboard (empty log): no sideways scroll', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  await context.close();
}

// Chart.js refused: everything except the canvas still works
async function dashNoChartTest(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await openContext(browser, vp, seed, { blockChart: true });
  await page.goto(url);
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
  await page.locator('#tab-dashboard').click();
  await waitFrame(page);
  const r = await page.evaluate(() => ({ chart: typeof Chart !== 'undefined', boxHidden: document.getElementById('monthBox').hidden, strip: document.querySelectorAll('#monthStrip button:not([disabled])').length, bars: document.querySelectorAll('#ratBars .hbar').length, tiles: document.querySelectorAll('#dashTiles .stat').length }));
  record(n, 'Dashboard (Chart.js blocked): tiles, bars and month buttons still render', !r.chart && r.boxHidden && r.strip > 0 && r.bars === 10 && r.tiles === 9, JSON.stringify(r));
  await page.locator('#monthStrip button:not([disabled])').first().click();
  record(n, 'Dashboard (Chart.js blocked): month button still drills down', await page.locator('#drillDlg').evaluate(d => d.open));
  record(n, 'Dashboard (Chart.js blocked): no uncaught errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();
}

// The page as committed (no sheet id, empty localStorage) must ask for the sheet link and read nothing until it has one
async function connectTest(browser, vp, seed, url) {
  const n = vp.name, SID = 'TEST_SHEET_ID_0123456789abcdefghijklmnop';
  const { context, page, problems } = await openContext(browser, vp, seed);
  await page.goto(url);
  await page.waitForLoadState('load');
  await page.waitForFunction(() => document.getElementById('gDlg').open, null, { timeout: 8000 }).catch(() => {});
  const s = await page.evaluate(() => ({ open: document.getElementById('gDlg').open, title: document.getElementById('gTitle').textContent, label: document.querySelector('label[for="gSheet"]').textContent, visible: document.getElementById('gSheet').getBoundingClientRect().height > 0, reads: window.__reads.length }));
  record(n, 'Connect: without a built sheet id the "Connect your Google Sheet" dialog opens asking for the link', s.open && /Connect your Google Sheet/.test(s.title) && /Sheet link/.test(s.label) && s.visible, JSON.stringify(s));
  record(n, 'Connect: no get_values call is made before a sheet is chosen', s.reads === 0, `${s.reads} read(s)`);
  await page.locator('#gSheet').fill(`https://docs.google.com/spreadsheets/d/${SID}/edit`);
  await page.locator('#gForm button[type="submit"]').click();
  await page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
  const after = await page.evaluate(() => ({ albums: window.__sg.state.albums.length, cfg: JSON.parse(localStorage.getItem('sg-config') || '{}'), open: document.getElementById('gDlg').open, reads: window.__reads.length }));
  record(n, 'Connect: submitting a sheet link loads the albums', after.albums === fxRows().length && after.reads > 0 && !after.open, `${after.albums} albums, ${after.reads} reads`);
  record(n, 'Connect: the sheet id is saved to localStorage "sg-config"', after.cfg.sheetId === SID, JSON.stringify(after.cfg));
  record(n, 'Connect: no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();
}


// ---------- Tools and Discover tabs ----------
const fxByTitle = t => fxRows().find(r => r[COL.title] === t);
const fxBacklog = r => ['Listen', 'Purchase', 'Coming Soon'].includes(r[COL.status]) && !fxHeard(r);
const MOOD_RULES = {
  'Loud': r => ['Rock', 'Metal'].includes(r[COL.genre]),
  'Chill': r => ['Electronic', 'Soundtrack', 'Soul/R&B'].includes(r[COL.genre]),
  'Throwback': r => parseFloat(r[COL.year]) > 0 && parseFloat(r[COL.year]) < 2000,
  'Something new': fxBacklog,
  'Old favourite': r => parseFloat(r[COL.rating]) >= 9,
  'Anything': () => true,
};
const SIX = ['Log', 'Plan', 'Library', 'Dashboard', 'Tools', 'Discover'];

// A fresh page on the live stub, already on the given tab
async function freshPage(browser, vp, seed, url, tab, { clockTo } = {}) {
  const ctx = await openContext(browser, vp, seed);
  if (clockTo) await ctx.context.clock.setFixedTime(clockTo);
  await ctx.page.goto(url);
  await ctx.page.waitForLoadState('load');
  await ctx.page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
  await ctx.page.locator(`#tab-${tab}`).click();
  await ctx.page.waitForTimeout(200);
  return ctx;
}

async function toolsTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'tools');

  // Six pills, in order, all reachable; the bar scrolls inside itself rather than the page
  const labels = await page.locator('nav.tabs .tab').allTextContents();
  record(n, 'Tabs: six pills in order Log, Plan, Library, Dashboard, Tools, Discover', labels.join() === SIX.join(), labels.join());
  await page.locator('#tab-discover').click();
  const reach = await page.evaluate(() => { const nav = document.querySelector('nav.tabs').getBoundingClientRect(), b = document.getElementById('tab-discover').getBoundingClientRect(); return { inside: b.left >= nav.left - 1 && b.right <= nav.right + 1, sw: document.documentElement.scrollWidth, iw: innerWidth }; });
  record(n, 'Tabs: the last pill is brought into view and the page does not scroll sideways', reach.inside && reach.sw <= reach.iw, JSON.stringify(reach));
  await page.locator('#tab-tools').click();
  await page.waitForTimeout(150);
  let o = await page.evaluate(overflow);
  record(n, 'Tools: renders with no sideways scroll', o.sw <= o.iw && (await page.locator('#view-tools').isVisible()), `scrollWidth ${o.sw} vs ${o.iw}`);
  const panels = await page.evaluate(() => ['dipCard', 'ownList', 'nudgeBox', 'goalOut', 'yirBox', 'recList'].map(id => document.getElementById(id).children.length));
  record(n, 'Tools: all six tools render content', panels.every(c => c > 0), panels.join());

  // Lucky dip: every mood returns an album that matches its rule; Another always differs
  for (const [mood, rule] of Object.entries(MOOD_RULES)) {
    await page.locator(`#dipMoods .chip[data-m="${mood}"]`).click();
    const titles = [];
    let ok = true, differs = true;
    for (let i = 0; i < 6; i++) {
      const t = await page.locator('#dipCard h3').textContent();
      const row = fxByTitle(t);
      if (!row || !rule(row)) ok = false;
      if (titles.length && titles[titles.length - 1] === t) differs = false;
      titles.push(t);
      await page.locator('#dipCard button', { hasText: 'Another' }).click();
    }
    const count = await page.locator('#dipCard .muted.small').last().textContent();
    record(n, `Lucky dip: "${mood}" always returns an album that fits (${count.trim()})`, ok, titles.join(' | '));
    record(n, `Lucky dip: "${mood}" Another gives a different album each time`, differs, titles.join(' | '));
  }
  const card = await page.evaluate(() => { const c = document.getElementById('dipCard'); return { h3: !!c.querySelector('h3'), meta: c.querySelector('.m').textContent, btns: [...c.querySelectorAll('button')].map(b => b.textContent) }; });
  record(n, 'Lucky dip: card shows artist/year and has Another, Log a listen today and Up next', card.h3 && /Test Artist/.test(card.meta) && /^Another,Log a listen today,(On )?Up next$/.test(card.btns.join()), JSON.stringify(card));
  // Log a listen today from the dip: one append to 🎸 Log, dated today
  await page.locator('#dipMoods .chip[data-m="Something new"]').click();
  // keep the sample nudge albums out of this step (the dip is random)
  for (let i = 0; i < 40 && [S4.stale, S4.quiet].includes(await page.locator('#dipCard h3').textContent()); i++) await page.locator('#dipCard button', { hasText: 'Another' }).click();
  const dipTitle = await page.locator('#dipCard h3').textContent();
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#dipCard button', { hasText: 'Log a listen today' }).click();
  await page.waitForFunction(() => /^Logged/.test(document.getElementById('statusText').textContent), null, { timeout: 8000 });
  const lw = await page.evaluate(() => window.__writes.map(w => ({ sheet: w.sheet, tool: w.tool, row: w.values[0] })));
  const todayIso = await page.evaluate(() => today());
  record(n, 'Lucky dip: "Log a listen today" appends one row to 🎸 Log dated today', lw.length === 1 && lw[0].sheet === '🎸 Log' && lw[0].tool === 'append_values' && lw[0].row[0] === todayIso && lw[0].row[2] === "'" + dipTitle, JSON.stringify(lw));
  const stillThere = await page.locator('#dipCard h3').textContent();
  record(n, 'Lucky dip: the album stays on screen after logging', stillThere === dipTitle, stillThere);

  // Do I own this?
  const ownLine = async q => { await page.locator('#ownQ').fill(q); return page.evaluate(() => [...document.querySelectorAll('#ownList li')].map(li => li.textContent)); };
  const ownedRow = fxRows().find(r => r[COL.format] === 'Vinyl (Owned)'), wantRow = fxRows().find(r => r[COL.format] === 'Vinyl (Wanted)');
  const o1 = await ownLine(ownedRow[COL.title]);
  record(n, 'Do I own this?: a Vinyl (Owned) album says "You own it on Vinyl"', o1.length === 1 && o1[0].includes('You own it on Vinyl') && o1[0].includes(ownedRow[COL.title]), o1.join(' / '));
  const o2 = await ownLine(wantRow[COL.title]);
  record(n, 'Do I own this?: a Vinyl (Wanted) album says "On your vinyl wish list"', o2.length === 1 && o2[0].includes('On your vinyl wish list'), o2.join(' / '));
  const plainRow = fxRows().find(r => !r[COL.format] && r[COL.status] === 'Listen');
  const o3 = await ownLine(plainRow[COL.title]);
  record(n, 'Do I own this?: an album you do not own says "Not owned" with its status', o3.length === 1 && o3[0].includes('Not owned') && o3[0].includes('Status: Listen'), o3.join(' / '));
  const o4 = await ownLine(ownedRow[COL.artist]);
  record(n, 'Do I own this?: searching by artist finds that artist\'s albums', o4.length >= 1 && o4.some(t => t.includes(ownedRow[COL.title]) && t.includes(ownedRow[COL.artist])), `${o4.length} hit(s)`);
  const o5 = await ownLine('zzzzqqq');
  record(n, 'Do I own this?: no match gives a plain answer', o5.length === 1 && /Nothing in your library/.test(o5[0]), o5.join());
  const wantBuy = fxRows().find(r => r[COL.format] === 'Vinyl (Wanted)');
  await ownLine(wantBuy[COL.title]);

  // Nudges
  const nudge = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#nudgeBox ol[data-nudge]')].map(ol => [ol.dataset.nudge, [...ol.querySelectorAll('li')].map(li => ({ t: li.querySelector('.t').textContent, btn: [...li.querySelectorAll('.acts button')].map(b => b.textContent).join() }))])));
  record(n, 'Nudges: an Up next album planned 100 days ago and never played is listed with "Log today"', (nudge.stale || []).some(x => x.t === S4.stale && x.btn === 'Log today'), JSON.stringify(nudge.stale));
  record(n, 'Nudges: a first listen with no play for 14+ days is listed with "Rate"', (nudge.first || []).some(x => x.t === S4.quiet && x.btn === 'Rate'), JSON.stringify(nudge.first));
  record(n, 'Nudges: a wish-list album without a Buy link is listed with "Edit"', (nudge.wish || []).length > 0 && nudge.wish.every(x => x.btn === 'Edit'), `${(nudge.wish || []).length} shown`);
  const nudgeWishShown = await page.locator('#nudgeBox ol[data-nudge="wish"] li').count();
  const nudgeWishTotal = Number((await page.locator('#nudgeBox .sub-head', { hasText: 'Wish list without a Buy link' }).textContent()).split('·').pop());
  const expectWish = fxRows().filter(r => r[COL.format] === 'Vinyl (Wanted)').length;   // the stub gives Buy links to some; check the count is plausible
  record(n, 'Nudges: long lists are capped at 5 with "Show all"', nudgeWishShown === 5 && nudgeWishTotal > 5 && nudgeWishTotal <= expectWish + 20, `${nudgeWishShown} of ${nudgeWishTotal}`);
  // Rate from the nudge writes the rating (and Status) cells of that album only
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator(`#nudgeBox ol[data-nudge="first"] li:has-text("${S4.quiet}") button`, { hasText: 'Rate' }).click();
  await page.locator('#nudgeBox ol[data-nudge="first"] .rate-pick button', { hasText: /^7$/ }).click();
  await page.locator('#nudgeBox button', { hasText: 'Save 7/10' }).click();
  await page.waitForFunction(() => /Rated/.test(document.getElementById('statusText').textContent), null, { timeout: 8000 });
  const quietId = fxByTitle(S4.quiet)[COL.id];
  const rw = await page.evaluate(() => window.__writes.map(w => ({ sheet: w.sheet, range: w.range.replace("'🎸'!", ''), v: w.values[0][0] })));
  const qrow = await page.evaluate(sheetRow, quietId);
  record(n, 'Nudges: Rate writes only that album\'s Rating and Status cells', rw.length === 2 && rw.every(w => w.sheet === '🎸') && JSON.stringify(rw.map(w => w.range).sort()) === JSON.stringify([`B${qrow}`, `D${qrow}`]) && rw.find(w => w.range === `B${qrow}`).v === 7, JSON.stringify(rw));
  const gone = await page.locator('#nudgeBox ol[data-nudge="first"] .t', { hasText: S4.quiet }).count();
  record(n, 'Nudges: once rated, the album leaves the list', gone === 0);
  // Log today from a stale Up next album clears the nudge
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator(`#nudgeBox ol[data-nudge="stale"] li:has-text("${S4.stale}") button`, { hasText: 'Log today' }).click();
  await page.waitForFunction(() => /^Logged/.test(document.getElementById('statusText').textContent), null, { timeout: 8000 });
  const sw = await page.evaluate(() => window.__writes.map(w => w.sheet + ':' + w.tool));
  record(n, 'Nudges: Log today appends a single row to 🎸 Log', sw.length === 1 && sw[0] === '🎸 Log:append_values', sw.join());
  record(n, 'Nudges: a logged Up next album leaves the stale list', (await page.locator('#nudgeBox ol[data-nudge="stale"]').count()) === 0 || (await page.locator('#nudgeBox ol[data-nudge="stale"] .t', { hasText: S4.stale }).count()) === 0);
  // Edit opens the album dialog
  await page.locator('#nudgeBox ol[data-nudge="wish"] li button', { hasText: 'Edit' }).first().click();
  record(n, 'Nudges: Edit opens the album edit dialog', await page.evaluate(() => document.getElementById('albumDlg').open));
  await page.locator('#dlgClose').click();

  // Goal planner (read-only parts)
  const goalTxt = await page.locator('#goalOut').textContent();
  const Y = String(new Date().getFullYear());
  const keys = new Set(seed['🎸 Log'].slice(1).filter(r => r[0].startsWith(Y)).map(r => r[1]));
  keys.add(quietId); keys.add(fxByTitle(S4.stale)[COL.id]); keys.add(fxByTitle(dipTitle)[COL.id]);   // logged during this test
  record(n, 'Goal planner: shows albums heard this year of the goal', new RegExp(`^${keys.size}\\s*of 52 albums`).test(goalTxt) && /albums a week/.test(goalTxt) && /current pace/.test(goalTxt), goalTxt.slice(0, 140));
  record(n, 'Goal planner: has a progress bar', (await page.locator('#goalOut .goal-bar i').count()) === 1);

  // Year in review
  const yy = await page.evaluate(() => ({ opts: [...document.querySelectorAll('#yirYear option')].map(o => o.value), tiles: [...document.querySelectorAll('#yirBox .yir-tiles b')].map(b => b.textContent), text: document.getElementById('yirBox').textContent, lists: document.querySelectorAll('#yirBox .yir-cols section').length, topAlbums: document.querySelectorAll('#yirBox .yir-cols section:nth-child(1) li button').length }));
  record(n, 'Year in review: the picker lists this year and the earlier years with log entries', yy.opts.includes(Y) && yy.opts.includes(String(Number(Y) - 1)) && yy.opts.includes(String(Number(Y) - 2)), yy.opts.join());
  record(n, 'Year in review: four totals, three lists, a busiest month', yy.tiles.length === 4 && yy.lists === 3 && /Busiest month: \w+ with \d+ listens?/.test(yy.text) && yy.topAlbums >= 1 && yy.topAlbums <= 5, `${yy.tiles.join('/')}`);
  const curPlays = seed['🎸 Log'].slice(1).filter(r => r[0].startsWith(Y)).reduce((s, r) => s + Number(r[4]), 0) + 2;   // + the two listens logged above
  record(n, 'Year in review: listens total matches the log', Number(yy.tiles[0]) === curPlays, `${yy.tiles[0]} vs ${curPlays}`);
  await page.locator('#yirYear').selectOption(String(Number(Y) - 2));
  const y2 = await page.evaluate(() => ({ tiles: [...document.querySelectorAll('#yirBox .yir-tiles b')].map(b => b.textContent), text: document.getElementById('yirBox').textContent }));
  record(n, 'Year in review: a past year shows its own totals (1 album, 2 listens, 1 new)', y2.tiles.join() === '2,1,1,1' && /Busiest month/.test(y2.text), y2.tiles.join());
  await page.locator('#yirYear').selectOption(String(Number(Y) - 1));
  const yBest = await page.locator('#yirBox .yir-cols section:nth-child(3) li').allTextContents();
  record(n, 'Year in review: "Highest rated new" lists albums first logged that year, with ratings', yBest.length === 1 && yBest[0].includes('Test Album 032 LP') && yBest[0].includes('9/10'), yBest.join(' | '));
  await page.locator('#yirYear').selectOption(Y);

  // Recommendations
  const recTitles = await page.locator('#recList .rec .t').allTextContents();
  const P = new Map();   // artist -> ratings, for a sanity check of the first pick
  for (const r of fxRows()) if (parseFloat(r[COL.rating]) > 0 && fxHeard(r)) (P.get(r[COL.artist]) || P.set(r[COL.artist], []).get(r[COL.artist])).push(parseFloat(r[COL.rating]));
  record(n, 'Recommendations: Best match shows up to 5 backlog albums, each with a "why" chip', recTitles.length > 0 && recTitles.length <= 5 && recTitles.every(t => fxBacklog(fxByTitle(t))) && (await page.locator('#recList .rec .why-chip').count()) > 0, recTitles.join(' | '));
  const modeRes = {};
  for (const m of ['artists', 'change', 'revisit', 'best']) {
    await page.locator(`#recModes .chip[data-m="${m}"]`).click();
    modeRes[m] = await page.evaluate(() => [...document.querySelectorAll('#recList .rec')].map(r => ({ t: r.querySelector('.t').textContent, chips: [...r.querySelectorAll('.why-chip')].map(c => c.textContent), act: r.querySelector('[data-act]').textContent })));
  }
  record(n, 'Recommendations: More from favourite artists only lists artists you rate 7+ on average', modeRes.artists.length > 0 && modeRes.artists.every(x => { const rs = P.get(fxByTitle(x.t)[COL.artist]) || []; return rs.length && rs.reduce((a, b) => a + b, 0) / rs.length >= 7 && fxBacklog(fxByTitle(x.t)); }), JSON.stringify(modeRes.artists.map(x => x.t)));
  record(n, 'Recommendations: Change of pace lists backlog albums with a genre chip', modeRes.change.length > 0 && modeRes.change.every(x => fxBacklog(fxByTitle(x.t)) && fxByTitle(x.t)[COL.genre] && x.chips.length > 0), JSON.stringify(modeRes.change.map(x => [x.t, x.chips[0]])));
  const sixMonths = 180;
  record(n, 'Recommendations: Revisit lists albums rated 9-10 with "Log a listen today" as the action', modeRes.revisit.length > 0 && modeRes.revisit.every(x => parseFloat(fxByTitle(x.t)[COL.rating]) >= 9 && x.act === 'Log a listen today'), JSON.stringify(modeRes.revisit.map(x => [x.t, x.act])));
  record(n, 'Recommendations: Best match / Artists / Change use "Up next" as the action', [modeRes.best, modeRes.artists, modeRes.change].every(l => l.every(x => x.act === 'Up next')));
  const recLogged = new Set(seed['🎸 Log'].slice(1).map(r => r[0]));
  void sixMonths; void recLogged;

  // Recommendations "Up next": single-cell K/L/O writes on that album's row only
  const firstRec = await page.locator('#recList .rec').first().getAttribute('data-id');
  const recRow = await page.evaluate(sheetRow, firstRec);
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#recList .rec').first().locator('button[data-act="up"]').click();
  await waitSaved(page);
  const uw = await page.evaluate(() => window.__writes.map(w => ({ sheet: w.sheet, tool: w.tool, range: w.range.replace("'🎸'!", ''), cells: w.values.length * w.values[0].length })));
  record(n, 'Recommendations: "Up next" writes only K, L and O of that album\'s row, one cell each', uw.length > 0 && uw.every(w => w.sheet === '🎸' && w.tool === 'update_values' && w.cells === 1 && [`K${recRow}`, `L${recRow}`, `O${recRow}`].includes(w.range)) && uw.some(w => w.range === `K${recRow}`), JSON.stringify(uw));
  const stillListed = await page.locator(`#recList .rec[data-id="${firstRec}"]`).count();
  record(n, 'Recommendations: an album moved to Up next leaves the list', stillListed === 0);

  // Dip "Up next": same single-cell rule
  await page.locator('#dipMoods .chip[data-m="Something new"]').click();
  for (let i = 0; i < 40 && await page.locator('#dipCard button', { hasText: /^Up next$/ }).isDisabled().catch(() => true); i++) await page.locator('#dipCard button', { hasText: 'Another' }).click();
  const dipUpTitle = await page.locator('#dipCard h3').textContent();
  const dipRow = await page.evaluate(sheetRow, fxByTitle(dipUpTitle)[COL.id]);
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#dipCard button', { hasText: /^Up next$/ }).click();
  await waitSaved(page);
  const dw = await page.evaluate(() => window.__writes.map(w => ({ sheet: w.sheet, range: w.range.replace("'🎸'!", '') })));
  record(n, 'Lucky dip: "Up next" writes only K, L and O of that album\'s row', dw.length > 0 && dw.every(w => w.sheet === '🎸' && [`K${dipRow}`, `L${dipRow}`, `O${dipRow}`].includes(w.range)), JSON.stringify(dw));
  record(n, 'Lucky dip: the Up next button then reads "On Up next" and is disabled', await page.locator('#dipCard button', { hasText: 'On Up next' }).isDisabled());

  o = await page.evaluate(overflow);
  record(n, 'Tools: no sideways scroll after interactions', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  const forb = await page.evaluate(() => window.__forbidden.length);
  record(n, 'Tools: never touches a tab outside 🎸', forb === 0);
  record(n, 'Tools: no console errors or uncaught exceptions', problems.length === 0, problems.slice(0, 2).join(' | '));
  await page.locator('#ownQ').fill(ownedRow[COL.title]);
  await page.screenshot({ path: join(OUT, `${n}-tools.png`), fullPage: true });
  await context.close();
}

// Goal planner writes: on its own page so the write log is exact
async function goalTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'tools');
  const goalRow = await page.evaluate(() => window.__sheet['🎸 Settings'].findIndex(r => r[0] === 'yearGoalAlbums') + 1);
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#goalOut button', { hasText: 'Change goal' }).click();
  await page.locator('#goalIn').fill('60');
  await page.locator('#goalOut button', { hasText: 'Save goal' }).click();
  await page.waitForFunction(() => document.getElementById('statusText').textContent === 'Goal set to 60 albums', null, { timeout: 8000 });
  const w = await page.evaluate(() => window.__writes.map(x => ({ tool: x.tool, sheet: x.sheet, range: x.range, v: x.values })));
  record(n, 'Goal planner: changing the goal to 60 makes exactly one write, to B of the yearGoalAlbums row in 🎸 Settings', w.length === 1 && w[0].tool === 'update_values' && w[0].sheet === '🎸 Settings' && w[0].range === `'🎸 Settings'!B${goalRow}` && JSON.stringify(w[0].v) === '[[60]]', JSON.stringify(w));
  const after = await page.evaluate(r => ({ cell: window.__sheet['🎸 Settings'][r - 1], text: document.getElementById('goalOut').textContent, tab: window.__sheet['🎸 Settings'].length }), goalRow);
  record(n, 'Goal planner: the sheet cell holds 60, the key cell is untouched, and the page shows "of 60"', after.cell[0] === 'yearGoalAlbums' && after.cell[1] === '60' && /of 60 albums/.test(after.text), JSON.stringify(after.cell));
  const sg = await page.evaluate(() => window.__sg.state.settings.yearGoalAlbums);
  record(n, 'Goal planner: the Log tab goal follows (60)', sg === 60 && (await (async () => { await page.locator('#tab-log').click(); return page.locator('#sHeardSub').textContent(); })()).includes('60'));
  // Saving the same number again writes nothing
  await page.locator('#tab-tools').click();
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#goalOut button', { hasText: 'Change goal' }).click();
  await page.locator('#goalIn').fill('60');
  await page.locator('#goalOut button', { hasText: 'Save goal' }).click();
  await page.waitForFunction(() => /already 60/.test(document.getElementById('statusText').textContent), null, { timeout: 8000 });
  record(n, 'Goal planner: saving an unchanged goal writes nothing', (await page.evaluate(() => window.__writes.length)) === 0);
  // Bad input is refused without any write
  await page.locator('#goalOut button', { hasText: 'Change goal' }).click();
  await page.locator('#goalIn').fill('0');
  await page.locator('#goalOut button', { hasText: 'Save goal' }).click();
  record(n, 'Goal planner: 0 is refused with a message and no write', /whole number/.test(await page.locator('#goalOut').textContent()) && (await page.evaluate(() => window.__writes.length)) === 0);
  record(n, 'Goal planner: no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();

  // A Settings tab without the key: one appended row [ 'yearGoalAlbums, 40 ] and nothing else
  const noKey = { ...seed, '🎸 Settings': seed['🎸 Settings'].filter(r => r[0] !== 'yearGoalAlbums') };
  const b = await freshPage(browser, vp, noKey, url, 'tools');
  await b.page.evaluate(() => { window.__writes.length = 0; });
  await b.page.locator('#goalOut button', { hasText: 'Change goal' }).click();
  await b.page.locator('#goalIn').fill('40');
  await b.page.locator('#goalOut button', { hasText: 'Save goal' }).click();
  await b.page.waitForFunction(() => document.getElementById('statusText').textContent === 'Goal set to 40 albums', null, { timeout: 8000 });
  const w2 = await b.page.evaluate(() => window.__writes.map(x => ({ tool: x.tool, sheet: x.sheet, v: x.values })));
  record(n, 'Goal planner: when the key is missing, one row is appended to 🎸 Settings', w2.length === 1 && w2[0].tool === 'append_values' && w2[0].sheet === '🎸 Settings' && JSON.stringify(w2[0].v) === `[["'yearGoalAlbums",40]]`, JSON.stringify(w2));
  await b.context.close();

  // Duplicate key: refuse, write nothing
  const dup = { ...seed, '🎸 Settings': [...seed['🎸 Settings'], ['yearGoalAlbums', '99']] };
  const c = await freshPage(browser, vp, dup, url, 'tools');
  await c.page.evaluate(() => { window.__writes.length = 0; });
  await c.page.locator('#goalOut button', { hasText: 'Change goal' }).click();
  await c.page.locator('#goalIn').fill('70');
  await c.page.locator('#goalOut button', { hasText: 'Save goal' }).click();
  await c.page.waitForFunction(() => /appears 2 times/.test(document.getElementById('goalOut').textContent), null, { timeout: 8000 });
  record(n, 'Goal planner: a key that appears twice is refused and nothing is written', (await c.page.evaluate(() => window.__writes.length)) === 0);
  await c.context.close();
}

async function discoverTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'discover');
  let o = await page.evaluate(overflow);
  record(n, 'Discover: renders with no sideways scroll', o.sw <= o.iw && (await page.locator('#view-discover').isVisible()), `scrollWidth ${o.sw} vs ${o.iw}`);
  const pool = fxRows().filter(r => fxHeard(r) && parseFloat(r[COL.rating]) >= 8).map(r => r[COL.title]);
  const pick1 = await page.locator('#aotdBox h3').textContent();
  record(n, 'Album of the day: comes from the rated-8-or-more pool', pool.includes(pick1), `${pick1} (pool ${pool.length})`);
  const card = await page.evaluate(() => { const c = document.getElementById('aotdBox'); return { text: c.querySelector('.aotd').textContent, btn: [...c.querySelectorAll('button')].map(b => b.textContent), yest: c.querySelector('.yest').textContent }; });
  const r1 = fxByTitle(pick1);
  record(n, 'Album of the day: shows artist, rating, year, a "Rated N · year" line, and Log a listen today', card.text.includes(r1[COL.artist]) && card.text.includes(`Rated ${r1[COL.rating]} · ${r1[COL.year]}`) && card.btn.includes('Log a listen today'), card.text.slice(0, 160));
  const yesterdayTitle = card.yest.replace(/^Yesterday's: /, '').split(' by ')[0];
  record(n, 'Album of the day: a "Yesterday\'s" line names a different pool album', /^Yesterday's: /.test(card.yest) && pool.includes(yesterdayTitle) && yesterdayTitle !== pick1, card.yest);
  // Stable across reloads on the same day
  const seen = [pick1];
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
    await page.locator('#tab-discover').click();
    seen.push(await page.locator('#aotdBox h3').textContent());
  }
  record(n, 'Album of the day: the same album after two reloads on the same day', new Set(seen).size === 1, seen.join(' | '));
  // Log a listen today from the card
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#aotdBox button', { hasText: 'Log a listen today' }).click();
  await page.waitForFunction(() => /^Logged/.test(document.getElementById('statusText').textContent), null, { timeout: 8000 });
  const lw = await page.evaluate(() => window.__writes.map(w => w.sheet + ':' + w.tool));
  record(n, 'Album of the day: "Log a listen today" appends one row to 🎸 Log', lw.length === 1 && lw[0] === '🎸 Log:append_values', lw.join());
  record(n, 'Album of the day: still the same album after logging', (await page.locator('#aotdBox h3').textContent()) === pick1);

  // On this day
  const od = await page.locator('#onDayList li').allTextContents();
  for (const x of S4.onDay) {
    record(n, `On this day: "${x.back === 1 ? '1 year ago' : x.back + ' years ago'} you played ${x.title}"`, od.some(t => t.includes(`${x.back === 1 ? '1 year ago' : x.back + ' years ago'} you played ${x.title}`)), od.join(' | '));
  }
  record(n, 'On this day: an album with a Release Date on today\'s month-day shows "was released 7 years ago today"', od.some(t => t.includes(`${S4.release} was released 7 years ago today`)), od.join(' | '));
  record(n, 'On this day: nearest year first', od[0].startsWith('1 year ago'), od[0]);

  // Anniversaries
  const Y = new Date().getFullYear();
  const an = await page.evaluate(() => [...document.querySelectorAll('#annivBox .mile-head')].map(h => ({ m: h.dataset.milestone, text: h.textContent, items: h.nextElementSibling.querySelectorAll('li').length })));
  const wantAn = [10, 20, 25, 30, 40, 50, 60].map(m => ({ m: String(m), n: fxRows().filter(r => parseFloat(r[COL.year]) === Y - m).length })).filter(x => x.n);
  record(n, 'Anniversaries: one group per milestone that has albums, in order, with the right counts', JSON.stringify(an.map(a => [a.m, Math.min(a.items, 99)])) === JSON.stringify(wantAn.map(a => [a.m, Math.min(a.n, 6)])) && an.every((a, i) => a.text.includes(`released ${Y - Number(a.m)}`) && a.text.includes(`${wantAn[i].n} album`)), JSON.stringify(an));
  // Coming soon
  const soon = await page.locator('#soonList2 li').allTextContents();
  const wantSoon = fxRows().filter(r => r[COL.status] === 'Coming Soon');
  record(n, 'Coming soon: lists Coming Soon albums with their year', soon.length === wantSoon.length && wantSoon.every(r => soon.some(t => t.includes(r[COL.title]) && t.includes(r[COL.year]))), soon.join(' | '));
  // Empty states
  const empty = { ...seed, '🎸 Log': [seed['🎸 Log'][0]] };
  o = await page.evaluate(overflow);
  record(n, 'Discover: no sideways scroll after interactions', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  record(n, 'Discover: no console errors or uncaught exceptions', problems.length === 0, problems.slice(0, 2).join(' | '));
  await page.screenshot({ path: join(OUT, `${n}-discover.png`), fullPage: true });
  await context.close();

  // Next day: a different album, and "Yesterday's" now names today's pick
  const t0 = new Date();
  const next = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + 1, 12, 0, 0);
  const d2 = await freshPage(browser, vp, seed, url, 'discover', { clockTo: next });
  const pick2 = await d2.page.locator('#aotdBox h3').textContent();
  const yest2 = await d2.page.locator('#aotdBox .yest').textContent();
  record(n, 'Album of the day: tomorrow gives a different album from the pool', pool.includes(pick2) && pick2 !== pick1 && pool.length >= 2, `${pick1} -> ${pick2}`);
  record(n, 'Album of the day: tomorrow\'s "Yesterday\'s" line is today\'s pick', yest2.includes(pick1), yest2);
  await d2.context.close();

  // No albums rated high enough: friendly empty state, no errors
  const lowSeed = { ...seed, '🎸': seed['🎸'].map((r, i) => (i === 0 ? r : [...r.slice(0, 1), r[1] && parseFloat(r[1]) >= 8 ? '5' : r[1], ...r.slice(2)])) };
  const e = await freshPage(browser, vp, lowSeed, url, 'discover');
  const et = await e.page.locator('#aotdBox').textContent();
  record(n, 'Album of the day: with nothing rated 8+ it explains what to do', /No albums rated 8 or higher yet/.test(et) && e.problems.length === 0, et.slice(0, 100));
  await e.context.close();
  // Empty log: On this day empty state and Year in review empty state
  const f = await freshPage(browser, vp, empty, url, 'discover');
  const ft = await f.page.locator('#onDayList').textContent();
  record(n, 'On this day: with no log and no release dates matching it says so', /Nothing on this date/.test(ft) || /was released/.test(ft), ft.slice(0, 120));
  await f.page.locator('#tab-tools').click();
  const yt = await f.page.locator('#yirBox').textContent();
  record(n, 'Year in review: an empty log gives a friendly empty state', /No listens logged yet/.test(yt), yt.slice(0, 100));
  record(n, 'Tools and Discover: nothing throws with an empty log', f.problems.length === 0, f.problems.slice(0, 2).join(' | '));
  await f.context.close();
}


// ---------- Tracks ----------
const TRK_TAB = '🎸 Tracks';
const trkRowOf = id => window.__sheet['🎸 Tracks'].findIndex((r, i) => i > 0 && r[0] === String(id)) + 1;
const trkWrites = page => page.evaluate(() => window.__writes.map(w => ({ tool: w.tool, sheet: w.sheet, range: w.range.replace("'🎸 Tracks'!", ''), values: w.values })));
const trkMsg = page => page.locator('#trkMsg').textContent();
const trkWaitMsg = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('trkMsg').textContent), re.source, { timeout: 8000 });
const trkWaitSaved = page => page.waitForFunction(() => document.getElementById('statusText').textContent === 'Tracks saved', null, { timeout: 8000 });
const trkOverflow = page => page.evaluate(() => { const d = document.getElementById('tracksDlg'); return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, dsw: d.scrollWidth, dcw: d.clientWidth }; });
const trkList = page => page.evaluate(() => [...document.querySelectorAll('#trkList .trk-row')].map(li => ({ id: li.dataset.id, pos: li.querySelector('.pos').textContent, title: li.querySelector('.t') ? li.querySelector('.t').textContent : '' })));
async function openTracksFromLibrary(page, id) {
  await page.locator('#tab-library').click();
  if (!(await page.locator(`#libBody tr.row.open[data-id="${id}"]`).count())) await page.locator(`#libBody tr.row[data-id="${id}"]`).click();
  await page.locator('#libBody tr.detail [data-tracks]').click();
  await page.waitForFunction(() => document.getElementById('tracksDlg').open);
  await page.waitForTimeout(150);
}
async function closeTracks(page) { await page.locator('#trkClose').click(); await page.waitForFunction(() => !document.getElementById('tracksDlg').open); }

async function tracksTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'library');
  const today = await page.evaluate(() => today());

  // Library detail row shows the count, then the Tracks dialog opens
  await page.locator('#libBody tr.row[data-id="1001"]').click();
  const detail = await page.locator('#libBody tr.detail').textContent();
  record(n, 'Tracks: Library detail row shows "2/5 copied"', /2\/5 copied/.test(detail), detail.slice(-80));
  await openTracksFromLibrary(page, '1001');
  const head = await page.evaluate(() => ({ title: document.getElementById('trkTitle').textContent, sub: document.getElementById('trkSub').textContent, prog: document.getElementById('trkProgText').textContent, bar: document.getElementById('trkBar').style.width }));
  record(n, 'Tracks: dialog header shows album, artist and year', head.title === 'Test Album 001 LP' && head.sub.includes('Test Artist 01') && head.sub.includes('1966'), JSON.stringify(head));
  record(n, 'Tracks: progress reads "2 of 5 tracks copied" with a 40% bar', head.prog === '2 of 5 tracks copied' && head.bar === '40%', `${head.prog} ${head.bar}`);
  const rows = await trkList(page);
  record(n, 'Tracks: grouped by side in order (A1 A2 A3, B1 B2) and the blank row is skipped', rows.map(r => r.pos).join() === 'A1,A2,A3,B1,B2' && rows.map(r => r.id).join() === '5001,5002,5003,5004,5005', rows.map(r => r.pos).join());
  const sides = await page.locator('#trkList .trk-side .eyebrow').allTextContents();
  record(n, 'Tracks: side headings are "Side A" and "Side B"', sides.join() === 'Side A,Side B', sides.join());
  const meta = await page.locator('#trkList .trk-row[data-id="5001"]').textContent();
  const fd = new Date(today + 'T00:00:00'); fd.setDate(fd.getDate() - 3);
  const want = `${fd.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][fd.getMonth()]} ${String(fd.getFullYear()).slice(2)}`;
  record(n, 'Tracks: shows length and the copied date as "d Mon yy"', meta.includes('5:12') && meta.includes('Copied ' + want), meta);
  let o = await trkOverflow(page);
  record(n, 'Tracks: no sideways scroll (long title wraps)', o.sw <= o.iw && o.dsw <= o.dcw, JSON.stringify(o));
  await page.screenshot({ path: join(OUT, `${n}-tracks.png`) });

  // Parser
  const parsed = await page.evaluate(() => parseTracklist([
    "A1 Israel's Son 5:12", "A2. Rocket (3:48)", "B3 - Tomorrow - 4:26", "1 Song name", "Plain song", "Side C", "Long one 1:02:03", "04) Zero Padded [7:05]"].join('\n'), null));
  const wantParsed = [
    ['A', '1', "Israel's Son", '5:12'], ['A', '2', 'Rocket', '3:48'], ['B', '3', 'Tomorrow', '4:26'], ['', '1', 'Song name', ''], ['', '2', 'Plain song', ''],
    ['C', '1', 'Long one', '1:02:03'], ['C', '4', 'Zero Padded', '7:05']];
  record(n, 'Tracks: parser handles every line format, header lines and h:mm:ss', JSON.stringify(parsed.map(r => [r.side, r.no, r.title, r.length])) === JSON.stringify(wantParsed), JSON.stringify(parsed.map(r => [r.side, r.no, r.title, r.length])));

  // Copied ✓ writes one cell
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#trkList .trk-row[data-id="5003"] [data-act="copied"]').click();
  await trkWaitSaved(page);
  let w = await trkWrites(page);
  const r3 = await page.evaluate(trkRowOf, 5003);
  record(n, 'Tracks: Copied ✓ writes exactly one cell, H of that row = today', w.length === 1 && w[0].tool === 'update_values' && w[0].range === `H${r3}` && w[0].values[0][0] === today && w[0].sheet === TRK_TAB, JSON.stringify(w));
  record(n, 'Tracks: progress moves to "3 of 5"', (await page.locator('#trkProgText').textContent()) === '3 of 5 tracks copied');
  // Tapping a copied track offers to clear the date
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#trkList .trk-row[data-id="5003"] [data-act="copied"]').click();
  const ask = await page.locator('#trkList .trk-row[data-id="5003"]').textContent();
  record(n, 'Tracks: tapping a copied track asks before clearing, and writes nothing yet', /Clear copied date/.test(ask) && (await trkWrites(page)).length === 0, ask);
  await page.locator('#trkList .trk-row[data-id="5003"] [data-act="clear-yes"]').click();
  await trkWaitSaved(page);
  w = await trkWrites(page);
  record(n, 'Tracks: "Clear copied date" writes one empty H cell', w.length === 1 && w[0].range === `H${r3}` && w[0].values[0][0] === '', JSON.stringify(w));

  // Edit title: only F
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#trkList .trk-row[data-id="5002"] [data-act="edit"]').click();
  await page.locator('#trkList .trk-row[data-id="5002"] [data-f="title"]').fill("Second Wind (remaster)");
  await page.locator('#trkList .trk-row[data-id="5002"] [data-act="edit-save"]').click();
  await trkWaitMsg(page, /^Saved/);
  w = await trkWrites(page);
  const r2 = await page.evaluate(trkRowOf, 5002);
  record(n, 'Tracks: editing a title writes only F of that row', w.length === 1 && w[0].range === `F${r2}` && w[0].values[0][0] === "'Second Wind (remaster)", JSON.stringify(w));
  const t2 = await page.locator('#trkList .trk-row[data-id="5002"] .t').textContent();
  record(n, 'Tracks: the edited title shows', t2 === 'Second Wind (remaster)', t2);

  // Mark side B copied: one H per not-yet-copied track on that side
  await page.evaluate(() => { window.__writes.length = 0; });
  const r4 = await page.evaluate(trkRowOf, 4 + 5000), r5 = await page.evaluate(trkRowOf, 5005);
  await page.locator('#trkList .trk-side[data-side="B"] [data-act="side"]').click();
  await trkWaitSaved(page);
  w = await trkWrites(page);
  record(n, 'Tracks: "Mark side B copied" writes one H cell per uncopied B track and nothing on side A', w.length === 2 && w.map(x => x.range).sort().join() === [`H${r4}`, `H${r5}`].sort().join() && w.every(x => x.values[0][0] === today), JSON.stringify(w.map(x => [x.range, x.values[0][0]])));
  record(n, 'Tracks: that side button is then disabled', await page.locator('#trkList .trk-side[data-side="B"] [data-act="side"]').isDisabled());
  record(n, 'Tracks: progress is "4 of 5" (side A still has one to do)', (await page.locator('#trkProgText').textContent()) === '4 of 5 tracks copied');
  // Mark all: only the one left (5003)
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#trkAll').click();
  await trkWaitSaved(page);
  w = await trkWrites(page);
  record(n, 'Tracks: "Mark all copied" writes only the track still to do', w.length === 1 && w[0].range === `H${r3}`, JSON.stringify(w));
  record(n, 'Tracks: all copied -> "5 of 5", Mark all disabled', (await page.locator('#trkProgText').textContent()) === '5 of 5 tracks copied' && await page.locator('#trkAll').isDisabled());

  // Delete: confirm in the page first, then one update of nine empty strings
  await page.evaluate(() => { window.__writes.length = 0; window.__rowsBefore = window.__sheet['🎸 Tracks'].length; });
  const r1 = await page.evaluate(trkRowOf, 5001);
  await page.locator('#trkList .trk-row[data-id="5001"] [data-act="delete"]').click();
  const ask2 = await page.locator('#trkList .trk-row[data-id="5001"]').textContent();
  record(n, 'Tracks: Delete asks in the page first and writes nothing yet', /Delete this track\?/.test(ask2) && (await trkWrites(page)).length === 0, ask2);
  await page.locator('#trkList .trk-row[data-id="5001"] [data-act="delete-yes"]').click();
  await trkWaitMsg(page, /^Deleted/);
  w = await trkWrites(page);
  record(n, 'Tracks: Delete writes exactly one update to A<row>:I<row> with nine ""', w.length === 1 && w[0].tool === 'update_values' && w[0].range === `A${r1}:I${r1}` && w[0].values.length === 1 && w[0].values[0].length === 9 && w[0].values[0].every(v => v === ''), JSON.stringify(w));
  const after = await page.evaluate(() => ({ rows: window.__sheet['🎸 Tracks'].length, before: window.__rowsBefore, ids: window.__sheet['🎸 Tracks'].map(r => r[0]).join() }));
  record(n, 'Tracks: the sheet row is emptied, not removed, and other rows are untouched', after.rows === after.before && after.ids === ',,5002,5003,,5004,5005,5006,5007'.replace(/^,,/, 'id,,'), after.ids);
  const rows2 = await trkList(page);
  record(n, 'Tracks: the deleted track disappears from the list', !rows2.some(r => r.id === '5001') && rows2.length === 4, rows2.map(r => r.pos).join());
  await page.screenshot({ path: join(OUT, `${n}-tracks-after.png`) });

  // Single add: default number is the next on that side; long title wraps
  await page.locator('#trkOneSide').fill('b');
  const dflt = await page.locator('#trkOneNo').inputValue();
  record(n, 'Tracks: single add defaults the number to the next one on that side', dflt === '3', dflt);
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#trkOneTitle').fill('A really quite long track title ' + 'wraps '.repeat(14));
  await page.locator('#trkOneLen').fill('3:07');
  await page.locator('#trkOneAdd').click();
  await trkWaitMsg(page, /^Added 1 track/);
  w = await trkWrites(page);
  record(n, 'Tracks: single add makes one append of one row with id max+1', w.length === 1 && w[0].tool === 'append_values' && w[0].values.length === 1 && w[0].values[0][0] === 5008 && w[0].values[0][3] === "'B" && w[0].values[0][4] === 3, JSON.stringify(w[0] && w[0].values[0]).slice(0, 120));
  o = await trkOverflow(page);
  record(n, 'Tracks: no sideways scroll with a very long title', o.sw <= o.iw && o.dsw <= o.dcw, JSON.stringify(o));
  await closeTracks(page);

  // Paste on album 1002: preview, fix, one append
  await openTracksFromLibrary(page, '1002');
  await page.evaluate(() => { window.__writes.length = 0; });
  await page.locator('#trkPaste').fill(["A1 Israel's Son 5:12", 'A2. Rocket Man (3:48)', 'B3 - Tomorrow - 4:26', '1 Song name'].join('\n'));
  const pv = await page.evaluate(() => [...document.querySelectorAll('#trkPreview .pv-row')].map(r => ['side', 'no', 'title', 'length'].map(k => r.querySelector(`[data-f="${k}"]`).value)));
  record(n, 'Tracks: pasting 4 lines shows a 4-row preview parsed correctly', JSON.stringify(pv) === JSON.stringify([['A', '1', "Israel's Son", '5:12'], ['A', '2', 'Rocket Man', '3:48'], ['B', '3', 'Tomorrow', '4:26'], ['', '1', 'Song name', '']]), JSON.stringify(pv));
  record(n, 'Tracks: nothing is written until Save', (await trkWrites(page)).length === 0);
  await page.locator('#trkPreview .pv-row[data-i="2"] [data-f="title"]').fill('Tomorrow Never Knows');
  o = await trkOverflow(page);
  record(n, 'Tracks: no sideways scroll with the preview showing', o.sw <= o.iw && o.dsw <= o.dcw, JSON.stringify(o));
  await page.locator('#trkSavePaste').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, `${n}-tracks-preview.png`) });
  const trkBefore = await page.evaluate(t => JSON.stringify(window.__sheet[t]), TRK_TAB);
  await page.locator('#trkSavePaste').click();
  await trkWaitMsg(page, /^Added 4 tracks/);
  // Nothing already in the tab may move or be overwritten: the blank (deleted) row stays blank,
  // and every row that was there before is unchanged; the new rows go below the last used row.
  const trkAfter = await page.evaluate(t => window.__sheet[t], TRK_TAB);
  const before = JSON.parse(trkBefore);
  const untouched = before.every((r, i) => JSON.stringify((trkAfter[i] || []).map(String)) === JSON.stringify(r.map(String)));
  record(n, 'Tracks: adding never overwrites or fills a blank (deleted) row', untouched && trkAfter.length >= before.length + 4, `before ${before.length} rows, after ${trkAfter.length}`);
  w = await trkWrites(page);
  const appends = w.filter(x => x.tool === 'append_values');
  const vals = appends[0] && appends[0].values;
  record(n, 'Tracks: saving makes exactly ONE append_values to 🎸 Tracks with 4 rows', w.length === 1 && appends.length === 1 && appends[0].sheet === TRK_TAB && vals.length === 4, `${w.length} write(s), ${vals && vals.length} row(s)`);
  record(n, 'Tracks: new ids are consecutive from max+1', vals && vals.map(r => r[0]).join() === '5009,5010,5011,5012', vals && vals.map(r => r[0]).join());
  record(n, 'Tracks: values are typed (ids and no as numbers; side, title, length as text with a leading \')', vals && JSON.stringify(vals[0]) === JSON.stringify([5009, 1002, "'Test Album 002 LP", "'A", 1, "'Israel's Son", "'5:12", '', '']) && JSON.stringify(vals[2]) === JSON.stringify([5011, 1002, "'Test Album 002 LP", "'B", 3, "'Tomorrow Never Knows", "'4:26", '', '']) && JSON.stringify(vals[3]) === JSON.stringify([5012, 1002, "'Test Album 002 LP", '', 1, "'Song name", '', '', '']), vals && JSON.stringify(vals[3]));
  const prog2 = await page.locator('#trkProgText').textContent();
  record(n, 'Tracks: the new tracks appear and progress updates ("2 of 6")', prog2 === '2 of 6 tracks copied', prog2);
  await closeTracks(page);

  const bad = await page.evaluate(() => ({ forbidden: window.__forbidden, offTab: window.__writes.filter(x => !x.sheet.startsWith('🎸')).length }));
  record(n, 'Tracks: no write ever touches a tab outside 🎸', bad.forbidden.length === 0 && bad.offTab === 0, JSON.stringify(bad));
  record(n, 'Tracks: no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();

  // Library chip and Dashboard tile (fresh data)
  const f = await freshPage(browser, vp, seed, url, 'library');
  const chip = await f.page.locator('#fColl .chip[data-v="copied"]').textContent();
  record(n, 'Tracks: Library "Copied" chip counts albums with a copied track', /Copied\s*2$/.test(chip.trim()), chip);
  await f.page.locator('#fColl .chip[data-v="copied"]').click();
  const lib = await f.page.evaluate(() => [...document.querySelectorAll('#libBody tr.row')].map(r => r.querySelector('.t').textContent + '|' + (r.querySelector('.trk-tag') || {}).textContent));
  record(n, 'Tracks: the Copied filter shows only those albums, each with its "x/y copied" tag', JSON.stringify(lib) === JSON.stringify(['Test Album 001 LP|2/5 copied', 'Test Album 002 LP|2/2 copied']), JSON.stringify(lib));
  const lo = await f.page.evaluate(overflow);
  record(n, 'Tracks: no sideways scroll in the filtered Library', lo.sw <= lo.iw, JSON.stringify(lo));
  await f.page.locator('#tab-dashboard').click();
  await f.page.waitForTimeout(200);
  const tile = await f.page.evaluate(() => { const t = document.querySelector('#dashTiles [data-tile="copied"]'); return t ? { eb: t.querySelector('.eyebrow').textContent, num: t.querySelector('.num').textContent, sub: t.querySelector('.sub').textContent } : null; });
  record(n, 'Tracks: Dashboard tile "Copied to MP3" shows 4 tracks and 1 album complete', tile && tile.eb === 'Copied to MP3' && tile.num === '4' && tile.sub === '1 album complete', JSON.stringify(tile));
  // Album edit dialog and Log row entry points
  await f.page.locator('#tab-library').click();
  await f.page.locator('#libBody tr.row[data-id="1001"]').click();
  await f.page.locator('#libBody tr.detail [data-edit]').click();
  await f.page.locator('#dlgTracks').click();
  await f.page.waitForFunction(() => document.getElementById('tracksDlg').open && !document.getElementById('albumDlg').open);
  record(n, 'Tracks: the album edit dialog has a Tracks button that opens the tracks', (await f.page.locator('#trkTitle').textContent()) === 'Test Album 001 LP');
  await closeTracks(f.page);
  record(n, 'Tracks: nothing was written by just looking', (await f.page.evaluate(() => window.__writes.length)) === 0);
  record(n, 'Tracks: Library and Dashboard cause no console errors', f.problems.length === 0, f.problems.slice(0, 2).join(' | '));
  await f.context.close();

  // Missing tab: a friendly notice, nothing else breaks
  const noTrk = { ...seed }; delete noTrk[TRK_TAB];
  const m = await freshPage(browser, vp, noTrk, url, 'library');
  await openTracksFromLibrary(m.page, '1001');
  const mt = await m.page.locator('#trkList').textContent();
  record(n, 'Tracks: with no 🎸 Tracks tab the dialog says so and hides the forms', /Tracks tab wasn't found/.test(mt) && await m.page.locator('#trkAdd').isHidden(), mt.slice(0, 80));
  await closeTracks(m.page);
  await m.page.locator('#tab-dashboard').click();
  const mtile = await m.page.locator('#dashTiles [data-tile="copied"] .num').textContent();
  record(n, 'Tracks: with no 🎸 Tracks tab the rest of the app still works (Dashboard tile shows 0)', mtile === '0' && (await m.page.locator('#statusText').textContent()).startsWith('Live') && m.problems.length === 0, m.problems.slice(0, 2).join(' | '));
  await m.context.close();
}

// ---------- runner ----------
const results = [];
const record = (vp, name, ok, detail = '') => {
  results.push({ vp, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` (${detail})` : ''}`);
};

// Chart.js is fetched from cdnjs by the real page. The test has no network, so that one URL is served from
// node_modules/chart.js when it is installed (blockChart: true refuses it, to prove the page works without it).
const CHART_URL = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
const CHART_LOCAL = join(here, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const HAVE_CHART = existsSync(CHART_LOCAL);

async function openContext(browser, vp, seed, { blockChart = false } = {}) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  let externalBlocked = 0;
  await context.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (u === CHART_URL && HAVE_CHART && !blockChart) return route.fulfill({ path: CHART_LOCAL, contentType: 'application/javascript' });
    externalBlocked++;               // no network in the test: other CDN scripts and fonts are refused
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
  return { context, page, problems, blocked: () => externalBlocked };
}

async function runViewport(browser, vp, seed, wrapperUrl, rawUrl) {
  console.log(`\n[${vp.name} ${vp.width}x${vp.height}]`);
  const { context, page, problems, blocked } = await openContext(browser, vp, seed);
  const externalBlocked = blocked();

  await page.goto(wrapperUrl);
  await page.waitForLoadState('load');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(300);

  const load = await page.evaluate(overflow);
  record(vp.name, 'page loads without console errors or uncaught exceptions', problems.length === 0,
    problems.length ? problems.slice(0, 3).join(' | ') : `${blocked()} external request(s) refused${HAVE_CHART ? ', Chart.js served locally' : ', no local Chart.js'}`);
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

  await dashTests(page, vp, seed);
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

  await dashEmptyLogTest(browser, vp, seed, wrapperUrl);
  await dashNoChartTest(browser, vp, seed, wrapperUrl);
  await connectTest(browser, vp, seed, rawUrl);
  await toolsTests(browser, vp, seed, wrapperUrl);
  await goalTests(browser, vp, seed, wrapperUrl);
  await discoverTests(browser, vp, seed, wrapperUrl);
  await tracksTests(browser, vp, seed, wrapperUrl);
}

async function main() {
  if (!existsSync(APP)) {
    console.error(`FAIL: app page not found at ${APP} (set APP_HTML to test another page)`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'sg-smoke-'));
  const wrapperPath = join(tmp, 'app-under-test.html');
  // Simulate the private artifact build (tools/build-artifact.py) with a fake sheet id.
  const appSrc = readFileSync(APP, 'utf8');
  if (!appSrc.includes("const BUILT_SHEET_ID = '';")) { console.error('FAIL  app.html must ship with an empty BUILT_SHEET_ID'); process.exit(1); }
  writeFileSync(wrapperPath, wrap(appSrc.replace("const BUILT_SHEET_ID = '';", "const BUILT_SHEET_ID = 'TEST_SHEET_ID_0123456789abcdefghijklmnop';")), 'utf8');

  // The app exactly as committed (empty BUILT_SHEET_ID), for the "Connect your Google Sheet" test
  const rawPath = join(tmp, 'app-raw.html');
  writeFileSync(rawPath, wrap(appSrc), 'utf8');

  const browser = await chromium.launch({
    // Playwright's bundled build is not installed here; fall back to the provided Chromium.
    executablePath: process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
    args: ['--no-sandbox'],          // container runs as root
  });
  try {
    const seed = buildSeed();
    for (const vp of VIEWPORTS) {
      await runViewport(browser, vp, seed, pathToFileURL(wrapperPath).href, pathToFileURL(rawPath).href);
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
