/**
 * Phase 1 exit test — THE SEAM PROOF.
 *
 * A planner freezes an interface contract between two modules; two executors
 * then implement producer and consumer INDEPENDENTLY (separate git worktrees,
 * never seeing each other's code). If the merged result compiles against the
 * stub and the planner-authored contract test passes, frozen contracts made
 * independent workers fit together — the core bet of the whole design (§4).
 *
 * Run: pnpm --filter @orchestrator/workers seam-proof
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProjectModel, Scheduler } from '@orchestrator/core';
import { runWorker } from './runner.js';
import { ensureWorkspaceRepo, createWorktree, mergeWorktree, removeWorktree } from './worktree.js';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const log = (msg: string) => console.log(msg);

const ROOT = resolve(import.meta.dirname, '../../..');
const WORKSPACE = join(ROOT, 'workspaces', 'seam-proof');

// ---- the mini product spec (deliberately tiny; the loop is the point) ------
const SPEC = `A tiny TypeScript "score system" with exactly two modules:
- src/producer.ts : tracks a player's score; awards points for events.
- src/consumer.ts : renders the current score state as a display string.
The consumer must know nothing about the producer's internals — only the shared interface.`;

// ---- planner output schema -------------------------------------------------
const PLAN_SCHEMA = {
  type: 'object',
  required: ['contractName', 'stubFileContent', 'contractTestContent', 'producerTask', 'consumerTask', 'rationale'],
  properties: {
    contractName: { type: 'string', description: 'e.g. score.IScore' },
    stubFileContent: {
      type: 'string',
      description:
        'Content of src/contract.ts: the frozen interface — exported types/interfaces both modules share. Types only, no implementation.',
    },
    contractTestContent: {
      type: 'string',
      description:
        "Content of src/contract.test.ts: a plain script (no test framework) that imports { createProducer } from './producer.ts' and { renderScore } from './consumer.ts', wires them through the contract types, and throws Error on any violation. Ends with console.log('CONTRACT OK'). Use .ts extensions in imports.",
    },
    producerTask: { type: 'string', description: 'Full instructions for the producer executor.' },
    consumerTask: { type: 'string', description: 'Full instructions for the consumer executor.' },
    rationale: { type: 'string' },
  },
} as const;

const EXEC_SCHEMA = {
  type: 'object',
  required: ['filesWritten', 'summary'],
  properties: {
    filesWritten: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
} as const;

interface PlanOut {
  contractName: string;
  stubFileContent: string;
  contractTestContent: string;
  producerTask: string;
  consumerTask: string;
  rationale: string;
}

async function main() {
  log(bold('\n══ Phase 1: the seam proof ══\n'));

  // fresh workspace + project model
  rmSync(WORKSPACE, { recursive: true, force: true });
  ensureWorkspaceRepo(WORKSPACE);
  mkdirSync(join(WORKSPACE, 'src'), { recursive: true });
  writeFileSync(
    join(WORKSPACE, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );

  const model = ProjectModel.open(':memory:');
  const scheduler = new Scheduler(model);
  model.addTask({ id: 'plan', title: 'Plan score system' });
  model.addTask({ id: 'producer', title: 'Implement producer', atomic: true });
  model.addTask({ id: 'consumer', title: 'Implement consumer', atomic: true });
  model.addTask({ id: 'integrate', title: 'Integrate + gates' });
  model.proposeContract({ id: 'score.contract', stubPath: 'src/contract.ts' });
  model.linkContract('plan', 'score.contract', 'produces');
  for (const t of ['producer', 'consumer']) {
    model.addEdge('plan', t, 'depends-on');
    model.linkContract(t, 'score.contract', 'consumes');
    model.addEdge(t, 'integrate', 'depends-on');
  }
  scheduler.computeReady();

  // ---- 1. PLANNER (strong model, read-only) --------------------------------
  log(bold('1) Planner (sonnet) — decompose and FREEZE the contract'));
  model.setStatus('plan', 'in_progress');
  const plan = await runWorker<PlanOut>({
    role: 'planner',
    model: 'sonnet',
    cwd: WORKSPACE,
    allowWrites: false,
    maxTurns: 8,
    schema: PLAN_SCHEMA,
    systemPrompt:
      'You are a PLANNER. You never write production code. You decompose work and freeze the interface contract the children share. The contract must be complete enough that two developers who never talk can implement against it and their code fits.',
    prompt: `Decompose this spec into a frozen contract plus two independent tasks.\n\n${SPEC}\n\nRequirements:\n- contract.ts holds ALL shared types. producer.ts must export a factory function createProducer, consumer.ts must export renderScore. Pin their exact signatures in the contract and repeat them in each task's instructions.\n- Each task instruction must say: implement ONLY your file, import shared types ONLY from './contract.ts' (use the .ts extension), do not create other files.\n- The contract test must verify observable behaviour through the contract only.`,
  });
  if (!plan.ok || !plan.output) throw new Error(`planner failed: ${plan.error}`);
  const p = plan.output;
  log(`   contract: ${green(p.contractName)}  ${dim(`(${plan.durationMs}ms, ${plan.numTurns} turns)`)}`);
  log(`   ${dim(p.rationale.slice(0, 160))}`);

  // orchestrator materialises the frozen artifacts and commits them so every
  // worktree inherits the SAME stub — the seam is now frozen.
  writeFileSync(join(WORKSPACE, 'src', 'contract.ts'), p.stubFileContent);
  writeFileSync(join(WORKSPACE, 'src', 'contract.test.ts'), p.contractTestContent);
  execFileSync('git', ['add', '-A'], { cwd: WORKSPACE });
  execFileSync('git', ['commit', '-q', '-m', 'freeze contract'], { cwd: WORKSPACE });
  model.freezeContract('score.contract', 1);
  scheduler.markDone('plan');
  log(green('   ✓ contract frozen & committed\n'));

  // ---- 2. EXECUTORS (cheap model, isolated worktrees, in parallel) ---------
  log(bold('2) Executors (haiku) — implement independently in isolated worktrees'));
  const execTask = (name: 'producer' | 'consumer', instructions: string) => {
    model.setStatus(name, 'in_progress');
    const wt = createWorktree(WORKSPACE, name);
    return runWorker<{ filesWritten: string[]; summary: string }>({
      role: name,
      model: 'haiku',
      cwd: wt,
      allowWrites: true,
      maxTurns: 15,
      schema: EXEC_SCHEMA,
      systemPrompt:
        "You are an EXECUTOR implementing exactly one atomic task against a frozen contract. Read src/contract.ts first and honour it exactly. Never modify contract.ts or contract.test.ts. Never create files beyond the one your task names. CONVENTION: every relative import MUST include the .ts extension (e.g. import type { X } from './contract.ts') — bare './contract' will fail the build.",
      prompt: instructions,
    });
  };

  const [prodRes, consRes] = await Promise.all([
    execTask('producer', p.producerTask),
    execTask('consumer', p.consumerTask),
  ]);
  for (const [name, r] of [['producer', prodRes], ['consumer', consRes]] as const) {
    if (!r.ok) throw new Error(`${name} failed: ${r.error}`);
    log(`   ${green('✓')} ${name}: ${r.output!.filesWritten.join(', ')} ${dim(`(${r.durationMs}ms)`)}`);
  }

  // ---- 3. INTEGRATE + CONTRACT GATES ---------------------------------------
  log(bold('\n3) Integrate the worktrees and run the contract gates'));
  mergeWorktree(WORKSPACE, 'producer');
  mergeWorktree(WORKSPACE, 'consumer');
  removeWorktree(WORKSPACE, 'producer');
  removeWorktree(WORKSPACE, 'consumer');
  scheduler.markDone('producer');
  scheduler.markDone('consumer');
  log('   merged both branches');

  // gate 1: the merged code must COMPILE against the frozen stub
  try {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: WORKSPACE, shell: true, encoding: 'utf8' });
    log(green('   ✓ gate 1: compiles against the frozen contract'));
  } catch (e) {
    log(red('   ✗ gate 1 FAILED: type errors at the seam'));
    log(dim(String((e as { stdout?: string }).stdout ?? e)));
    process.exit(1);
  }

  // gate 2: the planner-authored contract test must pass at runtime
  try {
    const out = execFileSync('node', ['--no-warnings', 'src/contract.test.ts'], {
      cwd: WORKSPACE,
      encoding: 'utf8',
    });
    if (!out.includes('CONTRACT OK')) throw new Error(out);
    log(green('   ✓ gate 2: contract test passes at runtime'));
  } catch (e) {
    log(red('   ✗ gate 2 FAILED: behavioural contract violation'));
    log(dim(String((e as { stdout?: string }).stdout ?? e)));
    process.exit(1);
  }

  scheduler.markDone('integrate');
  log(bold(green('\n══ SEAM PROOF PASSED ══')));
  log('Two workers who never saw each other\'s code produced pieces that fit,');
  log('because the planner froze the interface before they started.\n');
}

main().catch((e) => {
  console.error(red(`seam-proof failed: ${e.message}`));
  process.exit(1);
});
