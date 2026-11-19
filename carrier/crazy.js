// Carrier Crew: Crazy, a bonus bot. As pilot it swings down the glide path in S-turns and a roll
// from wing to wing, then settles and traps. Questions and answers: the header of bot.js.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const WILD_FROM = 4.2;    // miles astern: the autopilot comes off and the S-turns begin
const CALM_AT = 1.8;      // miles astern: back on the flight director, for the deck
const ROLL_AT = 2.9;      // miles astern: the roll from wing to wing
const SWING = 38;         // degrees of bank either side of the flight director in the S-turns
const PERIOD = 9;         // seconds for one S (left and right)

let firstSeen = {}, lastT = -1, roll = null;

function decide(obs) {
  if (!obs || !obs.aircraft || !Array.isArray(obs.calls)) return {};
  const answer = { do: [], stick: null };
  const a = obs.aircraft, t = obs.t;
  if (t < lastT) { firstSeen = {}; roll = null; }   // a new flight
  lastT = t;

  for (const call of obs.calls) {
    if (call.prompt) continue;
    if (!(call.id in firstSeen)) firstSeen[call.id] = t + (call.secondsLeft < 3.5 ? 0.2 : 0.5);
    if (t < firstSeen[call.id]) continue;
    let value = call.value;
    if (call.control === 'onspeed') {
      const row = obs.rules.landingData.find(r => r.weight === obs.weight);
      value = row ? row.onSpeed : null;
    }
    if (value !== null) answer.do.push({ control: call.control, value });
  }
  if (obs.seat !== 'pilot' || a.onDeck) return answer;

  const settled = a.lateral === 'LOC' && a.vertical === 'GS';
  const wild = settled && a.miles < WILD_FROM && a.miles > CALM_AT;
  if (wild && a.autopilot && answer.do.length < 4) answer.do.push({ control: 'ap', value: false });
  if (a.autopilot) return answer;

  // Where the bank should be: the flight director's, plus the S-turns, or the roll
  let bank = a.flightDirector.bank;
  if (wild) {
    if (!roll && a.miles < ROLL_AT) roll = { to: -50, done: false };
    if (roll && !roll.done) {
      bank = roll.to;
      if (roll.to < 0 && a.bank < -46) roll.to = 50;
      else if (roll.to > 0 && a.bank > 46) roll.done = true;
    } else bank += SWING * Math.sin(2 * Math.PI * t / PERIOD);
  }
  answer.stick = {
    x: clamp((bank - a.bank) * (wild ? 0.25 : 0.14), -1, 1),
    y: clamp((a.flightDirector.pitch - a.pitch) * 0.9, -1, 1),
  };
  return answer;
}
