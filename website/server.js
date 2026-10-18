#!/usr/bin/env node
// HTTP server: static files + SPA fallback + JSON API. Node >= 18, no dependencies.
//   node server.js            live mode, games in DATA_DIR/games.json
//   node server.js --demo     read-only demo data from public/demo/games.json
// Env: PORT (8080), HOST (0.0.0.0), DATA_DIR (./data), EVENTS_API_KEY, DEMO=1, LOG_REQUESTS=1
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { mergeConfig } from './public/js/shared/defaults.js';
import { buildLeague, shiftTimestamps } from './public/js/shared/league.js';
import {
    configResponse, gameResponse, gamesPage, healthResponse, profileResponse, rankingsResponse
} from './public/js/shared/model.js';
import { createMemoryStore, loadGamesFile, openFileStore, StoreError } from './lib/store.js';
import { validateGame } from './lib/validate.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const BODY_LIMIT = 1024 * 1024;
export const DEMO_OFFSET_MS = 45 * 60 * 1000;
const GZIP_MIN = 1024;
const APP_BASE = '<!--app-base-->';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
};
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.map', '.webmanifest', '.svg', '.txt', '.xml']);
const NO_CACHE = new Set(['.html', '.json', '.webmanifest']);

const BASE_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
};

class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

function sha1(buf) {
    return createHash('sha1').update(buf).digest('base64url').slice(0, 20);
}

function acceptsGzip(req) {
    const header = String(req.headers['accept-encoding'] || '');
    for (const part of header.split(',')) {
        const [name, ...params] = part.trim().toLowerCase().split(';');
        if (name !== 'gzip' && name !== '*') continue;
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        if (!q || Number(q.slice(2)) > 0) return true;
    }
    return false;
}

function etagMatches(req, ...tags) {
    const header = req.headers['if-none-match'];
    if (!header) return false;
    if (header.trim() === '*') return true;
    const given = header.split(',').map((t) => t.trim().replace(/^W\//, ''));
    return tags.some((t) => given.includes(t));
}

// Writes a complete response; picks gzip when it helps; omits the body for HEAD.
function send(req, res, status, headers, body, { gzipBody = null, compressible = false } = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '', 'utf8');
    let payload = buf;
    const out = { ...BASE_HEADERS, ...headers };
    if (compressible && buf.length >= GZIP_MIN) {
        out.Vary = 'Accept-Encoding';
        if (acceptsGzip(req)) {
            payload = gzipBody || zlib.gzipSync(buf);
            out['Content-Encoding'] = 'gzip';
        }
    }
    out['Content-Length'] = payload.length;
    res.writeHead(status, out);
    res.end(req.method === 'HEAD' ? undefined : payload);
}

function sendJson(req, res, status, data, headers = {}, gzipBody = null) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    send(req, res, status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
    }, body, { compressible: true, gzipBody });
}

function sendText(req, res, status, text, headers = {}) {
    send(req, res, status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
    }, `${text}\n`);
}

function safeEqual(a, b) {
    // Hash first so both buffers have the same length; compare in constant time.
    const ha = createHash('sha256').update(String(a)).digest();
    const hb = createHash('sha256').update(String(b)).digest();
    return timingSafeEqual(ha, hb);
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            reject(new HttpError(413, `Body too large (max ${limit} bytes)`));
            return;
        }
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = (err, value) => {
            if (done) return;
            done = true;
            req.removeListener('data', onData);
            if (err) {
                req.resume(); // discard the rest
                reject(err);
            } else {
                resolve(value);
            }
        };
        const onData = (chunk) => {
            size += chunk.length;
            if (size > limit) finish(new HttpError(413, `Body too large (max ${limit} bytes)`));
            else chunks.push(chunk);
        };
        req.on('data', onData);
        req.on('end', () => finish(null, Buffer.concat(chunks)));
        req.on('error', (err) => finish(new HttpError(400, `Could not read body: ${err.message}`)));
        req.on('close', () => finish(new HttpError(400, 'Request aborted')));
    });
}

// Opt-in for GET/HEAD clients: `X-Soft-404: 1` turns an API 404 into 200 { error, notFound: true }.
function wantsSoft404(req) {
    return (req.method === 'GET' || req.method === 'HEAD') && /^(1|true)$/i.test(String(req.headers['x-soft-404'] || ''));
}

function isSpaRoute(p) {
    return p === '/' || p === '/index.html' || p === '/rankings' || p.startsWith('/rankings/')
        || p === '/profile' || p.startsWith('/profile/');
}

function injectBase(html) {
    const tag = '<base href="/"><meta name="app-mode" content="live">';
    if (html.includes(APP_BASE)) return html.replace(APP_BASE, tag);
    // Fallback if the placeholder was removed: put it right after <head>.
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : tag + html;
}

async function readConfig(publicDir, log) {
    const file = path.join(publicDir, 'config.json');
    try {
        return mergeConfig(JSON.parse(await readFile(file, 'utf8')));
    } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[config] ${file} could not be read (${err.message}); using defaults`);
        return mergeConfig({});
    }
}

export async function createApp(options = {}) {
    const {
        demo = false,
        publicDir = path.join(ROOT, 'public'),
        dataDir = path.join(ROOT, 'data'),
        demoFile = path.join(publicDir, 'demo', 'games.json'),
        apiKey = '',
        now = () => Date.now(),
        log = console,
        logRequests = false
    } = options;
    const mode = demo ? 'demo' : 'live';
    const root = path.resolve(publicDir);
    const config = await readConfig(root, log);

    let store;
    if (demo) {
        let games;
        try {
            games = await loadGamesFile(demoFile);
        } catch (err) {
            if (err.code === 'ENOENT') throw new Error(`Demo data not found at ${demoFile}. Run "npm run seed" first.`);
            throw err;
        }
        store = createMemoryStore(shiftTimestamps(games, now() - DEMO_OFFSET_MS), { readOnly: true });
    } else {
        store = await openFileStore(dataDir);
    }

    // League + lazily built response caches, replaced on every write.
    let state;
    const rebuild = () => {
        const league = buildLeague(store.all(), config, { now: now() });
        state = { league, rankings: null };
        return league;
    };
    rebuild();

    const rankingsCache = () => {
        if (!state.rankings) {
            const json = JSON.stringify(rankingsResponse(state.league));
            const buf = Buffer.from(json, 'utf8');
            state.rankings = { json, gz: buf.length >= GZIP_MIN ? zlib.gzipSync(buf) : null };
        }
        return state.rankings;
    };

    const configJson = JSON.stringify({ ...configResponse(config), mode });

    function authorize(req) {
        if (demo) throw new HttpError(503, 'Writes are disabled in demo mode');
        if (!apiKey) throw new HttpError(503, 'Writes are disabled: set EVENTS_API_KEY on the server');
        const match = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization || '').trim());
        if (!match || !safeEqual(match[1], apiKey)) throw new HttpError(401, 'Missing or invalid API key');
    }

    function parseNumber(segment) {
        return /^\d{1,9}$/.test(segment) ? Number(segment) : null;
    }

    async function handleApi(req, res, segments, query) {
        const method = req.method === 'HEAD' ? 'GET' : req.method;
        const allow = (methods) => {
            if (!methods.includes(method)) {
                throw Object.assign(new HttpError(405, `Method ${req.method} not allowed`), {
                    headers: { Allow: methods.includes('GET') ? [...methods, 'HEAD'].join(', ') : methods.join(', ') }
                });
            }
        };
        const [resource, id, ...extra] = segments;
        if (extra.length) throw new HttpError(404, 'Unknown API endpoint');

        if (resource === 'health' && id === undefined) {
            allow(['GET']);
            return sendJson(req, res, 200, healthResponse(state.league, mode));
        }
        if (resource === 'config' && id === undefined) {
            allow(['GET']);
            return sendJson(req, res, 200, configJson);
        }
        if (resource === 'rankings' && id === undefined) {
            allow(['GET']);
            const cached = rankingsCache();
            return sendJson(req, res, 200, cached.json, {}, cached.gz);
        }
        if (resource === 'games' && id === undefined) {
            allow(['GET', 'POST']);
            if (method === 'GET') {
                return sendJson(req, res, 200, gamesPage(state.league, {
                    before: query.get('before') ?? undefined,
                    limit: query.get('limit') ?? undefined
                }));
            }
            authorize(req);
            const body = await readBody(req, BODY_LIMIT);
            let raw;
            try {
                raw = JSON.parse(body.toString('utf8'));
            } catch (err) {
                throw new HttpError(400, 'Body must be valid JSON', [err.message]);
            }
            const result = validateGame(raw, { now: now() });
            if (!result.ok) throw new HttpError(400, 'Invalid game', result.errors);
            let number;
            try {
                number = await store.add(result.game);
            } catch (err) {
                if (err instanceof StoreError && err.code === 'DUPLICATE') {
                    return sendJson(req, res, 409, { error: err.message, number: err.number });
                }
                throw err;
            }
            rebuild();
            log.info?.(`[api] stored game #${number}`);
            return sendJson(req, res, 201, { number }, { Location: `/api/games/${number}` });
        }
        if (resource === 'games' && id !== undefined) {
            allow(['GET', 'DELETE']);
            const number = parseNumber(id);
            if (method === 'GET') {
                const game = number === null ? null : gameResponse(state.league, number);
                if (!game) throw new HttpError(404, `Game #${id} not found`);
                return sendJson(req, res, 200, game);
            }
            authorize(req);
            if (number === null || !(await store.remove(number))) throw new HttpError(404, `Game #${id} not found`);
            rebuild();
            log.info?.(`[api] deleted game #${number}`);
            res.writeHead(204, { ...BASE_HEADERS, 'Cache-Control': 'no-store' });
            return res.end();
        }
        if (resource === 'profile' && id !== undefined && id !== '') {
            allow(['GET']);
            const profile = profileResponse(state.league, id, { now: now() });
            if (!profile) throw new HttpError(404, `Player "${id}" not found`);
            return sendJson(req, res, 200, profile);
        }
        throw new HttpError(404, 'Unknown API endpoint');
    }

    // In-memory cache of static files, revalidated against mtime/size.
    const fileCache = new Map();
    async function loadFile(file, info) {
        const hit = fileCache.get(file);
        if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit;
        const ext = path.extname(file).toLowerCase();
        let body = await readFile(file);
        if (file === path.join(root, 'index.html')) body = Buffer.from(injectBase(body.toString('utf8')), 'utf8');
        const entry = {
            mtimeMs: info.mtimeMs,
            size: info.size,
            ext,
            body,
            etag: `"${sha1(body)}"`,
            gz: COMPRESSIBLE.has(ext) && body.length >= GZIP_MIN ? zlib.gzipSync(body) : null
        };
        if (fileCache.size > 500) fileCache.clear();
        fileCache.set(file, entry);
        return entry;
    }

    async function statFile(file) {
        try {
            const info = await stat(file);
            return info.isFile() ? info : null;
        } catch {
            return null;
        }
    }

    async function serveFile(req, res, file, info, status = 200) {
        const entry = await loadFile(file, info);
        const gzip = entry.gz && acceptsGzip(req);
        const etag = gzip ? entry.etag.replace(/"$/, '-gz"') : entry.etag;
        const headers = {
            'Content-Type': MIME[entry.ext] || 'application/octet-stream',
            'Cache-Control': NO_CACHE.has(entry.ext) ? 'no-cache' : 'public, max-age=3600',
            ETag: etag
        };
        if (status === 200 && etagMatches(req, entry.etag, entry.etag.replace(/"$/, '-gz"'))) {
            const h304 = { ...BASE_HEADERS, ETag: etag, 'Cache-Control': headers['Cache-Control'] };
            if (entry.gz) h304.Vary = 'Accept-Encoding';
            res.writeHead(304, h304);
            return res.end();
        }
        return send(req, res, status, headers, entry.body, { compressible: Boolean(entry.gz), gzipBody: entry.gz });
    }

    async function serveShell(req, res, status) {
        const file = path.join(root, 'index.html');
        const info = await statFile(file);
        if (!info) return sendText(req, res, 503, 'public/index.html is missing');
        return serveFile(req, res, file, info, status);
    }

    async function handleStatic(req, res, rawPath) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            throw Object.assign(new HttpError(405, `Method ${req.method} not allowed`), { headers: { Allow: 'GET, HEAD' } });
        }
        let decoded;
        try {
            decoded = decodeURIComponent(rawPath);
        } catch {
            throw new HttpError(400, 'Malformed URL');
        }
        const parts = decoded.split(/[\\/]+/);
        if (decoded.includes('\0') || parts.includes('..')) throw new HttpError(400, 'Invalid path');
        if (parts.some((p) => p.startsWith('.'))) throw new HttpError(404, 'Not found');

        if (decoded === '/' || decoded === '/index.html') return serveShell(req, res, 200);
        const file = path.resolve(root, `.${decoded}`);
        if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(400, 'Invalid path');
        const info = decoded.endsWith('/') ? null : await statFile(file);
        if (info) return serveFile(req, res, file, info);
        const last = parts[parts.length - 1] || '';
        if (!isSpaRoute(decoded) && path.extname(last)) throw new HttpError(404, 'Not found');
        // Everything else is an app route; the client router renders "Page not found".
        return serveShell(req, res, 200);
    }

    async function handle(req, res) {
        if (logRequests) {
            const started = Date.now();
            res.once('finish', () => log.info?.(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
        }
        let rawUrl = req.url || '/';
        if (/^https?:\/\//i.test(rawUrl)) {
            try {
                const u = new URL(rawUrl);
                rawUrl = u.pathname + u.search;
            } catch {
                rawUrl = '/';
            }
        }
        const qi = rawUrl.indexOf('?');
        const rawPath = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
        const query = new URLSearchParams(qi === -1 ? '' : rawUrl.slice(qi + 1));
        const isApi = rawPath === '/api' || rawPath.startsWith('/api/');
        try {
            if (!rawPath.startsWith('/')) throw new HttpError(400, 'Bad request');
            if (isApi) {
                const segments = rawPath.slice(5).split('/');
                if (segments.length && segments[segments.length - 1] === '') segments.pop();
                let decoded;
                try {
                    decoded = segments.map((s) => decodeURIComponent(s));
                } catch {
                    throw new HttpError(400, 'Malformed URL');
                }
                await handleApi(req, res, decoded, query);
            } else {
                await handleStatic(req, res, rawPath);
            }
        } catch (err) {
            if (res.headersSent) {
                res.destroy();
            } else {
                const status = err instanceof HttpError ? err.status : 500;
                if (status >= 500 && !(err instanceof HttpError)) log.error(`[server] ${req.method} ${req.url} failed:`, err);
                const headers = { ...(err.headers || {}) };
                if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
                if (status === 413) headers.Connection = 'close';
                const message = err instanceof HttpError ? err.message : 'Internal server error';
                if (isApi && status === 404 && wantsSoft404(req)) {
                    // The web UI asks for not-found as 200 + { notFound: true } so browsers
                    // don't log a console error on every "Player not found" page.
                    sendJson(req, res, 200, { error: message, notFound: true }, headers);
                } else if (isApi) {
                    const body = { error: message };
                    if (err.details) body.details = err.details;
                    sendJson(req, res, status, body, headers);
                } else {
                    sendText(req, res, status, status === 404 ? 'Not found' : message, headers);
                }
            }
        }
    }

    return {
        mode,
        config,
        store,
        log,
        handle,
        rebuild,
        get league() {
            return state.league;
        },
        flush: () => store.flush()
    };
}

export async function createServer(options = {}) {
    const app = await createApp(options);
    const server = http.createServer((req, res) => {
        app.handle(req, res).catch((err) => {
            app.log.error('[server] unhandled request error:', err);
            res.destroy();
        });
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 5000;
    server.app = app;
    return server;
}

// Starts listening; resolves with { server, app, url, close }.
export async function startServer({ port = 8080, host = '0.0.0.0', ...options } = {}) {
    const server = await createServer(options);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const address = server.address();
    const shownHost = !host || host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
    return {
        server,
        app: server.app,
        port: address.port,
        url: `http://${shownHost}:${address.port}/`,
        close: () => new Promise((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections?.();
        })
    };
}

function parseArgs(argv) {
    const args = { demo: false, port: undefined };
    for (const arg of argv) {
        if (arg === '--demo') args.demo = true;
        else if (arg.startsWith('--port=')) args.port = Number(arg.slice(7));
        else if (arg === '--help' || arg === '-h') args.help = true;
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node server.js [--demo] [--port=N]\nEnv: PORT, HOST, DATA_DIR, EVENTS_API_KEY, DEMO=1, LOG_REQUESTS=1');
        return;
    }
    const env = process.env;
    const demo = args.demo || /^(1|true|yes|on)$/i.test(env.DEMO || '');
    const port = Number.isInteger(args.port) ? args.port : env.PORT !== undefined && env.PORT !== '' ? Number(env.PORT) : 8080;
    const host = env.HOST || '0.0.0.0';
    const dataDir = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(ROOT, 'data');
    const apiKey = env.EVENTS_API_KEY || '';

    let running;
    try {
        running = await startServer({
            port, host, demo, dataDir, apiKey, logRequests: /^(1|true|yes|on)$/i.test(env.LOG_REQUESTS || '')
        });
    } catch (err) {
        if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Set PORT to use another one.`);
        else console.error(`Failed to start: ${err.message}`);
        process.exit(1);
    }
    const { app, url, server } = running;
    const league = app.league;
    const source = demo ? 'public/demo/games.json (in memory, read-only, times shifted to now)' : app.store.file;
    const writes = demo ? 'disabled (demo mode)'
        : apiKey ? 'enabled: POST/DELETE /api/games with "Authorization: Bearer $EVENTS_API_KEY"'
            : 'disabled: set EVENTS_API_KEY to accept POST /api/games';
    console.log([
        '',
        `  ${app.config.siteName} server`,
        `  mode     ${app.mode}`,
        `  data     ${source}`,
        `  league   ${league.games.length} ranked games, ${league.ranked.length} players`,
        `  writes   ${writes}`,
        `  url      ${url}`,
        ''
    ].join('\n'));
    if (!demo && league.games.length === 0) {
        console.log('  No games yet. Try "npm run demo", or seed live data: node scripts/seed.js --out data/games.json --now now\n');
    }

    let closing = false;
    const shutdown = (signal) => {
        if (closing) process.exit(1);
        closing = true;
        console.log(`\n${signal} received, shutting down...`);
        setTimeout(() => process.exit(1), 5000).unref();
        server.close(async () => {
            try {
                await app.flush();
            } finally {
                process.exit(0);
            }
        });
        server.closeIdleConnections?.();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
