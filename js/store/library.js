/* The library remembers setups and a short summary of each session between
   visits. It lives in the browser (IndexedDB), on this computer only. Raw
   telemetry is never stored; drop the file again to look at its traces.

   Records
     setup   : Setup + { usage: { sessions[], lastUsed, bestLap, laps }, tags: { simBaseline } , status }
     session : summary from STA.session.summaryOf + { tendencies[] }

   If IndexedDB is unavailable (private window, some file:// setups) the library
   falls back to memory for the current visit and says so via `persistent`. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;

  // folders and files belong to the folder library (folders.js): watched folders and the index of what is in them.
  const DB_NAME = 'setup-telemetry-library', DB_VERSION = 2, STORES = ['setups', 'sessions', 'folders', 'files'];

  function memoryBackend() {
    const data = { setups: new Map(), sessions: new Map(), folders: new Map(), files: new Map() };
    // Folder records hold a live folder handle, which must not be copied through JSON.
    const copy = (store, v) => (store === 'folders' ? Object.assign({}, v) : JSON.parse(JSON.stringify(v)));
    return {
      persistent: false,
      all: async (store) => Array.from(data[store].values()).map((v) => copy(store, v)),
      get: async (store, id) => { const v = data[store].get(id); return v ? copy(store, v) : null; },
      put: async (store, rec) => { data[store].set(rec.id, copy(store, rec)); },
      del: async (store, id) => { data[store].delete(id); },
      clear: async (store) => { data[store].clear(); },
    };
  }

  function idbBackend() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' }); };
      req.onerror = () => reject(req.error || new Error('IndexedDB could not be opened'));
      req.onblocked = () => reject(new Error('IndexedDB is blocked'));
      req.onsuccess = () => {
        const db = req.result;
        const run = (store, mode, fn) => new Promise((res, rej) => {
          let out;
          const tx = db.transaction(store, mode);
          const r = fn(tx.objectStore(store));
          if (r) r.onsuccess = () => { out = r.result; };
          tx.oncomplete = () => res(out);
          tx.onerror = tx.onabort = () => rej(tx.error || new Error('Library write failed'));
        });
        resolve({
          persistent: true,
          all: (store) => run(store, 'readonly', (s) => s.getAll()),
          get: (store, id) => run(store, 'readonly', (s) => s.get(id)).then((v) => v || null),
          put: (store, rec) => run(store, 'readwrite', (s) => s.put(rec)),
          del: (store, id) => run(store, 'readwrite', (s) => s.delete(id)),
          clear: (store) => run(store, 'readwrite', (s) => s.clear()),
        });
      };
    });
  }

  let backend = null;
  async function open(forceMemory) {
    if (backend && !forceMemory) return backend;
    if (!forceMemory && root.indexedDB) {
      try { backend = await idbBackend(); return backend; } catch (e) { /* fall back below */ }
    }
    backend = memoryBackend();
    return backend;
  }

  const strip = (setup) => { const c = Object.assign({}, setup); return c; };

  /* Save a setup. An existing record with the same id keeps its name, tags and usage. */
  async function saveSetup(setup, extra) {
    const b = await open();
    const old = await b.get('setups', setup.id);
    const rec = Object.assign({}, strip(setup), {
      usage: (old && old.usage) || { sessions: [], lastUsed: null, bestLap: null, laps: 0 },
      tags: Object.assign({}, old && old.tags, setup.tags),
      status: setup.status || (old && old.status) || '',
      createdAt: (old && old.createdAt) || setup.createdAt || Date.now(),
    }, extra || {});
    if (old && old.userNamed) { rec.name = old.name; rec.userNamed = true; }
    await b.put('setups', rec);
    return rec;
  }

  /* Note that a setup was driven in a session. */
  async function recordUse(setup, summary) {
    const rec = await saveSetup(setup);
    const u = rec.usage;
    if (u.sessions.indexOf(summary.id) < 0) { u.sessions.push(summary.id); u.laps += summary.laps || 0; }
    if (!u.lastUsed || summary.recordedAt > u.lastUsed) u.lastUsed = summary.recordedAt;
    if (summary.bestLap && (!u.bestLap || summary.bestLap < u.bestLap)) u.bestLap = summary.bestLap;
    const b = await open();
    await b.put('setups', rec);
    return rec;
  }

  async function updateSetup(id, patch) {
    const b = await open(); const rec = await b.get('setups', id);
    if (!rec) return null;
    Object.assign(rec, patch);
    if (patch.tags) rec.tags = Object.assign({}, rec.tags, patch.tags);
    await b.put('setups', rec);
    return rec;
  }

  async function setups() { return (await open()).all('setups'); }
  async function sessions() { return (await open()).all('sessions'); }
  async function saveSession(summary) { await (await open()).put('sessions', summary); return summary; }
  async function removeSetup(id) { await (await open()).del('setups', id); }
  async function removeSession(id) { await (await open()).del('sessions', id); }

  async function exportAll() {
    return { app: 'setup-telemetry', version: 1, exportedAt: new Date().toISOString(), setups: await setups(), sessions: await sessions(), blocked: blockedAll(), reasons: reasonsAll() };
  }
  async function importAll(data) {
    if (!data || data.app !== 'setup-telemetry' || !Array.isArray(data.setups)) throw new Error('This is not a library export from this app.');
    const b = await open();
    for (const s of data.setups) if (s && s.id && Array.isArray(s.params)) await b.put('setups', s);
    for (const s of data.sessions || []) if (s && s.id) await b.put('sessions', s);
    if (data.reasons && typeof data.reasons === 'object') {
      for (const sid of Object.keys(data.reasons)) if (data.reasons[sid] && typeof data.reasons[sid] === 'object') reasonsAll()[sid] = Object.assign({}, data.reasons[sid], reasonsAll()[sid]);
      reasonsSave();
    }
    if (data.blocked && typeof data.blocked === 'object') {
      for (const k of Object.keys(data.blocked)) {
        if (!Array.isArray(data.blocked[k])) continue;
        const have = new Set((blockedAll()[k] || []).map((e) => JSON.stringify(e)));
        blockedAll()[k] = (blockedAll()[k] || []).concat(data.blocked[k].filter((e) => (typeof e === 'string' || isLimit(e) || isContest(e)) && !have.has(JSON.stringify(e))));
      }
      blockedSave();
    }
    return { setups: data.setups.length, sessions: (data.sessions || []).length };
  }
  async function clearAll() { const b = await open(); await b.clear('setups'); await b.clear('sessions'); blocked.clear(); reasons.clear(); }

  /* What the driver has said about a setup change: what it was for, and their own verdict.
     Keyed by the session the change led into, then by the change ("role|axle|dir"). */
  let reasonsMem = null;
  function reasonsAll() {
    if (reasonsMem) return reasonsMem;
    try { reasonsMem = JSON.parse(root.localStorage.getItem('sta-reasons') || '{}') || {}; } catch (e) { reasonsMem = {}; }
    return reasonsMem;
  }
  function reasonsSave() { try { root.localStorage.setItem('sta-reasons', JSON.stringify(reasonsAll())); } catch (e) { /* memory only */ } }
  const reasons = {
    all: () => reasonsAll(),
    get: (sessionId, key) => (reasonsAll()[sessionId] || {})[key] || {},
    set: (sessionId, key, patch) => {
      const forSession = reasonsAll()[sessionId] || (reasonsAll()[sessionId] = {});
      const rec = Object.assign({}, forSession[key], patch);
      for (const k of Object.keys(rec)) if (rec[k] == null || rec[k] === '') delete rec[k];
      if (Object.keys(rec).length) forSession[key] = rec; else delete forSession[key];
      if (!Object.keys(forSession).length) delete reasonsAll()[sessionId];
      reasonsSave();
    },
    clear: () => { reasonsMem = {}; reasonsSave(); },
  };

  /* Changes the driver has marked as "not possible on this car", per sim and car.
     Small, so it lives in localStorage; falls back to memory if that is unavailable. */
  let blockedMem = null;
  function blockedAll() {
    if (blockedMem) return blockedMem;
    try { blockedMem = JSON.parse(root.localStorage.getItem('sta-blocked') || '{}') || {}; } catch (e) { blockedMem = {}; }
    return blockedMem;
  }
  function blockedSave() { try { root.localStorage.setItem('sta-blocked', JSON.stringify(blockedMem)); } catch (e) { /* kept for this visit only */ } }
  const carKey = (sim, car) => sim + '|' + U.slug(car);
  // Entries per car are either a string "role|axle|dir" (a change ruled out altogether) or an
  // object { paramId, dir, num, raw, label } (a setting that cannot go past a value).
  const entries = (sim, car) => blockedAll()[carKey(sim, car)] || [];
  const put = (sim, car, list) => { blockedAll()[carKey(sim, car)] = list; blockedSave(); };
  const blocked = {
    list: (sim, car) => entries(sim, car).filter((e) => typeof e === 'string'),
    set: (sim, car) => new Set(entries(sim, car).filter((e) => typeof e === 'string')),
    add: (sim, car, key) => put(sim, car, entries(sim, car).filter((e) => e !== key).concat(key)),
    remove: (sim, car, key) => put(sim, car, entries(sim, car).filter((e) => e !== key)),
    clear: () => { blockedMem = {}; blockedSave(); },
  };
  const isLimit = (e) => e && typeof e === 'object' && e.paramId && (e.dir === '+' || e.dir === '-');
  // { contest: "role|axle|dir", reason, at }: a suggested change the driver contested, and why.
  const isContest = (e) => e && typeof e === 'object' && typeof e.contest === 'string';
  const contested = {
    list: (sim, car) => entries(sim, car).filter(isContest),
    map: (sim, car) => new Map(entries(sim, car).filter(isContest).map((e) => [e.contest, e])),
    add: (sim, car, key, reason) => put(sim, car, entries(sim, car).filter((x) => !(isContest(x) && x.contest === key)).concat({ contest: key, reason, at: Date.now() })),
    remove: (sim, car, key) => put(sim, car, entries(sim, car).filter((x) => !(isContest(x) && x.contest === key))),
  };
  const limits = {
    list: (sim, car) => entries(sim, car).filter(isLimit),
    map: (sim, car) => new Map(entries(sim, car).filter(isLimit).map((e) => [e.paramId + '|' + e.dir, e])),
    add: (sim, car, e) => put(sim, car, entries(sim, car).filter((x) => !(isLimit(x) && x.paramId === e.paramId && x.dir === e.dir)).concat(e)),
    remove: (sim, car, paramId, dir) => put(sim, car, entries(sim, car).filter((x) => !(isLimit(x) && x.paramId === paramId && x.dir === dir))),
  };

  const sameCar = (a, b) => U.slug(a) === U.slug(b) && U.slug(a) !== '';
  const sameTrack = (a, b) => U.slug(a) === U.slug(b) && U.slug(a) !== '';

  STA.library = { open, saveSetup, recordUse, updateSetup, setups, sessions, saveSession, removeSetup, removeSession, exportAll, importAll, clearAll, sameCar, sameTrack, blocked, limits, contested, reasons, raw: open,
    get persistent() { return backend ? backend.persistent : null; } };
})(typeof window !== 'undefined' ? window : globalThis);
