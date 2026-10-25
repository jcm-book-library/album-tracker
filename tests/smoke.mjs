// Smoke test for app.html (Music Collection).
// Loads the page in headless Chromium at laptop and phone widths, with a stubbed
// window.claude.use('mcp') backed by an in-memory copy of the 🎸 sheet tabs.
//
// Usage:  npm test            (from tests/)
// Env:    APP_HTML=/path/to/page.html   test a different page (used for harness checks)
//         SMOKE_ONLY=name1,name2        run only these suites (home, collection, relabel, pick, menu, dnd, log, tools, ...)
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
// One "now" for the whole run. Seed data is dated from it, and every test page's clock starts at it,
// so a run that crosses midnight can't see two different "todays".
const RUN_START = process.env.RUN_START ? new Date(process.env.RUN_START) : new Date();

function isoDay(offsetDays) {
  const d = new Date(RUN_START);
  d.setDate(d.getDate() - offsetDays);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const S4 = { onDay: [], quiet: '', stale: '', release: 'Test Album 060 LP' };
// Sheet columns of 🎸: D Status, F Format, Q Favourite, R Labelled (only in the second seed variant)
const COLS = { rating: 1, status: 3, format: 5, release: 6, year: 7, id: 9, fav: 16, labelled: 17 };
const S5 = { fav: [], nope: [], soon: [] };   // what buildSeed added for the shelves, by title
function buildSeed({ labelled = false } = {}) {
  const albums = FIXTURE.values.map(r => [...r]);   // a copy: FIXTURE itself stays the fixed reference. [header, ...rows]; id is column J (index 9)
  // New columns after the fixture's A:O. P (Buy link) is added inside the page, so it is left blank here.
  albums[0].push('', 'Favourite');
  if (labelled) albums[0].push('Labelled');
  for (const r of albums.slice(1)) while (r.length < albums[0].length) r.push('');
  {
    const rows = albums.slice(1), title = t => rows.find(r => r[0] === t);
    // Didn't like: four Listened albums with middling ratings (not rows other tests rely on)
    S5.nope = ['Test Album 092 LP', 'Test Album 087 LP', 'Test Album 095 LP', 'Test Album 102 LP'];
    S5.nope.forEach(t => { title(t)[COLS.status] = "Didn't like"; });
    // Coming Soon: the fixture's one (year only) plus two more, so the Upcoming shelf has dated and undated albums.
    // They come from the end of the unrated Listen list so the first ones (Plan sample data) are untouched.
    const listen = rows.filter(r => r[COLS.status] === 'Listen' && !r[COLS.rating]);
    const [a, b, c] = listen.slice(-3);
    a[COLS.status] = 'Coming Soon'; a[COLS.release] = isoDay(-12);
    b[COLS.status] = 'Coming Soon'; b[COLS.release] = isoDay(-40);
    c[COLS.status] = 'Coming Soon'; c[COLS.year] = '2027';
    S5.soon = [a[0], b[0], c[0], title('Test Album 123 LP')[0]];
    // Favourites: four dates on albums with four different labels (Heard, Owned, Vinyl wish list, To hear)
    const wish = rows.find(r => r[COLS.status] === 'Purchase' && r[COLS.format] === 'Vinyl (Wanted)');
    const hear = listen[listen.length - 8];
    const favs = [[title('Test Album 125 LP'), isoDay(30)], [title('Test Album 044 LP'), isoDay(5)], [wish, isoDay(60)], [hear, isoDay(12)]];
    favs.forEach(([r, d]) => { r[COLS.fav] = d; });
    S5.fav = favs.map(([r, d]) => ({ title: r[0], date: d }));
  }
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
  const now = new Date(RUN_START), p2 = n => String(n).padStart(2, '0'), md = `${p2(now.getMonth() + 1)}-${p2(now.getDate())}`, Y = now.getFullYear();
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
  await page.screenshot({ path: join(OUT, `${n}-plan-after.png`), fullPage: true });
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
  const nowYear = String(new Date(RUN_START).getFullYear());
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
  await page.screenshot({ path: join(OUT, `${n}-dashboard-log.png`), fullPage: true });
}

// Same page, but the stub's 🎸 Log has only its header
async function dashEmptyLogTest(browser, vp, seed, url) {
  const n = vp.name;
  const empty = { ...seed, '🎸 Log': [seed['🎸 Log'][0]] };
  const { context, page, problems } = await openContext(browser, vp, empty, { showLog: true });
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
  const { context, page, problems } = await openContext(browser, vp, seed, { blockChart: true, showLog: true });
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
const FIVE = ['Home', 'Collection', 'Plan', 'Dashboard', 'Tools'];
const SIX = ['Home', 'Collection', 'Log', 'Plan', 'Dashboard', 'Tools'];   // with the listening log switched on

// A fresh page on the live stub, already on the given tab
async function freshPage(browser, vp, seed, url, tab, { clockTo, reducedMotion, showLog, touch } = {}) {
  const ctx = await openContext(browser, vp, seed, { reducedMotion, showLog, touch });
  if (clockTo) await ctx.context.clock.setFixedTime(clockTo);
  await ctx.page.goto(url);
  await ctx.page.waitForLoadState('load');
  await ctx.page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
  await ctx.page.locator(`#tab-${tab}`).click();
  await ctx.page.waitForTimeout(200);
  return ctx;
}

// ---------- Layout (symmetry) ----------
async function layoutTests(browser, vp, seed, url) {
  const n = vp.name, laptop = vp.width >= 1000;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'log', { showLog: true });
  await page.evaluate(() => { window.__writes.length = 0; });
  for (const t of ['home', 'collection', 'log', 'plan', 'dashboard', 'tools']) {
    await page.locator(`#tab-${t}`).click();
    await page.waitForTimeout(250);
    const o = await page.evaluate(overflow);
    record(n, `Layout: no sideways scroll on ${t}`, o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  }
  if (laptop) {
    await page.locator('#tab-log').click();
    await page.waitForTimeout(200);
    const g = await page.evaluate(() => {
      const r = id => document.querySelector(id).getBoundingClientRect();
      const [a, b, c, d] = ['.p-log', '.p-rot', '.p-recent', '.p-first'].map(r);
      return { wTop: [a.width, b.width], wBot: [c.width, d.width], h1: [a.height, b.height], h2: [c.height, d.height], leftDiff: Math.abs(a.left - c.left), rightDiff: Math.abs(b.left - d.left) };
    });
    record(n, 'Layout: Log has two equal columns', Math.abs(g.wTop[0] - g.wTop[1]) <= 2 && Math.abs(g.wBot[0] - g.wBot[1]) <= 2 && Math.abs(g.wTop[0] - g.wBot[0]) <= 2, JSON.stringify(g));
    record(n, 'Layout: Log row 1 panels have equal heights', Math.abs(g.h1[0] - g.h1[1]) <= 2, g.h1.join(' vs '));
    record(n, 'Layout: Log row 2 panels have equal heights', Math.abs(g.h2[0] - g.h2[1]) <= 2, g.h2.join(' vs '));
    // Plan and Tools pairs
    const pairs = async (tab, sels) => {
      await page.locator(`#tab-${tab}`).click(); await page.waitForTimeout(200);
      return page.evaluate(sels => sels.map(([x, y]) => { const a = document.querySelector(x).getBoundingClientRect(), b = document.querySelector(y).getBoundingClientRect(); return Math.abs(a.height - b.height) <= 2 && Math.abs(a.top - b.top) <= 2; }), sels);
    };
    const pp = await pairs('plan', [['.p-up', '.p-soon'], ['.p-deck', '.p-wish']]);
    record(n, 'Layout: Plan panel pairs share a row and a height', pp.every(Boolean), pp.join());
    const tp = await pairs('tools', [['#dipH', '#ownH'], ['#nudH', '#goalH']].map(([x, y]) => [x + ' ', y + ' ']).map(([x, y]) => [`section:has(${x.trim()})`, `section:has(${y.trim()})`]));
    record(n, 'Layout: Tools panel pairs share a row and a height', tp.every(Boolean), tp.join());
    // Dashboard tiles: every row full, or the last tile spans the row
    await page.locator('#tab-dashboard').click(); await page.waitForTimeout(250);
    const tiles = await page.evaluate(() => {
      const els = [...document.querySelectorAll('#dashTiles .stat')], box = document.getElementById('dashTiles').getBoundingClientRect();
      const rows = new Map();
      for (const e of els) { const r = e.getBoundingClientRect(); const k = Math.round(r.top); (rows.get(k) || rows.set(k, []).get(k)).push(r); }
      return [...rows.values()].map(rs => ({ count: rs.length, covers: Math.abs(rs[0].left - box.left) <= 2 && Math.abs(rs[rs.length - 1].right - box.right) <= 2 }));
    });
    const full = tiles.every(r => r.covers && r.count === tiles[0].count);
    record(n, 'Layout: Dashboard tiles fill complete rows (no orphan)', tiles.length > 1 && (full || tiles.every(r => r.covers)), JSON.stringify(tiles));
    const dp = await page.evaluate(() => [...document.querySelectorAll('#view-dashboard .dash-2 > .panel:not(.full)')].reduce((acc, p, i, all) => { if (i % 2 === 0 && all[i + 1]) { const a = p.getBoundingClientRect(), b = all[i + 1].getBoundingClientRect(); acc.push(Math.abs(a.height - b.height) <= 2); } return acc; }, []));
    record(n, 'Layout: Dashboard panel pairs have equal heights', dp.length > 0 && dp.every(Boolean), dp.join());
  } else {
    await page.locator('#tab-dashboard').click(); await page.waitForTimeout(250);
    const last = await page.evaluate(() => { const els = [...document.querySelectorAll('#dashTiles .stat')], b = document.getElementById('dashTiles').getBoundingClientRect(), r = els[els.length - 1].getBoundingClientRect(); return { n: els.length, spans: r.width >= b.width - 2 }; });
    record(n, 'Layout: phone Dashboard ninth tile spans both columns', last.n % 2 === 0 || last.spans, JSON.stringify(last));
  }
  // Show all expands Recent entries in place
  await page.locator('#tab-log').click(); await page.waitForTimeout(150);
  const before = await page.locator('#recentList > li:not(.empty)').count();
  const total = await page.evaluate(() => state.log.length);
  record(n, 'Layout: Recent entries starts capped at 6', before === 6 && total > 6, `${before} shown of ${total}`);
  await page.locator('#recMore').click();
  const after = await page.locator('#recentList > li:not(.empty)').count();
  record(n, 'Layout: Show all expands Recent entries to every entry', after === Math.min(15, total), `${after} shown of ${total}`);
  await page.locator('#recMore').click();
  record(n, 'Layout: Show fewer collapses Recent entries again', (await page.locator('#recentList > li:not(.empty)').count()) === 6);
  const writes = await page.evaluate(() => window.__writes.length);
  record(n, 'Layout: browsing the tabs and Show all cause no sheet writes', writes === 0, `${writes} writes`);
  record(n, 'Layout: no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();
}

async function toolsTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'tools', { showLog: true });

  // Six pills with the log on, in order, all reachable; the bar scrolls inside itself rather than the page
  const labels = await page.locator('nav.tabs .tab:visible').allTextContents();
  record(n, 'Tabs: with the log on, six pills in order Home, Collection, Log, Plan, Dashboard, Tools', labels.join() === SIX.join(), labels.join());
  await page.locator('#tab-tools').click();
  const reach = await page.evaluate(() => { const nav = document.querySelector('nav.tabs').getBoundingClientRect(), b = document.getElementById('tab-tools').getBoundingClientRect(); return { inside: b.left >= nav.left - 1 && b.right <= nav.right + 1, sw: document.documentElement.scrollWidth, iw: innerWidth }; });
  record(n, 'Tabs: the last pill is brought into view and the page does not scroll sideways', reach.inside && reach.sw <= reach.iw, JSON.stringify(reach));
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
  const card = await page.evaluate(() => { const c = document.getElementById('dipCard'); return { h3: c.querySelector('h3') && c.querySelector('h3').textContent, meta: c.querySelector('.m').textContent, btns: [...c.querySelectorAll('button')].map(b => b.textContent) }; });
  const cardRow = fxByTitle(card.h3) || [];   // some fixture albums have no artist or year, so the card must show exactly what its row has
  record(n, 'Lucky dip: card shows artist/year and has Another, Log a listen today and Up next', !!card.h3 && (!cardRow[COL.artist] || card.meta.includes(cardRow[COL.artist])) && (!cardRow[COL.year] || card.meta.includes(cardRow[COL.year])) && /^Another,Log a listen today,(On )?Up next$/.test(card.btns.join()), JSON.stringify(card));
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
  const Y = String(new Date(RUN_START).getFullYear());
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
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'tools', { showLog: true });
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
  const b = await freshPage(browser, vp, noKey, url, 'tools', { showLog: true });
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
  const c = await freshPage(browser, vp, dup, url, 'tools', { showLog: true });
  await c.page.evaluate(() => { window.__writes.length = 0; });
  await c.page.locator('#goalOut button', { hasText: 'Change goal' }).click();
  await c.page.locator('#goalIn').fill('70');
  await c.page.locator('#goalOut button', { hasText: 'Save goal' }).click();
  await c.page.waitForFunction(() => /appears 2 times/.test(document.getElementById('goalOut').textContent), null, { timeout: 8000 });
  record(n, 'Goal planner: a key that appears twice is refused and nothing is written', (await c.page.evaluate(() => window.__writes.length)) === 0);
  await c.context.close();
}

async function homeTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'home', { showLog: true });
  let o = await page.evaluate(overflow);
  record(n, 'Home: renders with no sideways scroll', o.sw <= o.iw && (await page.locator('#view-home').isVisible()), `scrollWidth ${o.sw} vs ${o.iw}`);
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
    await page.locator('#tab-home').click();
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
  const Y = new Date(RUN_START).getFullYear();
  const an = await page.evaluate(() => [...document.querySelectorAll('#annivBox .mile-head')].map(h => ({ m: h.dataset.milestone, text: h.textContent, items: h.nextElementSibling.querySelectorAll('li').length })));
  const wantAn = [10, 20, 25, 30, 40, 50, 60].map(m => ({ m: String(m), n: fxRows().filter(r => parseFloat(r[COL.year]) === Y - m).length })).filter(x => x.n);
  record(n, 'Anniversaries: one group per milestone that has albums, in order, with the right counts', JSON.stringify(an.map(a => [a.m, Math.min(a.items, 99)])) === JSON.stringify(wantAn.map(a => [a.m, Math.min(a.n, 6)])) && an.every((a, i) => a.text.includes(`released ${Y - Number(a.m)}`) && a.text.includes(`${wantAn[i].n} album`)), JSON.stringify(an));
  // Upcoming: the Coming Soon albums, soonest first, each with a countdown (real future date) or its year
  const upcoming = await page.evaluate(() => [...document.querySelectorAll('#upcomingList > li:not(.empty)')].map(li => li.textContent));
  const todayIso0 = await page.evaluate(() => today());
  const wantSoon = fxSeedRows(seed).filter(r => labelFor(r) === 'upcoming')
    // Order: real future dates first (soonest first), then year-only for this year or later, then years already past, then nothing
    .map(r => ({ r, key: r[COLS.release] >= todayIso0 ? `0 ${r[COLS.release]}` : !r[COLS.year] ? '3' : Number(r[COLS.year]) >= Number(todayIso0.slice(0, 4)) ? `1 ${r[COLS.year]}` : `2 ${r[COLS.year]}` }))
    .sort((x, y) => x.key.localeCompare(y.key) || x.r[0].localeCompare(y.r[0]));
  const wantText = ({ r }) => r[COLS.release] >= todayIso0 ? `in ${Math.round((new Date(r[COLS.release] + 'T00:00:00') - new Date(todayIso0 + 'T00:00:00')) / 864e5)} days` : r[COLS.year];
  record(n, 'Upcoming: lists the Coming Soon albums soonest first, each with a countdown or its year', wantSoon.length === 4 && upcoming.length === wantSoon.length && wantSoon.every((x, i) => upcoming[i].includes(x.r[0]) && upcoming[i].endsWith(wantText(x))), upcoming.join(' | '));
  record(n, 'Upcoming: a release date 12 days away reads "in 12 days"', upcoming.some(t => t.includes(S5.soon[0]) && t.endsWith('in 12 days')), upcoming.join(' | '));
  // Empty states
  const empty = { ...seed, '🎸 Log': [seed['🎸 Log'][0]] };
  o = await page.evaluate(overflow);
  record(n, 'Home: no sideways scroll after interactions', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  record(n, 'Home: no console errors or uncaught exceptions', problems.length === 0, problems.slice(0, 2).join(' | '));
  await page.screenshot({ path: join(OUT, `${n}-home-log.png`), fullPage: true });
  await context.close();

  // Next day: a different album, and "Yesterday's" now names today's pick
  const t0 = new Date(RUN_START);
  const next = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + 1, 12, 0, 0);
  const d2 = await freshPage(browser, vp, seed, url, 'home', { clockTo: next });
  const pick2 = await d2.page.locator('#aotdBox h3').textContent();
  const yest2 = await d2.page.locator('#aotdBox .yest').textContent();
  record(n, 'Album of the day: tomorrow gives a different album from the pool', pool.includes(pick2) && pick2 !== pick1 && pool.length >= 2, `${pick1} -> ${pick2}`);
  record(n, 'Album of the day: tomorrow\'s "Yesterday\'s" line is today\'s pick', yest2.includes(pick1), yest2);
  await d2.context.close();

  // No albums rated high enough: friendly empty state, no errors
  const lowSeed = { ...seed, '🎸': seed['🎸'].map((r, i) => (i === 0 ? r : [...r.slice(0, 1), r[1] && parseFloat(r[1]) >= 8 ? '5' : r[1], ...r.slice(2)])) };
  const e = await freshPage(browser, vp, lowSeed, url, 'home');
  const et = await e.page.locator('#aotdBox').textContent();
  record(n, 'Album of the day: with nothing rated 8+ it explains what to do', /No albums rated 8 or higher yet/.test(et) && e.problems.length === 0, et.slice(0, 100));
  await e.context.close();
  // Empty log: On this day empty state and Year in review empty state
  const f = await freshPage(browser, vp, empty, url, 'home', { showLog: true });
  const ft = await f.page.locator('#onDayList').textContent();
  record(n, 'On this day: with no log and no release dates matching it says so', /Nothing on this date/.test(ft) || /was released/.test(ft), ft.slice(0, 120));
  await f.page.locator('#tab-tools').click();
  const yt = await f.page.locator('#yirBox').textContent();
  record(n, 'Year in review: an empty log gives a friendly empty state', /No listens logged yet/.test(yt), yt.slice(0, 100));
  record(n, 'Tools and Home: nothing throws with an empty log', f.problems.length === 0, f.problems.slice(0, 2).join(' | '));
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
const toTable = async page => { await page.locator('#tab-collection').click(); await page.locator('#colView button[data-v="table"]').click(); };
async function openTracksFromLibrary(page, id) {
  await toTable(page);
  if (!(await page.locator(`#libBody tr.row.open[data-id="${id}"]`).count())) await page.locator(`#libBody tr.row[data-id="${id}"]`).click();
  await page.locator('#libBody tr.detail [data-tracks]').click();
  await page.waitForFunction(() => document.getElementById('tracksDlg').open);
  await page.waitForTimeout(150);
}
async function closeTracks(page) { await page.locator('#trkClose').click(); await page.waitForFunction(() => !document.getElementById('tracksDlg').open); }

async function tracksTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
  await toTable(page);
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
  const f = await freshPage(browser, vp, seed, url, 'collection');
  await toTable(f.page);
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
  await toTable(f.page);
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
  const m = await freshPage(browser, vp, noTrk, url, 'collection');
  await openTracksFromLibrary(m.page, '1001');
  const mt = await m.page.locator('#trkList').textContent();
  record(n, 'Tracks: with no 🎸 Tracks tab the dialog says so and hides the forms', /Tracks tab wasn't found/.test(mt) && await m.page.locator('#trkAdd').isHidden(), mt.slice(0, 80));
  await closeTracks(m.page);
  await m.page.locator('#tab-dashboard').click();
  const mtile = await m.page.locator('#dashTiles [data-tile="copied"] .num').textContent();
  record(n, 'Tracks: with no 🎸 Tracks tab the rest of the app still works (Dashboard tile shows 0)', mtile === '0' && (await m.page.locator('#statusText').textContent()).startsWith('Live') && m.problems.length === 0, m.problems.slice(0, 2).join(' | '));
  await m.context.close();
}

// ---------- Music Collection: name, pressings, Look panel ----------
const PRESS_HEX = { emerald: '#3bd1a0', canary: '#f4cf2d', midnight: '#5aa3f5', tangerine: '#ff8a2a', magenta: '#e056dc', crimson: '#ff4357' };
const hexToRgb = h => `rgb(${[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;
const MARK_ANIMS = () => document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.id === 'headMark').length;

// What the page should show on the run's day (the page clock starts at RUN_START, like the seed data)
const PRESS_BY_MONTH = ['emerald', 'emerald', 'canary', 'canary', 'midnight', 'midnight', 'tangerine', 'tangerine', 'magenta', 'magenta', 'crimson', 'crimson'];
const PRESS_NAME = { emerald: 'Emerald', canary: 'Canary', midnight: 'Midnight blue', tangerine: 'Tangerine', magenta: 'Magenta', crimson: 'Crimson' };
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function lookTests(browser, vp, seed, url) {
  const n = vp.name;
  const AUTO = PRESS_BY_MONTH[RUN_START.getMonth()], ALT = AUTO === 'crimson' ? 'canary' : 'crimson';
  const EYEBROW = `${WEEKDAYS[RUN_START.getDay()]} ${RUN_START.getDate()} ${MON3[RUN_START.getMonth()]} ${String(RUN_START.getFullYear()).slice(2)}`;
  // Name
  let f = await freshPage(browser, vp, seed, url, 'home', {});
  const title = await f.page.title();
  const h1 = await f.page.locator('h1').textContent();
  const visible = await f.page.evaluate(() => document.body.innerText);
  record(n, 'Name: the title and header say "Music Collection"', title === 'Music Collection' && h1.trim() === 'Music Collection', `${title} | ${h1}`);
  record(n, 'Name: the old name appears nowhere in the visible text', !/sleeves|grooves/i.test(visible));
  const eyebrow = (await f.page.locator('#todayLabel').textContent()).trim();
  record(n, `Pressing: the header eyebrow reads "${EYEBROW} · ${PRESS_NAME[AUTO]} pressing" (no season)`, eyebrow === `${EYEBROW} · ${PRESS_NAME[AUTO]} pressing`, eyebrow);
  record(n, 'Pressing: the header has the record mark and the marble ground sits behind the page', await f.page.evaluate(() => !!document.querySelector('header svg#headMark use') && getComputedStyle(document.querySelector('.ground')).position === 'fixed' && getComputedStyle(document.querySelector('.wrap')).zIndex === '1'));
  record(n, 'Pressing: the page is dark only', await f.page.evaluate(() => getComputedStyle(document.documentElement).colorScheme === 'dark'));
  // Active tab pill follows the pressing
  const pill = await f.page.evaluate(() => getComputedStyle(document.querySelector('.tab[aria-selected="true"]')).backgroundColor);
  record(n, `Pressing: the active tab pill is the pressing colour (${AUTO})`, pill === hexToRgb(PRESS_HEX[AUTO]), pill);
  await f.context.close();

  // Pressing by month, with no drift inside a pressing
  for (const [d, want] of [['2026-01-02', 'emerald'], ['2026-03-05', 'canary'], ['2026-10-01', 'magenta'], ['2026-10-31', 'magenta'], ['2026-12-15', 'crimson']]) {
    const m = await freshPage(browser, vp, seed, url, 'home', { clockTo: `${d}T12:00:00` });
    const got = await m.page.evaluate(() => document.documentElement.dataset.p);
    const tab = await m.page.evaluate(() => getComputedStyle(document.querySelector('.tab[aria-selected="true"]')).backgroundColor);
    record(n, `Pressing: ${d} is ${want}`, got === want && tab === hexToRgb(PRESS_HEX[want]), `${got}, tab ${tab}`);
    await m.context.close();
  }

  // Look panel
  const l = await freshPage(browser, vp, seed, url, 'tools', { showLog: true });
  const page = l.page;
  const dp = () => page.evaluate(() => document.documentElement.dataset.p);
  record(n, 'Look: the panel is at the bottom of Tools with "This month (auto)" selected', await page.evaluate(() => {
    const secs = [...document.querySelectorAll('#view-tools section.panel')]; const last = secs[secs.length - 1];
    return last.querySelector('h2').textContent === 'Look' && document.getElementById('lookPressing').selectedOptions[0].textContent === 'This month (auto)';
  }));
  await page.selectOption('#lookPressing', ALT);
  record(n, `Look: choosing ${PRESS_NAME[ALT]} sets data-p ${ALT}`, (await dp()) === ALT);
  record(n, 'Look: the header eyebrow follows the chosen pressing', (await page.locator('#todayLabel').textContent()).trim().endsWith(`${PRESS_NAME[ALT]} pressing`));
  record(n, 'Look: the choice is stored in sg-pressing', (await page.evaluate(() => localStorage.getItem('sg-pressing'))) === ALT);
  await page.reload(); await page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
  record(n, `Look: ${PRESS_NAME[ALT]} persists after reload`, (await dp()) === ALT && (await page.locator('#lookPressing').inputValue()) === ALT);
  // Charts, heatmap and the pill read the pressing
  await page.locator('#tab-dashboard').click(); await page.waitForTimeout(250);
  const dashCol = await page.evaluate(() => {
    const ch = window.Chart && Chart.getChart(document.getElementById('monthChart'));
    const cell = document.querySelector('#heat i.c[data-d]');
    return { bar: ch ? ch.data.datasets[0].backgroundColor[0] : null, heat: cell ? getComputedStyle(cell).backgroundColor : null,
      pill: getComputedStyle(document.querySelector('.tab[aria-selected="true"]')).backgroundColor };
  });
  record(n, 'Look: Dashboard bars and the pill use the pressing colour', dashCol.pill === hexToRgb(PRESS_HEX[ALT]) && (!HAVE_CHART || (dashCol.bar || '').startsWith(PRESS_HEX[ALT])), JSON.stringify(dashCol));
  record(n, 'Look: the Dashboard heatmap cells are tinted from the pressing', !!dashCol.heat && /^rgb/.test(dashCol.heat), dashCol.heat);
  await page.locator('#tab-tools').click();
  await page.selectOption('#lookPressing', 'auto');
  record(n, `Look: "This month (auto)" returns to the month's pressing (${AUTO})`, (await dp()) === AUTO && (await page.evaluate(() => localStorage.getItem('sg-pressing'))) === null);
  // Plain dark
  const discShown = () => page.evaluate(() => getComputedStyle(document.querySelector('.disc')).display !== 'none');
  record(n, 'Look: the marble record is shown by default', await discShown());
  await page.selectOption('#lookBg', 'plain');
  record(n, 'Look: Plain dark hides the disc', !(await discShown()) && (await page.evaluate(() => localStorage.getItem('sg-bg'))) === 'plain');
  await page.reload(); await page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
  record(n, 'Look: Plain dark persists after reload', !(await discShown()) && (await page.locator('#lookBg').inputValue()) === 'plain');
  await page.selectOption('#lookBg', 'marble');
  record(n, 'Look: Marble record brings the disc back', await discShown());
  // Every tab, crimson + plain: no sideways scroll
  await page.selectOption('#lookPressing', ALT); await page.selectOption('#lookBg', 'plain');
  const bad = [];
  for (const t of ['home', 'collection', 'plan', 'dashboard', 'tools']) {
    await page.locator(`#tab-${t}`).click(); await page.waitForTimeout(150);
    const o = await page.evaluate(overflow); if (o.sw > o.iw) bad.push(`${t} ${o.sw}>${o.iw}`);
  }
  record(n, `Look: no sideways scroll on any tab with ${PRESS_NAME[ALT]} and Plain dark`, bad.length === 0, bad.join(', '));
  record(n, 'Look: changing the look writes nothing to the sheet', (await page.evaluate(() => window.__writes.length)) === 0);
  record(n, 'Look: no console errors', l.problems.length === 0, l.problems.slice(0, 2).join(' | '));
  await l.context.close();

  // Header mark spins once after Refresh (not with reduced motion)
  for (const reduce of [false, true]) {
    const r = await freshPage(browser, vp, seed, url, 'home', reduce ? { reducedMotion: 'reduce' } : {});
    await r.page.locator('#refreshBtn').click();
    await r.page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live') && !document.getElementById('refreshBtn').disabled);
    const anims = await r.page.evaluate(MARK_ANIMS);
    record(n, reduce ? 'Motion: with reduced motion the header mark has no running animation after Refresh' : 'Motion: the header mark spins after Refresh', reduce ? anims === 0 : anims === 1, `${anims} animation(s)`);
    await r.context.close();
  }
}

// ---------- Music Collection: shelves, labels, favourites, Home ----------
const fxSeedRows = seed => seed['🎸'].slice(1);
// The label rules, written out here separately from the app. The first rule that matches wins; nothing left over means To hear.
const LABEL_RULES = [
  ['nope', r => r[COLS.status] === "Didn't like"],
  ['owned', r => r[COLS.status] === 'Owned' || r[COLS.format] === 'Vinyl (Owned)'],
  ['wish', r => r[COLS.status] === 'Purchase' || r[COLS.format] === 'Vinyl (Wanted)'],
  ['upcoming', r => r[COLS.status] === 'Coming Soon'],
  ['hear', r => r[COLS.status] === 'Listen'],
  ['heard', r => r[COLS.status] === 'Listened' || Number(r[COLS.rating]) > 0],
];
const labelFor = r => (LABEL_RULES.find(([, ok]) => ok(r)) || ['hear'])[0];
const LABEL_NAME = { owned: 'Owned', wish: 'Vinyl wish list', upcoming: 'Upcoming', hear: 'To hear', heard: 'Heard', nope: "Didn't like" };
const SHELF_ORDER = ['fav', 'owned', 'wish', 'upcoming', 'hear', 'heard', 'nope'];
const SHELF_HEAD = { fav: 'Favourites', ...LABEL_NAME };
const LOCK_MSG = 'Still owned on vinyl. Change Format in the album details first.';
function expectedShelves(seed) {
  const rows = fxSeedRows(seed), out = Object.fromEntries(SHELF_ORDER.map(k => [k, []]));
  for (const r of rows) out[labelFor(r)].push(r[COLS.id]);
  out.fav = rows.filter(r => r[COLS.fav]).sort((a, b) => b[COLS.fav].localeCompare(a[COLS.fav])).map(r => r[COLS.id]);   // newest first
  return out;
}
const isPW = r => r[COLS.status] === 'Purchase' && r[COLS.format] === 'Vinyl (Wanted)';

const gw = page => page.evaluate(() => window.__writes.map(w => ({ tool: w.tool, sheet: w.sheet, range: w.range, v: w.values && w.values[0] ? w.values[0][0] : undefined, n: w.values ? w.values.length * (w.values[0] || []).length : 0 })));
const cw = page => page.evaluate(() => { window.__writes.length = 0; });
const waitWrites = (page, k) => page.waitForFunction(c => window.__writes.length >= c, k, { timeout: 8000 });
const settle = page => page.waitForTimeout(250);
const shelfSel = k => `#shelves .shelf[data-key="${k}"]`;
async function expandShelf(page, key) {
  const b = page.locator(`${shelfSel(key)} [data-sa="all"]`);
  if (await b.count() && (await b.getAttribute('aria-expanded')) === 'false') await b.click();
}
const shelfIds = (page, key) => page.evaluate(k => [...document.querySelectorAll(`#shelves .shelf[data-key="${k}"] .s-it`)].map(e => e.dataset.id), key);
const shelfCounts = page => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#shelves .shelf')].map(s => [s.dataset.key, +s.querySelector('.sh-count').textContent])));
const cellOf = (page, id) => page.evaluate(i => { const r = window.__sheet['🎸'].find((x, k) => k > 0 && x[9] === i); return JSON.stringify(r); }, id);
const allOnTab = page => page.evaluate(() => window.__forbidden.length === 0 && window.__writes.every(w => w.sheet.startsWith('🎸')));
async function openChip(page, id, shelf) {
  await expandShelf(page, shelf);
  const chip = page.locator(`${shelfSel(shelf)} .s-it[data-id="${id}"] .s-chip`);
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await page.locator('.s-menu').waitFor();
}
async function relabelViaMenu(page, id, shelf, to) {
  await openChip(page, id, shelf);
  await page.locator(`.s-menu button[data-k="${to}"]`).click();
}
const toasts = page => page.locator('#toasts .toast').allTextContents();

// ----- Collection: shelves, search, detail strip, Table view
async function collectionTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
  await cw(page);
  const want = expectedShelves(seed);

  const heads = await page.locator('#shelves .shelf h2').allTextContents();
  record(n, 'Collection: shelves run Favourites, Owned, Vinyl wish list, Upcoming, To hear, Heard, Didn\'t like', heads.map(h => h.trim()).join('|') === SHELF_ORDER.map(k => SHELF_HEAD[k]).join('|'), heads.join('|'));
  const tb = await page.evaluate(() => ({ seg: [...document.querySelectorAll('#colView button')].map(b => b.textContent + ':' + b.getAttribute('aria-pressed')), add: !!document.getElementById('addAlbumBtn'), search: !!document.getElementById('libSearch') }));
  record(n, 'Collection: toolbar has a Shelves | Table switch (Shelves on), a search box and Add album', tb.seg.join() === 'Shelves:true,Table:false' && tb.add && tb.search, JSON.stringify(tb));

  // membership: counts, then the sleeves on each shelf after Show all
  const counts = await shelfCounts(page);
  record(n, 'Collection: all 7 shelf counts match the labels worked out from the sheet', SHELF_ORDER.every(k => counts[k] === want[k].length) && want.nope.length === 4 && want.fav.length === 4, JSON.stringify(counts));
  for (const k of SHELF_ORDER) {
    await expandShelf(page, k);
    const ids = await shelfIds(page, k);
    record(n, `Collection: the ${SHELF_HEAD[k]} shelf holds exactly the right albums (${ids.length})`, sortedJson(ids) === sortedJson(want[k]), `${ids.length} vs ${want[k].length}`);
  }
  const favIds = await shelfIds(page, 'fav');
  record(n, 'Collection: Favourites are ordered newest first', favIds.join() === want.fav.join(), `${favIds.join()} vs ${want.fav.join()}`);
  const favLabels = new Set(want.fav.map(id => labelFor(fxSeedRows(seed).find(r => r[COLS.id] === id))));
  let alsoOnLabel = true;
  for (const id of want.fav) { const lab = labelFor(fxSeedRows(seed).find(r => r[COLS.id] === id)); if (!(await shelfIds(page, lab)).includes(id)) alsoOnLabel = false; }
  record(n, 'Collection: a favourite sits on its label shelf AND on Favourites (four different labels)', alsoOnLabel && favLabels.size === 4, [...favLabels].join());
  const dragAttr = await page.evaluate(() => [...document.querySelectorAll('#shelves .s-it')].every(e => e.getAttribute('draggable') === 'true'));
  record(n, 'Collection: sleeves can be dragged (pointer: fine)', dragAttr);
  const cds = await page.evaluate(() => [...document.querySelectorAll('#shelves .shelf[data-key="upcoming"] .s-it')].map(e => e.querySelector('.s-cd') ? e.querySelector('.s-cd').textContent : ''));
  const sfx = vp.width < 560 ? ['in 12d', 'in 40d'] : ['in 12 days', 'in 40 days'];   // the chip is shortened on a phone
  record(n, 'Collection: Upcoming sleeves carry the countdown chip (in 12 days, in 40 days, or the year)', cds.includes(sfx[0]) && cds.includes(sfx[1]) && cds.includes('2027') && cds.every(Boolean), cds.join());
  const nStand = await page.evaluate(() => document.querySelectorAll('#shelves .shelf[data-key="heard"] .s-grid .s-it').length);
  record(n, 'Collection: "Show all" opens a wrapping grid in place, "Show fewer" closes it', nStand === want.heard.length && (await page.locator(`${shelfSel('heard')} [data-sa="all"]`).textContent()) === 'Show fewer', String(nStand));
  await page.locator(`${shelfSel('heard')} [data-sa="all"]`).click();
  record(n, 'Collection: after Show fewer the shelf is standing sleeves plus a packed stack', (await page.locator(`${shelfSel('heard')} .s-grid`).count()) === 0 && (await page.locator(`${shelfSel('heard')} .s-stack .s-it`).count()) > 0 && (await page.locator(`${shelfSel('heard')} .s-standing .s-it`).count()) === (vp.width < 560 ? 3 : 5));
  record(n, 'Collection: Show all / Show fewer write nothing', (await gw(page)).length === 0);

  // detail strip
  const buyAlbum = await page.evaluate(() => { const a = state.albums.find(x => x.buy && /^https:/.test(x.buy) && labelOf(x) === 'wish' && toNum(x.id)); return a ? { id: String(toNum(a.id)), title: a.title } : null; });
  await expandShelf(page, 'wish');
  await page.locator(`${shelfSel('wish')} .s-it[data-id="${buyAlbum.id}"] .s-art`).click();
  const d = await page.evaluate(() => { const e = document.querySelector('#shelves .s-detail'); return e ? { h3: e.querySelector('h3').textContent, btns: [...e.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean), buy: e.querySelector('a.s-buy') ? { t: e.querySelector('a.s-buy').textContent, href: e.querySelector('a.s-buy').href, target: e.querySelector('a.s-buy').target, rel: e.querySelector('a.s-buy').rel } : null, pressed: e.querySelector('.s-pickbtn').getAttribute('aria-pressed') } : null; });
  record(n, 'Collection: tapping a sleeve opens the detail strip with label chip, Favourite, Tracks, Edit and a Buy pill', !!d && d.h3 === buyAlbum.title && /^Vinyl wish list/.test(d.btns[0]) && d.btns.includes('Favourite') && d.btns.includes('Tracks') && d.btns.includes('Edit') && !!d.buy && /^Buy · /.test(d.buy.t) && d.buy.target === '_blank' && /noopener/.test(d.buy.rel), JSON.stringify(d));
  await page.locator('#shelves .s-detail [data-sa="tracks"]').click();
  await page.waitForFunction(() => document.getElementById('tracksDlg').open);
  record(n, 'Collection: the detail strip\'s Tracks button opens the tracks dialog for that album', (await page.locator('#trkTitle').textContent()) === buyAlbum.title);
  await page.locator('#trkClose').click(); await page.waitForFunction(() => !document.getElementById('tracksDlg').open);
  await page.locator('#shelves .s-detail [data-sa="edit"]').click();
  await page.waitForFunction(() => document.getElementById('albumDlg').open);
  record(n, 'Collection: the detail strip\'s Edit button opens the album dialog', (await page.locator('#dlgTitle').textContent()) === 'Edit album');
  const sel = await page.evaluate(() => [...document.getElementById('f-status').options].map(o => o.value));
  record(n, 'Album dialog: Status offers Didn\'t like', sel.includes("Didn't like") && sel.length === 7, sel.join());
  await page.locator('#dlgClose').click();
  await page.locator('#shelves .s-detail [data-sa="close"]').click();
  record(n, 'Collection: the detail strip closes', (await page.locator('#shelves .s-detail').count()) === 0);
  // a sleeve with no buy link has no Buy pill
  const plain = await page.evaluate(() => { const a = state.albums.find(x => !x.buy && labelOf(x) === 'heard' && toNum(x.id)); return String(toNum(a.id)); });
  await expandShelf(page, 'heard');
  await page.locator(`${shelfSel('heard')} .s-it[data-id="${plain}"] .s-art`).click();
  record(n, 'Collection: no Buy pill when the album has no buy link', (await page.locator('#shelves .s-detail').count()) === 1 && (await page.locator('#shelves .s-detail a.s-buy').count()) === 0);
  await page.locator('#shelves .s-detail [data-sa="close"]').click();

  // search filters shelves by title / artist / genre and hides shelves with no match
  const tq = 'Test Album 060';
  const rows = fxSeedRows(seed);
  const hit = rows.filter(r => [r[0], r[2], r[4]].some(v => String(v).toLowerCase().includes(tq.toLowerCase())));
  const wantKeys = SHELF_ORDER.filter(k => hit.some(r => (k === 'fav' ? !!r[COLS.fav] : labelFor(r) === k)));
  await page.locator('#libSearch').fill(tq);
  await page.waitForTimeout(350);
  const shown = await page.evaluate(() => [...document.querySelectorAll('#shelves .shelf')].map(s => s.dataset.key));
  record(n, 'Collection: searching shows only the shelves that have a match', shown.join() === wantKeys.join() && shown.length >= 1, `${shown.join()} vs ${wantKeys.join()}`);
  const artistQ = 'Test Artist 05';
  await page.locator('#libSearch').fill(artistQ); await page.waitForTimeout(350);
  const hitA = rows.filter(r => String(r[2]).toLowerCase().includes(artistQ.toLowerCase()));
  const shownA = await shelfCounts(page);
  record(n, 'Collection: search also matches the artist, and counts follow the matches', SHELF_ORDER.every(k => (shownA[k] || 0) === hitA.filter(r => (k === 'fav' ? !!r[COLS.fav] : labelFor(r) === k)).length), JSON.stringify(shownA));
  await page.locator('#libSearch').fill('zzzzqqq'); await page.waitForTimeout(350);
  record(n, 'Collection: a search with no match says so', (await page.locator('#shelves .shelf').count()) === 0 && /No albums match/.test(await page.locator('#shelves').textContent()));
  await page.locator('#libSearch').fill(''); await page.waitForTimeout(350);
  record(n, 'Collection: clearing the search brings every shelf back', (await page.locator('#shelves .shelf').count()) === 7);
  let o = await page.evaluate(overflow);
  record(n, 'Collection: no sideways scroll (Shelves)', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);

  // Table view: the old Library
  await page.locator('#colView button[data-v="table"]').click();
  const tv = await page.evaluate(() => ({ shelves: document.getElementById('colShelves').hidden, table: !document.getElementById('colTable').hidden, rows: document.querySelectorAll('#libBody tr.row').length, picks: document.querySelectorAll('#libBody tr.row .pickbtn-sm').length, head: [...document.querySelectorAll('#libHead th')].map(t => t.textContent.trim()) }));
  record(n, 'Table view: shows the Library table (first 100 albums) with a guitar pick on every row', tv.shelves && tv.table && tv.rows === 100 && tv.picks === 100 && tv.head.slice(0, 7).join() === 'Title,Artist,Rating,Status,Genre,Format,Year', JSON.stringify(tv));
  await page.locator('#libSearch').fill('Test Album 06'); await page.waitForTimeout(350);
  record(n, 'Table view: the search box filters the table', (await page.locator('#libBody tr.row').count()) === rows.filter(r => [r[0], r[2], r[4], r[8]].some(v => String(v).toLowerCase().includes('test album 06'))).length);
  await page.locator('#libSearch').fill(''); await page.waitForTimeout(350);
  await page.locator('#fColl .chip[data-v="fav"]').click();
  record(n, 'Table view: the Favourites chip lists the four favourites', (await page.locator('#libBody tr.row').count()) === 4 && (await page.locator('#libBody tr.row .pickbtn-sm[aria-pressed="true"]').count()) === 4);
  await page.locator('#fColl .chip[data-v="fav"]').click();
  await page.locator('#fStatus .chip[data-v="Didn\'t like"]').click();
  record(n, 'Table view: Status filter has a "Didn\'t like" chip with its four albums', (await page.locator('#libBody tr.row').count()) === 4 && (await page.locator('#libBody tr.row .pill').first().textContent()) === "Didn't like");
  await page.locator('#fStatus .chip[data-v="All"]').click();
  await page.locator('#libBody tr.row').first().click();
  const td = await page.evaluate(() => { const e = document.querySelector('#libBody tr.detail'); return { btns: [...e.querySelectorAll('button')].map(b => b.textContent.trim()), none: !e.querySelector('[data-log]') }; });
  record(n, 'Table view: the detail row has Edit album, Tracks, the label chip and Favourite (no "Log a listen" while the log is hidden)', td.btns.includes('Edit album') && td.btns.includes('Tracks') && td.btns.includes('Favourite') && td.btns.some(b => /▾$/.test(b)) && td.none, td.btns.join());
  o = await page.evaluate(overflow);
  record(n, 'Table view: no sideways scroll', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  await page.screenshot({ path: join(OUT, `${n}-collection-table.png`), fullPage: true });
  record(n, 'Collection: browsing, searching, Show all and the table cause no sheet writes', (await gw(page)).length === 0 && (await allOnTab(page)));
  record(n, 'Collection: no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();
}


// ----- the packed stack: the overflow of a shelf as narrow slices that fan out like a hand of cards
const stackSel = k => `${shelfSel(k)} .s-stack`;
const sliceInfo = (page, k) => page.evaluate(sel => [...document.querySelectorAll(sel)].map(e => ({ id: e.dataset.id, fanned: e.classList.contains('fanned') })), `${stackSel(k)} .slice`);
const fannedIds = async (page, k) => (await sliceInfo(page, k)).filter(x => x.fanned).map(x => x.id);
async function boxCenter(loc) { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; }
const sliceAt = (page, k, i) => page.locator(`${stackSel(k)} .slice`).nth(i);
async function hoverSlice(page, k, i) {
  await sliceAt(page, k, i).scrollIntoViewIfNeeded();
  const c = await boxCenter(sliceAt(page, k, i));
  await page.mouse.move(c.x, c.y, { steps: 3 });
  await page.waitForTimeout(220);
}
// Point at slice i, then rest the pointer on the raised card under it (the fan re-centres by a slice or so as the pointer moves
// up onto the card), until the same card stays under the pointer. Returns that card's album id.
async function settleOnCard(page, k, i) {
  await hoverSlice(page, k, i);
  let id = null;
  const cur = page.locator(`${stackSel(k)} .slice.cur`);
  for (let t = 0; t < 6; t++) {
    const now = await cur.getAttribute('data-id');
    if (now === id) break;
    id = now;
    const c = await boxCenter(cur.locator('.s-art'));
    await page.mouse.move(c.x, c.y, { steps: 2 }); await page.waitForTimeout(220);
  }
  return cur.getAttribute('data-id');
}
async function findCard(page, k, rowsById, pred, notIds = []) {
  const n = (await sliceInfo(page, k)).length;
  for (let i = 0; i < n; i++) {
    await page.mouse.move(5, 5); await page.waitForTimeout(120);
    const id = await settleOnCard(page, k, i);
    if (id && !notIds.includes(id) && pred(rowsById(id))) return id;
  }
  return null;
}
const detailTitle = page => page.evaluate(() => { const e = document.querySelector('#shelves .s-detail h3'); return e ? e.textContent : null; });

async function stackTests(browser, vp, seed, url) {
  const n = vp.name, phone = vp.width < 560;
  const N = phone ? 3 : 5, MAXS = phone ? 10 : 16;
  const rows = fxSeedRows(seed), want = expectedShelves(seed), total = want.hear.length;
  const k = Math.min(total - N, MAXS), more = total - N - k;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
  await cw(page);

  // 1. the packed stack
  const g = await page.evaluate(sel => {
    const st = document.querySelector(sel), board = st.closest('.s-board').getBoundingClientRect(), r = st.getBoundingClientRect(), sl = [...st.querySelectorAll('.slice')];
    const mr = st.querySelector('.s-more') ? st.querySelector('.s-more').getBoundingClientRect() : null;
    const w = sl.map(e => e.getBoundingClientRect()); const cs = getComputedStyle(sl[0]);
    return { k: sl.length, more: st.querySelector('.s-more') ? st.querySelector('.s-more').textContent : '', inside: r.left >= board.left && r.right <= board.right + 0.5 && (!mr || mr.right <= board.right + 0.5), sw: parseFloat(cs.width), role: st.getAttribute('role'), btns: sl.every(e => e.querySelector('button.s-art') && /album, label /.test(e.querySelector('.s-art').getAttribute('aria-label'))),
      tall: Math.abs(sl[0].getBoundingClientRect().height - parseFloat(getComputedStyle(sl[0]).height)) < 40, lean: cs.transform !== 'none', standing: st.closest('.s-row').querySelectorAll('.s-standing .s-it').length, over: document.documentElement.scrollWidth <= innerWidth };
  }, stackSel('hear'));
  record(n, `Stack: To hear (${total} albums) shows ${N} standing and a packed stack of ${k} slices (max ${MAXS})`, g.k === k && g.standing === N, JSON.stringify(g));
  record(n, `Stack: a "+${more}" chip sits at the end of the stack`, g.more === `+${more}`, g.more);
  record(n, `Stack: slices are ${phone ? '8-10' : '10-14'}px wide, buttons with a full aria-label, leaning, in a labelled group`, g.sw >= (phone ? 8 : 10) && g.sw <= (phone ? 10 : 14) && g.btns && g.lean && g.role === 'group', JSON.stringify(g));
  record(n, 'Stack: it sits inside the shelf and the page has no sideways scroll', g.inside && g.over, JSON.stringify(g));
  record(n, 'Stack: no stack when a shelf fits its standing sleeves (Owned/Favourites in the seed)', (await page.locator(`${shelfSel('fav')} .s-stack`).count()) === 0 || want.fav.length > N);

  // 2. hover fans 3 or 4 neighbours
  await hoverSlice(page, 'hear', 2);
  const f1 = await fannedIds(page, 'hear'), all = (await sliceInfo(page, 'hear')).map(x => x.id);
  record(n, 'Stack hover: the 3 or 4 slices nearest the pointer fan out, the rest stay packed', (f1.length === 3 || f1.length === 4) && f1.includes(all[2]) && f1.every(id => Math.abs(all.indexOf(id) - 2) <= 2), f1.join());
  const fan = await page.evaluate(sel => [...document.querySelectorAll(sel)].map(e => { const r = e.getBoundingClientRect(), a = e.querySelector('.s-art').getBoundingClientRect(); return { w: a.width, h: a.height, t: getComputedStyle(e).transform }; }), `${stackSel('hear')} .slice.fanned`);
  record(n, 'Stack hover: fanned cards are wider than packed slices (they show about half the sleeve) and rotated apart', fan.every(c => c.w > 25) && new Set(fan.map(c => c.t)).size === fan.length, JSON.stringify(fan));
  // the card under the pointer: caption, chip and pick
  const under = await page.evaluate(() => { const e = document.querySelector('.s-stack .slice.fanned.cur'); if (!e) return null; const cap = e.querySelector('.s-cap'), chip = e.querySelector('.s-chip'), pick = e.querySelector('.s-pick'), vis = x => getComputedStyle(x).display !== 'none' && +getComputedStyle(x).opacity > 0.9; return { id: e.dataset.id, cap: vis(cap) && cap.textContent, chip: vis(chip), pick: vis(pick) }; });
  const urow = under && rows.find(r => r[COLS.id] === under.id);
  record(n, 'Stack hover: the card under the pointer shows the same caption (title, artist, rating), plus the label chip and pick', !!under && under.cap.includes(urow[0]) && under.cap.includes(urow[2]) && /\/10|Not rated/.test(under.cap) && under.cap.includes('To hear') && under.chip && under.pick, JSON.stringify(under));
  // move along the stack: a different set; leaving packs it
  const farBefore = f1.join();
  await page.mouse.move(5, 5); await page.waitForTimeout(200);
  record(n, 'Stack hover: leaving the stack packs it again', (await fannedIds(page, 'hear')).length === 0);
  await hoverSlice(page, 'hear', k - 1);
  const f2 = await fannedIds(page, 'hear');
  record(n, 'Stack hover: pointing further along fans a different set (the last slices)', (f2.length === 3 || f2.length === 4) && f2.includes(all[k - 1]) && f2.join() !== farBefore, f2.join());
  // sliding along (not leaving) also moves the fan
  await hoverSlice(page, 'hear', 0);
  const f3 = await fannedIds(page, 'hear');
  const bare = k - 1;
  const bc = await boxCenter(sliceAt(page, 'hear', bare));
  await page.mouse.move(bc.x, bc.y, { steps: 6 }); await page.waitForTimeout(220);
  const f4 = await fannedIds(page, 'hear');
  record(n, 'Stack hover: sliding the pointer onto a packed slice moves the fan to it', f3.join() !== f4.join() && f4.includes(all[bare]), `${f3.join()} -> ${f4.join()}`);
  // click a fanned card: selects it, the detail strip shows that album
  await page.screenshot({ path: join(OUT, `${n}-fan.png`) });
  await page.mouse.move(5, 5); await page.waitForTimeout(150);
  const card = page.locator(`${stackSel('hear')} .slice.cur`), cid = await settleOnCard(page, 'hear', 6);
  const cc = await boxCenter(card.locator('.s-art'));
  const cid2 = await card.getAttribute('data-id');
  await page.mouse.click(cc.x, cc.y); await page.waitForTimeout(250);
  const crow = rows.find(r => r[COLS.id] === cid);
  record(n, 'Stack hover: clicking a fanned card selects it and the detail strip shows that album', cid === cid2 && (await detailTitle(page)) === crow[0] && (await page.locator(`${stackSel('hear')} .slice[data-id="${cid}"].sel`).count()) === 1, String(await detailTitle(page)));
  await page.locator('#shelves .s-detail [data-sa="close"]').click();
  record(n, 'Stack: browsing, hovering and selecting write nothing', (await gw(page)).length === 0);

  // label chip and pick on a fanned card
  const byId = id => rows.find(r => r[COLS.id] === id);
  const pid = await findCard(page, 'hear', byId, r => !r[COLS.format] && !r[COLS.fav], [cid]);
  const pcard = page.locator(`${stackSel('hear')} .slice.cur`);
  const psr = await page.evaluate(sheetRow, pid);
  await pcard.locator('.s-chip').click();
  await page.locator('.s-menu').waitFor();
  record(n, 'Stack chip: the label chip on a fanned card opens the label menu for that album', (await page.locator('.s-menu').getAttribute('aria-label')) === `Label for ${rows.find(r => r[COLS.id] === pid)[0]}`);
  await page.locator('.s-menu button[data-k="heard"]').click();
  await waitWrites(page, 1); await settle(page);
  const w1 = await gw(page);
  record(n, 'Stack chip: choosing Heard writes exactly the Status cell and moves the album to Heard', w1.length === 1 && w1[0].range === `'🎸'!D${psr}` && w1[0].v === 'Listened' && !(await shelfIds(page, 'hear')).includes(pid) && (await shelfIds(page, 'heard')).includes(pid), JSON.stringify(w1));
  await cw(page);
  const qid = await findCard(page, 'hear', byId, r => !r[COLS.format] && !r[COLS.fav]), qsr = await page.evaluate(sheetRow, qid);
  const qcard = page.locator(`${stackSel('hear')} .slice.cur`);
  await qcard.locator('.s-pick').click();
  await waitWrites(page, 1); await settle(page);
  const w2 = await gw(page);
  record(n, 'Stack pick: the guitar pick on a fanned card writes only the Favourite cell and adds it to Favourites', w2.length === 1 && w2[0].range === `'🎸'!Q${qsr}` && (await shelfIds(page, 'fav')).includes(qid), JSON.stringify(w2));
  record(n, 'Stack: no write outside the 🎸 tabs, no console errors', (await allOnTab(page)) && problems.length === 0, problems.slice(0, 2).join(' | '));

  // Show all: the wrapping grid of full sleeves, no stack
  await expandShelf(page, 'hear');
  record(n, 'Stack: "Show all" opens the grid of full sleeves with no stack', (await page.locator(`${shelfSel('hear')} .s-grid .s-it`).count()) === (await shelfCounts(page)).hear && (await page.locator(`${stackSel('hear')}`).count()) === 0);
  // Favourites uses the same stack for its overflow
  await page.evaluate(() => { state.albums.filter(a => !favOf(a)).slice(0, 8).forEach(a => { a.favourite = today(); }); render(); });
  const fs = await page.evaluate(() => ({ stack: document.querySelectorAll('#shelves .shelf[data-key="fav"] .s-stack .slice').length, stand: document.querySelectorAll('#shelves .shelf[data-key="fav"] .s-standing .s-it').length }));
  record(n, 'Stack: the Favourites shelf (mixed kinds) uses the same stack for its overflow', fs.stack > 0 && fs.stand === N, JSON.stringify(fs));
  const o = await page.evaluate(overflow);
  record(n, 'Stack: still no sideways scroll', o.sw <= o.iw);
  await context.close();

  // 3. keyboard: roving focus (a fresh page so no mouse has been used)
  {
    const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
    await cw(page);
    const stop = page.locator(`${stackSel('hear')} .slice .s-art[tabindex="0"]`);
    record(n, 'Stack keys: exactly one slice is a tab stop (roving focus)', (await stop.count()) === 1 && (await page.locator(`${stackSel('hear')} .slice .s-art`).count()) === k);
    await page.locator(`${stackSel('hear')} .slice`).first().scrollIntoViewIfNeeded();
    await page.keyboard.press('Tab');   // keyboard use, so that focus shows as :focus-visible
    await stop.focus();
    const ids = (await sliceInfo(page, 'hear')).map(x => x.id);
    const act = () => page.evaluate(() => { const a = document.activeElement, sl = a.closest && a.closest('.slice'); return { id: sl && sl.dataset.id, stack: a.classList.contains('s-stack'), role: a.tagName }; });
    const st0 = await fannedIds(page, 'hear');
    record(n, 'Stack keys: focusing a slice fans it with its neighbours', st0.length >= 3 && st0.length <= 4 && st0.includes(ids[0]), st0.join());
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    const a2 = await act(), st2 = await fannedIds(page, 'hear');
    record(n, 'Stack keys: ArrowRight moves focus to the next slice and the fan follows', a2.id === ids[2] && st2.includes(ids[2]) && st2.join() !== st0.join(), `${a2.id} ${st2.join()}`);
    await page.keyboard.press('ArrowLeft');
    record(n, 'Stack keys: ArrowLeft moves back', (await act()).id === ids[1]);
    await page.keyboard.press('End');
    const aEnd = await act();
    await page.keyboard.press('Home');
    record(n, 'Stack keys: End and Home jump to the last and first slice', aEnd.id === ids[k - 1] && (await act()).id === ids[0]);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter'); await page.waitForTimeout(250);
    const row1 = rows.find(r => r[COLS.id] === ids[1]);
    const a3 = await act();
    record(n, 'Stack keys: Enter selects the focused slice (detail strip shows it) and focus stays on it', (await detailTitle(page)) === row1[0] && a3.id === ids[1] && (await fannedIds(page, 'hear')).includes(ids[1]), `${await detailTitle(page)} ${JSON.stringify(a3)}`);
    await page.keyboard.press('Escape');
    const a4 = await act();
    record(n, 'Stack keys: Esc packs the stack and returns focus to the stack', (await fannedIds(page, 'hear')).length === 0 && a4.stack, JSON.stringify(a4));
    await page.keyboard.press('Tab');
    const a5 = await act();
    record(n, 'Stack keys: Tab goes back into the stack at its tab stop', !!a5.id && ids.includes(a5.id), JSON.stringify(a5));
    record(n, 'Stack keys: the live region says nothing extra, no writes, no console errors', (await page.locator('#live').textContent()) === '' && (await gw(page)).length === 0 && problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }

  // 4. touch: tap opens a 4-card fan with chevrons, tap a card selects, tap outside packs
  {
    const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection', { touch: true });
    await cw(page);
    const fine = await page.evaluate(() => matchMedia('(pointer: fine)').matches);
    await sliceAt(page, 'hear', 3).scrollIntoViewIfNeeded();
    const t = await boxCenter(sliceAt(page, 'hear', 3));
    const ids = (await sliceInfo(page, 'hear')).map(x => x.id);
    await page.touchscreen.tap(t.x, t.y); await page.waitForTimeout(250);
    const f = await fannedIds(page, 'hear');
    const chev = await page.evaluate(sel => [...document.querySelectorAll(sel)].map(b => { const r = b.getBoundingClientRect(); return r.width > 0 && getComputedStyle(b).display !== 'none'; }), `${stackSel('hear')} .s-chev`);
    record(n, 'Stack touch: tapping a slice opens a 4-card fan with left and right chevrons (and does not select)', !fine && f.length === 4 && f.includes(ids[3]) && chev.length === 2 && chev.every(Boolean) && (await detailTitle(page)) === null, `${fine} ${f.join()} ${chev}`);
    await page.screenshot({ path: join(OUT, `${n}-fan-touch.png`) });
    await page.locator(`${stackSel('hear')} .s-chev.next`).tap(); await page.waitForTimeout(250);
    const fn = await fannedIds(page, 'hear');
    record(n, 'Stack touch: the right chevron moves the fan along the stack, the left chevron moves it back', fn.length === 4 && fn.join() !== f.join() && fn.includes(ids[5]), fn.join());
    await page.locator(`${stackSel('hear')} .s-chev.prev`).tap(); await page.waitForTimeout(250);
    record(n, 'Stack touch: ...and back again', (await fannedIds(page, 'hear')).join() === f.join());
    // a card whose middle is not covered by its neighbours
    const top = await page.evaluate(sel => { for (const e of document.querySelectorAll(sel)) { const r = e.querySelector('.s-art').getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y); if (hit && e.contains(hit) && !hit.closest('.s-chip,.s-pick')) return { id: e.dataset.id, x, y }; } return null; }, `${stackSel('hear')} .slice.fanned`);
    const tid = top.id;
    await page.touchscreen.tap(top.x, top.y); await page.waitForTimeout(250);
    record(n, 'Stack touch: tapping a fanned card selects it', (await detailTitle(page)) === rows.find(r => r[COLS.id] === tid)[0], String(await detailTitle(page)));
    await page.locator('#shelves .s-detail [data-sa="close"]').tap();
    const h = await boxCenter(page.locator(`${shelfSel('hear')} h2`));
    await page.touchscreen.tap(h.x, h.y); await page.waitForTimeout(250);
    record(n, 'Stack touch: tapping outside packs the stack again', (await fannedIds(page, 'hear')).length === 0 && (await page.locator(`${stackSel('hear')}.touch`).count()) === 0);
    const o2 = await page.evaluate(overflow);
    record(n, 'Stack touch: no writes, no sideways scroll, no console errors', (await gw(page)).length === 0 && o2.sw <= o2.iw && problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }

  // 5. dragging a slice onto another shelf relabels it (real mouse path, as in the drag tests)
  {
    const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
    await cw(page);
    await sliceAt(page, 'hear', 0).scrollIntoViewIfNeeded();
    const tb0 = await page.locator(shelfSel('heard')).boundingBox();
    if (tb0.y + 120 > vp.height) await page.evaluate(d => window.scrollBy(0, d), tb0.y + 120 - vp.height + 20);
    const did = await findCard(page, 'hear', id => rows.find(r => r[COLS.id] === id), r => !r[COLS.format]), dsr = await page.evaluate(sheetRow, did);
    const dcard = page.locator(`${stackSel('hear')} .slice.cur`);
    const sb = await boxCenter(dcard.locator('.s-art')), tb = await page.locator(shelfSel('heard')).boundingBox();
    await page.mouse.move(sb.x, sb.y); await page.mouse.down();
    await page.mouse.move(sb.x + 12, sb.y + 12, { steps: 4 });
    await page.mouse.move(tb.x + tb.width / 2, Math.min(tb.y + 100, vp.height - 30), { steps: 14 });
    await page.mouse.up();
    await waitWrites(page, 1); await settle(page);
    const w = await gw(page);
    record(n, 'Stack drag: dragging a slice onto the Heard shelf writes the Status cell only and moves it', w.length === 1 && w[0].range === `'🎸'!D${dsr}` && w[0].v === 'Listened' && (await shelfIds(page, 'heard')).includes(did) && !(await shelfIds(page, 'hear')).includes(did), JSON.stringify(w));
    record(n, 'Stack drag: no write outside 🎸, no console errors', (await allOnTab(page)) && problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }

  // 6. reduced motion: the fan simply snaps
  {
    const { context, page } = await freshPage(browser, vp, seed, url, 'collection', { reducedMotion: 'reduce' });
    await hoverSlice(page, 'hear', 2);
    const run = await page.evaluate(() => document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('.s-stack')).length);
    const tr = await page.evaluate(sel => getComputedStyle(document.querySelector(sel)).transitionDuration, `${stackSel('hear')} .slice`);
    record(n, 'Stack reduced motion: the fan snaps (no transitions or animations on the stack)', run === 0 && /^0s(, 0s)*$/.test(tr) && (await fannedIds(page, 'hear')).length >= 3, `${run} ${tr}`);
    await context.close();
  }
}


// ----- Didn't like: the cartoon incinerator (the oldest albums are "incinerated": off the shelf, still in the sheet)
const INC_LABEL = "Incinerator: the oldest albums you didn't like get fed to it. They stay in your sheet.";
const nopeShelfIds = page => page.evaluate(() => [...document.querySelectorAll('#shelves .shelf[data-key="nope"] .s-it[data-id]')].map(e => e.dataset.id));
const nopeStanding = page => page.evaluate(() => [...document.querySelectorAll('#shelves .shelf[data-key="nope"] .s-standing .s-it')].map(e => { const r = e.getBoundingClientRect(); return { id: e.dataset.id, slot: e.dataset.slot, cx: r.left + r.width / 2, warm: e.classList.contains('warm') }; }));
const nopeHead = page => page.evaluate(() => { const s = document.querySelector('#shelves .shelf[data-key="nope"]'), note = s.querySelector('.sh-note'); return { count: +s.querySelector('.sh-count').textContent, note: note ? note.textContent : '' }; });
function nopeOrder(sd) {   // newest first: Labelled date (when the sheet has the column), then sheet row
  const lab = sd['🎸'][0].includes('Labelled');
  return fxSeedRows(sd).map((r, i) => ({ r, i })).filter(({ r }) => labelFor(r) === 'nope')
    .sort((a, b) => (lab ? (b.r[COLS.labelled] || '').localeCompare(a.r[COLS.labelled] || '') : 0) || b.i - a.i).map(({ r }) => r[COLS.id]);
}
const motionAnims = page => page.evaluate(() => document.getAnimations().filter(a => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#shelves')).map(a => a.animationName || a.constructor.name));
const fiveth = sd => fxSeedRows(sd).find(r => labelFor(r) === 'hear' && r[COLS.status] === 'Listen' && !r[COLS.format]);

async function incTests(browser, vp, seed, seedL, url) {
  const n = vp.name, SL = vp.width < 560 ? 3 : 4;
  const order = nopeOrder(seed), rows = fxSeedRows(seed);
  const waitGhostGone = page => page.waitForFunction(() => !document.querySelector('.s-ghost'), null, { timeout: 5000, polling: 100 });

  // 1. the seed's four albums stand in slots, newest to oldest, towards the furnace
  {
    const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
    await cw(page);
    await page.locator(shelfSel('nope')).scrollIntoViewIfNeeded();
    const st = await nopeStanding(page), head = await nopeHead(page);
    record(n, `Incinerator: the newest ${SL} Didn't like albums stand in slots ${vp.width < 560 ? '(3 on a phone)' : '(4)'}, newest first, from the left`, st.map(x => x.id).join() === order.slice(0, SL).join() && st.map(x => x.slot).join() === [...Array(SL).keys()].join() && st.every((x, i) => !i || x.cx > st[i - 1].cx), `${st.map(x => x.id)} vs ${order.slice(0, SL)}`);
    const fg = await page.evaluate(() => { const sh = document.querySelector('#shelves .shelf[data-key="nope"]'), m = sh.querySelector('.fn-mouth').getBoundingClientRect(), mx = m.left + m.width / 2, board = sh.querySelector('.s-board').getBoundingClientRect(), f = sh.querySelector('.furnace').getBoundingClientRect();
      const it = [...sh.querySelectorAll('.s-standing .s-it')].map(e => { const r = e.getBoundingClientRect(); return { d: mx - (r.left + r.width / 2), right: r.right }; });
      return { d: it.map(x => Math.round(x.d)), closer: it.every((x, i) => !i || x.d < it[i - 1].d), clear: it.every(x => x.right <= f.left + f.width * 0.2), inside: f.right <= board.right + 1 && f.left >= board.left, tall: f.height > 60, label: sh.querySelector('svg.furnace').getAttribute('aria-label'), role: sh.querySelector('svg.furnace').getAttribute('role'), tip: sh.querySelector('h2').title, flames: sh.querySelectorAll('.fn-fl').length }; });
    record(n, 'Incinerator: each slot is visibly closer to the furnace mouth than the one before', fg.closer && fg.d.every((d, i) => !i || fg.d[i - 1] - d > 20), fg.d.join());
    record(n, 'Incinerator: an inline SVG furnace (role=img) with the aria-label sits at the right end, inside the shelf, clear of the sleeves', fg.label === INC_LABEL && fg.role === 'img' && fg.inside && fg.clear && fg.tall && fg.flames >= 3, JSON.stringify(fg));
    record(n, 'Incinerator: the shelf heading explains it in a tooltip', fg.tip === "Albums you didn't like. The oldest get fed to the furnace, but they stay in your sheet.", fg.tip);
    record(n, `Incinerator: the header shows all 4 albums${SL < 4 ? ' and a muted "1 incinerated" note' : ' and no note while none are incinerated'}`, head.count === 4 && head.note === (SL < 4 ? '1 incinerated' : ''), JSON.stringify(head));
    const warm = await page.evaluate(() => [...document.querySelectorAll('#shelves .shelf[data-key="nope"] .s-standing .s-it')].map(e => e.classList.contains('warm') && getComputedStyle(e.querySelector('.s-art'), '::before').content !== 'none'));
    record(n, 'Incinerator: only the sleeve in the last slot gets the heat overlay (glow and scorched corner)', warm.length === SL && warm.slice(0, -1).every(x => !x) && warm[SL - 1] === true, warm.join());
    const an = await motionAnims(page);
    record(n, 'Incinerator: with motion allowed the flames flicker, smoke drifts and the last sleeve shakes (CSS animations)', an.filter(x => x === 'fnflick').length >= 3 && an.includes('fnpuff') && an.includes('nervous'), [...new Set(an)].join());
    const o = await page.evaluate(overflow);
    record(n, 'Incinerator: no sideways scroll, no writes, no console errors', o.sw <= o.iw && (await gw(page)).length === 0 && problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }

  // 2. a fifth album arrives: slot 0, the oldest leaves the shelf; Show all lists everything; rescue the ash tile; Undo
  {
    const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
    const row = fiveth(seed), id = row[COLS.id], sr = await page.evaluate(sheetRow, id);
    await cw(page);
    await relabelViaMenu(page, id, 'hear', 'nope');
    const ghost = await page.locator('.s-ghost').count();
    await waitWrites(page, 1); await settle(page);
    const w = await gw(page);
    record(n, 'Incinerator: relabelling an album to Didn\'t like writes exactly the Status cell (nothing extra)', w.length === 1 && w[0].range === `'🎸'!D${sr}` && w[0].v === "Didn't like" && w[0].tool === 'update_values', JSON.stringify(w));
    await page.locator(shelfSel('nope')).scrollIntoViewIfNeeded();
    const st = await nopeStanding(page), head = await nopeHead(page), dom = await nopeShelfIds(page);
    record(n, 'Incinerator: the new album is in slot 0 and every other album is one slot closer', st.map(x => x.id).join() === [id, ...order.slice(0, SL - 1)].join(), st.map(x => x.id).join());
    record(n, 'Incinerator: the oldest standing album has left the shelf (no sleeve for it in the shelf)', !dom.includes(order[SL - 1]) && dom.length === SL, dom.join());
    record(n, `Incinerator: the header count goes up to 5 and the note says "${5 - SL} incinerated"`, head.count === 5 && head.note === `${5 - SL} incinerated`, JSON.stringify(head));
    record(n, 'Incinerator: the pushed-out album slides into the furnace (a ghost sleeve animates, then is gone)', ghost === 1, String(ghost));
    await waitGhostGone(page);
    record(n, 'Incinerator: ...and nothing is left behind afterwards', (await page.locator('.s-ghost').count()) === 0);
    // Show all: every album, the incinerated ones as ash tiles
    await page.locator(`${shelfSel('nope')} [data-sa="all"]`).click();
    const grid = await page.evaluate(() => [...document.querySelectorAll('#shelves .shelf[data-key="nope"] .s-grid .s-it')].map(e => ({ id: e.dataset.id, ash: e.classList.contains('ash'), badge: !!e.querySelector('.s-ash'), cap: e.querySelector('.s-cap').textContent, filter: getComputedStyle(e.querySelector('.s-art')).filter })));
    const ids = [id, ...order];
    record(n, 'Incinerator: Show all lists every Didn\'t like album, newest first', grid.map(x => x.id).join() === ids.join(), grid.map(x => x.id).join());
    record(n, `Incinerator: the ${5 - SL} oldest are ash tiles (desaturated, flame badge, "Incinerated (still in your sheet)" caption), the rest are normal`, grid.every((x, i) => x.ash === (i >= SL) && x.badge === (i >= SL) && /Incinerated \(still in your sheet\)/.test(x.cap) === (i >= SL) && (i >= SL) === /grayscale/.test(x.filter)), JSON.stringify(grid.map(x => [x.ash, x.badge])));
    record(n, 'Incinerator: Show all has no furnace in the grid', (await page.locator(`${shelfSel('nope')} .s-grid`).count()) === 1);
    // rescue the oldest ash tile
    const ash = order[3], asr = await page.evaluate(sheetRow, ash);
    await cw(page);
    await openChip(page, ash, 'nope');
    record(n, 'Incinerator: an ash tile is still fully relabelable (its label chip opens the menu)', (await page.locator('.s-menu').getAttribute('aria-label')) === `Label for ${rows.find(r => r[COLS.id] === ash)[0]}`);
    await page.locator('.s-menu button[data-k="heard"]').click();
    await waitWrites(page, 1); await settle(page);
    const w2 = await gw(page), after = await nopeShelfIds(page);
    record(n, 'Incinerator: rescuing it (relabel to Heard) writes exactly the Status cell and moves it off the shelf', w2.length === 1 && w2[0].range === `'🎸'!D${asr}` && w2[0].v === 'Listened' && !after.includes(ash) && (await shelfIds(page, 'heard')).includes(ash), JSON.stringify(w2));
    record(n, 'Incinerator: the header count drops back to 4', (await nopeHead(page)).count === 4);
    // an ash tile can be selected too (detail strip)
    await page.evaluate(() => { shelfUI.expanded.nope = true; render(); });
    record(n, 'Incinerator: no write outside 🎸, no console errors', (await allOnTab(page)) && problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }
  // 3. Undo puts everything back
  {
    const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
    const row = fiveth(seed), id = row[COLS.id], sr = await page.evaluate(sheetRow, id), before = await cellOf(page, id);
    await relabelViaMenu(page, id, 'hear', 'nope');
    await waitWrites(page, 1); await settle(page);
    await cw(page);
    await page.locator('#toasts .toast button', { hasText: 'Undo' }).click();
    await waitWrites(page, 1); await settle(page);
    await page.locator(shelfSel('nope')).scrollIntoViewIfNeeded();
    const w = await gw(page), st = await nopeStanding(page), head = await nopeHead(page);
    record(n, 'Incinerator Undo: writes back only the previous Status and the row is as it was', w.length === 1 && w[0].range === `'🎸'!D${sr}` && w[0].v === row[COLS.status] && (await cellOf(page, id)) === before, JSON.stringify(w));
    record(n, 'Incinerator Undo: the previous slots are restored (the incinerated album is back, the others shifted back)', st.map(x => x.id).join() === order.slice(0, SL).join() && !(await nopeShelfIds(page)).includes(id), st.map(x => x.id).join());
    record(n, 'Incinerator Undo: the header goes back to 4 and no fire animation is left running', head.count === 4 && (await page.locator('.s-ghost').count()) === 0);
    record(n, 'Incinerator Undo: no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }
  // 4. a sheet with a Labelled column: the order follows the Labelled dates, and the move stamps it
  {
    const sd = JSON.parse(JSON.stringify(seedL)), rr = sd['🎸'].slice(1);
    const dates = { '1092': isoDay(2), '1087': isoDay(3), '1095': isoDay(10), '1102': isoDay(30) };   // not the same as sheet row order
    rr.forEach(r => { if (dates[r[COLS.id]]) r[COLS.labelled] = dates[r[COLS.id]]; });
    const ord = nopeOrder(sd);
    const { context, page, problems } = await freshPage(browser, vp, sd, url, 'collection');
    const st = await nopeStanding(page);
    record(n, 'Incinerator (Labelled column): the slots follow the Labelled dates, newest first', ord.join() === '1092,1087,1095,1102' && st.map(x => x.id).join() === ord.slice(0, SL).join(), `${st.map(x => x.id)} vs ${ord}`);
    const row = fiveth(sd), id = row[COLS.id], sr = await page.evaluate(sheetRow, id), today = await page.evaluate(() => today());
    await cw(page);
    await relabelViaMenu(page, id, 'hear', 'nope');
    await waitWrites(page, 2); await settle(page);
    const w = await gw(page), st2 = await nopeStanding(page);
    record(n, 'Incinerator (Labelled column): the move writes Status and Labelled only and lands in slot 0', w.map(x => `${x.range}=${x.v}`).sort().join('|') === [`'🎸'!D${sr}=Didn't like`, `'🎸'!R${sr}=${today}`].sort().join('|') && st2[0].id === id && st2.map(x => x.id).join() === [id, ...ord.slice(0, SL - 1)].join(), JSON.stringify(w));
    record(n, 'Incinerator (Labelled column): no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }
  // 5. reduced motion: nothing runs, everything snaps, the shelf still behaves
  {
    const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection', { reducedMotion: 'reduce' });
    await page.locator(shelfSel('nope')).scrollIntoViewIfNeeded();
    const idle = await motionAnims(page);
    record(n, 'Incinerator reduced motion: no running animations on the furnace, flames, smoke or sleeves', idle.length === 0, idle.join());
    const fl = await page.evaluate(() => ({ flames: document.querySelectorAll('#shelves .fn-fl').length, anim: getComputedStyle(document.querySelector('#shelves .fn-fl')).animationName }));
    record(n, 'Incinerator reduced motion: the flames are still drawn, just static', fl.flames >= 3 && fl.anim === 'none', JSON.stringify(fl));
    const row = fiveth(seed), id = row[COLS.id];
    await relabelViaMenu(page, id, 'hear', 'nope');
    const ghost = await page.locator('.s-ghost').count(), st = await nopeStanding(page), after = await motionAnims(page);
    record(n, 'Incinerator reduced motion: relabelling to Didn\'t like just snaps (no ghost sleeve, slot 0, oldest gone, no animations)', ghost === 0 && st[0].id === id && !(await nopeShelfIds(page)).includes(order[SL - 1]) && after.length === 0, `${ghost} ${after.join()}`);
    record(n, 'Incinerator reduced motion: no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }
  // 6. screenshots: Didn't like with six albums (some incinerated), plus one frame of the feeding animation
  {
    const sd = JSON.parse(JSON.stringify(seed)), more = sd['🎸'].slice(1).filter(r => r[COLS.status] === 'Listen' && !r[COLS.format]).slice(0, 2);
    more.forEach(r => { r[COLS.status] = "Didn't like"; });
    const { context, page } = await freshPage(browser, vp, sd, url, 'collection');
    await page.locator(shelfSel('nope')).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.locator(shelfSel('nope')).screenshot({ path: join(OUT, `${n}-incinerator.png`) });
    const hid = fiveth(sd)[COLS.id];
    await relabelViaMenu(page, hid, 'hear', 'nope');
    await page.locator(shelfSel('nope')).scrollIntoViewIfNeeded();
    await page.waitForTimeout(620);
    await page.locator(shelfSel('nope')).screenshot({ path: join(OUT, `${n}-incinerator-feeding.png`) });
    await page.locator(`${shelfSel('nope')} [data-sa="all"]`).click();
    await page.waitForTimeout(300);
    await page.locator(shelfSel('nope')).screenshot({ path: join(OUT, `${n}-incinerator-ash.png`) });
    record(n, 'Incinerator: screenshots written (six albums, feeding frame, ash tiles)', true);
    await context.close();
  }
}

// ----- relabel table: exactly which cells each move writes
const SCENARIOS = [
  { name: 'To hear → Heard', pick: r => labelFor(r) === 'hear' && !r[COLS.format], to: 'heard', writes: { D: 'Listened' }, both: true },
  { name: 'wish list (Vinyl (Wanted)) → Owned', pick: r => isPW(r), to: 'owned', writes: { D: 'Owned', F: 'Vinyl (Owned)' }, both: true },
  { name: 'Owned (by Status) → wish list', pick: r => r[COLS.status] === 'Owned' && !r[COLS.format], to: 'wish', writes: { D: 'Purchase' } },
  { name: 'Owned (Vinyl (Owned)) → wish list', pick: r => r[COLS.status] === 'Owned' && r[COLS.format] === 'Vinyl (Owned)', to: 'wish', writes: { D: 'Purchase', F: 'Vinyl (Wanted)' } },
  { name: 'Heard on Vinyl (Owned) → wish list', pick: r => r[COLS.status] === 'Listened' && r[COLS.format] === 'Vinyl (Owned)', to: 'wish', writes: { D: 'Purchase', F: 'Vinyl (Wanted)' } },
  { name: 'wish list (Vinyl (Wanted)) → To hear (Format cleared)', pick: r => isPW(r), to: 'hear', writes: { D: 'Listen', F: '' } },
  { name: 'To hear → Didn\'t like', pick: r => labelFor(r) === 'hear' && !r[COLS.format], to: 'nope', writes: { D: "Didn't like" } },
  { name: 'wish list (Vinyl (Wanted)) → Didn\'t like (Format cleared)', pick: r => isPW(r), to: 'nope', writes: { D: "Didn't like", F: '' } },
  { name: 'Heard → Upcoming', pick: r => labelFor(r) === 'heard' && !r[COLS.format], to: 'upcoming', writes: { D: 'Coming Soon' } },
  { name: 'Owned (Vinyl (Owned)) → Didn\'t like (Format kept)', pick: r => r[COLS.status] === 'Owned' && r[COLS.format] === 'Vinyl (Owned)', to: 'nope', writes: { D: "Didn't like" } },
];
const colIdx = { D: COLS.status, F: COLS.format, R: COLS.labelled };

async function relabelTests(browser, vp, seed, seedL, url) {
  const n = vp.name;
  const runs = [];
  for (const sc of SCENARIOS) runs.push([sc, seed, false]);
  for (const sc of SCENARIOS.filter(x => x.both)) runs.push([sc, seedL, true]);
  let allTab = true, problemsAll = [];
  for (const [sc, sd, withLabelled] of runs) {
    const row = fxSeedRows(sd).find(sc.pick), id = row[COLS.id], from = labelFor(row);
    const { context, page, problems } = await freshPage(browser, vp, sd, url, 'collection');
    const sr = await page.evaluate(sheetRow, id), before = JSON.parse(await cellOf(page, id)), todayIso = await page.evaluate(() => today());
    await cw(page);
    await relabelViaMenu(page, id, from, sc.to);
    const wantCells = { ...sc.writes, ...(withLabelled ? { R: todayIso } : {}) };
    await waitWrites(page, Object.keys(wantCells).length);
    await settle(page);
    const w = await gw(page);
    const got = w.map(x => `${x.range}=${x.v}`).sort().join(' | ');
    const exp = Object.entries(wantCells).map(([c, v]) => `'🎸'!${c}${sr}=${v}`).sort().join(' | ');
    const tag = `${sc.name}${withLabelled ? ' (sheet has a Labelled column)' : ''}`;
    record(n, `Relabel: ${tag} writes exactly ${Object.keys(wantCells).join('+')}`, got === exp && w.every(x => x.sheet === '🎸' && x.tool === 'update_values' && x.n === 1), `${got} vs ${exp}`);
    const after = JSON.parse(await cellOf(page, id)), wantRow = [...before];
    for (const [c, v] of Object.entries(wantCells)) wantRow[colIdx[c]] = v;
    record(n, `Relabel: ${tag} changes only those cells of the row`, JSON.stringify(after) === JSON.stringify(wantRow), JSON.stringify(after));
    const tt = await toasts(page);
    record(n, `Relabel: ${tag} shows "Moved <title> to <label>" with Undo`, tt.length === 1 && tt[0].includes(`Moved ${row[0]} to ${LABEL_NAME[sc.to]}`) && tt[0].includes('Undo'), tt.join(' | '));
    const onNew = await page.locator(`${shelfSel(sc.to)} .s-it[data-id="${id}"]`).count(), onOld = await page.locator(`${shelfSel(from)} .s-it[data-id="${id}"]`).count();
    record(n, `Relabel: ${tag} moves the sleeve to the ${LABEL_NAME[sc.to]} shelf`, onNew === 1 && onOld === 0, `new ${onNew}, old ${onOld}`);
    if (!withLabelled) record(n, `Relabel: ${tag} writes nothing extra when the sheet has no Labelled column`, !w.some(x => x.range.includes('!R')));
    allTab = allTab && (await allOnTab(page)); problemsAll.push(...problems);
    await context.close();
  }
  record(n, 'Relabel: no write ever leaves the 🎸 tabs', allTab);
  record(n, 'Relabel: no console errors', problemsAll.length === 0, problemsAll.slice(0, 2).join(' | '));

  // locked targets for an album that is Vinyl (Owned)
  {
    const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
    const row = fxSeedRows(seed).find(r => r[COLS.status] === 'Listened' && r[COLS.format] === 'Vinyl (Owned)'), id = row[COLS.id];
    await cw(page);
    await openChip(page, id, 'owned');
    const items = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.s-menu button')].map(b => [b.dataset.k, { disabled: b.getAttribute('aria-disabled') === 'true', title: b.title, checked: b.getAttribute('aria-checked') }])));
    record(n, 'Relabel: for a Vinyl (Owned) album To hear, Heard and Upcoming are disabled with an explanation', ['hear', 'heard', 'upcoming'].every(k => items[k].disabled && items[k].title === LOCK_MSG), JSON.stringify(items));
    record(n, 'Relabel: for a Vinyl (Owned) album Owned, Vinyl wish list and Didn\'t like stay available', ['owned', 'wish', 'nope'].every(k => !items[k].disabled) && items.owned.checked === 'true', JSON.stringify(items));
    await page.locator('.s-menu button[data-k="heard"]').click({ force: true });   // aria-disabled: Playwright would wait forever otherwise
    const t1 = await toasts(page);
    record(n, 'Relabel: choosing a disabled label explains why and writes nothing', (await gw(page)).length === 0 && t1.some(t => t.includes(LOCK_MSG)) && (await page.locator('.s-menu').count()) === 1, t1.join(' | '));
    await page.keyboard.press('Escape');
    // no-op: choosing the label it already has writes nothing and says nothing
    await cw(page);
    await openChip(page, id, 'owned');
    await page.locator('.s-menu button[data-k="owned"]').click();
    await settle(page);
    record(n, 'Relabel: choosing the current label is a no-op (no writes, no "Moved" toast)', (await gw(page)).length === 0 && !(await toasts(page)).some(t => t.startsWith('Moved')), (await toasts(page)).join(' | '));
    record(n, 'Relabel: no console errors (locked and no-op cases)', problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }
}

// ----- undo, and the 6 second toast
async function undoTests(browser, vp, seed, seedL, url) {
  const n = vp.name;
  for (const [label, sd, withL] of [['plain sheet', seed, false], ['sheet with a Labelled column', seedL, true]]) {
    const { context, page, problems } = await freshPage(browser, vp, sd, url, 'collection');
    const row = fxSeedRows(sd).find(isPW), id = row[COLS.id], sr = await page.evaluate(sheetRow, id);
    const before = await cellOf(page, id);
    await cw(page);
    await relabelViaMenu(page, id, 'wish', 'owned');
    const k = withL ? 3 : 2;
    await waitWrites(page, k); await settle(page);
    record(n, `Undo (${label}): the move changed the row`, (await cellOf(page, id)) !== before);
    await cw(page);
    await page.locator('#toasts .toast button', { hasText: 'Undo' }).click();
    await waitWrites(page, k); await settle(page);
    const w = await gw(page);
    const got = w.map(x => `${x.range}=${x.v}`).sort().join(' | ');
    const exp = [`'🎸'!D${sr}=Purchase`, `'🎸'!F${sr}=Vinyl (Wanted)`, ...(withL ? [`'🎸'!R${sr}=`] : [])].sort().join(' | ');
    record(n, `Undo (${label}): writes back the previous value of exactly the cells that changed${withL ? ', including the blank Labelled' : ''}`, got === exp, `${got} vs ${exp}`);
    record(n, `Undo (${label}): the row is exactly as it was`, (await cellOf(page, id)) === before);
    record(n, `Undo (${label}): the sleeve is back on the Vinyl wish list shelf and the toast is gone`, (await page.locator(`${shelfSel('wish')} .s-it[data-id="${id}"]`).count()) === 1 && (await page.locator('#toasts .toast').count()) === 0);
    record(n, `Undo (${label}): nothing outside 🎸 tabs, no console errors`, (await allOnTab(page)) && problems.length === 0, problems.slice(0, 2).join(' | '));
    await context.close();
  }
  // the toast lasts 6 seconds; toasts live in a polite live region
  const { context, page } = await freshPage(browser, vp, seed, url, 'collection');
  const row = fxSeedRows(seed).find(r => labelFor(r) === 'hear' && !r[COLS.format]), id = row[COLS.id];
  const live = await page.evaluate(() => { const t = document.getElementById('toasts'); return t.getAttribute('role') + '/' + t.getAttribute('aria-live'); });
  record(n, 'Toast: toasts sit in a live region (role=status, polite)', live === 'status/polite', live);
  await relabelViaMenu(page, id, 'hear', 'heard');
  await settle(page);
  record(n, 'Toast: the Undo toast is shown right after a move', (await page.locator('#toasts .toast').count()) === 1);
  await page.clock.fastForward(5000);
  record(n, 'Toast: still there after 5 seconds', (await page.locator('#toasts .toast').count()) === 1);
  await page.clock.fastForward(1500);
  record(n, 'Toast: gone after 6 seconds', (await page.locator('#toasts .toast').count()) === 0);
  await context.close();
}

// ----- the guitar pick
async function pickTests(browser, vp, seed, seedL, url) {
  const n = vp.name;
  const rows = fxSeedRows(seed);
  const target = rows.find(r => labelFor(r) === 'heard' && !r[COLS.fav] && !r[COLS.format]), id = target[COLS.id];
  const { context, page, problems } = await freshPage(browser, vp, seedL, url, 'collection');   // Labelled column present: a pick must not touch it
  const sr = await page.evaluate(sheetRow, id), todayIso = await page.evaluate(() => today());
  const favCountBefore = (await shelfCounts(page)).fav;
  await cw(page);
  await expandShelf(page, 'heard');
  const pick = page.locator(`${shelfSel('heard')} .s-it[data-id="${id}"] .s-pick`);
  await pick.scrollIntoViewIfNeeded();
  record(n, 'Pick: starts unpressed', (await pick.getAttribute('aria-pressed')) === 'false');
  await pick.click();
  await waitWrites(page, 1); await settle(page);
  let w = await gw(page);
  record(n, 'Pick: turning a favourite on writes exactly one cell, Favourite = today', w.length === 1 && w[0].range === `'🎸'!Q${sr}` && w[0].v === todayIso && w[0].sheet === '🎸' && w[0].n === 1, JSON.stringify(w));
  record(n, 'Pick: the pick is pressed and the album joined Favourites (first, newest)', (await pick.getAttribute('aria-pressed')) === 'true' && (await shelfCounts(page)).fav === favCountBefore + 1 && (await shelfIds(page, 'fav'))[0] === id, JSON.stringify(await shelfCounts(page)));
  record(n, 'Pick: it stays on its label shelf too (favourite is not a label)', (await page.locator(`${shelfSel('heard')} .s-it[data-id="${id}"]`).count()) === 1);
  record(n, 'Pick: the header record spins after a successful pick', (await page.evaluate(MARK_ANIMS)) === 1);
  record(n, 'Pick: status reads "Favourite saved"', (await page.locator('#statusText').textContent()) === 'Favourite saved');
  // off, from the Favourites shelf
  await cw(page);
  await expandShelf(page, 'fav');
  await page.locator(`${shelfSel('fav')} .s-it[data-id="${id}"] .s-pick`).click();
  await waitWrites(page, 1); await settle(page);
  w = await gw(page);
  record(n, 'Pick: turning it off writes exactly one empty Favourite cell', w.length === 1 && w[0].range === `'🎸'!Q${sr}` && w[0].v === '' && w[0].n === 1, JSON.stringify(w));
  record(n, 'Pick: it leaves Favourites but stays on its label shelf', !(await shelfIds(page, 'fav')).includes(id) && (await shelfIds(page, 'heard')).includes(id) && (await shelfCounts(page)).fav === favCountBefore);
  // from the detail strip
  await cw(page);
  await page.locator(`${shelfSel('heard')} .s-it[data-id="${id}"] .s-art`).click();
  await page.locator('#shelves .s-detail .s-pickbtn').click();
  await waitWrites(page, 1); await settle(page);
  w = await gw(page);
  record(n, 'Pick: the detail strip button writes the same single cell', w.length === 1 && w[0].range === `'🎸'!Q${sr}` && w[0].v === todayIso && (await page.locator('#shelves .s-detail .s-pickbtn').getAttribute('aria-pressed')) === 'true', JSON.stringify(w));
  // from the Table view
  await cw(page);
  await toTable(page);
  await page.locator('#libSearch').fill(target[0]); await page.waitForTimeout(350);
  const tpick = page.locator(`#libBody tr.row[data-id="${id}"] .pickbtn-sm`);
  record(n, 'Pick: the Table row shows it pressed', (await tpick.getAttribute('aria-pressed')) === 'true');
  await tpick.click();
  await waitWrites(page, 1); await settle(page);
  w = await gw(page);
  record(n, 'Pick: a Table row pick writes one cell and does not open the row', w.length === 1 && w[0].range === `'🎸'!Q${sr}` && w[0].v === '' && (await page.locator('#libBody tr.detail').count()) === 0, JSON.stringify(w));
  record(n, 'Pick: no write outside 🎸, no console errors', (await allOnTab(page)) && problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();

  // a failed write puts the screen back and says so
  {
    const f = await freshPage(browser, vp, seed, url, 'collection');
    const fsr = await f.page.evaluate(sheetRow, id), fbefore = await cellOf(f.page, id);
    await f.page.evaluate(() => { const m = window.__sg.state.mcp, orig = m.callTool.bind(m); m.callTool = (srv, tool, args, o) => tool === 'update_values' ? Promise.reject({ code: 'tool_error', message: 'simulated failure' }) : orig(srv, tool, args, o); });
    await expandShelf(f.page, 'heard');
    await f.page.locator(`${shelfSel('heard')} .s-it[data-id="${id}"] .s-pick`).click();
    await f.page.waitForFunction(() => /simulated failure/.test(document.getElementById('notice').textContent), null, { timeout: 8000 });
    await settle(f.page);
    record(n, 'Pick: if the write fails the pick goes back, the sheet is untouched and a message explains', (await cellOf(f.page, id)) === fbefore && (await shelfIds(f.page, 'fav')).length === 4 && (await f.page.locator('#notice').textContent()).includes(`Couldn't save the favourite for “${target[0]}”`) && fsr > 0);
    await f.context.close();
    const g = await freshPage(browser, vp, seed, url, 'collection');
    const grow = fxSeedRows(seed).find(r => labelFor(r) === 'hear' && !r[COLS.format]), gid = grow[COLS.id], gbefore = await cellOf(g.page, gid);
    await g.page.evaluate(() => { const m = window.__sg.state.mcp, orig = m.callTool.bind(m); m.callTool = (srv, tool, args, o) => tool === 'update_values' ? Promise.reject({ code: 'tool_error', message: 'simulated failure' }) : orig(srv, tool, args, o); });
    await relabelViaMenu(g.page, gid, 'hear', 'heard');
    await g.page.waitForFunction(() => /simulated failure/.test(document.getElementById('notice').textContent), null, { timeout: 8000 });
    await settle(g.page);
    record(n, 'Relabel: if the write fails the sleeve goes back to its shelf, the row is untouched and the toast goes', (await cellOf(g.page, gid)) === gbefore && (await shelfIds(g.page, 'hear')).includes(gid) && (await g.page.locator('#toasts .toast').count()) === 0);
    await g.context.close();
  }
  // offline (no connection to the sheet): the usual notice, nothing changes
  {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    await ctx.route('**/*', r => { const u = r.request().url(); return /^(file|data|blob):/.test(u) ? r.continue() : r.abort(); });
    await ctx.addInitScript(() => { window.claude = { use: async () => null }; });
    const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.goto(url);
    await page.waitForLoadState('load');
    await page.locator('#tab-collection').click();
    const sample = await page.evaluate(() => { const a = state.albums.find(x => labelOf(x) === 'hear'); return String(toNum(a.id)); });
    await relabelViaMenu(page, sample, 'hear', 'heard');
    const note = await page.locator('#notice').textContent();
    record(n, 'Relabel: offline shows the usual "needs the live connection" notice and changes nothing', /Changing a label needs the live connection/.test(note) && (await page.locator(`${shelfSel('hear')} .s-it[data-id="${sample}"]`).count()) === 1 && (await toasts(page)).length === 0, note);
    await page.locator(`${shelfSel('hear')} .s-it[data-id="${sample}"] .s-pick`).click();
    record(n, 'Pick: offline shows the usual notice too', /Picking favourites needs the live connection/.test(await page.locator('#notice').textContent()));
    record(n, 'Offline snapshot: shelves render without errors', (await page.locator('#shelves .shelf').count()) === 7 && errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
}

// ----- keyboard: the label popover is a proper menu
async function menuKeyboardTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
  const row = fxSeedRows(seed).find(r => labelFor(r) === 'hear' && !r[COLS.format]), id = row[COLS.id], sr = await page.evaluate(sheetRow, id);
  const chipSel = `${shelfSel('hear')} .s-it[data-id="${id}"] .s-chip`;
  await expandShelf(page, 'hear');
  await cw(page);
  await page.locator(chipSel).focus();
  await page.keyboard.press('Enter');
  await page.locator('.s-menu').waitFor();
  const m0 = await page.evaluate(() => ({ role: document.querySelector('.s-menu').getAttribute('role'), items: [...document.querySelectorAll('.s-menu button')].map(b => b.getAttribute('role')).join(), exp: document.querySelector('.s-chip[aria-expanded="true"]') !== null, focus: document.activeElement.dataset.k, checked: document.querySelector('.s-menu [aria-checked="true"]').dataset.k }));
  record(n, 'Menu: Enter on the label chip opens a role=menu of radio items, focus on the current label', m0.role === 'menu' && /^(menuitemradio,){5}menuitemradio$/.test(m0.items) && m0.exp && m0.focus === 'hear' && m0.checked === 'hear', JSON.stringify(m0));
  await page.keyboard.press('ArrowDown');
  const a1 = await page.evaluate(() => document.activeElement.dataset.k);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  const a2 = await page.evaluate(() => document.activeElement.dataset.k);
  await page.keyboard.press('End'); const a3 = await page.evaluate(() => document.activeElement.dataset.k);
  await page.keyboard.press('Home'); const a4 = await page.evaluate(() => document.activeElement.dataset.k);
  await page.keyboard.press('ArrowUp'); const a5 = await page.evaluate(() => document.activeElement.dataset.k);
  record(n, 'Menu: ArrowDown/ArrowUp/Home/End move through the labels (and wrap)', a1 === 'heard' && a2 === 'upcoming' && a3 === 'nope' && a4 === 'owned' && a5 === 'nope', [a1, a2, a3, a4, a5].join());
  await page.keyboard.press('Escape');
  const esc = await page.evaluate(() => ({ menu: !!document.querySelector('.s-menu'), onChip: document.activeElement.classList.contains('s-chip'), id: document.activeElement.closest('.s-it') && document.activeElement.closest('.s-it').dataset.id, exp: document.activeElement.getAttribute('aria-expanded') }));
  record(n, 'Menu: Escape closes it and focus returns to the label chip', !esc.menu && esc.onChip && esc.id === id && esc.exp === 'false', JSON.stringify(esc));
  record(n, 'Menu: Escape writes nothing', (await gw(page)).length === 0);
  await page.keyboard.press('Enter');
  await page.locator('.s-menu').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await waitWrites(page, 1); await settle(page);
  const w = await gw(page);
  record(n, 'Menu: Enter on "Heard" moves the album (one Status write)', w.length === 1 && w[0].range === `'🎸'!D${sr}` && w[0].v === 'Listened', JSON.stringify(w));
  const f2 = await page.evaluate(() => { const a = document.activeElement; const it = a.closest && a.closest('.s-it'); return { chip: a.classList.contains('s-chip'), id: it && it.dataset.id, shelf: it && it.dataset.shelf, menu: !!document.querySelector('.s-menu') }; });
  record(n, 'Menu: after Enter the menu is closed and focus is on the chip of the same album on its new shelf', f2.chip && f2.id === id && f2.shelf === 'heard' && !f2.menu, JSON.stringify(f2));
  // Tab leaves the menu
  await page.keyboard.press('Enter');
  await page.locator('.s-menu').waitFor();
  await page.keyboard.press('Tab');
  record(n, 'Menu: Tab closes the menu', (await page.locator('.s-menu').count()) === 0);
  record(n, 'Menu: no console errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();
}

// ----- drag and drop between shelves (laptop pointer)
async function dragTests(browser, vp, seed, url) {
  const n = vp.name;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'collection');
  const rows = fxSeedRows(seed);
  const firstHear = (await shelfIds(page, 'hear')).find(i => !rows.find(r => r[COLS.id] === i)[COLS.format]);   // a sleeve standing on the shelf
  const row = rows.find(r => r[COLS.id] === firstHear), id = firstHear, sr = await page.evaluate(sheetRow, id);
  await cw(page);
  // a real mouse drag: press on the sleeve, move over the Heard shelf, release
  const src = page.locator(`${shelfSel('hear')} .s-it[data-id="${id}"] .s-art`);
  await src.scrollIntoViewIfNeeded();
  let sb = await src.boundingBox();
  const tgtBox = await page.locator(shelfSel('heard')).boundingBox();
  const vh = vp.height;
  if (tgtBox.y + 120 > vh) { await page.evaluate(d => window.scrollBy(0, d), tgtBox.y + 120 - vh + 20); sb = await src.boundingBox(); }
  const tb = await page.locator(shelfSel('heard')).boundingBox();
  await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width / 2 + 12, sb.y + sb.height / 2 + 12, { steps: 4 });
  await page.mouse.move(tb.x + tb.width / 2, Math.min(tb.y + 100, vh - 30), { steps: 14 });
  const over = await page.evaluate(() => !!document.querySelector('.shelf.drop'));
  await page.mouse.up();
  await waitWrites(page, 1); await settle(page);
  let w = await gw(page);
  record(n, 'Drag: dragging a sleeve onto another shelf highlights the shelf while over it', over);
  record(n, 'Drag: dropping To hear → Heard writes the Status cell only', w.length === 1 && w[0].range === `'🎸'!D${sr}` && w[0].v === 'Listened', JSON.stringify(w));
  record(n, 'Drag: the sleeve is on the Heard shelf now and a Moved toast with Undo appears', (await shelfIds(page, 'heard')).includes(id) && !(await shelfIds(page, 'hear')).includes(id) && (await toasts(page)).some(t => t.includes(`Moved ${row[0]} to Heard`) && t.includes('Undo')));
  record(n, 'Drag: the highlight clears after the drop', (await page.locator('.shelf.drop').count()) === 0);

  // the rest use drag events directly (the shelves are too far apart to reach with one mouse path)
  const dnd = async (fromId, toKey, fromShelf) => {
    const dt = await page.evaluateHandle(() => new DataTransfer());
    await page.locator(`${shelfSel(fromShelf)} .s-it[data-id="${fromId}"]`).dispatchEvent('dragstart', { dataTransfer: dt });
    await page.locator(shelfSel(toKey)).dispatchEvent('dragover', { dataTransfer: dt });
    await page.locator(shelfSel(toKey)).dispatchEvent('drop', { dataTransfer: dt });
    await page.evaluate(() => document.dispatchEvent(new Event('dragend', { bubbles: true })));   // the sleeve has usually moved by now
  };
  // a Vinyl (Owned) album cannot be dropped on To hear
  const owned = rows.find(r => r[COLS.status] === 'Listened' && r[COLS.format] === 'Vinyl (Owned)'), oid = owned[COLS.id];
  await cw(page);
  await expandShelf(page, 'owned');
  await dnd(oid, 'hear', 'owned');
  await settle(page);
  const rej = await toasts(page);
  record(n, 'Drag: dropping a Vinyl (Owned) album on To hear is rejected with a message and writes nothing', (await gw(page)).length === 0 && rej.some(t => t.includes(LOCK_MSG)) && (await shelfIds(page, 'owned')).includes(oid), rej.join(' | '));
  // dropping on its own shelf does nothing
  await dnd(oid, 'owned', 'owned'); await settle(page);
  record(n, 'Drag: dropping on the shelf it is already on writes nothing', (await gw(page)).length === 0);
  // dropping on Vinyl wish list is allowed, with the Format pairing
  await dnd(oid, 'wish', 'owned');
  await waitWrites(page, 2); await settle(page);
  const osr = await page.evaluate(sheetRow, oid);
  w = await gw(page);
  record(n, 'Drag: Vinyl (Owned) → Vinyl wish list writes Status and Format', w.map(x => `${x.range}=${x.v}`).sort().join('|') === [`'🎸'!D${osr}=Purchase`, `'🎸'!F${osr}=Vinyl (Wanted)`].sort().join('|'), JSON.stringify(w));
  // dropping on Favourites turns the pick on (one cell)
  await cw(page);
  const plain = rows.find(r => labelFor(r) === 'hear' && !r[COLS.format] && !r[COLS.fav] && r[COLS.id] !== id), pid = plain[COLS.id], psr = await page.evaluate(sheetRow, pid);
  await expandShelf(page, 'hear');
  await dnd(pid, 'fav', 'hear');
  await waitWrites(page, 1); await settle(page);
  w = await gw(page);
  record(n, 'Drag: dropping a sleeve on Favourites writes only the Favourite cell', w.length === 1 && w[0].range === `'🎸'!Q${psr}` && /^\d{4}-\d{2}-\d{2}$/.test(w[0].v), JSON.stringify(w));
  record(n, 'Drag: no write outside 🎸, no console errors', (await allOnTab(page)) && problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();
}

// ----- Home (default state: the listening log hidden)
async function homeDefaultTests(browser, vp, seed, url) {
  const n = vp.name, laptop = vp.width >= 1000;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'home');
  await cw(page);
  const rows = fxSeedRows(seed), want = expectedShelves(seed);
  const heads = (await page.locator('#view-home .panel h2').allTextContents()).map(h => h.trim());
  record(n, 'Home: six panels - Album of the day, Favourites, Upcoming, Something to hear, On this day, Anniversaries', heads.join('|') === 'Album of the day|Favourites|Upcoming|Something to hear|On this day|Anniversaries', heads.join('|'));
  // Album of the day
  const pool = rows.filter(r => Number(r[COLS.rating]) >= 8 && labelFor(r) !== 'nope').map(r => r[0]);
  const aotd = await page.locator('#aotdBox h3').textContent();
  const aBtns = await page.locator('#aotdBox button').allTextContents();
  record(n, 'Home: Album of the day comes from the rated 8+ pool, with a Favourite pick and no "Log a listen today" while the log is hidden', pool.includes(aotd) && aBtns.some(b => /Favourite/.test(b)) && !aBtns.some(b => /Log a listen/.test(b)), `${aotd}: ${aBtns.join(' / ')}`);
  const arow = rows.find(r => r[0] === aotd), asr = await page.evaluate(sheetRow, arow[COLS.id]), todayIso = await page.evaluate(() => today());
  await page.locator('#aotdBox .s-pickbtn').click();
  await waitWrites(page, 1); await settle(page);
  let w = await gw(page);
  record(n, 'Home: the Album of the day pick writes one Favourite cell', w.length === 1 && w[0].range === `'🎸'!Q${asr}` && w[0].v === todayIso && (await page.locator('#aotdBox .s-pickbtn').getAttribute('aria-pressed')) === 'true', JSON.stringify(w));
  record(n, 'Home: and it joins the Favourites shelf on Home, first', (await page.locator('#homeFav .s-it').first().getAttribute('data-id')) === arow[COLS.id]);
  await cw(page);
  await page.locator('#aotdBox .s-pickbtn').click();
  await waitWrites(page, 1); await settle(page);
  w = await gw(page);
  record(n, 'Home: pressing it again writes one empty cell', w.length === 1 && w[0].range === `'🎸'!Q${asr}` && w[0].v === '');
  // Favourites shelf on Home
  const homeFav = await page.evaluate(() => [...document.querySelectorAll('#homeFav .s-it')].map(e => e.dataset.id));
  record(n, 'Home: the Favourites shelf lists the favourites newest first', homeFav.join() === want.fav.join(), `${homeFav.join()} vs ${want.fav.join()}`);
  const hcount = await page.locator('#homeFav .sh-count').textContent();
  record(n, 'Home: the Favourites shelf shows its count', hcount === String(want.fav.length));
  await page.locator('#homeFav [data-sa="seeall"]').click();
  record(n, 'Home: "See all on Collection" switches to the Collection tab', await page.locator('#view-collection').isVisible() && (await page.locator('#tab-collection').getAttribute('aria-selected')) === 'true');
  await page.locator('#tab-home').click();
  // Upcoming
  const up = await page.locator('#upcomingList > li:not(.empty)').allTextContents();
  record(n, 'Home: Upcoming lists four albums with a countdown or year', up.length === 4 && up.some(t => /in 12 days$/.test(t)) && up.some(t => /in 40 days$/.test(t)) && up.some(t => /2027$/.test(t)), up.join(' | '));
  // On this day: releases only while the log is hidden
  const od = await page.locator('#onDayList li').allTextContents();
  record(n, 'Home: On this day shows releases but no plays while the log is hidden', od.some(t => t.includes(`${S4.release} was released 7 years ago today`)) && !od.some(t => /you played/.test(t)), od.join(' | '));
  record(n, 'Home: Anniversaries panel renders', (await page.locator('#annivBox').textContent()).length > 0);
  // Something to hear
  const hearSet = new Set(rows.filter(r => labelFor(r) === 'hear').map(r => r[0]));
  const before = await page.locator('#hearBox').textContent();
  record(n, 'Something to hear: shows a prompt until you ask', /Pick for me/.test(before) && (await page.locator('#hearBox h3').count()) === 0, before);
  const seen = [];
  for (let i = 0; i < 12; i++) {
    await page.locator('#hearPick').click();
    seen.push(await page.locator('#hearBox h3').textContent());
  }
  // the sample plan already has some To hear albums on Up next: keep picking until the card offers a fresh one
  for (let i = 0; i < 40 && await page.evaluate(() => albumByKey(home.hearId).plan === 'Up next'); i++) { await page.locator('#hearPick').click(); seen.push(await page.locator('#hearBox h3').textContent()); }
  record(n, 'Something to hear: "Pick for me" only picks To hear albums', seen.every(t => hearSet.has(t)), seen.join(' | '));
  record(n, 'Something to hear: never the same album twice in a row', seen.every((t, i) => i === 0 || t !== seen[i - 1]) && new Set(seen).size > 2, seen.join(' | '));
  const hc = await page.evaluate(() => ({ chip: document.querySelector('#hearBox .lblchip').textContent, btns: [...document.querySelectorAll('#hearBox button')].map(b => b.textContent.trim()) }));
  record(n, 'Something to hear: the card has the label chip and an Up next button', hc.chip === 'To hear ▾' && hc.btns.includes('Up next'), JSON.stringify(hc));
  const pickedTitle = seen[seen.length - 1], psr = await page.evaluate(sheetRow, rows.find(r => r[0] === pickedTitle)[COLS.id]);
  await cw(page);
  await page.locator('#hearBox button', { hasText: /^Up next$/ }).click();
  await waitSaved(page);
  w = await gw(page);
  record(n, 'Something to hear: Up next writes only the plan cells (K, L, O) of that album', w.length > 0 && w.every(x => [`'🎸'!K${psr}`, `'🎸'!L${psr}`, `'🎸'!O${psr}`].includes(x.range)), JSON.stringify(w.map(x => x.range)));
  record(n, 'Something to hear: the button then reads "On Up next"', await page.locator('#hearBox button', { hasText: 'On Up next' }).isDisabled());
  // the label chip on the card changes the label from Home
  await cw(page);
  await page.locator('#hearBox .lblchip').click();
  await page.locator('.s-menu button[data-k="heard"]').click();
  await waitWrites(page, 1); await settle(page);
  w = await gw(page);
  record(n, 'Something to hear: the label chip moves the album (Status write) from Home', w.length === 1 && w[0].v === 'Listened' && (await page.locator('#hearBox .lblchip').textContent()) === 'Heard ▾', JSON.stringify(w));
  // layout: paired panels share a row and a height
  const pairs = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#view-home .home-grid > .panel')].map(p => p.getBoundingClientRect());
    return [[0, 1], [2, 3]].map(([a, b]) => ({ same: Math.abs(ps[a].top - ps[b].top) <= 2, h: Math.abs(ps[a].height - ps[b].height) <= 2, w: Math.abs(ps[a].width - ps[b].width) <= 2 }));
  });
  if (laptop) record(n, 'Home: the first four panels sit in equal pairs (same row, same height, same width); On this day and Anniversaries are full width', pairs.every(p => p.same && p.h && p.w), JSON.stringify(pairs));
  else record(n, 'Home: panels stack in one column on a phone', await page.evaluate(() => { const ps = [...document.querySelectorAll('#view-home .home-grid > .panel')].map(p => p.getBoundingClientRect()); return ps.every((p, i) => i === 0 || p.top >= ps[i - 1].bottom - 1) && ps.every(p => p.width > innerWidth - 40); }));
  const o = await page.evaluate(overflow);
  record(n, 'Home: no sideways scroll', o.sw <= o.iw, `scrollWidth ${o.sw} vs ${o.iw}`);
  record(n, 'Home: nothing outside 🎸 written, no console errors', (await allOnTab(page)) && problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();
}

// ----- the listening log switch (Tools > Look), tabs, Dashboard tiles
async function logSwitchTests(browser, vp, seed, url) {
  const n = vp.name, laptop = vp.width >= 1000;
  const { context, page, problems } = await freshPage(browser, vp, seed, url, 'tools');
  const rows = fxSeedRows(seed);
  const vis = sel => page.locator(sel).isVisible();
  let labels = await page.locator('nav.tabs .tab:visible').allTextContents();
  record(n, 'Log switch: by default there are five tabs - Home, Collection, Plan, Dashboard, Tools', labels.join() === FIVE.join() && !(await vis('#tab-log')), labels.join());
  record(n, 'Log switch: the Look panel has "Show listening log", off by default, and nothing is stored', (await page.locator('#lookLog').isChecked()) === false && (await page.evaluate(() => localStorage.getItem('sg-showlog'))) === null);
  record(n, 'Log switch: Tools hides Nudges, Goal planner and Year in review, and keeps Lucky dip, Do I own this?, Recommendations and Look', !(await vis('#nudPanel')) && !(await vis('#goalPanel')) && !(await vis('#yirPanel')) && (await vis('#dipH')) && (await vis('#ownH')) && (await vis('#recsH')) && (await vis('#lookH')));
  const dipBtns = await page.locator('#dipCard button').allTextContents();
  record(n, 'Log switch: Lucky dip has no "Log a listen today" while the log is hidden', dipBtns.join() === 'Another,Up next' || dipBtns.join() === 'Another,On Up next', dipBtns.join());
  await page.locator('#recModes .chip[data-m="revisit"]').click();
  const rv = await page.evaluate(() => [...document.querySelectorAll('#recList .rec')].map(r => ({ t: r.querySelector('.t').textContent, acts: [...r.querySelectorAll('.rec-actions button')].map(b => b.textContent) })));
  record(n, 'Log switch: Revisit lists albums rated 9 or 10 with only Open (no logging)', rv.length > 0 && rv.every(x => Number(rows.find(r => r[0] === x.t)[COLS.rating]) >= 9 && x.acts.join() === 'Open'), JSON.stringify(rv.slice(0, 2)));
  const o1 = await page.evaluate(overflow);
  record(n, 'Log switch: Tools (log hidden) has no sideways scroll', o1.sw <= o1.iw, `${o1.sw} vs ${o1.iw}`);

  // Dashboard with the log hidden: nine tiles
  await page.locator('#tab-dashboard').click(); await settle(page);
  const tiles = await page.evaluate(() => [...document.querySelectorAll('#dashTiles .stat')].map(s => ({ k: s.dataset.tile, eb: s.querySelector('.eyebrow').textContent, num: s.querySelector('.num').textContent, sub: s.querySelector('.sub').textContent })));
  const T = Object.fromEntries(tiles.map(t => [t.k, t]));
  record(n, 'Dashboard (log hidden): nine tiles in order - Albums heard, Favourites, Average rating, Owned, Vinyl wish list, Listening backlog, Upcoming, Artists heard, Copied to MP3', tiles.map(t => t.eb).join('|') === 'Albums heard|Favourites|Average rating|Owned|Vinyl wish list|Listening backlog|Upcoming|Artists heard|Copied to MP3', tiles.map(t => t.eb).join('|'));
  const heardRows = rows.filter(r => Number(r[COLS.rating]) > 0 || r[COLS.status] === 'Listened' || r[COLS.status] === 'Owned');
  const ratings = heardRows.map(r => parseFloat(r[COLS.rating])).filter(x => x > 0);
  const count = k => rows.filter(r => labelFor(r) === k).length;
  const vinyl = rows.filter(r => r[COLS.format] === 'Vinyl (Owned)').length;
  const artists = new Set(heardRows.map(r => r[2].trim().toLowerCase()).filter(Boolean)).size;
  const checks = {
    heard: T.heard.num === String(heardRows.length), favs: T.favs.num === '4', avg: T.avg.num === (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1),
    owned: T.owned.num === String(count('owned')) && T.owned.sub === `${vinyl} on vinyl`, wish: T.wish.num === String(count('wish')), backlog: T.backlog.num === String(count('hear')),
    upcoming: T.upcoming.num === String(count('upcoming')) && /next in 12 days/.test(T.upcoming.sub), artists: T.artists.num === String(artists), copied: T.copied.num === '4'
  };
  record(n, 'Dashboard (log hidden): tile numbers match the sheet (checked independently)', Object.values(checks).every(Boolean), JSON.stringify(checks) + ' ' + JSON.stringify(tiles.map(t => t.num)));
  const hid = await page.evaluate(() => ['dashPeriods', 'monthPanel', 'heatPanel', 'artPlaysCol'].map(id => document.getElementById(id).getBoundingClientRect().height === 0));
  record(n, 'Dashboard (log hidden): listens per month, the listening calendar, the year picker and "most plays" are hidden', hid.every(Boolean), hid.join());
  const shownPanels = await page.evaluate(() => [...document.querySelectorAll('#view-dashboard .panel')].filter(p => p.getBoundingClientRect().height > 0).map(p => p.querySelector('h2').textContent));
  record(n, 'Dashboard (log hidden): Ratings, Genres, Decades, Formats and Top artists remain', ['Ratings', 'Genres', 'Decades', 'Formats & ownership', 'Top artists'].every(h => shownPanels.includes(h)) && shownPanels.length === 5, shownPanels.join());
  const layout = await page.evaluate(() => {
    const els = [...document.querySelectorAll('#dashTiles .stat')], box = document.getElementById('dashTiles').getBoundingClientRect(), rowsM = new Map();
    for (const e of els) { const r = e.getBoundingClientRect(); const k = Math.round(r.top); (rowsM.get(k) || rowsM.set(k, []).get(k)).push(r); }
    const rs = [...rowsM.values()];
    const pr = [...document.querySelectorAll('#view-dashboard .dash-2 > .panel')].filter(p => p.getBoundingClientRect().height > 0).map(p => ({ full: p.classList.contains('full'), r: p.getBoundingClientRect() }));
    return { rows: rs.map(r => r.length), cover: rs.every(r => Math.abs(r[0].left - box.left) <= 2 && Math.abs(r[r.length - 1].right - box.right) <= 2), lastW: els[els.length - 1].getBoundingClientRect().width, boxW: box.width, panels: pr.map(p => p.full) };
  });
  if (laptop) record(n, 'Dashboard (log hidden): tiles form a 3x3 grid on a laptop', layout.rows.join() === '3,3,3' && layout.cover, JSON.stringify(layout));
  else record(n, 'Dashboard (log hidden): tiles are two columns on a phone with the ninth spanning', layout.rows.join() === '2,2,2,2,1' && layout.lastW >= layout.boxW - 2, JSON.stringify(layout));
  const pairsOk = await page.evaluate(() => { const ps = [...document.querySelectorAll('#view-dashboard .dash-2 > .panel')].filter(p => p.getBoundingClientRect().height > 0 && !p.classList.contains('full')); return ps.every((p, i) => i % 2 || !ps[i + 1] || Math.abs(p.getBoundingClientRect().height - ps[i + 1].getBoundingClientRect().height) <= 2) && ps.length % 2 === 0; });
  if (laptop) record(n, 'Dashboard (log hidden): half-width panels come in equal pairs (no orphan)', pairsOk);
  const o2 = await page.evaluate(overflow);
  record(n, 'Dashboard (log hidden): no sideways scroll', o2.sw <= o2.iw, `${o2.sw} vs ${o2.iw}`);

  // switch it on
  await page.locator('#tab-tools').click();
  await page.locator('#lookLog').check();
  await settle(page);
  labels = await page.locator('nav.tabs .tab:visible').allTextContents();
  record(n, 'Log switch: turning it on adds the Log tab after Collection', labels.join() === SIX.join(), labels.join());
  record(n, 'Log switch: it is remembered in sg-showlog', (await page.evaluate(() => localStorage.getItem('sg-showlog'))) === '1');
  record(n, 'Log switch: Nudges, Goal planner and Year in review come back', (await vis('#nudPanel')) && (await vis('#goalPanel')) && (await vis('#yirPanel')) && (await page.locator('#nudgeBox').textContent()).length > 0);
  const dipBtns2 = await page.locator('#dipCard button').allTextContents();
  record(n, 'Log switch: Lucky dip gets "Log a listen today" back', dipBtns2.includes('Log a listen today'), dipBtns2.join());
  await page.locator('#tab-log').click();
  record(n, 'Log switch: the Log tab shows the log form', (await vis('#view-log')) && (await vis('#lgSave')));
  await page.locator('#tab-dashboard').click(); await settle(page);
  const t2 = await page.locator('#dashTiles .stat').evaluateAll(els => els.map(e => e.dataset.tile));
  record(n, 'Log switch: Dashboard goes back to the log tiles and panels', t2.includes('plays') && t2.includes('logged') && !t2.includes('favs') && (await vis('#monthPanel')) && (await vis('#heatPanel')) && (await vis('#dashPeriods')));
  await page.locator('#tab-home').click();
  record(n, 'Log switch: Home gets "Log a listen today" on the Album of the day and plays in On this day', (await page.locator('#aotdBox button', { hasText: 'Log a listen today' }).count()) === 1);
  await page.reload();
  await page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
  record(n, 'Log switch: stays on after a reload', (await vis('#tab-log')) && (await page.locator('#lookLog').isChecked()));
  // and off again
  await page.locator('#tab-tools').click();
  await page.locator('#lookLog').uncheck();
  record(n, 'Log switch: turning it off hides the tab again', !(await vis('#tab-log')) && (await page.evaluate(() => localStorage.getItem('sg-showlog'))) === '0');
  record(n, 'Log switch: changing it writes nothing to the sheet, no console errors', (await gw(page)).length === 0 && problems.length === 0, problems.slice(0, 2).join(' | '));
  await context.close();
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

async function openContext(browser, vp, seed, { blockChart = false, reducedMotion, showLog = false, touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, ...(reducedMotion ? { reducedMotion } : {}), ...(touch ? { hasTouch: true, isMobile: vp.width < 560 } : {}) });
  await context.clock.install({ time: RUN_START });
  let externalBlocked = 0;
  await context.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    if (u === CHART_URL && HAVE_CHART && !blockChart) return route.fulfill({ path: CHART_LOCAL, contentType: 'application/javascript' });
    externalBlocked++;               // no network in the test: other CDN scripts and fonts are refused
    return route.abort();
  });
  await context.addInitScript(installStub, seed);
  // The listening log is hidden by default; tests that exercise it switch it on the way a person does (Tools > Look)
  if (showLog) await context.addInitScript(() => { try { localStorage.setItem('sg-showlog', '1'); } catch (e) {} });
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

async function runViewport(browser, vp, seed, seedL, wrapperUrl, rawUrl) {
  console.log(`\n[${vp.name} ${vp.width}x${vp.height}]`);
  const only = (process.env.SMOKE_ONLY || '').split(',').filter(Boolean);
  const run = (name, fn) => (!only.length || only.includes(name)) ? fn() : null;

  // A. the page as a person first sees it: listening log hidden
  if (!only.length || only.includes('tabs')) {
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
    record(vp.name, 'tabs: Home, Collection, Plan, Dashboard, Tools (no Log tab by default)', bar.tabs.map(t => t.label).join() === FIVE.join(), bar.tabs.map(t => t.label).join());
    record(vp.name, 'Home is the tab shown on load', (await page.locator('#tab-home').getAttribute('aria-selected')) === 'true' && await page.locator('#view-home').isVisible());

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
    const forbidden = await page.evaluate(() => window.__forbidden);
    record(vp.name, 'no access outside 🎸 tabs (window.__forbidden empty)', forbidden.length === 0, forbidden.length ? JSON.stringify(forbidden.slice(0, 3)) : '');
    record(vp.name, 'visiting every tab writes nothing to the sheet', (await page.evaluate(() => window.__writes.length)) === 0);
    record(vp.name, 'no console errors or uncaught exceptions during the run', problems.length === 0, problems.slice(0, 3).join(' | '));
    void externalBlocked;
    await context.close();
  }

  // B. with the listening log switched on: the Dashboard log panels and the Plan tab, as before
  if (!only.length || only.includes('dash')) {
    const { context, page, problems } = await openContext(browser, vp, seed, { showLog: true });
    await page.goto(wrapperUrl);
    await page.waitForLoadState('load');
    await page.waitForFunction(() => document.getElementById('statusText').textContent.startsWith('Live'), null, { timeout: 8000 });
    await page.waitForTimeout(300);
    await dashTests(page, vp, seed);
    await planTests(page, vp);
    const forbidden = await page.evaluate(() => window.__forbidden);
    record(vp.name, 'with the log on: no access outside 🎸 tabs', forbidden.length === 0, forbidden.length ? JSON.stringify(forbidden.slice(0, 3)) : '');
    record(vp.name, 'with the log on: no console errors or uncaught exceptions during the run', problems.length === 0, problems.slice(0, 3).join(' | '));
    const writes = await page.evaluate(() => window.__writes);
    console.log(`  info  ${writes.length} sheet write call(s) recorded during the run`);
    await context.close();
  }

  await run('dashlog', () => dashEmptyLogTest(browser, vp, seed, wrapperUrl));
  await run('dashlog', () => dashNoChartTest(browser, vp, seed, wrapperUrl));
  await run('connect', () => connectTest(browser, vp, seed, rawUrl));
  await run('tools', () => toolsTests(browser, vp, seed, wrapperUrl));
  await run('tools', () => goalTests(browser, vp, seed, wrapperUrl));
  await run('home', () => homeTests(browser, vp, seed, wrapperUrl));
  await run('home', () => homeDefaultTests(browser, vp, seed, wrapperUrl));
  await run('collection', () => collectionTests(browser, vp, seed, wrapperUrl));
  await run('relabel', () => relabelTests(browser, vp, seed, seedL, wrapperUrl));
  await run('undo', () => undoTests(browser, vp, seed, seedL, wrapperUrl));
  await run('pick', () => pickTests(browser, vp, seed, seedL, wrapperUrl));
  await run('menu', () => menuKeyboardTests(browser, vp, seed, wrapperUrl));
  await run('dnd', () => dragTests(browser, vp, seed, wrapperUrl));
  await run('stack', () => stackTests(browser, vp, seed, wrapperUrl));
  await run('inc', () => incTests(browser, vp, seed, seedL, wrapperUrl));
  await run('log', () => logSwitchTests(browser, vp, seed, wrapperUrl));
  await run('tracks', () => tracksTests(browser, vp, seed, wrapperUrl));
  await run('look', () => lookTests(browser, vp, seed, wrapperUrl));
  await run('layout', () => layoutTests(browser, vp, seed, wrapperUrl));
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
    const seed = buildSeed(), seedL = buildSeed({ labelled: true });   // seedL: the sheet also has a Labelled column
    for (const vp of VIEWPORTS) {
      await runViewport(browser, vp, seed, seedL, pathToFileURL(wrapperPath).href, pathToFileURL(rawPath).href);
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
