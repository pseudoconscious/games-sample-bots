// Two Fists: Crazy, a bonus bot. Both fists swing in large circles without stopping, and it only
// moves forward. The questions and answers are described in the header of bot.js.

// Settings:
//   turns    circles a second
//   tired    circles a second when breath is 25 or less
//   radius   radius of each circle
//   inset    distance from the middle line to each circle's centre
//   through  how far past the head the front of a circle reaches
//   close    distance to the head below which it only shuffles forward
const MILL = { turns: 0.8, tired: 0.55, radius: 105, inset: 20, through: 30, close: 120 };
let spin = 0, lastT = -1;

const len = p => Math.hypot(p.f, p.r);

function decide(obs) {
  const answer = { left: null, right: null, move: { f: 0, r: 0 } };
  if (obs.phase !== 'fight') return answer;
  const { you, foe, t } = obs;
  const head = foe.head, d = len(head);
  // Slower when out of breath
  const dt = lastT < 0 ? 0 : Math.max(0, Math.min(0.2, t - lastT));
  lastT = t;
  spin += dt * 2 * Math.PI * (you.breath > 25 ? MILL.turns : MILL.tired);
  // The front of each circle goes through the other boxer's head; the circles lean towards it
  const front = Math.max(80, Math.min(135, head.f)) + MILL.through, centre = front - MILL.radius;
  const lean = Math.max(-60, Math.min(60, head.r * 0.5));
  for (const i of [0, 1]) {
    const side = i === 0 ? -1 : 1, a = spin + i * Math.PI;
    // Mirror images: at the front of its circle each fist is going across, towards the middle
    const target = { f: centre + MILL.radius * Math.cos(a), r: lean + side * (MILL.inset - MILL.radius * Math.sin(a)) };
    if (i === 0) answer.left = target; else answer.right = target;
  }
  // Forward at full speed until close, then slowly; swaying from side to side
  answer.move.f = d > MILL.close ? 1 : 0.25;
  answer.move.r = Math.sin(t * 3) * 0.35 + (head.r > 0 ? 0.3 : -0.3);
  // Stay off the ropes
  const c = you.ringCentre;
  if (len(c) > 280) { answer.move.f += c.f / len(c) * 0.6; answer.move.r += c.r / len(c) * 0.6; }
  return answer;
}
