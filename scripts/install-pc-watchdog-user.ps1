# install-pc-watchdog-user.ps1 — the watchdog you can install WITHOUT admin.
#
# 2026-08-11. Craig: "we could ask marco to look up my computer specs before,
# now we cant". The PC worker had been dead for 26 hours. His machine was at
# 96% memory (15.4 GB of 16) and the worker got squeezed out — and nothing
# brought it back, because `JarvisPcWorkerWatchdog` DID NOT EXIST on the
# machine. CLAUDE.md described it as live; install-pc-worker.ps1 only creates
# it when run elevated, and that elevated re-run has never happened.
#
# So the documented safety net for "a dead worker cannot restart a dead worker"
# was itself dead. This script closes that hole with what is achievable without
# an admin prompt: the same check, the same 5-minute cadence, registered under
# Craig's own account instead of SYSTEM.
#
# WHAT YOU GIVE UP versus the SYSTEM version (still worth doing later, from an
# elevated PowerShell, via install-pc-worker.ps1):
#   - this runs only while Craig is logged in; the SYSTEM one runs regardless.
#   - it cannot restart the worker if the whole user session is gone.
# WHAT IT COVERS — which is the case that actually bit: machine on, user logged
# in, worker killed by memory pressure or a crash.
#
# Deliberately one inline command with no repo dependency: this must still run
# when the checkout is broken or mid-pull. It only ever starts another task —
# it holds no credential and touches no network.

$ErrorActionPreference = 'Stop'
$TaskName     = 'JarvisPcWorker'
$WatchdogName = 'JarvisPcWorkerWatchdogUser'

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    throw "$TaskName is not registered. Run scripts\install-pc-worker.ps1 first."
}

# Match on node.exe AND the command line — BOTH, and the pairing matters in
# both directions:
#   - command line alone is not enough: any shell running a command that merely
#     MENTIONS pc-worker.js matches itself. The first version of this script did
#     exactly that and reported the worker healthy while it was dead — caught by
#     testing it, when it tried to kill the very shell doing the testing.
#   - node.exe alone is not enough either: Craig runs several node processes
#     (Claude Code among them), so "is node running" would have reported the
#     worker alive for all 26 hours it was gone.
# A single-quoted here-string: nothing here is interpolated or escaped, which
# keeps this readable. The task name is substituted afterwards. Quoting this
# command any other way is a nest of doubled and backticked quotes that fails
# at parse time — it did, on the first attempt.
$Cmd = @'
if (-not (Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*pc-worker.js*' })) { Start-ScheduledTask -TaskName '__TASK__' }
'@
$Cmd = $Cmd.Replace('__TASK__', $TaskName).Trim()

# The inner command is passed base64-encoded, for exactly the reason
# lib/pc-actions.js uses -EncodedCommand: it is only [A-Za-z0-9+/=], so no
# amount of re-tokenising by Task Scheduler or cmd.exe can break it apart.
$Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Cmd))

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $Encoded"

# At logon AND every 5 minutes thereafter: the worker's own AtLogOn trigger is
# no help when it dies an hour into a session, which is what happened.
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)

$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $WatchdogName -Action $Action -Trigger $Trigger `
    -Settings $Settings `
    -Description 'Restarts JarvisPcWorker if it is not running (user-level fallback for JarvisPcWorkerWatchdog, which needs admin to install).' `
    -Force | Out-Null

Write-Host "Registered '$WatchdogName' — checks every 5 minutes that the worker is alive."
Write-Host "For a watchdog that also runs while you are logged out, re-run scripts\install-pc-worker.ps1 from an ADMIN PowerShell."
