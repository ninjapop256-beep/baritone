// Tiny DOM helpers: an auto-escaping `html` tagged template plus query/delegation utilities.

export class SafeHtml {
    constructor(str) { this.__html = String(str); }
    toString() { return this.__html; }
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
}

/** Marks a trusted string as HTML (no escaping). Only use with markup you built yourself. */
export function raw(str) {
    return new SafeHtml(str ?? '');
}

const isSafe = (v) => v instanceof SafeHtml || (v !== null && typeof v === 'object' && typeof v.__html === 'string');

function render(value) {
    if (value === null || value === undefined || value === false) return '';
    if (isSafe(value)) return value.__html;
    if (Array.isArray(value)) return value.map(render).join('');
    return escapeHtml(value);
}

/** html`<b>${name}</b>` → SafeHtml. SafeHtml is inserted raw, arrays are flattened,
 *  null/undefined/false render nothing, everything else is escaped. */
export function html(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
    return new SafeHtml(out);
}

/** Converts SafeHtml (or anything `html` accepts) to its HTML string. */
export function toHtml(value) {
    return render(value);
}

const lastHtml = new WeakMap();

/** Sets innerHTML only when the markup differs from what setHtml last wrote.
 *  Returns true when the DOM was touched. Pass { force: true } to always write. */
export function setHtml(el, safe, { force = false } = {}) {
    if (!el) return false;
    const str = render(safe);
    if (!force && lastHtml.get(el) === str) return false;
    el.innerHTML = str;
    lastHtml.set(el, str);
    return true;
}

export function qs(sel, root = document) {
    return root.querySelector(sel);
}

export function qsa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
}

/** Delegated listener: handler(event, matchedElement) runs for events whose target is
 *  inside an element matching `selector` (within root). Returns an `off()` function. */
export function on(root, event, selector, handler, options) {
    const listener = (ev) => {
        const start = ev.target instanceof Element ? ev.target : ev.target?.parentElement;
        const match = start?.closest(selector);
        if (match && root.contains(match)) handler(ev, match);
    };
    root.addEventListener(event, listener, options);
    return () => root.removeEventListener(event, listener, options);
}
