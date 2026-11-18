# Setup-Tele-LMU_Iracing

A browser app that reads telemetry from **iRacing** and **Le Mans Ultimate (LMU)**, shows
where a lap was won or lost, and suggests setup changes aimed at lap time.

It runs entirely on your computer. Nothing is uploaded.

## What it does

| Tab | What you get |
|---|---|
| Lap comparison | Two laps (A and B) overlaid: speed, pedals, steering, gear, RPM, G forces and the running time difference, with both driven lines on a map and a corner-by-corner table. The two laps can come from different sessions at the same track. |
| Track map | The track drawn from your own position data, with the line coloured by speed, by throttle and brake, or by where each lap gains time. |
| Telemetry tables | Lap table, corner table, samples every 5–100 m, and tyre, brake and ride-height readings. Every table saves as CSV. |
| Setup advice | Findings from your fastest laps (balance by corner phase and speed, traction, locking, tyres, ride height, brakes, gearing), each with a confidence level, turned into specific changes to the setup that was on the car. |
| Baseline setup | A starting setup for a car and track. Before proposing anything it checks whether you already have a setup in progress for that car and track, and tells you to carry on from it if so. |
| Setups and differences | Every setup the app has seen, and a side-by-side table of how any two or more differ. |

## Running it

1. Download or clone this repository.
2. Open `index.html` in Chrome or Edge. No install and no build step.
3. Drop telemetry files onto the page, or use **Choose files**.

The first time you open an LMU recording, the app downloads the DuckDB engine (about
35 MB) from the jsDelivr CDN so it can read LMU's database format; the browser caches it
afterwards. iRacing files need no internet at all. To run LMU files fully offline, see
`vendor/duckdb/README.md`.

The app is a plain static site, so it can also be served by GitHub Pages or any web server.

## Getting telemetry out of the sims

**iRacing.** Turn on telemetry recording while in the car (Alt+L unless you have changed
the key). Each time you get in the car a new `.ibt` file is written to
`Documents\iRacing\telemetry`. The file contains the telemetry and the setup that was on
the car.

**Le Mans Ultimate (version 1.2 or later).** Turn on telemetry recording in the game's
gameplay settings (automatic recording, or bind the record key). Each session is written
as a `.duckdb` file to `Le Mans Ultimate\UserData\Telemetry`. The file contains the
telemetry and the setup that was on the car.

**Setups on their own.** LMU setup files (`.svm`, in `UserData\player\Settings\<track>`)
can be dropped in directly. **Scan a folder for setups** reads the setup out of every
`.svm`, `.ibt` and `.duckdb` file in a folder without loading the telemetry, which is the
quick way to tell the app what you have already been running. iRacing `.sto` setup files
are encrypted and this app does not read or write them; load an `.ibt` driven on that
setup instead. Telemetry recording is off until you press Alt+L, and the telemetry folder
does not exist until the first recording.

## How the setup advice works

The advice does not know which car you are driving. It applies general racing-car
engineering rules to what the telemetry shows, then looks for the matching setting in the
setup that was on the car.

- **Balance.** In gentle cornering, steering follows road curvature and lateral load in a
  straight-line way. The app fits that relationship from your laps, then measures how far
  your steering departs from it near the grip limit: more lock than expected means the
  front is sliding (understeer), less lock or opposite lock means the rear is (oversteer).
  This is split by corner phase (entry, middle, exit) and corner speed (slow, medium,
  fast), because the fix for a slow-corner problem is mechanical and the fix for a
  fast-corner problem is usually aerodynamic.
- **Other checks**, used when the file has the channel: wheel speeds (locking, wheelspin),
  traction-control activity, throttle lifts on exit, tyre temperature spread across the
  tread, ride height, brake temperatures, and time on the rev limiter in top gear.
- **Suggestions** are ordered most useful first. Where the sim stores a setting as a step
  number (most LMU settings), the app tells you how many steps to move rather than
  inventing a value.
- **When a change cannot be made, the app looks for another way to get the same effect.**
  A setting the car does not have, or one already at the end of its range, is skipped and
  the nearest equivalent is used instead: for example, if the rear anti-roll bar is
  already disconnected, the app stiffens the front bar, or softens the rear springs,
  rather than asking for a softer rear bar. What was skipped, and why, is listed under the
  suggestions.
- **"Not possible on this car".** LMU reports each setting's range, so the app knows its
  limits. iRacing does not, so there the app only knows a limit when the value itself says
  so (a bar that reads "Disconnected", a setting at zero). If it still suggests something
  the garage will not allow, press **Not possible on this car** on that suggestion. The
  app remembers it for that car, stops suggesting it, and re-plans around it. It can be
  undone from the list under the suggestions.

Each finding carries a confidence level:

- **High**: measured directly on three or more laps (for example wheel speeds), or a
  steering-based finding that tyre temperatures agree with.
- **Medium**: steering-based balance over three or more laps.
- **Low**: based on one or two laps, or on a general threshold that varies by car (tyre
  temperature spread, ride height, brake temperature).

Treat every suggestion as something to test: change one or two things, drive three to
five clean laps, load the new file and compare.

## How the baseline works

For the chosen sim, car and track, the app looks through its library in this order:

1. A setup you have already used for this car at this track. If there is one, the app
   says so and recommends continuing from it. You can still ask for a new baseline.
2. A setup of yours for the same car at another track, to be adapted.
3. The sim's own baseline for the car, to be adapted. A setup counts as the sim baseline
   if its name contains "baseline", "default" or "fixed", or if you mark it as such.

The new baseline is the starting setup plus a small number of changes driven by the track
(share of the lap at full throttle, mix of slow and fast corners, bumpiness, all measured
from telemetry when the app has seen the track, or chosen by you), by whether you prefer a
stable or a lively car, and by balance problems that keep appearing in your earlier
sessions with that car. The result is saved next to the sim baseline so the differences
can be seen in **Setups and differences**. With nothing to react to, the baseline is the
starting setup and the app says so.

## Where your data is kept

Setups and a short summary of each session (track, car, best lap, track character,
findings) are stored in the browser's own storage on this computer, per browser. Raw
telemetry is never stored; drop the file again to see its traces. Use **Export library**
and **Import library** in the Setups tab to back the library up or move it to another
browser or computer.

## Known limits

- **iRacing lap handling has been checked against simulated files, not a full real
  session.** The `.ibt` reader itself was checked against a real iRacing file, but that
  file is a few seconds long. Lap splitting, lap times and corner detection on the iRacing
  side are covered by the test suite using recordings generated in iRacing's file layout.
  The LMU side was checked against a real multi-lap LMU recording.
- **iRacing tyre data.** iRacing only refreshes tyre temperature, pressure and wear when
  the car is in the pits, so tyre findings for iRacing reflect the end of a run and are
  always low confidence.
- **LMU car names.** LMU's telemetry names the entry (team and number), not the car model,
  so two liveries of the same car look like different cars. A `.svm` file names the car
  differently again. The baseline tab shows same-class setups at the track separately for
  that reason.
- **Corner numbers** are assigned in driving order from the telemetry (C1, C2 …) and will
  not always match a circuit's official turn numbers.
- **Mislabelled channels.** LMU stores lateral and longitudinal G under each other's
  names. The app checks both against speed and the driven path and swaps them when needed,
  and tells you when it has.
- **iRacing setting ranges are not known to the app.** See "Not possible on this car"
  above.
- **The advice is general.** It has no per-car targets for tyre pressures, temperatures or
  ride heights, and it cannot tell you the lap time a change is worth.

## Tests

    npm test

Needs Node.js 20 or later and has no dependencies. The tests build recordings from a small
driving simulation with known answers (lap length, lap times, corner positions, an
understeering car and a neutral one) and run them through the same code the browser uses,
in both sims' formats. To write one of those simulated iRacing files to disk for trying
the app without your own data:

    node tests/helpers/make-ibt.js sample.ibt

## Layout

    index.html            page shell
    css/app.css           styles, light and dark themes
    js/core/util.js       maths and formatting helpers
    js/io/ibt.js          iRacing .ibt reader
    js/io/yaml-lite.js    reader for the session info inside an .ibt
    js/io/lmu.js          LMU .duckdb reader
    js/model/session.js   laps, distance grids, track map, corners
    js/model/setup.js     setups from both sims, roles, differences
    js/analysis/          handling analysis, advice rules, baseline
    js/store/library.js   browser-side setup and session library
    js/ui/                charts, DuckDB loader, app shell and tabs
    vendor/duckdb/        bundled DuckDB browser client (see its README)
    tests/                unit tests and the simulation that feeds them

## Third-party code

`vendor/duckdb/duckdb-browser.iife.js` bundles [duckdb-wasm](https://github.com/duckdb/duckdb-wasm)
(MIT) and [Apache Arrow JS](https://github.com/apache/arrow) (Apache-2.0). The pairing of
LMU setup-file keys with the keys in LMU's recorded setup was cross-checked against the
key table in [LMU-LoadTelemetry](https://github.com/marekwolny/LMU-LoadTelemetry), which
credits the LMU Telemetry Lab project, and against a real LMU recording.
