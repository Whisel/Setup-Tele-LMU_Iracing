/* Opens a Le Mans Ultimate .duckdb recording in the browser with duckdb-wasm
   and exposes the two calls STA.lmu needs: rows(sql) and cols(sql).

   The small client library is bundled in vendor/duckdb. The engine (WebAssembly
   + worker) is loaded from vendor/duckdb when the app is served over http and
   the files are there, otherwise from the jsDelivr CDN. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});

  const VERSION = '1.29.0';
  const CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@' + VERSION + '/dist/';
  let dbPromise = null, attachSeq = 0;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  async function engineBase() {
    const cfg = (STA.config && STA.config.duckdbBase) || null;
    if (cfg) return cfg;
    if (/^https?:$/.test(location.protocol)) {
      try {
        const local = new URL('vendor/duckdb/', location.href).href;
        const r = await fetch(local + 'duckdb-browser-eh.worker.js', { method: 'HEAD' });
        if (r.ok) return local;
      } catch (e) { /* use the CDN */ }
    }
    return CDN;
  }

  async function engine() {
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      if (!root.duckdbWasm) await loadScript('vendor/duckdb/duckdb-browser.iife.js');
      const duckdb = root.duckdbWasm, base = await engineBase();
      const bundle = await duckdb.selectBundle({
        mvp: { mainModule: base + 'duckdb-mvp.wasm', mainWorker: base + 'duckdb-browser-mvp.worker.js' },
        eh: { mainModule: base + 'duckdb-eh.wasm', mainWorker: base + 'duckdb-browser-eh.worker.js' },
      });
      // A worker script from another origin has to be started through a same-origin blob.
      const url = URL.createObjectURL(new Blob(['importScripts(' + JSON.stringify(bundle.mainWorker) + ');'], { type: 'text/javascript' }));
      let db;
      try {
        const worker = new Worker(url);
        db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      } catch (e) {
        throw new Error('The DuckDB engine needed to read Le Mans Ultimate files could not be loaded from ' + base +
          '. Check your internet connection (it is downloaded once, then cached). Details: ' + (e && e.message ? e.message : e));
      } finally { URL.revokeObjectURL(url); }
      const conn = await db.connect();
      return { duckdb, db, conn };
    })();
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
  }

  /* Open one recording. Returns { rows, cols, close }. */
  async function open(file) {
    const { duckdb, db, conn } = await engine();
    const alias = 'rec' + (++attachSeq), name = alias + '.duckdb';
    await db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    try {
      await conn.query("ATTACH '" + name + "' AS " + alias + ' (READ_ONLY)');
    } catch (e) {
      await db.dropFile(name).catch(() => {});
      const why = e && e.message ? e.message.split('\n')[0] : '';
      throw new Error(/not a valid DuckDB/i.test(why) ? 'This is not a DuckDB database, so it is not a Le Mans Ultimate telemetry recording.'
        : 'This file could not be opened as a DuckDB database. ' + why.replace(alias + '.duckdb', file.name));
    }
    await conn.query('USE ' + alias);
    const plain = (v) => (typeof v === 'bigint' ? Number(v) : v);
    return {
      rows: async (sql) => (await conn.query(sql)).toArray().map((r) => { const o = r.toJSON(); for (const k of Object.keys(o)) o[k] = plain(o[k]); return o; }),
      cols: async (sql) => {
        const t = await conn.query(sql), out = {};
        for (const f of t.schema.fields) out[f.name] = t.getChild(f.name).toArray();
        return out;
      },
      close: async () => {
        try { await conn.query('USE memory'); await conn.query('DETACH ' + alias); await db.dropFile(name); } catch (e) { /* nothing to clean up */ }
      },
    };
  }

  STA.duck = { open, VERSION, CDN };
})(typeof window !== 'undefined' ? window : globalThis);
