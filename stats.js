// stats.js: every number shown on the Stats and Matches screens comes from here.
// A match: { id, date, hero, mode, win, k, d, a, gold?, minions?, points?, duration?, note? }
// gold, minions and points are optional, so their averages skip blanks.
//
// Averages are kept as whole-number sums (gold in tenths of a thousand) and rounded
// only for display, so an exact half such as 13.95 always rounds up to 14.0.
// Plain decimal arithmetic would store 13.95 as 13.9499... and show 13.9.

const TENTHS = { gold: 10 };

const avg = (list, key) => {
  const scale = TENTHS[key] || 1;
  const vals = list.map(m => m[key]).filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!vals.length) return null;
  const sum = vals.reduce((s, v) => s + Math.round(v * scale), 0);
  return { sum, scale, n: vals.length, value: sum / scale / vals.length };
};

export function summarise(matches) {
  const games = matches.length;
  const wins = matches.filter(m => m.win).length;
  return {
    games, wins, losses: games - wins,
    winRate: games ? { wins, games } : null,
    k: avg(matches, 'k'), d: avg(matches, 'd'), a: avg(matches, 'a'),
    gold: avg(matches, 'gold'), minions: avg(matches, 'minions'),
  };
}

export function byHero(matches) {
  const groups = new Map();
  for (const m of matches) {
    if (!groups.has(m.hero)) groups.set(m.hero, []);
    groups.get(m.hero).push(m);
  }
  return [...groups].map(([hero, list]) => ({ hero, ...summarise(list) }))
    .sort((x, y) => y.games - x.games || x.hero.localeCompare(y.hero));
}

// One decimal place, halves rounded up: round(sum * 10 / (scale * n)) / 10, all in whole numbers.
const oneDp = a => (Math.round((a.sum * 10) / (a.scale * a.n)) / 10).toFixed(1);

export const fmt = {
  pct: r => (r === null ? '–' : Math.round((r.wins * 100) / r.games) + '%'),
  one: a => (a ? oneDp(a) : '–'),
  gold: a => (a ? oneDp(a) + 'k' : '–'),
};
