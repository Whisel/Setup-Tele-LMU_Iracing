# Bundled DuckDB browser client

`duckdb-browser.iife.js` is the main-thread client of
[duckdb-wasm](https://github.com/duckdb/duckdb-wasm) 1.29.0 (MIT licence) with its
dependency [Apache Arrow JS](https://github.com/apache/arrow) 17.0.0 (Apache-2.0 licence),
bundled into one classic script so the app can load it from a `file://` page.

It was produced with:

    npm install @duckdb/duckdb-wasm@1.29.0 esbuild
    npx esbuild node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs \
      --bundle --format=iife --global-name=duckdbWasm --minify \
      --outfile=vendor/duckdb/duckdb-browser.iife.js

The DuckDB engine itself (a ~35 MB WebAssembly file plus its worker script) is not
stored in this repository. The app downloads it from the jsDelivr CDN the first time
you open a Le Mans Ultimate recording, and the browser caches it after that.

## Running without the CDN

If you serve the app from a local web server and want it to work offline, copy these
four files from `node_modules/@duckdb/duckdb-wasm/dist/` into this folder:

    duckdb-eh.wasm
    duckdb-browser-eh.worker.js
    duckdb-mvp.wasm
    duckdb-browser-mvp.worker.js

The app checks for them here first and only falls back to the CDN when they are
missing. This only works over `http://`, not when the page is opened as a file.
