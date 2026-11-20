<#
  Le Mans Ultimate lap recorder for the Setup & Telemetry app.

  What it does
    Le Mans Ultimate only closes its own telemetry file when the session ends. This
    script reads the game's live data instead (the "LMU_Data" shared memory the game
    publishes while you drive) and keeps the laps of the current run in memory. As soon
    as the game reports the car in the pits (pit lane, garage, or back in the menus)
    the run is finished: the laps are written to a ".lmulaps" file and the web app is
    told, so the run can be opened there seconds later while the session carries on.

  What it needs
    Windows, Le Mans Ultimate v1.2 or newer, and in the game:
      Settings > Gameplay > Enable Plugins = On   (then restart the game)
    Nothing is installed into the game and nothing is sent to it, apart from one
    read-only question to the game's own local web service for the setup on the car.

  How to start it
    Double-click Start-LMU-Recorder.cmd, or:
      powershell -NoProfile -ExecutionPolicy Bypass -File lmu-recorder.ps1

  Options
    -OutDir <folder>     where runs are saved (default: Documents\LMU live laps)
    -Port <n>            port the web app talks to (default 8765, same as the iRacing recorder)
    -Hz <n>              samples per second, 10 to 100 (default 50)
    -AllowOrigin <url>   let a web page at this address use the recorder (repeatable)
    -DemoFile <path>     write a made-up three-lap run to this file and stop (to try the app)
    -MemoryImage <file>  read a saved copy of the game's memory instead of the game (for testing)
    -DemoDrive <file>    play a made-up two-lap stint into that file, eight times faster than life (for testing)
    -SelfTest            check the script on this computer and stop

  The web app talks to it on http://127.0.0.1:<port>:
    GET  /status    what the recorder sees and how many runs it has saved
    POST /command   {"cmd":"finish"} saves the laps recorded so far without waiting for the pits
#>
[CmdletBinding()]
param(
  [int]$Port = 8765,
  [string]$OutDir = '',
  [int]$Hz = 50,
  [string[]]$AllowOrigin = @(),
  [string]$DemoFile = '',
  [string]$MemoryImage = '',
  [string]$DemoDrive = '',
  [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:Version = '1.0'
$script:RestBase = 'http://localhost:6397'

# ------------------------------------------------------------------ the reader (compiled once, runs on its own thread)
# The byte positions below are where each value sits in the game's shared memory, worked
# out from the layout the game's plugin kit describes. Only the values the app uses are read.

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Text;
using System.Threading;

namespace StaLmu
{
    public static class Layout
    {
        public const int Size = 324820;
        // generic
        public const int GameVersion = 64;
        // scoring
        public const int Scoring = 1632;
        public const int ScTrackName = 0, ScSession = 64, ScCurrentET = 68, ScTrackLen = 88, ScNumVehicles = 104, ScInRealtime = 115, ScAmbient = 228, ScTrackTemp = 236;
        public const int Vehicles = 1632 + 560, VehSize = 584, MaxVehicles = 104;
        public const int VsDriver = 4, VsTotalLaps = 100, VsLapDist = 104, VsPathLateral = 112, VsLastS1 = 152, VsLastS2 = 160, VsLastLap = 168,
            VsIsPlayer = 196, VsInPits = 198, VsClass = 200, VsPitState = 457, VsInGarage = 507;
        // telemetry
        public const int Telemetry = 128464;
        public const int TlPlayerIdx = 1, TlHasVehicle = 2, TlVehicles = 4, TelSize = 1888;
        public const int TeElapsed = 12, TeLapNumber = 20, TeLapStart = 24, TeVehicleName = 32, TeTrackName = 96, TePos = 160, TeLocalVel = 184, TeLocalAccel = 208,
            TeLocalRot = 304, TeGear = 352, TeRpm = 356, TeThrottleRaw = 388, TeBrakeRaw = 396, TeSteerRaw = 404, TeClutchRaw = 412, TeThrottle = 420,
            TeFront3rd = 460, TeRear3rd = 468, TeFrontRide = 484, TeRearRide = 492, TeFuel = 524, TeMaxRpm = 532, TeAbsActive = 746, TeTcActive = 747, TeWheels = 848, WheelSize = 260;
        public const int WhSuspDefl = 0, WhRideHeight = 8, WhBrakeTemp = 24, WhRotation = 40, WhPressure = 120, WhTemp = 128, WhWear = 152, WhRadiusCm = 179, WhCarcass = 204;
    }

    /* One look at the game. */
    public sealed class Frame
    {
        public bool HasVehicle, InRealtime, InPits, InGarage;
        public int PitState, LapNumber, TotalLaps, Session, GameVersion;
        public double ET, LapStartET, LastLap, LastS1, LastS2, TrackLen, AirTemp, TrackTemp, MaxRpm;
        public string Track = "", Car = "", CarClass = "", Driver = "";
        public float[] V;      // one value per column
        public float[] W;      // four values (FL FR RL RR) per wheel column
    }

    public static class Columns
    {
        public static readonly string[] Cols = new string[] {
            "Ground Speed", "Throttle Pos Unfiltered", "Throttle Pos", "Brake Pos", "Clutch Pos", "Steering Pos", "Engine RPM",
            "G Force Lat", "G Force Long", "G Force Vert", "Pos X", "Pos Y", "Local Vel Forward", "Local Vel Lateral", "Yaw Rate",
            "Fuel Level", "FrontRideHeight", "RearRideHeight", "Front3rdDeflection", "Rear3rdDeflection", "Gear", "ABS", "TC", "Path Lateral" };
        public static readonly string[] WheelCols = new string[] {
            "Wheel Speed", "TyresPressure", "TyresTempLeft", "TyresTempCentre", "TyresTempRight", "TyresCarcassTemp", "Tyres Wear", "Brakes Temp", "RideHeights", "Susp Pos" };
    }

    /* Reads frames from the game's shared memory, or from a saved copy of it. */
    public sealed class Memory : IDisposable
    {
        private MemoryMappedFile map;
        private MemoryMappedViewAccessor acc;
        private readonly byte[] tel = new byte[Layout.TelSize];
        private readonly byte[] veh = new byte[Layout.VehSize];
        private readonly byte[] sc = new byte[560];
        private int playerScoring = -1;

        public static Memory OpenGame()
        {
            Memory m = new Memory();
            m.map = MemoryMappedFile.OpenExisting("LMU_Data", MemoryMappedFileRights.Read);
            m.acc = m.map.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
            return m;
        }

        public static Memory OpenImage(string path)
        {
            Memory m = new Memory();
            m.map = MemoryMappedFile.CreateFromFile(path, FileMode.Open);
            m.acc = m.map.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
            return m;
        }

        /* Read through a map someone else holds (the demo writes into it while this reads). */
        public static Memory Wrap(MemoryMappedFile shared)
        {
            Memory m = new Memory();
            m.acc = shared.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
            return m;
        }

        public long Capacity { get { return acc == null ? 0 : acc.Capacity; } }

        public void Dispose()
        {
            if (acc != null) { acc.Dispose(); acc = null; }
            if (map != null) { map.Dispose(); map = null; }
        }

        private static string Text(byte[] b, int off, int len)
        {
            int n = 0;
            while (n < len && b[off + n] != 0) n++;
            return Encoding.UTF8.GetString(b, off, n).Trim();
        }

        private static double D(byte[] b, int off) { return BitConverter.ToDouble(b, off); }

        private static float Clean(double v) { return double.IsNaN(v) || double.IsInfinity(v) ? 0f : (float)v; }

        /* null when the memory is too small to be the game's. */
        public Frame Read()
        {
            if (acc == null || acc.Capacity < Layout.Size) return null;
            Frame f = new Frame();
            f.GameVersion = acc.ReadInt32(Layout.GameVersion);
            acc.ReadArray<byte>(Layout.Scoring, sc, 0, sc.Length);
            f.Track = Text(sc, Layout.ScTrackName, 64);
            f.Session = BitConverter.ToInt32(sc, Layout.ScSession);
            f.TrackLen = D(sc, Layout.ScTrackLen);
            f.InRealtime = sc[Layout.ScInRealtime] != 0;
            f.AirTemp = D(sc, Layout.ScAmbient);
            f.TrackTemp = D(sc, Layout.ScTrackTemp);
            int count = Math.Max(0, Math.Min(Layout.MaxVehicles, BitConverter.ToInt32(sc, Layout.ScNumVehicles)));

            // The player's entry in the scoring list: usually where it was last time.
            int found = -1;
            if (playerScoring >= 0 && playerScoring < count && acc.ReadByte(Layout.Vehicles + playerScoring * Layout.VehSize + Layout.VsIsPlayer) != 0) found = playerScoring;
            for (int i = 0; found < 0 && i < count; i++)
                if (acc.ReadByte(Layout.Vehicles + i * Layout.VehSize + Layout.VsIsPlayer) != 0) found = i;
            playerScoring = found;
            float pathLateral = 0f;
            if (found >= 0)
            {
                acc.ReadArray<byte>(Layout.Vehicles + found * Layout.VehSize, veh, 0, veh.Length);
                f.Driver = Text(veh, Layout.VsDriver, 32);
                f.CarClass = Text(veh, Layout.VsClass, 32);
                f.TotalLaps = BitConverter.ToInt16(veh, Layout.VsTotalLaps);
                f.LastLap = D(veh, Layout.VsLastLap); f.LastS1 = D(veh, Layout.VsLastS1); f.LastS2 = D(veh, Layout.VsLastS2);
                f.InPits = veh[Layout.VsInPits] != 0;
                f.PitState = veh[Layout.VsPitState];
                f.InGarage = veh[Layout.VsInGarage] != 0;
                pathLateral = Clean(D(veh, Layout.VsPathLateral));
            }

            f.HasVehicle = acc.ReadByte(Layout.Telemetry + Layout.TlHasVehicle) != 0 && found >= 0;
            int idx = acc.ReadByte(Layout.Telemetry + Layout.TlPlayerIdx);
            if (!f.HasVehicle || idx >= Layout.MaxVehicles) { f.HasVehicle = false; return f; }
            long at = Layout.Telemetry + Layout.TlVehicles + (long)idx * Layout.TelSize;
            // The game rewrites this block 100 times a second. Read it until the same moment is seen before and after.
            for (int attempt = 0; attempt < 4; attempt++)
            {
                acc.ReadArray<byte>(at, tel, 0, tel.Length);
                if (acc.ReadDouble(at + Layout.TeElapsed) == D(tel, Layout.TeElapsed)) break;
            }
            f.ET = D(tel, Layout.TeElapsed);
            f.LapNumber = BitConverter.ToInt32(tel, Layout.TeLapNumber);
            f.LapStartET = D(tel, Layout.TeLapStart);
            f.Car = Text(tel, Layout.TeVehicleName, 64);
            if (f.Track.Length == 0) f.Track = Text(tel, Layout.TeTrackName, 64);
            f.MaxRpm = D(tel, Layout.TeMaxRpm);

            // The game's axes: x to the left of the car, y up, z to the rear.
            double vx = D(tel, Layout.TeLocalVel), vy = D(tel, Layout.TeLocalVel + 8), vz = D(tel, Layout.TeLocalVel + 16);
            float[] v = new float[Columns.Cols.Length];
            v[0] = Clean(Math.Sqrt(vx * vx + vy * vy + vz * vz) * 3.6);
            v[1] = Clean(D(tel, Layout.TeThrottleRaw) * 100); v[2] = Clean(D(tel, Layout.TeThrottle) * 100);
            v[3] = Clean(D(tel, Layout.TeBrakeRaw) * 100); v[4] = Clean(D(tel, Layout.TeClutchRaw) * 100);
            v[5] = Clean(D(tel, Layout.TeSteerRaw) * 100);
            v[6] = Clean(D(tel, Layout.TeRpm));
            v[7] = Clean(D(tel, Layout.TeLocalAccel) / 9.80665); v[8] = Clean(-D(tel, Layout.TeLocalAccel + 16) / 9.80665); v[9] = Clean(D(tel, Layout.TeLocalAccel + 8) / 9.80665);
            v[10] = Clean(D(tel, Layout.TePos)); v[11] = Clean(D(tel, Layout.TePos + 16));
            v[12] = Clean(-vz); v[13] = Clean(vx); v[14] = Clean(D(tel, Layout.TeLocalRot + 8));
            v[15] = Clean(D(tel, Layout.TeFuel));
            v[16] = Clean(D(tel, Layout.TeFrontRide)); v[17] = Clean(D(tel, Layout.TeRearRide));
            v[18] = Clean(D(tel, Layout.TeFront3rd)); v[19] = Clean(D(tel, Layout.TeRear3rd));
            v[20] = BitConverter.ToInt32(tel, Layout.TeGear);
            v[21] = tel[Layout.TeAbsActive] != 0 ? 1f : 0f; v[22] = tel[Layout.TeTcActive] != 0 ? 1f : 0f;
            v[23] = pathLateral;
            f.V = v;

            float[] w = new float[Columns.WheelCols.Length * 4];
            for (int k = 0; k < 4; k++)
            {
                int o = Layout.TeWheels + k * Layout.WheelSize;
                double radius = tel[o + Layout.WhRadiusCm] / 100.0;
                if (radius < 0.15) radius = 0.34;
                w[0 * 4 + k] = Clean(Math.Abs(D(tel, o + Layout.WhRotation)) * radius);
                w[1 * 4 + k] = Clean(D(tel, o + Layout.WhPressure));
                w[2 * 4 + k] = Clean(D(tel, o + Layout.WhTemp) - 273.15);
                w[3 * 4 + k] = Clean(D(tel, o + Layout.WhTemp + 8) - 273.15);
                w[4 * 4 + k] = Clean(D(tel, o + Layout.WhTemp + 16) - 273.15);
                w[5 * 4 + k] = Clean(D(tel, o + Layout.WhCarcass) - 273.15);
                w[6 * 4 + k] = Clean(D(tel, o + Layout.WhWear) * 100);
                w[7 * 4 + k] = Clean(D(tel, o + Layout.WhBrakeTemp));
                w[8 * 4 + k] = Clean(D(tel, o + Layout.WhRideHeight));
                w[9 * 4 + k] = Clean(D(tel, o + Layout.WhSuspDefl));
            }
            f.W = w;
            return f;
        }
    }

    /* The laps of one run, ready to be written. */
    public sealed class Run
    {
        public int N;
        public double[] T;
        public float[][] Data;        // Cols then WheelCols x 4, each N long
        public double[] LapTs, LapTime, LapS1, LapS2;
        public int[] LapNum;
        public string Track = "", Car = "", CarClass = "", Driver = "";
        public int Session, GameVersion;
        public double TrackLen, AirTemp, TrackTemp, MaxRpm, TStart, TEnd;
        public DateTime StartedUtc;

        /* File: "STALMU01", header length (int32), header (UTF-8 JSON), zero padding to a multiple of 8,
           then N float64 times and N float32 per column. */
        public void Write(string path, byte[] header)
        {
            string tmp = path + ".part";
            using (FileStream fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            using (BinaryWriter bw = new BinaryWriter(fs))
            {
                bw.Write(Encoding.ASCII.GetBytes("STALMU01"));
                bw.Write(header.Length);
                bw.Write(header);
                int pad = (8 - ((12 + header.Length) % 8)) % 8;
                for (int i = 0; i < pad; i++) bw.Write((byte)0);
                byte[] buf = new byte[N * 8];
                Buffer.BlockCopy(T, 0, buf, 0, N * 8);
                bw.Write(buf, 0, N * 8);
                for (int c = 0; c < Data.Length; c++)
                {
                    Buffer.BlockCopy(Data[c], 0, buf, 0, N * 4);
                    bw.Write(buf, 0, N * 4);
                }
            }
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);   // the app only ever sees a finished file
        }
    }

    /* Keeps the samples of the current run and decides when it starts and ends. */
    public sealed class Recorder
    {
        public const int Settle = 4;            // looks in a row before "in the pits" or "on track" is believed
        private int n, cap;
        private double[] t;
        private float[][] data;
        private readonly List<double> lapTs = new List<double>(), lapTime = new List<double>(), lapS1 = new List<double>(), lapS2 = new List<double>();
        private readonly List<int> lapNum = new List<int>();
        private int lastLap = int.MinValue, lastTotal = int.MinValue, pitLooks, trackLooks;
        private double lastET = double.NegativeInfinity;
        private Frame first, last;
        private DateTime started;
        private Run ready;

        public bool Connected, Driving, InPits, Recording;
        public int Samples { get { return n; } }
        public int Laps { get { return Math.Max(0, lapTs.Count - 1); } }
        public bool RunReady { get { return ready != null; } }
        public string Track = "", Car = "";

        public Recorder() { Clear(); }

        private void Clear()
        {
            n = 0; cap = 4096;
            t = new double[cap];
            data = new float[Columns.Cols.Length + Columns.WheelCols.Length * 4][];
            for (int c = 0; c < data.Length; c++) data[c] = new float[cap];
            lapTs.Clear(); lapTime.Clear(); lapS1.Clear(); lapS2.Clear(); lapNum.Clear();
            lastLap = int.MinValue; lastTotal = int.MinValue; lastET = double.NegativeInfinity; first = null; last = null;
        }

        private void Append(Frame f)
        {
            if (n == cap)
            {
                cap *= 2;
                Array.Resize(ref t, cap);
                for (int c = 0; c < data.Length; c++) Array.Resize(ref data[c], cap);
            }
            t[n] = f.ET;
            int cols = Columns.Cols.Length;
            for (int c = 0; c < cols; c++) data[c][n] = f.V[c];
            for (int c = 0; c < f.W.Length; c++) data[cols + c][n] = f.W[c];
            n++;
        }

        /* Give the recorder the next look at the game (null when the game is not there). */
        public void Step(Frame f)
        {
            Connected = f != null;
            Driving = f != null && f.HasVehicle && f.InRealtime;
            bool pit = !Driving || f.InPits || f.InGarage;
            InPits = Driving && pit;
            if (f != null) { Track = f.Track; Car = f.Car; }
            if (pit) { pitLooks++; trackLooks = 0; } else { trackLooks++; pitLooks = 0; }

            if (Recording)
            {
                if (Driving && f.ET > lastET)
                {
                    // A session restart winds the clock back: what was recorded belongs to the old session.
                    if (lastLap != int.MinValue && f.LapNumber < lastLap) { Finish(); return; }
                    if (lastLap != int.MinValue && f.LapNumber != lastLap) { lapTs.Add(f.LapStartET); lapNum.Add(f.LapNumber); lapTime.Add(0); lapS1.Add(0); lapS2.Add(0); }
                    lastLap = f.LapNumber;
                    // The official time arrives with the next scoring update, a moment after the line.
                    if (lastTotal != int.MinValue && f.TotalLaps != lastTotal && lapTs.Count > 0)
                    {
                        int k = lapTs.Count - 1;
                        if (lapTime[k] == 0) { lapTime[k] = f.LastLap > 0 ? f.LastLap : 0; lapS1[k] = f.LastS1 > 0 ? f.LastS1 : 0; lapS2[k] = f.LastS2 > 0 ? f.LastS2 : 0; }
                    }
                    lastTotal = f.TotalLaps;
                    Append(f); lastET = f.ET; last = f;
                }
                else if (Driving && f.ET < lastET - 1) { Finish(); return; }
                if (pitLooks >= Settle || !Driving) Finish();
            }
            else if (ready == null && Driving && trackLooks >= Settle)
            {
                Clear();
                Recording = true; first = f; started = DateTime.UtcNow;
                lastLap = f.LapNumber; lastTotal = f.TotalLaps;
                Append(f); lastET = f.ET; last = f;
            }
        }

        /* End the run now. It is kept only when it holds at least one whole lap. */
        public void Finish()
        {
            if (!Recording) return;
            Recording = false;
            if (lapTs.Count >= 2 && n > 10 && first != null)
            {
                Run r = new Run();
                r.N = n; r.T = new double[n]; Array.Copy(t, r.T, n);
                r.Data = new float[data.Length][];
                for (int c = 0; c < data.Length; c++) { r.Data[c] = new float[n]; Array.Copy(data[c], r.Data[c], n); }
                r.LapTs = lapTs.ToArray(); r.LapNum = lapNum.ToArray(); r.LapTime = lapTime.ToArray(); r.LapS1 = lapS1.ToArray(); r.LapS2 = lapS2.ToArray();
                r.Track = first.Track; r.Car = first.Car; r.CarClass = first.CarClass; r.Driver = first.Driver; r.Session = first.Session; r.GameVersion = first.GameVersion;
                r.TrackLen = first.TrackLen; r.AirTemp = last.AirTemp; r.TrackTemp = last.TrackTemp; r.MaxRpm = first.MaxRpm;
                r.TStart = t[0]; r.TEnd = t[n - 1]; r.StartedUtc = started;
                ready = r;
            }
            Clear();
        }

        public Run TakeRun() { Run r = ready; ready = null; return r; }
    }

    /* Looks at the game on its own thread, so the timing does not depend on the script. */
    public sealed class Sampler : IDisposable
    {
        private readonly object gate = new object();
        private readonly Recorder rec = new Recorder();
        private readonly string image;
        private readonly int hz;
        private Memory mem;
        private Thread thread;
        private volatile bool stop;
        public string LastError = "";

        public Sampler(int hz, string image) { this.hz = Math.Max(10, Math.Min(100, hz)); this.image = image; }

        public void Start()
        {
            thread = new Thread(Loop);
            thread.IsBackground = true;
            thread.Start();
        }

        private void Loop()
        {
            System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
            double next = 0, step = 1000.0 / hz, retryAt = 0;
            while (!stop)
            {
                Frame f = null;
                try
                {
                    if (mem == null && sw.Elapsed.TotalMilliseconds >= retryAt)
                    {
                        retryAt = sw.Elapsed.TotalMilliseconds + 2000;
                        try { mem = image != null && image.Length > 0 ? Memory.OpenImage(image) : Memory.OpenGame(); LastError = ""; }
                        catch (FileNotFoundException) { mem = null; }
                    }
                    if (mem != null) f = mem.Read();
                }
                catch (Exception e)
                {
                    LastError = e.Message;
                    if (mem != null) { try { mem.Dispose(); } catch (Exception) { } mem = null; }
                }
                lock (gate) { rec.Step(f); }
                next += step;
                double wait = next - sw.Elapsed.TotalMilliseconds;
                if (wait < -500) next = sw.Elapsed.TotalMilliseconds;   // fell behind (PC asleep): start the rhythm again
                else if (wait > 0) Thread.Sleep((int)Math.Ceiling(wait));
            }
        }

        /* connected, driving, inPits, recording, samples, laps, runReady, track, car */
        public object[] Status()
        {
            lock (gate) { return new object[] { rec.Connected, rec.Driving, rec.InPits, rec.Recording, rec.Samples, rec.Laps, rec.RunReady, rec.Track, rec.Car }; }
        }

        public Run TakeRun() { lock (gate) { return rec.TakeRun(); } }
        public void FinishNow() { lock (gate) { rec.Finish(); } }

        public void Dispose()
        {
            stop = true;
            if (thread != null) thread.Join(1000);
            if (mem != null) { mem.Dispose(); mem = null; }
        }
    }

    /* A made-up car on a made-up track, written into a copy of the game's memory. Used by -DemoFile and -SelfTest. */
    public sealed class Demo
    {
        public readonly byte[] Image = new byte[Layout.Size];
        public double ET, LapStart, S;          // seconds, seconds, metres round the lap
        public int Lap;
        public bool InPits = true, InGarage = true, Realtime = true, HasVehicle = true;
        private int scoringLaps;
        private double lastLapTime, x, z, heading;
        public const double Straight = 500, Radius = 60;
        public static double Length { get { return 2 * Straight + 2 * Math.PI * Radius; } }

        private void PutD(int off, double v) { Buffer.BlockCopy(BitConverter.GetBytes(v), 0, Image, off, 8); }
        private void PutI(int off, int v) { Buffer.BlockCopy(BitConverter.GetBytes(v), 0, Image, off, 4); }
        private void PutS(int off, string s) { byte[] b = Encoding.UTF8.GetBytes(s); Buffer.BlockCopy(b, 0, Image, off, b.Length); Image[off + b.Length] = 0; }

        private static double Curvature(double s)
        {
            double m = s % Length;
            if (m < Straight) return 0;
            if (m < Straight + Math.PI * Radius) return 1 / Radius;
            if (m < 2 * Straight + Math.PI * Radius) return 0;
            return 1 / Radius;
        }

        private static double Speed(double s)
        {
            double m = s % Length, corner = 24, top = 70;
            double[] starts = new double[] { Straight, 2 * Straight + Math.PI * Radius };
            double v = Curvature(s) > 0 ? corner : top;
            foreach (double c in starts)
            {
                double before = c - m;                          // metres to the corner
                if (before > 0 && before < 220) v = Math.Min(v, Math.Sqrt(corner * corner + 2 * 11.0 * before));
                double after = m - (c + Math.PI * Radius);      // metres since the corner ended
                if (after < 0) after += Length;
                if (after >= 0 && after < 420 && Curvature(s) == 0) v = Math.Min(v, Math.Sqrt(corner * corner + 2 * 5.5 * after));
            }
            return v;
        }

        /* Move the car on by dt seconds and write what the game would publish. */
        public void Advance(double dt)
        {
            double v = InGarage ? 0 : Speed(S), k = InGarage ? 0 : Curvature(S), v2 = InGarage ? 0 : Speed(S + v * dt);
            double accel = (v2 - v) / dt;
            S += v * dt; ET += dt;
            heading += v * k * dt;
            x += v * Math.Sin(heading) * dt; z += v * Math.Cos(heading) * dt;
            if (S >= (Lap + 1) * Length) { lastLapTime = ET - LapStart; Lap++; LapStart = ET; }
            // scoring is refreshed five times a second
            bool scoringTick = Math.Floor(ET * 5) != Math.Floor((ET - dt) * 5);

            PutI(Layout.GameVersion, 14);
            int sc = Layout.Scoring;
            PutS(sc + Layout.ScTrackName, "Demo Speedway");
            PutI(sc + Layout.ScSession, 1);
            PutD(sc + Layout.ScTrackLen, Length);
            PutI(sc + Layout.ScNumVehicles, 2);
            Image[sc + Layout.ScInRealtime] = (byte)(Realtime ? 1 : 0);
            PutD(sc + Layout.ScAmbient, 24); PutD(sc + Layout.ScTrackTemp, 31);
            int vh = Layout.Vehicles + 1 * Layout.VehSize;      // the player is the second car in the list
            PutS(vh + Layout.VsDriver, "Demo Driver"); PutS(vh + Layout.VsClass, "GT3");
            Image[vh + Layout.VsIsPlayer] = 1;
            if (scoringTick)
            {
                if (scoringLaps != Lap) { scoringLaps = Lap; PutD(vh + Layout.VsLastLap, lastLapTime); PutD(vh + Layout.VsLastS1, lastLapTime * 0.3); PutD(vh + Layout.VsLastS2, lastLapTime * 0.65); }
                Buffer.BlockCopy(BitConverter.GetBytes((short)scoringLaps), 0, Image, vh + Layout.VsTotalLaps, 2);
                Image[vh + Layout.VsInPits] = (byte)(InPits ? 1 : 0);
                Image[vh + Layout.VsInGarage] = (byte)(InGarage ? 1 : 0);
                PutD(vh + Layout.VsPathLateral, 0.4);
            }
            int tl = Layout.Telemetry;
            Image[tl + Layout.TlPlayerIdx] = 3; Image[tl + Layout.TlHasVehicle] = (byte)(HasVehicle ? 1 : 0);
            int te = tl + Layout.TlVehicles + 3 * Layout.TelSize;
            PutD(te + Layout.TeElapsed, ET); PutI(te + Layout.TeLapNumber, Lap); PutD(te + Layout.TeLapStart, LapStart);
            PutS(te + Layout.TeVehicleName, "Demo GT3 #7"); PutS(te + Layout.TeTrackName, "Demo Speedway");
            PutD(te + Layout.TePos, x); PutD(te + Layout.TePos + 16, z);
            double rear = 3.5 * Math.Min(1, v * v * k / 9.6) * Math.PI / 180;      // rear slip angle
            PutD(te + Layout.TeLocalVel, 1.35 * v * k - Math.Tan(rear) * v); PutD(te + Layout.TeLocalVel + 16, -v);
            PutD(te + Layout.TeLocalAccel, v * v * k); PutD(te + Layout.TeLocalAccel + 16, -accel); PutD(te + Layout.TeLocalAccel + 8, 0);
            PutD(te + Layout.TeLocalRot + 8, v * k);
            PutI(te + Layout.TeGear, Math.Max(1, Math.Min(6, 1 + (int)(v / 13))));
            PutD(te + Layout.TeRpm, 3500 + (v % 13) / 13 * 4000); PutD(te + Layout.TeMaxRpm, 9000);
            double thr = accel > 0.3 ? 1 : accel > -0.5 ? 0.3 : 0, brk = accel < -1 ? Math.Min(1, -accel / 14) : 0, steer = Math.Max(-1, Math.Min(1, 26 * k + 0.002 * v * v * k));
            PutD(te + Layout.TeThrottleRaw, thr); PutD(te + Layout.TeThrottle, thr); PutD(te + Layout.TeBrakeRaw, brk); PutD(te + Layout.TeSteerRaw, steer);
            PutD(te + Layout.TeFuel, 60 - ET * 0.02);
            PutD(te + Layout.TeFrontRide, 0.05 - v * 0.0002); PutD(te + Layout.TeRearRide, 0.07 - v * 0.0002);
            PutD(te + Layout.TeFront3rd, 0.06); PutD(te + Layout.TeRear3rd, 0.08);
            for (int w = 0; w < 4; w++)
            {
                int o = te + Layout.TeWheels + w * Layout.WheelSize;
                Image[o + Layout.WhRadiusCm] = 34;
                PutD(o + Layout.WhRotation, -v / 0.34);
                PutD(o + Layout.WhPressure, 165 + w); PutD(o + Layout.WhWear, 0.98);
                PutD(o + Layout.WhTemp, 273.15 + 80); PutD(o + Layout.WhTemp + 8, 273.15 + 85); PutD(o + Layout.WhTemp + 16, 273.15 + 82);
                PutD(o + Layout.WhCarcass, 273.15 + 78); PutD(o + Layout.WhBrakeTemp, 420);
                PutD(o + Layout.WhRideHeight, 0.05); PutD(o + Layout.WhSuspDefl, 0.07);
            }
        }

        /* Where the car should be for a stint of `laps` whole laps: garage, pit lane, track, pit lane. */
        public void Plan(int laps)
        {
            if (ET > 2) InGarage = false;
            if (S > 150 && Lap <= laps) InPits = false;
            if (Lap == laps + 1 && S % Length > 200) InPits = true;      // into the pit lane after the last whole lap
        }

        /* Drive `laps` whole laps out of the garage and back into the pits, through the same reader and recorder the game is read with. */
        public static Run Drive(string imagePath, int laps, int hz)
        {
            Demo d = new Demo();
            Recorder rec = new Recorder();
            File.WriteAllBytes(imagePath, d.Image);
            using (MemoryMappedFile map = MemoryMappedFile.CreateFromFile(imagePath, FileMode.Open))
            using (MemoryMappedViewAccessor acc = map.CreateViewAccessor(0, Layout.Size, MemoryMappedFileAccess.ReadWrite))
            using (Memory mem = Memory.Wrap(map))
            {
                double dt = 1.0 / hz;
                for (int i = 0; i < hz * 3600 && !rec.RunReady; i++)
                {
                    d.Plan(laps);
                    d.Advance(dt);
                    acc.WriteArray<byte>(0, d.Image, 0, d.Image.Length);
                    rec.Step(mem.Read());
                }
            }
            return rec.TakeRun();
        }

    }
}
'@
if (-not ('StaLmu.Sampler' -as [type])) {
  if ($PSVersionTable.PSVersion.Major -le 5) { Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.Core') }
  else { Add-Type -TypeDefinition $source -Language CSharp }
}

# ------------------------------------------------------------------ small helpers

function Get-NowSeconds { return [double]([System.Diagnostics.Stopwatch]::GetTimestamp()) / [double]([System.Diagnostics.Stopwatch]::Frequency) }
function Write-Log([string]$Text) { Write-Host ((Get-Date -Format 'HH:mm:ss') + '  ' + $Text) }

function Get-OutDir {
  if ($OutDir) { return $OutDir }
  $docs = [Environment]::GetFolderPath('MyDocuments')
  if (-not $docs) { $docs = $PSScriptRoot }
  return (Join-Path $docs 'LMU live laps')
}

function Get-SafeName([string]$Text) {
  $s = ($Text -replace '[\\/:*?"<>|\x00-\x1f]', ' ').Trim()
  if (-not $s) { $s = 'Unknown' }
  if ($s.Length -gt 60) { $s = $s.Substring(0, 60).Trim() }
  return $s
}

$script:SessionNames = @{ 0 = 'Test Day'; 1 = 'Practice'; 2 = 'Practice'; 3 = 'Practice'; 4 = 'Practice'; 5 = 'Qualifying'; 6 = 'Qualifying'; 7 = 'Qualifying'; 8 = 'Qualifying'; 9 = 'Warmup'; 10 = 'Race'; 11 = 'Race'; 12 = 'Race'; 13 = 'Race' }

# The setup on the car, as the game's own local web service reports it. $null when it cannot be had.
function Get-SetupJson {
  try {
    $req = [System.Net.WebRequest]::Create($script:RestBase + '/rest/garage/getPlayerGarageData')
    $req.Method = 'GET'; $req.Timeout = 1500; $req.ReadWriteTimeout = 1500
    $res = $req.GetResponse()
    try {
      $reader = New-Object System.IO.StreamReader -ArgumentList $res.GetResponseStream(), ([System.Text.Encoding]::UTF8)
      $text = $reader.ReadToEnd()
    } finally { $res.Close() }
    if (-not $text -or $text.Length -gt 2000000) { return $null }
    $obj = $text | ConvertFrom-Json          # must be JSON, and must look like a setup
    $names = @($obj.PSObject.Properties.Name)
    if (@($names | Where-Object { $_ -like 'VM_*' }).Count -lt 3) { return $null }
    return $text
  } catch { return $null }
}

# The JSON header of a run file. The setup is spliced in as it came from the game.
function Get-RunHeader($Run, [string]$SetupJson, [int]$Rate) {
  $session = 'Practice'
  if ($script:SessionNames.ContainsKey([int]$Run.Session)) { $session = $script:SessionNames[[int]$Run.Session] }
  $meta = [ordered]@{
    TrackName = [string]$Run.Track; TrackLayout = [string]$Run.Track; CarName = [string]$Run.Car; CarClass = [string]$Run.CarClass; DriverName = [string]$Run.Driver
    SessionType = $session; RecordingTime = $Run.StartedUtc.ToString('yyyy-MM-ddTHH_mm_ssZ'); TrackLength = [Math]::Round([double]$Run.TrackLen, 1)
    AirTemp = [Math]::Round([double]$Run.AirTemp, 1); TrackTemp = [Math]::Round([double]$Run.TrackTemp, 1); MaxRpm = [Math]::Round([double]$Run.MaxRpm); GameVersion = [int]$Run.GameVersion
  }
  $head = [ordered]@{
    format = 'sta-lmu-live'; version = 1; recorder = $script:Version; hz = $Rate; n = [int]$Run.N; tStart = [double]$Run.TStart; tEnd = [double]$Run.TEnd
    cols = [StaLmu.Columns]::Cols; wheelCols = [StaLmu.Columns]::WheelCols; meta = $meta
    laps = [ordered]@{ ts = @($Run.LapTs); num = @($Run.LapNum); time = @($Run.LapTime); s1 = @($Run.LapS1); s2 = @($Run.LapS2) }
    setup = '@@SETUP@@'
  }
  $json = $head | ConvertTo-Json -Compress -Depth 6
  $setup = 'null'
  if ($SetupJson) { $setup = $SetupJson }
  return [System.Text.Encoding]::UTF8.GetBytes($json.Replace('"@@SETUP@@"', $setup))
}

function Save-Run($Run, [string]$SetupJson, [int]$Rate, [string]$Path) {
  if (-not $Path) {
    $dir = Get-OutDir
    if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    $name = (Get-SafeName $Run.Track) + '_' + (Get-SafeName $Run.Car) + '_' + $Run.StartedUtc.ToString('yyyy-MM-ddTHH_mm_ssZ') + '.lmulaps'
    $Path = Join-Path $dir $name
  }
  $Run.Write($Path, (Get-RunHeader $Run $SetupJson $Rate))
  return $Path
}

# ------------------------------------------------------------------ what the web app is told

$script:R = @{ Finished = 0; LastFinished = $null; LastFile = ''; LastLaps = 0; LastError = ''; Status = @($false, $false, $false, $false, 0, 0, $false, '', ''); Since = $null }

function Get-RecorderStatus {
  $s = $script:R.Status
  $last = $null
  if ($null -ne $script:R.LastFinished) { $last = [long]$script:R.LastFinished }
  return [ordered]@{
    app = 'sta-recorder'; version = $script:Version; sim = 'lmu'; mode = 'auto'
    connected = [bool]$s[0]; onTrack = ([bool]$s[1] -and -not [bool]$s[2]); inPits = [bool]$s[2]; enabled = $true; recording = [bool]$s[3]
    laps = [int]$s[5]; samples = [int]$s[4]; track = [string]$s[7]; car = [string]$s[8]
    finished = [int]$script:R.Finished; lastFinishedAt = $last; lastFile = [string]$script:R.LastFile; lastLaps = [int]$script:R.LastLaps
    recordingSince = $script:R.Since; simulated = $false; error = [string]$script:R.LastError
  }
}

function Test-OriginAllowed($Origin, [string[]]$Extra) {
  if ($null -eq $Origin) { return $true }
  if ($Origin -eq 'null') { return $true }
  $low = ([string]$Origin).ToLowerInvariant()
  foreach ($prefix in @('http://localhost', 'http://127.0.0.1', 'https://localhost', 'https://127.0.0.1')) {
    if ($low -eq $prefix -or $low.StartsWith($prefix + ':', [System.StringComparison]::Ordinal)) { return $true }
  }
  foreach ($e in $Extra) { if ($e -and $low -eq $e.ToLowerInvariant().TrimEnd('/')) { return $true } }
  return $false
}

function Get-Response([string]$Method, [string]$Path, [hashtable]$Headers, [string]$Body, [string[]]$Extra) {
  $origin = $null
  if ($Headers.ContainsKey('origin')) { $origin = $Headers['origin'] }
  if (-not (Test-OriginAllowed $origin $Extra)) { return @{ code = 403; body = @{ error = 'this website is not allowed to use the recorder' } } }
  $route = $Path.Split('?')[0]
  if ($Method -eq 'OPTIONS') { return @{ code = 204; body = $null } }
  if ($Method -eq 'GET') {
    if ($route -eq '/status') { return @{ code = 200; body = (Get-RecorderStatus) } }
    return @{ code = 404; body = @{ error = 'not found' } }
  }
  if ($Method -ne 'POST') { return @{ code = 405; body = @{ error = 'method not allowed' } } }
  if ($route -ne '/command') { return @{ code = 404; body = @{ error = 'not found' } } }
  $ctype = ''
  if ($Headers.ContainsKey('content-type')) { $ctype = $Headers['content-type'].ToLowerInvariant() }
  if ($ctype.IndexOf('application/json', [System.StringComparison]::Ordinal) -lt 0) { return @{ code = 415; body = @{ error = 'send JSON' } } }
  $cmd = ''
  try {
    $obj = $Body | ConvertFrom-Json
    if ($null -ne $obj -and ($obj.PSObject.Properties.Name -contains 'cmd')) { $cmd = [string]$obj.cmd }
  } catch { return @{ code = 400; body = @{ error = 'bad request' } } }
  $ok = $false; $message = 'Le Mans Ultimate laps are recorded by themselves; the only command is "finish".'
  if ($cmd -eq 'finish' -or $cmd -eq 'stop') {
    if ($script:Sampler) { $script:Sampler.FinishNow(); Invoke-Poll }
    $ok = $true; $message = ''
  } elseif ($cmd -eq 'auto' -or $cmd -eq 'start') { $ok = $true; $message = '' }
  $out = Get-RecorderStatus
  $out['ok'] = $ok
  if ($message) { $out['message'] = $message }
  $code = 409
  if ($ok) { $code = 200 }
  return @{ code = $code; body = $out }
}

$script:StatusText = @{ 200 = 'OK'; 204 = 'No Content'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 405 = 'Method Not Allowed'; 409 = 'Conflict'; 415 = 'Unsupported Media Type' }

function Invoke-Client($Client, [string[]]$Extra) {
  try {
    $Client.ReceiveTimeout = 400
    $Client.SendTimeout = 2000
    $stream = $Client.GetStream()
    $chunk = New-Object byte[] 4096
    $all = New-Object System.IO.MemoryStream
    $headEnd = -1
    while ($headEnd -lt 0 -and $all.Length -lt 16384) {
      $n = $stream.Read($chunk, 0, $chunk.Length)
      if ($n -le 0) { break }
      $all.Write($chunk, 0, $n)
      $headEnd = [System.Text.Encoding]::ASCII.GetString($all.ToArray()).IndexOf("`r`n`r`n", [System.StringComparison]::Ordinal)
    }
    if ($headEnd -lt 0) { return }
    $lines = [System.Text.Encoding]::ASCII.GetString($all.ToArray(), 0, $headEnd) -split "`r`n"
    $first = $lines[0].Split(' ')
    if ($first.Length -lt 2) { return }
    $headers = @{}
    for ($i = 1; $i -lt $lines.Length; $i++) {
      $colon = $lines[$i].IndexOf(':')
      if ($colon -gt 0) { $headers[$lines[$i].Substring(0, $colon).Trim().ToLowerInvariant()] = $lines[$i].Substring($colon + 1).Trim() }
    }
    $length = 0
    if ($headers.ContainsKey('content-length')) { [void][int]::TryParse($headers['content-length'], [ref]$length) }
    $length = [Math]::Max(0, [Math]::Min($length, 4096))
    $bodyStart = $headEnd + 4
    while (($all.Length - $bodyStart) -lt $length) {
      $n = $stream.Read($chunk, 0, $chunk.Length)
      if ($n -le 0) { break }
      $all.Write($chunk, 0, $n)
    }
    $body = ''
    $have = [int][Math]::Min($length, $all.Length - $bodyStart)
    if ($have -gt 0) { $body = [System.Text.Encoding]::UTF8.GetString($all.ToArray(), $bodyStart, $have) }

    $res = Get-Response $first[0].ToUpperInvariant() $first[1] $headers $body $Extra

    $payload = New-Object byte[] 0
    if ($null -ne $res.body) { $payload = [System.Text.Encoding]::UTF8.GetBytes(($res.body | ConvertTo-Json -Compress)) }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('HTTP/1.1 ' + $res.code + ' ' + $script:StatusText[[int]$res.code] + "`r`n")
    if ($headers.ContainsKey('origin') -and (Test-OriginAllowed $headers['origin'] $Extra)) {
      [void]$sb.Append('Access-Control-Allow-Origin: ' + $headers['origin'] + "`r`n")
      [void]$sb.Append("Vary: Origin`r`n")
      [void]$sb.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n")
      [void]$sb.Append("Access-Control-Allow-Headers: content-type`r`n")
      [void]$sb.Append("Access-Control-Allow-Private-Network: true`r`n")
      [void]$sb.Append("Access-Control-Max-Age: 600`r`n")
    }
    [void]$sb.Append("Content-Type: application/json`r`n")
    [void]$sb.Append("Cache-Control: no-store`r`n")
    [void]$sb.Append('Content-Length: ' + $payload.Length + "`r`n")
    [void]$sb.Append("Connection: close`r`n`r`n")
    $headBytes = [System.Text.Encoding]::ASCII.GetBytes($sb.ToString())
    $stream.Write($headBytes, 0, $headBytes.Length)
    if ($payload.Length -gt 0) { $stream.Write($payload, 0, $payload.Length) }
    $stream.Flush()
  } catch {
    # A client that hangs up or sends rubbish is simply dropped.
  } finally {
    try { $Client.Close() } catch { }
  }
}

# ------------------------------------------------------------------ the loop's own work

# Looks at the reader four times a second: reports changes and saves a run as soon as one is ready.
function Invoke-Poll {
  $s = $script:Sampler.Status()
  $was = $script:R.Status
  $script:R.Status = $s
  $script:R.LastError = [string]$script:Sampler.LastError
  if ([bool]$s[0] -and -not [bool]$was[0]) { Write-Log 'Le Mans Ultimate found.' }
  if (-not [bool]$s[0] -and [bool]$was[0]) { Write-Log 'Le Mans Ultimate closed.' }
  if ([bool]$s[3] -and -not [bool]$was[3]) { $script:R.Since = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()); Write-Log ('On track: recording. ' + $s[8] + ' at ' + $s[7]) }
  if (-not [bool]$s[3] -and [bool]$was[3]) { $script:R.Since = $null; if (-not [bool]$s[6]) { Write-Log 'Back in the pits before a whole lap was done: nothing to save.' } }
  if ([bool]$s[6]) {
    $run = $script:Sampler.TakeRun()
    if ($null -ne $run) {
      try {
        $setup = Get-SetupJson
        $path = Save-Run $run $setup $script:Rate ''
        $script:R.Finished = [int]$script:R.Finished + 1
        $script:R.LastFinished = [long]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $script:R.LastFile = [System.IO.Path]::GetFileName($path)
        $script:R.LastLaps = [int]$run.LapTs.Length - 1
        $setupText = 'with the setup'
        if (-not $setup) { $setupText = 'without the setup (the game did not answer)' }
        Write-Log ('In the pits: saved ' + ([int]$run.LapTs.Length - 1) + ' lap(s) ' + $setupText + ' -> ' + $path)
      } catch {
        $script:R.LastError = 'Could not save the run: ' + $_.Exception.Message
        Write-Log $script:R.LastError
      }
    }
  }
}

# ------------------------------------------------------------------ self-test

function Invoke-SelfTest {
  function Check([string]$Name, $Cond) {
    $script:__n++
    if ($Cond) { Write-Host ('  ok    ' + $Name) } else { Write-Host ('  FAIL  ' + $Name); $script:__f++ }
  }
  $script:__n = 0; $script:__f = 0
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('sta-lmu-' + [Guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $tmp -Force)
  try {
    $image = Join-Path $tmp 'memory.bin'
    $run = [StaLmu.Demo]::Drive($image, 3, 50)
    Check 'three laps out of the garage and back to the pits give a run' ($null -ne $run)
    if ($null -ne $run) {
      Check 'the run holds four line crossings (three whole laps)' ($run.LapTs.Length -eq 4)
      $lapLen = $run.LapTs[2] - $run.LapTs[1]
      Check ('a lap of the demo track takes 25 to 60 s (' + [Math]::Round($lapLen, 2) + ')') ($lapLen -gt 25 -and $lapLen -lt 60)
      Check 'the official lap time matches the crossings' ([Math]::Abs($run.LapTime[2] - $lapLen) -lt 0.05)
      Check 'nothing is recorded in the garage' ($run.TStart -gt 2)
      Check 'recording stops in the pit lane, not a lap later' (($run.TEnd - $run.LapTs[3]) -lt 20)
      Check 'car, track, class and driver are read' ($run.Car -eq 'Demo GT3 #7' -and $run.Track -eq 'Demo Speedway' -and $run.CarClass -eq 'GT3' -and $run.Driver -eq 'Demo Driver')
      $speed = $run.Data[0]; $max = 0.0; foreach ($v in $speed) { if ($v -gt $max) { $max = $v } }
      Check ('top speed is about 234 km/h (' + [Math]::Round($max, 1) + ')') ([Math]::Abs($max - 234.5) -lt 3)
      $cols = [StaLmu.Columns]::Cols.Length
      Check 'wheel speed is the car speed in m/s' ([Math]::Abs($run.Data[$cols + 0][200] * 3.6 - $speed[200]) -lt 0.5)
      Check 'tyre temperatures are in Celsius' ([Math]::Abs($run.Data[$cols + 3 * 4][200] - 85) -lt 0.01)
      Check 'tyre wear is in percent' ([Math]::Abs($run.Data[$cols + 6 * 4][200] - 98) -lt 0.01)
      Check 'forward speed is positive, in m/s' ([Math]::Abs($run.Data[12][200] * 3.6 - $speed[200]) -lt 0.5)
      $out = Join-Path $tmp 'run.lmulaps'
      [void](Save-Run $run '{"VM_REAR_WING":{"available":true,"value":5,"stringValue":"P5","minValue":0,"maxValue":10},"VM_A":{"available":true},"VM_B":{"available":true}}' 50 $out)
      $bytes = [System.IO.File]::ReadAllBytes($out)
      Check 'the file starts with its mark' ([System.Text.Encoding]::ASCII.GetString($bytes, 0, 8) -eq 'STALMU01')
      $hl = [BitConverter]::ToInt32($bytes, 8)
      $head = [System.Text.Encoding]::UTF8.GetString($bytes, 12, $hl) | ConvertFrom-Json
      Check 'the header names the run' ($head.format -eq 'sta-lmu-live' -and $head.meta.CarName -eq 'Demo GT3 #7' -and $head.n -eq $run.N)
      Check 'the setup is carried as the game gave it' ($head.setup.VM_REAR_WING.stringValue -eq 'P5')
      $pad = (8 - ((12 + $hl) % 8)) % 8
      $expect = 12 + $hl + $pad + $run.N * 8 + $run.N * 4 * ($cols + [StaLmu.Columns]::WheelCols.Length * 4)
      Check 'the file is exactly as long as its header says' ($bytes.Length -eq $expect)
      Check 'no half-written file is left behind' (-not (Test-Path -LiteralPath ($out + '.part')))
      Check 'the first time in the file is the start of the run' ([Math]::Abs([BitConverter]::ToDouble($bytes, 12 + $hl + $pad) - $run.TStart) -lt 1e-9)
    }
    # a stint that never completes a lap is not saved
    $short = [StaLmu.Demo]::Drive((Join-Path $tmp 'memory2.bin'), 0, 50)
    Check 'an out-lap straight back to the pits saves nothing' ($null -eq $short)
    # too small to be the game's memory
    $small = Join-Path $tmp 'small.bin'
    [System.IO.File]::WriteAllBytes($small, (New-Object byte[] 4096))
    $m = [StaLmu.Memory]::OpenImage($small)
    Check 'memory of the wrong size is refused' ($null -eq $m.Read())
    $m.Dispose()
    Check 'the layout ends where the game says it does' ([StaLmu.Layout]::Telemetry + 4 + 104 * 1888 -eq [StaLmu.Layout]::Size)
    Check 'web pages from elsewhere are refused' (-not (Test-OriginAllowed 'https://example.com' @()))
    Check 'pages on this computer are allowed' (Test-OriginAllowed 'http://localhost:8000' @())
    Check 'status says which sim it is for' ((Get-RecorderStatus).sim -eq 'lmu')
    Check 'file names are made safe' ((Get-SafeName 'Team: WRT #46/WE2?') -eq 'Team  WRT #46 WE2')
  } finally {
    try { Remove-Item -LiteralPath $tmp -Recurse -Force } catch { }
  }
  Write-Host ''
  if ($script:__f -eq 0) { Write-Host ('All ' + $script:__n + ' checks passed.'); return 0 }
  Write-Host ($script:__f.ToString() + ' of ' + $script:__n + ' checks FAILED.'); return 1
}

# ------------------------------------------------------------------ start

$script:Sampler = $null
$script:Rate = [Math]::Max(10, [Math]::Min(100, $Hz))

if ($SelfTest) { exit (Invoke-SelfTest) }

if ($DemoFile) {
  $image = [System.IO.Path]::GetTempFileName()
  try {
    $run = [StaLmu.Demo]::Drive($image, 3, $script:Rate)
    $path = Save-Run $run $null $script:Rate $DemoFile
    Write-Host ('Wrote a made-up three-lap run to ' + $path)
  } finally { try { Remove-Item -LiteralPath $image -Force } catch { } }
  exit 0
}

if ($DemoDrive) {
  # Plays the made-up car into a memory image while another copy of this script reads it with -MemoryImage.
  $demo = New-Object StaLmu.Demo
  [System.IO.File]::WriteAllBytes($DemoDrive, $demo.Image)
  $map = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateFromFile($DemoDrive, [System.IO.FileMode]::Open)
  $view = $map.CreateViewAccessor(0, [StaLmu.Layout]::Size)
  try {
    $pitSince = $null
    while ($true) {
      for ($k = 0; $k -lt 8; $k++) { $demo.Plan(2); $demo.Advance(0.02) }
      $view.WriteArray(0, $demo.Image, 0, $demo.Image.Length)
      if ($demo.Lap -ge 3 -and $demo.InPits) { if ($null -eq $pitSince) { $pitSince = Get-NowSeconds } elseif (((Get-NowSeconds) - $pitSince) -gt 3) { break } }
      Start-Sleep -Milliseconds 20
    }
  } finally { $view.Dispose(); $map.Dispose() }
  exit 0
}

if (-not $MemoryImage -and $env:OS -ne 'Windows_NT') {
  Write-Host 'Le Mans Ultimate runs on Windows, so the recorder does too. Use -SelfTest or -DemoFile to try it here.'
  exit 2
}

$listener = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Loopback), $Port
try { $listener.Start() } catch {
  Write-Host ('Port ' + $Port + ' on this computer is in use. Is a recorder already running (the iRacing one uses the same port)? Close it, or pick another port with -Port and set the same number in the app.')
  exit 1
}

$script:Sampler = New-Object StaLmu.Sampler -ArgumentList $script:Rate, $MemoryImage
$script:Sampler.Start()
Write-Log ('LMU lap recorder ' + $script:Version + '. Listening on http://127.0.0.1:' + $Port + '. Runs are saved in ' + (Get-OutDir))
Write-Log 'Leave this window open while you drive. Close it, or press Ctrl+C, to stop.'
Write-Log 'Waiting for Le Mans Ultimate (Settings > Gameplay > Enable Plugins must be On)...'

$nextPoll = 0.0
$waiting = New-Object System.Collections.ArrayList
try {
  while ($true) {
    while ($listener.Pending()) { [void]$waiting.Add(@{ Client = $listener.AcceptTcpClient(); At = (Get-NowSeconds) }) }
    for ($i = $waiting.Count - 1; $i -ge 0; $i--) {
      $w = $waiting[$i]
      $ready = $false
      try { $ready = ($w.Client.Available -gt 0) } catch { $ready = $false }
      if ($ready) { $waiting.RemoveAt($i); Invoke-Client $w.Client $AllowOrigin }
      elseif (((Get-NowSeconds) - $w.At) -gt 2.0) { $waiting.RemoveAt($i); try { $w.Client.Close() } catch { } }
    }
    $t = Get-NowSeconds
    if ($t -ge $nextPoll) { Invoke-Poll; $nextPoll = $t + 0.25 }
    Start-Sleep -Milliseconds 40
  }
} finally {
  $listener.Stop()
  if ($script:Sampler) {
    # Laps still in memory when the window is closed are saved rather than lost.
    try { $script:Sampler.FinishNow(); Invoke-Poll } catch { }
    $script:Sampler.Dispose()
  }
  Write-Host ((Get-Date -Format 'HH:mm:ss') + '  Stopped.')
}
