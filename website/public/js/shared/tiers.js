// Tier math. Pure ESM: runs unchanged in Node and the browser.
import { DEFAULT_CONFIG } from './defaults.js';

export const DIVISIONS = Object.freeze(['III', 'II', 'I']); // lowest band first

const sortedCache = new WeakMap();

// Tiers sorted by min ascending (memoised per array, input is not mutated).
export function sortTiers(tiers = DEFAULT_CONFIG.tiers) {
    const list = Array.isArray(tiers) && tiers.length ? tiers : DEFAULT_CONFIG.tiers;
    let sorted = sortedCache.get(list);
    if (!sorted) {
        sorted = [...list].sort((a, b) => a.min - b.min);
        sortedCache.set(list, sorted);
    }
    return sorted;
}

// Index of the tier for `hype` in sortTiers(tiers): last tier with min <= hype
// (the lowest tier when hype is below every min).
export function tierIndex(hype, tiers) {
    const sorted = sortTiers(tiers);
    const value = Number.isFinite(hype) ? hype : 0;
    let lo = 0;
    let hi = sorted.length - 1;
    let found = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].min <= value) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

export function tierFor(hype, tiers) {
    const sorted = sortTiers(tiers);
    const value = Number.isFinite(hype) ? hype : 0;
    const index = tierIndex(value, sorted);
    const tier = sorted[index];
    const nextTier = sorted[index + 1] || null;
    if (!nextTier) {
        return {
            id: tier.id, name: tier.name, min: tier.min,
            next: null, nextName: null, division: null,
            label: tier.name, progress: 1, toNext: 0
        };
    }
    const span = nextTier.min - tier.min;
    const offset = value - tier.min;
    const band = span > 0 ? Math.min(2, Math.max(0, Math.floor((offset * 3) / span))) : 0;
    const division = DIVISIONS[band];
    return {
        id: tier.id, name: tier.name, min: tier.min,
        next: nextTier.min, nextName: nextTier.name, division,
        label: `${tier.name} ${division}`,
        progress: span > 0 ? Math.min(1, Math.max(0, offset / span)) : 1,
        toNext: nextTier.min - value
    };
}

export function tierById(id, tiers) {
    const key = String(id ?? '').toUpperCase();
    return sortTiers(tiers).find((t) => t.id === key) || null;
}

// CSS class for a tier id: 'GOLD' -> 'tier-gold'.
export function tierClass(id) {
    return `tier-${String(id ?? 'coal').toLowerCase()}`;
}
