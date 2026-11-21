/* Where the lap time is: the yardstick everything else is judged by.

   A handling problem only matters if fixing it makes the lap faster, and some
   changes (wing above all) are made for speed, not for handling. So every
   session's best lap is stored as a pace profile: the time taken over each
   10 m of the lap, tagged with what the car was doing there.

     S  straight        not braking, little side load
     B  braking         brake applied
     L  slow corner     cornering under 100 km/h
     M  medium corner   cornering at 100 to 160 km/h
     H  fast corner     cornering above 160 km/h

   Two profiles of the same car and track can then be laid over each other to
   say where a lap was gained or lost: "straights -0.31 s, fast corners
   +0.08 s". The zones are taken from the earlier lap, so both laps are
   measured over the same pieces of track.

   Each kind of setup change acts on certain zones (wing: straights, fast
   corners and braking; differential: slow and medium corners and the straight
   that follows; springs and bars: every corner, the braking into it and the
   straight out of it). A change is judged first on the time gained or lost
   where it acts.

   Time shows up next to where it is won, not only in the corner itself: a car
   that is quicker through a corner brakes less going in and carries speed down
   the following straight. That is why corner changes are also given the
   braking zones and, when no wing change competes for them, the straights. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;

  const CELL = 10; // metres
  const ZONES = ['S', 'B', 'L', 'M', 'H'];
  const ZONE_TEXT = { S: 'straights', B: 'braking', L: 'slow corners', M: 'medium corners', H: 'fast corners' };

  /* The best lap as time per cell and a zone letter per cell. null when there is no usable lap. */
  function profile(session, gmaxHint) {
    const lap = session.bestLap;
    if (!lap) return null;
    const g = STA.session.lapGrid(session, lap);
    if (!g || !g.speed || !g.t) return null;
    const per = Math.max(1, Math.round(CELL / g.step)), n = Math.floor((g.n - 1) / per);
    if (n < 20) return null;
    let gmax = gmaxHint;
    if (!(gmax > 0) && g.latG) { const a = []; for (let i = 0; i < g.n; i += 3) a.push(Math.abs(g.latG[i])); gmax = U.percentile(a, 0.98); }
    const t = new Array(n);
    let zone = '', top = 0;
    for (let i = 0; i < n; i++) {
      const a = i * per, b = a + per;
      t[i] = Math.round((g.t[b] - g.t[a]) * 1000);
      let brake = 0, lat = 0, v = 0;
      for (let j = a; j < b; j++) { if (g.brake && g.brake[j] > brake) brake = g.brake[j]; if (g.latG) lat += Math.abs(g.latG[j]); v += g.speed[j]; }
      lat /= per; v /= per;
      if (v > top) top = v;
      const kmh = v * 3.6;
      zone += brake > 0.05 ? 'B' : gmax > 0 && lat >= 0.4 * gmax ? (kmh < 100 ? 'L' : kmh <= 160 ? 'M' : 'H') : 'S';
    }
    return { cell: +(per * g.step).toFixed(3), t, zone, top: +top.toFixed(2), lap: +(g.t[n * per] - g.t[0]).toFixed(3) };
  }

  /* Share of the lap spent in each zone. */
  function shares(p) {
    if (!p || !p.t) return null;
    const out = { S: 0, B: 0, L: 0, M: 0, H: 0 };
    let total = 0;
    for (let i = 0; i < p.t.length; i++) { out[p.zone[i]] += p.t[i]; total += p.t[i]; }
    for (const z of ZONES) out[z] = total ? out[z] / total : 0;
    return out;
  }

  /* Time gained (negative) or lost (positive) in each zone going from one best lap to a later one.
     Zones come from the earlier lap. null when the two are not the same length of track. */
  function delta(before, after) {
    if (!before || !after || !before.t || !after.t) return null;
    const nb = before.t.length, na = after.t.length;
    if (Math.abs(nb * before.cell - na * after.cell) > 0.03 * nb * before.cell) return null;
    // Running time of the later lap, read off at the same fractions of the lap as the earlier lap's cells.
    const cum = new Float64Array(na + 1);
    for (let i = 0; i < na; i++) cum[i + 1] = cum[i] + after.t[i];
    const at = (frac) => { const x = frac * na, i = Math.min(na - 1, Math.floor(x)); return cum[i] + (cum[i + 1] - cum[i]) * (x - i); };
    const zones = { S: 0, B: 0, L: 0, M: 0, H: 0 }, time = { S: 0, B: 0, L: 0, M: 0, H: 0 };
    let prev = 0, total = 0, lapB = 0;
    for (let i = 0; i < nb; i++) {
      const end = at((i + 1) / nb), d = (end - prev - before.t[i]) / 1000, z = before.zone[i];
      prev = end; zones[z] += d; time[z] += before.t[i] / 1000; total += d; lapB += before.t[i] / 1000;
    }
    const share = {};
    for (const z of ZONES) share[z] = lapB ? time[z] / lapB : 0;
    return { lap: total, zones, share, lapBefore: lapB, lapAfter: lapB + total, top: { before: before.top, after: after.top, d: after.top - before.top },
      // Smaller than this is not a real difference: a twentieth of a second, or a thousandth of the lap.
      sig: Math.max(0.05, 0.001 * lapB) };
  }

  const AERO = { rearWing: true, frontAero: true, rearAeroPart: true, frontAeroPart: true, aeroTrim: true };
  const BRAKES = { brakeBias: true, brakePressure: true, abs: true, brakeDuct: true };
  const DRIVE = { diffPreload: true, diffPower: true, diffCoast: true, tc: true };

  /* The zones a change acts on. `all` is every change made at the same time: when the wing was
     changed too, time on the straights is credited to the wing, not to the others. */
  function acts(change, all) {
    if (change.role === 'rearWing' || change.role === 'rearAeroPart' || change.role === 'aeroTrim') return 'SHB';
    if (change.role === 'frontAero' || change.role === 'frontAeroPart') return 'SH';
    if (BRAKES[change.role]) return 'B';
    const aeroToo = (all || []).some((c) => AERO[c.role]);
    if (DRIVE[change.role]) return aeroToo ? 'LM' : 'LMS';
    return aeroToo ? 'LMHB' : 'LMHBS';
  }

  /* What a change is for when its purpose is pace, not a handling problem. */
  function purpose(change) {
    if (!AERO[change.role]) return null;
    return change.dir === '-' ? 'Top speed and time on the straights' : 'Grip in fast corners and under braking';
  }

  const secs = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + ' s';

  /* Time where one change acts: { net, word, parts: [{ zone, d }], text }. */
  function effect(change, all, d) {
    const zs = acts(change, all).split(''), parts = zs.map((z) => ({ zone: z, d: d.zones[z] })).filter((p) => d.share[p.zone] > 0);
    const net = parts.reduce((s, p) => s + p.d, 0);
    const shown = parts.filter((p) => Math.abs(p.d) >= 0.01).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    return { zones: zs.join(''), net, word: net <= -d.sig ? 'faster' : net >= d.sig ? 'slower' : 'same', parts,
      text: shown.length ? shown.map((p) => ZONE_TEXT[p.zone] + ' ' + secs(p.d)).join(', ') : 'no change where it acts' };
  }

  STA.pace = { CELL, ZONES, ZONE_TEXT, AERO, profile, shares, delta, acts, purpose, effect, secs };
})(typeof window !== 'undefined' ? window : globalThis);
