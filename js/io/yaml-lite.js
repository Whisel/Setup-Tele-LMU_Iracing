/* Minimal YAML reader for the session-info block iRacing embeds in .ibt files.
   That block only uses nested maps, lists of maps and plain scalars, so this is
   deliberately not a general YAML parser. All scalars are returned as strings. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});

  function scalar(v) {
    v = v.trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function parse(text) {
    const lines = [];
    for (const raw of String(text).split(/\r?\n/)) {
      if (!raw.trim() || raw.trim() === '---' || raw.trim() === '...') continue;
      const indent = raw.length - raw.replace(/^ +/, '').length;
      lines.push({ indent, text: raw.trim() });
    }
    let i = 0;

    function parseMap(indent) {
      const obj = {};
      while (i < lines.length) {
        const L = lines[i];
        if (L.indent < indent) break;
        if (L.indent > indent) { i++; continue; }
        if (L.text.startsWith('- ') || L.text === '-') break;
        const c = L.text.indexOf(':');
        if (c < 0) { i++; continue; }
        const key = L.text.slice(0, c).trim(), val = L.text.slice(c + 1);
        i++;
        if (val.trim() === '') {
          const N = lines[i];
          if (N && N.text.startsWith('- ') && N.indent >= indent) obj[key] = parseList(N.indent);
          else if (N && N.indent > indent) obj[key] = parseMap(N.indent);
          else obj[key] = '';
        } else obj[key] = scalar(val);
      }
      return obj;
    }

    function parseList(indent) {
      const arr = [];
      while (i < lines.length) {
        const L = lines[i];
        if (L.indent !== indent || !L.text.startsWith('- ')) break;
        // Treat "- Key: v" as the first entry of a map indented two columns further.
        lines[i] = { indent: indent + 2, text: L.text.slice(2).trim() };
        arr.push(parseMap(indent + 2));
      }
      return arr;
    }

    return lines.length ? parseMap(lines[0].indent) : {};
  }

  STA.yaml = { parse };
})(typeof window !== 'undefined' ? window : globalThis);
