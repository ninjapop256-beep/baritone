import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, deepMerge, mergeConfig } from '../public/js/shared/defaults.js';
import {
    buildLeague, comparePlayers, hypeChangeFor, normalizeUuid, placementPoints, shiftTimestamps
} from '../public/js/shared/league.js';
import { MIN, T0, makeGame, randomGames, range, rng, soloGame, uuidFor } from './helpers.js';

const P = (league, i) => league.players.get(uuidFor(i));
const entryFor = (league, i, number) => {
    const game = league.gameByNumber.get(number);
    for (const team of game.teams) for (const p of team.players) if (p.uuid === uuidFor(i)) return { ...p, placement: team.placement };
    return null;
};

test('normalizeUuid accepts dashed/undashed/any case and rejects junk', () => {
    const want = '519bfea1-583e-4980-81a4-a038d9180040';
    assert.equal(normalizeUuid('519bfea1-583e-4980-81a4-a038d9180040'), want);
    assert.equal(normalizeUuid('519BFEA1583E498081A4A038D9180040'), want);
    assert.equal(normalizeUuid('  519bfea1583e498081a4a038d9180040 '), want);
    for (const bad of ['', 'abc', null, undefined, 42, '519bfea1-583e-4980-81a4-a038d918004', 'zz9bfea1583e498081a4a038d9180040']) {
        assert.equal(normalizeUuid(bad), null, String(bad));
    }
});

test('scoring formula on a full 16-team solo lobby', () => {
    const order = range(1, 16);
    const league = buildLeague([soloGame(1, order, { 1: 3, 2: 0, 8: 0, 16: 0 })], DEFAULT_CONFIG);
    // p=1: 200 * 1 + 60 + 3 kills * 10 = 290
    assert.equal(entryFor(league, 1, 1).hypeChange, 290);
    // p=2: 200 * (14/15)^2 = 174.22 -> 175
    assert.equal(entryFor(league, 2, 1).hypeChange, 175);
    // p=8: 200 * (8/15)^2 = 56.89 -> 55
    assert.equal(entryFor(league, 8, 1).hypeChange, 55);
    // p=16: 0
    assert.equal(entryFor(league, 16, 1).hypeChange, 0);
    assert.equal(P(league, 1).hype, 290);
    assert.equal(P(league, 1).tier, 'COAL');
    assert.equal(entryFor(league, 1, 1).tierAfter, 'COAL');
});

test('lobby factor scales placement points but not kills', () => {
    // T = 8 -> factor 0.5. p=1 with 2 kills: 0.5 * 260 + 20 = 150; p=8 with 1 kill: 10
    const league = buildLeague([soloGame(1, range(1, 8), { 1: 2, 8: 1 })], DEFAULT_CONFIG);
    assert.equal(entryFor(league, 1, 1).hypeChange, 150);
    assert.equal(entryFor(league, 8, 1).hypeChange, 10);
    // p=4 of 8: 0.5 * 200 * (4/7)^2 = 32.65 -> 35
    assert.equal(entryFor(league, 4, 1).hypeChange, 35);
});

test('entry cost depends on the tier before the game', () => {
    const games = [
        soloGame(1, range(1, 16), { 1: 4 }), // player 1: 260 + 40 = 300 -> COPPER
        soloGame(2, [...range(2, 16), 1]), // player 1 last: 0 - 10 (COPPER) = -10 -> 290
        soloGame(3, [...range(2, 16), 1]) // back in COAL: cost 0 -> 290
    ];
    const league = buildLeague(games, DEFAULT_CONFIG);
    assert.equal(entryFor(league, 1, 1).hypeAfter, 300);
    assert.equal(entryFor(league, 1, 1).tierAfter, 'COPPER');
    const second = entryFor(league, 1, 2);
    assert.equal(second.tierBefore, 'COPPER');
    assert.equal(second.hypeChange, -10);
    assert.equal(second.hypeAfter, 290);
    const third = entryFor(league, 1, 3);
    assert.equal(third.tierBefore, 'COAL');
    assert.equal(third.hypeChange, 0);
    assert.equal(P(league, 1).hype, 290);
    assert.equal(P(league, 1).peakHype, 300);
    assert.equal(P(league, 1).lowHype, 290);
});

test('hype is floored at 0 and hypeChange reflects the floor', () => {
    const config = deepMerge(DEFAULT_CONFIG, { scoring: { entryCost: { COAL: 50 } } });
    const games = [
        soloGame(1, range(1, 16)), // player 8: 56.89 - 50 = 6.89 -> 5
        soloGame(2, [...range(1, 7), ...range(9, 16), 8]) // player 8 last: -50 -> floor 0, change -5
    ];
    const league = buildLeague(games, config);
    assert.equal(entryFor(league, 8, 1).hypeAfter, 5);
    const last = entryFor(league, 8, 2);
    assert.equal(last.hypeBefore, 5);
    assert.equal(last.hypeAfter, 0);
    assert.equal(last.hypeChange, -5);
    // player 16 last twice from 0: stays 0, change 0 (never negative)
    assert.equal(entryFor(league, 16, 1).hypeAfter, 0);
    assert.equal(entryFor(league, 16, 1).hypeChange, 0);
});

test('helpers: placementPoints / hypeChangeFor', () => {
    const s = mergeConfig({}).scoring;
    assert.equal(placementPoints(1, 10, s), 260);
    assert.equal(placementPoints(10, 10, s), 0);
    assert.equal(placementPoints(1, 1, s), 260); // single team: no division by zero
    assert.deepEqual(hypeChangeFor({ placement: 1, teams: 16, kills: 0, hypeBefore: 1000, tierId: 'IRON' }, s), { hypeAfter: 1240, hypeChange: 240 });
    // JS rounding: -2.5 rounds towards +inf -> -10
    assert.deepEqual(hypeChangeFor({ placement: 16, teams: 16, kills: 0, hypeBefore: 100, tierId: 'X' },
        { ...s, entryCost: { X: 12.5 } }), { hypeAfter: 90, hypeChange: -10 });
});

test('teammates share placement points but score their own kills', () => {
    const game = makeGame(1, [
        [{ i: 1, kills: 5 }, { i: 2, kills: 0 }],
        ...range(3, 32).reduce((acc, i, k) => (k % 2 ? acc[acc.length - 1].push(i) : acc.push([i]), acc), [])
    ], { teamSize: 2 });
    const league = buildLeague([game], DEFAULT_CONFIG);
    assert.equal(league.games[0].teamCount, 16);
    assert.equal(entryFor(league, 1, 1).hypeChange, 310);
    assert.equal(entryFor(league, 2, 1).hypeChange, 260);
    assert.equal(league.games[0].teams[0].kills, 5);
    assert.equal(league.games[0].winners.length, 2);
});

test('unranked games and games below minTeams are ignored everywhere', () => {
    const games = [
        soloGame(1, range(1, 10)),
        soloGame(2, [99, 1, 2, 3, 4], {}, { ranked: false }),
        soloGame(3, [98, 1, 2]) // 3 teams < minTeams 4
    ];
    const league = buildLeague(games, DEFAULT_CONFIG);
    assert.deepEqual(league.games.map((g) => g.number), [1]);
    assert.equal(league.gameByNumber.has(2), false);
    assert.equal(league.players.has(uuidFor(99)), false);
    assert.equal(league.players.has(uuidFor(98)), false);
    assert.equal(P(league, 1).events, 1);
    assert.equal(league.ranked.length, 10);
});

test('player stats: wins, podiums, average/best placement, kills, deaths, damage', () => {
    const games = [
        soloGame(1, range(1, 10), { 1: 2 }),
        soloGame(2, [5, 6, 1, 2, 3, 4, 7, 8, 9, 10], { 1: 1 }),
        soloGame(3, [5, 6, 7, 8, 1, 2, 3, 4, 9, 10])
    ];
    games[0].teams[0].players[0].damage = 12.25;
    games[1].teams[2].players[0].damage = 3;
    const league = buildLeague(games, DEFAULT_CONFIG);
    const p = P(league, 1);
    assert.equal(p.events, 3);
    assert.equal(p.wins, 1);
    assert.equal(p.podiums, 2);
    assert.equal(p.placementSum, 9);
    assert.equal(p.averagePlacement, 3);
    assert.equal(p.bestPlacement, 1);
    assert.equal(p.kills, 3);
    assert.equal(p.deaths, 2); // default: 0 for a win, 1 otherwise
    assert.equal(p.damage, 15.3);
    assert.equal(p.firstSeen, games[0].endedAt);
    assert.equal(p.lastSeen, games[2].endedAt);
    assert.equal(p.history.length, 3);
    assert.deepEqual(Object.keys(p.history[0]).sort(),
        ['at', 'hypeAfter', 'hypeBefore', 'hypeChange', 'kills', 'number', 'placement', 'rank', 'teams'].sort());
});

test('processed game shape and ordering', () => {
    const games = [soloGame(2, range(1, 6), { 1: 3, 2: 1 }), soloGame(1, range(1, 6))];
    const league = buildLeague(games, DEFAULT_CONFIG);
    assert.deepEqual(league.games.map((g) => g.number), [2, 1]);
    const g = league.gameByNumber.get(2);
    for (const key of ['number', 'mode', 'modeName', 'modeColor', 'map', 'teamSize', 'startedAt', 'endedAt', 'duration',
        'teamCount', 'players', 'kills', 'ranked', 'teams', 'winners']) {
        assert.ok(key in g, key);
    }
    assert.equal(g.modeName, 'Battle Royale');
    assert.equal(g.modeColor, 'gold');
    assert.equal(g.duration, 20 * MIN);
    assert.equal(g.players, 6);
    assert.equal(g.kills, 4);
    assert.equal(g.teams[0].eliminatedAt, null);
    assert.deepEqual(g.teams.map((t) => t.placement), [1, 2, 3, 4, 5, 6]);
    const p = g.teams[0].players[0];
    assert.deepEqual(Object.keys(p).sort(), ['damage', 'deaths', 'hypeAfter', 'hypeBefore', 'hypeChange', 'kills', 'name',
        'skin', 'tierAfter', 'tierBefore', 'uuid'].sort());
    assert.equal(p.skin, p.uuid);
});

test('mode names: explicit modeName, config, then title-cased slug', () => {
    const games = [
        soloGame(1, range(1, 5), {}, { mode: 'bedwars' }),
        { ...soloGame(2, range(1, 5), {}, { mode: 'bedwars' }), modeName: 'Bed Wars Duos Cup' },
        soloGame(3, range(1, 5), {}, { mode: 'build-battle' })
    ];
    const league = buildLeague(games, DEFAULT_CONFIG);
    assert.equal(league.gameByNumber.get(1).modeName, 'Bed Wars');
    assert.equal(league.gameByNumber.get(1).modeColor, 'red');
    assert.equal(league.gameByNumber.get(2).modeName, 'Bed Wars Duos Cup');
    assert.equal(league.gameByNumber.get(3).modeName, 'Build Battle');
    assert.equal(league.gameByNumber.get(3).modeColor, 'blue');
});

test('games are processed by endedAt, not by number; name/skin = latest seen', () => {
    const later = soloGame(1, range(1, 5), {}, { startedAt: T0 + 100 * MIN });
    later.teams[0].players[0].name = 'NewName';
    later.teams[0].players[0].skin = 'skin-new';
    const earlier = soloGame(2, [5, 4, 3, 2, 1], {}, { startedAt: T0 });
    const league = buildLeague([later, earlier], DEFAULT_CONFIG);
    const p = P(league, 1);
    assert.deepEqual(p.history.map((h) => h.number), [2, 1]);
    assert.equal(p.name, 'NewName');
    assert.equal(p.skin, 'skin-new');
    assert.equal(league.byName.get('newname'), uuidFor(1));
    assert.equal(league.byName.has('player1'), false);
});

test('UUID formats are merged into one player', () => {
    const a = soloGame(1, range(1, 5));
    const b = soloGame(2, range(1, 5));
    b.teams[0].players[0].uuid = uuidFor(1).replace(/-/g, '').toUpperCase();
    const league = buildLeague([a, b], DEFAULT_CONFIG);
    assert.equal(P(league, 1).events, 2);
    assert.equal(league.ranked.length, 5);
});

test('ranked order: hype desc, wins desc, kills desc, name asc case-insensitive', () => {
    const league = buildLeague([soloGame(1, range(1, 20))], DEFAULT_CONFIG);
    for (let i = 1; i < league.ranked.length; i++) {
        assert.ok(comparePlayers(league.ranked[i - 1], league.ranked[i]) < 0);
        assert.equal(league.ranked[i].position, i + 1);
    }
});

test('name ordering is case-insensitive on exact ties', () => {
    // Everyone places last-equivalent: two separate 4-team games where the tied players come last.
    const g1 = makeGame(1, [[{ i: 10 }], [{ i: 11 }], [{ i: 12 }], [{ i: 1, name: 'bravo' }]]);
    const g2 = makeGame(2, [[{ i: 13 }], [{ i: 14 }], [{ i: 15 }], [{ i: 2, name: 'Alpha' }]]);
    const g3 = makeGame(3, [[{ i: 16 }], [{ i: 17 }], [{ i: 18 }], [{ i: 3, name: 'charlie' }]]);
    const league = buildLeague([g1, g2, g3], DEFAULT_CONFIG);
    const tail = league.ranked.filter((p) => p.hype === 0).map((p) => p.name);
    assert.deepEqual(tail, ['Alpha', 'bravo', 'charlie']);
});

test('history ranks match a brute-force re-sort after every game', () => {
    for (const seed of [3, 11, 29]) {
        const raw = randomGames(120, { players: 70, seed, ranked: 'mixed' });
        // Shuffle the input order and endedAt a bit so processing order != number order.
        const rand = rng(seed + 100);
        raw.forEach((g) => {
            const jitter = Math.floor(rand() * 90) * MIN;
            g.startedAt += jitter;
            g.endedAt += jitter;
            for (const t of g.teams) if (t.eliminatedAt) t.eliminatedAt += jitter;
        });
        raw.sort(() => rand() - 0.5);
        const league = buildLeague(raw, DEFAULT_CONFIG);
        const chronological = [...league.games].sort((a, b) => a.endedAt - b.endedAt || a.number - b.number);

        const state = new Map();
        const expected = new Map(); // `${uuid}#${number}` -> rank
        for (const g of chronological) {
            for (const team of g.teams) {
                for (const p of team.players) {
                    const s = state.get(p.uuid) || { uuid: p.uuid, hype: 0, wins: 0, kills: 0, name: p.name };
                    s.hype = p.hypeAfter;
                    s.wins += team.placement === 1 ? 1 : 0;
                    s.kills += p.kills;
                    s.name = p.name;
                    state.set(p.uuid, s);
                }
            }
            const sorted = [...state.values()].sort(comparePlayers);
            sorted.forEach((s, idx) => {
                if (g.teams.some((t) => t.players.some((p) => p.uuid === s.uuid))) expected.set(`${s.uuid}#${g.number}`, idx + 1);
            });
        }
        let checked = 0;
        for (const p of league.ranked) {
            for (const h of p.history) {
                assert.equal(h.rank, expected.get(`${p.uuid}#${h.number}`), `seed ${seed} ${p.name} game ${h.number}`);
                checked++;
            }
        }
        assert.ok(checked > 500);
        // Final order equals a full sort.
        const final = [...league.ranked].sort(comparePlayers).map((p) => p.uuid);
        assert.deepEqual(league.ranked.map((p) => p.uuid), final);
        // And the last history rank of each player equals... their rank at that time, which for the
        // most recent game's participants is their final position if nobody played after.
        const newest = chronological[chronological.length - 1];
        for (const team of newest.teams) {
            for (const pl of team.players) {
                const rec = league.players.get(pl.uuid);
                assert.equal(rec.history[rec.history.length - 1].rank, rec.position);
            }
        }
    }
});

test('robust to messy input', () => {
    const good = soloGame(5, range(1, 6));
    const messy = [
        null, 42, 'x', {}, { teams: 'nope' }, { teams: [] },
        { number: 9, startedAt: 'abc', endedAt: null, teams: [{ players: [{ uuid: uuidFor(1), name: 'A' }] }] },
        good,
        {
            // no number, string numbers, junk players, duplicate uuid, missing placements
            mode: 'SkyWars', startedAt: String(T0), endedAt: T0 + 10 * MIN, teamSize: '1',
            teams: [
                { placement: '2', players: [{ uuid: uuidFor(20), name: 'Two', kills: '3' }] },
                { placement: 1, players: [{ uuid: uuidFor(21), name: 'One', kills: -5 }, { uuid: uuidFor(21), name: 'Dup' }] },
                { players: [{ uuid: 'not-a-uuid', name: 'Bad' }] },
                { placement: 3, players: [{ uuid: uuidFor(22) }] },
                { placement: 4, players: [{ uuid: uuidFor(23), name: 'Four', damage: 'lots' }] },
                null
            ]
        }
    ];
    const league = buildLeague(messy, DEFAULT_CONFIG);
    assert.equal(league.games.length, 2);
    const sky = league.games.find((g) => g.mode === 'skywars');
    assert.equal(sky.number, 6); // assigned after the max existing number (5)
    assert.equal(sky.teamCount, 4);
    assert.deepEqual(sky.teams.map((t) => t.players[0].name), ['One', 'Two', uuidFor(22).slice(0, 8), 'Four']);
    assert.equal(sky.teams[0].players.length, 1);
    assert.equal(sky.teams[0].players[0].kills, 0);
    assert.equal(sky.teams[1].players[0].kills, 3);
    assert.equal(sky.teams[3].players[0].damage, null);
    assert.equal(buildLeague(null, null).ranked.length, 0);
    assert.equal(buildLeague({ games: [good] }, undefined).games.length, 1);
});

test('duplicate numbers keep the first and renumber the rest', () => {
    const league = buildLeague([soloGame(3, range(1, 5)), soloGame(3, range(1, 5), {}, { startedAt: T0 + 999 * MIN })], DEFAULT_CONFIG);
    assert.deepEqual(league.games.map((g) => g.number), [4, 3]);
});

test('shiftTimestamps moves every time by the same delta without mutating', () => {
    const games = [soloGame(1, range(1, 5)), soloGame(2, range(1, 5))];
    const snapshot = JSON.stringify(games);
    const target = Date.UTC(2030, 0, 1);
    const shifted = shiftTimestamps(games, target);
    assert.equal(JSON.stringify(games), snapshot);
    const delta = target - games[1].endedAt;
    assert.equal(shifted[1].endedAt, target);
    assert.equal(shifted[0].startedAt, games[0].startedAt + delta);
    assert.equal(shifted[0].teams[1].eliminatedAt, games[0].teams[1].eliminatedAt + delta);
    assert.equal(shifted[0].teams[0].eliminatedAt, null);
    assert.deepEqual(shiftTimestamps([], target), []);
});

test('mergeConfig fills defaults, sanitises types and is idempotent', () => {
    const user = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}');
    Object.assign(user, {
        siteName: 'My Server',
        scoring: { killPoints: '15', roundTo: 0, minTeams: 1, entryCost: { GOLD: 99 } },
        modes: { duels: { name: 'Duels', color: 'pink' } },
        tiers: [{ id: 'gold', min: 10 }, { id: 'coal', name: 'Coal', min: 0 }, { id: 'bad id', min: 5 }, { id: 'X' }],
        skins: 'weird',
        serverIp: null
    });
    const cfg = mergeConfig(user);
    assert.equal(cfg.siteName, 'My Server');
    assert.equal(cfg.ratingName, 'Hype');
    assert.equal(cfg.scoring.killPoints, 15);
    assert.equal(cfg.scoring.roundTo, 1);
    assert.equal(cfg.scoring.minTeams, 2);
    assert.deepEqual(cfg.tiers.map((t) => [t.id, t.name, t.min]), [['COAL', 'Coal', 0], ['GOLD', 'Gold', 10]]);
    assert.deepEqual(cfg.scoring.entryCost, { COAL: 0, GOLD: 99 });
    assert.equal(cfg.modes.duels.color, 'blue');
    assert.equal(cfg.modes['battle-royale'].name, 'Battle Royale');
    assert.equal(cfg.skins, 'auto');
    assert.equal(cfg.serverIp, '');
    assert.equal({}.polluted, undefined);
    assert.equal(cfg.polluted, undefined);
    assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
    assert.deepEqual(mergeConfig(cfg), cfg);
    assert.deepEqual(mergeConfig(undefined), mergeConfig({}));
    assert.deepEqual(mergeConfig({}).tiers, DEFAULT_CONFIG.tiers);
    // Defaults are frozen and never mutated by merging.
    assert.ok(Object.isFrozen(DEFAULT_CONFIG.scoring));
});

test('deepMerge merges objects, replaces arrays and skips undefined', () => {
    const a = { x: { y: 1, z: [1, 2] }, k: 1 };
    const out = deepMerge(a, { x: { z: [3] }, k: undefined, n: { m: 1 } });
    assert.deepEqual(out, { x: { y: 1, z: [3] }, k: 1, n: { m: 1 } });
    assert.deepEqual(a, { x: { y: 1, z: [1, 2] }, k: 1 });
    out.x.z.push(9);
    assert.deepEqual(a.x.z, [1, 2]);
});

test('performance: 10k games x 40 players x 5k players builds in under 3 s', () => {
    const rand = rng(12345);
    const games = [];
    const N = 5000;
    for (let n = 1; n <= 10000; n++) {
        const used = new Set();
        const teams = [];
        while (used.size < 40) {
            const i = Math.floor(rand() * N);
            if (used.has(i)) continue;
            used.add(i);
            teams.push({
                placement: teams.length + 1,
                eliminatedAt: null,
                players: [{ uuid: uuidFor(i), name: `P${i}`, kills: Math.floor(rand() * 3) }]
            });
        }
        const startedAt = T0 + n * 25 * MIN;
        games.push({ number: n, mode: 'battle-royale', teamSize: 1, startedAt, endedAt: startedAt + 20 * MIN, teams });
    }
    const t = performance.now();
    const league = buildLeague(games, DEFAULT_CONFIG);
    const ms = performance.now() - t;
    assert.equal(league.games.length, 10000);
    assert.equal(league.ranked.length, N);
    assert.ok(ms < 3000, `buildLeague took ${ms.toFixed(0)} ms`);
    // Spot-check: ranks stay within bounds.
    for (const p of league.ranked.slice(0, 50)) for (const h of p.history) assert.ok(h.rank >= 1 && h.rank <= N);
});
