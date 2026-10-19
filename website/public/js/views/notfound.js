// Fallback view for unknown routes.
import { html, setHtml } from '../ui/dom.js';

export function mount(root, ctx) {
    const path = ctx.params?.path || ctx.route?.path || '';
    setHtml(root, html`
        <section class="card card-pad notfound">
            <p class="notfound-code" aria-hidden="true">404</p>
            <h1 class="notfound-title">Page not found</h1>
            <p class="card-sub">There is nothing at <code class="notfound-path">${path || '/'}</code>. It may have moved, or the link is mistyped.</p>
            <div class="notfound-actions">
                <a class="btn btn-primary" href="${ctx.href('/rankings/overall')}">Go to rankings</a>
                <a class="btn btn-ghost" href="${ctx.href('/rankings/history')}">Game history</a>
            </div>
        </section>`);
    return { unmount() { root.replaceChildren(); } };
}
