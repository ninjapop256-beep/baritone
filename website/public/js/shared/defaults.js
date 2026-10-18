// Default site config. public/config.json is merged on top of this with
// mergeConfig(), so the owner only needs to list what they change.
// Pure ESM: runs unchanged in Node and the browser.

export const MODE_COLORS = Object.freeze(['gold', 'red', 'blue', 'green', 'purple']);
export const SKIN_MODES = Object.freeze(['auto', 'mc-heads', 'local']);

export const DEFAULT_CONFIG = deepFreeze({
    siteName: 'PVP EVENTS',
    brand: { mark: 'PVP', text: 'EVENTS' },
    tagline: 'Ranked Minecraft PvP events',
    ratingName: 'Hype',
    serverIp: 'play.example.net',
    alternateServerIp: 'hub.example.net',
    alternateServerCommand: '/events',
    discordUrl: 'https://discord.gg/your-invite',
    storeUrl: 'https://store.example.net',
    skins: 'auto',
    modes: {
        'battle-royale': { name: 'Battle Royale', color: 'gold' },
        bedwars: { name: 'Bed Wars', color: 'red' },
        skywars: { name: 'SkyWars', color: 'blue' }
    },
    scoring: {
        startingHype: 0,
        minTeams: 4,
        maxPlacementPoints: 200,
        placementCurve: 2,
        winBonus: 60,
        killPoints: 10,
        fullLobbyTeams: 16,
        roundTo: 5,
        entryCost: { COAL: 0, COPPER: 10, IRON: 20, GOLD: 35, EMERALD: 50, DIAMOND: 70, NETHERITE: 90 }
    },
    tiers: [
        { id: 'COAL', name: 'Coal', min: 0 },
        { id: 'COPPER', name: 'Copper', min: 300 },
        { id: 'IRON', name: 'Iron', min: 800 },
        { id: 'GOLD', name: 'Gold', min: 1500 },
        { id: 'EMERALD', name: 'Emerald', min: 2500 },
        { id: 'DIAMOND', name: 'Diamond', min: 4000 },
        { id: 'NETHERITE', name: 'Netherite', min: 6000 }
    ]
});

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function deepClone(value) {
    if (Array.isArray(value)) return value.map(deepClone);
    if (isPlainObject(value)) {
        const out = {};
        for (const key of Object.keys(value)) {
            if (!UNSAFE_KEYS.has(key)) out[key] = deepClone(value[key]);
        }
        return out;
    }
    return value;
}

// Generic deep merge: plain objects merge recursively, everything else
// (arrays, primitives, null) replaces. undefined never overrides. Inputs are
// not mutated; the result shares no references with them.
export function deepMerge(base, ...overrides) {
    let out = deepClone(base);
    for (const override of overrides) {
        if (override === undefined) continue;
        if (isPlainObject(out) && isPlainObject(override)) {
            for (const key of Object.keys(override)) {
                if (UNSAFE_KEYS.has(key) || override[key] === undefined) continue;
                out[key] = key in out ? deepMerge(out[key], override[key]) : deepClone(override[key]);
            }
        } else {
            out = deepClone(override);
        }
    }
    return out;
}

// Merge that keeps the default's type: a value of the wrong type falls back to
// the default, so a typo in config.json cannot crash the site.
function typedMerge(def, user) {
    if (user === undefined) return deepClone(def);
    if (isPlainObject(def)) {
        if (!isPlainObject(user)) return deepClone(def);
        const out = deepClone(def);
        for (const key of Object.keys(user)) {
            if (UNSAFE_KEYS.has(key)) continue;
            out[key] = key in def ? typedMerge(def[key], user[key]) : deepClone(user[key]);
        }
        return out;
    }
    if (Array.isArray(def)) return Array.isArray(user) ? deepClone(user) : deepClone(def);
    if (typeof def === 'number') return toNumber(user, def);
    if (typeof def === 'string') {
        if (typeof user === 'string') return user;
        if (user === null) return '';
        if (typeof user === 'number' || typeof user === 'boolean') return String(user);
        return def;
    }
    if (typeof def === 'boolean') return typeof user === 'boolean' ? user : def;
    return deepClone(user);
}

function toNumber(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return fallback;
}

export function titleCase(slug) {
    return String(slug ?? '')
        .replace(/[_-]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normaliseTiers(list) {
    const seen = new Set();
    const tiers = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!isPlainObject(raw)) continue;
        const id = String(raw.id ?? '').trim().toUpperCase();
        const min = toNumber(raw.min, NaN);
        if (!/^[A-Z0-9_]+$/.test(id) || !Number.isFinite(min) || seen.has(id)) continue;
        seen.add(id);
        const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : titleCase(id.toLowerCase());
        tiers.push({ ...deepClone(raw), id, name, min });
    }
    tiers.sort((a, b) => a.min - b.min);
    return tiers.length ? tiers : deepClone(DEFAULT_CONFIG.tiers);
}

function normaliseModes(modes) {
    const out = {};
    for (const [slug, raw] of Object.entries(isPlainObject(modes) ? modes : {})) {
        if (!isPlainObject(raw)) continue;
        const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : titleCase(slug);
        const color = MODE_COLORS.includes(raw.color) ? raw.color : 'blue';
        out[slug] = { ...deepClone(raw), name, color };
    }
    return out;
}

// Full site config = defaults <- userConfig, with every field sanitised.
// Idempotent: mergeConfig(mergeConfig(x)) deep-equals mergeConfig(x).
export function mergeConfig(userConfig) {
    const cfg = typedMerge(DEFAULT_CONFIG, isPlainObject(userConfig) ? userConfig : {});
    cfg.tiers = normaliseTiers(cfg.tiers);
    cfg.modes = normaliseModes(cfg.modes);
    if (!SKIN_MODES.includes(cfg.skins)) cfg.skins = 'auto';
    if (!cfg.siteName.trim()) cfg.siteName = DEFAULT_CONFIG.siteName;
    if (!cfg.ratingName.trim()) cfg.ratingName = DEFAULT_CONFIG.ratingName;

    const s = cfg.scoring;
    s.startingHype = Math.max(0, s.startingHype);
    s.minTeams = Math.max(2, Math.round(s.minTeams));
    s.maxPlacementPoints = Math.max(0, s.maxPlacementPoints);
    if (!(s.placementCurve > 0)) s.placementCurve = 1;
    s.fullLobbyTeams = Math.max(1, s.fullLobbyTeams);
    if (!(s.roundTo >= 1)) s.roundTo = 1;
    const entryCost = {};
    for (const tier of cfg.tiers) entryCost[tier.id] = toNumber(s.entryCost?.[tier.id], 0);
    s.entryCost = entryCost;
    return cfg;
}

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}
