// Two Fists: the sample bot. The game's built-in bots are this file with different settings.
// To use your own, put it in a GitHub repository as bot.js and paste the repository's link into
// the game, or answer the same questions from your own API.
//
// decide(obs) is called about 20 times a second and returns the answer.
//
// Frame and units: every position is in your boxer's own frame, f forward (negative: behind),
// r to your right (negative: to your left), origin between your shoulders. Ring units: a glove
// is 32 across, your reach from the shoulder is 160, the ring is 900 from rope to rope. Speeds
// (v) are units a second. Your boxer always turns to face the other one.
//
// obs:
//   t, phase        seconds; 'ready', 'fight', 'count' (someone is down), 'rest', 'over'.
//                   Only 'fight' uses the answer; while down, the bot is not asked
//   round, timeLeft the round (1 to rules.rounds) and its seconds left
//   you             hp, maxHp, breath (0 to 100; punching empties it, a tired arm is slower),
//                   stunned, downs, hands [left, right] ({ f, r, v: { f, r } }),
//                   ringCentre { f, r } (far away: near the ropes)
//   foe             head { f, r }, body { f, r }, facing (degrees from your facing; 180: at you),
//                   hands [left, right] ({ f, r, v }; v towards you is a punch coming), v { f, r },
//                   hp, maxHp, breath, stunned, down, downs
//   rules           reach 160, shoulder 60 (shoulders at r = -60 and +60), guard { f, r },
//                   headRadius 36, gloveRadius 32, ringHalf 450, rounds 3, roundSeconds 60
//
// Answer: { left: { f, r } | null, right: { f, r } | null, move: { f, r } }
//   left, right     the point that glove is pulled to; null returns it to the guard. A point
//                   beyond reach is kept at the arm's end; a glove never goes behind the back
//   move            the feet, f forward (+) or back (-), r right (+) or left (-), each -1 to 1
//
// A punch lands as hard as the glove is moving when it touches: aim 40 to 100 past the head and
// return it (null) about a quarter of a second later. Under about 500 a second a glove does no
// harm. Only head hits score. A straight reaches about 205 from body to body.
//
// API: the game sends each question as a POST with JSON and the header X-Boxer-Id, and reads the
// answer as JSON. It must be https and allow CORS (Access-Control-Allow-Origin: *, and
// Access-Control-Allow-Headers: Content-Type, X-Boxer-Id). After 1.5 s with no answer, the
// gloves return to the guard.
//
// Settings (self.BOT_SETTINGS): style, 'steady' (default), 'brawler' or 'counter'.

const S = (typeof self !== 'undefined' && self.BOT_SETTINGS) || {};
const STYLE = S.style || 'steady';
// Per style:
//   out     distance to the other head while waiting, just out of range
//   inside  distance to the other head at which it throws
//   every   seconds between attacks (varied at random)
//   through how far past the head a punch is aimed
//   hook    chance that a punch is a hook
//   combo   chance that the other hand follows
//   block   chance of blocking a punch that is coming
//   circle  how fast it moves sideways while waiting
const TUNE = {
  steady: { out: 245, inside: 168, every: 0.9, through: 80, hook: 0.15, combo: 0.35, block: 0.6, circle: 0.45 },
  brawler: { out: 225, inside: 156, every: 0.55, through: 95, hook: 0.45, combo: 0.6, block: 0.3, circle: 0.3 },
  counter: { out: 255, inside: 172, every: 1.6, through: 90, hook: 0.25, combo: 0.5, block: 0.9, circle: 0.6 },
}[STYLE] || {};

// Each hand's punch in progress ({ kind, until, target }), and when each hand may punch again
const punches = [null, null];
const rested = [0, 0];
let nextAt = 0, circleDir = 1, circleUntil = 0, counterAt = -1;
// The feet: 'out' (waiting out of range), 'in' (stepping in to throw), 'hit' (throwing), 'back' (stepping out)
let mode = 'out', modeUntil = 0;

const len = p => Math.hypot(p.f, p.r);

function decide(obs) {
  const { you, foe, rules, t } = obs;
  const head = foe.head, reach = rules.reach, sh = rules.shoulder;
  const answer = { left: null, right: null, move: { f: 0, r: 0 } };
  if (obs.phase !== 'fight') return answer;

  // Feet: wait out of range on its toes and circle; when it is time, step in all the way, throw,
  // and step back out. Stay off the ropes
  const d = len(head);
  if ((mode === 'in' || mode === 'hit') && t > modeUntil) { mode = 'back'; modeUntil = t + 0.7; }
  if (mode === 'back' && (d > TUNE.out - 10 || t > modeUntil)) mode = 'out';
  if (mode === 'out' && t >= nextAt && d > TUNE.inside + 40 && you.breath > 25) { mode = 'in'; modeUntil = t + 1.1; }
  const bounce = Math.sin(t * 6) * 0.25;
  answer.move.f = mode === 'in' ? 1 : mode === 'back' ? -1 : mode === 'hit' ? 0 : Math.max(-0.5, Math.min(1, (d - TUNE.out) / 70)) + bounce;
  if (t > circleUntil) { circleDir = Math.random() < 0.5 ? -1 : 1; circleUntil = t + 0.8 + Math.random() * 2; }
  answer.move.r = circleDir * TUNE.circle * (mode === 'in' ? 0.3 : mode === 'back' ? 1.6 : 1) * (0.55 + 0.45 * Math.abs(Math.sin(t * 6)));
  const c = you.ringCentre;
  if (len(c) > 280) { answer.move.f += c.f / len(c) * 0.6; answer.move.r += c.r / len(c) * 0.6; }
  if (you.breath < 20) answer.move.f = Math.min(answer.move.f, -0.6);   // out of breath: back off

  // Is a glove coming at our face? Put the nearer of ours in its way
  let threat = null;
  for (const g of foe.hands) {
    const toward = -(g.v.f * g.f + g.v.r * g.r) / (len(g) || 1);
    if (toward > 700 && len(g) < 230 && (!threat || len(g) < len(threat))) threat = g;
  }
  if (threat && Math.random() < TUNE.block) {
    const i = threat.r < 0 ? 0 : 1;
    if (!punches[i] || punches[i].kind !== 'go') {
      const k = 60 / (len(threat) || 1);
      punches[i] = { kind: 'block', until: t + 0.3, target: { f: threat.f * k + 8, r: threat.r * k } };
      if (STYLE === 'counter') counterAt = t + 0.25;
    }
  }

  // Throw a punch when the head is in reach and it is time (or right after a block, for the counter puncher)
  const inReach = Math.hypot(head.f, head.r - sh) < reach + 10 || Math.hypot(head.f, head.r + sh) < reach + 10;
  const time = (mode === 'in' && d < TUNE.inside + 15) || (counterAt > 0 && t >= counterAt);
  if (inReach && time && you.breath > 15 && !you.stunned) {
    counterAt = -1;
    if (mode === 'in') { mode = 'hit'; modeUntil = t + 0.4; }   // it stays while the punch is out
    const free = [0, 1].filter(i => !punches[i] && t > rested[i]);
    if (free.length) {
      const i = free[Math.floor(Math.random() * free.length)];
      throwPunch(i, head, t, sh);
      nextAt = t + TUNE.every * (0.6 + Math.random() * 0.8);
      const other = 1 - i;
      if (!punches[other] && Math.random() < TUNE.combo) {
        punches[other] = { kind: 'wait', until: t + 0.18, then: () => throwPunch(other, head, t + 0.18, sh) };
      }
    }
  }

  // Each hand: out on its punch, or back to guard
  for (const i of [0, 1]) {
    const p = punches[i];
    let target = null;
    if (p && t >= p.until) {
      if (p.kind === 'wait') { punches[i] = null; p.then(); }
      else if (p.kind === 'hook1') { punches[i] = { kind: 'go', until: t + 0.22, target: p.next }; }
      else { punches[i] = null; rested[i] = t + 0.25; }
    }
    const now = punches[i];
    if (now && now.kind !== 'wait') target = now.target;
    if (i === 0) answer.left = target; else answer.right = target;
  }
  return answer;
}

/** Hand [i] (0 left, 1 right) goes for the head: straight through it, or round the side first for a hook. */
function throwPunch(i, head, t, sh) {
  const side = i === 0 ? -1 : 1;
  if (Math.random() < TUNE.hook) {
    // Out wide on its own side, then across through the head
    punches[i] = {
      kind: 'hook1', until: t + 0.09, target: { f: head.f - 10, r: head.r + side * 115 },
      next: { f: head.f + 6, r: head.r - side * TUNE.through },
    };
    return;
  }
  const df = head.f, dr = head.r - side * sh, l = Math.hypot(df, dr) || 1;
  punches[i] = { kind: 'go', until: t + 0.24, target: { f: head.f + df / l * TUNE.through, r: head.r + dr / l * TUNE.through } };
}
