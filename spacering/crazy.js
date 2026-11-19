// Crazy squad: a bonus Space Ring bot (crazy.json). Like bot.js, whose header describes obs and the
// answer, but the squad flies loops in a tight formation and drops its flares like fireworks.

const S = Object.assign({
  hunt: false,       // chase enemies flying the same way, at boost
  range: 2000,       // fire at enemies this close
  slow: false,       // cruise slowly and let them come
  rearGuard: false,  // wingmen prefer targets behind
  flareAt: 650,      // drop a flare when a torpedo locked on us is this close
  gunReach: 0.95,    // use the cannon on enemies within this much of its bolts' reach (0..1)
  both: true,        // where the cannon reaches, send the missiles too (false: the cannon alone there)
  clear: true,       // wingmen also shoot the rocks ahead of their leader (false: only those in their own lane)
  crazy: true,       // loops in a tight formation, flares as fireworks (false: flies as bot.js)
  loopWidth: 300,    // crazy: how far each loop swings across the tube, either side of the middle
  loopTime: 4,       // crazy: seconds for one loop
}, (typeof self !== 'undefined' && self.BOT_SETTINGS) || {});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Where to aim (degrees, 0 ahead, 90 right) to meet [t], given the torpedo's speed relative to us. */
function leadAngle(me, t, speed) {
  const rvA = (t.vAhead || 0) - me.speed, rvX = (t.vx || 0) - me.vx;
  let pa = t.ahead, px = t.x - me.x, time = 0;
  for (let i = 0; i < 3; i++) {
    time = Math.hypot(pa, px) / speed;
    pa = t.ahead + rvA * time;
    px = t.x - me.x + rvX * time;
  }
  return { angle: Math.atan2(px, pa) * 180 / Math.PI, time };
}

/** Throttle (-1..1) that makes our speed [want]. */
function throttleFor(want, R) {
  if (want >= R.cruise) return clamp((want - R.cruise) / (R.boost - R.cruise), 0, 1);
  return -clamp((R.cruise - want) / (R.cruise - R.slowest), 0, 1);
}

function decide(o) {
  const me = o.you, R = o.rules, W = R.tubeWidth;
  if (me.entering) return {};
  const leader = me.role === 'leader' ? null : o.mates.find(m => m.id === me.leader);
  let wantX = me.x;
  let throttle = S.slow ? -0.5 : 0;

  // Crazy: where the squad is in its loop (the same for every ship: they all read the game's clock)
  const loop = Math.PI * 2 * (o.time || 0) / S.loopTime;

  if (leader) {
    // Wingmen: a V behind the leader, alternating sides (crazy: a tight one, close behind)
    const wings = [me, ...o.mates.filter(m => m.role === 'wing')].sort((a, b) => a.unit - b.unit);
    const i = wings.findIndex(m => m.id === me.id);
    const side = i % 2 === 0 ? -1 : 1;
    const spread = S.crazy ? 80 : S.slow ? 230 : 160;
    const behind = (S.crazy ? 100 : 150) * (1 + Math.floor(i / 2));
    wantX = leader.x + side * spread;
    const err = leader.ahead - behind;
    throttle = throttleFor(leader.vAhead + clamp(err * 1.5, -300, 400), R);
  } else {
    // The leader: gems near the path; a hunter goes after the nearest enemy flying our way
    const gem = o.gems.filter(g => g.ahead > 150 && g.ahead < 1400 && Math.abs(g.x - me.x) < 320)
      .sort((a, b) => a.ahead - b.ahead)[0];
    if (gem) wantX = gem.x;
    else wantX = me.x + (W / 2 - me.x) * 0.2;
    if (S.hunt) {
      const prey = o.enemies.filter(e => e.sameDirection && e.ahead > 0 && e.ahead < 6000).sort((a, b) => a.ahead - b.ahead)[0];
      if (prey) {
        wantX = prey.x;
        throttle = prey.ahead > 900 ? 1 : prey.ahead < 500 ? -0.4 : 0;
        if (me.boost < 0.15) throttle = Math.min(throttle, 0);
      }
    }
    // Someone on our tail: speed up to open the gap, while there's boost
    const tail = o.enemies.filter(e => e.sameDirection && e.ahead < 0 && e.ahead > -1200)[0];
    if (tail && !S.slow && me.boost > 0.3) throttle = Math.max(throttle, 0.7);
    // Crazy: loop the loop. Swing across the tube and back while speeding up and slowing down,
    // so the squad draws circles; the wingmen follow the leader, so they loop with it
    if (S.crazy) {
      wantX = W / 2 + S.loopWidth * Math.sin(loop);
      throttle = me.boost > 0.15 ? 0.8 * Math.cos(loop) : Math.min(0, 0.8 * Math.cos(loop));
    }
  }

  // Rocks in our lane: step aside to whichever side has more room
  const rock = o.rocks.filter(m => m.ahead > -40 && m.ahead < 750 && Math.abs(m.x - wantX) < m.r + R.shipSize * 1.3)
    .sort((a, b) => a.ahead - b.ahead)[0];
  if (rock) {
    const left = rock.x - rock.r - R.shipSize * 1.6, right = rock.x + rock.r + R.shipSize * 1.6;
    wantX = (wantX < rock.x ? left > R.shipSize : right > W - R.shipSize) ? left : right;
    if (wantX < R.shipSize || wantX > W - R.shipSize) wantX = wantX < W / 2 ? right : left;
  }

  // A torpedo locked on us: flare when it's close, and jink sideways
  const threat = o.torpedoes.filter(t => t.onYou).map(t => ({ t, d: Math.hypot(t.ahead, t.x - me.x) })).sort((a, b) => a.d - b.d)[0];
  let flare = false;
  if (threat) {
    if (threat.d < S.flareAt * (S.hunt ? 1.4 : 1) && me.flareReady) flare = true;
    if (threat.d < 900) wantX = me.x + (threat.t.x > me.x ? -260 : 260);
  }
  // Crazy: fireworks. A pair of flares at each side of the loop, keeping the last one for a real lock
  if (S.crazy && !flare && me.flareReady && me.flares > 1 && Math.abs(Math.sin(loop)) > 0.95) flare = true;

  // Shooting: the nearest enemy in range (rear guards prefer the ones behind), else a rock ahead.
  // Where the cannon's bolts reach the target: the cannon, and with it (S.both) every missile the
  // rack has. From further out: a missile, if the rack has one.
  let fire, weapon;
  const tenth = a => Math.round(a * 10) / 10;
  let targets = o.enemies.filter(e => !e.entering && Math.hypot(e.ahead, e.x - me.x) < S.range);
  if (S.rearGuard && leader) {
    const back = targets.filter(e => e.ahead < 0);
    if (back.length) targets = back;
  }
  targets.sort((a, b) => Math.hypot(a.ahead, a.x - me.x) - Math.hypot(b.ahead, b.x - me.x));
  for (const t of targets) {
    const c = leadAngle(me, t, R.cannonSpeed);
    if (c.time < R.cannonLife * S.gunReach) { fire = tenth(c.angle); weapon = S.both ? 'both' : 'cannon'; break; }
    if (!me.fireReady) continue;
    const l = leadAngle(me, t, R.torpedoSpeed);
    if (l.time < R.torpedoLife * 0.9) { fire = Math.round(l.angle); weapon = 'missile'; break; }
  }
  if (fire === undefined) {
    // Rocks: the nearest one in our own lane or, for a wingman, in the leader's (past the leader).
    // The cannon clears it.
    const inLane = (m, ship) => Math.abs(m.x - ship.x) < m.r + 30;
    const r = o.rocks.filter(m => m.ahead > 200 && m.ahead < 1000
      && (inLane(m, me) || (S.clear && leader && m.ahead > leader.ahead + 150 && inLane(m, leader))))
      .sort((a, b) => a.ahead - b.ahead)[0];
    const l = r && leadAngle(me, r, R.cannonSpeed);
    if (l && l.time < R.cannonLife * 0.95) { fire = tenth(l.angle); weapon = 'cannon'; }
  }

  return { x: clamp(wantX, R.shipSize * 1.4, W - R.shipSize * 1.4), throttle, fire, weapon, flare };
}

// For a server in Node (require('./bot.js').decide); a browser ignores this line
if (typeof module !== 'undefined' && module.exports) module.exports = { decide };
