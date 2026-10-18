// Player skin images: real skins from mc-heads.net, or deterministic procedural pixel
// characters rendered locally as tiny SVG data URIs (no network needed).
import { html, raw } from './dom.js';

let skinMode = 'local';

/** 'mc-heads' | 'local' */
export function setSkinMode(mode) {
    skinMode = mode === 'mc-heads' ? 'mc-heads' : 'local';
}

export function getSkinMode() {
    return skinMode;
}

const asPlayer = (p) => (typeof p === 'string' ? { name: p } : (p || {}));

/** mc-heads id: skin || uuid || name */
function skinId(p) {
    p = asPlayer(p);
    return String(p.skin || p.uuid || p.name || 'MHF_Steve');
}

/** Stable seed for the local generator (dash/case-insensitive). */
export function skinKey(p) {
    return skinId(p).toLowerCase().replace(/-/g, '');
}

export function bodySrc(p) {
    if (skinMode === 'mc-heads') return `https://mc-heads.net/body/${encodeURIComponent(skinId(p))}/right`;
    return localSkinUrl(p, 'body');
}

export function headSrc(p, size = 32) {
    if (skinMode === 'mc-heads') {
        const px = Math.max(8, Math.min(512, Math.round(size) || 32));
        return `https://mc-heads.net/avatar/${encodeURIComponent(skinId(p))}/${px}`;
    }
    return localSkinUrl(p, 'head');
}

// ---------- procedural skins ----------

function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function prng(seed) {
    let a = seed || 1;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f))).toString(16).padStart(2, '0');
    return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}

function mix(a, b, t) {
    const A = parseInt(a.slice(1), 16); const Bn = parseInt(b.slice(1), 16);
    const ch = (s) => {
        const va = (A >> s) & 255; const vb = (Bn >> s) & 255;
        return Math.round(va + (vb - va) * t).toString(16).padStart(2, '0');
    };
    return `#${ch(16)}${ch(8)}${ch(0)}`;
}

const SKIN = ['#f7d7bd', '#efc4a2', '#e2b08a', '#cf9a72', '#b97f58', '#9c6643', '#7d4e33', '#5f3a26'];
const HAIR = ['#24180f', '#3d2718', '#5c3a22', '#8a5a32', '#b9853f', '#e2c46e', '#f2e6b0', '#18181f',
    '#7a2424', '#c4462c', '#e7e7ee', '#6a4fb8', '#2e69b8', '#2c9a68', '#e06aa8', '#ff8f5a'];
const CLOTH = ['#d64545', '#e07a2f', '#e8c547', '#4caf50', '#25a18e', '#3a7bd5', '#5b4fc9', '#9b4fc9',
    '#d9579b', '#ececf2', '#2b2f3a', '#6b7280', '#7c5a3c', '#1f8a70', '#a8323e', '#f2a65a', '#3d4a6b', '#161a22'];
const PANTS = ['#26324d', '#3b4f7a', '#23262e', '#4a3b2a', '#5a5f6b', '#2f5a3a', '#6b2f2f', '#1d2b4f', '#7a6a55', '#3a3550'];
const SHOES = ['#1b1b20', '#3a2a20', '#e9e9ef', '#5a3a28', '#2a2f45', '#b03a3a'];
const EYES = ['#3a6fd8', '#2f8a4f', '#5a3a22', '#30303c', '#7a4fd0', '#2aa3b8', '#8a5a2a'];

const HAIR_STYLES = ['short', 'short', 'long', 'fringe', 'buzz', 'cap', 'hood', 'beanie', 'long', 'spiky'];
const TOPS = ['tee', 'tee', 'hoodie', 'jacket', 'stripes', 'tee', 'hoodie', 'vest'];

function design(key) {
    const r = prng(hash(key));
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const shirt = pick(CLOTH);
    let accent = pick(CLOTH);
    if (accent === shirt) accent = shade(shirt, 0.62);
    const hairIndex = Math.floor(r() * HAIR.length);
    return {
        r,
        skin: pick(SKIN),
        hair: HAIR[hairIndex],
        naturalHair: hairIndex < 11,
        eyes: pick(EYES),
        shirt,
        accent,
        pants: pick(PANTS),
        shoes: pick(SHOES),
        hairStyle: pick(HAIR_STYLES),
        top: pick(TOPS),
        shorts: r() < 0.14,
        beard: r() < 0.1,
        blush: r() < 0.18,
        brows: r() < 0.5,
        print: r() < 0.5,
        belt: r() < 0.55,
    };
}

/** Paints the 8×8 face into px(x, y, colour) at offset (ox, oy). */
function paintHead(d, px, ox, oy) {
    const { r, skin, hair, eyes } = d;
    const skinD = shade(skin, 0.86);
    const hairD = shade(hair, 0.78);
    const hairL = shade(hair, 1.18);
    const hairPx = (x, y) => px(ox + x, oy + y, r() < 0.18 ? hairD : (r() < 0.12 ? hairL : hair));
    const hatColor = d.accent;
    const hatPx = (x, y, c = hatColor) => px(ox + x, oy + y, r() < 0.15 ? shade(c, 0.9) : c);

    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px(ox + x, oy + y, x === 7 || y === 7 ? skinD : skin);

    // eyes, brows, mouth
    let eyeY = 4;
    px(ox + 1, oy + eyeY, '#ffffff'); px(ox + 2, oy + eyeY, eyes);
    px(ox + 5, oy + eyeY, eyes); px(ox + 6, oy + eyeY, '#ffffff');
    if (d.brows) { px(ox + 1, oy + 3, hairD); px(ox + 2, oy + 3, hairD); px(ox + 5, oy + 3, hairD); px(ox + 6, oy + 3, hairD); }
    px(ox + 3, oy + 5, skinD); px(ox + 4, oy + 5, skinD);
    px(ox + 3, oy + 6, shade(skin, 0.62)); px(ox + 4, oy + 6, shade(skin, 0.62));
    if (d.blush) { const b = mix(skin, '#ff6f7d', 0.32); px(ox + 1, oy + 5, b); px(ox + 6, oy + 5, b); }
    if (d.beard && d.naturalHair && d.hairStyle !== 'long' && d.hairStyle !== 'hood') {
        for (const [x, y] of [[1, 6], [2, 6], [5, 6], [6, 6], [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [0, 5], [7, 5], [0, 6], [7, 6], [0, 7], [7, 7]]) hairPx(x, y);
    }

    switch (d.hairStyle) {
        case 'long':
            for (let x = 0; x < 8; x++) { hairPx(x, 0); hairPx(x, 1); }
            for (let x = 0; x < 8; x++) if (x < 2 || x > 5 || r() < 0.45) hairPx(x, 2);
            for (let y = 3; y < 8; y++) { hairPx(0, y); hairPx(7, y); }
            break;
        case 'fringe':
            for (let y = 0; y < 3; y++) for (let x = 0; x < 8; x++) hairPx(x, y);
            for (let x = 0; x < 8; x++) if (x === 0 || x === 7 || r() < 0.3) hairPx(x, 3);
            break;
        case 'buzz':
            for (let x = 0; x < 8; x++) hairPx(x, 0);
            for (let x = 0; x < 8; x++) if (x === 0 || x === 7 || r() < 0.55) hairPx(x, 1);
            hairPx(0, 2); hairPx(7, 2);
            break;
        case 'spiky':
            for (let x = 0; x < 8; x++) { hairPx(x, 0); hairPx(x, 1); }
            for (let x = 0; x < 8; x += 2) hairPx(x + (r() < 0.5 ? 0 : 1), 2);
            hairPx(0, 2); hairPx(7, 2); hairPx(0, 3); hairPx(7, 3);
            px(ox + 1, oy, hairL); px(ox + 4, oy, hairL);
            break;
        case 'cap':
            for (let x = 0; x < 8; x++) { hatPx(x, 0); hatPx(x, 1); }
            px(ox + 3, oy + 1, shade(hatColor, 1.25)); px(ox + 4, oy + 1, shade(hatColor, 1.25));
            for (let x = 0; x < 8; x++) px(ox + x, oy + 2, shade(hatColor, 0.68));
            hairPx(0, 3); hairPx(7, 3);
            break;
        case 'hood': {
            const hood = d.shirt;
            for (let x = 0; x < 8; x++) { hatPx(x, 0, hood); hatPx(x, 1, hood); }
            for (let y = 2; y < 8; y++) { hatPx(0, y, shade(hood, 0.85)); hatPx(7, y, shade(hood, 0.85)); }
            for (let x = 1; x < 7; x++) if (r() < 0.6) hairPx(x, 2);
            break;
        }
        case 'beanie':
            for (let x = 0; x < 8; x++) { hatPx(x, 0); hatPx(x, 1); }
            for (let x = 0; x < 8; x++) px(ox + x, oy + 2, x % 2 ? shade(hatColor, 0.75) : shade(hatColor, 0.88));
            px(ox + 3, oy, shade(hatColor, 1.2)); px(ox + 4, oy, shade(hatColor, 1.2));
            hairPx(0, 3); hairPx(7, 3);
            break;
        default: // short
            for (let x = 0; x < 8; x++) { hairPx(x, 0); hairPx(x, 1); }
            for (let x = 0; x < 8; x++) if (x === 0 || x === 7 || r() < 0.35) hairPx(x, 2);
            if (r() < 0.6) { hairPx(0, 3); hairPx(7, 3); }
    }
}

function paintBody(d, px) {
    const { r, skin, shirt, accent, pants, shoes } = d;
    const cloth = (x, y, c) => px(x, y, r() < 0.12 ? shade(c, 0.92) : (r() < 0.08 ? shade(c, 1.06) : c));
    const skinD = shade(skin, 0.86);
    const longSleeves = d.top === 'hoodie' || d.top === 'jacket' || (d.top === 'stripes' && r() < 0.5);
    const sleeveRows = d.top === 'vest' ? 0 : (longSleeves ? 10 : 4);
    const sleeve = shirt;

    // torso: x 4..11, y 8..19
    for (let ty = 0; ty < 12; ty++) {
        for (let tx = 0; tx < 8; tx++) {
            let c = shirt;
            if (d.top === 'stripes' && ty % 4 >= 2) c = accent;
            if (d.top === 'jacket' && (tx === 3 || tx === 4)) c = accent;
            if (d.top === 'jacket' && (tx === 2 || tx === 5)) c = shade(shirt, 0.8);
            if (d.top === 'vest' && (tx === 3 || tx === 4) && ty < 9) c = accent;
            if (tx === 7) c = shade(c, 0.86);
            cloth(4 + tx, 8 + ty, c);
        }
    }
    // collar / neckline
    px(7, 8, skin); px(8, 8, skin);
    if (d.top === 'tee' && r() < 0.5) { px(7, 9, skinD); px(8, 9, skinD); }
    if (d.top === 'hoodie') {
        for (let tx = 0; tx < 8; tx++) px(4 + tx, 8, shade(shirt, 0.78));
        px(7, 8, skin); px(8, 8, skin);
        px(6, 9, '#f2f2f2'); px(6, 10, '#f2f2f2'); px(9, 9, '#f2f2f2'); px(9, 10, '#f2f2f2');
        for (let tx = 2; tx < 6; tx++) { px(4 + tx, 15, shade(shirt, 0.8)); px(4 + tx, 16, shade(shirt, 0.84)); }
    }
    if (d.print && (d.top === 'tee' || d.top === 'vest')) {
        const pc = accent;
        px(7, 11, pc); px(8, 11, pc); px(7, 12, pc); px(8, 12, pc);
        if (r() < 0.5) { px(6, 12, shade(pc, 0.8)); px(9, 12, shade(pc, 0.8)); px(7, 13, shade(pc, 0.8)); px(8, 13, shade(pc, 0.8)); }
    }
    if (d.belt) {
        for (let tx = 0; tx < 8; tx++) px(4 + tx, 19, '#2a2220');
        px(7, 19, '#d9b04a'); px(8, 19, '#d9b04a');
    }
    // long hair drapes over the shoulders
    if (d.hairStyle === 'long') {
        for (let y = 8; y < 11; y++) { px(4, y, d.hair); px(11, y, shade(d.hair, 0.85)); }
    }

    // arms: x 0..3 and 12..15, y 8..19
    for (const ax of [0, 12]) {
        for (let ay = 0; ay < 12; ay++) {
            for (let i = 0; i < 4; i++) {
                const x = ax + i;
                const inner = (ax === 0 && i === 3) || (ax === 12 && i === 0);
                const outer = (ax === 0 && i === 0) || (ax === 12 && i === 3);
                if (ay < sleeveRows) {
                    let c = sleeve;
                    if (d.top === 'stripes' && ay % 4 >= 2) c = accent;
                    if (ay === sleeveRows - 1) c = shade(c, 0.8); // cuff
                    if (inner) c = shade(c, 0.84);
                    else if (outer && ax === 12) c = shade(c, 0.9);
                    cloth(x, 8 + ay, c);
                } else {
                    let c = skin;
                    if (inner || ay === 11) c = skinD;
                    px(x, 8 + ay, c);
                }
            }
        }
    }

    // legs: x 4..7 and 8..11, y 20..31
    for (let ly = 0; ly < 12; ly++) {
        for (let lx = 0; lx < 8; lx++) {
            const x = 4 + lx;
            const gap = lx === 3;
            let c;
            if (ly >= 10) c = ly === 11 ? shade(shoes, 0.8) : shoes;
            else if (d.shorts && ly >= 5) c = ly === 9 ? '#f0f0f4' : (gap ? skinD : skin);
            else c = gap ? shade(pants, 0.75) : (lx === 7 ? shade(pants, 0.88) : pants);
            if (ly >= 10 || (d.shorts && ly >= 5)) px(x, 20 + ly, c);
            else cloth(x, 20 + ly, c);
        }
    }
}

function toSvg(grid, w, h) {
    // one stroked path per colour, horizontal runs merged (keeps each SVG ~1-3 KB)
    const byColor = new Map();
    for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
            const c = grid[y * w + x];
            let x2 = x + 1;
            while (x2 < w && grid[y * w + x2] === c) x2++;
            if (c) {
                let d = byColor.get(c);
                if (!d) byColor.set(c, (d = []));
                d.push(`M${x} ${y}.5h${x2 - x}`);
            }
            x = x2;
        }
    }
    let body = '';
    for (const [c, d] of byColor) body += `<path stroke='${c}' d='${d.join('')}'/>`;
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' shape-rendering='crispEdges'>${body}</svg>`;
}

const svgCache = new Map();
const uriCache = new Map();
const blobCache = new Map();
const CACHE_MAX = 4000;

function remember(map, key, value) {
    if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
    map.set(key, value);
    return value;
}

function cacheKey(p, kind) {
    return `${kind === 'head' ? 'head' : 'body'}:${skinKey(p)}`;
}

/** Raw SVG markup of the procedural skin. */
function localSvg(p, kind) {
    const k = cacheKey(p, kind);
    const hit = svgCache.get(k);
    if (hit) return hit;
    const key = skinKey(p);
    let svg;
    if (kind === 'head') {
        const grid = new Array(64).fill(null);
        paintHead(design(key), (x, y, c) => { grid[y * 8 + x] = c; }, 0, 0);
        svg = toSvg(grid, 8, 8);
    } else {
        const grid = new Array(16 * 32).fill(null);
        const px = (x, y, c) => { if (x >= 0 && x < 16 && y >= 0 && y < 32) grid[y * 16 + x] = c; };
        paintBody(design(key), px);
        paintHead(design(key), px, 4, 0); // fresh PRNG → same face as the head avatar
        svg = toSvg(grid, 16, 32);
    }
    return remember(svgCache, k, svg);
}

/** Deterministic procedural skin as an SVG data URI. kind: 'body' (16×32 figure) | 'head' (8×8 face). */
export function localSkin(p, kind = 'body') {
    const k = cacheKey(p, kind);
    const hit = uriCache.get(k);
    if (hit) return hit;
    const uri = 'data:image/svg+xml,' + localSvg(p, kind).replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');
    return remember(uriCache, k, uri);
}

const canBlob = typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';

/** Same image as localSkin() but as a short cached blob: URL (keeps big tables light).
 *  Falls back to the data URI where blobs are unavailable. Blob URLs are never revoked. */
export function localSkinUrl(p, kind = 'body') {
    if (!canBlob) return localSkin(p, kind);
    const k = cacheKey(p, kind);
    let url = blobCache.get(k);
    if (!url) {
        try {
            url = URL.createObjectURL(new Blob([localSvg(p, kind)], { type: 'image/svg+xml' }));
        } catch {
            return localSkin(p, kind);
        }
        blobCache.set(k, url);
    }
    return url;
}

/** <img class="skin skin-<kind> cls"> for a player. size = px height (head: square; body: 2:1 tall). */
export function skinImg(p, { kind = 'head', size, cls = '', lazy = true, alt = '' } = {}) {
    const body = kind === 'body';
    const h = Math.round(size || (body ? 64 : 32));
    const w = body ? Math.round(h / 2) : h;
    const remote = skinMode === 'mc-heads';
    const src = body ? bodySrc(p) : headSrc(p, h * 2);
    // mc-heads mode: a compact "<kind>:<seed>" fallback token, resolved to a local skin on error
    const fallback = remote ? `${body ? 'body' : 'head'}:${skinKey(p)}` : null;
    return html`<img class="skin skin-${body ? 'body' : 'head'}${cls ? ' ' + cls : ''}" src="${src.startsWith('data:') ? raw(src) : src}" width="${w}" height="${h}" alt="${alt}"${lazy ? raw(' loading="lazy"') : ''} decoding="async" draggable="false"${remote ? html` referrerpolicy="no-referrer" data-skin-fallback="${fallback}"` : ''}>`;
}

// Swap a failed remote skin to its local fallback (once). Capture phase: error doesn't bubble.
if (typeof document !== 'undefined') {
    document.addEventListener('error', (ev) => {
        const img = ev.target;
        if (!(img instanceof HTMLImageElement) || !img.dataset.skinFallback || img.dataset.skinFailed) return;
        img.dataset.skinFailed = '1';
        const fb = img.dataset.skinFallback;
        if (fb.startsWith('data:')) { img.src = fb; return; }
        const i = fb.indexOf(':');
        const kind = fb.slice(0, i) === 'body' ? 'body' : 'head';
        img.src = localSkinUrl({ skin: fb.slice(i + 1) }, kind);
    }, true);
}
