import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG } from '../public/js/shared/defaults.js';
import { buildLeague } from '../public/js/shared/league.js';
import { validateGame } from '../lib/validate.js';
import { SEED_DEFAULTS, createRng, generate } from '../scripts/seed.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const games = generate();

test('PRNG is deterministic per seed', () => {
    const a = createRng('x');
    const b = createRng('x');
    const c = createRng('y');
    const seqA = Array.from({ length: 5 }, () => a.next());
    assert.deepEqual(seqA, Array.from({ length: 5 }, () => b.next()));
    assert.notDeepEqual(seqA, Array.from({ length: 5 }, () => c.next()));
    assert.match(createRng(1).uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('generate() is reproducible and matches the committed demo file', async () => {
    assert.equal(JSON.stringify(generate()), JSON.stringify(games));
    const committed = await readFile(path.join(ROOT, 'public/demo/games.json'), 'utf8');
    assert.equal(committed, JSON.stringify(games), 'public/demo/games.json is stale: run "npm run seed"');
    assert.ok(committed.length < 900 * 1024, `demo file is ${committed.length} bytes`);
});

test('default dataset shape: ~110 ranked games, ~650 players, ~14 days', () => {
    const ranked = games.filter((g) => g.ranked !== false);
    assert.equal(ranked.length, SEED_DEFAULTS.games);
    assert.ok(games.length > ranked.length, 'has a few unranked games');
    assert.equal(games.at(-1).endedAt, SEED_DEFAULTS.now);
    const span = (games.at(-1).endedAt - games[0].startedAt) / 86400000;
    assert.ok(span > 10 && span < 18, `span ${span} days`);
    games.forEach((g, i) => assert.equal(g.number, i + 1));
    for (let i = 1; i < games.length; i++) assert.ok(games[i].startedAt > games[i - 1].endedAt, 'games do not overlap');

    const league = buildLeague(games, DEFAULT_CONFIG);
    assert.equal(league.games.length, SEED_DEFAULTS.games);
    assert.equal(league.ranked.length, SEED_DEFAULTS.players);
    const modes = {};
    for (const g of ranked) modes[g.mode] = (modes[g.mode] || 0) + 1;
    assert.ok(modes['battle-royale'] / ranked.length > 0.55);
    assert.ok(modes.bedwars > 0 && modes.skywars > 0);
    const events = league.ranked.map((p) => p.events).sort((a, b) => b - a);
    assert.ok(events[0] > 50, 'has grinders');
    assert.ok(events[Math.floor(events.length / 2)] <= 6, 'many casuals');
    const tiers = new Set(league.ranked.map((p) => p.tier));
    assert.ok(tiers.size >= 5, `tiers present: ${[...tiers]}`);
});

test('every generated game passes validation with believable stats', () => {
    for (const g of games) {
        const res = validateGame(g, { now: SEED_DEFAULTS.now });
        assert.equal(res.ok, true, `game ${g.number}: ${res.errors.slice(0, 3).join('; ')}`);
        const T = g.teams.length;
        assert.ok(T >= 12 && T <= 45, `teams ${T}`);
        assert.ok(g.teamSize >= 1 && g.teamSize <= 4);
        const minutes = (g.endedAt - g.startedAt) / 60000;
        assert.ok(minutes >= 8 && minutes <= 33, `duration ${minutes}`);
        const sorted = [...g.teams].sort((a, b) => a.placement - b.placement);
        for (let i = 2; i < sorted.length; i++) assert.ok(sorted[i].eliminatedAt <= sorted[i - 1].eliminatedAt);
        const players = g.teams.flatMap((t) => t.players);
        const kills = players.reduce((s, p) => s + p.kills, 0);
        const outs = players.length - g.teams[0].players.length;
        assert.ok(kills <= players.reduce((s, p) => s + p.deaths, 0), 'kills never exceed deaths');
        assert.ok(kills >= outs * 0.5, `kills ${kills} vs eliminations ${outs}`);
    }
});

test('names are original-looking gamer tags: 3-16 chars, unique', () => {
    const names = new Map();
    for (const g of games) for (const t of g.teams) for (const p of t.players) names.set(p.name.toLowerCase(), p.name);
    for (const name of names.values()) assert.match(name, /^[A-Za-z0-9_]{3,16}$/);
    const uuidsByName = new Map();
    for (const g of games) for (const t of g.teams) for (const p of t.players) {
        const set = uuidsByName.get(p.name.toLowerCase()) || new Set();
        set.add(p.uuid);
        uuidsByName.set(p.name.toLowerCase(), set);
    }
    for (const [name, set] of uuidsByName) assert.equal(set.size, 1, `name ${name} shared by several players`);
});

test('CLI flags: --games --players --seed --now --out', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pvp-seed-'));
    try {
        const out = path.join(dir, 'g.json');
        const stdout = execFileSync(process.execPath, [path.join(ROOT, 'scripts/seed.js'), '--games', '12', '--players=40',
            '--seed', 'abc', '--now', '2026-01-02T03:04:05Z', '--out', out], { encoding: 'utf8' });
        assert.match(stdout, /Wrote \d+ games \(12 ranked\)/);
        const data = JSON.parse(await readFile(out, 'utf8'));
        assert.equal(data.filter((g) => g.ranked !== false).length, 12);
        assert.equal(data.at(-1).endedAt, Date.parse('2026-01-02T03:04:05Z'));
        assert.equal(JSON.stringify(data), JSON.stringify(generate({ games: 12, players: 40, seed: 'abc', now: Date.parse('2026-01-02T03:04:05Z') })));
        assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'scripts/seed.js'), '--games', 'x'], { stdio: 'pipe' }));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
