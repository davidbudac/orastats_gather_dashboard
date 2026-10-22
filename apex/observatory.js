/* APEX presentation adapter. The report renderer remains shared with SQL*Plus. */
(function () {
  'use strict';
  const meta = D.meta || {};
  const source = document.getElementById('snapshot-source');
  const date = new Date(meta.generated);
  source.textContent = (meta.db || 'Database') + ' / ' + (meta.con || '') +
    ' / ' + (meta.days || 31) + '-day snapshot';
  document.getElementById('snapshot-time').textContent = Number.isNaN(date.getTime())
    ? 'Collection time unavailable'
    : 'Collected ' + date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const age = Date.now() - date.getTime();
  if (age > 864e5) document.getElementById('snapshot-time').textContent += ' (over 24 hours ago)';
  document.getElementById('reload-snapshot').addEventListener('click', () => location.reload());
})();
