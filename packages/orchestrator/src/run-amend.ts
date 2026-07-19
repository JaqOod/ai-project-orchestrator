/**
 * Amend an already-built workspace incrementally — the studio iteration loop.
 *
 *   node dist/run-amend.js <workspace-name-or-path> <feedback.md> [--rounds N]
 *
 * Opens the persisted Project Model (no wipe), has a Sonnet planner turn the
 * user's feedback + existing source into new atomic tasks, pumps them through
 * the normal gate/merge machinery, then runs the same verify rounds as a build.
 * v1 is additive-only: no contract re-versioning; a change that touches a
 * contract file is emitted as ONE task updating the contract and all consumers.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { runWorker } from '@orchestrator/workers';
import { Orchestrator } from './orchestrator.js';
import { PRODUCT_TYPES } from './product-types.js';
import { runVerifyRounds } from './verify-rounds.js';
import { loadStudioState, modelPath, saveStudioState } from './studio-state.js';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const [wsArg, feedbackPath] = positional;
if (!wsArg || !feedbackPath || !existsSync(feedbackPath)) {
  console.error('usage: run-amend <workspace-name-or-path> <feedback.md> [--rounds N]');
  process.exit(1);
}
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const ROUNDS = Number(flag('rounds', '2'));
const ROOT = resolve(import.meta.dirname, '../../..');
const WS = isAbsolute(wsArg) ? wsArg : join(ROOT, 'workspaces', wsArg);

const state = loadStudioState(WS);
if (!state) {
  console.error(red(`No studio project found at ${WS} — build it first with: pnpm orchestrate <spec.md>`));
  process.exit(1);
}
const TYPE = PRODUCT_TYPES[state.type];
const FEEDBACK = readFileSync(feedbackPath, 'utf8');
const SPEC_PATH = join(WS, state.specPath);

// ---- amend planner ---------------------------------------------------------
const AMEND_SCHEMA = {
  type: 'object',
  required: ['updatedSpecSection', 'tasks'],
  properties: {
    updatedSpecSection: {
      type: 'string',
      description: 'markdown describing the change, to append to the living SPEC.md',
    },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'spec'],
        properties: {
          id: { type: 'string', description: 'kebab-case, unique' },
          spec: {
            type: 'string',
            description:
              'Complete standalone instructions naming the exact file(s) to create or edit and the precise behaviour change. The executor sees ONLY this plus the frozen contract files.',
          },
        },
      },
    },
  },
} as const;
interface AmendPlan {
  updatedSpecSection: string;
  tasks: { id: string; spec: string }[];
}

async function planAmend(spec: string): Promise<AmendPlan> {
  const files = execFileSync('git', ['ls-files', 'src'], { cwd: WS, encoding: 'utf8' }).trim();
  const res = await runWorker<AmendPlan>({
    role: 'amend-planner',
    model: 'sonnet',
    cwd: WS,
    allowWrites: false,
    maxTurns: 15,
    schema: AMEND_SCHEMA,
    systemPrompt:
      'You are an AMEND PLANNER in an AI software factory. The product is already built and working; the user wants changes. You never write production code — you read the existing source and emit small, independent, atomic edit tasks for executor workers who see only their task text plus the contract files. If a change requires modifying a contract file, emit ONE task that updates the contract AND every consumer together.',
    prompt: [
      `USER FEEDBACK (the changes wanted now):\n${FEEDBACK}`,
      `\nCURRENT PRODUCT SPEC:\n${spec}`,
      `\nPROJECT CONVENTIONS (mandatory):\n${TYPE.conventions()}`,
      `\nEXISTING SOURCE FILES:\n${files}`,
      '\nRead whichever source files you need to plan precisely. Then emit 1-6 atomic tasks (each: exact files, exact behaviour) plus a short markdown section documenting the change for the living spec.',
    ].join('\n'),
  });
  if (!res.ok || !res.output) throw new Error(`amend planner failed: ${res.error}`);
  return res.output;
}

// ---- main ------------------------------------------------------------------
async function main() {
  console.log(bold(`\n══ Amend: ${state!.name} (${state!.type}) ══\n`));
  // snapshot anything dirty so the gate's rollback (reset --hard HEAD~1) is safe
  try {
    git(WS, 'add', '-A');
    git(WS, 'commit', '-q', '-m', 'pre-amend snapshot');
  } catch { /* clean */ }

  const spec = readFileSync(SPEC_PATH, 'utf8');
  const orch = new Orchestrator({
    workspace: WS,
    spec,
    conventions: TYPE.conventions(),
    concurrency: 3,
    maxRetries: 1,
    buildGate: TYPE.buildGate,
    modelPath: modelPath(WS),
  });

  console.log(bold('◆ PLAN amendment'));
  const plan = await planAmend(spec);
  const round = state!.rounds.length + 1;
  appendFileSync(SPEC_PATH, `\n\n## Change ${round} (${new Date().toISOString().slice(0, 10)})\n\n${plan.updatedSpecSection}\n`);
  git(WS, 'add', '-A');
  try {
    git(WS, 'commit', '-q', '-m', `amend ${round}: spec update`);
  } catch { /* no-op */ }

  for (const t of plan.tasks) {
    console.log(dim(`   + task a${round}-${t.id}`));
    orch.addFixTask(`a${round}-${t.id}`, t.spec, []);
  }
  const result = await orch.pump();
  console.log(bold(`\nAmend pass: ${result.done} done, ${result.failed} failed`));

  const fullSpec = readFileSync(SPEC_PATH, 'utf8');
  const verdicts = await runVerifyRounds({
    orch,
    type: TYPE,
    workspace: WS,
    spec: fullSpec,
    rounds: ROUNDS,
    idPrefix: `a${round}-`,
  });
  const last = verdicts.at(-1);
  state!.rounds.push({
    at: new Date().toISOString(),
    kind: 'amend',
    feedback: FEEDBACK.split('\n')[0]!.slice(0, 120),
    verdict: last?.verdict ?? 'no verdict',
    acceptable: last?.acceptable ?? false,
  });
  saveStudioState(WS, state!);
  git(WS, 'add', '-A');
  try {
    git(WS, 'commit', '-q', '-m', `amend ${round}: ${FEEDBACK.split('\n')[0]!.slice(0, 60)}`);
  } catch { /* no-op */ }

  orch.printStats();
  console.log(bold(green(`\n══ AMEND ${round} COMPLETE ══`)));
  console.log(`Product: ${WS}  (${TYPE.runHint(WS)})`);
  if (last && !last.acceptable) console.log(red(` - final verdict: ${last.verdict.slice(0, 300)}`));
  for (const i of orch.designIssues) console.log(red(` - design issue: ${i.split('\n')[0]}`));
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

main().catch((e) => {
  console.error(red(`amend failed: ${e.message}`));
  process.exit(1);
});
