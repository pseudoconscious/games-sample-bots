// Carrier Crew: the sample bot. The game's built-in bots are this file with different settings.
// To use your own, put it in a GitHub repository as bot.js and paste the repository's link into
// the game, or answer the same questions from your own API.
//
// decide(obs) is called about 5 times a second for one seat, the pilot's or the back-seater's,
// and returns the answer.
//
// obs:
//   t, seat         seconds since the flight began; 'pilot' (flies) or 'back' (sets the jet up)
//   calls           what this seat is asked to do now: { id, control, value, from, say, prompt,
//                   secondsLeft }. Do it before secondsLeft runs out. prompt: true (fly the
//                   ball) is flown, not a control to move. value is null for the on-speed call:
//                   work it out from weight and rules.landingData
//   otherCalls      what the other seat is asked to do: { id, control, say }
//   aircraft        ias, v (knots); altFt (feet above the deck); vsFpm; heading, bank, pitch,
//                   alpha (degrees); onDeck, stopped, wire; miles and astern (metres) behind the
//                   landing area; lineDots (2 is full scale, + left of the line); ball (0 on the
//                   glide path, + high, 1 is a quarter of a degree); leftOfCentre (metres);
//                   flightDirector { bank, pitch } (flies the line and the glide path); autopilot;
//                   power ('idle', 'auto' or 'mil'); lateral, vertical, approachArmed; mcp
//                   { speed, heading }; flaps, flapPosition, gear, hook, speedbrake, antiSkid,
//                   dump, fuel (tonnes), ballCalled, minSpeed, warnings
//   weight          the weight to trap at (tonnes); fuelTarget: the fuel that goes with it
//   onSpeedSet      the on-speed set so far
//   rules           controls (this seat's), flaps, flapLimits, gearLimit, onSpeedAlpha,
//                   landingData [{ weight, onSpeed }], deck { length, width, heading, wires,
//                   glideDeg }
//
// Everything is measured from the ship, which steams at 25 knots; the landing area points 9
// degrees left of its bow.
//
// Answer: { do: [{ control, value }, ...], stick: { x, y } | null }
//   do              at most four moves; a control of the other seat is ignored.
//                   pilot: hdg (degrees), spd (knots, 110 to 260), app (true couples the
//                   approach), ap (true or false; not back on inside three quarters of a mile),
//                   pwr ('idle', 'auto' or 'mil').
//                   back: onspeed (knots), dump, brk, skid (true or false), gear and hook
//                   ('down' or 'up'), flaps (0 to 2), ball (true: the ball call)
//   stick           pilot only, while the autopilot is off: x -1 (roll left) to 1, y -1 (nose
//                   down) to 1; null leaves it centred
//
// API: the game sends each question as a POST with JSON and the header X-Seat ('pilot' or
// 'back'), and reads the answer as JSON. It must be https and allow CORS
// (Access-Control-Allow-Origin: *, and Access-Control-Allow-Headers: Content-Type, X-Seat). One
// question is out at a time; after 1.5 s with no answer the controls stay where they are.
//
// Settings (self.BOT_SETTINGS): style, 'steady' (default), 'sharp' or 'easy': how soon after a
// call it acts, and how tightly it flies the ball.

const S = (typeof self !== 'undefined' && self.BOT_SETTINGS) || {};
const STYLE = S.style || 'steady';
// Seconds after a call before acting on it: a range, and for 'easy' a share of the call's time
const WAIT = { sharp: [0.3, 0.8], steady: [1.2, 2.8], easy: null }[STYLE];
// How hard the stick chases the flight director: 'easy' is a little lazy, so it wanders on the ball
const GRIP = { sharp: 1, steady: 0.9, easy: 0.7 }[STYLE];

const firstSeen = {};   // call id -> when to act on it
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function decide(obs) {
  const answer = { do: [], stick: null };
  const a = obs.aircraft, t = obs.t;

  for (const call of obs.calls) {
    if (call.prompt) continue;   // a prompt (fly the ball) is flown, not a control to move
    if (!(call.id in firstSeen)) {
      // A call with only a moment to answer (full power on the deck) is answered at once
      const wait = call.secondsLeft < 3.5 ? 0.2 : WAIT ? WAIT[0] + Math.random() * (WAIT[1] - WAIT[0]) : call.secondsLeft * 0.4;
      firstSeen[call.id] = t + wait;
    }
    if (t < firstSeen[call.id]) continue;
    let value = call.value;
    // The on-speed is worked out, not told: the landing data gives it from the trap weight
    if (call.control === 'onspeed') {
      const row = obs.rules.landingData.find(r => r.weight === obs.weight);
      value = row ? row.onSpeed : null;
    }
    if (value !== null) answer.do.push({ control: call.control, value });
  }

  // The pilot's hand: by the flight director once the autopilot is off. No flare: the glide path
  // is flown into the deck
  if (obs.seat === 'pilot' && !a.autopilot && !a.onDeck) {
    answer.stick = {
      x: clamp((a.flightDirector.bank - a.bank) * 0.14 * GRIP, -1, 1),
      y: clamp((a.flightDirector.pitch - a.pitch) * 0.9 * GRIP, -1, 1),
    };
  }
  return answer;
}
