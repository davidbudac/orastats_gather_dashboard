/*
 * Statistics gathering dashboard -- page script.
 *
 * Source of sql/_app.sql (tools/build_assets.sh).  Reads the D.* datasets
 * that the SQL sections printed above it and renders four views:
 * overview, runs, one run in detail, and what still needs statistics.
 * No libraries, no network: the report must work from file:// offline.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- data
  const missing = [];
  function rows(name) {
    if (Array.isArray(D[name])) return D[name];
    missing.push(name);
    return [];
  }
  const META = D.meta || {};
  if (!D.meta) missing.push('meta');
  const ts = (s) => (s ? Date.parse(s) : null);
  const GEN = ts(META.generated) || Date.now();
  const DAYS = META.days || 31;
  const T0 = GEN - DAYS * 864e5;
  const DAY = 864e5;

  // ------------------------------------------------------------ formatting
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => (n == null ? '' : Number(n).toLocaleString('en-US'));
  function fmtDur(s) {
    if (s == null || isNaN(s)) return '';
    if (s < 1) return s < 0.01 ? '<0.01 s' : s.toFixed(2) + ' s';
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + ' s';
    const m = Math.floor(s / 60), sec = Math.round(s % 60);
    if (s < 3600) return m + 'm ' + String(sec).padStart(2, '0') + 's';
    const h = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
    if (s < 86400) return h + 'h ' + String(mm).padStart(2, '0') + 'm';
    return Math.floor(s / 86400) + 'd ' + String(Math.floor((s % 86400) / 3600)).padStart(2, '0') + 'h';
  }
  function fmtAgo(ms) {
    const s = (GEN - ms) / 1000;
    return s < 0 ? 'in the future' : fmtDur(s) + ' before the report';
  }
  function compact(n) {
    if (n == null) return '';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'G';
    if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(Math.round(n));
  }
  function titleCase(s) { return String(s).toLowerCase().replace(/^\w/, (c) => c.toUpperCase()); }
  function plural(n, one, many) { return fmtN(n) + ' ' + (n === 1 ? one : (many || one + 's')); }

  // Time zone: DB host (the offset of SYSTIMESTAMP when the report ran), UTC or browser
  const store = (() => { try { return window.localStorage; } catch (e) { return null; } })();
  let tzMode = (store && store.getItem('gd.tz')) || 'db';
  function dbOffsetMin() {
    const m = /^([+-])(\d\d):(\d\d)$/.exec(META.dbtz || '+00:00');
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  }
  function tzOff(ms) {
    if (tzMode === 'utc') return 0;
    if (tzMode === 'local') return -new Date(ms).getTimezoneOffset();
    return dbOffsetMin();
  }
  function offLabel(min) {
    const a = Math.abs(min);
    return 'UTC' + (min < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
  }
  function fmtT(ms, sec) {
    if (ms == null) return '';
    const iso = new Date(ms + tzOff(ms) * 60000).toISOString();
    return iso.slice(0, 10) + ' ' + iso.slice(11, sec ? 19 : 16);
  }
  function fmtClock(ms, sec) {
    if (ms == null) return '';
    return new Date(ms + tzOff(ms) * 60000).toISOString().slice(11, sec ? 19 : 16);
  }
  function dayStart(ms) { const off = tzOff(ms) * 60000; return Math.floor((ms + off) / DAY) * DAY - off; }


  const CONS = new Map(rows('cons').map((r) => [r[0], r[1]]));
  const conName = (id) => CONS.get(id) || (id === 0 ? (META.db || 'DB') : 'CON_ID ' + id);
  const conKey = (con, s) => con + '|' + s;

  function unxml(s) {
    return String(s)
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  function parseParams(notes) {
    const p = {};
    const re = /<param name="([^"]*)" val="([^"]*)"\/>/g;
    let m;
    while ((m = re.exec(notes || ''))) p[m[1]] = unxml(m[2]);
    return p;
  }
  function parseError(notes) {
    const m = /<error>([\s\S]*?)(<\/error>|$)/.exec(notes || '');
    return m ? unxml(m[1]).trim() : null;
  }
  function splitTarget(t) {
    const parts = [];
    const re = /"((?:[^"]|"")*)"/g;
    let m;
    while ((m = re.exec(t || ''))) parts.push(m[1].replace(/""/g, '"'));
    if (!parts.length && t) return String(t).split('.');
    return parts;
  }
  const showTarget = (t) => splitTarget(t).join('.');

  // D.ops
  const OPS = [];
  const OPMAP = new Map();
  rows('ops').forEach((r) => {
    const o = {
      con: r[0], id: r[1], op: r[2], target: r[3], start: ts(r[4]), end: ts(r[5]),
      status: r[6] || '', job: r[7], sid: r[8], notes: r[9] || '',
      agg: [], tasks: [], key: r[0] + '/' + r[1]
    };
    o.params = parseParams(o.notes);
    o.error = parseError(o.notes);
    o.kind = o.op === 'gather_database_stats (auto)' ? 'auto'
      : (/^gather_/.test(o.op) && !/reporting mode/.test(o.op)) ? 'gather' : 'other';
    o.highFreq = o.kind === 'auto' && /^ORA\$_ATSK_AUTOSTS/.test(o.job || '');
    o.abandoned = !o.end && /IN PROGRESS|PENDING/.test(o.status) && GEN - o.start > DAY;
    o.endEff = o.end || (o.status === 'IN PROGRESS' && !o.abandoned ? GEN : o.start);
    o.secs = Math.max(0, (o.endEff - o.start) / 1000);
    OPS.push(o);
    OPMAP.set(o.key, o);
  });

  // D.tagg: exact per-operation totals
  rows('tagg').forEach((r) => {
    const o = OPMAP.get(r[0] + '/' + r[1]);
    if (o) o.agg.push({ type: r[2], status: r[3], n: r[4], size: r[5] || 0, secs: r[6] || 0, hist: r[7] || 0 });
  });

  // D.tasks: per-object rows (possibly truncated per operation)
  const TASKS = [];
  rows('tasks').forEach((r) => {
    const o = OPMAP.get(r[0] + '/' + r[1]);
    const notes = r[13] || '';
    const hm = /<histograms>([^<]*)<\/histograms>/.exec(notes);
    const xm = /<xstats>([\s\S]*?)<\/xstats>/.exec(notes);
    const t = {
      con: r[0], opid: r[1], op: o, target: r[2], objn: r[3], type: r[4] || '', size: r[5],
      start: ts(r[6]), end: ts(r[7]), status: r[8] || '', cost: r[9], coeff: r[10],
      actions: r[11], prio: r[12], notes: notes,
      hist: hm ? hm[1].split(';').filter(Boolean) : [],
      xstats: xm ? unxml(xm[1].replace(/<[^>]+>/g, ' ')).trim() : '',
      error: parseError(notes)
    };
    t.parts = splitTarget(t.target);
    t.name = t.parts.join('.');
    t.secs = t.start && t.end ? (t.end - t.start) / 1000 : null;
    if (o) o.tasks.push(t);
    TASKS.push(t);
  });

  // D.ajh / D.sjr: the scheduler's view of each job
  const AJH = new Map();
  rows('ajh').forEach((r) => {
    AJH.set(conKey(r[0], r[4]), {
      con: r[0], window: r[1], winStart: ts(r[2]), winSecs: r[3], job: r[4], status: r[5],
      start: ts(r[6]), secs: r[7], error: r[8], info: r[9]
    });
  });
  const SJR = new Map();
  rows('sjr').forEach((r) => {
    const j = {
      con: r[0], logId: r[1], owner: r[2], job: r[3], status: r[4], error: r[5],
      start: ts(r[6]), secs: r[7], cpu: r[8], session: r[9], info: r[10]
    };
    const k = conKey(j.con, j.job);
    if (!SJR.has(k)) SJR.set(k, []);
    SJR.get(k).push(j);
  });

  // Windows: history plus the ones open right now
  const WCFG = rows('wcfg').map((r) => ({
    con: r[0], name: r[1], enabled: r[2], active: r[3], repeat: r[4], secs: r[5],
    next: ts(r[6]), last: ts(r[7]), maint: r[8] === 'Y'
  }));
  const MAINT = new Set(WCFG.filter((w) => w.maint).map((w) => conKey(w.con, w.name)));
  const WINS = rows('win').map((r) => ({
    con: r[0], name: r[1], start: ts(r[3]) || ts(r[2]), planned: r[4], secs: r[5]
  })).map((w) => Object.assign(w, { end: w.start + (w.secs || w.planned || 0) * 1000 }));
  WCFG.forEach((w) => {
    if (w.active === 'TRUE' && w.last) {
      WINS.push({ con: w.con, name: w.name, start: w.last, planned: w.secs, secs: null, end: Math.min(w.last + w.secs * 1000, GEN), open: true });
    }
  });
  WINS.forEach((w) => { w.maint = MAINT.has(conKey(w.con, w.name)) || /_WINDOW$/.test(w.name); });

  const ATC = rows('atc').map((r) => ({ con: r[0], status: r[1], group: r[2], mean: r[3], max7: r[4], attrs: r[5] }));
  const PREFS = new Map(rows('prefs').map((r) => [r[0], r[1]]));
  const TPREFS = rows('tprefs').map((r) => ({ con: r[0], owner: r[1], table: r[2], pref: r[3], value: r[4], om: r[5] === 'Y' }));
  const TPREFMAP = new Map();
  TPREFS.forEach((p) => {
    const k = conKey(p.con, p.owner + '.' + p.table);
    if (!TPREFMAP.has(k)) TPREFMAP.set(k, []);
    TPREFMAP.get(k).push(p);
  });

  // ------------------------------------------------- derived: per run
  const SEV_RANK = { good: 0, info: 0, warn: 1, serious: 2, crit: 3 };
  const SEV_ICON = { good: '\u2713', info: 'i', warn: '!', serious: '!', crit: '\u2715' };

  OPS.forEach((o) => {
    const s = { n: 0, done: 0, failed: 0, notDone: 0, secs: 0, size: 0, hist: 0, byType: {} };
    o.agg.forEach((a) => {
      s.n += a.n; s.secs += a.secs; s.size += a.size; s.hist += a.hist;
      if (a.status === 'COMPLETED') s.done += a.n;
      else if (a.status === 'FAILED') s.failed += a.n;
      else s.notDone += a.n;
      const bt = s.byType[a.type] || (s.byType[a.type] = { n: 0, done: 0, failed: 0, other: 0, secs: 0, size: 0, hist: 0 });
      bt.n += a.n; bt.secs += a.secs; bt.size += a.size; bt.hist += a.hist;
      if (a.status === 'COMPLETED') bt.done += a.n; else if (a.status === 'FAILED') bt.failed += a.n; else bt.other += a.n;
    });
    o.stats = s;
    o.truncated = o.tasks.length < s.n;
    o.ajh = o.job ? AJH.get(conKey(o.con, o.job)) : null;
    const runs = o.job ? SJR.get(conKey(o.con, o.job)) || [] : [];
    o.sjr = runs.find((j) => j.start <= o.start + 5000 && j.start + (j.secs + 5) * 1000 >= o.start) || null;
    if (o.ajh) {
      o.window = { name: o.ajh.window, start: o.ajh.winStart, end: o.ajh.winStart + o.ajh.winSecs * 1000, secs: o.ajh.winSecs };
    } else {
      const w = WINS.find((w) => w.con === o.con && w.start <= o.start && o.start < w.end);
      o.window = w ? { name: w.name, start: w.start, end: w.end, secs: (w.end - w.start) / 1000, open: w.open } : null;
    }
  });

  // Recurring failures: the same object failing with the same error across runs
  const FAILS = new Map();
  function addFail(con, target, error, o, when) {
    const err = (error || 'no error text recorded').replace(/\s+/g, ' ').slice(0, 300);
    const k = con + '|' + target + '|' + err;
    let f = FAILS.get(k);
    if (!f) FAILS.set(k, f = { con: con, target: target, error: err, runs: new Set(), first: when, last: when, lastOp: o });
    f.runs.add(o.key);
    if (when < f.first) f.first = when;
    if (when >= f.last) { f.last = when; f.lastOp = o; }
  }
  TASKS.forEach((t) => { if (t.status === 'FAILED' && t.op) addFail(t.con, showTarget(t.target), t.error || t.op.error, t.op, t.start || t.op.start); });
  OPS.forEach((o) => {
    if (o.kind === 'gather' && o.status === 'FAILED' && !o.stats.failed) addFail(o.con, showTarget(o.target), o.error, o, o.start);
  });
  const FAILLIST = [...FAILS.values()].sort((a, b) => b.runs.size - a.runs.size || b.last - a.last);
  // Failures Oracle documents as expected; they do not make a run incomplete
  const BENIGN = [
    { re: /X\$LOGMNR_CONTENTS.*log ?miner or data guard must be started/i, why: 'X$LOGMNR_CONTENTS can only be analyzed while LogMiner runs; the automatic job tries it every time. Harmless.' }
  ];
  const benign = (err) => BENIGN.find((b) => b.re.test(err || '')) || null;
  FAILLIST.forEach((f) => { f.benign = benign(f.target + ' ' + f.error); });
  const chronic = new Set(FAILLIST.filter((f) => f.runs.size >= 3).map((f) => f.con + '|' + f.target));

  function verdict(o) {
    const s = o.stats;
    if (o.status === 'FAILED') return { sev: 'crit', label: 'Failed', why: o.error || 'The operation failed.' };
    if (o.status === 'TIMED OUT') return { sev: 'crit', label: 'Timed out', why: 'Stopped before finishing (end of the maintenance window or AUTO_TASK_MAX_RUN_TIME).' + (s.notDone ? ' ' + fmtN(s.notDone) + ' objects not processed.' : '') };
    if (o.abandoned) return { sev: 'crit', label: 'Never finished', why: 'Still IN PROGRESS a day later: the session ended (killed, instance restart) before the operation could record its end.' };
    if (o.status === 'IN PROGRESS') return { sev: 'info', label: 'Running', why: 'In progress when the report was generated.' };
    if (o.ajh && /STOPPED|FAILED|BROKEN/.test(o.ajh.status)) return { sev: 'crit', label: 'Job ' + o.ajh.status.toLowerCase(), why: o.ajh.info || 'The scheduler reports the job as ' + o.ajh.status + '.' };
    if (s.notDone) return { sev: 'crit', label: fmtN(s.notDone) + ' not processed', why: fmtN(s.notDone) + ' objects were queued but never completed (status pending, skipped or timed out).' };
    const fails = o.tasks.filter((t) => t.status === 'FAILED');
    const expected = fails.filter((t) => benign(t.name + ' ' + t.error)).length;
    if (s.failed && expected === s.failed) {
      return { sev: 'good', label: 'Complete', why: 'Every object it picked was gathered, except ' + plural(expected, 'expected failure') + ' (' + fails.map((t) => t.name).join(', ') + ').', expected: expected };
    }
    if (s.failed) {
      const allChronic = fails.length === s.failed && fails.every((t) => chronic.has(t.con + '|' + showTarget(t.target)));
      return { sev: 'warn', label: fmtN(s.failed) + ' failed', why: fmtN(s.failed) + ' of ' + fmtN(s.n) + ' objects failed' + (allChronic ? ' (the same objects fail in every run).' : '.') };
    }
    if (o.status && o.status !== 'COMPLETED') return { sev: 'warn', label: titleCase(o.status), why: 'Status ' + o.status + '.' };
    return { sev: 'good', label: 'Complete', why: o.kind === 'other' ? 'Completed.' : 'Every object it picked was gathered.' };
  }
  OPS.forEach((o) => { o.v = verdict(o); });

  const AUTO = OPS.filter((o) => o.kind === 'auto');
  const GATHERS = OPS.filter((o) => o.kind === 'gather');
  const lastAuto = new Map();
  AUTO.forEach((o) => { const l = lastAuto.get(o.con); if (!l || o.start > l.start) lastAuto.set(o.con, o); });

  // ------------------------------------------- derived: still needing stats
  const lastAttempt = new Map();
  TASKS.forEach((t) => {
    if (!t.start) return;
    const k = conKey(t.con, t.name);
    const l = lastAttempt.get(k);
    if (!l || t.start > l.start) lastAttempt.set(k, t);
  });
  OPS.forEach((o) => {
    if (o.kind !== 'gather' || !/table_stats$/.test(o.op)) return;
    const k = conKey(o.con, showTarget(o.target) + (o.params.partname ? '.' + o.params.partname : ''));
    const l = lastAttempt.get(k);
    if (!l || o.start > l.start) lastAttempt.set(k, { start: o.start, status: o.status, error: o.error, op: o });
  });

  const CATS = {
    failed: { sev: 'crit', title: 'Last gather failed', text: 'The most recent attempt to gather this object in the period failed. It stays stale until the error is fixed.' },
    missed: { sev: 'crit', title: 'Missed by the last automatic run', text: 'Its changes were recorded before the last automatic run started, yet that run did not gather it (run stopped early, object outside AUTOSTATS_TARGET, or a table preference).' },
    locked: { sev: 'warn', title: 'Stale or missing, but locked', text: 'Statistics are locked: the automatic job and every gather without FORCE skip it. Intentional for some tables; check it is.' },
    missing: { sev: 'warn', title: 'No statistics at all', text: 'Never gathered. The optimizer falls back to dynamic sampling. The automatic job gathers these first, so check why it has not.' },
    fresh: { sev: 'info', title: 'Stale since the last automatic run', text: 'Changed after the last automatic run started. The next run is expected to pick it up; nothing missed yet.' },
    stale: { sev: 'info', title: 'Stale, time of change unknown', text: 'Marked stale but no DML monitoring row tells when it changed (e.g. no automatic run in the period to compare with).' },
    missingSub: { sev: 'info', title: 'Subpartitions without statistics', text: 'Usually by design: GRANULARITY AUTO does not gather subpartition statistics for every subpartitioning type.' },
    fixed: { sev: 'info', title: 'Fixed objects (X$) without statistics', text: 'Gathered only by GATHER_FIXED_OBJECTS_STATS or GATHER_DICTIONARY_STATS; some X$ tables can never be analyzed.' }
  };
  const CAT_ORDER = ['failed', 'missed', 'locked', 'missing', 'fresh', 'stale', 'missingSub', 'fixed'];

  const BL = rows('bl').map((r) => {
    const b = {
      con: r[0], owner: r[1], table: r[2], part: r[3], sub: r[4], type: r[5] || '',
      rows: r[6], blocks: r[7], analyzed: ts(r[8]), stale: r[9] === 'YES', locked: r[10],
      ins: r[11], upd: r[12], del: r[13], trunc: r[14] === 'YES', dmlTs: ts(r[15]), om: r[16] === 'Y'
    };
    b.name = [b.owner, b.table, b.part, b.sub].filter(Boolean).join('.');
    b.missing = !b.analyzed;
    const la = lastAuto.get(b.con);
    const att = lastAttempt.get(conKey(b.con, b.name)) ||
      (b.sub ? lastAttempt.get(conKey(b.con, [b.owner, b.table, b.sub].join('.'))) : null);
    b.attempt = att || null;
    b.prefs = TPREFMAP.get(conKey(b.con, b.owner + '.' + b.table)) || [];
    if (att && att.status === 'FAILED') b.cat = 'failed';
    else if (b.locked) b.cat = 'locked';
    else if (b.type === 'FIXED TABLE') b.cat = 'fixed';
    else if (b.missing && b.type === 'SUBPARTITION') b.cat = 'missingSub';
    else if (b.missing) b.cat = 'missing';
    else if (b.dmlTs && la && b.dmlTs < la.start) b.cat = 'missed';
    else if (b.dmlTs && la) b.cat = 'fresh';
    else b.cat = 'stale';
    b.dml = (b.ins || 0) + (b.upd || 0) + (b.del || 0);
    b.pct = b.rows ? (100 * b.dml) / b.rows : null;
    return b;
  });
  const BLAGG = rows('blagg').map((r) => ({ con: r[0], om: r[1] === 'Y', type: r[2], stale: r[3] === 'Y', missing: r[4] === 'Y', locked: r[5] === 'Y', n: r[6] }));
  const blTruncated = BL.length >= (META.maxBacklog || 5000);

  function sevBadge(sev, label, tip) {
    return '<span class="sev ' + sev + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : '') + '><i>' + SEV_ICON[sev] + '</i>' + esc(label) + '</span>';
  }
  const kindLabel = { auto: 'Automatic job', gather: 'Manual / custom gather', other: 'Other DBMS_STATS call' };
  function opLabel(o) {
    if (o.kind === 'auto') return o.highFreq ? 'Automatic job (high-frequency)' : 'Automatic job';
    return o.op;
  }
  function opTarget(o) {
    if (o.kind === 'auto') return 'database (AUTO)';
    const t = showTarget(o.target);
    return t + (o.params.partname ? '.' + o.params.partname : '');
  }
  function opTip(o) {
    return '<b>' + esc(opLabel(o)) + '</b> ' + (o.kind === 'auto' ? '' : esc(opTarget(o))) +
      '<br>' + esc(conName(o.con)) + ' &middot; ' + esc(fmtT(o.start, true)) + ' &middot; ' + esc(fmtDur(o.secs)) +
      '<br>' + (o.stats.n ? plural(o.stats.n, 'object') + ' &middot; ' : '') + esc(o.v.label) +
      (o.v.sev !== 'good' ? '<br><span class="muted">' + esc(o.v.why) + '</span>' : '');
  }

  // ---------------------------------------------------------------- tables
  // spec: { cols: [{ key, label, num, cls, html(r), val(r), tip }], rows, sort: [key, dir], limit, href(r), empty }
  function renderTable(host, spec) {
    const st = host._t || (host._t = { sort: spec.sort || null, limit: spec.limit || 300 });
    const cols = spec.cols;
    let data = spec.rows.slice();
    if (st.sort) {
      const c = cols.find((c) => c.key === st.sort[0]);
      if (c) {
        const val = c.val || ((r) => r[c.key]);
        const dir = st.sort[1];
        data.sort((a, b) => {
          const x = val(a), y = val(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (x < y ? -1 : x > y ? 1 : 0) * dir;
        });
      }
    }
    const shown = data.slice(0, st.limit);
    let h = '<div class="tablewrap"><table><thead><tr>';
    cols.forEach((c) => {
      const sorted = st.sort && st.sort[0] === c.key;
      h += '<th data-sort="' + c.key + '" class="' + (c.num ? 'num ' : '') + (sorted ? 'sorted' + (st.sort[1] > 0 ? ' asc' : '') : '') + '"' +
        (c.tip ? ' data-tip="' + esc(c.tip) + '"' : '') + '>' + esc(c.label) + '</th>';
    });
    h += '</tr></thead><tbody>';
    if (!shown.length) h += '<tr><td colspan="' + cols.length + '" class="note">' + esc(spec.empty || 'Nothing to show.') + '</td></tr>';
    shown.forEach((r) => {
      const href = spec.href ? spec.href(r) : null;
      h += '<tr' + (href ? ' class="click" data-href="' + esc(href) + '"' : '') + '>';
      cols.forEach((c) => {
        const v = c.html ? c.html(r) : esc(r[c.key]);
        h += '<td class="' + (c.num ? 'num ' : '') + (c.cls || '') + '">' + (v == null ? '' : v) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    if (data.length > shown.length) {
      h += '<div class="more-rows note">Showing ' + fmtN(shown.length) + ' of ' + fmtN(data.length) + ' rows. <button type="button">Show 500 more</button></div>';
    } else if (data.length > 20) {
      h += '<div class="more-rows note">' + fmtN(data.length) + ' rows.</div>';
    }
    host.innerHTML = h;
    host.querySelectorAll('th[data-sort]').forEach((th) => {
      th.onclick = () => {
        const k = th.getAttribute('data-sort');
        const c = cols.find((c) => c.key === k);
        st.sort = st.sort && st.sort[0] === k ? [k, -st.sort[1]] : [k, c && (c.num || c.desc) ? -1 : 1];
        renderTable(host, spec);
      };
    });
    const more = host.querySelector('.more-rows button');
    if (more) more.onclick = () => { st.limit += 500; renderTable(host, spec); };
  }

  // ---------------------------------------------------------------- charts
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function timeTicks(a, b, width, minPx) {
    const span = b - a;
    const steps = [5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 28 * DAY];
    const step = steps.find((s) => (s / span) * width >= minPx) || 28 * DAY;
    const out = [];
    let t;
    if (step >= DAY) {
      t = dayStart(a);
      while (t < a) t += DAY;
      for (; t <= b; t += step) out.push(t);
    } else {
      const off = tzOff(a) * 60000;
      t = Math.ceil((a + off) / step) * step - off;
      for (; t <= b; t += step) out.push(t);
    }
    return { ticks: out, step: step };
  }
  function tickLabel(t, step) {
    if (step >= DAY) return fmtT(t).slice(5, 10);
    const c = fmtClock(t);
    return c === '00:00' ? fmtT(t).slice(5, 10) : c;
  }

  // Overview timeline: one lane pair per container (automatic job, other gathers) over the whole period
  function timelineSVG(width, from, to, cons) {
    const L = 150, R = 12, laneH = 18, gap = 12, top = 4;
    const W = Math.max(200, width - L - R);
    const x = (t) => L + ((t - from) / (to - from)) * W;
    const H = top + cons.length * (2 * laneH + gap) + 22;
    const tt = timeTicks(from, to, W, 70);
    let s = '<svg width="' + width + '" height="' + H + '" role="img" aria-label="Timeline of statistics operations">';
    tt.ticks.forEach((t) => { s += '<line class="grid" x1="' + x(t) + '" x2="' + x(t) + '" y1="' + top + '" y2="' + (H - 20) + '"/>'; });
    cons.forEach((con, i) => {
      const y0 = top + i * (2 * laneH + gap);
      s += '<text class="lane-label" x="0" y="' + (y0 + 13) + '">' + esc(conName(con)) + '</text>';
      s += '<text x="0" y="' + (y0 + 13) + '" dx="' + (L - 8) + '" text-anchor="end">auto job</text>';
      s += '<text x="0" y="' + (y0 + laneH + 13) + '" dx="' + (L - 8) + '" text-anchor="end">other gathers</text>';
      WINS.filter((w) => w.con === con && w.maint && w.end > from && w.start < to).forEach((w) => {
        const a = Math.max(x(w.start), L), b = Math.min(x(w.end), L + W);
        s += '<rect class="win" x="' + a + '" y="' + y0 + '" width="' + Math.max(1, b - a) + '" height="' + laneH + '" data-tip="' +
          esc('<b>' + esc(w.name) + '</b>' + (w.open ? ' (open now)' : '') + '<br>' + esc(fmtT(w.start)) + ' \u2192 ' + esc(fmtT(w.end)) + ' &middot; ' + esc(fmtDur((w.end - w.start) / 1000))) + '"/>';
      });
      s += '<line class="axis" x1="' + L + '" x2="' + (L + W) + '" y1="' + (y0 + 2 * laneH + 0.5) + '" y2="' + (y0 + 2 * laneH + 0.5) + '"/>';
      const ops = OPS.filter((o) => o.con === con && o.kind !== 'other' && o.endEff >= from && o.start <= to)
        .sort((a, b) => SEV_RANK[a.v.sev] - SEV_RANK[b.v.sev]);
      ops.forEach((o) => {
        const y = y0 + (o.kind === 'auto' ? 0 : laneH) + 3;
        const a = x(Math.max(o.start, from));
        const w = Math.max(4, x(Math.min(o.endEff, to)) - a);
        s += '<rect class="mark f-' + o.v.sev + '" x="' + (a - (w === 4 ? 2 : 0)) + '" y="' + y + '" width="' + w + '" height="' + (laneH - 6) + '" rx="2" data-href="#run/' + o.key + '" data-tip="' + esc(opTip(o)) + '"/>';
      });
    });
    tt.ticks.forEach((t) => { s += '<text x="' + x(t) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(tickLabel(t, tt.step)) + '</text>'; });
    return s + '</svg>';
  }

  // Columns over the same time axis: one value per automatic run, colored by container
  function runColumnsSVG(width, from, to, runs, val, fmt, label) {
    const L = 150, R = 12, H = 120, top = 8, bottom = 22;
    const W = Math.max(200, width - L - R);
    const x = (t) => L + ((t - from) / (to - from)) * W;
    const max = niceMax(Math.max(0, ...runs.map(val)));
    const y = (v) => top + (H - top - bottom) * (1 - v / max);
    const cons = [...new Set(runs.map((o) => o.con))].sort((a, b) => a - b);
    const tt = timeTicks(from, to, W, 70);
    let s = '<svg width="' + width + '" height="' + H + '" role="img" aria-label="' + esc(label) + '">';
    [0, max / 2, max].forEach((v) => {
      s += '<line class="grid" x1="' + L + '" x2="' + (L + W) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      s += '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(v ? fmt(v) : '0') + '</text>';
    });
    runs.forEach((o) => {
      const v = val(o);
      const cx = x(o.start), yy = y(v), h = Math.max(1, y(0) - yy);
      const ci = cons.indexOf(o.con) % 3 + 1;
      s += '<rect class="hit" x="' + (cx - 4) + '" y="' + top + '" width="8" height="' + (H - top - bottom) + '" data-href="#run/' + o.key + '" data-tip="' + esc(opTip(o)) + '"/>';
      s += '<path class="mark f-s' + ci + '" pointer-events="none" d="M' + (cx - 2) + ',' + y(0) + 'V' + (yy + 2) + 'q0,-2 2,-2q2,0 2,2V' + y(0) + 'Z" data-h="' + h + '"/>';
    });
    s += '<line class="axis" x1="' + L + '" x2="' + (L + W) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
    tt.ticks.forEach((t) => { s += '<text x="' + x(t) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(tickLabel(t, tt.step)) + '</text>'; });
    return s + '</svg>';
  }

  // One run's objects over time.  Up to 40 objects: one labelled row each.
  // More: packed lanes, each object in the first lane free at its start, so
  // serial work shares a lane and concurrent work stacks.
  const typeClass = (t) => (t.status === 'FAILED' ? 'f-crit' : t.status !== 'COMPLETED' ? 'f-warn'
    : /INDEX/.test(t.type) ? 'f-s3' : /PARTITION/.test(t.type) ? 'f-s2' : 'f-s1');
  function ganttSVG(width, o, tasks) {
    const timed = tasks.filter((t) => t.start).sort((a, b) => a.start - b.start || (b.secs || 0) - (a.secs || 0));
    const rowsMode = timed.length <= 40;
    const MAXL = 24;
    const lanes = [];
    const lane = new Map();
    if (!rowsMode) {
      timed.forEach((t) => {
        const end = t.end || t.start;
        let i = lanes.findIndex((e) => e <= t.start);
        if (i < 0) {
          if (lanes.length < MAXL) i = lanes.push(end) - 1;
          else i = lanes.indexOf(Math.min(...lanes));
        }
        lanes[i] = Math.max(lanes[i] || 0, end);
        lane.set(t, i);
      });
    }
    const n = rowsMode ? timed.length : lanes.length;
    const rowH = rowsMode ? 18 : 16;
    const L = rowsMode ? 280 : 60, R = 12, top = 4, bottom = 22;
    const W = Math.max(200, width - L - R);
    const from = Math.min(o.start, ...timed.map((t) => t.start));
    const to = Math.max(o.endEff, ...timed.map((t) => t.end || t.start), from + 1000);
    const x = (t) => L + ((t - from) / (to - from)) * W;
    const H = top + n * rowH + bottom;
    const tt = timeTicks(from, to, W, 80);
    let s = '<svg width="' + width + '" height="' + H + '" role="img" aria-label="Objects of this run over time">';
    tt.ticks.forEach((t) => { s += '<line class="grid" x1="' + x(t) + '" x2="' + x(t) + '" y1="' + top + '" y2="' + (H - bottom) + '"/>'; });
    if (!rowsMode) {
      for (let i = 0; i < n; i++) s += '<text x="' + (L - 8) + '" y="' + (top + i * rowH + 12) + '" text-anchor="end">' + (i + 1) + '</text>';
    }
    if (o.window && o.window.end > from && o.window.end <= to) {
      s += '<line x1="' + x(o.window.end) + '" x2="' + x(o.window.end) + '" y1="' + top + '" y2="' + (H - bottom) + '" stroke="var(--crit)" stroke-width="1.5"/>';
    }
    timed.forEach((t, i) => {
      const y = top + (rowsMode ? i : lane.get(t)) * rowH;
      const a = x(t.start);
      const w = Math.max(1, x(t.end || t.start) - a - (rowsMode ? 0 : 1));
      const tip = '<b>' + esc(t.name) + '</b><br>' + esc(t.type.toLowerCase()) + ' &middot; ' + esc(t.status.toLowerCase()) +
        '<br>' + esc(fmtClock(t.start, true)) + ' &middot; ' + esc(fmtDur(t.secs)) + (t.size != null ? ' &middot; size ' + fmtN(t.size) : '') +
        (t.hist.length ? '<br>Histograms: ' + esc(t.hist.join(', ')) : '') + (t.error ? '<br><span class="muted">' + esc(t.error) + '</span>' : '');
      if (rowsMode) {
        s += '<text x="0" y="' + (y + 13) + '">' + esc(t.name.length > 42 ? t.name.slice(0, 41) + '\u2026' : t.name) + '</text>';
        s += '<rect class="hit" x="0" y="' + y + '" width="' + (L + W) + '" height="' + rowH + '" data-tip="' + esc(tip) + '"/>';
        s += '<rect class="mark ' + typeClass(t) + '" pointer-events="none" x="' + a + '" y="' + (y + 3) + '" width="' + Math.max(2, w) + '" height="' + (rowH - 6) + '" rx="2"/>';
      } else {
        s += '<rect class="mark ' + typeClass(t) + '" x="' + a + '" y="' + (y + 2) + '" width="' + Math.max(1.5, w) + '" height="' + (rowH - 4) + '" data-tip="' + esc(tip) + '"/>';
      }
    });
    tt.ticks.forEach((t) => { s += '<text x="' + x(t) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(fmtClock(t, tt.step < 5 * 60e3)) + '</text>'; });
    s += '</svg>';
    return { svg: s, lanes: rowsMode ? 0 : n, capped: lanes.length >= MAXL };
  }

  // ------------------------------------------------------------ chrome
  const app = document.getElementById('app');
  function chrome() {
    const scope = META.cdb === 'YES' ? (META.conId === 1 ? 'all containers (run in CDB$ROOT)' : 'PDB ' + META.con) : 'non-CDB';
    const dbo = dbOffsetMin();
    app.innerHTML =
      '<div class="top"><h1>Statistics gathering</h1>' +
      '<span class="db">' + esc(META.db || '?') + (META.dbUnique && META.dbUnique.toUpperCase() !== String(META.db).toUpperCase() ? ' (' + esc(META.dbUnique) + ')' : '') +
      ' &middot; ' + esc(scope) + ' &middot; ' + esc(META.version || '') + ' &middot; ' + esc(META.host || '') + '</span>' +
      '<nav><a href="#overview" data-v="overview">Overview</a><a href="#runs" data-v="runs">Runs</a><a href="#backlog" data-v="backlog">Still needs stats</a><a href="#config" data-v="config">Setup</a></nav>' +
      '<span class="ctl"><label>Times <select id="tz">' +
      '<option value="db">DB host (' + offLabel(dbo) + ')</option><option value="utc">UTC</option><option value="local">Browser (' + offLabel(-new Date().getTimezoneOffset()) + ')</option>' +
      '</select></label><button type="button" id="theme" data-tip="Light / dark">\u25d0</button></span></div>' +
      '<main id="view"></main><div id="tip"></div>';
    const tz = document.getElementById('tz');
    tz.value = tzMode;
    tz.onchange = () => { tzMode = tz.value; if (store) store.setItem('gd.tz', tzMode); route(); };
    const savedTheme = store && store.getItem('gd.theme');
    if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
    document.getElementById('theme').onclick = () => {
      const cur = document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      if (store) store.setItem('gd.theme', next);
    };
  }

  // tooltips and row links (event delegation)
  function wireGlobal() {
    const tip = document.getElementById('tip');
    document.addEventListener('mousemove', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) { tip.style.display = 'none'; return; }
      tip.innerHTML = el.getAttribute('data-tip');
      tip.style.display = 'block';
      const r = tip.getBoundingClientRect();
      let left = e.clientX + 14, topY = e.clientY + 14;
      if (left + r.width > innerWidth - 8) left = e.clientX - r.width - 14;
      if (topY + r.height > innerHeight - 8) topY = e.clientY - r.height - 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.max(4, topY) + 'px';
    });
    document.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('[data-href]');
      if (el && !e.target.closest('a,button,select,input')) location.hash = el.getAttribute('data-href');
    });
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => route(true), 150); });
  }

  function missingBox() {
    if (!missing.length) return '';
    return '<div class="warnbox"><b>Not collected:</b> ' + missing.map(esc).join(', ') +
      '. The SQL for these sections failed (missing grant, or an object this release does not have); the rest of the page works without them. ' +
      'The error text is in the HTML source next to the dataset name.</div>';
  }

  function panel(title, sub, body, right) {
    return '<section class="panel"><header><h2>' + esc(title) + '</h2>' + (sub ? '<span class="sub">' + sub + '</span>' : '') +
      (right ? '<span class="right">' + right + '</span>' : '') + '</header>' + body + '</section>';
  }
  function tile(label, value, detail, href) {
    return '<div class="tile"><div class="label">' + esc(label) + '</div>' +
      (href ? '<a class="value" href="' + esc(href) + '">' + value + '</a>' : '<div class="value">' + value + '</div>') +
      (detail ? '<div class="detail">' + detail + '</div>' : '') + '</div>';
  }

  // ------------------------------------------------------------ overview
  function findings() {
    const f = [];
    const add = (sev, html, more) => f.push({ sev: sev, html: html, more: more });
    ATC.forEach((a) => {
      if (a.status !== 'ENABLED') add('crit', 'The automatic statistics task is <b>' + esc(a.status.toLowerCase()) + '</b> in ' + esc(conName(a.con)) + '.', 'Nothing gathers stale statistics there unless a custom job does.');
    });
    if (PREFS.get('AUTOSTATS_TARGET') === 'ORACLE') add('crit', 'AUTOSTATS_TARGET is <b>ORACLE</b> in ' + esc(META.con) + ': the automatic job gathers only Oracle-owned schemas.', 'Application schemas need their own gather jobs.');
    const cons = [...new Set(ATC.map((a) => a.con).concat(AUTO.map((o) => o.con)))].sort((a, b) => a - b);
    cons.forEach((c) => {
      const runs = AUTO.filter((o) => o.con === c);
      const la = lastAuto.get(c);
      if (!runs.length) {
        add('crit', 'No automatic statistics run in ' + esc(conName(c)) + ' in the last ' + DAYS + ' days.', 'Check the task status and the maintenance windows on the Setup tab.');
        return;
      }
      const bad = runs.filter((o) => o.v.sev === 'crit');
      const warn = runs.filter((o) => o.v.sev === 'warn');
      const sec = runs.map((o) => o.secs).sort((a, b) => a - b);
      const med = sec[Math.floor(sec.length / 2)];
      const sev = bad.length ? 'crit' : warn.length ? 'warn' : 'good';
      add(sev, esc(conName(c)) + ': <a href="#runs?kind=auto&con=' + c + '">' + plural(runs.length, 'automatic run') + '</a>' +
        (bad.length ? ', <a href="#runs?kind=auto&con=' + c + '&sev=crit">' + plural(bad.length, 'did not finish', 'did not finish') + '</a>' : '') +
        (warn.length ? ', <a href="#runs?kind=auto&con=' + c + '&sev=warn">' + fmtN(warn.length) + ' with failed objects</a>' : '') +
        (!bad.length && !warn.length ? ', all complete' : '') + '.',
        'Typical run ' + fmtDur(med) + ', longest ' + fmtDur(sec[sec.length - 1]) + '. Last run ' + fmtT(la.start) + ' (' + fmtAgo(la.start) + '), ' + la.v.label.toLowerCase() + '.');
      if (GEN - la.start > 2 * DAY) add('warn', 'The last automatic run in ' + esc(conName(c)) + ' started ' + esc(fmtAgo(la.start)) + '.', 'It normally runs in every maintenance window.');
      const wins = WINS.filter((w) => w.con === c && w.maint && !w.open && w.start >= T0 && w.end > w.start);
      const empty = wins.filter((w) => !runs.some((o) => o.start >= w.start - 60e3 && o.start <= w.end));
      if (empty.length) add('warn', esc(conName(c)) + ': ' + plural(empty.length, 'maintenance window') + ' of ' + fmtN(wins.length) + ' passed without an automatic statistics run.', 'Last one: ' + esc(empty[empty.length - 1].name) + ' at ' + fmtT(empty[empty.length - 1].start) + '. Windows can be too short, disabled, or taken by other tasks.');
      const atEnd = runs.filter((o) => o.window && o.end && o.window.end - o.end < 120e3 && o.window.end > o.start);
      if (atEnd.length) add('crit', esc(conName(c)) + ': ' + plural(atEnd.length, 'run') + ' ended at the close of the maintenance window.', 'The window is too short for the work; objects left over wait for the next window.');
    });
    const rec = FAILLIST.filter((x) => x.runs.size >= 2 && !x.benign);
    if (rec.length) {
      const top = rec[0];
      add('warn', '<a href="#overview/failures">' + plural(rec.length, 'object') + ' failed in more than one run</a>, e.g. <code>' + esc(top.target) + '</code> in ' + plural(top.runs.size, 'run') + '.', esc(top.error));
    }
    const ben = FAILLIST.filter((x) => x.benign);
    if (ben.length) {
      const names = [...new Set(ben.map((x) => x.target))];
      add('info', 'Expected failures, not counted against the runs: ' + names.map((n) => '<code>' + esc(n) + '</code> (' + esc(ben.filter((x) => x.target === n).map((x) => conName(x.con)).join(', ')) + ')').join(', ') + '.', esc(ben[0].benign.why));
    }
    const appBL = BLAGG.filter((b) => !b.om && b.type !== 'FIXED TABLE');
    const appStale = appBL.filter((b) => b.stale).reduce((a, b) => a + b.n, 0);
    const appMissing = appBL.filter((b) => b.missing && b.type !== 'SUBPARTITION').reduce((a, b) => a + b.n, 0);
    const cnt = {};
    BL.filter((b) => !b.om).forEach((b) => { cnt[b.cat] = (cnt[b.cat] || 0) + 1; });
    if (cnt.missed || cnt.failed) {
      add('crit', '<a href="#backlog?cat=' + (cnt.missed ? 'missed' : 'failed') + '">' + (cnt.missed ? plural(cnt.missed, 'application object') + ' missed by the last automatic run' : '') +
        (cnt.missed && cnt.failed ? ', ' : '') + (cnt.failed ? plural(cnt.failed, 'object') + ' whose last gather failed' : '') + '</a>.', 'They are stale now, and the job had its chance.');
    }
    if (appStale || appMissing) {
      add('info', 'Application objects needing statistics now: <a href="#backlog">' + fmtN(appStale) + ' stale, ' + fmtN(appMissing) + ' without statistics</a>.',
        (cnt.fresh ? fmtN(cnt.fresh) + ' changed after the last automatic run (expected). ' : '') + (cnt.locked ? fmtN(cnt.locked) + ' locked. ' : '') + 'Staleness as of the last DML-monitoring flush.');
    } else if (!missing.includes('bl')) {
      add('good', 'No application table or partition is stale or missing statistics right now.');
    }
    const mf = GATHERS.filter((o) => o.v.sev === 'crit');
    if (GATHERS.length) add(mf.length ? 'warn' : 'good', '<a href="#runs?kind=gather">' + plural(GATHERS.length, 'manual or custom gather') + '</a>' + (mf.length ? ', <a href="#runs?kind=gather&sev=crit">' + fmtN(mf.length) + ' failed</a>' : ', none failed') + '.');
    return f.sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]);
  }

  function viewOverview(sub) {
    const v = document.getElementById('view');
    const runsOk = AUTO.filter((o) => o.v.sev === 'good').length;
    const objs = AUTO.reduce((a, o) => a + o.stats.done, 0) + GATHERS.reduce((a, o) => a + o.stats.done, 0);
    const failedObjs = new Set(FAILLIST.filter((f) => !f.benign).map((f) => f.con + '|' + f.target)).size;
    const benignObjs = new Set(FAILLIST.filter((f) => f.benign).map((f) => f.con + '|' + f.target)).size;
    const totalSecs = AUTO.concat(GATHERS).reduce((a, o) => a + o.secs, 0);
    const longest = AUTO.reduce((m, o) => (!m || o.secs > m.secs ? o : m), null);
    const appBL = BLAGG.filter((b) => !b.om && b.type !== 'FIXED TABLE');
    const stale = appBL.filter((b) => b.stale).reduce((a, b) => a + b.n, 0);
    const miss = appBL.filter((b) => b.missing && b.type !== 'SUBPARTITION').reduce((a, b) => a + b.n, 0);
    const hist = AUTO.concat(GATHERS).reduce((a, o) => a + o.stats.hist, 0);

    let h = missingBox();
    h += panel('Findings', 'last ' + DAYS + ' days to ' + esc(fmtT(GEN)) + ' &middot; times in ' + esc(tzMode === 'utc' ? 'UTC' : offLabel(tzOff(GEN))),
      '<ul class="findings">' + findings().map((x) => '<li>' + sevBadge(x.sev, '') + '<div>' + x.html + (x.more ? '<div class="more">' + x.more + '</div>' : '') + '</div></li>').join('') + '</ul>');
    h += '<div class="tiles" style="margin-bottom:16px">' +
      tile('Automatic runs', fmtN(AUTO.length), fmtN(runsOk) + ' complete, ' + fmtN(AUTO.length - runsOk) + ' with problems', '#runs?kind=auto') +
      tile('Manual / custom gathers', fmtN(GATHERS.length), fmtN(GATHERS.filter((o) => o.v.sev === 'crit').length) + ' failed', '#runs?kind=gather') +
      tile('Objects gathered', compact(objs), 'tables, partitions, indexes; ' + compact(hist) + ' with histograms') +
      tile('Objects that failed', fmtN(failedObjs), 'distinct objects' + (benignObjs ? ', plus ' + fmtN(benignObjs) + ' expected' : ''), '#overview/failures') +
      tile('Time spent gathering', fmtDur(totalSecs), longest ? 'longest automatic run ' + fmtDur(longest.secs) : '') +
      tile('Stale now', fmtN(stale), 'application tables / partitions', '#backlog') +
      tile('Without statistics', fmtN(miss), 'application tables / partitions', '#backlog?cat=missing') +
      '</div>';

    const cons = [...new Set(OPS.filter((o) => o.kind !== 'other').map((o) => o.con))].sort((a, b) => a - b);
    h += panel('Timeline', 'each mark is one run; click for its detail',
      '<div id="tl"></div><div class="legend"><span><b class="win"></b>maintenance window</span><span><b class="good"></b>complete</span><span><b class="warn"></b>some objects failed</span><span><b class="crit"></b>failed, stopped or not finished</span></div>' +
      '<h3 class="chart-title">Automatic job: run time per run</h3><div id="c-dur"></div>' +
      '<h3 class="chart-title">Automatic job: objects per run</h3><div id="c-obj"></div>' + consLegend());
    h += panel('Failures', 'same object, same error, across runs', '<div id="t-fail"></div>');
    h += panel('Most expensive objects', 'total gather time in the period', '<div id="t-heavy"></div>');
    v.innerHTML = h;

    const w = v.querySelector('#tl').clientWidth;
    v.querySelector('#tl').innerHTML = cons.length ? timelineSVG(w, T0, GEN, cons) : '<p class="note">No gather operations in the period.</p>';
    const autoSorted = AUTO.slice().sort((a, b) => a.start - b.start);
    const cw = w;
    v.querySelector('#c-dur').innerHTML = autoSorted.length ? runColumnsSVG(cw, T0, GEN, autoSorted, (o) => o.secs, fmtDur, 'Run time per automatic run') : '<p class="note">No automatic runs.</p>';
    v.querySelector('#c-obj').innerHTML = autoSorted.length ? runColumnsSVG(cw, T0, GEN, autoSorted, (o) => o.stats.n, compact, 'Objects per automatic run') : '';

    renderTable(v.querySelector('#t-fail'), {
      rows: FAILLIST, sort: ['runs', -1], limit: sub === 'failures' ? 1000 : 10, empty: 'No object failed in the period.',
      href: (f) => '#run/' + f.lastOp.key,
      cols: [
        { key: 'target', label: 'Object', html: (f) => '<code>' + esc(f.target) + '</code>' + (CONS.size > 1 ? ' <span class="pill">' + esc(conName(f.con)) + '</span>' : '') },
        { key: 'runs', label: 'Runs', num: true, val: (f) => f.runs.size, html: (f) => fmtN(f.runs.size) },
        { key: 'last', label: 'Last', cls: 't', html: (f) => esc(fmtT(f.last)) },
        { key: 'error', label: 'Error', cls: 'wrap', html: (f) => (f.benign ? '<span class="pill" data-tip="' + esc(esc(f.benign.why)) + '">expected</span> ' + esc(f.error) : '<span class="err">' + esc(f.error) + '</span>') }
      ]
    });
    if (sub === 'failures') v.querySelector('#t-fail').scrollIntoView();

    const heavy = new Map();
    TASKS.forEach((t) => {
      if (!t.op || t.op.kind === 'other' || t.secs == null) return;
      const k = t.con + '|' + t.name;
      let x = heavy.get(k);
      if (!x) heavy.set(k, x = { con: t.con, name: t.name, type: t.type, n: 0, secs: 0, max: 0, last: null });
      x.n++; x.secs += t.secs; x.max = Math.max(x.max, t.secs);
      if (!x.last || t.start > x.last.start) x.last = t;
    });
    const hl = [...heavy.values()].sort((a, b) => b.secs - a.secs).slice(0, 200);
    const hmax = hl.length ? hl[0].secs : 1;
    renderTable(v.querySelector('#t-heavy'), {
      rows: hl, sort: ['secs', -1], limit: 10, empty: 'No per-object timings recorded.',
      href: (x) => '#run/' + x.last.op.key,
      cols: [
        { key: 'name', label: 'Object', html: (x) => '<code>' + esc(x.name) + '</code> <span class="pill">' + esc(x.type.toLowerCase()) + '</span>' },
        { key: 'n', label: 'Gathers', num: true, html: (x) => fmtN(x.n) },
        { key: 'secs', label: 'Total', num: true, html: (x) => esc(fmtDur(x.secs)) },
        { key: 'bar', label: '', val: (x) => x.secs, html: (x) => '<div class="bar"><b style="width:' + (100 * x.secs / hmax).toFixed(1) + '%"></b></div>' },
        { key: 'max', label: 'Longest', num: true, html: (x) => esc(fmtDur(x.max)) }
      ]
    });
  }
  function consLegend() {
    const cons = [...new Set(AUTO.map((o) => o.con))].sort((a, b) => a - b);
    if (cons.length < 2) return '';
    return '<div class="legend">' + cons.map((c, i) => '<span><b class="s' + (i % 3 + 1) + '"></b>' + esc(conName(c)) + '</span>').join('') + '</div>';
  }

  // ------------------------------------------------------------ runs
  function viewRuns(q) {
    const v = document.getElementById('view');
    const f = {
      kind: q.get('kind') || 'gathers', con: q.get('con') || '', sev: q.get('sev') || '', text: q.get('q') || ''
    };
    const consAll = [...new Set(OPS.map((o) => o.con))].sort((a, b) => a - b);
    v.innerHTML = missingBox() + panel('Runs', 'every DBMS_STATS operation in the last ' + DAYS + ' days; click a row for its objects',
      '<div class="filters">' +
      '<label>Show <select id="f-kind"><option value="gathers">All gathers</option><option value="auto">Automatic job</option><option value="gather">Manual / custom gathers</option><option value="all">All DBMS_STATS operations</option></select></label>' +
      (consAll.length > 1 ? '<label>Container <select id="f-con"><option value="">All</option>' + consAll.map((c) => '<option value="' + c + '">' + esc(conName(c)) + '</option>').join('') + '</select></label>' : '') +
      '<label>Outcome <select id="f-sev"><option value="">Any</option><option value="crit">Failed / not finished</option><option value="warn">Some objects failed</option><option value="problem">Any problem</option><option value="good">Complete</option></select></label>' +
      '<input type="search" id="f-q" placeholder="Filter: operation, target, job, error" size="34">' +
      '<span class="note" id="f-n"></span></div><div id="t-runs"></div>');
    const sel = (id) => v.querySelector(id);
    sel('#f-kind').value = f.kind;
    if (sel('#f-con')) sel('#f-con').value = f.con;
    sel('#f-sev').value = f.sev;
    sel('#f-q').value = f.text;
    const host = sel('#t-runs');
    function apply() {
      f.kind = sel('#f-kind').value; f.con = sel('#f-con') ? sel('#f-con').value : ''; f.sev = sel('#f-sev').value; f.text = sel('#f-q').value.trim().toLowerCase();
      const params = new URLSearchParams();
      if (f.kind !== 'gathers') params.set('kind', f.kind);
      if (f.con) params.set('con', f.con);
      if (f.sev) params.set('sev', f.sev);
      if (f.text) params.set('q', f.text);
      const hs = '#runs' + (params.toString() ? '?' + params.toString() : '');
      if (location.hash !== hs) history.replaceState(null, '', hs);
      const list = OPS.filter((o) =>
        (f.kind === 'all' || (f.kind === 'gathers' ? o.kind !== 'other' : o.kind === f.kind)) &&
        (!f.con || String(o.con) === f.con) &&
        (!f.sev || (f.sev === 'problem' ? o.v.sev === 'crit' || o.v.sev === 'warn' : o.v.sev === f.sev)) &&
        (!f.text || [o.op, opTarget(o), o.job, o.error, o.status, o.v.label].join(' ').toLowerCase().includes(f.text)));
      sel('#f-n').textContent = plural(list.length, 'operation');
      host._t = host._t || { sort: ['start', -1], limit: 300 };
      renderTable(host, {
        rows: list, href: (o) => '#run/' + o.key, empty: 'No operation matches.',
        cols: [
          { key: 'start', label: 'Started', cls: 't', desc: true, html: (o) => esc(fmtT(o.start, true)) },
          { key: 'sev', label: 'Outcome', val: (o) => SEV_RANK[o.v.sev], desc: true, html: (o) => sevBadge(o.v.sev, o.v.label, o.v.why) },
          { key: 'con', label: 'Container', html: (o) => esc(conName(o.con)) },
          { key: 'op', label: 'Operation', val: (o) => opLabel(o), html: (o) => esc(opLabel(o)) },
          { key: 'target', label: 'Target', cls: 'wrap', val: (o) => opTarget(o), html: (o) => '<code>' + esc(opTarget(o)) + '</code>' },
          { key: 'secs', label: 'Duration', num: true, html: (o) => esc(fmtDur(o.secs)) },
          { key: 'n', label: 'Objects', num: true, val: (o) => o.stats.n, html: (o) => (o.stats.n ? fmtN(o.stats.n) : '') },
          { key: 'failed', label: 'Failed', num: true, val: (o) => o.stats.failed + o.stats.notDone, html: (o) => (o.stats.failed + o.stats.notDone ? '<span class="err">' + fmtN(o.stats.failed + o.stats.notDone) + '</span>' : '') },
          { key: 'job', label: 'Job / window', html: (o) => esc(o.job || '') + (o.window ? ' <span class="pill">' + esc(o.window.name) + '</span>' : '') }
        ]
      });
    }
    ['#f-kind', '#f-con', '#f-sev'].forEach((id) => { if (sel(id)) sel(id).onchange = () => { host._t.limit = 300; apply(); }; });
    let qt;
    sel('#f-q').oninput = () => { clearTimeout(qt); qt = setTimeout(apply, 200); };
    apply();
  }

  // ------------------------------------------------------------ one run
  function viewRun(con, id) {
    const v = document.getElementById('view');
    const o = OPMAP.get(con + '/' + id);
    if (!o) { v.innerHTML = panel('Run not found', '', '<p>No operation ' + esc(id) + ' in container ' + esc(con) + ' in this report.</p>'); return; }
    const s = o.stats;
    const same = OPS.filter((x) => x.kind === o.kind && x.con === o.con && (o.kind !== 'gather' || x.op === o.op)).sort((a, b) => a.start - b.start);
    const i = same.indexOf(o);
    const prev = same[i - 1], next = same[i + 1];
    let h = '<div class="crumbs"><a href="#runs?kind=' + (o.kind === 'other' ? 'all' : o.kind) + '">\u2190 Runs</a>' +
      (prev ? ' &middot; <a href="#run/' + prev.key + '">previous</a>' : '') + (next ? ' &middot; <a href="#run/' + next.key + '">next</a>' : '') + '</div>';
    h += '<div class="title-row"><h2>' + esc(opLabel(o)) + (o.kind === 'auto' ? '' : ' <code>' + esc(opTarget(o)) + '</code>') + '</h2>' + sevBadge(o.v.sev, o.v.label) +
      '<span class="note">' + esc(conName(o.con)) + ' &middot; operation ' + esc(o.id) + '</span></div>';
    if (o.v.sev !== 'good') h += '<div class="warnbox">' + esc(o.v.why) + '</div>';

    const facts = [
      ['Started', fmtT(o.start, true)],
      ['Ended', o.end ? fmtT(o.end, true) : '(no end recorded)'],
      ['Duration', fmtDur(o.secs)],
      ['Status', o.status],
      ['Job', o.job || '(called from a session, not a scheduler job)'],
      ['Session', o.sid]
    ];
    if (o.sjr) facts.push(['Scheduler', o.sjr.status + ' &middot; run ' + fmtDur(o.sjr.secs) + ' &middot; CPU ' + fmtDur(o.sjr.cpu) + (o.sjr.error ? ' &middot; ORA-' + o.sjr.error : '')]);
    if (o.window) {
      const used = o.end && o.window.end > o.window.start ? (100 * (o.end - o.window.start)) / (o.window.end - o.window.start) : null;
      facts.push(['Window', o.window.name + ' ' + fmtT(o.window.start) + ' \u2192 ' + fmtClock(o.window.end) + ' (' + fmtDur(o.window.secs) + ')' +
        (o.end ? ' &middot; ended ' + fmtDur((o.window.end - o.end) / 1000) + ' before the window closed' : '') + (used != null ? ' &middot; ' + used.toFixed(0) + '% of the window elapsed' : '')]);
    }
    if (o.ajh && o.ajh.info) facts.push(['Job info', o.ajh.info]);
    const kv = '<dl class="kv">' + facts.map((f) => '<dt>' + esc(f[0]) + '</dt><dd>' + (f[0] === 'Scheduler' || f[0] === 'Window' ? f[1] : esc(f[1])) + '</dd>').join('') + '</dl>';
    const pk = Object.keys(o.params);
    const params = pk.length ? '<dl class="kv">' + pk.map((k) => '<dt>' + esc(k) + '</dt><dd><code>' + esc(o.params[k] === '' ? "''" : o.params[k]) + '</code></dd>').join('') + '</dl>' : '<p class="note">No parameters recorded.</p>';
    h += '<div class="cols">' + panel('Run', '', kv + (o.error ? '<div class="err-block" style="margin-top:10px">' + esc(o.error) + '</div>' : '')) +
      panel('Parameters', 'as the call resolved them (DEFAULT_* = the preference in force)', params) + '</div><div style="height:16px"></div>';

    if (s.n) {
      const types = Object.keys(s.byType).sort((a, b) => s.byType[b].secs - s.byType[a].secs);
      let tb = '<div class="tablewrap"><table><thead><tr><th>Object type</th><th class="num">Objects</th><th class="num">Gathered</th><th class="num">Failed</th><th class="num">Not processed</th><th class="num">With histograms</th><th class="num">Time (sum)</th></tr></thead><tbody>';
      types.forEach((t) => {
        const b = s.byType[t];
        tb += '<tr><td>' + esc(t.toLowerCase()) + '</td><td class="num">' + fmtN(b.n) + '</td><td class="num">' + fmtN(b.done) + '</td><td class="num">' + (b.failed ? '<span class="err">' + fmtN(b.failed) + '</span>' : '') +
          '</td><td class="num">' + (b.other ? '<span class="err">' + fmtN(b.other) + '</span>' : '') + '</td><td class="num">' + (b.hist ? fmtN(b.hist) : '') + '</td><td class="num">' + esc(fmtDur(b.secs)) + '</td></tr>';
      });
      tb += '<tr><td><b>Total</b></td><td class="num"><b>' + fmtN(s.n) + '</b></td><td class="num">' + fmtN(s.done) + '</td><td class="num">' + (s.failed ? '<span class="err">' + fmtN(s.failed) + '</span>' : '') +
        '</td><td class="num">' + (s.notDone ? '<span class="err">' + fmtN(s.notDone) + '</span>' : '') + '</td><td class="num">' + fmtN(s.hist) + '</td><td class="num">' + esc(fmtDur(s.secs)) + '</td></tr></tbody></table></div>';
      const conc = o.params.concurrent === 'TRUE' || (s.secs > o.secs * 1.2 && o.secs > 1);
      const owners = new Map();
      o.tasks.forEach((t) => { const k = t.parts[0] || '?'; const x = owners.get(k) || { n: 0, secs: 0 }; x.n++; x.secs += t.secs || 0; owners.set(k, x); });
      const ol = [...owners.entries()].sort((a, b) => b[1].secs - a[1].secs).slice(0, 8);
      const ot = '<div class="tablewrap"><table><thead><tr><th>Schema</th><th class="num">Objects</th><th class="num">Time (sum)</th></tr></thead><tbody>' +
        ol.map((e) => '<tr><td>' + esc(e[0]) + '</td><td class="num">' + fmtN(e[1].n) + '</td><td class="num">' + esc(fmtDur(e[1].secs)) + '</td></tr>').join('') + '</tbody></table></div>';
      h += '<div class="cols cols-2-1">' + panel('What it did', plural(s.n, 'object') + (conc ? ' &middot; objects ran concurrently, so the sum exceeds the elapsed time' : ''), tb) +
        panel('By schema', o.truncated ? 'from the ' + fmtN(o.tasks.length) + ' objects embedded' : '', ot) + '</div><div style="height:16px"></div>';
      h += panel('Objects over time', (o.tasks.length > 40 ? 'objects running at the same time stack into lanes; hover for each object' : '') +
        (o.window && o.window.end <= o.endEff + 60e3 ? ' &middot; red line: window end' : ''),
        '<div id="gantt"></div><div class="legend"><span><b class="s1"></b>table</span><span><b class="s2"></b>partition</span><span><b class="s3"></b>index</span><span><b class="crit"></b>failed</span><span><b class="warn"></b>not completed</span></div>');
      h += panel('Objects', o.truncated ? 'showing ' + fmtN(o.tasks.length) + ' of ' + fmtN(s.n) + ' (failed first, then slowest; raise max_tasks_per_run for all)' : plural(s.n, 'object'),
        '<div class="filters"><label>Status <select id="o-st"><option value="">Any</option>' + [...new Set(o.tasks.map((t) => t.status))].sort().map((x) => '<option>' + esc(x) + '</option>').join('') + '</select></label>' +
        '<label>Type <select id="o-ty"><option value="">Any</option>' + [...new Set(o.tasks.map((t) => t.type))].sort().map((x) => '<option>' + esc(x) + '</option>').join('') + '</select></label>' +
        '<input type="search" id="o-q" placeholder="Filter objects" size="28"></div><div id="t-obj"></div>');
    } else if (o.kind !== 'other') {
      h += panel('What it did', '', '<p>No per-object rows recorded for this operation' + (o.status === 'COMPLETED' ? ': it found nothing to gather.' : '.') + '</p>');
    }
    if (o.kind === 'auto' && lastAuto.get(o.con) === o) {
      const n = BL.filter((b) => b.con === o.con && !b.om && (b.cat === 'missed' || b.cat === 'failed')).length;
      h += panel('After this run', 'the latest automatic run in ' + esc(conName(o.con)),
        '<p>' + (n ? '<a href="#backlog?cat=missed&con=' + o.con + '">' + plural(n, 'application object') + '</a> were stale before this run started and are still stale, or failed.' : 'No application object that was stale when this run started is still stale.') + '</p>');
    }
    v.innerHTML = h;

    if (s.n && o.tasks.length) {
      const g = v.querySelector('#gantt');
      const gr = ganttSVG(g.clientWidth, o, o.tasks);
      g.innerHTML = gr.svg + (gr.capped ? '<p class="note">More than 24 objects ran at once; the busiest lanes are merged.</p>' : '');
      const host = v.querySelector('#t-obj');
      const st = v.querySelector('#o-st'), ty = v.querySelector('#o-ty'), qq = v.querySelector('#o-q');
      const draw = () => {
        const q = qq.value.trim().toLowerCase();
        renderTable(host, {
          rows: o.tasks.filter((t) => (!st.value || t.status === st.value) && (!ty.value || t.type === ty.value) && (!q || (t.name + ' ' + (t.error || '') + ' ' + t.hist.join(' ')).toLowerCase().includes(q))),
          sort: ['secs', -1], limit: 300,
          cols: [
            { key: 'name', label: 'Object', html: (t) => '<code>' + esc(t.name) + '</code>' },
            { key: 'type', label: 'Type', html: (t) => esc(t.type.toLowerCase()) },
            { key: 'size', label: 'Size', num: true, tip: 'TARGET_SIZE as recorded by DBMS_STATS (blocks)', html: (t) => fmtN(t.size) },
            { key: 'start', label: 'Started', cls: 't', html: (t) => esc(fmtClock(t.start, true)) },
            { key: 'secs', label: 'Duration', num: true, html: (t) => esc(fmtDur(t.secs)) },
            { key: 'status', label: 'Status', html: (t) => (t.status === 'COMPLETED' ? sevBadge('good', 'gathered') : sevBadge(t.status === 'FAILED' ? 'crit' : 'warn', t.status.toLowerCase())) },
            { key: 'hist', label: 'Histograms', cls: 'wrap', val: (t) => t.hist.length, html: (t) => (t.hist.length ? '<span data-tip="' + esc(esc(t.hist.join(', '))) + '">' + plural(t.hist.length, 'column') + '</span>' : '') },
            { key: 'error', label: 'Error / extended stats', cls: 'wrap', html: (t) => (t.error ? '<span class="err">' + esc(t.error) + '</span>' : esc(t.xstats)) }
          ]
        });
      };
      [st, ty].forEach((e) => { e.onchange = () => { host._t.limit = 300; draw(); }; });
      let qt;
      qq.oninput = () => { clearTimeout(qt); qt = setTimeout(draw, 200); };
      draw();
    }
  }

  // ------------------------------------------------------------ backlog
  function viewBacklog(q) {
    const v = document.getElementById('view');
    const f = { cat: q.get('cat') || '', con: q.get('con') || '', om: q.get('om') === '1', text: q.get('q') || '' };
    const consAll = [...new Set(BL.map((b) => b.con))].sort((a, b) => a - b);
    let h = missingBox();
    h += '<div class="cat-cards" id="cats"></div>';
    h += panel('Objects that need statistics now', 'tables, partitions and subpartitions that are stale or have no statistics; staleness as of the last DML-monitoring flush',
      '<div class="filters">' +
      (consAll.length > 1 ? '<label>Container <select id="b-con"><option value="">All</option>' + consAll.map((c) => '<option value="' + c + '">' + esc(conName(c)) + '</option>').join('') + '</select></label>' : '') +
      '<label><input type="checkbox" id="b-om"> include Oracle-maintained schemas</label>' +
      '<input type="search" id="b-q" placeholder="Filter: owner, table, partition" size="30">' +
      '<span class="note" id="b-n"></span></div>' +
      (blTruncated ? '<p class="note">Only the first ' + fmtN(BL.length) + ' objects are embedded (application schemas first); raise max_backlog for all. The counts on the cards cover the embedded rows.</p>' : '') +
      '<div id="t-bl"></div>');
    v.innerHTML = h;
    const sel = (id) => v.querySelector(id);
    if (sel('#b-con')) sel('#b-con').value = f.con;
    sel('#b-om').checked = f.om;
    sel('#b-q').value = f.text;
    const host = sel('#t-bl');
    function apply() {
      f.con = sel('#b-con') ? sel('#b-con').value : '';
      f.om = sel('#b-om').checked;
      f.text = sel('#b-q').value.trim().toLowerCase();
      const params = new URLSearchParams();
      if (f.cat) params.set('cat', f.cat);
      if (f.con) params.set('con', f.con);
      if (f.om) params.set('om', '1');
      if (f.text) params.set('q', f.text);
      const hs = '#backlog' + (params.toString() ? '?' + params.toString() : '');
      if (location.hash !== hs) history.replaceState(null, '', hs);
      const base = BL.filter((b) => (f.om || !b.om) && (!f.con || String(b.con) === f.con) && (!f.text || b.name.toLowerCase().includes(f.text)));
      const cnt = {};
      base.forEach((b) => { cnt[b.cat] = (cnt[b.cat] || 0) + 1; });
      sel('#cats').innerHTML = CAT_ORDER.filter((c) => cnt[c] || f.cat === c).map((c) =>
        '<button type="button" class="cat-card' + (f.cat === c ? ' on' : '') + '" data-cat="' + c + '"><div>' + sevBadge(CATS[c].sev, CATS[c].title) + '</div><div class="n">' + fmtN(cnt[c] || 0) + '</div><div class="d">' + esc(CATS[c].text) + '</div></button>').join('') ||
        '<div class="tile"><div class="label">Nothing needs statistics</div><div class="detail">with the current filters</div></div>';
      sel('#cats').querySelectorAll('[data-cat]').forEach((b) => {
        b.onclick = () => { const c = b.getAttribute('data-cat'); f.cat = f.cat === c ? '' : c; host._t && (host._t.limit = 300); apply(); };
      });
      const list = base.filter((b) => !f.cat || b.cat === f.cat);
      sel('#b-n').textContent = plural(list.length, 'object') + (f.cat ? ' in "' + CATS[f.cat].title + '"' : '');
      renderTable(host, {
        rows: list, sort: host._t ? host._t.sort : null, limit: 300, empty: 'Nothing matches.',
        href: (b) => (b.attempt && b.attempt.op ? '#run/' + b.attempt.op.key : null),
        cols: [
          { key: 'name', label: 'Object', html: (b) => '<code>' + esc(b.name) + '</code>' + (consAll.length > 1 ? ' <span class="pill">' + esc(conName(b.con)) + '</span>' : '') },
          { key: 'type', label: 'Type', html: (b) => esc(b.type.toLowerCase()) },
          { key: 'cat', label: 'Why', val: (b) => CAT_ORDER.indexOf(b.cat), html: (b) => sevBadge(CATS[b.cat].sev, CATS[b.cat].title, CATS[b.cat].text) },
          { key: 'rows', label: 'Rows (stats)', num: true, html: (b) => fmtN(b.rows) },
          { key: 'dml', label: 'Changed rows', num: true, tip: 'Inserts + updates + deletes since the last gather (DBA_TAB_MODIFICATIONS)', html: (b) => (b.dml ? '<span data-tip="' + esc('ins ' + fmtN(b.ins) + ', upd ' + fmtN(b.upd) + ', del ' + fmtN(b.del) + (b.trunc ? ', truncated' : '')) + '">' + fmtN(b.dml) + '</span>' : (b.trunc ? 'truncated' : '')) },
          { key: 'pct', label: '% changed', num: true, html: (b) => (b.pct != null ? (b.pct >= 1000 ? '>999' : b.pct.toFixed(b.pct < 10 ? 1 : 0)) + '%' : '') },
          { key: 'analyzed', label: 'Last analyzed', cls: 't', html: (b) => (b.analyzed ? esc(fmtT(b.analyzed)) : '<span class="err">never</span>') },
          { key: 'dmlTs', label: 'Last change seen', cls: 't', html: (b) => esc(fmtT(b.dmlTs)) },
          { key: 'attempt', label: 'Last gather attempt', cls: 'wrap', val: (b) => (b.attempt ? b.attempt.start : null),
            html: (b) => (b.attempt ? esc(fmtT(b.attempt.start)) + ' ' + (b.attempt.status === 'FAILED' ? '<span class="err">failed: ' + esc(b.attempt.error || '') + '</span>' : esc(String(b.attempt.status || '').toLowerCase())) : '<span class="note">none in the period</span>') },
          { key: 'prefs', label: 'Table prefs', cls: 'wrap', val: (b) => b.prefs.length,
            html: (b) => {
              const key = b.prefs.filter((p) => /^(STALE_PERCENT|INCREMENTAL|GRANULARITY|PUBLISH)$/.test(p.pref));
              const rest = b.prefs.length - key.length;
              return (b.locked ? '<span class="pill">locked ' + esc(b.locked.toLowerCase()) + '</span> ' : '') +
                key.map((p) => '<span class="pill">' + esc(p.pref) + '=' + esc(p.value) + '</span>').join(' ') +
                (rest ? ' <span class="pill" data-tip="' + esc(b.prefs.map((p) => esc(p.pref) + ' = ' + esc(p.value)).join('<br>')) + '">' + (key.length ? '+' : '') + plural(rest, 'pref') + '</span>' : '');
            } }
        ]
      });
    }
    ['#b-con', '#b-om'].forEach((id) => { if (sel(id)) sel(id).onchange = () => { if (host._t) host._t.limit = 300; apply(); }; });
    let qt;
    sel('#b-q').oninput = () => { clearTimeout(qt); qt = setTimeout(apply, 200); };
    apply();
  }

  // ------------------------------------------------------------ setup
  function viewConfig() {
    const v = document.getElementById('view');
    let h = missingBox();
    const atc = '<div class="tablewrap"><table><thead><tr><th>Container</th><th>Status</th><th>Window group</th><th class="num">Mean job</th><th class="num">Longest, last 7 days</th><th>Attributes</th></tr></thead><tbody>' +
      (ATC.length ? ATC.map((a) => '<tr><td>' + esc(conName(a.con)) + '</td><td>' + sevBadge(a.status === 'ENABLED' ? 'good' : 'crit', a.status.toLowerCase()) + '</td><td>' + esc(a.group) + '</td><td class="num">' + esc(fmtDur(a.mean)) +
        '</td><td class="num">' + esc(fmtDur(a.max7)) + '</td><td>' + esc(a.attrs) + '</td></tr>').join('') : '<tr><td colspan="6" class="note">No rows.</td></tr>') + '</tbody></table></div>';
    h += panel('Automatic statistics task', 'DBA_AUTOTASK_CLIENT', atc);
    const wins = WCFG.slice().sort((a, b) => a.con - b.con || (a.next || 9e15) - (b.next || 9e15));
    renderLater.push(() => renderTable(v.querySelector('#t-win'), {
      rows: wins, sort: null, limit: 100,
      cols: [
        { key: 'con', label: 'Container', html: (w) => esc(conName(w.con)) },
        { key: 'name', label: 'Window', html: (w) => esc(w.name) + (w.maint ? ' <span class="pill">maintenance</span>' : '') },
        { key: 'enabled', label: 'Enabled', html: (w) => (w.enabled === 'TRUE' ? 'yes' : '<span class="err">no</span>') + (w.active === 'TRUE' ? ' <span class="pill">open now</span>' : '') },
        { key: 'secs', label: 'Duration', num: true, html: (w) => esc(fmtDur(w.secs)) },
        { key: 'repeat', label: 'Repeat interval', cls: 'wrap', html: (w) => '<code>' + esc(w.repeat) + '</code>' },
        { key: 'last', label: 'Last opened', cls: 't', html: (w) => esc(fmtT(w.last)) },
        { key: 'next', label: 'Next', cls: 't', html: (w) => esc(fmtT(w.next)) }
      ]
    }));
    h += panel('Scheduler windows', 'the automatic job runs only while a window of its group is open', '<div id="t-win"></div>');
    const pr = [...PREFS.entries()];
    const prefNotes = {
      AUTOSTATS_TARGET: 'AUTO: all schemas; ORACLE: only Oracle-owned schemas',
      STALE_PERCENT: 'percent of rows changed before a table counts as stale',
      CONCURRENT: 'gather several objects at the same time',
      AUTO_TASK_STATUS: 'high-frequency automatic task (Exadata and Autonomous only in 19c)',
      AUTO_TASK_MAX_RUN_TIME: 'seconds, high-frequency task',
      AUTO_TASK_INTERVAL: 'seconds between high-frequency runs'
    };
    h += '<div class="cols">' + panel('Global preferences', 'DBMS_STATS.GET_PREFS in ' + esc(META.con || ''),
      '<div class="tablewrap"><table><thead><tr><th>Preference</th><th>Value</th><th></th></tr></thead><tbody>' +
      pr.map((p) => '<tr><td>' + esc(p[0]) + '</td><td><code>' + esc(p[1]) + '</code></td><td class="note">' + esc(prefNotes[p[0]] || '') + '</td></tr>').join('') + '</tbody></table></div>') +
      panel('Statistics history', '',
        '<dl class="kv"><dt>Retention</dt><dd>' + esc(META.retention) + ' days (operations older than this are purged, so this report cannot reach further back)</dd>' +
        '<dt>Oldest available</dt><dd>' + esc(fmtT(ts(META.availability))) + '</dd><dt>Report period</dt><dd>' + esc(fmtT(T0)) + ' \u2192 ' + esc(fmtT(GEN)) + ' (' + DAYS + ' days)</dd>' +
        '<dt>Collected as</dt><dd>' + esc(META.user) + ' in ' + esc(META.con) + ' on ' + esc(META.instance) + '</dd>' +
        '<dt>Embedded rows</dt><dd>' + fmtN(OPS.length) + ' operations, ' + fmtN(TASKS.length) + ' objects (max ' + fmtN(META.maxTasks) + ' per run), ' + fmtN(BL.length) + ' needing statistics</dd></dl>') + '</div><div style="height:16px"></div>';
    h += panel('Table preferences', 'DBA_TAB_STAT_PREFS (application schemas first)', '<div id="t-tp"></div>');
    v.innerHTML = h;
    renderLater.splice(0).forEach((fn) => fn());
    renderTable(v.querySelector('#t-tp'), {
      rows: TPREFS, limit: 50, empty: 'No table-level preferences.',
      cols: [
        { key: 'con', label: 'Container', html: (p) => esc(conName(p.con)) },
        { key: 'owner', label: 'Owner', html: (p) => esc(p.owner) + (p.om ? ' <span class="pill">Oracle</span>' : '') },
        { key: 'table', label: 'Table' },
        { key: 'pref', label: 'Preference' },
        { key: 'value', label: 'Value', cls: 'wrap', html: (p) => '<code>' + esc(p.value) + '</code>' }
      ]
    });
  }
  const renderLater = [];

  // ------------------------------------------------------------ router
  function route(resize) {
    const raw = location.hash.replace(/^#/, '') || 'overview';
    const qi = raw.indexOf('?');
    const path = (qi < 0 ? raw : raw.slice(0, qi)).split('/');
    const q = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
    const view = path[0];
    document.querySelectorAll('.top nav a').forEach((a) => {
      const dv = a.getAttribute('data-v');
      a.classList.toggle('on', dv === view || (dv === 'runs' && view === 'run'));
    });
    const keepScroll = resize ? window.scrollY : 0;
    if (view === 'runs') viewRuns(q);
    else if (view === 'run') viewRun(path[1], path[2]);
    else if (view === 'backlog') viewBacklog(q);
    else if (view === 'config') viewConfig();
    else viewOverview(path[1]);
    if (!(view === 'overview' && path[1])) window.scrollTo(0, keepScroll);
    document.getElementById('tip').style.display = 'none';
  }

  chrome();
  wireGlobal();
  window.addEventListener('hashchange', () => route());
  route();
})();
