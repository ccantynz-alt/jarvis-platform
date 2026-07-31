# install-pc-worker.ps1 — registers the Jarvis PC worker as a Task Scheduler
# job so it survives logon, sleep/wake, and crashes without needing a console
# window open. Run this ONCE from an elevated PowerShell prompt, from the
# repo root (C:\dev\ccantynz-alt\jarvis-platform).
#
# Task Scheduler over NSSM/a startup shortcut: no extra binary to install,
# native restart-on-failure, and "run only when logged on" matches the
# requirement that the worker bills THIS Windows user's own claude login.
#
# ── 2026-07-31: two changes, both from a real incident ──────────────────────
#
# ELEVATION (-RunLevel Highest). Craig asked for Jarvis to be able to restart
# services on the PC. Restart-Service needs an administrator token; without it
# every service verb returns "Access is denied" no matter how good the plumbing
# is. The task still runs as CRAIG'S OWN ACCOUNT — that is deliberate and must
# not be changed to SYSTEM, because the worker spawns `claude` against the
# subscription login under this user's %USERPROFILE%\.claude. Highest gives the
# admin token, not a different identity.
#
# THE WATCHDOG TASK. From the live transcript on 2026-07-31, after Craig's PC
# had crashed:
#     Craig:  "restart the worker service"
#     Jarvis: "That's the one thing I can't do from here, sir. The only channel
#              to that machine is the worker itself — it calls out to me, I
#              never reach in. So if it's not running, I've got no way to start
#              it."
# That is a genuine bootstrap hole and no amount of capability INSIDE the
# worker can close it: a dead worker cannot restart a dead worker. So a second,
# tiny scheduled task runs every 5 minutes as SYSTEM and starts JarvisPcWorker
# if its process is gone. It is deliberately dumb — no network, no repo code,
# nothing that can fail in an interesting way — because it is the thing that
# has to work when everything else has not.

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$NodePath = (Get-Command node -ErrorAction Stop).Source
$TaskName = 'JarvisPcWorker'
$WatchdogName = 'JarvisPcWorkerWatchdog'

$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
    Write-Warning "NOT running as administrator."
    Write-Warning "The worker will be registered, but WITHOUT the admin rights it needs to restart Windows services,"
    Write-Warning "and the watchdog task cannot be created at all."
    Write-Warning "Re-run this from an elevated PowerShell (right-click -> Run as administrator) to get both."
}

if (-not (Test-Path (Join-Path $RepoRoot 'config\pc-worker.env'))) {
    Write-Warning "config\pc-worker.env not found. Copy config\pc-worker.env.example to config\pc-worker.env and fill in JARVIS_WORKER_TOKEN before the worker can authenticate."
}

# ── The worker itself ───────────────────────────────────────────────────────
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$RepoRoot\src\pc-worker.js`"" -WorkingDirectory $RepoRoot

$Triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn)
)

$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -MultipleInstances IgnoreNew

# RunLevel Highest = admin token, same user. See the note at the top of this
# file for why this is NOT changed to run as SYSTEM.
$Principal = if ($IsAdmin) {
    New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
} else {
    New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Settings $Settings `
    -Principal $Principal `
    -Description 'Jarvis worker: pulls dispatched jobs from the server over the tailnet and runs them with this user''s claude login.' `
    -Force | Out-Null

Write-Host "Registered '$TaskName'$(if ($IsAdmin) { ' (elevated - can restart services)' } else { ' (NOT elevated - cannot restart services)' })"

# ── The watchdog: the only thing that can revive a dead worker ───────────────
if ($IsAdmin) {
    # Deliberately a single inline command with no repo dependency: if the
    # checkout is broken or mid-pull, this must still run.
    $WatchdogCmd = "if (-not (Get-Process node -ErrorAction SilentlyContinue | " +
                   "Where-Object { $_.Path -eq '$NodePath' } | " +
                   "Where-Object { (Get-CimInstance Win32_Process -Filter \""ProcessId=$($_.Id)\"").CommandLine -like '*pc-worker.js*' })) " +
                   "{ Start-ScheduledTask -TaskName '$TaskName' }"

    $WdAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$WatchdogCmd`""

    # Every 5 minutes, forever, starting at boot as well as at logon — the
    # worker's own AtLogOn trigger does nothing if it died an hour into a session.
    $WdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)

    $WdSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew

    # SYSTEM: the watchdog must run whether or not Craig is logged in, and it
    # only ever starts another task — it holds no credential and touches no
    # network.
    $WdPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

    Register-ScheduledTask -TaskName $WatchdogName -Action $WdAction -Trigger $WdTrigger `
        -Settings $WdSettings -Principal $WdPrincipal `
        -Description 'Restarts JarvisPcWorker if it is not running. A dead worker cannot restart itself — this is the only thing that can.' `
        -Force | Out-Null

    Write-Host "Registered '$WatchdogName' — checks every 5 minutes that the worker is alive."
} else {
    Write-Warning "Skipped '$WatchdogName' (needs admin). Without it, a crashed worker stays dead until you start it by hand."
}

Write-Host ""
Write-Host "Start it now with:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Check status with:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "Confirm it came up elevated (this is what lets Jarvis restart services):"
Write-Host "  the worker logs 'elevation: ADMINISTRATOR' on startup"
Write-Host "Kill switch (stops the worker immediately, even mid-poll): create the file"
Write-Host "  $env:ProgramData\jarvis\KILL"
