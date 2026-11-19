// Drift Streets: Crazy, a bonus bot. It spins a whole donut at every corner and still gets home.
// obs and the answer are as in bot.js.

const S = (typeof self !== 'undefined' && self.BOT_SETTINGS) || {};
// Settings (self.BOT_SETTINGS.tune overrides any of them):
//   lat        how hard it corners, m/s2
//   brake      how hard it brakes, m/s2
//   gas        the most throttle it uses
//   top        its top speed, m/s
//   ease       how much it lifts off with the wheel turned
//   exit       how early it is back on the power out of a corner
//   spinV      how fast it comes to a corner and spins, m/s
//   kick       how long the handbrake swings the tail out, seconds
//   slipMin    the handbrake again if the slide drops below this, degrees
//   gasSpin    the throttle that holds it round
//   hardBelow  the wheel goes hard over only below this speed, m/s, so the car stays on its wheels
const TUNE = Object.assign({ lat: 10.5, brake: 10, gas: 1, top: 60, ease: 0.4, exit: 0.9, spinV: 9, kick: 0.35, slipMin: 20, gasSpin: 0.6, hardBelow: 10 }, S.tune);

// One bot file may drive several cars: what it remembers is kept per car (obs.you.id)
const memory = {};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RAD = Math.PI / 180;

function decide(obs) {
  const me = obs.you;
  const t = obs.t;
  let m = memory[me.id];
  // A new race starts its clock again: what was remembered from the last one means nothing now
  if (!m || t < m.t) m = memory[me.id] = { backUntil: -1, backSteer: 0, stuckSince: -1, foot: 0, passSide: 0, passAt: -9, at: t, spin: null, spun: false };
  m.t = t;
  if (obs.phase !== 'race' || me.finished || me.wrecked) { m.foot = 0; return { steer: 0, throttle: 0, handbrake: false }; }
  const step = obs.rules.pathStep, path = obs.path, n = path.length;
  const speed = Math.hypot(me.speed, me.slide);
  const slipRad = me.slip * RAD, slip = Math.abs(me.slip);
  const yaw = me.yawRate * RAD;
  const ray = deg => obs.rays.find(r => r.deg === deg).d;

  // ---- Backing out of trouble ----
  if (t < m.backUntil) return { steer: m.backSteer, throttle: -1, handbrake: false };
  const ahead = ray(0);
  if (speed < 1.5 && ahead < 5) {
    if (m.stuckSince < 0) m.stuckSince = t;
    if (t - m.stuckSince > 0.6) {
      // Nose against a wall: reverse, turning the tail towards where the road is
      m.backUntil = t + 1.4;
      m.backSteer = path[3].r > 0 ? -1 : 1;
      m.stuckSince = -1;
      m.foot = 0;
      return { steer: m.backSteer, throttle: -1, handbrake: false };
    }
  } else m.stuckSince = -1;

  // ---- The line ahead: where it is and how it bends ----
  // A spot [d] metres along it (between the points it is given as)
  const along = d => {
    const k = clamp(d / step, 0, n - 1.001), i = Math.floor(k), u = k - i;
    return { f: path[i].f + (path[i + 1].f - path[i].f) * u, r: path[i].r + (path[i + 1].r - path[i].r) * u };
  };
  // turn[k]: how far the line turns at its point k (radians, + to the right)
  const turn = new Array(n).fill(0);
  for (let k = 1; k < n - 1; k++) {
    const a = path[k - 1], b = path[k], c = path[k + 1];
    turn[k] = Math.atan2((b.f - a.f) * (c.r - b.r) - (b.r - a.r) * (c.f - b.f), (b.f - a.f) * (c.f - b.f) + (b.r - a.r) * (c.r - b.r));
  }

  // ---- How fast: from how sharply the line bends, and the room there is to brake for it ----
  // (braking starts a little early: the foot takes a moment, and the bend starts before its point)
  const margin = 4 + speed * 0.25;
  let allowed = TUNE.top;
  // No faster than a bend this sharp (1 / its radius) allows, [there] metres ahead
  const slowFor = (curve, there) => {
    if (curve < 0.004) return;
    const fastest = TUNE.lat / curve;                          // the square of what the tyres (or the slide) carry round it
    allowed = Math.min(allowed, Math.sqrt(fastest + 2 * TUNE.brake * Math.max(0, there - margin)));
  };
  for (let k = 0; k < n - 1; k++) {
    const here = Math.abs(turn[k]), next = Math.abs(turn[k + 1]), after = k + 2 < n - 1 ? Math.abs(turn[k + 2]) : 0;
    // In a bend: as sharp as its points say
    if (k > 0) slowFor(here / step, (k - 1) * step);
    // Where a bend begins, the first point shows only a part of it. The points after say how
    // sharp it really is, and how small that part is says where between two points it starts
    if (next > here * 1.3 && next > 0.02) {
      const part = here / next, into = (part + Math.sqrt(2 * part * part + part)) / (1 + part);
      slowFor(Math.max(next, after) / step, (k + 1 - Math.min(1, into)) * step);
    }
  }
  // What comes after the last point is not known: it may be a tight corner
  allowed = Math.min(allowed, Math.sqrt(TUNE.lat * 24 + 2 * TUNE.brake * Math.max(0, (n - 1) * step - margin)));

  // What the points show wobbles a little as they move along the line: the speed it may do
  // comes down at once and goes up gently, so the foot does not follow the wobble
  if (m.allowed !== undefined && t > m.seen) allowed = Math.min(allowed, m.allowed + 8 * (t - m.seen));
  m.allowed = allowed; m.seen = t;

  // ---- Where to point: a spot on the line some way ahead, further the faster it goes ----
  const look = clamp(6 + speed * 0.6, 8, 40);
  const target = along(look);

  // ---- The other cars ----
  // One in the way and slower: round it on the side with room, or stay behind it
  let inWay = null;
  for (const o of obs.cars) {
    if (o.f < 2 || o.f > 34) continue;
    const off = o.r - along(o.f).r * Math.min(1, o.f / 12);    // how far it is from where this car will drive
    const closing = me.speed - o.v.f;
    if (Math.abs(off) > 3 || closing < 0.5) continue;
    if (!inWay || o.f < inWay.f) inWay = { f: o.f, off, closing, v: Math.max(0, o.v.f) };
  }
  if (inWay) {
    const gap = Math.max(0, inWay.f - 4.8);
    // Keep to the side already chosen for a moment, or the car wavers behind the other
    let side = t - m.passAt < 1 && m.passSide ? m.passSide : inWay.off > 0 ? -1 : 1;
    const room = s => ray(s * 60) > 8 && ray(s * 30) > 14 && ray(s * 90) > 4.5;
    if (!room(side)) side = room(-side) ? -side : 0;
    if (side) {
      m.passSide = side; m.passAt = t;
      target.r += side * clamp(3.2 - side * inWay.off, 0, 4) * clamp(1.3 - gap / 30, 0, 1);
    }
    // No way round, or about to touch: no faster than it, with room to slow down in
    if (!side || gap / inWay.closing < 0.45) allowed = Math.min(allowed, Math.sqrt(inWay.v * inWay.v + 2 * TUNE.brake * 0.7 * Math.max(0, gap - 2)));
  }
  // One right beside: a little room for it
  for (const o of obs.cars) if (Math.abs(o.f) < 5 && Math.abs(o.r) < 3) target.r -= Math.sign(o.r) * (3 - Math.abs(o.r)) * 0.6;

  const angle = Math.atan2(target.r, Math.max(0.1, target.f));
  // The same, seen from the way the car is going (in a slide that is not where its nose points)
  const angleGoing = angle - slipRad;
  // The faster it goes, the less the hand needs to do
  let steer = clamp(angle * (1.2 + 22 / (6 + speed)) - yaw * 0.3, -1, 1);
  // Facing the wrong way: turn round on the spot
  if (target.f < -2) steer = target.r >= 0 ? 1 : -1;
  // The road is off to the side already (it ran wide, or it is turning round): no faster than a tight corner
  if (Math.abs(angleGoing) > 0.8) allowed = Math.min(allowed, 11);
  // Something close in front (a wall after a mistake): do not drive into it. In a slide the car
  // is not going where its nose points, so it looks along the way it is going
  const going = obs.rays.reduce((a, r) => (Math.abs(r.deg - me.slip) < Math.abs(a.deg - me.slip) ? r : a)).d;
  const clear = Math.min(ahead, going);
  // (only when it is really close: in any corner the nose points at the outside wall for a while)
  if (clear < 3 + speed * 0.25) allowed = Math.min(allowed, Math.max(4, clear * 0.8));

  // How far the line turns in the next [reach] metres
  const bendIn = reach => { let b = 0; for (let k = 1; k < n - 1; k++) b += turn[k] * clamp((reach - (k - 0.5) * step) / step, 0, 1); return b; };
  {
    // Each corner is spun once: after a donut, none until the road is straight again; coming to
    // one, slow enough to spin it round
    const soon = bendIn(30);
    if (m.spun && !m.spin && Math.abs(soon) < 0.15) m.spun = false;
    if (!m.spin && !m.spun && Math.abs(soon) > 0.5) allowed = Math.min(allowed, TUNE.spinV);
  }

  // ---- The foot: up to the speed it may do and no further, without stabbing at the pedals ----
  const spare = allowed - speed;
  let want = spare >= 0 ? Math.min(TUNE.gas, 0.25 + spare / 4) : spare > -0.5 ? 0.25 * (1 + 2 * spare) : Math.max(-1, spare + 0.5);
  // A light foot while the wheel is turned, or the tail comes round
  if (want > 0) want = Math.min(want, 1 - Math.abs(steer) * TUNE.ease * clamp(1.4 - speed / 22, 0, 1));
  // The tyres that push the car on are the ones that hold it in the corner: the harder it is
  // cornering (m/s2), the less power they take before the tail steps out and it runs wide
  const cornering = Math.abs(yaw) * speed;
  if (want > 0) want = Math.min(want, Math.max(0.25, TUNE.exit * Math.sqrt(Math.max(0, 1 - cornering * cornering / 156))));
  let handbrake = false;

  {
    // ---- The donut: a whole turn on the spot at every corner, then on ----
    const dt = clamp(t - m.at, 0, 0.25);
    m.at = t;
    const close = bendIn(12);
    if (!m.spin && !m.spun) {
      if (Math.abs(close) > 0.2 && speed > 4 && speed < TUNE.spinV + 4 && me.surface !== 'grass' && clear > 6)
        m.spin = { dir: Math.sign(close), turned: 0, from: t };
    }
    if (m.spin) {
      const s = m.spin;
      s.turned += me.yawRate * RAD * dt * s.dir;
      // Round once (or it is taking too long, or a wall comes up): out of it, and drive on
      if (s.turned > 2 * Math.PI - 0.4 || t - s.from > 3 || (ahead < 2.5 && t - s.from > 0.5)) { m.spin = null; m.spun = true; }
      else {
        // The handbrake swings the tail out, and again whenever the turning slows; the wheel hard
        // into it on the power keeps it going round, the power eased off to keep the circle small
        const kick = t - s.from < TUNE.kick || (slip < TUNE.slipMin && speed > 4);
        m.foot = kick ? 0.6 : clamp(TUNE.gasSpin + (TUNE.spinV - speed) * 0.3, 0.3, 1);
        // (hard over, past 1, while slow enough that the car does not lean onto two wheels)
        return { steer: s.dir * (speed < TUNE.hardBelow ? 1.5 : 1), throttle: m.foot, handbrake: kick };
      }
    }
    if (slip > 22 && want > 0.3) want = 0.3;   // sliding and not meaning to: off the power until it comes back
  }

  // The foot moves quickly, but it does not jump: off the power faster than onto it
  const foot = handbrake ? want : m.foot + clamp(want - m.foot, -0.45, 0.3);
  m.foot = foot;
  return { steer, throttle: foot, handbrake };
}
