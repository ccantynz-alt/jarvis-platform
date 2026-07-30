/**
 * Jarvis lint config — KNOWN DEBT #7, cleared 2026-07-30.
 *
 * This exists because of one bug. `src/slack-bridge.js` logged
 * `` `[slack] intent via ${via} (${ms}ms)` `` where `ms` was never declared, so
 * EVERY Slack command threw a ReferenceError. It shipped on 2026-07-08 and sat
 * there for 22 days. `node --check` cannot see it — an undeclared identifier is
 * valid syntax — and no test covered that line.
 *
 * The debt entry was deferred twice for a good reason: nobody knew how many
 * violations existed, so nobody knew whether adding a linter meant a five-minute
 * job or a week of cleanup. That is now measured. Against the real pre-fix file,
 * this config reports:
 *
 *     637:45  error  'ms' is not defined            no-undef
 *     624:9   error  't0' is assigned but never used  no-unused-vars
 *
 * — the bug, plus its own corroboration. Against the whole tree it reported 13
 * problems, all trivial, all fixed in the same commit. Total cost: one afternoon.
 *
 * Run it:  npm run lint
 *
 * NOT wired into `npm test` on purpose. The test suite runs on a dev checkout
 * with no node_modules (deps live on the box), and a test command that cannot run
 * where it is invoked is worse than no test command. Lint on the box, or wherever
 * dependencies are installed.
 */

import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Node runtime. Listed explicitly rather than pulling in a globals
        // package — this is the whole surface these services actually use, and a
        // dependency for a name list is not worth it.
        process: 'readonly', console: 'readonly', Buffer: 'readonly', global: 'readonly',
        globalThis: 'readonly', __dirname: 'readonly', __filename: 'readonly',
        require: 'readonly', module: 'writable', exports: 'writable',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', setImmediate: 'readonly', queueMicrotask: 'readonly',
        // Web-standard APIs present in modern Node.
        fetch: 'readonly', Response: 'readonly', Request: 'readonly', Headers: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', AbortController: 'readonly',
        AbortSignal: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        structuredClone: 'readonly', crypto: 'readonly', performance: 'readonly',
        WebSocket: 'readonly',
      },
    },
    rules: {
      // The rule this config was created for. Keep it an error, always.
      'no-undef': 'error',

      // args: 'none' — express handlers legitimately take (req, res, next) and
      // ignore some. caughtErrors: 'none' — `catch (e) {}` where e is unused is a
      // deliberate best-effort pattern here. varsIgnorePattern — `_name` opts out.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],

      // OFF deliberately, and this is the one judgement call in the file. This
      // codebase uses `catch { /* why */ }` extensively and on purpose — cache
      // pruning, budget tracking and notification plumbing must never take down a
      // caller, and each one carries a comment saying so. Enabling no-empty would
      // have meant 30 disable directives, which teaches people to add disable
      // directives. If an empty catch is ever wrong here, it is wrong because it
      // hides a failure that should be reported — a code-review question, not a
      // lint one.
      'no-empty': 'off',
    },
  },
  {
    // page.evaluate() callbacks are serialised and executed inside Chromium, not
    // in this process, so `document` and friends are correct there and no-undef
    // is wrong about them. Scoped to the one file that drives a browser rather
    // than declared globally, so a stray `document` anywhere else is still caught.
    files: ['src/browser-service.js'],
    languageOptions: {
      globals: { document: 'readonly', window: 'readonly', navigator: 'readonly' },
    },
  },
];
