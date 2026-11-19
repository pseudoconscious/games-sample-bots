# PseudoConscious Games: sample bots

The bots of the PseudoConscious Games, to copy and make your own. In every game listed here, a bot can play your place: one of the game's own, your own code from GitHub, or your own web API.

## The games

| Game | Folder |
|---|---|
| Script Squad, Tank API, T-Rex API, Mix & Match | `commando/` |
| Word Pop | `wordpop/` |
| Space Ring API | `spacering/` |
| Sneaky Kitchen | `kitchen/` |
| Heli Valley | `heli/` |
| Landing Crew | `flight/` |
| Carrier Crew | `carrier/` |
| Two Fists | `boxing/` |
| Drift Streets | `drift/` |

Each folder holds `bot.js`, the game's bot, and one `.json` file per built-in style. The comment at the top of `bot.js` says what the game asks the bot, what it must answer, and what each setting does.

## A bot

A bot is one JavaScript file that defines `decide(obs)`. The game calls it many times a second with what the bot's unit can see (`obs`, plain JSON) and uses the object it returns as the unit's next move. The file may read its settings as `self.BOT_SETTINGS`.

A style file names a bot beside it and the settings to run it with:

    { "bot": "bot.js", "settings": { "style": "tidy" } }

## Start in three steps

1. **Copy this repository** to your own GitHub account (Use this template, or Fork).
2. **Change a bot**: edit `<folder>/bot.js`, or a style's settings.
3. **Load it in the game**: in the game's bot picker choose **My bot code (GitHub)**, paste the address and tap **Use**. Any of these works:
   - the folder, `https://github.com/<you>/games-sample-bots/tree/main/drift`: its `bot.js`;
   - a style, `https://github.com/<you>/games-sample-bots/tree/main/drift/tidy.json`;
   - a file, `https://github.com/<you>/games-sample-bots/blob/main/drift/bot.js`.

Your bot runs in your own browser, in a sandbox: it receives only the game's questions, with no access to the page, your account or the network. A bot that takes more than 3 seconds to answer is stopped and the game's own bot takes over. Other players never run your code.

## The API way

Run the same bot as a small web server and give the game its address:

    node servebot.js drift                  the Drift bot with its default settings
    node servebot.js drift/tidy.json        the same bot with one style's settings
    node servebot.js drift 9000             on another port (8787 by default)
    node servebot.js drift --check          load the bot and ask it one empty question

Node 18 or newer, nothing to install. In the game's bot picker choose **My API** and paste the address, for example `http://localhost:8787/`.

- The game sends each question as a `POST` with a JSON body (the same `obs` a bot receives) and expects the answer as JSON, within 1.5 seconds. One question per unit is in flight at a time; an answer that is late is skipped.
- A header names the unit that asks (for example `X-Car-Id`); `bot.js` says which one its game uses.
- The game calls your API from the player's browser, so the API must allow web pages (CORS). `servebot.js` does.
- When you tap **Use**, the game sends one empty question (`{}`) and uses the API only if it answers with JSON.
- The game's site is https, so your API must be https, except on your own computer: `http://localhost` works once your browser has asked you to allow it.

## Bonus: crazy.json

Several folders also have `crazy.json`, a style with its own bot file (`crazy.js`) that is not among the game's choices. To meet it, load its address in the bot picker, or run `node servebot.js <folder>/crazy.json`.

## Licence

MIT: see `LICENSE`.
