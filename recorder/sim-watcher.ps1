<#
  Starts the right recorder when a simulator starts, and stops it when the simulator closes.

    iRacing running            -> iracing-recorder.ps1
    Le Mans Ultimate running   -> lmu-recorder.ps1

  It only watches the list of running programs (every 3 seconds); it does not touch the
  simulators. Both recorders use the same port, so one runs at a time: the simulator
  that was started first.

  Start it by hand with Start-Recorders.cmd, or let Windows start it when you sign in:
    Install-AutoStart.cmd      adds a shortcut to your Startup folder (no administrator rights)
    Remove-AutoStart.cmd       removes it again

  Options
    -Install / -Uninstall   add or remove the Startup shortcut, then stop
    -PollSeconds <n>        how often to look (default 3)
    -GraceSeconds <n>       how long a recorder gets to save its last run after the simulator closes (default 5)
    -SelfTest               check the script on this computer and stop
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [int]$PollSeconds = 3,
  [int]$GraceSeconds = 5,
  [switch]$SelfTest
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:Version = '1.0'
$script:ShortcutName = 'Sim telemetry recorders.lnk'

# Which program means which simulator, and which recorder goes with it. Process names are without ".exe".
$script:Sims = @(
  @{ Key = 'iracing'; Name = 'iRacing'; Processes = @('iRacingSim64DX11', 'iRacingSim64DX12', 'iRacingSim64'); Script = 'iracing-recorder.ps1' },
  @{ Key = 'lmu'; Name = 'Le Mans Ultimate'; Processes = @('Le Mans Ultimate'); Script = 'lmu-recorder.ps1' }
)

function Write-Log([string]$Text) { Write-Host ((Get-Date -Format 'HH:mm:ss') + '  ' + $Text) }

# The PowerShell program this script is running in; the recorders are started with the same one.
function Get-HostPath { return [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName }

# The first simulator in the list that is running, or $null.
function Get-RunningSim($Sims) {
  foreach ($sim in $Sims) {
    foreach ($name in $sim.Processes) {
      if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) { return $sim }
    }
  }
  return $null
}

function Start-Recorder($Sim, [string]$Folder) {
  $path = Join-Path $Folder $Sim.Script
  if (-not (Test-Path -LiteralPath $path)) { throw ('The recorder script is missing: ' + $path) }
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $path + '"'))
  if ($Sim.ContainsKey('Arguments')) { $arguments += $Sim.Arguments }
  if ($env:OS -eq 'Windows_NT') { return (Start-Process -FilePath (Get-HostPath) -ArgumentList $arguments -WindowStyle Minimized -PassThru) }
  return (Start-Process -FilePath (Get-HostPath) -ArgumentList $arguments -PassThru)
}

function Stop-Recorder($Process) {
  if ($null -eq $Process) { return }
  try { if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue; [void]$Process.WaitForExit(3000) } } catch { }
}

<# One look at the world. $State = @{ Sim; Process; GoneAt }  ->  what was done: '', 'started', 'stopped', 'restarted'
   - a simulator appears            -> its recorder is started
   - the simulator has gone         -> the recorder gets $Grace seconds to save, then is stopped
   - the recorder stopped by itself -> it is started again while the simulator is still there, at most
                                       once every 30 seconds (it may be stopping because another
                                       recorder already has the port) #>
function Invoke-Watch($State, $Sims, [string]$Folder, [double]$Now, [double]$Grace) {
  $running = Get-RunningSim $Sims
  if ($null -eq $State.Sim) {
    if ($null -eq $running) { return '' }
    $State.Process = Start-Recorder $running $Folder
    $State.Sim = $running; $State.GoneAt = $null; $State.StartedAt = $Now
    return 'started'
  }
  $still = ($null -ne $running -and $running.Key -eq $State.Sim.Key)
  if (-not $still) {
    # A different simulator counts as "gone" too: the recorder for the old one is stopped first.
    $stillThere = (@($State.Sim.Processes | Where-Object { @(Get-Process -Name $_ -ErrorAction SilentlyContinue).Count -gt 0 }).Count -gt 0)
    if (-not $stillThere) {
      if ($null -eq $State.GoneAt) { $State.GoneAt = $Now }
      if (($Now - $State.GoneAt) -ge $Grace) {
        Stop-Recorder $State.Process
        $State.Sim = $null; $State.Process = $null; $State.GoneAt = $null
        return 'stopped'
      }
    }
    return ''
  }
  $State.GoneAt = $null
  if ($null -ne $State.Process -and $State.Process.HasExited -and ($Now - $State.StartedAt) -ge 30) {
    $State.Process = Start-Recorder $State.Sim $Folder
    $State.StartedAt = $Now
    return 'restarted'
  }
  return ''
}

# ------------------------------------------------------------------ starting with Windows

function Get-ShortcutPath { return (Join-Path ([Environment]::GetFolderPath('Startup')) $script:ShortcutName) }

function Install-AutoStart {
  if ($env:OS -ne 'Windows_NT') { Write-Host 'Starting with Windows only works on Windows.'; return 2 }
  $link = Get-ShortcutPath
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($link)
  $sc.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"'
  $sc.WorkingDirectory = $PSScriptRoot
  $sc.WindowStyle = 7          # minimised: it stays out of the way but can be found and closed
  $sc.Description = 'Starts the telemetry recorder when iRacing or Le Mans Ultimate starts'
  $sc.Save()
  Write-Host ('Done. The recorders now start by themselves when you sign in to Windows.')
  Write-Host ('Shortcut: ' + $link)
  Write-Host 'To start them right now without signing out, run Start-Recorders.cmd.'
  return 0
}

function Uninstall-AutoStart {
  if ($env:OS -ne 'Windows_NT') { Write-Host 'Starting with Windows only works on Windows.'; return 2 }
  $link = Get-ShortcutPath
  if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force; Write-Host 'Removed. The recorders no longer start with Windows.' }
  else { Write-Host 'Nothing to remove: the recorders were not set to start with Windows.' }
  Write-Host 'A watcher that is running now keeps running until you close its window.'
  return 0
}

# ------------------------------------------------------------------ self-test

function Invoke-SelfTest {
  $script:__n = 0; $script:__f = 0
  function Check([string]$Name, $Cond) {
    $script:__n++
    if ($Cond) { Write-Host ('  ok    ' + $Name) } else { Write-Host ('  FAIL  ' + $Name); $script:__f++ }
  }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('sta-watch-' + [Guid]::NewGuid().ToString('N'))
  [void](New-Item -ItemType Directory -Path $tmp -Force)
  $fakeSim = $null; $state = @{ Sim = $null; Process = $null; GoneAt = $null; StartedAt = 0.0 }
  try {
    # A stand-in recorder that leaves a mark and then just waits, and a stand-in simulator: a second copy of PowerShell under its own name.
    $mark = Join-Path $tmp 'started.txt'
    Set-Content -LiteralPath (Join-Path $tmp 'fake-recorder.ps1') -Value ('Add-Content -LiteralPath "' + $mark + '" -Value "x"; while ($true) { Start-Sleep -Milliseconds 200 }')
    $hostPath = Get-HostPath
    $simExe = Join-Path $tmp ('StaFakeSim' + [System.IO.Path]::GetExtension($hostPath))
    $simName = 'StaFakeSim'
    $copied = $false
    try { Copy-Item -LiteralPath $hostPath -Destination $simExe; $copied = $true } catch { $copied = $false }
    $sims = @(@{ Key = 'fake'; Name = 'Fake sim'; Processes = @($simName); Script = 'fake-recorder.ps1' })
    $marks = { if (Test-Path -LiteralPath $mark) { @(Get-Content -LiteralPath $mark).Count } else { 0 } }

    Check 'nothing is started while no simulator runs' ((Invoke-Watch $state $sims $tmp 0 2) -eq '' -and $null -eq $state.Process)
    Check 'both real simulators are known' ((@($script:Sims | ForEach-Object { $_.Key }) -join ',') -eq 'iracing,lmu')
    Check 'each recorder script is next to this one' (@($script:Sims | Where-Object { -not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $_.Script)) }).Count -eq 0)

    # The stand-in simulator: on Windows a renamed copy keeps its own process name; elsewhere "sleep" does the job.
    if ($env:OS -eq 'Windows_NT' -and $copied) {
      $fakeSim = Start-Process -FilePath $simExe -ArgumentList @('-NoProfile', '-Command', 'Start-Sleep -Seconds 60') -WindowStyle Hidden -PassThru
    } else {
      $sims[0].Processes = @('sleep')
      $fakeSim = Start-Process -FilePath 'sleep' -ArgumentList @('60') -PassThru
    }
    Start-Sleep -Milliseconds 800
    Check 'the simulator is seen' ($null -ne (Get-RunningSim $sims))
    Check 'its recorder is started' ((Invoke-Watch $state $sims $tmp 10 2) -eq 'started' -and $null -ne $state.Process -and -not $state.Process.HasExited)
    $deadline = (Get-Date).AddSeconds(15); while ((& $marks) -lt 1 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    Check 'the recorder really runs' ((& $marks) -eq 1)
    Check 'it is not started twice' ((Invoke-Watch $state $sims $tmp 11 2) -eq '' -and (& $marks) -eq 1)

    # the recorder dies on its own while the simulator is still up: it comes back
    Stop-Recorder $state.Process
    Check 'a recorder that stopped by itself is not restarted straight away' ((Invoke-Watch $state $sims $tmp 12 2) -eq '')
    Check 'but is started again after half a minute' ((Invoke-Watch $state $sims $tmp 41 2) -eq 'restarted')
    $deadline = (Get-Date).AddSeconds(15); while ((& $marks) -lt 2 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    Check 'and runs again' ((& $marks) -eq 2 -and -not $state.Process.HasExited)

    # the simulator closes
    Stop-Process -Id $fakeSim.Id -Force; [void]$fakeSim.WaitForExit(3000); Start-Sleep -Milliseconds 500
    $recorder = $state.Process
    Check 'the recorder is left alone for the grace time' ((Invoke-Watch $state $sims $tmp 50 2) -eq '' -and -not $recorder.HasExited)
    Check 'still within the grace time' ((Invoke-Watch $state $sims $tmp 51 2) -eq '' -and -not $recorder.HasExited)
    Check 'then it is stopped' ((Invoke-Watch $state $sims $tmp 52.5 2) -eq 'stopped' -and $recorder.HasExited -and $null -eq $state.Sim)
    Check 'and nothing is started after that' ((Invoke-Watch $state $sims $tmp 60 2) -eq '' -and (& $marks) -eq 2)
  } finally {
    Stop-Recorder $state.Process
    if ($null -ne $fakeSim) { try { if (-not $fakeSim.HasExited) { Stop-Process -Id $fakeSim.Id -Force } } catch { } }
    Start-Sleep -Milliseconds 300
    try { Remove-Item -LiteralPath $tmp -Recurse -Force } catch { }
  }
  Write-Host ''
  Write-Host 'Not covered: the Startup shortcut, and the real program names of the two simulators. Those need Windows and the simulators.'
  if ($script:__f -eq 0) { Write-Host ('All ' + $script:__n + ' checks passed.'); return 0 }
  Write-Host ($script:__f.ToString() + ' of ' + $script:__n + ' checks FAILED.'); return 1
}

# ------------------------------------------------------------------ start

if ($SelfTest) { exit (Invoke-SelfTest) }
if ($Install) { exit (Install-AutoStart) }
if ($Uninstall) { exit (Uninstall-AutoStart) }

if ($env:OS -ne 'Windows_NT') { Write-Host 'The simulators run on Windows, so the watcher does too. Use -SelfTest to try it here.'; exit 2 }

# One watcher is enough: a second copy says so and leaves.
$created = $false
$mutex = New-Object System.Threading.Mutex -ArgumentList $true, 'Local\StaSimWatcher', ([ref]$created)
if (-not $created) { Write-Host 'The watcher is already running (look for its minimised window).'; Start-Sleep -Seconds 3; exit 0 }

try { $Host.UI.RawUI.WindowTitle = 'Sim telemetry recorders' } catch { }
Write-Log ('Recorder watcher ' + $script:Version + '. Waiting for iRacing or Le Mans Ultimate.')
Write-Log 'Leave this window open (minimised is fine). Close it to stop.'
$state = @{ Sim = $null; Process = $null; GoneAt = $null; StartedAt = 0.0 }
$clock = [System.Diagnostics.Stopwatch]::StartNew()
try {
  while ($true) {
    try {
      $before = $state.Sim
      $did = Invoke-Watch $state $script:Sims $PSScriptRoot $clock.Elapsed.TotalSeconds $GraceSeconds
      if ($did -eq 'started') { Write-Log ($state.Sim.Name + ' is running: recorder started.') }
      elseif ($did -eq 'restarted') { Write-Log ('The ' + $state.Sim.Name + ' recorder had stopped: started again.') }
      elseif ($did -eq 'stopped') { Write-Log ($before.Name + ' has closed: recorder stopped.') }
    } catch { Write-Log ('Problem: ' + $_.Exception.Message) }
    Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
  }
} finally {
  Stop-Recorder $state.Process
  try { $mutex.ReleaseMutex() } catch { }
}
