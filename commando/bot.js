// Script Squad sample bot. It leads commandos, tanks and T-Rexes (obs.rules.unitType says which).
//
// decide(obs) is called for each unit of the squad, 5 times a second each, and returns that unit's
// answer. Anything kept outside decide() is shared by the whole squad. Run as an API, the bot gets
// the same obs as a JSON POST body, with the unit's id in the X-Commando-Id header, and answers
// with JSON; it is first sent an empty question ({}).
//
// obs. Positions in world units (rules.tile, 60, to a tile), x right, y down; angles in degrees,
// 0 right, 90 down, clockwise; speeds in units per second; times in seconds.
//   tick, time
//   you          this unit: id ("<team>-<unit>"), unit, team, type, sector (its team's map in
//                map.squares), alive, aboard, x, y, facing, vx, vy, hp, maxHp, ammo, reload,
//                shielded, respawnIn, reinforcements, tour, score. Tank: hull. T-Rex: roarIn,
//                stunned, held, locked.
//   team         every unit of the squad: id, unit, you, alive, x, y, facing, hp, maxHp, ammo
//   grid         the tiles round this unit: radius, originX, originY (world position of rows[0][0]),
//                rows ((2 * radius + 1) strings). S steel, B brick, b damaged brick, W water,
//                T trees, . open, @ this unit, A teammate, E enemy, o enemy bullet, H our base,
//                C enemy base, k our helicopter, K enemy helicopter.
//   soldiers     enemy units in view: id, team, name, type, x, y, vx, vy, facing, hp, maxHp, shielded
//   bullets      in view: x, y, vx, vy, mine
//   heard        gunfire heard: x, y, distance, bearing, age, mine
//   bases        our base, and enemy bases in view: mine, x, y, hp, maxHp, gun ("down", "rising",
//                "up", "lowering", "out"), gunHitsLeft; launcher and missiles (a tank team's base);
//                snake (a T-Rex team's base)
//   baseHealth   every standing base, seen or not: mine, sector, hp, maxHp
//   helicopters  near this unit: id, team, mine, x, y, vx, vy, heading, phase, aboard, hits,
//                hitsToKillNext, hitsToDestroy
//   map          sectors, sectorTiles, tilesX, tilesY, squares (top-left tile of each team's map)
//   rules        the game's numbers (tile, teamSize, walkSpeed, bulletRange, ...), unitType, and
//                melee (true for a T-Rex)
//
// Answer. A missing field changes nothing; an answer holds until the next one.
//   move    "forward" | "backward" | "stop", or -1..1
//   strafe  "left" | "right" | "none", or -1..1
//   aim     degrees: turn to this angle and hold it
//   turn    "left" | "right" | "none", or -1..1 (ignored when aim is given)
//   fire    true | false (a T-Rex bites)
//   reload  true: change the magazine now
//   say     "advance" | "retreat" | "hold" | "contact" (commandos only)
//   Tank:   hull "left" | "right" | "none" or -1..1 (move then drives along the hull);
//           turret "left" | "right" or -1..1
//   T-Rex:  roar true
//
// How it plays. Of the units standing:
//   guards   30%, rounded down: fight anything that comes near the base; otherwise face the side
//            gunfire comes from, or patrol a ring round the base.
//   raiders  the rest, in fire teams of up to four: search the enemy maps for their bases, fight
//            the units they meet, and besiege a base once found.
// After 10 s with nothing near the base, the guards raid too; when the base is hit, everyone
// returns. Outnumbered units fall back while firing. An enemy helicopter with soldiers aboard is
// shot first. The share of guards follows the bases' health (obs.baseHealth): 70% when ours is
// clearly worse than the enemies' average, 15% when clearly better, 30% otherwise.
//
// Settings (self.BOT_SETTINGS, from a style file such as attack.json):
//   guards        a fixed number of guards instead of a share (attack.json: 0, defend.json: 99)
//   guardShare    a fixed share of guards instead of the one set by the bases' health
//   quietSeconds  seconds with nothing near the base before the guards raid (default 10)

const SETTINGS = (typeof self !== 'undefined' && self.BOT_SETTINGS) || {};
const BLOCKS_SHOT = new Set('SBbHC');
const GUARD_RADIUS = 3;
const EXPLORE_STEP = 7;
const DEFEND_SECONDS = 10.0;
const ALERT_SECONDS = 6.0;
const QUIET_SECONDS = SETTINGS.quietSeconds ?? 10.0;
const GUARD_SHARE = 0.3;
const DEFEND_SHARE = 0.7;      // our base clearly worse than the enemies' average
const ATTACK_SHARE = 0.15;     // clearly better
const GAP_ENTER = 0.10;        // health gap (share of full) to start defending or attacking
const GAP_LEAVE = 0.05;        // ... and to stop: between the two, keep what we're doing
const BAD_SHAPE = 0.5;         // under half health
const TAKE_TURNS = 60;         // seconds each turn lasts when all are in bad shape and even
const QUIET_RADIUS = 20;
const MUZZLE = 22.0;
const SIEGE_RADIUS = 4;   // tiles from an enemy base: just outside its fort's brick ring
const SIEGE_SPOTS = 12;
const IDLE = { move: 'stop', strafe: 'none', turn: 'none', fire: false };

const hypot = Math.hypot;
const key = (x, y) => `${x},${y}`;
const unkey = k => k.split(',').map(Number);
const norm = deg => ((((deg + 180) % 360) + 360) % 360) - 180;
const heading = (x0, y0, x1, y1) => Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
const minBy = (list, f) => {
  let best = null, bv = Infinity;
  for (const v of list) {
    const s = f(v);
    if (s < bv) { bv = s; best = v; }
  }
  return best;
};

class Unit {
  constructor() {
    this.lastTime = null;
    this.tick = 0.2;
    this.path = [];
    this.pathGoal = null;
    this.pathAt = -99;
    this.stuckSince = null;
    this.unstickUntil = -1;
    this.unstickSide = 'left';
    this.explore = null;
    this.tile = null;
    this.retreating = false;
    this.turnedAt = -99;
  }
}

/** A tiny priority queue for the route planner. */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

class Team {
  constructor() {
    this.mem = new Map();
    this.units = new Map();
    this.baseHp = null;
    this.baseHitAt = -99;
    this.enemyBases = new Map();
    this.patrol = 0;
    this.noise = null;
    this.razed = new Set();
    this.guards = new Set();
    this.activeAt = null;
    this.quiet = false;
    this.said = new Map();
    this.gapSide = 'even';   // which side of the health gap we're on (with the margin)
    this.stance = 'even';    // what we do: 'defend', 'attack' or 'even'
    this.huntPick = Math.random();   // which of several equally near enemy maps this team chooses
  }

  /**
   * 'defend', 'attack' or 'even', from our base's health against the enemies' average. The gap
   * has to pass GAP_ENTER to change sides and fall under GAP_LEAVE to come back to even. Even
   * with every base in bad shape: odd and even maps take turns at attacking.
   */
  pickStance(obs) {
    const all = obs.baseHealth || [];
    const mine = all.find(b => b.mine);
    const enemies = all.filter(b => !b.mine);
    if (!mine || !enemies.length || SETTINGS.guards !== undefined || SETTINGS.guardShare !== undefined) return (this.stance = this.gapSide = 'even');
    const frac = b => b.hp / b.maxHp;
    const gap = enemies.reduce((s, b) => s + frac(b), 0) / enemies.length - frac(mine);   // > 0: ours worse
    if (gap > GAP_ENTER || (this.gapSide === 'defend' && gap > GAP_LEAVE)) this.gapSide = 'defend';
    else if (gap < -GAP_ENTER || (this.gapSide === 'attack' && gap < -GAP_LEAVE)) this.gapSide = 'attack';
    else this.gapSide = 'even';
    this.stance = this.gapSide;
    if (this.stance === 'even' && all.every(b => frac(b) < BAD_SHAPE)) {
      const turn = Math.floor(obs.time / TAKE_TURNS);
      this.stance = (mine.sector + turn) % 2 === 0 ? 'attack' : 'defend';
    }
    return this.stance;
  }

  /**
   * [nGuards] of the commandos standing guard the base: the ones already on guard stay, topped
   * up nearest home first (or trimmed). After QUIET_SECONDS with nothing near the base there are
   * none; anything happening there brings them back.
   */
  assignRoles(nearestHome, nGuards, now, activity, alarm) {
    if (this.activeAt === null) this.activeAt = now;
    if (activity || alarm) {
      this.activeAt = now;
      this.quiet = false;
    } else if (now - this.activeAt > QUIET_SECONDS && this.stance !== 'defend') {
      this.quiet = true;
    }
    if (this.quiet) {
      this.guards = new Set();
      return;
    }
    const keep = nearestHome.filter(m => this.guards.has(m));
    for (const m of nearestHome) {
      if (keep.length >= nGuards) break;
      if (!keep.includes(m)) keep.push(m);
    }
    this.guards = new Set(keep.slice(0, nGuards));
  }

  remember(obs) {
    const g = obs.grid;
    const t = obs.rules.tile;
    const ox = Math.round(g.originX / t), oy = Math.round(g.originY / t);
    g.rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const c = row[i];
        const k = key(ox + i, oy + j);
        if ('SBbWT.HC'.includes(c)) this.mem.set(k, c);
        else if (!this.mem.has(k)) this.mem.set(k, '.');
      }
    });
  }

  cost(tx, ty) {
    if (tx < 0 || ty < 0) return null;
    const c = this.mem.get(key(tx, ty)) ?? '.';
    if ('SWHC'.includes(c)) return null;
    if (c === 'B' || c === 'b') return 6.0;
    return 1.0;
  }

  /** A* over remembered tiles from start to within `near` tiles of goal: a list of [x, y], start first. */
  route(start, goal, near = 0, limit = 20000) {
    const h = p => Math.max(0, hypot(p[0] - goal[0], p[1] - goal[1]) - near);
    const frontier = new Heap();
    frontier.push([h(start), 0, start]);
    const came = new Map([[key(...start), null]]);
    const best = new Map([[key(...start), 0]]);
    let n = 0;
    while (frontier.size && n < limit) {
      const [, g, cur] = frontier.pop();
      n++;
      if (Math.max(Math.abs(cur[0] - goal[0]), Math.abs(cur[1] - goal[1])) <= near) {
        const out = [];
        let c = cur;
        while (c !== null) {
          out.push(c);
          c = came.get(key(...c));
        }
        return out.reverse();
      }
      if (g > (best.get(key(...cur)) ?? 1e18)) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nxt = [cur[0] + dx, cur[1] + dy];
        let c = this.cost(nxt[0], nxt[1]);
        if (c === null) continue;
        if (dx && dy) {
          if (this.cost(cur[0] + dx, cur[1]) !== 1.0 || this.cost(cur[0], cur[1] + dy) !== 1.0) continue;
          c *= 1.414;
        }
        const ng = g + c;
        const nk = key(...nxt);
        if (ng < (best.get(nk) ?? 1e18)) {
          best.set(nk, ng);
          came.set(nk, cur);
          frontier.push([ng + h(nxt), ng, nxt]);
        }
      }
    }
    return null;
  }
}

/** Each team map's top-left tile (maps in a row for a game that doesn't say). */
function squaresOf(world) {
  return world.squares || Array.from({ length: world.sectors }, (_, k) => [k * world.sectorTiles, 0]);
}

/** Which team map tile (tx, ty) is on, or -1 between maps. */
function sectorOfTile(world, tx, ty) {
  const S = world.sectorTiles;
  return squaresOf(world).findIndex(([x, y]) => tx >= x && tx < x + S && ty >= y && ty < y + S);
}

function tileAt(obs, x, y) {
  const g = obs.grid;
  const t = obs.rules.tile;
  const i = Math.floor((x - g.originX) / t);
  const j = Math.floor((y - g.originY) / t);
  const rows = g.rows;
  if (j >= 0 && j < rows.length && i >= 0 && i < rows[j].length) return rows[j][i];
  return '?';
}

function clearShot(obs, x0, y0, x1, y1) {
  const t = obs.rules.tile;
  const ex = Math.floor(x1 / t), ey = Math.floor(y1 / t);
  const steps = Math.max(1, Math.floor(hypot(x1 - x0, y1 - y0) / 12));
  for (let k = 1; k < steps; k++) {
    const f = k / steps;
    const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f;
    if (Math.floor(px / t) === ex && Math.floor(py / t) === ey) continue;
    if (BLOCKS_SHOT.has(tileAt(obs, px, py))) return false;
  }
  return true;
}

/**
 * What stands between two points: 'clear', 'brick' (only bricks, which bullets break, so
 * shooting through them is worth it) or 'solid' (steel, or another base).
 */
function shotLine(obs, x0, y0, x1, y1) {
  const t = obs.rules.tile;
  const ex = Math.floor(x1 / t), ey = Math.floor(y1 / t);
  const steps = Math.max(1, Math.floor(hypot(x1 - x0, y1 - y0) / 12));
  let line = 'clear';
  for (let k = 1; k < steps; k++) {
    const f = k / steps;
    const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f;
    if (Math.floor(px / t) === ex && Math.floor(py / t) === ey) continue;
    const c = tileAt(obs, px, py);
    if (c === 'B' || c === 'b') line = 'brick';
    else if (BLOCKS_SHOT.has(c)) return 'solid';
  }
  return line;
}

/**
 * What stands in the way of walking straight from one point to another, for a unit that breaks
 * brick walls by walking into them (a T-Rex): 'clear', 'brick' or 'solid' (steel, water, a base).
 */
function chargeLine(obs, x0, y0, x1, y1) {
  const t = obs.rules.tile;
  const ex = Math.floor(x1 / t), ey = Math.floor(y1 / t);
  const steps = Math.max(1, Math.floor(hypot(x1 - x0, y1 - y0) / 12));
  let line = 'clear';
  for (let k = 1; k < steps; k++) {
    const f = k / steps;
    const px = x0 + (x1 - x0) * f, py = y0 + (y1 - y0) * f;
    if (Math.floor(px / t) === ex && Math.floor(py / t) === ey) continue;
    const c = tileAt(obs, px, py);
    if (c === 'B' || c === 'b') line = 'brick';
    else if (c === 'S' || c === 'W' || c === 'H' || c === 'C' || c === '?') return 'solid';
  }
  return line;
}

function lead(me, target, rules) {
  const s = rules.bulletSpeed;
  const vx = target.vx || 0, vy = target.vy || 0;
  let t = 0;
  for (let i = 0; i < 3; i++) t = Math.max(0, (hypot(target.x + vx * t - me.x, target.y + vy * t - me.y) - MUZZLE) / s);
  return [target.x + vx * t, target.y + vy * t];
}

const teams = new Map();

function decide(obs) {
  const me = obs.you;
  if (!me || !obs.rules) return {};   // an empty question (an API check): no action
  const id = me.team ?? '?';
  if (!teams.has(id)) teams.set(id, new Team());
  return think(teams.get(id), obs);
}

function think(team, obs) {
  const me = obs.you;
  const rules = obs.rules;
  const n = me.unit;
  if (!team.units.has(n)) team.units.set(n, new Unit());
  const u = team.units.get(n);
  const now = obs.time;
  if (u.lastTime !== null && now > u.lastTime) u.tick = Math.min(0.5, now - u.lastTime);
  u.lastTime = now;
  team.remember(obs);

  const act = { ...IDLE };
  if (!me.alive) {
    u.path = [];
    u.tile = null;
    u.retreating = false;
    return act;
  }

  const T = rules.tile;
  const R = rules.soldierRadius;
  // A melee unit (a T-Rex): `fire` is a bite, so it must reach its target; it breaks brick walls
  // by walking into them; it can roar
  const melee = rules.melee === true;
  // Stunned by a roar, or held in a T-Rex's jaws: no action until it ends
  if (me.stunned || me.held) return act;
  const turnStep = rules.turnDegPerSec * u.tick;
  const myTile = [Math.floor(me.x / T), Math.floor(me.y / T)];
  const sameTile = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  u.tile = myTile;
  const base = obs.bases.find(b => b.mine) || null;
  let baseTile = null;
  if (base) {
    if (team.baseHp !== null && base.hp < team.baseHp) team.baseHitAt = now;
    team.baseHp = base.hp;
    baseTile = [Math.floor(base.x / T), Math.floor(base.y / T)];
  } else {
    team.baseHp = null;
  }
  const defending = base !== null && now - team.baseHitAt < DEFEND_SECONDS;

  // Enemy bases: remember every one any of us spots; forget one that's in view but gone
  const showing = new Map(obs.bases.filter(b => !b.mine).map(b => [key(b.x, b.y), b.hp]));
  for (const [k, v] of showing) team.enemyBases.set(k, v);
  for (const k of [...team.enemyBases.keys()]) {
    const [bx, by] = unkey(k);
    if (!showing.has(k) && tileAt(obs, bx, by) !== '?') {
      team.enemyBases.delete(k);
      team.razed.add(sectorOfTile(obs.map, Math.floor(bx / T), Math.floor(by / T)));
    }
  }

  // Listen: remember the shots that aren't ours, preferring whatever is closest to the base
  if (base) {
    for (const h of obs.heard || []) {
      if (h.mine) continue;
      const d = hypot(h.x - base.x, h.y - base.y);
      const old = team.noise;
      if (old === null || now - old[2] > 1.0 || d <= hypot(old[0] - base.x, old[1] - base.y)) team.noise = [h.x, h.y, now];
    }
  }
  const noise = base && team.noise && now - team.noise[2] < ALERT_SECONDS ? team.noise : null;

  let aim = null, aimR = 0, fireOk = false, walkTo = null, sidestep = false, backOff = false;
  // A base's missile launcher (a tank team's base): rising, or up with a missile left, it is
  // deadly nearby. A missile flies to where its target stood at launch, so a moving unit this far
  // out escapes it (its blast radius, outrun at this unit's speed)
  const missilesUp = b => !!b && b.launcher === true && (b.gun === 'rising' || (b.gun === 'up' && (b.missiles ?? 1) > 0));
  const missileSafe = Math.min(640, ((rules.missileSplash ?? 85) + R + 10) * (rules.missileSpeed ?? 520) / Math.max(40, rules.walkSpeed));
  // A nest's snake (a T-Rex team's base) out of its hole strikes anything in reach. A roar nearby
  // sends it back in, so a T-Rex with its roar ready goes in and roars; other units stay out of
  // reach until it is back in
  const snakeOut = b => !!b && b.snake === true && (b.gun === 'rising' || b.gun === 'up');
  const snakeSafe = (rules.snakeReach ?? 300) + R + 40;
  const canScare = rules.melee === true && (me.roarIn ?? 1) <= 0;
  /** How far to keep from enemy base [b] just now (0: no need). */
  const keepOutOf = b => (missilesUp(b) ? missileSafe : snakeOut(b) && !canScare ? snakeSafe : 0);
  let dodgeSide = null, dodgeMove = 'stop';   // circling a base whose gun is up

  const straight = tile => {
    const x1 = (tile[0] + 0.5) * T, y1 = (tile[1] + 0.5) * T;
    const d = hypot(x1 - me.x, y1 - me.y);
    const steps = Math.max(1, Math.floor(d / 15));
    const nx = -(y1 - me.y) / Math.max(d, 1), ny = (x1 - me.x) / Math.max(d, 1);
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      const px = me.x + (x1 - me.x) * f, py = me.y + (y1 - me.y) * f;
      for (const off of [-R, 0, R]) {
        if (team.cost(Math.floor((px + nx * off) / T), Math.floor((py + ny * off) / T)) !== 1.0) return false;
      }
    }
    return true;
  };

  const indexIn = (path, tile) => path.findIndex(p => sameTile(p, tile));

  const go = (goal, near) => {
    if (!sameTile(goal, u.pathGoal) || now - u.pathAt > 1.2 || !u.path.length || indexIn(u.path, myTile) < 0) {
      u.path = team.route(myTile, goal, near) || [];
      u.pathGoal = goal;
      u.pathAt = now;
    }
    if (!u.path.length) return false;
    const rest = u.path.slice(indexIn(u.path, myTile) + 1);
    if (!rest.length) return true;
    const nxt = rest[0];
    const m = team.mem.get(key(...nxt));
    if (m === 'B' || m === 'b') {
      if (aim === null || !fireOk) {
        aim = [(nxt[0] + 0.5) * T, (nxt[1] + 0.5) * T];
        aimR = T * 0.45;
        fireOk = true;
      }
      // A T-Rex also walks into the wall, which breaks it
      if (melee) walkTo = [(nxt[0] + 0.5) * T, (nxt[1] + 0.5) * T];
      return true;
    }
    let way = nxt;
    for (const cand of rest.slice(1, 4)) {
      const cm = team.mem.get(key(...cand));
      if (cm === 'B' || cm === 'b' || !straight(cand)) break;
      way = cand;
    }
    walkTo = [(way[0] + 0.5) * T, (way[1] + 0.5) * T];
    return true;
  };

  // ----- choose a target -----
  let target = null, best = null;
  for (const e of obs.soldiers) {
    // A shielded soldier (just landed) cannot be hurt yet
    if (e.shielded) continue;
    const d = hypot(e.x - me.x, e.y - me.y);
    let score = d + e.hp * 12;
    // A T-Rex prefers a target that is dazed or locked with another: it cannot bite back
    if (rules.melee === true && (e.stunned || e.locked)) score -= 260;
    if (base) {
      const nearBase = hypot(e.x - base.x, e.y - base.y) / T;
      if (nearBase < 7) score -= 400 - nearBase * 40;
    }
    if (!clearShot(obs, me.x, me.y, e.x, e.y)) score += 300;
    if (best === null || score < best) {
      best = score;
      target = e;
    }
  }
  let targetR = R;
  for (const h of obs.helicopters || []) {
    if (h.mine || h.aboard === 0 || h.phase === 'down' || melee) continue;   // a T-Rex cannot reach a helicopter
    let score = hypot(h.x - me.x, h.y - me.y) - 350;
    if (!clearShot(obs, me.x, me.y, h.x, h.y)) score += 300;
    if (best === null || score < best) {
      best = score;
      target = { x: h.x, y: h.y, vx: h.vx || 0, vy: h.vy || 0, hp: h.hitsToDestroy, shielded: false };
      targetR = rules.heliRadius ?? 42;
    }
  }

  // How far it can hit something of radius [tr]: a gun's range, or a bite's (skin to skin)
  const reachTo = tr => (melee ? R + tr + (rules.biteReach ?? 30) : rules.bulletRange + MUZZLE);
  const reach = reachTo(targetR);
  const targetD = target ? hypot(target.x - me.x, target.y - me.y) : 0;
  let targetOpen = false;
  if (target) {
    const [ax, ay] = lead(me, target, rules);
    targetOpen = targetD < reach * 0.95 && (melee || (clearShot(obs, me.x, me.y, ax, ay) && clearShot(obs, me.x, me.y, target.x, target.y)));
    aim = [ax, ay];
    aimR = targetR;
    fireOk = targetOpen && !target.shielded;
  }

  // ----- who does what -----
  const size = rules.teamSize ?? 4;
  const aliveMates = obs.team.filter(m => m.alive);
  // The share of units that guard (rounded down, so a last unit attacks), set by how our base
  // stands against the enemies'
  const stance = team.pickStance(obs);
  const share = stance === 'defend' ? DEFEND_SHARE : stance === 'attack' ? ATTACK_SHARE : GUARD_SHARE;
  const nGuards = SETTINGS.guards !== undefined ? Math.min(SETTINGS.guards, aliveMates.length)
    : Math.floor(aliveMates.length * (SETTINGS.guardShare ?? share));
  const standing = aliveMates.map(m => m.unit).sort((a, b) => a - b);
  const home = base ? [base.x, base.y] : [me.x, me.y];
  const nearestHome = [...aliveMates].sort((a, b) => hypot(a.x - home[0], a.y - home[1]) - hypot(b.x - home[0], b.y - home[1])).map(m => m.unit);
  const distHome = hypot(me.x - home[0], me.y - home[1]) / T;
  const activity = !!base && (
    (target !== null && hypot(target.x - home[0], target.y - home[1]) / T < QUIET_RADIUS) ||
    (team.noise !== null && now - team.noise[2] < 1.0 && hypot(team.noise[0] - home[0], team.noise[1] - home[1]) / T < QUIET_RADIUS)
  );
  team.assignRoles(nearestHome, nGuards, now, activity, defending);
  const guard = team.guards.has(n);

  const world = obs.map;
  const squares = squaresOf(world);
  const guardsUp = standing.filter(m => team.guards.has(m));
  const raidersUp = standing.filter(m => !team.guards.has(m));
  const fireTeam = raidersUp.includes(n) ? Math.floor(raidersUp.indexOf(n) / 4) : -1;
  const teamMates = fireTeam >= 0 ? raidersUp.slice(fireTeam * 4, (fireTeam + 1) * 4) : [];
  const leader = teamMates.length ? teamMates[0] : n;
  const slot = guardsUp.includes(n) ? guardsUp.indexOf(n) : guardsUp.length + (n % 3);
  const recalled = defending && distHome > 8;

  // ----- outnumbered? -----
  const foes = obs.soldiers.filter(e => hypot(e.x - me.x, e.y - me.y) < 700);
  const beside = aliveMates.filter(m => hypot(m.x - me.x, m.y - me.y) < 450);
  const wasRetreating = u.retreating;
  // A T-Rex never falls back: it cannot fight from a distance
  const outnumbered = !melee && foes.length >= 2 && foes.length > beside.length && (base === null || distHome > 6);
  if (outnumbered !== u.retreating && (now - u.turnedAt > 3.0 || !foes.length)) {
    u.retreating = outnumbered;
    u.turnedAt = now;
  }
  if (u.retreating !== wasRetreating) {
    const order = u.retreating ? 'retreat' : 'advance';
    if (now - (team.said.get(order) ?? -99) > 4.0) {
      team.said.set(order, now);
      act.say = order;
    }
  }

  // ----- decide where to be -----
  const ringPoint = k => {
    const a = k * 45 * Math.PI / 180;
    return [baseTile[0] + Math.round(Math.cos(a) * GUARD_RADIUS), baseTile[1] + Math.round(Math.sin(a) * GUARD_RADIUS)];
  };

  const guardPost = () => {
    // The posts are 8 points round the base; with more than 8 guards two share a post
    let k = team.patrol + slot * (Math.floor(8 / Math.max(1, guardsUp.length)) || 1);
    let p = ringPoint(k);
    for (let i = 0; i < 8; i++) {
      p = ringPoint(k);
      if (team.cost(p[0], p[1]) === 1.0) break;
      k++;
    }
    if (n === Math.min(...standing) && Math.max(Math.abs(p[0] - myTile[0]), Math.abs(p[1] - myTile[1])) <= 1) team.patrol = (k + 1) % 8;
    return p;
  };

  const listeningPost = () => {
    const k = Math.round(heading(base.x, base.y, noise[0], noise[1]) / 45);
    const found = [];
    for (const step of [0, 1, -1, 2, -2, 3, -3, 4]) {
      const p = ringPoint(k + step);
      if (team.cost(p[0], p[1]) === 1.0) found.push(p);
    }
    if (!found.length) return myTile;
    return found[Math.min(slot, found.length - 1)];
  };

  const explore = () => {
    const leadUnit = team.units.get(leader);
    if (n !== leader && leadUnit && leadUnit.tile) {
      if (Math.max(Math.abs(leadUnit.tile[0] - myTile[0]), Math.abs(leadUnit.tile[1] - myTile[1])) > 2) go(leadUnit.tile, 1);
      return;
    }
    const side = world.sectorTiles;
    const hunting = [];
    squares.forEach(([sx, sy], k) => { if (k !== me.sector && !team.razed.has(k)) hunting.push([sx + side / 2, sy + side / 2]); });
    // The nearest enemy map; among maps about as near, each team keeps its own random choice,
    // so two teams do not always pick the same neighbour
    const dist = c => hypot(c[0] - myTile[0], c[1] - myTile[1]);
    const nearest = hunting.length ? Math.min(...hunting.map(dist)) : 0;
    const close = hunting.filter(c => dist(c) <= nearest * 1.15 + 1);
    const centre = close.length ? close[Math.floor(team.huntPick * close.length)] : myTile;
    if (u.explore === null || team.mem.has(key(...u.explore))) {
      const unseen = [];
      for (const [sx, sy] of squares) {
        for (let gx = sx + 3; gx < sx + side - 2; gx += EXPLORE_STEP) {
          for (let gy = sy + 3; gy < sy + side - 2; gy += EXPLORE_STEP) if (!team.mem.has(key(gx, gy))) unseen.push([gx, gy]);
        }
      }
      unseen.sort((a, b) => hypot(a[0] - centre[0], a[1] - centre[1]) - hypot(b[0] - centre[0], b[1] - centre[1]));
      u.explore = unseen.length ? unseen[Math.min(Math.max(fireTeam, 0), unseen.length - 1)] : null;
    }
    if (u.explore !== null) {
      if (!go(u.explore, 1)) {
        team.mem.set(key(...u.explore), 'S');
        u.explore = null;
      }
    } else if (baseTile) {
      go(guardPost(), 0);
    }
  };

  const targetNearBase = !!(target && base && hypot(target.x - base.x, target.y - base.y) / T < 9);

  // A raider with an enemy base in reach (only bricks in the way) shoots the base rather than
  // chase a soldier it cannot hit
  let siegeReady = false;
  if (team.enemyBases.size && !guard) {
    const [ex, ey] = unkey(minBy([...team.enemyBases.keys()], k => { const [x, y] = unkey(k); return hypot(x - me.x, y - me.y); }));
    siegeReady = tileAt(obs, ex, ey) !== '?' && (melee
      ? hypot(ex - me.x, ey - me.y) < reachTo(rules.baseCoreRadius ?? 32)
      : hypot(ex - me.x, ey - me.y) < reach * 0.9 && shotLine(obs, me.x, me.y, ex, ey) !== 'solid');
  }

  if (u.retreating && foes.length && !recalled) {
    const fx = foes.reduce((s, e) => s + e.x, 0) / foes.length;
    const fy = foes.reduce((s, e) => s + e.y, 0) / foes.length;
    const myGap = hypot(me.x - fx, me.y - fy);
    const behind = aliveMates.filter(m => m.unit !== n && hypot(m.x - me.x, m.y - me.y) >= 450 && hypot(m.x - fx, m.y - fy) > myGap);
    let rally = null;
    if (behind.length) {
      const mate = minBy(behind, m => hypot(m.x - me.x, m.y - me.y));
      rally = [Math.floor(mate.x / T), Math.floor(mate.y / T)];
    } else if (baseTile) {
      rally = baseTile;
    }
    if (rally) go(rally, 1);
    if (walkTo === null) walkTo = [me.x + (me.x - fx) / Math.max(myGap, 1) * 150, me.y + (me.y - fy) / Math.max(myGap, 1) * 150];
  } else if (recalled) {
    // Return home: shooting at a foe in the open while walking, otherwise at full speed
    if (!targetOpen) {
      aim = null;
      fireOk = false;
    }
    go(baseTile, 3);
  } else if (target && targetOpen) {
    if (melee) walkTo = [target.x, target.y];   // a T-Rex stays on its target
    else {
      sidestep = true;
      if (targetD < 200) backOff = true;
      else if (targetD > 480 && !guard) walkTo = [target.x, target.y];
    }
  } else if (target && !siegeReady && (!guard || targetNearBase || defending)) {
    // A T-Rex runs straight at it when only bricks, if anything, are in the way: it breaks through
    if (melee && chargeLine(obs, me.x, me.y, target.x, target.y) !== 'solid') walkTo = [target.x, target.y];
    else go([Math.floor(target.x / T), Math.floor(target.y / T)], 0);
  } else if (baseTile && (defending || guard)) {
    if (noise) {
      go(listeningPost(), 0);
      if (aim === null) {
        aim = [noise[0], noise[1]];
        aimR = 0;
        fireOk = false;
      }
    } else {
      go(guardPost(), 0);
    }
  } else if (team.enemyBases.size) {
    const [ex, ey] = unkey(minBy([...team.enemyBases.keys()], k => { const [x, y] = unkey(k); return hypot(x - me.x, y - me.y); }));
    const d = hypot(ex - me.x, ey - me.y);
    const bt = [Math.floor(ex / T), Math.floor(ey / T)];
    // Each raider takes its own spot on a ring round the base, so they spread out
    const ring = [];
    for (let k = 0; k < SIEGE_SPOTS; k++) {
      const a = k * 2 * Math.PI / SIEGE_SPOTS;
      const p = [bt[0] + Math.round(Math.cos(a) * SIEGE_RADIUS), bt[1] + Math.round(Math.sin(a) * SIEGE_RADIUS)];
      if (team.cost(p[0], p[1]) === 1.0 && !ring.some(q => sameTile(q, p))) ring.push(p);
    }
    // Spots in order round the ring starting from the side facing home, shared out evenly
    const fromHome = Math.atan2(home[1] - ey, home[0] - ex);
    const turn = p => ((Math.atan2(p[1] + 0.5 - ey / T, p[0] + 0.5 - ex / T) - fromHome) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    ring.sort((a, b) => turn(a) - turn(b));
    const besiegers = raidersUp.length ? raidersUp : [n];
    const rank = Math.max(0, besiegers.indexOf(n));
    const spot = ring.length ? ring[Math.floor(rank * ring.length / besiegers.length) % ring.length] : null;
    // Fire whenever the base is in reach and only bricks, if anything, are in the way: the
    // bullets break the bricks
    const line = tileAt(obs, ex, ey) !== '?' && d < reach * 0.9 ? shotLine(obs, me.x, me.y, ex, ey) : 'solid';
    // Its gun is out of its hole: keep moving
    const eb = obs.bases.find(b => !b.mine && hypot(b.x - ex, b.y - ey) < T);
    const gunLive = !!eb && !!eb.gun && eb.gun !== 'down' && eb.gun !== 'out';
    const launcherUp = missilesUp(eb);
    const keepOut = keepOutOf(eb);
    if (melee && keepOut) {
      // A T-Rex cannot bite from there: it keeps moving until the launcher (or the snake) goes down
      aim = [ex, ey];
      aimR = rules.baseCoreRadius ?? 32;
      fireOk = false;
      if (!u.orbitAt || now >= u.orbitAt) {
        u.orbitDir = Math.random() < 0.5 ? 'left' : 'right';
        u.orbitAt = now + 1.5 + Math.random() * 3;
      }
      dodgeSide = u.orbitDir;
      dodgeMove = d < keepOut + 30 ? 'backward' : d > keepOut + 140 ? 'forward' : 'stop';
    } else if (melee) {
      // A T-Rex goes up to the base and bites it, through any bricks in the way
      aim = [ex, ey];
      aimR = rules.baseCoreRadius ?? 32;
      fireOk = d < reachTo(aimR);
      if (chargeLine(obs, me.x, me.y, ex, ey) !== 'solid') walkTo = [ex, ey];
      else go(bt, 1);
    } else if (line !== 'solid' && gunLive) {
      aim = [ex, ey];
      aimR = rules.baseCoreRadius ?? 32;
      fireOk = true;
      // Circle the base while firing, each unit its own way, switching at random so the gun
      // cannot follow; step away from a teammate that is too close (the gun fires at groups)
      if (!u.orbitAt || now >= u.orbitAt) {
        u.orbitDir = Math.random() < 0.5 ? 'left' : 'right';
        u.orbitAt = now + 1.5 + Math.random() * 3;
      }
      dodgeSide = u.orbitDir;
      const crowd = (rules.gunCrowd ?? 150) * 0.9;
      const close = aliveMates.filter(m => m.unit !== n && hypot(m.x - me.x, m.y - me.y) < crowd);
      if (close.length) {
        const m = minBy(close, q => hypot(q.x - me.x, q.y - me.y));
        dodgeSide = norm(heading(me.x, me.y, m.x, m.y) - heading(me.x, me.y, ex, ey)) > 0 ? 'left' : 'right';
      }
      // Move in or out a little at times, staying in reach
      const wave = Math.sin(now * 1.3 + n * 2.1);
      // Near a missile launcher: no closer than a missile can be outrun
      const inner = launcherUp ? Math.max(reach * 0.5, missileSafe + 20) : reach * 0.5;
      dodgeMove = d < inner ? 'backward' : d > Math.max(reach * 0.85, inner + 50) ? 'forward' : wave > 0.6 ? 'forward' : wave < -0.6 ? 'backward' : 'stop';
    } else if (line !== 'solid') {
      aim = [ex, ey];
      aimR = rules.baseCoreRadius ?? 32;
      fireOk = true;
      // Pressed against a teammate: move towards its own spot, still firing
      const squeezed = aliveMates.some(m => m.unit !== n && hypot(m.x - me.x, m.y - me.y) < R * 2.6);
      if (squeezed && spot && !sameTile(spot, myTile)) go(spot, 0);
    } else if (spot) {
      go(spot, 0);
    } else {
      go(bt, 3);
    }
  } else {
    explore();
  }

  // ----- too near a missile launcher that is up, or a snake that is out: move away first -----
  for (const b of obs.bases) {
    const keep = b.mine ? 0 : keepOutOf(b);
    if (!keep) continue;
    const d = hypot(b.x - me.x, b.y - me.y);
    if (d >= keep) continue;
    // Straight out if the way is clear, otherwise towards home
    const ox = me.x + (me.x - b.x) / Math.max(d, 1) * 150, oy = me.y + (me.y - b.y) / Math.max(d, 1) * 150;
    const out = [Math.floor(ox / T), Math.floor(oy / T)];
    aim = null;
    fireOk = false;
    sidestep = false;
    backOff = false;
    dodgeSide = null;
    walkTo = null;
    if (team.cost(out[0], out[1]) === 1.0 && straight(out)) walkTo = [ox, oy];
    else if (!baseTile || !go(baseTile, 2) || walkTo === null) { walkTo = [ox, oy]; aim = null; fireOk = false; }
    break;
  }

  // ----- turn the plan into an answer -----
  let aimDeg;
  if (aim !== null) aimDeg = heading(me.x, me.y, aim[0], aim[1]);
  else if (walkTo !== null) aimDeg = heading(me.x, me.y, walkTo[0], walkTo[1]);
  else aimDeg = me.facing;
  act.aim = Math.round((((aimDeg % 360) + 360) % 360) * 10) / 10;

  const swing = Math.max(-turnStep / 2, Math.min(turnStep / 2, norm(aimDeg - me.facing)));
  const facing = me.facing + swing;
  const walkDir = worldDeg => {
    const rel = norm(worldDeg - facing);
    const a = Math.abs(rel);
    act.move = a < 67.5 ? 'forward' : a > 112.5 ? 'backward' : 'stop';
    act.strafe = a < 22.5 || a > 157.5 ? 'none' : rel > 0 ? 'right' : 'left';
  };

  if (now < u.unstickUntil) {
    act.move = 'backward';
    act.strafe = u.unstickSide;
  } else if (walkTo !== null) {
    const weave = u.retreating ? (Math.floor(now / 0.6 + n) % 2 === 0 ? 35 : -35) : 0;
    walkDir(heading(me.x, me.y, walkTo[0], walkTo[1]) + weave);
  } else if (backOff) {
    act.move = 'backward';
  }
  if (sidestep && walkTo === null) act.strafe = Math.floor(now / 0.7 + n) % 2 === 0 ? 'left' : 'right';
  if (dodgeSide && walkTo === null && now >= u.unstickUntil) {
    act.strafe = dodgeSide;
    act.move = dodgeMove;
    // Against a wall: circle the other way
    if (hypot(me.vx, me.vy) < 12) {
      if (u.dodgeStuck == null) u.dodgeStuck = now;
      if (now - u.dodgeStuck > 0.5) {
        u.orbitDir = u.orbitDir === 'left' ? 'right' : 'left';
        u.orbitAt = now + 1.5 + Math.random() * 3;
        u.dodgeStuck = null;
      }
    } else {
      u.dodgeStuck = null;
    }
  }

  if (walkTo !== null && hypot(me.vx, me.vy) < 12) {
    if (u.stuckSince === null) u.stuckSince = now;
    // A T-Rex pushing on a wall is not stuck: breaking it takes time
    if (now - u.stuckSince > (melee ? 2.5 : 1.0)) {
      u.unstickUntil = now + 0.5;
      u.unstickSide = u.unstickSide === 'right' ? 'left' : 'right';
      u.stuckSince = null;
      u.path = [];
    }
  } else {
    u.stuckSince = null;
  }

  if (aim !== null && fireOk && me.reload <= 0.05) {
    const d = hypot(aim[0] - me.x, aim[1] - me.y);
    const tol = melee ? 45 : Math.max(2.5, Math.atan2(aimR, Math.max(d, 1)) * 180 / Math.PI);
    act.fire = d < (melee ? reachTo(aimR) : reach) && Math.abs(norm(aimDeg - me.facing)) < tol;
  }
  if (!melee && !obs.soldiers.length && !act.fire && me.ammo < rules.magazine * 0.4) act.reload = true;
  // Roar against a group, or against a single enemy when badly hurt
  if (melee && (me.roarIn ?? 1) <= 0) {
    const near = obs.soldiers.filter(e => !e.stunned && !e.held && hypot(e.x - me.x, e.y - me.y) < (rules.roarRadius ?? 240) * 0.9);
    if (near.length >= 2 || (near.length === 1 && me.hp < me.maxHp * 0.6)) act.roar = true;
    // and to send a nest's snake back into its hole
    if (obs.bases.some(b => !b.mine && snakeOut(b) && hypot(b.x - me.x, b.y - me.y) < (rules.roarRadius ?? 240) * 0.9)) act.roar = true;
  }
  return act;
}

// In Node the same file is a module: require("./bot.js").decide. In the browser this line does nothing.
if (typeof module !== 'undefined' && module.exports) module.exports = { decide };
