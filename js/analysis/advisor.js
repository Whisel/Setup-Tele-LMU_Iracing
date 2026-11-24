/* Turns findings from handling.js into concrete setup changes for the setup
   that was on the car.

   The rules are the general ones race engineers use for any car. Each rule is a
   list of options in the order they are normally tried; the advisor keeps the
   first ones that the loaded car actually lets you adjust, and reports the rest
   as "not adjustable on this car". */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util, SU = () => STA.setup;

  /* What "+" and "−" mean for each kind of setting, and how big one sensible step is. */
  const ROLE = {
    arb: { name: 'anti-roll bar', t: ['Stiffen the {a} anti-roll bar', 'Soften the {a} anti-roll bar'], by: '1 step', index: true, intStep: 1 },
    spring: { name: 'springs', t: ['Stiffen the {a} springs', 'Soften the {a} springs'], by: '1 step', index: true },
    thirdSpring: { name: 'third/heave spring', t: ['Stiffen the {a} third (heave) spring', 'Soften the {a} third (heave) spring'], by: '1 step', index: true },
    packers: { name: 'packers / bump stops', t: ['Add {a} packers', 'Remove {a} packers'], by: '1 step', index: true },
    rideHeight: { name: 'ride height', t: ['Raise the {a} ride height', 'Lower the {a} ride height'], by: 'about 1 mm', index: true, units: { mm: 1, cm: 0.1, m: 0.001, in: 0.04 } },
    rearWing: { name: 'rear wing', t: ['Add rear wing', 'Take off rear wing'], by: '1 step', index: true, intStep: 1, fixedAxle: true },
    frontAero: { name: 'front aero', t: ['Add front downforce', 'Take off front downforce'], by: '1 step', index: true, intStep: 1, fixedAxle: true },
    // Read from the setup and compared between runs, but not moved by the advice: their steps are fixed choices.
    rearAeroPart: { name: 'rear gurney / beam wing', t: ['Add rear gurney or beam wing', 'Take off rear gurney or beam wing'], by: '1 step', fixedAxle: true },
    frontAeroPart: { name: 'front flap gurney / type', t: ['Add front flap gurney or a bigger flap', 'Take off front flap gurney or fit a smaller flap'], by: '1 step', fixedAxle: true },
    aeroTrim: { name: 'aero package', t: ['Fit a higher-downforce aero package', 'Fit a lower-downforce aero package'], by: '1 step' },
    pressure: { name: 'tyre pressure', t: ['Raise the {a} tyre pressures', 'Lower the {a} tyre pressures'], by: 'about 0.5 psi (3–4 kPa)', index: true, indexSteps: 3, units: { kpa: 3.5, psi: 0.5, bar: 0.03 } },
    camber: { name: 'camber', t: ['Reduce negative camber on the {a} wheels', 'Add negative camber on the {a} wheels'], by: '0.2°', units: { deg: 0.2, '°': 0.2 } },
    toe: { name: 'toe', t: ['Add toe-in on the {a} wheels', 'Add toe-out on the {a} wheels'], by: 'one small step' },
    slowBump: { name: 'slow bump damping', t: ['Stiffen the {a} slow bump damping', 'Soften the {a} slow bump damping'], by: '1–2 clicks', index: true, intStep: 1 },
    slowRebound: { name: 'slow rebound damping', t: ['Stiffen the {a} slow rebound damping', 'Soften the {a} slow rebound damping'], by: '1–2 clicks', index: true, intStep: 1 },
    fastBump: { name: 'fast bump damping', t: ['Stiffen the {a} fast bump damping', 'Soften the {a} fast bump damping'], by: '1–2 clicks', index: true, intStep: 1 },
    fastRebound: { name: 'fast rebound damping', t: ['Stiffen the {a} fast rebound damping', 'Soften the {a} fast rebound damping'], by: '1–2 clicks', index: true, intStep: 1 },
    brakeBias: { name: 'brake bias', t: ['Move brake bias forward', 'Move brake bias rearward'], by: '0.5%', units: { '%': 0.5 } },
    brakePressure: { name: 'brake pressure', t: ['Raise brake pressure', 'Lower brake pressure'], by: '1 step', index: true },
    brakeDuct: { name: 'brake ducts', t: ['Close the {a} brake ducts', 'Open the {a} brake ducts'], by: '1 step', index: true },
    diffPreload: { name: 'differential preload', t: ['Increase differential preload', 'Reduce differential preload'], by: '1 step', index: true },
    diffPower: { name: 'differential lock on power', t: ['Increase differential lock on power', 'Reduce differential lock on power'], by: '1 step', index: true },
    diffCoast: { name: 'differential lock off power', t: ['Increase differential lock off power', 'Reduce differential lock off power'], by: '1 step', index: true },
    tc: { name: 'traction control', t: ['Raise traction control', 'Lower traction control'], by: '1 step (towards more intervention)' },
    abs: { name: 'ABS', t: ['Raise ABS', 'Lower ABS'], by: '1 step' },
    engineBraking: { name: 'engine braking', t: ['Increase engine braking', 'Reduce engine braking'], by: '1 step' },
    finalDrive: { name: 'final drive / top gear', t: ['Lengthen the final drive or top gear', 'Shorten the final drive or top gear'], by: '1 step' },
  };

  function titleFor(role, dir, axle) {
    const R = ROLE[role];
    return R.t[dir === '+' ? 0 : 1].replace('{a} ', axle ? axle + ' ' : '').replace(/\s+/g, ' ');
  }
  function labelFor(role, axle) {
    const R = ROLE[role], txt = (axle && !R.fixedAxle ? axle + ' ' : '') + R.name;
    return txt.charAt(0).toUpperCase() + txt.slice(1);
  }

  const FRONT_ONLY = { camber: 1, toe: 1, pressure: 1, frontAero: 1, slowBump: 1, slowRebound: 1, fastBump: 1, fastRebound: 1 };

  // option = [role, axle, direction, effect, trade-off]
  const o = (role, axle, dir, effect, cost) => ({ role, axle, dir, effect, cost });

  const RULES = {
    'understeer|entry|slow': [
      o('brakeBias', null, '-', 'Shifts braking effort rearward so the front tyres keep more grip for turning in.', 'Too far and the rear becomes nervous under braking.'),
      o('diffCoast', null, '-', 'Lets the rear wheels turn at different speeds off-throttle, so the car rotates more easily.', 'Less stability when lifting or trail-braking.'),
      o('arb', 'front', '-', 'More front grip in roll.', 'Slower response on turn-in.'),
      o('slowBump', 'front', '-', 'Lets weight move onto the front tyres sooner as you brake and turn.', 'More dive under braking.'),
      o('toe', 'front', '-', 'Sharper initial turn-in.', 'More tyre drag and wear on the straights.'),
    ],
    'understeer|entry|fast': [
      o('frontAero', 'front', '+', 'More front downforce for high-speed turn-in.', 'Slightly more drag.'),
      o('rearWing', 'rear', '-', 'Moves aero balance forward and cuts drag.', 'Less rear stability in fast corners and under braking.'),
      o('rideHeight', 'front', '-', 'More rake moves aero balance forward.', 'Front may touch the ground under braking.'),
      o('arb', 'front', '-', 'More front grip in roll.', 'Slower response.'),
    ],
    'understeer|mid|slow': [
      o('arb', 'front', '-', 'More mechanical front grip mid-corner.', 'Slower change of direction.'),
      o('arb', 'rear', '+', 'Moves roll stiffness rearward so the front grips better.', 'Less traction on exit.'),
      o('spring', 'front', '-', 'More mechanical front grip.', 'More dive and a lower front under braking.'),
      o('camber', 'front', '-', 'Larger front contact patch when loaded.', 'Worse braking grip and more inner-edge heat.'),
      o('diffPreload', null, '-', 'Frees the rear axle so the car rotates around the apex.', 'Less stable on entry and less drive off slow corners.'),
      o('rideHeight', 'rear', '+', 'A little more rake shifts grip to the front.', 'Less rear stability.'),
    ],
    'understeer|mid|fast': [
      o('frontAero', 'front', '+', 'More front downforce.', 'Slightly more drag.'),
      o('rearWing', 'rear', '-', 'Moves aero balance forward and cuts drag.', 'Less rear grip in every fast corner.'),
      o('rideHeight', 'rear', '+', 'More rake moves aero balance forward.', 'Less rear stability.'),
      o('arb', 'front', '-', 'More front grip in roll.', 'Slower response.'),
    ],
    'understeer|exit|slow': [
      o('diffPower', null, '-', 'Less lock under power stops the rear axle pushing the car straight on.', 'More inside-wheel spin.'),
      o('diffPreload', null, '-', 'Frees the rear axle on throttle pick-up.', 'Less drive off slow corners.'),
      o('arb', 'rear', '+', 'Moves roll stiffness rearward so the front keeps its grip on throttle.', 'Less traction.'),
      o('slowRebound', 'front', '-', 'Lets the front extend so its tyres stay in contact as weight moves rearward.', 'Less platform control.'),
    ],
    'understeer|exit|fast': [
      o('rearWing', 'rear', '-', 'Moves aero balance forward.', 'Less rear stability.'),
      o('frontAero', 'front', '+', 'More front downforce.', 'Slightly more drag.'),
      o('arb', 'rear', '+', 'Moves roll stiffness rearward.', 'Less traction.'),
    ],
    'oversteer|entry|slow': [
      o('brakeBias', null, '+', 'Shifts braking effort forward so the rear stays planted on entry.', 'Too far and the fronts lock or the car will not turn in.'),
      o('diffCoast', null, '+', 'Ties the rear wheels together off-throttle, which steadies the rear.', 'More entry understeer.'),
      o('engineBraking', null, '-', 'Less engine drag on the rear axle when you lift.', 'Slightly longer braking distances.'),
      o('slowRebound', 'rear', '-', 'Keeps the rear tyres loaded as weight moves forward.', 'More pitch.'),
      o('toe', 'rear', '+', 'Rear toe-in steadies the car on entry.', 'More drag and rear tyre heat.'),
      o('arb', 'front', '+', 'Moves roll stiffness forward.', 'Less front grip mid-corner.'),
    ],
    'oversteer|entry|fast': [
      o('rearWing', 'rear', '+', 'More rear downforce for fast turn-in and braking.', 'More drag.'),
      o('brakeBias', null, '+', 'Steadies the rear under braking.', 'Risk of front locking.'),
      o('rideHeight', 'rear', '-', 'Less rake moves aero balance rearward.', 'Less front bite.'),
    ],
    'oversteer|mid|slow': [
      o('arb', 'rear', '-', 'More mechanical rear grip mid-corner.', 'More understeer.'),
      o('arb', 'front', '+', 'Moves roll stiffness forward.', 'Less front grip.'),
      o('spring', 'rear', '-', 'More mechanical rear grip.', 'More squat; rear may run lower.'),
      o('toe', 'rear', '+', 'Rear toe-in adds stability.', 'More drag and rear tyre heat.'),
      o('rideHeight', 'rear', '-', 'Less rake shifts grip to the rear.', 'Less front bite.'),
    ],
    'oversteer|mid|fast': [
      o('rearWing', 'rear', '+', 'More rear downforce.', 'More drag.'),
      o('rideHeight', 'rear', '-', 'Less rake moves aero balance rearward.', 'Less front bite.'),
      o('arb', 'rear', '-', 'More rear grip in roll.', 'More understeer.'),
    ],
    'oversteer|exit|slow': [
      o('tc', null, '+', 'Cuts power sooner when the rear tyres start to slip.', 'Slower if set too high.'),
      o('arb', 'rear', '-', 'More rear grip as power goes down.', 'More understeer mid-corner.'),
      o('spring', 'rear', '-', 'More traction.', 'More squat.'),
      o('slowBump', 'rear', '-', 'Lets the rear squat and take load as you apply power.', 'Less platform control.'),
      o('diffPower', null, '-', 'Less lock makes power oversteer more progressive.', 'More inside-wheel spin.'),
      o('pressure', 'rear', '-', 'Larger rear contact patch.', 'More tyre heat on long runs.'),
    ],
    'oversteer|exit|fast': [
      o('rearWing', 'rear', '+', 'More rear downforce.', 'More drag.'),
      o('arb', 'rear', '-', 'More rear grip.', 'More understeer.'),
    ],
    frontLock: [
      o('brakeBias', null, '-', 'Takes braking effort off the front tyres.', 'Rear becomes less stable under braking.'),
      o('brakePressure', null, '-', 'Makes it harder to exceed the tyres with the pedal.', 'Longer pedal effort for the same stop.'),
      o('abs', null, '+', 'More ABS intervention.', 'Slightly longer stops.'),
    ],
    rearLock: [
      o('brakeBias', null, '+', 'Takes braking effort off the rear tyres.', 'Front may lock sooner.'),
      o('engineBraking', null, '-', 'Less engine drag on the rear axle.', 'Slightly longer stops.'),
      o('diffCoast', null, '+', 'Shares braking between the rear wheels.', 'More entry understeer.'),
    ],
    wheelspin: [
      o('tc', null, '+', 'Cuts power when the driven tyres slip.', 'Slower if set too high.'),
      o('arb', 'rear', '-', 'More rear grip under power.', 'More mid-corner understeer.'),
      o('spring', 'rear', '-', 'More traction.', 'More squat.'),
      o('diffPower', null, '+', 'Drives both wheels when one spins.', 'More exit understeer; can snap if both break away.'),
      o('pressure', 'rear', '-', 'Larger contact patch.', 'More heat.'),
    ],
    traction: [
      o('tc', null, '+', 'Cuts power sooner when the rear tyres start to slip.', 'Slower if set too high.'),
      o('arb', 'rear', '-', 'More rear grip as power goes down.', 'More mid-corner understeer.'),
      o('slowBump', 'rear', '-', 'Lets the rear take load as you apply power.', 'Less platform control.'),
      o('spring', 'rear', '-', 'More traction.', 'More squat.'),
    ],
    camberTooMuch: [o('camber', '@', '+', 'Spreads load across the tread.', 'A little less peak cornering grip.')],
    camberTooLittle: [o('camber', '@', '-', 'Uses more of the tyre in corners.', 'Less straight-line braking and traction grip.')],
    pressureHigh: [o('pressure', '@', '-', 'Flattens the contact patch.', 'More rolling drag and heat if taken too far.')],
    pressureLow: [o('pressure', '@', '+', 'Supports the middle of the tread.', 'Less grip if taken too far.')],
    bottoming: [
      o('rideHeight', '@', '+', 'Stops the floor touching down.', 'Less downforce and a higher centre of gravity.'),
      o('packers', '@', '+', 'Limits travel without changing static height.', 'Harsh when the car reaches them.'),
      o('thirdSpring', '@', '+', 'Holds the car up as downforce builds.', 'Less compliance over bumps.'),
      o('spring', '@', '+', 'Holds the car up.', 'Less mechanical grip.'),
    ],
    limiter: [o('finalDrive', null, '+', 'Raises the speed at which top gear runs out.', 'Slightly weaker acceleration.')],
    brakeHot: [o('brakeDuct', '@', '-', 'More cooling air to the discs.', 'More drag and cooler tyres.')],
  };

  function ruleFor(f) {
    if (f.kind === 'understeer' || f.kind === 'oversteer') {
      const speed = f.band === 'high' ? 'fast' : 'slow';
      const list = RULES[f.kind + '|' + f.phase + '|' + speed] || [];
      // Medium-speed corners feel both mechanical and aero changes: lead with mechanical, then aero.
      if (f.band === 'medium' || f.band === 'all') {
        const aero = (RULES[f.kind + '|' + f.phase + '|fast'] || []).filter((x) => x.role === 'rearWing' || x.role === 'frontAero');
        return list.slice(0, 3).concat(aero.slice(0, 1), list.slice(3));
      }
      return list;
    }
    return RULES[f.kind] || [];
  }

  /* mult scales the step (the baseline builder can ask for two or three steps). */
  function buildChange(role, dir, params, mult) {
    const R = ROLE[role], sign = dir === '+' ? 1 : -1, m = mult || 1;
    const p = params[0], unit = String(p.unit || '').toLowerCase();
    let by = R.by;
    if (m > 1) by = /^1 step/.test(R.by) ? R.by.replace('1 step', m + ' steps') : /clicks/.test(R.by) ? m * 2 + ' clicks' : R.by.replace(/(\d+(\.\d+)?)/, (x) => String(+(parseFloat(x) * m).toFixed(2)));
    const change = { by, text: titleFor(role, dir, p.axle && !R.fixedAxle && params.every((q) => q.axle === p.axle) ? p.axle : null) + ' by ' + by };
    if (R.units && U.isNum(p.num) && R.units[unit] != null) change.delta = sign * m * R.units[unit];
    else if (R.index && p.index != null && p.max != null) change.steps = sign * m * (R.indexSteps || 1);
    else if (R.intStep && U.isNum(p.num) && !p.unit && /^\s*-?\d+\s*$/.test(p.raw)) change.delta = sign * m * R.intStep;
    // Never step past what the car allows: shorten the step to land on the limit.
    if (change.delta != null) {
      let room = Infinity, bound = null;
      for (const q of params) {
        const b = sign > 0 ? q.hi : q.lo;
        if (b == null || !U.isNum(q.num)) continue;
        const r = Math.max(0, sign * (b - q.num));
        if (r < room) { room = r; bound = b; }
      }
      if (room < Math.abs(change.delta) - 1e-9) {
        change.delta = sign * room; change.cappedAt = bound;
        change.text = change.text.replace(/ by .*$/, '') + ' to ' + +bound.toFixed(2) + (p.unit ? ' ' + p.unit : '') + ', the limit for this car';
      }
    }
    if (role === 'brakeBias' && change.delta == null && U.isNum(p.num) && p.num > 30 && p.num < 80) {
      change.text += ' (to about ' + (p.num + sign * m * 0.5).toFixed(1) + '% front)';
    }
    return change;
  }

  /* Other ways to get the same balance change when the first choice cannot be used
     (the setting does not exist on the car, is at the end of its range, or the
     driver has marked it as not possible). Ordered closest-equivalent first. */
  function equivalents(role, axle, dir) {
    const other = axle === 'front' ? 'rear' : axle === 'rear' ? 'front' : null, flip = dir === '+' ? '-' : '+';
    const softer = dir === '-';
    if (role === 'arb' && other) return [
      o('arb', other, flip, 'Shifts roll stiffness between the axles the same way, from the other end of the car.', 'Total roll stiffness goes ' + (softer ? 'up' : 'down') + ', so the car rolls ' + (softer ? 'less' : 'more') + ' overall.'),
      o('spring', axle, dir, (softer ? 'Softer' : 'Stiffer') + ' springs change grip at this end the same way the bar would.', softer ? 'More pitch and a lower ride height at this end under load.' : 'Less compliance over bumps at this end.'),
    ];
    if (role === 'spring' && other) return [
      o('arb', axle, dir, 'Changes roll stiffness at this end without altering ride height.', softer ? 'Slower change of direction.' : 'Less grip at this end in roll.'),
      o('spring', other, flip, 'Shifts the stiffness balance between the axles the same way.', 'Changes ride height and pitch at the other end.'),
    ];
    if (role === 'rearWing') return [o('frontAero', 'front', flip, 'Moves the aero balance the same way from the front of the car.', dir === '+' ? 'Less total downforce.' : 'More drag.')];
    if (role === 'frontAero') return [o('rearWing', 'rear', flip, 'Moves the aero balance the same way from the rear of the car.', dir === '+' ? 'Less total downforce and less rear stability.' : 'More drag.')];
    if (role === 'rideHeight' && other) return [o('rideHeight', other, flip, 'Changes the rake of the car the same way from the other axle.', 'Moves the whole car ' + (flip === '+' ? 'up, costing some downforce.' : 'down, closer to bottoming.'))];
    return [];
  }

  const blockKey = (role, axle, dir) => role + '|' + (axle || '') + '|' + dir;

  /* Why a driver contested a suggested change. Any of these takes the change out of the
     advice for that car until it is allowed again, and the next route is offered instead. */
  const CONTEST = {
    tradeoff: { label: 'I do not want this trade-off', text: 'trade-off not wanted' },
    none: { label: 'I tried it and it did not help', text: 'tried, did not help' },
    worse: { label: 'I tried it and it made the car worse', text: 'tried, made it worse' },
  };
  const contestText = (e) => (CONTEST[e && e.reason] || CONTEST.tradeoff).text;

  /* Settings for an option on this setup, and why it cannot be used if it cannot. */
  function resolve(setup, role, axle, dir, guard) {
    // guard = { blocked: Set of "role|axle|dir", limits: Map of "paramId|dir" -> limit,
    //           contested: Map of "role|axle|dir" -> { reason } }. A bare Set is accepted as `blocked`.
    const blocked = guard instanceof Set ? guard : guard && guard.blocked, limits = guard instanceof Set ? null : guard && guard.limits;
    const contested = guard instanceof Set ? null : guard && guard.contested;
    let params = SU().byRole(setup, role, axle || undefined);
    if (role === 'brakeBias') params = params.filter((p) => !/fine|peak|migration/.test(p.id)).slice(0, 1);
    if (role === 'tc' || role === 'abs') params = params.filter((p) => U.isNum(p.num)).slice(0, 1);
    const label = labelFor(role, axle);
    if (!params.length) return { params, why: label + ' (not adjustable on this car)' };
    if (blocked && blocked.has(blockKey(role, axle, dir))) return { params: [], why: titleFor(role, dir, axle) + ' (you marked this as not possible)' };
    if (contested && contested.has(blockKey(role, axle, dir))) return { params: [], contested: true, why: titleFor(role, dir, axle) + ' (' + contestText(contested.get(blockKey(role, axle, dir))) + ')' };
    const stuck = params.map((p) => SU().limitReason(p, dir, limits));
    if (stuck.every(Boolean)) return { params: [], why: label + ' (' + stuck[0] + ')' };
    return { params: params.filter((p, i) => !stuck[i]), why: null };
  }

  /* Settings that are outside what the car allows come first: nothing else matters until the
     setup is legal. One suggestion per kind of setting and axle. */
  function fixViolations(setup, suggestions, byKey) {
    if (!STA.carLimits) return [];
    const list = STA.carLimits.violations(setup), groups = new Map();
    for (const v of list) {
      if (!v.p.role || !ROLE[v.p.role]) continue;
      const key = v.p.role + '|' + (v.p.axle || '');
      const g = groups.get(key) || { key, role: v.p.role, axle: v.p.axle || null, side: v.side, bound: v.bound, src: v.src, params: [] };
      g.params.push(v.p); groups.set(key, g);
    }
    for (const g of groups.values()) {
      const dir = g.side === 'above' ? '-' : '+', unit = g.params[0].unit ? ' ' + g.params[0].unit : '', to = +g.bound.toFixed(2) + unit;
      const title = titleFor(g.role, dir, g.axle) + ' to ' + to;
      const s = {
        key: g.key, blockKey: blockKey(g.role, g.axle, dir), role: g.role, axle: g.axle, dir, title, amount: '', fix: true,
        paramIds: g.params.map((p) => p.id), current: SU().describe(g.params), change: { text: title, to: g.bound },
        effect: 'Limit: ' + (g.side === 'above' ? 'max ' : 'min ') + to + ' (' + g.src.replace(/^from the /, '') + '). Do this first; the car can fail tech inspection as it is.',
        cost: '', reasons: [labelFor(g.role, g.axle) + ' ' + g.side + ' the limit'], findingIds: [],
        confidence: /manual/.test(g.src) ? 'high' : 'medium', primary: true, insteadOf: null, score: 100,
      };
      byKey.set(g.key, s); suggestions.push(s);
    }
    return list;
  }

  /* What earlier sessions say about a change on this car (see learning.js), as a score
     factor and a sentence. stats = { tried, helped, none, hurt }. */
  function applyHistory(s, outcomes) {
    const all = outcomes && outcomes.get(s.blockKey);
    // The record for this particular problem when there is one, otherwise the change's record overall.
    const st = all && all.by && s.targetKey && all.by[s.targetKey] ? all.by[s.targetKey] : all;
    if (!st || !st.tried) return;
    s.history = st;
    s.score *= U.clamp(1 + 0.3 * (st.helped - st.hurt) - 0.15 * st.none, 0.4, 1.6);
    // Lap time gained where the change acts counts on top: a tenth of a second is worth a fifth more.
    const avg = st.timed ? st.time / st.timed : null;
    if (avg != null) s.score *= U.clamp(1 - 2 * avg, 0.6, 1.5);
    // Only results that showed no effect at all count against it; "problem smaller but no time gained" does not.
    if (st.helped === 0 && st.hurt + (st.dead != null ? st.dead : st.none) >= 2) s.demoted = true;
    const n = (k, word) => (k ? k + ' ' + word : null);
    s.historyText = 'On this car before: ' + [n(st.helped, 'helped'), n(st.none, 'no effect'), n(st.hurt, 'worse')].filter(Boolean).join(', ') + (s.demoted ? '. Listed last.' : '.')
      + (avg != null && Math.abs(avg) >= 0.03 ? ' About ' + Math.abs(avg).toFixed(2) + ' s a lap ' + (avg < 0 ? 'faster' : 'slower') + '.' : '');
  }

  /* The wing level is a lap-time question, not a handling one, so it gets its own entry:
     - the last wing step at this track gained time: offer another the same way
     - it cost time: offer the step back
     - never tried here, and half the lap or more is on the straights: offer one step less as an experiment
     pace: { shares: { S, B, L, M, H }, track, when }.  Returns a finding-like object, or null.
     Only wing steps made up to this session count (when), so looking back at an older run
     does not answer with something learned later from a different wing level. */
  function paceFinding(analysis, setup, outcomes, pace) {
    if (!pace || !pace.track) return null;
    const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const trials = [];
    for (const dir of ['-', '+']) {
      const st = outcomes && outcomes.get(blockKey('rearWing', 'rear', dir));
      for (const t of (st && st.trials) || []) {
        if (t.net == null || !STA.library || !STA.library.sameTrack(t.track, pace.track)) continue;
        if (t.cause !== 'paceGain' && t.cause !== 'paceLoss' && t.cause !== 'paceEven') continue;
        trials.push(Object.assign({ dir, a: num(t.from), b: num(t.to) }, t));
      }
    }
    trials.sort((x, y) => x.when - y.when);
    const COST = { '-': 'Less grip in fast corners and under braking.', '+': 'More drag: lower top speed.' };
    const base = { id: 'pace-wing', kind: 'pace', title: 'Lap time', severity: 0.45 };
    const secs = (v) => Math.abs(v).toFixed(2) + ' s a lap';
    if (!trials.length) {
      // Never tried here: an experiment, only where the straights are half the lap and the rear is stable.
      const unstable = analysis.findings.some((f) => (f.kind === 'oversteer' && f.band === 'high') || f.kind === 'rearLock');
      if (!pace.shares || pace.shares.S < 0.5 || unstable) return null;
      return Object.assign(base, { severity: 0.25, confidence: 'low',
        option: o('rearWing', 'rear', '-', 'An experiment: ' + Math.round(pace.shares.S * 100) + '% of this lap is on the straights. Judge it on lap time in the next run, not on feel.', COST['-']) });
    }
    // Lap time of every wing level tried at this track, against the first one. Each trial links two levels.
    const level = new Map(), shaky = new Set();
    for (const t of trials) {
      if (t.a == null || t.b == null) continue;
      if (level.has(t.a)) level.set(t.b, level.get(t.a) + t.net);
      else if (level.has(t.b)) level.set(t.a, level.get(t.b) - t.net);
      else { level.clear(); shaky.clear(); level.set(t.a, 0); level.set(t.b, t.net); }
      if (t.shared) { shaky.add(t.a); shaky.add(t.b); }
    }
    const wp = SU().byRole(setup, 'rearWing', 'rear')[0] || SU().byRole(setup, 'rearWing')[0];
    const now = wp ? (U.isNum(wp.num) ? wp.num : num(wp.raw)) : null;
    if (now == null || !level.has(now)) return null; // a level with no lap time on record: nothing to go on
    const SIG = 0.05, at = level.get(now);
    let best = now;
    for (const [lv, t] of level) if (t < level.get(best)) best = lv;
    // A gap of three times the noise floor from clean runs is medium; smaller, or shared with other changes, is low.
    const conf = (lv, gap) => (shaky.has(lv) || shaky.has(now) || gap < 3 * SIG ? 'low' : 'medium');
    if (at - level.get(best) >= SIG) {
      const dir = best < now ? '-' : '+';
      return Object.assign(base, { confidence: conf(best, at - level.get(best)),
        option: o('rearWing', 'rear', dir, 'Wing ' + best + ' was ' + secs(at - level.get(best)) + ' faster than ' + now + ' here. This goes back toward it.', COST[dir]) });
    }
    // On the best level tried. Go on only where the gain came from one side and the other is untried.
    const lower = Array.from(level.keys()).filter((lv) => lv < now), higher = Array.from(level.keys()).filter((lv) => lv > now);
    const nearest = (list, pick) => (list.length ? pick.apply(null, list) : null);
    const hi = nearest(higher, Math.min), lo = nearest(lower, Math.max);
    const up = hi == null ? null : level.get(hi) - at, down = lo == null ? null : level.get(lo) - at;
    const on = (other, gap) => 'Wing ' + now + ' is ' + secs(gap) + ' faster than ' + other + ' here. One more step the same way may gain again; judge it on lap time.';
    if (up != null && down == null && up >= SIG) {
      return Object.assign(base, { confidence: conf(hi, up),
        option: o('rearWing', 'rear', '-', on(hi, up), COST['-']) });
    }
    if (down != null && up == null && down >= SIG) {
      return Object.assign(base, { confidence: conf(lo, down),
        option: o('rearWing', 'rear', '+', on(lo, down), COST['+']) });
    }
    return null; // slower both ways, or no real difference: leave the wing where it is
  }

  /* findings + the setup on the car -> ordered suggestions.
     opts.blocked:  Set of "role|axle|dir" keys the driver has ruled out altogether.
     opts.limits:   Map of "paramId|dir" -> { num, raw } limits the driver has reported.
     opts.track:    track name, for limits that only apply at one circuit.
     opts.outcomes: Map of "role|axle|dir" -> { tried, helped, none, hurt } from earlier sessions.
     opts.contested: Map of "role|axle|dir" -> { reason } for changes the driver has contested.
     opts.learned:  Map of problem ("understeer|mid") -> [{ role, axle, dir, n }], changes that cut that
                    problem on this car although they are not a textbook answer to it (see learning.js).
     opts.pace:     { shares, track } of this session's best lap, for the wing-level entry (see paceFinding). */
  function advise(analysis, setup, opts) {
    const suggestions = [], skipped = [], exhausted = [], byKey = new Map();
    const blocked = { blocked: (opts && opts.blocked) || null, limits: (opts && opts.limits) || null, contested: (opts && opts.contested) || null };
    if (!setup) return { suggestions, skipped, exhausted, violations: [], car: null, note: 'This file has no setup stored in it, so advice is given as findings only. Load the setup to get specific changes.' };
    const car = STA.carLimits ? STA.carLimits.apply(setup, opts && opts.track, blocked.limits) : null;
    const violations = fixViolations(setup, suggestions, byKey);

    const outs = (opts && opts.outcomes) || null, learned = (opts && opts.learned) || null;
    // Handling findings first; the wing-level question last, so a handling need for the wing wins.
    const wing = paceFinding(analysis, setup, outs, opts && opts.pace);
    for (const f of analysis.findings.concat(wing ? [wing] : [])) {
      const tk = STA.learning ? STA.learning.targetKey(f) : null;
      // What this car has taught the app comes before the general rules.
      const own = ((learned && tk && learned.get(tk)) || []).map((e) => ({ role: e.role, axle: e.axle, dir: e.dir, learned: e.n, lone: true,
        effect: 'Cut this problem on this car before (' + e.n + (e.n === 1 ? ' run' : ' runs') + '). Learned from your own runs; not a textbook answer.', cost: 'Based on your runs only' }));
      let list = f.option ? [Object.assign({ lone: true }, f.option)] : own.concat(ruleFor(f));
      // Understeer on a car whose rear also slides: only changes that add front grip without
      // taking load or stability from the rear (no bars, springs, wing, differential or brake bias).
      if (f.rearFirst) list = list.filter((x) => FRONT_ONLY[x.role] && (x.axle === 'front' || (x.axle === '@' && f.axle === 'front') || x.role === 'frontAero')).map((x) => Object.assign({ lone: true }, x));
      let taken = 0;
      const unavailable = [], contestedHere = [];
      // A suggestion that stands in for a contested one says so.
      const standIn = (s) => { if (contestedHere.length) s.alternativeTo = Array.from(new Set((s.alternativeTo || []).concat(contestedHere))); };
      for (const first of list) {
        if (taken >= 2) break;
        const axle0 = first.axle === '@' ? f.axle : first.axle;
        // The option itself, then the closest equivalents if it cannot be used.
        const tries = [Object.assign({}, first, { axle: axle0 })].concat(first.lone ? [] : equivalents(first.role, axle0, first.dir));
        let failedWhy = null;
        for (const opt of tries) {
          const axle = opt.axle || null;
          const r = resolve(setup, opt.role, axle, opt.dir, blocked);
          if (!r.params.length) { unavailable.push(r.why); if (r.contested) contestedHere.push(r.why); if (!failedWhy) failedWhy = r.why; continue; }
          const key = opt.role + '|' + (axle || '');
          const existing = byKey.get(key);
          if (existing) {
            if (existing.dir === opt.dir && existing.fix) { existing.reasons.push(f.title); existing.findingIds.push(f.id); continue; }
            // Already suggested for this same finding (as a stand-in for an earlier option): do not count it twice.
            if (existing.dir === opt.dir && !existing.fix && existing.findingIds.indexOf(f.id) >= 0) break;
            if (existing.dir === opt.dir) { existing.reasons.push(f.title); existing.findingIds.push(f.id); existing.score += f.severity * 0.5; standIn(existing); taken++; break; }
            if (existing.fix) continue; // moving it back inside the limit is not optional
            existing.conflict = (existing.conflict || []).concat(f.title);
            if (f.felt || f.agreed) existing.againstFelt = true;
            continue; // wanted the other way round for another finding: look for a different route
          }
          // One step moved it the right way but not enough last time: offer two.
          const past = outs && outs.get(blockKey(opt.role, axle, opt.dir)), mine = past && past.by && tk ? past.by[tk] : null;
          const bigger = !!(mine && !mine.helped && mine.last === 'tooSmall');
          const change = buildChange(opt.role, opt.dir, r.params, bigger ? 2 : 1);
          const s = {
            key, blockKey: blockKey(opt.role, axle, opt.dir), role: opt.role, axle, dir: opt.dir, title: change.cappedAt != null ? change.text : titleFor(opt.role, opt.dir, axle),
            amount: change.cappedAt != null ? '' : change.by, targetKey: tk, learned: opt.learned || 0, bigger, paramIds: r.params.map((p) => p.id), current: SU().describe(r.params), change,
            effect: opt.effect, cost: opt.cost, reasons: [f.title], findingIds: [f.id], confidence: f.confidence, primary: taken === 0,
            insteadOf: opt === tries[0] ? null : failedWhy, score: f.severity * (taken === 0 ? 1 : 0.6),
          };
          standIn(s);
          byKey.set(key, s); suggestions.push(s); taken++;
          break;
        }
      }
      if (unavailable.length) skipped.push({ finding: f.title, items: Array.from(new Set(unavailable)) });
      // Every setup route contested or unavailable: what is left is the driving.
      if (!taken && contestedHere.length) exhausted.push({ finding: f.title, contested: Array.from(new Set(contestedHere)), tips: STA.technique ? STA.technique.forFinding(f) : [] });
    }
    // The wing-level entry is already built from the lap times on record, so its history is not counted twice.
    for (const s of suggestions) if (!s.fix && !(s.findingIds.length === 1 && s.findingIds[0] === 'pace-wing')) applyHistory(s, opts && opts.outcomes);
    // The driver's own ideas, checked and ranked with the app's.
    const mine = addIdeas(opts && opts.ideas, analysis.findings, setup, blocked, outs, learned, suggestions, byKey);
    // Limit fixes first, then first-choice fixes, then the alternatives; changes that have not worked on this car go last.
    // Changes that only serve understeer on a car whose rear slides come after everything for the rear.
    const waits = new Set(analysis.findings.filter((f) => f.rearFirst).map((f) => f.id));
    for (const s of suggestions) if (!s.fix && s.findingIds.length && s.findingIds.every((id) => waits.has(id))) s.rearFirst = true;
    // A change that works against something the driver felt goes below the ones that do not.
    for (const s of suggestions) if (s.againstFelt && !s.yours && !s.fix) { s.primary = false; s.score *= 0.5; }
    const tier = (s) => (s.fix ? 3 : s.demoted ? 0 : s.rearFirst ? 0.5 : s.primary ? 2 : 1);
    suggestions.sort((a, b) => tier(b) - tier(a) || b.score - a.score);
    suggestions.forEach((s, i) => { s.rank = i + 1; });
    return { suggestions, skipped, exhausted, violations, car, note: '', ideas: mine.judged, heldBack: mine.heldBack };
  }

  /* ---------- the driver's own ideas ---------- */

  const lowerFirst = (t) => String(t || '').replace(/^./, (c) => c.toLowerCase());

  /* One idea ({ role, axle, dir, for }) checked against what is known:
       can it be made     the car's limits and what was marked not possible
       what it is for     the felt problem it was linked to, or lap time, or nothing in particular
       the rules          does it answer that problem (or this car's own learned answer)?
       the opposite       is the opposite change the usual answer to a problem on the car? Then it makes it worse.
       this car           what happened when it was made here before
     verdict: good | try | against | impossible, with short reasons. */
  function judgeIdea(idea, findings, setup, guard, outcomes, learned) {
    if (!idea || !ROLE[idea.role] || (idea.dir !== '+' && idea.dir !== '-')) return null;
    const axle = idea.axle || null, dir = idea.dir, key = blockKey(idea.role, axle, dir);
    const r = resolve(setup, idea.role, axle, dir, { blocked: guard && guard.blocked, limits: guard && guard.limits });
    const out = { idea, key, role: idea.role, axle, dir, title: titleFor(idea.role, dir, axle), aim: null, helps: [], hurts: [], reasons: [], verdict: 'try', params: r.params };
    if (!r.params.length) { out.verdict = 'impossible'; out.reasons.push(r.why); return out; }
    const opp = dir === '+' ? '-' : '+', change = { role: idea.role, axle, dir, key }, back = { role: idea.role, axle, dir: opp, key: blockKey(idea.role, axle, opp) };
    const tk = (f) => STA.learning.targetKey(f);
    const learnedFor = (c, f) => ((learned && learned.get(tk(f))) || []).some((e) => e.key === c.key);
    const answers = (c, f) => STA.learning.addresses(c, f) || learnedFor(c, f);
    out.helps = findings.filter((f) => answers(change, f));
    out.hurts = findings.filter((f) => !answers(change, f) && answers(back, f));
    out.aim = idea.for === 'pace' ? 'pace' : STA.feel ? STA.feel.aimOf(idea, findings) : null;
    const target = out.aim && out.aim !== 'pace' ? out.aim : null, main = target ? [target] : out.helps;
    const rec = (f) => { const st = outcomes && outcomes.get(key); return st && st.by ? st.by[tk(f)] : null; };
    const say = (v, text) => { out.verdict = v; out.reasons.unshift(text); return out; };

    // This car's own record comes first.
    for (const f of main) {
      const b = rec(f);
      if (b && b.tried && !b.helped && b.hurt) return say('against', 'Made ' + lowerFirst(f.title) + ' worse on this car before (' + b.hurt + ' of ' + b.tried + (b.tried === 1 ? ' run' : ' runs') + ').');
      if (b && b.helped) out.reasons.push('Helped with ' + lowerFirst(f.title) + ' on this car before (' + b.helped + ' of ' + b.tried + ').');
      if (b && b.tried && !b.helped && !b.hurt && b.dead >= 2) out.reasons.push('Had no effect on ' + lowerFirst(f.title) + ' here twice.');
    }
    if (target && out.hurts.indexOf(target) >= 0) return say('against', 'Usually makes ' + lowerFirst(target.title) + ' worse: the usual answer is the opposite.');
    // What the driver felt counts a quarter more than what only the telemetry read; an idea is held back
    // only when what it makes worse clearly matters more than what it is for.
    const weight = (f) => f.severity * (f.felt || f.agreed ? 1.25 : 1);
    const worst = out.hurts.slice().sort((a, b) => weight(b) - weight(a))[0];
    const best = main.filter((f) => out.helps.indexOf(f) >= 0).sort((a, b) => weight(b) - weight(a))[0];
    if (worst && (!best || weight(worst) > weight(best) * 1.1)) return say('against', 'Makes ' + lowerFirst(worst.title) + ' worse' + (best ? ', which matters more here than ' + lowerFirst(best.title) : '') + '.');
    if (worst) out.reasons.push('Also makes ' + lowerFirst(worst.title) + ' worse.');
    if (out.aim === 'pace') return say('try', 'For lap time: judged on where the lap gains or loses after your next run.');
    if (target && out.helps.indexOf(target) < 0) return say('try', 'Not one of the app\'s usual answers for ' + lowerFirst(target.title) + '. Worth one run: the app will judge it against that.');
    if (!main.length) return say('try', 'Answers none of the problems on the car now. Judged on lap time after your next run.');
    if (worst || out.reasons.some((t) => /^Had no effect/.test(t))) return say('try', 'Answers ' + main.map((f) => lowerFirst(f.title)).join('; ') + '.');
    return say('good', 'Answers ' + main.map((f) => lowerFirst(f.title)).join('; ') + '.');
  }

  /* Ideas into the list of changes: a sound idea the app also suggests is marked as yours and moved
     up; a sound idea it does not suggest is added; the rest are held back with the reason and the
     app's own answer for the same problem. */
  function addIdeas(ideas, findings, setup, guard, outcomes, learned, suggestions, byKey) {
    const judged = [], heldBack = [];
    for (const idea of ideas || []) {
      const j = judgeIdea(idea, findings, setup, guard, outcomes, learned);
      if (!j) continue;
      judged.push(j);
      const f0 = j.aim && j.aim !== 'pace' ? j.aim : j.helps[0] || null;
      const appFor = (f) => suggestions.find((s) => !s.fix && !s.yours && f && s.findingIds.indexOf(f.id) >= 0 && s.blockKey !== j.key);
      if (j.verdict === 'against' || j.verdict === 'impossible') {
        const alt = appFor(f0); if (alt) j.instead = alt.title;
        // The app may suggest the same change for another problem; say so rather than look inconsistent.
        const also = suggestions.find((s) => s.blockKey === j.key && !s.fix); if (also) j.alsoApp = also;
        heldBack.push(j); continue;
      }
      let same = suggestions.find((s) => s.role === j.role && (s.axle || null) === j.axle && !s.fix);
      // The app wants the opposite, but its own change works against what the driver felt: the idea replaces it.
      if (same && same.dir !== j.dir && same.againstFelt) {
        suggestions.splice(suggestions.indexOf(same), 1); byKey.delete(same.key);
        j.replaced = same; j.reasons.push('Replaces the app\'s ' + lowerFirst(same.title) + ' (for ' + same.reasons.map(lowerFirst).join('; ') + '), which worked against what you felt.');
        same = null;
      }
      if (same && same.dir !== j.dir) {
        j.verdict = 'against'; j.reasons.unshift('The app suggests the opposite (' + lowerFirst(same.title) + ') for ' + same.reasons.map(lowerFirst).join('; ') + '.');
        heldBack.push(j); continue;
      }
      if (same) { same.yours = true; same.primary = true; same.score += 0.3; same.ideaVerdict = j.verdict; j.merged = same; continue; }
      const rule = f0 ? ruleFor(f0).find((o) => o.role === j.role && o.dir === j.dir) : null;
      const change = buildChange(j.role, j.dir, j.params, 1);
      const s = {
        key: j.role + '|' + (j.axle || ''), blockKey: j.key, role: j.role, axle: j.axle, dir: j.dir, title: change.cappedAt != null ? change.text : j.title,
        amount: change.cappedAt != null ? '' : change.by, targetKey: f0 ? STA.learning.targetKey(f0) : j.aim === 'pace' ? 'pace' : null, learned: 0, bigger: false,
        paramIds: j.params.map((p) => p.id), current: SU().describe(j.params), change, effect: rule ? rule.effect : 'Your idea.', cost: rule ? rule.cost : '',
        reasons: [j.aim === 'pace' ? 'Lap time' : f0 ? f0.title : 'Your idea'], findingIds: j.helps.map((f) => f.id), confidence: j.verdict === 'good' ? 'medium' : 'low',
        primary: j.verdict === 'good', yours: true, ideaVerdict: j.verdict, score: (f0 ? f0.severity : 0.4) * (j.verdict === 'good' ? 1.1 : 0.7),
      };
      applyHistory(s, outcomes);
      byKey.set(s.key, s); suggestions.push(s); j.merged = s;
    }
    return { judged, heldBack };
  }

  /* Copy of the setup with the chosen suggestions written in. */
  function proposeSetup(setup, suggestions, name) {
    const c = SU().clone(setup, { name: name || (setup.name + ' – revised'), source: 'advice', parentId: setup.id, status: 'in progress' });
    for (const s of suggestions) {
      for (const p of c.params) {
        if (s.paramIds.indexOf(p.id) < 0) continue;
        const r = SU().applyChange(p, Object.assign({ why: s.reasons[0] }, s.change));
        if (r.atLimit) p.note = 'Already at the end of its range; ' + s.change.text.toLowerCase() + ' is not possible.';
      }
    }
    return SU().refresh(c);
  }

  STA.advisor = { advise, judgeIdea, proposeSetup, CONTEST, contestText, ROLE, RULES, buildChange, ruleFor, titleFor, labelFor, equivalents, resolve, blockKey };
})(typeof window !== 'undefined' ? window : globalThis);
