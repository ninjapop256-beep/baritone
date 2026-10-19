// Tier helpers: keys (HT1 ... LT5), points, labels, comparable scores and titles.
// Pure ESM (Node + browser).
import { TIER_KEYS } from './defaults.js';

export { TIER_KEYS };
export const TIERS = Object.freeze([1, 2, 3, 4, 5]);

export function isTier(tier) {
    return Number.isInteger(tier) && tier >= 1 && tier <= 5;
}

/** tierKey(2, true) → 'HT2'; '' for an invalid tier. */
export function tierKey(tier, high) {
    return isTier(tier) ? `${high ? 'HT' : 'LT'}${tier}` : '';
}

/** 'HT2' / 'lt3' / 'RHT1' → { tier, high, retired }; null when it is not a tier key. */
export function parseTierKey(key) {
    const m = /^\s*(R)?(HT|LT)([1-5])\s*$/i.exec(String(key ?? ''));
    return m ? { tier: Number(m[3]), high: m[2].toUpperCase() === 'HT', retired: Boolean(m[1]) } : null;
}

/** Points for a tier from config.points (0 for an invalid tier). */
export function tierPoints(tier, high, config) {
    if (!isTier(tier)) return 0;
    const value = config?.points?.[tierKey(tier, high)];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** { tier, high, retired } → 'HT2', or 'RHT2' when retired; '' when there is no tier. */
export function tierLabel(t) {
    if (!t || !isTier(t.tier)) return '';
    return `${t.retired ? 'R' : ''}${tierKey(t.tier, t.high)}`;
}

/** 'High Tier 2' / 'Low Tier 5'. */
export function tierName(tier, high) {
    return isTier(tier) ? `${high ? 'High' : 'Low'} Tier ${tier}` : '';
}

/** Comparable number, higher is better: HT1 = 11, LT1 = 10 ... HT5 = 3, LT5 = 2; 0 = no tier. */
export function tierScore(tier, high) {
    return isTier(tier) ? (6 - tier) * 2 + (high ? 1 : 0) : 0;
}

/** Inverse of tierScore (clamped to LT5..HT1). */
export function tierFromScore(score) {
    const s = Math.min(11, Math.max(2, Math.round(Number(score) || 2)));
    return { tier: 6 - Math.floor(s / 2), high: s % 2 === 1 };
}

const byMinDesc = (titles) => (Array.isArray(titles) ? titles : [])
    .filter((t) => t && Number.isFinite(t.min))
    .sort((a, b) => b.min - a.min);

/** Highest title whose min <= points; the lowest title when none qualifies; null without titles. */
export function titleFor(points, titles) {
    const list = byMinDesc(titles);
    if (!list.length) return null;
    const p = Number(points) || 0;
    return list.find((t) => p >= t.min) || list[list.length - 1];
}

/** The next title above `points` (to show "N points to Elite"), or null at the top. */
export function nextTitle(points, titles) {
    const p = Number(points) || 0;
    const above = byMinDesc(titles).filter((t) => t.min > p);
    return above.length ? above[above.length - 1] : null;
}
