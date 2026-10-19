// Tier list engine: turns the append-only log of tier tests into players, points, positions
// and per-mode tier columns. Pure ESM: the server and the in-browser demo run the same code.
import { isTier, tierPoints, tierScore, titleFor } from './tiers.js';

const UUID_HEX = /^[0-9a-f]{32}$/;

/** Any UUID spelling (dashes optional, any case) → lowercase dashed form; null when invalid. */
export function normalizeUuid(value) {
    if (typeof value !== 'string') return null;
    const hex = value.trim().toLowerCase().replace(/-/g, '');
    if (!UUID_HEX.test(hex)) return null;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Plain code-point order on lowercase names: identical in every browser and in Node.
function cmpText(a, b) {
    const x = String(a ?? '').toLowerCase();
    const y = String(b ?? '').toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
}

/** Chronological record order: `at`, then `id` (records without an id last). */
export function compareRecords(a, b) {
    const ida = Number.isSafeInteger(a.id) ? a.id : Infinity;
    const idb = Number.isSafeInteger(b.id) ? b.id : Infinity;
    return a.at - b.at || (ida === idb ? 0 : ida < idb ? -1 : 1);
}

/** Leaderboard order: points, best tier, tests taken, then name. */
export function comparePlayers(a, b) {
    return b.points - a.points
        || b.bestScore - a.bestScore
        || b.tests - a.tests
        || cmpText(a.name, b.name)
        || cmpText(a.uuid, b.uuid);
}

/** Order inside one tier column: HT before LT, active before retired, longest-held first, then name. */
export function compareEntries(a, b) {
    return Number(b.high) - Number(a.high)
        || Number(a.retired) - Number(b.retired)
        || a.at - b.at
        || cmpText(a.name, b.name)
        || cmpText(a.uuid, b.uuid);
}

/** Players tie (share a position) when both points and best tier are equal. */
export function sameStanding(a, b) {
    return a.points === b.points && a.bestScore === b.bestScore;
}

/** Competition ranking (1, 2, 2, 4) over an already sorted list; returns positions by index. */
export function competitionPositions(sorted) {
    const out = [];
    sorted.forEach((p, i) => {
        out.push(i > 0 && sameStanding(p, sorted[i - 1]) ? out[i - 1] : i + 1);
    });
    return out;
}

// Lenient read of one stored record; null when it cannot be used.
function readRecord(raw, modes, index) {
    if (!raw || typeof raw !== 'object') return null;
    const uuid = normalizeUuid(raw.uuid);
    const mode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : '';
    const at = typeof raw.at === 'number' ? raw.at : Number.NaN;
    if (!uuid || !modes.has(mode) || !Number.isFinite(at)) return null;
    const removed = raw.removed === true || raw.tier === 0;
    if (!removed && !isTier(raw.tier)) return null;
    return {
        id: Number.isSafeInteger(raw.id) ? raw.id : null,
        uuid,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null,
        region: typeof raw.region === 'string' && raw.region.trim() ? raw.region.trim().toUpperCase() : null,
        mode,
        tier: removed ? 0 : raw.tier,
        high: !removed && raw.high === true,
        retired: !removed && raw.retired === true,
        removed,
        at,
        tester: typeof raw.tester === 'string' && raw.tester.trim() ? raw.tester.trim() : null,
        index
    };
}

/**
 * buildTierList(tests, config, { now }) → {
 *   config, generatedAt, testCount,
 *   players: Map<uuid, Player>, ranked: Player[], byName: Map<lowerName, uuid>, pastNames: Map<lowerName, uuid>,
 *   modes: { [modeId]: { total, tiers: [{ tier, players: [Entry] }] } }
 * }
 * Player = { uuid, name, region, points, title, position, bestScore, tests, pastNames,
 *            tiers: { [modeId]: { tier, high, retired, at, tester, peak: { tier, high, at } } },
 *            history: [entry, newest first], firstTested, lastTested }
 * Entry  = { uuid, name, region, tier, high, retired, at }
 */
export function buildTierList(tests, config, { now = Date.now() } = {}) {
    const modeIds = (config?.modes || []).map((m) => m.id);
    const modeSet = new Set(modeIds);
    const records = [];
    (Array.isArray(tests) ? tests : []).forEach((raw, i) => {
        const r = readRecord(raw, modeSet, i);
        if (r) records.push(r);
    });
    records.sort((a, b) => compareRecords(a, b) || a.index - b.index);

    const players = new Map();
    const extra = new Map(); // uuid -> { names: Map<lower, { name, at }>, peaks: {} }
    for (const r of records) {
        let p = players.get(r.uuid);
        if (!p) {
            p = {
                uuid: r.uuid, name: null, region: null, points: 0, title: null, position: null, bestScore: 0,
                tests: 0, pastNames: [], tiers: {}, history: [], firstTested: r.at, lastTested: r.at
            };
            players.set(r.uuid, p);
            extra.set(r.uuid, { names: new Map(), peaks: {} });
        }
        const x = extra.get(r.uuid);
        p.tests++;
        p.lastTested = r.at;
        if (r.name) {
            p.name = r.name;
            x.names.set(r.name.toLowerCase(), { name: r.name, at: r.at });
        }
        if (r.region) p.region = r.region;

        const before = p.tiers[r.mode];
        const prev = before ? { tier: before.tier, high: before.high, retired: before.retired } : null;
        if (r.removed) {
            delete p.tiers[r.mode];
        } else {
            const peak = x.peaks[r.mode];
            if (!peak || tierScore(r.tier, r.high) > tierScore(peak.tier, peak.high)) {
                x.peaks[r.mode] = { tier: r.tier, high: r.high, at: r.at };
            }
            p.tiers[r.mode] = { tier: r.tier, high: r.high, retired: r.retired, at: r.at, tester: r.tester, peak: null };
        }
        const entry = { id: r.id, mode: r.mode, tier: r.tier, high: r.high, retired: r.retired, at: r.at, tester: r.tester, name: r.name, region: r.region, prev };
        if (r.removed) entry.removed = true;
        p.history.push(entry);
    }

    const retiredCounts = config?.retiredCounts !== false;
    const ranked = [];
    for (const p of players.values()) {
        const x = extra.get(p.uuid);
        if (!p.name) p.name = p.uuid.slice(0, 8);
        const lower = p.name.toLowerCase();
        p.pastNames = [...x.names.entries()]
            .filter(([key]) => key !== lower)
            .sort((a, b) => b[1].at - a[1].at)
            .map(([, v]) => v.name);
        p.history.reverse();

        // tiers in config order, each with its all-time peak
        const tiers = {};
        let points = 0;
        let best = 0;
        for (const id of modeIds) {
            const t = p.tiers[id];
            if (!t) continue;
            t.peak = { ...x.peaks[id] };
            tiers[id] = t;
            if (t.retired && !retiredCounts) continue;
            points += tierPoints(t.tier, t.high, config);
            best = Math.max(best, tierScore(t.tier, t.high));
        }
        p.tiers = tiers;
        p.points = Math.round(points * 100) / 100;
        p.bestScore = best;
        p.title = titleFor(p.points, config?.titles);
        if (Object.keys(tiers).length) ranked.push(p);
    }

    ranked.sort(comparePlayers);
    competitionPositions(ranked).forEach((pos, i) => { ranked[i].position = pos; });

    // Current names win; with duplicates the most recently tested player gets the name.
    const byRecency = [...players.values()].sort((a, b) => a.lastTested - b.lastTested);
    const byName = new Map();
    for (const p of byRecency) byName.set(p.name.toLowerCase(), p.uuid);
    const pastNames = new Map();
    const pastAt = new Map();
    for (const p of byRecency) {
        const names = extra.get(p.uuid).names;
        for (const old of p.pastNames) {
            const key = old.toLowerCase();
            const at = names.get(key).at;
            if (byName.has(key) || (pastAt.has(key) && pastAt.get(key) > at)) continue;
            pastNames.set(key, p.uuid);
            pastAt.set(key, at);
        }
    }

    const modes = {};
    for (const id of modeIds) {
        const columns = [1, 2, 3, 4, 5].map((tier) => ({ tier, players: [] }));
        let total = 0;
        for (const p of ranked) {
            const t = p.tiers[id];
            if (!t) continue;
            columns[t.tier - 1].players.push({ uuid: p.uuid, name: p.name, region: p.region, tier: t.tier, high: t.high, retired: t.retired, at: t.at });
            total++;
        }
        for (const col of columns) col.players.sort(compareEntries);
        modes[id] = { total, tiers: columns };
    }

    return { config, generatedAt: now, testCount: records.length, players, ranked, byName, pastNames, modes };
}
