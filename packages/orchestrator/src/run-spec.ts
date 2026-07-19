/**
 * Generic entry point: build ANY product from a plain-text spec file.
 *
 *   node dist/run-spec.js <spec.md> [--name <workspace-name>] [--type web|node|rust] [--rounds N]
 *
 * - type node (default): a Node/CLI/library product; verified by a worker that
 *   builds and actually runs it against the spec.
 * - type web: a browser product on canvas#game; verified by the Director via
 *   headless-Chrome screenshots.
 * - type rust: a terminal Rust product (crossterm only); verified like node.
 *
 * The finished product lands in workspaces/<name>/ (its own git repo) with a
 * persisted Project Model + studio.json, so `run-amend` can iterate on it later.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Orchestrator } from './orchestrator.js';
import { PRODUCT_TYPES } from './product-types.js';
import { runVerifyRounds } from './verify-rounds.js';
import { modelPath, saveStudioState, type StudioProductType } from './studio-state.js';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const specPath = argv.find((a) => !a.startsWith('--'));
if (!specPath || !existsSync(specPath)) {
  console.error('usage: run-spec <spec-file> [--name <name>] [--type web|node|rust] [--rounds N]');
  process.exit(1);
}
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const SPEC = readFileSync(specPath, 'utf8');
const NAME = flag('name', basename(specPath).replace(/\.[^.]+$/, ''));
const TYPE_ID = flag('type', 'node') as StudioProductType;
const ROUNDS = Number(flag('rounds', '2'));
const TYPE = PRODUCT_TYPES[TYPE_ID];
if (!TYPE) {
  console.error(`unknown --type '${TYPE_ID}' (web | node | rust)`);
  process.exit(1);
}

const ROOT = resolve(import.meta.dirname, '../../..');
const WS = join(ROOT, 'workspaces', NAME);

// ---- main ------------------------------------------------------------------
async function main() {
  console.log(bold(`\n══ Orchestrate: ${NAME} (${TYPE_ID}) ══\n`));
  // fresh build: wipe, then scaffold + the living spec + studio state
  rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  TYPE.writeFixtures(WS, NAME);
  writeFileSync(join(WS, 'SPEC.md'), SPEC);
  saveStudioState(WS, {
    name: NAME,
    type: TYPE_ID,
    specPath: 'SPEC.md',
    createdAt: new Date().toISOString(),
    rounds: [],
  });

  const orch = new Orchestrator({
    workspace: WS,
    spec: SPEC,
    conventions: TYPE.conventions(),
    maxDepth: 2,
    concurrency: 3,
    maxRetries: 1,
    buildGate: TYPE.buildGate,
    modelPath: modelPath(WS),
  });
  const result = await orch.run();
  console.log(bold(`\nBuild pass: ${result.done} done, ${result.failed} failed`));

  const verdicts = await runVerifyRounds({ orch, type: TYPE, workspace: WS, spec: SPEC, rounds: ROUNDS });
  const last = verdicts.at(-1);
  saveStudioState(WS, {
    name: NAME,
    type: TYPE_ID,
    specPath: 'SPEC.md',
    createdAt: new Date().toISOString(),
    rounds: verdicts.map((v) => ({
      at: new Date().toISOString(),
      kind: 'build' as const,
      verdict: v.verdict,
      acceptable: v.acceptable,
    })),
  });
  try {
    git(WS, 'add', '-A');
    git(WS, 'commit', '-q', '-m', 'build complete: studio state + dist');
  } catch { /* nothing to commit */ }

  orch.printStats();
  console.log(bold(green(`\n══ ${NAME.toUpperCase()} COMPLETE ══`)));
  console.log(`Product: workspaces/${NAME}/  (${TYPE.runHint(WS)})`);
  if (last && !last.acceptable) console.log(red(` - final verdict: ${last.verdict.slice(0, 300)}`));
  for (const i of orch.designIssues) console.log(red(` - design issue: ${i.split('\n')[0]}`));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

main().catch((e) => {
  console.error(red(`run failed: ${e.message}`));
  process.exit(1);
});
