// Developer → IA Sync.
//
// Every action here is preview-then-apply. A sync that writes first and reports
// afterwards is one nobody dares run, so the preview is the primary button and
// Apply stays disabled until you have actually looked at a plan.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const out  = () => $('ia-sync-out');
  const out2 = () => $('ia-sync-out2');

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function note(el, kind, html) {
    const colour = kind === 'bad' ? 'var(--red,#f04f5e)'
                 : kind === 'warn' ? 'var(--amber,#f5b730)'
                 : 'var(--green,#2ed896)';
    el.innerHTML = `<div style="border-left:3px solid ${colour};padding:.6rem .9rem;
      background:rgba(255,255,255,.03);border-radius:6px;">${html}</div>`;
  }

  function busy(el, label) {
    el.innerHTML = `<div class="muted"><i class="ti ti-loader-2"></i> ${esc(label)}…</div>`;
  }

  async function api(url, opts) {
    const res = await fetch(url, { credentials: 'include', ...opts });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
    return body;
  }

  /** The plan, as the sheet's own three blocks. */
  function renderPlan(plan) {
    if (!plan.ok) {
      return note(out(), 'bad', `Could not build a plan: ${esc(plan.reason || 'unknown')}`);
    }
    const week = plan.weekFrom ? new Date(plan.weekFrom).toDateString() : 'this week';
    let html = `<p class="muted" style="margin:0 0 .8rem;">Week starting <strong>${esc(week)}</strong> ·
      ${plan.counts.members} members · ${plan.counts.withPoints} with points</p>`;

    for (const s of plan.sections) {
      if (!s.rows.length) continue;
      html += `<h3 style="margin:1rem 0 .4rem;font-size:13px;letter-spacing:.08em;text-transform:uppercase;">
        ${esc(s.title)}</h3><table class="data-table"><thead><tr>
        <th>Member</th><th>Rank</th><th style="text-align:right;">Total</th><th>Target</th></tr></thead><tbody>`;
      for (const r of s.rows) {
        const target = r.exempt ? 'Exempt' : (r.target == null ? '—' : r.target);
        const colour = r.exempt ? 'var(--text-muted)'
                     : r.met ? 'var(--green,#2ed896)' : 'var(--amber,#f5b730)';
        html += `<tr><td>${esc(r.username)}</td><td class="muted">${esc(r.rankAbbr || r.rank)}</td>
          <td style="text-align:right;color:${colour};"><strong>${r.total}</strong></td>
          <td class="muted">${esc(target)}</td></tr>`;
      }
      html += '</tbody></table>';
    }

    // The two things worth a second look before writing.
    if (plan.unplaced.length) {
      html += `<p style="color:var(--amber,#f5b730);margin-top:.9rem;">
        ${plan.unplaced.length} member(s) have a rank with no quota tier and were left out:
        ${esc(plan.unplaced.map(r => r.username).join(', '))}</p>`;
    }
    if (plan.orphanAwards.length) {
      html += `<p class="muted" style="margin-top:.6rem;">
        ${plan.orphanAwards.length} award(s) belong to somebody not currently in IA
        (left, or the Roblox name never resolved):
        ${esc(plan.orphanAwards.map(o => `${o.robloxUsername || o.key} (${o.total})`).join(', '))}</p>`;
    }
    out().innerHTML = html;
    $('ia-sync-apply').disabled = false;
  }

  function wire() {
    const plan = $('ia-sync-plan');
    if (!plan || plan.dataset.wired) return;
    plan.dataset.wired = '1';

    plan.addEventListener('click', async () => {
      busy(out(), 'Building the plan');
      try { renderPlan(await api('/api/dev/ia-sync/plan')); }
      catch (err) { note(out(), 'bad', esc(err.message)); }
    });

    $('ia-sync-apply').addEventListener('click', async () => {
      busy(out(), 'Writing to the sheet');
      try {
        const r = await api('/api/dev/ia-sync/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            borders: $('ia-sync-borders').checked,
            addMissing: $('ia-sync-add').checked,
          }),
        });
        if (!r.ok) return note(out(), 'bad', esc(r.reason || (r.errors || []).join('; ')));
        let msg = `Updated <strong>${r.updated}</strong> row(s).`;
        if (r.added.length)   msg += ` Added ${r.added.length}: ${esc(r.added.join(', '))}.`;
        if (r.missing.length) msg += `<br><span style="color:var(--amber,#f5b730);">Not found on the sheet: ${esc(r.missing.join(', '))}</span>`;
        if (r.errors.length)  msg += `<br><span style="color:var(--red,#f04f5e);">${esc(r.errors.join('; '))}</span>`;
        note(out(), r.missing.length || r.errors.length ? 'warn' : 'ok', msg);
      } catch (err) { note(out(), 'bad', esc(err.message)); }
    });

    const runImport = async (dry) => {
      const ch = ($('ia-sync-case-channel').value || '').trim();
      if (!ch) return note(out2(), 'bad', 'Give the administrative-log channel id first.');
      busy(out2(), dry ? 'Reading the channel' : 'Importing cases');
      try {
        const r = await api('/api/dev/case-log-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: ch, dry }),
        });
        let msg = `Parsed <strong>${r.parsed ?? 0}</strong> log(s): `
                + `${r.created ?? 0} created, ${r.updated ?? 0} filled in.`;
        // The census is the point: what it could NOT read is what needs a parser.
        const un = r.unmatched || r.unparsed || r.samples;
        if (un && un.length) {
          msg += `<br><span style="color:var(--amber,#f5b730);">${un.length} message(s) looked like a case
            but matched no known format &mdash; these need a new shape adding.</span>`;
        }
        note(out2(), un && un.length ? 'warn' : 'ok', msg);
      } catch (err) { note(out2(), 'bad', esc(err.message)); }
    };

    $('ia-sync-cases-dry').addEventListener('click', () => runImport(true));
    $('ia-sync-cases').addEventListener('click', () => runImport(false));

    $('ia-sync-tickets').addEventListener('click', async () => {
      busy(out2(), 'Sweeping the ticket-log channel');
      try {
        const r = await api('/api/dev/ia-sync/tickets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        if (!r) { note(out2(), 'ok', 'A sweep is already running · try again in a moment.'); return; }
        // Cards posted is the number people actually care about: it is how many
        // closed tickets have just been put in front of a reviewer.
        const cards = r.cardsPosted
          ? ` · review cards posted ${r.cardsPosted}${r.cardsPending ? ` of ${r.cardsPending} waiting` : ''}`
          : (r.cardsPending ? ` · ${r.cardsPending} still waiting for a card` : '');
        note(out2(), r.error ? 'warn' : 'ok',
          `Scanned ${r.scanned ?? '?'} · new ${r.created ?? r.new ?? 0} · refreshed ${r.updated ?? r.refreshed ?? 0}${cards}.`
          + (r.error ? ` ${esc(r.error)}` : ''));
      } catch (err) { note(out2(), 'bad', esc(err.message)); }
    });
  }

  // The page is created by the dashboard's own router, so wire on demand.
  document.addEventListener('DOMContentLoaded', wire);
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('[data-page="ia-sync"]')) setTimeout(wire, 0);
  });
})();
