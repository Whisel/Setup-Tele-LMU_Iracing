<#
.SYNOPSIS
  iRacing recorder: switches iRacing's telemetry recording on and off.

.DESCRIPTION
  A small program that runs next to iRacing on the same Windows PC and works with
  the Setup and Telemetry web app. It needs nothing installed: it runs in the
  Windows PowerShell that comes with Windows 10 and 11 (and in PowerShell 7).

  What it does
    - Watches for iRacing through the sim's own SDK (read-only shared memory).
    - In automatic mode, switches disk telemetry on whenever the sim is running,
      so every run is recorded without pressing Alt+L. iRacing itself only writes
      a file while you are in the car, and closes it when you get out.
    - Lets the web app start, stop and split recording, and tells it when a run
      has been saved, so the app can pick the new file up straight away.

  How it talks to iRacing
    Only through the two channels iRacing provides for add-on programs:
    - reading the telemetry memory the sim publishes (Local\IRSDKMemMapFileName)
    - sending the SDK's telemetry command (broadcast message 10: stop, start,
      restart), which is the same switch as Alt+L
    It never writes to the sim's memory, files or settings and injects nothing.

  How it talks to the web app
    A tiny web server on this computer only (127.0.0.1). It answers
      GET  /status    what the sim and the recording are doing
      POST /command   {"cmd": "start" | "stop" | "restart" | "auto" | "manual"}
    Pages opened from disk and pages on localhost may call it. Any other website
    is refused unless you list it with -AllowOrigin.

.PARAMETER Port
  Port on this computer the app connects to. Default 8765.
.PARAMETER Manual
  Do not switch recording on automatically.
.PARAMETER Auto
  Switch recording on whenever iRacing is running (the default the first time).
.PARAMETER AllowOrigin
  Websites allowed to use the recorder, for example https://you.github.io
.PARAMETER Simulate
  Pretend iRacing is running. For trying the recorder and the app without the sim.
.PARAMETER SelfTest
  Check the recorder's own logic and its web server, then exit. Touches nothing in iRacing.
.PARAMETER MemoryImage
  For testing: read the sim's telemetry memory from this file instead of from iRacing.

.EXAMPLE
  Start-iRacing-Recorder.cmd
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File iracing-recorder.ps1 -SelfTest
#>
[CmdletBinding()]
param(
  [int]$Port = 8765,
  [switch]$Manual,
  [switch]$Auto,
  [string[]]$AllowOrigin = @(),
  [switch]$Simulate,
  [switch]$SelfTest,
  [string]$MemoryImage = ''
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$script:Version = '1.1'

# iRacing SDK constants (irsdk_defines.h)
$script:MemMapName = 'Local\IRSDKMemMapFileName'
$script:MemMapSize = 1164 * 1024
$script:BroadcastName = 'IRSDK_BROADCASTMSG'
$script:BroadcastTelemCommand = 10                              # irsdk_BroadcastTelemCommand
$script:Telem = @{ 'stop' = 0; 'start' = 1; 'restart' = 2 }     # irsdk_TelemCommandMode
$script:HeaderSize = 112                                        # 10 ints, 2 pad ints, 4 buffers of 16 bytes
$script:VarHeaderSize = 144
$script:Wanted = @('IsOnTrack', 'IsDiskLoggingEnabled', 'IsDiskLoggingActive')
$script:RetrySeconds = 3.0

# ------------------------------------------------------------------ small helpers

$script:ClockOverride = $null
function Get-NowSeconds {
  if ($null -ne $script:ClockOverride) { return [double]$script:ClockOverride }
  return [double]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) / 1000.0
}

$script:LogLines = New-Object System.Collections.ArrayList
$script:Quiet = $false
function Write-Log([string]$Text) {
  [void]$script:LogLines.Add($Text)
  if (-not $script:Quiet) { Write-Host ((Get-Date -Format 'HH:mm:ss') + '  ' + $Text) }
}

function New-OffState { return @{ connected = $false; onTrack = $false; enabled = $null; active = $null } }

# ------------------------------------------------------------------ reading the sim

# A "memory" is @{ Kind = 'bytes'; Bytes = [byte[]] } or @{ Kind = 'accessor'; Accessor = ...; File = ... }.
function Read-Mem($Mem, [int]$Offset, [int]$Length) {
  $empty = New-Object byte[] 0
  if ($null -eq $Mem -or $Offset -lt 0 -or $Length -le 0) { return ,$empty }
  if ($Mem.Kind -eq 'bytes') {
    $src = [byte[]]$Mem.Bytes
    if ($Offset -ge $src.Length) { return ,$empty }
    $n = [Math]::Min($Length, $src.Length - $Offset)
    $out = New-Object byte[] $n
    [Array]::Copy($src, $Offset, $out, 0, $n)
    return ,$out
  }
  $acc = $Mem.Accessor
  if (([long]$Offset + $Length) -gt $acc.Capacity -or ($Offset + $Length) -gt $script:MemMapSize) { return ,$empty }
  $out = New-Object byte[] $Length
  [void]$acc.ReadArray([long]$Offset, $out, 0, $Length)
  return ,$out
}

# Reads three yes/no values out of iRacing's telemetry memory. The layout is the same as the
# header of an .ibt file. $Cache remembers where the values are between calls.
function Read-SimState($Mem, [hashtable]$Cache) {
  $off = New-OffState
  if ($null -eq $Mem) { $Cache.Vars = $null; return $off }
  $head = Read-Mem $Mem 0 $script:HeaderSize
  if ($head.Length -lt $script:HeaderSize) { return $off }
  $status = [BitConverter]::ToInt32($head, 4)
  $numVars = [BitConverter]::ToInt32($head, 24)
  $varOff = [BitConverter]::ToInt32($head, 28)
  $numBuf = [BitConverter]::ToInt32($head, 32)
  $bufLen = [BitConverter]::ToInt32($head, 36)
  if (($status -band 1) -eq 0 -or $numVars -le 0 -or $numVars -gt 4096 -or $numBuf -le 0 -or $numBuf -gt 4) {
    $Cache.Vars = $null
    return $off
  }
  $layout = "$numVars/$varOff"
  if ($null -eq $Cache.Vars -or $Cache.Layout -ne $layout) {
    $vars = @{}
    if ($varOff -gt 0 -and ($varOff + $numVars * $script:VarHeaderSize) -le $script:MemMapSize) {
      $raw = Read-Mem $Mem $varOff ($numVars * $script:VarHeaderSize)
      $count = [Math]::Floor($raw.Length / $script:VarHeaderSize)
      for ($i = 0; $i -lt $count; $i++) {
        $base = $i * $script:VarHeaderSize
        $name = [System.Text.Encoding]::ASCII.GetString($raw, $base + 16, 32).Split([char]0)[0]
        if ($script:Wanted -contains $name) { $vars[$name] = [BitConverter]::ToInt32($raw, $base + 4) }
      }
    }
    $Cache.Vars = $vars
    $Cache.Layout = $layout
  }
  # The sim rotates between buffers; the one with the highest tick is the newest complete one.
  $bestTick = -1
  $bestOff = -1
  for ($i = 0; $i -lt $numBuf; $i++) {
    $tick = [BitConverter]::ToInt32($head, 48 + 16 * $i)
    if ($tick -gt $bestTick) { $bestTick = $tick; $bestOff = [BitConverter]::ToInt32($head, 52 + 16 * $i) }
  }
  if ($bestOff -le 0 -or $bufLen -le 0 -or ($bestOff + $bufLen) -gt $script:MemMapSize) { return $off }
  $buf = Read-Mem $Mem $bestOff $bufLen
  $flag = {
    param($name)
    if (-not $Cache.Vars.ContainsKey($name)) { return $null }
    $o = $Cache.Vars[$name]
    if ($o -lt 0 -or $o -ge $buf.Length) { return $null }
    return ($buf[$o] -ne 0)
  }
  $onTrack = & $flag 'IsOnTrack'
  return @{ connected = $true; onTrack = ($onTrack -eq $true); enabled = (& $flag 'IsDiskLoggingEnabled'); active = (& $flag 'IsDiskLoggingActive') }
}

# ------------------------------------------------------------------ the sim: real, simulated, or a memory image

$script:Sim = $null

function New-WindowsSim {
  # user32 calls for the SDK broadcast message.
  if (-not ('StaRecorder.Win32' -as [type])) {
    Add-Type -Namespace StaRecorder -Name Win32 -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern uint RegisterWindowMessage(string lpString);
[DllImport("user32.dll", SetLastError = true)]
[return: MarshalAs(UnmanagedType.Bool)]
public static extern bool SendNotifyMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
'@
  }
  try { Add-Type -AssemblyName System.Core } catch { }
  $msg = [StaRecorder.Win32]::RegisterWindowMessage($script:BroadcastName)
  return @{ Kind = 'windows'; Message = $msg; Mem = $null; Cache = @{ Vars = $null; Layout = '' } }
}

function New-SimulatedSim {
  return @{ Kind = 'simulated'; Running = $true; OnTrack = $false; Enabled = $false; Sent = (New-Object System.Collections.ArrayList); IgnoreCommands = $false; HideFlags = $false; FailRead = '' }
}

function New-ImageSim([string]$Path) {
  return @{ Kind = 'image'; Path = $Path; Cache = @{ Vars = $null; Layout = '' }; Sent = (New-Object System.Collections.ArrayList) }
}

function Close-SimMemory {
  $s = $script:Sim
  if ($null -eq $s -or $s.Kind -ne 'windows' -or $null -eq $s.Mem) { return }
  try { $s.Mem.Accessor.Dispose() } catch { }
  try { $s.Mem.File.Dispose() } catch { }
  $s.Mem = $null
}

function Get-SimState {
  $s = $script:Sim
  if ($s.Kind -eq 'simulated') {
    if ($s.FailRead) { throw $s.FailRead }
    if (-not $s.Running) { return (New-OffState) }
    if ($s.HideFlags) { return @{ connected = $true; onTrack = $s.OnTrack; enabled = $null; active = $null } }
    return @{ connected = $true; onTrack = $s.OnTrack; enabled = $s.Enabled; active = ($s.Enabled -and $s.OnTrack) }
  }
  if ($s.Kind -eq 'image') {
    if (-not (Test-Path -LiteralPath $s.Path)) { return (Read-SimState $null $s.Cache) }
    return (Read-SimState @{ Kind = 'bytes'; Bytes = [System.IO.File]::ReadAllBytes($s.Path) } $s.Cache)
  }
  # Windows. OpenExisting only opens a mapping that already exists. (Creating one under this name
  # before the sim starts could get in the sim's way, so that is never done.)
  if ($null -eq $s.Mem) {
    try {
      $file = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting($script:MemMapName, [System.IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
      $acc = $file.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
      $s.Mem = @{ Kind = 'accessor'; File = $file; Accessor = $acc }
    } catch {
      return (Read-SimState $null $s.Cache)
    }
  }
  $st = Read-SimState $s.Mem $s.Cache
  # Let go of the memory while the sim is not running, so nothing of iRacing's is held open.
  if (-not $st.connected) { Close-SimMemory }
  return $st
}

function Send-SimCommand([string]$Cmd) {
  $s = $script:Sim
  if ($s.Kind -eq 'simulated') {
    [void]$s.Sent.Add($Cmd)
    if ($s.Running -and -not $s.IgnoreCommands) {
      if ($Cmd -eq 'start') { $s.Enabled = $true }
      if ($Cmd -eq 'stop') { $s.Enabled = $false }
    }
    return $true
  }
  if ($s.Kind -eq 'image') { [void]$s.Sent.Add($Cmd); return $true }
  if (-not $s.Message) { return $false }
  # wParam = MAKELONG(message, command)
  $wparam = ($script:BroadcastTelemCommand -band 0xFFFF) -bor (($script:Telem[$Cmd] -band 0xFFFF) -shl 16)
  return [bool][StaRecorder.Win32]::SendNotifyMessage([IntPtr]0xFFFF, [uint32]$s.Message, [IntPtr]$wparam, [IntPtr]::Zero)
}

function Invoke-SimulatorCommand([string]$Cmd) {
  $s = $script:Sim
  if ($s.Kind -ne 'simulated') { return $false }
  if ($Cmd -eq 'sim-enter') { $s.OnTrack = $true }
  elseif ($Cmd -eq 'sim-exit') { $s.OnTrack = $false }
  elseif ($Cmd -eq 'sim-quit') { $s.Running = $false; $s.OnTrack = $false; $s.Enabled = $false }
  elseif ($Cmd -eq 'sim-launch') { $s.Running = $true }
  else { return $false }
  return $true
}

# ------------------------------------------------------------------ deciding what to do

$script:R = $null
function Reset-Recorder([string]$Mode) {
  if ($Mode -ne 'manual') { $Mode = 'auto' }
  $script:R = @{ Mode = $Mode; State = (New-OffState); Finished = 0; LastFinished = $null; StartedAt = $null; LastSent = 0.0; LastError = '' }
}

# A file is being written while the sim says "active". Older builds without that value:
# enabled and in the car means a file is being written.
function Test-Writing($St) {
  if (-not $St.connected) { return $false }
  if ($null -ne $St.active) { return [bool]$St.active }
  return (($St.enabled -eq $true) -and ($St.onTrack -eq $true))
}

function Send-Telemetry([string]$Cmd, [double]$Now) {
  $script:R.LastSent = $Now
  $ok = $false
  try { $ok = Send-SimCommand $Cmd } catch { $script:R.LastError = $_.Exception.Message }
  if ($ok) {
    $text = @{ 'start' = 'Telemetry recording switched on.'; 'stop' = 'Telemetry recording switched off.'; 'restart' = 'New telemetry file started.' }
    Write-Log $text[$Cmd]
  }
  return $ok
}

function Invoke-Poll {
  $r = $script:R
  $now = $null
  try { $now = Get-SimState } catch { $r.LastError = $_.Exception.Message; $now = New-OffState }   # a read error never stops the program
  $before = $r.State
  $r.State = $now
  $t = Get-NowSeconds
  if ($now.connected -and -not $before.connected) { Write-Log 'iRacing found.' }
  if ($before.connected -and -not $now.connected) { Write-Log 'iRacing closed.' }
  $was = Test-Writing $before
  $is = Test-Writing $now
  if ($is -and -not $was) { $r.StartedAt = $t; Write-Log 'Recording.' }
  if ($was -and -not $is) {
    # The sim has closed the file: a run has been saved.
    $r.Finished = $r.Finished + 1
    $r.LastFinished = $t
    $r.StartedAt = $null
    Write-Log ('Run saved (' + $r.Finished + ' this session).')
  }
  if ($r.Mode -eq 'auto' -and $now.connected) {
    if ($null -eq $now.enabled) {
      # The sim does not say whether recording is on: ask each time it starts or the car is entered.
      $needs = (-not $before.connected) -or ($now.onTrack -and -not $before.onTrack)
    } else {
      $needs = -not $now.enabled
    }
    if ($needs -and ($t - $r.LastSent) -ge $script:RetrySeconds) { [void](Send-Telemetry 'start' $t) }
  }
}

# -> @{ ok; message }
function Invoke-RecorderCommand([string]$Cmd) {
  $r = $script:R
  if ($Cmd -eq 'auto' -or $Cmd -eq 'manual') {
    $r.Mode = $Cmd
    if ($Cmd -eq 'auto') { Write-Log 'Mode: automatic.' } else { Write-Log 'Mode: manual.' }
    return @{ ok = $true; message = '' }
  }
  if (-not $script:Telem.ContainsKey($Cmd)) { return @{ ok = $false; message = 'unknown command' } }
  if (-not $r.State.connected) { return @{ ok = $false; message = 'iRacing is not running' } }
  # Stopping by hand means "leave it off": automatic mode would switch it straight back on.
  if ($Cmd -eq 'stop' -and $r.Mode -eq 'auto') { $r.Mode = 'manual' }
  $ok = Send-Telemetry $Cmd (Get-NowSeconds)
  if ($ok) { return @{ ok = $true; message = '' } }
  return @{ ok = $false; message = 'the command could not be sent' }
}

function Get-RecorderStatus {
  $r = $script:R
  $s = $r.State
  $lastFinishedAt = $null
  if ($null -ne $r.LastFinished) { $lastFinishedAt = [long]([double]$r.LastFinished * 1000) }
  $since = $null
  if ($null -ne $r.StartedAt) { $since = [long]([double]$r.StartedAt * 1000) }
  return [ordered]@{
    app = 'sta-recorder'; version = $script:Version; sim = 'iracing'; mode = $r.Mode
    connected = [bool]$s.connected; onTrack = [bool]$s.onTrack; enabled = $s.enabled; recording = [bool](Test-Writing $s)
    finished = [int]$r.Finished; lastFinishedAt = $lastFinishedAt; recordingSince = $since
    simulated = ($script:Sim.Kind -eq 'simulated'); error = [string]$r.LastError
  }
}

# ------------------------------------------------------------------ talking to the web app

# Pages opened from disk send "null"; localhost pages send their address. Anything else must be listed.
function Test-OriginAllowed($Origin, [string[]]$Extra) {
  if ($null -eq $Origin) { return $true }       # not a web page (a command-line tool or the address bar)
  if ($Origin -eq 'null') { return $true }
  $low = ([string]$Origin).ToLowerInvariant()
  foreach ($prefix in @('http://localhost', 'http://127.0.0.1', 'https://localhost', 'https://127.0.0.1')) {
    if ($low -eq $prefix -or $low.StartsWith($prefix + ':', [System.StringComparison]::Ordinal)) { return $true }
  }
  foreach ($e in $Extra) {
    if ($e -and $low -eq $e.ToLowerInvariant().TrimEnd('/')) { return $true }
  }
  return $false
}

# Works out the answer to one request. -> @{ code; body }  (body $null for no content)
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
  # Commands must be JSON sent by a page: a plain form or link from another site cannot do that.
  $ctype = ''
  if ($Headers.ContainsKey('content-type')) { $ctype = $Headers['content-type'].ToLowerInvariant() }
  if ($ctype.IndexOf('application/json', [System.StringComparison]::Ordinal) -lt 0) { return @{ code = 415; body = @{ error = 'send JSON' } } }
  $cmd = ''
  try {
    $obj = $Body | ConvertFrom-Json
    if ($null -ne $obj -and ($obj.PSObject.Properties.Name -contains 'cmd')) { $cmd = [string]$obj.cmd }
  } catch {
    return @{ code = 400; body = @{ error = 'bad request' } }
  }
  if ($cmd.StartsWith('sim-', [System.StringComparison]::Ordinal) -and $script:Sim.Kind -eq 'simulated') {
    $res = @{ ok = (Invoke-SimulatorCommand $cmd); message = '' }
    Invoke-Poll
  } else {
    $modeBefore = $script:R.Mode
    $res = Invoke-RecorderCommand $cmd
    if ($script:R.Mode -ne $modeBefore) { Save-Mode $script:R.Mode }
  }
  $out = Get-RecorderStatus
  $out['ok'] = [bool]$res.ok
  if ($res.message) { $out['message'] = $res.message }
  $code = 409
  if ($res.ok) { $code = 200 }
  return @{ code = $code; body = $out }
}

$script:StatusText = @{ 200 = 'OK'; 204 = 'No Content'; 400 = 'Bad Request'; 403 = 'Forbidden'; 404 = 'Not Found'; 405 = 'Method Not Allowed'; 409 = 'Conflict'; 415 = 'Unsupported Media Type' }

function Invoke-Client($Client, [string[]]$Extra) {
  try {
    # Called once the connection has sent something; the rest of a request from this computer follows at once.
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

# ------------------------------------------------------------------ settings

$script:SaveSettings = $true
function Get-SettingsPath { return (Join-Path $PSScriptRoot 'recorder-settings.json') }
function Get-SavedMode([string]$Default) {
  try {
    $m = (Get-Content -LiteralPath (Get-SettingsPath) -Raw | ConvertFrom-Json).mode
    if ($m -eq 'auto' -or $m -eq 'manual') { return $m }
  } catch { }
  return $Default
}
function Save-Mode([string]$Mode) {
  if (-not $script:SaveSettings) { return }
  try { Set-Content -LiteralPath (Get-SettingsPath) -Value ('{"mode":"' + $Mode + '"}') -Encoding ASCII } catch { }
}

# ------------------------------------------------------------------ self-test

function Invoke-SelfTest {
  $script:Quiet = $true
  $script:SaveSettings = $false
  $failed = New-Object System.Collections.ArrayList
  $check = {
    param([string]$Name, $Actual, $Expected)
    $script:TestCount++
    $a = ($Actual | ConvertTo-Json -Compress -Depth 4)
    $e = ($Expected | ConvertTo-Json -Compress -Depth 4)
    if ($a -ne $e) { [void]$failed.Add($Name + ': got ' + $a + ', expected ' + $e) }
  }
  $script:TestCount = 0

  # --- an image of iRacing's telemetry memory: header, variable headers, two data buffers
  $image = {
    param([hashtable]$Values, [bool]$Connected = $true, [int]$Newest = 1)
    $names = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt 40; $i++) { [void]$names.Add('Speed' + $i) }
    foreach ($k in @('IsOnTrack', 'IsDiskLoggingEnabled', 'IsDiskLoggingActive')) { if ($Values.ContainsKey($k)) { [void]$names.Add($k) } }
    $varOff = 112; $bufLen = 64
    $buf0 = $varOff + $names.Count * 144
    $buf1 = $buf0 + $bufLen
    $mem = New-Object byte[] ($buf1 + $bufLen)
    $put = { param([int]$At, [int]$V) [Array]::Copy([BitConverter]::GetBytes([int]$V), 0, $mem, $At, 4) }
    $status = 0; if ($Connected) { $status = 1 }
    $ints = @(2, $status, 60, 1, 0, 0, $names.Count, $varOff, 2, $bufLen)
    for ($i = 0; $i -lt 10; $i++) { & $put ($i * 4) $ints[$i] }
    # buffer 0 is stale (everything off); buffer 1 holds the current values unless told otherwise
    $tick0 = 100; if ($Newest -eq 0) { $tick0 = 300 }
    & $put 48 $tick0; & $put 52 $buf0
    & $put 64 200; & $put 68 $buf1
    for ($i = 0; $i -lt $names.Count; $i++) {
      $base = $varOff + $i * 144
      & $put $base 1; & $put ($base + 4) $i; & $put ($base + 8) 1
      $nb = [System.Text.Encoding]::ASCII.GetBytes([string]$names[$i])
      [Array]::Copy($nb, 0, $mem, $base + 16, $nb.Length)
      if ($Values.ContainsKey([string]$names[$i]) -and $Values[[string]$names[$i]]) { $mem[$buf1 + $i] = 1 }
    }
    return ,$mem
  }
  $read = { param($Bytes) return (Read-SimState @{ Kind = 'bytes'; Bytes = $Bytes } @{ Vars = $null; Layout = '' }) }
  $flat = { param($St) return @($St.connected, $St.onTrack, $St.enabled, $St.active) }

  & $check 'reader: flags from the newest buffer' (& $flat (& $read (& $image @{ IsOnTrack = $true; IsDiskLoggingEnabled = $true; IsDiskLoggingActive = $false }))) @($true, $true, $true, $false)
  & $check 'reader: the other buffer when it is newer' (& $flat (& $read (& $image @{ IsOnTrack = $true; IsDiskLoggingEnabled = $true; IsDiskLoggingActive = $true } $true 0))) @($true, $false, $false, $false)
  & $check 'reader: sim not connected' (& $flat (& $read (& $image @{ IsOnTrack = $true } $false))) @($false, $false, $null, $null)
  & $check 'reader: no memory' (& $flat (Read-SimState $null @{ Vars = $null; Layout = '' })) @($false, $false, $null, $null)
  & $check 'reader: short memory is not a crash' (& $flat (& $read (New-Object byte[] 20))) @($false, $false, $null, $null)
  & $check 'reader: values the sim does not publish are unknown' (& $flat (& $read (& $image @{ IsOnTrack = $true }))) @($true, $true, $null, $null)
  $bad = & $image @{ IsOnTrack = $true; IsDiskLoggingEnabled = $true; IsDiskLoggingActive = $true }
  [Array]::Copy([BitConverter]::GetBytes([int]900), 0, $bad, 64, 4)
  [Array]::Copy([BitConverter]::GetBytes([int]($script:MemMapSize + 5)), 0, $bad, 68, 4)
  & $check 'reader: an offset outside the mapping is refused' (& $flat (& $read $bad)) @($false, $false, $null, $null)

  # --- deciding what to do, against the pretend sim and a clock that only moves when told
  $fresh = { param([string]$Mode = 'auto') $script:Sim = New-SimulatedSim; Reset-Recorder $Mode; $script:LogLines.Clear(); $script:ClockOverride = 1000.0 }
  $sent = { return (@($script:Sim.Sent) -join ',') }

  & $fresh
  Invoke-Poll
  & $check 'auto: switches recording on when the sim appears' (& $sent) 'start'
  $script:ClockOverride += 1; Invoke-Poll
  & $check 'auto: not sent again once it is on' (& $sent) 'start'
  [void](Invoke-SimulatorCommand 'sim-enter'); $script:ClockOverride += 1; Invoke-Poll
  $st = Get-RecorderStatus
  & $check 'auto: recording while in the car' @($st.recording, $st.recordingSince) @($true, [long]1002000)
  [void](Invoke-SimulatorCommand 'sim-exit'); $script:ClockOverride += 60; Invoke-Poll
  $st = Get-RecorderStatus
  & $check 'auto: a saved run is counted when the driver gets out' @($st.recording, $st.finished, $st.lastFinishedAt) @($false, 1, [long]1062000)
  & $check 'auto: what the window prints' (@($script:LogLines) -join ' | ') 'iRacing found. | Telemetry recording switched on. | Recording. | Run saved (1 this session).'

  & $fresh; $script:Sim.IgnoreCommands = $true
  Invoke-Poll; $script:ClockOverride += 1; Invoke-Poll; $script:ClockOverride += 1; Invoke-Poll
  & $check 'auto: a start that did not take is not hammered' (& $sent) 'start'
  $script:ClockOverride += 2; Invoke-Poll
  & $check 'auto: ...but is retried after three seconds' (& $sent) 'start,start'

  & $fresh 'manual'
  Invoke-Poll; $script:ClockOverride += 10; Invoke-Poll
  & $check 'manual: sends nothing until asked' (& $sent) ''
  & $check 'manual: start on request' (Invoke-RecorderCommand 'start').ok $true
  & $check 'manual: restart on request' @((Invoke-RecorderCommand 'restart').ok, (& $sent)) @($true, 'start,restart')
  & $check 'unknown command' (Invoke-RecorderCommand 'nonsense').message 'unknown command'

  & $fresh
  Invoke-Poll
  & $check 'stop by hand' (Invoke-RecorderCommand 'stop').ok $true
  $script:ClockOverride += 30; Invoke-Poll; $script:ClockOverride += 30; Invoke-Poll
  & $check 'stop by hand stays stopped' @($script:R.Mode, (& $sent)) @('manual', 'start,stop')
  [void](Invoke-RecorderCommand 'auto'); $script:ClockOverride += 5; Invoke-Poll
  & $check 'back to automatic switches it on again' (& $sent) 'start,stop,start'

  & $fresh
  [void](Invoke-SimulatorCommand 'sim-quit'); Invoke-Poll
  & $check 'commands need the sim' @((Invoke-RecorderCommand 'start').message, (& $sent)) @('iRacing is not running', '')
  & $check 'the mode can still be changed without the sim' (Invoke-RecorderCommand 'manual').ok $true

  & $fresh
  Invoke-Poll; [void](Invoke-SimulatorCommand 'sim-enter'); Invoke-Poll
  [void](Invoke-SimulatorCommand 'sim-quit'); Invoke-Poll
  $st = Get-RecorderStatus
  & $check 'quitting the sim mid-run counts the run as saved' @($st.connected, $st.finished) @($false, 1)

  & $fresh; $script:Sim.HideFlags = $true
  Invoke-Poll; $script:ClockOverride += 10; Invoke-Poll
  & $check 'older sim: asked once when it appears' (& $sent) 'start'
  [void](Invoke-SimulatorCommand 'sim-enter'); $script:ClockOverride += 10; Invoke-Poll
  & $check 'older sim: and again when the car is entered' (& $sent) 'start,start'

  & $fresh; $script:Sim.FailRead = 'memory went away'
  Invoke-Poll
  $st = Get-RecorderStatus
  & $check 'a read error does not stop the recorder' @($st.connected, $st.error) @($false, 'memory went away')

  # --- who may call
  $none = [string[]]@()
  & $check 'origin: not a web page' (Test-OriginAllowed $null $none) $true
  & $check 'origin: the app opened from disk' (Test-OriginAllowed 'null' $none) $true
  & $check 'origin: localhost' (Test-OriginAllowed 'http://localhost:8080' $none) $true
  & $check 'origin: 127.0.0.1' (Test-OriginAllowed 'http://127.0.0.1:5500' $none) $true
  & $check 'origin: another website' (Test-OriginAllowed 'https://example.com' $none) $false
  & $check 'origin: a lookalike of localhost' (Test-OriginAllowed 'http://localhost.evil.com' $none) $false
  & $check 'origin: a lookalike of 127.0.0.1' (Test-OriginAllowed 'http://127.0.0.1.evil.com:80' $none) $false
  & $check 'origin: a listed website' (Test-OriginAllowed 'https://Whisel.github.io' ([string[]]@('https://whisel.github.io/'))) $true

  # --- requests, as the web server answers them
  & $fresh 'manual'
  Invoke-Poll
  $json = @{ 'origin' = 'null'; 'content-type' = 'application/json' }
  $res = Get-Response 'GET' '/status' @{ 'origin' = 'null' } '' $none
  & $check 'http: status' @($res.code, $res.body.app, $res.body.mode, $res.body.connected, $res.body.simulated) @(200, 'sta-recorder', 'manual', $true, $true)
  $res = Get-Response 'POST' '/command' $json '{"cmd":"start"}' $none
  & $check 'http: start' @($res.code, $res.body.ok, (& $sent)) @(200, $true, 'start')
  $res = Get-Response 'POST' '/command' $json '{"cmd":"auto"}' $none
  & $check 'http: mode' @($res.code, $res.body.mode) @(200, 'auto')
  $res = Get-Response 'POST' '/command' $json '{"cmd":"sim-enter"}' $none
  & $check 'http: pretend sim enters the car' $res.body.recording $true
  $res = Get-Response 'POST' '/command' $json '{"cmd":"sim-exit"}' $none
  & $check 'http: pretend sim leaves the car' @($res.body.recording, $res.body.finished) @($false, 1)
  $res = Get-Response 'POST' '/command' $json '{"cmd":"fly"}' $none
  & $check 'http: unknown command' @($res.code, $res.body.ok, $res.body.message) @(409, $false, 'unknown command')
  $res = Get-Response 'POST' '/command' $json 'not json' $none
  & $check 'http: rubbish body' $res.code 400
  $before = & $sent
  $res = Get-Response 'POST' '/command' @{ 'origin' = 'https://example.com'; 'content-type' = 'application/json' } '{"cmd":"stop"}' $none
  & $check 'http: another website is refused' @($res.code, (& $sent)) @(403, $before)
  $res = Get-Response 'POST' '/command' @{ 'content-type' = 'text/plain' } '{"cmd":"stop"}' $none
  & $check 'http: a plain form post cannot send a command' @($res.code, (& $sent)) @(415, $before)
  & $check 'http: preflight' (Get-Response 'OPTIONS' '/command' @{ 'origin' = 'null' } '' $none).code 204
  & $check 'http: preflight from another website' (Get-Response 'OPTIONS' '/command' @{ 'origin' = 'https://example.com' } '' $none).code 403
  & $check 'http: unknown path' (Get-Response 'GET' '/' @{ 'origin' = 'null' } '' $none).code 404
  & $check 'http: unknown method' (Get-Response 'DELETE' '/status' @{ 'origin' = 'null' } '' $none).code 405

  # --- the web server itself, over a real connection on this computer
  $script:ClockOverride = $null
  & $fresh 'manual'
  $script:ClockOverride = $null
  Invoke-Poll
  $listener = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Loopback), 0
  $listener.Start()
  try {
    $testPort = $listener.LocalEndpoint.Port
    $ask = {
      param([string]$Request)
      $c = New-Object System.Net.Sockets.TcpClient
      $c.Connect([System.Net.IPAddress]::Loopback, $testPort)
      $c.ReceiveTimeout = 3000
      $s = $c.GetStream()
      $bytes = [System.Text.Encoding]::ASCII.GetBytes($Request)
      $s.Write($bytes, 0, $bytes.Length); $s.Flush()
      # this script is single-threaded: serve the request we just sent, then read the answer
      $deadline = (Get-Date).AddSeconds(3)
      while (-not $listener.Pending() -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 5 }
      if ($listener.Pending()) { Invoke-Client $listener.AcceptTcpClient() $none }
      $ms = New-Object System.IO.MemoryStream
      $buf = New-Object byte[] 4096
      try { while (($n = $s.Read($buf, 0, $buf.Length)) -gt 0) { $ms.Write($buf, 0, $n) } } catch { }
      $c.Close()
      return [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
    }
    $answer = & $ask ("GET /status HTTP/1.1`r`nHost: 127.0.0.1`r`nOrigin: null`r`n`r`n")
    $bodyAt = $answer.IndexOf("`r`n`r`n", [System.StringComparison]::Ordinal)
    $ok = $answer.StartsWith('HTTP/1.1 200 OK', [System.StringComparison]::Ordinal) -and $answer.Contains('Access-Control-Allow-Origin: null') -and $bodyAt -gt 0
    & $check 'server: status over a real connection' $ok $true
    if ($bodyAt -gt 0) {
      $obj = $answer.Substring($bodyAt + 4) | ConvertFrom-Json
      & $check 'server: the answer is the status' @($obj.app, $obj.connected, $obj.enabled, $obj.finished) @('sta-recorder', $true, $false, 0)
    }
    $post = '{"cmd":"start"}'
    $answer = & $ask ("POST /command HTTP/1.1`r`nHost: 127.0.0.1`r`nOrigin: null`r`nContent-Type: application/json`r`nContent-Length: " + $post.Length + "`r`n`r`n" + $post)
    & $check 'server: a command over a real connection' @($answer.StartsWith('HTTP/1.1 200 OK', [System.StringComparison]::Ordinal), (& $sent)) @($true, 'start')
    $answer = & $ask ("GET /status HTTP/1.1`r`nHost: 127.0.0.1`r`nOrigin: https://example.com`r`n`r`n")
    & $check 'server: another website over a real connection' @($answer.StartsWith('HTTP/1.1 403', [System.StringComparison]::Ordinal), $answer.Contains('Access-Control-Allow-Origin')) @($true, $false)
  } finally {
    $listener.Stop()
  }

  $script:Quiet = $false
  Write-Host ('PowerShell ' + $PSVersionTable.PSVersion.ToString())
  if ($failed.Count -eq 0) {
    Write-Host ('Self-test passed: ' + $script:TestCount + ' checks.')
    Write-Host 'Not covered: the two Windows calls that open iRacing''s memory and send the command. Those need the sim.'
    return 0
  }
  Write-Host ('Self-test FAILED: ' + $failed.Count + ' of ' + $script:TestCount + ' checks.')
  foreach ($f in $failed) { Write-Host ('  ' + $f) }
  return 1
}

# ------------------------------------------------------------------ start

if ($SelfTest) { exit (Invoke-SelfTest) }

$isWindowsHost = ($env:OS -eq 'Windows_NT')
if ($Simulate) {
  $script:Sim = New-SimulatedSim
  $script:SaveSettings = $false
} elseif ($MemoryImage) {
  $script:Sim = New-ImageSim $MemoryImage
  $script:SaveSettings = $false
} elseif (-not $isWindowsHost) {
  Write-Host 'iRacing runs on Windows, so the recorder does too. Use -Simulate to try it here.'
  exit 2
} else {
  $script:Sim = New-WindowsSim
}

$mode = Get-SavedMode 'auto'
if ($Manual) { $mode = 'manual' } elseif ($Auto) { $mode = 'auto' }
if ($Simulate -and -not $Manual) { $mode = 'auto' }
Reset-Recorder $mode

$listener = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Loopback), $Port
try {
  $listener.Start()
} catch {
  Write-Host ('Port ' + $Port + ' on this computer is in use. Is the recorder already running? Otherwise pick another with -Port and set the same number in the app.')
  exit 1
}

$modeText = 'automatic'
if ($mode -eq 'manual') { $modeText = 'manual' }
$simText = ''
if ($Simulate) { $simText = ' (simulated sim)' }
Write-Log ('iRacing recorder ' + $script:Version + $simText + '. Mode: ' + $modeText + '. Listening on http://127.0.0.1:' + $Port)
Write-Log 'Leave this window open while you drive. Close it, or press Ctrl+C, to stop.'
if (-not $Simulate) { Write-Log 'Waiting for iRacing...' }

$nextPoll = 0.0
# Connections that have been opened but have not sent anything yet. Browsers open spare ones;
# they are answered when they speak and dropped after two seconds of silence, so a silent
# connection never delays a real request.
$waiting = New-Object System.Collections.ArrayList
try {
  while ($true) {
    while ($listener.Pending()) { [void]$waiting.Add(@{ Client = $listener.AcceptTcpClient(); At = (Get-NowSeconds) }) }
    for ($i = $waiting.Count - 1; $i -ge 0; $i--) {
      $w = $waiting[$i]
      $ready = $false
      try { $ready = ($w.Client.Available -gt 0) } catch { $ready = $false }
      if ($ready) {
        $waiting.RemoveAt($i)
        Invoke-Client $w.Client $AllowOrigin
      } elseif (((Get-NowSeconds) - $w.At) -gt 2.0) {
        $waiting.RemoveAt($i)
        try { $w.Client.Close() } catch { }
      }
    }
    $t = Get-NowSeconds
    if ($t -ge $nextPoll) { Invoke-Poll; $nextPoll = $t + 0.5 }
    Start-Sleep -Milliseconds 40
  }
} finally {
  $listener.Stop()
  Close-SimMemory
  Write-Host ((Get-Date -Format 'HH:mm:ss') + '  Stopped. Telemetry recording in iRacing is left as it was.')
}
