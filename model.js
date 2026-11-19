// model.js: the one place that decides what a valid match is. Used when saving
// from the form and (later) when restoring a backup file, so both apply the same rules.
import { HEROES } from './heroes.js';

const CONTROL = /[\u0000-\u001f\u007f]/g;
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
const blank = v => v === undefined || v === null || String(v).trim() === '';

function intIn(v, max) {
  const s = String(v).trim();
  if (!/^\d{1,4}$/.test(s)) return NaN;
  const n = Number(s);
  return n <= max ? n : NaN;
}

export function todayIso() {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// Returns { match, errors }. errors maps a field name to a sentence for the player.
export function cleanMatch(d, { anyHero = false } = {}) {
  const errors = {};
  const m = {};

  if (!blank(d.id)) {
    if (Number.isInteger(d.id) && d.id > 0) m.id = d.id; else errors.id = 'Bad id.';
  }
  if (d.win === true || d.win === false) m.win = d.win; else errors.win = 'Choose win or loss.';

  const hero = typeof d.hero === 'string' ? d.hero.trim() : '';
  if (anyHero ? hero.length >= 1 && hero.length <= 30 && !HAS_CONTROL.test(hero) : HEROES.includes(hero)) m.hero = hero;
  else errors.hero = 'Choose a hero.';

  const mode = (d.mode === 'Other' ? String(d.modeOther ?? '') : String(d.mode ?? '')).replace(CONTROL, '').trim();
  if (mode.length >= 1 && mode.length <= 30) m.mode = mode;
  else errors[d.mode === 'Other' ? 'modeOther' : 'mode'] = 'Type the mode name, up to 30 characters.';

  for (const [key, label] of [['k', 'kills'], ['d', 'deaths'], ['a', 'assists']]) {
    const n = blank(d[key]) ? NaN : intIn(d[key], 999);
    if (Number.isNaN(n)) errors[key] = `Enter ${label} as a whole number.`; else m[key] = n;
  }

  if (!blank(d.gold)) {
    const s = String(d.gold).trim().replace(/k$/i, '');
    const n = /^\d{1,3}(\.\d)?$/.test(s) ? Number(s) : NaN;
    if (Number.isNaN(n)) errors.gold = 'Enter gold like 14.2'; else m.gold = n;
  }
  if (!blank(d.minions)) {
    const n = intIn(d.minions, 9999);
    if (Number.isNaN(n)) errors.minions = 'Enter a whole number.'; else m.minions = n;
  }
  if (!blank(d.points)) {
    const n = intIn(d.points, 999);
    if (Number.isNaN(n)) errors.points = 'Enter a whole number.'; else m.points = n;
  }
  if (!blank(d.duration)) {
    const s = String(d.duration).trim();
    if (/^\d{1,2}:[0-5]\d$/.test(s)) m.duration = s; else errors.duration = 'Enter the length like 18:42';
  }

  const date = String(d.date ?? '');
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T00:00:00Z')) &&
    date >= '2014-01-01' && date <= todayIso();
  if (valid) m.date = date; else errors.date = 'Choose a date that is not in the future.';

  if (!blank(d.note)) {
    const note = String(d.note).replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
    if (note.length > 280) errors.note = 'Keep the note under 280 characters.'; else m.note = note;
  }
  return { match: m, errors };
}

// Newest first.
export const byNewest = (x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : (y.id || 0) - (x.id || 0));
