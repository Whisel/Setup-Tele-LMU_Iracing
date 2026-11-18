/* Known limits of individual cars: how far a setting can go, or what the rules allow.

   Where these come from
   - iRacing's own per-car user manuals (https://www.iracing.com/resources/user-manuals/),
     read in November 2026. Each entry links the manual it was taken from. The manuals
     are uneven: some state legal ride heights and every adjustment range, some state
     nothing, so a car with no entry (or a setting with no line) simply has no known
     limit here. iRacing can change a car at any season build; treat these as a guide
     and use "Not possible on this car" in the app to correct or extend them.
   - "driver" entries were reported by the person using the app and are not in a manual.

   Compact form: 'role:axle:min:max[:unit][@condition]'
     role  rh ride height (mm unless unit given), arb, spr spring rate (N/mm), lsc/hsc
           low/high-speed compression, lsr/hsr low/high-speed rebound, tc, abs, wing,
           diffp differential lock on power
     axle  f, r, or a (both)
     min/max  blank when the manual gives only one side
     @nord    applies only at the Nürburgring Nordschleife */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;
  const M = 'https://s100.iracing.com/wp-content/uploads/';
  const NORD = 'rh:a:70:@nord';
  const GT4_DAMP = (b, r) => 'lsc:a:0:' + b + ',lsr:a:0:' + r;
  const FOUR = (lo, hi) => ['lsc', 'hsc', 'lsr', 'hsr'].map((k) => k + ':a:' + lo + ':' + hi).join(',');

  // Order matters: the first matching pattern wins, so specific names come before general ones.
  const IRACING = [
    ['Super Formula Lights', 'super formula lights|f324|\\bsfl\\b', M + '2024/03/Super-Formula-Lights_Manual_V1.pdf', 'arb:f:1:5', 'rh:f::20'],
    ['FIA F4', '\\bf4\\b', M + '2024/04/FIA-F4-Manual-V3.pdf', 'rh:f:20:,rh:r:30:40,spr:a:88:175,arb:a:1:5,lsc:a:1:10,lsr:a:1:10'],
    ['Formula Vee', 'formula vee|\\bvee\\b', M + '2023/10/Formula-Vee-Manual.pdf', 'rh:f:25.4:,rh:r:114:152'],
    ['Acura ARX-06 GTP', 'arx 06|arx06', M + '2025/01/Acura-ARX-06-GTP-V2.pdf', 'arb:a::5'],
    ['Acura NSX EVO22 GT3', '\\bnsx\\b', M + '2024/12/Acura-GT3_Manual_V2.pdf', 'arb:f:1:8,arb:r:1:5,tc:a:1:12,abs:a:1:12,' + FOUR(1, 16) + ',' + NORD],
    ['Audi R8 LMS EVO II GT3', 'r8 lms.*evo ii|r8 lms.*evo 2|r8 lms evo2', M + '2024/07/Audi-R8-LMS-EVO-II-GT3_Manual.pdf', 'lsc:a:2:38,lsr:a:2:38,hsc:a:0:40,hsr:a:0:40,tc:a:1:12,abs:a:1:12,' + NORD],
    ['Audi R8 LMS GT3', 'r8 lms', M + '2023/10/UM-Audi-R8-LMS-GT3-Manual.pdf', 'rh:f:50:,rh:r:50:90,spr:f:160:280,spr:r:190:310,lsc:a:-24:0,lsr:a:-24:0'],
    ['Audi RS 3 LMS TCR', 'rs 3 lms|rs3 lms', M + '2025/03/Audi_RS3_LMS_TCR_V2.pdf', 'wing:r:-4:4,lsr:a:0:10'],
    ['BMW M4 G82 GT4', 'm4 g82|g82 gt4', M + '2024/12/BMW-M4-G82-GT4-Manual-V2.pdf', 'arb:f:1:5,arb:r:0:5,lsc:a:-18:0,lsr:a:-18:0'],
    ['BMW M4 F82 GT4', 'm4 f82|m4 gt4', M + '2024/07/BMW-M4-GT4-V2.pdf', 'arb:f:1:3,arb:r:1:2,' + GT4_DAMP(25, 18)],
    ['BMW M4 GT3', 'm4 gt3', M + '2024/07/BMW-M4-GT3-Manual_V3.pdf', 'rh:r:50:95,' + FOUR(0, 11) + ',abs:a:1:12,tc:a:1:10,' + NORD],
    ['BMW M8 GTE', 'm8 gte', M + '2024/09/BMW-M8-GTE_Manual_V2.pdf', 'tc:a:1:9'],
    ['BMW M2 CSR', 'm2 csr|m2 cs racing', M + '2024/12/BMW-M2-CSR-Manual_V2.pdf', 'rh:a:125:'],
    ['Aston Martin Vantage GT4', 'vantage gt4', M + '2025/03/Aston-Vantage-GT4-Manual_V4.pdf', 'arb:a:1:3,abs:a:0:11,tc:a:0:11,' + GT4_DAMP(25, 18)],
    ['Aston Martin GT3 EVO', 'aston martin.*gt3|vantage gt3', M + '2026/01/Aston-Martin-GT3-Evo-V1.pdf', 'arb:a:1:8,abs:a:0:11,tc:a:0:11,' + FOUR(0, 18)],
    ['Chevrolet Corvette Z06 GT3.R', 'z06 gt3|corvette.*gt3', M + '2024/06/Chevrolet-Corvette-Z06-GT3_manual_V2.pdf', 'arb:a:0:6,lsc:a:0:30,lsr:a:0:30,hsc:a:0:22,hsr:a:0:22,abs:a:0:11,tc:a:0:11,' + NORD],
    ['Ferrari 296 Challenge', '296 challenge', M + '2025/06/Ferrari-296-Challenge.pdf', 'rh:f:105:,rh:r:107:'],
    ['Ferrari 296 GT3', '296 gt3', M + '2024/06/Ferrari-296-GT3-V4.pdf', 'rh:r:50:92.5'],
    ['Ferrari 488 GT3 EVO 2020', '488 gt3 evo', M + '2023/10/Ferrari-488-GT3-EVO-2020.pdf', 'rh:f:50:,rh:r:50:90,spr:a:180:330,arb:a:1:10,' + FOUR(0, 11)],
    ['Ferrari 488 GT3', '488 gt3', M + '2023/10/UM-Ferrari-488-GT3-Manual-V2.pdf', 'rh:f:50:,rh:r:50:90,arb:a:1:10,spr:f:180:330,spr:r:190:310,' + FOUR(0, 11) + ',tc:a:1:6,abs:a:1:12'],
    ['Ford GT GT3', 'ford gt gt3|ford gt3', M + '2024/01/UM-Ford-GT-GT3-V2.pdf', 'rh:f:50:,rh:r:50:95,spr:f:158:385,spr:r:158:280,arb:a:1:4,' + FOUR(0, 10) + ',tc:a:1:3,abs:a:1:12'],
    ['Ford Mustang GT3', 'mustang gt3', M + '2024/06/Mustang-GT3_Manual_V2.pdf', 'arb:a:1:5,' + FOUR(0, 11) + ',abs:a:1:12,tc:a:1:12,' + NORD],
    ['Honda Civic Type R TCR', 'civic', M + '2025/03/Honda-Civic-Type-R_TCR.pdf', 'wing:r:-4:4,abs:a:0:11'],
    ['Hyundai Elantra N TCR', 'elantra', M + '2025/03/Hyundai-Elantra-N-TCR_V3.pdf', 'wing:r:-4:4'],
    ['Hyundai Veloster N TCR', 'veloster', M + '2025/03/Hyundai-Veloster-N-TC-Manual-V4.pdf', 'wing:r:-4:4'],
    ['Lamborghini Huracán GT3 EVO', 'hurac', M + '2024/07/UM-Lamborghini-Huracan-GT3-Evo-V3.pdf', 'tc:a:1:10,abs:a:1:12,' + NORD],
    ['Mazda MX-5 Cup', 'mx 5|mx5', M + '2025/02/Global-Mazda-MX5_Manual_V2.pdf', GT4_DAMP(11, 11)],
    ['McLaren 720S GT3', '720s', M + '2024/09/Mclaren-720S-GT3_V2.pdf', 'lsc:a:0:40,lsr:a:0:40,hsc:a:0:50,hsr:a:0:50,' + NORD],
    ['McLaren 570S GT4', '570s', M + '2024/07/McLaren-570S-GT4-Manual-V2.pdf', 'arb:a:1:2,' + GT4_DAMP(18, 18)],
    ['McLaren MP4-12C GT3', 'mp4 12c|mp4', M + '2024/01/UM-McLaren-MP4-12C-GT3-V3.pdf', 'rh:f:50:,rh:r:50:95,spr:f:158:385,spr:r:158:280,arb:a:1:4,' + FOUR(0, 10) + ',tc:a:1:3,abs:a:1:12'],
    ['Mercedes-AMG GT4', 'amg gt4', M + '2024/07/Mercedes-AMG-GT4-Manual-V2.pdf', 'abs:a:1:12,tc:a:1:12,' + GT4_DAMP(15, 12)],
    ['Mercedes-AMG GT3 2020', 'amg gt3 2020|amg gt3 evo', M + '2026/09/Mercedes-AMG-GT3-2020-Manual_V10.pdf', FOUR(0, 11) + ',' + NORD],
    ['Mercedes-AMG GT3', 'amg gt3', M + '2023/10/UM-Mercedes-AMG-GT3-Manual-V2.pdf', 'rh:f:50:,rh:r:50:92.5,tc:a:1:12,abs:a:1:12,' + FOUR(1, 8)],
    ['Porsche 718 Cayman GT4', 'cayman', M + '2024/07/Porsche-718-Cayman-GT4-Manual-V5.pdf', 'arb:r:1:7,abs:a:0:11,tc:a:0:11,' + GT4_DAMP(18, 18)],
    ['Porsche 911 GT3 Cup (992.2)', '992 2', M + '2026/01/Porsche-Cup-992.2-V1.pdf', 'rh:f:72:,rh:r:106:'],
    ['Porsche 911 GT3 R (992)', 'gt3 r.*992|992.*gt3 r', M + '2024/09/Porsche-911-GT3-R-992_V2.pdf', 'diffp:a:4:'],
    ['Porsche 911 GT3 R', '911 gt3 r\\b', M + '2023/10/UM-Porsche-911-GT3-R.pdf', 'rh:f:50:,rh:r:50:87.5,spr:a:200:400,' + FOUR(-24, 0) + ',tc:a:0:11,abs:a:0:11'],
    ['Porsche Mission R', 'mission r', M + '2023/09/Porsche-Mission-R-real-Manual-V5-1.pdf', 'arb:f:1:3,arb:r:1:7'],
    ['Toyota GR86', 'gr86|gr 86', M + '2024/09/Toyota_GR86_Manual_V2.pdf', 'wing:r:5:15,abs:a:0:3,tc:a:0:3'],
    ['Gen 3 Australian Supercars', 'gen 3|gen3', M + '2025/06/Gen-3-Supercars-Manual_V5.pdf', GT4_DAMP(40, 40)],
    ['ARCA Series cars', '\\barca\\b', M + '2025/03/ARCA_25_Manual_V1.pdf', 'rh:r:4:5:in'],
    ['NASCAR Xfinity Series cars', 'xfinity|o reilly|oreilly', M + '2026/03/UM-NASCAR-Oreilly_Manual_V1.pdf', 'rh:r:4.5:5:in'],
    ['NASCAR Craftsman Trucks', 'nascar.*truck|silverado|tundra trd|f150', M + '2024/05/NASCAR-Trucks-Manual-V6.pdf', 'rh:r:100:110'],
  ];

  const ROLE_OF = { rh: 'rideHeight', arb: 'arb', spr: 'spring', lsc: 'slowBump', hsc: 'fastBump', lsr: 'slowRebound', hsr: 'fastRebound', tc: 'tc', abs: 'abs', wing: 'rearWing', diffp: 'diffPower' };
  const UNIT_OF = { rh: 'mm', spr: 'N/mm' };

  function parseSpec(spec, src) {
    return spec.split(',').filter(Boolean).map((item) => {
      const [body, cond] = item.split('@'), f = body.split(':');
      return { role: ROLE_OF[f[0]], axle: f[1] === 'f' ? 'front' : f[1] === 'r' ? 'rear' : null,
        min: f[2] === '' || f[2] == null ? null : parseFloat(f[2]), max: f[3] === '' || f[3] == null ? null : parseFloat(f[3]),
        unit: f[4] || UNIT_OF[f[0]] || '', track: cond === 'nord' ? /nordschleife|gesamtstrecke|rburgring combined/ : null, src };
    });
  }

  const CARS = IRACING.map(([name, pattern, url, manual, driver]) => ({
    sim: 'iracing', name, re: new RegExp(pattern), url,
    limits: parseSpec(manual || '', 'manual').concat(parseSpec(driver || '', 'driver')),
  }));

  function forCar(sim, carName) {
    const slug = U.slug(carName);
    return CARS.find((c) => c.sim === sim && c.re.test(slug)) || null;
  }

  /* Convert a limit value into the unit a setup value is shown in; null if they cannot be compared. */
  function toUnit(v, from, to) {
    const t = String(to || '').toLowerCase().replace(/s$/, '');
    if (from === 'mm' || from === 'in') {
      const mm = from === 'in' ? v * 25.4 : v;
      return t === 'mm' ? mm : t === 'cm' ? mm / 10 : t === 'm' ? mm / 1000 : t === 'in' || t === '"' ? mm / 25.4 : null;
    }
    if (from === 'N/mm') return t === 'n/mm' ? v : t === 'lb/in' || t === 'lbs/in' ? v * 5.710147 : null;
    if (from === '') return t === '' || t === 'click' || t === 'deg' || t === '°' ? v : null; // counts, clicks and wing angles
    return t === String(from).toLowerCase() ? v : null;
  }

  /* Write the known range onto each matching setting of a setup: p.lo / p.hi in the setting's
     own unit, with p.loSrc / p.hiSrc saying where the limit came from. Safe to call repeatedly. */
  function apply(setup, trackName, learned) {
    if (!setup || !setup.params) return null;
    for (const p of setup.params) { delete p.lo; delete p.hi; delete p.loSrc; delete p.hiSrc; }
    // Limits the driver entered for this car count the same way as the built-in ones.
    if (learned) for (const p of setup.params) {
      if (!U.isNum(p.num)) continue;
      const lo = learned.get(p.id + '|-'), hi = learned.get(p.id + '|+');
      if (lo && U.isNum(lo.num)) { p.lo = lo.num; p.loSrc = 'set by you'; }
      if (hi && U.isNum(hi.num)) { p.hi = hi.num; p.hiSrc = 'set by you'; }
    }
    const car = forCar(setup.sim, setup.car);
    if (!car) return null;
    const track = U.slug(trackName == null ? setup.track : trackName);
    for (const L of car.limits) {
      if (L.track && !L.track.test(track)) continue;
      for (const p of setup.params) {
        if (p.role !== L.role || p.derived || !U.isNum(p.num) || (L.axle && p.axle !== L.axle)) continue;
        const lo = L.min == null ? null : toUnit(L.min, L.unit, p.unit), hi = L.max == null ? null : toUnit(L.max, L.unit, p.unit);
        if (L.min != null && lo == null || L.max != null && hi == null) continue;
        // A value far outside the range means this line is not about this setting; leave it alone.
        // (Only for unit-less click ranges: a ride height in mm is always about the ride height.)
        const span = lo != null && hi != null ? hi - lo : Math.max(1, Math.abs(lo != null ? lo : hi) * 0.5);
        if (L.unit === '' && ((lo != null && p.num < lo - 0.6 * span) || (hi != null && p.num > hi + 0.6 * span))) continue;
        const src = L.src === 'driver' ? 'reported by a driver' : L.track ? 'iRacing manual, Nordschleife only' : 'from the iRacing manual';
        // A limit the driver entered wins over a built-in one, so a wrong entry here can be corrected in the app.
        if (lo != null && p.loSrc !== 'set by you' && (p.lo == null || lo > p.lo)) { p.lo = lo; p.loSrc = src; }
        if (hi != null && p.hiSrc !== 'set by you' && (p.hi == null || hi < p.hi)) { p.hi = hi; p.hiSrc = src; }
      }
    }
    return car;
  }

  /* Settings whose current value is outside the known range. */
  function violations(setup) {
    const out = [];
    for (const p of (setup && setup.params) || []) {
      if (!U.isNum(p.num)) continue;
      const eps = 1e-6 + Math.abs(p.num) * 1e-4;
      if (p.lo != null && p.num < p.lo - eps) out.push({ p, side: 'below', bound: p.lo, src: p.loSrc });
      else if (p.hi != null && p.num > p.hi + eps) out.push({ p, side: 'above', bound: p.hi, src: p.hiSrc });
    }
    return out;
  }

  STA.carLimits = { CARS, forCar, apply, violations, toUnit };
})(typeof window !== 'undefined' ? window : globalThis);
