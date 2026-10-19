// Default site config. public/config.json is merged on top of this with mergeConfig(),
// so the owner only lists what they change and a typo can never crash the site.
// Pure ESM: runs unchanged in Node and the browser.

export const TIER_KEYS = Object.freeze(['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5']);
export const REGION_COLORS = Object.freeze(['red', 'green', 'orange', 'purple', 'teal', 'yellow', 'blue']);
export const SKIN_MODES = Object.freeze(['auto', 'mc-heads', 'local']);
export const DEFAULT_MODE_COLOR = '#9aa4b2';

export const DEFAULT_CONFIG = deepFreeze({
    siteName: 'BLOCKTIERS',
    tagline: 'The Minecraft PvP tier list',
    description: 'Players are tier-tested in eight gamemodes, placed from Tier 1 to Tier 5 and ranked on one overall leaderboard.',
    serverIp: 'play.example.net',
    serverPort: 25565,
    serverVersions: 'Java 1.21+ · Bedrock',
    testCommand: '/tiertest',
    discords: [
        { name: 'Community', url: 'https://discord.gg/your-invite' },
        { name: 'Tier testing', url: 'https://discord.gg/your-testing-invite' }
    ],
    skins: 'auto',
    regions: [
        { id: 'NA', name: 'North America', color: 'red' },
        { id: 'EU', name: 'Europe', color: 'green' },
        { id: 'SA', name: 'South America', color: 'orange' },
        { id: 'AS', name: 'Asia', color: 'purple' },
        { id: 'OCE', name: 'Oceania', color: 'teal' },
        { id: 'ME', name: 'Middle East', color: 'yellow' },
        { id: 'AF', name: 'Africa', color: 'blue' }
    ],
    modes: [
        { id: 'vanilla', name: 'Vanilla', icon: 'vanilla', color: '#b98cff', blurb: 'End crystals, anchors and full netherite.' },
        { id: 'uhc', name: 'UHC', icon: 'uhc', color: '#ff5d6c', blurb: 'No natural regen: golden apples, lava and rods.' },
        { id: 'pot', name: 'Pot', icon: 'pot', color: '#ff8ad8', blurb: 'Splash healing potions and diamond gear.' },
        { id: 'nethop', name: 'NethOP', icon: 'nethop', color: '#9d7bff', blurb: 'Overpowered netherite kits with debuff potions.' },
        { id: 'smp', name: 'SMP', icon: 'smp', color: '#3fd6b0', blurb: 'Survival-style kits: totems, pearls and shields.' },
        { id: 'sword', name: 'Sword', icon: 'sword', color: '#62b6ff', blurb: 'Just a sword and armor. Pure aim and spacing.' },
        { id: 'axe', name: 'Axe', icon: 'axe', color: '#7fd0ff', blurb: 'Axes, shields and shield-breaking timing.' },
        { id: 'mace', name: 'Mace', icon: 'mace', color: '#c8c8d8', blurb: 'Wind charges, elytra and devastating mace smashes.' }
    ],
    points: { HT1: 50, LT1: 40, HT2: 28, LT2: 20, HT3: 12, LT3: 8, HT4: 5, LT4: 3, HT5: 2, LT5: 1 },
    retiredCounts: true,
    titles: [
        { id: 'grand-champion', name: 'Grand Champion', min: 350 },
        { id: 'champion', name: 'Champion', min: 200 },
        { id: 'elite', name: 'Elite', min: 100 },
        { id: 'veteran', name: 'Veteran', min: 50 },
        { id: 'contender', name: 'Contender', min: 20 },
        { id: 'apprentice', name: 'Apprentice', min: 10 },
        { id: 'rookie', name: 'Rookie', min: 0 }
    ]
});

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

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

export function titleCase(slug) {
    return String(slug ?? '')
        .replace(/[_-]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function toNumber(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
    return fallback;
}

const cleanText = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);

// Merge that keeps the default's type: a value of the wrong type falls back to the default.
// Plain objects merge per key; arrays and primitives replace.
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

function normaliseModes(list) {
    const defaults = new Map(DEFAULT_CONFIG.modes.map((m) => [m.id, m]));
    const seen = new Set();
    const modes = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!isPlainObject(raw)) continue;
        const id = String(raw.id ?? '').trim().toLowerCase();
        if (!SLUG_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        const def = defaults.get(id);
        const icon = String(raw.icon ?? '').trim().toLowerCase();
        modes.push({
            ...deepClone(raw),
            id,
            name: cleanText(raw.name, def?.name || titleCase(id)),
            icon: SLUG_RE.test(icon) ? icon : id,
            color: typeof raw.color === 'string' && HEX_RE.test(raw.color.trim()) ? raw.color.trim() : (def?.color || DEFAULT_MODE_COLOR),
            blurb: typeof raw.blurb === 'string' ? raw.blurb.trim() : (def?.blurb || '')
        });
    }
    return modes.length ? modes : deepClone(DEFAULT_CONFIG.modes);
}

function normaliseRegions(list) {
    const seen = new Set();
    const regions = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!isPlainObject(raw)) continue;
        const id = String(raw.id ?? '').trim().toUpperCase();
        if (!/^[A-Z0-9]{1,8}$/.test(id) || seen.has(id)) continue;
        seen.add(id);
        regions.push({
            ...deepClone(raw),
            id,
            name: cleanText(raw.name, id),
            color: REGION_COLORS.includes(raw.color) ? raw.color : 'blue'
        });
    }
    return regions.length ? regions : deepClone(DEFAULT_CONFIG.regions);
}

function normalisePoints(points) {
    const out = {};
    for (const key of TIER_KEYS) out[key] = Math.max(0, toNumber(points?.[key], DEFAULT_CONFIG.points[key]));
    return out;
}

// Highest first. The lowest title is the one everybody starts with, so its min is 0.
function normaliseTitles(list) {
    const seen = new Set();
    const titles = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!isPlainObject(raw)) continue;
        const name = cleanText(raw.name);
        const id = String(raw.id ?? '').trim().toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const min = toNumber(raw.min, NaN);
        if (!name || !SLUG_RE.test(id) || !Number.isFinite(min) || seen.has(id)) continue;
        seen.add(id);
        titles.push({ ...deepClone(raw), id, name, min: Math.max(0, min) });
    }
    if (!titles.length) return deepClone(DEFAULT_CONFIG.titles);
    titles.sort((a, b) => b.min - a.min);
    titles[titles.length - 1].min = 0;
    return titles;
}

function normaliseDiscords(list) {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
        if (!isPlainObject(raw) || typeof raw.url !== 'string' || !/^https?:\/\/\S+$/i.test(raw.url.trim())) continue;
        out.push({ ...deepClone(raw), name: cleanText(raw.name, 'Discord'), url: raw.url.trim() });
    }
    return out;
}

// Full site config = defaults <- userConfig, every field sanitised.
// Idempotent: mergeConfig(mergeConfig(x)) deep-equals mergeConfig(x).
export function mergeConfig(userConfig) {
    const cfg = typedMerge(DEFAULT_CONFIG, isPlainObject(userConfig) ? userConfig : {});
    cfg.siteName = cleanText(cfg.siteName, DEFAULT_CONFIG.siteName);
    cfg.serverIp = cfg.serverIp.trim();
    const port = Math.round(cfg.serverPort);
    cfg.serverPort = port >= 1 && port <= 65535 ? port : DEFAULT_CONFIG.serverPort;
    if (!SKIN_MODES.includes(cfg.skins)) cfg.skins = 'auto';
    cfg.modes = normaliseModes(cfg.modes);
    cfg.regions = normaliseRegions(cfg.regions);
    cfg.points = normalisePoints(cfg.points);
    cfg.titles = normaliseTitles(cfg.titles);
    cfg.discords = normaliseDiscords(cfg.discords);
    return cfg;
}

function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const key of Object.keys(value)) deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}
