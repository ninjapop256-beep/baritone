// Rankings view (/rankings/overall): top-3 podium, tier filter, live search and the full ladder.
// Rows are keyed DOM nodes (see patchList) so polling, search and filtering never rebuild
// unchanged rows; body skins are drawn lazily as rows approach the viewport.
import { html, setHtml, qs, on, patchList } from '../ui/dom.js';
import { skinImg } from '../ui/skins.js';
import { tierText, tierClass, placeText, countText } from '../ui/badges.js';
import { fmtInt, fmtDec, plural } from '../ui/format.js';

const POLL_MS = 10000;
const QUERY_SYNC_MS = 250; // replaceState is rate-limited by browsers, so batch keystrokes
const EAGER_SKINS = 14; // rows drawn immediately on first paint (the rest lazily)
const FIRST_ROWS = 60; // first paint renders this many rows, the rest follow in chunks after it
const ROW_CHUNK = 400;
const HIGHLIGHT = 'rk-match';

const profilePath = (name) => `/profile/${encodeURIComponent(name)}`;

// Small pixel crown over the #1 card (original art).
const CROWN = html`<svg class="rk-crown" viewBox="0 0 11 7" width="33" height="21" aria-hidden="true" shape-rendering="crispEdges"><path fill="#7a4a06" d="M0 1h1v6H0zM10 1h1v6h-1zM1 6h9v1H1z"/><path fill="#ffcf53" d="M1 2h1v4H1zM9 2h1v4H9zM2 3h1v3H2zM8 3h1v3H8zM3 2h1v4H3zM7 2h1v4H7zM4 3h3v3H4zM5 0h1v3H5z"/><path fill="#fff3b8" d="M1 2h1v1H1zM5 0h1v1H5zM9 2h1v1H9z"/><path fill="#ff6b9a" d="M5 4h1v1H5z"/></svg>`;

export function mount(root, ctx) {
    const { api, config, shell } = ctx;
    const link = ctx.href;
    const ratingName = config.ratingName || 'Hype';
    const minTeams = config.scoring?.minTeams ?? 4;
    // highest tier first, like the ladder itself
    const tiers = (Array.isArray(config.tiers) ? config.tiers : []).slice().sort((a, b) => b.min - a.min);
    const tierIds = new Set(tiers.map((t) => tierClass(t.id)));
    const parseTier = (v) => {
        const id = tierClass(v || '');
        return v && tierIds.has(id) ? id : '';
    };

    let alive = true;
    let data = null;          // last rankings response
    let failed = null;        // initial load error
    let q = (ctx.query.q || '').trim();
    let tier = parseTier(ctx.query.tier);
    let pollTimer = null;
    let syncTimer = null;
    let announceTimer = null;
    let inflight = null;
    let rowLimit = FIRST_ROWS; // grows to Infinity once the whole ladder has been built
    let chunkFrame = 0;
    let chunkTimer = null;
    const rowCache = new Map();

    setHtml(root, html`
        <section class="board rk-board" aria-labelledby="rk-title">
            ${shell.rankTabs('overall')}
            <div class="board-meta">
                <div class="rk-heading">
                    <h1 class="board-title" id="rk-title">${ratingName} Rankings</h1>
                    <p class="board-summary rk-summary">Loading players…</p>
                </div>
                ${shell.serverBlock()}
            </div>
            <div class="rk-filters" role="group" aria-label="Filter by tier" hidden></div>
            <div class="rk-podium-slot"></div>
            <div class="rk-table">
                <div class="rk-stick" aria-hidden="true"></div>
                <div class="table-head rk-head" aria-hidden="true" hidden>
                    <span>#</span><span>Player</span><span class="right">${ratingName}</span>
                    <span class="right hide-sm">Events</span><span class="right hide-sm">Wins</span>
                    <span class="right hide-sm">K/D</span><span class="right hide-sm">Avg</span>
                </div>
                <div class="rows rk-rows"></div>
                <div class="rk-state"></div>
            </div>
            <p class="visually-hidden rk-announce" role="status" aria-live="polite"></p>
        </section>`);

    const el = {
        summary: qs('.rk-summary', root),
        filters: qs('.rk-filters', root),
        podium: qs('.rk-podium-slot', root),
        head: qs('.rk-head', root),
        rows: qs('.rk-rows', root),
        state: qs('.rk-state', root),
        announce: qs('.rk-announce', root),
    };

    // the sticky table head turns opaque once it is stuck to the top of the viewport
    const stickIo = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(([e]) => {
            el.head.classList.toggle('is-stuck', !e.isIntersecting && e.boundingClientRect.top < 0);
        })
        : null;
    stickIo?.observe(qs('.rk-stick', root));

    // ---- lazy body skins: placeholders become <img> when a row nears the viewport ----
    function hydrate(row) {
        for (const ph of row.querySelectorAll('.rk-skin-ph')) {
            const tpl = document.createElement('template');
            tpl.innerHTML = skinImg({ skin: ph.dataset.skin }, { kind: 'body', size: 64, cls: 'rk-skin', lazy: false }).__html;
            ph.replaceWith(tpl.content);
        }
    }
    const io = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                io.unobserve(e.target);
                hydrate(e.target);
            }
        }, { rootMargin: '700px 0px' })
        : null;

    const forget = (node) => io?.unobserve(node);
    // drop cached rows of players that are no longer on the ladder
    function pruneCache() {
        const keep = new Set(data.players.map((p) => p.uuid || p.name));
        for (const [key, entry] of rowCache) {
            if (keep.has(key)) continue;
            forget(entry.node);
            rowCache.delete(key);
        }
    }

    // ---- markup ----
    function rowHtml(p) {
        return html`<a class="row rk-row" href="${link(profilePath(p.name))}">
            <span class="rk-pos${p.position >= 10000 ? ' is-xlong' : (p.position >= 1000 ? ' is-long' : '')}">${placeText(p.position)}</span>
            <span class="cell rk-player">
                <span class="rk-skin-ph" data-skin="${p.skin || p.uuid || p.name}" aria-hidden="true"></span>
                <span class="rk-id"><span class="rk-name">${p.name}</span>${tierText(p.tier, p.tierLabel)}</span>
            </span>
            <span class="num rk-hype"><span class="visually-hidden">${ratingName} </span>${fmtInt(p.hype)}</span>
            <span class="num rk-stat hide-sm"><span class="visually-hidden">Events </span>${fmtInt(p.events)}</span>
            <span class="num rk-stat hide-sm"><span class="visually-hidden">Wins </span>${fmtInt(p.wins)}</span>
            <span class="num rk-stat hide-sm"><span class="visually-hidden">K/D </span>${fmtDec(p.kd, 2)}</span>
            <span class="num rk-stat hide-sm"><span class="visually-hidden">Average placement </span>${fmtDec(p.averagePlacement, 1)}</span>
        </a>`.__html;
    }

    function podiumHtml(top) {
        if (!top.length) return '';
        const sizes = { 1: 192, 2: 160, 3: 160 };
        return html`<ol class="rk-podium rk-podium-${top.length}" aria-label="Top ${top.length}">
            ${top.map((p) => html`<li class="rk-pod rk-pod-${p.position}">
                <a class="rk-pod-card tier-${tierClass(p.tier)}" href="${link(profilePath(p.name))}">
                    ${p.position === 1 ? CROWN : ''}
                    <span class="rk-pod-top">
                        <span class="rk-pod-name">${p.name}</span>
                        <span class="rk-pod-hype"><span class="digits">${fmtInt(p.hype)}</span> <span class="rk-pod-unit">${ratingName}</span></span>
                    </span>
                    <span class="rk-pod-stage">${skinImg(p, { kind: 'body', size: sizes[p.position] || 160, cls: 'rk-pod-skin', lazy: false })}</span>
                    <span class="rk-pod-base">
                        <span class="rk-pod-rank digits"><span class="visually-hidden">Rank </span>#${p.position}</span>
                        ${tierText(p.tier, p.tierLabel)}
                    </span>
                </a>
            </li>`)}
        </ol>`;
    }

    function filtersHtml(counts) {
        const btn = (id, label, n, inner) => html`<button type="button" class="rk-chip${id ? ` tier-${id}` : ''}${n ? '' : ' is-empty'}" data-tier="${id}" aria-pressed="false" title="${label}: ${plural(n, 'player')}">${inner}<span class="rk-chip-n digits">${fmtInt(n)}</span></button>`;
        return html`${btn('', 'All tiers', data.total, html`<span class="rk-chip-all">All</span>`)}
            ${tiers.map((t) => {
                const id = tierClass(t.id);
                return btn(id, t.name, counts.get(id) || 0, html`<span class="rk-chip-gem" aria-hidden="true"></span>${tierText(t.id, t.name)}`);
            })}`;
    }

    const skeleton = html`
        <div class="rk-podium rk-podium-3 is-loading" aria-hidden="true">
            <div class="rk-pod rk-pod-1"><div class="rk-pod-card skeleton"></div></div>
            <div class="rk-pod rk-pod-2"><div class="rk-pod-card skeleton"></div></div>
            <div class="rk-pod rk-pod-3"><div class="rk-pod-card skeleton"></div></div>
        </div>`;

    function loadingState() {
        setHtml(el.podium, skeleton);
        setHtml(el.state, html`<div class="rows rk-skeleton-rows" aria-busy="true">
            <span class="visually-hidden">Loading rankings…</span>
            ${Array.from({ length: 6 }, () => html`<div class="skeleton skeleton-row"></div>`)}
        </div>`);
    }

    // ---- render ----
    function matches() {
        const ql = q.toLowerCase();
        if (!ql && !tier) return data.players;
        return data.players.filter((p) => (!tier || tierClass(p.tier) === tier) && (!ql || p.name.toLowerCase().includes(ql)));
    }

    function render() {
        if (!alive) return;
        if (failed && !data) {
            el.filters.hidden = true;
            el.head.hidden = true;
            setHtml(el.podium, '');
            patchList(el.rows, [], rowCache);
            setHtml(el.state, html`<div class="board-body"><div class="error-box" role="alert">
                <p class="error-title">Couldn't load the rankings</p>
                <p class="error-text">${failed.message || 'Something went wrong.'}</p>
                <div class="error-actions"><button class="btn" type="button" data-app-retry>Try again</button></div>
            </div></div>`);
            setHtml(el.summary, 'Rankings unavailable');
            return;
        }
        if (!data) return;

        const filtering = !!(q || tier);
        const list = matches();
        const counts = new Map();
        for (const p of data.players) {
            const id = tierClass(p.tier);
            counts.set(id, (counts.get(id) || 0) + 1);
        }

        setHtml(el.summary, html`${countText(data.total, 'ranked player')}${filtering ? html` · <span class="rk-matches">${countText(list.length, 'match', 'matches')}</span>` : ''}${ctx.live ? html` <span class="rk-live" title="Updates automatically">Live</span>` : ''}`);

        el.filters.hidden = data.total === 0;
        if (data.total) {
            // markup ignores the selection so a click never rebuilds the buttons (keeps focus)
            setHtml(el.filters, filtersHtml(counts));
            for (const b of el.filters.querySelectorAll('[data-tier]')) {
                const pressed = b.dataset.tier === tier ? 'true' : 'false';
                if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
            }
        }

        const podium = filtering ? [] : data.players.slice(0, 3);
        setHtml(el.podium, podiumHtml(podium));

        const shown = filtering ? list : list.slice(podium.length);
        const first = rowCache.size === 0;
        const visible = shown.length > rowLimit ? shown.slice(0, rowLimit) : shown;
        const created = patchList(el.rows, visible.map((p) => ({ key: p.uuid || p.name, html: rowHtml(p) })), rowCache, forget);
        if (visible.length < shown.length) scheduleChunk();
        let eager = first ? EAGER_SKINS : 0;
        for (const node of created.values()) {
            if (!io || eager-- > 0) hydrate(node);
            else io.observe(node);
        }
        el.head.hidden = shown.length === 0;
        el.rows.hidden = shown.length === 0;

        if (data.total === 0) {
            setHtml(el.state, html`<div class="board-body"><div class="empty">
                <p class="empty-title">No ranked players yet</p>
                <p class="empty-text">The ladder fills in after the first ranked event finishes (${plural(minTeams, 'team')} or more). Check back soon!</p>
            </div></div>`);
        } else if (!list.length) {
            const tierName = tier ? (tiers.find((t) => tierClass(t.id) === tier)?.name || tier) : '';
            setHtml(el.state, html`<div class="board-body"><div class="empty">
                <p class="empty-title">${q ? html`No players match “${q}”${tierName ? ` in ${tierName}` : ''}` : html`Nobody is in ${tierName} yet`}</p>
                <p class="empty-text">${q ? 'Check the spelling, or search for part of the name.' : `Climb the ladder to be the first ${tierName} player.`}</p>
                <div class="error-actions">
                    ${q ? html`<button class="btn btn-sm" type="button" data-rk-clear="q">Clear search</button>` : ''}
                    ${tier ? html`<button class="btn btn-sm btn-ghost" type="button" data-rk-clear="tier">Show all tiers</button>` : ''}
                </div>
            </div></div>`);
        } else {
            setHtml(el.state, '');
        }
        paintHighlights();
    }

    // Build the rest of a long ladder after the first paint (next frame, then a task).
    function scheduleChunk() {
        if (chunkFrame || chunkTimer) return;
        chunkFrame = requestAnimationFrame(() => {
            chunkFrame = 0;
            chunkTimer = setTimeout(() => {
                chunkTimer = null;
                if (!alive) return;
                rowLimit = rowLimit + ROW_CHUNK >= (data?.players.length || 0) ? Infinity : rowLimit + ROW_CHUNK;
                render();
            }, 0);
        });
    }

    // Highlight the matched part of each name with the CSS Custom Highlight API (no DOM changes,
    // so the cached rows stay reusable). Browsers without it simply show no highlight.
    function paintHighlights() {
        if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight !== 'function' || typeof StaticRange !== 'function') return;
        const ql = q.toLowerCase();
        if (!ql || !data) { CSS.highlights.delete(HIGHLIGHT); return; }
        const hl = new Highlight();
        for (const name of el.rows.querySelectorAll('.rk-name')) {
            const text = name.firstChild;
            if (!text || text.nodeType !== 3) continue;
            const i = text.data.toLowerCase().indexOf(ql);
            if (i < 0) continue;
            // StaticRange: live Ranges would be updated on every later DOM mutation
            hl.add(new StaticRange({ startContainer: text, startOffset: i, endContainer: text, endOffset: i + ql.length }));
        }
        CSS.highlights.set(HIGHLIGHT, hl);
    }

    function announce() {
        clearTimeout(announceTimer);
        announceTimer = setTimeout(() => {
            if (!alive || !data) return;
            const n = matches().length;
            el.announce.textContent = q || tier ? `${plural(n, 'player')} found` : `Showing all ${plural(data.total, 'player')}`;
        }, 450);
    }

    function syncQuery() {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => { if (alive) ctx.setQuery({ q: q || null, tier: tier || null }); }, QUERY_SYNC_MS);
    }

    // ---- data ----
    async function load({ quiet = false } = {}) {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const next = await api.rankings();
                if (!alive) return;
                const same = data && next.generatedAt === data.generatedAt && next.total === data.total;
                failed = null;
                setLive(true);
                if (same) return;
                data = { ...next, players: Array.isArray(next.players) ? next.players : [] };
                pruneCache();
                render();
            } catch (err) {
                if (!alive) return;
                if (data) { setLive(false); return; } // keep showing stale data while polling fails
                if (!quiet) console.warn(err);
                failed = err;
                render();
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    function setLive(ok) {
        const dot = qs('.rk-live', el.summary);
        if (!dot) return;
        const text = ok ? 'Live' : 'Reconnecting';
        if (dot.textContent === text) return;
        dot.classList.toggle('is-stale', !ok);
        dot.textContent = text;
    }

    // ---- interaction ----
    const offChip = on(el.filters, 'click', '[data-tier]', (ev, b) => {
        const next = b.dataset.tier || '';
        tier = tier === next ? '' : next;
        syncQuery();
        render();
        announce();
    });
    const offClear = on(el.state, 'click', '[data-rk-clear]', (ev, b) => {
        if (b.dataset.rkClear === 'q') {
            q = '';
            shell.setSearch('');
            shell.focusSearch?.();
        } else {
            tier = '';
            qs('[data-tier=""]', el.filters)?.focus();
        }
        syncQuery();
        render();
        announce();
    });

    shell.setSearch(q);
    const offSearch = shell.onSearch(({ type, value }) => {
        if (type === 'input') {
            if (value === q) return true;
            q = value;
            syncQuery();
            render();
            announce();
            return true;
        }
        // submit: open the profile on an exact or single match, otherwise stay on the list
        q = value;
        syncQuery();
        render();
        if (!data || !value) return true;
        const v = value.toLowerCase();
        const exact = data.players.find((p) => p.name.toLowerCase() === v);
        const list = matches();
        const target = exact || (list.length === 1 ? list[0] : null);
        if (target) ctx.navigate(profilePath(target.name));
        else announce();
        return true;
    });

    const onVisible = () => { if (!document.hidden) load({ quiet: true }); };
    if (ctx.live) {
        pollTimer = setInterval(() => { if (!document.hidden) load({ quiet: true }); }, POLL_MS);
        document.addEventListener('visibilitychange', onVisible);
    }

    loadingState();
    load();

    return {
        update(next) {
            const nq = (next.query.q || '').trim();
            const nt = parseTier(next.query.tier);
            if (nq === q && nt === tier) return;
            q = nq;
            tier = nt;
            shell.setSearch(q);
            render();
        },
        unmount() {
            alive = false;
            clearInterval(pollTimer);
            clearTimeout(syncTimer);
            clearTimeout(announceTimer);
            clearTimeout(chunkTimer);
            cancelAnimationFrame(chunkFrame);
            document.removeEventListener('visibilitychange', onVisible);
            io?.disconnect();
            stickIo?.disconnect();
            offSearch();
            offChip();
            offClear();
            if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete(HIGHLIGHT);
        },
    };
}
