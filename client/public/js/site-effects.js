// site-effects.js — developer-controlled site-wide effects
(function () {
  var confettiOn   = false;
  var fireworksOn  = false;
  var fwTimer      = null;
  var partyTimer   = null;
  var countdownTimer = null;
  var cursorHandler = null; // the rainbow-cursor mousemove listener (so it can be removed)

  // ── helpers ─────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function rm(id) { var e = el(id); if (e) e.remove(); }

  function injectStyle(id, css) {
    rm(id);
    var s = document.createElement('style');
    s.id = id; s.textContent = css;
    document.head.appendChild(s);
  }

  function clearAll() {
    ['site-banner','site-snow','site-matrix','site-spotlight',
     'site-fireworks-wrap','site-countdown','site-spiders','site-cursor-trail']
      .forEach(rm);
    ['site-style-party','site-style-halloween','site-style-cursor']
      .forEach(rm);
    if (fwTimer)      { clearInterval(fwTimer);      fwTimer      = null; }
    if (partyTimer)   { clearInterval(partyTimer);   partyTimer   = null; }
    if (countdownTimer){ clearInterval(countdownTimer); countdownTimer = null; }
    if (cursorHandler) { document.removeEventListener('mousemove', cursorHandler); cursorHandler = null; }
    // Reset background glows that party mode manipulates inline
    document.querySelectorAll('.bg-glow-1,.bg-glow-2').forEach(function(g) {
      g.style.removeProperty('background');
    });
  }

  // ── Banner ──────────────────────────────────────────────────────
  function renderBanner(text, color) {
    if (!text) return;
    var bar = document.createElement('div');
    bar.id = 'site-banner';
    bar.textContent = text;
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9000;padding:8px 16px;' +
      'text-align:center;font-size:13px;font-weight:600;color:#fff;' +
      'background:' + (color || '#3c6eff') + ';box-shadow:0 2px 12px rgba(0,0,0,.35);' +
      'letter-spacing:.02em;';
    document.body.appendChild(bar);
  }

  // ── Snow ────────────────────────────────────────────────────────
  function renderSnow() {
    var wrap = document.createElement('div');
    wrap.id = 'site-snow';
    wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8999;overflow:hidden;';
    injectStyle('site-style-snow',
      '@keyframes sf-fall{0%{transform:translateY(-10vh) translateX(0);opacity:0}' +
      '10%{opacity:.9}100%{transform:translateY(110vh) translateX(40px);opacity:.2}}');
    for (var i = 0; i < 40; i++) {
      var f = document.createElement('div');
      var size = 8 + Math.random() * 7;
      f.innerHTML = met.e('met_snow', { size: size });
      f.style.cssText =
        'position:absolute;top:-5vh;left:' + (Math.random()*100) + 'vw;' +
        'opacity:' + (0.4+Math.random()*0.6) + ';' +
        'line-height:0;' +
        'animation:sf-fall ' + (6+Math.random()*8) + 's linear ' + (Math.random()*8) + 's infinite;';
      wrap.appendChild(f);
    }
    document.body.appendChild(wrap);
  }

  // ── Matrix Rain ─────────────────────────────────────────────────
  function renderMatrix() {
    var canvas = document.createElement('canvas');
    canvas.id = 'site-matrix';
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8990;opacity:.18;';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var cols = Math.floor(canvas.width / 16);
    var drops = [];
    for (var i = 0; i < cols; i++) drops[i] = Math.random() * -50;
    var chars = 'ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ0123456789ABCDEF';
    (function draw() {
      if (!el('site-matrix')) return;
      ctx.fillStyle = 'rgba(0,0,0,0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#00ff41';
      ctx.font = '14px monospace';
      for (var j = 0; j < drops.length; j++) {
        var ch = chars[Math.floor(Math.random()*chars.length)];
        ctx.fillText(ch, j*16, drops[j]*16);
        if (drops[j]*16 > canvas.height && Math.random() > 0.975) drops[j] = 0;
        drops[j]++;
      }
      requestAnimationFrame(draw);
    })();
  }

  // ── Party Mode ──────────────────────────────────────────────────
  function renderParty() {
    var hue = 0;
    var glows = document.querySelectorAll('.bg-glow-1,.bg-glow-2');
    partyTimer = setInterval(function () {
      hue = (hue + 2) % 360;
      var col1 = 'hsl(' + hue + ',80%,40%)';
      var col2 = 'hsl(' + ((hue+140)%360) + ',80%,40%)';
      glows.forEach(function (g, i) {
        g.style.background = 'radial-gradient(ellipse,'+( i===0 ? col1 : col2 )+' 0%,transparent 70%)';
      });
    }, 40);
  }

  // ── Fireworks ───────────────────────────────────────────────────
  function shootFirework() {
    var box = document.getElementById('site-fireworks-wrap');
    if (!box) return;
    var x = 20 + Math.random() * 60;
    var y = 10 + Math.random() * 40;
    var hue = Math.floor(Math.random()*360);
    var n = 60;
    for (var i = 0; i < n; i++) {
      var p = document.createElement('div');
      var angle = (i / n) * 360;
      var dist  = 40 + Math.random() * 80;
      var rad   = angle * Math.PI / 180;
      var tx    = Math.cos(rad) * dist;
      var ty    = Math.sin(rad) * dist;
      var size  = 3 + Math.random() * 4;
      p.style.cssText =
        'position:absolute;border-radius:50%;pointer-events:none;' +
        'width:' + size + 'px;height:' + size + 'px;' +
        'background:hsl(' + hue + ',100%,65%);' +
        'left:' + x + 'vw;top:' + y + 'vh;' +
        'animation:fw-burst 1.2s cubic-bezier(.2,.6,.3,1) forwards;' +
        '--tx:' + tx + 'px;--ty:' + ty + 'px;';
      box.appendChild(p);
      setTimeout(function(pp){ pp.remove(); }, 1400, p);
    }
  }

  function renderFireworks() {
    var box = document.createElement('div');
    box.id  = 'site-fireworks-wrap';
    box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9100;overflow:hidden;';
    document.body.appendChild(box);
    injectStyle('site-style-fw',
      '@keyframes fw-burst{0%{transform:translate(0,0);opacity:1}' +
      '100%{transform:translate(var(--tx),var(--ty));opacity:0}}');
    shootFirework();
    fwTimer = setInterval(function () {
      var cnt = 1 + Math.floor(Math.random()*3);
      for (var i = 0; i < cnt; i++) setTimeout(shootFirework, i * 200);
    }, 2500 + Math.random() * 3000);
  }

  // ── Halloween ───────────────────────────────────────────────────
  function renderHalloween() {
    injectStyle('site-style-halloween',
      ':root{--blue:#ff6a00 !important;--purple:#9b1dff !important}' +
      '.bg-glow-1{background:radial-gradient(ellipse,#ff4500 0%,transparent 70%) !important}' +
      '.bg-glow-2{background:radial-gradient(ellipse,#6b0fad 0%,transparent 70%) !important}' +
      '@keyframes spider-drop{0%{top:-5vh;opacity:0}10%{opacity:1}' +
      '80%{opacity:.8}100%{top:110vh;opacity:0}}');
    var wrap = document.createElement('div');
    wrap.id = 'site-spiders';
    wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8995;overflow:hidden;';
    var spiders = ['met_spider','met_web','met_ghost','met_bat','met_pumpkin'];
    for (var i = 0; i < 20; i++) {
      var sp = document.createElement('div');
      sp.innerHTML = met.e(spiders[Math.floor(Math.random()*spiders.length)], { size: 14+Math.random()*20 });
      sp.style.cssText =
        'position:absolute;top:-5vh;left:' + (Math.random()*100) + 'vw;' +
        'line-height:0;' +
        'animation:spider-drop ' + (8+Math.random()*10) + 's linear ' + (Math.random()*10) + 's infinite;';
      wrap.appendChild(sp);
    }
    document.body.appendChild(wrap);
  }

  // ── Rainbow cursor ──────────────────────────────────────────────
  function renderRainbowCursor() {
    injectStyle('site-style-cursor', '*{cursor:crosshair!important}');
    var trail = document.createElement('div');
    trail.id = 'site-cursor-trail';
    trail.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9200;overflow:hidden;';
    document.body.appendChild(trail);
    var hue = 0;
    cursorHandler = function (e) {
      if (!el('site-cursor-trail')) return;
      var dot = document.createElement('div');
      hue = (hue + 8) % 360;
      var size = 8 + Math.random() * 6;
      dot.style.cssText =
        'position:fixed;pointer-events:none;border-radius:50%;' +
        'width:' + size + 'px;height:' + size + 'px;' +
        'left:' + (e.clientX - size/2) + 'px;top:' + (e.clientY - size/2) + 'px;' +
        'background:hsl(' + hue + ',100%,60%);opacity:.9;' +
        'transition:opacity .4s,transform .4s;';
      trail.appendChild(dot);
      setTimeout(function () { dot.style.opacity='0'; dot.style.transform='scale(0)'; }, 50);
      setTimeout(function () { dot.remove(); }, 450);
    };
    document.addEventListener('mousemove', cursorHandler);
  }

  // ── User Spotlight ──────────────────────────────────────────────
  function renderSpotlight(username) {
    if (!username) return;
    var bar = document.createElement('div');
    bar.id = 'site-spotlight';
    bar.innerHTML = met.e('met_star') + ' <strong>Spotlight:</strong> ' + username + ' ' + met.e('met_star');
    bar.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9050;' +
      'padding:10px 28px;border-radius:999px;font-size:14px;font-weight:700;color:#fff;' +
      'background:linear-gradient(135deg,#f5c518,#ff8c00);' +
      'box-shadow:0 0 30px rgba(245,197,24,.6),0 4px 18px rgba(0,0,0,.4);' +
      'letter-spacing:.04em;white-space:nowrap;' +
      'animation:spotlight-pulse 2s ease-in-out infinite;';
    injectStyle('site-style-spotlight',
      '@keyframes spotlight-pulse{0%,100%{box-shadow:0 0 30px rgba(245,197,24,.6),0 4px 18px rgba(0,0,0,.4)}' +
      '50%{box-shadow:0 0 60px rgba(245,197,24,.9),0 4px 28px rgba(0,0,0,.5)}}');
    document.body.appendChild(bar);
  }

  // ── Countdown ───────────────────────────────────────────────────
  function renderCountdown(label, target) {
    if (!label || !target) return;
    var end = new Date(target).getTime();
    if (isNaN(end)) return;
    var box = document.createElement('div');
    box.id = 'site-countdown';
    box.style.cssText =
      'position:fixed;top:52px;right:16px;z-index:8998;padding:10px 16px;border-radius:10px;' +
      'background:rgba(10,12,20,.85);border:1px solid rgba(60,110,255,.4);' +
      'backdrop-filter:blur(8px);font-size:12px;color:var(--text-secondary);min-width:160px;text-align:center;' +
      'box-shadow:0 4px 20px rgba(0,0,0,.5);';
    function update() {
      if (!el('site-countdown')) { clearInterval(countdownTimer); return; }
      var diff = end - Date.now();
      if (diff <= 0) { box.innerHTML = '<div style="font-weight:700;color:#5dff9b;">' + met.e('met_celebrate') + ' ' + label + ' — NOW!</div>'; clearInterval(countdownTimer); countdownTimer = null; return; }
      var d = Math.floor(diff/86400000);
      var h = Math.floor((diff%86400000)/3600000);
      var m = Math.floor((diff%3600000)/60000);
      var s = Math.floor((diff%60000)/1000);
      var pad = function(n){ return String(n).padStart(2,'0'); };
      box.innerHTML =
        '<div style="font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">' + label + '</div>' +
        '<div style="font-size:18px;font-weight:700;color:var(--text-primary);font-family:var(--font-mono,monospace);letter-spacing:.06em;">' +
        (d > 0 ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s) + '</div>';
    }
    update();
    countdownTimer = setInterval(update, 1000);
    document.body.appendChild(box);
  }

  // ── Confetti burst ──────────────────────────────────────────────
  window.fireConfetti = function () {
    if (!confettiOn) return;
    var colors = ['#ff5d5d','#ffcf3f','#5dff9b','#5db8ff','#c77dff','#ff8fd0'];
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9500;overflow:hidden;';
    injectStyle('site-style-confetti-drop',
      '@keyframes cf-drop{to{transform:translateY(105vh) rotate(720deg);opacity:0}}');
    for (var i = 0; i < 90; i++) {
      var p = document.createElement('div');
      var s = 6 + Math.random() * 6;
      p.style.cssText =
        'position:absolute;top:-5vh;left:' + (Math.random()*100) + 'vw;' +
        'width:' + s + 'px;height:' + (s*0.5) + 'px;' +
        'background:' + colors[i%colors.length] + ';opacity:.95;' +
        'transform:rotate(' + (Math.random()*360) + 'deg);' +
        'animation:cf-drop ' + (1.6+Math.random()*1.4) + 's cubic-bezier(.2,.6,.4,1) ' + (Math.random()*.3) + 's forwards;';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3600);
  };

  // ── Main apply ──────────────────────────────────────────────────
  window.applySiteEffects = function () {
    fetch('/api/site-config', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        clearAll();
        // Site-wide UI theme (server also injects this on first paint; keep it
        // in sync here so the switch reaches everyone without a manual reload).
        document.documentElement.setAttribute('data-ui', cfg.auroraTheme ? 'aurora' : '');
        confettiOn  = !!cfg.confetti;
        fireworksOn = !!cfg.fireworks;
        renderBanner(cfg.bannerText, cfg.bannerColor);
        if (cfg.snow)          renderSnow();
        if (cfg.matrixRain)    renderMatrix();
        if (cfg.partyMode)     renderParty();
        if (cfg.fireworks)     renderFireworks();
        if (cfg.halloween)     renderHalloween();
        if (cfg.rainbowCursor) renderRainbowCursor();
        if (cfg.spotlightUser) renderSpotlight(cfg.spotlightUser);
        if (cfg.countdownLabel && cfg.countdownTarget)
          renderCountdown(cfg.countdownLabel, cfg.countdownTarget);
      })
      .catch(function () {});
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.applySiteEffects);
  } else { window.applySiteEffects(); }
})();
