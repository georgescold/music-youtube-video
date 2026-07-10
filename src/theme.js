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
