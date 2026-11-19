/* Application shell: state, file import, the left rail and the lap bar.
   The individual tabs live in views.js. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;
  const $ = (id) => document.getElementById(id);

  const TABS = [
    ['compare', 'Lap comparison'], ['map', 'Track map'], ['tables', 'Telemetry tables'],
    ['advice', 'Setup advice'], ['technique', 'Driving technique'], ['baseline', 'Baseline setup'], ['setups', 'Setups and differences'],
  ];

  /* Laps being overlaid: any number, from any loaded session.
       overlay  = [{ sid, lap, slot }]   slot gives the lap its letter and colour and never changes while it is selected
       refSlot  = slot of the reference lap, the one every time difference is measured against */
  const state = {
    sessions: [], activeId: null, overlay: [], refSlot: null, tab: 'compare',
    speedUnit: 'kmh', setups: [], summaries: [], analysis: new Map(), tech: new Map(), messages: [], ui: {},
  };
  const SLOT_COLOURS = 8; // distinct colours available; laps beyond that are drawn in a neutral grey
  const letterOf = (slot) => (slot < 26 ? String.fromCharCode(65 + slot) : 'L' + (slot + 1));
  const colourVarOf = (slot) => (slot < SLOT_COLOURS ? '--lap-' + slot : '--lap-x');
  const refEntry = () => state.overlay.find((e) => e.slot === state.refSlot) || state.overlay[0] || null;
  const findEntry = (sid, lap) => state.overlay.find((e) => e.sid === sid && e.lap === lap) || null;
  // The reference lap and the first other lap are still available as A and B for the views that compare exactly two laps.
  Object.defineProperty(state, 'A', { get: () => refEntry() });
  Object.defineProperty(state, 'B', { get: () => { const r = refEntry(); return state.overlay.find((e) => e !== r) || null; } });

  function addLap(sid, lap) {
    if (findEntry(sid, lap)) return;
    const used = new Set(state.overlay.map((e) => e.slot));
    let slot = 0; while (used.has(slot)) slot++;
    state.overlay.push({ sid, lap, slot });
    if (!refEntry() || state.refSlot == null) state.refSlot = state.overlay[0].slot;
  }
  function removeLap(sid, lap) {
    state.overlay = state.overlay.filter((e) => !(e.sid === sid && e.lap === lap));
    if (!state.overlay.some((e) => e.slot === state.refSlot)) state.refSlot = state.overlay.length ? state.overlay[0].slot : null;
  }
  function setRef(sid, lap) { addLap(sid, lap); state.refSlot = findEntry(sid, lap).slot; }
  function clearLaps() { state.overlay = []; state.refSlot = null; }

  /* Every overlaid lap, resolved, reference first. Keeps enough distance grids cached for all of them. */
  function overlayLaps() {
    const perSession = new Map();
    for (const e of state.overlay) perSession.set(e.sid, (perSession.get(e.sid) || 0) + 1);
    const ref = refEntry(), out = [];
    for (const e of state.overlay) {
      const s = sessionById(e.sid); if (!s || !s.laps[e.lap]) continue;
      s._gridCap = Math.max(14, perSession.get(e.sid) + 6);
      out.push({ session: s, lap: s.laps[e.lap], grid: STA.session.lapGrid(s, s.laps[e.lap]), slot: e.slot, letter: letterOf(e.slot), colorVar: colourVarOf(e.slot), isRef: e === ref, muted: e.slot >= SLOT_COLOURS });
    }
    return out.sort((x, y) => (y.isRef ? 1 : 0) - (x.isRef ? 1 : 0));
  }

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
  // When a session was recorded, in the viewer's own time zone.
  const dayText = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) : 'Date unknown');
  const timeText = (ms) => (ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '');
  const whenText = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + timeText(ms) : '');
  // LMU runs have no setup name of their own, so the app names them after the recording time; no need to show that twice.
  const namedSetup = (s) => (s.setup && !/^Driven \d{4}-/.test(s.setup.name) ? s.setup.name : '');
  const sessionById = (id) => state.sessions.find((s) => s.id === id) || null;
  const active = () => sessionById(state.activeId);

  /* Resolve a lap selection { sid, lap } to its session, lap and distance grid. */
  function pick(sel) {
    if (!sel) return null;
    const s = sessionById(sel.sid); if (!s) return null;
    const lap = s.laps[sel.lap]; if (!lap) return null;
    return { session: s, lap, grid: STA.session.lapGrid(s, lap) };
  }

  /* Handling analysis is cached per session; the advice is rebuilt each time because it
     depends on what the driver has marked as not possible on this car. */
  function analysisFor(session) {
    if (!state.analysis.has(session.id)) state.analysis.set(session.id, STA.handling.analyse(session));
    const an = state.analysis.get(session.id);
    const sim = session.meta.sim, car = session.meta.car;
    // What earlier sessions with this car say about each kind of change.
    const know = STA.learning.knowledge(state.summaries, state.setups, { sim, car }, STA.library.reasons.all()), outcomes = know.stats;
    return { an, outcomes, know, adv: STA.advisor.advise(an, session.setup, { learned: know.links, blocked: STA.library.blocked.set(sim, car), limits: STA.library.limits.map(sim, car), contested: STA.library.contested.map(sim, car), track: session.trackName, outcomes }) };
  }

  /* Driving-technique analysis, cached per session. */
  function techFor(session) {
    if (!state.tech.has(session.id)) state.tech.set(session.id, STA.technique.analyse(session, analysisFor(session).an));
    return state.tech.get(session.id);
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
    // Kept in the order the runs were driven, earliest first, whatever order the files were added in.
    state.sessions.sort((a, b) => (a.meta.recordedAt || 0) - (b.meta.recordedAt || 0) || String(a.meta.fileName).localeCompare(String(b.meta.fileName)));
    state.analysis.delete(session.id); state.tech.delete(session.id);
    activate(session.id, true);
    for (const w of session.warnings) say('warn', session.meta.fileName + ': ' + w);
    for (const n of session.notes || []) say('info', session.meta.fileName + ': ' + n);

    // Remember the setup and a summary so later visits can find "what was I running here?"
    const summary = STA.session.summaryOf(session);
    // The summary also records how the car behaved, so the next session can be judged against it.
    if (session.refLap) Object.assign(summary, STA.learning.snapshot(session, analysisFor(session).an, techFor(session)));
    await STA.library.saveSession(summary);
    if (session.setup) await STA.library.recordUse(session.setup, summary);
    await refreshLibrary();
  }

  function activate(id, resetLaps) {
    state.activeId = id;
    const s = sessionById(id); if (!s) return;
    // Switching session keeps the overlaid laps, so laps from different sessions can be compared.
    if (resetLaps || !pick(state.A)) {
      const timed = s.laps.filter((l) => l.complete && l.valid).sort((a, b) => a.time - b.time);
      const any = s.laps.filter((l) => l.complete);
      const first = timed[0] || any[0] || s.laps[0];
      const second = timed[1] || any.find((l) => l !== first) || null;
      clearLaps();
      if (first) addLap(id, first.idx);
      if (second) addLap(id, second.idx);
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
    let day = null;
    for (const s of state.sessions) {
      const on = s.id === state.activeId, d = dayText(s.meta.recordedAt);
      if (d !== day) { day = d; box.appendChild(h('div', { class: 'session-day', text: d })); }
      box.appendChild(h('div', { class: 'session' + (on ? ' on' : ''), title: 'Recorded ' + d + ', ' + timeText(s.meta.recordedAt), role: 'button', tabindex: '0', 'aria-pressed': on ? 'true' : 'false',
        onclick: () => { activate(s.id); renderAll(); }, onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); activate(s.id); renderAll(); } } }, [
        h('div', { class: 'session-top' }, [h('span', { class: 'session-time num', text: timeText(s.meta.recordedAt) }), h('span', { class: 'session-track', text: s.trackName })]),
        h('div', { class: 'session-car', text: s.meta.car }),
        h('div', { class: 'session-file', text: s.meta.fileName, title: s.meta.fileName }),
        h('div', { class: 'session-meta' }, [
          h('span', { class: 'tag', text: simName(s.meta.sim) }),
          namedSetup(s) ? h('span', { class: 'session-setup', text: namedSetup(s), title: 'Setup: ' + namedSetup(s) }) : null,
          h('span', { class: 'num', text: s.bestLap ? U.fmtLap(s.bestLap.time) : 'no timed lap' }),
        ]),
        h('button', { class: 'x', type: 'button', 'aria-label': 'Close this session', title: 'Close this session', text: '×', onclick: (ev) => {
          ev.stopPropagation();
          state.sessions = state.sessions.filter((x) => x.id !== s.id);
          for (const e of state.overlay.filter((e) => e.sid === s.id)) removeLap(e.sid, e.lap);
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
    const best = s.bestLap ? s.bestLap.time : null, ref = refEntry();
    const timed = s.laps.filter((l) => l.complete && l.valid);
    box.appendChild(h('div', { class: 'lap-tools' }, [
      h('button', { class: 'link', type: 'button', text: 'Overlay all ' + timed.length + ' timed laps', disabled: timed.length ? null : true,
        onclick: () => { for (const l of timed) addLap(s.id, l.idx); renderAll(); } }),
      h('button', { class: 'link', type: 'button', text: 'Clear overlay', disabled: state.overlay.length ? null : true, onclick: () => { clearLaps(); renderAll(); } }),
    ]));
    const rows = s.laps.map((l) => {
      const e = findEntry(s.id, l.idx), isRef = !!e && e === ref;
      const status = !l.complete ? (l.note || 'partial') : l.pit ? 'pit lane' : !l.valid ? (l.note || 'not counted') : (l.note || '');
      return h('tr', { class: l.complete && l.valid ? '' : 'dim', style: e ? 'box-shadow: inset 3px 0 0 var(' + colourVarOf(e.slot) + ')' : null }, [
        h('td', { class: 'num', text: String(l.num) }),
        h('td', { class: 'num strong', text: l.complete ? U.fmtLap(l.time) : '–' }),
        h('td', { class: 'num', text: l.complete && l.valid && best != null ? (l.time === best ? 'best' : U.fmtDelta(l.time - best)) : '' }),
        h('td', { class: 'lap-note', text: status, title: status }),
        h('td', {}, h('button', { class: 'pill' + (e ? ' on' : ''), type: 'button', 'aria-pressed': e ? 'true' : 'false', style: e ? 'background: var(' + colourVarOf(e.slot) + '); border-color: var(' + colourVarOf(e.slot) + ')' : null,
          title: e ? 'Remove lap ' + letterOf(e.slot) + ' from the overlay' : 'Add this lap to the overlay', 'aria-label': (e ? 'Remove lap ' : 'Overlay lap ') + l.num, text: e ? letterOf(e.slot) : '+',
          onclick: () => { if (e) removeLap(s.id, l.idx); else addLap(s.id, l.idx); renderAll(); } })),
        h('td', {}, h('button', { class: 'pill ref' + (isRef ? ' on' : ''), type: 'button', 'aria-pressed': isRef ? 'true' : 'false', title: isRef ? 'This is the reference lap' : 'Make this the reference lap (time differences are measured against it)',
          'aria-label': 'Reference lap ' + l.num, text: 'Ref', onclick: () => { setRef(s.id, l.idx); renderAll(); } })),
      ]);
    });
    box.appendChild(h('table', { class: 'laps' }, [
      h('thead', {}, h('tr', {}, ['Lap', 'Time', 'Gap', '', 'Overlay', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, rows),
    ]));
  }

  function renderLapbar() {
    const bar = $('lapbar'); bar.innerHTML = '';
    const laps = overlayLaps(), ref = laps.find((l) => l.isRef) || null;
    bar.className = 'lapbar' + (laps.length > 3 ? ' dense' : '');
    if (!laps.length) {
      bar.appendChild(h('div', { class: 'lapchip' }, [h('span', { class: 'lapchip-meta', text: state.sessions.length ? 'No laps selected. Use the + buttons in the lap list to overlay as many laps as you like.' : 'Load a telemetry file, then pick laps to overlay.' })]));
      return;
    }
    for (const p of laps) {
      const gap = ref && p !== ref && p.lap.complete && ref.lap.complete ? p.lap.time - ref.lap.time : null;
      const where = 'Lap ' + p.lap.num + ' · ' + whenText(p.session.meta.recordedAt) + (namedSetup(p.session) ? ' · ' + namedSetup(p.session) : '');
      const chip = h('div', { class: 'lapchip' + (p.isRef ? ' is-ref' : ''), style: 'box-shadow: inset 0 3px 0 var(' + p.colorVar + ')', title: where + ', ' + p.session.meta.car + ', ' + p.session.meta.fileName }, [
        h('span', { class: 'lapchip-key' }, [h('i', { class: 'sw', style: 'background: var(' + p.colorVar + ')' }), 'Lap ' + p.letter]),
        h('span', { class: 'lapchip-time num', text: p.lap.complete ? U.fmtLap(p.lap.time) : 'partial' }),
        h('span', { class: 'lapchip-meta' }, [p.isRef ? h('b', { text: 'Reference' }) : gap == null ? '' : h('b', { class: 'num', text: U.fmtDelta(gap) + ' s' }), ' ' + where]),
        h('span', { class: 'lapchip-acts' }, [
          p.isRef ? null : h('button', { class: 'link', type: 'button', text: 'Make reference', onclick: () => { setRef(p.session.id, p.lap.idx); renderAll(); } }),
          h('button', { class: 'link', type: 'button', text: 'Remove', 'aria-label': 'Remove lap ' + p.letter, onclick: () => { removeLap(p.session.id, p.lap.idx); renderAll(); } }),
        ]),
      ]);
      chip.addEventListener('mouseenter', () => STA.views.highlight(p.letter));
      chip.addEventListener('mouseleave', () => STA.views.highlight(null));
      bar.appendChild(chip);
    }
    if (laps.length > SLOT_COLOURS) bar.appendChild(h('div', { class: 'lapwarn', text: 'Eight laps have their own colour. The rest are drawn in grey; point at a lap here to pick it out in the traces and on the map.' }));
    const tracks = new Set(laps.map((l) => U.slug(l.session.trackName)));
    if (tracks.size > 1) bar.appendChild(h('div', { class: 'lapwarn', text: 'These laps are from different tracks, so the comparison is not meaningful.' }));
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

  STA.app = { start, state, h, pick, active, sessionById, overlayLaps, addLap, removeLap, setRef, clearLaps, letterOf, colourVarOf, analysisFor, techFor, speed, speedUnit, simName, dateText, dayText, timeText, whenText, say, addFiles, scanFolder, refreshLibrary, renderAll, renderLapbar, renderLaps, activate };
})(typeof window !== 'undefined' ? window : globalThis);
