// app.js: screens and navigation. All text reaches the page through textContent (no innerHTML).
import { HEROES, MODES } from './heroes.js';
import { summarise, byHero, fmt } from './stats.js';
import { cleanMatch, byNewest, todayIso } from './model.js';
import * as db from './db.js';
import { importFile, warmUp } from './importer.js';
import { makeBackup, deliverBackup, readBackup } from './backup.js';

export const DISCLAIMER = 'This content is not affiliated, endorsed, sponsored or approved by Super Evil Megacorp.';

/* ---------- tiny DOM helper ---------- */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

/* ---------- state ---------- */
const DEFAULT_SETTINGS = { username: '', defaultMode: MODES[0], lastHero: '', lastMode: '', lastBackupAt: '', savesSinceBackup: 0 };
const NUDGE_AFTER = 10;
const state = {
  matches: [],
  settings: { ...DEFAULT_SETTINGS },
  draft: null,        // the match on the check / edit screen
  imported: null,     // last reader result and row crops, for the row picker
  importing: null,    // { status: 'reading' | 'error', ... }
  storageError: null,
};

const view = document.getElementById('view');
const toast = document.getElementById('toast');

function showToast(message, actionLabel, action) {
  const kids = [h('span', { text: message })];
  if (actionLabel) kids.push(h('button', { class: 'btn btn-quiet', type: 'button', text: actionLabel, onclick: () => { toast.hidden = true; action(); } }));
  toast.replaceChildren(...kids);
  toast.hidden = false;
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => { toast.hidden = true; }, 6000);
}

const dateLabel = iso => new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const kdaNode = (k, d, a) => h('span', { class: 'kda' }, String(k), h('span', { class: 'sep', text: '/' }), String(d), h('span', { class: 'sep', text: '/' }), String(a));
const go = (hash, replace) => { if (replace) location.replace(hash); else location.hash = hash; };

async function saveSettings() {
  try { await db.putSettings(state.settings); } catch { showToast('Could not save settings on this phone.'); }
}
async function reloadMatches() { state.matches = (await db.allMatches()).sort(byNewest); }

/* ---------- Matches ---------- */
function pickScreenshot() { document.getElementById('pick').click(); }

function matchesScreen(params) {
  const played = byHero(state.matches).sort((x, y) => x.hero.localeCompare(y.hero));
  let hero = params.get('hero');
  if (hero && !played.some(p => p.hero === hero)) hero = null;
  const list = hero ? state.matches.filter(m => m.hero === hero) : state.matches;
  const s = summarise(list);

  const actions = h('div', { class: 'actions' }, h('div', { class: 'stack' },
    h('button', { class: 'btn btn-primary', type: 'button', text: 'Import screenshot', onclick: pickScreenshot }),
    h('button', { class: 'btn btn-quiet', type: 'button', text: 'Enter a match by hand', onclick: () => openDraft(newDraft()) })));

  if (!state.matches.length) {
    return [h('h1', { text: 'Matches' }),
      state.storageError ? h('p', { class: 'banner', text: state.storageError }) : null,
      h('div', { class: 'empty' },
        h('h2', { text: 'No matches yet' }),
        h('p', { class: 'muted', text: 'After a game, screenshot the end-of-match screen and import it here. Your stats are read on this phone and stay on it.' })),
      actions];
  }

  const filter = played.length > 1 ? h('label', { class: 'field filter' }, h('span', { text: 'Hero' }),
    h('select', { name: 'hero-filter', onchange: e => go(e.target.value ? '#matches?hero=' + encodeURIComponent(e.target.value) : '#matches') },
      h('option', { value: '', text: `All heroes (${state.matches.length})`, selected: !hero }),
      played.map(p => h('option', { value: p.hero, text: `${p.hero} (${p.games})`, selected: p.hero === hero })))) : null;

  const unsaved = state.settings.savesSinceBackup || 0;
  const nudge = unsaved >= NUDGE_AFTER ? h('div', { class: 'nudge' },
    h('p', { text: `${unsaved} matches since your last backup. They are only on this phone.` }),
    h('button', { class: 'btn btn-secondary', type: 'button', text: 'Save a backup file', onclick: doBackup })) : null;
  return [h('h1', { text: 'Matches' }),
    nudge,
    filter,
    h('dl', { class: 'summary' },
      h('div', {}, h('dt', { text: 'Win rate' }), h('dd', { class: 'big', text: fmt.pct(s.winRate) })),
      h('div', {}, h('dt', { text: 'Record' }), h('dd', { text: `${s.wins}W ${s.losses}L` })),
      h('div', {}, h('dt', { text: 'Average K/D/A' }), h('dd', {}, kdaNode(fmt.one(s.k), fmt.one(s.d), fmt.one(s.a))))),
    h('ul', { class: 'matches' }, list.map(m => h('li', { class: 'match' },
      h('button', { type: 'button', onclick: () => openDraft(draftFrom(m)), 'aria-label': `${m.win ? 'Win' : 'Loss'}, ${m.hero}, ${m.k} ${m.d} ${m.a}, ${dateLabel(m.date)}. Edit` },
        h('span', { class: 'result ' + (m.win ? 'win' : 'loss'), text: m.win ? 'W' : 'L' }),
        h('span', {}, h('span', { class: 'hero', text: m.hero }), h('br'), h('span', { class: 'meta', text: [m.mode, dateLabel(m.date), m.duration].filter(Boolean).join(' · ') })),
        kdaNode(m.k, m.d, m.a))))),
    actions];
}

/* ---------- Import ---------- */
// Android share sheet: the service worker left the picture in a cache for us.
async function takeShared() {
  try {
    const cache = await caches.open('postmatch-share');
    const res = await cache.match('shared-image');
    await cache.delete('shared-image');
    if (res) { const blob = await res.blob(); return onPicked(new File([blob], 'shared-screenshot', { type: blob.type })); }
  } catch { /* fall through */ }
  go('#matches', true);
}
function sharedScreen() {
  takeShared();
  return [h('h1', { text: 'Reading the screenshot' })];
}

const IMPORT_ERRORS = {
  small: w => `This picture is ${w} pixels wide, too small to read. Chat apps shrink pictures, so import the original screenshot from your Photos.`,
  big: () => 'This picture is too large to read. Import the screenshot itself.',
  type: () => 'That file is not a picture. Choose the screenshot from your Photos.',
  decode: () => 'This phone could not open that picture. Try taking the screenshot again.',
  'no-panel': () => 'Could not find the match results in this picture. Import a screenshot of the end-of-match screen.',
  'no-header': () => 'Could not find the match results in this picture. Import a screenshot of the end-of-match screen.',
  'no-rows': () => 'Could not find the player rows in this picture. Import a screenshot of the end-of-match screen.',
  engine: () => 'The reader did not start. Close Postmatch, open it again and retry.',
};

async function onPicked(file) {
  if (!file) return;
  state.importing = { status: 'reading' };
  go('#import');
  const out = await importFile(file, { username: state.settings.username });
  if (out.error) {
    state.importing = { status: 'error', message: (IMPORT_ERRORS[out.error] || IMPORT_ERRORS['no-panel'])(out.width) };
    if (location.hash.startsWith('#import')) render();
    return;
  }
  if (state.imported) state.imported.strips.forEach(u => u && URL.revokeObjectURL(u));
  state.imported = out;
  state.importing = null;
  const r = out.res;
  if (r.playerRow === null) go('#pick', true);
  else { openDraft(draftFromRow(r.playerRow), true); }
}

function importScreen() {
  const st = state.importing;
  if (!st) { go('#matches', true); return []; }
  if (st.status === 'reading') {
    return [h('h1', { text: 'Reading the screenshot' }),
      h('p', { class: 'muted', role: 'status', text: 'This takes a few seconds, longer the first time. Everything happens on this phone.' })];
  }
  return [h('h1', { text: 'Could not read that screenshot' }),
    h('p', { text: st.message }),
    h('div', { class: 'stack' },
      h('button', { class: 'btn btn-primary', type: 'button', text: 'Choose another screenshot', onclick: pickScreenshot }),
      h('button', { class: 'btn btn-secondary', type: 'button', text: 'Enter the match by hand', onclick: () => openDraft(newDraft(), true) }),
      h('a', { class: 'btn btn-quiet', href: '#matches', text: 'Cancel' }))];
}

// Mode: Blitz is recognised from the screen. Otherwise keep the last mode if it fits
// the team size, else the usual mode if it fits, else the ranked mode for that size.
function guessMode(r) {
  if (r.layout === 'p') return { mode: 'Blitz', sure: true };
  const size = r.mode === '3v3' ? '3V3' : r.mode === '5v5' ? '5V5' : null;
  const fits = m => m && (!size || m.startsWith(size) || m === 'ARAL') && m !== 'Blitz';
  for (const m of [state.settings.lastMode, state.settings.defaultMode]) if (fits(m) && MODES.includes(m)) return { mode: m, sure: !!size && m.startsWith(size) };
  return { mode: size ? `${size} Ranked` : state.settings.defaultMode, sure: false };
}

function draftFromRow(index) {
  const r = state.imported.res, row = r.rows[index];
  const unsure = {};
  const shaky = f => !f || !f.ok || (typeof f.conf === 'number' && f.conf < 80);
  const d = newDraft();
  Object.assign(d, { source: 'screenshot', rowIndex: index, strip: state.imported.strips[index], otherRows: r.rows.length > 1 });
  d.win = r.result === 'win';
  if (r.resultMargin < 25) unsure.win = true;
  if (row.kda.ok) { d.k = row.kda.k; d.d = row.kda.d; d.a = row.kda.a; }
  if (shaky(row.kda)) Object.assign(unsure, { k: true, d: true, a: true });
  if (r.checks && r.checks[row.side] === false) unsure.k = true;   // team score does not add up
  if (row.gold) { d.gold = row.gold.raw.replace(/k$/, ''); if (shaky(row.gold)) unsure.gold = true; }
  if (row.minions) { d.minions = row.minions.raw; if (shaky(row.minions)) unsure.minions = true; }
  if (row.points) { d.points = row.points.raw; if (shaky(row.points)) unsure.points = true; }
  if (r.duration && r.duration.raw) { d.duration = r.duration.raw; if (shaky(r.duration)) unsure.duration = true; }
  const gm = guessMode(r);
  d.mode = gm.mode;
  if (!gm.sure) unsure.mode = true;
  if (row.faded) Object.assign(unsure, { k: true, d: true, a: true });
  if (row.team === 'red') unsure.win = true;   // the player picked a row on the other team
  d.unsure = unsure;
  return d;
}

function pickScreen() {
  const imp = state.imported;
  if (!imp) { go('#matches', true); return []; }
  const r = imp.res;
  const blue = r.rows.map((row, i) => ({ row, i })).filter(x => !r.blueSide || x.row.team === 'blue');
  const rows = state.showAllRows ? r.rows.map((row, i) => ({ row, i })) : blue;
  return [h('h1', { text: 'Which row is yours?' }),
    h('p', { class: 'muted', text: r.itemsView
      ? 'This screenshot shows items, so your row could not be spotted. Tap your row. Adding your in-game name in Settings lets Postmatch find it next time.'
      : 'Tap your row.' }),
    h('div', { class: 'stack' }, rows.map(({ row, i }) => h('button', { class: 'rowpick', type: 'button', onclick: () => openDraft(draftFromRow(i), true),
      'aria-label': `${row.name && row.name.text ? row.name.text + ', ' : ''}K/D/A ${row.kda.raw || 'not read'}` },
      imp.strips[i] ? h('img', { src: imp.strips[i], alt: '' }) : h('span', { text: `K/D/A ${row.kda.raw || 'not read'}` })))),
    h('div', { class: 'stack after' },
      !state.showAllRows && blue.length < r.rows.length ? h('button', { class: 'btn btn-secondary', type: 'button', text: 'Show the other team too', onclick: () => { state.showAllRows = true; render(); } }) : null,
      h('a', { class: 'btn btn-quiet', href: '#matches', text: 'Cancel' }))];
}

/* ---------- Check / edit / manual entry: one form ---------- */
function newDraft() {
  return { id: null, date: todayIso(), hero: state.settings.lastHero || '', mode: state.settings.lastMode || state.settings.defaultMode, modeOther: '', win: null, k: '', d: '', a: '', gold: '', minions: '', points: '', duration: '', note: '', unsure: {}, errors: {}, source: 'manual' };
}
function draftFrom(m) {
  const custom = !MODES.includes(m.mode);
  const str = v => (v === undefined || v === null ? '' : String(v));
  return { ...newDraft(), id: m.id, date: m.date, hero: m.hero, mode: custom ? 'Other' : m.mode, modeOther: custom ? m.mode : '', win: m.win,
    k: str(m.k), d: str(m.d), a: str(m.a), gold: m.gold === undefined ? '' : m.gold.toFixed(1), minions: str(m.minions), points: str(m.points),
    duration: str(m.duration), note: str(m.note), source: 'edit' };
}
function openDraft(d, replace) { state.draft = d; state.showAllRows = false; go('#match', replace); if (location.hash === '#match') render(); }

function fieldClass(d, key) { return d.errors && d.errors[key] ? ' invalid' : d.unsure && d.unsure[key] ? ' unsure' : ''; }
function fieldNote(d, key) {
  const text = d.errors && d.errors[key] ? d.errors[key] : d.unsure && d.unsure[key] ? 'Check this' : '';
  return h('span', { class: 'note', id: `note-${key}`, text });
}
function textField(label, key, d, attrs = {}) {
  return h('label', { class: 'field' + fieldClass(d, key) },
    h('span', { text: label }),
    h('input', { name: key, autocomplete: 'off', value: d[key] ?? '', 'aria-describedby': `note-${key}`, 'aria-invalid': d.errors && d.errors[key] ? 'true' : null, oninput: e => { d[key] = e.target.value; }, ...attrs }),
    fieldNote(d, key));
}
const numField = (label, key, d, decimal) => textField(label, key, d, { class: 'num', inputMode: decimal ? 'decimal' : 'numeric' });

async function saveDraft(d) {
  const { match, errors } = cleanMatch(d);
  d.errors = errors;
  if (Object.keys(errors).length) {
    render();
    const first = view.querySelector('[aria-invalid="true"], .invalid input, .invalid select');
    if (first) first.focus();
    return;
  }
  try {
    const id = await db.putMatch(match);
    state.settings.lastHero = match.hero;
    if (!d.id) state.settings.savesSinceBackup = (state.settings.savesSinceBackup || 0) + 1;
    if (MODES.includes(match.mode)) state.settings.lastMode = match.mode;
    await saveSettings();
    await reloadMatches();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    state.draft = null;
    go('#matches', true);
    showToast(d.id ? 'Changes saved' : 'Match saved');
    return id;
  } catch {
    showToast('Could not save on this phone. Free some space and try again.');
  }
}

async function deleteDraft(d) {
  const saved = state.matches.find(m => m.id === d.id);
  if (!saved) return;
  try {
    await db.deleteMatch(d.id);
    await reloadMatches();
    state.draft = null;
    go('#matches', true);
    showToast('Match deleted', 'Undo', async () => { await db.putMatch(saved); await reloadMatches(); render(); });
  } catch {
    showToast('Could not delete. Try again.');
  }
}

function matchScreen() {
  const d = state.draft;
  if (!d) { go('#matches', true); return []; }
  const fromShot = d.source === 'screenshot';
  const blitz = d.mode === 'Blitz';
  const title = d.id ? 'Edit match' : fromShot ? 'Check the match' : 'Add a match';
  const unsureCount = Object.keys(d.unsure || {}).length;
  const errorCount = Object.keys(d.errors || {}).length;
  const durationField = textField('Length (optional)', 'duration', d, { inputMode: 'numeric', placeholder: 'mm:ss' });

  const form = h('form', { novalidate: true, id: 'match-form', onsubmit: e => { e.preventDefault(); saveDraft(d); } },
    fromShot && d.strip ? h('figure', { class: 'strip' }, h('img', { src: d.strip, alt: 'Your row, cut from the screenshot' }), h('figcaption', { text: 'Your row in the screenshot. Compare it with the numbers below.' })) : null,
    errorCount ? h('p', { class: 'banner invalid-banner', role: 'alert', text: errorCount === 1 ? 'One field needs fixing before this can be saved.' : `${errorCount} fields need fixing before this can be saved.` })
      : fromShot && unsureCount ? h('p', { class: 'banner', text: unsureCount === 1 ? 'One value was hard to read. It is marked “Check this”.' : `${unsureCount} values were hard to read. They are marked “Check this”.` }) : null,

    h('fieldset', { class: fieldClass(d, 'win').trim() }, h('legend', { text: 'Result' }),
      h('div', { class: 'seg' },
        h('label', {}, h('input', { type: 'radio', name: 'win', value: '1', checked: d.win === true, onchange: () => { d.win = true; } }), h('span', { class: 'win', text: 'Win' })),
        h('label', {}, h('input', { type: 'radio', name: 'win', value: '0', checked: d.win === false, onchange: () => { d.win = false; } }), h('span', { class: 'loss', text: 'Loss' }))),
      fieldNote(d, 'win')),

    h('div', { class: 'pair' },
      h('label', { class: 'field' + fieldClass(d, 'hero') }, h('span', { text: 'Hero' }),
        h('select', { name: 'hero', 'aria-invalid': d.errors && d.errors.hero ? 'true' : null, onchange: e => { d.hero = e.target.value; } },
          h('option', { value: '', text: 'Choose a hero' }), HEROES.map(n => h('option', { value: n, text: n, selected: n === d.hero }))),
        fieldNote(d, 'hero')),
      h('label', { class: 'field' + fieldClass(d, 'mode') }, h('span', { text: 'Mode' }),
        h('select', { name: 'mode', onchange: e => { d.mode = e.target.value; render(); } },
          [...MODES, 'Other'].map(n => h('option', { value: n, text: n, selected: n === d.mode }))),
        fieldNote(d, 'mode'))),
    d.mode === 'Other' ? textField('Mode name', 'modeOther', d, { maxLength: 30 }) : null,

    h('div', { class: 'trio field' }, numField('Kills', 'k', d), numField('Deaths', 'd', d), numField('Assists', 'a', d)),
    blitz
      ? h('div', { class: 'pair' }, numField('Points (optional)', 'points', d), durationField)
      : h('div', { class: 'pair' }, numField('Gold, k (optional)', 'gold', d, true), numField('Minions (optional)', 'minions', d)),
    h('div', { class: 'pair' },
      blitz ? null : durationField,
      h('label', { class: 'field' + fieldClass(d, 'date') }, h('span', { text: 'Date' }), h('input', { type: 'date', name: 'date', value: d.date, max: todayIso(), onchange: e => { d.date = e.target.value; } }), fieldNote(d, 'date'))),
    h('label', { class: 'field' + fieldClass(d, 'note') }, h('span', { text: 'Note (optional)' }), h('textarea', { name: 'note', maxLength: 280, value: d.note, oninput: e => { d.note = e.target.value; } }), fieldNote(d, 'note')),

    h('div', { class: 'savebar' }, h('button', { class: 'btn btn-primary', type: 'submit', text: d.id ? 'Save changes' : 'Save match' })),
    h('div', { class: 'stack' },
      fromShot && d.otherRows ? h('button', { class: 'btn btn-secondary', type: 'button', text: 'Not your row? Pick another', onclick: () => go('#pick') }) : null,
      d.id ? h('button', { class: 'btn btn-danger', type: 'button', text: 'Delete match', onclick: () => deleteDraft(d) }) : null,
      h('a', { class: 'btn btn-quiet', href: '#matches', text: 'Cancel' })));
  return [h('h1', { text: title }), form];
}

/* ---------- Stats ---------- */
function statsScreen() {
  const s = summarise(state.matches);
  if (!s.games) return [h('h1', { text: 'Stats' }), h('div', { class: 'empty' }, h('h2', { text: 'Nothing to add up yet' }), h('p', { class: 'muted', text: 'Your win rate and K/D/A appear here after your first saved match.' }), h('a', { class: 'btn btn-primary', href: '#matches', text: 'Go to Matches' }))];
  const partial = a => (a && a.n < s.games ? ` (${a.n} of ${s.games} matches)` : '');
  return [h('h1', { text: 'Stats' }),
    h('dl', { class: 'figures' },
      h('div', { class: 'wide' }, h('dt', { text: `Win rate over ${s.games} ${s.games === 1 ? 'match' : 'matches'}` }), h('dd', { text: fmt.pct(s.winRate) })),
      h('div', {}, h('dt', { text: 'Record' }), h('dd', { text: `${s.wins}W ${s.losses}L` })),
      h('div', {}, h('dt', { text: 'Average K/D/A' }), h('dd', {}, kdaNode(fmt.one(s.k), fmt.one(s.d), fmt.one(s.a)))),
      s.gold ? h('div', {}, h('dt', { text: 'Average gold' + partial(s.gold) }), h('dd', { text: fmt.gold(s.gold) })) : null,
      s.minions ? h('div', {}, h('dt', { text: 'Average minion kills' + partial(s.minions) }), h('dd', { text: fmt.one(s.minions) })) : null),
    h('h2', { text: 'By hero' }),
    h('p', { class: 'small muted', text: 'Tap a hero to see those matches.' }),
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Hero' }), h('th', { scope: 'col', text: 'Games' }), h('th', { scope: 'col', text: 'Wins' }), h('th', { scope: 'col', text: 'Avg K/D/A' }))),
      h('tbody', {}, byHero(state.matches).map(r => h('tr', {},
        h('td', {}, h('a', { class: 'herolink', href: '#matches?hero=' + encodeURIComponent(r.hero), text: r.hero })),
        h('td', { class: 'num', text: String(r.games) }), h('td', { class: 'num', text: fmt.pct(r.winRate) }),
        h('td', { class: 'num' }, kdaNode(fmt.one(r.k), fmt.one(r.d), fmt.one(r.a)))))))];
}

/* ---------- Settings ---------- */
function settingsScreen() {
  const st = state.settings;
  return [h('h1', { text: 'Settings' }),
    h('label', { class: 'field' }, h('span', { text: 'Your in-game name' }),
      h('input', { name: 'username', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, maxLength: 40, value: st.username, onchange: e => { st.username = e.target.value.replace(/[\u0000-\u001f\u007f]/g, '').trim(); saveSettings(); } }),
      h('span', { class: 'small muted', text: 'Used to find your row in a screenshot.' })),
    h('label', { class: 'field' }, h('span', { text: 'Usual mode' }),
      h('select', { name: 'defaultMode', onchange: e => { st.defaultMode = e.target.value; saveSettings(); } }, MODES.map(n => h('option', { value: n, text: n, selected: n === st.defaultMode })))),
    h('h2', { text: 'Backup' }),
    h('p', { class: 'muted', text: 'Your matches live only on this phone. Removing Postmatch from your Home Screen deletes them. Save a backup file now and then, and use it to move to a new phone.' }),
    h('p', { class: 'small muted', text: st.lastBackupAt ? `Last backup: ${new Date(st.lastBackupAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : 'No backup saved yet.' }),
    h('div', { class: 'stack' },
      h('button', { class: 'btn btn-secondary', type: 'button', text: 'Save a backup file', onclick: doBackup }),
      h('button', { class: 'btn btn-secondary', type: 'button', text: 'Restore from a backup file', onclick: () => document.getElementById('restore-pick').click() })),
    h('h2', { text: 'Help' }),
    h('div', { class: 'stack' }, h('a', { class: 'btn btn-secondary', href: 'guide.html', text: 'How to use Postmatch' })),
    h('div', { class: 'legal' },
      h('p', { text: DISCLAIMER }),
      h('p', { text: 'Built by Phoenix Applications & Automations' }))];
}

/* ---------- Backup and restore ---------- */
async function doBackup() {
  if (!state.matches.length) { showToast('There are no matches to back up yet.'); return; }
  const { file, count } = makeBackup(state.matches, state.settings);
  const how = await deliverBackup(file);
  if (how === 'cancelled') return;
  state.settings.lastBackupAt = new Date().toISOString();
  state.settings.savesSinceBackup = 0;
  await saveSettings();
  render();
  showToast(how === 'shared' ? `Backup of ${count} matches ready` : `Backup of ${count} matches downloaded`);
}

async function onRestorePicked(file) {
  if (!file) return;
  state.restore = await readBackup(file);
  go('#restore');
}

async function applyRestore() {
  const r = state.restore;
  if (!r || !r.ok) return;
  try {
    const newest = r.matches.slice().sort(byNewest)[0];
    const settings = { ...state.settings, ...r.settings, lastHero: newest ? newest.hero : '', lastMode: newest && MODES.includes(newest.mode) ? newest.mode : '', savesSinceBackup: 0 };
    await db.replaceAll(r.matches, settings);
    state.settings = settings;
    await reloadMatches();
    state.restore = null;
    go('#matches', true);
    showToast(`Restored ${r.matches.length} matches`);
  } catch {
    showToast('Could not restore on this phone. Nothing was changed.');
  }
}

function restoreScreen() {
  const r = state.restore;
  if (!r) { go('#settings', true); return []; }
  if (!r.ok) {
    return [h('h1', { text: 'Could not restore' }), h('p', { text: r.message }),
      h('div', { class: 'stack' },
        h('button', { class: 'btn btn-secondary', type: 'button', text: 'Choose another file', onclick: () => document.getElementById('restore-pick').click() }),
        h('a', { class: 'btn btn-quiet', href: '#settings', text: 'Cancel' }))];
  }
  const when = r.exportedAt ? new Date(r.exportedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'an unknown date';
  const have = state.matches.length;
  return [h('h1', { text: 'Restore this backup?' }),
    h('p', { text: `The backup from ${when} holds ${r.matches.length} ${r.matches.length === 1 ? 'match' : 'matches'}.` }),
    have ? h('p', { class: 'banner', text: `Restoring replaces the ${have} ${have === 1 ? 'match' : 'matches'} now on this phone. ${have === 1 ? 'It' : 'They'} cannot be brought back unless you have another backup.` }) : null,
    h('div', { class: 'stack' },
      h('button', { class: have ? 'btn btn-danger' : 'btn btn-primary', type: 'button', text: have ? `Replace with the backup` : `Restore ${r.matches.length} matches`, onclick: applyRestore }),
      h('a', { class: 'btn btn-quiet', href: '#settings', text: 'Cancel' }))];
}

/* ---------- router ---------- */
const routes = { shared: sharedScreen, restore: restoreScreen, matches: matchesScreen, match: matchScreen, import: importScreen, pick: pickScreen, stats: statsScreen, settings: settingsScreen };
const TAB_OF = { matches: 'matches', stats: 'stats', settings: 'settings' };
export function render() {
  const [name, query] = (location.hash || '#matches').slice(1).split('?');
  const screen = routes[name] || matchesScreen;
  // a focused task hides the tabs, so the way out is Save or Cancel
  const task = !TAB_OF[name] && routes[name] !== undefined;
  document.body.classList.toggle('focus-task', task);
  if (task) toast.hidden = true;
  for (const a of document.querySelectorAll('#tabs a')) {
    if (a.dataset.tab === TAB_OF[name]) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const nodes = screen(new URLSearchParams(query || ''));
  // screens may leave optional pieces as null; never let one reach the page as text
  view.replaceChildren(...nodes.filter(n => n !== null && n !== undefined && n !== false),
    h('input', { id: 'pick', type: 'file', accept: 'image/*', hidden: true, onchange: e => { const f = e.target.files[0]; e.target.value = ''; onPicked(f); } }),
    // no accept filter: iPhone greys out .json files under some filters; the file is checked on arrival instead
    h('input', { id: 'restore-pick', type: 'file', hidden: true, onchange: e => { const f = e.target.files[0]; e.target.value = ''; onRestorePicked(f); } }));
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

async function start() {
  try {
    const [matches, settings] = await Promise.all([db.allMatches(), db.getSettings()]);
    state.matches = matches.sort(byNewest);
    state.settings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  } catch {
    state.storageError = 'This browser is blocking storage, so matches cannot be saved. Private browsing does this.';
  }
  render();
  setTimeout(warmUp, 1500);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.__postmatch = { state, render, openDraft, showToast };
start();
