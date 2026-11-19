// Landing Crew: Crazy, a bonus bot. A sightseeing approach: it swoops and wanders, lines up
// LINE_UP miles out and lands. obs and the answer are described at the top of bot.js.

const SHARE = [0.6, 0.85];   // how far into a call's time it acts on it
const LINE_UP = 9;           // miles out: the last sensible moment to settle down

const firstSeen = {};   // call id -> when to act on it
let sightseeing = true;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

function decide(obs) {
  // An empty question (the game's "My API" asks one when it is picked): an empty answer
  if (!obs || !Array.isArray(obs.calls) || !obs.aircraft) return {};
  const answer = { do: [], stick: null };
  const a = obs.aircraft, t = obs.t;

  for (const call of obs.calls) {
    if (call.prompt) continue;   // a prompt (the flare) is flown, not a control to move
    if (!(call.id in firstSeen)) firstSeen[call.id] = t + call.secondsLeft * (SHARE[0] + Math.random() * (SHARE[1] - SHARE[0]));
    if (t < firstSeen[call.id]) continue;
    if (call.control === 'app' && sightseeing) continue;   // no approach yet: still looking around
    let value = call.value;
    // VREF is worked out, not told: the landing data gives it from the weight
    if (call.control === 'vref') {
      const row = obs.rules.landingData.find(r => r.weight === obs.weight);
      value = row ? row.vref : null;
    }
    if (value !== null) answer.do.push({ control: call.control, value });
  }

  if (obs.seat !== 'capt') return answer;

  if (sightseeing) {
    if (a.dme <= LINE_UP || a.altFt < 1500 || a.onGround) {
      // Enough sights: the approach, and the autopilot back on to fly it
      sightseeing = false;
      if (!a.approachArmed && a.lateral !== 'LOC') answer.do.push({ control: 'app', value: true });
      if (!a.autopilot && a.altFt > 400) answer.do.push({ control: 'ap', value: true });
    } else {
      if (a.autopilot && t > 4) answer.do.push({ control: 'ap', value: false });
      // Slow swings around the flight director's line: banks one way and the other
      const bank = clamp(a.flightDirector.bank + 20 * Math.sin(t * 0.33) + 8 * Math.sin(t * 0.91), -30, 30);
      // The swoops are its own: long, slow, a few hundred feet up and down around 2500 feet
      const pitch = a.alpha + 6 * Math.sin(t * 0.16) + clamp((2500 - a.altFt) * 0.006, -2, 2);
      answer.stick = { x: clamp((bank - a.bank) * 0.14, -1, 1), y: clamp((pitch - a.pitch) * 0.9, -1, 1) };
      return answer;
    }
  }

  // Lined up: by the flight director while flying by hand, along the centre line on the runway
  if (a.onGround) {
    const aim = obs.rules.runway.heading + clamp(a.leftOfCentre * 0.35, -6, 6);
    answer.stick = { x: clamp(angDiff(aim, a.heading) * 0.5, -1, 1), y: 0 };
  } else if (!a.autopilot) {
    answer.stick = {
      x: clamp((a.flightDirector.bank - a.bank) * 0.14, -1, 1),
      y: clamp((a.flightDirector.pitch - a.pitch) * 0.9, -1, 1),
    };
  }
  return answer;
}
