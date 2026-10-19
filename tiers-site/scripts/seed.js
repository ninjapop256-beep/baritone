#!/usr/bin/env node
// Deterministic demo-data generator: same flags -> byte-identical output.
//   node scripts/seed.js [--seed blocktiers] [--now <ms|ISO|now>] [--players 1600]
//                        [--out public/demo/tests.json] [--events-out public/demo/events.json] [--pretty]
// Writes a tier-test log (one record per test, oldest first) and a list of events.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG } from '../public/js/shared/defaults.js';
import { tierFromScore } from '../public/js/shared/tiers.js';
import { DEMO_LAG_MS } from '../public/js/shared/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const SEED_DEFAULTS = Object.freeze({
    seed: 'blocktiers',
    now: Date.UTC(2026, 9, 18, 18, 0, 0), // fixed anchor so the committed files are reproducible
    players: 1600
});

// ---------- PRNG (cyrb128 seed hash + sfc32) ----------

function cyrb128(str) {
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
        const k = str.charCodeAt(i);
        h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
        h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
        h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
        h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4;
    h2 ^= h1;
    h3 ^= h1;
    h4 ^= h1;
    return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export function createRng(seed) {
    let [a, b, c, d] = cyrb128(String(seed));
    const next = () => {
        a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
        let t = (a + b) | 0;
        a = b ^ (b >>> 9);
        b = (c + (c << 3)) | 0;
        c = (c << 21) | (c >>> 11);
        d = (d + 1) | 0;
        t = (t + d) | 0;
        c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 16; i++) next();
    return {
        next,
        float: (lo, hi) => lo + (hi - lo) * next(),
        int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
        chance: (p) => next() < p,
        pick: (arr) => arr[Math.floor(next() * arr.length)],
        weighted(entries) {
            let total = 0;
            for (const [, w] of entries) total += w;
            let r = next() * total;
            for (const [v, w] of entries) {
                r -= w;
                if (r < 0) return v;
            }
            return entries[entries.length - 1][0];
        },
        normal() {
            const u = 1 - next();
            const v = next();
            return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        },
        uuid() {
            let hex = '';
            for (let i = 0; i < 32; i++) {
                let n = Math.floor(next() * 16);
                if (i === 12) n = 4; // version 4
                if (i === 16) n = 8 + (n & 3); // variant 10xx
                hex += n.toString(16);
            }
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
    };
}

// ---------- names (procedural, original) ----------

const ADJ = ['Frosty', 'Silent', 'Rapid', 'Lucky', 'Swift', 'Crimson', 'Shadow', 'Lunar', 'Solar', 'Mystic',
    'Rusty', 'Sneaky', 'Toxic', 'Turbo', 'Hyper', 'Cosmic', 'Pixel', 'Neon', 'Wild', 'Brave', 'Sly', 'Grim',
    'Icy', 'Blazing', 'Stormy', 'Quiet', 'Fuzzy', 'Salty', 'Spicy', 'Golden', 'Mossy', 'Dusty', 'Misty',
    'Amber', 'Velvet', 'Feral', 'Jolly', 'Sleepy', 'Grumpy', 'Clumsy', 'Epic', 'Mega', 'Ultra', 'Tiny', 'Lil',
    'Dark', 'Bright', 'Cyber', 'Retro', 'Noble', 'Royal', 'Vivid', 'Hollow', 'Phantom', 'Rogue', 'Savage',
    'Chill', 'Crispy', 'Soggy', 'Wobbly', 'Zesty', 'Lazy', 'Nimble', 'Arctic', 'Molten', 'Static', 'Atomic',
    'Sharp', 'Steady', 'Clutch', 'Combo', 'Crit', 'Quick', 'Heavy', 'Low', 'Lone', 'Sweaty'];
const NOUN = ['Pickaxe', 'Creeper', 'Ender', 'Blaze', 'Golem', 'Fox', 'Wolf', 'Panda', 'Otter', 'Falcon',
    'Raven', 'Viper', 'Cobra', 'Tiger', 'Bear', 'Moose', 'Gecko', 'Badger', 'Ferret', 'Llama', 'Axolotl',
    'Phoenix', 'Dragon', 'Knight', 'Ninja', 'Pirate', 'Wizard', 'Ranger', 'Hunter', 'Archer', 'Miner',
    'Crafter', 'Builder', 'Slayer', 'Sniper', 'Bandit', 'Nomad', 'Titan', 'Sprout', 'Pebble', 'Cactus',
    'Melon', 'Cookie', 'Potato', 'Carrot', 'Taco', 'Waffle', 'Muffin', 'Noodle', 'Pickle', 'Biscuit',
    'Turtle', 'Comet', 'Meteor', 'Rocket', 'Storm', 'Blade', 'Arrow', 'Shield', 'Hammer', 'Anvil', 'Lantern',
    'Torch', 'Beacon', 'Prism', 'Quartz', 'Ruby', 'Onyx', 'Jade', 'Spud', 'Goose', 'Squid', 'Slime', 'Bee',
    'Frog', 'Yeti', 'Kraken', 'Mantis', 'Hornet', 'Lynx', 'Bison', 'Owl', 'Crow', 'Hawk', 'Shark', 'Koi',
    'Totem', 'Pearl', 'Crystal', 'Anchor', 'Trident', 'Elytra', 'Potion', 'Apple', 'Rod', 'Strafe', 'Combo'];
const SYL = ['ka', 'zu', 'mi', 'ro', 'vex', 'lo', 'ny', 'tri', 'ix', 'ar', 'el', 'on', 'qua', 'zy', 'ra',
    'fi', 'do', 'ven', 'kai', 'lux', 'zor', 'bel', 'mar', 'tes', 'ko', 'ri', 'sa', 'vo', 'xa', 'jin', 'pax',
    'rin', 'ola', 'um', 'ex', 'dra', 'ky', 'fen', 'gli', 'mo', 'nex', 'tal', 'yu', 'bri', 'cor', 'dex',
    'wyn', 'sol', 'tak', 'vi', 'zel', 'quo', 'har', 'lin', 'mox', 'pry', 'sk', 'th', 'fl', 'gr'];
const TAILS = ['_', '_x', 'x', '_mc', 'mc', '_pvp', 'pvp', 'HD', 'xd', 'z', '_v2', 'II', 'YT', 'TV', '_ttv', 'Plays', 'Gaming'];
const PREFIXES = ['its', 'Its', 'xX', 'Mr', 'Not', 'The', 'iAm', 'oG', 'Real', 'Sir', 'Big', 'only', 'just'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const digits = (rng) => rng.weighted([[String(rng.int(1, 9)), 2], [String(rng.int(10, 99)), 5],
    [String(rng.int(100, 999)), 2], [`0${rng.int(1, 9)}`, 1], [String(rng.int(1990, 2014)), 1]]);
const leet = (s, rng) => s.replace(/[aeiost]/gi, (c) => (rng.chance(0.45)
    ? { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' }[c.toLowerCase()] : c));

function syllableWord(rng, min = 2, max = 3) {
    let w = '';
    const n = rng.int(min, max);
    for (let i = 0; i < n; i++) w += rng.pick(SYL);
    return w;
}

function makeName(rng) {
    const style = rng.weighted([
        ['adjNoun', 20], ['adjNounNum', 12], ['lowerSnake', 9], ['syllNum', 14], ['syllCap', 10],
        ['prefix', 10], ['tail', 9], ['leet', 5], ['xx', 2], ['nounNum', 6], ['lowerRun', 3]
    ]);
    const adj = rng.pick(ADJ);
    const noun = rng.pick(NOUN);
    switch (style) {
        case 'adjNoun': return adj + noun;
        case 'adjNounNum': return adj + noun + digits(rng);
        case 'lowerSnake': return `${adj.toLowerCase()}_${noun.toLowerCase()}${rng.chance(0.3) ? `_${rng.int(1, 99)}` : ''}`;
        case 'syllNum': return syllableWord(rng) + digits(rng);
        case 'syllCap': return cap(syllableWord(rng, 2, 4));
        case 'prefix': return rng.pick(PREFIXES) + (rng.chance(0.5) ? noun : cap(syllableWord(rng, 2, 3)));
        case 'tail': return (rng.chance(0.5) ? noun : cap(syllableWord(rng, 2, 3))) + rng.pick(TAILS);
        case 'leet': return leet(adj + noun, rng);
        case 'xx': return `xX${rng.chance(0.5) ? noun : adj}Xx`;
        case 'nounNum': return noun.toLowerCase() + digits(rng);
        default: return syllableWord(rng, 3, 4) + rng.pick(['', 'x', 'z', '_']);
    }
}

function uniqueName(rng, taken) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const name = makeName(rng);
        if (name.length >= 3 && name.length <= 16 && /^[A-Za-z0-9_]+$/.test(name) && !taken.has(name.toLowerCase())) {
            taken.add(name.toLowerCase());
            return name;
        }
    }
    let n = taken.size; // practically unreachable; keeps the generator total
    while (taken.has(`player_${n}`)) n++;
    taken.add(`player_${n}`);
    return `player_${n}`;
}

// ---------- distributions ----------

const REGION_WEIGHTS = [['NA', 40], ['EU', 38], ['SA', 7], ['AS', 7], ['OCE', 4], ['ME', 3], ['AF', 1]];
// How popular each gamemode is for testing (how many players get a tier in it).
const MODE_WEIGHTS = { sword: 16, vanilla: 14, pot: 12, uhc: 12, smp: 11, axe: 10, mace: 9, nethop: 8 };
const MODE_COUNT_WEIGHTS = [[1, 30], [2, 22], [3, 16], [4, 11], [5, 8], [6, 6], [7, 4], [8, 3]];
// Share of all (player, mode) tiers per tier, best first: a steep pyramid.
const TIER_SHARE = [0.012, 0.048, 0.14, 0.3];
const HIGH_SHARE = 0.38; // the top 38% inside each tier are High (HT)

// Tier score ladder: LT5 = 2 ... HT1 = 11 (see tierScore).
function finalScore(rank, total) {
    const q = rank / total;
    let lo = 0;
    for (let i = 0; i < TIER_SHARE.length; i++) {
        const hi = lo + TIER_SHARE[i];
        if (q < hi) return { tier: i + 1, high: (q - lo) / TIER_SHARE[i] < HIGH_SHARE };
        lo = hi;
    }
    return { tier: 5, high: (q - lo) / (1 - lo) < HIGH_SHARE * 0.9 };
}

const scoreOf = (t) => (6 - t.tier) * 2 + (t.high ? 1 : 0);

function pickModes(rng, count) {
    const pool = Object.entries(MODE_WEIGHTS);
    const out = [];
    while (out.length < count && pool.length) {
        const mode = rng.weighted(pool);
        out.push(mode);
        pool.splice(pool.findIndex(([m]) => m === mode), 1);
    }
    return out;
}

// ---------- generator ----------

export function generate(options = {}) {
    const opts = { ...SEED_DEFAULTS, ...options };
    const N = Math.max(2, Math.floor(opts.players));
    const anchor = Math.round(opts.now);
    const latest = anchor - DEMO_LAG_MS; // newest test
    const rng = createRng(`${opts.seed}|${N}`);
    const knownModes = new Set(DEFAULT_CONFIG.modes.map((m) => m.id));

    // 1. Testers: a small staff, a few of them doing most of the work.
    const taken = new Set();
    const testers = [];
    for (let i = 0; i < 40; i++) testers.push([uniqueName(rng, taken), Math.pow(rng.float(0.15, 1), 2.2)]);

    // 2. Players: region, hidden skill, how many modes they got tested in, when they started.
    const players = [];
    for (let i = 0; i < N; i++) {
        const skill = rng.normal();
        let count = rng.weighted(MODE_COUNT_WEIGHTS);
        if (skill > 1.6) count += 2;
        else if (skill > 0.9) count += 1;
        players.push({
            uuid: rng.uuid(),
            name: uniqueName(rng, taken),
            region: rng.weighted(REGION_WEIGHTS),
            skill,
            modes: pickModes(rng, Math.min(8, count)).filter((m) => knownModes.has(m)),
            start: latest - Math.round(Math.pow(rng.next(), 0.8) * 300 * DAY),
            oldName: null,
            renameAt: 0
        });
    }
    for (const p of players) {
        if (rng.chance(0.02)) {
            p.oldName = uniqueName(rng, taken);
            p.renameAt = p.start + Math.round(rng.float(0.2, 0.9) * (latest - p.start));
        }
    }

    // 3. Final tier for every (player, mode): skill-correlated across modes, ranked into the pyramid.
    const pairs = [];
    for (const p of players) {
        for (const mode of p.modes) pairs.push({ p, mode, s: p.skill * 0.8 + rng.normal() * 0.55 });
    }
    pairs.sort((a, b) => b.s - a.s);
    pairs.forEach((pair, i) => { pair.final = finalScore(i, pairs.length); });

    // 4. Test history per pair: 1-3 tests climbing to the final tier (sometimes a drop at the end).
    const records = [];
    const testerOf = () => rng.weighted(testers);
    for (const pair of pairs) {
        const { p, mode, final } = pair;
        const fs = scoreOf(final);
        const k = rng.weighted(final.tier <= 2 ? [[1, 2], [2, 4], [3, 4]] : final.tier === 3 ? [[1, 4], [2, 4], [3, 2]] : [[1, 6], [2, 3], [3, 1]]);
        const scores = [fs];
        const dropped = k > 1 && fs < 11 && rng.chance(0.08);
        for (let j = 1; j < k; j++) {
            const later = scores[0];
            scores.unshift(j === 1 && dropped ? later + 1 : Math.max(2, later - rng.int(1, 3)));
        }
        // times: first test somewhere after the player's start, re-tests 1-8 weeks apart
        const span = latest - p.start;
        let t = p.start + Math.round(rng.next() * span * 0.75);
        const times = [];
        for (let j = 0; j < scores.length; j++) {
            times.push(Math.min(latest - rng.int(1, 600) * 60000, t));
            t += rng.int(7, 56) * DAY + rng.int(0, 23) * HOUR;
        }
        const retired = rng.chance(final.tier <= 3 ? 0.06 : 0.02);
        scores.forEach((score, j) => {
            const { tier, high } = tierFromScore(score);
            const at = times[j] - (times[j] % 60000) + rng.int(0, 59999);
            const name = p.oldName && at < p.renameAt ? p.oldName : p.name;
            const rec = { uuid: p.uuid, name, region: p.region, mode, tier, high, at, tester: testerOf()[0] };
            if (retired && j === scores.length - 1) rec.retired = true;
            records.push(rec);
        });
        // A handful of tiers were taken away again (staff decision): a clearing record.
        if (rng.chance(0.002)) {
            const at = Math.min(latest - 60000, times[times.length - 1] + rng.int(3, 20) * DAY);
            records.push({ uuid: p.uuid, name: p.name, region: p.region, mode, tier: 0, high: false, at, tester: testerOf()[0] });
        }
    }

    // 5. Chronological ids; the newest test lands exactly DEMO_LAG_MS before the anchor.
    records.sort((a, b) => a.at - b.at || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0) || (a.mode < b.mode ? -1 : 1));
    if (records.length) records[records.length - 1].at = latest;
    const tests = records.map((r, i) => {
        const out = { id: i + 1, uuid: r.uuid, name: r.name, region: r.region, mode: r.mode, tier: r.tier, high: r.high };
        if (r.retired) out.retired = true;
        out.at = r.at;
        out.tester = r.tester;
        return out;
    });

    return { tests, events: makeEvents(anchor) };
}

// ---------- events (original copy) ----------

function at(anchor, days, hourUtc) {
    const d = new Date(anchor + days * DAY);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 0, 0);
}

const EVENT_TEMPLATES = [
    {
        days: 2, hour: 23, hours: 3, slug: 'sword-sprint-cup', title: 'Sword Sprint Cup', mode: 'sword', format: '1v1', region: 'NA',
        maxPlayers: 64, prize: 'Champion role + tier re-test priority', host: 'Tournament staff',
        description: 'A quick single-elimination bracket for sword players of every tier. Show up, warm up, and see how far your spacing carries you.\n\nMatches are best of three until the quarterfinals and best of five from there on.\n\nKits are provided on the event server: full diamond armor and a diamond sword, no enchantments.\n\nCheck in on Discord at least 15 minutes before the start or your slot goes to the waitlist.\n\nNo-shows after five minutes forfeit the match.'
    },
    {
        days: 4, hour: 18, hours: 4, slug: 'crystal-clash-open', title: 'Crystal Clash Open', mode: 'vanilla', format: '1v1', region: 'EU',
        maxPlayers: 128, prize: 'Custom cape design + 3 months of supporter rank', host: 'Tournament staff',
        description: 'Our biggest Vanilla bracket of the season. End crystals, respawn anchors and full netherite, exactly like a tier test.\n\nDouble elimination: lose once and you drop to the lower bracket.\n\nAll rounds are first to two; the grand final is first to three.\n\nTotems are limited to the kit amount. Bringing extra items into a match means a forfeit.\n\nSpectators are welcome in the lobby; streaming with a two-minute delay is allowed.'
    },
    {
        days: 8, hour: 20, hours: 3, slug: 'duo-uhc-night', title: 'Duo UHC Night', mode: 'uhc', format: '2v2', region: 'EU',
        maxPlayers: 48, prize: 'Event winner tag for both players', host: 'Community team',
        description: 'Grab a partner for an evening of 2v2 UHC: no natural regeneration, golden apples only.\n\nTeams register together; one player signs up for both.\n\nEach round is a single game on a fresh arena. Lava buckets and rods are part of the kit.\n\nCross-teaming with other duos gets both teams removed.\n\nThe final four teams play a best-of-three.'
    },
    {
        days: 13, hour: 1, hours: 2, slug: 'mace-mayhem-ffa', title: 'Mace Mayhem FFA', mode: 'mace', format: 'FFA', region: 'NA',
        maxPlayers: 40, prize: 'Golden mace trophy in the lobby hall of fame', host: 'Community team',
        description: 'Forty players, one arena, plenty of wind charges. The last one standing takes the round.\n\nThree rounds are played. Points come from placement and eliminations; the best total wins.\n\nElytra and wind charges are included in the kit. Bring your own nerve.\n\nTeaming in a free-for-all is not allowed and will be checked on the recordings.'
    },
    {
        days: 21, hour: 9, hours: 3, slug: 'pacific-pot-series', title: 'Pacific Pot Series', mode: 'pot', format: '1v1', region: 'OCE',
        maxPlayers: 32, prize: 'Featured spot on the home page for a month', host: 'Regional staff',
        description: 'A Pot bracket scheduled for players in Oceania and Asia, so nobody has to play at four in the morning.\n\nSingle elimination, first to two, splash healing potions and diamond gear.\n\nLatency matters: the event runs on our Sydney proxy.\n\nPlayers outside the region may join if slots are left one hour before the start.'
    },
    {
        days: 34, hour: 19, hours: 5, slug: 'all-modes-gauntlet', title: 'All-Modes Gauntlet', mode: 'smp', format: '1v1', region: 'Global',
        maxPlayers: 64, prize: 'Gauntlet title on your profile + custom kill effect', host: 'Tournament staff',
        description: 'One bracket, many kits. Every round is played in a different gamemode, drawn live on stream.\n\nThe opening round is always SMP; later rounds can be any of the eight tested modes.\n\nMatches are first to two. A tie-breaker game is played in Sword.\n\nYou need a tier in at least three gamemodes to enter.\n\nSign-ups close 24 hours before the start.'
    },
    {
        days: -2, hour: 22, hours: 3, slug: 'axe-and-shield-showdown', title: 'Axe & Shield Showdown', mode: 'axe', format: '1v1', region: 'NA',
        maxPlayers: 32, prize: 'Showdown winner role', host: 'Community team',
        description: 'A bracket all about shield timing: break the guard, land the follow-up.\n\nSingle elimination, first to three.\n\nKits use netherite axes, shields and iron armor.\n\nThe top four were invited to a free re-test in Axe.'
    },
    {
        days: -9, hour: 18, hours: 4, slug: 'nether-kings-cup', title: 'Nether Kings Cup', mode: 'nethop', format: '1v1', region: 'EU',
        maxPlayers: 64, prize: 'Netherite crown cosmetic', host: 'Tournament staff',
        description: 'Overpowered netherite kits with debuff potions: long fights, big comebacks.\n\nDouble elimination, first to two.\n\nSlowness and weakness splash potions are part of the kit; bringing extra potions is a forfeit.\n\nThe grand final went the full five games.'
    },
    {
        days: -18, hour: 23, hours: 3, slug: 'sword-sprint-qualifier', title: 'Sword Sprint Qualifier', mode: 'sword', format: '1v1', region: 'NA',
        maxPlayers: 128, prize: 'Seeded slot in the Sword Sprint Cup', host: 'Tournament staff',
        description: 'The qualifier for this season\'s Sword Sprint Cup.\n\nSwiss format: five rounds, everyone plays every round.\n\nPlayers with four or more wins earned a seeded spot in the cup.'
    },
    {
        days: -30, hour: 20, hours: 4, slug: 'smp-survival-league', title: 'SMP Survival League', mode: 'smp', format: '2v2', region: 'EU',
        maxPlayers: 32, prize: 'League champion banner', host: 'Community team',
        description: 'A league night with survival-style kits: totems, ender pearls and shields.\n\nTeams of two played a round robin in groups, then a short knockout stage.\n\nPearl cooldowns and totem counts followed our standard SMP test kit.'
    },
    {
        days: -47, hour: 0, hours: 3, slug: 'latin-crystal-league', title: 'Latin Crystal League', mode: 'vanilla', format: '1v1', region: 'SA',
        maxPlayers: 32, prize: 'Regional champion role', host: 'Regional staff',
        description: 'A Vanilla bracket hosted on our São Paulo proxy for players in South America.\n\nSingle elimination, first to two, the final first to three.\n\nCommentary was in Portuguese and Spanish.'
    },
    {
        days: -75, hour: 19, hours: 2, slug: 'season-opener-ffa', title: 'Season Opener FFA', mode: 'uhc', format: 'FFA', region: 'Global',
        maxPlayers: 60, prize: 'Opener badge on your profile', host: 'Tournament staff',
        description: 'The free-for-all that kicked off the season: sixty players, one shrinking UHC arena.\n\nNo natural regeneration; golden apples and heads only.\n\nThe border started closing after ten minutes.'
    }
];

function makeEvents(anchor) {
    return EVENT_TEMPLATES.map((t) => {
        const startsAt = at(anchor, t.days, t.hour);
        const event = { slug: t.slug, title: t.title, mode: t.mode, format: t.format, region: t.region, startsAt };
        if (t.hours) event.endsAt = startsAt + t.hours * HOUR;
        event.description = t.description;
        if (t.maxPlayers) event.maxPlayers = t.maxPlayers;
        if (t.prize) event.prize = t.prize;
        if (t.host) event.host = t.host;
        return event;
    }).sort((a, b) => a.startsAt - b.startsAt);
}

// ---------- CLI ----------

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
        const eq = arg.indexOf('=');
        const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
        if (key === 'pretty' || key === 'help') {
            out[key] = true;
            continue;
        }
        const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
        if (value === undefined) throw new Error(`Missing value for --${key}`);
        out[key] = value;
    }
    return out;
}

export function parseNow(value) {
    if (value === undefined) return SEED_DEFAULTS.now;
    if (value === 'now') return Date.now();
    if (/^\d+$/.test(value)) return Number(value);
    const t = Date.parse(value);
    if (!Number.isFinite(t)) throw new Error(`--now must be epoch ms, an ISO date or "now" (got "${value}")`);
    return t;
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
        if (args.help) {
            console.log('Usage: node scripts/seed.js [--seed s] [--now ms|ISO|now] [--players n] [--out tests.json] [--events-out events.json] [--pretty]');
            return;
        }
        args.now = parseNow(args.now);
        if (args.players !== undefined) {
            const n = Number(args.players);
            if (!Number.isInteger(n) || n < 2) throw new Error(`--players must be an integer >= 2 (got "${args.players}")`);
            args.players = n;
        }
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    const { tests, events } = generate({ seed: args.seed ?? SEED_DEFAULTS.seed, now: args.now, players: args.players ?? SEED_DEFAULTS.players });
    const testsOut = args.out ? path.resolve(process.cwd(), args.out) : path.join(ROOT, 'public/demo/tests.json');
    const eventsOut = args['events-out'] ? path.resolve(process.cwd(), args['events-out']) : path.join(ROOT, 'public/demo/events.json');
    const testsJson = args.pretty ? `${JSON.stringify(tests, null, 2)}\n` : `${JSON.stringify(tests)}\n`;
    const eventsJson = `${JSON.stringify(events, null, 2)}\n`;
    await mkdir(path.dirname(testsOut), { recursive: true });
    await mkdir(path.dirname(eventsOut), { recursive: true });
    await writeFile(testsOut, testsJson);
    await writeFile(eventsOut, eventsJson);
    const uuids = new Set(tests.map((t) => t.uuid));
    const upcoming = events.filter((e) => e.startsAt > args.now).length;
    console.log(`Wrote ${tests.length} tests for ${uuids.size} players, ${(testsJson.length / 1024).toFixed(0)} KB -> ${testsOut}`);
    console.log(`Wrote ${events.length} events (${upcoming} after ${new Date(args.now).toISOString()}) -> ${eventsOut}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
