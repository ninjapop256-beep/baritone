// Boot: detect mode, load config, render the shell, route to views (loaded on demand).
// No static imports: if any core module fails to load, the error card below still renders.

const ROUTES = [
    { path: '/', view: 'rankings', nav: 'rankings' },
    { path: '/rankings', view: 'rankings', nav: 'rankings' },
    { path: '/rankings/overall', view: 'rankings', nav: 'rankings' },
    { path: '/rankings/history', view: 'history', nav: 'rankings', title: 'Game History' },
    { path: '/rankings/history/:number', view: 'game', nav: 'rankings', title: (p) => `Game #${p.number}` },
    { path: '/profile/:name', view: 'profile', nav: 'rankings', title: (p) => p.name },
];

const VIEWS = {
    rankings: () => import('./views/rankings.js'),
    history: () => import('./views/history.js'),
    game: () => import('./views/game.js'),
    profile: () => import('./views/profile.js'),
    notfound: () => import('./views/notfound.js'),
};

const app = document.getElementById('app');
let booted = false;
let linkTo = (path) => `#${path}`; // replaced by the router's href once loaded

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function errorCard(title, err, { retryLabel = 'Try again', home = true } = {}) {
    const message = err?.message || (typeof err === 'string' ? err : 'Something unexpected happened.');
    const detail = err?.stack || '';
    return `<section class="card card-pad app-error" role="alert">
        <div class="error-box">
            <p class="error-title">${esc(title)}</p>
            <p class="error-text">${esc(message)}</p>
            <div class="error-actions">
                <button class="btn" type="button" data-app-retry>${esc(retryLabel)}</button>
                ${home ? `<a class="btn btn-ghost" href="${esc(linkTo('/rankings/overall'))}">Go to rankings</a>` : ''}
            </div>
            ${detail ? `<details class="error-details"><summary>Technical details</summary><pre>${esc(detail)}</pre></details>` : ''}
        </div>
    </section>`;
}

const LOADING = '<section class="card card-pad"><div class="loading loading-page" aria-busy="true"><span class="visually-hidden">Loading…</span></div></section>';

let fatalShown = false;
function renderFatal(title, err) {
    console.error(err);
    if (!app || fatalShown) return;
    fatalShown = true;
    app.innerHTML = errorCard(title, err, { retryLabel: 'Reload', home: false });
    app.removeAttribute('aria-busy');
    app.addEventListener('click', (ev) => {
        if (ev.target instanceof Element && ev.target.closest('[data-app-retry]')) location.reload();
    });
}

// Last-resort boundary: errors before the router is up would otherwise leave a blank page.
window.addEventListener('error', (ev) => {
    if (!booted && ev.error) renderFatal('The site failed to start', ev.error);
});
window.addEventListener('unhandledrejection', (ev) => {
    if (!booted) renderFatal('The site failed to start', ev.reason);
});

async function detectMode() {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1' || params.get('demo') === 'true') return 'demo';
    const meta = document.querySelector('meta[name="app-mode"]')?.content;
    if (meta === 'live' || meta === 'demo') return meta;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
        const res = await fetch(new URL('api/health', document.baseURI), { cache: 'no-store', signal: ctrl.signal });
        if (!res.ok) return 'demo';
        const body = await res.json();
        return body && body.ok === true ? 'live' : 'demo';
    } catch {
        return 'demo';
    } finally {
        clearTimeout(timer);
    }
}

/** Per-mount wrapper so search handlers a view forgets to remove are cleaned up on unmount. */
function scopedShell(shell) {
    const offs = [];
    const scoped = Object.create(shell);
    scoped.onSearch = (handler) => {
        const off = shell.onSearch(handler);
        offs.push(off);
        return off;
    };
    scoped.dispose = () => { offs.splice(0).forEach((off) => off()); };
    return scoped;
}

async function boot() {
    const [{ createApi }, routerMod, { renderShell }, { setSkinMode }] = await Promise.all([
        import('./api.js'),
        import('./router.js'),
        import('./shell.js'),
        import('./ui/skins.js'),
    ]);
    const { createRouter, href, navigate, getQuery, setQuery } = routerMod;

    const mode = await detectMode();
    document.documentElement.dataset.mode = mode;
    const api = createApi(mode);
    let config;
    try {
        config = await api.config();
    } catch (err) {
        renderFatal('Could not load the site', err);
        return;
    }
    setSkinMode(config.skins === 'mc-heads' || config.skins === 'local'
        ? config.skins
        : (mode === 'live' && config.mode !== 'demo' ? 'mc-heads' : 'local'));

    const ratingName = config.ratingName || 'Hype';
    let shell = null;
    let current = null; // { key, instance, scoped }
    let token = 0;
    const scrollMemory = new Map(); // route key → scrollY, for back/forward

    // Restore a remembered position once the new view is tall enough (data loads async).
    function restoreScroll(y, my) {
        const t0 = performance.now();
        let stop = false;
        const cancel = () => { stop = true; };
        const evs = ['wheel', 'touchstart', 'keydown', 'mousedown'];
        evs.forEach((e) => window.addEventListener(e, cancel, { passive: true, once: true }));
        const done = () => evs.forEach((e) => window.removeEventListener(e, cancel));
        const step = () => {
            if (stop || my !== token) return done();
            const max = document.documentElement.scrollHeight - window.innerHeight;
            if (max >= y - 1 || performance.now() - t0 > 3000) {
                window.scrollTo(0, Math.min(y, Math.max(0, max)));
                return done();
            }
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    const pageTitle = (route) => {
        if (route.view === 'rankings') return `${ratingName} Rankings`;
        if (route.view === 'notfound') return 'Page not found';
        return typeof route.title === 'function' ? route.title(route.params) : route.title;
    };

    // live = a real server whose data can change: drives polling and the LIVE badge
    // (false for static demo mode and for the read-only `server.js --demo`).
    const live = mode === 'live' && config.mode !== 'demo';

    const makeCtx = (route, scoped) => ({
        api,
        config,
        mode,
        live,
        params: { ...route.params },
        query: { ...route.query },
        route,
        href,
        navigate,
        setQuery,
        getQuery,
        shell: scoped,
        now: () => Date.now(),
    });

    function teardown() {
        if (!current) return;
        try { current.instance?.unmount?.(); } catch (err) { console.error('unmount failed', err); }
        current.scoped?.dispose();
        current = null;
    }

    async function show(route, prev) {
        const my = ++token;
        const key = `${route.view}|${JSON.stringify(route.params)}`;
        const active = document.activeElement;
        const restoreFocus = !!prev && active && active !== document.body && !active.closest?.('#topbar .search');

        if (current && prev && current.key === key) {
            // same view + params, only the query changed → update in place when supported
            if (typeof current.instance?.update === 'function') {
                try {
                    current.instance.update(makeCtx(route, current.scoped));
                    return;
                } catch (err) { console.error('update failed, remounting', err); }
            }
        } else {
            window.scrollTo(0, 0);
        }
        const restoreY = route.via === 'pop' ? scrollMemory.get(route.key) : undefined;

        shell.setTitle(pageTitle(route));
        shell.setActiveNav(route.nav || null);
        if (route.view !== 'rankings') shell.setSearch('');

        teardown();
        app.setAttribute('aria-busy', 'true');
        app.innerHTML = LOADING;

        let mod;
        try {
            mod = await (VIEWS[route.view] || VIEWS.notfound)();
            if (typeof mod?.mount !== 'function') throw new Error(`View "${route.view}" has no mount() export.`);
        } catch (err) {
            if (my !== token) return;
            console.error(err);
            app.removeAttribute('aria-busy');
            app.innerHTML = errorCard('This page failed to load', err);
            return;
        }
        if (my !== token) return;

        const scoped = scopedShell(shell);
        const root = document.createElement('div');
        root.className = `view view-${route.view}`;
        app.replaceChildren(root);
        current = { key, instance: null, scoped };
        try {
            const instance = await mod.mount(root, makeCtx(route, scoped));
            if (my !== token) {
                try { instance?.unmount?.(); } catch { /* ignore */ }
                scoped.dispose();
                return;
            }
            current.instance = instance || null;
        } catch (err) {
            if (my !== token) return;
            console.error(err);
            scoped.dispose();
            current = null;
            app.innerHTML = errorCard('Something went wrong on this page', err);
        } finally {
            if (my === token) app.removeAttribute('aria-busy');
        }
        if (restoreFocus && my === token) app.focus({ preventScroll: true });
        if (restoreY > 0 && my === token) restoreScroll(restoreY, my);
    }

    const router = createRouter({
        mode,
        routes: ROUTES,
        onChange: (route, prev) => {
            if (prev) {
                scrollMemory.delete(prev.key);
                scrollMemory.set(prev.key, window.scrollY);
                if (scrollMemory.size > 60) scrollMemory.delete(scrollMemory.keys().next().value);
            }
            show(route, prev).catch((err) => {
                console.error(err);
                app.innerHTML = errorCard('Something went wrong', err);
            });
        },
    });
    linkTo = href;

    shell = renderShell({ config, mode, router: { href, navigate } });

    app.addEventListener('click', (ev) => {
        if (!(ev.target instanceof Element) || !ev.target.closest('[data-app-retry]') || fatalShown) return;
        const route = router.current();
        if (route) show(route, null);
    });

    booted = true;
    router.start();
}

boot().catch((err) => renderFatal('The site failed to start', err));
