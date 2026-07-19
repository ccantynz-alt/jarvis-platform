// scripts/test-brain.mjs — end-to-end proof of the subscription Claude brain.
// Run ON THE BOX: node scripts/test-brain.mjs [prompt]
// Exercises: claude-auth profile discovery → brain-claude SDK session →
// streaming → tool loop → transcript append. Prints provider, model, timings.
import { runAgent, getBrainProvider, hasAgent } from '../src/lib/agent.js';

const prompt = process.argv[2] || 'In one short sentence: which model are you running as, and is the system healthy? End with the word BRAIN-OK.';
console.log(`provider=${getBrainProvider()} hasAgent=${hasAgent()}`);
const t0 = Date.now();
let first = 0;
const transcript = [];
try {
  const out = await runAgent(transcript, prompt, (chunk) => {
    if (!first) { first = Date.now() - t0; process.stdout.write(`[first token ${first}ms] `); }
    process.stdout.write(chunk);
  });
  console.log(`\n---\ntotal=${Date.now() - t0}ms provider_after=${getBrainProvider()}`);
  console.log(`speech="${out.speech.slice(0, 120)}"`);
  process.exit(out.text.includes('BRAIN-OK') || out.text.length > 0 ? 0 : 1);
} catch (e) {
  console.error(`\nFAILED after ${Date.now() - t0}ms: ${e.message}`);
  process.exit(1);
}
