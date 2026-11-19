// Sneaky Kitchen: the crazy cook, a bonus bot. It plays like bot.js (see its header), but takes each
// item to a wrong table and back before delivering it; it never drops anything in the wrong place.

let me = -1;
let last = null, push = null;            // where the cooks were at the last question, and the push since
const score = [];
let target = null, nearSince = null, backOff = null;

const dist = (a, b) => Math.hypot(a.u - b.u, a.v - b.v);
const near = (a, b, r) => dist(a, b) < r;

/** Scores each cook by how well it moved with the push; the best score is this bot's cook. */
function watch(obs) {
  if (last && push) {
    obs.cooks.forEach((c, i) => {
      const du = c.u - last[i].u, dv = c.v - last[i].v;
      score[i] = (score[i] || 0) + du * push.x + dv * push.y - 0.3 * Math.abs(du * push.y - dv * push.x);
    });
  }
  last = obs.cooks.map(c => ({ u: c.u, v: c.v }));
}

/** Where to go next, given what the cook carries. A table takes one action per walk-up. */
function plan(obs) {
  const c = obs.cooks[me], k = obs.kitchen, hands = c.carry;
  const ordered = obs.orders.map(o => o.recipe);
  const dishOf = items => Object.keys(k.recipes).find(r => k.recipes[r].length === items.length && k.recipes[r].every(x => items.includes(x)));
  const fits = (items, recipe) => items.every(x => k.recipes[recipe].includes(x));
  if (hands && hands.kind === 'plate') {
    // An ordered, finished dish goes to the team's bell; any other plate goes to a bin
    if (!hands.spoiled && ordered.includes(dishOf(hands.items))) return k.bells[c.team];
    return k.bins.reduce((a, b) => (dist(a, c) < dist(b, c) ? a : b));
  }
  if (hands && hands.kind === 'ingredient') {
    // The table whose plate it completes most, or a free one
    let best = null, value = -1;
    obs.tables.forEach(t => {
      if (t.spoiled || t.items.includes(hands.ing)) return;
      const after = t.items.concat(hands.ing);
      if (!ordered.some(r => fits(after, r))) return;
      const v = t.items.length * 2 - dist(t, c) * 0.2;
      if (v > value) { value = v; best = t; }
    });
    return best || k.bins[0];
  }
  // Empty hands: take an ordered, finished dish from a table
  const ready = obs.tables.find(t => !t.spoiled && t.items.length && ordered.includes(dishOf(t.items)));
  if (ready) return ready;
  // Otherwise fetch the next missing ingredient of the first order
  for (const o of obs.orders) {
    const plate = obs.tables.filter(t => !t.spoiled && fits(t.items, o.recipe)).sort((a, b) => b.items.length - a.items.length)[0];
    const missing = o.ingredients.find(x => !plate || !plate.items.includes(x));
    if (missing) return k.stations.find(s => s.ing === missing);
  }
  return null;
}

// ---- Detours ----
let trip = '', tripAt = 0, detour = [];   // what the cook carried when the detours were planned, and the points left to visit

/** True when a point is out of reach of every table, station, bin and bell, with a margin. */
function safe(p, obs) {
  const k = obs.kitchen, r = k.reach, m = 0.4;
  if (p.u < 0.6 || p.v < 0.6 || p.u > k.size.u - 0.6 || p.v > k.size.v - 0.6) return false;
  return obs.tables.every(t => !near(p, t, r.table + m)) && k.stations.every(s => !near(p, s, r.station + m))
    && k.bins.every(b => !near(p, b, r.bin + m)) && Object.values(k.bells).every(b => !near(p, b, r.bell + m));
}

/** The point at distance d from place, towards from. */
function before(place, from, d) {
  const l = dist(place, from) || 1;
  return { u: place.u + (from.u - place.u) / l * d, v: place.v + (from.v - place.v) / l * d };
}

/** The detour points for this trip: a wrong table and back when carrying, a random spot when not. */
function planDetours(obs, c, goal) {
  const out = [], firstSafe = list => list.find(p => safe(p, obs));
  const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);
  if (c.carry) {
    // In front of a wrong table, with a 1.2 s pause
    const wrong = shuffle(obs.tables.filter(t => !(t.u === goal.u && t.v === goal.v)));
    const decoy = firstSafe(wrong.map(t => before(t, c, obs.kitchen.reach.table + 0.6)));
    if (decoy) out.push({ ...decoy, think: 1.2 });
    // Back towards where the item was picked up, with a 0.6 s pause
    const back = firstSafe([1.6, 2.2, 1.2].map(d => before(c, goal, d)));
    if (back) out.push({ ...back, think: 0.6 });
  } else {
    // Empty hands: a random spot, with a 0.4 s pause
    const spots = Array.from({ length: 12 }, () => ({ u: 1 + Math.random() * (obs.kitchen.size.u - 2), v: 1 + Math.random() * (obs.kitchen.size.v - 2) }));
    const spot = firstSafe(spots);
    if (spot) out.push({ ...spot, think: 0.4 });
  }
  return out;
}

/** The next move on a detour, or null when the detours are done. */
function crazyStep(obs, c, goal) {
  const hands = c.carry ? (c.carry.kind === 'plate' ? `plate:${c.carry.items.join('+')}` : c.carry.ing) : '';
  if (hands !== trip) { trip = hands; tripAt = obs.t; detour = planDetours(obs, c, goal); }
  if (obs.t - tripAt > 12) detour = [];   // detours not finished in 12 s are dropped
  const p = detour[0];
  if (!p) return null;
  if (!near(c, p, 0.3)) return { goTo: { u: p.u, v: p.v } };
  // At the point: wiggle in place for the pause, then go to the next one
  if (p.until === undefined) p.until = obs.t + p.think;
  if (obs.t < p.until) return { walk: { x: Math.sin(obs.t * 9) * 0.25, y: 0 } };
  detour.shift();
  return crazyStep(obs, c, goal);
}

function decide(obs) {
  if (!obs.cooks || !obs.cooks.length) return {};
  watch(obs);
  // First 3 seconds: push left and right, then up and down, and see which cook follows
  if (me < 0 || obs.t < 3) {
    push = obs.t % 1.2 < 0.6 ? { x: obs.t < 1.5 ? 1 : 0, y: obs.t < 1.5 ? 0 : 1 } : { x: obs.t < 1.5 ? -1 : 0, y: obs.t < 1.5 ? 0 : -1 };
    if (obs.t >= 2.8) me = score.indexOf(Math.max(...score));
    return { walk: push };
  }
  push = null;
  const c = obs.cooks[me];
  // Step back from a table so the next walk-up counts
  if (backOff) {
    if (!near(c, backOff, 0.35)) return { goTo: backOff };
    backOff = null;
  }
  const goal = plan(obs);
  if (!goal) return { walk: { x: 0, y: 0 } };
  // Detours first, then the task
  const step = crazyStep(obs, c, goal);
  if (step) return step;
  // At a table with nothing happening for 0.8 s: step back and walk up again
  const isTable = obs.tables.some(t => t.u === goal.u && t.v === goal.v);
  const key = `${goal.u},${goal.v}`;
  if (target !== key) { target = key; nearSince = null; }
  if (isTable && near(c, goal, obs.kitchen.reach.table + 0.05)) {
    if (nearSince === null) nearSince = obs.t;
    else if (obs.t - nearSince > 0.8) { backOff = { u: goal.u, v: goal.v + (goal.v < obs.kitchen.size.v / 2 ? -1.4 : 1.4) }; nearSince = null; return { goTo: backOff }; }
  }
  return { goTo: { u: goal.u, v: goal.v } };
}
