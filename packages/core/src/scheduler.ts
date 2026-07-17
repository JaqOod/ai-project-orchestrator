import type { ProjectModel } from './project-model.js';
import type { Task, TaskStatus } from './types.js';

/**
 * Statuses the scheduler is allowed to move between `blocked` and `ready`.
 * Terminal / actively-worked statuses are left untouched.
 */
const SCHEDULABLE = new Set<TaskStatus>(['draft', 'atomic', 'blocked', 'ready', 'stale']);

export interface SchedulerLog {
  ready: (task: Task) => void;
  blocked: (task: Task, reason: string) => void;
  done: (task: Task) => void;
  stale: (task: Task, reason: string) => void;
}

const noopLog: SchedulerLog = {
  ready: () => {},
  blocked: () => {},
  done: () => {},
  stale: () => {},
};

export interface GateResult {
  met: boolean;
  reason: string;
}

/**
 * The dependency scheduler (§16). It owns the single rule that makes the whole
 * "freeze the seam before building the children" guarantee real:
 *
 *   A task is READY iff every `depends-on` predecessor is `done`
 *   AND every consumed contract's live version is `frozen`.
 *
 * It never runs work itself — it only computes what *may* run now.
 */
export class Scheduler {
  private readonly model: ProjectModel;
  private readonly log: SchedulerLog;

  constructor(model: ProjectModel, log: Partial<SchedulerLog> = {}) {
    this.model = model;
    this.log = { ...noopLog, ...log };
  }

  /** Evaluate whether a single task's prerequisites are currently satisfied. */
  gate(taskId: string): GateResult {
    // 1. task-to-task dependencies
    const deps = this.model.edgesInto(taskId).filter((e) => e.kind === 'depends-on');
    for (const dep of deps) {
      const pred = this.model.getTask(dep.from);
      if (!pred || pred.status !== 'done') {
        return { met: false, reason: `waiting on dep '${dep.from}'` };
      }
    }
    // 2. consumed interface contracts must be frozen (the seam guarantee, §4)
    const consumed = this.model.contractsForTask(taskId, 'consumes');
    for (const contractId of consumed) {
      const contract = this.model.currentContract(contractId);
      if (!contract || contract.status !== 'frozen') {
        const state = contract ? `${contract.status} v${contract.version}` : 'missing';
        return { met: false, reason: `contract '${contractId}' not frozen (${state})` };
      }
    }
    return { met: true, reason: 'all prerequisites satisfied' };
  }

  /**
   * Recompute gating for every schedulable task, applying blocked<->ready
   * transitions, and return the tasks that are ready to run now.
   */
  computeReady(): Task[] {
    const ready: Task[] = [];
    for (const task of this.model.allTasks()) {
      if (!SCHEDULABLE.has(task.status)) continue;
      const result = this.gate(task.id);
      if (result.met) {
        if (task.status !== 'ready') {
          this.model.setStatus(task.id, 'ready', result.reason);
          this.log.ready({ ...task, status: 'ready' });
        }
        ready.push({ ...task, status: 'ready' });
      } else if (task.status !== 'blocked') {
        this.model.setStatus(task.id, 'blocked', result.reason);
        this.log.blocked({ ...task, status: 'blocked' }, result.reason);
      }
    }
    return ready;
  }

  /** Ready tasks without mutating state (a pure view). */
  readySet(): Task[] {
    return this.model
      .allTasks()
      .filter((t) => SCHEDULABLE.has(t.status) && this.gate(t.id).met);
  }

  /**
   * Mark a task complete and re-evaluate the frontier. Returns the tasks that
   * became ready as a result.
   */
  markDone(taskId: string): Task[] {
    this.model.setStatus(taskId, 'done', 'completed');
    const task = this.model.getTask(taskId);
    if (task) this.log.done(task);
    return this.computeReady();
  }

  /**
   * Handle a contract being superseded by a new version (§27.3). Every consumer
   * is marked `stale` (must re-run), and that staleness cascades to any `done`
   * dependents downstream — the blast radius. Consumers then sit blocked until
   * the new contract version is frozen.
   */
  restaleForContract(contractId: string): Task[] {
    for (const consumerId of this.model.consumersOfContract(contractId)) {
      this.markStale(consumerId, `contract '${contractId}' superseded`);
    }
    return this.computeReady();
  }

  private markStale(taskId: string, reason: string): void {
    const task = this.model.getTask(taskId);
    if (!task) return;
    if (task.status === 'stale') return; // already handled — stops cascade cycles
    this.model.setStatus(taskId, 'stale', reason);
    this.log.stale({ ...task, status: 'stale' }, reason);
    // cascade to done dependents: their input just changed underneath them
    for (const edge of this.model.edgesFrom(taskId)) {
      if (edge.kind !== 'depends-on') continue;
      const dependent = this.model.getTask(edge.to);
      if (dependent && dependent.status === 'done') {
        this.markStale(dependent.id, `upstream '${taskId}' became stale`);
      }
    }
  }
}
