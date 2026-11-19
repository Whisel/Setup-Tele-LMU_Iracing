const test = require('node:test'), assert = require('node:assert');
const STA = require('./helpers/load.js');
const { SETUP_YAML } = require('./helpers/make-ibt.js');

const SVM = `VehicleClassSetting="GT3 Test_Car"
UpgradeSetting=(0,0,0,0)
//Note: test file
[GENERAL]
Notes=""
Symmetric=1
FuelSetting=90//0.91
[REARWING]
RWSetting=9//3.3 deg
[SUSPENSION]
FrontAntiSwaySetting=4//P4
RearAntiSwaySetting=2//P2
FrontToeInSetting=6//-0.234 deg
[CONTROLS]
RearBrakeSetting=22//51.5:48.5
TCSetting=0//Available
[DRIVELINE]
DiffPreloadSetting=0//Non-adjustable
[FRONTLEFT]
CamberSetting=25//-2.50 deg
PressureSetting=3//139 kPa
RideHeightSetting=1//5.1 cm
[FRONTRIGHT]
CamberSetting=25//-2.50 deg
PressureSetting=3//139 kPa
RideHeightSetting=1//5.1 cm
`;
const lmuJson = (wing, arb) => ({
  VM_REAR_WING: { available: true, value: wing, minValue: 0, maxValue: 12, stringValue: (wing / 3 + 0.3).toFixed(1) + ' deg' },
  VM_FRONT_ANTISWAY: { available: true, value: arb, minValue: 0, maxValue: 11, stringValue: 'P' + arb },
  VM_REAR_ANTISWAY: { available: true, value: 2, minValue: 0, maxValue: 11, stringValue: 'P2' },
  VM_BRAKE_BALANCE: { available: true, value: 22, minValue: 0, maxValue: 57, stringValue: '51.5:48.5' },
  VM_DIFF_PRELOAD: { available: true, value: 0, minValue: 0, maxValue: 1, stringValue: 'Non-adjustable' },
  'WM_CAMBER-W_FL': { available: true, value: 25, minValue: 0, maxValue: 41, stringValue: '-2.50 deg' },
  'WM_PRESSURE-W_FL': { available: true, value: 3, minValue: 0, maxValue: 75, stringValue: '139 kPa' },
});

test('iRacing setup: values, units, roles, axles and sim-calculated readings', () => {
  const s = STA.setup.fromIracing(STA.yaml.parse(SETUP_YAML).CarSetup, { car: 'Test GT3', track: 'Test Ring', name: 'base' });
  const get = (id) => s.params.find((p) => p.id === id);
  const camber = get('chassis/leftfront/camber');
  assert.deepStrictEqual([camber.num, camber.unit, camber.role, camber.axle, camber.side], [-3.4, 'deg', 'camber', 'front', 'L']);
  assert.strictEqual(get('chassis/rear/arbblades').role, 'arb');
  assert.strictEqual(get('chassis/rear/arbblades').axle, 'rear');
  assert.strictEqual(get('tiresaero/aerosettings/rearwingsetting').role, 'rearWing');
  assert.strictEqual(get('chassis/front/brakepressurebias').role, 'brakeBias');
  assert.strictEqual(get('chassis/leftfront/lscompdamping').role, 'slowBump');
  assert.ok(get('tiresaero/leftfront/lasthotpressure').derived, 'hot pressure is a reading, not a setting');
  assert.ok(get('chassis/leftfront/cornerweight').derived);
  assert.strictEqual(STA.setup.byRole(s, 'pressure', 'front').length, 2, 'only the two cold pressures count as front pressure settings');
  assert.strictEqual(STA.setup.byRole(s, 'spring', 'rear').length, 2);
});

test('LMU setup from a recording and from a .svm file use the same ids, so they can be compared', () => {
  const a = STA.setup.fromLmuJson(lmuJson(9, 4), { car: 'X', track: 'T', name: 'rec' });
  const b = STA.setup.fromSvm(SVM, { track: 'T', name: 'file' });
  assert.strictEqual(b.car, 'GT3 Test_Car');
  const ids = (s) => new Set(s.params.map((p) => p.id));
  for (const id of ['rearwing/rwsetting', 'suspension/frontantiswaysetting', 'controls/rearbrakesetting', 'frontleft/cambersetting', 'frontleft/pressuresetting']) {
    assert.ok(ids(a).has(id) && ids(b).has(id), id);
  }
  const d = STA.setup.diff(a, b).filter((r) => r.changed && !r.onlyIn);
  assert.deepStrictEqual(d.map((r) => r.id), [], 'same values in both sources means no differences');
  assert.strictEqual(a.params.find((p) => p.id === 'driveline/diffpreloadsetting').adjustable, false, 'a one-choice setting is not adjustable');
  assert.strictEqual(STA.setup.byRole(a, 'diffPreload').length, 0);
  const wing = a.params.find((p) => p.role === 'rearWing');
  assert.deepStrictEqual([wing.index, wing.min, wing.max], [9, 0, 11]);
});

test('diff reports changed, unchanged and one-sided settings with numeric and step changes', () => {
  const a = STA.setup.fromLmuJson(lmuJson(9, 4), { car: 'X', track: 'T', name: 'a' });
  const b = STA.setup.fromLmuJson(Object.assign(lmuJson(7, 4), { VM_FRONT_WING: { available: true, value: 2, minValue: 0, maxValue: 5, stringValue: '2' } }), { car: 'X', track: 'T', name: 'b' });
  const rows = STA.setup.diff(a, b), by = (id) => rows.find((r) => r.id === id);
  assert.strictEqual(by('rearwing/rwsetting').changed, true);
  assert.strictEqual(by('rearwing/rwsetting').stepDelta, -2);
  assert.ok(Math.abs(by('rearwing/rwsetting').numDelta - (-0.7)) < 1e-9);
  assert.strictEqual(by('suspension/frontantiswaysetting').changed, false);
  assert.strictEqual(by('frontwing/fwsetting').onlyIn, 'b');
  assert.notStrictEqual(a.fingerprint, b.fingerprint);
  assert.strictEqual(a.fingerprint, STA.setup.fromLmuJson(lmuJson(9, 4), { car: 'X', track: 'T', name: 'again' }).fingerprint);
});

test('applyChange: steps respect the range, numeric values keep their unit, repeated changes stay relative to the original', () => {
  const s = STA.setup.clone(STA.setup.fromLmuJson(lmuJson(9, 4), { car: 'X', track: 'T', name: 'a' }));
  const arb = s.params.find((p) => p.id === 'suspension/frontantiswaysetting');
  assert.deepStrictEqual(STA.setup.applyChange(arb, { steps: -1, text: 'soften' }), { moved: -1, atLimit: false });
  assert.strictEqual(arb.raw, '1 step down from P4');
  STA.setup.applyChange(arb, { steps: -1, text: 'soften' });
  assert.strictEqual(arb.raw, '2 steps down from P4');
  assert.strictEqual(arb.index, 2);
  arb.index = 0; assert.strictEqual(STA.setup.applyChange(arb, { steps: -1, text: 'soften' }).atLimit, true);
  const camber = s.params.find((p) => p.role === 'camber');
  STA.setup.applyChange(camber, { delta: -0.2, text: 'more camber' });
  assert.strictEqual(camber.raw, '-2.70 deg');
  assert.strictEqual(camber.index, null, 'the step number for a computed value is unknown');
  const bias = s.params.find((p) => p.role === 'brakeBias');
  STA.setup.applyChange(bias, { text: 'Move brake bias forward by 0.5%' });
  assert.strictEqual(bias.raw, 'Move brake bias forward by 0.5% (from 51.5:48.5)');
});

/* Garage names taken from the iRacing manuals for the two Super Formula cars. */
const SF23 = { TiresAero: { FrontAero: { FlapAngle: '21.0 deg' }, RearAero: { WingAngle: '14.0 deg', GurneyFlap: '5 mm' },
  AeroCalculator: { FrontRhAtSpeed: '15.0 mm', DownforceBalance: '44.1%' } },
  Chassis: { Front: { ArbDiameter: '18 mm' }, LeftFront: { RideHeight: '18.0 mm' }, RightFront: { RideHeight: '18.0 mm' }, LeftRear: { RideHeight: '45.0 mm' }, RightRear: { RideHeight: '45.0 mm' } } };
const SFL = { TiresAero: { AeroSetup: { AeroPackage: 'Medium DF', FrontFlapConfiguration: 'High DF flap', FrontFlapAngle: '18.0 deg', FrontFlapGurneyFlap: 'None',
  RearUpperFlapAngle: '12.0 deg', RearBeamWingAngle: '8.0 deg' } } };
const roles = (s) => Object.fromEntries(s.params.filter((p) => p.role && !p.derived).map((p) => [p.id.split('/').pop(), p.role + ':' + (p.axle || '')]));

test('wings and flaps: the end of the car comes from the name or the section, and add-ons are kept apart from the main element', () => {
  const sf = STA.setup.fromIracing(SF23, { car: 'Super Formula SF23 - Toyota', track: 'Suzuka', name: 'sf' });
  assert.deepStrictEqual([roles(sf).flapangle, roles(sf).wingangle, roles(sf).gurneyflap], ['frontAero:front', 'rearWing:rear', 'rearAeroPart:rear']);
  const sfl = STA.setup.fromIracing(SFL, { car: 'Super Formula Lights', track: 'Suzuka', name: 'sfl' });
  assert.deepStrictEqual(roles(sfl), { aeropackage: 'aeroTrim:', frontflapconfiguration: 'frontAeroPart:front', frontflapangle: 'frontAero:front', frontflapgurneyflap: 'frontAeroPart:front',
    rearupperflapangle: 'rearWing:rear', rearbeamwingangle: 'rearAeroPart:rear' });
  // a front wing is never read as the rear wing, whatever it is called
  const other = STA.setup.fromIracing({ Aero: { FrontWingAngle: '5.0 deg', RearWingAngle: '9.0 deg', RearWingWicker: '0.5 in' }, Chassis: { Rear: { WingAngle: '6 deg' }, Front: { WingAngle: '3 deg' } } }, { car: 'x', track: 'x', name: 'x' });
  assert.deepStrictEqual(other.params.map((p) => p.role + ':' + p.axle), ['frontAero:front', 'rearWing:rear', 'rearAeroPart:rear', 'rearWing:rear', 'frontAero:front']);
  // unchanged: GT3 splitter and wing, LMU wings
  const gt3 = STA.setup.fromIracing(STA.yaml.parse(SETUP_YAML).CarSetup, { car: 'Test GT3', track: 'x', name: 'x' });
  assert.deepStrictEqual([roles(gt3).rearwingsetting, roles(gt3).frontsplitter], ['rearWing:rear', 'frontAero:front']);
});

test('Super Formula: the front flap is offered for fast-corner understeer, and aero changes between runs are all seen', () => {
  const sf = STA.setup.fromIracing(SF23, { car: 'Super Formula SF23 - Toyota', track: 'Suzuka', name: 'sf' });
  const fast = [{ id: 'us-entry-high', kind: 'understeer', phase: 'entry', band: 'high', title: 'Corner entry understeer in fast corners', severity: 0.9, confidence: 'medium' }];
  const adv = STA.advisor.advise({ findings: fast }, sf, {});
  const flap = adv.suggestions.find((s) => s.blockKey === 'frontAero|front|+');
  assert.ok(flap, JSON.stringify(adv.suggestions.map((s) => s.blockKey)));
  assert.deepStrictEqual(flap.paramIds, ['tiresaero/frontaero/flapangle']);
  assert.ok(!JSON.stringify(adv).includes('Front aero (not adjustable on this car)'));
  const wing = STA.advisor.resolve(sf, 'rearWing', 'rear', '-', null);
  assert.deepStrictEqual(wing.params.map((p) => p.id), ['tiresaero/rearaero/wingangle'], 'the gurney is not moved as if it were the wing');

  const tree = JSON.parse(JSON.stringify(SFL)); Object.assign(tree.TiresAero.AeroSetup, { AeroPackage: 'Low DF', FrontFlapConfiguration: 'Low DF flap', FrontFlapAngle: '16.5 deg', FrontFlapGurneyFlap: '5mm', RearUpperFlapAngle: '9.0 deg' });
  const a = STA.setup.fromIracing(SFL, { car: 'Super Formula Lights', track: 'Suzuka', name: 'a' }), b = STA.setup.fromIracing(tree, { car: 'Super Formula Lights', track: 'Suzuka', name: 'b' });
  const ch = STA.learning.changesBetween(a, b).map((c) => c.key + ' ' + c.from + ' → ' + c.to).sort();
  assert.deepStrictEqual(ch, ['aeroTrim||- Medium DF → Low DF', 'frontAero|front|- 18.0 deg → 16.5 deg', 'rearWing|rear|- 12.0 deg → 9.0 deg']);
  // the flap type went down and the gurney went up in the same step: no single direction, so it is not judged as one change
  const only = JSON.parse(JSON.stringify(SFL)); only.TiresAero.AeroSetup.FrontFlapGurneyFlap = '10mm';
  const g = STA.learning.changesBetween(a, STA.setup.fromIracing(only, { car: 'Super Formula Lights', track: 'Suzuka', name: 'c' }));
  assert.deepStrictEqual(g.map((c) => [c.key, c.title, c.from, c.to]), [['frontAeroPart|front|+', 'Add front flap gurney or a bigger flap', 'None', '10mm']]);
  assert.strictEqual(STA.pace.purpose(g[0]), 'Grip in fast corners and under braking');
});
