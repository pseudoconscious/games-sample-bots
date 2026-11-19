// Runs a game's bot as an API, so the same bot.js reaches a game both ways a player can pick in
// the game's bot picker. Node 18 or newer; nothing to install.
//
//   node servebot.js commando                   commando/bot.js with its default settings
//   node servebot.js commando/attack.json       a style: the json names the bot beside it and its settings,
//                                               { "bot": "bot.js", "settings": { ... } }
//   node servebot.js drift 9000                 another port (8787 by default)
//   node servebot.js drift --check              no server: loads the bot, asks it one empty question
//
// What it answers, on http://localhost:<port>/:
//   POST /          the API: the body is the game's question (JSON); the answer is decide(question),
//                   as JSON. In the game: "My API", address http://localhost:8787/
//   GET  /<path>    this folder's files, as GitHub serves them (raw, any web page may fetch them).
//                   In the game: "My bot code (GitHub)", http://localhost:8787/drift/bot.js
//
// The game's page calls your API from the player's browser, so the answers allow any page (CORS).
// The game's site is https: it can call http://localhost on your own computer once the browser has
// asked you to allow it. For anyone else to use your API, run this behind https on a Node host.
//
// A bot file defines one function, decide(obs), and may read self.BOT_SETTINGS. The game runs it the
// same way in the player's browser, where it has no network and nothing else of the page.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.md': 'text/markdown', '.json': 'application/json', '.zip': 'application/zip' };

/**
 * What to run: "<game>" is <game>/bot.js with no settings; "<game>/<style>.json" is the bot that json
 * names, in the same folder, with its settings. Resolves to { file, settings }.
 */
export async function pickBot(what, root = HERE) {
  const s = String(what || '').replace(/\\/g, '/').replace(/\/+$/, '');
  let m = s.match(/^([a-z0-9_-]{2,40})$/);
  if (m) return { file: path.join(root, m[1], 'bot.js'), settings: {} };
  m = s.match(/^([a-z0-9_-]{2,40})\/([a-z0-9_-]{1,40})\.json$/);
  if (!m) throw new Error('which bot? a game folder (drift) or one of its styles (drift/tidy.json)');
  const style = JSON.parse(await readFile(path.join(root, m[1], `${m[2]}.json`), 'utf8').catch(() => { throw new Error(`no ${s} here`); }));
  const bot = String(style.bot || 'bot.js');
  // The bot a style names sits beside it: a file name only, never another folder
  if (!/^[A-Za-z0-9_-]{1,40}\.m?js$/.test(bot)) throw new Error(`${s}: "bot" must be a file in the same folder, such as bot.js`);
  return { file: path.join(root, m[1], bot), settings: style.settings && typeof style.settings === 'object' ? style.settings : {} };
}

/** decide() from a bot file, run the way the game runs it (a plain script, or a module). */
export async function loadDecide(file, settings = {}) {
  const code = await readFile(file, 'utf8').catch(() => { throw new Error(`no ${path.relative(HERE, file) || file} here`); });
  globalThis.self = { BOT_SETTINGS: settings };
  if (/^\s*export\s|\nexport\s/m.test(code)) {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
    const d = mod.decide || mod.default;
    if (typeof d !== 'function') throw new Error('the bot has no decide(obs)');
    return d;
  }
  const decide = new Function('self', `${code}\n;return typeof decide === 'function' ? decide : null;`)(globalThis.self);
  if (typeof decide !== 'function') throw new Error('the bot has no decide(obs)');
  return decide;
}

export function serve(decide, port, root = HERE) {
  const server = http.createServer(async (req, res) => {
    // The headers the page asks to send (each game names its unit in one: X-Car-Id, X-Commando-Id, ...)
    const asked = req.headers['access-control-request-headers'];
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': asked || '*', 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (req.method === 'OPTIONS') return send(204, '');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let obs;
      try { obs = JSON.parse(body || '{}'); } catch (e) { return send(400, JSON.stringify({ error: 'the question is not JSON' })); }
      try {
        const answer = decide(obs);
        return send(200, JSON.stringify(answer && typeof answer === 'object' ? answer : {}));
      } catch (e) {
        // The game checks an address with an empty question when it is picked: "nothing" is the answer
        if (obs && typeof obs === 'object' && !Object.keys(obs).length) return send(200, '{}');
        return send(500, JSON.stringify({ error: String(e.message || e) }));
      }
    }
    if (req.method === 'GET') {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      const file = path.resolve(root, rel || 'README.md');
      if (!file.startsWith(root + path.sep)) return send(403, 'no');
      try { return send(200, await readFile(file), TYPES[path.extname(file)] || 'text/plain'); } catch (e) { return send(404, 'not found'); }
    }
    return send(405, 'GET or POST');
  });
  server.listen(port, () => console.log(`Bot API on http://localhost:${port}/ (POST); files on http://localhost:${port}/<game>/bot.js`));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const all = process.argv.slice(2);
  const check = all.includes('--check');
  const [what, port = '8787'] = all.filter(a => a !== '--check');
  try {
    const { file, settings } = await pickBot(what);
    const decide = await loadDecide(file, settings);
    if (check) {
      let answer;
      try { answer = decide({}); } catch (e) { answer = { error: e.message }; }
      console.log(`${what} loads; decide({}) answered ${JSON.stringify(answer)} (an error here only means the bot needs a real question)`);
    } else {
      serve(decide, Number(port));
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
