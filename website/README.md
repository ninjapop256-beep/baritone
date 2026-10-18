# PVP EVENTS — rankings website for Minecraft PvP events

A ready-to-run website for a Minecraft server that hosts ranked PvP events (battle royale,
bed wars, sky wars, or any mode you invent). Your server plugin reports each finished game.
The site turns those games into a live leaderboard:

- **Rankings**: a top-3 podium, tier filter chips, instant player search and the full ladder.
- **Game history**: every ranked game, newest first, with mode, map, duration, players, kills and winners.
- **Game pages**: the winners on a gold stage, every team's placement, kills, Hype gained or lost,
  and links to the older and newer game.
- **Player profiles**: skin, global rank, tier progress, event stats, the players around them on the
  ladder, a Hype/rank history chart and their full game list.

Players are rated with **Hype**: points for placing well and for kills, minus a small entry cost
that grows with your tier. Hype puts players into seven tiers, from Coal to Netherite.

It has **no dependencies**: no `npm install`, no database and no build step. It needs only
Node.js 18 or newer, and stores games in one JSON file. It works on phones and desktops, and
updates itself while people watch.

> "PVP EVENTS", `play.example.net` and the Discord/store links are placeholders. Put your own
> in [`public/config.json`](#make-it-yours) (one file).

---

## Contents

1. [Quick start](#quick-start)
2. [Make it yours](#make-it-yours)
3. [Reporting games from your Minecraft plugin](#reporting-games-from-your-minecraft-plugin)
4. [How Hype and tiers work](#how-hype-and-tiers-work)
5. [Deploying](#deploying)
6. [API reference](#api-reference)
7. [Page URLs and shortcuts](#page-urls-and-shortcuts)
8. [Project layout](#project-layout)
9. [Development and tests](#development-and-tests)
10. [Troubleshooting](#troubleshooting)

---

## Quick start

You need [Node.js](https://nodejs.org) 18 or newer (`node --version` to check). Then, inside this
`website/` folder:

```sh
# 1. See it with demo data (650 made-up players, 110 games, read-only)
npm run demo
# → open http://localhost:8080

# 2. Run it for real: games are stored in ./data/games.json
EVENTS_API_KEY=pick-a-long-random-secret npm start
```

That's it; there is nothing to install. On the first real start the site is empty and says
"No ranked players yet". It fills up as soon as your plugin posts the first game (see below).

Make a strong key with either of:

```sh
openssl rand -hex 32
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To try the live site with fake data first, seed some games into the data folder:

```sh
node scripts/seed.js --out data/games.json --now now   # testing only: fake players
```

Delete `data/games.json` again before you go live.

---

## Make it yours

Everything players see that is about *your* server lives in **`public/config.json`**. Edit it,
then restart the server (or just reload, for the static demo).

| Key | What it does | Default |
|---|---|---|
| `siteName` | Browser tab title and footer | `"PVP EVENTS"` |
| `brand.mark`, `brand.text` | The logo in the top bar: `mark` is drawn in gold, then `text` | `"PVP"`, `"EVENTS"` |
| `tagline` | Short description for search engines and link previews | `"Ranked Minecraft PvP events"` |
| `ratingName` | Name of the rating everywhere ("Hype Rankings", "+30 Hype") | `"Hype"` |
| `serverIp` | Main address in the PLAY box; click to copy | `"play.example.net"` |
| `alternateServerIp`, `alternateServerCommand` | Second address and the command to run there | `"hub.example.net"`, `"/events"` |
| `discordUrl`, `storeUrl` | Top-bar and footer links; set one to `""` to hide it | placeholders |
| `skins` | `"mc-heads"` loads real skins from mc-heads.net; `"local"` draws pixel figures offline; `"auto"` uses real skins on a live server and local figures for demo data | `"auto"` |
| `modes` | Display name and colour per game mode slug (see below) | battle-royale, bedwars, skywars |
| `scoring` | How Hype is calculated ([details](#how-hype-and-tiers-work)) | |
| `tiers` | Tier names and the Hype each one starts at | Coal … Netherite |

**Game modes.** The plugin sends a mode *slug* such as `"duels"`. Give it a nice name and one of
the colours `gold`, `red`, `blue`, `green` or `purple`:

```json
"modes": {
    "battle-royale": { "name": "Battle Royale", "color": "gold" },
    "duels": { "name": "Duels", "color": "purple" }
}
```

A mode that isn't listed still works: its slug is title-cased ("king-of-the-hill" → "King Of The
Hill") and shown in blue. A game can also send its own `modeName`.

**Tiers.** You can rename tiers and change their `min` Hype freely. The seven built-in ids
(`COAL`, `COPPER`, `IRON`, `GOLD`, `EMERALD`, `DIAMOND`, `NETHERITE`) have their own metallic
colours. A new id works too, but it gets the Coal look unless you add a `.tier-<id>` colour in
`public/css/base.css`.

**Changing scoring or tiers re-rates everyone.** Hype is recalculated from the full game list on
every start, so a change applies to all past games too. Nothing is lost.

**Background art.** `public/img/world.svg` is an original blocky sunset landscape, blurred by CSS.
Replace it with any image (keep the file name, or change `.world` in `public/css/base.css`).
`npm run world -- --seed=7` generates a different landscape. The favicon is `public/img/favicon.svg`.

---

## Reporting games from your Minecraft plugin

When a game ends, your plugin sends one HTTP request:

```
POST https://your-site.example/api/games
Authorization: Bearer <EVENTS_API_KEY>
Content-Type: application/json

{ ...the game... }
```

The site validates the game, saves it, recalculates everyone's Hype, and open pages update
within about 10–30 seconds.

### Example

`game.json`, a solo battle royale with 4 players (real games usually have more):

```json
{
    "mode": "battle-royale",
    "map": "cherry_grove",
    "teamSize": 1,
    "startedAt": 1792309830905,
    "endedAt": 1792310811052,
    "teams": [
        { "placement": 1, "eliminatedAt": null,
          "players": [{ "uuid": "4f8e2c1a-9b3d-4e7f-a2c6-1d5b8e9f0a31", "name": "CreeperKing", "kills": 3, "damage": 41.5 }] },
        { "placement": 2, "eliminatedAt": 1792310790000,
          "players": [{ "uuid": "b7d14e09-2c6a-4f81-9e3b-5a0c7d2e4f68", "name": "EnderQueen", "kills": 1 }] },
        { "placement": 3, "eliminatedAt": 1792310521000,
          "players": [{ "uuid": "0c93a5f2-71e4-4b2d-8f6a-e3b9c1d70a54", "name": "RedstoneRex", "kills": 0 }] },
        { "placement": 4, "eliminatedAt": 1792310102000,
          "players": [{ "uuid": "e25b6d8c-4a17-4c93-b0f5-92d6a8e3c107", "name": "PixelPaladin", "kills": 0 }] }
    ]
}
```

```sh
curl -X POST http://localhost:8080/api/games \
     -H "Authorization: Bearer $EVENTS_API_KEY" \
     -H "Content-Type: application/json" \
     -d @game.json
# → 201 {"number":1}
```

For team games, put all teammates in one team's `players` array and set `teamSize` (2 = duos,
3 = trios, 4 = squads, any number up to 100).

### Fields

| Field | Required | Meaning |
|---|---|---|
| `mode` | yes | Mode slug: lowercase letters, digits, `-`, `_` (max 32). Looked up in `config.modes`. |
| `modeName` | no | Display name for this game only (overrides `config.modes`). |
| `map` | no | Map slug, e.g. `"cherry_grove"`; shown as "Cherry Grove". |
| `teamSize` | yes | Players per team: 1 = solos, 2 = duos … up to 100. |
| `startedAt`, `endedAt` | yes | **Epoch milliseconds** (Java: `System.currentTimeMillis()`). Seconds are rejected with a clear error. |
| `ranked` | no | `false` stores the game but leaves it out of the rankings and history (e.g. practice rounds). Default `true`. |
| `number` | no | Game number. Leave it out and the site numbers games 1, 2, 3 … itself. |
| `teams[]` | yes | Every team, in any order (max 200). |
| `teams[].placement` | yes | 1 = winner … N = first team out. Unique, 1 to the number of teams. |
| `teams[].eliminatedAt` | no | Epoch ms when the team was knocked out; `null` for the winner. Shown as "Out at 12:04". |
| `teams[].players[]` | yes | 1 to `teamSize` players. |
| `….uuid` | yes | The player's Minecraft UUID, with or without dashes. This is their identity: name changes keep their stats. |
| `….name` | yes | Current Minecraft name (1–16 of `A-Z a-z 0-9 _`). The newest game's name is shown. |
| `….kills` | yes | Kills in this game (0–1000). |
| `….deaths` | no | Defaults to 0 for the winners and 1 for everyone else. |
| `….damage` | no | Hearts of damage dealt; summed on the profile ("Damage dealt"). |
| `….skin` | no | Skin id for mc-heads.net; defaults to the UUID. |

Unknown fields are ignored, so you can send extra data. A game with fewer than 4 teams
(`scoring.minTeams`) is stored but not rated.

### Responses

| Status | Body | Meaning |
|---|---|---|
| `201` | `{ "number": 42 }` | Saved as game #42 (also sent in the `Location` header). |
| `400` | `{ "error": "Invalid game", "details": ["teams[1].players[0].name: must be 1-16 characters … (got \"Bad Name!\")", …] }` | Fix the listed fields and send it again. |
| `401` | `{ "error": "Missing or invalid API key" }` | Wrong or missing `Authorization` header. |
| `409` | `{ "error": "This game was already recorded as #42", "number": 42 }` | Duplicate, so a retry after a timeout is safe. |
| `413` | `{ "error": "Body too large …" }` | Bodies are limited to 1 MB (thousands of players). |
| `503` | `{ "error": "Writes are disabled …" }` | The server has no `EVENTS_API_KEY`, or runs in demo mode. |

A resend is caught as a duplicate when it has the same `number`, or (without a number) the same
mode, start, end, team count and winners. So if a request times out, it is safe to retry.

**Removing a game** (e.g. a test game, or a game that had a cheater):

```sh
curl -X DELETE http://localhost:8080/api/games/42 -H "Authorization: Bearer $EVENTS_API_KEY"
# → 204 (deleted) or 404 (no such game); everyone's Hype is recalculated
```

### Sending it from Java

A minimal sketch for a Paper/Spigot plugin (Java 11+). Send it off the main thread so the server
doesn't freeze:

```java
HttpClient http = HttpClient.newHttpClient();

void reportGame(String gameJson) {          // build the JSON with Gson, Jackson, ...
    HttpRequest req = HttpRequest.newBuilder(URI.create("https://your-site.example/api/games"))
            .header("Authorization", "Bearer " + apiKey)
            .header("Content-Type", "application/json")
            .timeout(Duration.ofSeconds(10))
            .POST(HttpRequest.BodyPublishers.ofString(gameJson))
            .build();
    http.sendAsync(req, HttpResponse.BodyHandlers.ofString()).thenAccept(res -> {
        if (res.statusCode() != 201 && res.statusCode() != 409) {
            getLogger().warning("Game report failed: " + res.statusCode() + " " + res.body());
        }
    });
}
```

---

## How Hype and tiers work

Every ranked game is scored in the order games ended. For a game with **T** teams, a player whose
team finished in place **p** gets:

```
placement points = 200 × ((T − p) / (T − 1))²        (+60 more for the winners)
lobby factor     = min(1, T / 16)                     (small lobbies are worth less)
change           = lobby factor × placement points
                 + 10 × own kills
                 − entry cost of the player's tier before the game
```

The change is rounded to the nearest 5 and Hype never drops below 0. Teammates share the
placement points; kills count per player. Everyone starts at 0.

What placing earns in a full 16-team lobby, before kills:

| Place | 1st | 2nd | 3rd | 4th | 8th | 12th | 16th (last) |
|---|---|---|---|---|---|---|---|
| Coal player | **+260** | +175 | +150 | +130 | +55 | +15 | ±0 |
| Gold player | +225 | +140 | +115 | +95 | +20 | −20 | −35 |
| Netherite player | +170 | +85 | +60 | +40 | −35 | −75 | −90 |

So climbing is easy at first, and staying at the top takes consistent podiums. Every kill is +10 on top.

**Tiers** (by current Hype). Every tier except the top one is split into three divisions:
III (lowest), II and I. For example, Gold runs from 1,500 to 2,499 Hype, and Gold I is its top third.

| Tier | Starts at | Entry cost per game |
|---|---|---|
| Coal | 0 | 0 |
| Copper | 300 | 10 |
| Iron | 800 | 20 |
| Gold | 1,500 | 35 |
| Emerald | 2,500 | 50 |
| Diamond | 4,000 | 70 |
| Netherite | 6,000 | 90 |

The ladder is sorted by Hype, then wins, then kills, then name. Every number above comes from
`scoring` and `tiers` in `public/config.json`:

```json
"scoring": {
    "startingHype": 0, "minTeams": 4,
    "maxPlacementPoints": 200, "placementCurve": 2, "winBonus": 60,
    "killPoints": 10, "fullLobbyTeams": 16, "roundTo": 5,
    "entryCost": { "COAL": 0, "COPPER": 10, "IRON": 20, "GOLD": 35, "EMERALD": 50, "DIAMOND": 70, "NETHERITE": 90 }
}
```

---

## Deploying

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port to listen on (or `--port=N`). |
| `HOST` | `0.0.0.0` | Interface to listen on. Use `127.0.0.1` behind a reverse proxy. |
| `DATA_DIR` | `./data` | Folder for `games.json`. Relative paths start from the current folder. |
| `EVENTS_API_KEY` | (none) | Secret the plugin must send. Without it the site is read-only (POST answers 503). |
| `DEMO` | (off) | `DEMO=1` (or `--demo`) serves the bundled demo data, read-only. |
| `LOG_REQUESTS` | (off) | `LOG_REQUESTS=1` logs every request. |

Any host that runs Node 18+ works: a VPS, a game-server panel with Node support, Railway, Render,
Fly.io and similar. Copy the `website/` folder, set the variables, and run `node server.js`.
**Keep `DATA_DIR` on persistent storage**, because `games.json` is your entire history. Back it
up like a world save; copying the file is a complete backup. Writes are atomic (temp file +
rename), so a crash can't leave a half-written file.

### systemd (Linux VPS)

`/etc/systemd/system/pvp-events.service`:

```ini
[Unit]
Description=PVP EVENTS website
After=network.target

[Service]
WorkingDirectory=/opt/pvp-events/website
ExecStart=/usr/bin/node server.js
Environment=PORT=8080 HOST=127.0.0.1 DATA_DIR=/var/lib/pvp-events
Environment=EVENTS_API_KEY=change-me-to-a-long-random-secret
Restart=on-failure
User=pvp-events

[Install]
WantedBy=multi-user.target
```

```sh
sudo mkdir -p /var/lib/pvp-events && sudo chown pvp-events /var/lib/pvp-events
sudo systemctl enable --now pvp-events
journalctl -u pvp-events -f     # logs
```

### pm2

```sh
EVENTS_API_KEY=… DATA_DIR=/var/lib/pvp-events pm2 start server.js --name pvp-events
pm2 save && pm2 startup
```

### Reverse proxy and HTTPS

Put the site behind nginx or Caddy for HTTPS, especially if the plugin sends the API key over the
internet. Serve it at the **root of a domain or subdomain** (e.g. `https://events.example.net/`),
not under a sub-path. nginx example:

```nginx
server {
    server_name events.example.net;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
    # listen 443 ssl; plus certificates, e.g. via certbot --nginx
}
```

Caddy is a one-liner: `events.example.net { reverse_proxy 127.0.0.1:8080 }`, which also sets up HTTPS.

The server already gzips responses, sends ETags and caches static files for an hour. After you
change CSS or JS, visitors may see the old version for up to an hour unless they reload.

### Static demo hosting (GitHub Pages, Netlify, any web host)

The `public/` folder works on its own as a static site. With no server behind it, the site runs in
**demo mode**: it loads `demo/games.json` and calculates the rankings in the browser. This is
handy for showing off the design or for a portfolio. Upload the *contents* of `public/` (for GitHub
Pages, publish that folder, e.g. with a Pages workflow whose artifact path is `website/public`).
Sub-paths such as `user.github.io/my-repo/` work.

Static links use `#` routes, such as `…/index.html#/profile/CreeperKing`. The small file
`public/api/health` tells the page that no live server is present. Static hosting can't receive
games; real rankings need `server.js`.

---

## API reference

All responses are JSON with `Cache-Control: no-store`. Reads need no key.

| Method & path | Returns |
|---|---|
| `GET /api/health` | `{ ok: true, mode: "live" \| "demo", games, players }` |
| `GET /api/config` | The public site config (anything that looks like a secret is removed) + `mode`. |
| `GET /api/rankings` | `{ siteName, ratingName, generatedAt, total, players: [Row] }`, the whole ladder in order. |
| `GET /api/games?before=N&limit=30` | `{ total, more, games: [Summary] }`, newest first. `before` (exclusive) pages backwards; `limit` 1–100. |
| `GET /api/games/:number` | The full game (below), or 404. |
| `GET /api/profile/:nameOrUuid` | `{ player, history, games, neighbors }`, or 404. Names ignore case; UUIDs work with or without dashes. |
| `POST /api/games` | Store a game (needs the key). See [Responses](#responses). |
| `DELETE /api/games/:number` | Remove a game (needs the key): `204` / `404`. |

Shapes (abbreviated):

```js
Row      = { position, uuid, name, skin, hype, tier: "GOLD", tierName: "Gold", division: "II", tierLabel: "Gold II",
             events, wins, kills, deaths, kd, averagePlacement, lastSeen }
Summary  = { number, mode, modeName, modeColor, map, teamSize, teamCount, players, kills,
             startedAt, endedAt, duration, winners: [{ uuid, name, skin, kills, hypeChange, hypeAfter }] }
Game     = { ...Summary fields, ranked: true, winners: [...],
             teams: [{ placement, eliminatedAt, kills,
                       players: [{ uuid, name, skin, kills, deaths, damage,
                                   hypeBefore, hypeChange, hypeAfter, tierBefore, tierAfter }] }],
             mostKills: { uuid, name, skin, kills } | null,
             prev: olderGameNumber | null, next: newerGameNumber | null }
Profile  = { player:    { ...Row fields, podiums, damage, bestPlacement, peakHype, lowHype, firstSeen, total,
                          winRate, top3Rate, killsPerEvent, events30d, tierMin, nextTierMin, nextTierName, progress, toNext },
             history:   [{ number, at, hype, change, rank, placement, teams }],      // oldest first
             games:     [{ number, mode, modeName, map, teamSize, startedAt, endedAt, placement, teams,
                           kills, hypeChange, hypeAfter }],                          // newest first
             neighbors: [{ position, uuid, name, skin, hype, tier, tierName, tierLabel }] }  // 5 around the player
```

Times are epoch milliseconds, `duration` is in ms, and `rank` in `history` is the player's ladder
position right after that game. Unranked games and games with too few teams never appear.

Errors are `{ error }` with a matching status code. One detail for API clients: the website's
own pages send the header `X-Soft-404: 1`, which makes a GET 404 come back as
`200 { error, notFound: true }`, so browsers don't log a console error for "Player not found".
Other clients can ignore this and get normal 404s.

---

## Page URLs and shortcuts

| URL | Page |
|---|---|
| `/` or `/rankings/overall` | Rankings. `?q=steve` searches, `?tier=gold` filters (coal, copper, iron, gold, emerald, diamond, netherite). |
| `/rankings/history` | Game history |
| `/rankings/history/42` | Game #42. `?player=CreeperKing` highlights that player's team (profile links add it). |
| `/profile/CreeperKing` | Player profile (name or UUID). `?chart=rank` shows rank instead of Hype; `?range=7d`, `30d` or `90d` limits the chart. |

All of these are shareable links. On static hosting they look like `index.html#/profile/CreeperKing`.
On a live server, `https://your-site/?demo=1` opens the bundled demo data instead (handy for comparing).

Keyboard: **/** jumps to the player search and **Esc** leaves it. **Enter** in the search opens
the player (exact or single match). On a game page, **←** / **→** open the older/newer game. The
profile chart is keyboard-accessible: Tab to it, use the arrow keys, Home/End, and Enter to open a game.

---

## Project layout

```
website/
  server.js               HTTP server: static files, page routes, JSON API (zero dependencies)
  lib/store.js            games.json storage (atomic writes, duplicate detection)
  lib/validate.js         checks games the plugin POSTs, with readable errors
  scripts/seed.js         deterministic demo-data generator (npm run seed)
  scripts/make-world.js   generates the background art public/img/world.svg (npm run world)
  test/                   node:test suites (npm test)
  data/                   your games (created on first run; git-ignored)
  public/                 everything the browser loads; also works alone as a static demo
    index.html            page shell
    config.json           ← your branding, links, modes, scoring and tiers
    demo/games.json       demo data
    api/health            marker file for static hosting (see above)
    img/                  world.svg background, favicon.svg
    css/base.css          design tokens and shared components
    css/{rankings,history,game,profile}.css
    js/main.js            start-up: picks live or demo mode, loads config, routes pages
    js/router.js          URLs (real paths on the server, #/paths on static hosting)
    js/api.js             data: the server API, or the in-browser demo engine
    js/shell.js           top bar, search, footer, tabs, PLAY box
    js/ui/                html escaping, number/date formatting, skins, badges, SVG chart
    js/views/             rankings, history, game, profile, not-found pages
    js/shared/            league engine (scoring, tiers, response shapes), shared by server and browser
```

The scoring engine in `public/js/shared/` runs unchanged in Node and in the browser. That is how
the static demo produces exactly the same pages as the server.

Fonts: Pixelify Sans (text), Silkscreen (small labels) and Jersey 10 (numbers, because Pixelify's
"5" looks like an "S"), loaded from Google Fonts. Without them, the site falls back to system fonts.

---

## Development and tests

```sh
npm test          # 80 tests: scoring, tiers, validation, storage, seed, HTTP server
npm run check     # syntax-check every .js file
npm run demo      # demo server on :8080
npm run seed      # regenerate public/demo/games.json (same output every run)
npm run world     # regenerate public/img/world.svg (--seed=N for a different landscape)
```

The browser code is plain ES modules with no bundler: edit a file and reload. To preview the
static demo without Node, run `python3 -m http.server 8000 --directory public` and open
`http://localhost:8000/index.html`.

Seed options: `node scripts/seed.js --games 300 --players 2000 --now now --out data/games.json --pretty`.
`--now now` makes the newest game end a moment ago. `--seed` picks a different (still repeatable) world.

---

## Troubleshooting

- **The site says "No ranked players yet"**: no ranked game with 4+ teams has been posted yet.
  Check the plugin's response codes, or run `curl http://localhost:8080/api/health`.
- **POST returns 503**: start the server with `EVENTS_API_KEY` set (and not with `--demo`).
- **POST returns 400**: read `details`; every problem names the field, e.g. `teams[2].players[0].uuid`.
  The most common mistake is sending seconds instead of milliseconds.
- **"Port 8080 is already in use"**: set `PORT=8081`, or stop the other process.
- **The server refuses to start and reports a corrupt games.json**: it never overwrites a broken file.
  Fix the JSON (it's one array of games) or restore your backup, then start it again.
- **Skins all look like Steve**: mc-heads.net shows the default skin for UUIDs that aren't real
  Minecraft accounts (e.g. offline-mode servers). Set `"skins": "local"` to use the built-in pixel figures.
