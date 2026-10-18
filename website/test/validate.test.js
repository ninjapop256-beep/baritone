import test from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS, validateGame } from '../lib/validate.js';
import { MIN, T0, makeGame, range, uuidFor } from './helpers.js';

const NOW = T0 + 365 * 24 * 60 * MIN;
const good = () => makeGame(7, [[{ i: 1, kills: 3, damage: 21.25 }, { i: 2, kills: 1 }], [{ i: 3 }, { i: 4, deaths: 2 }], [{ i: 5 }], [{ i: 6 }]], { teamSize: 2 });
const check = (raw) => validateGame(raw, { now: NOW });
const errorsFor = (mutate) => {
    const g = good();
    mutate(g);
    const res = check(g);
    assert.equal(res.ok, false, 'expected validation to fail');
    assert.equal(res.game, null);
    return res.errors.join('\n');
};

test('a good game passes and is normalised', () => {
    const raw = good();
    raw.mode = ' Battle-Royale ';
    raw.map = 'Cherry_Grove';
    raw.teams[0].players[0].uuid = uuidFor(1).replace(/-/g, '').toUpperCase();
    raw.teams[0].eliminatedAt = 0; // some plugins send 0 for the winner
    raw.teams.reverse(); // order does not matter
    raw.extra = 'ignored';
    const res = check(raw);
    assert.equal(res.ok, true, res.errors.join('\n'));
    assert.deepEqual(res.errors, []);
    const g = res.game;
    assert.equal(g.number, 7);
    assert.equal(g.mode, 'battle-royale');
    assert.equal(g.map, 'cherry_grove');
    assert.equal(g.ranked, true);
    assert.equal(g.extra, undefined);
    assert.deepEqual(g.teams.map((t) => t.placement), [1, 2, 3, 4]);
    assert.equal(g.teams[0].eliminatedAt, null);
    assert.equal(g.teams[0].players[0].uuid, uuidFor(1));
    assert.equal(g.teams[0].players[0].damage, 21.25);
    assert.equal(g.teams[1].players[1].deaths, 2);
    assert.equal('deaths' in g.teams[0].players[0], false);
});

test('optional fields: number, map, modeName, ranked, skin', () => {
    const raw = good();
    delete raw.number;
    delete raw.map;
    raw.modeName = 'Summer Cup';
    raw.ranked = false;
    raw.teams[0].players[0].skin = 'a1b2c3_d4';
    const res = check(raw);
    assert.equal(res.ok, true, res.errors.join('\n'));
    assert.equal(res.game.number, undefined);
    assert.equal(res.game.map, undefined);
    assert.equal(res.game.modeName, 'Summer Cup');
    assert.equal(res.game.ranked, false);
    assert.equal(res.game.teams[0].players[0].skin, 'a1b2c3_d4');
    assert.equal(check({ ...good(), number: null }).ok, true);
});

test('rejects non-object bodies', () => {
    for (const body of [null, 42, 'game', [], [good()], true]) {
        const res = check(body);
        assert.equal(res.ok, false);
        assert.match(res.errors[0], /^body: expected a JSON object/);
    }
});

test('top-level field errors', () => {
    assert.match(errorsFor((g) => delete g.mode), /^mode: is required/m);
    assert.match(errorsFor((g) => { g.mode = 'Battle Royale!'; }), /^mode: must be a slug/m);
    assert.match(errorsFor((g) => { g.number = 0; }), /^number: must be a positive integer/m);
    assert.match(errorsFor((g) => { g.number = 1.5; }), /^number:/m);
    assert.match(errorsFor((g) => { g.number = '7'; }), /^number:/m);
    assert.match(errorsFor((g) => { g.map = 'cherry grove'; }), /^map: must be a slug/m);
    assert.match(errorsFor((g) => { g.modeName = ''; }), /^modeName:/m);
    assert.match(errorsFor((g) => delete g.teamSize), /^teamSize: is required/m);
    assert.match(errorsFor((g) => { g.teamSize = 0; }), /^teamSize:/m);
    assert.match(errorsFor((g) => { g.teamSize = 2.5; }), /^teamSize:/m);
    assert.match(errorsFor((g) => { g.ranked = 'yes'; }), /^ranked: must be true or false/m);
});

test('timestamp errors', () => {
    assert.match(errorsFor((g) => delete g.startedAt), /^startedAt: is required: epoch milliseconds/m);
    assert.match(errorsFor((g) => { g.startedAt = Math.floor(g.startedAt / 1000); }), /^startedAt: looks like epoch seconds/m);
    assert.match(errorsFor((g) => { g.endedAt = '2026-10-01'; }), /^endedAt: is required/m);
    assert.match(errorsFor((g) => { g.endedAt = g.startedAt - 1; }), /^endedAt: must not be before startedAt/m);
    assert.match(errorsFor((g) => { g.startedAt = Date.UTC(2005, 0, 1); }), /^startedAt: is not a plausible time/m);
    assert.match(errorsFor((g) => { g.startedAt = NOW + 3 * 24 * 60 * MIN; g.endedAt = g.startedAt + MIN; }), /not a plausible time/);
    assert.match(errorsFor((g) => { g.endedAt = g.startedAt + 25 * 60 * MIN; }), /more than 24 hours/);
});

test('team errors', () => {
    assert.match(errorsFor((g) => { g.teams = []; }), /^teams: is required: a non-empty array/m);
    assert.match(errorsFor((g) => delete g.teams), /^teams: is required/m);
    assert.match(errorsFor((g) => { g.teams[1] = 'x'; }), /^teams\[1\]: must be an object/m);
    assert.match(errorsFor((g) => { g.teams[1].placement = 1; }), /^teams\[1\]\.placement: duplicates teams\[0\]/m);
    assert.match(errorsFor((g) => { g.teams[1].placement = 9; }), /^teams\[1\]\.placement: must be an integer from 1 \(winner\) to 4/m);
    assert.match(errorsFor((g) => delete g.teams[2].placement), /^teams\[2\]\.placement:/m);
    assert.match(errorsFor((g) => { g.teams[0].eliminatedAt = g.endedAt; }), /^teams\[0\]\.eliminatedAt: must be null for the winning team/m);
    assert.match(errorsFor((g) => { g.teams[1].eliminatedAt = g.startedAt - 10 * MIN; }), /^teams\[1\]\.eliminatedAt: must be between/m);
    assert.match(errorsFor((g) => { g.teams[1].eliminatedAt = 'soon'; }), /^teams\[1\]\.eliminatedAt: must be epoch milliseconds or null/m);
    assert.match(errorsFor((g) => { g.teams[2].players = []; }), /^teams\[2\]\.players: must be a non-empty array/m);
    assert.match(errorsFor((g) => { g.teams[2].players.push({ uuid: uuidFor(50), name: 'A', kills: 0 }, { uuid: uuidFor(51), name: 'B', kills: 0 }); }),
        /^teams\[2\]\.players: has 3 players but teamSize is 2/m);
});

test('eliminatedAt within a small slack is clamped into the game window', () => {
    const g = good();
    g.teams[3].eliminatedAt = g.startedAt - 2000;
    g.teams[1].eliminatedAt = g.endedAt + 2000;
    const res = check(g);
    assert.equal(res.ok, true, res.errors.join('\n'));
    assert.equal(res.game.teams[3].eliminatedAt, g.startedAt);
    assert.equal(res.game.teams[1].eliminatedAt, g.endedAt);
});

test('player errors', () => {
    assert.match(errorsFor((g) => { g.teams[0].players[0].uuid = 'not-a-uuid'; }), /^teams\[0\]\.players\[0\]\.uuid: must be a Minecraft UUID/m);
    assert.match(errorsFor((g) => delete g.teams[0].players[0].uuid), /uuid: must be a Minecraft UUID/);
    assert.match(errorsFor((g) => { g.teams[2].players[0].uuid = uuidFor(1).toUpperCase(); }),
        /^teams\[2\]\.players\[0\]\.uuid: already appears at teams\[0\]\.players\[0\]/m);
    assert.match(errorsFor((g) => { g.teams[0].players[1].uuid = g.teams[0].players[0].uuid; }), /already appears/);
    for (const name of ['', 'has space', 'x'.repeat(17), 'Ünïcode', 42, null]) {
        assert.match(errorsFor((g) => { g.teams[1].players[0].name = name; }), /^teams\[1\]\.players\[0\]\.name: must be 1-16 characters/m, String(name));
    }
    assert.match(errorsFor((g) => delete g.teams[0].players[1].kills), /kills: is required: an integer 0-1000/);
    assert.match(errorsFor((g) => { g.teams[0].players[1].kills = -1; }), /kills:/);
    assert.match(errorsFor((g) => { g.teams[0].players[1].kills = 1.5; }), /kills:/);
    assert.match(errorsFor((g) => { g.teams[0].players[1].kills = '3'; }), /kills:/);
    assert.match(errorsFor((g) => { g.teams[0].players[1].deaths = -2; }), /deaths: must be an integer/);
    assert.match(errorsFor((g) => { g.teams[0].players[1].damage = -2; }), /damage: must be a number of hearts/);
    assert.match(errorsFor((g) => { g.teams[0].players[1].damage = '5'; }), /damage:/);
    assert.match(errorsFor((g) => { g.teams[0].players[1].skin = 'bad skin!'; }), /skin: must be a skin id/);
    assert.match(errorsFor((g) => { g.teams[0].players[1] = 7; }), /^teams\[0\]\.players\[1\]: must be an object/m);
    // helpful: shows the offending value
    assert.match(errorsFor((g) => { g.teams[1].players[0].name = 'Bad Name!'; }), /\(got "Bad Name!"\)/);
});

test('size limits: 200 teams, 1000 players', () => {
    const teams = range(1, LIMITS.maxTeams + 1).map((i) => [i]);
    assert.match(check(makeGame(1, teams, { teamSize: 1 })).errors.join('\n'), /^teams: has more than 200 teams/m);
    const ok = check(makeGame(1, range(1, 200).map((i) => [i]), { teamSize: 1 }));
    assert.equal(ok.ok, true, ok.errors.slice(0, 3).join('\n'));
    const big = makeGame(1, range(0, 199).map((t) => range(0, 5).map((k) => t * 6 + k + 1)), { teamSize: 6 });
    assert.match(check(big).errors.join('\n'), /^teams: has more than 1000 players in total/m);
});

test('errors are capped with a summary line', () => {
    const g = makeGame(1, range(1, 120).map((i) => [{ i, name: 'bad name' }]), { teamSize: 1 });
    const res = check(g);
    assert.equal(res.ok, false);
    assert.equal(res.errors.length, LIMITS.maxErrors + 1);
    assert.match(res.errors.at(-1), /^\.\.\. and 70 more errors$/);
});
