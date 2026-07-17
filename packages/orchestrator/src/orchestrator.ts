/**
 * The orchestrator (Phase 2): drives the core loop over a real product
 * workspace — recursive planning with frozen contracts, an executor pool with
 * worktree isolation, serialized merges, a compile gate after every merge,
 * retry-with-feedback, and DesignIssue artifacts instead of halting (§15).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ProjectModel, Scheduler, type Task } from '@orchestrator/core';
import {
  runWorker,
  ensureWorkspaceRepo,
  createWorktree,
  mergeWorktree,
  removeWorktree,
} from '@orchestrator/workers';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export interface RunConfig {
  workspace: string;
  /** root product spec */
  spec: string;
  /** conventions every worker must follow (the universal reference doc, §6) */
  conventions: string;
  maxDepth?: number;
  concurrency?: number;
  maxRetries?: number;
  /** returns null on success or an error report string */
  buildGate: (workspace: string) => string | null;
}

interface PlanChild {
  id: string;
  title: string;
  spec: string;
  atomic: boolean;
  consumes: string[];
  dependsOn: string[];
}
interface PlanOut {
  verdict: 'atomic' | 'split';
  contracts: { id: string; fileName: string; content: string }[];
  children: PlanChild[];
  rationale: string;
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['verdict', 'contracts', 'children', 'rationale'],
  properties: {
    verdict: { type: 'string', enum: ['atomic', 'split'] },
    contracts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'fileName', 'content'],
        properties: {
          id: { type: 'string', description: 'e.g. game.IState' },
          fileName: { type: 'string', description: 'workspace-relative path, e.g. src/contracts.ts' },
          content: { type: 'string', description: 'TypeScript types/interfaces only, no implementation' },
        },
      },
    },
    children: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'spec', 'atomic', 'consumes', 'dependsOn'],
        properties: {
          id: { type: 'string', description: 'kebab-case, unique' },
          title: { type: 'string' },
          spec: {
            type: 'string',
            description:
              'Complete standalone instructions: exact file to create, exports with exact signatures from the contract, behaviour. The executor sees ONLY this + the contract files.',
          },
          atomic: { type: 'boolean', description: 'true if one small file, one model call, checkable' },
          consumes: { type: 'array', items: { type: 'string' }, description: 'contract ids it must honour' },
          dependsOn: {
            type: 'array',
            items: { type: 'string' },
            description:
              'sibling child ids whose OUTPUT FILES this child imports at build time. A child that imports another module (beyond the contract file) must list it here so it is scheduled after that module exists. Children that only share contract types need NO dependency.',
          },
        },
      },
    },
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

export class Orchestrator {
  readonly model: ProjectModel;
  readonly scheduler: Scheduler;
  private readonly cfg: Required<RunConfig>;
  private mergeLock: Promise<void> = Promise.resolve();
  readonly designIssues: string[] = [];
  readonly stats: { task: string; role: string; model: string; durationMs: number; turns: number }[] = [];

  constructor(cfg: RunConfig) {
    this.cfg = { maxDepth: 2, concurrency: 3, maxRetries: 1, ...cfg };
    this.model = ProjectModel.open(':memory:');
    this.scheduler = new Scheduler(this.model);
    ensureWorkspaceRepo(cfg.workspace);
  }

  async run(): Promise<{ done: number; failed: number; issues: string[] }> {
    this.model.addTask({ id: 'root', title: 'root', spec: this.cfg.spec, status: 'draft' });
    return this.pump();
  }

  /** Drive the frontier until nothing is left to do (also used to resume after re-queues). */
  async pump(): Promise<{ done: number; failed: number; issues: string[] }> {
    const active = new Set<string>();
    const running: Promise<void>[] = [];

    // simple frontier pump: keep spawning ready work up to the concurrency cap
    while (true) {
      const ready = this.scheduler
        .computeReady()
        .filter((t) => !active.has(t.id));
      for (const task of ready) {
        if (active.size >= this.cfg.concurrency) break;
        active.add(task.id);
        const p = this.dispatch(task)
          .catch((e) => {
            console.log(red(`   ✗ ${task.id} crashed: ${e.message}`));
            this.model.setStatus(task.id, 'failed', e.message);
          })
          .finally(() => active.delete(task.id));
        running.push(p);
      }
      const pending = this.model
        .allTasks()
        .filter((t) => !['done', 'failed'].includes(t.status));
      if (pending.length === 0) break;
      if (active.size === 0 && ready.length === 0) {
        // nothing runnable and nothing running: deadlock or all blocked-forever
        for (const t of pending) this.model.setStatus(t.id, 'failed', 'unschedulable');
        break;
      }
      await sleep(300);
    }
    await Promise.allSettled(running);
    const all = this.model.allTasks();
    return {
      done: all.filter((t) => t.status === 'done').length,
      failed: all.filter((t) => t.status === 'failed').length,
      issues: this.designIssues,
    };
  }

  printStats(): void {
    const total = this.stats.reduce((s, x) => s + x.durationMs, 0);
    console.log(bold('\nWorker stats:'));
    for (const s of this.stats)
      console.log(dim(`  ${s.role.padEnd(9)} ${s.model.padEnd(7)} ${String(s.durationMs).padStart(7)}ms  ${s.turns} turns  ${s.task}`));
    console.log(dim(`  total worker time: ${(total / 1000).toFixed(1)}s across ${this.stats.length} calls`));
  }

  private async dispatch(task: Task): Promise<void> {
    if (task.atomic) return this.execute(task);
    return this.plan(task);
  }

  // ---- planning ------------------------------------------------------------
  private async plan(task: Task): Promise<void> {
    this.model.setStatus(task.id, 'planning');
    const forceAtomic = task.depth >= this.cfg.maxDepth;
    console.log(bold(`◆ PLAN ${task.id}`) + dim(` (depth ${task.depth}${forceAtomic ? ', max depth — informational' : ''})`));

    const res = await runWorker<PlanOut>({
      role: 'planner',
      model: 'sonnet',
      cwd: this.cfg.workspace,
      allowWrites: false,
      maxTurns: 10,
      schema: PLAN_SCHEMA,
      systemPrompt:
        'You are a PLANNER in an AI software factory. You never write production code. You either declare a task atomic, or split it into children AND freeze the complete interface contract between them (a TypeScript contracts file with every shared type and exact function signatures). Children are built by independent workers who never talk to each other — the contract is their only common ground, so it must pin EVERYTHING shared: names, signatures, data shapes, file names.',
      prompt: [
        `TASK: ${task.title}`,
        `SPEC:\n${task.spec}`,
        `\nPROJECT CONVENTIONS (mandatory):\n${this.cfg.conventions}`,
        forceAtomic
          ? '\nDepth limit reached: you MUST return verdict "atomic" with no children.'
          : `\nA task is atomic when it is one small file, completable in a single sitting, with a clear checkable result. Otherwise split into 3-8 children (mark each child atomic:true unless it genuinely needs further splitting) and emit the frozen contract file(s) they share. Child specs must be fully self-contained.`,
      ].join('\n'),
    });
    if (!res.ok || !res.output) throw new Error(`planner failed: ${res.error}`);
    this.stats.push({ task: task.id, role: 'planner', model: 'sonnet', durationMs: res.durationMs, turns: res.numTurns });
    const plan = res.output;

    if (plan.verdict === 'atomic' || plan.children.length === 0) {
      // reclassify and let the executor path pick it up on the next pump
      this.model.setAtomic(task.id, true);
      this.model.setStatus(task.id, 'atomic', 'planner declared atomic');
      console.log(dim(`   ${task.id}: declared atomic`));
      return;
    }

    // freeze the seams: write contract files, commit, register + freeze
    for (const c of plan.contracts) {
      const p = join(this.cfg.workspace, c.fileName);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c.content);
      this.model.proposeContract({ id: c.id, stubPath: c.fileName, authoredBy: task.id });
      this.model.freezeContract(c.id, 1);
      this.model.linkContract(task.id, c.id, 'produces');
    }
    git(this.cfg.workspace, 'add', '-A');
    try {
      git(this.cfg.workspace, 'commit', '-q', '-m', `freeze contracts for ${task.id}`);
    } catch { /* nothing new */ }

    for (const child of plan.children) {
      this.model.addTask({
        id: child.id,
        parentId: task.id,
        title: child.title,
        spec: child.spec,
        depth: task.depth + 1,
        atomic: child.atomic,
        createdBy: task.id,
      });
      this.model.addEdge(task.id, child.id, 'depends-on');
      for (const cid of child.consumes) this.model.linkContract(child.id, cid, 'consumes');
    }
    // inter-child build dependencies (added after all children exist, FK-safe)
    for (const child of plan.children) {
      for (const dep of child.dependsOn ?? []) {
        if (plan.children.some((c) => c.id === dep) && dep !== child.id) {
          this.model.addEdge(dep, child.id, 'depends-on');
        }
      }
    }
    console.log(
      green(`   ✓ split into ${plan.children.length} children, froze ${plan.contracts.length} contract file(s)`) +
        dim(` [${plan.children.map((c) => c.id).join(', ')}]`),
    );
    this.model.setStatus(task.id, 'done', 'planned');
  }

  // ---- execution -----------------------------------------------------------
  private async execute(task: Task, attempt = 0, feedback = ''): Promise<void> {
    this.model.setStatus(task.id, 'in_progress');
    console.log(bold(`▶ EXEC ${task.id}`) + dim(attempt ? ` (retry ${attempt})` : ''));

    // context package: the task spec + the frozen contracts it consumes
    const contracts = this.model
      .contractsForTask(task.id, 'consumes')
      .map((cid) => this.model.currentContract(cid))
      .filter(Boolean)
      .map((c) => {
        const p = join(this.cfg.workspace, c!.stubPath);
        return existsSync(p) ? `--- ${c!.stubPath} (FROZEN contract) ---\n${readFileSync(p, 'utf8')}` : '';
      })
      .join('\n\n');

    const wtName = `${task.id}${attempt ? `-r${attempt}` : ''}`;
    const wt = createWorktree(this.cfg.workspace, wtName);
    const res = await runWorker<{ filesWritten: string[]; summary: string }>({
      role: task.id,
      model: 'haiku',
      cwd: wt,
      allowWrites: true,
      maxTurns: 20,
      schema: EXEC_SCHEMA,
      systemPrompt:
        "You are an EXECUTOR implementing exactly one atomic task against frozen contracts. Honour the contract files exactly — never modify them. Create only the file(s) your task names. CONVENTION: every relative import MUST include the .ts extension (e.g. from './contracts.ts').",
      prompt: [
        `TASK: ${task.title}`,
        `SPEC:\n${task.spec}`,
        `\nPROJECT CONVENTIONS (mandatory):\n${this.cfg.conventions}`,
        contracts ? `\nFROZEN CONTRACTS you must honour:\n${contracts}` : '',
        feedback ? `\nPREVIOUS ATTEMPT FAILED THE BUILD GATE. Fix these errors:\n${feedback}` : '',
      ].join('\n'),
    });
    if (!res.ok) {
      removeWorktree(this.cfg.workspace, wtName);
      throw new Error(`executor failed: ${res.error}`);
    }
    this.stats.push({ task: task.id, role: 'executor', model: 'haiku', durationMs: res.durationMs, turns: res.numTurns });

    // integrate: serialized merge + build gate
    const gateError = await this.withMergeLock(() => {
      mergeWorktree(this.cfg.workspace, wtName);
      removeWorktree(this.cfg.workspace, wtName);
      const err = this.cfg.buildGate(this.cfg.workspace);
      if (err) {
        // roll the merge back so the mainline stays green
        git(this.cfg.workspace, 'reset', '--hard', 'HEAD~1');
      }
      return err;
    });

    if (gateError) {
      console.log(yellow(`   ⚠ ${task.id} failed the build gate`));
      if (attempt < this.cfg.maxRetries) {
        return this.execute(task, attempt + 1, gateError.slice(0, 2000));
      }
      this.designIssues.push(`${task.id}: exhausted retries. Last gate error:\n${gateError.slice(0, 500)}`);
      this.model.setStatus(task.id, 'failed', 'gate failed after retries');
      console.log(red(`   ✗ ${task.id} FAILED after ${attempt + 1} attempts → DesignIssue recorded`));
      return;
    }
    console.log(green(`   ✓ ${task.id} merged & gate green`) + dim(` (${res.durationMs}ms) ${res.output!.summary.slice(0, 80)}`));
    this.model.setStatus(task.id, 'done');
  }

  private withMergeLock<T>(fn: () => T): Promise<T> {
    const result = this.mergeLock.then(fn);
    this.mergeLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Re-queue a fix task (used by the Director loop). */
  addFixTask(id: string, spec: string, consumes: string[]): void {
    this.model.addTask({ id, title: `fix: ${id}`, spec, atomic: true, depth: 1, createdBy: 'director' });
    for (const cid of consumes) this.model.linkContract(id, cid, 'consumes');
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
