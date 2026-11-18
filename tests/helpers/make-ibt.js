/* Writes an iRacing-format .ibt file in memory from a simulated run, so the
   reader is tested against the real byte layout rather than a mock. */
const { G } = require('./sim.js');

const SETUP_YAML = `CarSetup:
 UpdateCount: 3
 TiresAero:
  LeftFront:
   StartingPressure: 165.5 kPa
   LastHotPressure: 180.2 kPa
   LastTempsOMI: 70C, 78C, 85C
  RightFront:
   StartingPressure: 165.5 kPa
   LastHotPressure: 180.0 kPa
   LastTempsIMO: 84C, 77C, 69C
  LeftRear:
   StartingPressure: 158.6 kPa
  RightRear:
   StartingPressure: 158.6 kPa
  AeroSettings:
   RearWingSetting: 5
   FrontSplitter: 2
 Chassis:
  Front:
   ArbBlades: 3
   ToeIn: -1.5 mm
   BrakePressureBias: 54.0%
  LeftFront:
   CornerWeight: 3050 N
   RideHeight: 55.0 mm
   SpringRate: 220 N/mm
   LsCompDamping: 6 clicks
   Camber: -3.4 deg
  RightFront:
   CornerWeight: 3050 N
   RideHeight: 55.0 mm
   SpringRate: 220 N/mm
   LsCompDamping: 6 clicks
   Camber: -3.4 deg
  LeftRear:
   RideHeight: 70.0 mm
   SpringRate: 180 N/mm
   Camber: -2.1 deg
   ToeIn: +1.0 mm
  RightRear:
   RideHeight: 70.0 mm
   SpringRate: 180 N/mm
   Camber: -2.1 deg
   ToeIn: +1.0 mm
  Rear:
   ArbBlades: 2
   FuelLevel: 60.0 L
 Drivetrain:
  Differential:
   DiffPreload: 80 Nm
  TractionControl:
   TractionControlSetting: 4
`;

function sessionYaml(run, extra) {
  return `---
WeekendInfo:
 TrackName: testring
 TrackLength: ${(run.length / 1000).toFixed(2)} km
 TrackDisplayName: Test Ring
 TrackConfigName: Grand Prix
 EventType: Test
DriverInfo:
 DriverCarIdx: 0
 DriverCarRedLine: 7600.000
 DriverSetupName: ${(extra && extra.setupName) || 'baseline.sto'}
 Drivers:
 - CarIdx: 0
   UserName: Test Driver
   CarScreenName: Test GT3
   CarClassShortName: GT3
 - CarIdx: 1
   UserName: Pace Car
   CarScreenName: Safety Car
SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionType: Practice
${(extra && extra.setupYaml) || SETUP_YAML}...
`;
}

function makeIbt(run, extra) {
  const R = 6371000, lat0 = 47.22, lon0 = 14.76, k = 180 / Math.PI;
  const cols = [
    ['SessionTime', 5, 's', (j) => 100 + run.t[j]],
    ['Lap', 2, '', (j) => run.lap[j]],
    ['LapDist', 4, 'm', (j) => run.dist[j]],
    ['LapDistPct', 4, '%', (j) => run.dist[j] / run.length],
    ['LapLastLapTime', 4, 's', (j) => run.lastLap[j]],
    ['Speed', 4, 'm/s', (j) => run.speed[j]],
    ['Throttle', 4, '%', (j) => run.thr[j]],
    ['Brake', 4, '%', (j) => run.brk[j]],
    ['SteeringWheelAngle', 4, 'rad', (j) => run.steer[j] / k],
    ['Gear', 2, '', (j) => run.gear[j]],
    ['RPM', 4, 'revs/min', (j) => run.rpm[j]],
    ['LatAccel', 4, 'm/s^2', (j) => run.latG[j] * G],
    ['LongAccel', 4, 'm/s^2', (j) => run.longAccel[j]],
    ['Lat', 5, 'deg', (j) => lat0 + (run.y[j] / R) * k],
    ['Lon', 5, 'deg', (j) => lon0 + (run.x[j] / (R * Math.cos(lat0 / k))) * k],
    ['OnPitRoad', 1, '', () => 0],
    ['FuelLevel', 4, 'l', (j) => 60 - run.t[j] * 0.01],
  ];
  const size = { 1: 1, 2: 4, 4: 4, 5: 8 };
  let off = 0; const vars = cols.map(([name, type, unit, fn]) => { const v = { name, type, unit, fn, offset: off }; off += size[type]; return v; });
  const bufLen = off, yaml = Buffer.from(sessionYaml(run, extra) + '\0', 'latin1');
  const varHeaderOffset = 144, sessionInfoOffset = varHeaderOffset + vars.length * 144, bufOffset = sessionInfoOffset + yaml.length;
  const buf = Buffer.alloc(bufOffset + run.n * bufLen);
  [2, 1, run.hz, 0, yaml.length, sessionInfoOffset, vars.length, varHeaderOffset, 1, bufLen].forEach((v, i) => buf.writeInt32LE(v, i * 4));
  buf.writeInt32LE(run.n, 48); buf.writeInt32LE(bufOffset, 52);
  buf.writeBigInt64LE(BigInt((extra && extra.startDate) || 1767225600), 112); buf.writeDoubleLE(100, 120); buf.writeDoubleLE(100 + run.t[run.n - 1], 128);
  buf.writeInt32LE(run.trueLaps.length, 136); buf.writeInt32LE(run.n, 140);
  vars.forEach((v, i) => {
    const o = varHeaderOffset + i * 144;
    buf.writeInt32LE(v.type, o); buf.writeInt32LE(v.offset, o + 4); buf.writeInt32LE(1, o + 8);
    buf.write(v.name, o + 16, 'latin1'); buf.write('test channel', o + 48, 'latin1'); buf.write(v.unit, o + 112, 'latin1');
  });
  yaml.copy(buf, sessionInfoOffset);
  for (let j = 0; j < run.n; j++) {
    const base = bufOffset + j * bufLen;
    for (const v of vars) {
      const x = v.fn(j), o = base + v.offset;
      if (v.type === 5) buf.writeDoubleLE(x, o); else if (v.type === 4) buf.writeFloatLE(x, o); else if (v.type === 2) buf.writeInt32LE(x, o); else buf.writeUInt8(x ? 1 : 0, o);
    }
  }
  return buf;
}

module.exports = { makeIbt, SETUP_YAML };

/* Run directly to write a simulated recording to disk for trying the app:
     node tests/helpers/make-ibt.js sample.ibt [understeer 0..1] [setup name] */
if (require.main === module) {
  const { drive } = require('./sim.js');
  const out = process.argv[2] || 'sample.ibt', us = parseFloat(process.argv[3] || '0.5'), name = process.argv[4] || 'sample_setup.sto';
  const yaml = us > 0.3 ? SETUP_YAML : SETUP_YAML.replace(/ArbBlades: 3/, 'ArbBlades: 2').replace(/RearWingSetting: 5/, 'RearWingSetting: 6');
  require('fs').writeFileSync(out, makeIbt(drive({ laps: 5, understeer: us }), { setupName: name, setupYaml: yaml, startDate: Math.floor(Date.now() / 1000) - (us > 0.3 ? 86400 : 0) }));
  console.log('Wrote ' + out + ' (simulated data, not from iRacing)');
}
