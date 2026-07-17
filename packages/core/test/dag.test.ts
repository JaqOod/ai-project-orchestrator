import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectModel, Scheduler } from '../src/index.js';

/**
 * Phase 0 exit test.
 *
 * A scripted 5-task DAG built around a single frozen interface contract,
 * mirroring the §4 combat-system seam:
 *
 *   plan-combat  (produces contract combat.IDamageable)
 *        │  depends-on + freezes the contract
 *        ├── weapons        (consumes combat.IDamageable)
 *        ├── damage         (consumes combat.IDamageable)
 *        └── hit-detection  (consumes combat.IDamageable)
 *                 │  all three depended on by
 *                 └── integrate
 *
 * Proves: (1) correct execution order, (2) contract freezing gates the
 * children, (3) versioning + staleness re-queue exactly the right subset.
 */

const CONTRACT = 'combat.IDamageable';

// deterministic clock so status-event timestamps don't depend on wall time
let tick = 0;
const clock = () => `t${String(tick++).padStart(4, '0')}`;

function ids(tasks: { id: string }[]): string[] {
  return tasks.map((t) => t.id).sort();
}

function buildDag() {
  tick = 0;
  const model = ProjectModel.open(':memory:', clock);
  const scheduler = new Scheduler(model);

  model.addTask({ id: 'plan-combat', title: 'Plan combat system' });
  model.addTask({ id: 'weapons', title: 'Weapons', atomic: true });
  model.addTask({ id: 'damage', title: 'Damage', atomic: true });
  model.addTask({ id: 'hit-detection', title: 'Hit detection', atomic: true });
  model.addTask({ id: 'integrate', title: 'Integrate combat' });

  // the planner will freeze this; it starts merely proposed
  model.proposeContract({ id: CONTRACT, stubPath: 'contracts/combat/IDamageable.d.ts' });
  model.linkContract('plan-combat', CONTRACT, 'produces');

  for (const child of ['weapons', 'damage', 'hit-detection']) {
    model.addEdge('plan-combat', child, 'depends-on');
    model.linkContract(child, CONTRACT, 'consumes');
    model.addEdge(child, 'integrate', 'depends-on');
  }

  return { model, scheduler };
}

describe('Phase 0 — DAG scheduler with a frozen contract', () => {
  let model: ProjectModel;
  let scheduler: Scheduler;

  beforeEach(() => {
    ({ model, scheduler } = buildDag());
  });

  it('initially only the planner is ready; the children are all blocked', () => {
    const ready = scheduler.computeReady();
    expect(ids(ready)).toEqual(['plan-combat']);
    expect(model.getTask('weapons')!.status).toBe('blocked');
  });

  it('the seam guarantee: a child stays blocked on an UNFROZEN contract even once its dependency is done', () => {
    scheduler.computeReady();

    // finish the planner but deliberately do NOT freeze the contract
    scheduler.markDone('plan-combat');

    // the dependency is satisfied, so the ONLY thing holding the child back is
    // the un-frozen interface contract — this is the core §4 guarantee.
    const gate = scheduler.gate('weapons');
    expect(gate.met).toBe(false);
    expect(gate.reason).toContain('not frozen');
    expect(model.getTask('weapons')!.status).toBe('blocked');

    // freezing it releases the children
    model.freezeContract(CONTRACT, 1);
    expect(ids(scheduler.computeReady())).toEqual(['damage', 'hit-detection', 'weapons']);
  });

  it('freezing the contract + finishing the planner unblocks all three children', () => {
    scheduler.computeReady();

    // planner does its job: freeze the seam, then complete
    model.freezeContract(CONTRACT, 1);
    const newlyReady = scheduler.markDone('plan-combat');

    expect(ids(newlyReady)).toEqual(['damage', 'hit-detection', 'weapons']);
    // integration still cannot start — its deps aren't done
    expect(model.getTask('integrate')!.status).toBe('blocked');
  });

  it('integration only becomes ready after every child is done', () => {
    scheduler.computeReady();
    model.freezeContract(CONTRACT, 1);
    scheduler.markDone('plan-combat');

    scheduler.markDone('weapons');
    scheduler.markDone('damage');
    expect(model.getTask('integrate')!.status).toBe('blocked'); // still waiting on hit-detection

    const afterLast = scheduler.markDone('hit-detection');
    expect(ids(afterLast)).toContain('integrate');

    scheduler.markDone('integrate');
    expect(model.getTask('integrate')!.status).toBe('done');
  });

  it('respects topological order end-to-end (a dep is never ready before its predecessors are done)', () => {
    const order: string[] = [];
    scheduler.computeReady();
    model.freezeContract(CONTRACT, 1);

    // drain the frontier, always completing a currently-ready task
    let frontier = scheduler.readySet();
    while (frontier.length > 0) {
      const next = frontier[0]!;
      // invariant: every depends-on predecessor of `next` is already done
      for (const edge of model.edgesInto(next.id)) {
        if (edge.kind === 'depends-on') {
          expect(model.getTask(edge.from)!.status).toBe('done');
        }
      }
      order.push(next.id);
      scheduler.markDone(next.id);
      frontier = scheduler.readySet();
    }

    expect(order[0]).toBe('plan-combat');
    expect(order[order.length - 1]).toBe('integrate');
    expect(order).toHaveLength(5);
  });

  describe('contract versioning + staleness (§27.3)', () => {
    beforeEach(() => {
      // drive the whole DAG to done first
      scheduler.computeReady();
      model.freezeContract(CONTRACT, 1);
      scheduler.markDone('plan-combat');
      scheduler.markDone('weapons');
      scheduler.markDone('damage');
      scheduler.markDone('hit-detection');
      scheduler.markDone('integrate');
    });

    it('publishing v2 re-queues exactly the consumers + their downstream, and nothing else', () => {
      model.publishNewVersion(CONTRACT, { rationale: 'durability must be a struct, not an int' });
      const readyAfterSupersede = scheduler.restaleForContract(CONTRACT);

      // consumers + integrate go stale; the producer (plan-combat) does NOT re-run
      expect(model.getTask('plan-combat')!.status).toBe('done');
      expect(model.getTask('weapons')!.status).toBe('blocked'); // stale -> blocked (v2 not frozen)
      expect(model.getTask('damage')!.status).toBe('blocked');
      expect(model.getTask('hit-detection')!.status).toBe('blocked');
      expect(model.getTask('integrate')!.status).toBe('blocked'); // cascaded via depends-on

      // nothing is runnable until the new contract version is frozen
      expect(readyAfterSupersede).toHaveLength(0);
    });

    it('freezing v2 makes only the invalidated children ready again', () => {
      model.publishNewVersion(CONTRACT);
      scheduler.restaleForContract(CONTRACT);

      model.freezeContract(CONTRACT, 2);
      const ready = scheduler.computeReady();

      expect(ids(ready)).toEqual(['damage', 'hit-detection', 'weapons']);
      expect(model.currentContract(CONTRACT)!.version).toBe(2);

      // finish the re-queued work; integrate comes back last
      scheduler.markDone('weapons');
      scheduler.markDone('damage');
      const afterLast = scheduler.markDone('hit-detection');
      expect(ids(afterLast)).toContain('integrate');
    });
  });
});
