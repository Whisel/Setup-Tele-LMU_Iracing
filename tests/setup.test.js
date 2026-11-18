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
