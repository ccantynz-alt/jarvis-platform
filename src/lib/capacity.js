// capacity.js — adaptive job concurrency (Marco spec §7, 2026-08-31). Pure: the
// orchestrator feeds it os.loadavg()/os.freemem(); nothing here touches the OS.
// Production is protected by the CEILING (never add pressure), never by
// preemption: a shrinking ceiling stops NEW spawns, running jobs always finish.

export function ceilingFor({ load1, cores, freeMemGB }) {
  const perCore = load1 / cores;
  if (perCore > 0.7 || freeMemGB < 1.5) return 1;
  if (perCore < 0.4 && freeMemGB > 3.0) return 6;
  return 4;
}

export function computeSlots({ queued, running, load1, cores, freeMemGB, fixed = null }) {
  const ceiling = fixed !== null ? fixed : ceilingFor({ load1, cores, freeMemGB });
  const wanted = Math.min(Math.ceil(queued / 2), ceiling);
  return Math.max(0, Math.min(wanted, ceiling - running));
}
