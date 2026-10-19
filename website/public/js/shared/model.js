// API response builders shared by server.js and the in-browser demo engine,
// so both return exactly the same shapes. Pure ESM (no Node/DOM APIs).
import { deepClone, isPlainObject } from './defaults.js';
import { normalizeUuid } from './league.js';
import { tierFor } from './tiers.js';

const DAY = 24 * 60 * 60 * 1000;
const SECRET_KEY = /^_|secret|password|passwd|token|api[-_]?key|private[-_]?key|credential/i;

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

export function kdRatio(kills, deaths) {
    return round2(deaths ? kills / deaths : kills);
}

function stripSecrets(value) {
    if (Array.isArray(value)) return value.map(stripSecrets);
    if (!isPlainObject(value)) return value;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        if (!SECRET_KEY.test(key)) out[key] = stripSecrets(v);
    }
    return out;
}

// Public copy of the (merged) config; the caller adds `mode`.
export function configResponse(config) {
    return stripSecrets(deepClone(config || {}));
}

export function rankingRow(p) {
    return {
        position: p.position, uuid: p.uuid, name: p.name, skin: p.skin, hype: p.hype,
        tier: p.tier, tierName: p.tierName, division: p.division, tierLabel: p.tierLabel,
        events: p.events, wins: p.wins, kills: p.kills, deaths: p.deaths, kd: kdRatio(p.kills, p.deaths),
        averagePlacement: p.averagePlacement, lastSeen: p.lastSeen
    };
}

export function rankingsResponse(league) {
    return {
        siteName: league.config.siteName,
        ratingName: league.config.ratingName,
        generatedAt: league.generatedAt,
        total: league.ranked.length,
        players: league.ranked.map(rankingRow)
    };
}

export function gameSummary(g) {
    return {
        number: g.number, mode: g.mode, modeName: g.modeName, modeColor: g.modeColor, map: g.map,
        teamSize: g.teamSize, teamCount: g.teamCount, players: g.players, kills: g.kills,
        startedAt: g.startedAt, endedAt: g.endedAt, duration: g.duration,
        winners: g.winners.map((p) => ({
            uuid: p.uuid, name: p.name, skin: p.skin, kills: p.kills, hypeChange: p.hypeChange, hypeAfter: p.hypeAfter
        }))
    };
}

function toInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

// Index of the first game (league.games is number DESC) with number < before.
function firstOlderIndex(games, before) {
    let lo = 0;
    let hi = games.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (games[mid].number < before) hi = mid;
        else lo = mid + 1;
    }
    return lo;
}

// Newest first; `before` is an exclusive game number; limit clamped 1..100.
export function gamesPage(league, { before, limit = 30 } = {}) {
    const games = league.games;
    const lim = Math.min(100, Math.max(1, toInt(limit) ?? 30));
    const b = toInt(before);
    const start = b === null ? 0 : firstOlderIndex(games, b);
    const slice = games.slice(start, start + lim);
    return { total: games.length, more: start + slice.length < games.length, games: slice.map(gameSummary) };
}

function findGameIndex(games, number) {
    let lo = 0;
    let hi = games.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const n = games[mid].number;
        if (n === number) return mid;
        if (n > number) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

export function gameResponse(league, number) {
    const n = toInt(number);
    if (n === null) return null;
    const game = league.gameByNumber.get(n);
    if (!game) return null;
    let best = null;
    for (const team of game.teams) {
        for (const p of team.players) {
            if (p.kills > 0 && (!best || p.kills > best.kills)) best = p;
        }
    }
    const i = findGameIndex(league.games, n);
    return {
        ...game,
        mostKills: best ? { uuid: best.uuid, name: best.name, skin: best.skin, kills: best.kills } : null,
        prev: i >= 0 && i + 1 < league.games.length ? league.games[i + 1].number : null,
        next: i > 0 ? league.games[i - 1].number : null
    };
}

// Player by uuid (dashed or not) or by name: current name in exact case, then in any case,
// then a name the player used before (so links survive renames). Names may be shared over
// time; the most recent user wins, which is why the site's own links also carry the uuid.
export function findPlayer(league, key) {
    if (key === null || key === undefined) return null;
    const text = String(key).trim();
    if (!text) return null;
    const uuid = normalizeUuid(text);
    if (uuid && league.players.has(uuid)) return league.players.get(uuid);
    const lower = text.toLowerCase();
    const id = league.byExactName?.get(text) ?? league.byName.get(lower) ?? league.pastNames?.get(lower);
    return id ? league.players.get(id) || null : null;
}

function neighborRow(p) {
    return {
        position: p.position, uuid: p.uuid, name: p.name, skin: p.skin, hype: p.hype,
        tier: p.tier, tierName: p.tierName, tierLabel: p.tierLabel
    };
}

export function profileResponse(league, key, { now } = {}) {
    const record = findPlayer(league, key);
    if (!record) return null;
    const at = Number.isFinite(now) ? now : Date.now();
    const { history, ...rest } = record;
    const tier = tierFor(record.hype, league.config.tiers);
    const events = record.events || 0;
    const since = at - 30 * DAY;
    let events30d = 0;
    for (const h of history) if (h.at >= since) events30d++;

    const player = {
        ...rest,
        // shortest URL key that opens this profile: the name, or the uuid if the name leads elsewhere
        key: findPlayer(league, record.name) === record ? record.name : record.uuid,
        total: league.ranked.length,
        kd: kdRatio(record.kills, record.deaths),
        winRate: events ? round4(record.wins / events) : 0,
        top3Rate: events ? round4(record.podiums / events) : 0,
        killsPerEvent: events ? round2(record.kills / events) : 0,
        events30d,
        tierMin: tier.min,
        nextTierMin: tier.next,
        nextTierName: tier.nextName,
        progress: round4(tier.progress),
        toNext: tier.toNext
    };

    const games = [];
    for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        const g = league.gameByNumber.get(h.number);
        if (!g) continue;
        games.push({
            number: g.number, mode: g.mode, modeName: g.modeName, modeColor: g.modeColor, map: g.map,
            teamSize: g.teamSize, startedAt: g.startedAt, endedAt: g.endedAt,
            placement: h.placement, teams: h.teams, kills: h.kills, hypeChange: h.hypeChange, hypeAfter: h.hypeAfter
        });
    }

    const ranked = league.ranked;
    const idx = record.position - 1;
    const start = Math.max(0, Math.min(idx - 2, ranked.length - 5));
    const neighbors = ranked.slice(start, start + 5).map(neighborRow);

    return {
        player,
        history: history.map((h) => ({
            number: h.number, at: h.at, hype: h.hypeAfter, change: h.hypeChange,
            rank: h.rank, placement: h.placement, teams: h.teams
        })),
        games,
        neighbors
    };
}

// Small summary used by /api/health.
export function healthResponse(league, mode) {
    return { ok: true, mode, games: league.games.length, players: league.ranked.length };
}
