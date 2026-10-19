// Dependency-free, responsive SVG line/area chart with an accessible tooltip.
//
//   const chart = createChart(el, { points: [{ x: ms, y: 7490, ...extra }], ... });
//   chart.update({ points, invert, ... });   // merge options and re-render (diff-skipped)
//   chart.destroy();
//
// Points are drawn evenly spaced in the order given (oldest first), so busy days don't
// bunch up; the x axis is labelled with dates (or times when everything is on one day).
// Pointer: hover shows the nearest point, click selects it (touch: tap shows, tap again
// selects). Keyboard: the plot is one tab stop (role=slider) — arrows / Home / End /
// PageUp / PageDown move between points, Enter or Space selects. Re-renders on resize.
import { setHtml, toHtml } from './dom.js';
import { fmtDate, fmtInt, fmtTime } from './format.js';

const FONT_Y = { family: "'Jersey 10', 'Pixelify Sans', monospace", size: 15, spacing: 0.3 };
const FONT_X = { family: "Silkscreen, 'Pixelify Sans', monospace", size: 9, spacing: 0.6 };
const FONT_LAST = { family: "'Jersey 10', 'Pixelify Sans', monospace", size: 19, spacing: 0.3 };

const DEFAULTS = {
    points: [],               // [{ x: epoch ms, y: number, ...anything }], oldest first
    invert: false,            // true: smallest value at the top (e.g. rank #1)
    floor: null,              // lowest value the axis may show (0 for ratings, 1 for ranks)
    integer: true,            // integer tick steps only
    minSpan: null,            // smallest y range shown (flat series get this much room)
    include: [],              // extra values the y axis must cover (e.g. the value before the range)
    formatY: (v) => fmtInt(v),
    formatLast: null,         // label at the newest point (defaults to formatY); false hides it
    formatDay: (x) => fmtDate(x),
    formatTime: (x) => fmtTime(x),
    dayKey: (x) => { const d = new Date(x); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; },
    tooltip: null,            // (point, index, points) → SafeHtml | string
    describe: null,           // (point, index, points) → plain text for assistive tech
    label: 'Chart',           // accessible name of the plot
    help: 'Use the left and right arrow keys to move between points.',
    onSelect: null,           // (point, index) → void
    selectHint: 'Click to open',
    touchHint: 'Tap again to open',
    keyHint: 'Press Enter to open',
    emptyText: 'No data yet',
};

let uid = 0;
let measureCtx;

function textWidth(text, font) {
    const s = String(text);
    if (measureCtx === undefined) {
        try { measureCtx = document.createElement('canvas').getContext('2d'); } catch { measureCtx = null; }
    }
    if (!measureCtx) return s.length * font.size * 0.62 + s.length * font.spacing;
    measureCtx.font = `${font.size}px ${font.family}`;
    return measureCtx.measureText(s).width + s.length * font.spacing;
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r1 = (n) => Math.round(n * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fontAttrs = (f) => `font-family="${esc(f.family)}" font-size="${f.size}" letter-spacing="${f.spacing}"`;

/** A "nice" tick step (1, 2, 2.5, 5 × 10^k) giving about `count` intervals over `span`. */
export function niceStep(span, count = 4, integer = false) {
    const rawStep = Math.max(Math.abs(span), 1e-9) / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    const f = rawStep / mag;
    let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    if (integer) step = step < 1 ? 1 : Math.floor(step);
    return step;
}

/**
 * Axis scale for values in [lo, hi]: { min, max, step, ticks }.
 * Flat ranges are widened to `minSpan`; `floor` clamps the bottom (and becomes a tick).
 */
export function niceScale(lo, hi, { count = 4, integer = false, floor = null, minSpan = null } = {}) {
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = floor ?? 0; hi = lo + 1; }
    if (hi < lo) [lo, hi] = [hi, lo];
    const need = minSpan ?? (integer ? 4 : 1);
    if (hi - lo < need) {
        const mid = (lo + hi) / 2;
        lo = mid - need / 2;
        hi = mid + need / 2;
    }
    if (floor !== null && lo < floor) { hi += floor - lo; lo = floor; }
    const step = niceStep(hi - lo, count, integer);
    const fix = (v) => Number(v.toPrecision(12));
    let min = fix(Math.floor(lo / step + 1e-9) * step);
    const max = fix(Math.ceil(hi / step - 1e-9) * step);
    const ticks = [];
    if (floor !== null && min < floor) { min = floor; ticks.push(floor); }
    for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-6; k++) {
        const t = fix(k * step);
        if (ticks.length && t - ticks[ticks.length - 1] < step * 0.5) continue; // too close to the floor tick
        ticks.push(t);
    }
    return { min, max: max > min ? max : min + step, step, ticks };
}

/** Picks non-overlapping labels, newest first (the right edge matters most). */
function pickLabels(cands, left, right, gap) {
    const kept = [];
    let limit = right;
    for (let i = cands.length - 1; i >= 0; i--) {
        const c = cands[i];
        const half = c.w / 2;
        const cx = clamp(c.x, left + half, right - half);
        if (cx + half > limit) continue;
        kept.push({ ...c, cx });
        limit = cx - half - gap;
    }
    return kept.reverse();
}

export function createChart(el, initial = {}) {
    const id = `chart${++uid}`;
    let opts = { ...DEFAULTS, ...initial };
    let layout = null;      // { W, H, xs, ys, top, bottom, left, right }
    let active = -1;
    let alive = true;
    let downType = 'mouse';
    let activeAtDown = -1;
    let rendered = false;
    let lastSize = '';

    el.classList.add('chart');
    el.innerHTML = `
        <div class="chart-plot" tabindex="0" role="slider" aria-orientation="horizontal" aria-describedby="${id}-help">
            <div class="chart-layer"></div>
            <svg class="chart-hover" aria-hidden="true" focusable="false">
                <line class="chart-cross" x1="0" y1="0" x2="0" y2="0"></line>
                <circle class="chart-halo" cx="0" cy="0" r="9"></circle>
                <circle class="chart-mark" cx="0" cy="0" r="4.5"></circle>
            </svg>
            <div class="chart-tip" aria-hidden="true" hidden></div>
        </div>
        <span class="visually-hidden" id="${id}-help"></span>`;
    const plot = el.querySelector('.chart-plot');
    const layer = el.querySelector('.chart-layer');
    const hover = el.querySelector('.chart-hover');
    const cross = el.querySelector('.chart-cross');
    const halo = el.querySelector('.chart-halo');
    const mark = el.querySelector('.chart-mark');
    const tip = el.querySelector('.chart-tip');
    const help = el.querySelector(`#${id}-help`);

    const pts = () => opts.points || [];

    function build(W, H) {
        const points = pts();
        const n = points.length;
        const values = points.map((p) => Number(p.y)).filter(Number.isFinite);
        let lo = Infinity;
        let hi = -Infinity;
        for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!values.length) { lo = opts.floor ?? 0; hi = lo; }
        else {
            for (const v of [].concat(opts.include ?? [])) {
                if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
            }
        }

        const top = 30;
        const bottom = H - 30;
        const plotH = Math.max(20, bottom - top);
        const count = clamp(Math.round(plotH / 52), 2, 6);
        const scale = niceScale(lo, hi, { count, integer: opts.integer, floor: opts.floor, minSpan: opts.minSpan });
        const labels = scale.ticks.map((t) => ({ t, text: opts.formatY(t) }));
        const yw = Math.max(16, ...labels.map((l) => textWidth(l.text, FONT_Y)));
        const left = Math.ceil(yw + 14);
        const right = W - 14;
        const plotW = Math.max(20, right - left);
        const pad = n > 1 ? Math.min(12, plotW * 0.04) : 0;
        const xs = points.map((_, i) => (n === 1 ? left + plotW / 2 : left + pad + (i * (plotW - pad * 2)) / (n - 1)));
        const yAt = (v) => {
            const t = (v - scale.min) / (scale.max - scale.min || 1);
            return opts.invert ? top + t * plotH : bottom - t * plotH;
        };
        const ys = points.map((p) => yAt(Number(p.y)));
        return { W, H, n, xs, ys, yAt, top, bottom, left, right, plotW, scale, labels };
    }

    function xLabels(L) {
        const points = pts();
        if (!points.length) return [];
        const keys = points.map((p) => opts.dayKey(p.x));
        const oneDay = keys.every((k) => k === keys[0]);
        const cands = [];
        points.forEach((p, i) => {
            if (!oneDay && i > 0 && keys[i] === keys[i - 1]) return;
            const text = oneDay ? opts.formatTime(p.x) : opts.formatDay(p.x);
            cands.push({ i, x: L.xs[i], text, w: textWidth(text.toUpperCase(), FONT_X), day: !oneDay });
        });
        return pickLabels(cands, L.left - 6, L.W - 4, 16);
    }

    function svgMarkup(L) {
        const points = pts();
        const { W, H, n, xs, ys, top, bottom, left, right } = L;
        const parts = [];
        parts.push(`<svg class="chart-svg${opts.invert ? ' chart-inverted' : ''}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">`);
        parts.push(`<defs><linearGradient id="${id}-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".36"></stop><stop offset=".72" stop-color="currentColor" stop-opacity=".07"></stop><stop offset="1" stop-color="currentColor" stop-opacity="0"></stop></linearGradient></defs>`);

        // horizontal grid + y labels
        parts.push('<g class="chart-grid">');
        for (const l of L.labels) {
            const y = Math.round(L.yAt(l.t)) + 0.5;
            parts.push(`<line x1="${left}" x2="${right}" y1="${y}" y2="${y}"></line>`);
            parts.push(`<text class="chart-ylabel" x="${left - 10}" y="${y}" text-anchor="end" dominant-baseline="central" ${fontAttrs(FONT_Y)}>${esc(l.text)}</text>`);
        }
        parts.push('</g>');

        if (!n) {
            parts.push(`<text class="chart-empty" x="${(left + right) / 2}" y="${(top + bottom) / 2}" text-anchor="middle" dominant-baseline="central">${esc(opts.emptyText)}</text></svg>`);
            return parts.join('');
        }

        // x labels (+ faint day separators)
        const xl = xLabels(L);
        parts.push('<g class="chart-xgrid">');
        for (const l of xl) {
            if (l.day && l.i > 0) {
                const x = Math.round(l.x) + 0.5;
                parts.push(`<line x1="${x}" x2="${x}" y1="${top}" y2="${bottom}"></line>`);
            }
            parts.push(`<text class="chart-xlabel" x="${r1(l.cx)}" y="${bottom + 18}" text-anchor="middle" ${fontAttrs(FONT_X)}>${esc(l.text.toUpperCase())}</text>`);
        }
        parts.push('</g>');

        // area + line
        const line = xs.map((x, i) => `${i ? 'L' : 'M'}${r1(x)} ${r1(ys[i])}`).join('');
        if (n > 1) {
            parts.push(`<path class="chart-area" d="${line}L${r1(xs[n - 1])} ${bottom}L${r1(xs[0])} ${bottom}Z" fill="url(#${id}-fill)"></path>`);
            parts.push(`<path class="chart-line" d="${line}" pathLength="1"></path>`);
        } else {
            // a single game: a soft guide from the axis to the dot
            parts.push(`<line class="chart-stem" x1="${r1(xs[0])}" x2="${r1(xs[0])}" y1="${bottom}" y2="${r1(ys[0])}"></line>`);
        }

        // dots (hidden when they would merge into the line)
        const spacing = n > 1 ? (xs[n - 1] - xs[0]) / (n - 1) : Infinity;
        const r = spacing >= 11 ? 3.4 : spacing >= 6 ? 2.6 : spacing >= 3.5 ? 1.8 : 0;
        parts.push('<g class="chart-dots">');
        if (r) for (let i = 0; i < n; i++) parts.push(`<circle cx="${r1(xs[i])}" cy="${r1(ys[i])}" r="${r}"></circle>`);
        parts.push(`<circle class="chart-dot-last" cx="${r1(xs[n - 1])}" cy="${r1(ys[n - 1])}" r="${Math.max(r, 3.4) + 0.6}"></circle>`);
        parts.push('</g>');

        // label for the newest point
        const fmtLast = opts.formatLast === false ? null : (opts.formatLast || opts.formatY);
        if (fmtLast) {
            const text = String(fmtLast(points[n - 1].y, points[n - 1]));
            const w = textWidth(text, FONT_LAST);
            const x = xs[n - 1];
            const y = ys[n - 1];
            const above = y - 14 >= 14;
            const lx = clamp(x, left + w / 2, W - 2 - w / 2);
            parts.push(`<text class="chart-last" x="${r1(lx)}" y="${r1(above ? y - 12 : y + 22)}" text-anchor="middle" ${fontAttrs(FONT_LAST)}>${esc(text)}</text>`);
        }
        parts.push('</svg>');
        return parts.join('');
    }

    function syncAria() {
        const n = pts().length;
        help.textContent = n ? `${opts.help}${opts.onSelect ? ' Press Enter to open the selected point.' : ''}` : '';
        if (!n) {
            plot.setAttribute('role', 'img');
            plot.setAttribute('aria-label', `${opts.label}: ${opts.emptyText}`);
            plot.setAttribute('tabindex', '-1');
            for (const a of ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext', 'aria-orientation']) plot.removeAttribute(a);
            return;
        }
        plot.setAttribute('role', 'slider');
        plot.setAttribute('aria-orientation', 'horizontal');
        plot.setAttribute('aria-label', opts.label);
        plot.setAttribute('tabindex', '0');
        plot.setAttribute('aria-valuemin', '1');
        plot.setAttribute('aria-valuemax', String(n));
        const i = active >= 0 ? active : n - 1;
        plot.setAttribute('aria-valuenow', String(i + 1));
        const p = pts()[i];
        const text = opts.describe ? opts.describe(p, i, pts()) : `${opts.formatDay(p.x)}: ${opts.formatY(p.y)}`;
        plot.setAttribute('aria-valuetext', String(text));
    }

    function render(force = false) {
        if (!alive) return;
        const W = Math.round(plot.clientWidth);
        const H = Math.round(plot.clientHeight);
        if (W < 60 || H < 60) return; // hidden or not laid out yet; the observer calls back
        lastSize = `${W}x${H}`;
        layout = build(W, H);
        let markup = svgMarkup(layout);
        // draw-in animation on the first render with data only
        if (!rendered && layout.n > 1) markup = markup.replace('class="chart-svg"', 'class="chart-svg chart-enter"');
        if (layout.n) rendered = true;
        setHtml(layer, { __html: markup }, { force });
        hover.setAttribute('viewBox', `0 0 ${W} ${H}`);
        hover.setAttribute('width', String(W));
        hover.setAttribute('height', String(H));
        if (active >= layout.n) active = -1;
        syncAria();
        paintActive();
    }

    function paintActive() {
        const on = active >= 0 && layout && active < layout.n;
        plot.classList.toggle('is-active', on);
        if (!on) {
            tip.hidden = true;
            return;
        }
        const x = layout.xs[active];
        const y = layout.ys[active];
        cross.setAttribute('x1', r1(x)); cross.setAttribute('x2', r1(x));
        cross.setAttribute('y1', layout.top); cross.setAttribute('y2', layout.bottom);
        for (const c of [halo, mark]) { c.setAttribute('cx', r1(x)); c.setAttribute('cy', r1(y)); }

        const p = pts()[active];
        const body = opts.tooltip ? toHtml(opts.tooltip(p, active, pts())) : esc(`${opts.formatDay(p.x)} · ${opts.formatY(p.y)}`);
        const hint = opts.onSelect ? `<span class="chart-tip-hint">${esc(downType === 'touch' ? opts.touchHint : downType === 'keyboard' ? opts.keyHint : opts.selectHint)}</span>` : '';
        setHtml(tip, { __html: body + hint });
        tip.hidden = false;
        // place beside the point, flipping to stay inside the plot
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        let left = x + 14;
        if (left + tw > layout.W - 4) left = x - 14 - tw;
        if (left < 4) left = clamp(x - tw / 2, 4, Math.max(4, layout.W - tw - 4));
        let topPx = y - th - 14;
        if (topPx < 4) topPx = y + 16;
        if (topPx + th > layout.H - 4) topPx = Math.max(4, layout.H - th - 4);
        tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(topPx)}px)`;
    }

    function setActive(i) {
        const n = pts().length;
        const next = n ? clamp(i, 0, n - 1) : -1;
        if (next === active && plot.classList.contains('is-active') === (next >= 0)) return;
        active = next;
        syncAria();
        paintActive();
    }

    function clearActive() {
        active = -1;
        syncAria();
        paintActive();
    }

    function indexAt(ev) {
        if (!layout || !layout.n) return -1;
        const rect = plot.getBoundingClientRect();
        const x = (ev.clientX - rect.left) * (layout.W / (rect.width || layout.W));
        const { xs, n } = layout;
        if (n === 1) return 0;
        // xs is evenly spaced → direct index, then nudge to the true nearest
        const step = (xs[n - 1] - xs[0]) / (n - 1);
        return clamp(Math.round((x - xs[0]) / step), 0, n - 1);
    }

    function select(i) {
        const p = pts()[i];
        if (p && typeof opts.onSelect === 'function') opts.onSelect(p, i);
    }

    const onMove = (ev) => {
        if (ev.pointerType === 'touch' && ev.buttons === 0) return;
        if (ev.pointerType) downType = ev.pointerType;
        const i = indexAt(ev);
        if (i >= 0) setActive(i);
    };
    const onLeave = () => {
        if (!plot.matches(':focus-visible')) clearActive();
    };
    const onDown = (ev) => {
        downType = ev.pointerType || 'mouse';
        activeAtDown = active;
    };
    const onClick = (ev) => {
        const i = indexAt(ev);
        if (i < 0) return;
        if (downType === 'touch' && activeAtDown !== i) {
            setActive(i);
            return;
        }
        setActive(i);
        select(i);
    };
    const onKey = (ev) => {
        const n = pts().length;
        if (!n) return;
        const cur = active >= 0 ? active : n - 1;
        const page = Math.max(1, Math.round(n / 10));
        let next = null;
        switch (ev.key) {
            case 'ArrowLeft': case 'ArrowDown': next = cur - 1; break;
            case 'ArrowRight': case 'ArrowUp': next = cur + 1; break;
            case 'PageDown': next = cur - page; break;
            case 'PageUp': next = cur + page; break;
            case 'Home': next = 0; break;
            case 'End': next = n - 1; break;
            case 'Enter': case ' ':
                ev.preventDefault();
                if (active < 0) setActive(cur);
                else select(active);
                return;
            case 'Escape':
                if (active >= 0) { ev.preventDefault(); clearActive(); }
                return;
            default: return;
        }
        ev.preventDefault();
        downType = 'keyboard';
        setActive(next);
    };
    const onFocus = () => {
        // keyboard focus shows the newest point straight away
        if (active < 0 && pts().length && plot.matches(':focus-visible')) {
            downType = 'keyboard';
            setActive(pts().length - 1);
        }
    };
    const onBlur = () => clearActive();

    plot.addEventListener('pointermove', onMove);
    plot.addEventListener('pointerleave', onLeave);
    plot.addEventListener('pointerdown', onDown);
    plot.addEventListener('click', onClick);
    plot.addEventListener('keydown', onKey);
    plot.addEventListener('focus', onFocus);
    plot.addEventListener('blur', onBlur);

    let raf = 0;
    const schedule = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            const size = `${Math.round(plot.clientWidth)}x${Math.round(plot.clientHeight)}`;
            if (size !== lastSize) render();
        });
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    if (ro) ro.observe(plot);
    else window.addEventListener('resize', schedule);
    // label widths are measured with the pixel fonts; re-measure once they arrive
    document.fonts?.ready?.then(() => { if (alive) { lastSize = ''; render(); } });

    render();

    return {
        el,
        update(next = {}) {
            const prevPoints = opts.points || [];
            opts = { ...opts, ...next };
            if (next.points && next.points !== prevPoints) {
                // keep the highlighted point (matched by x) while it is hovered or focused
                const held = active >= 0 && (plot.matches(':focus-visible') || plot.matches(':hover'));
                const x = held ? prevPoints[active]?.x : undefined;
                active = x === undefined ? -1 : (opts.points || []).findIndex((p) => p.x === x);
            }
            lastSize = '';
            render();
        },
        /** Highlight point i (or -1 to clear). */
        setActive(i) { if (i < 0) clearActive(); else setActive(i); },
        destroy() {
            alive = false;
            cancelAnimationFrame(raf);
            if (ro) ro.disconnect();
            else window.removeEventListener('resize', schedule);
            plot.removeEventListener('pointermove', onMove);
            plot.removeEventListener('pointerleave', onLeave);
            plot.removeEventListener('pointerdown', onDown);
            plot.removeEventListener('click', onClick);
            plot.removeEventListener('keydown', onKey);
            plot.removeEventListener('focus', onFocus);
            plot.removeEventListener('blur', onBlur);
        },
    };
}
