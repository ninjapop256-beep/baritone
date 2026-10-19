// Strict validation for games POSTed by the Minecraft plugin.
// validateGame(raw, { now }) -> { ok, game, errors }
import { normalizeUuid } from '../public/js/shared/league.js';

export const LIMITS = Object.freeze({
    maxTeams: 200,
    maxPlayers: 1000,
    maxTeamSize: 100,
    maxKills: 1000,
    maxDeaths: 1000,
    maxDamage: 100000,
    maxDurationMs: 24 * 60 * 60 * 1000,
    maxErrors: 50
});

// Minecraft 1.0 release; anything older is certainly a bad timestamp.
const MIN_TIME = Date.UTC(2011, 10, 18);
const FUTURE_SLACK = 24 * 60 * 60 * 1000;
const ELIM_SLACK = 60 * 1000;

// Java names, optionally after one symbol: Geyser/Floodgate prefix Bedrock names ('.Steve').
const NAME_RE = /^[!-/:-@[-^`{-~]?[A-Za-z0-9_]{1,16}$/;
const MODE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAP_MAX = 48;
const SKIN_RE = /^[A-Za-z0-9_-]{1,128}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

function show(value) {
    if (value === undefined) return 'nothing';
    let text;
    try {
        text = JSON.stringify(value);
    } catch {
        text = String(value);
    }
    if (text === undefined) text = String(value);
    return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

export function validateGame(raw, { now = Date.now() } = {}) {
    const errors = [];
    let dropped = 0;
    const bad = (path, message, value) => {
        if (errors.length >= LIMITS.maxErrors) {
            dropped++;
            return;
        }
        errors.push(`${path}: ${message} (got ${show(value)})`);
    };

    if (!isObj(raw)) {
        return { ok: false, game: null, errors: [`body: expected a JSON object describing one game (got ${show(raw)})`] };
    }

    const game = {};

    // number (optional; the store assigns the next one when missing)
    if (raw.number !== undefined && raw.number !== null) {
        if (!isInt(raw.number) || raw.number < 1 || raw.number > 1e9) bad('number', 'must be a positive integer, or omitted to auto-number', raw.number);
        else game.number = raw.number;
    }

    // mode
    if (typeof raw.mode !== 'string') {
        bad('mode', 'is required: a slug such as "battle-royale", "bedwars" or "skywars"', raw.mode);
    } else {
        const mode = raw.mode.trim().toLowerCase();
        if (!MODE_RE.test(mode)) bad('mode', 'must be a slug of 1-32 lowercase letters, digits, "-" or "_"', raw.mode);
        else game.mode = mode;
    }

    if (raw.modeName !== undefined && raw.modeName !== null) {
        if (typeof raw.modeName !== 'string' || !raw.modeName.trim() || raw.modeName.trim().length > 48) {
            bad('modeName', 'must be a non-empty string of at most 48 characters, or omitted', raw.modeName);
        } else {
            game.modeName = raw.modeName.trim();
        }
    }

    // map is display-only: "Cherry Grove" is stored as the slug "cherry_grove"; a name with no
    // usable letters is left out rather than failing the game
    if (raw.map !== undefined && raw.map !== null && raw.map !== '') {
        if (typeof raw.map !== 'string') {
            bad('map', 'must be a string such as "cherry_grove" or "Cherry Grove"', raw.map);
        } else {
            const map = raw.map.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, MAP_MAX).replace(/^[_-]+|[_-]+$/g, '');
            if (map) game.map = map;
        }
    }

    // teamSize
    if (!isInt(raw.teamSize) || raw.teamSize < 1 || raw.teamSize > LIMITS.maxTeamSize) {
        bad('teamSize', `is required: players per team, an integer 1-${LIMITS.maxTeamSize} (1 = solos, 2 = duos ...)`, raw.teamSize);
    } else {
        game.teamSize = raw.teamSize;
    }

    // timestamps (epoch milliseconds)
    const checkTime = (key) => {
        const v = raw[key];
        if (!isInt(v)) {
            bad(key, 'is required: epoch milliseconds as an integer', v);
            return null;
        }
        if (v > 0 && v < 1e11) {
            bad(key, 'looks like epoch seconds; send epoch milliseconds', v);
            return null;
        }
        if (v < MIN_TIME || v > now + FUTURE_SLACK) {
            bad(key, 'is not a plausible time (before 2011 or more than a day in the future)', v);
            return null;
        }
        return v;
    };
    const startedAt = checkTime('startedAt');
    const endedAt = checkTime('endedAt');
    if (startedAt !== null && endedAt !== null) {
        if (endedAt < startedAt) bad('endedAt', 'must not be before startedAt', endedAt);
        else if (endedAt - startedAt > LIMITS.maxDurationMs) bad('endedAt', 'game lasted more than 24 hours', endedAt - startedAt);
        game.startedAt = startedAt;
        game.endedAt = endedAt;
    }

    if (raw.ranked !== undefined && raw.ranked !== null && typeof raw.ranked !== 'boolean') {
        bad('ranked', 'must be true or false (default true)', raw.ranked);
    }
    game.ranked = raw.ranked !== false;

    // teams
    const teamsOut = [];
    if (!Array.isArray(raw.teams) || raw.teams.length === 0) {
        bad('teams', 'is required: a non-empty array of teams', raw.teams);
    } else if (raw.teams.length > LIMITS.maxTeams) {
        bad('teams', `has more than ${LIMITS.maxTeams} teams`, raw.teams.length);
    } else {
        const placements = new Map();
        const uuids = new Map();
        let totalPlayers = 0;
        // the best (lowest) placement wins; gaps are fine (e.g. an empty team was left out)
        const best = Math.min(...raw.teams.map((t) => (isObj(t) && isInt(t.placement) && t.placement >= 1 ? t.placement : Infinity)));

        raw.teams.forEach((team, ti) => {
            const tp = `teams[${ti}]`;
            if (!isObj(team)) {
                bad(tp, 'must be an object with placement and players', team);
                return;
            }
            const out = { placement: null, eliminatedAt: null, players: [] };

            if (!isInt(team.placement) || team.placement < 1 || team.placement > LIMITS.maxTeams) {
                bad(`${tp}.placement`, `must be an integer from 1 (winner) to ${LIMITS.maxTeams}; lower is better`, team.placement);
            } else if (placements.has(team.placement)) {
                bad(`${tp}.placement`, `duplicates teams[${placements.get(team.placement)}]; placements must be unique`, team.placement);
            } else {
                placements.set(team.placement, ti);
                out.placement = team.placement;
            }

            const el = team.eliminatedAt === 0 ? null : team.eliminatedAt; // 0: Java's "not set"
            if (out.placement === best) {
                if (el !== undefined && el !== null) bad(`${tp}.eliminatedAt`, 'must be null for the winning team', el);
            } else if (el !== undefined && el !== null) {
                if (!isInt(el)) {
                    bad(`${tp}.eliminatedAt`, 'must be epoch milliseconds or null', el);
                } else if (startedAt !== null && endedAt !== null
                    && (el < startedAt - ELIM_SLACK || el > endedAt + ELIM_SLACK)) {
                    bad(`${tp}.eliminatedAt`, 'must be between startedAt and endedAt', el);
                } else {
                    out.eliminatedAt = startedAt !== null && endedAt !== null
                        ? Math.min(endedAt, Math.max(startedAt, el)) : el;
                }
            }

            if (!Array.isArray(team.players) || team.players.length === 0) {
                bad(`${tp}.players`, 'must be a non-empty array of players', team.players);
            } else {
                if (game.teamSize && team.players.length > game.teamSize) {
                    bad(`${tp}.players`, `has ${team.players.length} players but teamSize is ${game.teamSize}`, team.players.length);
                }
                totalPlayers += team.players.length;
                team.players.forEach((p, pi) => {
                    const pp = `${tp}.players[${pi}]`;
                    if (!isObj(p)) {
                        bad(pp, 'must be an object with uuid, name and kills', p);
                        return;
                    }
                    const player = {};
                    const uuid = normalizeUuid(p.uuid);
                    if (!uuid) {
                        bad(`${pp}.uuid`, 'must be a Minecraft UUID (32 hex digits, dashes optional)', p.uuid);
                    } else if (uuids.has(uuid)) {
                        bad(`${pp}.uuid`, `already appears at ${uuids.get(uuid)}; each player may appear once per game`, p.uuid);
                    } else {
                        uuids.set(uuid, pp);
                        player.uuid = uuid;
                    }
                    if (typeof p.name !== 'string' || !NAME_RE.test(p.name)) {
                        bad(`${pp}.name`, 'must be 1-16 characters of A-Z, a-z, 0-9 or _ (optionally after one symbol, e.g. a Bedrock "." prefix)', p.name);
                    } else {
                        player.name = p.name;
                    }
                    if (p.skin !== undefined && p.skin !== null && p.skin !== '') {
                        if (typeof p.skin !== 'string' || !SKIN_RE.test(p.skin)) bad(`${pp}.skin`, 'must be a skin id (letters, digits, "-" or "_")', p.skin);
                        else player.skin = p.skin;
                    }
                    if (p.kills === undefined || p.kills === null) {
                        player.kills = 0; // serializers often leave out zero values
                    } else if (!isInt(p.kills) || p.kills < 0 || p.kills > LIMITS.maxKills) {
                        bad(`${pp}.kills`, `must be an integer 0-${LIMITS.maxKills}`, p.kills);
                    } else {
                        player.kills = p.kills;
                    }
                    if (p.deaths !== undefined && p.deaths !== null) {
                        if (!isInt(p.deaths) || p.deaths < 0 || p.deaths > LIMITS.maxDeaths) bad(`${pp}.deaths`, `must be an integer 0-${LIMITS.maxDeaths}, or omitted`, p.deaths);
                        else player.deaths = p.deaths;
                    }
                    if (p.damage !== undefined && p.damage !== null) {
                        if (typeof p.damage !== 'number' || !Number.isFinite(p.damage) || p.damage < 0 || p.damage > LIMITS.maxDamage) {
                            bad(`${pp}.damage`, 'must be a number of hearts >= 0, or omitted', p.damage);
                        } else {
                            player.damage = Math.round(p.damage * 100) / 100;
                        }
                    }
                    out.players.push(player);
                });
            }
            teamsOut.push(out);
        });

        if (totalPlayers > LIMITS.maxPlayers) bad('teams', `has more than ${LIMITS.maxPlayers} players in total`, totalPlayers);
    }

    if (dropped) errors.push(`... and ${dropped} more error${dropped === 1 ? '' : 's'}`);
    if (errors.length) return { ok: false, game: null, errors };

    teamsOut.sort((a, b) => a.placement - b.placement);
    teamsOut.forEach((t, i) => { t.placement = i + 1; }); // stored as 1..n
    game.teams = teamsOut;
    return { ok: true, game, errors: [] };
}
