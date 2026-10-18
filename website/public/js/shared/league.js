// buildLeague(): raw games -> processed games, player records and ratings.
// Pure ESM: runs unchanged in Node and the browser (no Node/DOM APIs).
import { MODE_COLORS, mergeConfig, titleCase } from './defaults.js';
import { sortTiers, tierFor } from './tiers.js';

const HEX32 = /^[0-9a-f]{32}$/;
const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Minecraft UUID (dashed or not, any case) -> lowercase dashed form, or null.
export function normalizeUuid(value) {
    if (typeof value !== 'string') return null;
    if (DASHED.test(value)) return value;
    const hex = value.trim().toLowerCase().replace(/-/g, '');
    if (!HEX32.test(hex)) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function modeInfo(mode, config, modeName) {
    const entry = config?.modes?.[mode];
    const name = typeof modeName === 'string' && modeName.trim() ? modeName.trim()
        : entry?.name || titleCase(mode);
    const color = MODE_COLORS.includes(entry?.color) ? entry.color : 'blue';
    return { name, color };
}

// Moves every timestamp so the newest game ends at `newestEndedAt` (demo mode).
// Returns new game objects; the input is not mutated.
export function shiftTimestamps(rawGames, newestEndedAt) {
    const games = Array.isArray(rawGames) ? rawGames.filter((g) => g && typeof g === 'object') : [];
    let newest = -Infinity;
    for (const g of games) {
        const end = toTime(g.endedAt) ?? toTime(g.startedAt);
        if (end !== null && end > newest) newest = end;
    }
    if (!Number.isFinite(newest) || !Number.isFinite(newestEndedAt)) return games.map((g) => ({ ...g }));
    const delta = Math.round(newestEndedAt - newest);
    const shift = (t) => (toTime(t) === null ? t : toTime(t) + delta);
    return games.map((g) => ({
        ...g,
        startedAt: shift(g.startedAt),
        endedAt: shift(g.endedAt),
        teams: Array.isArray(g.teams)
            ? g.teams.map((t) => (t && typeof t === 'object' ? { ...t, eliminatedAt: shift(t.eliminatedAt) } : t))
            : g.teams
    }));
}

function toTime(value) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function toCount(value, fallback = 0) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function toDamage(value) {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Cleans one raw game. Returns null when nothing usable is left. Players
// without a valid UUID and repeated UUIDs within the game are dropped, empty
// teams are dropped and placements are re-numbered 1..n in their given order.
function cleanGame(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.teams)) return null;
    let startedAt = toTime(raw.startedAt);
    let endedAt = toTime(raw.endedAt);
    if (startedAt === null && endedAt === null) return null;
    if (startedAt === null) startedAt = endedAt;
    if (endedAt === null || endedAt < startedAt) endedAt = startedAt;

    const seen = new Set();
    const teams = [];
    raw.teams.forEach((team, order) => {
        if (!team || typeof team !== 'object' || !Array.isArray(team.players)) return;
        const players = [];
        for (const p of team.players) {
            if (!p || typeof p !== 'object') continue;
            const uuid = normalizeUuid(p.uuid);
            if (!uuid || seen.has(uuid)) continue;
            seen.add(uuid);
            const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 32) : uuid.slice(0, 8);
            const skin = typeof p.skin === 'string' && p.skin.trim() ? p.skin.trim() : uuid;
            // Final processed shape; hype fields are filled in by buildLeague.
            players.push({
                uuid, name, skin, kills: toCount(p.kills), deaths: p.deaths, damage: toDamage(p.damage),
                hypeBefore: 0, hypeChange: 0, hypeAfter: 0, tierBefore: '', tierAfter: ''
            });
        }
        if (!players.length) return;
        const placement = Number(team.placement);
        teams.push({
            sortKey: Number.isFinite(placement) ? placement : Infinity,
            order,
            eliminatedAt: toTime(team.eliminatedAt),
            players
        });
    });
    if (!teams.length) return null;
    teams.sort((a, b) => a.sortKey - b.sortKey || a.order - b.order);

    let maxTeam = 0;
    const cleanTeams = teams.map((t, i) => {
        const placement = i + 1;
        maxTeam = Math.max(maxTeam, t.players.length);
        for (const p of t.players) p.deaths = toCount(p.deaths, placement === 1 ? 0 : 1);
        return { placement, eliminatedAt: placement === 1 ? null : t.eliminatedAt, kills: 0, players: t.players };
    });

    const mode = typeof raw.mode === 'string' && raw.mode.trim() ? raw.mode.trim().toLowerCase() : 'event';
    const teamSize = toCount(raw.teamSize, 0) || maxTeam;
    return {
        number: toCount(raw.number, 0) || null,
        mode,
        modeName: typeof raw.modeName === 'string' ? raw.modeName : null,
        map: typeof raw.map === 'string' && raw.map.trim() ? raw.map.trim() : null,
        teamSize: Math.max(1, teamSize),
        startedAt,
        endedAt,
        ranked: raw.ranked !== false,
        teams: cleanTeams
    };
}

// Leaderboard order: hype desc, wins desc, kills desc, name asc (case-insensitive), uuid.
function compareState(a, b) {
    if (a.hype !== b.hype) return b.hype - a.hype;
    if (a.wins !== b.wins) return b.wins - a.wins;
    if (a.kills !== b.kills) return b.kills - a.kills;
    if (a.nameKey !== b.nameKey) return a.nameKey < b.nameKey ? -1 : 1;
    return a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0;
}

export function comparePlayers(a, b) {
    return compareState(
        { hype: a.hype, wins: a.wins, kills: a.kills, nameKey: String(a.name).toLowerCase(), uuid: a.uuid },
        { hype: b.hype, wins: b.wins, kills: b.kills, nameKey: String(b.name).toLowerCase(), uuid: b.uuid }
    );
}

// Points before entry cost for placement p of T teams (exported for tests/UI).
export function placementPoints(p, T, scoring) {
    const ratio = T > 1 ? (T - p) / (T - 1) : 1;
    let pts = scoring.maxPlacementPoints * Math.pow(Math.max(0, ratio), scoring.placementCurve);
    if (p === 1) pts += scoring.winBonus;
    return pts;
}

export function hypeChangeFor({ placement, teams, kills, hypeBefore, tierId }, scoring) {
    const lobbyFactor = Math.min(1, teams / scoring.fullLobbyTeams);
    const raw = lobbyFactor * placementPoints(placement, teams, scoring)
        + kills * scoring.killPoints
        - (scoring.entryCost[tierId] || 0);
    const change = Math.round(raw / scoring.roundTo) * scoring.roundTo;
    const hypeAfter = Math.max(0, hypeBefore + change);
    return { hypeAfter, hypeChange: hypeAfter - hypeBefore };
}

const WIN_SLOTS = 1048576; // 2^20: wins share the primary sort key with hype

export function buildLeague(rawGames, config, { now } = {}) {
    const cfg = mergeConfig(config);
    const scoring = cfg.scoring;
    const tiers = sortTiers(cfg.tiers);
    const tierIdOf = (hype) => {
        for (let t = tiers.length - 1; t > 0; t--) if (hype >= tiers[t].min) return tiers[t].id;
        return tiers[0].id;
    };
    const list = Array.isArray(rawGames) ? rawGames
        : Array.isArray(rawGames?.games) ? rawGames.games : [];

    // Clean, then give missing/duplicate numbers fresh ones after the max.
    const cleaned = [];
    for (const raw of list) {
        const game = cleanGame(raw);
        if (game) cleaned.push(game);
    }
    const used = new Set();
    let maxNumber = 0;
    for (const g of cleaned) if (g.number) maxNumber = Math.max(maxNumber, g.number);
    const unnumbered = [];
    for (const g of cleaned) {
        if (g.number && !used.has(g.number)) used.add(g.number);
        else unnumbered.push(g);
    }
    unnumbered.sort((a, b) => a.endedAt - b.endedAt);
    for (const g of unnumbered) g.number = ++maxNumber;

    const playable = cleaned
        .filter((g) => g.ranked && g.teams.length >= scoring.minTeams)
        .sort((a, b) => a.endedAt - b.endedAt || a.number - b.number);

    // Rank tracking. `order[0..size)` holds state indices sorted by
    // compareState; sort keys (hype+wins, kills) live in typed arrays. Per game:
    // binary-search the players' old slots, cut them out, then splice them back
    // in at their new slots with block moves: O(m log n + memmove), no re-sort.
    const states = new Map(); // uuid -> mutable player state
    const stateAt = []; // index -> state
    let capacity = 1024;
    let order = new Int32Array(capacity);
    let key = new Float64Array(capacity);
    let key2 = new Float64Array(capacity);
    let size = 0;
    const grow = () => {
        capacity *= 2;
        const o = new Int32Array(capacity); o.set(order); order = o;
        const k = new Float64Array(capacity); k.set(key); key = k;
        const k2 = new Float64Array(capacity); k2.set(key2); key2 = k2;
    };
    const byOrder = (a, b) => (key[a] !== key[b] ? key[b] - key[a]
        : key2[a] !== key2[b] ? key2[b] - key2[a] : compareState(stateAt[a], stateAt[b]));
    // First slot in [lo, hi) whose entry does not sort before state `ix`.
    const lowerBound = (ix, lo, hi) => {
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (byOrder(order[mid], ix) < 0) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };

    const games = [];
    const lobbyCap = scoring.fullLobbyTeams;
    const gameStates = [];
    const oldSlots = [];
    const ids = [];
    const slots = [];

    for (let gi = 0; gi < playable.length; gi++) {
        const g = playable[gi];
        const T = g.teams.length;
        const lobbyFactor = Math.min(1, T / lobbyCap);
        const { name: modeName, color: modeColor } = modeInfo(g.mode, cfg, g.modeName);
        let totalKills = 0;
        let playerCount = 0;

        // Pass 1 (before any key changes): find or create states, note old slots.
        gameStates.length = 0;
        oldSlots.length = 0;
        for (const team of g.teams) {
            for (const p of team.players) {
                let st = states.get(p.uuid);
                if (!st) {
                    if (stateAt.length === capacity) grow();
                    st = {
                        ix: stateAt.length, uuid: p.uuid, name: p.name, skin: p.skin, nameKey: '',
                        hype: scoring.startingHype, events: 0, wins: 0, podiums: 0, kills: 0, deaths: 0,
                        damage: 0, placementSum: 0, bestPlacement: team.placement, peakHype: -Infinity,
                        lowHype: Infinity, firstSeen: g.endedAt, lastSeen: g.endedAt, history: [], lastEntry: null
                    };
                    states.set(p.uuid, st);
                    stateAt.push(st);
                } else {
                    let slot = lowerBound(st.ix, 0, size);
                    if (order[slot] !== st.ix) slot = order.subarray(0, size).indexOf(st.ix); // never expected
                    oldSlots.push(slot);
                }
                gameStates.push(st);
            }
        }

        // Pass 2: score everyone and update their stats.
        let gp = 0;
        for (const team of g.teams) {
            const placement = team.placement;
            const base = lobbyFactor * placementPoints(placement, T, scoring);
            let teamKills = 0;
            for (const p of team.players) {
                const st = gameStates[gp++];
                const hypeBefore = st.hype;
                const tierBefore = tierIdOf(hypeBefore);
                const raw = base + p.kills * scoring.killPoints - (scoring.entryCost[tierBefore] || 0);
                const hypeAfter = Math.max(0, hypeBefore + Math.round(raw / scoring.roundTo) * scoring.roundTo);
                const hypeChange = hypeAfter - hypeBefore;

                p.hypeBefore = hypeBefore;
                p.hypeChange = hypeChange;
                p.hypeAfter = hypeAfter;
                p.tierBefore = tierBefore;
                p.tierAfter = tierIdOf(hypeAfter);

                if (st.name !== p.name || !st.nameKey) {
                    st.name = p.name;
                    st.nameKey = p.name.toLowerCase();
                }
                st.skin = p.skin;
                st.hype = hypeAfter;
                st.events++;
                if (placement === 1) st.wins++;
                if (placement <= 3) st.podiums++;
                st.kills += p.kills;
                st.deaths += p.deaths;
                if (p.damage !== null) st.damage += p.damage;
                st.placementSum += placement;
                if (placement < st.bestPlacement) st.bestPlacement = placement;
                if (hypeAfter > st.peakHype) st.peakHype = hypeAfter;
                if (hypeAfter < st.lowHype) st.lowHype = hypeAfter;
                st.lastSeen = g.endedAt;
                st.lastEntry = {
                    number: g.number, at: g.endedAt, hypeBefore, hypeChange, hypeAfter,
                    placement, teams: T, kills: p.kills, rank: 0
                };
                st.history.push(st.lastEntry);
                key[st.ix] = hypeAfter * WIN_SLOTS + Math.min(st.wins, WIN_SLOTS - 1);
                key2[st.ix] = st.kills;

                teamKills += p.kills;
                playerCount++;
            }
            team.kills = teamKills;
            totalKills += teamKills;
        }

        // Pass 3: cut the old slots out (ascending), compacting with block moves.
        if (oldSlots.length) {
            oldSlots.sort((a, b) => a - b);
            let write = oldSlots[0];
            for (let r = 0; r < oldSlots.length; r++) {
                const from = oldSlots[r] + 1;
                const to = r + 1 < oldSlots.length ? oldSlots[r + 1] : size;
                if (to > from) order.copyWithin(write, from, to);
                write += to - from;
            }
            size -= oldSlots.length;
        }

        // Pass 4: insert everyone at their new slots, filling from the back.
        ids.length = 0;
        for (const st of gameStates) ids.push(st.ix);
        ids.sort(byOrder);
        const m = ids.length;
        slots.length = m;
        for (let j = 0, lo = 0; j < m; j++) lo = slots[j] = lowerBound(ids[j], lo, size);
        let src = size;
        let dst = size + m;
        for (let j = m - 1; j >= 0; j--) {
            const at = slots[j];
            if (src > at) order.copyWithin(dst - (src - at), at, src);
            dst -= src - at;
            src = at;
            order[--dst] = ids[j];
            stateAt[ids[j]].lastEntry.rank = dst + 1;
        }
        size += m;

        games.push({
            number: g.number, mode: g.mode, modeName, modeColor, map: g.map, teamSize: g.teamSize,
            startedAt: g.startedAt, endedAt: g.endedAt, duration: g.endedAt - g.startedAt,
            teamCount: T, players: playerCount, kills: totalKills, ranked: true,
            teams: g.teams, winners: g.teams[0].players
        });
    }

    const players = new Map();
    const ranked = [];
    for (let i = 0; i < size; i++) {
        const st = stateAt[order[i]];
        const tier = tierFor(st.hype, tiers);
        const record = {
            uuid: st.uuid, name: st.name, skin: st.skin, hype: st.hype,
            tier: tier.id, tierName: tier.name, division: tier.division, tierLabel: tier.label,
            events: st.events, wins: st.wins, podiums: st.podiums, kills: st.kills, deaths: st.deaths,
            damage: Math.round(st.damage * 10) / 10, placementSum: st.placementSum,
            averagePlacement: round2(st.placementSum / st.events), bestPlacement: st.bestPlacement,
            peakHype: st.peakHype, lowHype: st.lowHype, firstSeen: st.firstSeen, lastSeen: st.lastSeen,
            position: i + 1, history: st.history
        };
        players.set(st.uuid, record);
        ranked.push(record);
    }

    // Name lookup: on a clash the most recently active player owns the name.
    const byName = new Map();
    [...ranked].sort((a, b) => a.lastSeen - b.lastSeen).forEach((r) => byName.set(r.name.toLowerCase(), r.uuid));

    games.sort((a, b) => b.number - a.number);
    const gameByNumber = new Map(games.map((g) => [g.number, g]));

    return {
        config: cfg,
        generatedAt: Number.isFinite(now) ? now : Date.now(),
        games,
        gameByNumber,
        players,
        ranked,
        byName
    };
}
