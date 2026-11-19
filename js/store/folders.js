/* The folder library: telemetry folders the app keeps an eye on.

   The driver points the app at the folders the sims write to (for example
   Documents\iRacing\telemetry and Le Mans Ultimate's UserData\Telemetry).
   The app remembers the folders, reads only the header of each recording to
   find out which sim, car and track it is, and keeps that index between
   visits. Recordings can then be opened straight from the index, sorted by
   sim, car and track, without choosing the file again.

   How the browser allows this
   - Chrome and Edge can remember a folder (File System Access API). After a
     restart the browser may ask once to confirm access; that needs a click.
   - Other browsers can only read a folder for the current visit. The index is
     still kept, but the folder has to be picked again before a file can be
     opened.

   Nothing is copied or uploaded: files are read where they are, on this
   computer, and the index holds names and header facts only.

   Index entry
     { id, folderId, path, name, size, lastModified, kind: 'run' | 'setup',
       sim, car, carClass, track, recordedAt, setupName,
       sessionId, bestLap, laps      filled in once the run has been opened
       partial, error                when the header could not be fully read } */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;
  const EXT = /\.(ibt|duckdb|svm)$/i, MAX_FILES = 3000, MAX_DEPTH = 5;

  // For this visit: folderId -> { handle } or { files: Map(path -> File) }.
  const live = new Map();
  const db = () => STA.library.raw();

  const supported = () => typeof root.showDirectoryPicker === 'function';
  const comboKey = (e) => [e.sim, U.slug(e.car), U.slug(e.track)].join('|');

  async function permission(handle, ask) {
    if (!handle || !handle.queryPermission) return 'granted';
    try {
      let p = await handle.queryPermission({ mode: 'read' });
      if (p !== 'granted' && ask && handle.requestPermission) p = await handle.requestPermission({ mode: 'read' });
      return p;
    } catch (e) { return 'denied'; }
  }

  const source = (f) => live.get(f.id) || (f.handle ? { handle: f.handle } : null);

  /* Folders with their state: ready | locked (needs a click to allow reading again) | offline (picked for one visit only). */
  async function list() {
    const out = [];
    for (const f of (await (await db()).all('folders')).sort((a, b) => a.addedAt - b.addedAt)) {
      const src = source(f);
      out.push(Object.assign({}, f, { state: !src ? 'offline' : src.handle ? ((await permission(src.handle, false)) === 'granted' ? 'ready' : 'locked') : 'ready' }));
    }
    return out;
  }

  /* Ask the driver for a folder and remember it. Needs a click. */
  async function add() {
    const handle = await root.showDirectoryPicker({ mode: 'read', id: 'sta-telemetry' });
    for (const f of await (await db()).all('folders')) {
      if (f.handle && f.handle.isSameEntry && (await f.handle.isSameEntry(handle))) { live.set(f.id, { handle }); return f; }
    }
    const rec = { id: 'fold-' + U.uid(), name: handle.name, addedAt: Date.now(), lastScan: null, handle };
    try { await (await db()).put('folders', rec); }
    catch (e) {
      // A browser that hands out folder handles but cannot store them: keep the folder for this visit.
      delete rec.handle; rec.picked = true;
      await (await db()).put('folders', rec);
    }
    live.set(rec.id, { handle });
    return rec;
  }

  /* Give a remembered folder its handle for this visit (the same folder picked again). */
  function attach(id, handle) { live.set(id, { handle }); }

  /* Fallback for browsers that cannot remember a folder: the files from a folder picker, for this visit. */
  async function addPicked(fileList) {
    const files = Array.from(fileList || []).filter((f) => EXT.test(f.name));
    if (!files.length) return null;
    const rel = (f) => f.webkitRelativePath || f.name, name = rel(files[0]).split('/')[0] || 'Picked folder';
    const id = 'pick-' + U.hash(name), map = new Map(files.map((f) => [rel(f).split('/').slice(1).join('/') || f.name, f]));
    const b = await db(), old = (await b.all('folders')).find((f) => f.id === id);
    const rec = old || { id, name, addedAt: Date.now(), lastScan: null, picked: true };
    await b.put('folders', rec);
    live.set(id, { files: map });
    return rec;
  }

  async function remove(id) {
    const b = await db();
    for (const e of await b.all('files')) if (e.folderId === id) await b.del('files', e.id);
    await b.del('folders', id);
    live.delete(id);
  }

  async function walk(handle, prefix, depth, out) {
    for await (const [name, h] of handle.entries()) {
      if (out.length >= MAX_FILES) return;
      if (h.kind === 'file') { if (EXT.test(name)) out.push({ path: prefix + name, get: () => h.getFile() }); }
      else if (depth < MAX_DEPTH && name[0] !== '.') await walk(h, prefix + name + '/', depth + 1, out);
    }
  }

  /* Which sim, car and track a recording is, from its header only. Also returns the setup stored in it. */
  async function readMeta(file) {
    if (/\.ibt$/i.test(file.name)) {
      const raw = await STA.ibt.read(file, { headerOnly: true });
      const info = raw.sessionInfo || {}, wk = info.WeekendInfo || {}, di = info.DriverInfo || {};
      const idx = parseInt(di.DriverCarIdx, 10), drv = (di.Drivers || []).find((d) => parseInt(d.CarIdx, 10) === idx) || (di.Drivers || [])[0] || {};
      const m = { sim: 'iracing', car: drv.CarScreenName || drv.CarPath || 'Unknown car', carClass: drv.CarClassShortName || '',
        recordedAt: raw.header.startDate ? raw.header.startDate * 1000 : file.lastModified, setupName: String(di.DriverSetupName || '').replace(/\.sto$/i, '') };
      m.track = STA.session.trackName({ track: wk.TrackDisplayName || wk.TrackName || 'Unknown track', trackConfig: wk.TrackConfigName && wk.TrackConfigName !== 'N/A' ? wk.TrackConfigName : '' });
      if (info.CarSetup) m.setup = STA.setup.fromIracing(info.CarSetup, { car: m.car, carClass: m.carClass, track: m.track, name: m.setupName || STA.session.runName(m.recordedAt), createdAt: m.recordedAt });
      return m;
    }
    // Le Mans Ultimate: the file name carries the track and time; the car is inside the database.
    const fromName = /^(.*)_([A-Z0-9]+)_(\d{4}-\d\d-\d\dT\d\d_\d\d_\d\dZ)\.duckdb$/i.exec(file.name);
    const guess = { sim: 'lmu', car: 'Unknown car', carClass: '', track: fromName ? fromName[1] : 'Unknown track', setupName: '',
      recordedAt: (fromName && Date.parse(fromName[3].replace(/_/g, ':'))) || file.lastModified, partial: true };
    let conn;
    try { conn = await STA.duck.open(file); } catch (e) { return guess; }
    try {
      const mt = await STA.lmu.readMeta(conn);
      const m = { sim: 'lmu', car: mt.CarName || 'Unknown car', carClass: mt.CarClass || '', setupName: '',
        recordedAt: Date.parse(String(mt.RecordingTime || '').replace(/_/g, ':')) || guess.recordedAt };
      m.track = STA.session.trackName({ track: mt.TrackName || guess.track, trackConfig: mt.TrackLayout && mt.TrackLayout !== mt.TrackName ? mt.TrackLayout : '' });
      if (mt.CarSetup) m.setup = STA.setup.fromLmuJson(mt.CarSetup, { car: m.car, carClass: m.carClass, track: m.track, name: STA.session.runName(m.recordedAt), createdAt: m.recordedAt });
      return m;
    } finally { await conn.close(); }
  }

  async function keepSetup(setup, when) {
    const rec = await STA.library.saveSetup(setup);
    if (!rec.usage.lastUsed || when > rec.usage.lastUsed) await STA.library.updateSetup(rec.id, { usage: Object.assign(rec.usage, { lastUsed: when }) });
  }

  /* Bring the index up to date. Only new or changed files are read.
     opts.ask: may show the browser's permission prompt (only allowed from a click).
     Returns { added, total, locked: [folders that need a click], offline: [...] }. */
  async function scan(opts) {
    const o = opts || {}, b = await db(), report = { added: 0, removed: 0, total: 0, locked: [], offline: [], failed: 0 };
    const folders = (await b.all('folders')).filter((f) => !o.only || f.id === o.only), all = await b.all('files');
    for (const f of folders) {
      const src = source(f);
      if (!src) { report.offline.push(f); continue; }
      const found = [];
      if (src.handle) {
        if ((await permission(src.handle, !!o.ask)) !== 'granted') { report.locked.push(f); continue; }
        live.set(f.id, { handle: src.handle });
        try { await walk(src.handle, '', 0, found); } catch (e) { report.locked.push(f); continue; }
      } else for (const [path, file] of src.files) found.push({ path, get: async () => file });

      const known = new Map(all.filter((e) => e.folderId === f.id).map((e) => [e.id, e])), seen = new Set();
      for (let i = 0; i < found.length; i++) {
        const id = f.id + ':' + found[i].path;
        seen.add(id);
        let file;
        try { file = await found[i].get(); } catch (e) { continue; }
        const old = known.get(id);
        if (old && old.size === file.size && old.lastModified === file.lastModified && !old.partial) continue;
        // A recording the sim is still writing: leave it for the next scan.
        if (Date.now() - file.lastModified < 15000 && !o.includeFresh) continue;
        if (o.onProgress) o.onProgress(f.name + ': ' + file.name, i / found.length);
        const entry = { id, folderId: f.id, path: found[i].path, name: file.name, size: file.size, lastModified: file.lastModified, kind: 'run' };
        try {
          if (/\.svm$/i.test(file.name)) {
            entry.kind = 'setup';
            const parts = found[i].path.split('/'), track = parts.length > 1 ? parts[parts.length - 2] : 'Unknown track';
            const setup = STA.setup.fromSvm(await file.text(), { name: file.name.replace(/\.svm$/i, ''), track, createdAt: file.lastModified });
            if (setup.params.length) await keepSetup(setup, file.lastModified);
          } else {
            const m = await readMeta(file);
            if (m.setup) await keepSetup(m.setup, m.recordedAt);
            delete m.setup;
            Object.assign(entry, m);
            // The same recording seen before under this name keeps what was learned from opening it.
            if (old && old.recordedAt === entry.recordedAt) Object.assign(entry, { sessionId: old.sessionId, bestLap: old.bestLap, laps: old.laps });
          }
          report.added++;
        } catch (e) { entry.error = e && e.message ? e.message : String(e); report.failed++; }
        await b.put('files', entry);
      }
      for (const e of known.values()) if (!seen.has(e.id)) { await b.del('files', e.id); report.removed++; }
      const rec = (await b.all('folders')).find((x) => x.id === f.id);
      if (rec) { rec.lastScan = Date.now(); await b.put('folders', rec); }
    }
    report.total = (await b.all('files')).filter((e) => e.kind === 'run' && !e.error).length;
    return report;
  }

  const entries = async () => (await (await db()).all('files'));

  async function mark(id, patch) {
    const b = await db(), e = (await b.all('files')).find((x) => x.id === id);
    if (!e) return null;
    Object.assign(e, patch); await b.put('files', e);
    return e;
  }

  /* The File behind an index entry. May show the permission prompt, so call it from a click. */
  async function fileFor(entry) {
    const folder = (await (await db()).all('folders')).find((f) => f.id === entry.folderId);
    const src = folder && source(folder);
    if (!src) throw new Error('The folder "' + (folder ? folder.name : '?') + '" has to be picked again before its files can be opened.');
    if (src.files) { const f = src.files.get(entry.path); if (!f) throw new Error(entry.name + ' is no longer in that folder.'); return f; }
    if ((await permission(src.handle, true)) !== 'granted') throw new Error('The browser was not allowed to read "' + folder.name + '".');
    live.set(folder.id, { handle: src.handle });
    const parts = entry.path.split('/');
    let dir = src.handle;
    try {
      for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
      return await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    } catch (e) { throw new Error(entry.name + ' is no longer in "' + folder.name + '". Rescan the folder.'); }
  }

  /* Index entries grouped by sim, then car, then track. Pure: used by the Library tab and the tests.
     summaries (optional) supply best laps for runs opened in earlier visits. */
  function tree(list, summaries) {
    const best = new Map();
    for (const s of summaries || []) if (s.bestLap) { const k = comboKey(s); if (!best.has(k) || s.bestLap < best.get(k)) best.set(k, s.bestLap); }
    const sims = new Map();
    for (const e of list) {
      if (e.kind !== 'run' || e.error) continue;
      const sim = sims.get(e.sim) || sims.set(e.sim, { sim: e.sim, cars: new Map(), runs: 0 }).get(e.sim);
      const ck = U.slug(e.car), car = sim.cars.get(ck) || sim.cars.set(ck, { car: e.car, carClass: e.carClass || '', tracks: new Map(), last: 0, runs: 0 }).get(ck);
      const key = comboKey(e), tr = car.tracks.get(key) || car.tracks.set(key, { key, sim: e.sim, car: e.car, track: e.track, runs: [], last: 0, best: best.get(key) || null, unopened: 0 }).get(key);
      tr.runs.push(e); sim.runs++; car.runs++;
      if (!e.sessionId) tr.unopened++;
      if (e.bestLap && (!tr.best || e.bestLap < tr.best)) tr.best = e.bestLap;
      tr.last = Math.max(tr.last, e.recordedAt || 0); car.last = Math.max(car.last, tr.last);
    }
    const order = { iracing: 0, lmu: 1 };
    return Array.from(sims.values()).sort((a, b) => (a.sim in order ? order[a.sim] : 9) - (b.sim in order ? order[b.sim] : 9)).map((s) => ({
      sim: s.sim, runs: s.runs,
      cars: Array.from(s.cars.values()).sort((a, b) => b.last - a.last).map((c) => ({
        car: c.car, carClass: c.carClass, last: c.last, runs: c.runs,
        tracks: Array.from(c.tracks.values()).sort((a, b) => b.last - a.last).map((t) => Object.assign(t, { runs: t.runs.sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0)) })),
      })),
    }));
  }

  /* Where the driver left off in each car and track combination. Small, so it lives in localStorage. */
  let resumeMem = null;
  function resumeAll() {
    if (resumeMem) return resumeMem;
    try { resumeMem = JSON.parse(root.localStorage.getItem('sta-resume') || '{}') || {}; } catch (e) { resumeMem = {}; }
    if (!resumeMem.combos) resumeMem.combos = {};
    return resumeMem;
  }
  const resume = {
    get: (key) => resumeAll().combos[key] || null,
    set: (key, state) => { const r = resumeAll(); r.combos[key] = state; r.last = key; try { root.localStorage.setItem('sta-resume', JSON.stringify(r)); } catch (e) { /* memory only */ } },
    last: () => resumeAll().last || null,
    clear: () => { resumeMem = { combos: {} }; try { root.localStorage.removeItem('sta-resume'); } catch (e) { /* ignore */ } },
  };

  STA.folders = { supported, list, add, attach, addPicked, remove, scan, entries, mark, fileFor, tree, comboKey, resume, readMeta };
})(typeof window !== 'undefined' ? window : globalThis);
