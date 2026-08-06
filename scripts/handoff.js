#!/usr/bin/env node
/**
 * Hand a platform's findings over to that platform's own agent.
 *
 * 2026-08-05, Craig: "i can pass the security problems to the zoobicon agent".
 * That is the right shape and the direction docs/GOVERNANCE.md is heading —
 * the platform owns its fixes, Jarvis navigates. This produces the brief.
 *
 *   node scripts/handoff.js zoobicon                      # preview
 *   node scripts/handoff.js zoobicon --severity high      # widen the net
 *   node scripts/handoff.js zoobicon --claim              # ...and stop Jarvis working them
 *   node scripts/handoff.js zoobicon --out /tmp/brief.md
 *
 * --claim is the important half. Without it, fix-runner keeps selecting the
 * same findings and two agents write two different fixes for one bug in one
 * repo — the exact race that gluecron finding #229 describes in its own code.
 * It stamps `fix_job_id` with a handoff sentinel, which fix-runner already
 * treats as "someone else has this" (lib/fix-dispatch.js). Deliberately NOT a
 * new status: leaving the finding `confirmed` means code-health still
 * re-checks it later and can mark it `fixed` on its own evidence, so a handoff
 * that quietly goes nowhere still surfaces instead of vanishing.
 */

const MEMORY = process.env.JARVIS_MEMORY || 'http://127.0.0.1:9200';
const RANK = { critical: 0, high: 1, medium: 2, low: 3 };

const args = process.argv.slice(2);
const platform = args.find(a => !a.startsWith('--'));
const flag = (name, dflt = null) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? dflt : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const minSeverity = String(flag('severity', 'critical'));
const doClaim = !!flag('claim', false);
const outPath = flag('out', null);

if (!platform) {
  console.error('usage: node scripts/handoff.js <platform> [--severity critical|high|medium] [--claim] [--out FILE]');
  process.exit(1);
}
if (!(minSeverity in RANK)) {
  console.error(`--severity must be one of ${Object.keys(RANK).join('|')}`);
  process.exit(1);
}

const esc = (s) => String(s ?? '').replace(/\r/g, '').trim();

async function main() {
  const res = await fetch(`${MEMORY}/memory/findings?platform=${encodeURIComponent(platform)}&open_only=1&limit=300`);
  if (!res.ok) throw new Error(`memory returned ${res.status}`);
  const all = await res.json();

  const picked = all
    .filter(f => (RANK[f.severity] ?? 9) <= RANK[minSeverity])
    // Only hand over what survived adversarial verification. An unverified
    // finding wastes the receiving agent's time and damages trust in the whole
    // handoff — the same rule fix-runner applies before spending an agent.
    .filter(f => f.status === 'confirmed')
    .sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) || a.id - b.id);

  const skipped = all.filter(f => (RANK[f.severity] ?? 9) <= RANK[minSeverity] && f.status !== 'confirmed');
  const withFix = picked.filter(f => f.fix_job_id && !String(f.fix_job_id).startsWith('handoff:'));

  const L = [];
  L.push(`# ${platform} — security & correctness findings`);
  L.push('');
  L.push(`Handed over by Jarvis on ${new Date().toISOString().slice(0, 10)}. ${picked.length} finding(s) at ${minSeverity} or worse.`);
  L.push('');
  L.push('Every finding below was produced by a read-only review agent and then');
  L.push('**independently re-checked by an adversarial verifier** whose job was to refute');
  L.push('it. Only the ones it could not refute are here. The evidence quoted is what the');
  L.push('verifier confirmed, not a summary of it.');
  L.push('');
  L.push('They are ordered worst first. Each names the file and line where it was found —');
  L.push('**check the line still says what the evidence claims before changing anything**,');
  L.push('since the review ran against the commit noted per finding and the tree has moved.');
  L.push('');
  if (withFix.length) {
    L.push(`## Already written — ${withFix.length} of these have a fix on a branch`);
    L.push('');
    L.push('Jarvis prepared these before the handoff. Review them rather than starting from');
    L.push('scratch; they are branches, nothing is merged.');
    L.push('');
    for (const f of withFix) L.push(`- **#${f.id}** \`jarvis/fix-${f.id}\` — ${esc(f.title)}`);
    L.push('');
  }
  L.push('---');
  L.push('');

  for (const f of picked) {
    const loc = f.file_path ? `\`${f.file_path}${f.line ? ':' + f.line : ''}\`` : '_location not recorded_';
    L.push(`## #${f.id} — ${esc(f.title)}`);
    L.push('');
    L.push(`| | |`);
    L.push(`|---|---|`);
    L.push(`| **Severity** | ${f.severity} |`);
    L.push(`| **Kind** | ${f.kind} |`);
    L.push(`| **Location** | ${loc} |`);
    L.push(`| **Found against** | ${f.commit_sha ? '`' + f.commit_sha + '`' : 'unknown commit'} |`);
    L.push(`| **Seen** | ${f.seen_count} sweep(s), first ${String(f.first_seen).slice(0, 10)} |`);
    if (f.fix_job_id && !String(f.fix_job_id).startsWith('handoff:')) {
      L.push(`| **Existing fix** | branch \`jarvis/fix-${f.id}\` |`);
    }
    L.push('');
    L.push('**What the verifier confirmed:**');
    L.push('');
    L.push('> ' + (esc(f.evidence) || '_no evidence recorded_').split('\n').join('\n> '));
    L.push('');
    if (f.suggested_fix) {
      L.push('**Suggested direction** (not binding — your call):');
      L.push('');
      L.push('> ' + esc(f.suggested_fix).split('\n').join('\n> '));
      L.push('');
    }
    L.push('---');
    L.push('');
  }

  if (skipped.length) {
    L.push(`## Not included (${skipped.length})`);
    L.push('');
    L.push('These are at the same severity but were never adversarially verified, so they');
    L.push('may be wrong. Listed for completeness only — do not act on them without');
    L.push('confirming them yourself.');
    L.push('');
    for (const f of skipped) L.push(`- #${f.id} (${f.status}) ${esc(f.title)}`);
    L.push('');
  }

  const brief = L.join('\n');
  if (outPath && typeof outPath === 'string') {
    const { writeFileSync } = await import('fs');
    writeFileSync(outPath, brief);
    console.error(`written: ${outPath} (${picked.length} findings, ${brief.length} bytes)`);
  } else {
    process.stdout.write(brief);
  }

  if (doClaim) {
    let claimed = 0;
    for (const f of picked) {
      // Never overwrite a real fix job — that would lose the link to a branch
      // someone is actually reviewing.
      if (f.fix_job_id) continue;
      const r = await fetch(`${MEMORY}/memory/findings/${f.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fix_job_id: `handoff:${platform}-agent` }),
      });
      if (r.ok) claimed++;
    }
    console.error(`claimed ${claimed} finding(s) as handed off — fix-runner will leave them alone.`);
    console.error(`They stay 'confirmed', so code-health still re-checks them and will mark`);
    console.error(`them fixed on its own evidence if the handoff lands.`);
  }
}

main().catch(e => { console.error(`handoff failed: ${e.message}`); process.exit(1); });
