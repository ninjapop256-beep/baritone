// Client-side router. History mode (real paths, live server) or hash mode
// (#/path?query — static hosting / demo). Module-level helpers work after createRouter().

let state = {
    hashMode: true,
    basePath: '',
    router: null,
    hasBase: null, // memoised: is there a <base href> element? (looked up once, not per link)
};

// Hash mode: with a <base> element, a bare '#…' would resolve against the base, not this page,
// so links carry the page's own path. Only the hash changes in hash mode, so this is stable.
function hashPrefix() {
    if (state.hasBase === null) state.hasBase = !!document.querySelector('base[href]');
    return state.hasBase ? `${location.pathname}${location.search}` : '';
}

const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p) || '/';

function safeDecode(s) {
    try { return decodeURIComponent(s); } catch { return s; }
}

function parseQuery(search) {
    const out = {};
    const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
    for (const [k, v] of sp) out[k] = v;
    return out;
}

function buildQuery(obj) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(obj || {})) {
        if (v === null || v === undefined || v === '' || v === false) continue;
        sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
}

/** Current app path + query string, e.g. '/profile/Name?x=1'. */
function currentLocation() {
    if (state.hashMode) {
        const h = location.hash || '';
        const body = h.startsWith('#/') ? h.slice(1) : '/';
        const qi = body.indexOf('?');
        return { path: trimSlash(qi >= 0 ? body.slice(0, qi) : body), search: qi >= 0 ? body.slice(qi) : '' };
    }
    let path = location.pathname;
    if (state.basePath && path.startsWith(state.basePath)) path = path.slice(state.basePath.length) || '/';
    path = path.replace(/\/index\.html$/, '/');
    return { path: trimSlash(path.startsWith('/') ? path : `/${path}`), search: location.search };
}

/** App path → URL for an <a href>. Hash mode: '#/x'. History mode: '<base>/x'. */
export function href(path = '/') {
    const p = String(path).startsWith('/') ? String(path) : `/${path}`;
    if (state.hashMode) return `${hashPrefix()}#${p}`;
    return `${state.basePath}${p}`;
}

/** Navigate to an app path ('/profile/Name?x=1'). */
export function navigate(path, { replace = false } = {}) {
    const p = String(path || '/').startsWith('/') ? String(path || '/') : `/${path}`;
    if (state.hashMode) {
        const url = `${location.pathname}${location.search}#${p}`;
        if (replace) history.replaceState(history.state, '', url);
        else history.pushState(null, '', url);
    } else {
        const url = `${state.basePath}${p}`;
        if (replace) history.replaceState(history.state, '', url);
        else history.pushState(null, '', url);
    }
    state.router?.handle('push');
}

/** Current query as a plain object of strings. */
export function getQuery() {
    return parseQuery(currentLocation().search);
}

/** Merge into the current query (null/undefined/''/false removes a key) with replaceState.
 *  Does not notify onChange (the caller already knows). `path` swaps the app path too, e.g. a
 *  profile opened by an old name shows its current one. */
export function setQuery(obj, { path: nextPath } = {}) {
    const path = nextPath || currentLocation().path;
    const next = { ...getQuery(), ...(obj || {}) };
    const qs = buildQuery(next);
    const url = state.hashMode ? `${location.pathname}${location.search}#${path}${qs}` : `${state.basePath}${path}${qs}`;
    history.replaceState(history.state, '', url);
    if (state.router) state.router.lastKey = path + qs;
}

function compile(routes) {
    return routes.map((r) => {
        const names = [];
        const pattern = trimSlash(r.path).split('/').map((seg) => {
            if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('/');
        return { ...r, names, re: new RegExp(`^${pattern}$`, 'i') };
    });
}

/** Resolve a path against the compiled table. Falls back to { view: 'notfound' }. */
function match(compiled, path) {
    for (const r of compiled) {
        const m = r.re.exec(path);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = safeDecode(m[i + 1]); });
        return { ...r, params };
    }
    return { view: 'notfound', path: '*', params: { path } };
}

function isPlainLeftClick(ev) {
    return ev.button === 0 && !ev.defaultPrevented && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && !ev.altKey;
}

/**
 * createRouter({ mode, routes, onChange })
 *   mode: 'live' → history mode, anything else → hash mode
 *   routes: [{ path: '/profile/:name', view: 'profile', ...extra }]
 *   onChange(route, prev): route = { view, params, query, path (app path), key (path+search),
 *                                    via ('initial'|'push'|'pop'), pattern, ...extra }
 * Returns { start(), handle(), current(), stop() }.
 */
export function createRouter({ mode, routes, onChange }) {
    const hashMode = mode !== 'live';
    let basePath = '';
    if (!hashMode) {
        const baseEl = document.querySelector('base[href]');
        if (baseEl) basePath = trimSlash(new URL(baseEl.href).pathname);
        if (basePath === '/') basePath = '';
    }
    state = { hashMode, basePath, router: null, hasBase: null };

    const compiled = compile(routes || []);
    let current = null;

    const router = {
        lastKey: null,
        current: () => current,
        handle(via = 'pop') {
            const { path, search } = currentLocation();
            const key = path + search;
            if (key === router.lastKey) return;
            router.lastKey = key;
            const m = match(compiled, path);
            const prev = current;
            current = { ...m, pattern: m.path, path, key, via, query: parseQuery(search) };
            delete current.re;
            delete current.names;
            try { onChange?.(current, prev); } catch (err) { console.error(err); }
        },
        start() {
            if (!hashMode && location.hash.startsWith('#/')) {
                // a shared hash-style link opened on the live server → turn it into a real path
                history.replaceState(null, '', `${basePath}${location.hash.slice(1)}`);
            }
            if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; // main.js restores
            window.addEventListener('popstate', onPop);
            if (hashMode) window.addEventListener('hashchange', onPop);
            document.addEventListener('click', onClick);
            router.handle('initial');
            return router;
        },
        stop() {
            window.removeEventListener('popstate', onPop);
            window.removeEventListener('hashchange', onPop);
            document.removeEventListener('click', onClick);
        },
    };

    function onPop() {
        // ignore plain in-page anchors (#app) in hash mode
        if (hashMode && location.hash && !location.hash.startsWith('#/')) return;
        router.handle('pop');
    }

    function onClick(ev) {
        if (!isPlainLeftClick(ev)) return;
        const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
        if (!a || a.hasAttribute('download') || a.hasAttribute('data-external')) return;
        const target = a.getAttribute('target');
        if (target && target !== '_self') return;
        const url = new URL(a.href, location.href);
        if (url.origin !== location.origin) return;
        if (hashMode) {
            // hash routes go through pushState so link clicks are told apart from back/forward
            // (and so a <base> element can't turn them into a full page load)
            if (url.hash.startsWith('#/')) {
                ev.preventDefault();
                const target = url.hash.slice(1);
                if (target !== currentLocation().path + currentLocation().search) navigate(target);
            }
            return;
        }
        let path = url.pathname;
        if (basePath) {
            if (!path.startsWith(basePath)) return;
            path = path.slice(basePath.length) || '/';
        }
        if (path.startsWith('/api/') || /\.[a-z0-9]{1,8}$/i.test(path)) return; // real files / API
        if (url.hash && url.pathname === location.pathname && url.search === location.search) return; // in-page anchor
        ev.preventDefault();
        navigate(path + url.search);
    }

    state.router = router;
    return router;
}
