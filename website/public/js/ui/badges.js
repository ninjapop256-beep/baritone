// Small badge/label helpers that return SafeHtml.
import { html } from './dom.js';
import { fmtSigned, fmtPlace, fmtInt, mapName } from './format.js';

const MODE_COLORS = new Set(['gold', 'red', 'blue', 'green', 'purple']);

/** Lowercase, class-safe tier id ('GOLD' → 'gold'). */
export function tierClass(tierId) {
    return String(tierId || 'coal').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'coal';
}

/** Mode colour class suffix; unknown → 'blue'. */
export function modeColor(color) {
    const c = String(color || '').toLowerCase();
    return MODE_COLORS.has(c) ? c : 'blue';
}

/** Metallic gradient tier name: <span class="tier-text tier-gold">GOLD II</span> */
export function tierText(tierId, label) {
    const text = String(label || tierId || '').toUpperCase();
    return html`<span class="tier-text tier-${tierClass(tierId)}">${text}</span>`;
}

/** Tier name in a pill: <span class="tier-chip tier-gold"><span>GOLD II</span></span> */
export function tierChip(tierId, label) {
    const text = String(label || tierId || '').toUpperCase();
    return html`<span class="tier-chip tier-${tierClass(tierId)}"><span>${text}</span></span>`;
}

/** Tier progress bar; progress 0..1. */
export function tierBar(tierId, progress, label = '') {
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    return html`<div class="tier-bar tier-${tierClass(tierId)}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p * 100)}"${label ? html` aria-label="${label}"` : ''}><span style="--p:${p.toFixed(4)}"></span></div>`;
}

/** Game mode pill coloured by game.modeColor: <span class="mode-pill mode-gold">BATTLE ROYALE</span> */
export function modePill(game) {
    const g = game || {};
    const name = String(g.modeName || mapName(g.mode) || 'Event').toUpperCase();
    // inner span: lets a long custom name end in an ellipsis (the title then shows all of it)
    return html`<span class="mode-pill mode-${modeColor(g.modeColor)}"${name.length > 18 ? html` title="${name}"` : ''}><span>${name}</span></span>`;
}

/** Neutral chip: <span class="chip cls">text</span> */
export function chip(text, cls = '') {
    return html`<span class="chip${cls ? ' ' + cls : ''}">${text}</span>`;
}

/** Hype change: <span class="delta pos">+300</span> / neg / zero */
export function hypeDelta(n) {
    const v = Number(n);
    if (n === null || n === undefined || !Number.isFinite(v)) return html`<span class="delta zero">—</span>`;
    const r = Math.round(v);
    const cls = r > 0 ? 'pos' : (r < 0 ? 'neg' : 'zero');
    return html`<span class="delta ${cls}">${fmtSigned(r)}</span>`;
}

/** Placement: <span class="place place-1">#1</span> (place-1..3 get medal colours) */
export function placeText(n) {
    const v = Math.round(Number(n));
    const medal = v >= 1 && v <= 3 ? ` place-${v}` : '';
    return html`<span class="place${medal}">${fmtPlace(n)}</span>`;
}

/** '650 ranked players' with the figure in the numbers font (Pixelify's 5 reads like an S). */
export function countText(n, word, pluralWord = `${word}s`) {
    return html`<span class="digits rk-count">${fmtInt(n)}</span> ${Number(n) === 1 ? word : pluralWord}`;
}
