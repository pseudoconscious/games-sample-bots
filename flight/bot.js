// Landing Crew: the sample bot.
//
// Two pilots land an airliner. The captain (seat 'capt', left) flies; the first officer (seat
// 'fo', right) sets the aircraft up. Your bot flies your seat. To use your own, put it in a GitHub
// repository as bot.js and paste the repository's link into the game, or run it as an API.
//
// decide(obs) is called about 5 times a second and returns the answer.
//
// obs:
//   t                 seconds since the flight began
//   seat              'capt' or 'fo'
//   calls             what your seat is asked to do now, each:
//                       id, control, value (the value to set; null for 'vref': work it out),
//                       from ('atc', 'capt', 'fo', 'gpws'), say (the call as shown),
//                       prompt (true: flown, not a control to move, e.g. the flare),
//                       secondsLeft (act before it runs out)
//   otherCalls        what the other seat is asked to do: id, control, say
//   aircraft:
//     ias, v          indicated and true airspeed, knots
//     altFt           height over the runway, feet
//     vsFpm           climbing (+) or sinking (-), feet a minute
//     heading         degrees; bank (right +), pitch (nose up +), alpha (wing angle): degrees
//     onGround        true from touchdown
//     dme             miles to the runway
//     locDots, gsDots off the runway's line and off the glide path (2 = full scale)
//     leftOfCentre    metres left of the runway's centre line (right is negative)
//     flightDirector  { bank, pitch }: what to fly to follow the approach and to flare, degrees
//     autopilot, autothrottle   true or false
//     lateral         'HDG' or 'LOC'; vertical: 'ALT' or 'GS'; approachArmed: true or false
//     mcp             { speed, heading }: what is set on the panel
//     flaps (notch 0-6), flapPosition (where the flaps are now), gear ('up', 'down'),
//     speedbrake ('down', 'armed', 'up'), autobrake (0-5), lights, reverse, brake
//     minSpeed        the slowest comfortable speed with the flaps where they are, knots
//     warnings        e.g. ['stall', 'sink', 'bank', 'glide', 'gear', 'flapSpeed', 'gearSpeed']
//   weight            the landing weight, tonnes; vrefSet: the VREF set, or null
//   rules:
//     controls        the controls your seat may move
//     flaps           degrees per notch; flapLimits: top speed per notch; gearLimit: knots
//     autobrake       the selector's settings, 0 (OFF) to 5 (MAX)
//     landingData     [{ weight, vref }]: VREF for each weight
//     runway          { length, width (metres), heading (degrees) }
//
// The answer: { do: [{ control, value }, ...], stick: { x, y } }
//   captain:        hdg (degrees), spd (110-260 knots), app (true arms the approach),
//                   ap (true/false: the autopilot), rev (true/false, on the ground), brake (true/false)
//   first officer:  flaps (notch 0-6), gear ('down', 'up'), sb ('down', 'armed', 'up'),
//                   ab (0-5), lights (true/false), vref (knots, from rules.landingData)
//   stick           captain only: x -1 (roll left) to 1 (roll right), y -1 (nose up) to 1 (nose
//                   down). It flies while the autopilot is off and steers on the runway; null
//                   leaves it centred. At most four moves an answer; the other seat's are ignored.
//
// Scoring is the crew's: a soft touchdown on the centre line, early on the runway, stopping on it,
// and every call answered in time.
//
// As an API: a POST with obs as JSON and the header X-Seat ('capt' or 'fo'); the answer as JSON.
// It must be https and allow web pages to call it (CORS: Access-Control-Allow-Origin: * and
// Access-Control-Allow-Headers: Content-Type, X-Seat). One question is out at a time; after
// 1.5 s without an answer the controls stay where they are.
//
// Setting (self.BOT_SETTINGS), used by the game's built-in styles:
//   style             how soon it acts on a call: 'crisp' within a second, 'steady' (the default)
//                     after one to three seconds, 'relaxed' once about half the call's time is gone

const S = (typeof self !== 'undefined' && self.BOT_SETTINGS) || {};
const STYLE = S.style || 'steady';
// Seconds after a call before acting on it: a range, and for 'relaxed' a share of the call's time
const WAIT = { crisp: [0.4, 1], steady: [1.4, 3.2], relaxed: null }[STYLE];

const firstSeen = {};   // call id -> the time it was first seen, and when to act on it
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

function decide(obs) {
  const answer = { do: [], stick: null };
  const a = obs.aircraft, t = obs.t;

  for (const call of obs.calls) {
    if (call.prompt) continue;   // a prompt (the flare) is flown, not a control to move
    if (!(call.id in firstSeen)) {
      const wait = WAIT ? WAIT[0] + Math.random() * (WAIT[1] - WAIT[0]) : call.secondsLeft * 0.45;
      firstSeen[call.id] = t + wait;
    }
    if (t < firstSeen[call.id]) continue;
    let value = call.value;
    // VREF is worked out, not told: the landing data gives it from the weight
    if (call.control === 'vref') {
      const row = obs.rules.landingData.find(r => r.weight === obs.weight);
      value = row ? row.vref : null;
    }
    if (value !== null) answer.do.push({ control: call.control, value });
  }

  // The captain's hands: by the flight director while flying by hand, along the centre line on the runway
  if (obs.seat === 'capt') {
    if (a.onGround) {
      const aim = obs.rules.runway.heading + clamp(a.leftOfCentre * 0.35, -6, 6);
      answer.stick = { x: clamp(angDiff(aim, a.heading) * 0.5, -1, 1), y: 0 };
    } else if (!a.autopilot) {
      answer.stick = {
        x: clamp((a.flightDirector.bank - a.bank) * 0.14, -1, 1),
        y: clamp((a.flightDirector.pitch - a.pitch) * 0.9, -1, 1),
      };
    }
  }
  return answer;
}
