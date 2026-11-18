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

  const DB_NAME = 'setup-telemetry-library', STORES = ['setups', 'sessions'];

  function memoryBackend() {
    const data = { setups: new Map(), sessions: new Map() };
    return {
      persistent: false,
      all: async (store) => Array.from(data[store].values()).map((v) => JSON.parse(JSON.stringify(v))),
      get: async (store, id) => { const v = data[store].get(id); return v ? JSON.parse(JSON.stringify(v)) : null; },
      put: async (store, rec) => { data[store].set(rec.id, JSON.parse(JSON.stringify(rec))); },
      del: async (store, id) => { data[store].delete(id); },
      clear: async (store) => { data[store].clear(); },
    };
  }

  function idbBackend() {
    return new Promise((resolve, reject) => {
      let req;
      try { req = root.indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
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
    return { app: 'setup-telemetry', version: 1, exportedAt: new Date().toISOString(), setups: await setups(), sessions: await sessions() };
  }
  async function importAll(data) {
    if (!data || data.app !== 'setup-telemetry' || !Array.isArray(data.setups)) throw new Error('This is not a library export from this app.');
    const b = await open();
    for (const s of data.setups) if (s && s.id && Array.isArray(s.params)) await b.put('setups', s);
    for (const s of data.sessions || []) if (s && s.id) await b.put('sessions', s);
    return { setups: data.setups.length, sessions: (data.sessions || []).length };
  }
  async function clearAll() { const b = await open(); await b.clear('setups'); await b.clear('sessions'); }

  const sameCar = (a, b) => U.slug(a) === U.slug(b) && U.slug(a) !== '';
  const sameTrack = (a, b) => U.slug(a) === U.slug(b) && U.slug(a) !== '';

  STA.library = { open, saveSetup, recordUse, updateSetup, setups, sessions, saveSession, removeSetup, removeSession, exportAll, importAll, clearAll, sameCar, sameTrack,
    get persistent() { return backend ? backend.persistent : null; } };
})(typeof window !== 'undefined' ? window : globalThis);
