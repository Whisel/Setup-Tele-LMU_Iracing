/* What the driver felt in the car, and the changes they want to try.

   For each run the driver can note, in one place:
     felt   what the car did: understeer or oversteer (entry, mid-corner or exit; slow,
            medium, fast or all corners; a little or a lot), "balanced" for a part of the
            corner, front or rear locking, wheelspin, bottoming, or that it felt good.
     ideas  changes they want to try, each with what it is for.

   How it is used:
     advice    what was felt becomes a problem to fix, next to what the telemetry found.
               Where both agree the problem counts for more. Where the driver felt the
               opposite (or balanced) in the same part of the corner, the telemetry reading
               is set aside: the telemetry can mistake one for the other, the driver cannot.
               Each idea is checked against the rules, the car's limits, the other problems
               and what earlier runs on this car showed, and is ranked with the app's own.
     learning  an idea that was then made is judged against the reason the driver gave. A
               problem that was felt is judged by what is felt on the next run: gone, less,
               the same, more, or now the other way. That is the driver's word and it comes
               before the telemetry.

   Stored per run in the library (see library.js, "feel"). */
(function (root) {
  'use strict';
  const STA = (root.STA = root.STA || {});
  const U = STA.util;
  const H = () => STA.handling;

  const BALANCE = { understeer: 1, oversteer: 1, balanced: 1 };
  const KINDS = [
    ['understeer', 'Understeer'], ['oversteer', 'Oversteer'], ['balanced', 'Balanced'],
    ['frontLock', 'Fronts lock under braking'], ['rearLock', 'Rear locks or steps out under braking'],
    ['wheelspin', 'Wheelspin on exit'], ['bottoming', 'Bottoming out'], ['good', 'Felt good, no complaints'],
  ];
  const BANDS = [['all', 'all corners'], ['low', 'slow corners'], ['medium', 'medium corners'], ['high', 'fast corners']];
  const bandText = (b) => (b === 'all' ? 'all corners' : H().BAND_TEXT[b]);
  const isBal = (f) => f.kind === 'understeer' || f.kind === 'oversteer';
  const overlap = (a, b) => a.band === 'all' || b.band === 'all' || a.band === b.band;
  const lower = (t) => String(t || '').replace(/^./, (c) => c.toLowerCase());

  /* A stable name for one felt item, used to link an idea to it. */
  function feltKey(x) {
    if (BALANCE[x.kind]) return x.kind + '|' + x.phase + '|' + x.band;
    if (x.kind === 'bottoming') return 'bottoming|' + (x.axle || 'front');
    return x.kind;
  }

  /* One felt item as a problem, in the same shape as a telemetry finding. */
  function findingOf(x) {
    if (!x || !x.kind || x.kind === 'good') return null;
    const amount = x.amount === 2 ? 2 : 1, words = amount === 2 ? 'a lot' : 'a little';
    const base = { id: 'felt-' + feltKey(x).replace(/\|/g, '-'), felt: true, feltKey: feltKey(x), amount, severity: amount === 2 ? 0.85 : 0.5, confidence: 'medium', evidence: '' };
    if (BALANCE[x.kind]) {
      if (!x.phase || !x.band) return null;
      const t = H().PHASE_TEXT[x.phase] + ' ' + (x.kind === 'balanced' ? 'balanced' : x.kind) + ' in ' + bandText(x.band);
      return Object.assign(base, { kind: x.kind, phase: x.phase, band: x.band, area: 'Balance', title: t, detail: x.kind === 'balanced' ? 'You felt it balanced.' : 'You felt it (' + words + ').' });
    }
    const T = { frontLock: ['Front wheels locking', 'Braking', 'front'], rearLock: ['Rear locking or stepping out under braking', 'Braking', 'rear'], wheelspin: ['Wheelspin on exit', 'Traction', 'rear'],
      bottoming: [(x.axle === 'rear' ? 'Rear' : 'Front') + ' bottoming out', 'Ride height', x.axle === 'rear' ? 'rear' : 'front'] }[x.kind];
    if (!T) return null;
    return Object.assign(base, { kind: x.kind, axle: T[2], area: T[1], title: T[0], detail: 'You felt it (' + words + ').', phase: x.kind === 'wheelspin' ? 'exit' : undefined, band: x.kind === 'wheelspin' ? 'low' : undefined });
  }

  /* Same problem? Balance items match by phase and overlapping corners; bottoming by end of the car. */
  function sameProblem(a, b) {
    if (a.kind !== b.kind) return a.kind === 'wheelspin' && b.kind === 'traction' || a.kind === 'traction' && b.kind === 'wheelspin';
    if (isBal(a)) return a.phase === b.phase && overlap(a, b);
    if (a.kind === 'bottoming') return (a.axle || 'front') === (b.axle || 'front');
    return true;
  }

  /* The telemetry analysis with what the driver felt worked in.
     findings  telemetry findings the driver did not contradict (marked agreed when felt too),
               then what was felt that the telemetry did not show
     setAside  telemetry findings the driver felt otherwise about, each with because: the felt item
     felt      the felt items as findings, including "balanced"
     good      the driver said the car felt good */
  function merge(an, notes) {
    const felt = ((notes && notes.felt) || []).map(findingOf).filter(Boolean);
    const good = !!((notes && notes.felt) || []).some((x) => x.kind === 'good');
    if (!felt.length) return Object.assign({}, an, { setAside: [], felt: [], good });
    const findings = [], setAside = [], used = new Set();
    for (const t of an.findings) {
      // The driver felt the other way round, or balanced, in the same part of the corner.
      const against = isBal(t) && felt.find((x) => BALANCE[x.kind] && x.kind !== t.kind && x.phase === t.phase && overlap(x, t));
      if (against) { setAside.push(Object.assign({}, t, { because: against })); continue; }
      const same = felt.find((x) => sameProblem(x, t));
      if (same) {
        used.add(same);
        findings.push(Object.assign({}, t, { agreed: true, amount: same.amount, feltKey: same.feltKey, severity: Math.min(1, Math.max(t.severity, same.severity) + 0.1), confidence: 'high',
          evidence: (t.evidence ? t.evidence + ' ' : '') + 'You felt it too (' + (same.amount === 2 ? 'a lot' : 'a little') + ').' }));
        continue;
      }
      findings.push(t);
    }
    for (const x of felt) if (!used.has(x) && x.kind !== 'balanced') findings.push(x);
    // Understeer is cured only from the front where the rear also slides in the same part of the
    // corner; a measured slide anywhere keeps the flag the telemetry gave it.
    const loose = findings.filter((f) => f.kind === 'oversteer');
    for (const f of findings) {
      if (f.kind !== 'understeer') continue;
      if (f.felt) f.rearFirst = loose.some((o) => o.phase === f.phase && overlap(o, f));
      else if (f.rearFirst && !loose.length) f.rearFirst = false;
    }
    findings.sort((a, b) => b.severity - a.severity);
    return Object.assign({}, an, { findings, setAside, felt, good });
  }

  /* How a problem that was felt before moved, going by what is felt after. null when the driver
     recorded nothing for the later run (then the telemetry is used). */
  function moved(f, after) {
    const items = (after && after.felt) || [];
    if (!items.length) return null;
    if (items.some((x) => x.kind === 'good')) return { word: 'better', text: 'you felt the car good', gain: f.severity || 0.5, byFeel: true };
    const A = items.map(findingOf).filter(Boolean);
    const was = f.amount || (f.severity >= 0.7 ? 2 : 1);
    if (isBal(f)) {
      const other = A.find((x) => isBal(x) && x.kind !== f.kind && x.phase === f.phase && overlap(x, f));
      if (other) return { word: 'overshot', text: 'now you feel ' + lower(other.title), gain: 0.3, byFeel: true };
      const calm = A.find((x) => x.kind === 'balanced' && x.phase === f.phase && overlap(x, f));
      if (calm) return { word: 'better', text: 'you felt it balanced', gain: 0.5, byFeel: true };
    }
    const now = A.find((x) => x.kind !== 'balanced' && sameProblem(x, f));
    if (!now) return { word: 'better', text: 'you no longer felt it', gain: 0.5, byFeel: true };
    const words = (n) => (n === 2 ? 'a lot' : 'a little');
    if (now.amount < was) return { word: 'better', text: 'you felt it less (' + words(was) + ' → ' + words(now.amount) + ')', gain: 0.25, byFeel: true };
    if (now.amount > was) return { word: 'worse', text: 'you felt it more (' + words(was) + ' → ' + words(now.amount) + ')', gain: -0.25, byFeel: true };
    return { word: 'same', text: 'you still felt it (' + words(now.amount) + ')', gain: 0, byFeel: true };
  }

  /* The felt item an idea was linked to, as a finding, from a list of findings (merged or felt). */
  function aimOf(idea, findings) {
    if (!idea || !idea.for || idea.for === 'none' || idea.for === 'pace') return null;
    return (findings || []).find((f) => f.feltKey === idea.for) || null;
  }

  STA.feel = { KINDS, BANDS, BALANCE, feltKey, findingOf, sameProblem, merge, moved, aimOf, bandText };
})(typeof window !== 'undefined' ? window : globalThis);
