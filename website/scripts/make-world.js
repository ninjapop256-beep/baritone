#!/usr/bin/env node
// Generates public/img/world.svg: an original, blocky Minecraft-style sunset landscape
// (pink/violet sky, pixel clouds + sun, layered hills, blossom trees, water, grass).
// Deterministic: the same SEED always produces the same file. The page blurs it via CSS.
//
// Usage: node scripts/make-world.js [--seed=N] [--out=path]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(args.out || resolve(here, '../public/img/world.svg'));
const SEED = Number(args.seed ?? 20261018) >>> 0;

const B = 16;           // block size in SVG units
const W = 120;          // grid width in blocks  (1920 units)
const H = 68;           // grid height in blocks (1088 units)
const HORIZON = 40;     // first row below the far hills' baseline
const WATER_TOP = 44;
const WATER_BOTTOM = 52;

// ---------- seeded helpers ----------
function mulberry32(a) {
    return function next() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(SEED);
const rint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// Smooth 1D noise from a few random sine waves.
function wave(amps) {
    const parts = amps.map(([amp, freq]) => ({ amp, freq, phase: rand() * Math.PI * 2 }));
    return (x) => parts.reduce((s, p) => s + p.amp * Math.sin(x * p.freq + p.phase), 0);
}

function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function mix(a, b, t) {
    const A = hexToRgb(a); const Bc = hexToRgb(b);
    return rgbToHex(A.map((v, i) => v + (Bc[i] - v) * t));
}
function ramp(stops, t) {
    // stops: [[pos, hex], ...] sorted by pos
    if (t <= stops[0][0]) return stops[0][1];
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
            const [p0, c0] = stops[i - 1]; const [p1, c1] = stops[i];
            return mix(c0, c1, (t - p0) / (p1 - p0));
        }
    }
    return stops[stops.length - 1][1];
}

// ---------- the grid ----------
const grid = Array.from({ length: H }, () => new Array(W).fill(null));
const set = (x, y, c) => {
    if (c && x >= 0 && x < W && y >= 0 && y < H) grid[y][x] = c;
};
const get = (x, y) => (x >= 0 && x < W && y >= 0 && y < H ? grid[y][x] : null);

// ---------- sky: stepped bands, violet -> pink -> peach ----------
const SKY = [
    [0.00, '#3a2c74'],
    [0.18, '#5b3f97'],
    [0.38, '#9658b0'],
    [0.58, '#d872ad'],
    [0.76, '#f59bb0'],
    [0.90, '#ffbea6'],
    [1.00, '#ffd9ae'],
];
for (let y = 0; y < HORIZON + 4; y++) {
    const band = Math.floor(y / 2) * 2; // 2-row bands keep it blocky
    const c = ramp(SKY, band / (HORIZON + 2));
    for (let x = 0; x < W; x++) set(x, y, c);
}
// a little dithering at band edges so the gradient reads as pixels, not stripes
for (let y = 2; y < HORIZON; y += 2) {
    const above = get(0, y - 1);
    for (let x = 0; x < W; x++) if (rand() < 0.16) set(x, y, above);
}

// stars in the top violet
for (let i = 0; i < 26; i++) {
    const x = rint(0, W - 1); const y = rint(0, 9);
    set(x, y, rand() < 0.5 ? '#c9b8ff' : '#efe6ff');
}

// ---------- sun with stepped halo ----------
const SUN = { x: 74, y: 31, r: 5.2 };
for (let y = 0; y < HORIZON + 2; y++) {
    for (let x = 0; x < W; x++) {
        const d = Math.hypot(x + 0.5 - SUN.x, (y + 0.5 - SUN.y) * 1.05);
        if (d < SUN.r) set(x, y, d < SUN.r - 1.6 ? '#fff7df' : '#ffefc4');
        else if (d < SUN.r + 2.2) set(x, y, mix(get(x, y), '#ffe0b3', 0.55));
        else if (d < SUN.r + 4.6 && rand() < 0.55) set(x, y, mix(get(x, y), '#ffd2b0', 0.35));
    }
}

// ---------- pixel clouds: a few overlapping puffs, flat shaded bottom ----------
function cloud(cx, cy, w, shade) {
    const puffs = [];
    const count = Math.max(2, Math.round(w / 7));
    for (let i = 0; i < count; i++) {
        const px = cx - w / 2 + (w / count) * (i + 0.5) + rint(-1, 1);
        const centre = 1 - Math.abs(i - (count - 1) / 2) / count;
        puffs.push({ x: px, hw: rint(3, 5), h: Math.round(1 + centre * 3 + rand()) });
    }
    const cells = new Map();
    for (const p of puffs) {
        for (let r = 0; r < p.h; r++) {
            const hw = p.hw - Math.max(0, r - p.h + 2); // round off the top rows
            for (let x = Math.round(p.x - hw); x <= Math.round(p.x + hw); x++) {
                const y = cy - r;
                const key = x + ',' + y;
                if (!cells.has(key)) cells.set(key, [x, y]);
            }
        }
    }
    for (const [x, y] of cells.values()) {
        const top = !cells.has(x + ',' + (y - 1));
        const c = y === cy ? shade : (top ? '#fff3f8' : '#ffdcec');
        set(x, y, c);
    }
    // soft underside row
    for (const [x, y] of cells.values()) if (y === cy && rand() < 0.6) set(x, y + 1, mix(get(x, y + 1) || shade, shade, 0.45));
}
cloud(15, 10, 22, '#e7a6cf');
cloud(43, 16, 14, '#eaa1c4');
cloud(99, 8, 26, '#cf8fca');
cloud(110, 21, 14, '#f2a8bf');
cloud(62, 6, 12, '#b98ad0');
cloud(88, 25, 11, '#f6b2b5');

// ---------- hills ----------
function hills({ base, minH, maxH, amps, top, body, edge, shade, shape = () => 1 }) {
    const n = wave(amps);
    const heights = [];
    for (let x = 0; x < W; x++) {
        const v = (n(x) + 1) / 2; // ~0..1
        const h = Math.round((minH + Math.max(0, Math.min(1, v)) * (maxH - minH)) * shape(x));
        heights.push(h);
    }
    // quantise into 2-3 block wide steps for a terraced, blocky look
    for (let x = 0; x < W; x++) if (x % 2 === 1) heights[x] = heights[x - 1];
    for (let x = 0; x < W; x++) {
        const topY = base - heights[x];
        for (let y = topY; y < H; y++) {
            let c = y === topY ? top : body;
            if (y === topY + 1 && edge) c = edge;
            if (shade && y > topY + 2 && rand() < 0.12) c = shade;
            set(x, y, c);
        }
    }
    return heights.map((h) => base - h);
}

// hazy distant mountains, partly in front of the low sun
hills({
    base: HORIZON - 3, minH: 0, maxH: 11,
    amps: [[1, 0.045], [0.5, 0.11], [0.18, 0.37]],
    top: '#e0a9d4', body: '#cf98cc', edge: '#d8a2d1', shade: '#c891c7',
    // a valley where the sun sets
    shape: (x) => Math.min(1, 0.15 + (Math.abs(x - SUN.x) / 16) ** 2),
});
const farTops = hills({
    base: HORIZON, minH: 2, maxH: 9,
    amps: [[1, 0.06], [0.45, 0.17], [0.2, 0.41]],
    top: '#c48bc7', body: '#a674b8', edge: '#b47fc0', shade: '#9a6caf',
});
const midTops = hills({
    base: WATER_TOP + 1, minH: 1, maxH: 6,
    amps: [[1, 0.09], [0.4, 0.23]],
    top: '#a6b47c', body: '#8c7f98', edge: '#96a074', shade: '#83778f',
});

// ---------- blossom trees ----------
const LEAF = ['#ffe1ee', '#ffc4de', '#ff9fca', '#f27fb6', '#d9609c', '#b84d88'];
const TRUNK = ['#4a2c33', '#38212a', '#5b3640'];
function tree({ x, groundY, trunkH, rx, ry, scale = 1, far = false }) {
    // trunk (2 wide for big trees) with a few side branches
    const tw = scale >= 1 ? 2 : 1;
    for (let y = groundY - trunkH; y < groundY; y++) {
        for (let i = 0; i < tw; i++) set(x + i, y, TRUNK[(y + i) % 2 === 0 ? 0 : 1]);
    }
    if (scale >= 1) {
        for (let i = 1; i <= 3; i++) set(x - i, groundY - trunkH + 2 - (i > 2 ? 1 : 0), TRUNK[2]);
        for (let i = 1; i <= 3; i++) set(x + tw - 1 + i, groundY - trunkH + 3 - (i > 2 ? 1 : 0), TRUNK[2]);
    }
    // canopy: noisy ellipse; colour by height + noise, darker underside
    const cy = groundY - trunkH - Math.round(ry * 0.35);
    const cx = x + tw / 2;
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
        for (let xx = Math.floor(cx - rx - 1); xx <= Math.ceil(cx + rx + 1); xx++) {
            const dx = (xx + 0.5 - cx) / rx; const dy = (y + 0.5 - cy) / ry;
            const d = dx * dx + dy * dy;
            const edgeNoise = (rand() - 0.5) * 0.5;
            if (d > 1 + edgeNoise * 0.6) continue;
            const t = (dy + 1) / 2; // 0 top .. 1 bottom
            let idx = Math.floor(t * 4.2 + (rand() - 0.5) * 1.6);
            if (dx < -0.25 && dy < 0) idx -= 1; // sun-lit left/top
            idx = Math.max(0, Math.min(LEAF.length - 1, idx + (far ? 1 : 0)));
            let c = LEAF[idx];
            if (far) c = mix(c, '#c88ac4', 0.35);
            set(xx, y, c);
        }
    }
    // hanging leaf drips under the canopy
    for (let i = 0; i < Math.round(rx * 0.9); i++) {
        const xx = Math.round(cx - rx * 0.8 + rand() * rx * 1.6);
        let y = Math.round(cy + ry * 0.6);
        while (y < H && get(xx, y) && LEAF.includes(get(xx, y))) y++;
        const len = rint(0, 2);
        for (let k = 0; k < len; k++) set(xx, y + k, far ? mix(LEAF[4], '#c88ac4', 0.35) : LEAF[4]);
    }
}

// distant small trees on the far and mid hills
for (const fx of [8, 21, 33, 47, 58, 88, 101, 113]) {
    tree({ x: fx, groundY: farTops[fx], trunkH: rint(1, 2), rx: rint(2, 3), ry: 2, scale: 0.5, far: true });
}
for (const mx of [12, 38, 52, 94, 106]) {
    tree({ x: mx, groundY: midTops[mx], trunkH: rint(2, 3), rx: rint(3, 4), ry: rint(2, 3), scale: 0.6, far: true });
}

// ---------- water band with sun reflection ----------
const WATER = ['#5966c9', '#6474d4', '#5a68cc', '#6d7bdb', '#6070cf', '#7584dc', '#6878d4', '#5c6ac8', '#5260bf'];
for (let y = WATER_TOP; y < WATER_BOTTOM + 3; y++) {
    const base = WATER[(y - WATER_TOP) % WATER.length];
    for (let x = 0; x < W; x++) {
        let c = base;
        if (rand() < 0.07) c = '#8f9be6'; // ripples
        const rx = Math.abs(x + 0.5 - SUN.x);
        const spread = 3 + (y - WATER_TOP) * 0.9;
        if (rx < spread && rand() < 0.62 - rx / (spread * 2.4)) c = rand() < 0.5 ? '#ffd7c4' : '#f6b6c8';
        // pink sky reflection near the top of the water
        if (y === WATER_TOP && rand() < 0.4) c = '#b48ad8';
        set(x, y, c);
    }
}

// ---------- foreground shores ----------
function shore(x0, x1, surface, roughness) {
    const n = wave([[roughness, 0.15], [roughness * 0.5, 0.41]]);
    for (let x = x0; x <= x1; x++) {
        const top = Math.round(surface + n(x));
        for (let y = top; y < H; y++) {
            let c;
            if (y === top) c = rand() < 0.2 ? '#9fd96f' : '#7cc25a';
            else if (y === top + 1) c = rand() < 0.35 ? '#7cc25a' : '#5f9e46';
            else if (y < top + 6) c = rand() < 0.25 ? '#7a4f36' : '#8c5c3e';
            else c = rand() < 0.3 ? '#55525e' : '#47444f'; // stone
            set(x, y, c);
        }
        // flowers and tall grass on the surface
        const r = rand();
        if (r < 0.10) set(x, top - 1, '#ffe36e');
        else if (r < 0.18) set(x, top - 1, '#ff8fc2');
        else if (r < 0.30) set(x, top - 1, '#6fb84f');
    }
}
shore(0, 36, WATER_TOP + 4, 1.6);
shore(84, W - 1, WATER_TOP + 3, 1.8);
// a few blocks at the very bottom across the middle (near shore, under the dark overlay)
shore(30, 90, WATER_BOTTOM + 3, 1);

// big framing blossom trees on the left and right
tree({ x: 9, groundY: WATER_TOP + 4, trunkH: 12, rx: 11, ry: 8 });
tree({ x: 27, groundY: WATER_TOP + 4, trunkH: 9, rx: 7, ry: 5 });
tree({ x: 108, groundY: WATER_TOP + 3, trunkH: 13, rx: 12, ry: 8 });
tree({ x: 92, groundY: WATER_TOP + 3, trunkH: 8, rx: 7, ry: 5 });
tree({ x: 60, groundY: WATER_BOTTOM + 3, trunkH: 7, rx: 6, ry: 4 });

// drifting petals
for (let i = 0; i < 34; i++) {
    const x = rand() < 0.5 ? rint(0, 40) : rint(80, W - 1);
    const y = rint(20, WATER_BOTTOM);
    set(x, y, rand() < 0.5 ? '#ffc4de' : '#ff9fca');
}

// ---------- emit: merge horizontal runs, one path per colour ----------
const byColor = new Map();
for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
        const c = grid[y][x];
        let x2 = x + 1;
        while (x2 < W && grid[y][x2] === c) x2++;
        if (c) {
            if (!byColor.has(c)) byColor.set(c, []);
            byColor.get(c).push(`M${x * B} ${y * B}h${(x2 - x) * B}v${B}h-${(x2 - x) * B}z`);
        }
        x = x2;
    }
}
const paths = [...byColor.entries()]
    .map(([c, d]) => `<path fill="${c}" d="${d.join('')}"/>`)
    .join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * B} ${H * B}" width="${W * B}" height="${H * B}" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges">
<!-- Original procedural art generated by scripts/make-world.js (seed ${SEED}). -->
<rect width="100%" height="100%" fill="#3a2c74"/>
${paths}
</svg>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, svg);
console.log(`wrote ${OUT} (${(svg.length / 1024).toFixed(1)} KB, ${byColor.size} colours)`);
