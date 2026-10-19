#!/usr/bin/env node
// Deterministic demo-data generator: same flags -> byte-identical output.
//   node scripts/seed.js [--seed pvp-events] [--now <ms|ISO|now>] [--games 110]
//                        [--players 650] [--out public/demo/games.json] [--pretty]
// --games counts ranked games; a few unranked ones are mixed in on top.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const SEED_DEFAULTS = Object.freeze({
    seed: 'pvp-events',
    now: Date.UTC(2026, 9, 18, 3, 40, 0), // fixed anchor so the committed file is reproducible
    games: 110,
    players: 650
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
    const rng = {
        next,
        float: (lo, hi) => lo + (hi - lo) * next(),
        int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
        chance: (p) => next() < p,
        pick: (arr) => arr[Math.floor(next() * arr.length)],
        weighted(entries) {
            // entries: [[value, weight], ...]
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
        gumbel: () => -Math.log(-Math.log(1 - next() * 0.999999 - 0.0000005)),
        shuffle(arr) {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(next() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
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
    return rng;
}

// ---------- names ----------

const ADJ = ['Frosty', 'Silent', 'Rapid', 'Lucky', 'Swift', 'Crimson', 'Shadow', 'Lunar', 'Solar', 'Mystic',
    'Rusty', 'Sneaky', 'Toxic', 'Turbo', 'Hyper', 'Cosmic', 'Pixel', 'Neon', 'Wild', 'Brave', 'Sly', 'Grim',
    'Icy', 'Blazing', 'Stormy', 'Quiet', 'Fuzzy', 'Salty', 'Spicy', 'Golden', 'Mossy', 'Dusty', 'Misty',
    'Amber', 'Velvet', 'Feral', 'Jolly', 'Sleepy', 'Grumpy', 'Clumsy', 'Epic', 'Mega', 'Ultra', 'Tiny', 'Lil',
    'Dark', 'Bright', 'Cyber', 'Retro', 'Noble', 'Royal', 'Vivid', 'Hollow', 'Phantom', 'Rogue', 'Savage',
    'Chill', 'Crispy', 'Soggy', 'Wobbly', 'Zesty', 'Lazy', 'Nimble', 'Arctic', 'Molten', 'Static', 'Atomic'];
const NOUN = ['Pickaxe', 'Creeper', 'Ender', 'Blaze', 'Golem', 'Fox', 'Wolf', 'Panda', 'Otter', 'Falcon',
    'Raven', 'Viper', 'Cobra', 'Tiger', 'Bear', 'Moose', 'Gecko', 'Badger', 'Ferret', 'Llama', 'Axolotl',
    'Phoenix', 'Dragon', 'Knight', 'Ninja', 'Pirate', 'Wizard', 'Ranger', 'Hunter', 'Archer', 'Miner',
    'Crafter', 'Builder', 'Slayer', 'Sniper', 'Bandit', 'Nomad', 'Titan', 'Sprout', 'Pebble', 'Cactus',
    'Melon', 'Cookie', 'Potato', 'Carrot', 'Taco', 'Waffle', 'Muffin', 'Noodle', 'Pickle', 'Biscuit',
    'Turtle', 'Comet', 'Meteor', 'Rocket', 'Storm', 'Blade', 'Arrow', 'Shield', 'Hammer', 'Anvil', 'Lantern',
    'Torch', 'Beacon', 'Prism', 'Quartz', 'Ruby', 'Onyx', 'Jade', 'Spud', 'Goose', 'Squid', 'Slime', 'Bee',
    'Frog', 'Yeti', 'Kraken', 'Mantis', 'Hornet', 'Lynx', 'Bison', 'Owl', 'Crow', 'Hawk', 'Shark', 'Koi'];
const SYL = ['ka', 'zu', 'mi', 'ro', 'vex', 'lo', 'ny', 'tri', 'ix', 'ar', 'el', 'on', 'qua', 'zy', 'ra',
    'fi', 'do', 'ven', 'kai', 'lux', 'zor', 'bel', 'mar', 'tes', 'ko', 'ri', 'sa', 'vo', 'xa', 'jin', 'pax',
    'rin', 'ola', 'um', 'ex', 'dra', 'ky', 'fen', 'gli', 'mo', 'nex', 'tal', 'yu', 'bri', 'cor', 'dex',
    'wyn', 'sol', 'tak', 'vi', 'zel', 'quo', 'har', 'lin', 'mox', 'pry', 'sk', 'th', 'fl', 'gr'];
const TAILS = ['_', '_x', 'x', '_mc', 'mc', '_pvp', 'pvp', 'HD', 'xd', 'z', '_v2', 'II', 'YT', 'TV', '_ttv', 'Plays', 'Gaming'];
const PREFIXES = ['its', 'Its', 'xX', 'Mr', 'Not', 'The', 'iAm', 'oG', 'Real', 'Sir', 'Big', 'only', 'just'];

function syllableWord(rng, min = 2, max = 3) {
    let w = '';
    const n = rng.int(min, max);
    for (let i = 0; i < n; i++) w += rng.pick(SYL);
    return w;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const digits = (rng) => rng.weighted([[String(rng.int(1, 9)), 2], [String(rng.int(10, 99)), 5],
    [String(rng.int(100, 999)), 2], [`0${rng.int(1, 9)}`, 1], [String(rng.int(1990, 2014)), 1]]);
const leet = (s, rng) => s.replace(/[aeiost]/gi, (c) => (rng.chance(0.45)
    ? { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' }[c.toLowerCase()] : c));

function makeName(rng) {
    const style = rng.weighted([
        ['adjNoun', 20], ['adjNounNum', 13], ['lowerSnake', 9], ['syllNum', 14], ['syllCap', 8],
        ['prefix', 10], ['tail', 9], ['leet', 5], ['xx', 3], ['nounNum', 6], ['lowerRun', 3]
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
    // Practically unreachable; keeps the generator total.
    let n = taken.size;
    while (taken.has(`player_${n}`)) n++;
    taken.add(`player_${n}`);
    return `player_${n}`;
}

// ---------- modes ----------

const MODES = {
    'battle-royale': {
        weight: 70,
        maps: ['cherry_grove', 'sunken_harbor', 'ember_canyon', 'frostpeak_village', 'mossy_ruins', 'coral_cove', 'amber_mesa', 'willow_marsh'],
        teamSizes: [[1, 42], [2, 33], [3, 10], [4, 15]],
        minutes: [14, 32],
        luck: 1.5
    },
    bedwars: {
        weight: 15,
        maps: ['lantern_isles', 'copperworks', 'candy_clouds', 'pagoda_peaks', 'rusty_rails'],
        teamSizes: [[1, 20], [2, 35], [3, 15], [4, 30]],
        minutes: [15, 30],
        luck: 1.25
    },
    skywars: {
        weight: 15,
        maps: ['floating_gardens', 'crystal_spires', 'windmill_isles', 'obsidian_reach', 'petal_drift'],
        teamSizes: [[1, 60], [2, 30], [4, 10]],
        minutes: [8, 16],
        luck: 1.6
    }
};
const TEAM_COUNTS = { 1: [18, 45], 2: [14, 28], 3: [12, 18], 4: [12, 15] };

// ---------- generator ----------

export function generate(options = {}) {
    const opts = { ...SEED_DEFAULTS, ...options };
    const G = Math.max(1, Math.floor(opts.games));
    const N = Math.max(4, Math.floor(opts.players));
    const rng = createRng(`${opts.seed}|${G}|${N}`);

    // 1. Game skeletons, newest first, then reversed to chronological.
    const unrankedCount = Math.max(0, Math.round(G * 0.035));
    const total = G + unrankedCount;
    const unrankedAt = new Set();
    while (unrankedAt.size < unrankedCount) unrankedAt.add(rng.int(1, Math.max(1, total - 2)));
    const skeletons = [];
    let cursor = Math.round(opts.now);
    let sessionLeft = rng.int(4, 8);
    for (let i = 0; i < total; i++) {
        const modeKey = rng.weighted(Object.entries(MODES).map(([k, m]) => [k, m.weight]));
        const mode = MODES[modeKey];
        const teamSize = rng.weighted(mode.teamSizes);
        const [tLo, tHi] = TEAM_COUNTS[teamSize];
        const duration = Math.round(rng.float(mode.minutes[0], mode.minutes[1]) * MIN + rng.int(0, 999));
        const endedAt = cursor;
        const startedAt = endedAt - duration;
        skeletons.push({
            mode: modeKey, map: rng.pick(mode.maps), teamSize, teamCount: rng.int(tLo, tHi),
            startedAt, endedAt, ranked: !unrankedAt.has(total - 1 - i), luck: mode.luck
        });
        if (--sessionLeft > 0) {
            cursor = startedAt - rng.int(3 * MIN, 9 * MIN) - rng.int(0, 59999);
        } else {
            cursor = startedAt - rng.int(15 * HOUR, 22 * HOUR) - rng.int(0, 59 * MIN);
            const day = new Date(cursor).getUTCDay(); // Sat/Sun/Mon UTC ~ weekend evenings in NA
            sessionLeft = day === 6 || day === 0 || day === 1 ? rng.int(7, 11) : rng.int(4, 8);
        }
    }
    skeletons.reverse();
    const rankedGames = skeletons.filter((s) => s.ranked);
    const slots = rankedGames.reduce((sum, s) => sum + s.teamCount * s.teamSize, 0);

    // 2. Players with a long-tail participation target, an active window and hidden skill.
    const taken = new Set();
    const players = [];
    for (let i = 0; i < N; i++) {
        players.push({
            uuid: rng.uuid(),
            name: uniqueName(rng, taken),
            r: Math.pow(1 - rng.next() * 0.9995, -1 / 1.15), // Pareto weight
            target: 0, used: 0, a: 0, b: G - 1, skill: 0, oldName: null, renameAt: -1
        });
    }
    const capGames = Math.max(1, Math.round(G * 0.88));
    const countAt = (scale) => players.reduce((sum, p) => sum + Math.min(capGames, Math.max(1, Math.round(p.r * scale))), 0);
    let lo = 0.01;
    let hi = 200;
    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (countAt(mid) > slots) hi = mid;
        else lo = mid;
    }
    for (const p of players) {
        p.target = Math.min(capGames, Math.max(1, Math.round(p.r * lo)));
        const heavy = p.target / capGames;
        p.skill = rng.normal() * 0.7 + heavy * 0.6 - 0.15;
        if (p.target >= G * 0.35 && rng.chance(0.75)) {
            p.a = 0;
            p.b = G - 1;
        } else {
            const len = Math.min(G, Math.max(p.target, Math.ceil(p.target * rng.float(1.3, 4)) + rng.int(0, 25)));
            p.a = rng.int(0, G - len);
            p.b = p.a + len - 1;
        }
        if (rng.chance(0.015)) {
            p.oldName = uniqueName(rng, taken);
            p.renameAt = rng.int(p.a, p.b);
        }
    }

    // 3. Rosters: weighted sampling without replacement (Efraimidis-Spirakis),
    //    weight = remaining quota / games left in the player's window.
    const rosterFor = (gi, size, ranked) => {
        const scored = [];
        for (const p of players) {
            let w;
            if (ranked) {
                const inWindow = gi >= p.a && gi <= p.b;
                const rem = p.target - p.used;
                w = inWindow && rem > 0 ? rem / (p.b - gi + 1) : inWindow ? 0.002 : 0.0001;
            } else {
                w = 0.2 + p.target / capGames;
            }
            scored.push([Math.log(1 - rng.next() * 0.999999) / w, p]);
        }
        scored.sort((x, y) => y[0] - x[0]);
        return scored.slice(0, Math.min(size, players.length)).map(([, p]) => p);
    };
    let gi = 0;
    for (const s of skeletons) {
        s.rankedIndex = s.ranked ? gi : -1;
        s.roster = rosterFor(s.ranked ? gi : Math.max(0, gi - 1), s.teamCount * s.teamSize, s.ranked);
        if (s.ranked) {
            for (const p of s.roster) p.used++;
            gi++;
        }
    }
    // Everyone should appear in at least one ranked game: swap idle players in for busy ones.
    const busiest = () => players.reduce((best, p) => (p.used > best.used ? p : best), players[0]);
    for (const p of players) {
        if (p.used > 0) continue;
        const donor = busiest();
        if (donor.used <= 1) break;
        const candidates = rankedGames.filter((s) => s.roster.includes(donor) && !s.roster.includes(p));
        if (!candidates.length) continue;
        const inWindow = candidates.filter((s) => s.rankedIndex >= p.a && s.rankedIndex <= p.b);
        const game = rng.pick(inWindow.length ? inWindow : candidates);
        game.roster[game.roster.indexOf(donor)] = p;
        donor.used--;
        p.used++;
    }

    // 4. Play each game out.
    return skeletons.map((s, index) => simulate(rng, s, index + 1));
}

const half = (n) => Math.round(n * 2) / 2;

function simulate(rng, s, number) {
    const roster = rng.shuffle([...s.roster]);
    const teams = [];
    for (let t = 0; t * s.teamSize < roster.length; t++) {
        const members = roster.slice(t * s.teamSize, (t + 1) * s.teamSize);
        const avg = members.reduce((sum, p) => sum + p.skill, 0) / members.length;
        const top = Math.max(...members.map((p) => p.skill));
        teams.push({ members, perf: avg * 0.7 + top * 0.3 + rng.gumbel() * s.luck });
    }
    teams.sort((a, b) => b.perf - a.perf);
    const T = teams.length;
    const duration = s.endedAt - s.startedAt;

    // Elimination times: many early knockouts, the runner-up falls right at the end.
    const times = [];
    for (let i = 0; i < T - 1; i++) times.push(Math.pow(rng.next(), 1.5));
    times.sort((a, b) => b - a);
    teams.forEach((team, i) => {
        team.placement = i + 1;
        if (i === 0) team.eliminatedAt = null;
        else if (i === 1) team.eliminatedAt = s.endedAt - rng.int(40, 2500);
        else team.eliminatedAt = Math.min(teams[i - 1].eliminatedAt - rng.int(50, 4000),
            Math.round(s.startedAt + 25000 + (duration - 60000) * times[i - 1]));
        if (team.eliminatedAt !== null) team.eliminatedAt = Math.max(s.startedAt + 5000, team.eliminatedAt);
    });

    const stats = new Map(); // player -> { kills, deaths, damage }
    for (const team of teams) for (const p of team.members) stats.set(p, { kills: 0, deaths: 0, damage: 0 });
    const aliveAt = (t, excludeTeam) => {
        const out = [];
        for (const team of teams) {
            if (team === excludeTeam) continue;
            if (team.eliminatedAt === null || team.eliminatedAt > t) out.push(...team.members);
        }
        return out;
    };
    const credit = (victimTeam, t) => {
        if (!rng.chance(0.84)) return; // fall damage, void, the border...
        const candidates = aliveAt(t, victimTeam);
        if (!candidates.length) return;
        const weights = candidates.map((p) => Math.exp(0.8 * p.skill));
        let r = rng.next() * weights.reduce((a, b) => a + b, 0);
        for (let i = 0; i < candidates.length; i++) {
            r -= weights[i];
            if (r < 0) {
                stats.get(candidates[i]).kills++;
                return;
            }
        }
        stats.get(candidates[candidates.length - 1]).kills++;
    };

    for (const team of teams) {
        const out = team.eliminatedAt ?? s.endedAt;
        team.members.forEach((p, mi) => {
            const st = stats.get(p);
            if (s.mode === 'bedwars') {
                // Respawn deaths before the bed goes.
                const respawns = rng.weighted([[0, 3], [1, 4], [2, 3], [3, 2], [4, 1]]);
                for (let k = 0; k < respawns; k++) {
                    const t = s.startedAt + rng.next() * (out - s.startedAt);
                    st.deaths++;
                    credit(team, t);
                }
            }
            const dies = team.placement > 1 || (mi > 0 && rng.chance(0.25));
            if (dies) {
                const t = team.placement > 1 ? out - rng.int(0, 20000) : s.startedAt + rng.next() * duration;
                st.deaths++;
                credit(team, t);
            }
        });
    }

    const outTeams = teams.map((team) => {
        const alive = ((team.eliminatedAt ?? s.endedAt) - s.startedAt) / duration;
        return {
            placement: team.placement,
            eliminatedAt: team.eliminatedAt,
            players: team.members.map((p) => {
                const st = stats.get(p);
                const damage = half(st.kills * rng.float(4, 8.5) + alive * rng.float(1, 12) + rng.float(0, 3));
                const renamed = p.oldName && s.rankedIndex >= 0 && s.rankedIndex < p.renameAt;
                return { uuid: p.uuid, name: renamed ? p.oldName : p.name, kills: st.kills, deaths: st.deaths, damage };
            })
        };
    });

    const game = {
        number,
        mode: s.mode,
        map: s.map,
        teamSize: s.teamSize,
        startedAt: s.startedAt,
        endedAt: s.endedAt
    };
    if (!s.ranked) game.ranked = false;
    game.teams = outTeams;
    return game;
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

function parseNow(value) {
    if (value === undefined) return SEED_DEFAULTS.now;
    if (value === 'now') return Date.now();
    if (/^\d+$/.test(value)) return Number(value);
    const t = Date.parse(value);
    if (!Number.isFinite(t)) throw new Error(`--now must be epoch ms, an ISO date or "now" (got "${value}")`);
    return t;
}

function positiveInt(value, fallback, name) {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer (got "${value}")`);
    return n;
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
        if (args.help) {
            console.log('Usage: node scripts/seed.js [--seed s] [--now ms|ISO|now] [--games n] [--players n] [--out file] [--pretty]');
            return;
        }
        args.now = parseNow(args.now);
        args.games = positiveInt(args.games, SEED_DEFAULTS.games, 'games');
        args.players = positiveInt(args.players, SEED_DEFAULTS.players, 'players');
        if (args.players < 4) throw new Error('--players must be at least 4');
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    const games = generate({ seed: args.seed ?? SEED_DEFAULTS.seed, now: args.now, games: args.games, players: args.players });
    const out = path.resolve(args.out ? process.cwd() : ROOT, args.out || 'public/demo/games.json');
    const json = args.pretty ? `${JSON.stringify(games, null, 2)}\n` : JSON.stringify(games);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, json);
    const ranked = games.filter((g) => g.ranked !== false);
    const uuids = new Set(ranked.flatMap((g) => g.teams.flatMap((t) => t.players.map((p) => p.uuid))));
    const first = new Date(games[0].startedAt).toISOString();
    const last = new Date(games[games.length - 1].endedAt).toISOString();
    console.log(`Wrote ${games.length} games (${ranked.length} ranked), ${uuids.size} players, ${(json.length / 1024).toFixed(0)} KB -> ${out}`);
    console.log(`  ${first} .. ${last}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
