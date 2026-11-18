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
    if (role === 'brakeBias' && change.delta == null && U.isNum(p.num) && p.num > 30 && p.num < 80) {
      change.text += ' (to about ' + (p.num + sign * m * 0.5).toFixed(1) + '% front)';
    }
    return change;
  }

  /* findings + the setup on the car -> ordered suggestions. */
  function advise(analysis, setup) {
    const suggestions = [], skipped = [], byKey = new Map();
    if (!setup) return { suggestions, skipped, note: 'This file has no setup stored in it, so advice is given as findings only. Load the setup to get specific changes.' };

    for (const f of analysis.findings) {
      const opts = ruleFor(f);
      let taken = 0;
      const unavailable = [];
      for (const opt of opts) {
        if (taken >= 2) break;
        const axle = opt.axle === '@' ? f.axle : opt.axle;
        let params = SU().byRole(setup, opt.role, axle || undefined);
        if (!axle) params = SU().byRole(setup, opt.role);
        if (opt.role === 'brakeBias') params = params.filter((p) => !/fine|peak|migration/.test(p.id)).slice(0, 1);
        if (opt.role === 'tc' || opt.role === 'abs') params = params.filter((p) => U.isNum(p.num)).slice(0, 1);
        if (!params.length) { unavailable.push(labelFor(opt.role, axle)); continue; }
        // Skip a step-based setting that is already at the end of its range in the wanted direction.
        if (ROLE[opt.role].index && params.every((p) => p.index != null && p.min != null && p.max != null && (opt.dir === '+' ? p.index >= p.max : p.index <= p.min))) {
          unavailable.push(labelFor(opt.role, axle) + ' (already at the end of its range)'); continue;
        }
        const key = opt.role + '|' + (axle || '');
        const existing = byKey.get(key);
        if (existing) {
          if (existing.dir === opt.dir) { existing.reasons.push(f.title); existing.findingIds.push(f.id); existing.score += f.severity * 0.5; taken++; }
          else existing.conflict = (existing.conflict || []).concat(f.title);
          continue;
        }
        const R = ROLE[opt.role];
        const s = {
          key, role: opt.role, axle: axle || null, dir: opt.dir, title: titleFor(opt.role, opt.dir, axle),
          amount: R.by, paramIds: params.map((p) => p.id), current: SU().describe(params), change: buildChange(opt.role, opt.dir, params),
          effect: opt.effect, cost: opt.cost, reasons: [f.title], findingIds: [f.id], confidence: f.confidence, primary: taken === 0,
          score: f.severity * (taken === 0 ? 1 : 0.6),
        };
        byKey.set(key, s); suggestions.push(s); taken++;
      }
      if (unavailable.length) skipped.push({ finding: f.title, items: Array.from(new Set(unavailable)) });
    }
    // First-choice fixes come before the alternatives for the same finding.
    suggestions.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || b.score - a.score);
    suggestions.forEach((s, i) => { s.rank = i + 1; });
    return { suggestions, skipped, note: '' };
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

  STA.advisor = { advise, proposeSetup, ROLE, RULES, buildChange, ruleFor, titleFor, labelFor };
})(typeof window !== 'undefined' ? window : globalThis);
