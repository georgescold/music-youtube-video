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
  addBtn.title = 'Créer une nouvelle chaîne';
  addBtn.addEventListener('click', function () {
    var name = prompt('Nom de la nouvelle chaîne ?');
    if (!name || !name.trim()) return;
    addBtn.disabled = true;
    fetch('/api/channels/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) })
      .then(function () { location.reload(); })
      .catch(function () { addBtn.disabled = false; });
  });
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
