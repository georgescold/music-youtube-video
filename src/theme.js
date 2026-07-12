// Bascule de thème clair/sombre, partagée par toutes les pages. Persistée dans localStorage.
(function () {
  // Icônes SVG épurées (Feather), suivent la couleur du texte (currentColor).
  var SUN = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.2v2.3M12 19.5v2.3M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.2 12h2.3M19.5 12h2.3M4.4 19.6l1.6-1.6M18 6l1.6-1.6"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.3A8.2 8.2 0 1 1 10.7 3.5a6.4 6.4 0 0 0 9.8 9.8z"/></svg>';
  function current() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
  function paint() {
    var dark = current() === 'dark';
    document.querySelectorAll('.theme-toggle').forEach(function (b) {
      // On affiche l'icône du thème ACTUEL : soleil en clair, lune en sombre.
      b.innerHTML = dark ? MOON : SUN;
      b.title = dark ? 'Passer en thème clair' : 'Passer en thème sombre';
    });
  }
  function toggle() {
    var next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('abm-theme', next); } catch (e) {}
    paint();
  }
  document.querySelectorAll('.theme-toggle').forEach(function (b) { b.addEventListener('click', toggle); });
  paint();
})();

// Sélecteur de chaîne dans le header (présent sur toutes les pages).
(function initChannelSwitch() {
  var sel = document.getElementById('chan-switch');
  if (!sel) return;
  // Petit bouton "+" collé au sélecteur : créer une nouvelle chaîne au moment de changer de chaîne.
  var addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'chan-new-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Ajouter une chaîne (assistant guidé)';
  addBtn.addEventListener('click', function () { location.href = '/onboarding'; });
  sel.parentNode.insertBefore(addBtn, sel.nextSibling);
  fetch('/api/channels').then(function (r) { return r.json(); }).then(function (d) {
    sel.innerHTML = '';
    (d.channels || []).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      if (c.id === d.activeId) o.selected = true;
      sel.appendChild(o);
    });
    if (!(d.channels || []).length) { var o = document.createElement('option'); o.textContent = 'Aucune chaîne'; sel.appendChild(o); sel.disabled = true; }
    sel.addEventListener('change', function () {
      sel.disabled = true;
      fetch('/api/channels/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sel.value }) })
        .then(function () { location.reload(); })
        .catch(function () { sel.disabled = false; });
    });
  }).catch(function () {});
})();

// Centre de notifications in-app (cloche) — présent sur toutes les pages avec un header.
(function initBell() {
  var sel = document.getElementById('chan-switch'); if (!sel) return;
  var BELL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
  var ICON = { video_published: '✅', video_review: '📝', gen_failed: '❌', gen_started: '⏳', epidemic_auth: '🔑', youtube_auth: '🔴', quota: '🚦', backgrounds_low: '🖼️', daily_report: '📊', viral: '🚀', milestones: '🏆', coach_report: '🧠', weekly_recap: '🗓️', youtube_unverified: '⚠️' };
  var bell = document.createElement('button'); bell.type = 'button'; bell.className = 'notif-bell'; bell.title = 'Notifications';
  bell.innerHTML = BELL + '<span class="notif-badge" style="display:none">0</span>';
  sel.parentNode.insertBefore(bell, sel);
  var panel = document.createElement('div'); panel.className = 'notif-panel'; panel.style.display = 'none'; document.body.appendChild(panel);
  var open = false;
  function when(s) { var t = new Date(s), diff = (Date.now() - t) / 1000; if (diff < 60) return "à l'instant"; if (diff < 3600) return 'il y a ' + Math.floor(diff / 60) + ' min'; if (diff < 86400) return 'il y a ' + Math.floor(diff / 3600) + ' h'; return t.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function setBadge(n) { var b = bell.querySelector('.notif-badge'); if (n > 0) { b.style.display = ''; b.textContent = n > 99 ? '99+' : n; } else b.style.display = 'none'; }
  function render(items) {
    var head = '<div class="notif-head">Notifications</div>';
    if (!items || !items.length) { panel.innerHTML = head + '<div class="notif-empty">Aucune notification.</div>'; return; }
    panel.innerHTML = head + items.map(function (n) {
      var body = n.body ? '<div class="notif-body">' + esc(n.body).slice(0, 240) + '</div>' : '';
      var inner = '<div class="notif-ic">' + (ICON[n.type] || '•') + '</div><div class="notif-txt"><div class="notif-title">' + esc(n.title || '') + '</div>' + body + '<div class="notif-when">' + when(n.created_at) + '</div></div>';
      return n.url ? '<a class="notif-item' + (n.read ? '' : ' unread') + '" href="' + esc(n.url) + '" target="_blank">' + inner + '</a>' : '<div class="notif-item' + (n.read ? '' : ' unread') + '">' + inner + '</div>';
    }).join('');
  }
  function load() { fetch('/api/notifications').then(function (r) { return r.json(); }).then(function (d) { setBadge(d.unread || 0); if (open) render(d.items); }).catch(function () {}); }
  bell.addEventListener('click', function (e) {
    e.stopPropagation(); open = !open;
    if (open) { panel.style.display = ''; fetch('/api/notifications').then(function (r) { return r.json(); }).then(function (d) { render(d.items); fetch('/api/notifications/read', { method: 'POST' }); setBadge(0); }); }
    else panel.style.display = 'none';
  });
  document.addEventListener('click', function () { if (open) { open = false; panel.style.display = 'none'; } });
  panel.addEventListener('click', function (e) { e.stopPropagation(); });
  load(); setInterval(load, 30000);
})();
