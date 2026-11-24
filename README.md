# Setup-Tele-LMU_Iracing

A browser app that reads telemetry from **iRacing** and **Le Mans Ultimate (LMU)**, shows
where a lap was won or lost, and suggests setup changes aimed at lap time.

It runs entirely on your computer. Nothing is uploaded.

## What it does

| Tab | What you get |
|---|---|
| (recorder line) | Above the session list: what iRacing's telemetry recording is doing, with start and stop. Needs the program in `recorder/`. |
| Library | Your telemetry folders, sorted by sim, then car, then track. Opens a car and track the way you left it. |
| Lap comparison | Any number of laps overlaid: speed, pedals, steering, gear, RPM, G forces and each lap's running time difference to the reference lap, with every driven line on a map and a corner-by-corner table. Laps can come from different sessions at the same track. |
| Track map | The track drawn from your own position data, with the line coloured by speed, by throttle and brake, or by where each lap gains time. |
| Telemetry tables | Lap table, corner table, samples every 5–100 m, and tyre, brake and ride-height readings. Every table saves as CSV. |
| Setup advice | Findings from your fastest laps (balance by corner phase and speed, traction, locking, tyres, ride height, brakes, gearing), each with a confidence level, turned into specific changes to the setup that was on the car. Changes stay inside the car's known limits, and the tab shows whether your last setup change did what it was meant to. |
| Driving technique | Where your own best sections add up to a faster lap, which corners vary most, coasting, how you apply and release the brake and pick up the throttle, and how to drive around each handling problem the setup advice found. |
| Baseline setup | A starting setup for a car and track. Before proposing anything it checks whether you already have a setup in progress for that car and track, and tells you to carry on from it if so. |
| Setups and differences | Every setup the app has seen, and a side-by-side table of how any two or more differ. |

## Library: your telemetry folders, sorted

Add a folder once with **Add a telemetry folder** (for example `Documents\iRacing\telemetry`
and Le Mans Ultimate's `UserData\Telemetry`; add as many as you like). The app then:

- **Indexes it.** It reads only the header of each recording to learn the sim, car, track
  and time, and keeps that index between visits. Setups found in the files go into the setup
  library. Nothing is copied or uploaded.
- **Sorts it.** The Library tab lists sim, then car, then track, with the number of runs,
  how many are new, when the car was last driven there and the best lap. **Runs** shows
  each recording; **Open** loads the combination.
- **Keeps it current.** New recordings are picked up when the app opens and whenever you
  come back to its window, so there is nothing to add by hand after a run. A file the sim is
  still writing is left for the next check.
- **Picks up where you left off.** For each car and track the app remembers which runs
  were open, which laps were overlaid, the reference lap and the tab. **Continue** on the
  Library tab reopens the last combination that way, and adds a run recorded since.

Opening a combination closes runs from other cars and tracks. Their history, setups and
what the app has learned stay in the library.

What the browser allows: Chrome and Edge can remember a folder. After the browser has been
restarted it may ask once to read the folder again, which takes one click (**Allow and
rescan**). Other browsers can read a folder for one visit only: the index is kept, but the
folder has to be picked again before a file can be opened. Single files can still be
dropped on the page in any browser.

## iRacing recorder: recording that starts and stops itself

`recorder/` holds a small program that runs next to iRacing on the same PC. With it, the
loop is: drive, get out of the car, and the run is already open in the app.

- **Starts recording for you.** In automatic mode it switches iRacing's disk telemetry on
  whenever the sim is running, so there is no Alt+L to remember. iRacing itself writes a
  file only while you are in the car and closes it when you get out.
- **Start, stop and split from the app.** The recorder line above the session list shows
  what is happening (waiting for iRacing, ready, recording, switched off) with **Start
  recording** / **Stop recording**, **New file**, and a **Record every run** tick box.
  Stopping by hand leaves it off until you start it again.
- **Opens the run when it is saved.** When the sim closes a file the app indexes the
  folder straight away and, with **Open a run when it is saved** ticked, opens that car and
  track with the new run added. This needs the telemetry folder in the Library.

Set it up once:

1. Double-click `recorder\Start-iRacing-Recorder.cmd` and leave its window open while you
   drive. It runs in the Windows PowerShell that comes with Windows 10 and 11, so there is
   nothing to install. To have it start with Windows, put a shortcut to it in the Startup
   folder (Win+R, `shell:startup`).
2. In the app, press **Turn on** on the recorder line.

To check it on your PC before trusting it with a session, run
`recorder\Start-iRacing-Recorder.cmd -SelfTest`. It runs 52 checks of its own logic and
web server in a couple of seconds, prints the PowerShell version it ran in, and touches
nothing in iRacing.

How it works, and what it does not do:

- It uses only what iRacing's SDK provides for add-on programs: it reads the telemetry
  memory the sim publishes, and sends the SDK's telemetry command (stop, start, restart),
  which is the same switch as Alt+L. It never writes to the sim's memory, files or
  settings.
- It talks to the app through a web server on this computer only (`127.0.0.1:8765`).
  Pages opened from disk or served from localhost may use it; other websites are refused.
  If you host the app somewhere, start the recorder with
  `-AllowOrigin https://your.site`. `-Port` changes the port, `-Manual` starts it
  without automatic recording.
- In automatic mode, pressing Alt+L to switch telemetry off will be undone within a few
  seconds. Use **Stop recording** in the app, or untick **Record every run**.
- Recordings add up: an hour of driving is several hundred megabytes at iRacing's
  default 60 Hz. The recorder does not delete anything.
- `Start-iRacing-Recorder.cmd -Simulate` runs it against a pretend sim, which is how the
  link to the app is tested.
- The launcher starts the script with `-ExecutionPolicy Bypass`, which applies to that one
  window only. On a PC where an administrator has locked the PowerShell execution policy,
  the script will be refused and that policy would have to allow it. Windows may also ask
  before running a `.cmd` file that was downloaded from the internet.
- iRacing only. Le Mans Ultimate has its own automatic recording setting in the game.

## Recorders that start with the simulator

You do not have to start a recorder by hand. A small watcher looks at the list of running
programs every three seconds:

- iRacing starts: the iRacing recorder starts. Le Mans Ultimate starts: the LMU lap
  recorder starts. Each runs in its own minimised window.
- The simulator closes: its recorder gets five seconds to save what it has, then it is
  stopped.
- A recorder that stops by itself while the simulator is still running is started again
  (at most once every 30 seconds).

Two ways to use it, both in the `recorder` folder:

- `Start-Recorders.cmd` starts the watcher now. Leave its window open (minimised is fine).
- `Install-AutoStart.cmd` adds a shortcut to your Windows Startup folder, so the watcher
  starts when you sign in. No administrator rights are needed. `Remove-AutoStart.cmd`
  takes the shortcut away again.

The watcher only reads the list of running programs. It looks for `iRacingSim64DX11`
(iRacing) and `Le Mans Ultimate` (LMU). `Start-Recorders.cmd -SelfTest` checks it on
your PC with a stand-in program.

## Le Mans Ultimate lap recorder

Le Mans Ultimate closes its own telemetry file when the session ends. To see laps
while the session is still on, run the lap recorder next to the game:

1. In the game: **Settings > Gameplay > Enable Plugins = On**, then restart the game.
2. Start `recorder/Start-LMU-Recorder.cmd` and leave its window open.
3. In the app, turn on the recorder link (top of the Library tab) and add the folder
   **Documents\\LMU live laps** to the Library once.

What happens then:

- The recorder reads the game's live data (the `LMU_Data` shared memory the game
  publishes) 50 times a second and keeps the laps of the current run in memory. It
  starts when the car leaves the pit lane.
- **When the game reports the car in the pits** (pit lane, garage, or back at the
  menus) the run is finished: its laps are written to a `.lmulaps` file and the app
  opens it a moment later. A run with no whole lap is dropped.
- The setup on the car is asked from the game's own local web service (read only), once
  when the run starts and again when it is saved. Two of the game's pages carry it
  (`/rest/garage/getPlayerGarageData` and `/rest/garage/UIScreen/CarSetupOverview`) and
  both are tried. If neither gives it, the run is saved without the setup, the recorder
  window says why ("did not answer", "answered with an error", "answered, but without
  setup values"), and the app shows the same reason next to the run. Setup advice is
  hidden for a run without a setup.
- "Save laps now" in the app saves the laps so far without waiting for the pits.
- These runs also carry the car's own forward and sideways velocity and yaw rate,
  which the game's `.duckdb` file does not, so **oversteer is measured** for them the
  same way as for iRacing (see "Understeer or oversteer").

Good to know:

- It uses the same port (8765) as the iRacing recorder, so run one of them at a time.
- Nothing is installed into the game and nothing is changed in it.
- `Start-LMU-Recorder.cmd -SelfTest` checks the script on your PC;
  `-DemoFile demo.lmulaps` writes a made-up three-lap run you can open in the app.
- The positions of the values in the game's memory were worked out from the layout in
  the game's plugin kit. The kit's header file is not part of this repository. A game
  update that changes the layout will need the recorder updated.
- Not yet tried against the game itself: see "Known limits".

## Tabs appear when they have something to show

- **Library** is always there.
- **Lap comparison, Track map, Telemetry tables, Driving technique** appear once a
  session is open.
- **Setup advice** appears when the open session has a setup. A run without one (for
  example an LMU lap-recorder run saved while the game did not answer) does not show it.
- **Baseline setup** and **Setups and differences** appear once at least one setup is
  known, from a recording or a setup file.

If the tab you were on is no longer there, the app moves to Lap comparison, or to the
Library when no session is open.

## Sessions in recorded order

Loaded sessions are listed in the order they were driven, earliest first, whatever order
the files were added in. They are grouped under the day, and each card leads with the
time the recording started (in your computer's time zone), followed by the track, car,
file, setup name and best lap. The same time appears on each overlaid lap and in "Did the
last change work?", so it is clear which run is which.

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

## The track in 3D

On the **Track map** tab, switch **Flat map** to **3D**. The reference lap is drawn as a
line in space with a wall standing on it: its height is the pedal. Brake is the red part
from the road up; throttle is the green part stacked on top. A braking peak is a tall red
fin before a corner, and mid-corner throttle is a green wall that starts at or after the
apex. It is a different way to look at the lap, not a replay.

- **Moving around.** Drag to turn the view, right-drag or Shift-drag to move it, scroll to
  zoom. Click the line to turn around that point; double-click or **Reset view** to start
  again; **From above** looks straight down. With the view selected, the arrow keys turn it
  and + and − zoom.
- **Linked to the traces.** The speed, throttle and brake traces of every overlaid lap sit
  below the view. Moving over either one shows the same point in both, with the values
  in the panel on the right.
- **Wall height** sets how tall a full pedal is drawn; **Steepness** exaggerates the hills
  (twice as steep by default), so small climbs and drops can be seen.
- **Height data.** iRacing files carry the car's altitude, and runs from the LMU lap
  recorder carry the game's own height. Le Mans Ultimate's own `.duckdb` recording has
  none, so those laps are drawn flat and the view says so.
- **What it is not.** There is no circuit model: the files do not say where the track
  edges are, so the view shows the line you drove on a plain ground. Perspective also
  makes near walls look taller than far ones; read exact values from the traces.

It is drawn on the page's ordinary canvas with no 3D library (a full redraw takes about
4 ms for a 4.7 km lap), so it works from a double-clicked `index.html` like the rest of
the app.

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
can be dropped in directly. Adding the folder to the Library reads the setup out of every
`.svm`, `.ibt` and `.duckdb` file in it without loading the telemetry, which is the quickest
way to fill the setup library. iRacing `.sto` files are encrypted and this app does not read or write them; load an `.ibt` recorded with that
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
- **Contesting a change.** Every suggestion has **Contest this change**. Pick a reason:
  you do not want the trade-off, you tried it and it did not help, you tried it and it
  made the car worse, or the car cannot do it. The change is taken out and the next way to
  get the same effect is offered in its place, marked as the alternative to what you
  contested. You can contest the alternative too. When no setup route is left for a
  problem, the app says so and shows the driving-side options instead. Contested changes
  are remembered per car (at every track), apply to the baseline as well, are listed under
  the suggestions with **Allow again**, and are included in the library export. Each
  change in a proposed baseline has its own **Contest** link; a change that only existed
  to balance a contested one (front aero trimmed to match a smaller rear wing) is dropped
  with it.
- **"Not possible on this car".** This is the fourth reason in the contest menu. LMU reports each setting's range, so the app knows its
  limits. iRacing does not, so there the app only knows a limit when the value itself says
  so (a bar that reads "Disconnected", a setting at zero) or when it is built in: a
  differential's lock on power, set as a count of clutch friction faces, is never taken
  below 2. If the app still suggests something the garage will not allow, choose **Not
  possible on this car** for that suggestion. The app records the current value as the
  limit in that direction for that car, stops suggesting the change, and re-plans around
  it. The limit is tied to the value: if "cannot go below 2" is recorded and a later setup
  has 4, a reduction is offered again. Limits can be removed from the list under the
  suggestions, and they are included in the library export.
- **Wings and flaps.** Which end of the car a wing or flap belongs to is read from its own
  name ("Front flap angle", "RWSetting") or, when the name does not say, from the garage
  section it sits in: on the Super Formula SF23 the front wing is "Front aero / Flap
  angle" and the rear is "Rear aero / Wing angle". The main element at each end is the
  one the advice moves. Gurneys, wickers, beam wings, flap types and aero packages are
  fixed choices, so the advice leaves them alone, but a change to any of them between
  two runs is picked up and judged on lap time like a wing change.

## Understeer or oversteer: how the balance is read

- **Oversteer is measured, not averaged (iRacing).** iRacing logs the car's forward and
  sideways velocity and its yaw rate. From those the app works out the slip angle of the
  rear axle, and from the steering the slip angle of the front. A moment counts as the
  rear sliding when the rear is at a bigger slip angle than the front, or far beyond the
  angle it normally works at. Oversteer is reported from how often that happens near the
  limit in each part of the corner ("rear slides for 16% of the time near the limit,
  repeats in C5, C12"), so a car that steps out and is caught shows up even when most
  of the corner is tidy.
- **Why this was changed.** The earlier reading compared the driver's steering with what
  a gentle corner needs and took the middle value. A slide that is caught lasts a
  fraction of a second, so the middle value never saw it, while holding the car at the
  limit mid-corner always takes more lock than the gentle-corner line. The result was
  "understeer" on cars that were loose, and changes that made them looser. On a public
  recording of a prototype whose rear slides for 46% of slow-corner exits, the old
  reading led with "soften the front bar, move brake bias rearward, take off rear wing,
  stiffen the rear bar"; the new one leads with traction control and a softer rear bar.
- **The rear comes first.** When the rear slides anywhere in the corner, understeer found
  alongside it is ranked below it and marked "after the rear is settled". For that
  understeer only front-end changes that do not take load or stability from the rear
  are offered (front camber, toe, pressures, dampers, front wing): no bars, springs,
  rear wing, differential or brake bias.
- **Le Mans Ultimate, and files without those channels.** The older steering-only reading
  is still used there, so treat an "understeer" finding on a car that feels loose with
  suspicion and contest the change.

## Car limits

A suggestion is never allowed to take a setting past what the car allows, and a setting
that is already outside the limit is the first thing the app tells you to fix.

- **Le Mans Ultimate.** Every recording carries the allowed range of every setting, so
  limits are known for any LMU car with nothing to maintain.
- **iRacing.** iRacing does not put ranges in its telemetry. The app carries a table
  (`js/data/car-limits.js`) of limits taken from
  [iRacing's per-car user manuals](https://www.iracing.com/resources/user-manuals/):
  legal ride-height windows, spring-rate ranges, and the click ranges of anti-roll bars,
  dampers, traction control, ABS and wings, for 44 cars. Each entry links the manual it
  came from, and the Setup advice tab shows the limits in force for the loaded car.
  A limit that only applies at one circuit (the 70 mm minimum ride height for GT3 cars on
  the Nürburgring Nordschleife) is only applied there.
- **Reported by a driver.** A limit that is real but not in a manual is marked as such.
  The Super Formula Lights front ride height (no more than 20 mm) is one.
- **A limit that depends on another setting.** On the Super Formula SF23 the only limit is
  the front flap angle, and how high it can go depends on the rear wing angle: at 18.5 deg
  of rear wing the flap stops at 24 deg (reported by a driver). The app keeps such a limit
  as points, one per rear wing angle. It applies the limit at a recorded angle, draws a
  straight line between two recorded angles (shown as an estimate), and assumes nothing
  outside them: there the Limits panel says the limit is not known yet. When the garage
  stops you at another rear wing angle, choose **Not possible on this car** on the
  suggestion, or enter the value under "Limits for the …"; it is stored for that rear
  wing angle. A suggestion to change the rear wing on this car carries a note that the
  front flap limit moves with it.
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

## Lap time is the yardstick

The goal is a faster lap, so that is what every change is measured against.

- **Pace profile.** Each session's best lap is kept as the time taken over every 10 m,
  tagged with what the car was doing there: straight, braking, slow corner (under
  100 km/h), medium corner or fast corner (over 160 km/h), plus the top speed.
- **Where the lap moved.** Two runs of the same car and track are laid over each other:
  "straights -0.31 s, fast corners +0.08 s, top speed +6 km/h". The zones come from the
  earlier lap, so both are measured over the same pieces of track.
- **Each change is judged where it acts.** Wing: straights, fast corners and braking.
  Brakes: braking. Differential and traction control: slow and medium corners and the
  straight after them. Springs, bars, dampers, geometry and pressures: every corner, the
  braking into it and the straight out of it. When the wing was changed in the same run,
  time on the straights is credited to the wing.
- **Result = time.** Helped means faster where the change acts; worse means slower. A
  handling problem that got smaller without the lap getting faster is reported as exactly
  that, not as having helped, and it is not held against the change either.
- **A wing change is a pace change.** Unless it answers a handling problem found in the
  earlier run, or you say otherwise, taking wing off is read as "top speed and time on
  the straights" and judged on the trade: what the straights gained against what the
  fast corners and braking lost.
- **The wing level gets its own entry in "Changes to make".** Every wing level run at this
  track is kept with its lap time against the others. On a slower level it offers the step
  back toward the fastest one ("Wing 3 was 0.47 s a lap faster than 1 here"). On the
  fastest level it offers one more step the same way only while the other side is
  untried; once it is slower both ways it offers nothing. Where the wing has never been
  changed here, half the lap or more is on the straights and the rear is stable in fast
  corners, it offers one step less as an experiment.

What to keep in mind: this compares one best lap with another, so a better-driven lap or
a cooler track shows up as time gained too. Time is counted where it shows on the track,
and a slow corner costs time on the straight after it as well as in the corner. Sessions
loaded before this was added have no pace profile until their file is opened again; they
are judged on overall lap time as before.

## Learning from your sessions

Every session you load leaves a short record in the library: the balance in each corner
phase, the findings, typical lap time and which setup was on the car. No raw telemetry is
kept. The app uses those records in three ways.

- **Did the last change work?** When the run before this one (same car, same track) used a
  different setup, every changed setting is treated as an experiment and shown as one row:
  - **Why** it was changed. The app reads this from its rules (the change is a usual answer
    to something found in the earlier run). If it cannot, it asks: pick what the change was
    for from the list. You can also correct the app's reading.
  - **Got**: how that measure moved.
  - **Result**: helped, no clear difference, or worse. You can overrule it ("I say: helped")
    when you felt something the numbers do not show; the tally then uses your call.
  - **What the app makes of it** when the expectation was missed:
    - right direction but too small (a bigger step is offered next time)
    - this setting does not drive the problem on this car (the next kind of setting is named)
    - it went the wrong way
    - your laps show a driving habit that produces the same problem
    - the problem got smaller but the lap did not get faster, so it was not what was costing time
- **Unexpected gains.** When a problem got better and nothing was aimed at it, the change
  is credited. One clean result (a single change) or two shared ones make it an answer the
  app offers for that problem on that car, marked "Learned on this car". If it later fails
  for that problem, the lesson is withdrawn.
- **What your runs have taught the app about this car.** The current understanding in
  plain sentences, each with a confidence level: what works and by how much, what does not,
  what was newly learned, and what a single change was worth in lap time.
- **Suggestions re-ordered by results on this car.** Tallies are kept per change and per
  problem, across all tracks. Changes that have helped move up. A change with two results
  against it and none for it goes to the bottom, so the next alternative leads.
- **Recurring problems shape the baseline.** A balance problem seen in two or more earlier
  sessions with a car is leaned against when a new baseline is built.

The more before-and-after pairs the library holds, the more the order of suggestions
reflects your car and your driving instead of general rules. To get clean evidence, change
one or two things at a time and keep loading the files, including runs where nothing
changed.

What this cannot do: lap time also moves with track temperature, fuel, tyre wear and
practice, so one comparison is weak evidence, and when several settings change at once the
app cannot tell which one did what. It says so on the page when that applies. What it
learns is limited to what it can measure: which change moved which problem, in which
direction, and whether one step was enough. It does not model the car, and it only knows
why you changed something if the rules explain it or you tell it.

## How the advice is laid out

The Setup advice tab leads with the changes. Each one is two lines: what to change and
by how much, then the current value, the problem it fixes and what it costs. Anything
else is a click away: "How it works" under a change, "Not offered" for routes the car
cannot take, "Balance by corner phase and speed" under the findings, and the car's
limits at the bottom. "Did the last change work?" only appears when there is an earlier
session with the same car and track to compare with. The Driving technique tab follows
the same pattern: a headline number, one thing to try, and the corners it applies to.

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

- **The LMU lap recorder has not been run against the game.** It was built and tested
  without Le Mans Ultimate: the self-test and a made-up session played into a copy of
  the game's memory exercise the reading, the pit detection, the file and the app. What
  that cannot show is whether the game puts every value where the recorder expects it,
  whether "in the pits" switches at the moment you expect, and whether the game's web
  service answers with the setup. If a first real run shows odd values, that is where
  to look.
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

The recorder tests itself: `recorder\Start-iRacing-Recorder.cmd -SelfTest` (52 checks; they
cover everything except the two Windows calls that open iRacing's memory and send the
command).

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
    js/io/recorder.js     talks to the iRacing recorder on this PC
    recorder/             the iRacing recorder (PowerShell, Windows), with a built-in self-test
    js/store/folders.js   watched folders, the file index, where you left off
    js/store/library.js   browser-side setup and session library
    js/ui/                charts, the 3D view (track3d.js), DuckDB loader, app shell and tabs
    vendor/duckdb/        bundled DuckDB browser client (see its README)
    tests/                unit tests and the simulation that feeds them

## Third-party code

`vendor/duckdb/duckdb-browser.iife.js` bundles [duckdb-wasm](https://github.com/duckdb/duckdb-wasm)
(MIT) and [Apache Arrow JS](https://github.com/apache/arrow) (Apache-2.0). The pairing of
LMU setup-file keys with the keys in LMU's recorded setup was cross-checked against the
key table in [LMU-LoadTelemetry](https://github.com/marekwolny/LMU-LoadTelemetry), which
credits the LMU Telemetry Lab project, and against a real LMU recording.
