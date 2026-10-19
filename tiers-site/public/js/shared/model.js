// API response builders shared by server.js and the in-browser demo, so both return exactly
// the same shapes. Pure ESM (no Node or DOM APIs). Query arguments may be plain objects or
// URLSearchParams; every value is parsed defensively.
import { deepClone, isPlainObject } from './defaults.js';
import { buildTierList, competitionPositions, normalizeUuid } from './ranking.js';

export const OVERALL_DEFAULT_LIMIT = 50;
export const OVERALL_MAX_LIMIT = 200;
export const SEARCH_LIMIT = 8;
export const QUERY_MAX = 32;
export const EVENT_DEFAULT_MS = 2 * 60 * 60 * 1000; // events without endsAt count as 2 h long
export const DEMO_LAG_MS = 30 * 60 * 1000; // the newest demo test happened 30 minutes "ago"

const SECRET_KEY = /^_|secret|password|passwd|token|api[-_]?key|private[-_]?key|credential/i;
const MINUTE = 60 * 1000;

function param(query, key) {
    if (!query) return undefined;
    if (typeof query.get === 'function') return query.get(key) ?? undefined;
    return query[key];
}

function toInt(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function cleanQuery(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0, QUERY_MAX) : '';
}

// '' / 'all' / 'global' → null (no filter); anything else is an uppercase region id.
function regionFilter(value) {
    const region = typeof value === 'string' ? value.trim().toUpperCase() : '';
    return !region || region === 'ALL' || region === 'GLOBAL' ? null : region.slice(0, 16);
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

const titleRef = (t) => (t ? { id: t.id, name: t.name } : null);

// ---------- health / config ----------

/** GET /api/config: the merged public config (secret-looking keys removed) + mode. */
export function configResponse(config, mode = 'live') {
    return { ...stripSecrets(deepClone(config || {})), mode };
}

/** GET /api/health */
export function healthResponse(list, mode = 'live') {
    return { ok: true, mode, players: list.ranked.length, tests: list.testCount };
}

// ---------- overall ----------

/** One leaderboard row. `position` is passed in because a region filter re-ranks. */
export function overallRow(p, position = p.position) {
    const tiers = {};
    for (const [mode, t] of Object.entries(p.tiers)) tiers[mode] = { tier: t.tier, high: t.high, retired: t.retired };
    return {
        position,
        overallPosition: p.position,
        uuid: p.uuid,
        name: p.name,
        region: p.region,
        points: p.points,
        title: titleRef(p.title),
        tiers
    };
}

/**
 * GET /api/overall?region=&q=&offset=0&limit=50 → { total, totalAll, offset, limit, region, q, players: [Row] }
 * A region filter ranks that region on its own (1, 2, 2, 4 ...); `overallPosition` keeps the
 * global place. `q` (name contains, any case) only filters: positions stay those of the region.
 */
export function overallResponse(list, query = {}) {
    const region = regionFilter(param(query, 'region'));
    const q = cleanQuery(param(query, 'q')).toLowerCase();
    const offset = Math.max(0, toInt(param(query, 'offset'), 0));
    const limit = Math.min(OVERALL_MAX_LIMIT, Math.max(1, toInt(param(query, 'limit'), OVERALL_DEFAULT_LIMIT)));

    let scoped = list.ranked;
    let positions = null;
    if (region) {
        scoped = scoped.filter((p) => p.region === region);
        positions = competitionPositions(scoped);
    }
    let rows = scoped.map((p, i) => [p, positions ? positions[i] : p.position]);
    if (q) rows = rows.filter(([p]) => p.name.toLowerCase().includes(q));
    return {
        total: rows.length,
        totalAll: list.ranked.length,
        offset,
        limit,
        region,
        q,
        players: rows.slice(offset, offset + limit).map(([p, pos]) => overallRow(p, pos))
    };
}

// ---------- mode ----------

export function findMode(config, id) {
    const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
    return (config?.modes || []).find((m) => m.id === key) || null;
}

/** GET /api/mode/:mode?region= → { mode, region, total, tiers: [{ tier, players: [Entry] }] }; null for an unknown mode. */
export function modeResponse(list, modeId, query = {}) {
    const mode = findMode(list.config, modeId);
    if (!mode) return null;
    const region = regionFilter(param(query, 'region'));
    const columns = list.modes[mode.id]?.tiers || [1, 2, 3, 4, 5].map((tier) => ({ tier, players: [] }));
    let total = 0;
    const tiers = columns.map((col) => {
        const players = (region ? col.players.filter((e) => e.region === region) : col.players).map((e) => ({ ...e }));
        total += players.length;
        return { tier: col.tier, players };
    });
    return { mode: deepClone(mode), region, total, tiers };
}

// ---------- players ----------

/** Name (any case), past name or UUID; `id` (a UUID) wins when it names a known player. */
export function findPlayer(list, key, { id } = {}) {
    const byId = normalizeUuid(typeof id === 'string' ? id : '');
    if (byId && list.players.has(byId)) return list.players.get(byId);
    const text = typeof key === 'string' ? key.trim() : '';
    if (!text) return null;
    const uuid = normalizeUuid(text);
    if (uuid) return list.players.get(uuid) || null;
    const lower = text.toLowerCase();
    const hit = list.byName.get(lower) || list.pastNames.get(lower);
    return hit ? list.players.get(hit) || null : null;
}

/**
 * GET /api/players/:key?id= → { player, history } or null.
 * player = Player minus history + totalRanked; history = test records, newest first, each with
 * `prev` (that mode's tier before this test, or null) and `removed: true` for a cleared mode.
 */
export function playerResponse(list, key, query = {}) {
    const p = findPlayer(list, key, { id: param(query, 'id') });
    if (!p) return null;
    const tiers = {};
    for (const [mode, t] of Object.entries(p.tiers)) tiers[mode] = { ...t, peak: { ...t.peak } };
    return {
        player: {
            uuid: p.uuid,
            name: p.name,
            region: p.region,
            points: p.points,
            title: p.title ? { ...p.title } : null,
            position: p.position,
            totalRanked: list.ranked.length,
            tests: p.tests,
            tiers,
            pastNames: [...p.pastNames],
            firstTested: p.firstTested,
            lastTested: p.lastTested
        },
        history: p.history.map((h) => ({ ...h, prev: h.prev ? { ...h.prev } : null }))
    };
}

// ---------- search ----------

/**
 * GET /api/search?q= → { results: [{ uuid, name, region, points, title, position, pastName? }] }
 * Top 8: exact name, then prefix, then contains, then past names; ranked players before
 * unranked ones, better positions first. A UUID finds that player.
 */
export function searchResponse(list, q, { limit = SEARCH_LIMIT } = {}) {
    const text = cleanQuery(typeof q === 'object' && q !== null ? param(q, 'q') : q);
    if (!text) return { results: [] };
    const result = (p, pastName) => {
        const r = { uuid: p.uuid, name: p.name, region: p.region, points: p.points, title: titleRef(p.title), position: p.position };
        if (pastName) r.pastName = pastName;
        return r;
    };
    const uuid = normalizeUuid(text);
    if (uuid) {
        const p = list.players.get(uuid);
        return { results: p ? [result(p)] : [] };
    }
    const needle = text.toLowerCase();
    const hits = [];
    for (const p of list.players.values()) {
        const name = p.name.toLowerCase();
        let group = name === needle ? 0 : name.startsWith(needle) ? 1 : name.includes(needle) ? 2 : -1;
        let pastName = null;
        if (group === -1) {
            pastName = p.pastNames.find((n) => n.toLowerCase().startsWith(needle)) || null;
            if (pastName) group = pastName.toLowerCase() === needle ? 3 : 4;
        }
        if (group !== -1) hits.push({ p, group, pastName });
    }
    hits.sort((a, b) => a.group - b.group
        || (a.p.position ?? Infinity) - (b.p.position ?? Infinity)
        || b.p.lastTested - a.p.lastTested
        || (a.p.name.toLowerCase() < b.p.name.toLowerCase() ? -1 : a.p.name.toLowerCase() > b.p.name.toLowerCase() ? 1 : 0));
    const max = Math.max(1, Math.min(50, toInt(limit, SEARCH_LIMIT)));
    return { results: hits.slice(0, max).map((h) => result(h.p, h.pastName)) };
}

// ---------- events ----------

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function toTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (typeof value === 'string' && value.trim()) {
        const t = /^\d+$/.test(value.trim()) ? Number(value) : Date.parse(value);
        return Number.isFinite(t) ? t : null;
    }
    return null;
}

const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

export function slugify(value) {
    return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
}

/**
 * Cleans events from events.json (an array or { events: [...] }). Invalid entries are skipped
 * and reported through onError(message). Times may be epoch ms or ISO strings. Sorted by start.
 * Event = { slug, title, mode, format, region, startsAt, endsAt?, description, maxPlayers?, prize?, host?, url? }
 */
export function normalizeEvents(raw, { onError = () => {} } = {}) {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.events) ? raw.events : null;
    if (!list) {
        if (raw !== undefined && raw !== null) onError('events must be a JSON array of events');
        return [];
    }
    const seen = new Set();
    const out = [];
    list.forEach((e, i) => {
        if (!isPlainObject(e)) return onError(`events[${i}]: must be an object`);
        const title = text(e.title, 120);
        const slug = typeof e.slug === 'string' && e.slug.trim() ? e.slug.trim().toLowerCase() : slugify(title);
        const startsAt = toTime(e.startsAt);
        if (!title) return onError(`events[${i}].title: is required`);
        if (!SLUG_RE.test(slug)) return onError(`events[${i}].slug: use 1-64 lowercase letters, digits or "-"`);
        if (seen.has(slug)) return onError(`events[${i}].slug: "${slug}" is used twice`);
        if (startsAt === null) return onError(`events[${i}].startsAt: must be epoch milliseconds or an ISO date`);
        seen.add(slug);
        const event = {
            slug,
            title,
            mode: text(e.mode, 32)?.toLowerCase() ?? null,
            format: text(e.format, 24),
            region: text(e.region, 24),
            startsAt,
            description: typeof e.description === 'string' ? e.description.trim().slice(0, 6000) : ''
        };
        const endsAt = toTime(e.endsAt);
        if (endsAt !== null && endsAt > startsAt) event.endsAt = endsAt;
        const maxPlayers = toInt(e.maxPlayers, null);
        if (maxPlayers !== null && maxPlayers > 0) event.maxPlayers = maxPlayers;
        const prize = text(e.prize, 120);
        if (prize) event.prize = prize;
        const host = text(e.host, 64);
        if (host) event.host = host;
        if (typeof e.url === 'string' && /^https?:\/\/\S+$/i.test(e.url.trim())) event.url = e.url.trim();
        out.push(event);
    });
    return out.sort((a, b) => a.startsAt - b.startsAt || (a.slug < b.slug ? -1 : 1));
}

/** 'upcoming' | 'live' | 'past' at time `now`. */
export function eventStatus(event, now) {
    const end = event.endsAt ?? event.startsAt + EVENT_DEFAULT_MS;
    if (now < event.startsAt) return 'upcoming';
    return now < end ? 'live' : 'past';
}

const withStatus = (event, now) => ({ ...event, status: eventStatus(event, now) });

/** GET /api/events → { upcoming: [Event] (live first, soonest first), past: [Event] (newest first) } */
export function eventsResponse(events, { now = Date.now() } = {}) {
    const all = (events || []).map((e) => withStatus(e, now));
    return {
        upcoming: all.filter((e) => e.status !== 'past').sort((a, b) => a.startsAt - b.startsAt),
        past: all.filter((e) => e.status === 'past').sort((a, b) => b.startsAt - a.startsAt)
    };
}

/** GET /api/events/:slug → Event (with status) or null. */
export function eventResponse(events, slug, { now = Date.now() } = {}) {
    const key = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
    const event = key ? (events || []).find((e) => e.slug === key) : null;
    return event ? withStatus(event, now) : null;
}

// ---------- server status ----------

/** GET /api/server shape for an unreachable server. */
export function offlineServerResponse(now = Date.now(), error = undefined) {
    const out = { online: false, players: { online: 0, max: 0 }, version: null, motd: null, latency: null, checkedAt: now };
    if (error) out.error = error;
    return out;
}

/** Plausible, smoothly changing numbers for demo mode (busiest around 20:00 UTC). */
export function demoServerResponse(config, now = Date.now()) {
    const minute = Math.floor(now / MINUTE);
    const hour = (now / (60 * MINUTE)) % 24;
    const wave = (Math.cos(((hour - 20) / 24) * 2 * Math.PI) + 1) / 2; // 1 at 20:00 UTC, 0 at 08:00
    const jitter = ((minute * 2654435761) >>> 0) % 97;
    return {
        online: true,
        players: { online: Math.round(640 + wave * 1700 + jitter), max: 4000 },
        version: '1.21.x',
        motd: `${config?.siteName || 'Tier list'} · ${config?.tagline || 'PvP tier testing'}`,
        latency: 18 + (((minute * 40503) >>> 0) % 23),
        checkedAt: minute * MINUTE
    };
}

// ---------- demo data ----------

/** Shift (ms) that makes the newest demo test happen DEMO_LAG_MS before `now`. */
export function demoShift(tests, now = Date.now()) {
    let newest = -Infinity;
    for (const t of Array.isArray(tests) ? tests : []) {
        if (t && typeof t.at === 'number' && Number.isFinite(t.at) && t.at > newest) newest = t.at;
    }
    return Number.isFinite(newest) ? Math.round(now - DEMO_LAG_MS - newest) : 0;
}

export function shiftTests(tests, delta) {
    return (Array.isArray(tests) ? tests : []).map((t) => (t && typeof t.at === 'number' ? { ...t, at: t.at + delta } : t));
}

export function shiftEvents(events, delta) {
    return (events || []).map((e) => {
        const out = { ...e, startsAt: e.startsAt + delta };
        if (typeof e.endsAt === 'number') out.endsAt = e.endsAt + delta;
        return out;
    });
}

/** Demo files → { tests, events, delta }, moved in time together so they always look recent. */
export function prepareDemo({ tests, events, now = Date.now() } = {}) {
    const delta = demoShift(tests, now);
    return { tests: shiftTests(tests, delta), events: shiftEvents(normalizeEvents(events ?? []), delta), delta };
}

// ---------- facade ----------

/**
 * One object answering every read endpoint (used by the browser demo; handy in tests).
 * createEngine({ config, tests, events, mode, now }) → { list, events, health(), config(), overall(q),
 *   mode(id, q), player(key, q), search(q), eventList(), event(slug), server() }
 * Not-found answers are null. `now` may be a number or a function (default Date.now).
 */
export function createEngine({ config, tests = [], events = [], mode = 'demo', now = Date.now } = {}) {
    const clock = typeof now === 'function' ? now : () => now;
    const list = buildTierList(tests, config, { now: clock() });
    const evts = normalizeEvents(events);
    return {
        list,
        events: evts,
        health: () => healthResponse(list, mode),
        config: () => configResponse(config, mode),
        overall: (query) => overallResponse(list, query),
        mode: (id, query) => modeResponse(list, id, query),
        player: (key, query) => playerResponse(list, key, query),
        search: (q) => searchResponse(list, q),
        eventList: () => eventsResponse(evts, { now: clock() }),
        event: (slug) => eventResponse(evts, slug, { now: clock() }),
        server: () => demoServerResponse(config, clock())
    };
}
