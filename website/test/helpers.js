// Shared test fixtures (not a test file itself).

export const T0 = Date.UTC(2026, 9, 1, 18, 0, 0);
export const MIN = 60 * 1000;

// Deterministic, valid v4-shaped UUID for player i.
export function uuidFor(i) {
    return `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
}

// Tiny deterministic PRNG for randomised tests.
export function rng(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        return s / 4294967296;
    };
}

// teams: array (placement order, winner first) of arrays of player specs:
// a number i, or { i, kills, deaths, damage, name, uuid }.
export function makeGame(number, teams, opts = {}) {
    const startedAt = opts.startedAt ?? T0 + number * 30 * MIN;
    const endedAt = opts.endedAt ?? startedAt + 20 * MIN;
    const T = teams.length;
    return {
        number,
        mode: opts.mode ?? 'battle-royale',
        ...(opts.map === undefined ? { map: 'cherry_grove' } : opts.map === null ? {} : { map: opts.map }),
        teamSize: opts.teamSize ?? Math.max(...teams.map((t) => t.length)),
        startedAt,
        endedAt,
        ...(opts.ranked === undefined ? {} : { ranked: opts.ranked }),
        teams: teams.map((members, idx) => ({
            placement: idx + 1,
            eliminatedAt: idx === 0 ? null : endedAt - Math.round(((idx) / T) * (endedAt - startedAt)),
            players: members.map((m) => {
                const spec = typeof m === 'number' ? { i: m } : m;
                const p = {
                    uuid: spec.uuid ?? uuidFor(spec.i),
                    name: spec.name ?? `Player${spec.i}`,
                    kills: spec.kills ?? 0
                };
                if (spec.deaths !== undefined) p.deaths = spec.deaths;
                if (spec.damage !== undefined) p.damage = spec.damage;
                if (spec.skin !== undefined) p.skin = spec.skin;
                return p;
            })
        }))
    };
}

// Solo game: `order` lists player indices from winner to last place.
export function soloGame(number, order, kills = {}, opts = {}) {
    return makeGame(number, order.map((i) => [{ i, kills: kills[i] ?? 0 }]), { teamSize: 1, ...opts });
}

export const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

// Random but structurally valid games for property tests.
export function randomGames(count, { players = 50, seed = 7, minTeams = 4, maxTeams = 20, ranked = true } = {}) {
    const rand = rng(seed);
    const games = [];
    for (let n = 1; n <= count; n++) {
        const teamSize = 1 + Math.floor(rand() * 3);
        const T = minTeams + Math.floor(rand() * (maxTeams - minTeams + 1));
        const need = Math.min(players, T * teamSize);
        const pool = [];
        const used = new Set();
        while (pool.length < need) {
            const i = Math.floor(rand() * players);
            if (!used.has(i)) {
                used.add(i);
                pool.push(i);
            }
        }
        const teams = [];
        for (let t = 0; t * teamSize < pool.length; t++) {
            teams.push(pool.slice(t * teamSize, (t + 1) * teamSize).map((i) => ({ i, kills: Math.floor(rand() * 4), name: `P${i}` })));
        }
        if (teams.length < 2) continue;
        games.push(makeGame(n, teams, { teamSize, ranked: ranked === 'mixed' ? rand() > 0.1 : ranked }));
    }
    return games;
}
