/* Application shell: state, file import, the left rail and the lap bar.
   The individual tabs live in views.js. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;
  const $ = (id) => document.getElementById(id);

  const TABS = [
    ['compare', 'Lap comparison'], ['map', 'Track map'], ['tables', 'Telemetry tables'],
    ['advice', 'Setup advice'], ['baseline', 'Baseline setup'], ['setups', 'Setups and differences'],
  ];

  const state = {
    sessions: [], activeId: null, A: null, B: null, tab: 'compare',
    speedUnit: 'kmh', setups: [], summaries: [], analysis: new Map(), messages: [], ui: {},
  };

  /* ---------- small helpers shared with views.js ---------- */

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const k of Object.keys(attrs || {})) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children || [])) if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }

  const speed = (ms) => (state.speedUnit === 'mph' ? ms * 2.236936 : ms * 3.6);
  const speedUnit = () => (state.speedUnit === 'mph' ? 'mph' : 'km/h');
  const simName = (s) => (s === 'iracing' ? 'iRacing' : s === 'lmu' ? 'Le Mans Ultimate' : s);
  const dateText = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const sessionById = (id) => state.sessions.find((s) => s.id === id) || null;
  const active = () => sessionById(state.activeId);

  /* Resolve a lap selection { sid, lap } to its session, lap and distance grid. */
  function pick(sel) {
    if (!sel) return null;
    const s = sessionById(sel.sid); if (!s) return null;
    const lap = s.laps[sel.lap]; if (!lap) return null;
    return { session: s, lap, grid: STA.session.lapGrid(s, lap) };
  }

  function analysisFor(session) {
    if (!state.analysis.has(session.id)) {
      const an = STA.handling.analyse(session);
      state.analysis.set(session.id, { an, adv: STA.advisor.advise(an, session.setup) });
    }
    return state.analysis.get(session.id);
  }

  function say(kind, text) {
    state.messages.unshift({ kind, text, id: U.uid('m') });
    state.messages = state.messages.slice(0, 6);
    renderMessages();
  }

  function busy(text, frac) {
    const el = $('busy');
    if (!text) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<span>' + U.esc(text) + '</span><span class="bar"><i style="width:' + Math.round(U.clamp(frac || 0, 0, 1) * 100) + '%"></i></span>';
  }

  /* ---------- library ---------- */

  async function refreshLibrary() {
    state.setups = await STA.library.setups();
    state.summaries = await STA.library.sessions();
  }

  /* ---------- import ---------- */

  const ext = (name) => (/\.([a-z0-9]+)$/i.exec(name) || [0, ''])[1].toLowerCase();

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    let added = 0;
    for (const file of files) {
      try {
        const e = ext(file.name);
        if (e === 'ibt') { await loadIbt(file); added++; }
        else if (e === 'duckdb') { await loadLmu(file); added++; }
        else if (e === 'svm') { await loadSvm(file); }
        else if (e === 'json') { await loadJson(file); }
        else say('warn', file.name + ': this file type is not supported. Use .ibt, .duckdb, .svm or a library export (.json).');
      } catch (err) {
        console.error(err);
        say('error', file.name + ': ' + (err && err.message ? err.message : String(err)));
      }
    }
    busy(null);
    await refreshLibrary();
    renderAll();
  }

  async function loadIbt(file) {
    busy('Reading ' + file.name, 0);
    const raw = await STA.ibt.read(file, { want: STA.session.IBT_WANT, onProgress: (f) => busy('Reading ' + file.name, f) });
    await addSession(STA.session.fromIbt(raw, file));
  }

  async function loadLmu(file) {
    busy('Starting the DuckDB reader (first use downloads about 35 MB)', 0.05);
    const db = await STA.duck.open(file);
    try {
      const raw = await STA.lmu.read(db, { onProgress: (f) => busy('Reading ' + file.name, f) });
      await addSession(STA.session.fromLmu(raw, file));
    } finally { await db.close(); }
  }

  async function loadSvm(file, quiet) {
    const text = await file.text();
    const rel = file.webkitRelativePath || '';
    const parts = rel.split('/'), folder = parts.length > 1 ? parts[parts.length - 2] : '';
    const setup = STA.setup.fromSvm(text, { name: file.name.replace(/\.svm$/i, ''), track: folder || 'Unknown track', createdAt: file.lastModified || Date.now() });
    if (!setup.params.length) throw new Error('no setup values found in this .svm file');
    const rec = await STA.library.saveSetup(setup);
    if (!rec.usage.lastUsed) await STA.library.updateSetup(rec.id, { usage: Object.assign(rec.usage, { lastUsed: file.lastModified || null }) });
    if (!quiet) say('ok', 'Added setup "' + setup.name + '" to the library' + (folder ? ' for ' + folder : '. Its track is unknown; set it in Setups and differences') + '.');
    return rec;
  }

  async function loadJson(file) {
    const data = JSON.parse(await file.text());
    const r = await STA.library.importAll(data);
    say('ok', 'Imported ' + r.setups + ' setups and ' + r.sessions + ' session summaries from ' + file.name + '.');
  }

  async function addSession(session) {
    const dup = state.sessions.findIndex((s) => s.id === session.id);
    if (dup >= 0) state.sessions.splice(dup, 1);
    state.sessions.push(session);
    state.analysis.delete(session.id);
    activate(session.id, true);
    for (const w of session.warnings) say('warn', session.meta.fileName + ': ' + w);
    for (const n of session.notes || []) say('info', session.meta.fileName + ': ' + n);

    // Remember the setup and a summary so later visits can find "what was I running here?"
    const summary = STA.session.summaryOf(session);
    if (session.refLap) {
      const { an } = analysisFor(session);
      summary.tendencies = an.findings.map((f) => ({ id: f.id, kind: f.kind, phase: f.phase, band: f.band, axle: f.axle, title: f.title }));
    }
    await STA.library.saveSession(summary);
    if (session.setup) await STA.library.recordUse(session.setup, summary);
  }

  function activate(id, resetLaps) {
    state.activeId = id;
    const s = sessionById(id); if (!s) return;
    // Switching session keeps laps A and B, so a lap from one session can be compared with a lap from another.
    if (resetLaps || !pick(state.A)) {
      const timed = s.laps.filter((l) => l.complete && l.valid).sort((a, b) => a.time - b.time);
      const any = s.laps.filter((l) => l.complete);
      const first = timed[0] || any[0] || s.laps[0];
      state.A = first ? { sid: id, lap: first.idx } : null;
      const second = timed[1] || any.find((l) => l !== first) || null;
      state.B = second ? { sid: id, lap: second.idx } : null;
    }
  }

  /* Read just the setups out of every supported file in a folder. */
  async function scanFolder(fileList) {
    const files = Array.from(fileList || []).filter((f) => /\.(svm|ibt|duckdb)$/i.test(f.name));
    if (!files.length) { say('warn', 'No .svm, .ibt or .duckdb files in that folder.'); return; }
    const cap = files.slice(0, 600);
    let found = 0, failed = 0;
    for (let i = 0; i < cap.length; i++) {
      const file = cap[i];
      busy('Scanning ' + (i + 1) + ' of ' + cap.length, i / cap.length);
      try {
        const e = ext(file.name);
        if (e === 'svm') { await loadSvm(file, true); found++; }
        else if (e === 'ibt') {
          const raw = await STA.ibt.read(file, { headerOnly: true });
          const info = raw.sessionInfo || {}, wk = info.WeekendInfo || {}, di = info.DriverInfo || {};
          if (!info.CarSetup) continue;
          const idx = parseInt(di.DriverCarIdx, 10), drv = (di.Drivers || []).find((d) => parseInt(d.CarIdx, 10) === idx) || {};
          const meta = { track: wk.TrackDisplayName || wk.TrackName || 'Unknown track', trackConfig: wk.TrackConfigName && wk.TrackConfigName !== 'N/A' ? wk.TrackConfigName : '' };
          const when = raw.header.startDate ? raw.header.startDate * 1000 : file.lastModified;
          const setup = STA.setup.fromIracing(info.CarSetup, { car: drv.CarScreenName || 'Unknown car', track: STA.session.trackName(meta),
            name: String(di.DriverSetupName || file.name).replace(/\.sto$/i, ''), createdAt: when });
          const rec = await STA.library.saveSetup(setup);
          if (!rec.usage.lastUsed || when > rec.usage.lastUsed) await STA.library.updateSetup(rec.id, { usage: Object.assign(rec.usage, { lastUsed: when }) });
          found++;
        } else {
          const db = await STA.duck.open(file);
          try {
            const mt = await STA.lmu.readMeta(db);
            if (!mt.CarSetup) continue;
            const meta = { track: mt.TrackName || 'Unknown track', trackConfig: mt.TrackLayout && mt.TrackLayout !== mt.TrackName ? mt.TrackLayout : '' };
            const when = Date.parse(String(mt.RecordingTime || '').replace(/_/g, ':')) || file.lastModified;
            const setup = STA.setup.fromLmuJson(mt.CarSetup, { car: mt.CarName || 'Unknown car', carClass: mt.CarClass || '', track: STA.session.trackName(meta), name: STA.session.runName(when), createdAt: when });
            const rec = await STA.library.saveSetup(setup);
            if (!rec.usage.lastUsed || when > rec.usage.lastUsed) await STA.library.updateSetup(rec.id, { usage: Object.assign(rec.usage, { lastUsed: when }) });
            found++;
          } finally { await db.close(); }
        }
      } catch (err) { failed++; console.warn(file.name, err); }
    }
    busy(null);
    say(found ? 'ok' : 'warn', 'Folder scan: ' + found + ' setups read' + (failed ? ', ' + failed + ' files could not be read' : '') + (files.length > cap.length ? ' (stopped after ' + cap.length + ' files)' : '') + '.');
    await refreshLibrary();
    renderAll();
  }

  /* ---------- rail ---------- */

  function renderMessages() {
    const box = $('messages'); box.innerHTML = '';
    for (const m of state.messages) {
      box.appendChild(h('div', { class: 'msg ' + m.kind }, [
        h('span', { class: 'msg-tag', text: m.kind === 'error' ? 'Problem' : m.kind === 'warn' ? 'Note' : m.kind === 'ok' ? 'Done' : 'Info' }),
        h('span', { class: 'msg-text', text: m.text }),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Dismiss', text: '×', onclick: () => { state.messages = state.messages.filter((x) => x.id !== m.id); renderMessages(); } }),
      ]));
    }
  }

  function renderSessions() {
    const box = $('session-list'); box.innerHTML = '';
    if (!state.sessions.length) { box.appendChild(h('p', { class: 'empty', text: 'No telemetry loaded yet. Add a file above to see laps, the track map and setup advice.' })); return; }
    for (const s of state.sessions) {
      const on = s.id === state.activeId;
      box.appendChild(h('div', { class: 'session' + (on ? ' on' : ''), role: 'button', tabindex: '0', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => { activate(s.id); renderAll(); }, onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(s.id); renderAll(); } } }, [
        h('div', { class: 'session-track', text: s.trackName }),
        h('div', { class: 'session-car', text: s.meta.car }),
        h('div', { class: 'session-file', text: s.meta.fileName, title: s.meta.fileName }),
        h('div', { class: 'session-meta' }, [
          h('span', { class: 'tag', text: simName(s.meta.sim) }),
          h('span', { text: dateText(s.meta.recordedAt) }),
          h('span', { class: 'num', text: s.bestLap ? U.fmtLap(s.bestLap.time) : 'no timed lap' }),
        ]),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Close this session', title: 'Close this session', text: '×', onclick: (ev) => {
          ev.stopPropagation();
          state.sessions = state.sessions.filter((x) => x.id !== s.id);
          if (state.A && state.A.sid === s.id) state.A = null;
          if (state.B && state.B.sid === s.id) state.B = null;
          if (state.activeId === s.id) { state.activeId = state.sessions.length ? state.sessions[0].id : null; if (state.activeId) activate(state.activeId, !state.A); }
          renderAll();
        } }),
      ]));
    }
  }

  function renderLaps() {
    const box = $('lap-list'), s = active(); box.innerHTML = '';
    $('laps-of').textContent = s ? 'in ' + s.trackName : '';
    if (!s) { box.appendChild(h('p', { class: 'empty', text: 'Laps appear here once a telemetry file is loaded.' })); return; }
    const best = s.bestLap ? s.bestLap.time : null;
    const rows = s.laps.map((l) => {
      const isA = state.A && state.A.sid === s.id && state.A.lap === l.idx, isB = state.B && state.B.sid === s.id && state.B.lap === l.idx;
      const status = !l.complete ? (l.note || 'partial') : l.pit ? 'pit lane' : !l.valid ? (l.note || 'not counted') : (l.note || '');
      return h('tr', { class: (isA ? 'is-a ' : '') + (isB ? 'is-b ' : '') + (l.complete && l.valid ? '' : 'dim') }, [
        h('td', { class: 'num', text: String(l.num) }),
        h('td', { class: 'num strong', text: l.complete ? U.fmtLap(l.time) : '–' }),
        h('td', { class: 'num', text: l.complete && l.valid && best != null ? (l.time === best ? 'best' : U.fmtDelta(l.time - best)) : '' }),
        h('td', { class: 'lap-note', text: status, title: status }),
        h('td', {}, h('button', { class: 'pill a' + (isA ? ' on' : ''), type: 'button', 'aria-pressed': isA ? 'true' : 'false', title: 'Use as lap A', text: 'A',
          onclick: () => { state.A = { sid: s.id, lap: l.idx }; if (isB) state.B = null; renderAll(); } })),
        h('td', {}, h('button', { class: 'pill b' + (isB ? ' on' : ''), type: 'button', 'aria-pressed': isB ? 'true' : 'false', title: isB ? 'Remove lap B' : 'Use as lap B', text: 'B',
          onclick: () => { state.B = isB ? null : { sid: s.id, lap: l.idx }; if (isA && !isB) state.A = null; renderAll(); } })),
      ]);
    });
    box.appendChild(h('table', { class: 'laps' }, [
      h('thead', {}, h('tr', {}, ['Lap', 'Time', 'Gap', '', '', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, rows),
    ]));
  }

  function renderLapbar() {
    const bar = $('lapbar'); bar.innerHTML = '';
    const a = pick(state.A), b = pick(state.B);
    const chip = (which, p) => h('div', { class: 'lapchip ' + which }, p ? [
      h('span', { class: 'lapchip-key' }, [h('i', { class: 'sw' }), 'Lap ' + which.toUpperCase()]),
      h('span', { class: 'lapchip-time num', text: p.lap.complete ? U.fmtLap(p.lap.time) : 'partial' }),
      h('span', { class: 'lapchip-meta', text: 'Lap ' + p.lap.num + ', ' + p.session.meta.car + (p.session.id !== state.activeId ? ' (' + p.session.meta.fileName + ')' : '') }),
    ] : [
      h('span', { class: 'lapchip-key' }, [h('i', { class: 'sw' }), 'Lap ' + which.toUpperCase()]),
      h('span', { class: 'lapchip-meta', text: which === 'a' ? 'Pick a lap with the A button in the lap list.' : 'Pick a second lap with the B button to compare.' }),
    ]);
    bar.appendChild(chip('a', a)); bar.appendChild(chip('b', b));
    if (a && b && a.lap.complete && b.lap.complete) {
      const d = b.lap.time - a.lap.time;
      bar.appendChild(h('div', { class: 'lapdelta' }, [
        h('span', { class: 'lapdelta-key', text: 'B − A' }),
        h('span', { class: 'lapdelta-val num', text: U.fmtDelta(d) + ' s' }),
        h('span', { class: 'lapdelta-note', text: Math.abs(d) < 0.0005 ? 'identical' : d > 0 ? 'A is faster' : 'B is faster' }),
      ]));
      if (U.slug(a.session.trackName) !== U.slug(b.session.trackName)) bar.appendChild(h('div', { class: 'lapwarn', text: 'These laps are from different tracks, so the comparison is not meaningful.' }));
    }
  }

  function renderTabs() {
    const nav = $('tabs'); nav.innerHTML = '';
    for (const [id, label] of TABS) {
      nav.appendChild(h('button', { class: 'tab' + (state.tab === id ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': state.tab === id ? 'true' : 'false', text: label,
        onclick: () => { state.tab = id; renderTabs(); STA.views.render(); } }));
    }
  }

  function renderAll() { renderTabs(); renderSessions(); renderLaps(); renderLapbar(); STA.views.render(); }

  /* ---------- start ---------- */

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $('theme-toggle').textContent = t === 'dark' ? 'Light theme' : 'Dark theme';
    try { localStorage.setItem('sta-theme', t); } catch (e) { /* preference just will not persist */ }
  }

  async function start() {
    let theme = 'dark';
    try { theme = localStorage.getItem('sta-theme') || (root.matchMedia && root.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); } catch (e) { /* keep default */ }
    try { state.speedUnit = localStorage.getItem('sta-speed') || 'kmh'; } catch (e) { /* keep default */ }
    applyTheme(theme);
    $('unit-speed').value = state.speedUnit;
    $('unit-speed').addEventListener('change', (ev) => { state.speedUnit = ev.target.value; try { localStorage.setItem('sta-speed', state.speedUnit); } catch (e) { /* ignore */ } renderAll(); });
    $('theme-toggle').addEventListener('click', () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); STA.views.render(); });
    $('pick-files').addEventListener('click', () => $('file-input').click());
    $('pick-folder').addEventListener('click', () => $('folder-input').click());
    $('file-input').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; });
    $('folder-input').addEventListener('change', (ev) => { scanFolder(ev.target.files); ev.target.value = ''; });
    const drop = $('drop');
    for (const type of ['dragenter', 'dragover']) root.addEventListener(type, (ev) => { ev.preventDefault(); drop.classList.add('over'); });
    for (const type of ['dragleave', 'drop']) root.addEventListener(type, (ev) => { ev.preventDefault(); if (type === 'drop' || ev.target === document.documentElement) drop.classList.remove('over'); });
    root.addEventListener('drop', (ev) => { drop.classList.remove('over'); if (ev.dataTransfer && ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files); });

    await STA.library.open();
    await refreshLibrary();
    if (STA.library.persistent === false) say('warn', 'This browser is not letting the page store data, so the setup library will only last until you close the tab. Use "Export library" in Setups and differences to keep it.');
    renderAll();
  }

  STA.app = { start, state, h, pick, active, sessionById, analysisFor, speed, speedUnit, simName, dateText, say, addFiles, scanFolder, refreshLibrary, renderAll, renderLapbar, renderLaps, activate };
})(typeof window !== 'undefined' ? window : globalThis);
