import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, deepMerge } from '../public/js/shared/defaults.js';
import { buildLeague } from '../public/js/shared/league.js';
import {
    configResponse, findPlayer, gameResponse, gamesPage, healthResponse, kdRatio, profileResponse, rankingsResponse
} from '../public/js/shared/model.js';
import { MIN, T0, makeGame, range, soloGame, uuidFor } from './helpers.js';

const DAY = 24 * 60 * MIN;

// 45 numbered games (1..45) with gaps from unranked ones (#10, #20 unranked).
function fixture() {
    const games = [];
    for (let n = 1; n <= 45; n++) {
        const order = range(1, 12).map((i) => ((i + n) % 12) + 1);
        games.push(soloGame(n, order, { [order[0]]: 2, [order[1]]: 1 }, { startedAt: T0 + n * DAY / 3, ranked: n % 10 !== 0 || n > 20 }));
    }
    return games;
}
const league = buildLeague(fixture(), DEFAULT_CONFIG, { now: T0 + 20 * DAY });
const numbers = league.games.map((g) => g.number);

test('healthResponse', () => {
    assert.deepEqual(healthResponse(league, 'live'), { ok: true, mode: 'live', games: 43, players: 12 });
});

test('kdRatio', () => {
    assert.equal(kdRatio(10, 0), 10);
    assert.equal(kdRatio(10, 3), 3.33);
    assert.equal(kdRatio(0, 0), 0);
});

test('configResponse strips secret-looking keys and copies deeply', () => {
    const cfg = deepMerge(DEFAULT_CONFIG, { apiKey: 'x', adminToken: 'y', _private: 1, nested: { password: 'z', ok: 1 } });
    const out = configResponse(cfg);
    assert.equal(out.apiKey, undefined);
    assert.equal(out.adminToken, undefined);
    assert.equal(out._private, undefined);
    assert.deepEqual(out.nested, { ok: 1 });
    assert.equal(out.siteName, 'PVP EVENTS');
    assert.deepEqual(out.scoring.entryCost, DEFAULT_CONFIG.scoring.entryCost);
    out.tiers[0].min = 999;
    assert.equal(cfg.tiers[0].min, 0);
});

test('rankingsResponse shape', () => {
    const r = rankingsResponse(league);
    assert.equal(r.siteName, 'PVP EVENTS');
    assert.equal(r.ratingName, 'Hype');
    assert.equal(r.generatedAt, T0 + 20 * DAY);
    assert.equal(r.total, 12);
    assert.equal(r.players.length, 12);
    assert.deepEqual(Object.keys(r.players[0]), ['position', 'uuid', 'name', 'skin', 'hype', 'tier', 'tierName', 'division',
        'tierLabel', 'events', 'wins', 'kills', 'deaths', 'kd', 'averagePlacement', 'lastSeen']);
    r.players.forEach((p, i) => assert.equal(p.position, i + 1));
    for (let i = 1; i < r.players.length; i++) assert.ok(r.players[i - 1].hype >= r.players[i].hype);
    const p = r.players[0];
    assert.equal(p.kd, kdRatio(p.kills, p.deaths));
    assert.doesNotThrow(() => JSON.stringify(r));
});

test('gamesPage: newest first, default limit 30, before is exclusive', () => {
    const first = gamesPage(league);
    assert.equal(first.total, 43);
    assert.equal(first.games.length, 30);
    assert.equal(first.more, true);
    assert.deepEqual(first.games.map((g) => g.number), numbers.slice(0, 30));
    const lastShown = first.games.at(-1).number;
    const second = gamesPage(league, { before: lastShown });
    assert.equal(second.games[0].number, numbers[30]);
    assert.equal(second.games.length, 13);
    assert.equal(second.more, false);
    // before a missing (unranked) number
    assert.equal(gamesPage(league, { before: 20, limit: 2 }).games[0].number, 19);
    assert.deepEqual(gamesPage(league, { before: 11, limit: 3 }).games.map((g) => g.number), [9, 8, 7]);
    assert.deepEqual(gamesPage(league, { before: 1 }), { total: 43, more: false, games: [] });
    assert.equal(gamesPage(league, { before: 999 }).games[0].number, 45);
    assert.deepEqual(Object.keys(first.games[0]), ['number', 'mode', 'modeName', 'modeColor', 'map', 'teamSize', 'teamCount',
        'players', 'kills', 'startedAt', 'endedAt', 'duration', 'winners']);
    assert.deepEqual(Object.keys(first.games[0].winners[0]), ['uuid', 'name', 'skin', 'kills', 'hypeChange', 'hypeAfter']);
});

test('gamesPage: limit clamping and junk parameters', () => {
    assert.equal(gamesPage(league, { limit: 0 }).games.length, 1);
    assert.equal(gamesPage(league, { limit: -5 }).games.length, 1);
    assert.equal(gamesPage(league, { limit: 1000 }).games.length, 43);
    assert.equal(gamesPage(league, { limit: 'abc' }).games.length, 30);
    assert.equal(gamesPage(league, { limit: '5' }).games.length, 5);
    assert.equal(gamesPage(league, { before: 'x' }).games[0].number, 45);
    assert.equal(gamesPage(league, { before: '' }).games[0].number, 45);
    assert.equal(gamesPage(league, { before: '30' }).games[0].number, 29);
    const big = buildLeague(range(1, 150).map((n) => soloGame(n, range(1, 5))), DEFAULT_CONFIG);
    assert.equal(gamesPage(big, { limit: 500 }).games.length, 100);
    assert.equal(gamesPage(big, { limit: 500 }).more, true);
    const empty = buildLeague([], DEFAULT_CONFIG);
    assert.deepEqual(gamesPage(empty), { total: 0, more: false, games: [] });
});

test('gameResponse: details, mostKills, prev/next with edges and gaps', () => {
    const g = gameResponse(league, 45);
    assert.equal(g.number, 45);
    assert.equal(g.next, null);
    assert.equal(g.prev, 44);
    assert.equal(g.mostKills.kills, 2);
    assert.equal(g.mostKills.uuid, g.teams[0].players[0].uuid);
    assert.deepEqual(Object.keys(g.mostKills), ['uuid', 'name', 'skin', 'kills']);
    const oldest = gameResponse(league, 1);
    assert.equal(oldest.prev, null);
    assert.equal(oldest.next, 2);
    const around = gameResponse(league, 11);
    assert.equal(around.prev, 9); // #10 is unranked
    assert.equal(around.next, 12);
    assert.equal(gameResponse(league, '11').number, 11);
    assert.equal(gameResponse(league, 10), null);
    assert.equal(gameResponse(league, 999), null);
    assert.equal(gameResponse(league, 'abc'), null);
    assert.equal(gameResponse(league, null), null);
    for (const key of ['teams', 'winners', 'teamCount', 'duration', 'modeName', 'modeColor']) assert.ok(key in g, key);
    const noKills = buildLeague([soloGame(1, range(1, 5))], DEFAULT_CONFIG);
    assert.equal(gameResponse(noKills, 1).mostKills, null);
    const single = gameResponse(noKills, 1);
    assert.equal(single.prev, null);
    assert.equal(single.next, null);
});

test('findPlayer / profileResponse lookup by name (any case) and uuid (any format)', () => {
    const name = league.ranked[3].name;
    const uuid = league.ranked[3].uuid;
    for (const key of [name, name.toUpperCase(), name.toLowerCase(), ` ${name} `, uuid, uuid.toUpperCase(), uuid.replace(/-/g, '')]) {
        assert.equal(profileResponse(league, key).player.uuid, uuid, key);
    }
    assert.equal(profileResponse(league, 'nobody'), null);
    assert.equal(profileResponse(league, ''), null);
    assert.equal(profileResponse(league, null), null);
    assert.equal(profileResponse(league, uuidFor(999)), null);
    assert.equal(findPlayer(league, name).uuid, uuid);
});

test('profileResponse: player stats, history and games', () => {
    const now = T0 + 20 * DAY;
    const prof = profileResponse(league, league.ranked[0].uuid, { now });
    const p = prof.player;
    assert.equal(p.history, undefined);
    assert.equal(p.total, 12);
    assert.equal(p.position, 1);
    assert.equal(p.kd, kdRatio(p.kills, p.deaths));
    assert.equal(p.winRate, Math.round((p.wins / p.events) * 10000) / 10000);
    assert.equal(p.top3Rate, Math.round((p.podiums / p.events) * 10000) / 10000);
    assert.equal(p.killsPerEvent, Math.round((p.kills / p.events) * 100) / 100);
    assert.ok(p.events30d > 0 && p.events30d <= p.events);
    for (const key of ['tierMin', 'nextTierMin', 'nextTierName', 'progress', 'toNext', 'peakHype', 'lowHype', 'bestPlacement', 'podiums', 'damage']) {
        assert.ok(key in p, key);
    }
    assert.equal(prof.history.length, p.events);
    assert.deepEqual(Object.keys(prof.history[0]), ['number', 'at', 'hype', 'change', 'rank', 'placement', 'teams']);
    for (let i = 1; i < prof.history.length; i++) assert.ok(prof.history[i].at >= prof.history[i - 1].at);
    assert.equal(prof.history.at(-1).hype, p.hype);
    assert.equal(prof.games.length, p.events);
    assert.deepEqual(Object.keys(prof.games[0]), ['number', 'mode', 'modeName', 'modeColor', 'map', 'teamSize', 'startedAt',
        'endedAt', 'placement', 'teams', 'kills', 'hypeChange', 'hypeAfter']);
    for (let i = 1; i < prof.games.length; i++) assert.ok(prof.games[i].endedAt <= prof.games[i - 1].endedAt);
    // events30d honours `now`
    assert.equal(profileResponse(league, p.uuid, { now: T0 + 400 * DAY }).player.events30d, 0);
});

test('profileResponse: neighbors are 2 above / 2 below, shifted at the edges', () => {
    const pos = (key) => profileResponse(league, key).neighbors.map((n) => n.position);
    assert.deepEqual(pos(league.ranked[0].uuid), [1, 2, 3, 4, 5]);
    assert.deepEqual(pos(league.ranked[1].uuid), [1, 2, 3, 4, 5]);
    assert.deepEqual(pos(league.ranked[2].uuid), [1, 2, 3, 4, 5]);
    assert.deepEqual(pos(league.ranked[5].uuid), [4, 5, 6, 7, 8]);
    assert.deepEqual(pos(league.ranked[10].uuid), [8, 9, 10, 11, 12]);
    assert.deepEqual(pos(league.ranked[11].uuid), [8, 9, 10, 11, 12]);
    const n = profileResponse(league, league.ranked[5].uuid).neighbors[2];
    assert.deepEqual(Object.keys(n), ['position', 'uuid', 'name', 'skin', 'hype', 'tier', 'tierName', 'tierLabel']);
    assert.equal(n.uuid, league.ranked[5].uuid);
    // Fewer than five players overall.
    const tiny = buildLeague([makeGame(1, [[1], [2], [3], [4]])], DEFAULT_CONFIG);
    assert.deepEqual(profileResponse(tiny, 'Player3').neighbors.map((x) => x.position), [1, 2, 3, 4]);
});

test('profile tier progress fields', () => {
    const prof = profileResponse(league, league.ranked[0].uuid);
    const p = prof.player;
    assert.equal(p.tierMin, DEFAULT_CONFIG.tiers.find((t) => t.id === p.tier).min);
    if (p.nextTierMin !== null) {
        assert.equal(p.toNext, p.nextTierMin - p.hype);
        assert.ok(p.progress >= 0 && p.progress <= 1);
    }
});
