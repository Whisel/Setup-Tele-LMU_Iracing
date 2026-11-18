# Setup-Tele-LMU_Iracing

A browser app that reads telemetry from **iRacing** and **Le Mans Ultimate (LMU)**, shows
where a lap was won or lost, and suggests setup changes aimed at lap time.

It runs entirely on your computer. Nothing is uploaded.

## What it does

| Tab | What you get |
|---|---|
| Lap comparison | Any number of laps overlaid: speed, pedals, steering, gear, RPM, G forces and each lap's running time difference to the reference lap, with every driven line on a map and a corner-by-corner table. Laps can come from different sessions at the same track. |
| Track map | The track drawn from your own position data, with the line coloured by speed, by throttle and brake, or by where each lap gains time. |
| Telemetry tables | Lap table, corner table, samples every 5–100 m, and tyre, brake and ride-height readings. Every table saves as CSV. |
| Setup advice | Findings from your fastest laps (balance by corner phase and speed, traction, locking, tyres, ride height, brakes, gearing), each with a confidence level, turned into specific changes to the setup that was on the car. Changes stay inside the car's known limits, and the tab shows whether your last setup change did what it was meant to. |
| Driving technique | Where your own best sections add up to a faster lap, which corners vary most, coasting, how you apply and release the brake and pick up the throttle, and how to drive around each handling problem the setup advice found. |
| Baseline setup | A starting setup for a car and track. Before proposing anything it checks whether you already have a setup in progress for that car and track, and tells you to carry on from it if so. |
| Setups and differences | Every setup the app has seen, and a side-by-side table of how any two or more differ. |

## Overlaying laps

Each lap in the lap list has a **+** button; press it on as many laps as you like, or use
**Overlay all timed laps**. Every overlaid lap gets a letter and a colour that it keeps
until you remove it. One lap is the **reference** (the **Ref** button): time differences
and the corner table are measured against it, and you can change it at any time without
the other laps changing colour.

The first eight laps have their own colour. Laps beyond that are drawn in grey, because
more colours than that cannot be told apart reliably; point at a lap in the bar above the
charts to pick it out in the traces and on the map. The Telemetry tables tab shows the
reference lap and the next overlaid lap; all laps appear in the Lap comparison tab.

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
  so (a bar that reads "Disconnected", a setting at zero) or when it is built in: a
  differential's lock on power, set as a count of clutch friction faces, is never taken
  below 2. If the app still suggests something the garage will not allow, press **Not
  possible on this car** on that suggestion. The app records the current value as the
  limit in that direction for that car, stops suggesting the change, and re-plans around
  it. The limit is tied to the value: if "cannot go below 2" is recorded and a later setup
  has 4, a reduction is offered again. Limits can be removed from the list under the
  suggestions, and they are included in the library export.

## Car limits

A suggestion is never allowed to take a setting past what the car allows, and a setting
that is already outside the limit is the first thing the app tells you to fix.

- **Le Mans Ultimate.** Every recording carries the allowed range of every setting, so
  limits are known for any LMU car with nothing to maintain.
- **iRacing.** iRacing does not put ranges in its telemetry. The app carries a table
  (`js/data/car-limits.js`) of limits taken from
  [iRacing's per-car user manuals](https://www.iracing.com/resources/user-manuals/):
  legal ride-height windows, spring-rate ranges, and the click ranges of anti-roll bars,
  dampers, traction control, ABS and wings, for 43 cars. Each entry links the manual it
  came from, and the Setup advice tab shows the limits in force for the loaded car.
  A limit that only applies at one circuit (the 70 mm minimum ride height for GT3 cars on
  the Nürburgring Nordschleife) is only applied there.
- **Reported by a driver.** A limit that is real but not in a manual is marked as such.
  The Super Formula Lights front ride height (no more than 20 mm) is one.
- **Your own limits.** Under "Limits for the …" on the Setup advice tab, pick a setting,
  choose "cannot go above" or "cannot go below" and enter the value. It is stored per car,
  applies to the same setting on both sides of the car, takes effect immediately in the
  advice and the baseline, and replaces a built-in limit for that setting if the built-in
  one is wrong or out of date.

When the usual step would cross a limit, the step is shortened to land on it ("Raise the
front ride height to 20 mm, the limit for this car"). At the limit the change is not
offered and the app uses the next route to the same effect.

The manuals are uneven: some state every range, some state none, and iRacing can change a
car at any season build. A car or setting with no entry simply has no known limit. To add
one permanently, add a line to `js/data/car-limits.js`; the format is described at the
top of that file.

## Driving technique

The Driving technique tab is about the driver, not the car. It has two parts.

**Measured from your laps** (timed laps within 5% of your best):

- **Your best sections.** Each lap is cut into one section per corner. The app adds up
  your quickest run through each section, shows how much quicker that is than your best
  lap, and for the biggest losses says what the quicker lap did differently (braked later,
  carried more speed, reached full throttle earlier).
- **Repeatability.** Which corners vary most from lap to lap. Until laps repeat, a setup
  change worth a tenth cannot be told apart from normal variation.
- **Coasting.** Time on neither pedal, and where.
- **Braking.** How long you take to reach peak pressure in big stops, whether you finish
  braking before turning in, and whether you release the pedal abruptly.
- **Throttle.** Picking it up early and waiting on part throttle, and going back off it
  after applying it.
- **Steering.** Repeated corrections inside a corner.

**Driving around what the car is doing.** For every handling finding there is a short list
of what to try from the seat: for entry understeer, slow the car more and trail the brake;
for exit oversteer, squeeze the throttle and take a gear higher; and so on. Use these when
a setup change did not do what was expected, when the setting you need is at its limit, or
in a fixed-setup series.

## Learning from your sessions

Every session you load leaves a short record in the library: the balance in each corner
phase, the findings, typical lap time and which setup was on the car. No raw telemetry is
kept. The app uses those records in three ways.

- **Did the last change work?** When the session before this one (same car, same track)
  used a different setup, the app lists what you changed, what each change is normally
  meant to fix, how that measure moved, and a result: helped, no clear difference, made it
  worse, or helped but went too far. Where a change did not help it shows the driving
  technique for the same problem.
- **Suggestions re-ordered by results on this car.** Each kind of change (for example
  "soften the front anti-roll bar") keeps a tally per car across all tracks. Changes that
  have helped move up. A change with two results against it and none for it is moved to
  the bottom, so the next alternative leads. Each suggestion shows its record.
- **Recurring problems shape the baseline.** A balance problem seen in two or more earlier
  sessions with a car is leaned against when a new baseline is built.

The more before-and-after pairs the library holds, the more the order of suggestions
reflects your car and your driving instead of general rules. To get clean evidence, change
one or two things at a time and keep loading the files, including runs where nothing
changed.

What this cannot do: lap time also moves with track temperature, fuel, tyre wear and
practice, so one comparison is weak evidence, and when several settings change at once the
app cannot tell which one did what. It says so on the page when that applies. The learning
re-orders and annotates the general rules; it does not invent new rules or learn how big a
step your car needs.

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
- **iRacing limits are only as complete as the manuals.** The built-in table was read from
  iRacing's manuals in November 2026 and covers 43 cars, with ride-height limits for 18 of
  them. It has not been checked against the garage screen of each car. If the app and the
  garage disagree, the garage is right: enter the real limit on the Setup advice tab.
- **Driving advice uses general thresholds** (for example, more than 0.3 s to reach peak
  brake pressure counts as slow). They are not tuned per car, and a car without ABS or
  with heavy downforce is driven differently from a road-based one.
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
    js/data/car-limits.js per-car limits for iRacing, with their sources
    js/analysis/          handling analysis, advice rules, driving technique,
                          learning from earlier sessions, baseline
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
