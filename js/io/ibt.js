/* iRacing .ibt (disk telemetry) reader.

   Layout (little endian), as written by the sim:
     0    irsdk_header (112 bytes): ver, status, tickRate, sessionInfoUpdate,
          sessionInfoLen, sessionInfoOffset, numVars, varHeaderOffset, numBuf,
          bufLen, pad[2], then varBuf[4] of {tickCount, bufOffset, pad[2]}
     112  disk sub-header (32 bytes): startDate(int64), startTime, endTime
          (doubles), lapCount, recordCount (int32)
     varHeaderOffset: numVars × 144 bytes {type, offset, count, countAsTime,
          pad[3], name[32], desc[64], unit[32]}
     sessionInfoOffset: YAML text (session, driver, car setup)
     varBuf[0].bufOffset: fixed-size records of bufLen bytes until end of file

   Files can be hundreds of MB, so sample data is read in slices and only the
   requested variables are kept. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});

  const TYPE_SIZE = [1, 1, 4, 4, 4, 8]; // char, bool, int, bitfield, float, double

  /* Wrap a File/Blob, ArrayBuffer, typed array or Node Buffer as {size, read}. */
  function makeSource(src) {
    if (src && typeof src.read === 'function' && typeof src.size === 'number') return src;
    if (typeof Blob !== 'undefined' && src instanceof Blob) {
      return { size: src.size, read: (o, l) => src.slice(o, o + l).arrayBuffer() };
    }
    let u8;
    if (src instanceof ArrayBuffer) u8 = new Uint8Array(src);
    else if (ArrayBuffer.isView(src)) u8 = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
    else throw new Error('Unsupported .ibt source');
    return {
      size: u8.byteLength,
      read: (o, l) => Promise.resolve(u8.slice(o, Math.min(u8.byteLength, o + l)).buffer),
    };
  }

  function cstr(u8, off, len) {
    let end = off;
    const lim = off + len;
    while (end < lim && u8[end] !== 0) end++;
    let s = '';
    for (let i = off; i < end; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function latin1(u8) {
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder('windows-1252').decode(u8); } catch (e) { /* fall through */ }
    }
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return s;
  }

  async function readHeader(source) {
    if (source.size < 144) throw new Error('File is too small to be an iRacing .ibt file.');
    const dv = new DataView(await source.read(0, 144));
    const h = {
      version: dv.getInt32(0, true),
      status: dv.getInt32(4, true),
      tickRate: dv.getInt32(8, true),
      sessionInfoLen: dv.getInt32(16, true),
      sessionInfoOffset: dv.getInt32(20, true),
      numVars: dv.getInt32(24, true),
      varHeaderOffset: dv.getInt32(28, true),
      numBuf: dv.getInt32(32, true),
      bufLen: dv.getInt32(36, true),
      bufOffset: dv.getInt32(52, true),
      startDate: Number(dv.getBigInt64(112, true)),
      startTime: dv.getFloat64(120, true),
      endTime: dv.getFloat64(128, true),
      lapCount: dv.getInt32(136, true),
      recordCount: dv.getInt32(140, true),
    };
    const sane = h.tickRate > 0 && h.tickRate <= 1000 && h.numVars > 0 && h.numVars < 5000 &&
      h.bufLen > 0 && h.bufLen < 1 << 20 && h.varHeaderOffset >= 112 && h.bufOffset > 0 &&
      h.sessionInfoOffset > 0 && h.sessionInfoOffset + h.sessionInfoLen <= source.size;
    if (!sane) throw new Error('This does not look like an iRacing .ibt telemetry file (header check failed).');
    return h;
  }

  async function readVarHeaders(source, h) {
    const u8 = new Uint8Array(await source.read(h.varHeaderOffset, h.numVars * 144));
    const dv = new DataView(u8.buffer);
    const vars = [];
    for (let i = 0; i < h.numVars; i++) {
      const o = i * 144;
      vars.push({
        type: dv.getInt32(o, true), offset: dv.getInt32(o + 4, true), count: dv.getInt32(o + 8, true),
        name: cstr(u8, o + 16, 32), desc: cstr(u8, o + 48, 64), unit: cstr(u8, o + 112, 32),
      });
    }
    return vars;
  }

  async function readSessionInfo(source, h) {
    const u8 = new Uint8Array(await source.read(h.sessionInfoOffset, h.sessionInfoLen));
    let end = u8.indexOf(0); if (end < 0) end = u8.length;
    const text = latin1(u8.subarray(0, end));
    return { text, info: STA.yaml.parse(text) };
  }

  /* Read an .ibt file.
     opts.want       array of variable names to extract (missing ones are skipped);
                     omit to extract every scalar numeric variable
     opts.headerOnly return session info and variable list without sample data
     opts.onProgress callback(fraction) */
  async function read(src, opts) {
    opts = opts || {};
    const source = makeSource(src);
    const header = await readHeader(source);
    const varHeaders = await readVarHeaders(source, header);
    const session = await readSessionInfo(source, header);
    const out = {
      header, sessionInfo: session.info, sessionInfoText: session.text,
      varList: varHeaders.map((v) => ({ name: v.name, unit: v.unit, desc: v.desc, type: v.type, count: v.count })),
      tickRate: header.tickRate, n: 0, vars: {},
    };
    if (opts.headerOnly) return out;

    const n = Math.floor((source.size - header.bufOffset) / header.bufLen);
    out.n = n;
    const wantSet = opts.want ? new Set(opts.want) : null;
    const picked = varHeaders.filter((v) => v.count === 1 && v.type >= 1 && v.type <= 5 && (!wantSet || wantSet.has(v.name)));
    for (const v of picked) {
      const A = v.type === 5 ? Float64Array : v.type === 4 ? Float32Array : v.type === 1 ? Uint8Array : Int32Array;
      out.vars[v.name] = { unit: v.unit, desc: v.desc, data: new A(n) };
      v._data = out.vars[v.name].data;
    }

    const chunkRecords = Math.max(1, Math.floor((8 << 20) / header.bufLen));
    for (let r0 = 0; r0 < n; r0 += chunkRecords) {
      const cnt = Math.min(chunkRecords, n - r0);
      const dv = new DataView(await source.read(header.bufOffset + r0 * header.bufLen, cnt * header.bufLen));
      for (const v of picked) {
        const d = v._data, off = v.offset, bl = header.bufLen;
        switch (v.type) {
          case 5: for (let k = 0; k < cnt; k++) d[r0 + k] = dv.getFloat64(k * bl + off, true); break;
          case 4: for (let k = 0; k < cnt; k++) d[r0 + k] = dv.getFloat32(k * bl + off, true); break;
          case 1: for (let k = 0; k < cnt; k++) d[r0 + k] = dv.getUint8(k * bl + off); break;
          default: for (let k = 0; k < cnt; k++) d[r0 + k] = dv.getInt32(k * bl + off, true);
        }
      }
      if (opts.onProgress) opts.onProgress(Math.min(1, (r0 + cnt) / n));
    }
    for (const v of picked) delete v._data;
    return out;
  }

  STA.ibt = { read, makeSource, TYPE_SIZE };
})(typeof window !== 'undefined' ? window : globalThis);
