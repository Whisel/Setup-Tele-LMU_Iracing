/* Application shell: state, file import, the left rail and the lap bar.
   The individual tabs live in views.js. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;
  const $ = (id) => document.getElementById(id);

  const TABS = [
    ['library', 'Library'], ['compare', 'Lap comparison'], ['map', 'Track map'], ['tables', 'Telemetry tables'],
    ['advice', 'Setup advice'], ['technique', 'Driving technique'], ['baseline', 'Baseline setup'], ['setups', 'Setups and differences'],
  ];

  /* Laps being overlaid: any number, from any loaded session.
       overlay  = [{ sid, lap, slot }]   slot gives the lap its letter and colour and never changes while it is selected
       refSlot  = slot of the reference lap, the one every time difference is measured against */
  const state = {
    sessions: [], activeId: null, overlay: [], refSlot: null, tab: 'library', lapSort: (() => { try { return localStorage.getItem('sta-lap-sort') || 'order'; } catch (e) { return 'order'; } })(),
    lib: { folders: [], entries: [], report: null, busy: false },
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

  /* The laps that can be compared, fastest first: timed laps, or any complete lap when none is timed. */
  function rankedLaps(s) {
    const timed = s.laps.filter((l) => l.complete && l.valid).sort((a, b) => a.time - b.time);
    return timed.length ? timed : s.laps.filter((l) => l.complete).sort((a, b) => a.time - b.time);
  }
  const DEFAULT_LAPS = 3;
  /* Overlay the fastest n laps of a session in place of the ones from it shown now. Laps from other
     sessions stay. The fastest becomes the reference unless the reference is from another session. */
  function showFastest(s, n) {
    const keepRef = refEntry() && refEntry().sid !== s.id;
    for (const e of state.overlay.filter((e) => e.sid === s.id)) removeLap(e.sid, e.lap);
    const pickd = rankedLaps(s).slice(0, n);
    for (const l of pickd) addLap(s.id, l.idx);
    if (!keepRef && pickd.length) setRef(s.id, pickd[0].idx);
  }

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
    const feelAll = STA.library.feel.all(), notes = STA.library.feel.get(session.id);
    const know = STA.learning.knowledge(state.summaries, state.setups, { sim, car }, STA.library.reasons.all(), feelAll), outcomes = know.stats;
    // What the driver felt in this run, worked in with what the telemetry found.
    const merged = STA.feel.merge(an, notes);
    // This session's best lap as a pace profile: where the lap time is spent.
    if (!an.pace) an.pace = STA.pace.profile(session, an.balance ? an.balance.gmax : null) || {};
    const pace = an.pace.t ? { shares: STA.pace.shares(an.pace), track: session.trackName, when: session.meta.recordedAt } : null;
    return { an, merged, notes, outcomes, know, pace, adv: STA.advisor.advise(merged, session.setup, { ideas: notes.ideas, pace, learned: know.links, trail: STA.learning.trail(state.summaries, state.setups, session), blocked: STA.library.blocked.set(sim, car), limits: STA.library.limits.map(sim, car), contested: STA.library.contested.map(sim, car), track: session.trackName, outcomes }) };
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
        else if (e === 'lmulaps') { await loadLmuLive(file); added++; }
        else if (e === 'svm') { await loadSvm(file); }
        else if (e === 'json') { await loadJson(file); }
        else say('warn', file.name + ': this file type is not supported. Use .ibt, .duckdb, .lmulaps, .svm or a library export (.json).');
      } catch (err) {
        console.error(err);
        say('error', file.name + ': ' + (err && err.message ? err.message : String(err)));
      }
    }
    busy(null);
    await refreshLibrary();
    // Someone who just added a file wants to see it, not the list of folders.
    if (added && state.tab === 'library' && !restoring) state.tab = 'compare';
    renderAll();
  }

  /* ---------- folder library ---------- */

  const fileKeys = new WeakMap(); // File -> index entry id, for files opened from the library
  let restoring = false;
  const comboOf = (s) => STA.folders.comboKey({ sim: s.meta.sim, car: s.meta.car, track: s.trackName });
  /* The index entry a file belongs to: opened from the library, or the same file dropped by hand. */
  function keyForFile(file) {
    if (!file) return null;
    if (fileKeys.has(file)) return fileKeys.get(file);
    const e = state.lib.entries.find((x) => x.kind === 'run' && x.name === file.name && x.size === file.size && x.lastModified === file.lastModified);
    return e ? e.id : null;
  }

  async function refreshLib() {
    state.lib.folders = await STA.folders.list();
    state.lib.entries = await STA.folders.entries();
  }

  /* Bring the index up to date. ask: allowed to show the browser's permission prompt (clicks only). */
  async function scanLib(ask, only, opts) {
    if (state.lib.busy) return;
    state.lib.busy = true;
    try {
      const rep = await STA.folders.scan({ ask, only, includeFresh: !!(opts && opts.includeFresh), onProgress: (label, f) => busy('Indexing ' + label, f) });
      state.lib.report = rep;
      if (rep.added) await refreshLibrary();
      if (ask && rep.added) say('ok', 'Indexed ' + rep.added + (rep.added === 1 ? ' new file.' : ' new files.'));
    } catch (e) { console.error(e); say('error', 'Folder scan: ' + (e && e.message ? e.message : e)); }
    busy(null);
    state.lib.busy = false;
    await refreshLib();
    if (state.tab === 'library') STA.views.render();
  }

  /* ---------- iRacing recorder ---------- */

  /* The recorder says a run has just been saved: index it and, if wanted, open it. */
  async function runFinished() {
    await new Promise((r) => setTimeout(r, 1500)); // let the sim finish closing the file
    if (!state.lib.folders.length) { const lmu = STA.recorder.state.status && STA.recorder.state.status.sim === 'lmu';
      say('info', 'A run was recorded. Add ' + (lmu ? 'the recorder\'s folder (Documents, "LMU live laps")' : 'your iRacing telemetry folder') + ' to the Library and new runs will open here by themselves.'); return; }
    const before = new Set(state.lib.entries.map((e) => e.id));
    // The sim has closed the file, so it is safe to read even though it was written seconds ago.
    await scanLib(false, null, { includeFresh: true });
    const fresh = state.lib.entries.filter((e) => e.kind === 'run' && !e.error && !before.has(e.id)).sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0))[0];
    if (!fresh) {
      const locked = state.lib.report && state.lib.report.locked.length;
      say(locked ? 'warn' : 'info', locked ? 'A run was recorded, but the browser needs your OK to read the folder again: Library, then "Allow and rescan".' : 'A run was recorded, but no new file has appeared in your folders yet.');
      return;
    }
    say('ok', 'New run recorded: ' + fresh.car + ' at ' + fresh.track + '.');
    if (STA.recorder.settings().autoOpen) await openCombo(STA.folders.comboKey(fresh));
    else renderAll();
  }

  function renderRecorder() {
    const box = $('recorder'); if (!box) return;
    box.innerHTML = '';
    const R = STA.recorder, cfg = R.settings(), st = R.state, d = R.describe(cfg, st), s = st.status || {};
    const act = async (cmd) => { try { const r = await R.command(cmd); if (r && r.ok === false && r.message) say('warn', 'Recorder: ' + r.message + '.'); } catch (e) { say('error', 'The recorder did not answer. Is it still running?'); } };
    box.appendChild(h('div', { class: 'rec-line' }, [
      h('span', { class: 'rec-dot ' + d.tone, 'aria-hidden': 'true' }),
      h('span', { class: 'rec-text', text: d.text }),
      s.simulated ? h('span', { class: 'tag', text: 'simulated' }) : null,
      h('button', { class: 'link', type: 'button', text: cfg.on ? 'Turn off' : 'Turn on', title: cfg.on ? 'Stop talking to the recorder program' : 'Connect to the recorder program on this PC (see recorder/ in the app folder)', onclick: () => R.setOn(!cfg.on) }),
    ]));
    if (!cfg.on) return;
    if (!st.reachable) { box.appendChild(h('p', { class: 'rec-hint', text: 'Start "Start-iRacing-Recorder" or "Start-LMU-Recorder" from the app\'s recorder folder on this PC.' })); return; }
    if (s.sim === 'lmu') { // records by itself; the one thing to ask for is to save now
      box.appendChild(h('div', { class: 'rec-controls' }, [
        s.recording && s.laps > 0 ? h('button', { class: 'btn ghost small', type: 'button', text: 'Save laps now', title: 'Saves the laps recorded so far without waiting for the pits', onclick: () => act('finish') }) : null,
      ]));
      if (s.lastFile) box.appendChild(h('p', { class: 'rec-hint', text: 'Last saved: ' + s.lastLaps + (s.lastLaps === 1 ? ' lap' : ' laps') + ' (' + s.lastFile + ')' }));
      box.appendChild(h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: !!cfg.autoOpen, onchange: (ev) => { R.save({ autoOpen: ev.target.checked }); } }), ' Open a run when it is saved']));
      return;
    }
    box.appendChild(h('div', { class: 'rec-controls' }, [
      s.connected ? h('button', { class: 'btn ghost small', type: 'button', text: s.enabled ? 'Stop recording' : 'Start recording', onclick: () => act(s.enabled ? 'stop' : 'start') }) : null,
      s.connected && s.recording ? h('button', { class: 'btn ghost small', type: 'button', text: 'New file', title: 'Saves the file so far and starts a new one', onclick: () => act('restart') }) : null,
    ]));
    box.appendChild(h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: s.mode === 'auto', onchange: (ev) => act(ev.target.checked ? 'auto' : 'manual') }), ' Record every run']));
    box.appendChild(h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: !!cfg.autoOpen, onchange: (ev) => { R.save({ autoOpen: ev.target.checked }); } }), ' Open a run when it is saved']));
  }

  async function addFolder() {
    if (!STA.folders.supported()) { $('folder-input').click(); return; }
    try {
      const f = await STA.folders.add();
      state.tab = 'library';
      await scanLib(true, f.id);
      renderAll();
    } catch (e) { if (!e || e.name !== 'AbortError') say('error', 'That folder could not be added: ' + (e && e.message ? e.message : e)); }
  }

  /* Folder picked through the plain file dialog (browsers that cannot remember a folder). */
  async function addPickedFolder(fileList) {
    const f = await STA.folders.addPicked(fileList);
    if (!f) { say('warn', 'No .ibt, .duckdb, .lmulaps or .svm files in that folder.'); return; }
    state.tab = 'library';
    await scanLib(true, f.id);
    renderAll();
  }

  async function removeFolder(id) { await STA.folders.remove(id); await refreshLib(); renderAll(); }

  function closeSession(id) {
    state.sessions = state.sessions.filter((x) => x.id !== id);
    for (const e of state.overlay.filter((e) => e.sid === id)) removeLap(e.sid, e.lap);
    state.analysis.delete(id); state.tech.delete(id);
  }

  /* Open a car and track combination from the library and put the view back the way it was left.
     onlyEntry: open just that one recording instead. */
  async function openCombo(key, onlyEntry) {
    const runs = state.lib.entries.filter((e) => e.kind === 'run' && !e.error && STA.folders.comboKey(e) === key).sort((a, b) => (a.recordedAt || 0) - (b.recordedAt || 0));
    if (!runs.length) return;
    const saved = onlyEntry ? null : STA.folders.resume.get(key), newest = runs[runs.length - 1];
    let want = onlyEntry ? [onlyEntry] : ((saved && saved.open) || []).filter((id) => runs.some((r) => r.id === id));
    // A run recorded since last time is what the driver came back for.
    if (!onlyEntry && want.indexOf(newest.id) < 0 && (!want.length || !newest.sessionId)) want.push(newest.id);
    restoring = true;
    try {
      for (const s of state.sessions.filter((s) => comboOf(s) !== key)) closeSession(s.id);
      const files = [];
      for (const id of want) {
        if (state.sessions.some((s) => s.meta.fileKey === id)) continue;
        try { const f = await STA.folders.fileFor(runs.find((r) => r.id === id)); fileKeys.set(f, id); files.push(f); }
        catch (e) { say('error', e && e.message ? e.message : String(e)); }
      }
      if (files.length) await addFiles(files);
      const byKey = (k) => state.sessions.find((s) => s.meta.fileKey === k);
      const fresh = byKey(newest.id) && !(saved && (saved.open || []).indexOf(newest.id) >= 0);
      if (saved && !fresh && byKey(saved.active)) {
        clearLaps();
        for (const o of saved.overlay || []) { const s = byKey(o.f), lap = s && s.laps.find((l) => l.num === o.n); if (lap) { addLap(s.id, lap.idx); if (o.ref) setRef(s.id, lap.idx); } }
        activate(byKey(saved.active).id, false);
        state.tab = saved.tab || 'advice';
      } else {
        const s = byKey(onlyEntry || newest.id) || state.sessions[state.sessions.length - 1];
        if (s) activate(s.id, true);
        state.tab = (saved && saved.tab) || 'advice';
      }
    } finally { restoring = false; }
    await refreshLib();
    renderAll();
  }

  /* Remember what is open and overlaid for the active car and track, so it can be restored later. */
  function saveResume() {
    if (restoring) return;
    const a = active();
    if (!a || !a.meta.fileKey) return;
    const key = comboOf(a), mine = state.sessions.filter((s) => s.meta.fileKey && comboOf(s) === key), old = STA.folders.resume.get(key);
    const overlay = [];
    for (const e of state.overlay) {
      const s = sessionById(e.sid), lap = s && s.meta.fileKey && s.laps.find((l) => l.idx === e.lap);
      if (lap) overlay.push({ f: s.meta.fileKey, n: lap.num, ref: e.slot === state.refSlot });
    }
    STA.folders.resume.set(key, { open: mine.map((s) => s.meta.fileKey), active: a.meta.fileKey, overlay, tab: state.tab === 'library' ? (old && old.tab) || 'advice' : state.tab, at: Date.now() });
  }

  async function loadIbt(file) {
    busy('Reading ' + file.name, 0);
    const raw = await STA.ibt.read(file, { want: STA.session.IBT_WANT, onProgress: (f) => busy('Reading ' + file.name, f) });
    const s = STA.session.fromIbt(raw, file);
    s.meta.fileKey = keyForFile(file);
    await addSession(s);
  }

  async function loadLmu(file) {
    busy('Starting the DuckDB reader (first use downloads about 35 MB)', 0.05);
    const db = await STA.duck.open(file);
    try {
      const raw = await STA.lmu.read(db, { onProgress: (f) => busy('Reading ' + file.name, f) });
      const s = STA.session.fromLmu(raw, file);
      s.meta.fileKey = keyForFile(file);
      await addSession(s);
    } finally { await db.close(); }
  }

  /* A run saved by the LMU lap recorder while the session was still on. */
  async function loadLmuLive(file) {
    busy('Reading ' + file.name, 0.3);
    const s = STA.session.fromLmu(await STA.lmuLive.read(file), file);
    s.meta.fileKey = keyForFile(file);
    await addSession(s);
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
    // The folder index remembers that this recording has been opened, and its best lap.
    if (session.meta.fileKey) {
      const e = await STA.folders.mark(session.meta.fileKey, { sessionId: session.id, bestLap: summary.bestLap || null, laps: summary.timedLaps || 0 });
      if (e) { const i = state.lib.entries.findIndex((x) => x.id === e.id); if (i >= 0) state.lib.entries[i] = e; }
    }
    await refreshLibrary();
  }

  function activate(id, resetLaps) {
    state.activeId = id;
    const s = sessionById(id); if (!s) return;
    // Switching session keeps the overlaid laps, so laps from different sessions can be compared.
    // A new session starts with its fastest three laps overlaid (or as many as it has).
    if (resetLaps || !pick(state.A)) {
      clearLaps();
      showFastest(s, DEFAULT_LAPS);
      if (!state.overlay.length && s.laps[0]) addLap(id, s.laps[0].idx);
    }
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
          closeSession(s.id);
          if (state.activeId === s.id) { state.activeId = state.sessions.length ? state.sessions[0].id : null; if (state.activeId) activate(state.activeId, !state.A); }
          renderAll();
        } }),
      ]));
    }
  }

  /* The lap list: every lap in the file with a tick box. "Show" picks the fastest few in one go;
     ticking a lap adds it to or takes it off the overlay. */
  function renderLaps() {
    const box = $('lap-list'), s = active(); box.innerHTML = '';
    $('laps-of').textContent = s ? 'in ' + s.trackName : '';
    if (!s) { box.appendChild(h('p', { class: 'empty', text: 'Laps appear here once a telemetry file is loaded.' })); return; }
    const best = s.bestLap ? s.bestLap.time : null, ref = refEntry();
    const ranked = rankedLaps(s), rank = new Map(ranked.map((l, i) => [l.idx, i + 1]));
    const mine = state.overlay.filter((e) => e.sid === s.id);
    // Which "fastest n" the current pick matches, if any.
    const chosen = new Set(mine.map((e) => e.lap));
    const n = mine.length && mine.length <= ranked.length && ranked.slice(0, mine.length).every((l) => chosen.has(l.idx)) ? mine.length : null;
    const counts = [1, 2, 3, 5, 10].filter((k) => k < ranked.length).concat(ranked.length ? [ranked.length] : []);
    const countSel = h('select', { 'aria-label': 'How many of the fastest laps to overlay', disabled: ranked.length ? null : true,
      onchange: (ev) => { if (ev.target.value) { showFastest(s, +ev.target.value); renderAll(); } } },
      (n == null ? [h('option', { value: '', selected: true, text: mine.length ? 'your pick (' + mine.length + ')' : 'none' })] : [])
        .concat(counts.map((k) => h('option', { value: k, selected: k === n, text: k === ranked.length ? 'all ' + k + (ranked.length > 1 ? ' laps' : ' lap') : 'fastest ' + k }))));
    const sortBy = state.lapSort === 'fast' ? 'fast' : 'order';
    const sortBtn = h('button', { class: 'link', type: 'button', text: sortBy === 'fast' ? 'In lap order' : 'Fastest first',
      title: 'Sort the list ' + (sortBy === 'fast' ? 'in the order the laps were driven' : 'by lap time'), onclick: () => { state.lapSort = sortBy === 'fast' ? 'order' : 'fast'; try { localStorage.setItem('sta-lap-sort', state.lapSort); } catch (e) { /* storage may be off */ } renderLaps(); } });
    box.appendChild(h('div', { class: 'lap-tools' }, [
      h('label', { class: 'lap-count' }, ['Show ', countSel]),
      h('span', { class: 'lap-tools-end' }, [sortBtn,
        h('button', { class: 'link', type: 'button', text: 'Clear', title: 'Take every lap off the overlay', disabled: state.overlay.length ? null : true, onclick: () => { clearLaps(); renderAll(); } })]),
    ]));
    const list = sortBy === 'fast' ? ranked.concat(s.laps.filter((l) => !rank.has(l.idx))) : s.laps;
    const toggle = (l) => { if (findEntry(s.id, l.idx)) removeLap(s.id, l.idx); else addLap(s.id, l.idx); renderAll(); };
    const rows = list.map((l) => {
      const e = findEntry(s.id, l.idx), isRef = !!e && e === ref, r = rank.get(l.idx);
      const status = !l.complete ? (l.note || 'partial') : l.pit ? 'pit lane' : !l.valid ? (l.note || 'not counted') : (l.note || '');
      const colour = e ? 'var(' + colourVarOf(e.slot) + ')' : null;
      return h('tr', { class: (l.complete && l.valid ? '' : 'dim') + (e ? ' picked' : ''), style: e ? 'box-shadow: inset 3px 0 0 ' + colour : null,
        onclick: (ev) => { if (ev.target.closest('button, input')) return; toggle(l); } }, [
        h('td', { class: 'pick' }, h('input', { type: 'checkbox', checked: !!e, style: e ? 'accent-color: ' + colour : null,
          'aria-label': (e ? 'Take lap ' + l.num + ' (' + letterOf(e.slot) + ') off the overlay' : 'Overlay lap ' + l.num), onchange: () => toggle(l) })),
        h('td', { class: 'num lap-letter', text: e ? letterOf(e.slot) : '', style: e ? 'color: ' + colour : null }),
        h('td', { class: 'num', text: String(l.num) }),
        h('td', { class: 'num strong', text: l.complete ? U.fmtLap(l.time) : '–' }),
        h('td', { class: 'num', text: l.complete && l.valid && best != null ? (l.time === best ? 'best' : U.fmtDelta(l.time - best)) : '', title: r ? 'Number ' + r + ' of ' + ranked.length + ' by lap time' : null }),
        h('td', { class: 'lap-note', text: status, title: status }),
        h('td', {}, h('button', { class: 'pill ref' + (isRef ? ' on' : ''), type: 'button', 'aria-pressed': isRef ? 'true' : 'false', title: isRef ? 'This is the reference lap' : 'Make this the reference lap (time differences are measured against it)',
          'aria-label': 'Reference lap ' + l.num, text: 'Ref', onclick: () => { setRef(s.id, l.idx); renderAll(); } })),
      ]);
    });
    box.appendChild(h('table', { class: 'laps' }, [
      h('thead', {}, h('tr', {}, ['', '', 'Lap', 'Time', 'Gap', '', ''].map((t) => h('th', { text: t })))),
      h('tbody', {}, rows),
    ]));
    if (mine.length > 6) box.appendChild(h('p', { class: 'hint', text: mine.length + ' laps overlaid. Charts stay readable up to about six; the extra laps are drawn in grey.' }));
  }

  function renderLapbar() {
    const bar = $('lapbar'); bar.innerHTML = '';
    const laps = overlayLaps(), ref = laps.find((l) => l.isRef) || null;
    bar.className = 'lapbar' + (laps.length > 3 ? ' dense' : '');
    if (!laps.length) {
      bar.appendChild(h('div', { class: 'lapchip' }, [h('span', { class: 'lapchip-meta', text: state.sessions.length ? 'No laps selected. Tick laps in the lap list, or choose how many of the fastest to show.' : 'Load a telemetry file, then pick laps to overlay.' })]));
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

  /* Only the tabs that have something to show:
       Library                                   always
       Lap comparison, Track map, Telemetry
       tables, Driving technique                 once a session is open
       Setup advice                              when that session has a setup
       Baseline setup, Setups and differences    when at least one setup is known */
  function visibleTabs() {
    const s = active(), haveSetups = state.setups.length > 0;
    const show = { library: true, compare: !!s, map: !!s, tables: !!s, technique: !!s, advice: !!(s && s.setup), baseline: haveSetups, setups: haveSetups };
    return TABS.filter(([id]) => show[id]);
  }

  function renderTabs() {
    const nav = $('tabs'); nav.innerHTML = '';
    const tabs = visibleTabs();
    // The open tab has gone (the session was closed, or this one has no setup): fall back to one that is there.
    if (!tabs.some(([id]) => id === state.tab)) state.tab = active() && tabs.some(([id]) => id === 'compare') ? 'compare' : 'library';
    for (const [id, label] of tabs) {
      nav.appendChild(h('button', { class: 'tab' + (state.tab === id ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': state.tab === id ? 'true' : 'false', text: label,
        onclick: () => { state.tab = id; renderTabs(); STA.views.render(); saveResume(); } }));
    }
  }

  function renderAll() { renderTabs(); renderSessions(); renderLaps(); renderLapbar(); STA.views.render(); saveResume(); }

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
    $('pick-folder').addEventListener('click', () => addFolder());
    $('file-input').addEventListener('change', (ev) => { addFiles(ev.target.files); ev.target.value = ''; });
    $('folder-input').addEventListener('change', (ev) => { addPickedFolder(ev.target.files); ev.target.value = ''; });
    const drop = $('drop');
    for (const type of ['dragenter', 'dragover']) root.addEventListener(type, (ev) => { ev.preventDefault(); drop.classList.add('over'); });
    for (const type of ['dragleave', 'drop']) root.addEventListener(type, (ev) => { ev.preventDefault(); if (type === 'drop' || ev.target === document.documentElement) drop.classList.remove('over'); });
    root.addEventListener('drop', (ev) => { drop.classList.remove('over'); if (ev.dataTransfer && ev.dataTransfer.files.length) addFiles(ev.dataTransfer.files); });

    await STA.library.open();
    await refreshLibrary();
    if (STA.library.persistent === false) say('warn', 'This browser is not letting the page store data, so the setup library will only last until you close the tab. Use "Export library" in Setups and differences to keep it.');
    await refreshLib();
    renderAll();
    // Pick up new recordings without being asked: now, and whenever the window is looked at again.
    // No prompt is shown here; a folder that needs one waits for a click in the Library tab.
    if (state.lib.folders.length) scanLib(false);
    STA.recorder.on('change', renderRecorder);
    STA.recorder.on('finished', () => { runFinished(); });
    renderRecorder();
    STA.recorder.start();
    let lastAuto = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state.lib.folders.length || Date.now() - lastAuto < 20000) return;
      lastAuto = Date.now(); scanLib(false);
    });
  }

  STA.app = { start, state, h, pick, active, sessionById, overlayLaps, addLap, removeLap, setRef, clearLaps, showFastest, rankedLaps, letterOf, colourVarOf, analysisFor, techFor, speed, speedUnit, simName, dateText, dayText, timeText, whenText, say, addFiles, refreshLibrary, refreshLib, scanLib, addFolder, removeFolder, openCombo, runFinished, renderRecorder, renderAll, renderLapbar, renderLaps, activate };
})(typeof window !== 'undefined' ? window : globalThis);
