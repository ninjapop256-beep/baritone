// App chrome: top bar (brand, nav, search), footer, and shared markup helpers
// (rank tabs, server block, back link). Also owns the delegated copy-to-clipboard buttons.
import { html, setHtml, qs } from './ui/dom.js';
import { href as routerHref, navigate as routerNavigate } from './router.js';

const SEARCH_ICON = html`<svg class="search-icon" viewBox="0 0 10 10" width="14" height="14" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M2 0h4v1H2zM1 1h1v1H1zM6 1h1v1H6zM0 2h1v4H0zM7 2h1v4H7zM1 6h1v1H1zM6 6h1v1H6zM2 7h4v1H2zM7 7h1v1H7zM8 8h1v1H8zM9 9h1v1H9z"/></svg>`;
const EXT = html`<span class="ext" aria-hidden="true">↗</span>`;

const isExternalUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

/** Overall / Game History underline tabs. active: 'overall' | 'history' */
export function rankTabs(active, href = routerHref) {
    const tab = (key, path, label) => html`<a class="tab${active === key ? ' active' : ''}" href="${href(path)}"${active === key ? html` aria-current="page"` : ''}>${label}</a>`;
    return html`<nav class="tabs" aria-label="Rankings sections">${tab('overall', '/rankings/overall', 'Overall')}${tab('history', '/rankings/history', 'Game History')}</nav>`;
}

/** "PLAY" block with copyable server addresses and the alternate join command. */
export function serverBlock(config = {}) {
    const ip = config.serverIp;
    const alt = config.alternateServerIp;
    const cmd = config.alternateServerCommand;
    if (!ip && !alt) return html``;
    const copy = (value) => html`<button class="copy-btn" type="button" data-copy="${value}" title="Copy ${value}"><span class="copy-label">${value}</span></button>`;
    return html`<div class="server-block">
        <span class="server-label">Play</span>
        <div class="server-ips">
            ${ip ? copy(ip) : ''}
            ${ip && alt ? html`<span class="server-or">or</span>` : ''}
            ${alt ? copy(alt) : ''}
            ${alt && cmd ? html`<code class="server-cmd" title="Then run this command">${cmd}</code>` : ''}
        </div>
    </div>`;
}

/** ‹ BACK TO … link */
export function backLink(hrefValue, label) {
    return html`<a class="back-link" href="${hrefValue}"><span class="back-chevron" aria-hidden="true">‹</span>${label}</a>`;
}

async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through to the legacy path */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
}

function announce(msg) {
    const live = document.getElementById('sr-status');
    if (!live) return;
    live.textContent = '';
    // next frame so repeated identical messages are still announced
    requestAnimationFrame(() => { live.textContent = msg; });
}

let globalsInstalled = false;
function installGlobals() {
    if (globalsInstalled) return;
    globalsInstalled = true;

    // Delegated copy buttons anywhere in the app
    document.addEventListener('click', async (ev) => {
        const btn = ev.target instanceof Element ? ev.target.closest('[data-copy]') : null;
        if (!btn) return;
        ev.preventDefault();
        const text = btn.getAttribute('data-copy');
        const ok = await copyText(text);
        btn.classList.toggle('copied', ok);
        btn.classList.toggle('copy-failed', !ok);
        btn.setAttribute('data-copied-text', ok ? 'Copied!' : 'Press Ctrl+C');
        announce(ok ? `Copied ${text} to the clipboard` : `Could not copy ${text}`);
        clearTimeout(btn._copyTimer);
        btn._copyTimer = setTimeout(() => btn.classList.remove('copied', 'copy-failed'), 900);
    });

    // Skip link without touching the hash (hash routing)
    document.addEventListener('click', (ev) => {
        const a = ev.target instanceof Element ? ev.target.closest('.skip-link') : null;
        if (!a) return;
        ev.preventDefault();
        const main = document.getElementById('app');
        main?.focus({ preventScroll: false });
        main?.scrollIntoView({ block: 'start' });
    });
}

/**
 * Renders #topbar and #footer. Returns the shell API:
 *   onSearch(handler) → off;  handler({ type: 'input'|'submit', value }) returns true when handled
 *   setSearch(value), focusSearch(), setActiveNav(key|null), setTitle(page)
 *   rankTabs(active), serverBlock(), backLink(href, label)   (bound to this config/router)
 */
export function renderShell({ config = {}, mode = 'demo', router = {} } = {}) {
    installGlobals();
    const href = router.href || routerHref;
    const navigate = router.navigate || routerNavigate;
    const siteName = config.siteName || 'PVP EVENTS';
    const brand = config.brand || {};
    const mark = brand.mark ?? 'PVP';
    const text = brand.text ?? 'EVENTS';
    const demoData = mode === 'demo' || config.mode === 'demo';

    const navExternal = (url, label) => (isExternalUrl(url)
        ? html`<a class="nav-link" href="${url}" target="_blank" rel="noopener noreferrer" data-external>${label}${EXT}<span class="visually-hidden"> (opens in a new tab)</span></a>`
        : '');

    const topbar = document.getElementById('topbar');
    if (topbar) {
        topbar.classList.add('topbar');
        setHtml(topbar, html`
            <div class="topbar-start">
                <a class="brand" href="${href('/')}" aria-label="${siteName} home">
                    ${mark ? html`<span class="brand-mark">${mark}</span>` : ''}${text ? html`<span class="brand-text">${text}</span>` : ''}
                </a>
            </div>
            <nav class="nav" aria-label="Main">
                ${navExternal(config.storeUrl, 'Store')}
                <a class="nav-link" data-nav="rankings" href="${href('/rankings/overall')}">Rankings</a>
                ${navExternal(config.discordUrl, 'Discord')}
            </nav>
            <div class="topbar-end">
                ${demoData ? html`<span class="demo-chip" title="Showing generated demo data, not real games">Demo data</span>` : ''}
                <form class="search" role="search" autocomplete="off">
                    ${SEARCH_ICON}
                    <label class="visually-hidden" for="search">Search players</label>
                    <input id="search" type="search" name="q" placeholder="Search players…" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" maxlength="32">
                    <kbd aria-hidden="true">/</kbd>
                </form>
            </div>`);
    }

    const footer = document.getElementById('footer');
    if (footer) {
        footer.classList.add('footer');
        const year = new Date().getFullYear();
        setHtml(footer, html`
            <div class="footer-inner">
                <p class="footer-note"><span class="footer-brand">${siteName}</span> · Not affiliated with Mojang or Microsoft.</p>
                <nav class="footer-links" aria-label="Footer">
                    <a href="${href('/rankings/overall')}">Rankings</a>
                    <a href="${href('/rankings/history')}">Game History</a>
                    ${isExternalUrl(config.discordUrl) ? html`<a href="${config.discordUrl}" target="_blank" rel="noopener noreferrer" data-external>Discord</a>` : ''}
                    ${isExternalUrl(config.storeUrl) ? html`<a href="${config.storeUrl}" target="_blank" rel="noopener noreferrer" data-external>Store</a>` : ''}
                </nav>
                <p class="footer-meta">${demoData ? 'Demo data · ' : ''}© ${year} ${siteName}</p>
            </div>`);
    }

    // ---- search ----
    const handlers = [];
    const form = qs('form.search', topbar || document);
    const input = qs('#search', topbar || document);

    function dispatch(type) {
        const value = (input?.value || '').trim();
        for (let i = handlers.length - 1; i >= 0; i--) {
            try {
                if (handlers[i]({ type, value }) === true) return true;
            } catch (err) { console.error(err); }
        }
        return false;
    }

    form?.addEventListener('submit', (ev) => {
        ev.preventDefault();
        if (dispatch('submit')) return;
        const value = (input?.value || '').trim();
        navigate(value ? `/rankings/overall?q=${encodeURIComponent(value)}` : '/rankings/overall');
    });
    input?.addEventListener('input', () => {
        form.classList.toggle('has-value', !!input.value);
        dispatch('input');
    });
    input?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
            ev.preventDefault();
            input.blur();
        }
    });
    document.addEventListener('keydown', (ev) => {
        if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
        const t = ev.target;
        if (t instanceof Element && (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))) return;
        if (!input) return;
        ev.preventDefault();
        input.focus();
        input.select();
    });

    const shell = {
        config,
        mode,
        onSearch(handler) {
            handlers.push(handler);
            return () => {
                const i = handlers.lastIndexOf(handler);
                if (i >= 0) handlers.splice(i, 1);
            };
        },
        setSearch(value) {
            if (!input) return;
            const v = value ?? '';
            if (input.value !== v) input.value = v;
            form?.classList.toggle('has-value', !!v);
        },
        getSearch: () => (input?.value || '').trim(),
        focusSearch() { input?.focus(); },
        setActiveNav(key) {
            for (const a of topbar?.querySelectorAll('[data-nav]') || []) {
                const on = !!key && a.dataset.nav === key;
                a.classList.toggle('active', on);
                if (on) a.setAttribute('aria-current', 'page');
                else a.removeAttribute('aria-current');
            }
        },
        setTitle(page) {
            document.title = page ? `${page} | ${siteName}` : siteName;
        },
        rankTabs: (active) => rankTabs(active, href),
        serverBlock: (cfg) => serverBlock(cfg || config),
        backLink,
    };
    return shell;
}
