// Game stores: a JSON file on disk (live) or a read-only in-memory list (demo).
// Both expose: kind, readOnly, file, all(), count, has(n), get(n), add(game),
// remove(n), flush().
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export class StoreError extends Error {
    constructor(message, code, extra = {}) {
        super(message);
        this.name = 'StoreError';
        this.code = code; // READ_ONLY | DUPLICATE | CORRUPT
        Object.assign(this, extra);
    }
}

// Cheap identity of a game, used to catch plugin retries that omit `number`.
function fingerprint(g) {
    const winners = Array.isArray(g?.teams)
        ? (g.teams.find((t) => t && t.placement === 1)?.players || []).map((p) => String(p?.uuid).toLowerCase().replace(/-/g, '')).sort().join(',')
        : '';
    return `${g?.mode}|${g?.startedAt}|${g?.endedAt}|${Array.isArray(g?.teams) ? g.teams.length : 0}|${winners}`;
}

function serialise(games) {
    // One game per line keeps the file diff-friendly and still compact.
    return games.length ? `[\n${games.map((g) => JSON.stringify(g)).join(',\n')}\n]\n` : '[]\n';
}

// Gives games with a missing, invalid or repeated number (hand-edited or imported files) the
// numbers after the current maximum, oldest first: the same numbers buildLeague would show.
// Returns the input array when nothing needs changing, otherwise a new array.
export function normaliseNumbers(games) {
    const used = new Set();
    let max = 0;
    for (const g of games) {
        const n = Number(g.number);
        if (Number.isSafeInteger(n) && n > 0) max = Math.max(max, n);
    }
    const fix = [];
    games.forEach((g, i) => {
        const n = Number(g.number);
        const ok = Number.isSafeInteger(n) && n > 0 && !used.has(n);
        if (ok) used.add(n);
        if (!ok || n !== g.number) fix.push({ i, number: ok ? n : null }); // "12" -> 12; missing/repeat -> new
    });
    if (!fix.length) return games;
    const time = (g) => Number(g.endedAt) || Number(g.startedAt) || 0;
    const fresh = fix.filter((f) => f.number === null).sort((a, b) => time(games[a.i]) - time(games[b.i]) || a.i - b.i);
    for (const f of fresh) f.number = ++max;
    const out = games.slice();
    for (const f of fix) {
        const { number: _old, ...rest } = games[f.i];
        out[f.i] = { number: f.number, ...rest };
    }
    return out;
}

export function parseGamesJson(text, source = 'games.json') {
    let data;
    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new StoreError(`${source} is not valid JSON (${err.message}). Fix or move the file; it was not modified.`, 'CORRUPT');
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.games) ? data.games : null;
    if (!list) throw new StoreError(`${source} must contain a JSON array of games`, 'CORRUPT');
    return list.filter((g) => g && typeof g === 'object' && !Array.isArray(g));
}

class BaseStore {
    constructor(games, { readOnly, kind, file = null }) {
        this.kind = kind;
        this.readOnly = readOnly;
        this.file = file;
        this.games = games;
        this.index();
    }

    index() {
        this.numbers = new Map();
        this.prints = new Map();
        this.maxNumber = 0;
        for (const g of this.games) {
            const n = Number(g.number);
            if (Number.isInteger(n) && n > 0) {
                if (!this.numbers.has(n)) this.numbers.set(n, g);
                this.maxNumber = Math.max(this.maxNumber, n);
            }
            const fp = fingerprint(g);
            if (!this.prints.has(fp)) this.prints.set(fp, g);
        }
    }

    all() {
        return this.games;
    }

    get count() {
        return this.games.length;
    }

    has(number) {
        return this.numbers.has(Number(number));
    }

    get(number) {
        return this.numbers.get(Number(number)) || null;
    }

    checkWritable() {
        if (this.readOnly) throw new StoreError('This store is read-only', 'READ_ONLY');
    }

    // Validated game -> stored copy with a number. Throws DUPLICATE for a resend of a stored
    // game (same mode, times, team count and winners). A different game whose number is
    // already taken (plugin counter reset, two arenas counting from 1) gets the next free one.
    prepare(game) {
        this.checkWritable();
        const existing = this.prints.get(fingerprint(game));
        if (existing) {
            throw new StoreError(`This game was already recorded as #${existing.number}`, 'DUPLICATE', { number: existing.number });
        }
        if (game.number !== undefined && game.number !== null && !this.numbers.has(game.number)) {
            return { ...game };
        }
        const { number: _taken, ...rest } = game;
        return { number: this.maxNumber + 1, ...rest };
    }

    async add(game) {
        const stored = this.prepare(game);
        this.games.push(stored);
        this.index();
        return stored.number;
    }

    async remove(number) {
        this.checkWritable();
        const n = Number(number);
        const before = this.games.length;
        this.games = this.games.filter((g) => Number(g.number) !== n);
        if (this.games.length === before) return false;
        this.index();
        return true;
    }

    async flush() {}
}

export function createMemoryStore(games = [], { readOnly = true } = {}) {
    const list = Array.isArray(games) ? [...games] : [];
    return new BaseStore(readOnly ? list : normaliseNumbers(list), { readOnly, kind: 'memory' });
}

class FileStore extends BaseStore {
    constructor(games, file) {
        super(games, { readOnly: false, kind: 'file', file });
        this.queue = Promise.resolve();
        this.tmpCounter = 0;
    }

    // Serialise writes so concurrent requests cannot interleave.
    enqueue(task) {
        const run = this.queue.then(task, task);
        this.queue = run.catch(() => {});
        return run;
    }

    async write(games) {
        await mkdir(path.dirname(this.file), { recursive: true });
        const tmp = path.join(path.dirname(this.file),
            `.${path.basename(this.file)}.${process.pid}.${++this.tmpCounter}.tmp`);
        const handle = await open(tmp, 'w');
        try {
            await handle.writeFile(serialise(games), 'utf8');
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await rename(tmp, this.file);
        } catch (err) {
            await unlink(tmp).catch(() => {});
            throw err;
        }
    }

    add(game) {
        return this.enqueue(async () => {
            const stored = this.prepare(game);
            const next = [...this.games, stored];
            await this.write(next);
            this.games = next;
            this.index();
            return stored.number;
        });
    }

    remove(number) {
        return this.enqueue(async () => {
            const n = Number(number);
            const next = this.games.filter((g) => Number(g.number) !== n);
            if (next.length === this.games.length) return false;
            await this.write(next);
            this.games = next;
            this.index();
            return true;
        });
    }

    flush() {
        return this.queue;
    }
}

// Opens (without creating) dataDir/games.json. A missing file is an empty store. Missing or
// repeated numbers are fixed in memory (saved with the next write), so the store, the site
// and DELETE all agree on every game's number.
export async function openFileStore(dataDir, { fileName = 'games.json' } = {}) {
    const file = path.resolve(dataDir, fileName);
    let games = [];
    try {
        games = parseGamesJson(await readFile(file, 'utf8'), file);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
    }
    return new FileStore(normaliseNumbers(games), file);
}

export async function loadGamesFile(file) {
    return parseGamesJson(await readFile(file, 'utf8'), file);
}
