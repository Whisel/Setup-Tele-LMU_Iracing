/* The six tabs. Each render function rebuilds its tab from the current state. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util, A = () => STA.app, S = () => STA.session;
  let live = []; // chart objects of the visible tab, destroyed on re-render

  const h = (...a) => STA.app.h(...a);
  const view = () => document.getElementById('view');
  const ui = () => STA.app.state.ui;

  function clear() { for (const c of live) c.destroy(); live = []; view().innerHTML = ''; }
  function empty(title, text) { return h('div', { class: 'blank' }, [h('h2', { text: title }), h('p', { text })]); }
  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/csv' })), download: name });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function table(cols, rows, opts) {
    opts = opts || {};
    return h('div', { class: 'tablewrap' + (opts.tall ? ' tall' : '') }, h('table', { class: 'data ' + (opts.cls || '') }, [
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.num ? 'num' : '', text: c.label, title: c.title || null })))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r._cls || '', onclick: r._click || null, tabindex: r._click ? '0' : null },
        cols.map((c) => { const v = r[c.key]; return h('td', { class: (c.num ? 'num ' : '') + (c.cls || '') + (r._cell && r._cell[c.key] ? ' ' + r._cell[c.key] : '') }, v instanceof Node ? v : [v == null ? '' : String(v)]); })))),
    ]));
  }
  const confTag = (c) => h('span', { class: 'conf ' + c, title: 'Confidence: ' + c, 'aria-label': c + ' confidence' }, [h('i', {}), c]);

  /* ---------- shared: every overlaid lap, expressed on the reference lap's grid ---------- */

  /* laps[0] (= a) is the reference; b is the first other lap, used by the views that
     compare exactly two laps. Each lap gets on(name) -> channel on the reference grid,
     and delta -> its time difference to the reference along the lap. */
  function pair() {
    const laps = A().overlayLaps();
    if (!laps.length) return null;
    const a = laps[0];
    for (const l of laps) {
      const cache = new Map();
      l.on = (name) => {
        if (l === a) return a.grid[name] || null;
        if (!cache.has(name)) cache.set(name, l.grid[name] && !Array.isArray(l.grid[name]) ? S().onGrid(a.grid, l.grid, l.grid[name]) : null);
        return cache.get(name);
      };
      l.delta = l === a ? null : S().deltaTime(a.grid, l.grid);
    }
    const b = laps[1] || null;
    const corners = a.session.corners && a.session.refLap ? a.session.corners : [];
    return { a, b, laps, others: laps.slice(1), onA: (name) => (b ? b.on(name) : null), corners, delta: b ? b.delta : null };
  }

  /* Corner numbers for one lap. Corner windows are indices on the reference grid; scale them if this lap's grid differs. */
  function statsFor(p, lap, c, prev) {
    const k = (lap.grid.n - 1) / (p.a.grid.n - 1);
    if (k === 1) return S().cornerStats(lap.grid, c, prev);
    return S().cornerStats(lap.grid, Object.assign({}, c, { a: Math.round(c.a * k), b: Math.round(c.b * k) }), prev == null ? null : Math.round(prev * k));
  }

  function cornerRows(p) {
    return p.corners.map((c, i) => {
      const prev = i > 0 ? p.corners[i - 1].b : null;
      const stats = p.laps.map((l) => statsFor(p, l, c, prev));
      return { c, stats, sa: stats[0], sb: stats[1] || null };
    });
  }

  /* ---------- Lap comparison ---------- */

  const CHANNELS = [
    ['speed', 'Speed'], ['throttle', 'Throttle'], ['brake', 'Brake'], ['steer', 'Steering'], ['gear', 'Gear'], ['rpm', 'Engine speed'],
    ['latG', 'Lateral G'], ['longG', 'Longitudinal G'], ['delta', 'Time difference'],
  ];

  function tracePanels(p) {
    const on = ui().channels;
    const g = p.a.grid, scale = (arr, k) => { if (!arr) return null; const o = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) o[i] = arr[i] * k; return o; };
    const kS = A().state.speedUnit === 'mph' ? 2.236936 : 3.6;
    const all = (name, k) => p.laps.map((l) => ({ name: l.letter, colorVar: l.colorVar, muted: l.muted, data: k ? scale(l.on(name), k) : l.on(name) }));
    const R = p.a.letter, panels = [];
    if (on.speed) panels.push({ key: 'speed', label: 'Speed', unit: A().speedUnit(), dec: 1, height: 150, series: all('speed', kS) });
    if (on.delta && p.others.length) panels.push({ key: 'delta', label: 'Time difference to lap ' + R, unit: 's (above zero: behind lap ' + R + ')', dec: 3, height: 84, zero: true, noDiff: true,
      series: p.others.map((l) => ({ name: l.letter, colorVar: l.colorVar, muted: l.muted, data: l.delta })) });
    if (on.throttle) panels.push({ key: 'throttle', label: 'Throttle', unit: '%', dec: 0, height: 70, min: 0, max: 100, series: all('throttle', 100) });
    if (on.brake) panels.push({ key: 'brake', label: 'Brake', unit: '%', dec: 0, height: 70, min: 0, max: 100, series: all('brake', 100) });
    if (on.steer && g.steer) panels.push({ key: 'steer', label: 'Steering', unit: p.a.session.meta.steerUnit + ', left is positive', dec: 1, height: 84, zero: true, series: all('steer') });
    if (on.gear && g.gear) panels.push({ key: 'gear', label: 'Gear', unit: '', dec: 0, height: 60, step: true, series: all('gear') });
    if (on.rpm && g.rpm) panels.push({ key: 'rpm', label: 'Engine speed', unit: 'rpm', dec: 0, height: 80, series: all('rpm') });
    if (on.latG && g.latG) panels.push({ key: 'latG', label: 'Lateral G', unit: 'g, left is positive', dec: 2, height: 80, zero: true, series: all('latG') });
    if (on.longG && g.longG) panels.push({ key: 'longG', label: 'Longitudinal G', unit: 'g, braking is negative', dec: 2, height: 80, zero: true, series: all('longG') });
    return panels;
  }

  function mapData(p, mode) {
    const g = p.a.grid, R = p.a.letter;
    const css = STA.charts.css, legend = [];
    const line = (l) => ({ name: l.letter, colorVar: l.colorVar, muted: l.muted, x: l.grid.x, y: l.grid.y, width: 2 });
    let lines = [line(p.a)];
    if (mode === 'speed') {
      const dark = document.documentElement.dataset.theme === 'dark';
      const ramp = dark ? ['#104281', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'] : ['#b7d3f6', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0d366b'];
      const [lo, hi] = U.minMax(g.speed);
      lines[0].colors = Array.from(g.speed, (v) => (v === v ? ramp[Math.min(ramp.length - 1, Math.floor(((v - lo) / Math.max(1e-6, hi - lo)) * ramp.length))] : 'transparent'));
      legend.push({ ramp, lo: A().speed(lo).toFixed(0), hi: A().speed(hi).toFixed(0) + ' ' + A().speedUnit(), label: 'Lap ' + R + ' speed' });
    } else if (mode === 'pedals') {
      const thr = css('--thr'), brk = css('--brk'), coast = css('--muted');
      lines[0].colors = Array.from(g.throttle, (v, i) => (v !== v ? 'transparent' : g.brake[i] > 0.05 ? brk : v > 0.2 ? thr : coast));
      legend.push({ swatches: [[thr, 'On throttle'], [brk, 'Braking'], [coast, 'Coasting']], label: 'Lap ' + R + ' pedals' });
    } else if (mode === 'gain' && p.b) {
      // Where each of the two laps gains: slope of the time difference over the surrounding 80 m.
      const ca = css(p.a.colorVar), cb = css(p.b.colorVar), even = css('--muted'), w = Math.round(40 / g.step), d = p.delta;
      lines[0].colors = Array.from(d, (v, i) => { const sl = d[Math.min(d.length - 1, i + w)] - d[Math.max(0, i - w)]; return sl !== sl ? 'transparent' : sl > 0.012 ? ca : sl < -0.012 ? cb : even; });
      legend.push({ swatches: [[ca, R + ' is gaining'], [cb, p.b.letter + ' is gaining'], [even, 'Even']], label: 'Time gained over each stretch, laps ' + R + ' and ' + p.b.letter });
    } else {
      lines = p.laps.filter((l) => l.grid.x).map(line);
      const named = p.laps.filter((l) => !l.muted), grey = p.laps.length - named.length;
      legend.push({ swatches: named.map((l) => [css(l.colorVar), 'Lap ' + l.letter]).concat(grey ? [[css('--lap-x'), grey + ' more in grey']] : []), label: 'Driven lines' });
    }
    return { lines, corners: p.corners.map((c) => ({ name: c.name, i: c.apex })), legend };
  }

  function legendEl(legend) {
    return h('div', { class: 'legend' }, legend.map((l) => h('div', { class: 'legend-row' }, [
      h('span', { class: 'legend-label', text: l.label }),
      l.ramp ? h('span', { class: 'legend-ramp' }, [h('span', { text: l.lo }), h('span', { class: 'ramp' }, l.ramp.map((c) => h('i', { style: 'background:' + c }))), h('span', { text: l.hi })])
        : h('span', { class: 'legend-sw' }, l.swatches.map(([c, t]) => h('span', {}, [h('i', { class: 'sw', style: 'background:' + c }), t]))),
    ])));
  }

  function renderCompare() {
    const p = pair();
    if (!p) return view().appendChild(empty('Compare laps', 'Load a telemetry file, then use the + buttons in the lap list on the left to overlay as many laps as you like. The traces, driven lines and a corner-by-corner table appear here.'));
    const g = p.a.grid, R = p.a.letter;
    const mapBox = h('div', { class: 'mapbox' }), traces = h('div', { class: 'traces' });
    const on = ui().channels || (ui().channels = { speed: true, throttle: true, brake: true, steer: true, gear: false, rpm: false, latG: false, longG: false, delta: true });
    const chooser = h('div', { class: 'chooser' }, CHANNELS.filter(([key]) => key !== 'delta' || p.b).map(([key, label]) =>
      h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: !!on[key], onchange: (ev) => { on[key] = ev.target.checked; render(); } }), label])));
    const hint = h('p', { class: 'hint', text: 'Drag across a trace to zoom, double-click to zoom back out. Scroll on the map to zoom, drag to move.' + (p.laps.length > 2 ? ' Point at a lap in the bar above to pick it out.' : '') });
    const md = g.x ? mapData(p, 'lines') : null;
    view().appendChild(h('div', { class: 'compare' }, [
      h('section', { class: 'panel map-panel' }, [h('h2', { text: 'Driven lines' }), g.x ? mapBox : h('p', { class: 'empty', text: 'This file has no position data, so there is no map.' }), md ? legendEl(md.legend) : null]),
      h('section', { class: 'panel' }, [h('div', { class: 'panel-head' }, [h('h2', { text: p.laps.length > 1 ? p.laps.length + ' laps by lap distance' : 'Traces by lap distance' }), chooser]), traces, hint]),
    ]));

    let map = null;
    const stack = new STA.charts.TraceStack(traces, { onCursor: (i) => { if (map) map.setCursor(i, false); } });
    live.push(stack);
    stack.setData({ x: g.d, panels: tracePanels(p), corners: p.corners });
    if (md) { map = new STA.charts.TrackMap(mapBox, { onCursor: (i) => stack.setCursor(i, false) }); live.push(map); map.setData(md); }

    // corner-by-corner table
    if (!p.corners.length) return;
    const rows = cornerRows(p), sp = (v) => A().speed(v).toFixed(1);
    const zoom = (c) => () => stack.setRange([Math.max(0, c.dStart - 150), Math.min(g.d[g.n - 1], c.dEnd + 120)]);
    const base = (r) => ({ name: r.c.name, dir: r.c.dir === 'L' ? 'Left' : 'Right', at: Math.round(r.c.dApex) + ' m', _click: zoom(r.c) });
    const brakeTxt = (st) => (st.brakeAt == null ? 'no braking' : Math.round(st.brakeAt) + ' m');
    let cols, data, note = 'Select a row to zoom the traces to that corner.';
    if (p.laps.length <= 2) {
      const Bn = p.b ? p.b.letter : '';
      let worst = null;
      data = rows.map((r) => {
        const dt = r.sb ? r.sb.time - r.sa.time : null;
        if (dt != null && (worst == null || Math.abs(dt) > Math.abs(worst.dt))) worst = { dt, name: r.c.name };
        return Object.assign(base(r), {
          aMin: sp(r.sa.min), bMin: r.sb ? sp(r.sb.min) : '', dMin: r.sb ? U.fmtDelta(A().speed(r.sb.min - r.sa.min), 1) : '',
          aBrake: brakeTxt(r.sa), bBrake: r.sb ? brakeTxt(r.sb) : '',
          dBrake: r.sb && r.sa.brakeAt != null && r.sb.brakeAt != null ? U.fmtDelta(r.sb.brakeAt - r.sa.brakeAt, 0) + ' m' : '',
          aT: r.sa.time.toFixed(3), bT: r.sb ? r.sb.time.toFixed(3) : '', dT: dt == null ? '' : U.fmtDelta(dt),
        });
      });
      const big = worst && p.b && Math.abs(worst.dt) >= 0.02;
      data.forEach((d) => { if (big && d.name === worst.name) d._cls = 'mark'; });
      if (big) note = 'Biggest difference: ' + worst.name + ' (' + U.fmtDelta(worst.dt) + ' s). ' + note;
      cols = [{ key: 'name', label: 'Corner' }, { key: 'dir', label: 'Turn' }, { key: 'at', label: 'Apex at', num: true },
        { key: 'aMin', label: R + ' min ' + A().speedUnit(), num: true }].concat(p.b ? [{ key: 'bMin', label: Bn + ' min', num: true }, { key: 'dMin', label: Bn + ' − ' + R, num: true }] : [],
        [{ key: 'aBrake', label: R + ' brakes at', num: true }], p.b ? [{ key: 'bBrake', label: Bn + ' brakes at', num: true }, { key: 'dBrake', label: Bn + ' − ' + R, num: true, title: 'Positive: ' + Bn + ' brakes later' }] : [],
        [{ key: 'aT', label: R + ' time in corner', num: true }], p.b ? [{ key: 'bT', label: Bn + ' time', num: true }, { key: 'dT', label: Bn + ' − ' + R + ' s', num: true }] : []);
    } else {
      // Many laps: the reference lap's numbers, each other lap's time against it, and which lap was quickest.
      let widest = null;
      data = rows.map((r) => {
        const times = r.stats.map((st) => st.time);
        let qi = 0; times.forEach((t, k) => { if (t < times[qi]) qi = k; });
        const spread = Math.max(...times) - Math.min(...times);
        if (widest == null || spread > widest.spread) widest = { spread, name: r.c.name };
        const o = Object.assign(base(r), { aMin: sp(r.sa.min), aBrake: brakeTxt(r.sa), aT: r.sa.time.toFixed(3), quick: p.laps[qi].letter + ' (' + sp(r.stats[qi].min) + ')', spread: spread.toFixed(3), _cell: {} });
        p.others.forEach((l, k) => { o['d' + k] = U.fmtDelta(r.stats[k + 1].time - r.sa.time); });
        return o;
      });
      data.forEach((d) => { if (widest && d.name === widest.name && widest.spread >= 0.02) d._cls = 'mark'; });
      if (widest && widest.spread >= 0.02) note = 'Widest spread between laps: ' + widest.name + ' (' + widest.spread.toFixed(3) + ' s). ' + note;
      cols = [{ key: 'name', label: 'Corner' }, { key: 'dir', label: 'Turn' }, { key: 'at', label: 'Apex at', num: true }, { key: 'aMin', label: R + ' min ' + A().speedUnit(), num: true },
        { key: 'aBrake', label: R + ' brakes at', num: true }, { key: 'aT', label: R + ' time in corner', num: true }]
        .concat(p.others.map((l, k) => ({ key: 'd' + k, label: l.letter + ' − ' + R + ' s', num: true })),
          [{ key: 'quick', label: 'Quickest lap (min ' + A().speedUnit() + ')' }, { key: 'spread', label: 'Spread s', num: true }]);
    }
    view().appendChild(h('section', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [h('h2', { text: 'Corner by corner' }), h('span', { class: 'h-note', text: note })]),
      table(cols, data),
      h('p', { class: 'hint', text: 'Corners are found from the lateral load on the reference lap\'s session and numbered in driving order (C1, C2 …). They will not always match the circuit\'s official turn numbers.' }),
    ]));
  }

  /* ---------- Track map ---------- */

  function renderMap() {
    const p = pair();
    if (!p) return view().appendChild(empty('Track map', 'Load a telemetry file to see the track and the line you drove.'));
    const g = p.a.grid, R = p.a.letter;
    if (!g.x) return view().appendChild(empty('No position data', 'This file does not contain position data, so a track map cannot be drawn.'));
    const mode = ui().mapMode || 'speed';
    const mapBox = h('div', { class: 'mapbox big' }), readout = h('div', { class: 'readout' });
    const md = mapData(p, mode === 'gain' && !p.b ? 'lines' : mode);
    const modes = [['speed', 'Speed on lap ' + R], ['pedals', 'Throttle and brake on lap ' + R], ['gain', p.b ? 'Where laps ' + R + ' and ' + p.b.letter + ' gain time' : 'Where each lap gains time'],
      ['lines', p.laps.length > 2 ? 'All ' + p.laps.length + ' driven lines' : 'Driven lines']];
    const sel = h('select', { onchange: (ev) => { ui().mapMode = ev.target.value; render(); } }, modes.map(([v, t]) => h('option', { value: v, selected: v === mode, disabled: v === 'gain' && !p.b, text: t })));
    let map = null;
    view().appendChild(h('section', { class: 'panel map-full' }, [
      h('div', { class: 'panel-head' }, [h('h2', { text: p.a.session.trackName }),
        h('div', { class: 'tools' }, [h('label', { class: 'mini' }, ['Colour the line by ', sel]), h('button', { class: 'btn ghost', type: 'button', text: 'Reset view', onclick: () => map && map.resetView() })])]),
      h('div', { class: 'map-split' }, [mapBox, h('div', { class: 'map-side' }, [legendEl(md.legend), readout,
        h('p', { class: 'hint', text: 'Scroll to zoom, drag to move, double-click to fit. Move over the line to read the values at that point.' })])]),
    ]));
    const cols = p.laps.slice(0, 6); // the readout stays readable up to six laps
    const showAt = (i) => {
      if (i < 0) { readout.innerHTML = '<p class="empty">Move over the line to read values.</p>'; return; }
      const c = p.corners.find((c) => i >= c.a && i <= c.b);
      const row = (label, f) => '<tr><th>' + label + '</th>' + cols.map((l) => '<td class="num">' + f(l) + '</td>').join('') + '</tr>';
      const at = (l, name) => { const arr = l.on(name); return arr ? arr[i] : NaN; };
      let html = '<table class="data kv"><thead><tr><th>' + Math.round(g.d[i]) + ' m' + (c ? ', ' + c.name : '') + '</th>' + cols.map((l) => '<th class="num"><i class="sw" style="background:var(' + l.colorVar + ')"></i>' + l.letter + '</th>').join('') + '</tr></thead><tbody>';
      html += row('Speed, ' + A().speedUnit(), (l) => U.fmt(A().speed(at(l, 'speed')), 1));
      html += row('Throttle, %', (l) => U.fmt(at(l, 'throttle') * 100, 0));
      html += row('Brake, %', (l) => U.fmt(at(l, 'brake') * 100, 0));
      if (g.gear) html += row('Gear', (l) => U.fmt(at(l, 'gear'), 0));
      if (g.latG) html += row('Lateral G', (l) => U.fmt(at(l, 'latG'), 2));
      html += row('Lap time so far, s', (l) => U.fmt(g.t[i] + (l.delta ? l.delta[i] : 0), 3));
      if (p.b) html += row('Gap to lap ' + R + ', s', (l) => (l.delta ? U.fmtDelta(l.delta[i]) : ''));
      readout.innerHTML = html + '</tbody></table>' + (p.laps.length > cols.length ? '<p class="hint">Showing the first ' + cols.length + ' of ' + p.laps.length + ' laps.</p>' : '');
    };
    map = new STA.charts.TrackMap(mapBox, { onCursor: showAt }); live.push(map);
    map.setData(md); showAt(-1);
  }

  /* ---------- Telemetry tables ---------- */

  function lapStats(session) {
    if (session._lapStats) return session._lapStats;
    const out = [];
    for (const l of session.laps) {
      if (!l.complete) { out.push({ lap: l }); continue; }
      const g = S().lapGrid(session, l);
      let tot = 0, wot = 0, brk = 0, thr = 0, vmax = 0, vmin = Infinity, gl = 0, gb = 0;
      for (let i = 1; i < g.n; i++) {
        const dt = g.t[i] - g.t[i - 1]; if (!(dt > 0)) continue;
        tot += dt; thr += g.throttle[i] * dt; if (g.throttle[i] > 0.95) wot += dt; if (g.brake[i] > 0.1) brk += dt;
        if (g.speed[i] > vmax) vmax = g.speed[i]; if (g.speed[i] < vmin) vmin = g.speed[i];
        if (g.latG && Math.abs(g.latG[i]) > gl) gl = Math.abs(g.latG[i]); if (g.longG && -g.longG[i] > gb) gb = -g.longG[i];
      }
      out.push({ lap: l, vmax, vmin, thr: tot ? thr / tot : 0, wot: tot ? wot / tot : 0, brk: tot ? brk / tot : 0, gl, gb,
        fuel: g.fuel ? g.fuel[0] - g.fuel[g.n - 1] : null });
    }
    session._lapStats = out;
    return out;
  }

  function renderTables() {
    const s = A().active(), p = pair();
    if (!s) return view().appendChild(empty('Telemetry tables', 'Load a telemetry file to see lap, corner and sample tables. Every table can be saved as CSV.'));
    const which = ui().table || 'laps';
    const tabs = [['laps', 'Laps'], ['corners', 'Corners'], ['samples', 'Samples along the lap'], ['car', 'Tyres, brakes and ride height']];
    let cols = [], rows = [], note = '', extra = null, csvName = which;
    const sp = (v) => (U.isNum(v) && isFinite(v) ? A().speed(v).toFixed(1) : '');
    if (which === 'laps') {
      const best = s.bestLap ? s.bestLap.time : null;
      cols = [{ key: 'n', label: 'Lap', num: true }, { key: 'time', label: 'Time', num: true }, { key: 'gap', label: 'Gap to best', num: true },
        { key: 's1', label: 'Sector 1', num: true }, { key: 's2', label: 'Sector 2', num: true }, { key: 's3', label: 'Sector 3', num: true },
        { key: 'vmax', label: 'Top ' + A().speedUnit(), num: true }, { key: 'vmin', label: 'Slowest', num: true }, { key: 'wot', label: 'Full throttle %', num: true },
        { key: 'brk', label: 'Braking %', num: true }, { key: 'gl', label: 'Peak lateral g', num: true }, { key: 'gb', label: 'Peak braking g', num: true },
        { key: 'fuel', label: 'Fuel used', num: true }, { key: 'status', label: 'Status' }];
      rows = lapStats(s).map((r) => {
        const l = r.lap;
        return { n: l.num, time: l.complete ? U.fmtLap(l.time) : '–', gap: l.complete && l.valid && best != null ? (l.time === best ? 'best' : U.fmtDelta(l.time - best)) : '',
          s1: l.s1 ? l.s1.toFixed(3) : '', s2: l.s2 ? l.s2.toFixed(3) : '', s3: l.s3 ? l.s3.toFixed(3) : '',
          vmax: sp(r.vmax), vmin: sp(r.vmin), wot: r.wot != null ? (r.wot * 100).toFixed(0) : '', brk: r.brk != null ? (r.brk * 100).toFixed(0) : '',
          gl: r.gl ? r.gl.toFixed(2) : '', gb: r.gb ? r.gb.toFixed(2) : '', fuel: U.isNum(r.fuel) ? r.fuel.toFixed(2) : '',
          status: !l.complete ? (l.note || 'partial') : l.pit ? 'pit lane' : !l.valid ? (l.note || 'not counted') : (l.note || 'timed'),
          _cls: s.bestLap && l.idx === s.bestLap.idx ? 'mark' : !l.complete || !l.valid ? 'dim' : '' };
      });
      note = s.meta.sim === 'iracing' ? 'iRacing does not write sector times to the telemetry file, so the sector columns are empty for iRacing sessions.' : '';
    } else if (which === 'corners') {
      if (!p || !p.corners.length) note = 'Corners need at least one complete lap in the reference lap\'s session.';
      else {
        const add = (k, label) => [{ key: 'a' + k, label: p.a.letter + ' ' + label, num: true }].concat(p.b ? [{ key: 'b' + k, label: p.b.letter + ' ' + label, num: true }] : []);
        cols = [{ key: 'name', label: 'Corner' }, { key: 'dir', label: 'Turn' }, { key: 'band', label: 'Type' }, { key: 'from', label: 'From m', num: true }, { key: 'to', label: 'To m', num: true }]
          .concat(add('In', 'entry ' + A().speedUnit()), add('Min', 'min'), add('Out', 'exit'), add('G', 'peak g'), add('Brk', 'brake point m'), add('Thr', 'full throttle at m'), add('T', 'time s'), p.b ? [{ key: 'dT', label: p.b.letter + ' − ' + p.a.letter + ' s', num: true }] : []);
        rows = cornerRows(p).map((r) => {
          const o = { name: r.c.name, dir: r.c.dir === 'L' ? 'Left' : 'Right', band: r.c.band === 'low' ? 'slow' : r.c.band === 'high' ? 'fast' : 'medium', from: Math.round(r.c.dStart), to: Math.round(r.c.dEnd) };
          for (const [k, st] of [['a', r.sa], ['b', r.sb]]) {
            if (!st) continue;
            o[k + 'In'] = sp(st.entry); o[k + 'Min'] = sp(st.min); o[k + 'Out'] = sp(st.exit); o[k + 'G'] = st.peakG.toFixed(2);
            o[k + 'Brk'] = st.brakeAt == null ? '' : Math.round(st.brakeAt); o[k + 'Thr'] = st.throttleAt == null ? '' : Math.round(st.throttleAt); o[k + 'T'] = st.time.toFixed(3);
          }
          if (r.sb) o.dT = U.fmtDelta(r.sb.time - r.sa.time);
          return o;
        });
      }
    } else if (which === 'samples') {
      if (!p) note = 'Add a lap to the overlay to list its samples.';
      else {
        const stepM = ui().sampleStep || 25, g = p.a.grid, every = Math.max(1, Math.round(stepM / g.step));
        extra = h('label', { class: 'mini' }, ['One row every ', h('select', { onchange: (ev) => { ui().sampleStep = +ev.target.value; render(); } }, [5, 10, 25, 50, 100].map((v) => h('option', { value: v, selected: v === stepM, text: v + ' m' })))]);
        const chans = [['speed', 'Speed ' + A().speedUnit(), (v) => sp(v)], ['throttle', 'Throttle %', (v) => U.fmt(v * 100, 0)], ['brake', 'Brake %', (v) => U.fmt(v * 100, 0)],
          ['steer', 'Steering', (v) => U.fmt(v, 1)], ['gear', 'Gear', (v) => U.fmt(v, 0)], ['rpm', 'RPM', (v) => U.fmt(v, 0)], ['latG', 'Lat g', (v) => U.fmt(v, 2)], ['longG', 'Long g', (v) => U.fmt(v, 2)]].filter((c) => g[c[0]]);
        const LA = p.a.letter, LB = p.b ? p.b.letter : '';
        cols = [{ key: 'd', label: 'Distance m', num: true }, { key: 'c', label: 'Corner' }, { key: 'ta', label: LA + ' time s', num: true }];
        for (const c of chans) cols.push({ key: 'a' + c[0], label: LA + ' ' + c[1], num: true });
        if (p.b) { cols.push({ key: 'dt', label: LB + ' − ' + LA + ' s', num: true }); for (const c of chans) cols.push({ key: 'b' + c[0], label: LB + ' ' + c[1], num: true }); }
        const bArr = {}; if (p.b) for (const c of chans) bArr[c[0]] = p.onA(c[0]);
        for (let i = 0; i < g.n; i += every) {
          const cn = p.corners.find((c) => i >= c.a && i <= c.b);
          const o = { d: Math.round(g.d[i]), c: cn ? cn.name : '', ta: U.fmt(g.t[i], 3) };
          for (const c of chans) { o['a' + c[0]] = c[2](g[c[0]][i]); if (p.b && bArr[c[0]]) o['b' + c[0]] = c[2](bArr[c[0]][i]); }
          if (p.b) o.dt = U.fmtDelta(p.delta[i]);
          rows.push(o);
        }
        csvName = 'samples-' + stepM + 'm';
      }
    } else {
      const { an } = A().analysisFor(s);
      cols = [{ key: 'k', label: 'Reading' }, { key: 'FL', label: 'Front left', num: true }, { key: 'FR', label: 'Front right', num: true }, { key: 'RL', label: 'Rear left', num: true }, { key: 'RR', label: 'Rear right', num: true }];
      const four = (label, f) => { const o = { k: label }; STA.WHEELS.forEach((w, i) => { o[w] = f(i); }); return o; };
      if (an.tyres) {
        const t = an.tyres.rows;
        rows.push(four('Tyre inner edge, °C', (i) => U.fmt(t[i].inner, 0)), four('Tyre middle, °C', (i) => U.fmt(t[i].mid, 0)), four('Tyre outer edge, °C', (i) => U.fmt(t[i].outer, 0)),
          four('Inner minus outer, °C', (i) => U.fmtDelta(t[i].spread, 0)));
        if (t[0].press != null) rows.push(four('Hot pressure, kPa', (i) => U.fmt(t[i].press, 1)));
        note = an.tyres.note;
      }
      if (an.brakes) rows.push(four('Peak brake temperature, °C', (i) => U.fmt(an.brakes.peak[i], 0)));
      if (an.ride) rows.push({ k: 'Lowest ride height above 72 km/h, mm', FL: U.fmt(an.ride.frontMinMm, 1), FR: '(front axle)', RL: U.fmt(an.ride.rearMinMm, 1), RR: '(rear axle)' });
      if (!rows.length) note = 'This file has no tyre, brake or ride-height channels.';
      else note = 'From laps ' + an.lapNums.join(', ') + '. ' + note;
    }
    view().appendChild(h('section', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [
        h('div', { class: 'seg', role: 'tablist' }, tabs.map(([v, t]) => h('button', { class: 'seg-btn' + (v === which ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': v === which ? 'true' : 'false', text: t, onclick: () => { ui().table = v; render(); } }))),
        h('div', { class: 'tools' }, [extra, rows.length ? h('button', { class: 'btn ghost', type: 'button', text: 'Save table as CSV', onclick: () => download(csvName + '.csv', U.csv([cols.map((c) => c.label)].concat(rows.map((r) => cols.map((c) => r[c.key]))))) }) : null]),
      ]),
      rows.length ? table(cols, rows, { tall: true }) : null,
      note ? h('p', { class: 'hint', text: note }) : null,
      p && p.laps.length > 2 && (which === 'corners' || which === 'samples') ? h('p', { class: 'hint', text: 'This table shows the reference lap ' + p.a.letter + ' and lap ' + p.b.letter + '. The other ' + (p.laps.length - 2) + ' overlaid laps are in the Lap comparison traces and its corner table.' }) : null,
    ]));
  }

  /* ---------- Library: watched folders, sorted by sim, car and track ---------- */

  function renderLibrary() {
    const st = A().state, L = st.lib, F = STA.folders;
    const tree = F.tree(L.entries, st.summaries), combos = [];
    for (const sim of tree) for (const car of sim.cars) for (const t of car.tracks) combos.push(t);
    const runsText = (t) => t.runs.length + (t.runs.length === 1 ? ' run' : ' runs') + (t.unopened ? ', ' + t.unopened + ' new' : '');
    const openKeys = new Set(st.sessions.map((s) => s.meta.fileKey).filter(Boolean));

    if (!L.folders.length) {
      view().appendChild(h('div', { class: 'blank' }, [
        h('h2', { text: 'Add your telemetry folders' }),
        h('p', { text: 'Point the app at the folders the sims record into. It sorts every run by sim, car and track, finds new runs by itself, and reopens a car and track the way you left it.' }),
        h('p', { class: 'hint', text: 'iRacing: Documents\\iRacing\\telemetry. Le Mans Ultimate: the game\'s UserData\\Telemetry folder. Nothing is copied or uploaded.' }),
        h('div', { class: 'actions centre' }, [h('button', { class: 'btn', type: 'button', text: 'Add a telemetry folder', onclick: () => A().addFolder() })]),
        F.supported() ? null : h('p', { class: 'hint', text: 'This browser can read a folder for one visit only. Chrome and Edge can remember it.' }),
      ]));
      return;
    }

    /* where you left off */
    const last = combos.find((t) => t.key === F.resume.last());
    if (last) {
      const saved = F.resume.get(last.key) || {};
      view().appendChild(h('section', { class: 'panel resume' }, [
        h('div', {}, [
          h('h2', { text: 'Pick up where you left off' }),
          h('p', { class: 'resume-what' }, [A().simName(last.sim) + ' · ', h('b', { text: last.car }), ' · ', h('b', { text: last.track })]),
          h('p', { class: 'hint', text: runsText(last) + (last.best ? ' · best ' + U.fmtLap(last.best) : '') + (saved.at ? ' · last open ' + A().whenText(saved.at) : '') }),
        ]),
        h('button', { class: 'btn', type: 'button', text: 'Continue', onclick: () => A().openCombo(last.key) }),
      ]));
    }

    /* sim > car > track */
    if (!combos.length) view().appendChild(h('section', { class: 'panel' }, [h('p', { class: 'empty', text: L.busy ? 'Indexing the folder…' : 'No recordings found in the folders below yet.' })]));
    for (const sim of tree) {
      view().appendChild(h('section', { class: 'panel' }, [
        h('h2', { text: A().simName(sim.sim) }),
      ].concat(sim.cars.map((car) => h('div', { class: 'libcar' }, [
        h('h3', {}, [car.car, car.carClass ? h('span', { class: 'tag', text: car.carClass }) : null]),
      ].concat(car.tracks.map((t) => {
        const open = ui().libOpen === t.key;
        return h('div', { class: 'combo' + (open ? ' open' : '') }, [
          h('div', { class: 'combo-row' }, [
            h('span', { class: 'combo-track', text: t.track }),
            h('span', { class: 'combo-meta', text: runsText(t) }),
            h('span', { class: 'combo-meta', text: 'last ' + A().whenText(t.last) }),
            h('span', { class: 'combo-best num', text: t.best ? U.fmtLap(t.best) : '–' }),
            h('span', { class: 'combo-acts' }, [
              h('button', { class: 'link', type: 'button', text: open ? 'Hide runs' : 'Runs', 'aria-expanded': open ? 'true' : 'false', onclick: () => { ui().libOpen = open ? null : t.key; render(); } }),
              h('button', { class: 'btn small', type: 'button', text: 'Open', 'aria-label': 'Open ' + car.car + ' at ' + t.track, onclick: () => A().openCombo(t.key) }),
            ]),
          ]),
          open ? h('div', { class: 'combo-runs' }, t.runs.map((e) => h('div', { class: 'run-row' }, [
            h('span', { class: 'num', text: A().whenText(e.recordedAt) }),
            h('span', { class: 'run-file', text: (e.setupName ? e.setupName + ' · ' : '') + e.name, title: e.path }),
            h('span', { class: 'combo-meta', text: openKeys.has(e.id) ? 'open now' : e.sessionId ? '' : 'new' }),
            h('span', { class: 'combo-best num', text: e.bestLap ? U.fmtLap(e.bestLap) : '–' }),
            h('button', { class: 'link', type: 'button', text: 'Open this run', onclick: () => A().openCombo(t.key, e.id) }),
          ]))) : null,
        ]);
      })))))));
    }

    /* folders */
    const state = { ready: '', locked: 'needs your OK to be read again', offline: 'picked for one visit: pick it again to open its files' };
    const count = (id) => L.entries.filter((e) => e.folderId === id && e.kind === 'run' && !e.error).length;
    const bad = L.entries.filter((e) => e.error);
    view().appendChild(h('section', { class: 'panel' }, [
      h('h2', { text: 'Folders' }),
      h('ul', { class: 'plain folders' }, L.folders.map((f) => h('li', {}, [
        h('b', { text: f.name }), ' · ' + count(f.id) + ' recordings' + (f.lastScan ? ' · checked ' + A().whenText(f.lastScan) : '') + (state[f.state] ? ' · ' + state[f.state] : '') + ' ',
        f.state === 'offline' ? h('button', { class: 'link', type: 'button', text: 'Pick it again', onclick: () => A().addFolder() })
          : h('button', { class: 'link', type: 'button', text: f.state === 'locked' ? 'Allow and rescan' : 'Rescan', onclick: () => A().scanLib(true, f.id) }),
        ' ', h('button', { class: 'link', type: 'button', text: 'Remove', 'aria-label': 'Remove folder ' + f.name, title: 'Stops watching this folder. Your files, setups and session history are not touched.', onclick: () => A().removeFolder(f.id) }),
      ]))),
      h('div', { class: 'actions' }, [h('button', { class: 'btn ghost', type: 'button', text: 'Add another folder', onclick: () => A().addFolder() })]),
      h('p', { class: 'hint', text: 'New recordings are picked up when you open the app or come back to its window. ' + (F.supported() ? 'After a browser restart, it may ask once to read a folder again.' : 'This browser can read a folder for one visit only; Chrome and Edge can remember it.') }),
      bad.length ? more('lib-bad', bad.length + (bad.length === 1 ? ' file could not be read' : ' files could not be read'), [h('ul', { class: 'plain' }, bad.slice(0, 30).map((e) => h('li', {}, [h('b', { text: e.name + ': ' }), e.error])))]) : null,
    ]));
  }

  /* ---------- Setup advice ---------- */

  /* A collapsed block that remembers whether it is open across re-renders. */
  function more(key, summary, children) {
    const open = ui().open || (ui().open = {});
    return h('details', { class: 'more', open: !!open[key], ontoggle: (ev) => { open[key] = ev.target.open; } }, [h('summary', { text: summary })].concat(children));
  }
  const lower = (t) => String(t || '').replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase());

  function renderAdvice() {
    const s = A().active();
    if (!s) return view().appendChild(empty('Setup advice', 'Load a telemetry file to get setup changes for the setup that was on the car.'));
    if (!s.refLap) return view().appendChild(empty('No complete lap', 'Setup advice needs at least one complete lap.'));
    const { an, adv } = A().analysisFor(s), sim = s.meta.sim, car = s.meta.car;
    const checked = ui().adviceChecked && ui().adviceFor === s.id ? ui().adviceChecked : (ui().adviceFor = s.id, ui().adviceChecked = Object.fromEntries(adv.suggestions.filter((x) => x.primary).slice(0, 2).map((x) => [x.key, true])));
    const again = () => { ui().contestOpen = null; ui().adviceChecked = null; render(); };

    /* --- the changes, first --- */
    const list = h('div', { class: 'suggestions' }), blockedList = STA.library.blocked.list(sim, car);
    if (!s.setup) list.appendChild(h('p', { class: 'empty', text: 'No setup in this file, so only findings are shown.' }));
    else if (!adv.suggestions.length) list.appendChild(h('p', { class: 'empty', text: an.findings.length ? 'No setup change is available for these findings on this car.' : 'No changes suggested. Keep this setup.' }));
    adv.suggestions.forEach((x) => {
      const tags = [];
      if (x.alternativeTo) tags.push(['warn', 'Instead of: ' + x.alternativeTo.join('; ')]);
      else if (x.insteadOf) tags.push(['warn', 'Instead of: ' + x.insteadOf]);
      if (x.learned) tags.push(['good', 'Learned on this car']);
      if (x.bigger) tags.push(['warn', 'Bigger step: one was too small last time']);
      if (x.historyText) tags.push([x.demoted ? 'bad' : 'good', x.historyText]);
      if (x.conflict) tags.push(['warn', 'Works against: ' + x.conflict.join('; ')]);
      const openMenu = ui().contestOpen === x.blockKey;
      list.appendChild(h('article', { class: 'suggestion' }, [
        h('label', { class: 'check big' }, [h('input', { type: 'checkbox', checked: !!checked[x.key], 'aria-label': 'Include: ' + x.title, onchange: (ev) => { checked[x.key] = ev.target.checked; } }), h('span', { class: 'rank num', text: String(x.rank) })]),
        h('div', { class: 'suggestion-body' }, [
          h('h3', {}, [x.title, x.amount ? h('span', { class: 'amount', text: ' · ' + x.amount }) : null]),
          h('p', { class: 'why' }, ['Now ', h('b', { text: x.current }), x.fix ? ' · ' + x.effect : (x.targetKey === 'pace' ? ' · For: ' : ' · Fixes: ') + x.reasons.map(lower).join('; ') + (x.cost ? ' · Cost: ' + lower(x.cost) : '')]),
          tags.length ? h('p', { class: 'tags' }, tags.map(([cls, text]) => h('span', { class: 'tag ' + cls, text }))) : null,
          x.fix ? null : more('why-' + x.blockKey, 'How it works', [h('p', { text: x.effect })]),
        ]),
        h('div', { class: 'suggestion-side' }, [confTag(x.confidence),
          x.fix ? null : h('button', { class: 'link', type: 'button', text: 'Contest this change', 'aria-expanded': openMenu ? 'true' : 'false',
            title: 'Take this change out and get the next way to the same effect',
            onclick: () => { ui().contestOpen = openMenu ? null : x.blockKey; render(); } }),
          !x.fix && openMenu ? h('div', { class: 'contest', role: 'group', 'aria-label': 'Why are you contesting this change?' },
            Object.keys(STA.advisor.CONTEST).map((reason) => h('button', { class: 'btn ghost small', type: 'button', text: STA.advisor.CONTEST[reason].label, onclick: () => { STA.library.contested.add(sim, car, x.blockKey, reason); again(); } }))
              .concat([h('button', { class: 'btn ghost small', type: 'button', text: 'Not possible on this car', title: 'Records that this setting cannot go further than its current value on this car',
                onclick: () => {
                  // Remember the current value as the limit in this direction, so the change is offered again if the value later moves away from it.
                  for (const p of s.setup.params) {
                    if (x.paramIds.indexOf(p.id) < 0) continue;
                    STA.library.limits.add(sim, car, { paramId: p.id, dir: x.dir, num: U.isNum(p.num) ? p.num : null, raw: p.raw, label: p.section + ' / ' + p.label });
                  }
                  again();
                } })])) : null]),
      ]));
    });
    const nameIn = h('input', { type: 'text', class: 'text', value: (s.setup ? s.setup.name : 'Setup') + ' – revised', 'aria-label': 'Name for the revised setup' });
    const nOut = adv.skipped.reduce((n, k) => n + k.items.length, 0);
    view().appendChild(h('section', { class: 'panel' }, [
      h('h2', { text: 'Changes to make' }),
      h('p', { class: 'hint', text: (an.lapNums.length === 1 ? 'Lap ' : 'Laps ') + an.lapNums.join(', ') + ' · ' + car + ' at ' + s.trackName + '. Try the ticked ones, drive 3–5 laps, reload.' }),
      list,
      adv.exhausted && adv.exhausted.length ? h('div', { class: 'skipped' }, [h('h3', { text: 'No setup route left: drive around it' }),
        h('ul', { class: 'plain' }, adv.exhausted.map((e) => h('li', {}, [h('b', { text: e.finding + ': ' }), e.tips.length ? e.tips.slice(0, 2).join(' ') : 'allow one of the contested changes again.']))),
        h('button', { class: 'link', type: 'button', text: 'Open driving technique', onclick: () => { A().state.tab = 'technique'; A().renderAll(); } })]) : null,
      s.setup && adv.suggestions.length ? h('div', { class: 'actions' }, [nameIn, h('button', { class: 'btn', type: 'button', text: 'Save ticked changes as a new setup', onclick: async () => {
        const picked = adv.suggestions.filter((x) => checked[x.key]);
        if (!picked.length) return A().say('warn', 'Tick at least one change first.');
        const prop = STA.advisor.proposeSetup(s.setup, picked, nameIn.value.trim() || undefined);
        prop.car = s.setup.car; prop.track = s.setup.track; prop.carClass = s.setup.carClass;
        await STA.library.saveSetup(prop, { userNamed: true });
        await A().refreshLibrary();
        ui().diffIds = [s.setup.id, prop.id]; A().state.tab = 'setups';
        A().say('ok', 'Saved "' + prop.name + '". It is shown next to the setup you drove.');
        A().renderAll();
      } })]) : null,
      contestedList(sim, car, again),
      blockedList.length ? h('div', { class: 'skipped' }, [h('h3', { text: 'Marked not possible' }),
        h('ul', { class: 'plain' }, blockedList.map((key) => { const [role, axle, dir] = key.split('|'); return h('li', {}, [STA.advisor.titleFor(role, dir, axle || null) + ' ',
          h('button', { class: 'link', type: 'button', text: 'Allow again', onclick: () => { STA.library.blocked.remove(sim, car, key); again(); } })]); }))]) : null,
      nOut ? more('skipped', 'Not offered (' + nOut + ')', [h('ul', { class: 'plain' }, adv.skipped.map((k) => h('li', {}, [h('b', { text: k.finding + ': ' }), k.items.join('; ') + '.'])))]) : null,
    ]));

    /* --- why: what the telemetry shows --- */
    const B = STA.handling;
    let balance = null;
    if (an.balance) {
      const word = (v) => (v >= 0.25 ? 'understeer ' : v <= -0.10 ? 'oversteer ' : '');
      const pct = (v) => { const r = Math.round(v * 100); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r) + '%'; };
      const cell = (m) => (m.idx == null ? '–' : word(m.idx) + pct(m.idx));
      const cls = (m) => (m.idx == null ? '' : m.idx >= 0.25 ? 'us' : m.idx <= -0.10 ? 'os' : '');
      const M = an.balance.matrix;
      const rows = B.PHASES.map((ph) => ({ ph: B.PHASE_TEXT[ph], low: cell(M[ph].low), medium: cell(M[ph].medium), high: cell(M[ph].high), all: cell(M[ph].all),
        _cell: { low: cls(M[ph].low), medium: cls(M[ph].medium), high: cls(M[ph].high), all: cls(M[ph].all) } }));
      balance = more('balance', 'Balance by corner phase and speed', [
        table([{ key: 'ph', label: 'Phase' }, { key: 'low', label: 'Slow (' + B.BAND_RANGE.low + ')' }, { key: 'medium', label: 'Medium (' + B.BAND_RANGE.medium + ')' }, { key: 'high', label: 'Fast (' + B.BAND_RANGE.high + ')' }, { key: 'all', label: 'All' }], rows, { cls: 'balance' }),
        h('p', { class: 'hint', text: 'Steering held at the limit against what the car needs. Above +25% is understeer, below −10% is oversteer.' }),
      ]);
    }
    // Only shown when there is an earlier session to compare with.
    const review = reviewPanel(s), learnt = learnedPanel(s);
    if (review) view().appendChild(review);
    if (learnt) view().appendChild(learnt);

    view().appendChild(h('section', { class: 'panel' }, [
      h('h2', { text: 'What the telemetry shows' }),
      an.findings.length ? h('div', { class: 'findings compact' }, an.findings.map((f) => h('article', { class: 'finding' }, [
        h('div', { class: 'finding-head' }, [h('h3', { text: f.title }), confTag(f.confidence)]),
        h('p', {}, [f.detail + ' ', h('span', { class: 'evidence', text: f.evidence })]),
      ]))) : h('p', { class: 'empty', text: 'Nothing stands out in these laps.' }),
      an.notes.length ? h('ul', { class: 'notes' }, an.notes.map((n) => h('li', { text: n }))) : null,
      balance,
    ]));

    if (s.setup) view().appendChild(limitsPanel(s, adv));
  }

  /* Changes the driver has contested on this car, each with a way to allow it again. */
  function contestedList(sim, car, again) {
    const list = STA.library.contested.list(sim, car);
    if (!list.length) return null;
    return h('div', { class: 'skipped' }, [h('h3', { text: 'Contested (this car, every track)' }),
      h('ul', { class: 'plain' }, list.map((e) => { const [role, axle, dir] = e.contest.split('|'); return h('li', {}, [h('b', { text: STA.advisor.titleFor(role, dir, axle || null) + ': ' }), STA.advisor.contestText(e) + ' ',
        h('button', { class: 'link', type: 'button', text: 'Allow again', onclick: () => { STA.library.contested.remove(sim, car, e.contest); again(); } })]); }))]);
  }

  /* Did the change made before this session do what it was meant to?
     Each change is treated as an experiment: why it was made, what happened, and what the app now thinks. */
  function reviewPanel(s) {
    const st = A().state, R = STA.library.reasons, rv = STA.learning.review(st.summaries, st.setups, s, R.all());
    const head = h('h2', { text: 'Did the last change work?' });
    if (!rv || rv.first) return null;
    const laps = (b, a) => 'Typical lap ' + U.fmtLap(b.medianLap || b.bestLap) + ' → ' + U.fmtLap(a.medianLap || a.bestLap);
    if (rv.sameSetup) return h('section', { class: 'panel' }, [head, h('p', { class: 'hint', text: 'Same setup as the run before (' + A().whenText(rv.before.recordedAt) + '). ' + laps(rv.before, rv.after) + '.' })]);
    const verdict = { helped: 'Helped', none: 'No clear difference', hurt: 'Worse' };
    const again = () => { A().state.analysis.delete(s.id); ui().adviceChecked = null; render(); };
    const rows = rv.changes.map((c) => {
      const inferred = c.why === 'pace' ? 'App\'s reading: ' + lower(c.purpose) : c.why === 'app' ? 'App\'s reading: ' + c.targets.map((t) => lower(t.title)).join('; ') : 'Not known: what was it for?';
      // Lap time where the change acts comes first; then top speed for wing changes; then the handling problem.
      const got = [];
      if (c.time) got.push(h('b', { text: STA.pace.secs(c.time.net) }), ' where it acts' + (c.time.parts.some((p) => Math.abs(p.d) >= 0.01) ? ': ' + c.time.text : ''));
      if (c.top && Math.abs(A().speed(c.top.d)) >= 0.5) got.push((got.length ? '. ' : '') + 'Top speed ' + (c.top.d > 0 ? '+' : '−') + Math.abs(A().speed(c.top.d)).toFixed(0) + ' ' + A().speedUnit());
      const probs = c.targets.filter((t) => t.kind !== 'pace');
      if (probs.length) got.push((got.length ? '. ' : '') + probs.map((t) => lower(t.title) + ' ' + t.text).join('; '));
      return {
        change: h('span', {}, [c.title, h('span', { class: 'evidence', text: ' ' + c.from + ' → ' + c.to })]),
        why: h('select', { class: 'mini', 'aria-label': 'What was this change for? ' + c.title, onchange: (ev) => { R.set(rv.after.id, c.key, { target: ev.target.value || null }); again(); } },
          [h('option', { value: '', selected: !c.note.target, text: inferred })].concat(rv.choices.map((o) => h('option', { value: o.value, selected: c.note.target === o.value, text: o.label })))),
        got: got.length ? h('span', {}, got) : '–',
        verdict: h('span', {}, [h('span', { class: 'verdict ' + c.verdict, text: c.overshot && c.verdict === 'helped' ? 'Helped, too far' : verdict[c.verdict] }),
          h('select', { class: 'mini', 'aria-label': 'Your own verdict on: ' + c.title, title: 'Overrule the telemetry if you felt otherwise', onchange: (ev) => { R.set(rv.after.id, c.key, { verdict: ev.target.value || null }); again(); } },
            [['', 'Telemetry\'s call'], ['helped', 'I say: helped'], ['none', 'I say: no difference'], ['hurt', 'I say: worse']].map(([v, t]) => h('option', { value: v, selected: (c.note.verdict || '') === v, text: t })))]),
        think: c.rethink,
      };
    });
    const unknown = rv.changes.filter((c) => c.why === 'unknown').length;
    const drive = rv.changes.filter((c) => c.targets.length && c.verdict !== 'helped' && (c.cause === 'driver' || c.cause === 'noLever'));
    const lap = rv.lap, lapWord = lap.rel == null ? '' : lap.word === 'same' ? ' (no real change)' : ' (' + Math.abs(lap.rel * 100).toFixed(2) + '% ' + lap.word + ')';
    const titleOf = (key) => { const c = rv.changes.find((x) => x.key === key); return c ? lower(c.title) : key; };
    return h('section', { class: 'panel' }, [
      head,
      h('p', { class: 'hint', text: 'Against the run before (' + A().whenText(rv.before.recordedAt) + ', "' + rv.setupBefore.name + '"). ' + laps(rv.before, rv.after) + lapWord + '.' }),
      rv.pace ? h('p', { class: 'moved' }, [h('b', { text: 'Where the best lap moved: ' }),
        U.fmtLap(rv.pace.lapBefore) + ' → ' + U.fmtLap(rv.pace.lapAfter) + ' (' + STA.pace.secs(rv.pace.lap) + '). ' +
        (STA.pace.ZONES.filter((z) => Math.abs(rv.pace.zones[z]) >= 0.01).sort((a, b) => Math.abs(rv.pace.zones[b]) - Math.abs(rv.pace.zones[a])).map((z) => STA.pace.ZONE_TEXT[z] + ' ' + STA.pace.secs(rv.pace.zones[z])).join(', ') || 'No zone moved by a hundredth') +
        '. Top speed ' + A().speed(rv.pace.top.before).toFixed(0) + ' → ' + A().speed(rv.pace.top.after).toFixed(0) + ' ' + A().speedUnit() + '.']) : null,
      unknown ? h('p', { class: 'instead', text: unknown + (unknown === 1 ? ' change has' : ' changes have') + ' no reason on record. Say what ' + (unknown === 1 ? 'it was' : 'each was') + ' for under "Why" and the app will judge it against that.' }) : null,
      rows.length ? table([{ key: 'change', label: 'Changed' }, { key: 'why', label: 'Why' }, { key: 'got', label: 'Lap time and effect' }, { key: 'verdict', label: 'Result' }, { key: 'think', label: 'What the app makes of it' }], rows, { cls: 'review' })
        : h('p', { class: 'empty', text: 'Only settings the app does not judge changed (fuel, gearing, cooling).' }),
      rv.bonus.length ? h('ul', { class: 'plain gains' }, rv.bonus.map((b) => h('li', {}, [h('b', { text: 'Unexpected gain: ' }), lower(b.title) + ' ' + b.text + ', with nothing aimed at it. Credited to ' + b.credit.map(titleOf).join('; ') + '. ' +
        (b.credit.length === 1 ? 'Now offered for this problem on this car.' : 'Shared between ' + b.credit.length + ' changes, so it needs a second run to count.')]))) : null,
      drive.length ? h('div', { class: 'skipped' }, [
        h('h3', { text: 'Try from the seat' }),
        h('ul', { class: 'plain' }, drive.map((c) => h('li', {}, [h('b', { text: c.targets[0].title + ': ' }), STA.technique.forTargets(c.targets).slice(0, 2).join(' ')]))),
        h('button', { class: 'link', type: 'button', text: 'Open driving technique', onclick: () => { st.tab = 'technique'; A().renderAll(); } }),
      ]) : null,
      h('p', { class: 'hint', text: (rv.changes.length > 1 ? rv.changes.length + ' changes at once, so the result is shared between them. ' : '') + (lap.noisy ? 'Lap times in these runs vary a lot, which weakens this. ' : '') + 'One comparison is weak evidence.' }),
    ]);
  }

  /* What the before-and-after runs have taught the app about this car. */
  function learnedPanel(s) {
    const know = A().analysisFor(s).know;
    if (!know || !know.relay.length) return null;
    return h('section', { class: 'panel' }, [
      h('h2', { text: 'What your runs have taught the app about this car' }),
      h('ul', { class: 'plain learned' }, know.relay.slice(0, 8).map((r) => h('li', { class: r.kind }, [r.text + (r.top && Math.abs(A().speed(r.top.d)) >= 0.5 ? ' Top speed ' + (r.top.d > 0 ? '+' : '−') + Math.abs(A().speed(r.top.d)).toFixed(0) + ' ' + A().speedUnit() + '.' : '') + ' ', confTag(r.confidence)]))),
      know.relay.length > 8 ? more('learned-all', 'All ' + know.relay.length, [h('ul', { class: 'plain learned' }, know.relay.slice(8).map((r) => h('li', { class: r.kind }, [r.text + ' ', confTag(r.confidence)])))]) : null,
    ]);
  }

  /* Known limits for the car, and a way to add or correct one. Collapsed until wanted. */
  function limitsPanel(s, adv) {
    const sim = s.meta.sim, car = s.meta.car, mine = STA.library.limits.list(sim, car), f = ui().limitForm || (ui().limitForm = { dir: '+', value: '' });
    const again = () => { ui().adviceChecked = null; render(); };
    const groups = new Map();
    for (const p of s.setup.params) {
      const unit = p.unit ? ' ' + p.unit : '', bits = [];
      if (p.lo != null && p.loSrc !== 'set by you') bits.push('min ' + +p.lo.toFixed(2) + unit);
      if (p.hi != null && p.hiSrc !== 'set by you') bits.push('max ' + +p.hi.toFixed(2) + unit);
      if (!bits.length) continue;
      const label = p.role && STA.advisor.ROLE[p.role] ? STA.advisor.labelFor(p.role, p.axle) : p.label;
      const src = String((p.loSrc !== 'set by you' && p.loSrc) || p.hiSrc).replace(/^from the /, ''), key = label + '|' + bits.join(', ') + '|' + src;
      if (!groups.has(key)) groups.set(key, { label, text: bits.join(', '), src });
    }
    const choices = s.setup.params.filter((p) => p.adjustable && !p.derived && U.isNum(p.num));
    if (!f.id || !choices.some((p) => p.id === f.id)) f.id = (choices.find((p) => p.role === 'rideHeight') || choices[0] || {}).id;
    const add = () => {
      const v = parseFloat(f.value), p0 = choices.find((p) => p.id === f.id);
      if (!p0 || !U.isNum(v)) return A().say('warn', 'Enter the limit as a number.');
      // The same setting on the other side of the car gets the same limit.
      for (const p of choices) if (p === p0 || (p.role && p.role === p0.role && p.axle === p0.axle && p.label === p0.label && p.unit === p0.unit)) {
        STA.library.limits.add(sim, car, { paramId: p.id, dir: f.dir, num: v, raw: v + (p.unit ? ' ' + p.unit : ''), label: p.section + ' / ' + p.label });
      }
      f.value = ''; again();
    };
    const count = [groups.size ? groups.size + ' built in' : null, mine.length ? mine.length + ' yours' : null].filter(Boolean).join(', ') || 'none yet';
    return h('section', { class: 'panel' }, [more('limits', 'Limits for the ' + car + ' (' + count + ')', [
      sim === 'lmu' ? h('p', { class: 'hint', text: 'LMU recordings carry every setting\'s range, so the advice already stops at them. Add only rules the sim does not enforce.' })
        : adv.car ? h('p', { class: 'hint' }, ['From ', h('a', { href: adv.car.url, target: '_blank', rel: 'noopener', text: 'iRacing\'s manual for the ' + adv.car.name }), ' unless marked. A limit you add replaces the built-in one.'])
        : h('p', { class: 'hint', text: 'None built in for this car. Add the ones you know.' }),
      groups.size ? h('ul', { class: 'plain' }, Array.from(groups.values()).map((g) => h('li', {}, [h('b', { text: g.label + ': ' }), g.text + ' (' + g.src + ')']))) : null,
      mine.length ? h('ul', { class: 'plain' }, mine.map((e) => h('li', {}, [h('b', { text: e.label + ': ' }), (e.dir === '-' ? 'min ' : 'max ') + e.raw + ' (yours) ',
        h('button', { class: 'link', type: 'button', text: 'Remove limit', onclick: () => { STA.library.limits.remove(sim, car, e.paramId, e.dir); again(); } })]))) : null,
      choices.length ? h('div', { class: 'form' }, [
        h('label', { class: 'wide' }, ['Setting', h('select', { onchange: (ev) => { f.id = ev.target.value; } }, choices.map((p) => h('option', { value: p.id, selected: p.id === f.id, text: p.section + ' / ' + p.label + ' (now ' + p.raw + ')' })))]),
        h('label', {}, ['Rule', h('select', { onchange: (ev) => { f.dir = ev.target.value; } }, [h('option', { value: '+', selected: f.dir === '+', text: 'Cannot go above' }), h('option', { value: '-', selected: f.dir === '-', text: 'Cannot go below' })])]),
        h('label', {}, ['Value', h('input', { type: 'number', step: 'any', class: 'text', value: f.value, 'aria-label': 'Limit value', oninput: (ev) => { f.value = ev.target.value; }, onkeydown: (ev) => { if (ev.key === 'Enter') add(); } })]),
        h('button', { class: 'btn ghost', type: 'button', text: 'Add limit', onclick: add }),
      ]) : null,
    ])]);
  }

  /* ---------- Driving technique ---------- */

  function renderTechnique() {
    const s = A().active();
    if (!s) return view().appendChild(empty('Driving technique', 'Load a telemetry file to see where your own driving has time in it.'));
    if (!s.refLap) return view().appendChild(empty('No complete lap', 'Driving advice needs at least one complete lap.'));
    const { an } = A().analysisFor(s), tech = A().techFor(s);
    const item = (x) => h('article', { class: 'finding' }, [
      h('div', { class: 'finding-head' }, [h('h3', { text: x.title }), confTag(x.confidence)]),
      h('p', {}, [h('b', { text: 'Try: ' }), x.how + ' ', h('span', { class: 'evidence', text: x.detail })]),
    ]);
    view().appendChild(h('section', { class: 'panel' }, [
      h('h2', { text: 'Time in your own driving' }),
      tech.laps.length ? h('p', { class: 'hint', text: (tech.laps.length === 1 ? 'Lap ' : 'Laps ') + tech.laps.join(', ') + ', compared with each other.' }) : null,
      tech.items.length ? h('div', { class: 'findings compact' }, tech.items.map(item))
        : h('p', { class: 'empty', text: tech.laps.length < 2 ? 'One timed lap is not enough. Drive 3–5 clean laps.' : 'Nothing stands out: laps repeat and the pedal work is clean.' }),
      tech.notes.length ? h('ul', { class: 'notes' }, tech.notes.map((n) => h('li', { text: n }))) : null,
      tech.items.length ? more('measured', 'How these are measured', [h('ul', { class: 'plain' }, tech.items.map((x) => h('li', {}, [h('b', { text: x.title + ': ' }), x.evidence])))]) : null,
    ]));
    const withTips = an.findings.map((f) => ({ f, tips: STA.technique.forFinding(f) })).filter((x) => x.tips.length);
    view().appendChild(h('section', { class: 'panel' }, [
      h('h2', { text: 'Driving around the car' }),
      h('p', { class: 'hint', text: 'For when a setup change did not work, the setting is at its limit, or the setup is fixed.' }),
      withTips.length ? h('div', { class: 'findings compact' }, withTips.map(({ f, tips }) => {
        const seen = tech.items.filter((x) => x.relates === f.kind + '|' + f.phase);
        return h('article', { class: 'finding' }, [
          h('div', { class: 'finding-head' }, [h('h3', { text: f.title })]),
          h('ul', { class: 'plain' }, tips.map((t) => h('li', { text: t })).concat(seen.map((x) => h('li', {}, [h('b', { text: 'Seen in your laps: ' }), lower(x.title) + '.'])))),
        ]);
      })) : h('p', { class: 'empty', text: 'No handling problem found, so nothing to drive around.' }),
    ]));
  }

  /* ---------- Baseline setup ---------- */

  function renderBaseline() {
    const st = A().state, s = A().active(), b = ui().baseline || (ui().baseline = {});
    const all = st.setups;
    if (!all.length && !s) return view().appendChild(empty('Baseline setup', 'Load a telemetry file or a setup first. The app then checks whether you already have a setup in progress for that car and track before proposing a new starting point.'));
    if (!b.sim) { b.sim = s ? s.meta.sim : all[0].sim; b.car = s ? s.meta.car : all[0].car; b.track = s ? s.trackName : all[0].track; }
    const uniq = (arr) => Array.from(new Set(arr.filter(Boolean))).sort();
    const cars = uniq(all.filter((x) => x.sim === b.sim).map((x) => x.car).concat(st.sessions.filter((x) => x.meta.sim === b.sim).map((x) => x.meta.car)));
    const tracks = uniq(all.filter((x) => x.sim === b.sim).map((x) => x.track).concat(st.summaries.filter((x) => x.sim === b.sim).map((x) => x.track), st.sessions.filter((x) => x.meta.sim === b.sim).map((x) => x.trackName)));
    if (cars.length && cars.indexOf(b.car) < 0) b.car = cars[0];
    if (tracks.length && tracks.indexOf(b.track) < 0) b.track = tracks[0];
    const carClass = (all.find((x) => x.sim === b.sim && STA.library.sameCar(x.car, b.car)) || {}).carClass || (s && s.meta.car === b.car ? s.meta.carClass : '');
    const selEl = (val, opts, on) => h('select', { onchange: (ev) => { on(ev.target.value); b.result = null; b.forceNew = false; render(); } }, opts.map(([v, t]) => h('option', { value: v, selected: v === val, text: t })));

    view().appendChild(h('section', { class: 'panel' }, [
      h('h2', { text: 'Which car and track?' }),
      h('div', { class: 'form' }, [
        h('label', {}, ['Sim', selEl(b.sim, [['iracing', 'iRacing'], ['lmu', 'Le Mans Ultimate']], (v) => { b.sim = v; b.car = null; b.track = null; b.refId = null; })]),
        h('label', {}, ['Car', selEl(b.car, cars.map((c) => [c, c]), (v) => { b.car = v; b.refId = null; })]),
        h('label', {}, ['Track', selEl(b.track, tracks.map((c) => [c, c]), (v) => { b.track = v; })]),
      ]),
    ]));

    const q = { sim: b.sim, car: b.car, track: b.track, carClass };
    const prev = STA.baseline.findPrevious(all, q), rec = STA.baseline.recommend(prev);
    const setupLine = (x) => h('li', {}, [h('b', { text: x.name }), ' for ' + x.track + (x.usage && x.usage.lastUsed ? ', last used ' + A().dateText(x.usage.lastUsed) : '') + (x.usage && x.usage.bestLap ? ', best lap ' + U.fmtLap(x.usage.bestLap) : '') + (x.usage && x.usage.sessions.length ? ', ' + x.usage.sessions.length + (x.usage.sessions.length === 1 ? ' session' : ' sessions') : '')]);
    const prevPanel = h('section', { class: 'panel' + (rec.mode === 'continue' ? ' notice' : '') }, [
      h('h2', { text: 'Earlier work on this car' }),
      h('p', { class: 'lead', text: rec.text }),
      prev.sameCombo.length ? h('div', {}, [h('h3', { text: 'In progress at this track' }), h('ul', { class: 'plain' }, prev.sameCombo.slice(0, 5).map(setupLine))]) : null,
      prev.sameCar.length ? h('div', {}, [h('h3', { text: 'Same car at other tracks' }), h('ul', { class: 'plain' }, prev.sameCar.slice(0, 5).map(setupLine))]) : null,
      prev.sameClassTrack.length ? h('div', {}, [h('h3', { text: 'Other ' + carClass + ' cars at this track (check before reusing)' }), h('ul', { class: 'plain' }, prev.sameClassTrack.slice(0, 4).map(setupLine))]) : null,
      prev.simBaselines.length ? h('div', {}, [h('h3', { text: 'Sim baselines in the library' }), h('ul', { class: 'plain' }, prev.simBaselines.slice(0, 4).map(setupLine))]) : null,
      rec.mode === 'continue' ? h('div', { class: 'actions' }, [
        h('button', { class: 'btn', type: 'button', text: 'Continue with "' + rec.setup.name + '"', onclick: () => {
          ui().diffIds = [rec.setup.id].concat(prev.simBaselines[0] ? [prev.simBaselines[0].id] : prev.sameCombo[1] ? [prev.sameCombo[1].id] : []);
          st.tab = 'setups'; A().renderAll();
        } }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Build a new baseline anyway', onclick: () => { b.forceNew = true; render(); } }),
      ]) : null,
    ]);
    view().appendChild(prevPanel);
    if (rec.mode === 'continue' && !b.forceNew) return;
    if (rec.mode === 'none') {
      view().appendChild(h('section', { class: 'panel' }, [h('h2', { text: 'Nothing to build from yet' }),
        h('p', { text: b.sim === 'iracing' ? 'iRacing setup files (.sto) cannot be read directly, but every telemetry file carries the setup that was on the car. Drive a lap on the iRacing baseline setup with telemetry recording on, then drop that .ibt file here.' : 'Drop the default .svm for this car (from UserData\\player\\Settings\\<track>), or a telemetry file recorded on it.' })]));
      return;
    }

    const pool = all.filter((x) => x.sim === b.sim && STA.library.sameCar(x.car, b.car)).sort((x, y) => ((y.usage && y.usage.lastUsed) || y.createdAt || 0) - ((x.usage && x.usage.lastUsed) || x.createdAt || 0));
    const ordered = prev.simBaselines.concat(pool.filter((x) => prev.simBaselines.indexOf(x) < 0));
    if (!b.refId || !ordered.some((x) => x.id === b.refId)) b.refId = (rec.mode === 'adapt' ? rec.setup : ordered[0]).id;
    const ref = ordered.find((x) => x.id === b.refId);
    const profSrc = st.sessions.find((x) => x.meta.sim === b.sim && STA.library.sameTrack(x.trackName, b.track) && x.profile) || st.summaries.filter((x) => x.sim === b.sim && STA.library.sameTrack(x.track, b.track) && x.profile).sort((x, y) => y.recordedAt - x.recordedAt)[0];
    const profile = profSrc ? profSrc.profile : null;
    b.pref = b.pref || { downforce: 'auto', surface: 'auto', corners: 'auto', balance: 'neutral' };
    const prefSel = (key, opts) => h('select', { onchange: (ev) => { b.pref[key] = ev.target.value; b.result = null; render(); } }, opts.map(([v, t]) => h('option', { value: v, selected: b.pref[key] === v, text: t })));
    const tnd = STA.baseline.tendencies(st.summaries, q);
    const reading = STA.baseline.readTrack(profile, b.pref);

    const buildNow = () => {
      b.result = STA.baseline.build(ref, { profile, pref: b.pref, tendencies: tnd, track: b.track, name: 'App baseline – ' + b.track, blocked: STA.library.blocked.set(b.sim, b.car), limits: STA.library.limits.map(b.sim, b.car), contested: STA.library.contested.map(b.sim, b.car) });
      b.result.setup.car = b.car; b.result.setup.carClass = ref.carClass; render();
    };

    view().appendChild(h('section', { class: 'panel' }, [
      h('h2', { text: 'Build a baseline' }),
      h('div', { class: 'form' }, [
        h('label', { class: 'wide' }, ['Start from', h('select', { onchange: (ev) => { b.refId = ev.target.value; b.result = null; render(); } },
          ordered.map((x) => h('option', { value: x.id, selected: x.id === b.refId, text: x.name + ' (' + x.track + ')' + (STA.baseline.isSimBaseline(x) ? ', sim baseline' : '') })))]),
        h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: STA.baseline.isSimBaseline(ref), onchange: async (ev) => { await STA.library.updateSetup(ref.id, { tags: { simBaseline: ev.target.checked } }); await A().refreshLibrary(); b.result = null; render(); } }), 'This is the sim\'s own baseline']),
      ]),
      h('div', { class: 'form' }, [
        h('label', {}, ['Downforce', prefSel('downforce', [['auto', 'Decide from telemetry'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])]),
        h('label', {}, ['Surface', prefSel('surface', [['auto', 'Decide from telemetry'], ['smooth', 'Smooth'], ['bumpy', 'Bumpy']])]),
        h('label', {}, ['Corner mix', prefSel('corners', [['auto', 'Decide from telemetry'], ['slow', 'Mostly slow'], ['mixed', 'Mixed'], ['fast', 'Mostly fast']])]),
        h('label', {}, ['How you like the car', prefSel('balance', [['stable', 'Stable, planted rear'], ['neutral', 'Neutral'], ['lively', 'Lively, rotates easily']])]),
      ]),
      h('ul', { class: 'notes' }, reading.why.map((w) => h('li', { text: w })).concat(
        profile ? [] : [h('li', { text: 'There is no telemetry for ' + b.track + ' in this sim yet, so anything left on "Decide from telemetry" uses the middle setting.' })],
        tnd.filter((t) => t.count >= 2).map((t) => h('li', { text: 'Your earlier sessions with this car keep showing: ' + t.title.toLowerCase() + ' (' + t.count + ' sessions). The baseline leans against it.' })))),
      h('div', { class: 'actions' }, [h('button', { class: 'btn', type: 'button', text: 'Build baseline for ' + b.track, onclick: () => buildNow() })]),
    ]));

    if (b.result) {
      const r = b.result;
      view().appendChild(h('section', { class: 'panel' }, [
        h('h2', { text: r.changes.length ? 'Proposed baseline: ' + r.changes.length + (r.changes.length === 1 ? ' change' : ' changes') + ' from "' + ref.name + '"' : 'No changes from "' + ref.name + '"' }),
        r.changes.length ? table([{ key: 'label', label: 'Setting' }, { key: 'from', label: 'Starting value' }, { key: 'to', label: 'Baseline' }, { key: 'text', label: 'Change' }, { key: 'why', label: 'Why' }, { key: 'alt', label: '' }],
          r.changes.map((c) => Object.assign({}, c, { alt: c.key ? h('button', { class: 'link', type: 'button', text: 'Contest', 'aria-label': 'Contest: ' + c.text, title: 'Take this change out and use another way to get the same effect, if there is one',
            onclick: () => { STA.library.contested.add(b.sim, b.car, c.key, 'tradeoff'); buildNow(); } }) : '' })))
          : h('p', { class: 'empty', text: 'With these choices the starting setup already suits the track, so it is the baseline. Change the options above if you want it to differ.' }),
        r.notApplied.length ? h('p', { class: 'hint', text: 'Left out: ' + r.notApplied.map((x) => x.label + ' (' + x.reason + ')').join('; ') + '.' }) : null,
        contestedList(b.sim, b.car, buildNow),
        h('p', { class: 'hint', text: 'Low to medium confidence: general rules, small steps.' }),
        r.changes.length ? h('div', { class: 'actions' }, [h('button', { class: 'btn', type: 'button', text: 'Save baseline and compare with the starting setup', onclick: async () => {
          await STA.library.saveSetup(r.setup, { userNamed: true }); await A().refreshLibrary();
          ui().diffIds = [ref.id, r.setup.id]; st.tab = 'setups'; A().say('ok', 'Saved "' + r.setup.name + '".'); A().renderAll();
        } })]) : null,
      ]));
    }
  }

  /* ---------- Setups and differences ---------- */

  function renderSetups() {
    const st = A().state, s = A().active(), all = st.setups.slice();
    const f = ui().setupFilter || (ui().setupFilter = { sim: s ? s.meta.sim : '', car: s ? s.meta.car : '', track: '' });
    const ids = ui().diffIds || (ui().diffIds = []);
    const uniq = (arr) => Array.from(new Set(arr.filter(Boolean))).sort();
    const shown = all.filter((x) => (!f.sim || x.sim === f.sim) && (!f.car || STA.library.sameCar(x.car, f.car)) && (!f.track || STA.library.sameTrack(x.track, f.track)) || ids.indexOf(x.id) >= 0)
      .sort((a, b) => ((b.usage && b.usage.lastUsed) || b.createdAt || 0) - ((a.usage && a.usage.lastUsed) || a.createdAt || 0));
    const fsel = (key, label, opts) => h('label', {}, [label, h('select', { onchange: (ev) => { f[key] = ev.target.value; render(); } }, [h('option', { value: '', text: 'All' })].concat(opts.map(([v, t]) => h('option', { value: v, selected: f[key] === v, text: t }))))]);
    const srcText = { telemetry: 'From telemetry', file: 'Setup file', advice: 'From setup advice', baseline: 'App baseline' };
    const impIn = h('input', { type: 'file', accept: '.json', hidden: true, onchange: (ev) => { A().addFiles(ev.target.files); ev.target.value = ''; } });

    const rows = shown.map((x) => ({
      pick: h('input', { type: 'checkbox', 'aria-label': 'Compare ' + x.name, checked: ids.indexOf(x.id) >= 0, onchange: (ev) => { const i = ids.indexOf(x.id); if (ev.target.checked && i < 0) ids.push(x.id); if (!ev.target.checked && i >= 0) ids.splice(i, 1); render(); } }),
      name: h('span', {}, [h('b', { text: x.name }), STA.baseline.isSimBaseline(x) ? h('span', { class: 'tag', text: 'sim baseline' }) : null, x.status ? h('span', { class: 'tag', text: x.status }) : null]),
      sim: A().simName(x.sim), car: x.car || '', track: x.track || '', src: srcText[x.source] || x.source || '',
      used: x.usage && x.usage.lastUsed ? A().dateText(x.usage.lastUsed) : '', best: x.usage && x.usage.bestLap ? U.fmtLap(x.usage.bestLap) : '',
      act: h('span', { class: 'rowacts' }, [
        h('button', { class: 'link', type: 'button', text: 'Rename', onclick: async () => { const n = prompt('Name for this setup', x.name); if (n && n.trim()) { await STA.library.updateSetup(x.id, { name: n.trim(), userNamed: true }); await A().refreshLibrary(); render(); } } }),
        h('button', { class: 'link', type: 'button', text: 'Set track', onclick: async () => { const n = prompt('Track this setup is for', x.track || ''); if (n && n.trim()) { await STA.library.updateSetup(x.id, { track: n.trim() }); await A().refreshLibrary(); render(); } } }),
        h('button', { class: 'link', type: 'button', text: STA.baseline.isSimBaseline(x) && x.tags && x.tags.simBaseline ? 'Unmark baseline' : 'Mark as sim baseline', onclick: async () => { await STA.library.updateSetup(x.id, { tags: { simBaseline: !(x.tags && x.tags.simBaseline) } }); await A().refreshLibrary(); render(); } }),
        h('button', { class: 'link danger', type: 'button', text: 'Delete', onclick: async () => { if (!confirm('Delete "' + x.name + '" from the library?')) return; await STA.library.removeSetup(x.id); const i = ids.indexOf(x.id); if (i >= 0) ids.splice(i, 1); await A().refreshLibrary(); render(); } }),
      ]),
    }));

    const lapSetups = (() => { const idsOf = Array.from(new Set(A().overlayLaps().filter((l) => l.session.setup).map((l) => l.session.setup.id))); return idsOf.length >= 2 ? idsOf : null; })();
    view().appendChild(h('section', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [h('h2', { text: 'Setup library' }), h('div', { class: 'tools' }, [
        lapSetups ? h('button', { class: 'btn ghost', type: 'button', text: 'Compare the ' + lapSetups.length + ' setups of the overlaid laps', onclick: () => { ui().diffIds = lapSetups; render(); } }) : null,
        h('button', { class: 'btn ghost', type: 'button', text: 'Export library', onclick: async () => download('setup-library.json', JSON.stringify(await STA.library.exportAll(), null, 1), 'application/json') }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Import library', onclick: () => impIn.click() }), impIn,
      ])]),
      h('div', { class: 'form' }, [
        fsel('sim', 'Sim', [['iracing', 'iRacing'], ['lmu', 'Le Mans Ultimate']]),
        fsel('car', 'Car', uniq(all.filter((x) => !f.sim || x.sim === f.sim).map((x) => x.car)).map((c) => [c, c])),
        fsel('track', 'Track', uniq(all.filter((x) => !f.sim || x.sim === f.sim).map((x) => x.track)).map((c) => [c, c])),
      ]),
      all.length ? (rows.length ? table([{ key: 'pick', label: 'Compare' }, { key: 'name', label: 'Setup' }, { key: 'sim', label: 'Sim' }, { key: 'car', label: 'Car' }, { key: 'track', label: 'Track' },
        { key: 'src', label: 'Source' }, { key: 'used', label: 'Last used' }, { key: 'best', label: 'Best lap', num: true }, { key: 'act', label: '' }], rows)
        : h('p', { class: 'empty', text: 'No setups match these filters.' }))
        : h('p', { class: 'empty', text: 'The library is empty. Every telemetry file you load adds the setup that was on the car. You can also drop .svm files or scan your setup folders from the panel on the left.' }),
      h('p', { class: 'hint', text: 'Tick two or more setups to see how they differ. The first one ticked is the reference. The library is stored in this browser on this computer' + (STA.library.persistent === false ? ' for this visit only' : '') + '; use Export library to back it up or move it.' }),
    ]));

    const picked = ids.map((id) => all.find((x) => x.id === id)).filter(Boolean);
    if (picked.length < 2) return;
    const refS = picked[0], onlyDiff = ui().onlyDiff !== false, hideCalc = ui().hideCalc !== false;
    const diffs = picked.slice(1).map((x) => STA.setup.diff(refS, x));
    // union of rows in reference order
    const order = [], seen = new Map();
    diffs.forEach((d, k) => d.forEach((r) => { if (!seen.has(r.id)) { seen.set(r.id, { id: r.id, section: r.section, label: r.label, derived: r.derived, ref: r.a, cells: [] }); order.push(r.id); } const e = seen.get(r.id); if (r.a != null) e.ref = r.a; e.cells[k] = r; }));
    let nDiff = 0;
    const out = [];
    for (const id of order) {
      const e = seen.get(id), changed = e.cells.some((c) => c && c.changed);
      if (hideCalc && e.derived) continue;
      if (changed) nDiff++;
      if (onlyDiff && !changed) continue;
      const row = { section: e.section, label: e.label, ref: e.ref == null ? 'not in this setup' : e.ref, _cell: {} };
      picked.slice(1).forEach((x, k) => {
        const c = e.cells[k];
        row['v' + k] = !c ? '' : c.b == null ? 'not in this setup' : c.b;
        row['d' + k] = !c || !c.changed ? '' : U.isNum(c.numDelta) && c.numDelta !== 0 ? U.fmtDelta(c.numDelta, Math.abs(c.numDelta) < 1 ? 2 : 1) + (c.unit ? ' ' + c.unit : '')
          : c.stepDelta ? Math.abs(c.stepDelta) + (Math.abs(c.stepDelta) === 1 ? ' step ' : ' steps ') + (c.stepDelta > 0 ? 'up' : 'down') : c.onlyIn ? '' : 'changed';
        if (c && c.changed) row._cell['v' + k] = 'diff';
      });
      out.push(row);
    }
    const cols = [{ key: 'section', label: 'Group' }, { key: 'label', label: 'Setting' }, { key: 'ref', label: refS.name + ' (reference)' }];
    picked.slice(1).forEach((x, k) => { cols.push({ key: 'v' + k, label: x.name }); cols.push({ key: 'd' + k, label: 'Change', num: true }); });
    const mismatch = picked.some((x) => x.sim !== refS.sim) ? 'These setups are from different sims, so their settings do not line up.' : picked.some((x) => !STA.library.sameCar(x.car, refS.car)) ? 'These setups are for different cars, so some settings will not line up.' : '';
    view().appendChild(h('section', { class: 'panel' }, [
      h('div', { class: 'panel-head' }, [h('h2', { text: nDiff + (nDiff === 1 ? ' setting differs' : ' settings differ') }), h('div', { class: 'tools' }, [
        h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: onlyDiff, onchange: (ev) => { ui().onlyDiff = ev.target.checked; render(); } }), 'Only differences']),
        h('label', { class: 'check' }, [h('input', { type: 'checkbox', checked: hideCalc, onchange: (ev) => { ui().hideCalc = ev.target.checked; render(); } }), 'Hide readings the sim calculates']),
        h('button', { class: 'btn ghost', type: 'button', text: 'Save as CSV', onclick: () => download('setup-differences.csv', U.csv([cols.map((c) => c.label)].concat(out.map((r) => cols.map((c) => r[c.key]))))) }),
      ])]),
      mismatch ? h('p', { class: 'lapwarn', text: mismatch }) : null,
      out.length ? table(cols, out, { cls: 'diff', tall: true }) : h('p', { class: 'empty', text: 'These setups are identical in every setting.' }),
    ]));
  }

  function render() {
    clear();
    const tab = STA.app.state.tab;
    ({ compare: renderCompare, map: renderMap, tables: renderTables, library: renderLibrary, advice: renderAdvice, technique: renderTechnique, baseline: renderBaseline, setups: renderSetups }[tab] || renderCompare)();
  }

  /* Pick one overlaid lap out in whatever charts are on screen (null clears it). */
  function highlight(letter) { for (const c of live) if (c.setHighlight) c.setHighlight(letter); }

  STA.views = { render, highlight };
})(typeof window !== 'undefined' ? window : globalThis);
