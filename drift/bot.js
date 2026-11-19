// Drift Streets: the sample bot. The game's three built-in drivers are this file with different
// settings (self.BOT_SETTINGS.style: 'tidy', 'sideways' or 'sunday').
//
// Your own bot: a file with a decide(obs) function. Put it in a GitHub repository as bot.js and
// paste the repository's link into the game. It runs in a background worker. Or run it as your
// own API: the game sends a POST with the question as JSON and the header X-Car-Id, and reads the
// answer as JSON. The API must be https and allow CORS (OPTIONS; Access-Control-Allow-Origin: *;
// Access-Control-Allow-Headers: Content-Type, X-Car-Id). One question is out at a time; after
// 1.5 s without an answer the car coasts.
//
// decide(obs) is called about 20 times a second for each car the bot drives.
//
// Units and frame: metres, metres a second, degrees. Everything is in the car's own frame:
// f metres ahead (negative behind), r metres to the right (negative to the left); angles are
// positive to the right (clockwise seen from above).
//
// obs:
//   t, phase          race clock in seconds from the green light; 'count', 'race' or 'done'
//   you.id            which car this question is for: keep anything remembered per id
//   you.speed         speed along the nose (negative in reverse)
//   you.slide         speed sideways (positive to the right)
//   you.slip          angle between where the car points and where it goes
//   you.yawRate       how fast it turns, degrees a second
//   you.steer         where the front wheels are, -1..1 of full lock
//   you.gear, revs    gear 1..5 (automatic); engine revs 0..1
//   you.surface       'asphalt', 'paving' or 'grass' (slippery and slow)
//   you.lap, place    lap (from 1) and place in the race
//   you.finished      home
//   you.health        100 (new) to 0; you.wrecked: a wreck now, it cannot drive
//   you.roll, upright lean in degrees (90 on its side, 180 on its roof); false while off its wheels
//   you.score, drift  drift points kept; the slide now: { on, points, chain }
//   path              the racing line ahead: 13 points { f, r }, 8 m apart, the first nearest the car
//   gates             the next three gates { f, r, line } in order; line: the finish line
//   rays              distance to the first wall in nine directions { deg, d }, -90..90, up to 80 m
//   cars              every other car within 60 m: { f, r, v: { f, r }, heading, place, wrecked }
//   rules             laps, cars, pathStep, gateRadius, roadWidth, carLength, carWidth, rayMax,
//                     driftAngle, driftSpeed
//
// The answer: { steer, throttle, handbrake }
//   steer      -1 (full left) .. 1 (full right); up to 1.5 either way is hard over: the wheels go
//              to full lock at any speed, and above about 40 km/h the car leans and can roll over
//   throttle   0..1 power; below 0 the brake, then reverse once stopped
//   handbrake  true locks the rear wheels: the tail swings out
// Missing or out-of-range values are clipped or read as 0 / false.
//
// The race: gates count only in order. A car standing still for 4 s while its bot drives is put
// back at the last gate. Points come from sliding (15 degrees or more, at 8 m/s or more), kept
// when the slide ends cleanly; slides within 2.5 s of each other multiply, up to five times.
//
// How it drives:
//   - obs.path is the racing line ahead. It points the car at a spot on that line, works out
//     from how sharply the line bends how fast each part of it can be taken, brakes once, in a
//     straight line, and no harder than that needs, and moves its foot smoothly.
//   - It sees the other cars: it goes round a slower one where there is room and lifts where
//     there is none.
//   - The 'sideways' style drifts. A car held sideways on the power corners harder than one that
//     grips, so it arrives faster, throws the tail out with the handbrake just before the bend,
//     holds the angle on the throttle all the way round (more power pulls it tighter), and lets
//     the car straighten as the road does.

const S = (typeof self !== 'undefined' && self.BOT_SETTINGS) || {};
const STYLE = S.style || 'tidy';
// Settings per style (self.BOT_SETTINGS.tune overrides any of them):
//   lat    how hard it corners, m/s2 (tyres that grip hold about 13, a drift about 17)
//   brake  how hard it brakes, m/s2
//   gas    the most throttle it uses
//   top    its top speed, m/s
//   ease   how much it lifts off with the wheel turned
//   exit   how early it is back on the power out of a corner
//   drift  true: it drifts through corners, with:
//     angle  how far round it holds the car, radians
//     lead   how early before the bend it starts, seconds of road
//     full   how sharp a bend must be for the whole angle, radians
//     kb, kd, kp  how the wheel holds the angle, steadies the turning, and aims at the line
//     pull   how long the handbrake is pulled to start a slide, seconds
const TUNE = Object.assign({}, {
  tidy: { lat: 10.5, brake: 10, gas: 1, top: 60, ease: 0.4, exit: 0.9 },
  sideways: { lat: 17, brake: 10, gas: 1, top: 60, ease: 0.2, exit: 1.2, drift: true, angle: 0.62, lead: 0.55, full: 0.22, kb: 2.4, kd: 0.3, kp: 0.6, pull: 0.3 },
  sunday: { lat: 7.5, brake: 7, gas: 0.8, top: 34, ease: 0.6, exit: 1 },
}[STYLE], S.tune);

// One bot file may drive several cars: what it remembers is kept per car (obs.you.id)
const memory = {};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const RAD = Math.PI / 180;

function decide(obs) {
  const me = obs.you;
  const t = obs.t;
  let m = memory[me.id];
  // A new race starts its clock again: what was remembered from the last one means nothing now
  if (!m || t < m.t) m = memory[me.id] = { backUntil: -1, backSteer: 0, pullUntil: -1, pulledAt: -9, pullSide: 0, stuckSince: -1, foot: 0, passSide: 0, passAt: -9 };
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
  const target = along(look), onLine = target.r;

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

  // ---- The drift (the 'sideways' style) ----
  if (TUNE.drift) {
    // How far the line turns in the next moment of road says how far round to hold the car:
    // all the way while the corner lasts, coming up to it just before, falling away as it ends
    const reach = clamp(speed * TUNE.lead, 8, 30);
    let bend = 0;
    for (let k = 1; k < n - 1; k++) bend += turn[k] * clamp((reach - (k - 0.5) * step) / step, 0, 1);
    const dir = Math.sign(bend);                                // 1: the corner goes right
    const fast = speed > 12 && me.surface !== 'grass';
    const over = speed - allowed;                               // how much too fast it is for what comes
    const wall = clear < 3 + speed * 0.25;
    // (not while it still has braking to do: that is done in a straight line)
    const hold = fast && !wall && (over < 3 || slip > 12) ? TUNE.angle * clamp(Math.abs(bend) / TUNE.full, 0, 1) : 0;
    const wanted = -dir * hold;                                 // the slip to hold (a right-hander slides to the left)
    const pulling = t < m.pullUntil;
    // In a slide it aims at a nearer spot (a far one cuts the corner), seen from the way it is going
    const near = along(clamp(4 + speed * 0.4, 8, 20));
    near.r += target.r - onLine;
    const aim = Math.atan2(near.r, Math.max(0.1, near.f)) - slipRad;
    // How hard it has to turn to come round to that spot (m/s2, + into the corner)
    const need = dir * speed * speed * 2 * Math.sin(aim) / Math.max(4, Math.hypot(near.f, near.r));
    // It starts a slide only when it is slow enough for the bend and the line does not go the
    // other way first (between a left and a right); until then it drives as the others do
    const ready = over < 3 && need > -3;
    if (slip > 9 || pulling || (hold > 0.12 && ready)) {
      // The wheel: into the corner when the angle is short of what is wanted, out of it when it
      // is over; steadied by how fast the car is turning against how fast the line does; and
      // towards the line, seen from the way the car is going
      const turning = speed * turn[1] / step;
      steer = clamp(TUNE.kb * (slipRad - wanted) - TUNE.kd * (yaw - turning) + TUNE.kp * aim, -1, 1);
      // The foot. Sideways, the power does not make the car faster: it pulls it tighter (from
      // about 10 m/s2 at four tenths to 17 flat out). So: as much as it takes to come round to
      // the spot on the line it is aiming for
      // Too fast for what comes, or a wall: off the power, and the slide itself scrubs the speed
      // off (braking hard in a slide only spins the car). Not sliding yet: the brake, as above
      if (over > 1.5 || wall) { if (slip > 12) want = over > 7 || wall ? -0.6 : 0; }
      else if (hold > 0.12) want = clamp(0.4 + (need - 10) / 12.5, 0.4, 1);
      else if (want > 0) want = Math.min(want, 0.7);
      // Starting it: a short pull of the handbrake with the wheel into the corner swings the
      // tail out; let go as soon as it is on its way
      if (!pulling && hold > 0.3 && ready && slipRad * -dir < hold * 0.35 && yaw * dir < 0.9 && t - m.pulledAt > 1.2) {
        m.pullUntil = t + TUNE.pull; m.pulledAt = t; m.pullSide = dir;
      }
      if (t < m.pullUntil) {
        if (slipRad * -m.pullSide > hold * 0.5 || yaw * m.pullSide > 1.5) m.pullUntil = t;
        else { handbrake = true; steer = m.pullSide; want = 1; }
      }
    }
  } else if (slip > 22 && want > 0.3) want = 0.3;   // sliding and not meaning to: off the power until it comes back

  // The foot moves quickly, but it does not jump: off the power faster than onto it
  const foot = handbrake ? want : m.foot + clamp(want - m.foot, -0.45, 0.3);
  m.foot = foot;
  return { steer, throttle: foot, handbrake };
}
