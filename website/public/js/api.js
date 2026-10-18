// Data source. Live: the server's JSON API. Demo: the same league engine and response
// builders running in the browser over public/demo/games.json (no server needed).

const DEMO_LAG_MS = 45 * 60 * 1000; // newest demo game "ended" 45 minutes ago

function httpError(status, message) {
    const err = new Error(message || `Request failed (${status})`);
    err.status = status;
    return err;
}

const url = (path) => new URL(path, document.baseURI).toString();

async function getJson(path) {
    let res;
    try {
        // X-Soft-404: the server answers "not found" as 200 { notFound: true }, so a missing
        // player or game doesn't print a network error in the browser console
        res = await fetch(url(path), { cache: 'no-store', headers: { Accept: 'application/json', 'X-Soft-404': '1' } });
    } catch (cause) {
        const err = httpError(0, 'Could not reach the server. Check your connection and try again.');
        err.cause = cause;
        throw err;
    }
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) throw httpError(res.status, body?.error || (res.status === 404 ? 'Not found' : `Request failed (${res.status})`));
    if (body && body.notFound === true) throw httpError(404, body.error || 'Not found');
    if (body === null) throw httpError(res.status, 'The server sent an invalid response.');
    return body;
}

function createLiveApi() {
    return {
        mode: 'live',
        config: () => getJson('api/config'),
        health: () => getJson('api/health'),
        rankings: () => getJson('api/rankings'),
        games({ before, limit } = {}) {
            const sp = new URLSearchParams();
            if (before !== undefined && before !== null && before !== '') sp.set('before', String(before));
            if (limit !== undefined && limit !== null && limit !== '') sp.set('limit', String(limit));
            const qs = sp.toString();
            return getJson(`api/games${qs ? `?${qs}` : ''}`);
        },
        game: (number) => getJson(`api/games/${encodeURIComponent(number)}`),
        profile: (key) => getJson(`api/profile/${encodeURIComponent(key)}`),
    };
}

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

function createDemoApi() {
    let loading = null;

    async function fetchStatic(path) {
        let res;
        try {
            res = await fetch(url(path), { cache: 'no-cache' });
        } catch (cause) {
            const err = httpError(0, `Could not load ${path}.`);
            err.cause = cause;
            throw err;
        }
        if (!res.ok) throw httpError(res.status, `Could not load ${path} (${res.status}).`);
        return res.json();
    }

    // Loads config + demo games once and builds the league (memoised; retried after a failure).
    function engine() {
        if (!loading) {
            loading = (async () => {
                const [defaults, leagueMod, model] = await Promise.all([
                    import('./shared/defaults.js'),
                    import('./shared/league.js'),
                    import('./shared/model.js'),
                ]);
                const [userConfig, rawGames] = await Promise.all([
                    fetchStatic('config.json').catch((err) => {
                        console.warn('config.json unavailable, using defaults:', err.message);
                        return {};
                    }),
                    fetchStatic('demo/games.json'),
                ]);
                const games = Array.isArray(rawGames) ? rawGames : (rawGames?.games || []);
                const config = defaults.mergeConfig(userConfig);
                const now = Date.now();
                const shifted = leagueMod.shiftTimestamps(games, now - DEMO_LAG_MS);
                const league = leagueMod.buildLeague(shifted, config, { now });
                return { config, league, model };
            })();
            loading.catch(() => { loading = null; });
        }
        return loading;
    }

    const answer = async (fn) => clone(fn(await engine()));

    return {
        mode: 'demo',
        config: () => answer(({ config, model }) => ({ ...model.configResponse(config), mode: 'demo' })),
        health: () => answer(({ league }) => ({ ok: true, mode: 'demo', games: league.games.length, players: league.ranked.length })),
        rankings: () => answer(({ league, model }) => model.rankingsResponse(league)),
        games: ({ before, limit } = {}) => answer(({ league, model }) => model.gamesPage(league, {
            before: before === undefined || before === null || before === '' ? undefined : Number(before),
            limit: limit === undefined || limit === null || limit === '' ? undefined : Number(limit),
        })),
        game: (number) => answer(({ league, model }) => {
            const n = Number(number);
            const res = Number.isInteger(n) ? model.gameResponse(league, n) : null;
            if (!res) throw httpError(404, `Game #${number} not found`);
            return res;
        }),
        profile: (key) => answer(({ league, model }) => {
            const res = key ? model.profileResponse(league, String(key), { now: Date.now() }) : null;
            if (!res) throw httpError(404, `Player "${key}" not found`);
            return res;
        }),
    };
}

/** createApi('live' | 'demo') → { mode, config(), health(), rankings(), games({before, limit}), game(n), profile(key) } */
export function createApi(mode) {
    return mode === 'live' ? createLiveApi() : createDemoApi();
}
