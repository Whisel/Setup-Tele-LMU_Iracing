const test = require('node:test'), assert = require('node:assert');
const STA = require('./helpers/load.js');
const { SETUP_YAML } = require('./helpers/make-ibt.js');

const setupFor = (edit) => STA.setup.fromIracing(STA.yaml.parse((edit || ((y) => y))(SETUP_YAML)).CarSetup, { car: 'Test GT3', track: 'Test Ring', name: 'n' });
const F = STA.feel;
const usMidLow = { id: 'us-mid-low', kind: 'understeer', phase: 'mid', band: 'low', title: 'Mid-corner understeer in slow corners', severity: 0.7, confidence: 'medium', evidence: 'C3, C7.' };
const usEntryLow = { id: 'us-entry-low', kind: 'understeer', phase: 'entry', band: 'low', title: 'Corner entry understeer in slow corners', severity: 0.6, confidence: 'medium', evidence: '' };
const osExitHigh = { id: 'os-exit-high', kind: 'oversteer', phase: 'exit', band: 'high', title: 'Corner exit oversteer in fast corners', severity: 0.5, confidence: 'low', evidence: '' };

test('what was felt is worked in: agreement counts for more, the opposite sets the telemetry aside, the rest is added', () => {
  const an = { findings: [usMidLow, usEntryLow, osExitHigh], notes: [] };
  const notes = { felt: [
    { kind: 'oversteer', phase: 'mid', band: 'low', amount: 2 },       // the telemetry read understeer here
    { kind: 'understeer', phase: 'entry', band: 'all', amount: 1 },    // agrees
    { kind: 'balanced', phase: 'exit', band: 'all' },                  // the telemetry read oversteer here
    { kind: 'frontLock', amount: 1 },                                   // not measured
  ] };
  const m = F.merge(an, notes);
  assert.deepStrictEqual(m.setAside.map((f) => [f.id, f.because.title]), [['us-mid-low', 'Mid-corner oversteer in slow corners'], ['os-exit-high', 'Corner exit balanced in all corners']]);
  const ids = m.findings.map((f) => f.id);
  assert.deepStrictEqual(ids.slice().sort(), ['felt-frontLock', 'felt-oversteer-mid-low', 'us-entry-low'].sort());
  const entry = m.findings.find((f) => f.id === 'us-entry-low');
  assert.deepStrictEqual([entry.agreed, entry.confidence, entry.severity, entry.feltKey], [true, 'high', 0.7, 'understeer|entry|all']);
  assert.match(entry.evidence, /You felt it too \(a little\)\./);
  assert.strictEqual(m.findings[0].id, 'felt-oversteer-mid-low', 'what was felt a lot comes first');
  // nothing noted: the analysis is unchanged
  assert.deepStrictEqual(F.merge(an, { felt: [] }).findings, an.findings);
  // "felt good" changes nothing in the findings but is kept
  assert.strictEqual(F.merge(an, { felt: [{ kind: 'good' }] }).good, true);
});

test('the advice follows the feel: a car felt loose on exit gets rear grip, not more front', () => {
  const setup = setupFor();
  const an = { findings: [usMidLow], notes: [] };
  const plain = STA.advisor.advise(an, setup, {});
  assert.ok(plain.suggestions.some((s) => s.blockKey === 'arb|front|-'), 'the telemetry alone asks for front grip');
  const m = F.merge(an, { felt: [{ kind: 'oversteer', phase: 'mid', band: 'low', amount: 2 }] });
  const adv = STA.advisor.advise(m, setup, {});
  const keys = adv.suggestions.map((s) => s.blockKey);
  assert.ok(!keys.includes('arb|front|-'), keys.join(', '));
  assert.ok(adv.suggestions[0].reasons.includes('Mid-corner oversteer in slow corners'), adv.suggestions[0].title);
});

test('each idea gets a verdict against the rules, the other problems, the limits and this car\'s record', () => {
  const setup = setupFor();
  const notes = { felt: [{ kind: 'oversteer', phase: 'exit', band: 'low', amount: 2 }, { kind: 'understeer', phase: 'entry', band: 'low', amount: 1 }] };
  const m = F.merge({ findings: [], notes: [] }, notes);
  const judge = (idea, extra) => STA.advisor.judgeIdea(idea, m.findings, setup, {}, extra && extra.outcomes, extra && extra.learned);

  const good = judge({ role: 'tc', axle: null, dir: '+', for: 'oversteer|exit|low' });
  assert.deepStrictEqual([good.verdict, good.reasons[0]], ['good', 'Answers corner exit oversteer in slow corners.']);

  const wrong = judge({ role: 'tc', axle: null, dir: '-', for: 'oversteer|exit|low' });
  assert.deepStrictEqual([wrong.verdict, wrong.reasons[0]], ['against', 'Usually makes corner exit oversteer in slow corners worse: the usual answer is the opposite.']);

  // softening the front bar helps the entry understeer, but also frees the rear on exit, which was felt a lot
  const front = judge({ role: 'arb', axle: 'front', dir: '-', for: 'understeer|entry|low' });
  assert.deepStrictEqual([front.verdict, front.reasons[0]], ['against', 'Makes corner exit oversteer in slow corners worse, which matters more here than corner entry understeer in slow corners.']);
  // with only the entry understeer felt, it is a good idea
  const alone = STA.advisor.judgeIdea({ role: 'arb', axle: 'front', dir: '-', for: 'understeer|entry|low' }, F.merge({ findings: [] }, { felt: [notes.felt[1]] }).findings, setup, {});
  assert.strictEqual(alone.verdict, 'good');

  // front camber is no usual answer to exit oversteer: worth one run, judged afterwards
  const odd = judge({ role: 'camber', axle: 'front', dir: '+', for: 'oversteer|exit|low' });
  assert.deepStrictEqual([odd.verdict, odd.reasons[0]], ['try', 'Not one of the app\'s usual answers for corner exit oversteer in slow corners. Worth one run: the app will judge it against that.']);

  // for lap time, and with no reason
  assert.strictEqual(judge({ role: 'rearWing', dir: '-', for: 'pace' }).verdict, 'try');
  assert.match(judge({ role: 'camber', axle: 'rear', dir: '+', for: 'none' }).reasons[0], /^Answers none of the problems/);
  // a setting this car does not have
  assert.deepStrictEqual([judge({ role: 'brakeDuct', axle: 'front', dir: '-', for: 'none' }).verdict, judge({ role: 'brakeDuct', axle: 'front', dir: '-', for: 'none' }).reasons[0]], ['impossible', 'Front brake ducts (not adjustable on this car)']);

  // the car's own record: it made this worse here before
  const outcomes = new Map([['tc||+', { tried: 1, helped: 0, none: 0, hurt: 1, dead: 0, by: { 'oversteer|exit': { tried: 1, helped: 0, none: 0, hurt: 1, dead: 0 } } }]]);
  const burnt = judge({ role: 'tc', axle: null, dir: '+', for: 'oversteer|exit|low' }, { outcomes });
  assert.deepStrictEqual([burnt.verdict, burnt.reasons[0]], ['against', 'Made corner exit oversteer in slow corners worse on this car before (1 of 1 run).']);

  // the car's limits
  const flat = setupFor((y) => y.replace('TractionControlSetting: 4', 'TractionControlSetting: 4'));
  for (const p of flat.params) if (p.role === 'tc') { p.hi = p.num; p.hiSrc = 'set by you'; }
  assert.strictEqual(STA.advisor.judgeIdea({ role: 'tc', dir: '+', for: 'oversteer|exit|low' }, m.findings, flat, {}).verdict, 'impossible');
});

test('an idea replaces the app\'s opposite change when that change works against what was felt', () => {
  const setup = setupFor();
  // the telemetry asks for a stiffer rear bar (mid-corner understeer); the driver felt the rear loose on exit, a lot
  const notes = { felt: [{ kind: 'oversteer', phase: 'exit', band: 'low', amount: 2 }], ideas: [{ role: 'arb', axle: 'rear', dir: '-', for: 'oversteer|exit|low' }] };
  const m = F.merge({ findings: [Object.assign({}, usMidLow, { severity: 0.95 })], notes: [] }, notes);
  const plain = STA.advisor.advise(m, setup, {});
  const stiff = plain.suggestions.find((s) => s.blockKey === 'arb|rear|+');
  assert.ok(stiff && stiff.againstFelt && !stiff.primary, 'the app\'s stiffer rear bar is marked and moved down');
  const adv = STA.advisor.advise(m, setup, { ideas: notes.ideas });
  assert.ok(!adv.suggestions.some((s) => s.blockKey === 'arb|rear|+'), 'both cannot be done: the app\'s goes');
  const soft = adv.suggestions.find((s) => s.blockKey === 'arb|rear|-');
  assert.ok(soft && soft.yours);
  assert.match(adv.ideas[0].reasons.join(' '), /Replaces the app's stiffen the rear anti-roll bar \(for mid-corner understeer in slow corners\), which worked against what you felt\./);
});

test('ideas are ranked with the app\'s own changes; the unsound ones are held back with an alternative', () => {
  const setup = setupFor();
  const notes = { felt: [{ kind: 'oversteer', phase: 'exit', band: 'low', amount: 2 }],
    ideas: [{ role: 'tc', axle: null, dir: '+', for: 'oversteer|exit|low' }, { role: 'arb', axle: 'rear', dir: '+', for: 'oversteer|exit|low' }, { role: 'camber', axle: 'front', dir: '+', for: 'oversteer|exit|low' }] };
  const adv = STA.advisor.advise(F.merge({ findings: [], notes: [] }, notes), setup, { ideas: notes.ideas });
  const tc = adv.suggestions.find((s) => s.blockKey === 'tc||+');
  assert.deepStrictEqual([tc.yours, tc.primary, tc.rank], [true, true, 1], 'the app suggests it too: marked as yours and first');
  const duct = adv.suggestions.find((s) => s.blockKey === 'camber|front|+');
  assert.deepStrictEqual([!!duct, duct && duct.yours, duct && duct.ideaVerdict, duct && duct.confidence], [true, true, 'try', 'low'], 'an unusual idea is in the list, below the sound ones');
  assert.ok(duct.rank > tc.rank);
  assert.deepStrictEqual(adv.heldBack.map((j) => [j.key, j.verdict]), [['arb|rear|+', 'against']]);
  assert.match(adv.heldBack[0].instead, /./, 'with the app\'s own answer for the same problem');
  assert.ok(!adv.suggestions.some((s) => s.blockKey === 'arb|rear|+'));
});

/* ---------- learning from what was felt ---------- */

let runNo = 0;
const bal0 = () => ({ entry: { low: 0, medium: 0, high: 0, all: 0 }, mid: { low: 0, medium: 0, high: 0, all: 0 }, exit: { low: 0, medium: 0, high: 0, all: 0 } });
const run = (setup, extra) => Object.assign({ id: 'feel-run-' + (++runNo), sim: 'iracing', car: 'Test GT3', track: 'Test Ring', recordedAt: 1767225600000 + runNo * 3600000,
  bestLap: 90, medianLap: 90.2, lapSpread: 0.1, setupId: setup.id, balance: bal0(), findings: [], metrics: {}, habits: [] }, extra || {});

test('an idea that was made is judged against its reason, by what was felt on the next run', () => {
  const a = setupFor(), b = setupFor((y) => y.replace('TractionControlSetting: 4', 'TractionControlSetting: 5'));
  const r1 = run(a), r2 = run(b);
  const before = { felt: [{ kind: 'oversteer', phase: 'exit', band: 'low', amount: 2 }], ideas: [{ role: 'tc', axle: null, dir: '+', for: 'oversteer|exit|low' }] };
  const judgeWith = (after) => STA.learning.judge(r1, r2, a, b, null, null, { before, after }).changes[0];

  const less = judgeWith({ felt: [{ kind: 'oversteer', phase: 'exit', band: 'low', amount: 1 }] });
  assert.deepStrictEqual([less.yours, less.why, less.targets[0].title, less.targets[0].text, less.targets[0].word], [true, 'driver', 'Corner exit oversteer in slow corners', 'you felt it less (a lot → a little)', 'better']);
  assert.strictEqual(less.verdict, 'helped', 'better and lap time unchanged on an old record without pace profiles: the benefit of the doubt');

  assert.deepStrictEqual([judgeWith({ felt: [{ kind: 'good' }] }).targets[0].text, judgeWith({ felt: [{ kind: 'good' }] }).targets[0].word], ['you felt the car good', 'better']);
  const same = judgeWith({ felt: [{ kind: 'oversteer', phase: 'exit', band: 'low', amount: 2 }] });
  assert.deepStrictEqual([same.targets[0].word, same.verdict], ['same', 'none']);
  const worse = judgeWith({ felt: [{ kind: 'oversteer', phase: 'exit', band: 'all', amount: 2 }, { kind: 'frontLock', amount: 1 }] });
  assert.strictEqual(worse.targets[0].word, 'same', '"all corners" covers the slow ones');
  const flipped = judgeWith({ felt: [{ kind: 'understeer', phase: 'exit', band: 'low', amount: 1 }] });
  assert.deepStrictEqual([flipped.targets[0].word, flipped.targets[0].text, flipped.overshot], ['overshot', 'now you feel corner exit understeer in slow corners', true]);
  const gone = judgeWith({ felt: [{ kind: 'frontLock', amount: 1 }] });
  assert.deepStrictEqual([gone.targets[0].word, gone.targets[0].text], ['better', 'you no longer felt it']);

  // nothing noted after: the telemetry decides, and here it never showed the problem
  const blind = judgeWith(null);
  assert.strictEqual(blind.targets[0].byFeel, undefined);
  assert.strictEqual(blind.cause, 'notSeen');
  assert.match(blind.rethink, /Note what you felt after the next run/);

  // the tallies: what was learned is the driver's reason, so the next time the same idea comes up it is known
  const feelMap = { [r1.id]: before, [r2.id]: { felt: [{ kind: 'oversteer', phase: 'exit', band: 'low', amount: 1 }] } };
  const know = STA.learning.knowledge([r1, r2], [a, b], { sim: 'iracing', car: 'Test GT3' }, null, feelMap);
  const st = know.stats.get('tc||+');
  assert.deepStrictEqual([st.tried, st.helped, st.by['oversteer|exit'].helped], [1, 1, 1]);
  const again = STA.advisor.judgeIdea({ role: 'tc', dir: '+', for: 'oversteer|exit|low' }, F.merge({ findings: [] }, before).findings, b, {}, know.stats);
  assert.ok(again.reasons.some((t) => /^Helped with corner exit oversteer in slow corners on this car before \(1 of 1\)\.$/.test(t)), again.reasons.join(' | '));
});

test('a change the app suggested for a felt problem is judged by the feel too, and an unexpected felt gain is credited', () => {
  const a = setupFor(), b = setupFor((y) => y.replace('ArbBlades: 3', 'ArbBlades: 2')); // softer front bar
  const r1 = run(a), r2 = run(b);
  const before = { felt: [{ kind: 'understeer', phase: 'entry', band: 'low', amount: 2 }, { kind: 'frontLock', amount: 1 }] };
  const j = STA.learning.judge(r1, r2, a, b, null, null, { before, after: { felt: [{ kind: 'frontLock', amount: 1 }] } });
  const c = j.changes[0];
  assert.deepStrictEqual([c.why, c.yours, c.targets.map((t) => [t.title, t.word])], ['app', undefined, [['Corner entry understeer in slow corners', 'better']]]);
  // front locking did not move (still a little): no bonus for it
  assert.deepStrictEqual(j.bonus, []);
  // the same change, and the locking went away too: credited as an unexpected gain
  const j2 = STA.learning.judge(r1, r2, a, b, null, null, { before, after: { felt: [{ kind: 'good' }] } });
  assert.deepStrictEqual(j2.bonus.map((x) => [x.key, x.text]), [['frontLock', 'you felt the car good']]);
});

test('the library keeps one note per thing felt and one idea per setting', () => {
  const L = STA.library.feel, sid = 'feel-store-test';
  L.put(sid, { felt: [], ideas: [] });
  L.addFelt(sid, { kind: 'understeer', phase: 'entry', band: 'low', amount: 1 });
  L.addFelt(sid, { kind: 'oversteer', phase: 'entry', band: 'low', amount: 2 }); // replaces: the same part of the corner
  L.addFelt(sid, { kind: 'frontLock', amount: 1 });
  assert.deepStrictEqual(L.get(sid).felt.map((x) => x.kind), ['oversteer', 'frontLock']);
  L.addFelt(sid, { kind: 'good' });
  assert.deepStrictEqual(L.get(sid).felt.map((x) => x.kind), ['good'], 'felt good clears the complaints');
  L.addFelt(sid, { kind: 'wheelspin', amount: 1 });
  assert.deepStrictEqual(L.get(sid).felt.map((x) => x.kind), ['wheelspin'], 'and a complaint clears "felt good"');
  L.addIdea(sid, { role: 'tc', axle: null, dir: '+', for: 'wheelspin' });
  L.addIdea(sid, { role: 'tc', axle: null, dir: '-', for: 'none' });
  assert.deepStrictEqual(L.get(sid).ideas.map((x) => x.dir), ['-'], 'one idea per setting: the later one stands');
  L.removeIdea(sid, 0); L.removeFelt(sid, 0);
  assert.strictEqual(L.all()[sid], undefined, 'an empty note is not kept');
});
