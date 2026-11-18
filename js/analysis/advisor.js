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
      if (f.band === 'medium') {
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
    const change = { text: titleFor(role, dir, p.axle && !R.fixedAxle && params.every((q) => q.axle === p.axle) ? p.axle : null) + ' by ' + by };
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
    tradeoff: { label: 'I do not want this trade-off', text: 'you did not want the trade-off' },
    none: { label: 'I tried it and it did not help', text: 'you tried it and it did not help' },
    worse: { label: 'I tried it and it made the car worse', text: 'you tried it and it made the car worse' },
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
        effect: 'Brings this setting back inside what the car allows (' + (g.side === 'above' ? 'no more than ' : 'no less than ') + to + ', ' + g.src + ').',
        cost: 'Until it is inside the limit the car can fail technical inspection, so make this change before judging any other.',
        reasons: [labelFor(g.role, g.axle) + ' is ' + g.side + ' the limit for this car'], findingIds: [],
        confidence: /manual/.test(g.src) ? 'high' : 'medium', primary: true, insteadOf: null, score: 100,
      };
      byKey.set(g.key, s); suggestions.push(s);
    }
    return list;
  }

  /* What earlier sessions say about a change on this car (see learning.js), as a score
     factor and a sentence. stats = { tried, helped, none, hurt }. */
  function applyHistory(s, outcomes) {
    const st = outcomes && outcomes.get(s.blockKey);
    if (!st || !st.tried) return;
    s.history = st;
    s.score *= U.clamp(1 + 0.3 * (st.helped - st.hurt) - 0.15 * st.none, 0.4, 1.6);
    if (st.helped === 0 && st.hurt + st.none >= 2) s.demoted = true;
    const n = (k, word) => (k ? k + ' ' + word : null);
    s.historyText = 'Tried ' + (st.tried === 1 ? 'once' : st.tried + ' times') + ' on this car before: ' + [n(st.helped, 'helped'), n(st.none, 'made no clear difference'), n(st.hurt, 'made it worse')].filter(Boolean).join(', ') + '.'
      + (s.demoted ? ' It is listed after the others for that reason.' : st.helped > st.hurt + st.none ? ' It is ranked higher for that reason.' : '');
  }

  /* findings + the setup on the car -> ordered suggestions.
     opts.blocked:  Set of "role|axle|dir" keys the driver has ruled out altogether.
     opts.limits:   Map of "paramId|dir" -> { num, raw } limits the driver has reported.
     opts.track:    track name, for limits that only apply at one circuit.
     opts.outcomes: Map of "role|axle|dir" -> { tried, helped, none, hurt } from earlier sessions.
     opts.contested: Map of "role|axle|dir" -> { reason } for changes the driver has contested. */
  function advise(analysis, setup, opts) {
    const suggestions = [], skipped = [], exhausted = [], byKey = new Map();
    const blocked = { blocked: (opts && opts.blocked) || null, limits: (opts && opts.limits) || null, contested: (opts && opts.contested) || null };
    if (!setup) return { suggestions, skipped, exhausted, violations: [], car: null, note: 'This file has no setup stored in it, so advice is given as findings only. Load the setup to get specific changes.' };
    const car = STA.carLimits ? STA.carLimits.apply(setup, opts && opts.track, blocked.limits) : null;
    const violations = fixViolations(setup, suggestions, byKey);

    for (const f of analysis.findings) {
      const list = ruleFor(f);
      let taken = 0;
      const unavailable = [], contestedHere = [];
      // A suggestion that stands in for a contested one says so.
      const standIn = (s) => { if (contestedHere.length) s.alternativeTo = Array.from(new Set((s.alternativeTo || []).concat(contestedHere))); };
      for (const first of list) {
        if (taken >= 2) break;
        const axle0 = first.axle === '@' ? f.axle : first.axle;
        // The option itself, then the closest equivalents if it cannot be used.
        const tries = [Object.assign({}, first, { axle: axle0 })].concat(equivalents(first.role, axle0, first.dir));
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
            continue; // wanted the other way round for another finding: look for a different route
          }
          const change = buildChange(opt.role, opt.dir, r.params);
          const s = {
            key, blockKey: blockKey(opt.role, axle, opt.dir), role: opt.role, axle, dir: opt.dir, title: change.cappedAt != null ? change.text : titleFor(opt.role, opt.dir, axle),
            amount: change.cappedAt != null ? '' : ROLE[opt.role].by, paramIds: r.params.map((p) => p.id), current: SU().describe(r.params), change,
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
    for (const s of suggestions) if (!s.fix) applyHistory(s, opts && opts.outcomes);
    // Limit fixes first, then first-choice fixes, then the alternatives; changes that have not worked on this car go last.
    const tier = (s) => (s.fix ? 3 : s.demoted ? 0 : s.primary ? 2 : 1);
    suggestions.sort((a, b) => tier(b) - tier(a) || b.score - a.score);
    suggestions.forEach((s, i) => { s.rank = i + 1; });
    return { suggestions, skipped, exhausted, violations, car, note: '' };
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

  STA.advisor = { advise, proposeSetup, CONTEST, contestText, ROLE, RULES, buildChange, ruleFor, titleFor, labelFor, equivalents, resolve, blockKey };
})(typeof window !== 'undefined' ? window : globalThis);
