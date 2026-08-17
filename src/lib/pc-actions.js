/**
 * pc-actions.js — the vocabulary of things Jarvis may do to Craig's PC.
 *
 * PURE and side-effect-free: no spawning, no fs, no network. Everything here
 * is "given a verb and arguments, what PowerShell should run, and is it safe
 * to run without asking first" — so the whole decision surface is unit-tested
 * without touching Windows. src/pc-worker.js does the spawning.
 *
 * WHY THIS EXISTS (2026-07-31). Until now the ONLY thing the PC worker could
 * do was spawn `claude --print` in a directory under C:\dev. So "restart the
 * worker service" meant booting a full agent — tens of seconds, a subscription
 * turn, and a coding assistant asked to do sysadmin. Craig, from the live
 * transcript that day, having watched his PC crash:
 *     Craig:  "restart the worker service"
 *     Jarvis: "That's the one thing I can't do from here, sir."
 * A typed action runs in well under a second and spends nothing.
 *
 * TWO RULES, and they are the whole security model:
 *
 *   1. NOTHING UNTRUSTED IS EVER INTERPOLATED INTO A COMMAND LINE. Arguments
 *      are embedded as PowerShell single-quoted literals via psQuote(), which
 *      is exact — inside '...' PowerShell has no escapes at all except '' for
 *      a literal quote. The built script then goes to powershell.exe over
 *      STDIN, never as an argv string, so cmd.exe's tokenizer never sees it.
 *      This is the same class of bug already fixed once on this path
 *      (2026-07-26, prompt injection into the cmd.exe command string) — the
 *      fix is not repeated by accident, it is repeated by design.
 *
 *   2. READ-ONLY VS MUTATING IS DECIDED HERE, ONCE. `mutates: true` means the
 *      brain must route it through the dispatch confirmation gate before it
 *      runs (Craig's ruling, 2026-07-31: diagnostics instantly, changes on his
 *      word). A verb that is missing this flag is treated as mutating — the
 *      default must be the careful one, because the failure mode of getting it
 *      backwards is a misheard sentence restarting something on his machine.
 */

// PowerShell single-quoted literal. Inside '...' the ONLY escape is '' for a
// quote — no backtick, no backslash, no $ expansion. That makes this total,
// which is why every argument goes through it.
export function psQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

// A Windows service name. Deliberately permissive about what a name may
// CONTAIN (real ones include dots, underscores, dollars and digits) and strict
// about length — psQuote is what makes it safe, not this. This check exists to
// give a clear error instead of a confusing PowerShell one.
const SERVICE_NAME_RE = /^[A-Za-z0-9._$ -]{1,80}$/;

const HOURS = (v, dflt, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt;
};
const COUNT = (v, dflt, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : dflt;
};

/**
 * The verb table. Each entry:
 *   mutates       — does it change the machine? (gate required)
 *   needsAdmin    — will it fail without an elevated worker?
 *   describe(a)   — one line for Craig, used in the confirmation preview
 *   build(a)      — the PowerShell script text, or throws on bad arguments
 *
 * Output discipline: every script ends in a formatted, bounded projection.
 * A verb that can dump unbounded text is a verb that can blow up a job row and
 * a voice reply.
 */
export const VERBS = {
  // ── Read-only: diagnostics, run immediately, no confirmation ──────────────
  'service.status': {
    mutates: false, needsAdmin: false,
    describe: (a) => `check the status of the "${a.name}" service`,
    build: (a) => {
      if (!SERVICE_NAME_RE.test(String(a.name || ''))) throw new Error('service name required');
      return `Get-Service -Name ${psQuote(a.name)} -ErrorAction Stop |
        Select-Object Name, DisplayName, Status, StartType | Format-List | Out-String`;
    },
  },

  'service.list': {
    mutates: false, needsAdmin: false,
    describe: (a) => (a.filter ? `list services matching "${a.filter}"` : 'list the running services'),
    build: (a) => {
      const where = a.filter
        ? `Where-Object { $_.Name -like ${psQuote('*' + a.filter + '*')} -or $_.DisplayName -like ${psQuote('*' + a.filter + '*')} }`
        : `Where-Object { $_.Status -eq 'Running' }`;
      return `Get-Service | ${where} |
        Select-Object -First ${COUNT(a.top, 60, 200)} Name, Status, StartType, DisplayName |
        Format-Table -AutoSize | Out-String -Width 200`;
    },
  },

  'process.list': {
    mutates: false, needsAdmin: false,
    describe: (a) => `list the top ${COUNT(a.top, 15, 60)} processes by memory`,
    build: (a) => `Get-Process | Sort-Object WorkingSet64 -Descending |
      Select-Object -First ${COUNT(a.top, 15, 60)} `+
      `Name, Id, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64/1MB)}}, ` +
      `@{N='CPUs';E={[math]::Round($_.CPU,1)}} |
      Format-Table -AutoSize | Out-String -Width 200`,
  },

  'system.info': {
    mutates: false, needsAdmin: false,
    describe: () => 'take a snapshot of the PC (uptime, CPU, memory, disk)',
    build: () => `
      $os = Get-CimInstance Win32_OperatingSystem
      $cs = Get-CimInstance Win32_ComputerSystem
      $up = (Get-Date) - $os.LastBootUpTime
      $totalMB = [math]::Round($os.TotalVisibleMemorySize/1KB)
      $freeMB  = [math]::Round($os.FreePhysicalMemory/1KB)
      "Host        : $($cs.Name)"
      "Uptime      : $([int]$up.TotalHours)h $($up.Minutes)m  (booted $($os.LastBootUpTime))"
      "Memory      : $($totalMB - $freeMB) MB used of $totalMB MB  ($([math]::Round(($totalMB-$freeMB)/$totalMB*100))%)"
      "CPU load    : $((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average)%"
      ""
      "Disks:"
      Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
        Select-Object DeviceID,
          @{N='FreeGB';E={[math]::Round($_.FreeSpace/1GB,1)}},
          @{N='TotalGB';E={[math]::Round($_.Size/1GB,1)}},
          @{N='Free%';E={[math]::Round($_.FreeSpace/$_.Size*100)}} |
        Format-Table -AutoSize | Out-String -Width 200`,
  },

  /**
   * system.specs — the HARDWARE INVENTORY, as opposed to system.info's live
   * snapshot. Both existed as one verb in Craig's head and neither answered
   * him: 2026-08-10 he asked Marco for his PC's specs and got nothing back
   * (the worker had been dead 26 hours), and even with the worker alive the
   * only verb in range was system.info, which reports how much of the memory
   * is in USE and says nothing about what the memory IS. "What CPU is in this
   * machine" had no path through the platform at all.
   *
   * Separate verb, not a flag on system.info: these answers are static, so
   * the two have different lifetimes — a snapshot is worth re-taking every
   * time, an inventory is worth quoting from a job row weeks later.
   *
   * Every optional source is -ErrorAction SilentlyContinue with a fallback,
   * because a machine missing ONE CIM class (Get-PhysicalDisk on an old
   * build, no discrete GPU) must still return the rest rather than fail the
   * whole action — a spec sheet is useful in parts.
   */
  'system.specs': {
    mutates: false, needsAdmin: false,
    describe: () => "read the PC's hardware specs (machine, CPU, memory, GPU, disks, OS)",
    build: () => `
      $cs   = Get-CimInstance Win32_ComputerSystem
      $os   = Get-CimInstance Win32_OperatingSystem
      $bios = Get-CimInstance Win32_BIOS -ErrorAction SilentlyContinue
      $cpus = @(Get-CimInstance Win32_Processor)
      $cpu  = $cpus[0]
      $biosDate = if ($bios -and $bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { 'unknown' }
      # Computed OUT of the string rather than as a nested-quote subexpression:
      # this script is only ever exercised on Craig's machine, so parser
      # cleverness that cannot be tested here does not belong in it.
      $sockets = if ($cpus.Count -gt 1) { ', ' + $cpus.Count + ' sockets' } else { '' }

      "Machine     : $($cs.Manufacturer) $($cs.Model)"
      "Host        : $($cs.Name)   ($($cs.SystemType))"
      "BIOS        : $($bios.SMBIOSBIOSVersion)  ($biosDate)   serial $($bios.SerialNumber)"
      "OS          : $($os.Caption) $($os.OSArchitecture), build $($os.BuildNumber)  (version $($os.Version))"
      "CPU         : $(($cpu.Name -replace '\\s+', ' ').Trim())"
      "              $($cpu.NumberOfCores) cores / $($cpu.NumberOfLogicalProcessors) threads @ $($cpu.MaxClockSpeed) MHz$sockets"

      # MEMORY IN FULL. Craig asked for the specs "specifically ram", and on a
      # LAPTOP the answer he needs is not just the total: it is the type, how
      # many slots are occupied, and what the board will take — i.e. whether
      # there is any upgrade headroom at all. This machine died at 96% memory
      # pressure and took the worker down for 26 hours (2026-08-10), so
      # "16 GB installed" alone is the number that hides the problem.
      $mem = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue)
      $arr = Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction SilentlyContinue
      $memTypes = @{ 20='DDR'; 21='DDR2'; 22='DDR2 FB-DIMM'; 24='DDR3'; 26='DDR4';
                     27='LPDDR'; 28='LPDDR2'; 29='LPDDR3'; 30='LPDDR4'; 34='DDR5'; 35='LPDDR5' }
      $formFactors = @{ 8='DIMM'; 12='SODIMM' }
      $memType = 'unknown type'
      $memForm = ''
      if ($mem.Count -gt 0) {
        if ($memTypes.ContainsKey([int]$mem[0].SMBIOSMemoryType)) { $memType = $memTypes[[int]$mem[0].SMBIOSMemoryType] }
        if ($formFactors.ContainsKey([int]$mem[0].FormFactor)) { $memForm = $formFactors[[int]$mem[0].FormFactor] }
      }
      # Soldered memory reports no slots at all — say so rather than printing
      # "0 of 0", because it is the whole answer to "can I put more in".
      $slots = if ($arr -and $arr.MemoryDevices) { $arr.MemoryDevices } else { 'unknown' }
      $maxGB = 'unknown'
      if ($arr) {
        # Both fields are in KB; MaxCapacity is a uint32 and overflows past 4 TB,
        # so prefer MaxCapacityEx where the firmware provides it.
        if ($arr.MaxCapacityEx) { $maxGB = [math]::Round($arr.MaxCapacityEx/1MB) }
        elseif ($arr.MaxCapacity) { $maxGB = [math]::Round($arr.MaxCapacity/1MB) }
      }
      $totalGB = [math]::Round($cs.TotalPhysicalMemory/1GB, 1)
      "Memory      : $totalGB GB installed  ($memType $memForm)"
      "              $($mem.Count) module(s) in $slots slot(s), board maximum $maxGB GB"
      ""

      if ($mem.Count -gt 0) {
        "Memory modules:"
        $mem | Select-Object -First 8 @{N='Slot';E={$_.DeviceLocator}},
          @{N='GB';E={[math]::Round($_.Capacity/1GB, 1)}},
          @{N='Type';E={if ($memTypes.ContainsKey([int]$_.SMBIOSMemoryType)) { $memTypes[[int]$_.SMBIOSMemoryType] } else { $_.SMBIOSMemoryType }}},
          @{N='MHz';E={if ($_.ConfiguredClockSpeed) { $_.ConfiguredClockSpeed } else { $_.Speed }}},
          Manufacturer, PartNumber |
          Format-Table -AutoSize | Out-String -Width 200
      }

      $gpu = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)
      if ($gpu.Count -gt 0) {
        "Graphics:"
        $gpu | Select-Object -First 4 Name,
          @{N='VRAM_GB';E={if ($_.AdapterRAM -gt 0) { [math]::Round($_.AdapterRAM/1GB, 1) } else { '?' }}},
          @{N='Driver';E={$_.DriverVersion}},
          @{N='Mode';E={$_.VideoModeDescription}} |
          Format-Table -AutoSize | Out-String -Width 200
      }

      "Disks:"
      $phys = @(Get-PhysicalDisk -ErrorAction SilentlyContinue)
      if ($phys.Count -gt 0) {
        $phys | Select-Object -First 8 FriendlyName, MediaType, BusType,
          @{N='SizeGB';E={[math]::Round($_.Size/1GB)}} |
          Format-Table -AutoSize | Out-String -Width 200
      } else {
        Get-CimInstance Win32_DiskDrive -ErrorAction SilentlyContinue |
          Select-Object -First 8 Model, InterfaceType,
            @{N='SizeGB';E={[math]::Round($_.Size/1GB)}} |
          Format-Table -AutoSize | Out-String -Width 200
      }`,
  },

  // The verb that matters most right now: Craig's PC is crashing and nobody
  // has read its event log. Kernel-Power 41 = it went down without a clean
  // shutdown; BugCheck = a blue screen with a dump to read.
  'eventlog.errors': {
    mutates: false, needsAdmin: false,
    describe: (a) => `read the last ${HOURS(a.hours, 48, 720)}h of system errors and crash events`,
    build: (a) => {
      const since = HOURS(a.hours, 48, 720);
      return `
      $since = (Get-Date).AddHours(-${since})
      "=== Unexpected shutdowns / bugchecks since $since ==="
      Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$since; Id=41,1001,6008,6005} -ErrorAction SilentlyContinue |
        Select-Object -First 25 TimeCreated, Id, ProviderName,
          @{N='Message';E={($_.Message -replace '\\s+',' ').Substring(0,[Math]::Min(160,$_.Message.Length))}} |
        Format-List | Out-String -Width 200
      ""
      "=== Critical + Error events since $since (top providers) ==="
      Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$since; Level=1,2} -ErrorAction SilentlyContinue |
        Group-Object ProviderName | Sort-Object Count -Descending |
        Select-Object -First 12 Count, Name | Format-Table -AutoSize | Out-String -Width 200
      ""
      "=== Most recent 15 errors ==="
      Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$since; Level=1,2} -ErrorAction SilentlyContinue |
        Select-Object -First 15 TimeCreated, Id, ProviderName,
          @{N='Message';E={($_.Message -replace '\\s+',' ').Substring(0,[Math]::Min(140,$_.Message.Length))}} |
        Format-List | Out-String -Width 200
      ""
      "=== Minidumps on disk ==="
      Get-ChildItem C:\\Windows\\Minidump\\*.dmp -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 10 LastWriteTime, Name, Length |
        Format-Table -AutoSize | Out-String -Width 200`;
    },
  },

  // ── The flywheel's PC leg (2026-08-08) ────────────────────────────────────
  // Craig's own coding sessions write transcripts under %USERPROFILE%\.claude\
  // projects — the richest lessons in the estate (his corrections, his
  // preferences, in his words). Two read-only verbs let the harvester pull
  // them: list what's new, then fetch one file at a time, gzipped. BOTH are
  // pinned inside the transcript root — a fetch verb that took any path would
  // be an arbitrary-file exfiltration tool wearing a flywheel's name.
  'harvest.list': {
    mutates: false, needsAdmin: false,
    describe: (a) => `list coding-session transcripts newer than ${a.since || 'the beginning'}`,
    build: (a) => {
      const since = String(a.since || '1970-01-01T00:00:00Z');
      if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(since)) throw new Error('since must be an ISO timestamp');
      return `
      $root = Join-Path $env:USERPROFILE '.claude\\projects'
      if (-not (Test-Path $root)) { "NO-ROOT"; exit 0 }
      $since = [DateTime]::Parse(${psQuote(since)}).ToUniversalTime()
      Get-ChildItem $root -Recurse -Filter *.jsonl -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTimeUtc -gt $since } |
        Sort-Object LastWriteTimeUtc |
        Select-Object -First 40 |
        ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.ToString('o'))" }`;
    },
  },

  'harvest.get': {
    mutates: false, needsAdmin: false,
    describe: (a) => `fetch one transcript for the flywheel: ${String(a.path || '').slice(-60)}`,
    build: (a) => {
      const p = String(a.path || '');
      if (!p || p.length > 500) throw new Error('path required');
      return `
      $root = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude\\projects'))
      $full = [IO.Path]::GetFullPath(${psQuote(p)})
      if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'path is outside the transcript root' }
      if (-not $full.EndsWith('.jsonl', [StringComparison]::OrdinalIgnoreCase)) { throw 'not a transcript file' }
      $bytes = [IO.File]::ReadAllBytes($full)
      if ($bytes.Length -gt 8MB) { throw "transcript too large ($($bytes.Length) bytes)" }
      $ms = New-Object IO.MemoryStream
      $gz = New-Object IO.Compression.GZipStream($ms, [IO.Compression.CompressionMode]::Compress)
      $gz.Write($bytes, 0, $bytes.Length); $gz.Close()
      [Convert]::ToBase64String($ms.ToArray())`;
    },
  },

  // ── Mutating: staged behind the confirmation gate ─────────────────────────
  'service.restart': {
    mutates: true, needsAdmin: true,
    describe: (a) => `RESTART the "${a.name}" service`,
    build: (a) => {
      if (!SERVICE_NAME_RE.test(String(a.name || ''))) throw new Error('service name required');
      const n = psQuote(a.name);
      // Report the state either side: "it worked" must be observable, not assumed.
      return `
      $before = (Get-Service -Name ${n} -ErrorAction Stop).Status
      "before: $before"
      Restart-Service -Name ${n} -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 800
      $after = (Get-Service -Name ${n}).Status
      "after : $after"
      if ($after -ne 'Running') { throw "service is $after after restart" }`;
    },
  },

  'service.start': {
    mutates: true, needsAdmin: true,
    describe: (a) => `START the "${a.name}" service`,
    build: (a) => {
      if (!SERVICE_NAME_RE.test(String(a.name || ''))) throw new Error('service name required');
      const n = psQuote(a.name);
      return `Start-Service -Name ${n} -ErrorAction Stop
        Start-Sleep -Milliseconds 500
        "status: $((Get-Service -Name ${n}).Status)"`;
    },
  },

  'service.stop': {
    mutates: true, needsAdmin: true,
    describe: (a) => `STOP the "${a.name}" service`,
    build: (a) => {
      if (!SERVICE_NAME_RE.test(String(a.name || ''))) throw new Error('service name required');
      const n = psQuote(a.name);
      return `Stop-Service -Name ${n} -Force -ErrorAction Stop
        Start-Sleep -Milliseconds 500
        "status: $((Get-Service -Name ${n}).Status)"`;
    },
  },

  'process.kill': {
    mutates: true, needsAdmin: false,
    describe: (a) => `KILL ${a.pid ? `process ${a.pid}` : `every process named "${a.name}"`}`,
    build: (a) => {
      if (a.pid != null && a.pid !== '') {
        const pid = Number(a.pid);
        if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
        return `$p = Get-Process -Id ${pid} -ErrorAction Stop
          "killing: $($p.Name) ($($p.Id))"
          Stop-Process -Id ${pid} -Force -ErrorAction Stop
          "killed"`;
      }
      if (!/^[A-Za-z0-9._ -]{1,80}$/.test(String(a.name || ''))) throw new Error('process name or pid required');
      const n = psQuote(a.name);
      return `$name = ${n}
        $ps = @(Get-Process -Name $name -ErrorAction Stop)
        "killing $($ps.Count) process(es) named $name"
        $ps | Stop-Process -Force -ErrorAction Stop
        "killed"`;
    },
  },

  // The escape hatch — "do anything he needs". Still gated, still logged, and
  // still never interpolated into a command line: the worker feeds this to
  // powershell over stdin verbatim.
  'shell': {
    mutates: true, needsAdmin: false,
    describe: (a) => `run this on the PC: ${String(a.command || '').slice(0, 200)}`,
    build: (a) => {
      const cmd = String(a.command || '').trim();
      if (!cmd) throw new Error('command required');
      if (cmd.length > 8000) throw new Error('command too long (8000 char limit)');
      return cmd;
    },
  },
};

export const isKnownVerb = (verb) => Object.prototype.hasOwnProperty.call(VERBS, verb);

/**
 * THE SPECS PROBE — why a verb was not enough (2026-08-17).
 *
 * Craig, out shopping with only a phone, asked what RAM his laptop has. Every
 * route to the answer required the laptop itself: dispatch system.specs → the
 * worker must be online → and it must have been restarted to know the verb.
 * The machine was at home. So the platform could not answer a static fact
 * about hardware it has been diagnosing for weeks.
 *
 * A fact that never changes should not need the machine present to be read.
 * The worker measures this ONCE at startup and ships it in every heartbeat;
 * the server keeps it in KV `pc-worker-capability`, which SURVIVES the laptop
 * being asleep, shut, or in another county. "What RAM do I have" is then
 * answerable from any surface, offline, with no job dispatch at all.
 *
 * Deliberately k=v lines rather than JSON: PowerShell's ConvertTo-Json on CIM
 * objects drags in type metadata and can emit an array or a bare object
 * depending on row count — a shape that changes with the data is the wrong
 * contract for something parsed on the far side of a wire.
 */
export const SPECS_PROBE = `
  $cs   = Get-CimInstance Win32_ComputerSystem
  $os   = Get-CimInstance Win32_OperatingSystem
  $cpu  = @(Get-CimInstance Win32_Processor)[0]
  $mem  = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue)
  $arr  = Get-CimInstance Win32_PhysicalMemoryArray -ErrorAction SilentlyContinue
  $memTypes = @{ 20='DDR'; 21='DDR2'; 22='DDR2 FB-DIMM'; 24='DDR3'; 26='DDR4';
                 27='LPDDR'; 28='LPDDR2'; 29='LPDDR3'; 30='LPDDR4'; 34='DDR5'; 35='LPDDR5' }
  $ramType = 'unknown'
  if ($mem.Count -gt 0 -and $memTypes.ContainsKey([int]$mem[0].SMBIOSMemoryType)) { $ramType = $memTypes[[int]$mem[0].SMBIOSMemoryType] }
  $ramMax = ''
  if ($arr) {
    if ($arr.MaxCapacityEx) { $ramMax = [math]::Round($arr.MaxCapacityEx/1MB) }
    elseif ($arr.MaxCapacity) { $ramMax = [math]::Round($arr.MaxCapacity/1MB) }
  }
  "host=$($cs.Name)"
  "machine=$($cs.Manufacturer) $($cs.Model)"
  "cpu=$(($cpu.Name -replace '\\s+', ' ').Trim())"
  "cpu_cores=$($cpu.NumberOfCores)"
  "cpu_threads=$($cpu.NumberOfLogicalProcessors)"
  "ram_gb=$([math]::Round($cs.TotalPhysicalMemory/1GB, 1))"
  "ram_type=$ramType"
  "ram_modules=$($mem.Count)"
  "ram_slots=$(if ($arr -and $arr.MemoryDevices) { $arr.MemoryDevices } else { '' })"
  "ram_max_gb=$ramMax"
  "os=$($os.Caption) build $($os.BuildNumber)"`;

// The keys the probe is allowed to report. An allowlist rather than "whatever
// came back": this string is parsed on the server and stored, and a probe from
// a machine running older or edited code must not be able to inject arbitrary
// keys into the capability record.
export const SPECS_KEYS = [
  'host', 'machine', 'cpu', 'cpu_cores', 'cpu_threads',
  'ram_gb', 'ram_type', 'ram_modules', 'ram_slots', 'ram_max_gb', 'os',
];

/**
 * Parse the probe's k=v output. Total: never throws, ignores anything it does
 * not recognise, and returns null when nothing usable came back — a worker on
 * a machine that answered garbage must leave the stored specs alone rather
 * than overwrite good data with an empty object.
 */
export function parseSpecsSummary(stdout) {
  const out = {};
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const eq = raw.indexOf('=');
    if (eq < 1) continue;
    const key = raw.slice(0, eq).trim();
    if (!SPECS_KEYS.includes(key)) continue;
    // Bounded: a stored value is read back into a spoken reply.
    const value = raw.slice(eq + 1).trim().slice(0, 120);
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Server side: specs arriving over the wire, allowlisted and bounded. The job
 * row is not a trust boundary and neither is a heartbeat body — a worker is a
 * machine that can be running edited code, so the server takes only the keys
 * it knows and truncates every value before it is stored and later spoken.
 */
export function sanitizeSpecs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of SPECS_KEYS) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    const s = String(v).trim().slice(0, 120);
    if (s) out[key] = s;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * One line Craig can hear. Written from whatever the probe managed to collect,
 * because a partial answer ("16 GB, DDR4") is worth far more than silence when
 * he is standing in a shop.
 */
export function describeRam(specs) {
  if (!specs || !specs.ram_gb) return null;
  let line = `${specs.ram_gb} GB`;
  if (specs.ram_type && specs.ram_type !== 'unknown') line += ` ${specs.ram_type}`;
  if (specs.ram_modules && specs.ram_slots) line += `, ${specs.ram_modules} of ${specs.ram_slots} slots used`;
  if (specs.ram_max_gb) line += `, ${specs.ram_max_gb} GB board maximum`;
  return line;
}

/**
 * Does the CONNECTED worker know this verb? The worker re-validates every job
 * against its own copy of this table (decodeActionJob — the job row is not a
 * trust boundary), which means shipping a verb in this repo does not ship it
 * to the PC: a worker running older code refuses it, permanently, on every
 * dispatch. 2026-08-08→10 that manufactured 41 failed harvest.list jobs.
 *
 * The worker now reports its verb list in every heartbeat (stored in KV
 * `pc-worker-capability`), so the orchestrator can refuse the dispatch UP
 * FRONT with the remedy in the error — zero doomed jobs — instead of
 * manufacturing one for the worker to refuse. An older worker that doesn't
 * report verbs gets the benefit of the doubt: the refusal path still works,
 * and default-denying dispatch on missing data would have turned this fix
 * into an outage for every un-updated worker.
 */
export function workerKnowsVerb(capability, verb) {
  if (!capability || !Array.isArray(capability.verbs)) return true;
  return capability.verbs.includes(verb);
}

/**
 * How a script actually reaches powershell.exe — and this is NOT a detail.
 *
 * The obvious transport, and the one used elsewhere in this repo for the
 * `claude` CLI, is to pipe the script to `powershell -Command -` over stdin.
 * MEASURED 2026-07-31, on this machine, before shipping: with `-Command -`,
 * a MULTI-LINE script runs NOTHING and exits 0 with empty output. Not an
 * error — silence. Every verb in the table above is multi-line, so every
 * action would have "succeeded" while returning nothing, and Jarvis would have
 * reported a service's status as blank rather than as broken.
 *
 * -EncodedCommand is the correct transport and is safer besides: the argument
 * is base64 of UTF-16LE, i.e. only [A-Za-z0-9+/=], so it cannot break out of
 * argv even under cmd.exe's re-tokenization. Nothing untrusted ever reaches a
 * shell parser, which is rule 1 at the top of this file.
 *
 * $ProgressPreference is silenced because PowerShell writes progress records
 * to STDERR as CLIXML ("Preparing modules for first use") — noise that would
 * otherwise make every clean run look like it had also failed.
 */
export function buildPowerShellArgs(script) {
  const wrapped = `$ProgressPreference = 'SilentlyContinue'\n${script}`;
  return [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64'),
  ];
}

// PowerShell still emits a CLIXML envelope on stderr in some conditions. It is
// never useful to Craig and reads like a crash in a spoken reply.
export function cleanStderr(text) {
  return String(text || '')
    .replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '')
    .trim();
}

/**
 * Validate a requested action and produce everything the worker and the brain
 * need. Throws on anything it does not fully understand — an unknown verb must
 * never degrade into "run it and see".
 */
export function planAction(verb, args = {}) {
  if (!isKnownVerb(verb)) {
    throw new Error(`unknown PC action "${verb}" — known: ${Object.keys(VERBS).join(', ')}`);
  }
  const spec = VERBS[verb];
  const script = spec.build(args || {});
  return {
    verb,
    args: args || {},
    script,
    // Default-deny: only an explicit `mutates: false` is read-only.
    mutates: spec.mutates !== false,
    needsAdmin: !!spec.needsAdmin,
    description: spec.describe(args || {}),
  };
}

/**
 * How a job row carries an action. `runtime` already exists on the jobs table
 * ('claude' by default) and means exactly this — HOW to execute — so no schema
 * migration is needed and no existing reader changes behaviour.
 */
export const ACTION_RUNTIME = 'action';

export function encodeActionJob(plan) {
  return {
    runtime: ACTION_RUNTIME,
    task: plan.description,
    prompt: JSON.stringify({ verb: plan.verb, args: plan.args }),
  };
}

/**
 * The worker's side: turn a claimed job back into a script. Re-validates from
 * the verb table rather than trusting a script carried across the wire — the
 * job row is not a trust boundary we want to widen.
 */
export function decodeActionJob(job) {
  if (!job || job.runtime !== ACTION_RUNTIME) return null;
  let parsed;
  try {
    parsed = JSON.parse(job.prompt || '{}');
  } catch {
    throw new Error('action job has unreadable prompt JSON');
  }
  return planAction(parsed.verb, parsed.args || {});
}
