# install-pc-worker.ps1 — registers the Jarvis PC worker as a Task Scheduler
# job so it survives logon, sleep/wake, and crashes without needing a console
# window open. Run this ONCE from an elevated PowerShell prompt, from the
# repo root (C:\dev\ccantynz-alt\jarvis-platform).
#
# Task Scheduler over NSSM/a startup shortcut: no extra binary to install,
# native restart-on-failure, and "run only when logged on" matches the
# requirement that the worker bills THIS Windows user's own claude login.

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$NodePath = (Get-Command node -ErrorAction Stop).Source
$TaskName = 'JarvisPcWorker'

if (-not (Test-Path (Join-Path $RepoRoot 'config\pc-worker.env'))) {
    Write-Warning "config\pc-worker.env not found. Copy config\pc-worker.env.example to config\pc-worker.env and fill in JARVIS_WORKER_TOKEN before the worker can authenticate."
}

$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$RepoRoot\src\pc-worker.js`"" -WorkingDirectory $RepoRoot

$Triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn)
)

$Settings = New-ScheduledTaskSettingsSet `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Settings $Settings `
    -Description 'Jarvis worker: pulls dispatched jobs from the server over the tailnet and runs them with this user''s claude login.' `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName'. Start it now with:"
Write-Host "  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Check status with:"
Write-Host "  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "Kill switch (stops the worker immediately, even mid-poll): create the file"
Write-Host "  $env:ProgramData\jarvis\KILL"
