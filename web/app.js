/*
 * Statistics gathering dashboard -- page script.
 *
 * Source of sql/_app.sql (tools/build_assets.sh).  Reads the D.* datasets
 * that the SQL sections printed above it and renders the views:
 * overview, runs, one run in detail, what still needs statistics,
 * column statistics, and setup.
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
    if (s < 9.95) return s.toFixed(1) + ' s';
    // round first, then split, so 119.6 s reads 2m 00s and not 1m 60s
    const r = Math.round(s);
    if (r < 60) return r + ' s';
    if (r < 3600) return Math.floor(r / 60) + 'm ' + String(r % 60).padStart(2, '0') + 's';
    const m = Math.round(s / 60);
    if (m < 1440) return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    const h = Math.round(s / 3600);
    return Math.floor(h / 24) + 'd ' + String(h % 24).padStart(2, '0') + 'h';
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
  // "2026-10-18 06:00 to 23:00", with the end date when it is another day
  function fmtSpan(a, b) {
    if (a == null || b == null) return fmtT(a);
    return fmtT(a) + ' to ' + (fmtT(a).slice(0, 10) === fmtT(b).slice(0, 10) ? fmtClock(b) : fmtT(b));
  }
  function dayStart(ms) { const off = tzOff(ms) * 60000; return Math.floor((ms + off) / DAY) * DAY - off; }


  const CONS = new Map(rows('cons').map((r) => [r[0], r[1]]));
  const conName = (id) => CONS.get(id) || (id === 0 ? (META.db || 'DB') : 'CON_ID ' + id);
  const conKey = (con, s) => con + '|' + s;
  // Oracle-maintained schemas (SYS, SYSTEM, ...), hidden unless asked for
  const OMU = new Set(rows('omu').map((r) => conKey(r[0], r[1])));
  const isOM = (con, owner) => OMU.has(conKey(con, owner));
  let showOM = !!store && store.getItem('gd.om') === '1';

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
    o.owner = o.kind === 'auto' ? null : splitTarget(o.target)[0] || null;
    o.om = o.kind !== 'auto' && ((!!o.owner && isOM(o.con, o.owner)) || /dictionary|fixed_objects|system_stats/.test(o.op));
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
    t.nameL = t.name.toLowerCase();
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

  // D.idx: index -> its table, so index gathers show under the table
  const IDX = new Map(rows('idx').map((r) => [conKey(r[0], r[1] + '.' + r[2]), r[3] + '.' + r[4]]));
  // The table an object row belongs to: "OWNER.TABLE" (null when unknown)
  TASKS.forEach((t) => {
    if (/^TABLE/.test(t.type)) t.tab = t.parts.length >= 2 ? t.parts[0] + '.' + t.parts[1] : null;
    else if (/^INDEX/.test(t.type)) t.tab = IDX.get(conKey(t.con, t.parts.slice(0, 2).join('.'))) || null;
    else t.tab = null;
    // the partition or subpartition name, when the row is one
    t.piece = !/PARTITION/.test(t.type) ? null : t.parts.length >= 3 ? t.parts[t.parts.length - 1] : (t.op && t.op.params.partname) || null;
  });

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
    const err = (error || 'Oracle recorded no error text for this failure').replace(/\s+/g, ' ').slice(0, 300);
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
  FAILLIST.forEach((f) => { f.benign = benign(f.target + ' ' + f.error); f.om = isOM(f.con, f.target.split('.')[0]); });
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
    const exp = fails.filter((t) => benign(t.name + ' ' + t.error));
    const expected = exp.length;
    if (s.failed && expected === s.failed) {
      return { sev: 'good', label: 'Complete', why: 'Every object it picked was gathered, except ' + plural(expected, 'expected failure') + ' (' + exp.map((t) => t.name).join(', ') + ').', expected: expected };
    }
    if (s.failed) {
      const real = fails.filter((t) => exp.indexOf(t) < 0);
      const allChronic = fails.length === s.failed && real.every((t) => chronic.has(t.con + '|' + showTarget(t.target)));
      return { sev: 'warn', label: fmtN(s.failed - expected) + ' failed', expected: expected,
        why: fmtN(s.failed - expected) + ' of ' + fmtN(s.n) + ' objects failed' + (allChronic ? ' (the same objects fail in every run)' : '') +
          (expected ? ', plus ' + plural(expected, 'expected failure') : '') + '.' };
    }
    if (o.status && o.status !== 'COMPLETED') return { sev: 'warn', label: titleCase(o.status), why: 'Status ' + o.status + '.' };
    return { sev: 'good', label: 'Complete', why: o.kind === 'other' ? 'Completed.' : 'Every object it picked was gathered.' };
  }
  OPS.forEach((o) => { o.v = verdict(o); });

  // Batches: the calls one job or session made back to back (gaps under two
  // minutes).  The runs list shows a batch as one row that opens up.
  const BATCHES = [];
  (() => {
    const cur = new Map();
    OPS.filter((o) => o.kind !== 'auto').sort((a, b) => a.start - b.start).forEach((o) => {
      const k = o.con + '|' + (o.job || 'sid ' + o.sid);
      let b = cur.get(k);
      if (!b || o.start - b.end > 120e3) {
        b = { id: BATCHES.length, con: o.con, job: o.job, sid: o.sid, ops: [], start: o.start, end: o.endEff };
        cur.set(k, b);
        BATCHES.push(b);
      }
      b.ops.push(o);
      b.end = Math.max(b.end, o.endEff);
      o.batch = b;
    });
  })();

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
    const k = conKey(o.con, showTarget(o.target) + (o.params.partname && splitTarget(o.target).length < 3 ? '.' + o.params.partname : ''));
    const l = lastAttempt.get(k);
    if (!l || o.start > l.start) lastAttempt.set(k, { start: o.start, status: o.status, error: o.error, op: o });
  });

  const CATS = {
    failed: { sev: 'crit', title: 'Last gather failed', text: 'The last gather of it in the period failed. Stale until the error is fixed.' },
    missed: { sev: 'crit', title: 'Missed by the last automatic run', text: 'Its changes were recorded before the last automatic run started, yet that run did not gather it (run stopped early, object outside AUTOSTATS_TARGET, or a table preference).' },
    locked: { sev: 'warn', title: 'Stale or missing, but locked', text: 'Locked: the automatic job and every gather without FORCE skip it. Check the lock is intentional.' },
    missing: { sev: 'warn', title: 'No statistics at all', text: 'Never gathered: the optimizer uses dynamic sampling. The automatic job takes these first; check why it has not.' },
    fresh: { sev: 'info', title: 'Stale since the last automatic run', text: 'Changed after the last automatic run started. The next run should take it.' },
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

  // Column statistics below the table level (sql/60_columns.sql)
  const COLCATS = {
    nostats: { sev: 'warn', title: 'Column without statistics', text: 'The table has statistics but this column has none, typically because it was added after the last gather. The optimizer guesses its selectivity.' },
    older: { sev: 'warn', title: 'Older than the table statistics', text: 'Over an hour older than the table statistics: the last gather left this column out (a METHOD_OPT naming only some columns, or FOR TABLE). Its distinct values, nulls and histogram describe older data.' },
    legacyhb: { sev: 'warn', title: 'Height-balanced histogram', text: 'Only built with a fixed ESTIMATE_PERCENT. With AUTO_SAMPLE_SIZE, 19c builds frequency, top-frequency or hybrid histograms instead, which estimate popular values much better.' },
    small: { sev: 'info', title: 'Histogram with few buckets', text: 'Fewer than half the buckets it could have (254, or one per distinct value): METHOD_OPT asked for a small SIZE. Values between two endpoints get an average estimate.' },
    freqgap: { sev: 'info', title: 'Frequency histogram missing values', text: 'Fewer buckets than distinct values: some values were not in the sample, or long strings that start alike share one endpoint. Values missing from it get a guessed estimate.' }
  };
  const COLCAT_ORDER = ['nostats', 'older', 'legacyhb', 'small', 'freqgap'];
  const COLCAT_SHORT = { nostats: 'without statistics', older: 'older than their table', legacyhb: 'with a height-balanced histogram', small: 'with a small histogram', freqgap: 'with gaps in a frequency histogram' };
  const COLS = rows('cols').map((r) => {
    const c = {
      con: r[0], owner: r[1], table: r[2], col: r[3], dtype: r[4], cat: r[5], hist: r[6], ndv: r[7], buckets: r[8],
      nulls: r[9], sample: r[10], analyzed: ts(r[11]), tabAnalyzed: ts(r[12]), rows: r[13], om: r[14] === 'Y'
    };
    c.name = c.owner + '.' + c.table;
    c.full = c.name + '.' + c.col;
    c.prefs = TPREFMAP.get(conKey(c.con, c.name)) || [];
    return c;
  }).filter((c) => COLCATS[c.cat]);
  const COLAGG = rows('colagg').map((r) => ({ con: r[0], om: r[1] === 'Y', cat: r[2], n: r[3], tables: r[4] }));
  const colTruncated = COLS.length >= (META.maxBacklog || 5000);
  // DML monitoring: what the flushed counters cover, and what is about to go stale
  const MON = rows('mon').map((r) => ({ con: r[0], n: r[1], newest: ts(r[2]), level: r[3] }));
  const NEAR = rows('near').map((r) => {
    const b = {
      con: r[0], owner: r[1], table: r[2], part: r[3], sub: r[4], type: r[5] || '', rows: r[6], analyzed: ts(r[7]),
      ins: r[8] || 0, upd: r[9] || 0, del: r[10] || 0, dmlTs: ts(r[11]), th: r[12], om: r[13] === 'Y'
    };
    b.name = [b.owner, b.table, b.part, b.sub].filter(Boolean).join('.');
    b.dml = b.ins + b.upd + b.del;
    b.pct = b.rows ? (100 * b.dml) / b.rows : null;
    b.share = b.pct != null && b.th ? b.pct / b.th : null;
    return b;
  });

  // D.tabs: the tables the Table view knows about (sql/70_tables.sql)
  const TABS = rows('tabs').map((r) => ({
    con: r[0], owner: r[1], table: r[2], ptype: r[3], subptype: r[4], nparts: r[5], interval: r[6] === 'Y',
    rows: r[7], blocks: r[8], analyzed: ts(r[9]), stale: r[10] === 'YES', locked: r[11], om: r[12] === 'Y',
    pStale: r[13] || 0, pMissing: r[14] || 0, pNewest: ts(r[15]), pOldest: ts(r[16]), name: r[1] + '.' + r[2]
  }));
  const TABMAP = new Map(TABS.map((t) => [conKey(t.con, t.name), t]));
  // D.syn: partitions with an incremental-statistics synopsis, per table
  const SYN = new Map(rows('syn').map((r) => [conKey(r[0], r[1] + '.' + r[2]), { parts: r[3], newest: ts(r[4]), oldest: ts(r[5]) }]));
  const tabHref = (con, name) => '#table/' + con + '/' + encodeURIComponent(name);
  // "OWNER.TABLE" as a link into the Table view (the name as is when unknown)
  function tabLink(con, name, label) {
    return name ? '<a class="tl" href="' + tabHref(con, name) + '">' + esc(label || name) + '</a>' : esc(label || '');
  }
  // An object's name with its partition set apart: OWNER.TABLE <pill>partition P1</pill>.
  // With link, the name opens the Table view when the table is known.
  function pieceName(t, link) {
    const base = t.piece ? t.parts.slice(0, -1).join('.') : t.name;
    const name = '<code>' + (link && t.tab ? tabLink(t.con, t.tab, base) : esc(base)) + '</code>';
    return !t.piece ? name : name + ' <span class="pill">' + (/SUB/.test(t.type) ? 'subpartition ' : 'partition ') + esc(t.piece) + '</span>';
  }
  // Backlog and near-stale rows: the table as a link, the partition as a pill;
  // a group's pill lists its partitions on hover
  function objCell(b, withCon) {
    let h = '<code>' + tabLink(b.con, b.owner + '.' + b.table) + '</code>';
    if (b.group) {
      const names = b.members.map((x) => [x.part, x.sub].filter(Boolean).join('.'));
      h += ' <span class="pill" data-tip="' + esc(names.slice(0, 15).map(esc).join('<br>') + (names.length > 15 ? '<br>+' + fmtN(names.length - 15) + ' more' : '')) + '">' + esc(plural(b.members.length, b.type.toLowerCase())) + '</span>';
    } else if (b.part || b.sub) {
      h += ' <span class="pill">' + (b.sub ? 'subpartition ' : 'partition ') + esc([b.part, b.sub].filter(Boolean).join('.')) + '</span>';
    } else if (b.type && b.type !== 'TABLE') {
      h += ' <span class="pill">' + esc(b.type.toLowerCase()) + '</span>';
    }
    return h + (withCon ? ' <span class="pill">' + esc(conName(b.con)) + '</span>' : '');
  }
  // Keep the tail (the partition) when a long name must be cut
  function shortName(name, max) {
    if (name.length <= max) return name;
    const tail = name.slice(-Math.min(18, Math.floor(max / 2)));
    return name.slice(0, max - tail.length - 1) + '\u2026' + tail;
  }

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
    const parts = splitTarget(o.target);
    return parts.join('.') + (o.params.partname && parts.length < 3 ? '.' + o.params.partname : '');
  }
  function opTip(o) {
    return '<b>' + esc(opLabel(o)) + (o.kind === 'auto' ? '' : ' ' + esc(opTarget(o))) + '</b>' +
      '<br>' + esc(conName(o.con)) + ', ' + esc(fmtT(o.start, true)) +
      '<br>' + esc(fmtDur(o.secs)) + (o.stats.n ? ', ' + plural(o.stats.n, 'object') : '') +
      '<br>' + esc(o.v.label) + (o.v.sev !== 'good' ? '<br><span class="muted">' + esc(o.v.why) + '</span>' : '');
  }

  // ---------------------------------------------------------------- tables
  // spec: { cols: [{ key, label, num, cls, html(r), val(r), tip }], rows, sort: [key, dir], limit, href(r), empty,
  //         kids(r) -> rows shown under r when it is opened, rowKey(r), onSort([key, dir]) }
  function renderTable(host, spec) {
    const st = host._t || (host._t = { sort: spec.sort || null, limit: spec.limit || 300 });
    if (!st.open) st.open = new Set();
    const cols = spec.cols;
    let data = spec.rows.slice();
    const cmp = (() => {
      if (!st.sort) return null;
      const c = cols.find((c) => c.key === st.sort[0]);
      if (!c) return null;
      const val = c.val || ((r) => r[c.key]);
      const dir = st.sort[1];
      return (a, b) => {
        const x = val(a), y = val(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      };
    })();
    if (cmp) data.sort(cmp);
    const shown = data.slice(0, st.limit);
    let h = '<div class="tablewrap"><table><thead><tr>';
    cols.forEach((c) => {
      const sorted = st.sort && st.sort[0] === c.key;
      h += '<th data-sort="' + c.key + '" class="' + (c.num ? 'num ' : '') + (sorted ? 'sorted' + (st.sort[1] > 0 ? ' asc' : '') : '') + '"' +
        (c.tip ? ' data-tip="' + esc(c.tip) + '"' : '') + '>' + esc(c.label) + '</th>';
    });
    h += '</tr></thead><tbody>';
    if (!shown.length) h += '<tr><td colspan="' + cols.length + '" class="note">' + esc(spec.empty || 'Nothing to show.') + '</td></tr>';
    const row = (r, kid) => {
      const kids = !kid && spec.kids ? spec.kids(r) : null;
      const key = kids ? String(spec.rowKey(r)) : null;
      const open = kids && st.open.has(key);
      const href = kids ? null : spec.href ? spec.href(r) : null;
      let t = '<tr class="' + (kid ? 'kid ' : '') + (kids ? 'group click' + (open ? ' open' : '') : href ? 'click' : '') + '"' +
        (href ? ' data-href="' + esc(href) + '"' : '') + (kids ? ' data-toggle="' + esc(key) + '"' : '') + '>';
      cols.forEach((c, i) => {
        const v = c.html ? c.html(r) : esc(r[c.key]);
        const disc = i ? '' : kids ? '<button type="button" class="disc" aria-expanded="' + !!open + '" aria-label="' + (open ? 'Close' : 'Open') + ' this group"></button>' : spec.kids ? '<span class="disc-pad"></span>' : '';
        t += '<td class="' + (c.num ? 'num ' : '') + (c.cls || '') + '">' + disc + (v == null ? '' : v) + '</td>';
      });
      t += '</tr>';
      if (open) {
        const ks = cmp ? kids.slice().sort(cmp) : kids;
        ks.slice(0, 500).forEach((k) => { t += row(k, true); });
        if (ks.length > 500) t += '<tr class="kid"><td colspan="' + cols.length + '" class="note">First 500 of ' + fmtN(ks.length) + '.</td></tr>';
      }
      return t;
    };
    shown.forEach((r) => { h += row(r, false); });
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
        if (spec.onSort) spec.onSort(st.sort); else renderTable(host, spec);
      };
    });
    host.querySelectorAll('tr[data-toggle]').forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('a,[data-copy]')) return;
        const k = tr.getAttribute('data-toggle');
        if (st.open.has(k)) st.open.delete(k); else st.open.add(k);
        renderTable(host, spec);
        const again = host.querySelector('tr[data-toggle="' + (window.CSS && CSS.escape ? CSS.escape(k) : k) + '"] .disc');
        if (again) again.focus({ preventScroll: true });
      };
    });
    const more = host.querySelector('.more-rows button');
    if (more) more.onclick = () => { st.limit += 500; renderTable(host, spec); };
  }
  // Sort order in the address: "start" ascending, "-start" descending
  const sortParam = (sort) => (sort ? (sort[1] < 0 ? '-' : '') + sort[0] : '');
  const parseSort = (p, dflt) => (p ? (p[0] === '-' ? [p.slice(1), -1] : [p, 1]) : dflt);

  // Copy to the clipboard; plain http (no secure context) falls back to execCommand
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    (document.querySelector('dialog[open]') || document.body).appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }


  // ---------------------------------------------------------------- charts
  const PLOT_L = 52;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function timeTicks(a, b, width, minPx) {
    const span = b - a;
    const steps = [1e3, 5e3, 15e3, 30e3, 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 3600e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, DAY];
    const step = steps.find((s) => (s / span) * width >= minPx) || DAY;
    const off = tzOff(a) * 60000;
    const out = [];
    for (let t = Math.ceil((a + off) / step) * step - off; t <= b; t += step) out.push(t);
    return { ticks: out, step: step };
  }
  // Day columns shared by the overview charts, in the selected time zone
  function dayAxis(width) {
    const d0 = dayStart(T0), d1 = dayStart(GEN) + DAY;
    const nd = Math.max(1, Math.round((d1 - d0) / DAY));
    const W = Math.max(240, width - PLOT_L - 8);
    const cw = W / nd;
    const col = (t) => Math.round((dayStart(t) - d0) / DAY);
    const tod = (t) => (t - dayStart(t)) / DAY;
    const x = (t) => PLOT_L + (col(t) + tod(t)) * cw;
    return { d0: d0, d1: d1, nd: nd, W: W, cw: cw, col: col, tod: tod, x: x };
  }
  function dayLabels(ax, y) {
    let s = '';
    const every = Math.max(1, Math.ceil(26 / ax.cw));
    let lastMonth = -1;
    for (let i = 0; i < ax.nd; i += every) {
      const ds = ax.d0 + i * DAY;
      const d = new Date(ds + tzOff(ds + 3600e3) * 60000 + 3600e3);
      const m = d.getUTCMonth();
      const lbl = m !== lastMonth ? MONTHS[m] + ' ' + d.getUTCDate() : String(d.getUTCDate());
      lastMonth = m;
      s += '<text x="' + (PLOT_L + (i + 0.5) * ax.cw) + '" y="' + y + '" text-anchor="' + (i === 0 ? 'start' : 'middle') + '" dx="' + (i === 0 ? -ax.cw / 2 + 2 : 0) + '">' + lbl + '</text>';
    }
    return s;
  }
  function isWeekend(ds) {
    const d = new Date(ds + tzOff(ds + 3600e3) * 60000 + 3600e3).getUTCDay();
    return d === 0 || d === 6;
  }
  function dayKey(ms) { return fmtT(ms).slice(0, 10); }

  // The overview's signature chart: days across, hours of the day down.
  // Maintenance windows are the night bands; each automatic run is a bar
  // at its start time (height = duration), each other gather a dot.
  function nightSVG(width, con) {
    const ax = dayAxis(width);
    const top = 4, H = 192, bottom = 22;
    const y = (f) => top + f * H;
    let s = '<svg width="' + width + '" height="' + (top + H + bottom) + '" role="img" aria-label="When statistics were gathered in ' + esc(conName(con)) + ', by day and time of day">' +
      '<defs><pattern id="hatch-' + con + '" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line class="hatch" x1="0" y1="0" x2="0" y2="6"/></pattern></defs>';
    const conWins = WINS.filter((w) => w.con === con && w.maint && w.end > ax.d0 && w.start < GEN);
    const conAuto = AUTO.filter((o) => o.con === con);
    // a closed window in which no automatic run started
    conWins.forEach((w) => { w.empty = !w.open && w.end < GEN && !conAuto.some((o) => o.start >= w.start - 60e3 && o.start <= w.end); });
    const today = ax.col(GEN);
    const noWin = [];
    for (let i = 0; i < ax.nd; i++) {
      const ds = ax.d0 + i * DAY;
      if (isWeekend(ds)) s += '<rect class="weekend" x="' + (PLOT_L + i * ax.cw) + '" y="' + top + '" width="' + ax.cw + '" height="' + H + '"/>';
      // no maintenance window touched this day and no automatic run: database down or windows off
      noWin[i] = i < today && !conWins.some((w) => w.start < ds + DAY && w.end > ds) && !conAuto.some((o) => o.start >= ds && o.start < ds + DAY);
      if (noWin[i]) s += '<rect class="nowin" fill="url(#hatch-' + con + ')" x="' + (PLOT_L + i * ax.cw + 1) + '" y="' + top + '" width="' + Math.max(1, ax.cw - 2) + '" height="' + H + '"/>';
    }
    [0, 6, 12, 18, 24].forEach((h) => {
      s += '<line class="' + (h % 24 ? 'grid' : 'axis') + '" x1="' + PLOT_L + '" x2="' + (PLOT_L + ax.W) + '" y1="' + y(h / 24) + '" y2="' + y(h / 24) + '"/>';
      s += '<text x="' + (PLOT_L - 8) + '" y="' + (y(h / 24) + 4) + '" text-anchor="end">' + String(h).padStart(2, '0') + ':00</text>';
    });
    // clickable day columns (open the runs of that day), with a summary of the day
    const days = [];
    for (let i = 0; i < ax.nd; i++) days.push({ auto: 0, bad: 0, man: 0, wins: [] });
    OPS.forEach((o) => {
      if (o.con !== con || o.kind === 'other' || o.start < ax.d0 || (o.om && !showOM)) return;
      const dd = days[ax.col(o.start)];
      if (!dd) return;
      if (o.kind === 'auto') { dd.auto++; if (o.v.sev !== 'good') dd.bad++; } else dd.man++;
    });
    WINS.forEach((w) => {
      if (w.con !== con || !w.maint || w.start < ax.d0) return;
      const dd = days[ax.col(w.start)];
      if (dd) dd.wins.push(w);
    });
    for (let i = 0; i < ax.nd; i++) {
      const ds = ax.d0 + i * DAY;
      const dd = days[i];
      const d = new Date(ds + tzOff(ds + 3600e3) * 60000 + 3600e3);
      const tip = '<b>' + WEEKDAYS[d.getUTCDay()] + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + '</b>' +
        '<br>' + (dd.auto ? plural(dd.auto, 'automatic run') + (dd.bad ? ', ' + fmtN(dd.bad) + ' with problems' : '') : 'No automatic run') +
        (dd.man ? '<br>' + plural(dd.man, 'manual or custom gather') : '') +
        dd.wins.map((w) => '<br>' + esc(w.name) + ' opened ' + esc(fmtClock(w.start)) + ' for ' + esc(fmtDur((w.end - w.start) / 1000)) + (w.empty ? ', no automatic run in it' : '')).join('') +
        (noWin[i] ? '<br>No maintenance window opened: database down, or the windows disabled' : '') +
        '<br><span class="muted">Click to list this day</span>';
      s += '<rect class="day" x="' + (PLOT_L + i * ax.cw) + '" y="' + top + '" width="' + ax.cw + '" height="' + H + '" data-tip="' + esc(tip) + '" data-href="#runs?day=' + dayKey(ds + 3600e3) + (CONS.size > 1 ? '&con=' + con : '') + '"/>';
    }
    conWins.forEach((w) => {
      let a = Math.max(w.start, ax.d0);
      const e = Math.min(w.end, GEN);
      let guard = 0;
      while (a < e && guard++ < 60) {
        const ds = dayStart(a);
        const segEnd = Math.min(e, ds + DAY);
        const x0 = PLOT_L + ax.col(a) * ax.cw + 1;
        const y0 = y(ax.tod(a)), y1 = segEnd === ds + DAY ? y(1) : y(ax.tod(segEnd));
        s += '<rect class="win' + (w.empty ? ' empty' : '') + '" pointer-events="none" x="' + (x0 + 0.5) + '" y="' + (y0 + 0.5) + '" width="' + Math.max(1, ax.cw - 3) + '" height="' + Math.max(1, y1 - y0 - 1) + '" rx="2"/>';
        if (a === w.start) s += '<rect class="win-edge' + (w.empty ? ' empty' : '') + '" pointer-events="none" x="' + x0 + '" y="' + y0 + '" width="' + Math.max(1, ax.cw - 2) + '" height="2"/>';
        a = segEnd;
      }
    });
    const bw = Math.max(4, ax.cw * 0.62);
    OPS.filter((o) => o.con === con && o.kind === 'gather' && o.start >= ax.d0 && (showOM || !o.om)).forEach((o) => {
      const cx = PLOT_L + (ax.col(o.start) + 0.8) * ax.cw;
      const r = o.v.sev === 'crit' ? 3.2 : Math.min(2.6, Math.max(1.6, ax.cw * 0.09));
      s += '<circle class="dot ' + (o.v.sev === 'crit' ? 'f-crit' : 'f-man') + '" cx="' + cx + '" cy="' + y(ax.tod(o.start)) + '" r="' + r + '" data-href="#run/' + o.key + '" data-tip="' + esc(opTip(o)) + '"/>';
    });
    conAuto.filter((o) => o.start >= ax.d0).sort((a, b) => SEV_RANK[a.v.sev] - SEV_RANK[b.v.sev]).forEach((o) => {
      const x0 = PLOT_L + (ax.col(o.start) + 0.06) * ax.cw;
      // short runs still get a mark big enough to see and to click
      const h = Math.max(7, (o.secs / 86400) * H);
      const y0 = Math.min(y(ax.tod(o.start)), y(1) - h);
      s += '<rect class="mark f-' + o.v.sev + '" x="' + x0 + '" y="' + y0 + '" width="' + bw + '" height="' + h + '" rx="1.5" data-href="#run/' + o.key + '" data-tip="' + esc(opTip(o)) + '"/>';
    });
    const nx = PLOT_L + ax.col(GEN) * ax.cw;
    s += '<line class="now" x1="' + nx + '" x2="' + (nx + ax.cw) + '" y1="' + y(ax.tod(GEN)) + '" y2="' + y(ax.tod(GEN)) + '"/>';
    s += dayLabels(ax, top + H + 16);
    return s + '</svg>';
  }

  // One column per automatic run on the same day axis as the night chart
  function runColumnsSVG(width, runs, val, fmt, label, trend) {
    const ax = dayAxis(width);
    const top = 8, H = 132, bottom = 22;
    const max = niceMax(Math.max(0, ...runs.map(val)));
    const y = (v) => top + (H - top - bottom) * (1 - v / max);
    const cons = [...new Set(AUTO.map((o) => o.con))].sort((a, b) => a - b);
    let s = '<svg width="' + width + '" height="' + H + '" role="img" aria-label="' + esc(label) + '">';
    for (let i = 0; i < ax.nd; i++) {
      if (isWeekend(ax.d0 + i * DAY)) s += '<rect class="weekend" x="' + (PLOT_L + i * ax.cw) + '" y="' + top + '" width="' + ax.cw + '" height="' + (H - top - bottom) + '"/>';
    }
    [0, max / 2, max].forEach((v) => {
      s += '<line class="' + (v ? 'grid' : 'axis') + '" x1="' + PLOT_L + '" x2="' + (PLOT_L + ax.W) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      s += '<text x="' + (PLOT_L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(v ? fmt(v) : '0') + '</text>';
    });
    let tr = '';
    if (trend) {
      cons.forEach((c, k) => {
        const rs = runs.filter((o) => o.con === c);
        if (rs.length < 4) return;
        const pts = rs.map((o, i) => {
          const win = rs.slice(Math.max(0, i - 6), i + 1).map(val).sort((a, b) => a - b);
          return ax.x(o.start).toFixed(1) + ',' + y(win[Math.floor(win.length / 2)]).toFixed(1);
        });
        tr += '<polyline class="trend t-s' + (k % 3 + 1) + '" pointer-events="none" points="' + pts.join(' ') + '"/>';
      });
    }
    runs.forEach((o) => {
      const v = val(o);
      const cx = ax.x(o.start);
      const yy = y(v);
      const ci = cons.indexOf(o.con) % 3 + 1;
      const w = Math.max(3, Math.min(8, ax.cw * 0.22));
      s += '<rect class="hit" x="' + (cx - 5) + '" y="' + top + '" width="10" height="' + (H - top - bottom) + '" data-href="#run/' + o.key + '" data-tip="' + esc(opTip(o)) + '"/>';
      if (v > 0) {
        const r = Math.min(2, w / 2, y(0) - yy);
        s += '<path class="mark f-s' + ci + '" pointer-events="none" d="M' + (cx - w / 2) + ',' + y(0) + 'V' + (yy + r) + 'q0,-' + r + ' ' + r + ',-' + r + 'H' + (cx + w / 2 - r) + 'q' + r + ',0 ' + r + ',' + r + 'V' + y(0) + 'Z"/>';
      }
    });
    s += tr + dayLabels(ax, H - 4);
    return s + '</svg>';
  }

  // One run's objects over time.  Up to 40 objects: one labelled row each.
  // More: packed lanes, each object in the first lane free at its start, so
  // serial work shares a lane and concurrent work stacks.
  const typeClass = (t) => (t.status === 'FAILED' ? 'f-crit' : t.status !== 'COMPLETED' ? 'f-warn'
    : /INDEX/.test(t.type) ? 'f-s3' : /PARTITION/.test(t.type) ? 'f-s2' : 'f-s1');
  // Tooltip of one object row: the partition named apart from its table
  function objTip(t) {
    const head = t.piece ? '<b>' + esc(t.parts.slice(0, -1).join('.')) + '</b><br>' + esc(t.type.toLowerCase()) + ' <b>' + esc(t.piece) + '</b>'
      : '<b>' + esc(t.name) + '</b><br>' + esc(t.type.toLowerCase());
    return head + ', ' + esc(t.status.toLowerCase()) +
      '<br>' + esc(fmtClock(t.start, true)) + ', ' + esc(fmtDur(t.secs)) + (t.size != null ? ', size ' + fmtN(t.size) : '') +
      (t.hist.length ? '<br>Histograms: ' + esc(t.hist.join(', ')) : '') + (t.error ? '<br><span class="muted">' + esc(t.error) + '</span>' : '');
  }
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
        if (i < 0) i = lanes.length < MAXL ? lanes.push(end) - 1 : lanes.indexOf(Math.min(...lanes));
        lanes[i] = Math.max(lanes[i] || 0, end);
        lane.set(t, i);
      });
    }
    const n = rowsMode ? timed.length : lanes.length;
    const rowH = rowsMode ? 20 : 16;
    const L = rowsMode ? 290 : 40, R = 8, top = 4, bottom = 22;
    const W = Math.max(200, width - L - R);
    const from = Math.min(o.start, ...timed.map((t) => t.start));
    const to = Math.max(o.endEff, ...timed.map((t) => t.end || t.start), from + 1000);
    const x = (t) => L + ((t - from) / (to - from)) * W;
    const H = top + n * rowH + bottom;
    const tt = timeTicks(from, to, W, 90);
    let s = '<svg width="' + width + '" height="' + H + '" role="img" aria-label="Objects of this run over time">';
    tt.ticks.forEach((t) => { s += '<line class="grid" x1="' + x(t) + '" x2="' + x(t) + '" y1="' + top + '" y2="' + (H - bottom) + '"/>'; });
    if (!rowsMode) for (let i = 0; i < n; i++) s += '<text x="' + (L - 10) + '" y="' + (top + i * rowH + 12) + '" text-anchor="end">' + (i + 1) + '</text>';
    if (o.window && o.window.end > from && o.window.end <= to) s += '<line class="end-line" x1="' + x(o.window.end) + '" x2="' + x(o.window.end) + '" y1="' + top + '" y2="' + (H - bottom) + '"/>';
    timed.forEach((t, i) => {
      const y = top + (rowsMode ? i : lane.get(t)) * rowH;
      const a = x(t.start);
      const w = Math.max(1, x(t.end || t.start) - a - (rowsMode ? 0 : 1));
      const tip = objTip(t);
      if (rowsMode) {
        s += '<text x="0" y="' + (y + 14) + '" style="fill:var(--ink-2)">' + esc(shortName(t.name, 42)) + '</text>';
        s += '<rect class="hit" x="0" y="' + y + '" width="' + (L + W) + '" height="' + rowH + '" data-tip="' + esc(tip) + '"/>';
        s += '<rect class="mark ' + typeClass(t) + '" pointer-events="none" x="' + a + '" y="' + (y + 4) + '" width="' + Math.max(2, w) + '" height="' + (rowH - 8) + '" rx="2"/>';
      } else {
        s += '<rect class="mark ' + typeClass(t) + '" x="' + a + '" y="' + (y + 2) + '" width="' + Math.max(1.5, w) + '" height="' + (rowH - 4) + '" data-tip="' + esc(tip) + '"/>';
      }
    });
    tt.ticks.forEach((t) => { s += '<text x="' + x(t) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(fmtClock(t, tt.step < 60e3)) + '</text>'; });
    return { svg: s + '</svg>', capped: lanes.length >= MAXL };
  }

  // ------------------------------------------------------------ chrome
  const ICON_THEME = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/></svg>';
  const app = document.getElementById('app');
  function scopeText() {
    if (META.cdb !== 'YES') return 'Whole database';
    return META.conId === 1 ? 'All containers' : 'Pluggable database ' + META.con;
  }
  function chrome() {
    const dbo = dbOffsetMin();
    app.innerHTML =
      '<header class="top"><div class="ident"><span class="db">' + esc(META.db || '?') + '</span>' +
      '<span class="scope">' + esc(scopeText()) + ', last ' + DAYS + ' days</span></div>' +
      '<nav class="tabs" aria-label="Views"><a href="#overview" data-v="overview">Overview</a><a href="#runs" data-v="runs">Runs</a>' +
      '<a href="#backlog" data-v="backlog">Needs statistics</a><a href="#columns" data-v="columns">Columns</a><a href="#table" data-v="table">Table</a><a href="#config" data-v="config">Setup</a></nav>' +
      '<div class="prefs"><label data-tip="Include gathers, failures and stale objects in Oracle-maintained schemas (SYS, SYSTEM, AUDSYS, ...). Automatic runs always show."><input type="checkbox" id="om"> Oracle schemas</label>' +
      '<label>Times <select id="tz">' +
      '<option value="db">DB host (' + offLabel(dbo) + ')</option><option value="utc">UTC</option><option value="local">This browser (' + offLabel(-new Date().getTimezoneOffset()) + ')</option>' +
      '</select></label><button type="button" class="icon-btn" id="theme" aria-label="Switch between light and dark">' + ICON_THEME + '</button></div></header>' +
      '<main id="view"></main>' +
      '<footer class="foot"><span>Generated ' + esc(fmtT(GEN)) + ' (' + esc(tzMode === 'utc' ? 'UTC' : offLabel(tzOff(GEN))) + ')</span><span>' + esc(META.db || '') + ' ' + esc(META.version || '') + ' on ' + esc(META.host || '') +
      '</span><span>Collected as ' + esc(META.user || '') + ' in ' + esc(META.con || '') + '</span><span>Read-only; nothing was changed in the database</span></footer>' +
      '<dialog class="drawer" id="drawer" aria-labelledby="drawer-title"></dialog><div id="tip" role="tooltip" popover="manual"></div>';
    const tz = document.getElementById('tz');
    tz.value = tzMode;
    tz.onchange = () => { tzMode = tz.value; if (store) store.setItem('gd.tz', tzMode); chrome(); wireDrawer(); renderedBase = null; keepScroll = true; route(); };
    const om = document.getElementById('om');
    om.checked = showOM;
    om.onchange = () => setShowOM(om.checked);
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

  function setShowOM(on) {
    showOM = on;
    if (store) store.setItem('gd.om', on ? '1' : '0');
    const box = document.getElementById('om');
    if (box) box.checked = on;
    renderedBase = null;
    keepScroll = true;
    route();
  }
  // "+12 in Oracle schemas": a hint with a one-click way to show them
  function omHint(n) {
    return !showOM && n ? ' <button type="button" class="linkish" data-om-on>+' + fmtN(n) + ' in Oracle schemas</button>' : '';
  }

  // The tooltip lives in the top layer (popover) so it shows over the run
  // drawer, which is a modal dialog.  Older browsers: display toggling.
  const POP = 'showPopover' in HTMLElement.prototype;
  function hideTip() {
    const tip = document.getElementById('tip');
    if (!tip) return;
    if (POP) { if (tip.matches(':popover-open')) tip.hidePopover(); } else tip.style.display = 'none';
  }
  function wireGlobal() {
    document.addEventListener('mousemove', (e) => {
      const tip = document.getElementById('tip');
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) { hideTip(); return; }
      if (tip._el !== el) { tip.innerHTML = el.getAttribute('data-tip'); tip._el = el; }
      if (POP) { if (!tip.matches(':popover-open')) tip.showPopover(); } else tip.style.display = 'block';
      const r = tip.getBoundingClientRect();
      let left = e.clientX + 14, topY = e.clientY + 16;
      if (left + r.width > innerWidth - 8) left = e.clientX - r.width - 14;
      if (topY + r.height > innerHeight - 8) topY = e.clientY - r.height - 14;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.max(4, topY) + 'px';
    });
    document.addEventListener('click', (e) => {
      const cp = e.target.closest && e.target.closest('[data-copy]');
      if (cp) {
        copyText(cp.getAttribute('data-copy')).then(() => {
          const was = cp.textContent;
          cp.textContent = 'Copied';
          cp.classList.add('done');
          setTimeout(() => { cp.textContent = was; cp.classList.remove('done'); }, 1400);
        });
        return;
      }
      if (e.target.closest && e.target.closest('[data-om-on]')) { setShowOM(true); return; }
      const el = e.target.closest && e.target.closest('[data-href]');
      if (el && !e.target.closest('a,button,select,input,label')) location.hash = el.getAttribute('data-href');
    });
    document.addEventListener('keydown', (e) => {
      const typing = e.target.closest && e.target.closest('input,select,textarea');
      const drawer = document.getElementById('drawer');
      if (e.key === '/' && !typing) {
        const box = (drawer.open ? drawer : document.getElementById('view')).querySelector('input[type="search"]');
        if (box) { e.preventDefault(); box.focus(); }
      } else if (drawer.open && !typing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const b = drawer.querySelector(e.key === 'ArrowLeft' ? '#prev' : '#next');
        if (b && !b.disabled) b.click();
      }
    });
    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { renderedBase = null; keepScroll = true; route(); }, 150); });
  }

  function missingBox() {
    if (!missing.length) return '';
    return '<div class="warnbox"><b>Not collected:</b> ' + missing.map(esc).join(', ') +
      '. Their SQL failed (missing grant, or an object this release lacks); the error text is in the HTML source next to the dataset name.</div>';
  }
  function sec(title, sub, body, end, cls) {
    return '<section class="sec' + (cls ? ' ' + cls : '') + '"><header><h2>' + esc(title) + '</h2>' + (sub ? '<p class="sub">' + sub + '</p>' : '') +
      (end ? '<div class="end">' + end + '</div>' : '') + '</header>' + body + '</section>';
  }
  function seg(id, options, value) {
    return '<div class="seg" role="group" id="' + id + '">' + options.map((o) =>
      '<button type="button" data-val="' + esc(o[0]) + '" aria-pressed="' + (o[0] === value) + '">' + esc(o[1]) + (o[2] != null ? '<span class="n">' + fmtN(o[2]) + '</span>' : '') + '</button>').join('') + '</div>';
  }
  function wireSeg(root, id, onPick) {
    const g = root.querySelector('#' + id);
    if (!g) return;
    g.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        g.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        onPick(b.getAttribute('data-val'));
      };
    });
  }
  function consLegend() {
    const cons = [...new Set(AUTO.map((o) => o.con))].sort((a, b) => a - b);
    if (cons.length < 2) return '';
    return '<div class="legend">' + cons.map((c, i) => '<span><b class="s' + (i % 3 + 1) + '"></b>' + esc(conName(c)) + '</span>').join('') + '</div>';
  }

  // ------------------------------------------------------------ overview
  function appBacklogCounts() {
    const cnt = {};
    BL.filter((b) => !b.om).forEach((b) => { cnt[b.cat] = (cnt[b.cat] || 0) + 1; });
    return cnt;
  }
  const andList = (xs) => (xs.length < 3 ? xs.join(' and ') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);
  // Containers whose last automatic run is more than two days old
  function stalledCons() {
    return [...lastAuto.entries()].filter((e) => GEN - e[1].start > 2 * DAY).map((e) => e[0]).sort((a, b) => a - b);
  }
  function headline() {
    const bad = AUTO.filter((o) => o.v.sev === 'crit').length;
    const warn = AUTO.filter((o) => o.v.sev === 'warn').length;
    const cnt = appBacklogCounts();
    const missed = (cnt.missed || 0) + (cnt.failed || 0);
    const off = ATC.filter((a) => a.status !== 'ENABLED');
    const stalled = stalledCons();
    let sev, text, pre = '';
    if (!AUTO.length) { sev = 'crit'; text = 'No automatic statistics run in the last ' + DAYS + ' days.'; }
    else if (off.length) { sev = 'crit'; text = 'The automatic statistics task is disabled in ' + andList(off.map((a) => conName(a.con))) + '.'; }
    else if (stalled.length) {
      const last = Math.max(...stalled.map((c) => lastAuto.get(c).start));
      const days = Math.floor((GEN - last) / DAY);
      sev = days >= 7 ? 'crit' : 'warn';
      text = 'No automatic run in ' + andList(stalled.map(conName)) + ' for ' + plural(days, 'day') + '.';
      const since = WINS.filter((w) => stalled.includes(w.con) && w.maint && w.start > last).length;
      pre = (since ? plural(since, 'maintenance window') + ' opened since ' + fmtT(last) + ' without one.'
        : 'No maintenance window has opened since ' + fmtT(last) + ': the database was down, or the windows are disabled.') +
        (bad ? ' Before that, ' + fmtN(bad) + ' of ' + plural(AUTO.length, 'run') + ' did not finish their work.'
          : ' Before that, ' + (warn ? 'all ' + plural(AUTO.length, 'run') + ' finished, ' + fmtN(warn) + ' with objects that failed.' : 'all ' + plural(AUTO.length, 'run') + ' gathered everything they picked.'));
    }
    else if (bad) { sev = 'crit'; text = fmtN(bad) + ' of ' + plural(AUTO.length, 'automatic run') + ' did not finish their work.'; }
    else if (missed) { sev = 'crit'; text = plural(missed, 'application object') + (missed === 1 ? ' is' : ' are') + ' stale although the automatic job already ran.'; }
    else if (warn) { sev = 'warn'; text = 'All ' + plural(AUTO.length, 'automatic run') + ' finished, ' + fmtN(warn) + ' with objects that failed.'; }
    else { sev = 'good'; text = 'All ' + plural(AUTO.length, 'automatic run') + ' in ' + DAYS + ' days gathered everything they picked.'; }
    const appStale = BLAGG.filter((b) => !b.om && b.type !== 'FIXED TABLE' && b.stale).reduce((a, b) => a + b.n, 0);
    let sub;
    if (missing.includes('bl')) sub = 'What still needs statistics was not collected.';
    else if (!appStale && !cnt.missing) sub = 'No application table or partition needs statistics right now.';
    else sub = plural(appStale, 'application table or partition', 'application tables and partitions') + (appStale === 1 ? ' is' : ' are') + ' stale right now' +
      (cnt.fresh ? '; ' + fmtN(cnt.fresh) + ' changed after the last automatic run and ' + (cnt.fresh === 1 ? 'is' : 'are') + ' next in line' : '') + '.';
    return { sev: sev, text: text, sub: (pre ? pre + ' ' : '') + sub };
  }

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
        add('crit', 'No automatic statistics run in ' + esc(conName(c)) + ' in the last ' + DAYS + ' days.', 'See Setup: task status and maintenance windows.');
        return;
      }
      const bad = runs.filter((o) => o.v.sev === 'crit');
      const warn = runs.filter((o) => o.v.sev === 'warn');
      const durs = runs.map((o) => o.secs).sort((a, b) => a - b);
      const med = durs[Math.floor(durs.length / 2)];
      add(bad.length ? 'crit' : warn.length ? 'warn' : 'good', esc(conName(c)) + ': <a href="#runs?kind=auto&con=' + c + '">' + plural(runs.length, 'automatic run') + '</a>' +
        (bad.length ? ', <a href="#runs?kind=auto&con=' + c + '&sev=crit">' + fmtN(bad.length) + ' did not finish</a>' : '') +
        (warn.length ? ', <a href="#runs?kind=auto&con=' + c + '&sev=warn">' + fmtN(warn.length) + ' with failed objects</a>' : '') +
        (!bad.length && !warn.length ? ', all complete' : '') + '.',
        'Typical run ' + fmtDur(med) + ', longest ' + fmtDur(durs[durs.length - 1]) + '. Last run ' + fmtT(la.start) + ', ' + fmtAgo(la.start) + '.');
      if (GEN - la.start > 2 * DAY) add('warn', 'The last automatic run in ' + esc(conName(c)) + ' started ' + esc(fmtAgo(la.start)) + '.', 'It normally runs in every maintenance window.');
      const wins = WINS.filter((w) => w.con === c && w.maint && !w.open && w.start >= T0 && w.end > w.start);
      const empty = wins.filter((w) => !runs.some((o) => o.start >= w.start - 60e3 && o.start <= w.end));
      if (empty.length) add('warn', esc(conName(c)) + ': ' + plural(empty.length, 'maintenance window') + ' of ' + fmtN(wins.length) + ' passed without an automatic run.', 'Last: ' + esc(empty[empty.length - 1].name) + ' at ' + fmtT(empty[empty.length - 1].start) + '.');
      const atEnd = runs.filter((o) => o.window && o.end && o.window.end - o.end < 120e3 && o.window.end > o.start);
      if (atEnd.length) add('crit', esc(conName(c)) + ': ' + plural(atEnd.length, 'run') + ' ended at the close of the maintenance window.', 'The window is too short for the work.');
    });
    const rec = FAILLIST.filter((x) => x.runs.size >= 2 && !x.benign && (showOM || !x.om));
    if (rec.length) add('warn', '<a href="#overview/failures">' + plural(rec.length, 'object') + ' failed in more than one run</a>, for example <code>' + esc(rec[0].target) + '</code> in ' + plural(rec[0].runs.size, 'run') + '.', esc(rec[0].error));
    const cnt = appBacklogCounts();
    if (cnt.missed || cnt.failed) {
      add('crit', '<a href="#backlog?cat=' + (cnt.missed ? 'missed' : 'failed') + '">' + (cnt.missed ? plural(cnt.missed, 'application object') + ' missed by the last automatic run' : '') +
        (cnt.missed && cnt.failed ? ', ' : '') + (cnt.failed ? plural(cnt.failed, 'object') + ' whose last gather failed' : '') + '</a>.', 'Stale now, after the job ran.');
    }
    const basic = MON.filter((m) => /^BASIC$/i.test(m.level || ''));
    if (basic.length) add('crit', 'STATISTICS_LEVEL is <b>BASIC</b> in ' + esc(META.con) + ': DML monitoring is off.', 'Nothing is counted in DBA_TAB_MODIFICATIONS, so no table ever turns stale and the automatic job regathers nothing.');
    const colCnt = {};
    COLAGG.filter((a) => showOM || !a.om).forEach((a) => { colCnt[a.cat] = (colCnt[a.cat] || 0) + a.n; });
    const colCats = COLCAT_ORDER.filter((c) => colCnt[c]);
    if (colCats.length) {
      const n = colCats.reduce((a, c) => a + colCnt[c], 0);
      add(colCats.some((c) => COLCATS[c].sev === 'warn') ? 'warn' : 'info',
        '<a href="#columns">' + plural(n, 'column') + (showOM ? '' : ' in application schemas') + '</a> with doubtful statistics: ' +
        colCats.map((c) => '<a href="#columns?cat=' + c + '">' + fmtN(colCnt[c]) + ' ' + COLCAT_SHORT[c] + '</a>').join(', ') + '.',
        'Table statistics fine, column statistics not.');
    }
    const near = NEAR.filter((b) => showOM || !b.om);
    if (near.length) {
      add('info', '<a href="#backlog">' + plural(near.length, 'table or partition', 'tables and partitions') + '</a> ' + (near.length === 1 ? 'is' : 'are') + ' at least halfway to stale' + (showOM ? '' : ' in application schemas') + '.',
        'From the flushed DML counters only.' + (near.length >= 2000 ? ' The report holds the first 2,000.' : ''));
    }
    const gs = GATHERS.filter((o) => showOM || !o.om);
    const mf = gs.filter((o) => o.v.sev === 'crit');
    if (gs.length) add(mf.length ? 'warn' : 'good', '<a href="#runs?kind=gather">' + plural(gs.length, 'manual or custom gather') + '</a>' + (showOM ? '' : ' in application schemas') + (mf.length ? ', <a href="#runs?kind=gather&sev=crit">' + fmtN(mf.length) + ' failed</a>' : ', none failed') + '.');
    const ben = FAILLIST.filter((x) => x.benign);
    if (ben.length) {
      const names = [...new Set(ben.map((x) => x.target))];
      add('info', 'Not counted as failures: ' + names.map((n) => '<code>' + esc(n) + '</code>').join(', ') + '.', esc(ben[0].benign.why));
    }
    return f.sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev]);
  }

  let histMetric = 'secs';
  function viewOverview(sub) {
    const v = document.getElementById('view');
    const hl = headline();
    const gs = GATHERS.filter((o) => showOM || !o.om);
    const objs = AUTO.concat(gs).reduce((a, o) => a + o.stats.done, 0);
    const hist = AUTO.concat(gs).reduce((a, o) => a + o.stats.hist, 0);
    const realFails = FAILLIST.filter((f) => !f.benign && (showOM || !f.om));
    const failedObjs = new Set(realFails.map((f) => f.con + '|' + f.target)).size;
    const totalSecs = AUTO.concat(gs).reduce((a, o) => a + o.secs, 0);
    const cnt = appBacklogCounts();

    let h = missingBox();
    h += '<section class="hero"><h1 class="verdict"><span class="mark ' + hl.sev + '" aria-hidden="true">' + SEV_ICON[hl.sev] + '</span><span>' + esc(hl.text) + '</span></h1>' +
      '<p class="verdict-sub">' + esc(hl.sub) + '</p>' +
      '<dl class="stats">' +
      '<div><dt>Automatic runs</dt><dd><a href="#runs?kind=auto">' + fmtN(AUTO.length) + '</a></dd></div>' +
      '<div><dt>Manual or custom gathers</dt><dd><a href="#runs?kind=gather">' + fmtN(gs.length) + '</a>' + (showOM ? '' : '<small>application schemas</small>') + '</dd></div>' +
      '<div><dt>Objects gathered</dt><dd>' + compact(objs) + '<small>' + compact(hist) + ' with histograms</small></dd></div>' +
      '<div><dt>Objects that failed</dt><dd><a href="#overview/failures">' + fmtN(failedObjs) + '</a></dd></div>' +
      '<div><dt>Time spent gathering</dt><dd>' + esc(fmtDur(totalSecs)) + '</dd></div>' +
      '</dl></section>';

    const cons = [...new Set(OPS.filter((o) => o.kind !== 'other').map((o) => o.con).concat(ATC.map((a) => a.con)))].sort((a, b) => a - b);
    h += sec('When statistics were gathered', 'One column per day, midnight to midnight. Click a run to open it, an empty spot to list the day.',
      '<div class="surface">' + cons.map((c) => '<div class="chart night" data-con="' + c + '">' + (cons.length > 1 ? '<div class="chart-head"><h3>' + esc(conName(c)) + '</h3></div>' : '') + '<div class="plot"></div></div>').join('') +
      '<div class="legend"><span><b class="win"></b>Maintenance window</span><span><b class="good"></b>Automatic run, complete</span><span><b class="warn"></b>Some objects failed</span><span><b class="crit"></b>Failed or did not finish</span><span><b class="dot"></b>Manual or custom gather</span><span><b class="weekend"></b>Weekend</span>' +
      '<span><b class="win-empty"></b>Window without an automatic run</span><span><b class="nowin"></b>No window opened</span></div></div>');

    const needRows = CAT_ORDER.filter((c) => cnt[c]);
    const needMax = Math.max(1, ...needRows.map((c) => cnt[c]));
    const needs = needRows.length ? '<ul class="needs">' + needRows.map((c) =>
      '<li><a href="#backlog?cat=' + c + '"><span>' + sevBadge(CATS[c].sev, CATS[c].title) + '</span><span class="n">' + fmtN(cnt[c]) + '</span>' +
      '<span class="bar ' + CATS[c].sev + '"><b style="inline-size:' + (100 * cnt[c] / needMax).toFixed(1) + '%"></b></span></a></li>').join('') + '</ul>' +
      '<p class="note" style="margin-block-start:0.75rem">Application schemas only. Staleness as of the last DML-monitoring flush.</p>'
      : '<p class="muted">' + (missing.includes('bl') ? 'Not collected.' : 'Nothing: every application table and partition has fresh statistics.') + '</p>';
    h += '<div class="split wide-narrow">' + sec('Findings', '', '<ul class="findings">' + findings().map((x) => '<li>' + sevBadge(x.sev, '') + '<div>' + x.html + (x.more ? '<div class="more">' + x.more + '</div>' : '') + '</div></li>').join('') + '</ul>') +
      sec('Needs statistics now', '', needs) + '</div>';

    h += sec('Automatic runs', 'One column per run. Line: median of the last 7.',
      '<div class="surface"><div class="plot" id="c-hist"></div>' + consLegend() + '</div>',
      seg('hist-metric', [['secs', 'Run time'], ['objects', 'Objects'], ['failed', 'Failed objects']], histMetric));
    h += '<div class="split">' + sec('Failures', 'Same object and error, counted across runs.', '<div id="t-fail"></div>', '', 'failures') +
      sec('Slowest objects', 'Gather time over the period.', '<div id="t-heavy"></div>') + '</div>';
    v.innerHTML = h;

    v.querySelectorAll('.chart.night').forEach((el) => {
      const p = el.querySelector('.plot');
      p.innerHTML = nightSVG(p.clientWidth, Number(el.getAttribute('data-con')));
    });
    const autoSorted = AUTO.slice().sort((a, b) => a.start - b.start);
    const drawHist = () => {
      const p = v.querySelector('#c-hist');
      if (!autoSorted.length) { p.innerHTML = '<p class="muted">No automatic runs in the period.</p>'; return; }
      const m = { secs: [(o) => o.secs, fmtDur, 'Run time per automatic run'], objects: [(o) => o.stats.n, compact, 'Objects per automatic run'], failed: [(o) => o.stats.failed + o.stats.notDone, compact, 'Failed objects per automatic run'] }[histMetric];
      p.innerHTML = runColumnsSVG(p.clientWidth, autoSorted, m[0], m[1], m[2], histMetric !== 'failed');
    };
    drawHist();
    wireSeg(v, 'hist-metric', (val) => { histMetric = val; drawHist(); });

    const failHost = v.querySelector('#t-fail');
    renderTable(failHost, {
      rows: realFails, sort: ['runs', -1], limit: sub === 'failures' ? 1000 : 8, empty: 'No object failed in the period' + (showOM ? '.' : ' in application schemas.'),
      href: (f) => '#run/' + f.lastOp.key,
      cols: [
        { key: 'target', label: 'Object', cls: 'wrap', html: (f) => '<code>' + esc(f.target) + '</code>' + (CONS.size > 1 ? ' <span class="pill">' + esc(conName(f.con)) + '</span>' : '') +
          '<div class="err sub-err">' + esc(f.error) + '</div>' },
        { key: 'runs', label: 'Runs', num: true, val: (f) => f.runs.size, html: (f) => fmtN(f.runs.size) },
        { key: 'last', label: 'Last', cls: 't', html: (f) => esc(fmtT(f.last)) }
      ]
    });
    const ben = FAILLIST.filter((f) => f.benign);
    const omFails = FAILLIST.filter((f) => !f.benign && f.om).length;
    const notes = [];
    if (ben.length) notes.push('Expected, not counted: ' + [...new Set(ben.map((f) => f.target))].map((t) => '<code>' + esc(t) + '</code>').join(', ') +
      ' in ' + plural(new Set(ben.flatMap((f) => [...f.runs])).size, 'run') + '.');
    if (omFails && !showOM) notes.push(omHint(omFails).trim() + ' not shown.');
    if (notes.length) failHost.insertAdjacentHTML('beforeend', '<p class="note table-note">' + notes.join(' ') + '</p>');
    if (sub === 'failures') v.querySelector('.failures').scrollIntoView();

    const heavy = new Map();
    const heavyOM = new Set();
    TASKS.forEach((t) => {
      if (!t.op || t.op.kind === 'other' || t.secs == null) return;
      if (!showOM && isOM(t.con, t.parts[0])) { heavyOM.add(t.con + '|' + t.name); return; }
      const k = t.con + '|' + t.name;
      let x = heavy.get(k);
      if (!x) heavy.set(k, x = { con: t.con, name: t.name, type: t.type, tab: t.tab, piece: t.piece, parts: t.parts, n: 0, secs: 0, max: 0, last: null });
      x.n++; x.secs += t.secs; x.max = Math.max(x.max, t.secs);
      if (!x.last || t.start > x.last.start) x.last = t;
    });
    const hl2 = [...heavy.values()].sort((a, b) => b.secs - a.secs).slice(0, 200);
    const hmax = hl2.length ? hl2[0].secs : 1;
    renderTable(v.querySelector('#t-heavy'), {
      rows: hl2, sort: ['secs', -1], limit: 8, empty: 'No per-object timings recorded.',
      href: (x) => '#run/' + x.last.op.key,
      cols: [
        { key: 'name', label: 'Object', cls: 'wrap', html: (x) => pieceName(x, true) + (x.piece ? '' : ' <span class="pill">' + esc(x.type.toLowerCase()) + '</span>') + (CONS.size > 1 ? ' <span class="pill">' + esc(conName(x.con)) + '</span>' : '') },
        { key: 'n', label: 'Gathers', num: true, html: (x) => fmtN(x.n) },
        { key: 'secs', label: 'Total', num: true, html: (x) => '<span class="durbar">' + esc(fmtDur(x.secs)) + '<span><b style="inline-size:' + (100 * x.secs / hmax).toFixed(1) + '%"></b></span></span>' }
      ]
    });
    if (heavyOM.size && !showOM) v.querySelector('#t-heavy').insertAdjacentHTML('beforeend', '<p class="note table-note">Application schemas only.' + omHint(heavyOM.size) + '</p>');
  }

  // ------------------------------------------------------------ runs
  // A batch with at least two matching calls becomes one row that opens up
  function batchRow(b, members) {
    const worst = members.reduce((w, o) => (SEV_RANK[o.v.sev] > SEV_RANK[w.v.sev] ? o : w), members[0]);
    const bad = members.filter((o) => o.v.sev !== 'good').length;
    const ops = new Map();
    members.forEach((o) => ops.set(o.op, (ops.get(o.op) || 0) + 1));
    const owners = [...new Set(members.map((o) => o.owner).filter(Boolean))];
    const targets = new Set(members.map((o) => opTarget(o))).size;
    const st = { n: 0, failed: 0, notDone: 0 };
    members.forEach((o) => { st.n += o.stats.n; st.failed += o.stats.failed - (o.v.expected || 0); st.notDone += o.stats.notDone; });
    return {
      batch: b, members: members, con: b.con, job: b.job, sid: b.sid, kind: members[0].kind,
      start: members[0].start, end: Math.max(...members.map((o) => o.endEff)),
      secs: (Math.max(...members.map((o) => o.endEff)) - members[0].start) / 1000,
      v: bad ? { sev: worst.v.sev, label: fmtN(bad) + ' with problems', why: fmtN(bad) + ' of ' + plural(members.length, 'call') + ' with problems. Worst: ' + worst.v.label + '. ' + worst.v.why } : { sev: 'good', label: 'Complete', why: 'Every call in this batch completed.' },
      ops: [...ops.entries()].sort((x, y) => y[1] - x[1]), owners: owners, targets: targets, stats: st,
      window: members[0].window
    };
  }
  const runsState = { kind: 'gathers', con: '', sev: '', text: '', day: '', group: true };
  function viewRuns(q) {
    const v = document.getElementById('view');
    const f = runsState;
    f.kind = q.get('kind') || 'gathers'; f.con = q.get('con') || ''; f.sev = q.get('sev') || ''; f.text = q.get('q') || ''; f.day = q.get('day') || '';
    f.group = q.get('g') !== '0';
    const consAll = [...new Set(OPS.map((o) => o.con))].sort((a, b) => a - b);
    v.innerHTML = missingBox() + sec('Runs', 'Every DBMS_STATS operation in the last ' + DAYS + ' days. Back-to-back calls of one job or session form a group. The text filter also matches the objects a run gathered.',
      '<div class="filters">' + seg('f-kind', [['gathers', 'All gathers'], ['auto', 'Automatic'], ['gather', 'Manual or custom'], ['all', 'Every DBMS_STATS call']], f.kind) +
      '<div id="f-sev-host"></div>' +
      (consAll.length > 1 ? '<label>Container <select id="f-con"><option value="">All</option>' + consAll.map((c) => '<option value="' + c + '">' + esc(conName(c)) + '</option>').join('') + '</select></label>' : '') +
      '<input type="search" id="f-q" placeholder="Filter by operation, object, job or error" aria-label="Filter runs">' +
      seg('f-group', [['1', 'Grouped'], ['0', 'Every call']], f.group ? '1' : '0') +
      '<span id="f-day"></span><span class="count" id="f-n"></span></div><div id="t-runs"></div>');
    const sel = (id) => v.querySelector(id);
    if (sel('#f-con')) sel('#f-con').value = f.con;
    sel('#f-q').value = f.text;
    const host = sel('#t-runs');
    host._t = { sort: parseSort(q.get('s'), ['start', -1]), limit: 300 };
    function apply() {
      f.con = sel('#f-con') ? sel('#f-con').value : '';
      f.text = sel('#f-q').value.trim().toLowerCase();
      const params = new URLSearchParams();
      if (f.kind !== 'gathers') params.set('kind', f.kind);
      if (f.con) params.set('con', f.con);
      if (f.sev) params.set('sev', f.sev);
      if (f.text) params.set('q', f.text);
      if (f.day) params.set('day', f.day);
      if (!f.group) params.set('g', '0');
      const sp = sortParam(host._t.sort);
      if (sp && sp !== '-start') params.set('s', sp);
      setBaseHash('#runs' + (params.toString() ? '?' + params.toString() : ''));
      // Text matches the run itself, or the objects it gathered (the ones
      // embedded in this report: a truncated run may hide a hit)
      const hits = new Map();
      let partial = 0;
      const textHit = (o) => {
        if (!f.text) return true;
        if (!o.search) o.search = [o.op, opTarget(o), o.job, o.error, o.status, o.v.label].join(' ').toLowerCase();
        if (o.search.includes(f.text)) return true;
        const m = o.tasks.filter((t) => t.nameL.includes(f.text));
        if (m.length) { hits.set(o, m); return true; }
        if (o.truncated) partial++;
        return false;
      };
      const scoped = OPS.filter((o) =>
        (f.kind === 'all' || (f.kind === 'gathers' ? o.kind !== 'other' : o.kind === f.kind)) &&
        (!f.con || String(o.con) === f.con) &&
        (!f.day || dayKey(o.start) === f.day) &&
        textHit(o));
      const base = scoped.filter((o) => showOM || !o.om);
      const hiddenOM = scoped.length - base.length;
      const n = { crit: 0, warn: 0, good: 0 };
      base.forEach((o) => { if (n[o.v.sev] != null) n[o.v.sev]++; });
      sel('#f-sev-host').innerHTML = seg('f-sev', [['', 'Any outcome', base.length], ['crit', 'Failed or unfinished', n.crit], ['warn', 'Some objects failed', n.warn], ['good', 'Complete', n.good]], f.sev);
      wireSeg(v, 'f-sev', (val) => { f.sev = val; host._t.limit = 300; apply(); });
      sel('#f-day').innerHTML = f.day ? '<button type="button" class="chip-x" id="f-day-x" aria-label="Show all days">' + esc(f.day) + ' <span aria-hidden="true">\u2715</span></button>' : '';
      if (f.day) sel('#f-day-x').onclick = () => { f.day = ''; apply(); };
      const list = base.filter((o) => !f.sev || o.v.sev === f.sev);
      let rowsOut = list;
      if (f.group) {
        const by = new Map();
        list.forEach((o) => { if (o.batch) { if (!by.has(o.batch)) by.set(o.batch, []); by.get(o.batch).push(o); } });
        const done = new Set();
        rowsOut = [];
        list.forEach((o) => {
          const m = o.batch ? by.get(o.batch) : null;
          if (!m || m.length < 2) { rowsOut.push(o); return; }
          if (done.has(o.batch)) return;
          done.add(o.batch);
          rowsOut.push(batchRow(o.batch, m.slice().sort((a, b) => a.start - b.start)));
        });
      }
      const groups = rowsOut.filter((r) => r.members).length;
      sel('#f-n').innerHTML = esc(plural(list.length, 'operation')) + (groups ? ', ' + esc(plural(groups, 'group')) : '') + omHint(hiddenOM) +
        (partial ? ' <span data-tip="' + esc(plural(partial, 'run embeds', 'runs embed') + ' only the first ' + fmtN(META.maxTasks) + ' objects; a hit there is not found. Raise max_tasks_per_run.') + '">(' + fmtN(partial) + ' searched partially)</span>' : '');
      // the objects that matched the text, under the run's target
      const hitText = (o) => {
        const m = o.members ? o.members.flatMap((x) => hits.get(x) || []) : hits.get(o);
        if (!m || !m.length) return '';
        const names = [...new Set(m.map((t) => t.name))];
        return '<div class="hits">' + names.slice(0, 3).map((n) => '<code>' + esc(n) + '</code>').join(', ') + (names.length > 3 ? ' +' + fmtN(names.length - 3) : '') + '</div>';
      };
      const dmax = Math.max(1, ...rowsOut.map((o) => o.secs));
      const objs = (o) => {
        const fail = o.stats.failed + o.stats.notDone - (o.members ? 0 : o.v.expected || 0);
        const exp = o.members ? 0 : o.v.expected || 0;
        return (o.stats.n ? fmtN(o.stats.n) : '') + (fail ? ' <span class="err">(' + fmtN(fail) + ' failed)</span>' : '') +
          (exp ? ' <span class="muted" data-tip="' + esc('Expected failure, not counted: ' + esc(o.v.why)) + '">(' + fmtN(exp) + ' expected)</span>' : '');
      };
      renderTable(host, {
        rows: rowsOut, href: (o) => '#run/' + o.key, empty: 'No operation matches these filters.',
        kids: (r) => r.members || null, rowKey: (r) => r.batch.id,
        onSort: () => apply(),
        cols: [
          { key: 'start', label: 'Started', cls: 't', desc: true, html: (o) => esc(fmtT(o.start, true)) },
          { key: 'sev', label: 'Outcome', val: (o) => SEV_RANK[o.v.sev], desc: true, html: (o) => sevBadge(o.v.sev, o.v.label, o.v.why) },
          { key: 'op', label: 'Operation', val: (o) => (o.members ? o.ops[0][0] : opLabel(o)),
            html: (o) => '<span class="nw">' + (o.members ? '<b>' + fmtN(o.members.length) + ' calls</b>' : esc(opLabel(o))) + (CONS.size > 1 ? ' <span class="pill">' + esc(conName(o.con)) + '</span>' : '') + '</span>' +
              (o.members ? ' <span class="muted">' + esc(o.ops.slice(0, 2).map((x) => x[0] + (o.ops.length > 1 ? ' \u00d7' + fmtN(x[1]) : '')).join(', ') + (o.ops.length > 2 ? ', +' + (o.ops.length - 2) + ' more' : '')) + '</span>' : '') },
          { key: 'target', label: 'Target', cls: 'wrap', val: (o) => (o.members ? o.owners.join(',') : opTarget(o)),
            html: (o) => (o.members ? (o.owners.length ? o.owners.slice(0, 3).map((x) => '<code>' + esc(x) + '</code>').join(', ') + (o.owners.length > 3 ? ' +' + (o.owners.length - 3) : '') : '') + ' <span class="muted">' + esc(plural(o.targets, 'target')) + '</span>'
              : o.kind === 'auto' ? '<span class="muted">whole database</span>' : '<code>' + (splitTarget(o.target).length >= 2 && /table_stats$/.test(o.op) ? tabLink(o.con, splitTarget(o.target).slice(0, 2).join('.'), opTarget(o)) : esc(opTarget(o))) + '</code>') + hitText(o) },
          { key: 'n', label: 'Objects', num: true, val: (o) => o.stats.n, html: objs },
          { key: 'secs', label: 'Duration', num: true, tip: 'For a group: from its first call to the end of its last', html: (o) => '<span class="durbar">' + esc(fmtDur(o.secs)) + '<span><b style="inline-size:' + Math.max(2, 100 * o.secs / dmax).toFixed(1) + '%"></b></span></span>' },
          { key: 'job', label: 'Job and window', cls: 'nw', html: (o) => (o.job ? '<code>' + esc(o.job) + '</code>' : '<span class="muted">session ' + esc(o.sid) + '</span>') + (o.window ? ' <span class="pill">' + esc(o.window.name) + '</span>' : '') }
        ]
      });
    }
    wireSeg(v, 'f-kind', (val) => { f.kind = val; host._t.limit = 300; apply(); });
    wireSeg(v, 'f-group', (val) => { f.group = val === '1'; host._t.limit = 300; apply(); });
    if (sel('#f-con')) sel('#f-con').onchange = () => { host._t.limit = 300; apply(); };
    let qt;
    sel('#f-q').oninput = () => { clearTimeout(qt); qt = setTimeout(apply, 180); };
    apply();
  }

  // ------------------------------------------------------------ one run (drawer)
  function runSiblings(o) {
    const same = OPS.filter((x) => x.kind === o.kind && x.con === o.con && (o.kind !== 'gather' || x.op === o.op)).sort((a, b) => a.start - b.start);
    const i = same.indexOf(o);
    return { prev: same[i - 1], next: same[i + 1], pos: i + 1, total: same.length };
  }
  // The run before this one: same container and kind; a manual gather also needs the same target
  function previousRun(o) {
    let best = null;
    OPS.forEach((x) => {
      if (x.kind !== o.kind || x.con !== o.con || x.start >= o.start || x === o) return;
      if (o.kind !== 'auto' && (x.op !== o.op || opTarget(x) !== opTarget(o))) return;
      if (!best || x.start > best.start) best = x;
    });
    return best;
  }
  function openRun(con, id) {
    const d = document.getElementById('drawer');
    const o = OPMAP.get(con + '/' + id);
    if (!o) {
      d.innerHTML = '<div class="drawer-head"><h2 id="drawer-title">Run not found</h2><div class="nav"><button type="button" id="close">Close</button></div></div>' +
        '<div class="drawer-body"><p>No operation ' + esc(id) + ' in container ' + esc(con) + ' in this report.</p></div>';
      d.querySelector('#close').onclick = () => d.close();
      if (!d.open) d.showModal();
      return;
    }
    const s = o.stats;
    const sib = runSiblings(o);
    let h = '<div class="drawer-head"><div><h2 id="drawer-title">' + esc(opLabel(o)) + (o.kind === 'auto' ? '' : ' <code>' + esc(opTarget(o)) + '</code>') + '</h2>' +
      '<div class="where">' + esc(conName(o.con)) + ', ' + esc(fmtT(o.start, true)) + ', run ' + fmtN(sib.pos) + ' of ' + fmtN(sib.total) + '</div></div>' + sevBadge(o.v.sev, o.v.label) +
      '<div class="nav"><button type="button" id="prev"' + (sib.prev ? '' : ' disabled') + ' aria-label="Previous run">\u2190 Previous</button>' +
      '<button type="button" id="next"' + (sib.next ? '' : ' disabled') + ' aria-label="Next run">Next \u2192</button>' +
      '<button type="button" id="close" aria-label="Close" autofocus>Close <kbd>Esc</kbd></button></div></div><div class="drawer-body">';
    if (o.v.sev !== 'good') h += '<div class="warnbox">' + esc(o.v.why) + '</div>';
    const prev = previousRun(o);
    if (prev) {
      const ps = prev.stats;
      const delta = (a, b, fmt, bad) => {
        const d = a - b;
        if (Math.abs(d) < 1e-9 || (fmt === fmtDur && Math.abs(d) < 0.5)) return '<span class="delta same">same</span>';
        const cls = bad == null ? '' : (d > 0) === bad ? ' worse' : ' better';
        return '<span class="delta' + cls + '">' + (d > 0 ? '+' : '\u2212') + esc(fmt(Math.abs(d))) + '</span>';
      };
      const pf = ps.failed - (prev.v.expected || 0) + ps.notDone, of = s.failed - (o.v.expected || 0) + s.notDone;
      h += '<section class="compare"><p class="note">Compared with the <a href="#run/' + prev.key + '">previous run</a>, ' + esc(fmtT(prev.start)) + '</p><dl class="stats compact">' +
        '<div><dt>Duration</dt><dd>' + esc(fmtDur(o.secs)) + delta(o.secs, prev.secs, fmtDur, null) + '</dd></div>' +
        '<div><dt>Objects</dt><dd>' + fmtN(s.n) + delta(s.n, ps.n, fmtN, null) + '</dd></div>' +
        '<div><dt>Gathered</dt><dd>' + fmtN(s.done) + delta(s.done, ps.done, fmtN, null) + '</dd></div>' +
        '<div><dt>Failed or not processed</dt><dd>' + fmtN(of) + delta(of, pf, fmtN, true) + '</dd></div>' +
        '<div><dt>With histograms</dt><dd>' + fmtN(s.hist) + delta(s.hist, ps.hist, fmtN, null) + '</dd></div>' +
        '</dl></section>';
    }

    const facts = [
      ['Started', esc(fmtT(o.start, true))],
      ['Ended', o.end ? esc(fmtT(o.end, true)) : '<span class="muted">no end recorded</span>'],
      ['Duration', esc(fmtDur(o.secs))],
      ['Status', esc(o.status)],
      ['Job', o.job ? '<code>' + esc(o.job) + '</code>' : '<span class="muted">called from a session</span>'],
      ['Session', esc(o.sid)]
    ];
    if (o.sjr) facts.push(['Scheduler', esc(o.sjr.status.toLowerCase()) + ', ran ' + esc(fmtDur(o.sjr.secs)) + ', CPU ' + esc(fmtDur(o.sjr.cpu)) + (o.sjr.error ? ', ORA-' + esc(o.sjr.error) : '')]);
    if (o.window) {
      const used = o.end && o.window.end > o.window.start ? (100 * (o.end - o.window.start)) / (o.window.end - o.window.start) : null;
      facts.push(['Window', esc(o.window.name) + ', ' + esc(fmtSpan(o.window.start, o.window.end)) + ' (' + esc(fmtDur(o.window.secs)) + ')' +
        (o.end ? '<br><span class="muted">Finished ' + esc(fmtDur((o.window.end - o.end) / 1000)) + ' before the window closed' + (used != null ? ', ' + used.toFixed(0) + '% of the window had passed' : '') + '</span>' : '')]);
    }
    if (o.ajh && o.ajh.info) facts.push(['Job info', esc(o.ajh.info)]);
    const kv = '<dl class="kv">' + facts.map((f) => '<dt>' + esc(f[0]) + '</dt><dd>' + f[1] + '</dd>').join('') + '</dl>';
    const pk = Object.keys(o.params);
    const params = pk.length ? '<dl class="kv">' + pk.map((k) => '<dt>' + esc(k) + '</dt><dd><code>' + esc(o.params[k] === '' ? "''" : o.params[k]) + '</code></dd>').join('') + '</dl>' : '<p class="muted">No parameters recorded.</p>';
    h += '<div class="split">' + sec('Run', '', '<div class="surface">' + kv + (o.error ? '<div class="err-block">' + esc(o.error) + '</div>' : '') + '</div>') +
      sec('Parameters', 'As resolved. DEFAULT_*: the preference in force.', '<div class="surface">' + params + '</div>') + '</div>';

    if (s.n) {
      const types = Object.keys(s.byType).sort((a, b) => s.byType[b].secs - s.byType[a].secs);
      let tb = '<div class="tablewrap"><table><thead><tr><th>Object type</th><th class="num">Objects</th><th class="num">Gathered</th><th class="num">Failed</th><th class="num">Not processed</th><th class="num">With histograms</th><th class="num">Time</th></tr></thead><tbody>';
      const row = (label, b, bold) => '<tr><td>' + (bold ? '<b>' + label + '</b>' : label) + '</td><td class="num">' + fmtN(b.n) + '</td><td class="num">' + fmtN(b.done) + '</td><td class="num">' + (b.failed ? '<span class="err">' + fmtN(b.failed) + '</span>' : '') +
        '</td><td class="num">' + ((b.other || b.notDone) ? '<span class="err">' + fmtN(b.other || b.notDone) + '</span>' : '') + '</td><td class="num">' + (b.hist ? fmtN(b.hist) : '') + '</td><td class="num">' + esc(fmtDur(b.secs)) + '</td></tr>';
      types.forEach((t) => { tb += row(esc(t.toLowerCase()), s.byType[t]); });
      if (types.length > 1) tb += row('Total', s, true);
      tb += '</tbody></table></div>';
      const conc = o.params.concurrent === 'TRUE' || (s.secs > o.secs * 1.2 && o.secs > 1);
      const owners = new Map();
      o.tasks.forEach((t) => { const k = t.parts[0] || '?'; const x = owners.get(k) || { n: 0, secs: 0 }; x.n++; x.secs += t.secs || 0; owners.set(k, x); });
      const ol = [...owners.entries()].sort((a, b) => b[1].secs - a[1].secs).slice(0, 8);
      const omax = ol.length ? Math.max(0.001, ol[0][1].secs) : 1;
      const ot = '<div class="tablewrap"><table><thead><tr><th>Schema</th><th class="num">Objects</th><th class="num">Time</th></tr></thead><tbody>' +
        ol.map((e) => '<tr><td>' + esc(e[0]) + '</td><td class="num">' + fmtN(e[1].n) + '</td><td class="num"><span class="durbar">' + esc(fmtDur(e[1].secs)) + '<span><b style="inline-size:' + (100 * e[1].secs / omax).toFixed(1) + '%"></b></span></span></td></tr>').join('') + '</tbody></table></div>';
      h += '<div class="split wide-narrow">' + sec('What it did', plural(s.n, 'object') + (conc ? '. Objects overlapped, so the times add up to more than the run took.' : '.'), '<div class="surface">' + tb + '</div>') +
        sec('By schema', o.truncated ? 'From the ' + fmtN(o.tasks.length) + ' objects in this report.' : '', '<div class="surface">' + ot + '</div>') + '</div>';
      const timedT = o.tasks.filter((t) => t.secs > 0).sort((a, b) => b.secs - a.secs);
      const tot = timedT.reduce((a, t) => a + t.secs, 0);
      if (tot > 0 && timedT.length > 1) {
        const top = timedT.slice(0, 8);
        const restN = timedT.length - top.length, rest = tot - top.reduce((a, t) => a + t.secs, 0);
        const segOf = (cls, secs, label, tip) => {
          const pct = (100 * secs) / tot;
          return '<span class="' + cls + '" style="flex-grow:' + pct.toFixed(3) + '" data-tip="' + esc(tip) + '">' + (pct >= 6 ? '<em>' + esc(label) + '</em>' : '') + '</span>';
        };
        const strip = top.map((t) => segOf(typeClass(t).replace('f-', 'b-'), t.secs, t.name.split('.').slice(1).join('.') || t.name,
          objTip(t) + '<br>' + ((100 * t.secs) / tot).toFixed(0) + '% of the object time')).join('') +
          (restN ? segOf('b-rest', rest, plural(restN, 'other object'), '<b>' + esc(plural(restN, 'other object')) + '</b><br>' + esc(fmtDur(rest)) + ', ' + ((100 * rest) / tot).toFixed(0) + '% of the object time') : '');
        h += sec('Where the time went', 'Slowest objects, share of all object time (' + esc(fmtDur(tot)) + '). Hover for names.', '<div class="surface"><div class="strip">' + strip + '</div></div>');
      }
      h += sec('Objects over time', (o.tasks.length > 40 ? 'Concurrent objects stack into lanes. Hover for the object.' : 'Hover for the object.') +
        (o.window && o.window.end <= o.endEff + 60e3 ? ' Red line: end of the window.' : ''),
        '<div class="surface"><div id="gantt"></div><div class="legend"><span><b class="s1"></b>Table</span><span><b class="s2"></b>Partition</span><span><b class="s3"></b>Index</span><span><b class="crit"></b>Failed</span><span><b class="warn"></b>Not completed</span></div></div>');
      h += sec('Objects', (o.truncated ? fmtN(o.tasks.length) + ' of ' + fmtN(s.n) + ' in this report: failed first, then slowest. Raise max_tasks_per_run to see all. ' : '') + 'Click a name for the table.',
        '<div class="filters"><div id="o-st-host"></div><label>Type <select id="o-ty"><option value="">Any</option>' + [...new Set(o.tasks.map((t) => t.type))].sort().map((x) => '<option>' + esc(x) + '</option>').join('') + '</select></label>' +
        '<input type="search" id="o-q" placeholder="Filter objects" aria-label="Filter objects"><span class="count" id="o-n"></span></div><div id="t-obj"></div>');
    } else if (o.kind !== 'other') {
      h += sec('What it did', '', '<p>No per-object rows were recorded for this operation' + (o.status === 'COMPLETED' ? '; it found nothing to gather.' : '.') + '</p>');
    }
    if (o.kind === 'auto' && lastAuto.get(o.con) === o) {
      const n = BL.filter((b) => b.con === o.con && !b.om && (b.cat === 'missed' || b.cat === 'failed')).length;
      h += sec('After this run', 'This is the latest automatic run in ' + esc(conName(o.con)) + '.',
        '<p>' + (n ? '<a href="#backlog?cat=missed&con=' + o.con + '">' + plural(n, 'application object') + '</a> were stale before this run started and still are, or failed.' : 'Every application object that was stale when this run started has been gathered.') + '</p>');
    }
    h += '</div>';
    d.innerHTML = h;
    d.querySelector('#close').onclick = () => d.close();
    if (sib.prev) d.querySelector('#prev').onclick = () => { location.hash = '#run/' + sib.prev.key; };
    if (sib.next) d.querySelector('#next').onclick = () => { location.hash = '#run/' + sib.next.key; };
    if (!d.open) d.showModal();
    d.scrollTop = 0;

    if (s.n && o.tasks.length) {
      const g = d.querySelector('#gantt');
      const gr = ganttSVG(g.clientWidth, o, o.tasks);
      g.innerHTML = gr.svg + (gr.capped ? '<p class="note">More than 24 objects ran at once; the busiest lanes are merged.</p>' : '');
      const host = d.querySelector('#t-obj');
      const ty = d.querySelector('#o-ty'), qq = d.querySelector('#o-q');
      let st = '';
      const draw = () => {
        const q = qq.value.trim().toLowerCase();
        const base = o.tasks.filter((t) => (!ty.value || t.type === ty.value) && (!q || (t.name + ' ' + (t.error || '') + ' ' + t.hist.join(' ')).toLowerCase().includes(q)));
        const nf = base.filter((t) => t.status === 'FAILED').length, nd = base.filter((t) => t.status === 'COMPLETED').length;
        d.querySelector('#o-st-host').innerHTML = seg('o-st', [['', 'All', base.length], ['COMPLETED', 'Gathered', nd], ['FAILED', 'Failed', nf]].concat(base.length - nf - nd ? [['other', 'Other', base.length - nf - nd]] : []), st);
        wireSeg(d, 'o-st', (val) => { st = val; host._t.limit = 300; draw(); });
        const list = base.filter((t) => !st || (st === 'other' ? t.status !== 'FAILED' && t.status !== 'COMPLETED' : t.status === st));
        d.querySelector('#o-n').textContent = plural(list.length, 'object');
        const dmax = Math.max(0.001, ...list.map((t) => t.secs || 0));
        renderTable(host, {
          rows: list, sort: ['secs', -1], limit: 300, empty: 'No object matches.',
          cols: [
            { key: 'name', label: 'Object', cls: 'wrap', html: (t) => pieceName(t, true) },
            { key: 'type', label: 'Type', html: (t) => esc(t.type.toLowerCase()) },
            { key: 'status', label: 'Status', html: (t) => (t.status === 'COMPLETED' ? sevBadge('good', 'gathered') : sevBadge(t.status === 'FAILED' ? 'crit' : 'warn', t.status.toLowerCase())) },
            { key: 'start', label: 'Started', cls: 't', html: (t) => esc(fmtClock(t.start, true)) },
            { key: 'secs', label: 'Duration', num: true, html: (t) => '<span class="durbar">' + esc(fmtDur(t.secs)) + '<span><b style="inline-size:' + (100 * (t.secs || 0) / dmax).toFixed(1) + '%"></b></span></span>' },
            { key: 'size', label: 'Size', num: true, tip: 'TARGET_SIZE as recorded by DBMS_STATS (blocks)', html: (t) => fmtN(t.size) },
            { key: 'hist', label: 'Histograms', val: (t) => t.hist.length, html: (t) => (t.hist.length ? '<span data-tip="' + esc(esc(t.hist.join(', '))) + '">' + plural(t.hist.length, 'column') + '</span>' : '') },
            { key: 'error', label: 'Error or extended statistics', cls: 'wrap', html: (t) => (t.error ? '<span class="err">' + esc(t.error) + '</span>' : esc(t.xstats)) }
          ]
        });
      };
      host._t = { sort: ['secs', -1], limit: 300 };
      ty.onchange = () => { host._t.limit = 300; draw(); };
      let qt;
      qq.oninput = () => { clearTimeout(qt); qt = setTimeout(draw, 180); };
      draw();
    }
  }

  // ------------------------------------------------------------ backlog
  // The statement that would gather an object (or a group of its partitions).
  // Shown and copied only: the report itself changes nothing.
  const sqlq = (x) => "'" + String(x).replace(/'/g, "''") + "'";
  function fixCmd(b) {
    if (b.cat === 'fixed') return 'exec dbms_stats.gather_fixed_objects_stats';
    const args = ['ownname => ' + sqlq(b.owner), 'tabname => ' + sqlq(b.table)];
    const sub = b.group ? b.type === 'SUBPARTITION' : !!b.sub;
    if (!b.group && (b.sub || b.part)) args.push('partname => ' + sqlq(b.sub || b.part));
    if (sub) args.push("granularity => 'SUBPARTITION'");
    else if (!b.group && b.part) args.push("granularity => 'PARTITION'");
    // FORCE gathers through a lock without removing it
    if (b.locked) args.push('force => TRUE');
    return 'exec dbms_stats.gather_table_stats(' + args.join(', ') + ')';
  }
  // Statements for several objects, with the container switch they need
  function fixScript(list, cmd) {
    const byCon = new Map();
    list.forEach((b) => {
      if (!byCon.has(b.con)) byCon.set(b.con, new Set());
      byCon.get(b.con).add((cmd || fixCmd)(b));
    });
    const out = [];
    byCon.forEach((cmds, con) => {
      if (META.cdb === 'YES' && byCon.size > 1 || (META.cdb === 'YES' && con !== META.conId)) out.push('alter session set container = ' + conName(con) + ';');
      cmds.forEach((c) => out.push(c));
    });
    return out.join('\n');
  }
  function stalePct(b) {
    const p = b.prefs.find((x) => x.pref === 'STALE_PERCENT');
    const v = Number(p ? p.value : PREFS.get('STALE_PERCENT'));
    return isFinite(v) && v > 0 ? v : 10;
  }
  // Partitions and subpartitions of one table with the same reason: one row
  function groupBacklog(list) {
    const by = new Map();
    list.forEach((b) => {
      if (!b.part && !b.sub) return;
      const k = b.con + '|' + b.owner + '.' + b.table + '|' + b.cat + '|' + b.type;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(b);
    });
    const done = new Set();
    const out = [];
    list.forEach((b) => {
      const k = b.con + '|' + b.owner + '.' + b.table + '|' + b.cat + '|' + b.type;
      const m = (b.part || b.sub) ? by.get(k) : null;
      if (!m || m.length < 3) { out.push(b); return; }
      if (done.has(k)) return;
      done.add(k);
      const sum = (f) => m.reduce((a, x) => a + (x[f] || 0), 0);
      const analyzed = m.some((x) => !x.analyzed) ? null : Math.min(...m.map((x) => x.analyzed));
      const atts = m.map((x) => x.attempt).filter(Boolean).sort((x, y) => y.start - x.start);
      const rowsN = sum('rows'), dml = sum('dml');
      out.push({
        group: true, key: k, members: m, con: b.con, owner: b.owner, table: b.table, type: b.type, cat: b.cat, om: b.om,
        name: b.owner + '.' + b.table, rows: rowsN || null, dml: dml, ins: sum('ins'), upd: sum('upd'), del: sum('del'), trunc: m.some((x) => x.trunc),
        pct: rowsN ? (100 * dml) / rowsN : null, analyzed: analyzed, missing: analyzed == null,
        dmlTs: Math.max(0, ...m.map((x) => x.dmlTs || 0)) || null, attempt: atts[0] || null,
        prefs: b.prefs, locked: b.locked
      });
    });
    return out;
  }
  // When the DML-monitoring counters were last written, for the staleness caveat
  function monText() {
    const newest = MON.map((m) => m.newest).filter(Boolean);
    if (!newest.length) return 'As of the last DML-monitoring flush. ';
    return 'As of the last DML-monitoring flush, newest counters ' + esc(fmtT(Math.max(...newest))) + '; later changes are still in memory. ';
  }
  function viewBacklog(q) {
    const v = document.getElementById('view');
    const f = { cat: q.get('cat') || '', con: q.get('con') || '', text: q.get('q') || '' };
    const consAll = [...new Set(BL.map((b) => b.con))].sort((a, b) => a - b);
    v.innerHTML = missingBox() + sec('Needs statistics now', 'Stale or without statistics, and why. ' + monText() + 'Partitions of one table with the same reason form a group.',
      '<div class="cats" id="cats"></div><p class="cat-text" id="cat-text"></p>' +
      '<div class="filters">' +
      (consAll.length > 1 ? '<label>Container <select id="b-con"><option value="">All</option>' + consAll.map((c) => '<option value="' + c + '">' + esc(conName(c)) + '</option>').join('') + '</select></label>' : '') +
      '<input type="search" id="b-q" placeholder="Filter by owner, table or partition" aria-label="Filter objects">' +
      '<button type="button" id="b-copy" class="copy-all">Copy gather statements</button>' +
      '<span class="count" id="b-n"></span></div>' +
      (blTruncated ? '<p class="note" style="margin-block-end:1rem">Only the first ' + fmtN(BL.length) + ' objects are in this report (application schemas first). Raise max_backlog to see all.</p>' : '') +
      '<div id="t-bl"></div>') +
      sec('Close to stale', 'At least half of STALE_PERCENT changed by the flushed counters alone. Unflushed changes may already have pushed them over.',
        '<div id="t-near"></div>');
    const sel = (id) => v.querySelector(id);
    if (sel('#b-con')) sel('#b-con').value = f.con;
    sel('#b-q').value = f.text;
    const host = sel('#t-bl');
    host._t = { sort: parseSort(q.get('s'), null), limit: 300 };
    function apply() {
      f.con = sel('#b-con') ? sel('#b-con').value : '';
      f.text = sel('#b-q').value.trim().toLowerCase();
      const params = new URLSearchParams();
      if (f.cat) params.set('cat', f.cat);
      if (f.con) params.set('con', f.con);
      if (f.text) params.set('q', f.text);
      if (host._t.sort) params.set('s', sortParam(host._t.sort));
      setBaseHash('#backlog' + (params.toString() ? '?' + params.toString() : ''));
      const scoped = BL.filter((b) => (!f.con || String(b.con) === f.con) && (!f.text || b.name.toLowerCase().includes(f.text)));
      const base = scoped.filter((b) => showOM || !b.om);
      const cnt = {};
      base.forEach((b) => { cnt[b.cat] = (cnt[b.cat] || 0) + 1; });
      const cats = CAT_ORDER.filter((c) => cnt[c] || f.cat === c);
      sel('#cats').innerHTML = cats.length ? '<button type="button" class="cat" data-cat="" aria-pressed="' + !f.cat + '">All<span class="n">' + fmtN(base.length) + '</span></button>' +
        cats.map((c) => '<button type="button" class="cat" data-cat="' + c + '" aria-pressed="' + (f.cat === c) + '">' + sevBadge(CATS[c].sev, CATS[c].title) + '<span class="n">' + fmtN(cnt[c] || 0) + '</span></button>').join('') : '';
      sel('#cat-text').textContent = f.cat ? CATS[f.cat].text : (base.length ? 'Pick a reason.' : 'Nothing needs statistics with these filters.');
      sel('#cats').querySelectorAll('[data-cat]').forEach((b) => {
        b.onclick = () => { f.cat = b.getAttribute('data-cat'); host._t.limit = 300; apply(); };
      });
      const list = base.filter((b) => !f.cat || b.cat === f.cat);
      const rowsOut = groupBacklog(list);
      const groups = rowsOut.filter((r) => r.group).length;
      sel('#b-n').innerHTML = esc(plural(list.length, 'object')) + (groups ? ', ' + esc(plural(groups, 'group')) : '') + omHint(scoped.length - base.length);
      const copyAll = sel('#b-copy');
      copyAll.hidden = !rowsOut.length;
      copyAll.setAttribute('data-copy', fixScript(rowsOut));
      copyAll.setAttribute('data-tip', esc('<b>' + plural(rowsOut.length, 'statement') + ' for the rows below</b><br>Review first: locked statistics are often locked on purpose.'));
      renderTable(host, {
        rows: rowsOut, limit: 300, empty: 'Nothing matches these filters.',
        href: (b) => (b.attempt && b.attempt.op ? '#run/' + b.attempt.op.key : null),
        kids: (r) => (r.group ? r.members : null), rowKey: (r) => r.key,
        onSort: () => apply(),
        cols: [
          { key: 'name', label: 'Object', cls: 'wrap', html: (b) => objCell(b, consAll.length > 1) },
          { key: 'cat', label: 'Why', val: (b) => CAT_ORDER.indexOf(b.cat), html: (b) => sevBadge(CATS[b.cat].sev, CATS[b.cat].title, CATS[b.cat].text) },
          { key: 'rows', label: 'Rows', num: true, tip: 'NUM_ROWS in the current statistics', html: (b) => fmtN(b.rows) },
          { key: 'pct', label: 'Changed', num: true, tip: 'Inserts + updates + deletes since the last gather, against the row count in the statistics. The tick is STALE_PERCENT.', val: (b) => b.pct,
            html: (b) => {
              if (!b.dml) return b.trunc ? 'truncated' : '';
              const th = stalePct(b);
              const bar = b.pct != null ? '<span class="pctbar" aria-hidden="true"><b style="inline-size:' + Math.min(100, b.pct).toFixed(1) + '%"></b><i style="inset-inline-start:' + Math.min(100, th) + '%"></i></span>' : '';
              return '<span class="pctcell" data-tip="' + esc('Inserts ' + fmtN(b.ins) + '<br>Updates ' + fmtN(b.upd) + '<br>Deletes ' + fmtN(b.del) + (b.trunc ? '<br>Truncated' : '') +
                (b.pct != null ? '<br>' + (b.pct >= 1000 ? 'over 999' : b.pct.toFixed(1)) + '% changed; stale from ' + th + '%' : '')) + '">' + fmtN(b.dml) +
                (b.pct != null ? ' <span class="muted">(' + (b.pct >= 1000 ? '>999' : b.pct.toFixed(b.pct < 10 ? 1 : 0)) + '%)</span>' : '') + bar + '</span>';
            } },
          { key: 'analyzed', label: 'Analyzed', cls: 't', html: (b) => (b.analyzed ? esc(fmtT(b.analyzed)) : '<span class="err">never</span>') },
          { key: 'dmlTs', label: 'Last DML', cls: 't', tip: 'Time of the last DML-monitoring row for it', html: (b) => esc(fmtT(b.dmlTs)) },
          { key: 'attempt', label: 'Last attempt', cls: 'wrap', tip: 'The last gather of this object in the period', val: (b) => (b.attempt ? b.attempt.start : null),
            html: (b) => (b.attempt ? esc(fmtT(b.attempt.start)) + ' ' + (b.attempt.status === 'FAILED' ? '<span class="err">failed: ' + esc(b.attempt.error || '') + '</span>' : '<span class="muted">' + esc(String(b.attempt.status || '').toLowerCase()) + '</span>') : '<span class="muted">none in the period</span>') },
          { key: 'prefs', label: 'Preferences', cls: 'wrap prefs', val: (b) => b.prefs.length,
            html: (b) => {
              const key = b.prefs.filter((p) => /^(STALE_PERCENT|INCREMENTAL|GRANULARITY|PUBLISH)$/.test(p.pref));
              const rest = b.prefs.length - key.length;
              return '<div class="pills">' + (b.locked ? '<span class="pill">locked ' + esc(b.locked.toLowerCase()) + '</span> ' : '') +
                key.map((p) => '<span class="pill">' + esc(p.pref) + '=' + esc(p.value) + '</span>').join(' ') +
                (rest ? ' <span class="pill" data-tip="' + esc(b.prefs.map((p) => esc(p.pref) + ' = ' + esc(p.value)).join('<br>')) + '">' + (key.length ? '+' : '') + plural(rest, 'preference') + '</span>' : '') + '</div>';
            } },
          { key: 'fix', label: 'Gather', val: () => null, html: (b) => {
            const cmd = fixScript([b]);
            return '<button type="button" class="copy" data-copy="' + esc(cmd) + '" data-tip="' + esc('<code>' + esc(cmd).replace(/\n/g, '<br>') + '</code><br><span class="muted">Click to copy' + (b.locked ? '. Locked: often on purpose, check first' : '') + '</span>') + '">Copy</button>';
          } }
        ]
      });
      applyNear();
    }
    const nearHost = sel('#t-near');
    // Partitions of one table: one row that opens up (three or more)
    function groupNear(list) {
      const by = new Map();
      list.forEach((b) => {
        if (!b.part && !b.sub) return;
        const k = b.con + '|' + b.owner + '.' + b.table + '|' + b.type;
        if (!by.has(k)) by.set(k, []);
        by.get(k).push(b);
      });
      const done = new Set();
      const out = [];
      list.forEach((b) => {
        const k = b.con + '|' + b.owner + '.' + b.table + '|' + b.type;
        const m = (b.part || b.sub) ? by.get(k) : null;
        if (!m || m.length < 3) { out.push(b); return; }
        if (done.has(k)) return;
        done.add(k);
        const sum = (fld) => m.reduce((a, x) => a + (x[fld] || 0), 0);
        const g = {
          group: true, key: k, members: m, con: b.con, owner: b.owner, table: b.table, type: b.type, om: b.om, name: b.owner + '.' + b.table,
          rows: sum('rows'), ins: sum('ins'), upd: sum('upd'), del: sum('del'), dml: sum('dml'), th: b.th,
          share: Math.max(...m.map((x) => x.share || 0)), analyzed: Math.min(...m.map((x) => x.analyzed || 9e15)), dmlTs: Math.max(...m.map((x) => x.dmlTs || 0)) || null
        };
        g.pct = g.rows ? (100 * g.dml) / g.rows : null;
        out.push(g);
      });
      return out;
    }
    function applyNear() {
      const list = NEAR.filter((b) => (showOM || !b.om) && (!f.con || String(b.con) === f.con) && (!f.text || b.name.toLowerCase().includes(f.text)));
      renderTable(nearHost, {
        rows: groupNear(list), sort: ['share', -1], limit: 50,
        kids: (r) => (r.group ? r.members : null), rowKey: (r) => r.key,
        empty: missing.includes('near') ? 'Not collected.' : 'Nothing is close to its stale threshold with these filters.',
        cols: [
          { key: 'name', label: 'Object', cls: 'wrap', html: (b) => objCell(b, consAll.length > 1 || CONS.size > 1) },
          { key: 'rows', label: 'Rows', num: true, tip: 'NUM_ROWS in the current statistics', html: (b) => fmtN(b.rows) },
          { key: 'share', label: 'Changed', num: true, tip: 'Inserts + updates + deletes in the flushed counters, against the row count. A full bar is STALE_PERCENT; for a group, the partition closest to it.',
            html: (b) => '<span class="pctcell" data-tip="' + esc('Inserts ' + fmtN(b.ins) + '<br>Updates ' + fmtN(b.upd) + '<br>Deletes ' + fmtN(b.del) + '<br>' + b.pct.toFixed(1) + '% changed; stale from ' + b.th + '%' +
              (b.group ? '<br>Closest partition: ' + (100 * b.share).toFixed(0) + '% of the way' : '')) + '">' +
              fmtN(b.dml) + ' <span class="muted">(' + b.pct.toFixed(1) + '%)</span><span class="pctbar" aria-hidden="true"><b style="inline-size:' + Math.min(100, 100 * b.share).toFixed(1) + '%"></b></span></span>' },
          { key: 'th', label: 'Stale at', num: true, tip: 'STALE_PERCENT: the table preference, else the global one', html: (b) => esc(b.th) + '%' },
          { key: 'analyzed', label: 'Analyzed', cls: 't', html: (b) => esc(fmtT(b.analyzed)) },
          { key: 'dmlTs', label: 'Last DML', cls: 't', tip: 'Time of the DML-monitoring row', html: (b) => esc(fmtT(b.dmlTs)) }
        ]
      });
    }
    if (sel('#b-con')) sel('#b-con').onchange = () => { host._t.limit = 300; apply(); };
    let qt;
    sel('#b-q').oninput = () => { clearTimeout(qt); qt = setTimeout(apply, 180); };
    apply();
  }

  // ------------------------------------------------------------ columns
  // A default gather fixes most of these; a height-balanced histogram also
  // needs AUTO_SAMPLE_SIZE in case a fixed ESTIMATE_PERCENT is what built it.
  function colFixCmd(c) {
    const args = ['ownname => ' + sqlq(c.owner), 'tabname => ' + sqlq(c.table)];
    if (c.cat === 'legacyhb') args.push('estimate_percent => dbms_stats.auto_sample_size');
    return 'exec dbms_stats.gather_table_stats(' + args.join(', ') + ')';
  }
  // Columns of one table with the same reason: one row that opens up
  function groupCols(list) {
    const by = new Map();
    list.forEach((c) => {
      const k = c.con + '|' + c.name + '|' + c.cat;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(c);
    });
    const done = new Set();
    const out = [];
    list.forEach((c) => {
      const k = c.con + '|' + c.name + '|' + c.cat;
      const m = by.get(k);
      if (m.length < 2) { out.push(c); return; }
      if (done.has(k)) return;
      done.add(k);
      const an = m.map((x) => x.analyzed).filter(Boolean);
      out.push({
        group: true, key: k, members: m, con: c.con, owner: c.owner, table: c.table, name: c.name, full: c.name, cat: c.cat, om: c.om,
        prefs: c.prefs, tabAnalyzed: c.tabAnalyzed, rows: c.rows, analyzed: an.length === m.length ? Math.min(...an) : null
      });
    });
    return out;
  }
  function viewColumns(q) {
    const v = document.getElementById('view');
    const f = { cat: q.get('cat') || '', con: q.get('con') || '', text: q.get('q') || '' };
    const consAll = [...new Set(COLS.map((c) => c.con))].sort((a, b) => a - b);
    const om = COLAGG.filter((a) => a.om).reduce((a, x) => a + x.n, 0);
    v.innerHTML = missingBox() + sec('Column statistics', 'Column statistics that lag behind their table, or histograms that cannot describe the column. Table level only; tables without statistics are under Needs statistics.',
      '<div class="cats" id="cats"></div><p class="cat-text" id="cat-text"></p>' +
      '<div class="filters">' +
      (consAll.length > 1 ? '<label>Container <select id="c-con"><option value="">All</option>' + consAll.map((c) => '<option value="' + c + '">' + esc(conName(c)) + '</option>').join('') + '</select></label>' : '') +
      '<input type="search" id="c-q" placeholder="Filter by owner, table or column" aria-label="Filter columns">' +
      '<button type="button" id="c-copy" class="copy-all">Copy gather statements</button>' +
      '<span class="count" id="c-n"></span></div>' +
      (colTruncated ? '<p class="note" style="margin-block-end:1rem">Only the first ' + fmtN(COLS.length) + ' columns are in this report (application schemas first); ' +
        fmtN(COLAGG.reduce((a, x) => a + x.n, 0)) + ' in all' + (om ? ', ' + fmtN(om) + ' of them in Oracle schemas' : '') + '. Raise max_backlog to see all.</p>' : '') +
      '<div id="t-cols"></div>');
    const sel = (id) => v.querySelector(id);
    if (sel('#c-con')) sel('#c-con').value = f.con;
    sel('#c-q').value = f.text;
    const host = sel('#t-cols');
    host._t = { sort: parseSort(q.get('s'), null), limit: 300 };
    function apply() {
      f.con = sel('#c-con') ? sel('#c-con').value : '';
      f.text = sel('#c-q').value.trim().toLowerCase();
      const params = new URLSearchParams();
      if (f.cat) params.set('cat', f.cat);
      if (f.con) params.set('con', f.con);
      if (f.text) params.set('q', f.text);
      if (host._t.sort) params.set('s', sortParam(host._t.sort));
      setBaseHash('#columns' + (params.toString() ? '?' + params.toString() : ''));
      const scoped = COLS.filter((c) => (!f.con || String(c.con) === f.con) && (!f.text || c.full.toLowerCase().includes(f.text)));
      const base = scoped.filter((c) => showOM || !c.om);
      const cnt = {};
      base.forEach((c) => { cnt[c.cat] = (cnt[c.cat] || 0) + 1; });
      const cats = COLCAT_ORDER.filter((c) => cnt[c] || f.cat === c);
      sel('#cats').innerHTML = cats.length ? '<button type="button" class="cat" data-cat="" aria-pressed="' + !f.cat + '">All<span class="n">' + fmtN(base.length) + '</span></button>' +
        cats.map((c) => '<button type="button" class="cat" data-cat="' + c + '" aria-pressed="' + (f.cat === c) + '">' + sevBadge(COLCATS[c].sev, COLCATS[c].title) + '<span class="n">' + fmtN(cnt[c] || 0) + '</span></button>').join('') : '';
      sel('#cat-text').textContent = f.cat ? COLCATS[f.cat].text : (base.length ? 'Pick a reason.' : missing.includes('cols') ? 'Not collected.' : 'No column statistics problem with these filters.');
      sel('#cats').querySelectorAll('[data-cat]').forEach((b) => {
        b.onclick = () => { f.cat = b.getAttribute('data-cat'); host._t.limit = 300; apply(); };
      });
      const list = base.filter((c) => !f.cat || c.cat === f.cat);
      const rowsOut = groupCols(list);
      const tables = new Set(list.map((c) => c.con + '|' + c.name)).size;
      sel('#c-n').innerHTML = esc(plural(list.length, 'column')) + (list.length ? ' in ' + esc(plural(tables, 'table')) : '') + omHint(scoped.length - base.length);
      const copyAll = sel('#c-copy');
      copyAll.hidden = !rowsOut.length;
      copyAll.setAttribute('data-copy', fixScript(rowsOut, colFixCmd));
      copyAll.setAttribute('data-tip', esc('<b>One statement per table below</b><br>A default gather: a METHOD_OPT or ESTIMATE_PERCENT table preference that caused this stays in force.'));
      renderTable(host, {
        rows: rowsOut, limit: 300, empty: 'Nothing matches these filters.',
        kids: (r) => (r.group ? r.members : null), rowKey: (r) => r.key,
        onSort: () => apply(),
        cols: [
          { key: 'full', label: 'Column', cls: 'wrap', html: (c) => '<code>' + tabLink(c.con, c.name) + (c.group ? '' : '.' + esc(c.col)) + '</code>' +
            (c.group ? ' <span class="pill" data-tip="' + esc(c.members.slice(0, 15).map((x) => esc(x.col)).join('<br>') + (c.members.length > 15 ? '<br>+' + fmtN(c.members.length - 15) + ' more' : '')) + '">' + esc(plural(c.members.length, 'column')) + '</span>' : c.dtype ? ' <span class="pill">' + esc(c.dtype.toLowerCase()) + '</span>' : '') +
            (consAll.length > 1 ? ' <span class="pill">' + esc(conName(c.con)) + '</span>' : '') },
          { key: 'cat', label: 'Why', val: (c) => COLCAT_ORDER.indexOf(c.cat), html: (c) => sevBadge(COLCATS[c.cat].sev, COLCATS[c.cat].title, COLCATS[c.cat].text) },
          { key: 'hist', label: 'Histogram', html: (c) => (c.group ? '' : !c.hist ? '' : c.hist === 'NONE' ? '<span class="muted">none</span>' :
            esc(c.hist.toLowerCase()) + ' <span class="muted">' + esc(plural(c.buckets, 'bucket')) + '</span>') },
          { key: 'ndv', label: 'Distinct', num: true, tip: 'NUM_DISTINCT', html: (c) => fmtN(c.ndv) },
          { key: 'nulls', label: 'Nulls', num: true, tip: 'NUM_NULLS', html: (c) => fmtN(c.nulls) },
          { key: 'rows', label: 'Table rows', num: true, tip: 'NUM_ROWS of the table', html: (c) => fmtN(c.rows) },
          { key: 'analyzed', label: 'Column analyzed', cls: 't', html: (c) => (c.analyzed ? esc(fmtT(c.analyzed)) : '<span class="err">never</span>') },
          { key: 'tabAnalyzed', label: 'Table analyzed', cls: 't', html: (c) => esc(fmtT(c.tabAnalyzed)) +
            (c.analyzed && c.tabAnalyzed - c.analyzed > 36e5 ? ' <span class="muted">(' + esc(fmtDur((c.tabAnalyzed - c.analyzed) / 1000)) + ' later)</span>' : '') },
          { key: 'prefs', label: 'Preferences', cls: 'wrap prefs', val: (c) => c.prefs.length,
            html: (c) => {
              const key = c.prefs.filter((p) => /^(METHOD_OPT|ESTIMATE_PERCENT)$/.test(p.pref));
              const rest = c.prefs.length - key.length;
              return '<div class="pills">' + key.map((p) => '<span class="pill">' + esc(p.pref) + '=' + esc(p.value) + '</span>').join(' ') +
                (rest ? ' <span class="pill" data-tip="' + esc(c.prefs.map((p) => esc(p.pref) + ' = ' + esc(p.value)).join('<br>')) + '">' + (key.length ? '+' : '') + plural(rest, 'preference') + '</span>' : '') + '</div>';
            } },
          { key: 'fix', label: 'Gather', val: () => null, html: (c) => {
            const cmd = fixScript([c], colFixCmd);
            return '<button type="button" class="copy" data-copy="' + esc(cmd) + '" data-tip="' + esc('<code>' + esc(cmd).replace(/\n/g, '<br>') + '</code><br><span class="muted">Click to copy. Gathers the whole table with its preferences.</span>') + '">Copy</button>';
          } }
        ]
      });
    }
    if (sel('#c-con')) sel('#c-con').onchange = () => { host._t.limit = 300; apply(); };
    let qt;
    sel('#c-q').oninput = () => { clearTimeout(qt); qt = setTimeout(apply, 180); };
    apply();
  }

  // ------------------------------------------------------------ one table
  // Everything the report knows about one table: its statistics now, the
  // preferences in force, whether incremental statistics are set up and in
  // use, and every gather that touched it in the period.
  let TABLE_INDEX = null;
  function tableIndex() {
    if (TABLE_INDEX) return TABLE_INDEX;
    const by = new Map();
    const add = (con, name) => {
      const k = conKey(con, name);
      let x = by.get(k);
      if (!x) by.set(k, x = { con: con, name: name, om: isOM(con, name.split('.')[0]), tab: TABMAP.get(k) || null, gathers: 0, last: null, prefs: TPREFMAP.get(k) || [] });
      return x;
    };
    TABS.forEach((t) => add(t.con, t.name));
    const seen = new Set();
    TASKS.forEach((t) => {
      if (!t.tab || !t.op || t.op.kind === 'other') return;
      const x = add(t.con, t.tab);
      const rk = t.tab + '|' + t.op.key;
      if (seen.has(rk)) return;
      seen.add(rk);
      x.gathers++;
      if (!x.last || t.op.start > x.last.start) x.last = t.op;
    });
    BL.forEach((b) => add(b.con, b.owner + '.' + b.table));
    NEAR.forEach((b) => add(b.con, b.owner + '.' + b.table));
    COLS.forEach((c) => add(c.con, c.name));
    TABLE_INDEX = [...by.values()];
    return TABLE_INDEX;
  }
  const isTrue = (v) => /^TRUE$/i.test(v || '');
  // The gathers of one table, one row per operation
  function tableRuns(con, name) {
    const runs = new Map();
    TASKS.forEach((t) => {
      if (t.con !== con || t.tab !== name || !t.op || t.op.kind === 'other') return;
      let r = runs.get(t.op);
      if (!r) runs.set(t.op, r = { op: t.op, glob: [], parts: [], idx: [], secs: 0, failed: 0, hist: 0, n: 0 });
      (/^TABLE/.test(t.type) ? (t.piece ? r.parts : r.glob) : r.idx).push(t);
      r.secs += t.secs || 0; r.n++;
      if (t.status === 'FAILED') r.failed++;
      if (t.hist.length) r.hist++;
    });
    return [...runs.values()].sort((a, b) => a.op.start - b.op.start);
  }
  // Is the incremental-statistics setup of this table consistent, and do the
  // gathers show it working?  One row per check.
  function incChecks(con, key, tab, runs, pref) {
    const out = [];
    const chk = (sev, what, value, why) => out.push({ sev: sev, what: what, value: value, why: why || '' });
    const seenParts = new Set();
    runs.forEach((r) => r.parts.forEach((t) => seenParts.add(t.piece)));
    const parted = tab ? !!tab.ptype : seenParts.size > 0;
    const nparts = (tab && tab.nparts) || seenParts.size;
    const inc = pref('INCREMENTAL'), incOn = isTrue(inc.v);
    const src = (p) => (p.src === 'table' ? 'table preference' : 'global preference');
    if (!parted) {
      chk('info', 'Partitioned', 'no', 'Incremental statistics apply to partitioned tables only.');
      if (inc.src === 'table' && incOn) chk('warn', 'INCREMENTAL', inc.v + ' (' + src(inc) + ')', 'No effect on a table without partitions.');
      return { checks: out, verdict: { sev: 'info', label: 'Not applicable' } };
    }
    chk('good', 'Partitioned', (tab && tab.ptype ? tab.ptype.toLowerCase() + (tab.subptype && tab.subptype !== 'NONE' ? ' / ' + tab.subptype.toLowerCase() : '') + ', ' : '') + plural(nparts, 'partition') + (tab && tab.interval ? ', interval' : ''), '');
    chk(incOn ? 'good' : 'warn', 'INCREMENTAL', (inc.v || 'unknown') + ' (' + src(inc) + ')', incOn ? '' : 'Off: a changed partition makes the whole table stale, and the global statistics need a full scan.');
    const pub = pref('PUBLISH');
    chk(isTrue(pub.v) ? 'good' : incOn ? 'crit' : 'info', 'PUBLISH', (pub.v || 'unknown') + ' (' + src(pub) + ')', isTrue(pub.v) ? '' : 'Incremental statistics need PUBLISH=TRUE.');
    const ep = pref('ESTIMATE_PERCENT'), epAuto = /AUTO_SAMPLE_SIZE/i.test(ep.v || '');
    chk(epAuto ? 'good' : incOn ? 'crit' : 'info', 'ESTIMATE_PERCENT', (ep.v || 'unknown') + ' (' + src(ep) + ')', epAuto ? '' : 'Synopses are only built with AUTO_SAMPLE_SIZE. With a fixed percent every gather rescans the table for the global statistics.');
    const gr = pref('GRANULARITY'), g = (gr.v || '').toUpperCase();
    const grOk = /^(AUTO|ALL|DEFAULT|GLOBAL AND PARTITION|APPROX_GLOBAL AND PARTITION)$/.test(g);
    chk(grOk ? 'good' : 'warn', 'GRANULARITY', (gr.v || 'unknown') + ' (' + src(gr) + ')', grOk ? '' : g === 'GLOBAL' ? 'Partition statistics are never gathered.' : 'Global statistics are not refreshed by these gathers.');
    const st = pref('INCREMENTAL_STALENESS');
    chk('info', 'INCREMENTAL_STALENESS', (st.v || 'NULL') + ' (' + src(st) + ')', /USE_STALE_PERCENT/i.test(st.v || '') ? 'A partition is regathered only past STALE_PERCENT.' : 'Any change makes a partition stale and regathered.');
    const lvl = (TPREFMAP.get(key) || []).find((p) => p.pref === 'INCREMENTAL_LEVEL');
    if (lvl) chk('info', 'INCREMENTAL_LEVEL', lvl.value + ' (table preference)', lvl.value === 'TABLE' ? 'A table-level synopsis too, for partition exchange.' : '');
    const syn = SYN.get(key);
    if (missing.includes('syn')) chk('info', 'Synopses', 'not checked', 'No access to SYS.WRI$_OPTSTAT_SYNOPSIS_HEAD$.');
    else if (syn) {
      const full = syn.parts >= nparts;
      chk(full ? 'good' : 'warn', 'Synopses', fmtN(syn.parts) + ' of ' + plural(nparts, 'partition') + ', newest ' + fmtT(syn.newest),
        full ? 'Every partition has one: the global statistics come from the synopses.' : 'Partitions without one are rescanned at the next gather of the global statistics (gathered before INCREMENTAL was set, or with a fixed ESTIMATE_PERCENT).');
    } else chk(incOn ? 'crit' : 'info', 'Synopses', 'none', incOn ? 'No partition has a synopsis: incremental statistics have not been used on this table yet. The next gather scans every partition once to build them.' : 'Built by the first gather with INCREMENTAL=TRUE.');
    const withGlob = runs.filter((r) => r.glob.length);
    if (!runs.length) chk('info', 'Gathers in the period', 'none', '');
    else if (incOn) {
      const full = withGlob.filter((r) => nparts >= 2 && r.parts.length >= 0.9 * nparts);
      const med = withGlob.map((r) => r.parts.length).sort((a, b) => a - b);
      const gsecs = withGlob.reduce((a, r) => a + r.glob.reduce((x, t) => x + (t.secs || 0), 0), 0) / Math.max(1, withGlob.length);
      if (full.length > 1) chk('warn', 'Gathers in the period', fmtN(full.length) + ' of ' + plural(withGlob.length, 'gather') + ' regathered every partition', 'Once is expected (the first incremental gather). Repeated full regathers mean the synopses are rebuilt each time: check ESTIMATE_PERCENT and INCREMENTAL_STALENESS, and the parameters of manual gathers below.');
      else if (withGlob.length) chk('good', 'Gathers in the period', plural(withGlob.length, 'gather') + ', typically ' + plural(med[Math.floor(med.length / 2)], 'partition') + ' each, global statistics in ' + fmtDur(gsecs), full.length ? 'One gather took every partition: the first incremental gather.' : 'Only changed partitions were regathered.');
      else chk('info', 'Gathers in the period', plural(runs.length, 'gather') + ', partitions only', 'The global statistics were not touched.');
    } else if (withGlob.length) {
      const gsecs = withGlob.reduce((a, r) => a + r.glob.reduce((x, t) => x + (t.secs || 0), 0), 0) / withGlob.length;
      chk('info', 'Gathers in the period', plural(withGlob.length, 'gather') + ' of the global statistics, ' + fmtDur(gsecs) + ' each on average', 'The whole table is scanned each time.');
    }
    const worst = out.reduce((w, c) => (SEV_RANK[c.sev] > SEV_RANK[w] ? c.sev : w), 'good');
    const verdict = worst === 'crit' ? { sev: 'crit', label: 'Broken' } : worst === 'warn' ? { sev: 'warn', label: incOn ? 'Needs attention' : 'Off' } : { sev: 'good', label: incOn ? 'In use' : 'Off' };
    return { checks: out, verdict: verdict };
  }
  // Gathers of one table over the period: one column per gather, stacked
  // by what it took (global, partitions, indexes)
  function tableRunsSVG(width, runs, metric) {
    const ax = dayAxis(width);
    const top = 8, H = 150, bottom = 22;
    const parts = (r) => (metric === 'secs' ? [r.glob, r.parts, r.idx].map((l) => l.reduce((a, t) => a + (t.secs || 0), 0)) : [r.glob.length, r.parts.length, r.idx.length]);
    const max = niceMax(Math.max(0, ...runs.map((r) => parts(r).reduce((a, b) => a + b, 0))));
    const y = (v) => top + (H - top - bottom) * (1 - v / max);
    const fmt = metric === 'secs' ? fmtDur : compact;
    let s = '<svg width="' + width + '" height="' + H + '" role="img" aria-label="Gathers of this table over time">';
    for (let i = 0; i < ax.nd; i++) {
      if (isWeekend(ax.d0 + i * DAY)) s += '<rect class="weekend" x="' + (PLOT_L + i * ax.cw) + '" y="' + top + '" width="' + ax.cw + '" height="' + (H - top - bottom) + '"/>';
    }
    [0, max / 2, max].forEach((v) => {
      s += '<line class="' + (v ? 'grid' : 'axis') + '" x1="' + PLOT_L + '" x2="' + (PLOT_L + ax.W) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      s += '<text x="' + (PLOT_L - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(v ? fmt(v) : '0') + '</text>';
    });
    const w = Math.max(3, Math.min(10, ax.cw * 0.3));
    runs.forEach((r) => {
      const cx = ax.x(r.op.start);
      const seg = parts(r);
      let base = 0;
      s += '<rect class="hit" x="' + (cx - 6) + '" y="' + top + '" width="12" height="' + (H - top - bottom) + '" data-href="#run/' + r.op.key + '" data-tip="' + esc(tableRunTip(r)) + '"/>';
      ['f-s1', 'f-s2', 'f-s3'].forEach((cls, i) => {
        if (!(seg[i] > 0)) return;
        const y1 = y(base + seg[i]), y0 = y(base);
        s += '<rect class="mark ' + (r.failed && i === 0 ? 'f-crit' : cls) + '" pointer-events="none" x="' + (cx - w / 2) + '" y="' + y1 + '" width="' + w + '" height="' + Math.max(1, y0 - y1) + '"/>';
        base += seg[i];
      });
    });
    s += dayLabels(ax, H - 4);
    return s + '</svg>';
  }
  function tableRunTip(r) {
    const o = r.op;
    const names = [...new Set(r.parts.map((t) => t.piece))];
    return '<b>' + esc(opLabel(o)) + (o.kind === 'auto' ? '' : ' ' + esc(opTarget(o))) + '</b><br>' + esc(fmtT(o.start, true)) + ', ' + esc(o.v.label) +
      '<br>Global statistics: ' + (r.glob.length ? esc(fmtDur(r.glob.reduce((a, t) => a + (t.secs || 0), 0))) + (r.glob.some((t) => t.status === 'FAILED') ? ' <span class="muted">failed</span>' : '') : 'not gathered') +
      '<br>Partitions: ' + (names.length ? fmtN(names.length) + ' <span class="muted">' + esc(names.slice(0, 6).join(', ')) + (names.length > 6 ? ', +' + fmtN(names.length - 6) : '') + '</span>' : 'none') +
      '<br>Indexes: ' + (r.idx.length ? fmtN(r.idx.length) : 'none') +
      '<br>' + esc(fmtDur(r.secs)) + (r.hist ? ', histograms on ' + plural(r.hist, 'object') : '') + (r.failed ? ', <span class="muted">' + plural(r.failed, 'object') + ' failed</span>' : '');
  }
  // Which partition each gather took: partitions down, gathers across
  function partMatrixSVG(width, runs, nparts) {
    const seen = new Map();
    runs.forEach((r) => r.parts.forEach((t) => { const x = seen.get(t.piece); if (!x || t.start > x) seen.set(t.piece, t.start || 0); }));
    const MAXR = 120;
    let names = [...seen.keys()].sort();
    const cut = names.length > MAXR;
    if (cut) names = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAXR).map((e) => e[0]).sort();
    const rowsAll = ['table (global)'].concat(names);
    const L = 190, R = 8, top = 4, bottom = 30, rh = 14;
    const W = Math.max(200, width - L - R);
    const cw = Math.max(5, Math.min(22, W / runs.length));
    const H = top + rowsAll.length * rh + bottom;
    let s = '<svg width="' + (L + runs.length * cw + R) + '" height="' + H + '" role="img" aria-label="Which partitions each gather took">';
    rowsAll.forEach((n, i) => {
      s += '<text x="' + (L - 8) + '" y="' + (top + i * rh + 11) + '" text-anchor="end"' + (i ? '' : ' style="fill:var(--ink-2)"') + '>' + esc(shortName(n, 26)) + '</text>';
    });
    runs.forEach((r, j) => {
      const x = L + j * cw;
      const cells = new Map();
      r.glob.forEach((t) => cells.set(rowsAll[0], t));
      r.parts.forEach((t) => cells.set(t.piece, t));
      rowsAll.forEach((n, i) => {
        const t = cells.get(n);
        const y = top + i * rh;
        if (!t) { s += '<rect class="cell-empty" x="' + (x + 0.5) + '" y="' + (y + 0.5) + '" width="' + (cw - 1) + '" height="' + (rh - 1) + '"/>'; return; }
        s += '<rect class="mark ' + (i ? typeClass(t) : t.status === 'FAILED' ? 'f-crit' : t.status !== 'COMPLETED' ? 'f-warn' : 'f-s1') + '" x="' + (x + 0.5) + '" y="' + (y + 0.5) + '" width="' + (cw - 1) + '" height="' + (rh - 1) + '" rx="2" data-href="#run/' + r.op.key + '" data-tip="' +
          esc('<b>' + esc(i ? n : 'global statistics') + '</b><br>' + esc(opLabel(r.op)) + ', ' + esc(fmtT(r.op.start, true)) + '<br>' + esc(t.status.toLowerCase()) + ', ' + esc(fmtDur(t.secs)) + (t.hist.length ? '<br>Histograms: ' + esc(t.hist.join(', ')) : '')) + '"/>';
      });
    });
    // one date label per ~70 px
    const every = Math.max(1, Math.ceil(70 / cw));
    let lastDay = '';
    runs.forEach((r, j) => {
      if (j % every) return;
      const d = fmtT(r.op.start).slice(5, 10);
      s += '<text x="' + (L + j * cw + cw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(d === lastDay ? fmtClock(r.op.start) : d) + '</text>';
      lastDay = d;
    });
    const note = (cut ? 'The ' + MAXR + ' most recently gathered of ' + plural(seen.size, 'partition') + '. ' : '') +
      (nparts > seen.size ? plural(nparts - seen.size, 'partition') + ' of ' + fmtN(nparts) + ' not gathered in the period.' : '');
    return { svg: s + '</svg>', note: note };
  }
  let tabMetric = 'objects';
  function viewTable(q, conStr, nameEnc) {
    const v = document.getElementById('view');
    const name = nameEnc ? decodeURIComponent(nameEnc) : '';
    const con = conStr ? Number(conStr) : null;
    const text = (q.get('q') || '').toLowerCase();
    let h = missingBox();
    h += '<div class="filters tb-find"><input type="search" id="tb-q" placeholder="Find a table: owner.table" aria-label="Find a table" value="' + esc(text) + '"><span class="count" id="tb-n"></span></div>';
    if (!name) {
      h += sec('Tables', 'Tables a gather touched in the period, with a table preference, or partitioned. Open one for its statistics, preferences, incremental setup and gather history.', '<div id="tb-list"></div>');
      v.innerHTML = h;
      const host = v.querySelector('#tb-list');
      host._t = { sort: parseSort(q.get('s'), ['gathers', -1]), limit: 300 };
      const box = v.querySelector('#tb-q');
      const apply = () => {
        const t = box.value.trim().toLowerCase();
        const params = new URLSearchParams();
        if (t) params.set('q', t);
        const sp = sortParam(host._t.sort);
        if (sp && sp !== '-gathers') params.set('s', sp);
        setBaseHash('#table' + (params.toString() ? '?' + params.toString() : ''));
        const all = tableIndex().filter((x) => !t || x.name.toLowerCase().includes(t));
        const list = all.filter((x) => showOM || !x.om);
        v.querySelector('#tb-n').innerHTML = esc(plural(list.length, 'table')) + omHint(all.length - list.length);
        renderTable(host, {
          rows: list, empty: 'No table matches.', href: (x) => tabHref(x.con, x.name), onSort: () => apply(),
          cols: [
            { key: 'name', label: 'Table', cls: 'wrap', html: (x) => '<code>' + esc(x.name) + '</code>' + (CONS.size > 1 ? ' <span class="pill">' + esc(conName(x.con)) + '</span>' : '') },
            { key: 'parts', label: 'Partitions', num: true, val: (x) => (x.tab ? x.tab.nparts : null), html: (x) => (x.tab && x.tab.ptype ? fmtN(x.tab.nparts || 0) + ' <span class="muted">' + esc(x.tab.ptype.toLowerCase()) + '</span>' : '') },
            { key: 'inc', label: 'Incremental', val: (x) => { const p = x.prefs.find((p) => p.pref === 'INCREMENTAL'); return p ? p.value : null; },
              html: (x) => { const p = x.prefs.find((p) => p.pref === 'INCREMENTAL'); return p ? '<code>' + esc(p.value) + '</code>' : (x.tab && x.tab.ptype ? '<span class="muted">' + esc(PREFS.get('INCREMENTAL') || '') + '</span>' : ''); } },
            { key: 'rows', label: 'Rows', num: true, val: (x) => (x.tab ? x.tab.rows : null), html: (x) => (x.tab ? fmtN(x.tab.rows) : '') },
            { key: 'analyzed', label: 'Analyzed', cls: 't', val: (x) => (x.tab ? x.tab.analyzed : null), html: (x) => (x.tab ? (x.tab.analyzed ? esc(fmtT(x.tab.analyzed)) : '<span class="err">never</span>') : '') },
            { key: 'stale', label: 'Now', val: (x) => (x.tab ? (x.tab.stale ? 1 : 0) + (x.tab.pStale ? 1 : 0) : null),
              html: (x) => (!x.tab ? '' : x.tab.stale ? sevBadge('warn', 'stale') : x.tab.pStale ? sevBadge('warn', plural(x.tab.pStale, 'stale partition')) : x.tab.pMissing ? sevBadge('warn', plural(x.tab.pMissing, 'partition') + ' without statistics') : x.tab.analyzed ? sevBadge('good', 'fresh') : '') },
            { key: 'gathers', label: 'Gathers', num: true, tip: 'Operations that touched the table or its partitions and indexes in the period', html: (x) => fmtN(x.gathers) },
            { key: 'last', label: 'Last gather', cls: 't', val: (x) => (x.last ? x.last.start : null), html: (x) => (x.last ? esc(fmtT(x.last.start)) : '') }
          ]
        });
      };
      let qt;
      box.oninput = () => { clearTimeout(qt); qt = setTimeout(apply, 180); };
      apply();
      return;
    }
    const key = conKey(con, name);
    const tab = TABMAP.get(key) || null;
    const owner = name.split('.')[0], tname = name.split('.').slice(1).join('.');
    const runs = tableRuns(con, name);
    const prefs = TPREFMAP.get(key) || [];
    const pref = (n) => { const p = prefs.find((x) => x.pref === n); return p ? { v: p.value, src: 'table' } : { v: PREFS.get(n), src: 'global' }; };
    const bl = BL.filter((b) => b.con === con && b.owner === owner && b.table === tname);
    const near = NEAR.filter((b) => b.con === con && b.owner === owner && b.table === tname);
    const cols = COLS.filter((c) => c.con === con && c.name === name);
    const inc = incChecks(con, key, tab, runs, pref);
    const nparts = (tab && tab.nparts) || 0;

    const facts = [];
    if (CONS.size > 1) facts.push(['Container', esc(conName(con))]);
    if (tab) {
      facts.push(['Partitioning', tab.ptype ? esc(tab.ptype.toLowerCase()) + (tab.subptype && tab.subptype !== 'NONE' ? ' / ' + esc(tab.subptype.toLowerCase()) : '') + ', ' + esc(plural(nparts, 'partition')) + (tab.interval ? ', interval' : '') : 'none']);
      facts.push(['Rows', tab.rows != null ? fmtN(tab.rows) + ' <span class="muted">(' + fmtN(tab.blocks) + ' blocks, in the statistics)</span>' : '<span class="muted">no statistics</span>']);
      facts.push(['Statistics', (tab.analyzed ? esc(fmtT(tab.analyzed)) + ' <span class="muted">(' + esc(fmtAgo(tab.analyzed)) + ')</span> ' + (tab.stale ? sevBadge('warn', 'stale') : sevBadge('good', 'fresh')) : '<span class="err">never gathered</span>') +
        (tab.locked ? ' <span class="pill">locked ' + esc(tab.locked.toLowerCase()) + '</span>' : '')]);
      if (tab.ptype) facts.push(['Partitions', esc(fmtN(nparts)) + (tab.pStale ? ', <span class="err">' + esc(fmtN(tab.pStale)) + ' stale</span>' : '') + (tab.pMissing ? ', <span class="err">' + esc(fmtN(tab.pMissing)) + ' without statistics</span>' : '') +
        (tab.pOldest ? '<br><span class="muted">analyzed between ' + esc(fmtT(tab.pOldest)) + ' and ' + esc(fmtT(tab.pNewest)) + '</span>' : '')]);
    } else {
      facts.push(['Statistics', '<span class="muted">not in this report (max_backlog reached, or the table is gone)</span>']);
    }
    const auto = runs.filter((r) => r.op.kind === 'auto').length;
    facts.push(['Gathers in ' + DAYS + ' days', runs.length ? fmtN(runs.length) + ' <span class="muted">(' + fmtN(auto) + ' automatic, ' + fmtN(runs.length - auto) + ' manual or custom)</span>, last ' + esc(fmtT(runs[runs.length - 1].op.start)) : '<span class="muted">none</span>']);
    const now = [];
    if (bl.length) {
      const cnt = {};
      bl.forEach((b) => { cnt[b.cat] = (cnt[b.cat] || 0) + 1; });
      now.push('<a href="#backlog?q=' + encodeURIComponent(name.toLowerCase()) + '">' + esc(plural(bl.length, 'object')) + ' need statistics</a>: ' + CAT_ORDER.filter((c) => cnt[c]).map((c) => sevBadge(CATS[c].sev, fmtN(cnt[c]) + ' ' + CATS[c].title.toLowerCase(), CATS[c].text)).join(' '));
    }
    if (near.length) now.push('<a href="#backlog?q=' + encodeURIComponent(name.toLowerCase()) + '">' + esc(plural(near.length, 'object')) + ' close to stale</a>');
    if (cols.length) now.push('<a href="#columns?q=' + encodeURIComponent(name.toLowerCase()) + '">' + esc(plural(cols.length, 'column')) + ' with doubtful statistics</a>');
    facts.push(['Needs attention', now.length ? now.join('<br>') : '<span class="muted">nothing</span>']);
    const cmd = fixScript([{ con: con, owner: owner, table: tname, locked: tab && tab.locked, cat: '' }]);
    facts.push(['Gather', '<button type="button" class="copy" data-copy="' + esc(cmd) + '" data-tip="' + esc('<code>' + esc(cmd).replace(/\n/g, '<br>') + '</code><br><span class="muted">Click to copy</span>') + '">Copy statement</button>']);
    const kv = '<dl class="kv">' + facts.map((f) => '<dt>' + f[0] + '</dt><dd>' + f[1] + '</dd>').join('') + '</dl>';
    const KEYP = ['INCREMENTAL', 'INCREMENTAL_STALENESS', 'INCREMENTAL_LEVEL', 'PUBLISH', 'ESTIMATE_PERCENT', 'GRANULARITY', 'METHOD_OPT', 'STALE_PERCENT', 'CASCADE', 'DEGREE', 'CONCURRENT', 'NO_INVALIDATE', 'OPTIONS'];
    const prefRows = KEYP.filter((p) => prefs.some((x) => x.pref === p) || PREFS.has(p)).map((p) => {
      const x = pref(p);
      return '<tr' + (x.src === 'table' ? ' class="own"' : '') + '><td>' + esc(p) + '</td><td><code>' + esc(x.v == null ? '' : x.v) + '</code></td><td class="muted">' + (x.src === 'table' ? 'table' : con !== META.conId ? '<span data-tip="' + esc('Global preference of ' + esc(META.con) + ', the container the report ran in') + '">global*</span>' : 'global') + '</td></tr>';
    }).concat(prefs.filter((x) => KEYP.indexOf(x.pref) < 0).map((x) => '<tr class="own"><td>' + esc(x.pref) + '</td><td><code>' + esc(x.value) + '</code></td><td class="muted">table</td></tr>'));
    const prefTable = '<div class="tablewrap"><table class="prefs-t"><thead><tr><th>Preference</th><th>Value</th><th>Set at</th></tr></thead><tbody>' + prefRows.join('') + '</tbody></table></div>';

    h += '<section class="sec tb-head"><header><h2><code>' + esc(name) + '</code></h2>' + (CONS.size > 1 ? '<span class="pill">' + esc(conName(con)) + '</span>' : '') + '</header></section>';
    h += sec('Incremental statistics', '', '<div class="surface"><div class="tablewrap"><table class="checks"><tbody>' +
      inc.checks.map((c) => '<tr><td>' + sevBadge(c.sev, c.what) + '</td><td>' + esc(c.value) + '</td><td class="muted wrap">' + esc(c.why) + '</td></tr>').join('') +
      '</tbody></table></div></div>', sevBadge(inc.verdict.sev, inc.verdict.label));
    h += '<div class="split">' + sec('Statistics now', '', '<div class="surface">' + kv + '</div>') +
      sec('Preferences in force', 'Table preferences override the global ones.', '<div class="surface">' + prefTable + '</div>') + '</div>';
    if (runs.length) {
      h += sec('Gathers over time', 'One column per gather. Hover for what it took, click to open it.',
        '<div class="surface"><div class="plot" id="tb-runs"></div><div class="legend"><span><b class="s1"></b>Global (table) statistics</span><span><b class="s2"></b>Partitions</span><span><b class="s3"></b>Indexes</span><span><b class="crit"></b>Failed</span></div></div>',
        seg('tb-metric', [['objects', 'Objects'], ['secs', 'Time']], tabMetric));
      if (runs.some((r) => r.parts.length)) {
        h += sec('Partitions per gather', 'A filled cell: the gather took that partition. With incremental statistics in use, only changed partitions fill and the global row is fast.',
          '<div class="surface"><div class="tablewrap" id="tb-matrix"></div><div class="legend"><span><b class="s1"></b>Global</span><span><b class="s2"></b>Partition</span><span><b class="crit"></b>Failed</span><span><b class="warn"></b>Not completed</span></div><p class="note" id="tb-matrix-note"></p></div>');
      }
      h += sec('Gathers', '', '<div id="tb-gathers"></div>');
    } else {
      h += sec('Gathers', '', '<p class="muted">No gather touched this table in the last ' + DAYS + ' days.</p>');
    }
    v.innerHTML = h;
    const box = v.querySelector('#tb-q');
    let qt;
    box.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { location.hash = '#table?q=' + encodeURIComponent(box.value.trim().toLowerCase()); }, 250); };
    if (!runs.length) return;
    const drawRuns = () => { const p = v.querySelector('#tb-runs'); p.innerHTML = tableRunsSVG(p.clientWidth, runs, tabMetric); };
    drawRuns();
    wireSeg(v, 'tb-metric', (val) => { tabMetric = val; drawRuns(); });
    const mx = v.querySelector('#tb-matrix');
    if (mx) {
      const m = partMatrixSVG(mx.clientWidth, runs, nparts);
      mx.innerHTML = m.svg;
      v.querySelector('#tb-matrix-note').textContent = m.note;
    }
    const PARAMS = ['partname', 'granularity', 'estimate_percent', 'method_opt', 'cascade', 'degree'];
    renderTable(v.querySelector('#tb-gathers'), {
      rows: runs.slice().reverse(), sort: ['start', -1], limit: 100, href: (r) => '#run/' + r.op.key,
      cols: [
        { key: 'start', label: 'Started', cls: 't', desc: true, val: (r) => r.op.start, html: (r) => esc(fmtT(r.op.start, true)) },
        { key: 'op', label: 'Run', cls: 'wrap', val: (r) => opLabel(r.op), html: (r) => esc(opLabel(r.op)) + (r.op.kind === 'auto' ? '' : ' <code>' + esc(opTarget(r.op)) + '</code>') + (r.op.job ? ' <span class="pill">' + esc(r.op.job) + '</span>' : '') },
        { key: 'sev', label: 'Outcome', val: (r) => SEV_RANK[r.op.v.sev], html: (r) => sevBadge(r.op.v.sev, r.op.v.label, r.op.v.why) },
        { key: 'glob', label: 'Global', num: true, tip: 'Time of the table-level (global) statistics', val: (r) => (r.glob.length ? r.glob.reduce((a, t) => a + (t.secs || 0), 0) : null),
          html: (r) => (r.glob.length ? (r.glob.some((t) => t.status === 'FAILED') ? '<span class="err">failed</span> ' : '') + esc(fmtDur(r.glob.reduce((a, t) => a + (t.secs || 0), 0))) : '<span class="muted">no</span>') },
        { key: 'parts', label: 'Partitions', num: true, val: (r) => r.parts.length, html: (r) => (r.parts.length ? '<span data-tip="' + esc([...new Set(r.parts.map((t) => t.piece))].slice(0, 20).map(esc).join('<br>') + (r.parts.length > 20 ? '<br>+' + fmtN(r.parts.length - 20) + ' more' : '')) + '">' + fmtN(r.parts.length) + (nparts ? ' <span class="muted">of ' + fmtN(nparts) + '</span>' : '') + ', ' + esc(fmtDur(r.parts.reduce((a, t) => a + (t.secs || 0), 0))) + '</span>' : '') },
        { key: 'idx', label: 'Indexes', num: true, val: (r) => r.idx.length, html: (r) => (r.idx.length ? fmtN(r.idx.length) : '') },
        { key: 'hist', label: 'Histograms', num: true, tip: 'Objects on which histograms were created', html: (r) => (r.hist ? fmtN(r.hist) : '') },
        { key: 'secs', label: 'Time', num: true, html: (r) => esc(fmtDur(r.secs)) },
        { key: 'params', label: 'Parameters', cls: 'wrap', val: () => null, html: (r) => '<div class="pills">' + PARAMS.filter((k) => r.op.params[k] != null && r.op.params[k] !== '' && !/^DEFAULT_|^NULL$/.test(r.op.params[k])).map((k) => '<span class="pill">' + esc(k) + '=' + esc(r.op.params[k]) + '</span>').join(' ') + '</div>' }
      ]
    });
  }

  // ------------------------------------------------------------ setup
  function viewConfig() {
    const v = document.getElementById('view');
    let h = missingBox();
    const atc = '<div class="surface"><div class="tablewrap"><table><thead><tr><th>Container</th><th>Status</th><th>Window group</th><th class="num">Average job</th><th class="num">Longest in the last 7 days</th><th>Attributes</th></tr></thead><tbody>' +
      (ATC.length ? ATC.map((a) => '<tr><td>' + esc(conName(a.con)) + '</td><td>' + sevBadge(a.status === 'ENABLED' ? 'good' : 'crit', a.status.toLowerCase()) + '</td><td><code>' + esc(a.group) + '</code></td><td class="num">' + esc(fmtDur(a.mean)) +
        '</td><td class="num">' + esc(fmtDur(a.max7)) + '</td><td class="muted">' + esc(a.attrs) + '</td></tr>').join('') : '<tr><td colspan="6" class="muted">No rows.</td></tr>') + '</tbody></table></div></div>';
    h += sec('Automatic statistics task', 'From DBA_AUTOTASK_CLIENT.', atc);
    h += sec('Scheduler windows', 'The automatic job runs only inside an open window of its group.', '<div class="surface"><div id="t-win"></div></div>');
    const prefNotes = {
      AUTOSTATS_TARGET: 'AUTO: all schemas. ORACLE: only Oracle-owned schemas.',
      STALE_PERCENT: 'Percent of rows changed before a table counts as stale.',
      CONCURRENT: 'Gather several objects at the same time.',
      AUTO_TASK_STATUS: 'High-frequency automatic task (Exadata and Autonomous only in 19c).',
      AUTO_TASK_MAX_RUN_TIME: 'Seconds, high-frequency task.',
      AUTO_TASK_INTERVAL: 'Seconds between high-frequency runs.'
    };
    h += '<div class="split">' + sec('Global preferences', 'DBMS_STATS.GET_PREFS in ' + esc(META.con || '') + '.',
      '<div class="surface"><div class="tablewrap"><table><thead><tr><th>Preference</th><th>Value</th></tr></thead><tbody>' +
      [...PREFS.entries()].map((p) => '<tr><td>' + esc(p[0]) + (prefNotes[p[0]] ? '<div class="note">' + esc(prefNotes[p[0]]) + '</div>' : '') + '</td><td><code>' + esc(p[1]) + '</code></td></tr>').join('') + '</tbody></table></div></div>') +
      sec('This report', '',
        '<div class="surface"><dl class="kv"><dt>Database</dt><dd>' + esc(META.db) + (META.dbUnique ? ' (' + esc(META.dbUnique) + ')' : '') + ', ' + esc(META.role || '') + ', ' + esc(META.openMode || '') + '</dd>' +
        '<dt>Version</dt><dd>' + esc(META.version) + '</dd><dt>Host</dt><dd>' + esc(META.host) + ', instance ' + esc(META.instance) + '</dd>' +
        '<dt>Period</dt><dd>' + esc(fmtT(T0)) + ' to ' + esc(fmtT(GEN)) + ' (' + DAYS + ' days)</dd>' +
        '<dt>History kept</dt><dd>' + esc(META.retention) + ' days; the oldest operation still available is from ' + esc(fmtT(ts(META.availability))) + '</dd>' +
        '<dt>Collected as</dt><dd>' + esc(META.user) + ' in ' + esc(META.con) + '</dd>' +
        '<dt>Rows embedded</dt><dd>' + fmtN(OPS.length) + ' operations, ' + fmtN(TASKS.length) + ' objects (at most ' + fmtN(META.maxTasks) + ' per run), ' + fmtN(BL.length) + ' needing statistics, ' + fmtN(COLS.length) + ' columns, ' + fmtN(NEAR.length) + ' close to stale</dd></dl></div>') + '</div>';
    h += sec('DML monitoring', 'DBA_TAB_MODIFICATIONS. Changes since the newest row are still in memory; this report does not flush them.',
      '<div class="surface"><div class="tablewrap"><table><thead><tr><th>Container</th><th class="num">Tables and partitions with counters</th><th>Newest counters</th><th>STATISTICS_LEVEL</th></tr></thead><tbody>' +
      (MON.length ? MON.map((m) => '<tr><td>' + esc(conName(m.con)) + '</td><td class="num">' + fmtN(m.n) + '</td><td>' + esc(fmtT(m.newest)) + (m.newest ? ' <span class="muted">' + esc(GEN - m.newest < 60e3 ? 'while the report ran' : fmtAgo(m.newest)) + '</span>' : '') +
        '</td><td>' + (/^BASIC$/i.test(m.level || '') ? sevBadge('crit', 'BASIC: monitoring off') : '<code>' + esc(m.level) + '</code>') + '</td></tr>').join('')
        : '<tr><td colspan="4" class="muted">' + (missing.includes('mon') ? 'Not collected.' : 'No DML-monitoring rows.') + '</td></tr>') + '</tbody></table></div>' +
      '<p class="note" style="margin-block-start:0.75rem">STATISTICS_LEVEL is that of ' + esc(META.con || 'the current container') + '.</p></div>');
    h += sec('Table preferences', 'DBA_TAB_STAT_PREFS, application schemas first.', '<div class="surface"><div id="t-tp"></div></div>');
    v.innerHTML = h;
    renderTable(v.querySelector('#t-win'), {
      rows: WCFG.slice().sort((a, b) => a.con - b.con || (a.next || 9e15) - (b.next || 9e15)), limit: 100,
      cols: [
        { key: 'con', label: 'Container', html: (w) => esc(conName(w.con)) },
        { key: 'name', label: 'Window', html: (w) => esc(w.name) + (w.maint ? ' <span class="pill">maintenance</span>' : '') },
        { key: 'enabled', label: 'Enabled', html: (w) => (w.enabled === 'TRUE' ? 'yes' : '<span class="err">no</span>') + (w.active === 'TRUE' ? ' <span class="pill">open now</span>' : '') },
        { key: 'secs', label: 'Length', num: true, html: (w) => esc(fmtDur(w.secs)) },
        { key: 'repeat', label: 'Repeat interval', cls: 'wrap', html: (w) => '<code>' + esc(w.repeat) + '</code>' },
        { key: 'last', label: 'Last opened', cls: 't', html: (w) => esc(fmtT(w.last)) },
        { key: 'next', label: 'Next', cls: 't', html: (w) => esc(fmtT(w.next)) }
      ]
    });
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

  // ------------------------------------------------------------ router
  // The run detail opens as a drawer over the view it was opened from.
  let baseHash = null, renderedBase = null, closingByRoute = false, keepScroll = false;
  function setBaseHash(hs) {
    baseHash = hs;
    renderedBase = hs.replace(/^#/, '');
    if (location.hash !== hs && !location.hash.startsWith('#run/')) history.replaceState(null, '', location.pathname + location.search + hs);
  }
  function wireDrawer() {
    const d = document.getElementById('drawer');
    d.addEventListener('close', () => {
      hideTip();
      if (!closingByRoute && location.hash.startsWith('#run/')) location.hash = baseHash || '#overview';
    });
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }
  function renderBase(raw) {
    const qi = raw.indexOf('?');
    const path = (qi < 0 ? raw : raw.slice(0, qi)).split('/');
    const q = new URLSearchParams(qi < 0 ? '' : raw.slice(qi + 1));
    const view = path[0] || 'overview';
    document.querySelectorAll('.tabs a').forEach((a) => {
      if (a.getAttribute('data-v') === view || (view === 'overview' && a.getAttribute('data-v') === 'overview')) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const keep = keepScroll ? window.scrollY : 0;
    keepScroll = false;
    renderedBase = raw;
    baseHash = '#' + raw;
    if (view === 'runs') viewRuns(q);
    else if (view === 'backlog') viewBacklog(q);
    else if (view === 'columns') viewColumns(q);
    else if (view === 'table') viewTable(q, path[1], path.slice(2).join('/'));
    else if (view === 'config') viewConfig();
    else viewOverview(path[1]);
    if (!(view === 'overview' && path[1])) window.scrollTo(0, keep);
  }
  function route() {
    const raw = location.hash.replace(/^#/, '') || 'overview';
    hideTip();
    if (raw.startsWith('run/')) {
      if (renderedBase === null) renderBase(baseHash ? baseHash.slice(1) : 'overview');
      const p = raw.split('/');
      openRun(p[1], p[2]);
      return;
    }
    const d = document.getElementById('drawer');
    if (d.open) { closingByRoute = true; d.close(); closingByRoute = false; }
    if (raw !== renderedBase) renderBase(raw);
  }

  chrome();
  wireDrawer();
  wireGlobal();
  window.addEventListener('hashchange', () => route());
  route();
})();
