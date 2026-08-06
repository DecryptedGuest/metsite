// client/public/js/division-brand.js
// Applies the division branding that server/lib/divisions.js → brandHead()
// injected into <head> as window.MET_BRAND.
//
// The colours are already live by the time this runs (they come from an inline
// <style>, so there is never a flash of the wrong division). This file only
// does the parts CSS can't: pointing <img> marks at the division's logo,
// dropping the crest watermark into the background canvas, and filling in any
// [data-brand] placeholders a page declares.
//
// Purely cosmetic — every step is guarded so a missing element or a page served
// without branding is a no-op, never an error.
(function () {
  var brand = window.MET_BRAND;
  if (!brand || !brand.slug) return;

  var isDivision = brand.slug !== 'met';

  function apply() {
    // Mark the document so division-theme.css engages. Normally the server has
    // already set this; doing it here too keeps the styling correct if a page
    // ever loads the script without the attribute.
    if (isDivision && !document.documentElement.getAttribute('data-division')) {
      document.documentElement.setAttribute('data-division', brand.slug);
    }

    // Division logo everywhere a dashboard mark appears.
    if (brand.logo) {
      var marks = document.querySelectorAll('.met-topbar-logo, .brand-logo img, [data-brand="logo"]');
      for (var i = 0; i < marks.length; i++) {
        marks[i].src = brand.logo;
        if (!marks[i].alt) marks[i].alt = brand.name;
      }
    }

    // Text placeholders: <span data-brand="short"></span> etc.
    var fields = { name: brand.name, short: brand.short, full: brand.fullName, tagline: brand.tagline };
    Object.keys(fields).forEach(function (key) {
      var nodes = document.querySelectorAll('[data-brand="' + key + '"]');
      for (var i = 0; i < nodes.length; i++) nodes[i].textContent = fields[key] || '';
    });

    // The crest watermark lives inside the fixed background canvas, so it never
    // scrolls, never takes a click and never affects layout.
    var canvas = document.querySelector('.bg-canvas');
    if (isDivision && canvas && !canvas.querySelector('.division-watermark')) {
      var mark = document.createElement('div');
      mark.className = 'division-watermark';
      mark.setAttribute('aria-hidden', 'true');
      canvas.appendChild(mark);
    }

    // Shared views (the dashboard "no access" page, for instance) carry no
    // division in their title — give them one when they're served under a
    // division's path.
    if (isDivision && document.title && document.title.indexOf(brand.name) === -1) {
      document.title = brand.name + ' · ' + document.title;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  } else {
    apply();
  }
})();
