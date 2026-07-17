// Phase 0 demo — watch the scheduler drive the §4 combat seam to completion
// with rich terminal logging. Run:  node packages/core/demo/run.mjs
import { ProjectModel, Scheduler } from '../dist/index.js';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const model = ProjectModel.open(':memory:');
const scheduler = new Scheduler(model, {
  ready: (t) => console.log(`  ${c.green('▶ READY')}   ${t.id}`),
  blocked: (t, why) => console.log(`  ${c.dim('· blocked')} ${t.id} ${c.dim(`(${why})`)}`),
  done: (t) => console.log(`  ${c.cyan('✓ DONE')}    ${t.id}`),
  stale: (t, why) => console.log(`  ${c.yellow('⟳ STALE')}   ${t.id} ${c.dim(`(${why})`)}`),
});

const CONTRACT = 'combat.IDamageable';
model.addTask({ id: 'plan-combat', title: 'Plan combat' });
model.addTask({ id: 'integrate', title: 'Integrate' });
for (const child of ['weapons', 'damage', 'hit-detection']) {
  model.addTask({ id: child, title: child, atomic: true });
  model.addEdge('plan-combat', child, 'depends-on');
  model.linkContract(child, CONTRACT, 'consumes');
  model.addEdge(child, 'integrate', 'depends-on');
}
model.proposeContract({ id: CONTRACT, stubPath: 'contracts/combat/IDamageable.d.ts' });
model.linkContract('plan-combat', CONTRACT, 'produces');

console.log(c.bold('\n1) Initial frontier — only the planner can run:'));
scheduler.computeReady();

console.log(c.bold('\n2) Planner freezes the contract, then completes:'));
model.freezeContract(CONTRACT, 1);
scheduler.markDone('plan-combat');

console.log(c.bold('\n3) Build the three children, then integrate:'));
for (const id of ['weapons', 'damage', 'hit-detection', 'integrate']) scheduler.markDone(id);

console.log(c.bold('\n4) A frozen interface was wrong — publish v2, invalidate the blast radius:'));
model.publishNewVersion(CONTRACT, { rationale: 'durability must be a struct, not an int' });
scheduler.restaleForContract(CONTRACT);

console.log(c.bold('\n5) Freeze v2 — only the invalidated subset re-runs (note: plan-combat does NOT):'));
model.freezeContract(CONTRACT, 2);
scheduler.computeReady();
for (const id of ['weapons', 'damage', 'hit-detection', 'integrate']) scheduler.markDone(id);

const done = model.allTasks().filter((t) => t.status === 'done').length;
console.log(c.bold(`\nAll settled: ${done}/${model.allTasks().length} tasks done. ` + c.green('✓')));
