// Number / date / countdown formatting. Output is English (en-US) for a consistent look;
// times are shown in the viewer's own time zone unless a helper says UTC.

const LOCALE = 'en-US';
const MINUS = '−';
const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const decFmts = new Map();
const dateFmts = new Map();

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const toNum = (n) => (typeof n === 'string' && n.trim() !== '' ? Number(n) : n);

function decFmt(d) {
    if (!decFmts.has(d)) decFmts.set(d, new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d }));
    return decFmts.get(d);
}

function dateFmt(key, opts) {
    if (!dateFmts.has(key)) dateFmts.set(key, new Intl.DateTimeFormat(LOCALE, opts));
    return dateFmts.get(key);
}

// ICU emits narrow no-break spaces before AM/PM; normalise to plain spaces.
const clean = (s) => s.replace(/[  ]/g, ' ');

function toDate(ms) {
    const n = toNum(ms);
    if (!isNum(n)) return null;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** 1451 → '1,451'; null → '—' */
export function fmtInt(n) {
    n = toNum(n);
    return isNum(n) ? intFmt.format(Math.round(n)).replace('-', MINUS) : '—';
}

/** 8.546 → '8.5' (d = 1) */
export function fmtDec(n, d = 1) {
    n = toNum(n);
    return isNum(n) ? decFmt(d).format(n).replace('-', MINUS) : '—';
}

/** 0.34 → '34.0%' */
export function fmtPct(x, d = 1) {
    x = toNum(x);
    return isNum(x) ? `${fmtDec(x * 100, d)}%` : '—';
}

/** 300 → '+300', -25 → '−25', 0 → '±0' */
export function fmtSigned(n) {
    n = toNum(n);
    if (!isNum(n)) return '—';
    const r = Math.round(n);
    if (r === 0) return '±0';
    return (r > 0 ? '+' : MINUS) + intFmt.format(Math.abs(r));
}

/** 'Oct 18' */
export function fmtDate(ms) {
    const d = toDate(ms);
    return d ? clean(dateFmt('d', { month: 'short', day: 'numeric' }).format(d)) : '—';
}

/** 'Oct 18, 2026' */
export function fmtDateYear(ms) {
    const d = toDate(ms);
    return d ? clean(dateFmt('dy', { month: 'short', day: 'numeric', year: 'numeric' }).format(d)) : '—';
}

/** 'Oct 18, 2026, 7:50 PM' */
export function fmtDateTime(ms) {
    const d = toDate(ms);
    return d ? clean(dateFmt('dt', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)) : '—';
}

/** 'Sun, Oct 18, 2026, 7:50 PM' */
export function fmtDateTimeLong(ms) {
    const d = toDate(ms);
    return d ? clean(dateFmt('dtl', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)) : '—';
}

/** '7:50 PM' */
export function fmtTime(ms) {
    const d = toDate(ms);
    return d ? clean(dateFmt('t', { hour: 'numeric', minute: '2-digit' }).format(d)) : '—';
}

/** 'Oct 18, 18:00 UTC' */
export function fmtUtc(ms) {
    const d = toDate(ms);
    return d ? `${clean(dateFmt('utc', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(d))} UTC` : '—';
}

/** Parts for a calendar date block: { month: 'OCT', day: '18', weekday: 'Sun' } (local time). */
export function dateParts(ms) {
    const d = toDate(ms);
    if (!d) return { month: '—', day: '—', weekday: '' };
    return {
        month: dateFmt('mon', { month: 'short' }).format(d).toUpperCase(),
        day: String(d.getDate()),
        weekday: dateFmt('wd', { weekday: 'short' }).format(d),
    };
}

const UNITS = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['week', 7 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60],
];

/** '9 hours ago', 'just now', 'in 5 minutes' */
export function fmtRelative(ms, now = Date.now()) {
    ms = toNum(ms);
    if (!isNum(ms)) return '—';
    const diff = Math.round((toNum(now) - ms) / 1000);
    const abs = Math.abs(diff);
    if (abs < 45) return 'just now';
    for (const [unit, secs] of UNITS) {
        // round up to the unit once we are ~90% of the way there (e.g. 55 min → 1 hour)
        if (abs >= secs * 0.9 || unit === 'minute') {
            const n = Math.max(1, Math.round(abs / secs));
            const label = `${n} ${unit}${n === 1 ? '' : 's'}`;
            return diff >= 0 ? `${label} ago` : `in ${label}`;
        }
    }
    return 'just now';
}

/** Compact countdown for a duration in ms: '3d 4h', '4h 12m', '12m 05s', '0s'. */
export function fmtCountdown(ms) {
    ms = toNum(ms);
    if (!isNum(ms)) return '—';
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}

/** 1 → '#1' */
export function fmtPlace(n) {
    n = toNum(n);
    return isNum(n) ? `#${fmtInt(n)}` : '—';
}

/** 1 → '1st', 2 → '2nd', 11 → '11th' */
export function ordinal(n) {
    n = Math.round(toNum(n));
    if (!isNum(n)) return '—';
    const t = n % 100;
    const suffix = t >= 11 && t <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
    return `${fmtInt(n)}${suffix}`;
}

/** plural(1451, 'player') → '1,451 players'; plural(1, 'point') → '1 point' */
export function plural(n, word, pluralWord = `${word}s`) {
    return `${fmtInt(n)} ${toNum(n) === 1 ? word : pluralWord}`;
}

/** 'some-slug_here' → 'Some Slug Here' */
export function titleCase(slug) {
    if (slug === null || slug === undefined || slug === '') return '';
    return String(slug)
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}
