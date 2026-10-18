// Player profile (/profile/:name): skin card, event stats, ladder neighbours, header with
// global rank + stat tiles + tier progress, Hype/rank history chart and the game list.
// Each card is its own diff-skipped part, so the 30 s live refresh only touches what changed.
import { html, setHtml, qs, on } from '../ui/dom.js';
import { tierChip, tierText, tierBar, tierClass, modePill, chip, hypeDelta, placeText } from '../ui/badges.js';
import {
    fmtInt, fmtDec, fmtPct, fmtDate, fmtDateYear, fmtDateTime, fmtTime, fmtRelative, fmtSigned,
    mapName, teamSizeLabel, plural,
} from '../ui/format.js';
import { skinImg } from '../ui/skins.js';
import { createChart } from '../ui/chart.js';

const POLL_MS = 30000;
const DAY = 24 * 60 * 60 * 1000;
const FIRST_PAGE = 15;
const MORE_STEP = 30;
const RANGES = [
    { id: '7d', label: '7D', days: 7, text: 'the last 7 days' },
    { id: '30d', label: '30D', days: 30, text: 'the last 30 days' },
    { id: '90d', label: '90D', days: 90, text: 'the last 90 days' },
    { id: 'all', label: 'All', days: null, text: 'all time' },
];
const METRICS = ['hype', 'rank'];

// Original pixel glyphs (the pixel fonts have no hearts or triangles).
const HEART = html`<svg class="pf-heart" viewBox="0 0 7 6" width="13" height="11" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M1 0h2v1H1zM4 0h2v1H4zM0 1h7v2H0zM1 3h5v1H1zM2 4h3v1H2zM3 5h1v1H3z"/><path fill="#fff" fill-opacity=".55" d="M1 1h1v1H1z"/></svg>`;
const UP = html`<svg class="pf-tri" viewBox="0 0 5 3" width="10" height="6" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M2 0h1v1h1v1h1v1H0V2h1V1h1z"/></svg>`;
const DOWN = html`<svg class="pf-tri" viewBox="0 0 5 3" width="10" height="6" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M0 0h5v1H4v1H3v1H2V2H1V1H0z"/></svg>`;

// Jersey 10 advance widths (em) so the outlined rank numeral can be sized to fill the card.
const NUM_EM = { '#': 0.64, 0: 0.37, 1: 0.21, 4: 0.37, 5: 0.37, 7: 0.37 };
const numeralEm = (text) => [...text].reduce((sum, ch) => sum + (NUM_EM[ch] ?? 0.43), 0);

// Pixelify's 5 reads like an S: set digit runs inside running text in the figures font.
const NUM_RUN = /\d(?:[\d,.:]*\d)?/g;
function nums(text) {
    const s = String(text ?? '');
    const out = [];
    let last = 0;
    for (const m of s.matchAll(NUM_RUN)) {
        out.push(s.slice(last, m.index), html`<span class="pf-n">${m[0]}</span>`);
        last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return html`${out}`;
}

const pickMetric = (q) => (METRICS.includes(q?.chart) ? q.chart : 'hype');
const pickRange = (q) => (RANGES.some((r) => r.id === q?.range) ? q.range : 'all');
const rangeById = (id) => RANGES.find((r) => r.id === id) || RANGES[RANGES.length - 1];
const short = (s, n = 32) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Chart points for a range; each keeps the previous game's rank for "moved" deltas. */
function buildPoints(history, range, now, metric) {
    const since = range.days ? now - range.days * DAY : -Infinity;
    const out = [];
    for (let i = 0; i < history.length; i++) {
        const h = history[i];
        if (!(h.at >= since)) continue;
        out.push({
            ...h,
            x: h.at,
            y: metric === 'rank' ? h.rank : h.hype,
            prevRank: i > 0 ? history[i - 1].rank : null,
            hypeBefore: h.hype - h.change,
        });
    }
    return out;
}

function summarize(points, metric) {
    if (!points.length) return null;
    const first = points[0];
    const last = points[points.length - 1];
    let hi = -Infinity;
    let lo = Infinity;
    for (const p of points) {
        if (p.y > hi) hi = p.y;
        if (p.y < lo) lo = p.y;
    }
    const change = metric === 'rank'
        ? (first.prevRank ?? first.rank) - last.rank // positive = climbed
        : last.hype - first.hypeBefore;
    return { change, hi, lo, games: points.length };
}

export function mount(root, ctx) {
    const { api, config, shell } = ctx;
    const ratingName = config.ratingName || 'Hype';
    const key = String(ctx.params?.name ?? '').trim();
    const state = {
        data: null,
        metric: pickMetric(ctx.query),
        range: pickRange(ctx.query),
        table: false,
        shown: FIRST_PAGE,
    };
    let alive = true;
    let inflight = false;
    let timer = 0;
    let chart = null;
    let chartSig = '';

    const back = shell.backLink(ctx.href('/rankings/overall'), 'Back to rankings');
    const profileHref = (name) => ctx.href(`/profile/${encodeURIComponent(name)}`);
    // ?player= makes the game page highlight (and scroll to) this player's team
    const gamePath = (n, name) => `/rankings/history/${n}${name ? `?player=${encodeURIComponent(name)}` : ''}`;
    const gameHref = (n, name) => ctx.href(gamePath(n, name));
    const part = (name) => qs(`[data-part="${name}"]`, root);

    // ---------- whole-page states ----------
    function loadingView() {
        const line = (w) => html`<span class="skeleton pf-sk-w${w}"></span>`;
        return html`${back}
            <div class="pf pf-loading" aria-hidden="true">
                <section class="card pf-skin">
                    <div class="pf-stage"><span class="skeleton pf-sk-body"></span></div>
                    <div class="pf-skin-foot"><div class="pf-foot-cell">${line(70)}${line(50)}</div><div class="pf-foot-cell">${line(60)}${line(45)}</div></div>
                </section>
                <section class="card card-pad pf-head">
                    <span class="skeleton pf-sk-name"></span>
                    <span class="skeleton pf-sk-chips"></span>
                    <div class="stat-grid pf-tiles">${[0, 1, 2, 3, 4, 5].map(() => html`<div class="stat-tile pf-sk-tile">${line(40)}${line(65)}</div>`)}</div>
                    <span class="skeleton pf-sk-bar"></span>
                </section>
                <div class="pf-col pf-side"><section class="card card-pad pf-stats">${[0, 1, 2, 3, 4, 5].map(() => html`<span class="skeleton pf-sk-stat"></span>`)}</section></div>
                <div class="pf-col pf-main"><section class="card card-pad pf-chart"><div class="loading pf-sk-chart">Loading player…</div></section></div>
            </div>
            <p class="visually-hidden" role="status">Loading player ${key}…</p>`;
    }

    function notFoundView() {
        return html`${back}
            <section class="card card-pad pf-missing">
                <div class="mystery" aria-hidden="true"><span class="mystery-block"><span class="mystery-q">?</span></span></div>
                <h1 class="pf-missing-title">Player not found</h1>
                <p class="card-sub">Nobody called <strong class="pf-missing-name">${short(key || '(blank)')}</strong> has played a ranked game yet.
                    Names match exactly, ignoring capitals — check the spelling or search the ladder.</p>
                <div class="pf-missing-actions">
                    ${key ? html`<a class="btn btn-primary" href="${ctx.href(`/rankings/overall?q=${encodeURIComponent(key.slice(0, 32))}`)}">Search the rankings</a>` : ''}
                    <a class="btn btn-ghost" href="${ctx.href('/rankings/overall')}">Back to rankings</a>
                </div>
            </section>`;
    }

    function errorView(err) {
        return html`${back}
            <section class="card card-pad">
                <div class="error-box" role="alert">
                    <p class="error-title">Couldn't load this player</p>
                    <p class="error-text">${err?.message || 'Something went wrong while loading the profile.'}</p>
                    <div class="error-actions">
                        <button class="btn" type="button" data-app-retry>Try again</button>
                        <a class="btn btn-ghost" href="${ctx.href('/rankings/overall')}">Back to rankings</a>
                    </div>
                </div>
            </section>`;
    }

    function frameView() {
        return html`${back}
            <div class="pf" data-ready>
                <section class="card pf-skin" data-part="skin" aria-label="Skin and activity"></section>
                <section class="card card-pad pf-head" data-part="head"></section>
                <div class="pf-col pf-side">
                    <section class="card card-pad pf-stats" data-part="stats" aria-labelledby="pf-stats-title"></section>
                    <section class="card card-pad pf-near" data-part="near" aria-labelledby="pf-near-title"></section>
                </div>
                <div class="pf-col pf-main">
                    <section class="card card-pad pf-chart" data-chart-card aria-labelledby="pf-chart-title">
                        <div data-part="chart-head"></div>
                        <div data-part="chart-summary"></div>
                        <div class="pf-plot">
                            <div class="pf-chart-canvas" data-chart></div>
                            <div class="pf-chart-none" data-part="chart-empty" hidden></div>
                        </div>
                        <div class="pf-chart-foot">
                            <div data-part="chart-toggle"></div>
                            <div class="pf-table-wrap" id="pf-table" data-part="chart-table" role="region" aria-labelledby="pf-table-caption" tabindex="0" hidden></div>
                        </div>
                    </section>
                    <section class="card card-pad pf-games" data-part="games" aria-labelledby="pf-games-title"></section>
                </div>
            </div>`;
    }

    // ---------- card parts ----------
    function skinPart(p, now) {
        const rank = `#${p.position}`;
        const medal = p.position <= 3 ? ` pf-ghost-${p.position}` : '';
        return html`
            <div class="pf-stage">
                <div class="pf-stage-chip">${tierChip(p.tier, p.tierLabel)}</div>
                <span class="pf-ghost${medal}" aria-hidden="true">${rank}</span>
                ${skinImg(p, { kind: 'body', size: 300, cls: 'pf-body', lazy: false, alt: `${p.name}'s skin` })}
            </div>
            <dl class="pf-skin-foot">
                <div class="pf-foot-cell">
                    <dt class="label">Last played</dt>
                    <dd class="pf-foot-v digits">${fmtDateYear(p.lastSeen)}</dd>
                    <dd class="pf-sub" title="${fmtDateTime(p.lastSeen)}">${nums(fmtRelative(p.lastSeen, now))}</dd>
                </div>
                <div class="pf-foot-cell">
                    <dt class="label">Games</dt>
                    <dd class="pf-foot-v digits">${fmtInt(p.events)}</dd>
                    <dd class="pf-sub">${nums(`${fmtInt(p.events30d)} in 30 days`)}</dd>
                </div>
            </dl>`;
    }

    function headPart(p) {
        const pct = p.total ? Math.max(1, Math.ceil((p.position / p.total) * 100)) : null;
        const medal = p.position <= 3 ? ` place-${p.position}` : '';
        const top = p.nextTierMin === null || p.nextTierMin === undefined;
        const tile = (label, value) => html`<div class="stat-tile"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`;
        return html`
            <div class="pf-head-top">
                <div class="pf-id">
                    <h1 class="pf-name">${p.name}</h1>
                    <div class="pf-badges">
                        ${tierText(p.tier, p.tierName)}
                        ${chip(p.division ? `Division ${p.division}` : 'Top tier', 'plain')}
                        ${pct !== null && pct <= 50 ? chip(`Top ${pct}%`, 'plain') : ''}
                    </div>
                </div>
                <div class="pf-rankbox">
                    <span class="label">Global rank</span>
                    <span class="pf-rank-n digits${medal}">#${fmtInt(p.position)}</span>
                    <span class="pf-sub">${nums(`of ${plural(p.total, 'player')}`)}</span>
                </div>
            </div>
            <div class="stat-grid pf-tiles">
                ${tile(ratingName, fmtInt(p.hype))}
                ${tile('Wins', fmtInt(p.wins))}
                ${tile('Win rate', fmtPct(p.winRate))}
                ${tile('Kills', fmtInt(p.kills))}
                ${tile('Deaths', fmtInt(p.deaths))}
                ${tile('K/D', fmtDec(p.kd, 2))}
            </div>
            <div class="pf-progress${top ? ' is-top' : ''}">
                <div class="pf-progress-row">
                    ${tierText(p.tier, p.tierLabel)}
                    <span class="pf-progress-next">${top
                        ? 'Highest tier reached'
                        : html`<span class="digits">${fmtInt(p.toNext)}</span> ${ratingName} to ${p.nextTierName}`}</span>
                </div>
                ${tierBar(p.tier, p.progress, top ? `${p.tierName}: highest tier reached` : `${p.tierName} progress: ${fmtPct(p.progress, 0)}, ${fmtInt(p.toNext)} ${ratingName} to ${p.nextTierName}`)}
            </div>`;
    }

    function statsPart(p) {
        const rows = [
            ['Average placement', p.events ? `#${fmtDec(p.averagePlacement, 1)}` : '—'],
            ['Best finish', p.bestPlacement ? placeText(p.bestPlacement) : '—'],
            ['Top 3 finishes', html`${fmtInt(p.podiums)}<span class="pf-stat-aside">${fmtPct(p.top3Rate, 0)}</span>`],
            ['Kills per event', fmtDec(p.killsPerEvent, 2)],
            ['Damage dealt', p.damage ? html`${fmtInt(p.damage)}${HEART}` : '—'],
            ['Events (30 days)', fmtInt(p.events30d)],
            [`Peak ${ratingName}`, fmtInt(p.peakHype)],
        ];
        return html`<h2 class="card-title" id="pf-stats-title">Event Stats</h2>
            <dl class="pf-statlist">${rows.map(([k, v]) => html`<div class="pf-stat"><dt>${k}</dt><dd class="num">${v}</dd></div>`)}</dl>`;
    }

    function nearPart(list, me) {
        return html`<h2 class="card-title" id="pf-near-title">Nearby on the Ladder</h2>
            <ol class="pf-near-list" role="list">${list.map((n) => {
                const cur = n.uuid === me.uuid;
                const inner = html`
                    <span class="pf-near-pos">${placeText(n.position)}</span>
                    ${skinImg(n, { size: 30 })}
                    <span class="pf-near-who"><span class="pf-near-name truncate">${n.name}</span>${tierText(n.tier, n.tierLabel)}</span>
                    <span class="num pf-near-hype">${fmtInt(n.hype)}</span>`;
                return html`<li>${cur
                    ? html`<div class="row pf-near-row is-current" aria-current="true">${inner}</div>`
                    : html`<a class="row pf-near-row" href="${profileHref(n.name)}">${inner}</a>`}</li>`;
            })}</ol>`;
    }

    function chartHeadPart() {
        const rank = state.metric === 'rank';
        const range = rangeById(state.range);
        return html`<div class="card-head pf-chart-head">
                <div class="pf-chart-titles">
                    <h2 class="card-title" id="pf-chart-title">${rank ? 'Rank History' : `${ratingName} History`}</h2>
                    <p class="card-sub">${rank ? 'Ladder position after each ranked game.' : `${ratingName} after each ranked game.`}<span class="hide-sm"> Hover a dot for details, click to open the game.</span></p>
                </div>
                <div class="pf-chart-controls">
                    <div class="seg" role="group" aria-label="Chart value">
                        <button type="button" data-metric="hype" data-focus="metric-hype" aria-pressed="${!rank}">${ratingName}</button>
                        <button type="button" data-metric="rank" data-focus="metric-rank" aria-pressed="${rank}">Rank</button>
                    </div>
                    <div class="seg" role="group" aria-label="Time range">
                        ${RANGES.map((r) => html`<button type="button" data-range="${r.id}" data-focus="range-${r.id}" aria-pressed="${r.id === range.id}" title="${r.days ? `Last ${r.days} days` : 'All time'}">${r.label}</button>`)}
                    </div>
                </div>
            </div>`;
    }

    function signed(n, unit = '') {
        if (n === null || n === undefined || !Number.isFinite(n)) return html`<span class="pf-sum-change zero">—</span>`;
        const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero';
        const glyph = n > 0 ? UP : n < 0 ? DOWN : '';
        return html`<span class="pf-sum-change ${cls}">${glyph}<span class="digits">${fmtSigned(n)}</span>${unit ? html`<span class="pf-sum-unit">${unit}</span>` : ''}</span>`;
    }

    function rankMove(n) {
        if (n === null || n === undefined) return html`<span class="chip plain">First game</span>`;
        const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero';
        const glyph = n > 0 ? UP : n < 0 ? DOWN : '';
        return html`<span class="delta ${cls} pf-move">${glyph}${n === 0 ? '±0' : fmtInt(Math.abs(n))}</span>`;
    }

    function summaryPart(points) {
        const s = summarize(points, state.metric);
        const rank = state.metric === 'rank';
        const val = (v, prefix = '') => (s ? `${prefix}${fmtInt(v)}` : '—');
        const items = rank
            ? [
                ['Change', s ? signed(s.change, s.change === 1 || s.change === -1 ? 'place' : 'places') : signed(null)],
                ['Best', val(s?.lo, '#')],
                ['Worst', val(s?.hi, '#')],
                ['Games', val(s?.games)],
            ]
            : [
                ['Change', s ? signed(s.change, ratingName) : signed(null)],
                ['Peak', val(s?.hi)],
                ['Low', val(s?.lo)],
                ['Games', val(s?.games)],
            ];
        return html`<dl class="pf-summary">${items.map(([k, v]) => html`<div class="pf-sum"><dt class="label">${k}</dt><dd class="pf-sum-v">${v}</dd></div>`)}</dl>`;
    }

    function emptyRangePart(range, p, now) {
        return html`<p class="empty-title">No games in ${range.text}</p>
            <p class="empty-text">${p.name} last played a ranked game ${nums(fmtRelative(p.lastSeen, now))}.</p>
            <button class="btn btn-sm" type="button" data-range="all" data-focus="range-all-empty">Show all time</button>`;
    }

    function tablePart(points) {
        const range = rangeById(state.range);
        const rows = points.slice().reverse();
        return html`<table class="pf-table">
                <caption class="visually-hidden" id="pf-table-caption">${ratingName} and rank after each ranked game, ${range.text}, newest first</caption>
                <thead><tr>
                    <th scope="col">Game</th><th scope="col">Date</th><th scope="col" class="right">Place</th>
                    <th scope="col" class="right">${ratingName}</th><th scope="col" class="right">Change</th><th scope="col" class="right">Rank</th>
                </tr></thead>
                <tbody>${rows.length ? rows.map((pt) => html`<tr>
                    <th scope="row"><a class="link" href="${gameHref(pt.number, state.data?.player?.name)}">#${pt.number}</a></th>
                    <td>${nums(fmtDateTime(pt.at))}</td>
                    <td class="right">${placeText(pt.placement)}<span class="pf-table-of"> / ${fmtInt(pt.teams)}</span></td>
                    <td class="right num">${fmtInt(pt.hype)}</td>
                    <td class="right">${hypeDelta(pt.change)}</td>
                    <td class="right num">#${fmtInt(pt.rank)}</td>
                </tr>`) : html`<tr><td colspan="6" class="pf-table-none">No games in ${range.text}.</td></tr>`}</tbody>
            </table>`;
    }

    function togglePart() {
        return html`<button type="button" class="pf-table-toggle" data-toggle-table data-focus="table" aria-expanded="${state.table}" aria-controls="pf-table">
            <span class="pf-caret" aria-hidden="true"></span>${state.table ? 'Hide table' : 'Show as table'}</button>`;
    }

    function gameRow(g, now, playerName) {
        const unit = g.teamSize > 1 ? 'teams' : 'players';
        const when = g.startedAt ?? g.endedAt; // start time, like the game history list and game page
        return html`<li><a class="row pf-game" href="${gameHref(g.number, playerName)}" data-game="${g.number}">
            <span class="cell pf-game-when hide-sm">
                <span class="pf-game-day">${nums(fmtDate(when))}</span>
                <span class="pf-sub" title="${fmtDateTime(when)}">${nums(`${fmtTime(when)} · ${fmtRelative(when, now)}`)}</span>
            </span>
            <span class="cell pf-game-event">
                <span class="pf-game-pills">${modePill(g)}${chip(teamSizeLabel(g.teamSize))}</span>
                <span class="pf-sub truncate">${nums(`Game #${g.number}`)}${g.map ? ` · ${mapName(g.map)}` : ''}</span>
                <span class="pf-sub show-sm">${nums(`${fmtDate(when)}, ${fmtTime(when)} · ${plural(g.kills, 'kill')}`)}</span>
            </span>
            <span class="cell pf-game-place">${placeText(g.placement)}<span class="pf-sub">${nums(`of ${fmtInt(g.teams)} ${unit}`)}</span></span>
            <span class="cell pf-game-kills hide-sm"><span class="num">${fmtInt(g.kills)}</span><span class="pf-sub">${g.kills === 1 ? 'kill' : 'kills'}</span></span>
            <span class="cell pf-game-hype">${hypeDelta(g.hypeChange)}<span class="pf-sub">${nums(fmtInt(g.hypeAfter))} ${ratingName}</span></span>
        </a></li>`;
    }

    function gamesPart(games, now) {
        const shown = Math.min(state.shown, games.length);
        const rest = games.length - shown;
        return html`<div class="card-head pf-games-head">
                <div>
                    <h2 class="card-title" id="pf-games-title">Game History</h2>
                    <p class="card-sub">${nums(plural(games.length, 'ranked game'))}, newest first. Open one for its full results.</p>
                </div>
            </div>
            ${games.length
                ? html`<ol class="pf-game-list" role="list">${games.slice(0, shown).map((g) => gameRow(g, now, state.data?.player?.name))}</ol>`
                : html`<div class="empty"><p class="empty-title">No ranked games yet</p></div>`}
            ${rest > 0 ? html`<div class="pf-more"><button class="btn" type="button" data-more data-focus="more">Show ${fmtInt(Math.min(rest, MORE_STEP))} more</button></div>` : ''}`;
    }

    // ---------- rendering ----------
    /** Re-render while keeping keyboard focus on the same logical control. */
    function keepFocus(fn) {
        const a = document.activeElement;
        const k = a instanceof Element && root.contains(a) ? a.getAttribute('data-focus') : null;
        fn();
        if (k && !root.contains(a)) qs(`[data-focus="${k}"]`, root)?.focus({ preventScroll: true });
    }

    function setTierClass(el, base, tier) {
        const cls = `${base} tier-${tierClass(tier)}`;
        if (el && el.className !== cls) el.className = cls;
    }

    function tipFor(pt) {
        const rank = state.metric === 'rank';
        const head = html`<span class="chart-tip-k">Game #${pt.number}</span>`;
        const date = html`<span class="chart-tip-date">${nums(fmtDateTime(pt.at))}</span>`;
        if (rank) {
            return html`${head}
                <span class="chart-tip-v"><span class="digits">#${fmtInt(pt.rank)}</span><small>on the ladder</small></span>
                <span class="chart-tip-row">${rankMove(pt.prevRank === null ? null : pt.prevRank - pt.rank)}<span class="chart-tip-aside">${nums(fmtInt(pt.hype))} ${ratingName}</span></span>
                ${date}`;
        }
        return html`${head}
            <span class="chart-tip-v"><span class="digits">${fmtInt(pt.hype)}</span><small>${ratingName}</small></span>
            <span class="chart-tip-row">${hypeDelta(pt.change)}<span class="chart-tip-aside">${placeText(pt.placement)} of ${nums(fmtInt(pt.teams))}</span></span>
            ${date}`;
    }

    function describe(pt) {
        const when = fmtDateTime(pt.at);
        const place = `placed ${fmtInt(pt.placement)} of ${fmtInt(pt.teams)}`;
        if (state.metric === 'rank') {
            const moved = pt.prevRank === null ? 'first game' : `${pt.prevRank - pt.rank >= 0 ? 'up' : 'down'} ${fmtInt(Math.abs(pt.prevRank - pt.rank))}`;
            return `Game ${pt.number}, ${when}: rank ${fmtInt(pt.rank)}, ${moved}, ${place}`;
        }
        return `Game ${pt.number}, ${when}: ${fmtInt(pt.hype)} ${ratingName}, ${fmtSigned(pt.change)}, ${place}`;
    }

    function renderChart() {
        const d = state.data;
        if (!d) return;
        const now = ctx.now();
        const range = rangeById(state.range);
        const rank = state.metric === 'rank';
        const points = buildPoints(d.history || [], range, now, state.metric);
        const card = qs('[data-chart-card]', root);
        if (card) {
            const cls = `card card-pad pf-chart tier-${tierClass(d.player.tier)} metric-${state.metric}`;
            if (card.className !== cls) card.className = cls;
        }
        keepFocus(() => {
            setHtml(part('chart-head'), chartHeadPart());
            setHtml(part('chart-summary'), summaryPart(points));
            setHtml(part('chart-toggle'), togglePart());
            const empty = part('chart-empty');
            const canvas = qs('[data-chart]', root);
            const none = points.length === 0;
            if (empty) {
                empty.hidden = !none;
                setHtml(empty, none ? emptyRangePart(range, d.player, now) : '');
            }
            if (canvas) canvas.hidden = none;
            const table = part('chart-table');
            if (table) {
                table.hidden = !state.table;
                setHtml(table, state.table ? tablePart(points) : '');
            }
        });

        const sig = `${state.metric}|${range.id}|${ratingName}|${points.map((p) => `${p.number}:${p.y}`).join(',')}`;
        if (sig === chartSig || !chart) return;
        chartSig = sig;
        chart.update({
            points,
            invert: rank,
            floor: rank ? 1 : 0,
            minSpan: rank ? 4 : 40,
            // keep the value from before the range on the axis (0 for a newcomer's first game)
            include: points.length ? [rank ? points[0].prevRank : points[0].hypeBefore] : [],
            integer: true,
            formatY: rank ? (v) => `#${fmtInt(v)}` : (v) => fmtInt(v),
            label: `${rank ? 'Rank' : ratingName} history chart, ${range.text}`,
            help: 'Use the left and right arrow keys to move between games.',
            tooltip: tipFor,
            describe,
            emptyText: `No games in ${range.text}`,
            selectHint: 'Click to open the game',
            touchHint: 'Tap again to open the game',
            keyHint: 'Press Enter to open the game',
        });
    }

    function renderGames() {
        const d = state.data;
        if (!d) return;
        keepFocus(() => setHtml(part('games'), gamesPart(d.games || [], ctx.now())));
    }

    function renderAll() {
        const d = state.data;
        if (!qs('.pf[data-ready]', root)) {
            chart?.destroy();
            setHtml(root, frameView());
            chartSig = '';
            chart = createChart(qs('[data-chart]', root), {
                onSelect: (pt) => ctx.navigate(gamePath(pt.number, state.data?.player?.name)),
            });
        }
        const p = d.player;
        const now = ctx.now();
        shell.setTitle(p.name);
        setTierClass(part('skin'), 'card pf-skin', p.tier);
        setTierClass(part('head'), 'card card-pad pf-head', p.tier);
        setHtml(part('skin'), skinPart(p, now));
        qs('.pf-ghost', root)?.style.setProperty('--em', numeralEm(`#${p.position}`).toFixed(3));
        setHtml(part('head'), headPart(p));
        qs('.pf-name', root)?.style.setProperty('--nl', String(Math.max(6, [...p.name].length)));
        setHtml(part('stats'), statsPart(p));
        const near = part('near');
        if (near) {
            near.hidden = !(d.neighbors && d.neighbors.length > 1);
            setHtml(near, near.hidden ? '' : nearPart(d.neighbors, p));
        }
        renderChart();
        renderGames();
    }

    function showMissing() {
        chart?.destroy();
        chart = null;
        state.data = null;
        shell.setTitle('Player not found');
        setHtml(root, notFoundView());
    }

    async function load(initial) {
        if (inflight || !alive) return;
        if (!key) { showMissing(); return; }
        inflight = true;
        try {
            const data = await api.profile(key);
            if (!alive) return;
            if (!data?.player) throw new Error('The server sent an incomplete profile.');
            state.data = data;
            renderAll();
        } catch (err) {
            if (!alive) return;
            if (err?.status === 404) showMissing();
            else if (initial || !state.data) setHtml(root, errorView(err));
            else console.warn('Profile refresh failed:', err?.message || err);
        } finally {
            inflight = false;
        }
    }

    // ---------- interaction ----------
    const syncQuery = () => ctx.setQuery({
        chart: state.metric === 'hype' ? null : state.metric,
        range: state.range === 'all' ? null : state.range,
    });

    const offs = [
        on(root, 'click', '[data-metric]', (ev, el) => {
            const m = el.getAttribute('data-metric');
            if (!METRICS.includes(m) || m === state.metric) return;
            state.metric = m;
            syncQuery();
            renderChart();
        }),
        on(root, 'click', '[data-range]', (ev, el) => {
            const r = el.getAttribute('data-range');
            if (!RANGES.some((x) => x.id === r) || r === state.range) return;
            const fromEmpty = el.closest('[data-part="chart-empty"]');
            state.range = r;
            syncQuery();
            renderChart();
            if (fromEmpty) qs(`[data-focus="range-${r}"]`, root)?.focus({ preventScroll: true });
        }),
        on(root, 'click', '[data-toggle-table]', () => {
            state.table = !state.table;
            renderChart();
        }),
        on(root, 'click', '[data-more]', () => {
            const before = state.shown;
            state.shown += MORE_STEP;
            renderGames();
            // move focus to the first newly revealed game so keyboard users keep their place
            qs(`.pf-game-list > li:nth-child(${before + 1}) a`, root)?.focus({ preventScroll: true });
        }),
    ];

    setHtml(root, loadingView());
    load(true);
    if (ctx.live) {
        timer = setInterval(() => { if (!document.hidden && state.data) load(false); }, POLL_MS);
    }

    return {
        update(next) {
            const metric = pickMetric(next?.query);
            const range = pickRange(next?.query);
            if (metric === state.metric && range === state.range) return;
            state.metric = metric;
            state.range = range;
            renderChart();
        },
        unmount() {
            alive = false;
            clearInterval(timer);
            offs.forEach((off) => off());
            chart?.destroy();
            chart = null;
        },
    };
}
