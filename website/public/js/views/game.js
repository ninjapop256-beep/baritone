// Game detail view (/rankings/history/:number): hero (chips, title, times, duration, stat
// tiles), older/newer navigation, the winners on a glowing gold stage and every team's placement.
// Optional ?player=<name|uuid> highlights (and scrolls to) that player's team.
import { html, raw, setHtml, qs } from '../ui/dom.js';
import { skinImg } from '../ui/skins.js';
import { modePill, modeColor, chip, hypeDelta, placeText, tierText } from '../ui/badges.js';
import { fmtDuration, fmtDateTimeLong, fmtTime, fmtRelative, fmtInt, mapName, teamSizeLabel } from '../ui/format.js';
import { tierFor, tierIndex } from '../shared/tiers.js';

const POLL_MS = 30000;
const TICK_MS = 60000; // refresh the "9 hours ago" label
const MAX_BODIES = 4;  // winner skins on the stage; the rest are listed by name
const SPARKS = 9;

// 8×8 pixel sword (original art) for per-player kills in team games.
const SWORD = (() => {
    const path = (fill, cells) => `<path fill="${fill}" d="${cells.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join('')}"/>`;
    return raw(`<svg class="gm-sword" viewBox="0 0 8 8" width="12" height="12" aria-hidden="true" focusable="false" shape-rendering="crispEdges">${
        path('#f4f7fb', [[7, 0], [6, 1], [5, 2], [4, 3], [3, 4]])}${
        path('#9fabbd', [[6, 0], [5, 1], [4, 2], [3, 3]])}${
        path('#e0a93e', [[1, 3], [2, 4], [3, 5], [4, 6], [0, 7]])}${
        path('#7a4e2a', [[2, 5], [1, 6]])}</svg>`);
})();

const CHEV_L = html`<span class="gm-chev" aria-hidden="true">‹</span>`;
const CHEV_R = html`<span class="gm-chev" aria-hidden="true">›</span>`;

const sameDay = (a, b) => {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : '');
const kills = (n) => html`<span class="num">${fmtInt(n)}</span> ${Number(n) === 1 ? 'kill' : 'kills'}`;
// figures inside running text use the numbers font (Pixelify's 5 reads like an S)
const fig = (v) => html`<span class="digits gm-fig-n">${v}</span>`;

/** ?player= matcher: name (any case) or uuid (dashed or not). */
function playerMatcher(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return () => false;
    const compact = k.replace(/-/g, '');
    return (p) => !!p && ((p.name && p.name.toLowerCase() === k) || (!!p.uuid && p.uuid.toLowerCase().replace(/-/g, '') === compact));
}

export function mount(root, ctx) {
    const { api, shell } = ctx;
    const config = ctx.config || {};
    const tiers = config.tiers;
    const ratingName = config.ratingName || 'Hype';
    const live = !!ctx.live;
    const href = ctx.href;
    const gameHref = (n) => href(`/rankings/history/${n}`);
    const profileHref = (p) => href(`/profile/${encodeURIComponent(p.name || p.uuid || '')}`);

    const param = String(ctx.params?.number ?? '').trim();
    const number = /^\d{1,15}$/.test(param) ? Number(param) : NaN;
    const valid = Number.isSafeInteger(number) && number > 0;

    let query = ctx.query || {};
    let alive = true;
    let game = null;
    let missing = false;
    let failed = null;
    let latest; // newest game number, fetched once for the not-found state
    let seq = 0;
    let pollTimer = null;
    let scrolledFor = ctx.route?.via === 'pop' ? String(query.player || '') : '';

    setHtml(root, html`
        <div class="gm-topnav">
            ${shell.backLink(href('/rankings/history'), html`Back to <span class="gm-hide-xs">game </span>history`)}
            <nav class="gm-mini" aria-label="Older and newer games" hidden></nav>
        </div>
        <div class="gm-slot" data-slot="hero"></div>
        <div class="gm-slot" data-slot="win" hidden></div>
        <div class="gm-slot" data-slot="place" hidden></div>
        <div class="gm-slot" data-slot="pager" hidden></div>`);

    const el = {
        mini: qs('.gm-mini', root),
        hero: qs('[data-slot="hero"]', root),
        win: qs('[data-slot="win"]', root),
        place: qs('[data-slot="place"]', root),
        pager: qs('[data-slot="pager"]', root),
    };

    function put(slot, markup) {
        const node = el[slot];
        const str = markup ? (markup.__html ?? String(markup)) : '';
        node.hidden = !str;
        setHtml(node, raw(str));
    }

    // ---------- markup ----------
    function miniHtml(g) {
        const btn = (n, dir) => {
            const older = dir === 'prev';
            if (n === null || n === undefined) {
                return html`<span class="gm-mini-btn is-off" title="${older ? 'This is the oldest ranked game' : 'This is the latest game'}">${older ? CHEV_L : ''}<span class="gm-mini-t">${older ? 'Oldest' : 'Latest'}</span>${older ? '' : CHEV_R}</span>`;
            }
            return html`<a class="gm-mini-btn" href="${gameHref(n)}" rel="${dir}" aria-keyshortcuts="${older ? 'ArrowLeft' : 'ArrowRight'}" title="${older ? 'Older' : 'Newer'} game (${older ? '←' : '→'} key)">
                ${older ? CHEV_L : ''}<span class="visually-hidden">${older ? 'Older' : 'Newer'} game </span><span class="digits">#${n}</span>${older ? '' : CHEV_R}</a>`;
        };
        return html`${btn(g.prev, 'prev')}${btn(g.next, 'next')}`;
    }

    function heroHtml(g, now) {
        const map = mapName(g.map);
        const ended = Number.isFinite(g.endedAt) ? (sameDay(g.startedAt, g.endedAt) ? fmtTime(g.endedAt) : fmtDateTimeLong(g.endedAt)) : null;
        const mk = g.mostKills;
        let tied = 0;
        let tiedNames = [];
        if (mk && mk.kills > 0) {
            for (const t of g.teams) for (const p of t.players || []) if (p.kills === mk.kills && p.uuid !== mk.uuid) tiedNames.push(p.name);
            tied = tiedNames.length;
            tiedNames = tiedNames.slice(0, 6);
        }
        return html`<section class="card gm-hero mode-${modeColor(g.modeColor)}" aria-labelledby="gm-title">
            <div class="gm-hero-top">
                <div class="gm-hero-main">
                    <div class="chips gm-chips">
                        ${modePill(g)}${chip(teamSizeLabel(g.teamSize))}${map ? chip(map, 'plain') : ''}${chip('Ranked', 'good')}${g.next === null ? chip('Latest game', 'accent') : ''}
                    </div>
                    <h1 class="gm-title" id="gm-title">Game <span class="digits gm-title-n">#${g.number}</span></h1>
                    <p class="gm-when"><span class="gm-when-in">
                        <span>Started <time datetime="${iso(g.startedAt)}">${fmtDateTimeLong(g.startedAt)}</time></span>
                        ${ended ? html`<span><span class="visually-hidden">, </span>ended <time datetime="${iso(g.endedAt)}">${ended}</time></span>` : ''}
                        ${Number.isFinite(g.endedAt) ? html`<span class="gm-ago"><span class="visually-hidden">, </span>${fmtRelative(g.endedAt, now)}</span>` : ''}
                    </span></p>
                </div>
                <div class="gm-dur">
                    <span class="stat-label gm-dur-k">Duration</span>
                    <span class="digits gm-dur-v">${fmtDuration(g.duration)}</span>
                    <span class="gm-dur-sub">start to winner</span>
                </div>
            </div>
            <div class="stat-grid gm-tiles">
                <div class="stat-tile"><span class="stat-label">Players</span> <span class="stat-value">${fmtInt(g.players)}</span></div>
                <div class="stat-tile"><span class="stat-label">Teams</span> <span class="stat-value">${fmtInt(g.teamCount)}</span></div>
                <div class="stat-tile"><span class="stat-label">Total kills</span> <span class="stat-value">${fmtInt(g.kills)}</span></div>
                <div class="stat-tile gm-tile-mk">
                    <span class="stat-label gm-mk-label">Most kills${tied ? html`<span class="gm-mk-tie" title="Tied with ${tiedNames.join(', ')}${tied > tiedNames.length ? ' and others' : ''}"><span class="visually-hidden">, </span>+${tied}<span class="hide-sm"> tied</span><span class="show-sm visually-hidden"> tied</span></span>` : ''}</span>
                    ${mk && mk.kills > 0 ? html`<span class="gm-mk">
                        <a class="gm-mk-name link" href="${profileHref(mk)}" title="${mk.name}">${mk.name}</a>
                        <span class="num gm-mk-n"><span class="visually-hidden">with </span>${fmtInt(mk.kills)}<span class="visually-hidden"> kills</span></span>
                    </span>` : html`<span class="stat-value faint">—</span>`}
                </div>
            </div>
        </section>`;
    }

    function champHtml(p, size) {
        const t = tierFor(p.hypeAfter, tiers);
        const up = Number.isFinite(p.hypeBefore) && tierIndex(p.hypeAfter, tiers) > tierIndex(p.hypeBefore, tiers);
        return html`<li class="gm-champ">
            <a class="gm-fig" href="${profileHref(p)}" tabindex="-1" aria-hidden="true">${skinImg(p, { kind: 'body', size, lazy: false, cls: 'gm-fig-img' })}</a>
            <span class="gm-block" aria-hidden="true"></span>
            <div class="gm-champ-info">
                <a class="gm-champ-name" href="${profileHref(p)}">${p.name}</a>
                <p class="gm-champ-stats">${kills(p.kills)}<span class="gm-sep"> · </span>${hypeDelta(p.hypeChange)}<span class="visually-hidden"> ${ratingName}</span></p>
                <p class="gm-champ-tier">${tierText(t.id, t.label)}${up ? html`<span class="gm-promo" title="Reached ${t.name} in this game">Rank up</span>` : ''}</p>
            </div>
        </li>`;
    }

    function winnersHtml(g) {
        const winners = Array.isArray(g.winners) && g.winners.length ? g.winners : (g.teams[0]?.players || []);
        const team = winners.length > 1 || (Number(g.teamSize) || 1) > 1;
        const shown = winners.slice(0, MAX_BODIES);
        const rest = winners.slice(MAX_BODIES);
        const teamKills = g.teams[0]?.kills ?? winners.reduce((s, p) => s + (p.kills || 0), 0);
        const of = html`of ${fig(fmtInt(g.teamCount))}${team ? ' teams' : ''}`;
        const size = shown.length > 1 ? 176 : 208;
        return html`<section class="card gm-win" aria-labelledby="gm-win-title">
            <div class="gm-win-head">
                <h2 class="card-title" id="gm-win-title">${winners.length > 1 ? 'Winners' : 'Winner'}</h2>
                <p class="card-sub">${fig('#1')} ${of} · ${fig(fmtInt(teamKills))} ${teamKills === 1 ? 'kill' : 'kills'}${team ? ' as a team' : ''}</p>
            </div>
            <div class="gm-stage" data-count="${shown.length}">
                <div class="gm-rays" aria-hidden="true"></div>
                <div class="gm-sparks" aria-hidden="true">${Array.from({ length: SPARKS }, () => html`<i></i>`)}</div>
                ${shown.length
                    ? html`<ul class="gm-champs" role="list">${shown.map((p) => champHtml(p, size))}</ul>`
                    : html`<p class="gm-nowin">No winner was recorded for this game.</p>`}
                ${rest.length ? html`<p class="gm-rest">Also on the team: ${rest.map((p, i) => html`${i ? ', ' : ''}<a class="link" href="${profileHref(p)}">${p.name}</a>`)}</p>` : ''}
            </div>
        </section>`;
    }

    function playerHtml(p, solo, isMe) {
        return html`<li class="gm-p${isMe(p) ? ' is-me' : ''}">
            ${skinImg(p, { size: 24, cls: 'gm-p-head' })}
            <a class="gm-p-name" href="${profileHref(p)}">${p.name}</a>
            ${solo ? '' : html`<span class="gm-pk" title="${fmtInt(p.kills)} ${p.kills === 1 ? 'kill' : 'kills'}">${SWORD}<span class="digits">${fmtInt(p.kills)}</span><span class="visually-hidden"> ${p.kills === 1 ? 'kill' : 'kills'}</span></span>`}
            ${hypeDelta(p.hypeChange)}<span class="visually-hidden"> ${ratingName}</span>
        </li>`;
    }

    function rowHtml(t, g, solo, isMe) {
        const place = Number(t.placement);
        const won = place === 1;
        const out = !won && Number.isFinite(t.eliminatedAt) && Number.isFinite(g.startedAt)
            ? fmtDuration(t.eliminatedAt - g.startedAt) : null;
        const players = Array.isArray(t.players) ? t.players : [];
        const current = players.some(isMe);
        const cls = `row gm-row${place >= 1 && place <= 3 ? ` is-${place}` : ''}${current ? ' is-current' : ''}`;
        return html`<li class="${cls}">
            <span class="gm-place">${placeText(place)}</span>
            <ul class="gm-team" role="list" aria-label="${solo ? 'Player' : `Team in place ${place}`}">${players.map((p) => playerHtml(p, solo, isMe))}</ul>
            <span class="gm-kills">${kills(t.kills ?? 0)}</span>
            <span class="gm-out">${won
                ? html`<span class="gm-won">Winner</span>`
                : (out ? html`Out at <span class="digits">${out}</span>` : html`<span class="faint">—</span>`)}</span>
        </li>`;
    }

    function placementsHtml(g) {
        const most = g.teams.reduce((m, t) => Math.max(m, (t.players || []).length), 0);
        const size = Math.max(Number(g.teamSize) || 1, most);
        const solo = size <= 1;
        // team members line up in columns on wide screens: duos 2, trios 3, squads 2×2, bigger 3
        const cols = solo ? 1 : (size === 3 || size > 4 ? 3 : 2);
        const isMe = playerMatcher(query.player);
        return html`<section class="card card-pad gm-places" aria-labelledby="gm-pl-title">
            <div class="card-head gm-pl-head">
                <div>
                    <h2 class="card-title" id="gm-pl-title">Placements</h2>
                    <p class="card-sub">${solo ? 'The winner, then the last player out first' : 'The winners, then the last team out first'}</p>
                </div>
            </div>
            ${g.teams.length
                ? html`<ol class="gm-rows gm-cols-${cols}" role="list">${g.teams.map((t) => rowHtml(t, g, solo, isMe))}</ol>`
                : html`<div class="empty"><p class="empty-title">No placements</p><p class="empty-text">This game has no recorded teams.</p></div>`}
        </section>`;
    }

    function pagerHtml(g) {
        const tile = (n, dir) => {
            const older = dir === 'prev';
            if (n === null || n === undefined) {
                return html`<div class="gm-pg gm-pg-${dir} is-edge">
                    <span class="gm-pg-text"><span class="gm-pg-k">${older ? 'Oldest game' : 'Latest game'}</span>
                    <span class="gm-pg-n">${older ? 'No older ranked games' : (live ? 'New games appear here automatically' : 'No newer games yet')}</span></span>
                </div>`;
            }
            return html`<a class="gm-pg gm-pg-${dir}" href="${gameHref(n)}" rel="${dir}">
                ${older ? CHEV_L : ''}
                <span class="gm-pg-text"><span class="gm-pg-k">${older ? 'Older game' : 'Newer game'}</span>
                <span class="gm-pg-n">Game <span class="digits">#${n}</span></span></span>
                ${older ? '' : CHEV_R}
            </a>`;
        };
        return html`<nav class="gm-pager" aria-label="Browse games">${tile(g.prev, 'prev')}${tile(g.next, 'next')}</nav>`;
    }

    function loadingHtml() {
        const tile = html`<div class="stat-tile gm-sk-tile"><span class="skeleton gm-sk-k"></span><span class="skeleton gm-sk-v"></span></div>`;
        return {
            hero: html`<section class="card gm-hero gm-skel" aria-busy="true">
                <span class="visually-hidden" role="status">Loading game…</span>
                <div class="gm-hero-top">
                    <div class="gm-hero-main">
                        <div class="chips"><span class="skeleton gm-sk-chip"></span><span class="skeleton gm-sk-chip is-s"></span><span class="skeleton gm-sk-chip"></span></div>
                        <span class="skeleton gm-sk-title"></span>
                        <span class="skeleton gm-sk-line"></span>
                    </div>
                    <span class="skeleton gm-sk-dur"></span>
                </div>
                <div class="stat-grid gm-tiles">${tile}${tile}${tile}${tile}</div>
            </section>`,
            win: html`<section class="card gm-win gm-skel" aria-hidden="true">
                <div class="gm-win-head"><span class="skeleton gm-sk-h2"></span><span class="skeleton gm-sk-sub"></span></div>
                <div class="gm-stage gm-stage-skel"><span class="skeleton gm-sk-fig"></span><span class="gm-block"></span></div>
            </section>`,
            place: html`<section class="card card-pad gm-places gm-skel" aria-hidden="true">
                <div class="card-head"><div><span class="skeleton gm-sk-h2"></span><span class="skeleton gm-sk-sub"></span></div></div>
                <div class="gm-sk-rows">${Array.from({ length: 6 }, () => html`<span class="skeleton skeleton-row"></span>`)}</div>
            </section>`,
        };
    }

    function missingHtml() {
        const shown = param.length > 18 ? `${param.slice(0, 17)}…` : param;
        return html`<section class="card card-pad gm-missing" aria-labelledby="gm-missing-title">
            <div class="mystery" aria-hidden="true"><span class="mystery-block"><span class="mystery-q">?</span></span></div>
            <h1 class="gm-missing-title" id="gm-missing-title">Game not found</h1>
            <p class="card-sub gm-missing-text">${valid
                ? html`There's no ranked game <span class="gm-missing-n digits">#${number}</span>. It may have been unranked or removed, or the link is mistyped.`
                : html`<span class="gm-missing-n">“${shown || ' '}”</span> isn't a valid game number. Game numbers are whole numbers, like <span class="gm-missing-n digits">#42</span>.`}</p>
            <div class="gm-missing-actions">
                ${Number.isFinite(latest) ? html`<a class="btn btn-primary" href="${gameHref(latest)}">Latest game <span class="digits">#${latest}</span></a>` : ''}
                <a class="btn${Number.isFinite(latest) ? ' btn-ghost' : ' btn-primary'}" href="${href('/rankings/history')}">Game history</a>
            </div>
        </section>`;
    }

    function errorHtml() {
        return html`<section class="card card-pad gm-error">
            <div class="error-box" role="alert">
                <p class="error-title">Couldn't load ${valid ? html`game ${fig(`#${number}`)}` : 'this game'}</p>
                <p class="error-text">${failed?.message || 'Something went wrong.'}</p>
                <div class="error-actions">
                    <button class="btn" type="button" data-app-retry>Try again</button>
                    <a class="btn btn-ghost" href="${href('/rankings/history')}">Game history</a>
                </div>
            </div>
        </section>`;
    }

    // ---------- render ----------
    function render() {
        if (!alive) return;
        if (game) {
            put('mini', miniHtml(game));
            put('hero', heroHtml(game, ctx.now()));
            put('win', winnersHtml(game));
            put('place', placementsHtml(game));
            put('pager', pagerHtml(game));
            return;
        }
        put('mini', '');
        put('pager', '');
        if (missing || failed) {
            put('hero', missing ? missingHtml() : errorHtml());
            put('win', '');
            put('place', '');
            return;
        }
        const sk = loadingHtml();
        put('hero', sk.hero);
        put('win', sk.win);
        put('place', sk.place);
    }

    function scrollToPlayer() {
        const key = String(query.player || '');
        if (!game || !key || scrolledFor === key) return;
        scrolledFor = key;
        const row = qs('.gm-row.is-current', root);
        if (!row) return;
        const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        requestAnimationFrame(() => row.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' }));
    }

    function fetchLatest() {
        if (latest !== undefined) return;
        latest = null;
        api.games({ limit: 1 }).then((res) => {
            const n = res?.games?.[0]?.number;
            if (!alive || !Number.isFinite(n) || n === number) return;
            latest = n;
            render();
        }).catch(() => { /* the history link is still there */ });
    }

    async function load() {
        if (!valid) {
            missing = true;
            shell.setTitle('Game not found');
            render();
            fetchLatest();
            return;
        }
        const my = ++seq;
        try {
            const g = await api.game(number);
            if (!alive || my !== seq) return;
            if (!g || typeof g !== 'object' || !Array.isArray(g.teams)) throw new Error('The server sent an unexpected response.');
            game = g;
            missing = false;
            failed = null;
            shell.setTitle(`Game #${g.number}`);
        } catch (err) {
            if (!alive || my !== seq) return;
            if (err?.status === 404) {
                game = null;
                missing = true;
                clearInterval(pollTimer); // gone (or never existed): stop asking
                shell.setTitle('Game not found');
                fetchLatest();
            } else if (game) {
                return; // a failed poll keeps the last good data on screen
            } else {
                failed = err;
            }
        }
        render();
        scrollToPlayer();
    }

    // ←/→ open the older/newer game (ignored while typing or with modifiers)
    function onKey(ev) {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        if (!game || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.isComposing) return;
        const t = ev.target;
        if (t instanceof Element && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="tablist"], [role="listbox"]')) return;
        const n = ev.key === 'ArrowLeft' ? game.prev : game.next;
        if (n === null || n === undefined) return;
        ev.preventDefault();
        ctx.navigate(`/rankings/history/${n}`);
    }
    document.addEventListener('keydown', onKey);

    const tickTimer = setInterval(() => { if (game && !document.hidden) render(); }, TICK_MS);
    if (live && valid) pollTimer = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);

    render();
    load();

    return {
        update(next) {
            query = next.query || {};
            render();
            scrollToPlayer();
        },
        unmount() {
            alive = false;
            clearInterval(tickTimer);
            clearInterval(pollTimer);
            document.removeEventListener('keydown', onKey);
        },
    };
}
