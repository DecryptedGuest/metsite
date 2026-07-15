/* cad-console.js — Metropolitan Police CAD dispatch console (dev panel).
   Talks to /api/cad/*. Every write routes through the same orchestrator the
   #radio channel uses, so the console and radio produce identical dispatch. */
(function () {
  var esc = function (s) { return (window.escapeHtml ? window.escapeHtml(s) : String(s == null ? '' : s)); };
  var fmt = function (d) { return window.formatDateTime ? window.formatDateTime(d) : new Date(d).toLocaleString(); };
  var toast = function (m, k) { if (window.showToast) window.showToast(m, k || 'info'); };
  function apiCall(path, opts) { return window.api(path, opts); }
  function post(path, body) { return apiCall(path, { method: 'POST', body: JSON.stringify(body || {}) }); }

  var STATUS_META = {
    AVAILABLE: ['Available', '#2ed896'], EN_ROUTE: ['En route', '#4a8fff'], ON_SCENE: ['On scene', '#f59e0b'],
    BUSY: ['Busy', '#c2701f'], MEAL_BREAK: ['Refs', '#8b93a1'], URGENT_ASSISTANCE: ['URGENT', '#ef4444'], OFF_DUTY: ['Off duty', '#6b7280'],
  };
  var GRADE_META = { I: ['I', '#ef4444', 'Immediate'], S: ['S', '#f59e0b', 'Significant'], E: ['E', '#4a8fff', 'Extended'], R: ['R', '#8b93a1', 'Referred'] };
  var STATUS_OPTS = ['AVAILABLE', 'EN_ROUTE', 'ON_SCENE', 'BUSY', 'MEAL_BREAK', 'URGENT_ASSISTANCE'];

  function chip(text, color) { return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;color:' + color + ';background:color-mix(in srgb,' + color + ' 16%,transparent);">' + esc(text) + '</span>'; }
  function ago(d) { var s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000); if (s < 60) return Math.floor(s) + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; return Math.floor(s / 3600) + 'h'; }

  var _poll = null;

  window.loadCad = function () {
    cadRefreshStatus();
    cadLoadVoice();
    cadRefreshAll();
    if (_poll) clearInterval(_poll);
    _poll = setInterval(function () {
      var pg = document.getElementById('page-cad');
      if (pg && pg.offsetParent !== null) cadRefreshAll(); else { clearInterval(_poll); _poll = null; }
    }, 4000);
  };

  function cadRefreshAll() { cadBoard(); cadIncidents(); cadFeed(); }

  var _cadStatus = {};
  function cadRefreshStatus() {
    return apiCall('/api/cad/status').then(function (s) {
      _cadStatus = s || {};
      var el = document.getElementById('cad-status-chips');
      if (el) el.innerHTML =
        chip(s.configured ? 'Radio linked' : 'No radio channel', s.configured ? '#2ed896' : '#8b93a1') +
        chip('Voice: ' + (s.voiceConnected ? 'connected' : (s.voiceReady ? 'ready' : 'text-only')), s.voiceConnected ? '#2ed896' : (s.voiceReady ? '#f59e0b' : '#8b93a1')) +
        (s.voiceMode === 'worker' ? chip('Voice host: Fly worker', '#9b6dff') : '') +
        chip('Intent: ' + s.intentEngine, s.intentEngine === 'claude' ? '#9b6dff' : '#8b93a1') +
        chip('TTS: ' + s.ttsEngine, s.ttsEngine === 'elevenlabs' ? '#9b6dff' : '#8b93a1');
      var vs = document.getElementById('cad-voice-state');
      if (vs) vs.innerHTML = s.voiceConnected ? chip('In channel', '#2ed896') : (s.voiceChannelId ? chip('Set, not joined', '#f59e0b') : chip('Not set', '#8b93a1'));
      var note = document.getElementById('cad-voice-note');
      if (note) {
        var v = s.voice || {};
        var workerMode = s.voiceMode === 'worker';
        // In worker mode the ElevenLabs key + voice connection live on the Fly.io
        // worker, so key presence comes from the worker's health, not Railway env.
        var hasKey = workerMode ? !!(s.worker && s.worker.health && s.worker.health.hasElevenKey) : s.hasElevenKey;
        var head;
        if (workerMode && !(s.worker && s.worker.health && s.worker.health.ok)) head = '<i class="ti ti-alert-triangle" style="color:#ef4444;"></i> Voice worker not responding' + (s.worker && s.worker.health && s.worker.health.error ? ' — ' + esc(s.worker.health.error) : '') + '. Check it\'s deployed and CAD_VOICE_WORKER_URL/SECRET match.';
        else if (!hasKey) head = '<i class="ti ti-alert-triangle" style="color:#f59e0b;"></i> No ElevenLabs API key detected' + (workerMode ? ' on the voice worker' : '') + ' — set ELEVENLABS_API_KEY to speak.';
        else if (v.why) head = '<i class="ti ti-alert-triangle" style="color:#f59e0b;"></i> ' + esc(v.why);
        else if (v.lastError) head = '<i class="ti ti-alert-triangle" style="color:#ef4444;"></i> ' + esc(v.lastError);
        else if (v.lastSpokeAt) head = '<i class="ti ti-circle-check" style="color:#2ed896;"></i> Speaking OK — last spoke ' + ago(v.lastSpokeAt) + ' ago.';
        else head = '<span style="color:var(--text-muted);">Pick a server + voice channel, Join, then Radio check.</span>';
        var log = (v.events && v.events.length)
          ? '<pre style="margin:8px 0 0;padding:8px;background:rgba(0,0,0,.25);border-radius:6px;font-size:11px;line-height:1.5;max-height:150px;overflow:auto;white-space:pre-wrap;color:var(--text-secondary);">' + v.events.map(esc).join('\n') + '</pre>'
          : '';
        note.innerHTML = head + log;
      }
      return s;
    }).catch(function () {});
  }

  // ── Voice channel picker ─────────────────────────────────────────────
  function cadLoadVoice() {
    apiCall('/api/cad/guilds').then(function (r) {
      var sel = document.getElementById('cad-voice-guild'); if (!sel) return;
      var guilds = r.guilds || [];
      if (!guilds.length) { sel.innerHTML = '<option value="">Bot not in any server</option>'; return; }
      var cur = _cadStatus.voiceGuildId || '';
      sel.innerHTML = '<option value="">Select a server…</option>' + guilds.map(function (g) {
        return '<option value="' + esc(g.id) + '"' + (g.id === cur ? ' selected' : '') + '>' + esc(g.name) + '</option>';
      }).join('');
      if (cur) cadLoadVoiceChannels();
    }).catch(function () {});
  }
  window.cadLoadVoiceChannels = function () {
    var gsel = document.getElementById('cad-voice-guild'); var csel = document.getElementById('cad-voice-channel');
    if (!gsel || !csel) return;
    var gid = gsel.value;
    if (!gid) { csel.innerHTML = '<option value="">Pick a server first</option>'; return; }
    csel.innerHTML = '<option value="">Loading…</option>';
    apiCall('/api/cad/guilds/' + encodeURIComponent(gid) + '/voice-channels').then(function (r) {
      var ch = r.channels || [];
      if (!ch.length) { csel.innerHTML = '<option value="">No voice channels</option>'; return; }
      var cur = _cadStatus.voiceChannelId || '';
      csel.innerHTML = '<option value="">Select a channel…</option>' + ch.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (c.id === cur ? ' selected' : '') + '>' + (c.stage ? '🎤 ' : '🔊 ') + esc(c.name) + '</option>';
      }).join('');
    }).catch(function () {});
  };
  window.cadVoiceJoin = function (btn) {
    var gid = (document.getElementById('cad-voice-guild') || {}).value;
    var cid = (document.getElementById('cad-voice-channel') || {}).value;
    if (!gid || !cid) return toast('Pick a server and a voice channel.', 'warning');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Joining…'; }
    post('/api/cad/voice/join', { guildId: gid, channelId: cid }).then(function (r) {
      toast(r.joined ? 'Joined the voice channel.' : (r.note || 'Saved.'), r.joined ? 'success' : 'warning');
      cadRefreshStatus();
    }).catch(function (e) { toast(e.message, 'error'); }).then(function () {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-plug"></i> Join & save'; }
    });
  };
  window.cadVoiceLeave = function () { post('/api/cad/voice/leave', {}).then(function () { toast('Left the voice channel.', 'success'); cadRefreshStatus(); }).catch(function (e) { toast(e.message, 'error'); }); };
  window.cadVoiceTest = function () {
    post('/api/cad/voice/test', {}).then(function (r) {
      var v = (r && r.voice) || {};
      if (v.lastSpokeAt && !v.lastError) toast('Radio check spoken in the channel.', 'success');
      else if (v.why) toast('Not speaking: ' + v.why, 'warning');
      else if (v.lastError) toast('Voice issue: ' + v.lastError, 'error');
      else toast('Radio check sent (mirrored to #radio).', 'info');
      cadFeed(); cadRefreshStatus();
    }).catch(function (e) { toast(e.message, 'error'); });
  };

  function cadBoard() {
    apiCall('/api/cad/board').then(function (r) {
      var el = document.getElementById('cad-board'); if (!el) return;
      var units = r.units || [];
      document.getElementById('cad-board-count').textContent = units.length + ' on duty';
      if (!units.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No units booked on.</div>'; return; }
      el.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px;">' + units.map(function (u) {
        var m = STATUS_META[u.status] || [u.status, '#8b93a1'];
        var opts = STATUS_OPTS.map(function (s) { return '<option value="' + s + '"' + (s === u.status ? ' selected' : '') + '>' + (STATUS_META[s] ? STATUS_META[s][0] : s) + '</option>'; }).join('');
        return '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border-dim,rgba(255,255,255,.08));border-radius:10px;' + (u.status === 'URGENT_ASSISTANCE' ? 'border-color:#ef4444;background:rgba(239,68,68,.08);' : '') + '">' +
          '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:13px;">' + esc(u.callsign) + ' ' + chip(m[0], m[1]) + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.officerName) + (u.currentIncidentId ? ' · on a job' : '') + '</div></div>' +
          '<select class="form-control" style="height:28px;font-size:11px;width:110px;" onchange="cadSetStatus(\'' + esc(u.callsign) + '\',this.value)">' + opts + '</select>' +
          '<button class="btn btn-secondary" style="height:28px;padding:0 8px;font-size:11px;" title="Book off" onclick="cadBookOff(\'' + esc(u.callsign) + '\')"><i class="ti ti-user-minus"></i></button>' +
          '</div>';
      }).join('') + '</div>';
    }).catch(function () {});
  }

  function cadIncidents() {
    apiCall('/api/cad/incidents').then(function (r) {
      var el = document.getElementById('cad-incidents'); if (!el) return;
      var inc = r.incidents || [];
      document.getElementById('cad-inc-count').textContent = inc.length + ' open';
      if (!inc.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No open incidents.</div>'; return; }
      el.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px;">' + inc.map(function (i) {
        var g = GRADE_META[i.grade] || [i.grade, '#8b93a1', ''];
        return '<div style="padding:9px 10px;border:1px solid var(--border-dim,rgba(255,255,255,.08));border-radius:10px;border-left:3px solid ' + g[1] + ';">' +
          '<div style="display:flex;align-items:center;gap:8px;"><span style="font-weight:700;font-size:12px;color:' + g[1] + ';" title="' + g[2] + '">' + g[0] + '</span>' +
          '<span style="font-family:var(--font-mono,monospace);font-size:12px;">' + esc(i.cadRef) + '</span>' + chip(i.status, '#8b93a1') +
          '<span style="margin-left:auto;font-size:11px;color:var(--text-muted);">' + ago(i.createdAt) + '</span></div>' +
          '<div style="font-size:13px;margin-top:3px;">' + esc(i.category) + ' — ' + esc(i.location) + '</div>' +
          (i.description ? '<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;">' + esc(i.description) + '</div>' : '') +
          '<div style="display:flex;gap:6px;margin-top:7px;">' +
            '<button class="btn btn-secondary" style="height:26px;padding:0 9px;font-size:11px;" onclick="cadAssign(\'' + esc(i.cadRef) + '\')"><i class="ti ti-user-check"></i> Assign</button>' +
            '<button class="btn btn-secondary" style="height:26px;padding:0 9px;font-size:11px;" onclick="cadUpdate(\'' + esc(i.cadRef) + '\')"><i class="ti ti-note"></i> Update</button>' +
            '<button class="btn btn-secondary" style="height:26px;padding:0 9px;font-size:11px;" onclick="cadClose(\'' + esc(i.cadRef) + '\')"><i class="ti ti-check"></i> Close</button>' +
          '</div></div>';
      }).join('') + '</div>';
    }).catch(function () {});
  }

  function cadFeed() {
    apiCall('/api/cad/feed?limit=50').then(function (r) {
      var el = document.getElementById('cad-feed'); if (!el) return;
      var f = r.feed || [];
      if (!f.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">No radio traffic yet.</div>'; return; }
      el.innerHTML = f.map(function (m) {
        if (m.kind === 'dispatch') {
          return '<div style="padding:6px 8px;border-left:2px solid var(--accent,#4a8fff);margin-bottom:5px;background:rgba(74,143,255,.05);border-radius:0 6px 6px 0;">' +
            '<div style="font-size:12px;"><i class="ti ti-broadcast" style="color:var(--accent);font-size:11px;"></i> ' + esc(m.text) + '</div>' +
            '<div style="font-size:10px;color:var(--text-muted);">control · ' + ago(m.at) + ' ago</div></div>';
        }
        var badge = m.intent && m.intent !== 'UNKNOWN' ? chip(m.intent + ' ' + Math.round((m.confidence || 0) * 100) + '%', m.confidence >= 0.6 ? '#2ed896' : '#f59e0b') : chip('unreadable', '#ef4444');
        return '<div style="padding:6px 8px;margin-bottom:5px;border-radius:6px;">' +
          '<div style="font-size:12px;"><strong>' + esc(m.callsign || m.author) + ':</strong> ' + esc(m.text) + '</div>' +
          '<div style="font-size:10px;color:var(--text-muted);display:flex;gap:6px;align-items:center;margin-top:2px;">' + badge + '<span>' + (m.source || '') + ' · ' + ago(m.at) + ' ago</span></div></div>';
      }).join('');
    }).catch(function () {});
  }

  // ── Actions ──────────────────────────────────────────────────────────
  window.cadBookOn = function () {
    var cs = (document.getElementById('cad-bo-cs') || {}).value || '';
    var nm = (document.getElementById('cad-bo-name') || {}).value || '';
    if (!cs.trim()) return toast('Enter a callsign.', 'warning');
    post('/api/cad/bookon', { callsign: cs.trim(), officerName: nm.trim() || 'Console' }).then(function () {
      document.getElementById('cad-bo-cs').value = ''; document.getElementById('cad-bo-name').value = '';
      toast('Unit booked on.', 'success'); cadRefreshAll();
    }).catch(function (e) { toast(e.message || 'Failed', 'error'); });
  };
  window.cadBookOff = function (cs) { post('/api/cad/bookoff', { callsign: cs }).then(function () { toast(cs + ' booked off.', 'success'); cadRefreshAll(); }).catch(function (e) { toast(e.message, 'error'); }); };
  window.cadSetStatus = function (cs, status) { post('/api/cad/status', { callsign: cs, status: status }).then(function () { cadRefreshAll(); }).catch(function (e) { toast(e.message, 'error'); cadBoard(); }); };
  window.cadCreateIncident = function () {
    var grade = (document.getElementById('cad-inc-grade') || {}).value;
    var cat = (document.getElementById('cad-inc-cat') || {}).value || '';
    var loc = (document.getElementById('cad-inc-loc') || {}).value || '';
    var desc = (document.getElementById('cad-inc-desc') || {}).value || '';
    if (!cat.trim() || !loc.trim()) return toast('Category and location are required.', 'warning');
    post('/api/cad/incident', { grade: grade, category: cat.trim(), location: loc.trim(), description: desc.trim() }).then(function (r) {
      document.getElementById('cad-inc-cat').value = ''; document.getElementById('cad-inc-loc').value = ''; document.getElementById('cad-inc-desc').value = '';
      toast('Incident ' + (r.incident ? r.incident.cadRef : '') + ' created.', 'success'); cadRefreshAll();
    }).catch(function (e) { toast(e.message || 'Failed', 'error'); });
  };
  window.cadAssign = function (ref) {
    var cs = window.prompt('Assign which callsign to ' + ref + '?', 'MP-1'); if (!cs) return;
    post('/api/cad/incident/assign', { ref: ref, callsign: cs.trim() }).then(function () { toast(cs + ' assigned to ' + ref + '.', 'success'); cadRefreshAll(); }).catch(function (e) { toast(e.message, 'error'); });
  };
  window.cadUpdate = function (ref) {
    var msg = window.prompt('Update / SITREP for ' + ref + ':'); if (!msg) return;
    post('/api/cad/incident/update', { ref: ref, message: msg.trim() }).then(function () { toast('Update noted.', 'success'); cadFeed(); }).catch(function (e) { toast(e.message, 'error'); });
  };
  window.cadClose = function (ref) {
    var out = window.prompt('Closing outcome for ' + ref + ':', 'Resolved'); if (out === null) return;
    post('/api/cad/incident/close', { ref: ref, outcome: out.trim() }).then(function () { toast(ref + ' closed.', 'success'); cadRefreshAll(); }).catch(function (e) { toast(e.message, 'error'); });
  };
  window.cadVehicle = function () {
    var vrm = (document.getElementById('cad-pnc-vrm') || {}).value || ''; if (!vrm.trim()) return;
    post('/api/cad/pnc/vehicle', { vrm: vrm.trim() }).then(function (r) { renderPnc(vehicleCard(r)); }).catch(function (e) { toast(e.message, 'error'); });
  };
  window.cadPerson = function () {
    var sur = (document.getElementById('cad-pnc-sur') || {}).value || ''; var fore = (document.getElementById('cad-pnc-fore') || {}).value || '';
    if (!sur.trim()) return toast('Enter a surname.', 'warning');
    post('/api/cad/pnc/person', { surname: sur.trim(), forename: fore.trim() || null }).then(function (r) { renderPnc(personCard(r)); }).catch(function (e) { toast(e.message, 'error'); });
  };
  window.cadTransmit = function () {
    var t = (document.getElementById('cad-tx') || {}).value || ''; if (!t.trim()) return;
    post('/api/cad/transmit', { text: t.trim() }).then(function () { document.getElementById('cad-tx').value = ''; cadFeed(); }).catch(function (e) { toast(e.message, 'error'); });
  };
  window.cadSeedPnc = function (btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader"></i> Seeding…'; }
    post('/api/cad/seed', {}).then(function (r) { toast('Seeded ' + r.vehicles + ' vehicles' + (r.personsSkipped ? '' : ', ' + r.persons + ' persons') + '.', 'success'); })
      .catch(function (e) { toast(e.message, 'error'); })
      .then(function () { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-database-plus"></i> Seed PNC'; } });
  };

  function renderPnc(html) { var el = document.getElementById('cad-pnc-out'); if (el) el.innerHTML = html; }
  function flag(text, color) { return '<span style="display:inline-block;font-size:11px;font-weight:600;color:' + color + ';background:color-mix(in srgb,' + color + ' 15%,transparent);padding:2px 7px;border-radius:6px;margin:2px 3px 0 0;">' + esc(text) + '</span>'; }
  function vehicleCard(r) {
    if (!r.found || !r.record) return '<div style="color:#ef4444;"><i class="ti ti-alert-triangle"></i> Negative trace on ' + esc(r.vrm || '') + '. No record held.</div>';
    var v = r.record; var fl = [];
    if (/untax/i.test(v.taxStatus)) fl.push(flag('Untaxed', '#ef4444')); else if (/sorn/i.test(v.taxStatus)) fl.push(flag('SORN', '#f59e0b'));
    if (/expire|none/i.test(v.motStatus)) fl.push(flag('No MOT', '#ef4444'));
    if (/uninsur/i.test(v.insuranceStatus)) fl.push(flag('Uninsured', '#ef4444'));
    if (v.stolen) fl.push(flag('STOLEN', '#ef4444'));
    (v.markers || []).forEach(function (m) { fl.push(flag(m, '#9b6dff')); });
    return '<div style="border:1px solid var(--border-dim,rgba(255,255,255,.08));border-radius:8px;padding:9px 10px;">' +
      '<div style="font-weight:700;font-family:var(--font-mono,monospace);">' + esc(v.vrm) + '</div>' +
      '<div style="font-size:13px;margin-top:2px;">' + esc(v.colour) + ' ' + esc(v.make) + ' ' + esc(v.model) + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);">RK: ' + esc(v.registeredKeeper) + '</div>' +
      '<div style="margin-top:5px;">' + (fl.length ? fl.join('') : flag('All in order', '#2ed896')) + '</div></div>';
  }
  function personCard(r) {
    if (!r.found || !r.records.length) return '<div style="color:#ef4444;"><i class="ti ti-alert-triangle"></i> Negative trace, no person record held.</div>';
    return r.records.slice(0, 6).map(function (p) {
      var fl = [];
      if (p.wanted) fl.push(flag('WANTED', '#ef4444'));
      (p.warningMarkers || []).forEach(function (m) { fl.push(flag(m, '#f59e0b')); });
      return '<div style="border:1px solid var(--border-dim,rgba(255,255,255,.08));border-radius:8px;padding:9px 10px;margin-bottom:6px;">' +
        '<div style="font-weight:700;">' + esc(p.forename) + ' ' + esc(p.surname) + '</div>' +
        '<div style="font-size:12px;color:var(--text-muted);">DOB ' + esc(p.dob) + ' · ' + esc(p.address) + '</div>' +
        '<div style="margin-top:5px;">' + (fl.length ? fl.join('') : flag('No markers', '#2ed896')) + '</div></div>';
    }).join('');
  }
})();
