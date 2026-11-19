// Word Pop: the sample bot. The game's built-in bots Easy, Normal and Hard are this file with the
// settings in easy.json, normal.json and hard.json. To write your own, copy this file into a
// GitHub repository as bot.js and paste the repository's link into the game.
//
// decide(obs) is called about 5 times a second while the bot is not dragging a word.
//   obs.phase      'play', 'waiting' (joins at the next round), 'countdown', 'results' or 'lobby'
//   obs.t          seconds since the round started; obs.timeLeft: seconds left
//   obs.board      8 rows from top to bottom, 8 tiles each from left to right: { id, letter }; 'Q' is QU,
//                  '*' is a wild tile (any letter)
//   obs.words      words on the board now, up to 300, not yet found by you:
//                  { word, path: [tile ids in order], points }
//   obs.found      your words this round; obs.score: your score
//   obs.others     [{ score }] of the other players
//   obs.rules      { paceMs (ms per dragged tile), minLength, wild: '*', points (for 3 to 8 letters) }
// Answer { path: [tile ids] }: the tiles of the next word in order, each next to the one before
// (diagonals too), each used once; {} waits. The game drags the path at paceMs a tile and lets go.
// A path that is no longer on the board is dropped; a tile popped while dragged ends the word.
//
// An API instead of code: the game sends each obs as a JSON POST with the header X-Player-Id and
// reads the answer as JSON. It must be https and allow CORS (Access-Control-Allow-Origin: *,
// Access-Control-Allow-Headers: Content-Type, X-Player-Id).
//
// Setting: self.BOT_SETTINGS.level, 'easy', 'normal' (default) or 'hard'.

const S = (typeof self !== 'undefined' && self.BOT_SETTINGS) || {};
// Per level: think = the range of seconds it looks before each word; lengths = how much it likes
// words of 3, 4, 5, 6 and 7 or more letters (0 = never).
const LEVELS = {
  easy: { think: [7, 12], lengths: [3, 2, 0.6, 0.15, 0] },
  normal: { think: [4.5, 8], lengths: [1.5, 2.2, 1.5, 0.6, 0.2] },
  hard: { think: [2.2, 4.5], lengths: [0.6, 1.5, 2.2, 1.8, 1.2] },
};
const L = LEVELS[S.level] || LEVELS.normal;
const between = ([a, b]) => a + Math.random() * (b - a);

let readyAt = null;   // when it has looked long enough (seconds into the round)

function decide(obs) {
  if (obs.phase !== 'play') { readyAt = null; return {}; }
  // Looking for a word: as long as its level takes
  if (readyAt === null || readyAt > obs.t + 20) readyAt = obs.t + between(L.think);
  if (obs.t < readyAt || !obs.words.length) return {};
  // One of the words it sees, the lengths it likes most more often
  const pref = w => L.lengths[Math.min(w.word.length, 7) - 3] || 0;
  let total = 0;
  const weights = obs.words.map(w => (total += pref(w)));
  if (!total) return {};
  const roll = Math.random() * total;
  readyAt = null;
  return { path: obs.words[weights.findIndex(x => x >= roll)].path };
}
