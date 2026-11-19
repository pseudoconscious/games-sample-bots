// Heli Valley: Crazy, a bonus bot with no settings. It passes low and fast over every herd in turn,
// zig-zagging, then lands at home and starts again. obs and the answer are as in bot.js.

const HEIGHT = [26, 32];   // flying height over the herds, in metres
const CEILING = 400;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const turnTo = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const levers = (sx, sy, lx, ly) => ({ stick: { x: sx, y: sy }, lever: { x: lx, y: ly } });

let wait = 2 + Math.random() * 6;   // seconds on the pad before the first round
let goal = null, height = 30, home = false, owesHome = false, best = Infinity, since = 0, last = null;
let buzzed = new Set();             // herds already passed on this round, by their index in obs.herds

/** Is this point on one of the lands, [margin] in from its edge? */
function inside(obs, x, y, margin) {
  return obs.lands.some(l => x >= l.x0 + margin && y >= l.y0 + margin && x <= l.x1 - margin && y <= l.y1 - margin);
}
/** Can it fly straight there without leaving the lands? It may cross from one land to the next. */
function across(obs, x, y, margin = 0) {
  const h = obs.you, d = Math.hypot(x - h.x, y - h.y), steps = Math.ceil(d / 50);
  for (let k = 1; k <= steps; k++) {
    if (!inside(obs, h.x + (x - h.x) * k / steps, h.y + (y - h.y) * k / steps, margin)) return false;
  }
  return true;
}
/** The nearest reachable herd not yet passed on this round, or null when none is left. */
function nextHerd(obs) {
  let found = null, bestD = Infinity;
  obs.herds.forEach((m, i) => {
    const d = Math.hypot(m.x - obs.you.x, m.y - obs.you.y);
    if (!buzzed.has(i) && d < bestD && across(obs, m.x, m.y)) { found = { x: m.x, y: m.y, herd: i }; bestD = d; }
  });
  return found;
}
/** A reachable point on the lands, used when home cannot be reached in a straight line. */
function somewhere(obs) {
  const x0 = Math.min(...obs.lands.map(l => l.x0)), x1 = Math.max(...obs.lands.map(l => l.x1));
  const y0 = Math.min(...obs.lands.map(l => l.y0)), y1 = Math.max(...obs.lands.map(l => l.y1));
  for (let n = 0; n < 40; n++) {
    const x = x0 + Math.random() * (x1 - x0), y = y0 + Math.random() * (y1 - y0);
    if (inside(obs, x, y, 200) && across(obs, x, y, 60)) return { x, y };
  }
  return { x: obs.you.x, y: obs.you.y };
}

function decide(obs) {
  const h = obs.you;
  if (!h || !obs.home || !obs.lands || !obs.lands.length) return levers(0, 0, 0, 0);
  const dt = last === null ? 0.2 : Math.max(0, Math.min(1, obs.t - last));
  last = obs.t;
  if (wait > 0) {
    wait -= dt;
    return levers(0, 0, 0, h.alt > 0 ? 1 : 0);
  }
  if (!goal) {
    // The next herd; when none is left, home, then a new round
    const herd = owesHome ? null : nextHerd(obs);
    home = !herd && across(obs, obs.home.x, obs.home.y);
    owesHome = !herd && !home;
    if (home) buzzed = new Set();
    goal = herd || (home ? { ...obs.home } : somewhere(obs));
    height = HEIGHT[0] + Math.random() * (HEIGHT[1] - HEIGHT[0]);
    best = Infinity;
    since = 0;
  }
  const dx = goal.x - h.x, dy = goal.y - h.y, d = Math.hypot(dx, dy);
  // No closer for 5 seconds (held by an edge or a tree): skip this goal
  since += dt;
  if (d < best - 20) { best = d; since = 0; }
  if (since > 5 && !(home && d < 200)) {
    if (goal.herd !== undefined) buzzed.add(goal.herd);
    goal = null; return levers(0, 0, 0, -0.5);
  }
  let want = height;
  // Someone close at the same height: one goes over, one goes under
  for (const o of obs.others || []) {
    if (Math.hypot(o.x - h.x, o.y - h.y) < 260 && Math.abs(o.alt - h.alt) < 34) want += h.alt >= o.alt ? 50 : -40;
  }
  // Keep above the tops of trees and rocks nearby, and of any within 300 ahead on its path
  const v = Math.hypot(h.vx, h.vy) || 1;
  for (const o of obs.near || []) {
    if (!o.top) continue;
    const ox = o.x - h.x, oy = o.y - h.y;
    const ahead = (ox * h.vx + oy * h.vy) / v, beside = Math.abs(ox * h.vy - oy * h.vx) / v;
    if (Math.hypot(ox, oy) < o.r + 80 || (ahead > -o.r && ahead < 300 && beside < o.r + 70)) want = Math.max(want, o.top + 15);
  }
  if (home && d < 200) {
    // Near home: slide over the pad without turning, land, wait, then take off again
    if (h.onGround && d < 40) { goal = null; wait = 6 + Math.random() * 8; return levers(0, 0, 0, 0); }
    const fx = Math.cos(h.heading), fy = Math.sin(h.heading);
    const along = dx * fx + dy * fy, side = -dx * fy + dy * fx;
    return levers(clamp(side / 110, -0.6, 0.6), -clamp(along / (along > 0 ? 180 : 90), -0.6, 0.6), 0,
      d < 30 ? 1 : clamp((h.alt - 45) / 30, -1, 1));
  }
  if (!home && d < 140) {
    if (goal.herd !== undefined) buzzed.add(goal.herd);
    goal = null; return levers(0, 0, 0, 0);
  }
  // Zig-zag: the nose swings to either side of the goal and the stick slides with it. Straight over
  // the herd itself, and straight home at full speed (the edge between two lands holds back a slow
  // crossing)
  const wiggle = d > 250 && !home ? Math.sin(obs.t * 2.6) : 0;
  const off = turnTo(h.heading, Math.atan2(dy, dx) + 0.55 * wiggle);
  return levers(0.8 * wiggle, h.alt > 18 && Math.abs(off) < 0.9 ? -1 : -0.3, clamp(off * 2.2, -1, 1),
    clamp((h.alt - clamp(want, 25, CEILING)) / 20, -1, 1));
}
