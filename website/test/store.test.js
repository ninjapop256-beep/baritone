import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { StoreError, createMemoryStore, openFileStore, parseGamesJson } from '../lib/store.js';
import { range, soloGame } from './helpers.js';

const tmpDir = () => mkdtemp(path.join(os.tmpdir(), 'pvp-store-'));

test('file store: missing file is empty, add auto-numbers and persists atomically', async () => {
    const dir = await tmpDir();
    try {
        const store = await openFileStore(path.join(dir, 'nested', 'data'));
        assert.equal(store.count, 0);
        assert.equal(store.readOnly, false);
        const { number: _drop, ...first } = soloGame(1, range(1, 4));
        assert.equal(await store.add(first), 1);
        assert.equal(await store.add(soloGame(10, range(1, 4), {}, { startedAt: 5e12 })), 10);
        const { number: _n, ...third } = soloGame(0, range(1, 4), {}, { startedAt: 6e12 });
        assert.equal(await store.add(third), 11);
        const text = await readFile(store.file, 'utf8');
        assert.equal(text.split('\n').length, 6); // [, 3 games, ], trailing newline
        assert.deepEqual(JSON.parse(text).map((g) => g.number), [1, 10, 11]);
        const files = await readdir(path.dirname(store.file));
        assert.deepEqual(files, ['games.json']); // no temp files left behind

        const reopened = await openFileStore(path.join(dir, 'nested', 'data'));
        assert.equal(reopened.count, 3);
        assert.ok(reopened.has(10));
        assert.equal(reopened.get('11').number, 11);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('file store: duplicates by number and by fingerprint', async () => {
    const dir = await tmpDir();
    try {
        const store = await openFileStore(dir);
        await store.add(soloGame(5, range(1, 4)));
        await assert.rejects(store.add(soloGame(5, range(1, 4), {}, { startedAt: 9e12 })),
            (err) => err instanceof StoreError && err.code === 'DUPLICATE' && err.number === 5);
        // Same game re-sent without a number (plugin retry) -> duplicate of #5.
        const { number: _n, ...retry } = soloGame(5, range(1, 4));
        await assert.rejects(store.add(retry), (err) => err.code === 'DUPLICATE' && err.number === 5);
        assert.equal(store.count, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('file store: remove and concurrent writes are serialised', async () => {
    const dir = await tmpDir();
    try {
        const store = await openFileStore(dir);
        const results = await Promise.all(range(1, 20).map((k) => {
            const { number: _n, ...g } = soloGame(k, range(1, 4), {}, { startedAt: 2e12 + k * 1e6 });
            return store.add(g);
        }));
        assert.deepEqual([...results].sort((a, b) => a - b), range(1, 20));
        assert.equal(await store.remove(7), true);
        assert.equal(await store.remove(7), false);
        assert.equal(await store.remove('abc'), false);
        await store.flush();
        const saved = JSON.parse(await readFile(store.file, 'utf8'));
        assert.equal(saved.length, 19);
        assert.equal(saved.some((g) => g.number === 7), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('file store: corrupt JSON is reported and never overwritten', async () => {
    const dir = await tmpDir();
    try {
        await writeFile(path.join(dir, 'games.json'), '[{"number": 1,');
        await assert.rejects(openFileStore(dir), (err) => err.code === 'CORRUPT' && /not valid JSON/.test(err.message));
        assert.equal(await readFile(path.join(dir, 'games.json'), 'utf8'), '[{"number": 1,');
        await writeFile(path.join(dir, 'games.json'), '{"nope": true}');
        await assert.rejects(openFileStore(dir), (err) => err.code === 'CORRUPT');
        await writeFile(path.join(dir, 'games.json'), JSON.stringify({ games: [soloGame(1, range(1, 4)), 5, null] }));
        assert.equal((await openFileStore(dir)).count, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('memory store: read-only by default', async () => {
    const store = createMemoryStore([soloGame(1, range(1, 4))]);
    assert.equal(store.readOnly, true);
    assert.equal(store.count, 1);
    await assert.rejects(store.add(soloGame(2, range(1, 4))), (err) => err.code === 'READ_ONLY');
    await assert.rejects(store.remove(1), (err) => err.code === 'READ_ONLY');
    const writable = createMemoryStore([], { readOnly: false });
    assert.equal(await writable.add(soloGame(3, range(1, 4))), 3);
    assert.equal(await writable.remove(3), true);
});

test('parseGamesJson', () => {
    assert.deepEqual(parseGamesJson('[]'), []);
    assert.throws(() => parseGamesJson('nope'), /not valid JSON/);
});
