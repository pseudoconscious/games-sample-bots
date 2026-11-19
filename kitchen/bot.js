// Sneaky Kitchen: sample bot.
//
// Use: put a copy in a GitHub repository as bot.js and paste the repository's link into the game,
// or serve the same function as an https API (see below).
//
// decide(obs) is called about 5 times a second and returns how your cook walks.
//
// obs (the kitchen is 16 by 9 units; u runs left to right, v top to bottom; times in seconds):
//   t, timeLeft     seconds since the start, and seconds left
//   scores          { red, blue }
//   role            'loyal', or 'saboteur' (wins if its team loses and it is not voted out)
//   cooks           all eight: { i, team, num, u, v, carry }; carry is null,
//                   { kind: 'ingredient', ing } or { kind: 'plate', items, spoiled }
//   tables          the six tables: { u, v, items, spoiled }; no items means a free table
//   orders          { recipe, ingredients, left } (left: seconds)
//   kitchen         size { u, v }; stations [{ ing, u, v }]; bins [{ u, v }];
//                   bells { red: { u, v }, blue: { u, v } }; recipes { name: [ingredients] };
//                   reach { table, station, bell, bin }: how close a cook must come to each
// A bot is not told which cook it leads; it must find out by moving and watching.
//
// Rules: near a station a cook picks up its ingredient. A table takes one action per walk-up: an
// ingredient goes on its plate, empty hands take the plate, a plate is put down on a free table.
// An ordered, finished dish carried to the team's bell is served. A bin takes what is carried.
//
// Answer: { goTo: { u, v } } (a place; the game walks the cook there and stops), or
// { walk: { x, y } } (a push, each -1 to 1; x right, y down). Anything else: stand still.
//
// API: the game sends a POST with obs as JSON and the header X-Cook, and reads the answer as JSON.
// It must be https and allow CORS (answer OPTIONS; Access-Control-Allow-Origin: *;
// Access-Control-Allow-Headers: Content-Type, X-Cook). One question is out at a time.
//
// Settings: none. This bot wiggles for the first 3 seconds to find its cook, then works on the
// first order it can, as a loyal cook would.

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
