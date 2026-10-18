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
  { name: 'laptop', width: 1366, height: 900 },
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
