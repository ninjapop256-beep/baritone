import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { DEMO_OFFSET_MS, createServer } from '../server.js';
import { MIN, range, soloGame } from './helpers.js';

const KEY = 'test-key-0123456789';
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const INDEX = '<!doctype html><html><head><meta charset="utf-8"><!--app-base--><title>Test</title></head><body><main id="app"></main></body></html>';

async function makePublic(dir) {
    await mkdir(path.join(dir, 'css'), { recursive: true });
    await mkdir(path.join(dir, 'demo'), { recursive: true });
    await mkdir(path.join(dir, 'img'), { recursive: true });
    await writeFile(path.join(dir, 'index.html'), INDEX);
    await writeFile(path.join(dir, 'css', 'base.css'), `body { color: red; }\n${'.x { margin: 0; }\n'.repeat(200)}`);
    await writeFile(path.join(dir, 'img', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(dir, '.secret'), 'hidden');
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ siteName: 'Test Events', apiKey: 'should-not-leak' }));
    const demo = range(1, 6).map((n) => soloGame(n, range(1, 8).map((i) => ((i + n) % 8) + 1), { 1: 2 }));
    await writeFile(path.join(dir, 'demo', 'games.json'), JSON.stringify(demo));
}

async function start(options) {
    const server = await createServer({ log: quiet, ...options });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        server,
        base,
        close: () => new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        })
    };
}

// Raw request (no URL normalisation, explicit headers, tolerant of early close).
function raw(base, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
    const url = new URL(base);
    return new Promise((resolve, reject) => {
        const req = http.request({ host: url.hostname, port: url.port, method, path: p, headers, agent: false }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (body) {
            req.write(body, () => {});
            req.on('error', () => {});
        }
        req.end();
    });
}

const json = async (res) => ({ status: res.status, body: await res.json(), headers: res.headers });
const post = (base, body, key = KEY, extra = {}) => fetch(`${base}/api/games`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body)
});
const freshGame = (number, offset = 0) => soloGame(number, range(1, 10), { 1: 3 }, { startedAt: Date.now() - 60 * MIN - offset });

describe('live server', () => {
    let dir;
    let srv;
    before(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pvp-server-'));
        await makePublic(path.join(dir, 'public'));
        await mkdir(path.join(dir, 'data'));
        await writeFile(path.join(dir, 'data', 'games.json'), JSON.stringify([
            soloGame(1, range(1, 10), { 1: 2 }), soloGame(2, range(2, 11), { 2: 1 }), soloGame(3, [3, 1, 2, 4, 5])
        ]));
        srv = await start({ publicDir: path.join(dir, 'public'), dataDir: path.join(dir, 'data'), apiKey: KEY });
    });
    after(async () => {
        await srv.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('GET /api/health', async () => {
        const { status, body, headers } = await json(await fetch(`${srv.base}/api/health`));
        assert.equal(status, 200);
        assert.deepEqual(body, { ok: true, mode: 'live', games: 3, players: 11 });
        assert.equal(headers.get('cache-control'), 'no-store');
        assert.match(headers.get('content-type'), /^application\/json/);
        assert.equal(headers.get('x-content-type-options'), 'nosniff');
    });

    test('GET /api/config merges defaults, adds mode, hides secrets', async () => {
        const { status, body } = await json(await fetch(`${srv.base}/api/config`));
        assert.equal(status, 200);
        assert.equal(body.siteName, 'Test Events');
        assert.equal(body.ratingName, 'Hype');
        assert.equal(body.mode, 'live');
        assert.equal(body.apiKey, undefined);
        assert.equal(body.tiers.length, 7);
    });

    test('GET /api/rankings (cached) and gzip', async () => {
        const { status, body } = await json(await fetch(`${srv.base}/api/rankings`));
        assert.equal(status, 200);
        assert.equal(body.total, 11);
        assert.equal(body.players[0].position, 1);
        const again = await (await fetch(`${srv.base}/api/rankings`)).text();
        assert.equal(again, JSON.stringify(body));
        const gz = await raw(srv.base, { path: '/api/rankings', headers: { 'Accept-Encoding': 'gzip' } });
        assert.equal(gz.headers['content-encoding'], 'gzip');
        assert.equal(gz.headers.vary, 'Accept-Encoding');
        assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString()), body);
        const head = await raw(srv.base, { method: 'HEAD', path: '/api/rankings' });
        assert.equal(head.status, 200);
        assert.equal(head.body.length, 0);
        assert.equal(Number(head.headers['content-length']), Buffer.byteLength(again));
    });

    test('GET /api/games paging', async () => {
        const all = await json(await fetch(`${srv.base}/api/games`));
        assert.deepEqual(all.body.games.map((g) => g.number), [3, 2, 1]);
        assert.equal(all.body.more, false);
        const page = await json(await fetch(`${srv.base}/api/games?before=3&limit=1`));
        assert.deepEqual(page.body.games.map((g) => g.number), [2]);
        assert.equal(page.body.more, true);
        assert.equal(page.body.total, 3);
        const junk = await json(await fetch(`${srv.base}/api/games?before=abc&limit=xyz`));
        assert.equal(junk.status, 200);
        assert.equal(junk.body.games.length, 3);
    });

    test('GET /api/games/:number and 404s', async () => {
        const ok = await json(await fetch(`${srv.base}/api/games/2`));
        assert.equal(ok.status, 200);
        assert.equal(ok.body.number, 2);
        assert.equal(ok.body.prev, 1);
        assert.equal(ok.body.next, 3);
        assert.ok(Array.isArray(ok.body.teams));
        for (const p of ['/api/games/99', '/api/games/abc', '/api/games/-1', '/api/games/1/extra']) {
            const res = await json(await fetch(`${srv.base}${p}`));
            assert.equal(res.status, 404, p);
            assert.equal(typeof res.body.error, 'string');
        }
    });

    test('GET /api/profile/:key by name (any case) and uuid; 404', async () => {
        const byName = await json(await fetch(`${srv.base}/api/profile/player1`));
        assert.equal(byName.status, 200);
        assert.equal(byName.body.player.name, 'Player1');
        assert.ok(byName.body.history.length >= 1);
        assert.ok(byName.body.neighbors.length >= 1);
        const byUuid = await json(await fetch(`${srv.base}/api/profile/${byName.body.player.uuid.replace(/-/g, '')}`));
        assert.equal(byUuid.body.player.uuid, byName.body.player.uuid);
        const missing = await json(await fetch(`${srv.base}/api/profile/Nobody%20Here`));
        assert.equal(missing.status, 404);
        assert.match(missing.body.error, /Nobody Here/);
    });

    test('unknown API routes and methods', async () => {
        assert.equal((await fetch(`${srv.base}/api/nope`)).status, 404);
        assert.equal((await fetch(`${srv.base}/api`)).status, 404);
        const res = await fetch(`${srv.base}/api/rankings`, { method: 'PUT' });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'GET, HEAD');
        assert.equal((await fetch(`${srv.base}/api/health`, { method: 'DELETE' })).status, 405);
    });

    test('static files: MIME, caching, ETag/304, gzip, HEAD', async () => {
        const css = await fetch(`${srv.base}/css/base.css`);
        assert.equal(css.status, 200);
        assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
        assert.equal(css.headers.get('cache-control'), 'public, max-age=3600');
        const etag = css.headers.get('etag');
        assert.match(etag, /^"[\w-]+"$/);
        assert.match(await css.text(), /color: red/);
        const notModified = await raw(srv.base, { path: '/css/base.css', headers: { 'If-None-Match': etag } });
        assert.equal(notModified.status, 304);
        assert.equal(notModified.body.length, 0);
        const gz = await raw(srv.base, { path: '/css/base.css', headers: { 'Accept-Encoding': 'gzip, br' } });
        assert.equal(gz.headers['content-encoding'], 'gzip');
        assert.match(gunzipSync(gz.body).toString(), /color: red/);
        const gz304 = await raw(srv.base, { path: '/css/base.css', headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': gz.headers.etag } });
        assert.equal(gz304.status, 304);
        const svg = await fetch(`${srv.base}/img/favicon.svg`);
        assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
        const cfg = await fetch(`${srv.base}/config.json`);
        assert.equal(cfg.headers.get('cache-control'), 'no-cache');
        const head = await raw(srv.base, { method: 'HEAD', path: '/css/base.css' });
        assert.equal(head.status, 200);
        assert.equal(head.body.length, 0);
        assert.ok(Number(head.headers['content-length']) > 1000);
        assert.equal((await fetch(`${srv.base}/css/base.css`, { method: 'POST' })).status, 405);
    });

    test('SPA fallback injects the base tag', async () => {
        for (const p of ['/', '/index.html', '/rankings', '/rankings/overall', '/rankings/history', '/rankings/history/2',
            '/profile/Player1', '/profile/Some%20Name?x=1']) {
            const res = await fetch(`${srv.base}${p}`);
            assert.equal(res.status, 200, p);
            assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
            assert.equal(res.headers.get('cache-control'), 'no-cache');
            const text = await res.text();
            assert.ok(text.includes('<meta charset="utf-8"><base href="/"><meta name="app-mode" content="live"><title>'), p);
            assert.equal(text.includes('<!--app-base-->'), false);
        }
        const unknown = await fetch(`${srv.base}/some/other/page`);
        assert.equal(unknown.status, 200); // client router shows "Page not found"
        assert.match(await unknown.text(), /<base href="\/">/);
        const missingFile = await fetch(`${srv.base}/css/missing.css`);
        assert.equal(missingFile.status, 404);
        assert.match(missingFile.headers.get('content-type'), /^text\/plain/);
    });

    test('path traversal and dotfiles are blocked', async () => {
        for (const p of ['/../package.json', '/..%2fpackage.json', '/css/..%2F..%2Fserver.js', '/%2e%2e/%2e%2e/etc/passwd',
            '/css/%2e%2e/%2e%2e/data/games.json', '/..\\..\\server.js', '/%00', '/%E0%A4%A']) {
            const res = await raw(srv.base, { path: p });
            assert.ok(res.status === 400 || res.status === 404, `${p} -> ${res.status}`);
            assert.equal(res.body.toString().includes('"number"'), false);
            assert.equal(res.body.toString().includes('import'), false);
        }
        assert.equal((await raw(srv.base, { path: '/.secret' })).status, 404);
    });

    test('POST /api/games: auth, validation, duplicates, size limit, success', async () => {
        assert.equal((await post(srv.base, freshGame(10), null)).status, 401);
        const wrong = await post(srv.base, freshGame(10), 'nope');
        assert.equal(wrong.status, 401);
        assert.equal(wrong.headers.get('www-authenticate'), 'Bearer');
        assert.equal((await post(srv.base, freshGame(10), `${KEY}x`)).status, 401);
        assert.equal((await post(srv.base, freshGame(10), null, { Authorization: KEY })).status, 401);

        const badJson = await json(await post(srv.base, '{"oops":'));
        assert.equal(badJson.status, 400);
        assert.equal(badJson.body.error, 'Body must be valid JSON');

        const invalid = await json(await post(srv.base, { mode: 'battle royale', teams: [] }));
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, 'Invalid game');
        assert.ok(invalid.body.details.length >= 3);
        assert.ok(invalid.body.details.some((d) => d.startsWith('mode:')));

        const created = await post(srv.base, freshGame(10));
        assert.equal(created.status, 201);
        assert.deepEqual(await created.json(), { number: 10 });
        assert.equal(created.headers.get('location'), '/api/games/10');

        const health = await json(await fetch(`${srv.base}/api/health`));
        assert.equal(health.body.games, 4);
        const rankings = await json(await fetch(`${srv.base}/api/rankings`));
        assert.ok(rankings.body.players.some((p) => p.events === 4 || p.events === 3));
        assert.equal((await json(await fetch(`${srv.base}/api/games?limit=1`))).body.games[0].number, 10);

        const dupNumber = await json(await post(srv.base, freshGame(10, 5 * MIN)));
        assert.equal(dupNumber.status, 409);
        assert.equal(dupNumber.body.number, 10);
        const { number: _n, ...retry } = freshGame(10);
        // same content without a number = plugin retry -> 409
        const retried = await json(await post(srv.base, { ...retry, startedAt: (await json(await fetch(`${srv.base}/api/games/10`))).body.startedAt,
            endedAt: (await json(await fetch(`${srv.base}/api/games/10`))).body.endedAt }));
        assert.equal(retried.status, 409);

        const { number: _m, ...auto } = freshGame(0, 30 * MIN);
        const autoRes = await json(await post(srv.base, auto));
        assert.equal(autoRes.status, 201);
        assert.equal(autoRes.body.number, 11);

        const saved = JSON.parse(await readFile(path.join(dir, 'data', 'games.json'), 'utf8'));
        assert.deepEqual(saved.map((g) => g.number), [1, 2, 3, 10, 11]);

        const huge = await raw(srv.base, {
            method: 'POST', path: '/api/games',
            headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Content-Length': 1024 * 1024 + 10 },
            body: Buffer.alloc(1024 * 1024 + 10, 32)
        });
        assert.equal(huge.status, 413);
        assert.match(JSON.parse(huge.body.toString()).error, /too large/);
        const chunked = await raw(srv.base, {
            method: 'POST', path: '/api/games',
            headers: { Authorization: `Bearer ${KEY}`, 'Transfer-Encoding': 'chunked' },
            body: Buffer.alloc(1024 * 1024 + 10, 32)
        });
        assert.equal(chunked.status, 413);
    });

    test('DELETE /api/games/:number', async () => {
        const del = (n, key = KEY) => fetch(`${srv.base}/api/games/${n}`, { method: 'DELETE', headers: key ? { Authorization: `Bearer ${key}` } : {} });
        assert.equal((await del(3, null)).status, 401);
        const ok = await del(3);
        assert.equal(ok.status, 204);
        assert.equal((await ok.text()), '');
        assert.equal((await del(3)).status, 404);
        assert.equal((await del('abc')).status, 404);
        assert.equal((await fetch(`${srv.base}/api/games/3`)).status, 404);
        const saved = JSON.parse(await readFile(path.join(dir, 'data', 'games.json'), 'utf8'));
        assert.equal(saved.some((g) => g.number === 3), false);
    });

    test('data survives a restart', async () => {
        const second = await start({ publicDir: path.join(dir, 'public'), dataDir: path.join(dir, 'data'), apiKey: KEY });
        try {
            const health = await json(await fetch(`${second.base}/api/health`));
            assert.equal(health.body.games, 4);
        } finally {
            await second.close();
        }
    });
});

describe('writes disabled without EVENTS_API_KEY', () => {
    let dir;
    let srv;
    before(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pvp-nokey-'));
        await makePublic(path.join(dir, 'public'));
        srv = await start({ publicDir: path.join(dir, 'public'), dataDir: path.join(dir, 'data') });
    });
    after(async () => {
        await srv.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('POST and DELETE answer 503; empty league still serves', async () => {
        const res = await json(await post(srv.base, freshGame(1)));
        assert.equal(res.status, 503);
        assert.match(res.body.error, /EVENTS_API_KEY/);
        assert.equal((await fetch(`${srv.base}/api/games/1`, { method: 'DELETE' })).status, 503);
        const rankings = await json(await fetch(`${srv.base}/api/rankings`));
        assert.deepEqual(rankings.body.players, []);
        const games = await json(await fetch(`${srv.base}/api/games`));
        assert.deepEqual(games.body, { total: 0, more: false, games: [] });
    });
});

describe('demo mode', () => {
    let dir;
    let srv;
    const bootNow = Date.UTC(2031, 5, 1, 12, 0, 0);
    before(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'pvp-demo-'));
        await makePublic(path.join(dir, 'public'));
        srv = await start({ demo: true, publicDir: path.join(dir, 'public'), dataDir: path.join(dir, 'data'), apiKey: KEY, now: () => bootNow });
    });
    after(async () => {
        await srv.close();
        await rm(dir, { recursive: true, force: true });
    });

    test('serves demo data with timestamps shifted to ~45 minutes before boot', async () => {
        const health = await json(await fetch(`${srv.base}/api/health`));
        assert.deepEqual(health.body, { ok: true, mode: 'demo', games: 6, players: 8 });
        const cfg = await json(await fetch(`${srv.base}/api/config`));
        assert.equal(cfg.body.mode, 'demo');
        const games = await json(await fetch(`${srv.base}/api/games`));
        assert.equal(games.body.games[0].endedAt, bootNow - DEMO_OFFSET_MS);
        const page = await fetch(`${srv.base}/rankings`);
        assert.match(await page.text(), /<meta name="app-mode" content="live">/);
    });

    test('is read-only even with a valid key', async () => {
        const res = await json(await post(srv.base, freshGame(50)));
        assert.equal(res.status, 503);
        assert.match(res.body.error, /demo/);
        const del = await fetch(`${srv.base}/api/games/1`, { method: 'DELETE', headers: { Authorization: `Bearer ${KEY}` } });
        assert.equal(del.status, 503);
        assert.equal((await json(await fetch(`${srv.base}/api/health`))).body.games, 6);
    });

    test('fails fast with a helpful message when demo data is missing', async () => {
        await assert.rejects(createServer({ demo: true, log: quiet, publicDir: path.join(dir, 'nowhere') }), /npm run seed/);
    });
});

describe('real public/ folder', () => {
    test('index.html has the app-base placeholder and the demo data builds', async (t) => {
        const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
        let html;
        try {
            html = await readFile(path.join(root, 'index.html'), 'utf8');
        } catch {
            t.skip('public/index.html not written yet');
            return;
        }
        assert.ok(html.includes('<!--app-base-->'));
        const srv = await start({ demo: true });
        try {
            const res = await fetch(`${srv.base}/rankings/overall`);
            assert.equal(res.status, 200);
            assert.match(await res.text(), /<base href="\/">/);
            const health = await json(await fetch(`${srv.base}/api/health`));
            assert.equal(health.body.mode, 'demo');
            assert.ok(health.body.games >= 100);
        } finally {
            await srv.close();
        }
    });
});

