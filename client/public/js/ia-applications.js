// client/public/js/ia-applications.js
// Reading and marking Internal Affairs applications, for Deputy Director and above.
//
// ── What this screen is for ───────────────────────────────────────
//
// Somebody has spent most of an hour writing six sections. The job here is to read
// it properly and decide, and everything on screen is arranged around that:
//
//   * the answers are the biggest thing on the page, in the order they were
//     written, with the question above each one;
//   * the marks are next to the answer they are for, not on a separate screen, so
//     nobody is scrolling back and forth holding a number in their head;
//   * the running total is pinned to the bottom, so the effect of a mark is
//     visible as it is typed rather than after a submit;
//   * the integrity findings are presented as EVIDENCE with the numbers attached,
//     never as a score. See server/lib/iaApplicationIntegrity.js for why.

(function () {
  'use strict';

  var stats = null;
  var tab = 'SUBMITTED';
  var queue = [];
  var open = null;        // the application being read
  var scores = {};        // qid → marks, as typed

  var esc = window.escapeHtml || function (s) { return String(s == null ? '' : s); };
  var host = function () { return document.getElementById('iar-body'); };

  function fmt(d) {
    if (!d) return '·';
    try { return new Date(d).toLocaleString(); } catch (e) { return String(d); }
  }

  function ago(d) {
    if (!d) return '';
    var s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  // ── The queue ───────────────────────────────────────────────────
  function renderQueue() {
    var h = '<div class="iar-tabs">'
      + tabBtn('SUBMITTED', 'Waiting', stats && stats.waiting)
      + tabBtn('ACCEPTED', 'Accepted', stats && stats.accepted)
      + tabBtn('REJECTED', 'Rejected', stats && stats.rejected)
      + '</div>';

    // The state of the paper and the key, said once at the top. A marker hand-
    // marking six multiple-choice questions should know it is because the key has
    // not been filled in, not because that is how it works.
    if (stats && stats.answerKey && !stats.answerKey.complete) {
      h += '<div class="panel glass iar-panel" style="border-left:3px solid var(--amber);">'
        + '<div class="iar-phead"><i class="ti ti-key"></i> The multiple-choice key is not set</div>'
        + '<div class="iar-nofind">' + stats.answerKey.unkeyed.length + ' of ' + stats.answerKey.total
        + ' multiple-choice questions have no correct answer recorded, so they are marked by hand like '
        + 'everything else. Nothing is pre-filled and nothing is guessed. Once the answers are set, '
        + 'those marks fill themselves in.</div></div>';
    }
    if (stats && stats.pages && !stats.pages.complete) {
      h += '<div class="panel glass iar-panel" style="border-left:3px solid var(--amber);">'
        + '<div class="iar-phead"><i class="ti ti-file-alert"></i> The paper is unfinished</div>'
        + '<div class="iar-nofind">Sections ' + esc(stats.pages.missing.join(', ')) + ' have no questions yet.</div></div>';
    }

    if (!queue.length) {
      h += '<div class="panel glass iar-state"><div class="big">'
        + (tab === 'SUBMITTED' ? '📭' : '📁') + '</div>'
        + '<h2>' + (tab === 'SUBMITTED' ? 'Nothing waiting' : 'Nothing here yet') + '</h2>'
        + '<p>' + (tab === 'SUBMITTED'
            ? 'Every application has been decided. New ones appear here as they are sent.'
            : 'No applications have been ' + tab.toLowerCase() + ' yet.') + '</p></div>';
      host().innerHTML = h;
      return wireQueue();
    }

    h += '<div class="panel glass" style="padding:0;overflow:hidden;">';
    h += queue.map(function (r) {
      var chips = '';
      if (r.evidenceCount) chips += '<span class="iar-chip ev">' + r.evidenceCount + ' evidence</span>';
      if (r.suggestiveCount) chips += '<span class="iar-chip sug">' + r.suggestiveCount + ' to check</span>';
      var pick = r.divisionless === true
        ? '<span class="iar-pick first">First pick</span>'
        : (r.divisionless === false
            ? '<span class="iar-pick later" title="' + esc((r.divisions || []).join(', ')) + '">In a division</span>'
            : '');
      return '<div class="iar-row" data-id="' + esc(r.id) + '">'
        + '<span class="iar-ref">' + esc(r.appRef) + '</span>'
        + '<span class="iar-who"><span class="a">' + esc(r.robloxUsername || r.discordUsername || '·') + '</span>'
        +   '<span class="b">' + esc(r.discordUsername || '') + '</span></span>'
        + pick
        + '<span class="iar-chips">' + chips + '</span>'
        + (r.status === 'SUBMITTED'
            ? '<span class="iar-when">' + esc(ago(r.submittedAt)) + '</span>'
            : '<span class="iar-when">' + (r.percentage != null ? r.percentage + '% · ' : '')
              + esc(r.markedByName || '') + '</span>')
        + '<i class="ti ti-chevron-right" style="color:var(--text-muted);"></i>'
        + '</div>';
    }).join('');
    h += '</div>';

    host().innerHTML = h;
    wireQueue();
  }

  function tabBtn(key, label, n) {
    return '<button class="iar-tab' + (tab === key ? ' on' : '') + '" data-tab="' + key + '">'
      + esc(label) + (n != null ? '<span class="n">' + n + '</span>' : '') + '</button>';
  }

  function wireQueue() {
    host().querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { tab = b.dataset.tab; loadQueue(); });
    });
    host().querySelectorAll('.iar-row').forEach(function (r) {
      r.addEventListener('click', function () { openOne(r.dataset.id); });
    });
  }

  // ── One application ─────────────────────────────────────────────

  // ── The applicant's profile ─────────────────────────────────────
  // Fetched once per application and cached on `open`, so flipping between
  // answers and going back and forth does not re-hit Roblox every render.
  var VERDICT = {
    pass:    { icon: 'ti-check',           cls: 'ok'   },
    fail:    { icon: 'ti-alert-triangle',  cls: 'bad'  },
    unknown: { icon: 'ti-help-circle',     cls: 'unk'  },
    note:    { icon: 'ti-info-circle',     cls: 'note' },
  };

  function days(n) {
    if (n == null) return '·';
    if (n < 1) return 'today';
    if (n < 60) return n + ' day' + (n === 1 ? '' : 's');
    if (n < 730) return Math.round(n / 30.44) + ' months';
    return (Math.round((n / 365.25) * 10) / 10) + ' years';
  }

  function avatar(url, alt, cls) {
    if (!url) {
      return '<span class="iar-av ' + (cls || '') + ' none"><i class="ti ti-user"></i></span>';
    }
    return '<img class="iar-av ' + (cls || '') + '" src="' + esc(url) + '" alt="' + esc(alt || '') + '"'
      + ' onerror="this.className=\'iar-av ' + (cls || '') + ' none\';this.removeAttribute(\'src\');" />';
  }

  function kv(k, v, tone) {
    return '<div class="iar-kv"><span class="k">' + esc(k) + '</span>'
      + '<span class="v' + (tone ? ' ' + tone : '') + '">' + (v == null || v === '' ? '·' : v) + '</span></div>';
  }

  function profileHtml(p) {
    if (!p) return '';
    var h = '';

    // ── The two accounts, side by side ─────────────────────────────
    h += '<div class="panel glass iar-panel iar-prof">'
      + '<div class="iar-phead"><i class="ti ti-user-scan"></i> Who applied</div>'
      + '<div class="iar-idents">';

    // Roblox. The full body is here because a marker genuinely looks at it.
    var rb = p.roblox || {};
    h += '<div class="iar-ident rbx">'
      + '<div class="iar-ident-pics">'
      +   avatar(rb.body, rb.username, 'big')
      +   avatar(rb.headshot, rb.username, 'small')
      + '</div>'
      + '<div class="iar-ident-body">'
      +   '<div class="iar-ident-top"><i class="ti ti-brand-roblox"></i> Roblox</div>'
      +   '<div class="iar-ident-name">' + esc(rb.username || 'not linked') + '</div>'
      +   (rb.displayName && rb.displayName !== rb.username
            ? '<div class="iar-ident-sub">shows as ' + esc(rb.displayName) + '</div>' : '')
      +   '<div class="iar-ident-rows">'
      +     kv('ID', rb.id ? '<span class="mono">' + esc(rb.id) + '</span>' : null)
      +     kv('Account made', rb.createdAt ? esc(fmt(rb.createdAt)) : null)
      +     kv('Account age', rb.accountAgeDays == null ? null
              : rb.accountAgeDays + ' days'
                + (rb.accountAgeDays >= 60 ? ' <span class="iar-dim">(' + days(rb.accountAgeDays) + ')</span>' : '')
                + ' <span class="iar-rule ' + (rb.meetsAgeRule === false ? 'bad' : rb.meetsAgeRule ? 'ok' : 'unk') + '">'
                + (rb.meetsAgeRule === false ? 'under the ' + rb.minAccountDays + '-day rule'
                   : rb.meetsAgeRule ? 'meets the ' + rb.minAccountDays + '-day rule' : 'unchecked')
                + '</span>')
      +     kv('MET group', rb.metGroup ? esc(rb.metGroup.rank) : (rb.groupsRead ? 'not a member' : null),
                rb.groupsRead && !rb.metGroup ? 'bad' : '')
      +     (rb.iaGroup ? kv('IA group', esc(rb.iaGroup.rank)) : '')
      +     kv('Groups', rb.groupsRead ? String((rb.groups || []).length) : null)
      +   '</div>'
      +   (rb.profileUrl
            ? '<a class="iar-ident-link" href="' + esc(rb.profileUrl) + '" target="_blank" rel="noopener">'
              + '<i class="ti ti-external-link"></i> Open on Roblox</a>' : '')
      + '</div></div>';

    // Discord. No API call: the creation date comes out of the id itself.
    var dc = p.discord || {};
    h += '<div class="iar-ident dsc">'
      + '<div class="iar-ident-pics">' + avatar(dc.avatar, dc.username, 'big') + '</div>'
      + '<div class="iar-ident-body">'
      +   '<div class="iar-ident-top"><i class="ti ti-brand-discord"></i> Discord</div>'
      +   '<div class="iar-ident-name">' + esc(dc.username || '·') + '</div>'
      +   (dc.displayName && dc.displayName !== dc.username
            ? '<div class="iar-ident-sub">shows as ' + esc(dc.displayName) + '</div>' : '')
      +   '<div class="iar-ident-rows">'
      +     kv('ID', dc.id ? '<span class="mono">' + esc(dc.id) + '</span>' : null)
      +     kv('Account made', dc.createdAt ? esc(fmt(dc.createdAt)) : null)
      +     kv('Account age', days(dc.accountAgeDays))
      +     kv('Signed in here', p.site && p.site.everSignedIn
              ? esc(fmt(p.site.lastLogin)) + ' <span class="iar-dim">(' + days(p.site.lastLoginDaysAgo) + ' ago)</span>'
              : 'never')
      +     kv('Site account', p.site && p.site.accountCreated ? esc(fmt(p.site.accountCreated)) : null)
      +   '</div>'
      + '</div></div>';

    h += '</div>';   // /iar-idents

    // ── The checks the rules make ──────────────────────────────────
    if ((p.checks || []).length) {
      h += '<div class="iar-checks">' + p.checks.map(function (c) {
        var v = VERDICT[c.verdict] || VERDICT.unknown;
        return '<div class="iar-check ' + v.cls + '" title="' + esc(c.detail || '') + '">'
          + '<i class="ti ' + v.icon + '"></i>'
          + '<span class="l">' + esc(c.label) + '</span>'
          + '<span class="d">' + esc(c.detail || '') + '</span></div>';
      }).join('') + '</div>';
    }
    if ((rb.notes || []).length) {
      h += '<div class="iar-nofind" style="margin-top:.7rem;color:var(--amber);">'
        + rb.notes.map(esc).join(' ') + '</div>';
    }
    h += '</div>';   // /panel

    // ── What they said, next to what we can see ────────────────────
    var d = p.declared || {};
    h += '<div class="panel glass iar-panel">'
      + '<div class="iar-phead"><i class="ti ti-list-details"></i> What they told us</div>'
      + '<div class="iar-grid4">'
      +   kv('Age', d.age ? esc(d.age) : null)
      +   kv('Plays on', d.platform ? esc(d.platform) : null)
      +   kv('Timezone', d.timezone ? esc(d.timezone) : null)
      +   kv('Applied from', d.device ? esc(d.device) : null)
      + '</div>'
      + '<div class="iar-nofind" style="margin-top:.5rem;">The device was detected, not typed. '
      + 'What they play on is what they said, and the two are allowed to differ.</div>'
      + '</div>';

    // ── Where the snapshot and the present disagree ────────────────
    if ((p.drift || []).length) {
      h += '<div class="panel glass iar-panel" style="border-left:3px solid var(--amber);">'
        + '<div class="iar-phead"><i class="ti ti-arrows-exchange"></i> Changed since they applied</div>'
        + '<div class="iar-drifts">' + p.drift.map(function (x) {
            return '<div class="iar-drift"><span class="w">' + esc(x.what) + '</span>'
              + '<span class="t">' + esc(x.then) + '</span>'
              + '<i class="ti ti-arrow-right"></i>'
              + '<span class="n">' + esc(x.now) + '</span></div>';
          }).join('') + '</div></div>';
    }

    // ── MET standing ───────────────────────────────────────────────
    var m = p.met || {};
    h += '<div class="panel glass iar-panel">'
      + '<div class="iar-phead"><i class="ti ti-shield-check"></i> Where they stand in MET</div>'
      + '<div class="iar-grid4">'
      +   kv('MET rank', m.rank ? esc(m.rank) + (m.rankSource ? ' <span class="iar-dim">' + esc(m.rankSource) + '</span>' : '') : null)
      +   kv('XP', m.xp == null ? null
            : '<strong>' + m.xp + '</strong>'
              + (m.xpRank ? ' <span class="iar-dim">' + esc(m.xpRank) + '</span>' : '')
              + (m.xpPosition ? ' <span class="iar-dim">#' + m.xpPosition + ' of ' + m.xpOf + '</span>' : ''))
      +   kv('Site role', m.siteRole ? esc(m.siteRole) : null)
      +   kv('Divisions', m.divisionless === true
            ? '<span class="iar-rule ok">none · first pick</span>'
            : (m.divisions || []).map(function (x) {
                return esc(x.division) + (x.rank ? ' <span class="iar-dim">' + esc(x.rank) + '</span>' : '');
              }).join(' · ') || null)
      + '</div></div>';

    // ── Their record ───────────────────────────────────────────────
    var rec = p.record || {};
    var lastWeek = Number(rec.casesInLastWeek) || 0;
    h += '<div class="panel glass iar-panel"'
      + (lastWeek || rec.isBlacklisted || (rec.activePunishments || []).length
          ? ' style="border-left:3px solid var(--amber);"' : '') + '>'
      + '<div class="iar-phead"><i class="ti ti-gavel"></i> Their record</div>'
      + '<div class="iar-grid4">'
      +   kv('Cases against them', rec.casesAgainstThem == null ? null : String(rec.casesAgainstThem))
      +   kv('In the last week', rec.casesInLastWeek == null ? null : String(lastWeek), lastWeek ? 'bad' : 'ok')
      +   kv('Punishments running', String((rec.activePunishments || []).length),
            (rec.activePunishments || []).length ? 'bad' : 'ok')
      +   kv('Tickets they closed', rec.ticketsHandled == null ? null : String(rec.ticketsHandled))
      + '</div>';
    if (rec.isBlacklisted) {
      h += '<div class="iar-nofind" style="color:var(--red);margin-top:.6rem;"><strong>This account is blacklisted.</strong> '
        + esc(rec.blacklistReason || '') + '</div>';
    }
    if ((rec.activePunishments || []).length) {
      h += '<div class="iar-punish">' + rec.activePunishments.map(function (x) {
        return '<span class="iar-pill bad">' + esc(x.action) + ' · ' + x.daysLeft + 'd left'
          + ' <span class="iar-dim">' + esc(x.caseRef) + '</span></span>';
      }).join('') + '</div>';
    }
    if ((rec.recentCases || []).length) {
      h += '<div class="iar-cases">' + rec.recentCases.map(function (c) {
        return '<div class="iar-case">'
          + '<span class="r mono">' + esc(c.caseRef || '·') + '</span>'
          + '<span class="a">' + esc(c.action || '·') + '</span>'
          + '<span class="s">' + esc(String(c.status || '').toLowerCase()) + '</span>'
          + '<span class="w">' + esc(fmt(c.createdAt)) + '</span>'
          + '<span class="y">' + esc(c.reason || '') + '</span>'
          + '</div>';
      }).join('') + '</div>';
    } else if (rec.casesAgainstThem === 0) {
      h += '<div class="iar-nofind" style="margin-top:.5rem;">Nothing on record.</div>';
    }
    if ((rec.notes || []).length) {
      h += '<div class="iar-nofind" style="margin-top:.5rem;color:var(--amber);">' + rec.notes.map(esc).join(' ') + '</div>';
    }
    h += '</div>';

    // ── Every group they are in ────────────────────────────────────
    if (rb.groupsRead && (rb.groups || []).length) {
      h += '<div class="panel glass iar-panel">'
        + '<div class="iar-phead"><i class="ti ti-users-group"></i> Roblox groups · ' + rb.groups.length + '</div>'
        + '<div class="iar-nofind" style="margin:0 0 .7rem;">Every group they are in, with the rank they hold. '
        + 'Nothing here is a verdict · it is context.</div>'
        + '<div class="iar-groups">' + rb.groups.map(function (g) {
            var flag = (rb.metGroup && g.id === rb.metGroup.id) ? ' met'
                     : ((rb.iaGroup && g.id === rb.iaGroup.id) ? ' ia' : '');
            return '<a class="iar-group' + flag + '" href="' + esc(g.url) + '" target="_blank" rel="noopener">'
              + (g.icon ? '<img src="' + esc(g.icon) + '" alt="" onerror="this.style.visibility=\'hidden\'" />'
                        : '<span class="ico"><i class="ti ti-users"></i></span>')
              + '<span class="n">' + esc(g.name) + '</span>'
              + '<span class="r">' + esc(g.rank) + '</span>'
              + '</a>';
          }).join('') + '</div></div>';
    }

    // ── Applied before? ────────────────────────────────────────────
    if ((p.history || []).length) {
      h += '<div class="panel glass iar-panel">'
        + '<div class="iar-phead"><i class="ti ti-history"></i> They have applied before · ' + p.history.length + '</div>'
        + '<div class="iar-hist">' + p.history.map(function (x) {
            var st = String(x.status || '').toLowerCase();
            return '<div class="iar-histrow">'
              + '<span class="r mono">' + esc(x.appRef) + '</span>'
              + '<span class="s ' + esc(st) + '">' + esc(st) + '</span>'
              + '<span class="p">' + (x.percentage != null ? x.percentage + '%' : '·') + '</span>'
              + '<span class="b">' + esc(x.markedByName || '') + '</span>'
              + '<span class="w">' + esc(fmt(x.markedAt || x.submittedAt)) + '</span>'
              + '</div>';
          }).join('') + '</div></div>';
    }

    return h;
  }

  async function loadProfile(id) {
    var box = document.getElementById('iar-profile');
    if (!box) return;
    try {
      // Cached on the open application, so going back to an answer and returning
      // does not spend another round of Roblox calls.
      if (!open.profile) open.profile = await api('/api/ia-application-review/' + encodeURIComponent(id) + '/profile');
      if (!document.getElementById('iar-profile')) return;   // they navigated away
      document.getElementById('iar-profile').innerHTML = profileHtml(open.profile);
    } catch (err) {
      var b = document.getElementById('iar-profile');
      if (b) {
        b.innerHTML = '<div class="panel glass iar-panel" style="border-left:3px solid var(--amber);">'
          + '<div class="iar-phead"><i class="ti ti-user-scan"></i> Who applied</div>'
          + '<div class="iar-nofind">Their profile could not be built: ' + esc(err.message || 'unknown error')
          + '. The application itself is unaffected · the summary above still stands.</div></div>';
      }
    }
  }

  function renderOne() {
    var a = open.application, paper = open.paper, found = open.integrity;
    var decided = a.status !== 'SUBMITTED';

    var h = '<div class="iar-back"><button class="btn btn-ghost btn-sm" id="iar-back">'
      + '<i class="ti ti-arrow-left"></i> Back to the queue</button></div>';

    // ── Who, and what we already knew about them ─────────────────
    var ctx = a.context || {};
    var cell = function (k, v) {
      return '<div class="cell"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v || '·') + '</span></div>';
    };
    h += '<div class="panel glass iar-idbar">'
      + cell('Reference', a.appRef)
      + cell('Roblox', a.robloxUsername)
      + cell('Discord', a.discordUsername)
      + cell('Sent', fmt(a.submittedAt))
      + cell('Timezone', (a.answers || {}).timezone)
      + cell('MET rank', ctx.metRank)
      + cell('Division', ctx.divisionless === true ? 'None · first pick'
          : (Array.isArray(ctx.divisions) && ctx.divisions.length ? ctx.divisions.join(', ') : '·'))
      + cell('Plays on', (a.answers || {}).platform)
      + cell('Age', (a.answers || {}).age_band)
      + '</div>';

    // The full profile lands here. Fetched separately because it calls Roblox,
    // and the paper should be readable while that happens rather than after it.
    // The snapshot line below is what a marker sees in the meantime, so the
    // section is never empty — it just gets better.
    h += '<div id="iar-profile">'
      + '<div class="panel glass iar-panel iar-prof-loading">'
      + '<div class="iar-phead"><i class="ti ti-user-scan"></i> Who applied</div>'
      + '<div class="iar-nofind"><span class="spinner"></span> Reading their accounts, groups and record…</div>'
      + '</div></div>';

    // ── How it was written ───────────────────────────────────────
    h += '<div class="panel glass iar-panel">'
      + '<div class="iar-phead"><i class="ti ti-fingerprint"></i> How this was written</div>';
    var s = found.summary || {};
    if (s.hasTelemetry) {
      h += '<div class="iar-meta" style="margin:0 0 .7rem;">'
        + '<span>' + esc(s.activeTyping || '·') + ' of typing</span>'
        + '<span>' + (s.characters || 0) + ' characters</span>'
        + '<span>away ' + esc(s.away || '0s') + '</span>'
        + (s.pasteCount ? '<span class="bad">' + s.pasteCount + ' paste(s), ' + s.pastedCharacters + ' characters</span>' : '<span>no pastes</span>')
        + '</div>';
    }
    var flags = (found.flags || []);
    if (!flags.length) {
      h += '<div class="iar-nofind">Nothing stood out. That is not proof it was written honestly · '
        + 'it means the things this can measure look ordinary.</div>';
    } else {
      h += flags.map(function (f) {
        var sev = f.severity === 'evidence' ? 'Evidence'
                : f.severity === 'suggestive' ? 'Worth checking' : 'Note';
        return '<div class="iar-find ' + esc(f.severity) + '">'
          + '<div class="lbl"><span class="sev">' + sev + '</span>' + esc(f.label) + '</div>'
          + (f.detail ? '<div class="det">' + esc(f.detail) + '</div>' : '')
          + (Array.isArray(f.items) && f.items.length > 1
              ? '<ul class="items">' + f.items.slice(0, 8).map(function (it) {
                  return '<li>' + esc(Object.keys(it).map(function (k) {
                    return k + '=' + String(it[k]).slice(0, 60);
                  }).join('  ')) + '</li>';
                }).join('') + '</ul>'
              : '')
          + '</div>';
      }).join('');
      h += '<div class="iar-nofind" style="margin-top:.7rem;">'
        + '<strong>Evidence</strong> is close to conclusive on its own. '
        + '<strong>Worth checking</strong> is consistent with cheating and also with ordinary behaviour, '
        + 'and should never decide anything by itself. There is no percentage here on purpose: nobody can '
        + 'turn typing speed into a calibrated probability, and a number that looks calibrated gets '
        + 'treated as though it is.</div>';
    }

    // The detectors, on demand only.
    var providers = (stats && stats.aiProviders) || [];
    if (open.aiScan) {
      h += '<div class="iar-find note" style="margin-top:.7rem;">'
        + '<div class="lbl"><span class="sev">AI scan</span>Run by ' + esc(open.aiScan.scannedByName || '·')
        + ' at ' + fmt(open.aiScan.at) + '</div>'
        + '<div class="det">' + esc(summariseScan(open.aiScan)) + '</div></div>';
    } else if (!decided) {
      h += '<div style="margin-top:.7rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;">'
        + '<button class="btn btn-ghost btn-sm" id="iar-scan"' + (providers.length ? '' : ' disabled')
        + '><i class="ti ti-robot"></i> Run an AI scan on the written answers</button>'
        + '<span class="iar-nofind" style="flex:1;min-width:200px;">'
        + (providers.length
            ? 'Third-party detectors (' + esc(providers.join(', ')) + '). They have real false-positive rates, '
              + 'so treat the result as one more piece of evidence, not a verdict.'
            : 'No detector is configured, so there is nothing to run.')
        + '</span></div>';
    }
    h += '</div>';

    // ── The answers, section by section ──────────────────────────
    h += '<div class="panel glass iar-panel">'
      + '<div class="iar-phead"><i class="ti ti-file-text"></i> What they wrote</div>';

    (paper.sections || []).forEach(function (sec) {
      var marked = sec.questions.filter(function (q) { return !q.captured; });
      if (!marked.length) return;
      h += '<div class="iar-sect"><div class="iar-sname">Section ' + sec.page + ' · ' + esc(sec.title) + '</div>';
      marked.forEach(function (q) { h += answerHtml(q, a, decided); });
      h += '</div>';
    });
    h += '</div>';

    // ── The decision ─────────────────────────────────────────────
    if (decided) {
      h += '<div class="panel glass iar-panel">'
        + '<div class="iar-phead"><i class="ti ti-stamp"></i> Decision</div>'
        + '<div class="iar-nofind"><strong style="color:' + (a.status === 'ACCEPTED' ? 'var(--green)' : 'var(--amber)') + ';">'
        + esc(a.status) + '</strong> by ' + esc(a.markedByName || '·') + ' on ' + fmt(a.markedAt)
        + ' · ' + (a.score != null ? a.score + '/' + a.maxScore + ' (' + a.percentage + '%)' : 'no score')
        + (a.markerNote ? '<div style="margin-top:.6rem;white-space:pre-wrap;">' + esc(a.markerNote) + '</div>' : '')
        + '</div></div>';
    } else {
      h += '<div class="panel glass iar-panel">'
        + '<div class="iar-phead"><i class="ti ti-message-2"></i> Note for the record</div>'
        + '<textarea class="form-control" id="iar-note" rows="3" maxlength="2000" '
        + 'placeholder="Why you decided what you decided. The applicant is told this."></textarea>'
        + '</div>';
      h += totalHtml();
    }

    host().innerHTML = h;
    wireOne(decided);
    loadProfile(a.id);
  }

  function summariseScan(scan) {
    if (!scan) return '';
    if (scan.overall && typeof scan.overall.aiPercent === 'number') {
      return 'The detectors put the written answers at roughly ' + Math.round(scan.overall.aiPercent)
        + '% machine-like overall. That is their opinion, not a measurement.';
    }
    if (scan.error) return 'The scan did not complete: ' + scan.error;
    return 'The scan ran. Read the per-answer results alongside everything else.';
  }

  function answerHtml(q, a, decided) {
    var val = (a.answers || {})[q.id];
    var text = q.type === 'agreement' ? (val === true ? 'Agreed' : 'NOT agreed') : String(val == null ? '' : val);
    var words = text.trim() ? text.trim().split(/\s+/).length : 0;

    var h = '<div class="iar-a" id="a-' + esc(q.id) + '">';
    h += '<div class="iar-q">' + esc(q.prompt || q.statement || q.id) + '</div>';
    h += '<div class="iar-ans' + (text.trim() ? '' : ' empty') + '">' + (text.trim() ? esc(text) : 'Left blank') + '</div>';

    // The numbers a marker would otherwise count by hand, including whether the
    // stated minimum was actually met.
    var bits = [];
    if (q.type === 'paragraph') {
      var need = q.minWords || 0, lim = q.maxWords || 0;
      var cls = (need && words < need) || (lim && words > lim) ? 'bad' : '';
      bits.push('<span class="' + cls + '">' + words + ' words'
        + (need ? ' (needs ' + need + (lim ? '–' + lim : '+') + ')' : '') + '</span>');
    }
    var t = (open.integrity && open.integrity.summary && open.integrity.summary.hasTelemetry) ? true : false;
    if (t) {
      var m = (open.rawPerQuestion || {})[q.id];
      if (m && m.chars) {
        bits.push('<span>' + Math.round((m.ms || 0) / 1000) + 's</span>');
        var ratio = m.chars ? (m.keystrokes || 0) / m.chars : 1;
        bits.push('<span class="' + (ratio < 0.4 ? 'bad' : '') + '">'
          + (m.keystrokes || 0) + ' keystrokes for ' + m.chars + ' characters</span>');
      }
    }
    if (bits.length) h += '<div class="iar-meta">' + bits.join('') + '</div>';

    if (q.guidance) h += '<div class="iar-guide">' + esc(q.guidance) + '</div>';

    if (q.points) {
      if (q.type === 'choice' && q.correct == null) {
        h += '<div class="iar-nokey"><i class="ti ti-key-off"></i> No correct answer is recorded for this one, '
          + 'so it is not pre-marked. Nothing has been guessed.</div>';
      } else if (q.type === 'choice' && q.correct != null) {
        var right = String(val) === String(q.correct);
        h += '<div class="iar-meta"><span class="' + (right ? '' : 'bad') + '">'
          + (right ? 'Correct' : 'Wrong · the answer is “' + esc(q.correct) + '”') + '</span></div>';
      }
      if (!decided) {
        h += '<div class="iar-mark">'
          + '<label for="s-' + esc(q.id) + '">Marks</label>'
          + '<input class="form-control" type="number" id="s-' + esc(q.id) + '" data-score="' + esc(q.id) + '" '
          + 'min="0" max="' + q.points + '" step="1" value="' + (scores[q.id] != null ? scores[q.id] : 0) + '" />'
          + '<span class="of">of ' + q.points + '</span>'
          + '<span class="quick">'
          +   '<button data-set="' + esc(q.id) + '|0">0</button>'
          +   (q.points > 1 ? '<button data-set="' + esc(q.id) + '|' + Math.floor(q.points / 2) + '">'
                + Math.floor(q.points / 2) + '</button>' : '')
          +   '<button data-set="' + esc(q.id) + '|' + q.points + '">' + q.points + '</button>'
          + '</span></div>';
      } else {
        h += '<div class="iar-meta"><span>' + ((a.scores || {})[q.id] != null ? (a.scores || {})[q.id] : '·')
          + ' of ' + q.points + ' marks</span></div>';
      }
    }
    return h + '</div>';
  }

  function totalHtml() {
    var maxScore = (stats && stats.totalPoints) || 0;
    var passMark = (stats && stats.passMark) || 0;
    var total = Object.keys(scores).reduce(function (n, k) { return n + (Number(scores[k]) || 0); }, 0);
    var pc = maxScore ? Math.round((total / maxScore) * 100) : 0;
    var pass = total >= passMark;
    return '<div class="iar-total ' + (pass ? 'pass' : 'fail') + '" id="iar-total">'
      + '<span class="n">' + total + ' / ' + maxScore + '</span>'
      + '<span class="pc">' + pc + '%' + (passMark ? ' · pass mark is ' + passMark : '') + '</span>'
      + '<span class="spacer"></span>'
      + '<button class="btn btn-danger" id="iar-reject"><i class="ti ti-x"></i> Reject</button>'
      + '<button class="btn btn-success" id="iar-accept"><i class="ti ti-check"></i> Accept</button>'
      + '</div>';
  }

  function refreshTotal() {
    var el = document.getElementById('iar-total');
    if (!el) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = totalHtml();
    el.replaceWith(tmp.firstElementChild);
    wireDecide();
  }

  function wireDecide() {
    var acc = document.getElementById('iar-accept');
    var rej = document.getElementById('iar-reject');
    if (acc) acc.addEventListener('click', function () { decide('accept'); });
    if (rej) rej.addEventListener('click', function () { decide('reject'); });
  }

  function wireOne(decided) {
    var back = document.getElementById('iar-back');
    if (back) back.addEventListener('click', function () { open = null; renderQueue(); window.scrollTo({ top: 0 }); });

    host().querySelectorAll('[data-score]').forEach(function (el) {
      el.addEventListener('input', function () {
        var q = el.dataset.score;
        var max = Number(el.max) || 0;
        var n = Math.max(0, Math.min(max, Math.round(Number(el.value) || 0)));
        scores[q] = n;
        refreshTotal();
      });
    });
    host().querySelectorAll('[data-set]').forEach(function (b) {
      b.addEventListener('click', function () {
        var parts = b.dataset.set.split('|');
        scores[parts[0]] = Number(parts[1]);
        var input = document.getElementById('s-' + parts[0]);
        if (input) input.value = parts[1];
        refreshTotal();
      });
    });
    var scan = document.getElementById('iar-scan');
    if (scan) scan.addEventListener('click', runScan);
    if (!decided) wireDecide();
  }

  // ── Actions ─────────────────────────────────────────────────────
  async function runScan() {
    var btn = document.getElementById('iar-scan');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Scanning…'; }
    try {
      var out = await api('/api/ia-application-review/' + open.application.id + '/ai-scan', { method: 'POST' });
      if (out && out.ok) { open.aiScan = out.aiScan; renderOne(); showToast('Scan finished.', 'success'); }
      else { showToast((out && out.why) || 'Nothing to scan.', 'info'); if (btn) btn.disabled = false; }
    } catch (err) {
      showToast(err.message || 'The scan failed.', 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-robot"></i> Run an AI scan on the written answers'; }
    }
  }

  async function decide(what) {
    var a = open.application;
    var maxScore = (stats && stats.totalPoints) || 0;
    var total = Object.keys(scores).reduce(function (n, k) { return n + (Number(scores[k]) || 0); }, 0);
    var pc = maxScore ? Math.round((total / maxScore) * 100) : 0;
    var note = (document.getElementById('iar-note') || {}).value || '';

    // Two things worth stopping for, because both are the kind of mistake somebody
    // notices afterwards.
    var warn = '';
    var passMark = (stats && stats.passMark) || 0;
    if (what === 'accept' && passMark && total < passMark) {
      warn = '\n\nNote this scores ' + total + '/' + maxScore + ', which is below the pass mark of '
           + passMark + '. Accepting is still yours to do · the score is evidence, not the decision.';
    }
    var ev = (open.integrity.flags || []).filter(function (f) { return f.severity === 'evidence'; });
    if (what === 'accept' && ev.length) {
      warn += '\n\nThere ' + (ev.length === 1 ? 'is 1 piece' : 'are ' + ev.length + ' pieces')
           + ' of EVIDENCE against how this was written. Read those before accepting.';
    }
    if (!note.trim()) {
      warn += '\n\nYou have not written a note. The applicant is told your reason, and "no reason given" '
           + 'is what a rejection looks like without one.';
    }

    var yes = await uiConfirm(
      (what === 'accept' ? 'Accept ' : 'Reject ') + a.appRef + ' · '
      + (a.robloxUsername || a.discordUsername) + ' · at ' + total + '/' + maxScore + ' (' + pc + '%)?'
      + warn,
      { title: what === 'accept' ? 'Accept this application?' : 'Reject this application?',
        confirmText: what === 'accept' ? 'Accept' : 'Reject',
        cancelText: 'Go back', danger: what === 'reject',
        icon: what === 'accept' ? 'ti-check' : 'ti-x' });
    if (!yes) return;

    try {
      await api('/api/ia-application-review/' + a.id + '/decide', {
        method: 'POST',
        body: JSON.stringify({ decision: what, scores: scores, note: note }),
      });
      showToast(a.appRef + ' ' + (what === 'accept' ? 'accepted' : 'rejected') + '.', 'success');
      open = null;
      await loadStats();
      await loadQueue();
      window.scrollTo({ top: 0 });
    } catch (err) {
      showToast(err.message || 'Could not record that decision.', 'error');
    }
  }

  // ── Loading ─────────────────────────────────────────────────────
  async function loadStats() {
    try {
      stats = await api('/api/ia-application-review/stats');
      var sub = document.getElementById('iar-sub');
      if (sub) {
        sub.textContent = 'Deputy Director and above · pass mark ' + stats.passMark + ' of ' + stats.totalPoints
          + ' (' + stats.passPercent + '%)';
      }
    } catch (err) { stats = null; }
  }

  async function loadQueue() {
    host().innerHTML = '<div class="iar-state"><div class="spinner"></div></div>';
    try {
      queue = await api('/api/ia-application-review/queue?status=' + encodeURIComponent(tab));
      renderQueue();
    } catch (err) {
      host().innerHTML = '<div class="panel glass iar-state"><div class="big">🔒</div>'
        + '<h2>Not for you</h2><p>' + esc(err.message || 'Reading applications is limited to Deputy Director and above.')
        + '</p></div>';
    }
  }

  async function openOne(id) {
    host().innerHTML = '<div class="iar-state"><div class="spinner"></div></div>';
    try {
      open = await api('/api/ia-application-review/' + encodeURIComponent(id));
      // The per-question telemetry, so each answer can show its own numbers.
      open.rawPerQuestion = {};
      // It is not in the response by design (the integrity module owns the
      // interpretation), so derive what the per-answer line needs from the flags.
      (open.integrity.flags || []).forEach(function (f) {
        (f.items || []).forEach(function (it) {
          if (it && it.question) open.rawPerQuestion[it.question] = it;
        });
      });
      scores = Object.assign({}, open.application.scores || {});
      renderOne();
      window.scrollTo({ top: 0 });
    } catch (err) {
      showToast(err.message || 'Could not open that application.', 'error');
      loadQueue();
    }
  }

  // ── Open or closed ──────────────────────────────────────────────
  // The only control on this page that changes something outside it, so it says
  // plainly what closing does and does not do. People do not close recruitment
  // expecting to lose the applications already in the queue.
  var gate = null;

  function renderGate() {
    var box = document.getElementById('iar-gate');
    if (!box || !gate) return;
    box.style.display = '';
    box.classList.toggle('closed', !gate.open);
    box.classList.toggle('open', !!gate.open);
    document.getElementById('iar-gate-state').textContent =
      gate.open ? 'Applications are open' : 'Applications are closed';
    document.getElementById('iar-gate-sub').textContent = gate.open
      ? 'Anybody eligible can start one.'
      : 'Nobody new can start or send one. Drafts and the queue are untouched.';
    var note = document.getElementById('iar-gate-note');
    if (note && note.value !== gate.note) note.value = gate.note || '';
    var btn = document.getElementById('iar-gate-btn');
    btn.className = 'btn btn-sm ' + (gate.open ? 'btn-ghost' : 'btn-success');
    btn.innerHTML = gate.open
      ? '<i class="ti ti-lock"></i> Close applications'
      : '<i class="ti ti-lock-open"></i> Open applications';
  }

  async function loadGate() {
    try { gate = await api('/api/ia-application-review/gate'); renderGate(); }
    catch (err) { /* the queue is still usable */ }
  }

  async function toggleGate() {
    if (!gate) return;
    var closing = gate.open;
    var note = document.getElementById('iar-gate-note');
    if (closing) {
      var yes = await (typeof uiConfirm === 'function'
        ? uiConfirm('Nobody new will be able to start or send an application.\n\n'
            + 'Everything already here stays: drafts are kept, and the applications '
            + 'waiting in the queue still need marking.',
            { title: 'Close applications?', confirmText: 'Close them',
              cancelText: 'Leave them open', icon: 'ti-lock' })
        : Promise.resolve(confirm('Close applications?')));
      if (!yes) return;
    }
    var btn = document.getElementById('iar-gate-btn');
    var was = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner"></div>';
    try {
      gate = await api('/api/ia-application-review/gate', {
        method: 'POST',
        body: JSON.stringify({ open: !closing, note: note ? note.value : '' }),
      });
      renderGate();
      showToast(gate.open ? 'Applications are open again.' : 'Applications are closed.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not change that.', 'error');
    } finally {
      btn.disabled = false;
      if (!gate) btn.innerHTML = was;
    }
  }

  (async function init() {
    var gb = document.getElementById('iar-gate-btn');
    if (gb) gb.addEventListener('click', toggleGate);
    // Saving the note while closed takes effect without reopening and reclosing.
    var gn = document.getElementById('iar-gate-note');
    if (gn) gn.addEventListener('change', async function () {
      if (!gate || gate.open) return;
      try {
        gate = await api('/api/ia-application-review/gate',
          { method: 'POST', body: JSON.stringify({ open: false, note: gn.value }) });
        renderGate();
        showToast('Saved what applicants are told.', 'success');
      } catch (err) { showToast(err.message || 'Could not save that.', 'error'); }
    });
    await Promise.all([loadStats(), loadGate()]);
    await loadQueue();
  })();
})();
