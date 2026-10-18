import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../public/js/shared/defaults.js';
import { DIVISIONS, sortTiers, tierById, tierClass, tierFor, tierIndex } from '../public/js/shared/tiers.js';

const tiers = DEFAULT_CONFIG.tiers;

test('tier boundaries: last tier with min <= hype', () => {
    const cases = [
        [0, 'COAL'], [299, 'COAL'], [300, 'COPPER'], [799, 'COPPER'], [800, 'IRON'],
        [1499, 'IRON'], [1500, 'GOLD'], [2499, 'GOLD'], [2500, 'EMERALD'], [3999, 'EMERALD'],
        [4000, 'DIAMOND'], [5999, 'DIAMOND'], [6000, 'NETHERITE'], [123456, 'NETHERITE']
    ];
    for (const [hype, id] of cases) assert.equal(tierFor(hype, tiers).id, id, `hype ${hype}`);
});

test('below the lowest min and bad input clamp to the first tier', () => {
    const custom = [{ id: 'A', name: 'A', min: 100 }, { id: 'B', name: 'B', min: 200 }];
    const t = tierFor(50, custom);
    assert.equal(t.id, 'A');
    assert.equal(t.progress, 0);
    assert.equal(t.division, 'III');
    assert.equal(tierFor(NaN, tiers).id, 'COAL');
    assert.equal(tierFor(undefined, tiers).id, 'COAL');
});

test('divisions: three equal bands III, II, I; none for the top tier', () => {
    assert.deepEqual(DIVISIONS, ['III', 'II', 'I']);
    // Gold: [1500, 2500) -> bands of 333.33
    assert.equal(tierFor(1500, tiers).division, 'III');
    assert.equal(tierFor(1833, tiers).division, 'III');
    assert.equal(tierFor(1834, tiers).division, 'II');
    assert.equal(tierFor(2166, tiers).division, 'II');
    assert.equal(tierFor(2167, tiers).division, 'I');
    assert.equal(tierFor(2499, tiers).division, 'I');
    // Coal: [0, 300) -> 0-99 III, 100-199 II, 200-299 I
    assert.equal(tierFor(99, tiers).division, 'III');
    assert.equal(tierFor(100, tiers).division, 'II');
    assert.equal(tierFor(200, tiers).division, 'I');
    const top = tierFor(9000, tiers);
    assert.equal(top.division, null);
    assert.equal(top.label, 'Netherite');
    assert.equal(tierFor(1900, tiers).label, 'Gold II');
});

test('progress, next and toNext', () => {
    const t = tierFor(2000, tiers);
    assert.equal(t.min, 1500);
    assert.equal(t.next, 2500);
    assert.equal(t.nextName, 'Emerald');
    assert.equal(t.progress, 0.5);
    assert.equal(t.toNext, 500);
    assert.equal(tierFor(1500, tiers).progress, 0);
    const top = tierFor(6500, tiers);
    assert.equal(top.next, null);
    assert.equal(top.nextName, null);
    assert.equal(top.progress, 1);
    assert.equal(top.toNext, 0);
});

test('unsorted tier lists are handled without mutating the input', () => {
    const shuffled = [tiers[3], tiers[0], tiers[6], tiers[1], tiers[5], tiers[2], tiers[4]];
    const copy = [...shuffled];
    assert.equal(tierFor(1600, shuffled).id, 'GOLD');
    assert.equal(tierFor(1600, shuffled).next, 2500);
    assert.deepEqual(shuffled, copy);
    assert.deepEqual(sortTiers(shuffled).map((t) => t.id), tiers.map((t) => t.id));
    assert.equal(tierIndex(4000, shuffled), 5);
});

test('helpers: tierById, tierClass, default tiers', () => {
    assert.equal(tierById('gold', tiers).min, 1500);
    assert.equal(tierById('nope', tiers), null);
    assert.equal(tierClass('NETHERITE'), 'tier-netherite');
    assert.equal(tierFor(500).id, 'COPPER');
});
