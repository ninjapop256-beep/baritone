// Game history view (/rankings/history): newest ranked games first, "Load older games"
// paging with before=, live polling that merges new games on top of the pages already loaded.
import { html, setHtml, qs, on } from '../ui/dom.js';
import { skinImg } from '../ui/skins.js';
import { modePill, chip } from '../ui/badges.js';
import { fmtDuration, fmtDateTime, fmtRelative, fmtInt, mapName, teamSizeLabel } from '../ui/format.js';
import { patchList, fastHref, countText } from './rankings.js';

const PAGE = 30;
const POLL_MS = 15000;
const TICK_MS = 60000; // refresh "9 hours ago" labels
const MAX_HEADS = 4;

// How many games the last visit had loaded, so Back from a game restores the list (and scroll).
const memory = { count: PAGE };

/** 'A', 'A & B', 'A, B & C' */
export function joinNames(names) {
    if (names.length <= 1) return names[0] || '';
    return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

export function mount(root, ctx) {
    const { api, shell } = ctx;
    const link = fastHref(ctx);

    let alive = true;
    let games = [];        // contiguous newest-first prefix of all ranked games
    let total = 0;
    let loaded = false;
    let failed = null;     // initial load error
    let moreState = 'idle'; // idle | loading | error
    let moreError = null;
    let pollTimer = null;
    let tickTimer = null;
    let inflight = null;
    const rowCache = new Map();
    // back/forward: reload as many games as before (one request, the API caps a page at 100)
    let firstLimit = ctx.route?.via === 'pop' ? Math.min(100, Math.max(PAGE, memory.count)) : PAGE;

    setHtml(root, html`
        <section class="board hs-board" aria-labelledby="hs-title">
            ${shell.rankTabs('history')}
            <div class="board-meta">
                <div class="hs-heading">
                    <h1 class="board-title" id="hs-title">Game History</h1>
                    <p class="board-summary hs-summary">Loading games…</p>
                </div>
            </div>
            <div class="table-head hs-head" aria-hidden="true" hidden>
                <span>Game</span><span>Event</span>
                <span class="right hide-sm">Duration</span><span class="right hide-md">Players</span>
                <span class="right hide-sm">Kills</span><span class="hs-head-winners">Winners</span>
            </div>
            <div class="rows hs-rows"></div>
            <div class="hs-state"></div>
            <div class="hs-foot" hidden>
                <p class="hs-count"></p>
                <button class="btn hs-more" type="button">Load older games</button>
                <p class="hs-more-error" role="alert"></p>
            </div>
        </section>`);

    const el = {
        summary: qs('.hs-summary', root),
        head: qs('.hs-head', root),
        rows: qs('.hs-rows', root),
        state: qs('.hs-state', root),
        foot: qs('.hs-foot', root),
        count: qs('.hs-count', root),
        more: qs('.hs-more', root),
        moreError: qs('.hs-more-error', root),
    };

    // ---- markup ----
    function rowHtml(g, latest, now) {
        const winners = Array.isArray(g.winners) ? g.winners : [];
        const extra = winners.length - MAX_HEADS;
        const map = mapName(g.map);
        const when = g.startedAt ?? g.endedAt;
        const iso = Number.isFinite(when) ? new Date(when).toISOString() : '';
        return html`<a class="row hs-row" href="${link(`/rankings/history/${g.number}`)}">
            <span class="hs-game">
                <span class="hs-label${latest ? ' is-latest' : ''}">${latest ? 'Latest game' : 'Game'}</span>
                <span class="hs-num digits${g.number >= 100000 ? ' is-xlong' : (g.number >= 1000 ? ' is-long' : '')}">#${g.number}</span>
            </span>
            <span class="cell hs-event">
                <span class="hs-chips">${modePill(g)}${chip(teamSizeLabel(g.teamSize), 'hs-size')}</span>
                <span class="hs-sub">${map ? html`<span class="hs-map">${map}</span><span class="hs-dot" aria-hidden="true"> · </span>` : ''}<time datetime="${iso}">${fmtDateTime(when)}</time><span class="hs-dot" aria-hidden="true"> · </span><span class="hs-ago">${fmtRelative(when, now)}</span></span>
            </span>
            <span class="num hs-dur hide-sm"><span class="visually-hidden">Duration </span>${fmtDuration(g.duration)}</span>
            <span class="num hs-stat hide-md"><span class="visually-hidden">Players </span>${fmtInt(g.players)}</span>
            <span class="num hs-stat hide-sm"><span class="visually-hidden">Kills </span>${fmtInt(g.kills)}</span>
            <span class="cell hs-winners">
                <span class="visually-hidden">${winners.length === 1 ? 'Winner' : 'Winners'}: </span>
                ${winners.length ? html`<span class="heads hs-heads" aria-hidden="true">${winners.slice(0, MAX_HEADS).map((w) => skinImg(w, { size: 24, cls: 'hs-head-img' }))}${extra > 0 ? html`<span class="hs-extra">+${extra}</span>` : ''}</span>
                <span class="hs-names">${joinNames(winners.map((w) => w.name))}</span>` : html`<span class="hs-names faint">—</span>`}
            </span>
        </a>`.__html;
    }

    function skeleton() {
        setHtml(el.state, html`<div class="rows hs-skeleton" aria-busy="true">
            <span class="visually-hidden">Loading games…</span>
            ${Array.from({ length: 6 }, () => html`<div class="skeleton skeleton-row"></div>`)}
        </div>`);
    }

    // ---- render ----
    function render({ fresh = null } = {}) {
        if (!alive) return;
        if (failed && !loaded) {
            setHtml(el.summary, 'Game history unavailable');
            el.head.hidden = true;
            el.foot.hidden = true;
            setHtml(el.state, html`<div class="board-body"><div class="error-box" role="alert">
                <p class="error-title">Couldn't load the game history</p>
                <p class="error-text">${failed.message || 'Something went wrong.'}</p>
                <div class="error-actions"><button class="btn" type="button" data-app-retry>Try again</button></div>
            </div></div>`);
            return;
        }
        if (!loaded) return;

        const now = ctx.now();
        const newest = games[0];
        const latestWhen = newest ? (newest.endedAt ?? newest.startedAt) : null;
        setHtml(el.summary, html`${countText(total, 'ranked game')}${newest ? html` · latest ${fmtRelative(latestWhen, now)}` : ''}${ctx.mode === 'live' ? html` <span class="rk-live" title="Updates automatically">Live</span>` : ''}`);

        const created = patchList(el.rows, games.map((g, i) => ({ key: g.number, html: rowHtml(g, i === 0, now) })), rowCache);
        if (fresh) {
            for (const [key, node] of created) {
                if (fresh.has(key)) node.classList.add('is-new');
            }
        }

        const empty = games.length === 0;
        el.head.hidden = empty;
        el.rows.hidden = empty;
        setHtml(el.state, empty ? html`<div class="board-body"><div class="empty">
            <p class="empty-title">No ranked games yet</p>
            <p class="empty-text">Finished events show up here automatically, newest first. Hop on the server and play one!</p>
        </div></div>` : '');

        // footer: count, load-more button (kept as one persistent element so focus survives), errors
        const more = games.length < total;
        el.foot.hidden = empty;
        setHtml(el.count, more
            ? html`Showing <span class="digits">${fmtInt(games.length)}</span> of <span class="digits">${fmtInt(total)}</span> games`
            : html`That's every ranked game${total > PAGE ? html` — <span class="digits">${fmtInt(total)}</span> in total` : ''}.`);
        el.more.hidden = !more;
        const busy = moreState === 'loading';
        el.more.setAttribute('aria-disabled', busy ? 'true' : 'false');
        el.more.classList.toggle('is-busy', busy);
        el.more.textContent = busy ? 'Loading…' : (moreState === 'error' ? 'Try again' : 'Load older games');
        el.moreError.hidden = moreState !== 'error';
        el.moreError.textContent = moreState === 'error' ? `Couldn't load older games. ${moreError?.message || ''}`.trim() : '';
    }

    // ---- data ----
    // Merge a fresh first page into the loaded list, keeping older pages that are still contiguous.
    function mergeNewest(page) {
        const top = Array.isArray(page.games) ? page.games : [];
        total = Number.isFinite(page.total) ? page.total : top.length;
        const known = new Set(games.map((g) => g.number));
        const fresh = new Set(loaded ? top.filter((g) => !known.has(g.number)).map((g) => g.number) : []);
        if (!top.length) {
            games = [];
        } else {
            const oldest = top[top.length - 1].number;
            const covered = !page.more; // the first page already holds every game
            const older = covered ? [] : games.filter((g) => g.number < oldest);
            // a gap (more new games than one page) means the old pages are no longer contiguous
            const gap = older.length && games.length && games[0].number < oldest;
            games = gap ? top : top.concat(older);
        }
        return fresh;
    }

    async function loadNewest({ quiet = false } = {}) {
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const page = await api.games({ limit: firstLimit });
                firstLimit = PAGE;
                if (!alive) return;
                const fresh = mergeNewest(page);
                loaded = true;
                failed = null;
                render({ fresh });
                setLive(true);
            } catch (err) {
                if (!alive) return;
                if (loaded) { setLive(false); return; } // keep the stale list while polling fails
                if (!quiet) console.warn(err);
                failed = err;
                render();
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    async function loadOlder() {
        if (moreState === 'loading' || !games.length) return;
        const before = games[games.length - 1].number; // numbers have gaps: page by the last shown
        const hadFocus = document.activeElement === el.more;
        moreState = 'loading';
        render();
        try {
            const page = await api.games({ before, limit: PAGE });
            if (!alive) return;
            const have = new Set(games.map((g) => g.number));
            const add = (page.games || []).filter((g) => g.number < before && !have.has(g.number));
            if (games.length && games[games.length - 1].number === before) games = games.concat(add);
            if (Number.isFinite(page.total)) total = page.total;
            if (!page.more && games.length < total) total = games.length; // server says nothing older is left
            moreState = 'idle';
            moreError = null;
            render();
            // the button disappears after the last page: move focus to the first new game instead
            if (hadFocus && el.more.hidden && add.length) rowCache.get(add[0].number)?.node.focus();
        } catch (err) {
            if (!alive) return;
            console.warn(err);
            moreState = 'error';
            moreError = err;
            render();
        }
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
    const offMore = on(el.foot, 'click', '.hs-more', (ev) => {
        ev.preventDefault();
        loadOlder();
    });
    const offAnim = on(el.rows, 'animationend', '.hs-row.is-new', (ev, row) => row.classList.remove('is-new'));

    const onVisible = () => { if (!document.hidden && ctx.mode === 'live') loadNewest({ quiet: true }); };
    if (ctx.mode === 'live') {
        pollTimer = setInterval(() => { if (!document.hidden) loadNewest({ quiet: true }); }, POLL_MS);
        document.addEventListener('visibilitychange', onVisible);
    }
    tickTimer = setInterval(() => { if (!document.hidden) render(); }, TICK_MS);

    skeleton();
    loadNewest();

    return {
        unmount() {
            alive = false;
            memory.count = games.length || PAGE;
            clearInterval(pollTimer);
            clearInterval(tickTimer);
            document.removeEventListener('visibilitychange', onVisible);
            offMore();
            offAnim();
        },
    };
}
