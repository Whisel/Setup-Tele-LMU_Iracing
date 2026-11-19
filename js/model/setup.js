/* Car setups from both sims in one shape, so they can be listed, compared and
   reasoned about with the same code.

   Setup = { id, sim, car, carClass, track, name, source, createdAt, params[], fingerprint }
   Param = { id, section, label, raw, num, unit, index, min, max,
             adjustable, derived, role, axle, side }

   `raw` is the text the sim shows. `index` is the click/step number LMU stores.
   `role` is a sim-independent meaning ("rearWing", "arb", "camber" ...) that the
   advisor uses to find the right knob on whatever car is loaded. */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;

  /* ---------- shared helpers ---------- */

  function splitCamel(s) {
    return String(s).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
  }
  function sentence(s) {
    s = splitCamel(s).toLowerCase();
    s = s.replace(/\b(arb|abs|tc|mgu k|ers|drs|rh|ls|hs)\b/g, (m) => m.toUpperCase());
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function parseNum(raw) {
    const m = /(^|[^A-Za-z0-9.])([-+]?\d+(?:\.\d+)?)\s*([A-Za-z%°/]+)?/.exec(' ' + String(raw));
    if (!m) return { num: null, unit: '' };
    return { num: parseFloat(m[2]), unit: m[3] || '' };
  }

  const NOT_ADJ = /^(n\/a|non-adjustable|fixed|detached|standard|none|available|rwd|fwd|awd)?$/i;

  /* Role detection works on a lower-cased "id label" string. Order matters:
     earlier, more specific patterns win. */
  const ROLE_RULES = [
    ['derived', /lasthotpressure|lasttemps|treadremaining|cornerweight|aerocalculator|atspeed|aerobalance|downforcetodrag|crossweight|weightdist|totalbrakebias|updatecount/],
    ['tyreCompound', /compound/],
    ['brakeBias', /brakepressurebias|brakebias|basebrakebias|brakebalance|brake balance|rearbrakesetting|frontbrakebias/],
    ['brakeMigration', /brakemigration|dynamicramping/],
    ['brakePressure', /brakepressure|pedalforce|maxbrakeforce/],
    ['brakeDuct', /brakeduct/],
    ['pressure', /startingpressure|coldpressure|pressuresetting|tirepressure|tyrepressure/],
    ['camber', /camber/],
    ['caster', /caster/],
    ['toe', /toe/],
    ['thirdSpring', /3rdspring|thirdspring|heavespring|heaverate|3rd spring/],
    ['tender', /tender/],
    ['packers', /packer|bumpstop|bumprubber|springrubber|bump stop/],
    ['spring', /springrate|springsetting|torsionbar|rollrate|springperch|\bspring\b/],
    ['rideHeight', /rideheight|ride height/],
    ['arb', /\barb|antiroll|antisway|swaybar|anti roll|farb|rarb/],
    // Wings, flaps and their add-ons: which end of the car and which part is worked out in aeroRole().
    ['aero', /wing|flap|mainplane|gurney|wicker|diveplane|splitter|canard|noseheight|fwsetting|rwsetting/],
    ['aeroTrim', /downforcetrim|aeropackage|aerosetting/],
    ['slowBump', /lscomp|lowspeedcomp|slowbump|ls comp|lsbump/],
    ['fastBump', /hscomp|highspeedcomp|fastbump|hs comp|hsbump/],
    ['slowRebound', /lsrbd|lsreb|lowspeedreb|slowrebound|ls rbd|ls reb/],
    ['fastRebound', /hsrbd|hsreb|highspeedreb|fastrebound|hs rbd|hs reb/],
    // Cars with a single bump and a single rebound adjuster: treated as the slow-speed ones.
    ['slowBump', /bumpstiffness|compdamping|compression|\bbump\b/],
    ['slowRebound', /reboundstiffness|rbddamping|rebound/],
    ['diffPreload', /preload/],
    ['diffCoast', /diffcoast|coastramp|diffentry|coastlock|differential\/entry|coast/],
    ['diffPower', /diffpower|powerramp|diffexit|powerlock|differential\/(middle|highspeed)|drivelock|clutchfriction/],
    ['tc', /tractioncontrol|tcsetting|tclevel|traction control|\btc\b/],
    ['abs', /antilock|abssetting|\babs\b/],
    ['engineBraking', /enginebrak/],
    ['finalDrive', /finaldrive|gear_final|final drive/],
    ['gear', /\bgear\d|gear\dsetting|gearstack|sixthgear|fifthgear|ratioset/],
    ['fuel', /fuel/],
    ['wedge', /wedge|trackbar/],
  ];

  /* A wing, flap or add-on -> its role. The end of the car comes from the item's own name
     ("FrontFlapAngle", "RWSetting") or, failing that, from its section ("Front aero / Flap
     angle", as on the Super Formula SF23). A bare "Wing angle" is the rear wing.
       frontAero / rearWing          the main element: the one the advice moves
       frontAeroPart / rearAeroPart  gurneys, wickers, beam wings and flap types: read and
                                     compared, but not moved by the advice */
  function aeroRole(p) {
    const parts = p.id.toLowerCase().split('/'), leaf = parts[parts.length - 1] + ' ' + String(p.label).toLowerCase(), section = parts.slice(0, -1).join('/');
    const end = (s) => { const f = /front|fwsetting|\bfw\b|diveplane|splitter|canard|nose/.test(s), r = /rear|rwsetting|\brw\b|beam/.test(s); return f && !r ? 'front' : r && !f ? 'rear' : null; };
    const axle = end(leaf) || end(section) || 'rear';
    const part = /gurney|wicker|beam|config|type/.test(leaf);
    return { role: axle === 'front' ? (part ? 'frontAeroPart' : 'frontAero') : (part ? 'rearAeroPart' : 'rearWing'), axle };
  }

  function classify(p) {
    const key = (p.id + ' ' + p.label).toLowerCase();
    for (const [role, re] of ROLE_RULES) {
      if (re.test(key)) {
        if (role === 'derived') { p.derived = true; p.adjustable = false; continue; }
        if (role === 'aero') { const a = aeroRole(p); p.role = a.role; p.axle = a.axle; break; }
        p.role = role; break;
      }
    }
    const path = p.id.toLowerCase();
    // Axle and side come from the last path part that mentions them.
    const parts = path.split('/').reverse();
    for (const part of parts) {
      if (!p.axle) {
        const f = /front|\blf|\brf|_fl$|_fr$/.test(part), r = /rear|\blr|\brr|_rl$|_rr$/.test(part);
        if (f && !r) p.axle = 'front'; else if (r && !f) p.axle = 'rear';
        else if (f && r) p.axle = part.indexOf('front') < part.indexOf('rear') ? 'front' : 'rear';
      }
      if (!p.side) {
        if (/left|_fl$|_rl$|\blf|\blr/.test(part)) p.side = 'L';
        else if (/right|_fr$|_rr$|\brf|\brr/.test(part)) p.side = 'R';
      }
    }
    if (p.role === 'brakeBias' || p.role === 'brakeMigration') p.axle = null;
    if (p.role === 'arb' && !p.axle) p.axle = /farb|f arb/.test(key) ? 'front' : /rarb|r arb/.test(key) ? 'rear' : null;
    if (p.role === 'rearWing' || p.role === 'rearAeroPart') p.axle = 'rear';
    if (p.role === 'frontAero' || p.role === 'frontAeroPart') p.axle = 'front';
    return p;
  }

  function finish(setup) {
    setup.params.forEach(classify);
    setup.fingerprint = U.hash(setup.sim + '|' + setup.params.filter((p) => !p.derived)
      .map((p) => p.id + '=' + norm(p.index != null ? p.index : p.raw)).sort().join(';'));
    if (!setup.id) setup.id = 'setup-' + setup.fingerprint + '-' + U.hash(U.slug(setup.car) + '|' + U.slug(setup.track));
    return setup;
  }

  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');

  /* ---------- iRacing: the CarSetup tree from the .ibt session info ---------- */

  function fromIracing(carSetup, meta) {
    const params = [];
    (function walk(node, path) {
      for (const key of Object.keys(node || {})) {
        const v = node[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, path.concat(key)); continue; }
        if (Array.isArray(v) || key === 'UpdateCount') continue;
        const full = path.concat(key);
        const n = parseNum(v);
        params.push({
          id: full.join('/').toLowerCase(),
          section: path.map(sentence).join(' / ') || 'General',
          label: sentence(key), raw: String(v), num: n.num, unit: n.unit,
          index: null, min: null, max: null, adjustable: true, derived: false, role: null, axle: null, side: null,
        });
      }
    })(carSetup, []);
    return finish(Object.assign({ sim: 'iracing', source: 'telemetry', params, createdAt: Date.now() }, meta));
  }

  /* ---------- LMU ---------- */

  /* Correspondence between the keys in a saved .svm setup file and the keys in
     the CarSetup JSON that LMU's own telemetry recording stores. These are the
     game's own identifiers; the pairing was cross-checked against the key table
     in the open LMU-LoadTelemetry project (which credits LMU Telemetry Lab) and
     against a real recording. */
  const LMU_VEHICLE = {
    GENERAL: { WedgeSetting: 'VM_WEIGHT_WEDGE', FuelSetting: 'VM_FUEL_LEVEL', FuelCapacitySetting: 'VM_FUEL_CAPACITY',
      VirtualEnergySetting: 'VM_VIRTUAL_ENERGY', NumPitstopsSetting: 'VM_NUM_PITSTOPS' },
    FRONTWING: { FWSetting: 'VM_FRONT_WING' },
    REARWING: { RWSetting: 'VM_REAR_WING' },
    BODYAERO: { WaterRadiatorSetting: 'VM_WATER_RADIATOR', OilRadiatorSetting: 'VM_OIL_RADIATOR',
      BrakeDuctSetting: 'VM_BRAKE_DUCTS', BrakeDuctRearSetting: 'VM_BRAKE_DUCTS_REAR' },
    SUSPENSION: { FrontWheelTrackSetting: 'VM_FRONT_WHEEL_TRACK', RearWheelTrackSetting: 'VM_REAR_WHEEL_TRACK',
      FrontAntiSwaySetting: 'VM_FRONT_ANTISWAY', RearAntiSwaySetting: 'VM_REAR_ANTISWAY',
      FrontToeInSetting: 'VM_FRONT_TOEIN', FrontToeOffsetSetting: 'VM_FRONT_TOEOFFSET',
      RearToeInSetting: 'VM_REAR_TOEIN', RearToeOffsetSetting: 'VM_REAR_TOEOFFSET',
      LeftCasterSetting: 'VM_LEFT_CASTER', RightCasterSetting: 'VM_RIGHT_CASTER',
      Front3rdPackerSetting: 'VM_FRONT_3RD_PACKERS', Front3rdSpringSetting: 'VM_FRONT_3RD_SPRING',
      Front3rdSlowBumpSetting: 'VM_FRONT_3RD_SLOWBUMP', Front3rdFastBumpSetting: 'VM_FRONT_3RD_FASTBUMP',
      Front3rdSlowReboundSetting: 'VM_FRONT_3RD_SLOWREBOUND', Front3rdFastReboundSetting: 'VM_FRONT_3RD_FASTREBOUND',
      Rear3rdPackerSetting: 'VM_REAR_3RD_PACKERS', Rear3rdSpringSetting: 'VM_REAR_3RD_SPRING',
      Rear3rdSlowBumpSetting: 'VM_REAR_3RD_SLOWBUMP', Rear3rdFastBumpSetting: 'VM_REAR_3RD_FASTBUMP',
      Rear3rdSlowReboundSetting: 'VM_REAR_3RD_SLOWREBOUND', Rear3rdFastReboundSetting: 'VM_REAR_3RD_FASTREBOUND' },
    CONTROLS: { SteerLockSetting: 'VM_STEER_LOCK', RearBrakeSetting: 'VM_BRAKE_BALANCE',
      BrakeMigrationSetting: 'VM_BRAKE_MIGRATION', BrakePressureSetting: 'VM_BRAKE_PRESSURE',
      TCSetting: 'VM_TRACTION_CONTROL', ABSSetting: 'VM_ANTILOCK_BRAKES',
      TractionControlMapSetting: 'VM_TRACTIONCONTROLMAP', TCPowerCutMapSetting: 'VM_TRACTIONCONTROLPOWERCUTMAP',
      TCSlipAngleMapSetting: 'VM_TRACTIONCONTROLSLIPANGLEMAP', AntilockBrakeSystemMapSetting: 'VM_ANTILOCKBRAKESYSTEMMAP' },
    ENGINE: { RevLimitSetting: 'VM_REV_LIMITER', EngineBoostSetting: 'VM_ENGINE_BOOST', RegenerationMapSetting: 'VM_REGEN_LEVEL',
      ElectricMotorMapSetting: 'VM_ELECTRIC_MOTOR_MAP', EngineMixtureSetting: 'VM_ENGINE_MIXTURE',
      EngineBrakingMapSetting: 'VM_ENGINE_BRAKEMAP' },
    DRIVELINE: { FinalDriveSetting: 'VM_GEAR_FINAL', Gear1Setting: 'VM_GEAR_1', Gear2Setting: 'VM_GEAR_2',
      Gear3Setting: 'VM_GEAR_3', Gear4Setting: 'VM_GEAR_4', Gear5Setting: 'VM_GEAR_5', Gear6Setting: 'VM_GEAR_6',
      RatioSetSetting: 'VM_RATIO_SET', DiffPumpSetting: 'VM_DIFF_PUMP', DiffPowerSetting: 'VM_DIFF_POWER',
      DiffCoastSetting: 'VM_DIFF_COAST', DiffPreloadSetting: 'VM_DIFF_PRELOAD', RearSplitSetting: 'VM_TORQUE_SPLIT' },
  };
  const LMU_WHEEL = { CamberSetting: 'CAMBER', PressureSetting: 'PRESSURE', PackerSetting: 'PACKERS', SpringSetting: 'SPRING',
    TenderSpringSetting: 'TENDERSPRING', TenderTravelSetting: 'TENDERSPRINGTRAVEL', SpringRubberSetting: 'SRUBBER',
    RideHeightSetting: 'RIDEHEIGHT', SlowBumpSetting: 'SLOWBUMP', FastBumpSetting: 'FASTBUMP',
    SlowReboundSetting: 'SLOWREBOUND', FastReboundSetting: 'FASTREBOUND', BrakeDiscSetting: 'BRAKEDISC', BrakePadSetting: 'BRAKEPAD' };
  const LMU_CORNERS = { FRONTLEFT: 'FL', FRONTRIGHT: 'FR', REARLEFT: 'RL', REARRIGHT: 'RR' };
  const LMU_SECTION_NAME = { GENERAL: 'General', FRONTWING: 'Aero', REARWING: 'Aero', BODYAERO: 'Cooling and ducts',
    SUSPENSION: 'Suspension', CONTROLS: 'Brakes and aids', ENGINE: 'Engine', DRIVELINE: 'Driveline',
    FRONTLEFT: 'Front left', FRONTRIGHT: 'Front right', REARLEFT: 'Rear left', REARRIGHT: 'Rear right', OTHER: 'Other' };
  const LMU_LABEL = { FWSetting: 'Front wing', RWSetting: 'Rear wing', FrontAntiSwaySetting: 'Front anti-roll bar',
    RearAntiSwaySetting: 'Rear anti-roll bar', RearBrakeSetting: 'Brake balance (front:rear)', TCSetting: 'Traction control',
    ABSSetting: 'ABS', TractionControlMapSetting: 'TC map', TCPowerCutMapSetting: 'TC power cut', TCSlipAngleMapSetting: 'TC slip angle',
    AntilockBrakeSystemMapSetting: 'ABS map', PackerSetting: 'Packers', SpringRubberSetting: 'Bump rubber' };

  // Reverse lookup: JSON key -> [section, svmKey]
  const LMU_JSON_TO_SVM = {};
  for (const sec of Object.keys(LMU_VEHICLE)) for (const k of Object.keys(LMU_VEHICLE[sec])) LMU_JSON_TO_SVM[LMU_VEHICLE[sec][k]] = [sec, k];
  for (const sec of Object.keys(LMU_CORNERS)) for (const k of Object.keys(LMU_WHEEL)) LMU_JSON_TO_SVM['WM_' + LMU_WHEEL[k] + '-W_' + LMU_CORNERS[sec]] = [sec, k];

  function lmuParam(section, key, raw, index, min, max, adjustable) {
    const n = parseNum(raw);
    return {
      id: (section + '/' + key).toLowerCase(), section: LMU_SECTION_NAME[section] || sentence(section),
      label: LMU_LABEL[key] || sentence(key.replace(/Setting$/, '')), raw: String(raw), num: n.num, unit: n.unit,
      index: index == null ? null : index, min: min == null ? null : min, max: max == null ? null : max,
      adjustable: adjustable, derived: false, role: null, axle: null, side: null,
    };
  }

  const LMU_SECTION_ORDER = ['GENERAL', 'FRONTWING', 'REARWING', 'BODYAERO', 'SUSPENSION', 'CONTROLS', 'ENGINE', 'DRIVELINE',
    'FRONTLEFT', 'FRONTRIGHT', 'REARLEFT', 'REARRIGHT', 'OTHER'];

  function orderLmu(params, secOf) {
    return params.map((p, i) => ({ p, i, s: LMU_SECTION_ORDER.indexOf(secOf.get(p)) }))
      .sort((a, b) => (a.s - b.s) || (a.i - b.i)).map((x) => x.p);
  }

  /* CarSetup JSON from the `metadata` table of an LMU .duckdb recording. */
  function fromLmuJson(json, meta) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    const params = [], secOf = new Map();
    for (const key of Object.keys(data || {})) {
      const e = data[key];
      if (!e || typeof e !== 'object' || !e.available) continue;
      const map = LMU_JSON_TO_SVM[key];
      let section = map ? map[0] : 'OTHER', svmKey = map ? map[1] : key.replace(/^[VW]M_/, '');
      const wm = !map && /^WM_(.+)-W_(FL|FR|RL|RR)$/.exec(key);
      if (wm) { section = Object.keys(LMU_CORNERS).find((k) => LMU_CORNERS[k] === wm[2]); svmKey = wm[1] + 'Setting'; }
      const raw = e.stringValue == null ? String(e.value) : String(e.stringValue).trim();
      // maxValue is the number of choices, so one choice means "cannot be changed".
      const adjustable = (e.maxValue - e.minValue) > 1 && !NOT_ADJ.test(raw);
      if (!map && !adjustable) continue;
      const p = lmuParam(section, svmKey, raw, e.value, e.minValue, e.maxValue == null ? null : e.maxValue - 1, adjustable);
      params.push(p); secOf.set(p, section);
    }
    return finish(Object.assign({ sim: 'lmu', source: 'telemetry', params: orderLmu(params, secOf), createdAt: Date.now() }, meta));
  }

  /* A saved LMU setup file (.svm): INI-like, `Key=index//display text`. */
  function fromSvm(text, meta) {
    const params = [], secOf = new Map();
    let section = 'GENERAL', vehicleClass = '';
    for (const line0 of String(text).split(/\r?\n/)) {
      const line = line0.trim();
      if (!line || line.startsWith('//')) continue;
      const sm = /^\[(.+)\]$/.exec(line);
      if (sm) { section = sm[1].toUpperCase(); continue; }
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim(), rest = line.slice(eq + 1);
      if (key === 'VehicleClassSetting') { vehicleClass = rest.replace(/^"|"$/g, '').trim(); continue; }
      if (/^(UpgradeSetting|Notes|Symmetric|CGHeightSetting|CGRightSetting|CGRearSetting)$/.test(key)) continue;
      const c = rest.indexOf('//');
      const valTxt = (c >= 0 ? rest.slice(0, c) : rest).trim();
      const disp = c >= 0 ? rest.slice(c + 2).trim() : valTxt;
      const idx = /^-?\d+$/.test(valTxt) ? parseInt(valTxt, 10) : null;
      const known = (LMU_VEHICLE[section] && LMU_VEHICLE[section][key]) || (LMU_CORNERS[section] && LMU_WHEEL[key]);
      const adjustable = !NOT_ADJ.test(disp);
      if (!known && !adjustable) continue;
      const p = lmuParam(section, key, disp, idx, null, null, adjustable);
      params.push(p); secOf.set(p, section);
    }
    const m = Object.assign({ sim: 'lmu', source: 'file', params: orderLmu(params, secOf), createdAt: Date.now() }, meta);
    if (!m.car && vehicleClass) m.car = vehicleClass;
    if (!m.carClass && vehicleClass) m.carClass = vehicleClass.split(/\s+/)[0];
    return finish(m);
  }

  /* ---------- queries ---------- */

  /* Parameters playing a role, optionally on one axle. Only ones the car lets you change. */
  function byRole(setup, role, axle) {
    if (!setup) return [];
    return setup.params.filter((p) => p.role === role && p.adjustable && !p.derived && (!axle || p.axle === axle || (!p.axle && axle === 'any')));
  }

  function describe(params) {
    if (!params.length) return '';
    const vals = Array.from(new Set(params.map((p) => p.raw)));
    return vals.join(' / ');
  }

  /* Row-by-row comparison of two setups. */
  function diff(a, b) {
    const rows = [], seen = new Set();
    const bMap = new Map((b ? b.params : []).map((p) => [p.id, p]));
    const push = (pa, pb) => {
      const ref = pa || pb;
      const same = pa && pb && (pa.index != null && pb.index != null ? pa.index === pb.index : norm(pa.raw) === norm(pb.raw));
      let numDelta = null, stepDelta = null;
      if (pa && pb && U.isNum(pa.num) && U.isNum(pb.num) && norm(pa.unit) === norm(pb.unit)) numDelta = pb.num - pa.num;
      if (pa && pb && pa.index != null && pb.index != null) stepDelta = pb.index - pa.index;
      rows.push({
        id: ref.id, section: ref.section, label: ref.label, role: ref.role, derived: !!ref.derived,
        adjustable: !!((pa && pa.adjustable) || (pb && pb.adjustable)),
        a: pa ? pa.raw : null, b: pb ? pb.raw : null, note: (pb && pb.note) || (pa && pa.note) || '',
        unit: ref.unit, numDelta, stepDelta, changed: !same, onlyIn: pa && pb ? null : pa ? 'a' : 'b',
      });
    };
    for (const pa of (a ? a.params : [])) { seen.add(pa.id); push(pa, bMap.get(pa.id) || null); }
    for (const pb of (b ? b.params : [])) if (!seen.has(pb.id)) push(null, pb);
    return rows;
  }

  /* Copy a setup so changes can be written onto it. */
  function clone(setup, meta) {
    const c = JSON.parse(JSON.stringify(setup));
    delete c.id; delete c.fingerprint;
    Object.assign(c, meta || {});
    c.createdAt = Date.now();
    return c;
  }

  /* Write a proposed change onto a parameter of a cloned setup.
     change = { steps, delta, text }.
       steps: move the LMU step index (only when the index range is known)
       delta: add to the numeric value, keeping the unit
       text : always kept as the human instruction */
  function applyChange(p, change) {
    // `was` / `wasIndex` remember the value before any proposed change, so a second
    // change to the same setting is still described relative to the original.
    const before = p.was != null ? p.was : p.raw;
    let moved = null;
    if (change.steps && p.index != null) {
      const from = p.wasIndex != null ? p.wasIndex : p.index;
      let idx = p.index + change.steps;
      if (p.min != null) idx = Math.max(p.min, idx);
      if (p.max != null) idx = Math.min(p.max, idx);
      moved = idx - p.index;
      if (moved === 0) return { moved: 0, atLimit: true };
      const total = idx - from;
      p.wasIndex = from; p.index = idx; p.num = null;
      p.raw = total === 0 ? before : Math.abs(total) + (Math.abs(total) === 1 ? ' step ' : ' steps ') + (total > 0 ? 'up' : 'down') + ' from ' + before;
    } else if ((U.isNum(change.delta) || U.isNum(change.to)) && U.isNum(p.num)) {
      // 'to' sets a value outright (used to bring a setting back inside the car's limits).
      let v = U.isNum(change.to) ? change.to : p.num + change.delta;
      const up = v > p.num;
      if (up && p.hi != null && p.num <= p.hi) v = Math.min(v, p.hi);
      if (!up && p.lo != null && p.num >= p.lo) v = Math.max(v, p.lo);
      if (Math.abs(v - p.num) < 1e-9) return { moved: 0, atLimit: true };
      const dec = (String(p.raw).match(/\.(\d+)/) || [0, ''])[1].length || (Math.abs(v - p.num) % 1 > 1e-9 ? 1 : 0);
      p.raw = (/^\s*\+/.test(before) && v > 0 ? '+' : '') + v.toFixed(dec) + (p.unit ? (p.unit === '%' ? '%' : ' ' + p.unit) : '');
      p.num = v; p.index = null; // the sim's step number for the new value is not known
    } else {
      p.raw = change.text + ' (from ' + before + ')';
    }
    p.note = change.text + (change.why ? ' — ' + change.why : '');
    p.was = before;
    return { moved, atLimit: false };
  }

  /* Why a setting cannot move further in a direction ('+' or '-'), or null if it can
     (or if the app cannot tell). LMU gives a step range. iRacing does not, so there
     the app relies on what the value itself says: a bar that reads "Disconnected"
     or a setting already at zero has nowhere lower to go. */
  const FLOOR_WORDS = /disconnect|detach|unhook|removed|not fitted|\bnone\b|\boff\b/i;
  const NEVER_NEGATIVE = { arb: 1, spring: 1, thirdSpring: 1, packers: 1, rearWing: 1, frontAero: 1, slowBump: 1, slowRebound: 1, fastBump: 1,
    fastRebound: 1, diffPreload: 1, diffPower: 1, diffCoast: 1, tc: 1, abs: 1, brakePressure: 1, engineBraking: 1 };
  const bareInteger = (p) => U.isNum(p.num) && !p.unit && /^\s*-?\d+\s*$/.test(String(p.was != null ? p.was : p.raw));
  /* learned: Map of "paramId|dir" -> { num, raw } limits the driver has reported for this car. */
  function limitReason(p, dir, learned) {
    if (p.index != null && p.min != null && p.max != null) {
      return (dir === '+' ? p.index >= p.max : p.index <= p.min) ? 'already at the end of its range (' + p.raw + ')' : null;
    }
    const raw = String(p.was != null ? p.was : p.raw).trim();
    // Known range for this car (STA.carLimits writes lo/hi onto the setting, in its own unit).
    if (U.isNum(p.num)) {
      const eps = 1e-6 + Math.abs(p.num) * 1e-4, unit = p.unit ? ' ' + p.unit : '';
      if (dir === '+' && p.hi != null && p.num >= p.hi - eps) return 'cannot go above ' + +p.hi.toFixed(2) + unit + ' on this car, ' + p.hiSrc;
      if (dir === '-' && p.lo != null && p.num <= p.lo + eps) return 'cannot go below ' + +p.lo.toFixed(2) + unit + ' on this car, ' + p.loSrc;
    }
    const L = learned && learned.get(p.id + '|' + dir);
    if (L) {
      if (U.isNum(L.num) && U.isNum(p.num)) { if (dir === '-' ? p.num <= L.num : p.num >= L.num) return 'cannot go ' + (dir === '-' ? 'below ' : 'above ') + L.raw + ' on this car'; }
      else if (norm(L.raw) === norm(raw)) return 'cannot go ' + (dir === '-' ? 'below ' : 'above ') + L.raw + ' on this car';
    }
    if (dir === '-' && FLOOR_WORDS.test(raw)) return 'already ' + raw.toLowerCase();
    if (dir === '-' && NEVER_NEGATIVE[p.role] && U.isNum(p.num) && p.num <= 0 && !/deg|°/i.test(p.unit || '')) return 'already at ' + raw;
    // A clutch-pack differential's lock on power is set as a count of friction faces, and 2 is the fewest it can run.
    if (dir === '-' && p.role === 'diffPower' && bareInteger(p) && p.num <= 2) return 'already at ' + raw + ', the lowest this setting goes';
    return null;
  }

  function refresh(setup) { delete setup.id; delete setup.fingerprint; return finish(setup); }

  STA.setup = { fromIracing, fromLmuJson, fromSvm, byRole, describe, diff, clone, applyChange, limitReason, refresh, parseNum, sentence, classify };
})(typeof window !== 'undefined' ? window : globalThis);
