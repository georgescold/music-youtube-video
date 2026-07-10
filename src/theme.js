// Bascule de thème clair/sombre, partagée par toutes les pages. Persistée dans localStorage.
(function () {
  function current() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }
  function paint() {
    var dark = current() === 'dark';
    document.querySelectorAll('.theme-toggle').forEach(function (b) {
      b.textContent = dark ? '☀️' : '🌙';
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
