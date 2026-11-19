// Heli Valley: the sample bot. A bot flies one helicopter. It defines decide(obs), which the game
// calls about 5 times a second, and returns the position of the two levers. To use your own, put
// it in a GitHub repository as bot.js and paste the repository's link into the game's bot picker.
//
// Settings (self.BOT_SETTINGS). The game's built-in bots are this file with:
//   style  'wanderer'   flies from one spot of the valley to another, home to its pad now and then
//          'herder'     passes low over the herds
//          'sightseer'  flies high and slow, and lands at home more often
//
// obs. Distances in world units: x to the right, y down the map; heights in metres; headings in
// radians (0 along x, 1.57 along y); speeds per second.
//   t         seconds since the room took off
//   you       { x, y, alt, heading, vx, vy, vz (up), rotor (0 still .. 1 full), onGround }
//   home      { x, y } your helipad
//   lands     [{ x0, y0, x1, y1 }] every land; the helicopter cannot leave them
//   others    [{ x, y, alt, heading, vx, vy }] the other helicopters
//   herds     [{ x, y, horses, scared }] each herd's middle, its size, and how frightened its most
//             frightened horse is (0 .. 1)
//   near      [{ kind, x, y, r, top }] trees, rocks and ponds within 900, with the height of their
//             tops (0 for water). Below a top the helicopter cannot pass through it; it cannot
//             land on water
//   rules     { forward, backward, sideways, turn, padRadius, landSize, scareReachAt100m }: top
//             speeds, turn rate (radians a second), sizes, and how far a helicopter 100 m up
//             frightens horses (less higher up; none from 560 m)
//
// The answer: { stick: { x, y }, lever: { x, y } }, each value -1 .. 1; a missing value is a lever
// let go.
//   stick  x slides left / right, y -1 forward .. 1 back (in the air only)
//   lever  x turns the nose left / right, y -1 climbs (and starts the rotor) .. 1 comes down
// The rotor stops after a few seconds on the ground with both levers let go. There is no score.
//
// As an API: the game sends each obs as a JSON POST to your https address with the header
// X-Heli-Id, one question at a time, and reads the answer as JSON. Allow any page to call it (CORS:
// answer OPTIONS; Access-Control-Allow-Origin: *; Access-Control-Allow-Headers: Content-Type,
// X-Heli-Id). Keep no state between questions that cannot be worked out from the question.

const S = (typeof self !== 'undefined' && self.BOT_SETTINGS) || {};
const STYLE = S.style || 'wanderer';
const HEIGHT = { wanderer: [60, 210], herder: [30, 45], sightseer: [180, 380] }[STYLE] || [60, 210];
const HOME_EVERY = STYLE === 'sightseer' ? 3 : 5;   // flights between two landings at home
const CEILING = 400;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const turnTo = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

let wait = 2 + Math.random() * 6;   // seconds on the pad before the first flight
let goal = null, legs = 0, height = 90, home = false, owesHome = false, best = Infinity, since = 0, last = null;

/** Is this point on one of the lands, [margin] in from its edge? */
function inside(obs, x, y, margin) {
  return obs.lands.some(l => x >= l.x0 + margin && y >= l.y0 + margin && x <= l.x1 - margin && y <= l.y1 - margin);
}
/** Can it fly straight there without leaving the lands (they are not always one rectangle)? */
function clear(obs, x, y) {
  const h = obs.you, d = Math.hypot(x - h.x, y - h.y), steps = Math.ceil(d / 120);
  for (let k = 1; k <= steps; k++) {
    if (!inside(obs, h.x + (x - h.x) * k / steps, h.y + (y - h.y) * k / steps, 60)) return false;
  }
  return true;
}
function pick(obs) {
  // The herder: the herd furthest from where it is now, that it can reach
  if (STYLE === 'herder') {
    const herds = obs.herds.filter(m => clear(obs, m.x, m.y)).sort((a, b) =>
      Math.hypot(b.x - obs.you.x, b.y - obs.you.y) - Math.hypot(a.x - obs.you.x, a.y - obs.you.y));
    if (herds.length) return { x: herds[0].x, y: herds[0].y };
  }
  const x0 = Math.min(...obs.lands.map(l => l.x0)), x1 = Math.max(...obs.lands.map(l => l.x1));
  const y0 = Math.min(...obs.lands.map(l => l.y0)), y1 = Math.max(...obs.lands.map(l => l.y1));
  for (let n = 0; n < 40; n++) {
    const x = x0 + Math.random() * (x1 - x0), y = y0 + Math.random() * (y1 - y0);
    if (inside(obs, x, y, 200) && clear(obs, x, y)) return { x, y };
  }
  return { x: obs.you.x, y: obs.you.y };
}
const levers = (sx, sy, lx, ly) => ({ stick: { x: sx, y: sy }, lever: { x: lx, y: ly } });

function decide(obs) {
  const h = obs.you;
  const dt = last === null ? 0.2 : Math.max(0, Math.min(1, obs.t - last));
  last = obs.t;
  if (!obs.home || !obs.lands.length) return levers(0, 0, 0, 0);
  if (wait > 0) {
    wait -= dt;
    return levers(0, 0, 0, h.alt > 0 ? 1 : 0);
  }
  if (!goal) {
    legs++;
    // Home every few flights, when the way there is clear; otherwise somewhere else first
    const due = legs % HOME_EVERY === 0 || owesHome;
    home = due && clear(obs, obs.home.x, obs.home.y);
    owesHome = due && !home;
    goal = home ? { ...obs.home } : pick(obs);
    height = HEIGHT[0] + Math.random() * (HEIGHT[1] - HEIGHT[0]);
    best = Infinity;
    since = 0;
  }
  const dx = goal.x - h.x, dy = goal.y - h.y, d = Math.hypot(dx, dy);
  // No closer for 5 seconds (held by an edge or a tree): choose another goal
  since += dt;
  if (d < best - 20) { best = d; since = 0; }
  if (since > 5 && !(home && d < 200)) { goal = null; return levers(0, 0, 0, -0.5); }
  let want = height;
  // Someone close at the same height: one goes over, one goes under
  for (const o of obs.others) {
    if (Math.hypot(o.x - h.x, o.y - h.y) < 260 && Math.abs(o.alt - h.alt) < 34) want += h.alt >= o.alt ? 50 : -40;
  }
  // Over trees and rocks it keeps above their tops
  for (const o of obs.near) if (o.top && Math.hypot(o.x - h.x, o.y - h.y) < o.r + 80) want = Math.max(want, o.top + 15);
  if (home && d < 200) {
    // Near home: slide over the pad without turning, land, wait, then take off again
    if (h.onGround && d < 40) { goal = null; wait = 6 + Math.random() * 8; return levers(0, 0, 0, 0); }
    const fx = Math.cos(h.heading), fy = Math.sin(h.heading);
    const along = dx * fx + dy * fy, across = -dx * fy + dy * fx;
    return levers(clamp(across / 110, -0.6, 0.6), -clamp(along / (along > 0 ? 180 : 90), -0.6, 0.6), 0,
      d < 30 ? 1 : clamp((h.alt - 45) / 30, -1, 1));
  }
  if (!home && d < 140) { goal = null; return levers(0, 0, 0, 0); }
  const off = turnTo(h.heading, Math.atan2(dy, dx));
  const slow = (home ? clamp(d / 260, 0.12, 1) : 1) * (STYLE === 'sightseer' ? 0.6 : 1);
  return levers(0, h.alt > 20 && Math.abs(off) < 0.7 ? -0.75 * slow : 0, clamp(off * 1.6, -1, 1),
    clamp((h.alt - clamp(want, 25, CEILING)) / 30, -1, 1));
}
