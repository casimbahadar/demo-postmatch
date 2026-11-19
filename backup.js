// backup.js: backup files out, and a strict check of any file coming back in.
// Restore reads and checks the whole file first; nothing is written unless every match passes.
import { SCHEMA_VERSION } from './db.js';
import { cleanMatch } from './model.js';
import { MODES } from './heroes.js';

export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export const MAX_MATCHES = 20000;

export function makeBackup(matches, settings) {
  const body = {
    app: 'postmatch', kind: 'backup', schema: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: { username: settings.username || '', defaultMode: settings.defaultMode || MODES[0] },
    matches,
  };
  const stamp = body.exportedAt.slice(0, 10);
  return { file: new File([JSON.stringify(body)], `postmatch-backup-${stamp}.json`, { type: 'application/json' }), count: matches.length };
}

// Share sheet where the phone has one (save to Files, Drive, email, AirDrop), else a download.
export async function deliverBackup(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Postmatch backup' }); return 'shared'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}

// Older backup formats are upgraded here, one step per schema version (none yet).
const UPGRADES = {};

// Returns { ok: true, matches, settings, exportedAt } or { ok: false, message }.
export async function readBackup(file) {
  const fail = message => ({ ok: false, message });
  if (!file) return fail('No file was chosen.');
  if (file.size > MAX_BACKUP_BYTES) return fail('That file is too large to be a Postmatch backup.');
  let data;
  try { data = JSON.parse(await file.text()); } catch { return fail('That file is not a Postmatch backup.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.app !== 'postmatch' || data.kind !== 'backup') return fail('That file is not a Postmatch backup.');
  if (!Number.isInteger(data.schema) || data.schema < 1) return fail('That backup is damaged.');
  if (data.schema > SCHEMA_VERSION) return fail('That backup comes from a newer Postmatch. Open Postmatch online once so it can update, then try again.');
  for (let v = data.schema; v < SCHEMA_VERSION; v++) data = UPGRADES[v + 1](data);
  if (!Array.isArray(data.matches)) return fail('That backup is damaged.');
  if (data.matches.length > MAX_MATCHES) return fail('That backup holds more matches than Postmatch can take.');

  const ids = new Set();
  const matches = [];
  for (let i = 0; i < data.matches.length; i++) {
    const raw = data.matches[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`Match ${i + 1} in that backup is damaged. Nothing was changed.`);
    // only known fields, as the form would have them
    const pick = {};
    for (const k of ['id', 'win', 'hero', 'mode', 'k', 'd', 'a', 'gold', 'minions', 'points', 'duration', 'date', 'note']) {
      const v = raw[k];
      if (v === undefined || v === null) continue;
      if (!['string', 'number', 'boolean'].includes(typeof v)) return fail(`Match ${i + 1} in that backup is damaged. Nothing was changed.`);
      pick[k] = k === 'id' || k === 'win' ? v : typeof v === 'number' ? String(v) : v;
    }
    if (typeof pick.gold === 'string' && /^\d+(\.\d+)?$/.test(pick.gold)) pick.gold = Number(pick.gold).toFixed(1);
    const { match, errors } = cleanMatch(pick, { anyHero: true });
    if (Object.keys(errors).length || match.id === undefined || ids.has(match.id)) return fail(`Match ${i + 1} in that backup is damaged. Nothing was changed.`);
    ids.add(match.id);
    matches.push(match);
  }
  const s = data.settings && typeof data.settings === 'object' ? data.settings : {};
  const username = typeof s.username === 'string' ? s.username.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '';
  const defaultMode = MODES.includes(s.defaultMode) ? s.defaultMode : MODES[0];
  const exportedAt = typeof data.exportedAt === 'string' && !Number.isNaN(Date.parse(data.exportedAt)) ? data.exportedAt : null;
  return { ok: true, matches, settings: { username, defaultMode }, exportedAt };
}
