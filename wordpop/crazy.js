// Word Pop: Crazy, a bonus bot. It plays only the longest words on the board: at each call it looks
// at one word picked at random and plays it if no word is longer. obs and the answer: see bot.js.

function decide(obs) {
  if (obs.phase !== 'play' || !obs.words.length) return {};
  const longest = obs.words.reduce((n, w) => Math.max(n, w.word.length), 0);
  const glance = obs.words[Math.floor(Math.random() * obs.words.length)];
  return glance.word.length >= longest ? { path: glance.path } : {};
}
