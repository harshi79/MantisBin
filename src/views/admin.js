/** Private, metadata-only administration. Native forms and tables work without JS. */
import { html } from '../lib/html.js';
import { formatBytes } from '../lib/validate.js';
import { icon } from '../assets/icons.js';
import { layout, alertBox } from './layout.js';

function date(value, time = false) {
  if (value == null) return 'Never';
  const iso = new Date(Number(value) * 1000).toISOString();
  return time ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso.slice(0, 10);
}
function shell(ctx, title, body) {
  return layout({ title: `${title} · MantisBin Admin`, theme: ctx.theme, path: ctx.url.pathname, noindex: true, body });
}
function csrfField(csrf) { return html`<input type="hidden" name="csrf" value="${csrf}">`; }
function actionLink(action, target, label, danger = false) {
  return html`<a class="btn btn-sm ${danger ? 'btn-danger' : 'btn-ghost'}" href="/admin/confirm?action=${action}&amp;target=${target}">${label}</a>`;
}
function pager(ctx, data) {
  const link = (number) => {
    const query = new URLSearchParams(ctx.url.searchParams);
    query.set('page', String(number));
    return `${ctx.url.pathname}?${query}`;
  };
  return html`<nav class="admin-pagination" aria-label="Pagination">
    ${data.number > 1 ? html`<a class="btn btn-sm" href="${link(data.number - 1)}">Previous</a>` : ''}
    <span>Page ${data.number} · up to 25 rows</span>
    ${data.hasNext && data.number < 10000 ? html`<a class="btn btn-sm" href="${link(data.number + 1)}">Next</a>` : ''}
  </nav>`;
}
function options(values, selected) {
  return values.map(([value, label]) => html`<option value="${value}" ${selected === value ? html`selected` : ''}>${label}</option>`);
}
function empty(text) { return html`<div class="empty">${text}</div>`; }

export function adminLoginPage(ctx, csrf, error = '') {
  return shell(ctx, 'Administrator sign-in', html`<section class="card-narrow admin-login">
    <p class="eyebrow">Restricted access</p>
    <h1>Administration</h1>
    <p class="tagline">A separate space to keep MantisBin running well.</p>
    ${alertBox(error ? [error] : [])}
    <form action="/admin/login" method="post">
      ${csrfField(csrf)}
      <div class="field"><label for="admin-password">Administrator password</label>
        <input id="admin-password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus>
      </div>
      <button class="btn btn-primary" type="submit">${icon('lock')} Sign in to admin</button>
    </form>
    <p class="field-note">Uses the ADMIN_PASSWORD secret, not an account password. Sessions expire after one hour.</p>
    <a class="small muted" href="/">Back to MantisBin</a>
  </section>`);
}

function header(session, active) {
  return html`<div class="admin-heading">
    <div><p class="eyebrow">MantisBin / Control room</p><h1>Administration</h1>
      <p class="tagline">Manage the service. Respect the content.</p></div>
    <form action="/admin/logout" method="post">${csrfField(session.csrf)}
      <button class="btn" type="submit">Sign out of admin</button></form>
  </div>
  <nav class="admin-tabs" aria-label="Administration">
    ${[['overview', '/admin', 'Overview'], ['pastes', '/admin/pastes', 'Pastes'], ['users', '/admin/users', 'Accounts'], ['tags', '/admin/tags', 'Tags'], ['stickers', '/admin/stickers', 'Stickers'], ['broadcast', '/admin/broadcast', 'Broadcast'], ['audit', '/admin/audit', 'Audit log']].map(([id, href, label]) => html`<a href="${href}" ${id === active ? html`aria-current="page"` : ''}>${label}</a>`)}
  </nav>`;
}

/**
 * Tag management: the catalogue plus a form that awards a tag to one account.
 *
 * Tags are the only decoration an operator can grant, so they live in their own
 * panel rather than inside the destructive confirmation flow: awarding is not a
 * dangerous action, but it is still audited.
 */
function tagManager(ctx, data) {
  const colors = data.colors || [];
  const effects = data.effects || [];
  return html`<section class="admin-panel"><div class="admin-panel-head"><div><h2>Profile tags</h2><p class="field-note">Award a tag to one account. Tags appear as chips beside the name on the public profile, and every award is recorded in the audit log.</p></div></div>
    <form class="admin-filters" action="/admin/tags" method="post">
      ${csrfField(data.session.csrf)}
      <input type="hidden" name="action" value="award">
      <div class="field grow"><label for="tag-user">Account</label><input id="tag-user" name="username" value="${data.username || ''}" maxlength="20" required placeholder="username"></div>
      <div class="field grow"><label for="tag-label">Tag label</label><input id="tag-label" name="label" maxlength="30" required placeholder="Beta tester"></div>
      <div class="field"><label for="tag-color">Colour</label><select id="tag-color" name="color">${colors.map((color) => html`<option value="${color.id}">${color.label}</option>`)}</select></div>
      <div class="field"><label for="tag-effect">Effect</label><select id="tag-effect" name="effect">${effects.map((effect) => html`<option value="${effect.id}">${effect.label}</option>`)}</select></div>
      <button class="btn btn-primary" type="submit">Award tag</button>
    </form>
    ${data.rows.length
      ? html`<div class="admin-table-scroll" tabindex="0" role="region" aria-label="Tag catalogue"><table class="admin-table"><thead><tr><th>Tag</th><th>Colour</th><th>Effect</th><th>Awarded to</th><th>Holders</th></tr></thead><tbody>
          ${data.rows.map((row) => html`<tr><td><b>${row.label}</b><span class="admin-sub">${row.id}</span></td><td>${row.color}</td><td>${row.effect || '—'}</td>
            <td>${row.holders?.length ? row.holders.map((holder) => html`<span class="admin-tag-row"><a href="/u/${holder}">@${holder}</a> <form action="/admin/tags" method="post">${csrfField(data.session.csrf)}<input type="hidden" name="action" value="revoke"><input type="hidden" name="tag_id" value="${row.id}"><input type="hidden" name="username" value="${holder}"><button class="btn btn-sm btn-ghost" type="submit">Revoke</button></form></span>`) : html`<span class="muted small">nobody yet</span>`}</td>
            <td>${row.count}</td></tr>`)}
        </tbody></table></div>`
      : html`<p class="muted">No tags yet. Awarding the first one creates it.</p>`}
  </section>`;
}

/**
 * Sticker management: the pack, an "add a row" form, and an importer that
 * promotes a GIF search result into the pack.
 *
 * Import is two-step on purpose — pick a provider and a category/id, and the
 * server re-resolves the image — so the pack can only ever contain an image
 * that came from a named provider, never an arbitrary URL from a form post.
 */
function stickerManager(ctx, data) {
  const values = data.values || {};
  return html`<section class="admin-panel">
    <div class="admin-panel-head"><div><h2>Sticker pack</h2>
      <p class="field-note">Tokens are typed in pastes (<span class="mono">:wave:</span>) and resolve at render time, so editing the pack changes every paste at once. Images must be https; a row without an image falls back to its emoji.</p>
    </div><span class="badge">${data.count}/${data.limit}</span></div>

    ${alertBox(data.errors, null)}

    <form class="admin-filters" action="/admin/stickers" method="post">
      ${csrfField(data.session.csrf)}
      <input type="hidden" name="action" value="add">
      <div class="field"><label for="sticker-token">Token</label><input id="sticker-token" name="token" value="${values.token || ''}" maxlength="34" required placeholder=":wave:"></div>
      <div class="field grow"><label for="sticker-label">Label <span class="muted">(alt text)</span></label><input id="sticker-label" name="label" value="${values.label || ''}" maxlength="40" placeholder="Wave"></div>
      <div class="field"><label for="sticker-emoji">Emoji ${icon('star')}</label><input id="sticker-emoji" name="emoji" maxlength="16" placeholder="👋"></div>
      <div class="field grow"><label for="sticker-url">Image URL</label><input id="sticker-url" name="url" maxlength="500" placeholder="https://…/wave.gif"></div>
      <button class="btn btn-primary" type="submit">Add sticker</button>
    </form>

    <form class="admin-filters" action="/admin/stickers" method="post">
      ${csrfField(data.session.csrf)}
      <input type="hidden" name="action" value="import">
      <input type="hidden" name="source" value="neko">
      <div class="field grow"><label for="sticker-category">Import an anime GIF</label>
        <select id="sticker-category" name="category">${data.categories.map((category) => html`<option value="${category.id}">${category.emoji} ${category.label}</option>`)}</select></div>
      <div class="field grow"><label for="sticker-import-token">Token <span class="muted">(optional)</span></label><input id="sticker-import-token" name="token" maxlength="34" placeholder=":anime-hug:"></div>
      <button class="btn" type="submit">Fetch + add</button>
    </form>

    ${data.rows.length
      ? html`<div class="sticker-admin-grid">
          ${data.rows.map(
            (row) => html`<div class="sticker-admin-card">
              <div class="sticker-admin-preview">${row.url ? html`<img src="${row.url}" alt="" width="56" height="56" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : html`<span class="sticker-admin-emoji">${row.emoji || '?'}</span>`}</div>
              <div class="sticker-admin-meta">
                <span class="mono small">${row.token}</span>
                <span class="muted small">${row.label || 'no label'}${row.emoji ? ` · ${row.emoji}` : ''}</span>
                <span class="muted small">added ${date(row.created_at)}</span>
              </div>
              <form action="/admin/stickers" method="post">
                ${csrfField(data.session.csrf)}
                <input type="hidden" name="action" value="delete">
                <input type="hidden" name="id" value="${row.id}">
                <button class="btn btn-sm btn-danger" type="submit">Remove</button>
              </form>
            </div>`,
          )}
        </div>`
      : html`<p class="muted">The pack is empty. Pastes render <span class="mono">:wave:</span> as the built-in emoji until a row is added.</p>`}
  </section>`;
}

/**
 * Broadcast composer: one announcement to every active account, with the
 * recipient count, the cap and the recent sends in front of the operator.
 */
function broadcastComposer(ctx, data) {
  const values = data.values || {};
  return html`<section class="admin-panel">
    <div class="admin-panel-head"><div><h2>Announcement</h2>
      <p class="field-note">Writes one notification to every active account. Suspended accounts are skipped, and the send is capped at ${data.cap} accounts. Use it for service news, not for content.</p>
    </div><span class="badge">${data.recipients} recipient${data.recipients === 1 ? '' : 's'}</span></div>

    ${alertBox(data.errors, null)}

    <form class="admin-broadcast" action="/admin/broadcast" method="post">
      ${csrfField(data.session.csrf)}
      <div class="field"><label for="broadcast-title">Title</label>
        <input id="broadcast-title" name="title" value="${values.title || ''}" maxlength="${data.titleMax}" required placeholder="Scheduled maintenance"></div>
      <div class="field"><label for="broadcast-message">Message</label>
        <textarea id="broadcast-message" name="message" rows="4" maxlength="${data.messageMax}" required placeholder="MantisBin will be read-only for ten minutes at 09:00 UTC.">${values.message || ''}</textarea></div>
      <div class="field"><label for="broadcast-link">Link <span class="muted">(optional)</span></label>
        <input id="broadcast-link" name="link" maxlength="300" placeholder="/docs or https://…" aria-describedby="broadcast-link-help">
        <p class="field-note" id="broadcast-link-help">A path on this site, or an https:// address. Anything else is refused.</p></div>
      <div class="submit-row"><span class="muted small">Everyone with an account can read this in ${icon('bell')} notifications.</span>
        <button class="btn btn-primary" type="submit">Send announcement</button></div>
    </form>

    ${data.recent.length
      ? html`<div class="admin-table-scroll" tabindex="0" role="region" aria-label="Recent announcements"><table class="admin-table"><thead><tr><th>Sent</th><th>Title</th><th>Recipients</th></tr></thead><tbody>
          ${data.recent.map(
            (row) => html`<tr><td>${date(row.sent_at, true)}</td><td><b>${row.title || '—'}</b><span class="admin-sub mono">${row.broadcast_id}</span></td><td>${row.recipients}</td></tr>`,
          )}
        </tbody></table></div>`
      : html`<p class="muted">Nothing has been announced yet.</p>`}
  </section>`;
}

function auditTable(rows) {
  if (!rows.length) return empty('No administrator activity yet.');
  return html`<div class="admin-table-scroll" tabindex="0" role="region" aria-label="Administrator audit log"><table class="admin-table">
    <thead><tr><th>When (UTC)</th><th>Action / target</th><th>Reason</th><th>Session actor</th></tr></thead>
    <tbody>${rows.map((row) => html`<tr>
      <td class="admin-date">${date(row.created_at, true)}</td>
      <td><b>${row.action.replaceAll('_', ' ')}</b><span class="admin-sub">${row.target}</span></td>
      <td class="admin-reason">${row.reason}</td><td class="mono small">${row.actor}</td>
    </tr>`)}</tbody>
  </table></div>`;
}

function overview(data) {
  const p = data.pastes;
  const metrics = [
    ['Active pastes', Number(p.active).toLocaleString(), `${p.guests} anonymous · ${Number(p.active) - Number(p.guests)} account-owned`],
    ['Accounts', Number(data.users.total).toLocaleString(), `${data.users.suspended} suspended`],
    ['Stored text', formatBytes(Number(p.bytes)), 'Content bytes, not database file size'],
    ['Awaiting cleanup', Number(p.stored) - Number(p.active), 'Expired or already-consumed pastes'],
  ];
  const max = Math.max(1, ...data.days.map((row) => Number(row.guests) + Number(row.accounts)));
  return html`<section class="admin-metrics" aria-label="Service snapshot">
    ${metrics.map(([label, value, note]) => html`<article><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`)}
  </section>
  <section class="admin-panel">
    <div class="admin-panel-head"><div><h2>Creation dates of retained pastes</h2><p class="field-note">Last 14 days, UTC · not a lifetime traffic chart</p></div><span class="badge">No visitor tracking</span></div>
    <p class="admin-explainer">Counts only pastes still in the database, including those awaiting cleanup. Deleted, expired-and-cleaned, and consumed pastes disappear from these numbers. Anonymous includes pastes anonymised after account deletion.</p>
    <div class="admin-table-scroll" tabindex="0" role="region" aria-label="Daily retained paste counts"><table class="admin-table admin-daily">
      <thead><tr><th>Date (UTC)</th><th>Anonymous</th><th>Account-owned</th><th>Total retained</th></tr></thead>
      <tbody>${data.days.map((row) => {
        const total = Number(row.guests) + Number(row.accounts);
        return html`<tr><td>${date(row.day)}</td><td>${row.guests}</td><td>${row.accounts}</td><td><span class="admin-meter"><meter min="0" max="${max}" value="${total}" aria-label="${total} retained pastes on ${date(row.day)}">${total}</meter><b>${total}</b></span></td></tr>`;
      })}</tbody>
    </table></div>
  </section>
  <div class="admin-columns">
    <section class="admin-panel admin-panel-padded"><p class="eyebrow">Housekeeping</p><h2>Keep storage tidy</h2>
      <p>Scheduled cleanup is configured hourly. You can also remove a batch of expired or already-consumed pastes now.</p>
      <p class="field-note">Each manual run handles up to 200 pastes and is recorded in the audit log. This does not fetch or read any paste.</p>
      ${actionLink('cleanup', 'expired', 'Review cleanup')}
    </section>
    <section class="admin-panel admin-panel-padded"><p class="eyebrow">Privacy by design</p><h2>Metadata, not content</h2>
      <p>Admin lists do not load paste titles, bodies, thumbnails, passwords, API keys, or session tokens.</p>
      <p class="field-note">${Number(p.views).toLocaleString()} recorded views on retained pastes. This is not a count of unique people. The dashboard does not track visitors.</p>
    </section>
  </div>
  <section class="admin-panel"><div class="admin-panel-head"><h2>Recent admin activity</h2><a href="/admin/audit">View audit log</a></div>${auditTable(data.audit)}</section>`;
}

function pasteList(ctx, data) {
  return html`<section class="admin-panel"><div class="admin-panel-head"><div><h2>Paste management</h2><p class="field-note">Anonymous and account-owned pastes. Metadata only; one-time pastes are never opened here.</p></div></div>
    <form class="admin-filters" action="/admin/pastes" method="get">
      <div class="field grow"><label for="admin-q">Paste ID or username</label><input id="admin-q" name="q" value="${data.q}" maxlength="80" placeholder="Search by ID or owner"></div>
      <div class="field"><label for="admin-owner">Owner</label><select id="admin-owner" name="owner">${options([['', 'All owners'], ['guest', 'Anonymous'], ['account', 'Accounts']], data.owner)}</select></div>
      <div class="field"><label for="admin-state">Status</label><select id="admin-state" name="state">${options([['', 'All statuses'], ['active', 'Active'], ['expired', 'Awaiting cleanup']], data.state)}</select></div>
      <div class="field"><label for="admin-protection">Protection</label><select id="admin-protection" name="protection">${options([['', 'All pastes'], ['password', 'Password protected'], ['burn', 'One-time']], data.protection)}</select></div>
      <button class="btn" type="submit">Filter</button><a class="btn btn-ghost" href="/admin/pastes">Reset</a>
    </form>
    ${data.rows.length ? html`<div class="admin-table-scroll" tabindex="0" role="region" aria-label="Paste metadata"><table class="admin-table"><thead><tr><th>Paste / language</th><th>Owner</th><th>Size / views</th><th>Created / expires (UTC)</th><th>Protection / status</th><th>Action</th></tr></thead><tbody>
      ${data.rows.map((row) => html`<tr><td><b class="mono">${row.id}</b><span class="admin-sub">${row.language}</span></td>
        <td>${row.username || 'Anonymous'}${row.user_id ? html`<span class="admin-sub">Account #${row.user_id}</span>` : ''}</td>
        <td>${formatBytes(Number(row.size))}<span class="admin-sub">${row.views} views</span></td>
        <td class="admin-date">${date(row.created_at)}<span class="admin-sub">${date(row.expires_at)}</span></td>
        <td>${row.protected ? html`<span class="badge">Password</span>` : ''}${row.burn_mode !== 'never' ? html`<span class="badge">One-time</span>` : ''}<span class="admin-sub">${row.burned || (row.expires_at != null && Number(row.expires_at) <= ctx.now) ? 'Awaiting cleanup' : 'Active'}</span></td>
        <td>${actionLink('delete_paste', row.id, 'Delete', true)}</td></tr>`)}
    </tbody></table></div>` : empty('No pastes match these filters.')}
    ${pager(ctx, data)}
  </section><p class="field-note">Anonymous pastes are not guest accounts. This dashboard does not identify or profile anonymous visitors.</p>`;
}

function userList(ctx, data) {
  return html`<section class="admin-panel"><div class="admin-panel-head"><div><h2>Account management</h2><p class="field-note">Suspension blocks authentication, not existing public paste links.</p></div></div>
    <form class="admin-filters" action="/admin/users" method="get">
      <div class="field grow"><label for="admin-q">Username</label><input id="admin-q" name="q" value="${data.q}" maxlength="80" placeholder="Find an account"></div>
      <div class="field"><label for="admin-state">Status</label><select id="admin-state" name="state">${options([['', 'All accounts'], ['suspended', 'Suspended']], data.state)}</select></div>
      <button class="btn" type="submit">Filter</button><a class="btn btn-ghost" href="/admin/users">Reset</a>
    </form>
    ${data.rows.length ? html`<div class="admin-table-scroll" tabindex="0" role="region" aria-label="Accounts"><table class="admin-table"><thead><tr><th>Account</th><th>Joined (UTC)</th><th>Retained pastes</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${data.rows.map((row) => html`<tr><td><b>${row.username}</b><span class="admin-sub">#${row.id}</span></td><td>${date(row.created_at)}</td><td>${row.pastes}</td>
        <td><span class="badge">${row.suspended_at != null ? 'Suspended' : 'Active'}</span></td>
        <td><div class="admin-row-actions">${row.suspended_at != null ? actionLink('restore_user', row.id, 'Restore') : actionLink('suspend_user', row.id, 'Suspend')}${actionLink('revoke_user', row.id, 'Revoke access')}<a class="btn btn-sm btn-ghost" href="/admin/tags?u=${encodeURIComponent(row.username)}">Tags</a>${actionLink('delete_user', row.id, 'Delete', true)}</div></td></tr>`)}
    </tbody></table></div>` : empty('No accounts match these filters.')}
    ${pager(ctx, data)}
  </section>`;
}

export function adminPage(ctx, session, active, data) {
  const body = active === 'overview' ? overview(data) : active === 'pastes' ? pasteList(ctx, data) : active === 'users' ? userList(ctx, data) : active === 'tags' ? tagManager(ctx, data) : active === 'stickers' ? stickerManager(ctx, data) : active === 'broadcast' ? broadcastComposer(ctx, data) : html`
    <section class="admin-panel"><div class="admin-panel-head"><div><h2>Audit log</h2><p class="field-note">Shared-password access is identified by session, not by individual person. Times are UTC.</p></div></div>${auditTable(data.rows)}${pager(ctx, data)}</section>`;
  return shell(ctx, 'Administration', html`<div class="admin-shell">${header(session, active)}
    ${ctx.url.searchParams.get('done') === '1' ? alertBox([], 'Action completed and recorded in the audit log.') : ''}
    ${body}
    <p class="admin-session-note">Session actor: <span class="mono">${session.actor}</span> · Fixed one-hour session · Rotate ADMIN_PASSWORD to invalidate all administrator sessions.</p>
  </div>`);
}

export function confirmationPage(ctx, session, action, target) {
  return shell(ctx, target.spec.label, html`<div class="admin-shell">${header(session, '')}
    <section class="admin-panel admin-confirm admin-panel-padded">
      <p class="eyebrow">Review before continuing</p><h2>${target.spec.label}</h2>
      <p><b>${target.label}</b></p><p>${target.spec.explanation}</p>
      <form action="/admin/action" method="post">
        ${csrfField(session.csrf)}<input type="hidden" name="action" value="${action}"><input type="hidden" name="target" value="${target.target}">
        <div class="field"><label for="admin-reason">Reason for this action</label><textarea id="admin-reason" name="reason" required minlength="5" maxlength="300" rows="3" aria-describedby="reason-help"></textarea><p class="field-note" id="reason-help">Recorded in the audit log. Do not include passwords or paste content.</p></div>
        <label class="check"><input type="checkbox" name="confirm" value="yes" required><span>I understand the effect of this action.</span></label>
        <div class="actions"><button class="btn btn-danger" type="submit">${target.spec.label}</button><a class="btn btn-ghost" href="/admin">Cancel</a></div>
      </form>
    </section></div>`);
}
