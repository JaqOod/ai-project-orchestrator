/**
 * The shared verify/re-queue loop used by both fresh builds and amends:
 * build dist → verify (type-specific) → re-queue defects as fix tasks → pump.
 */
import type { Orchestrator } from './orchestrator.js';
import type { ProductType, Verdict } from './product-types.js';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

export interface VerifyRoundOptions {
  orch: Orchestrator;
  type: ProductType;
  workspace: string;
  spec: string;
  rounds: number;
  /** keeps fix-task ids unique across the persisted model, e.g. 'a3-' */
  idPrefix?: string;
}

export async function runVerifyRounds(opts: VerifyRoundOptions): Promise<Verdict[]> {
  const { orch, type, workspace, spec, rounds, idPrefix = '' } = opts;
  const verdicts: Verdict[] = [];
  for (let round = 1; round <= rounds; round++) {
    type.buildDist(workspace);
    console.log(bold(`\n◇ VERIFY round ${round} (${type.id})`));
    const v = await type.verify(workspace, spec);
    verdicts.push(v);
    console.log(`   ${v.acceptable ? green('acceptable') : red('not acceptable')} — ${v.verdict.slice(0, 200)}`);
    if (v.acceptable && v.defects.length === 0) break;
    if (round === rounds || v.defects.length === 0) {
      if (!v.acceptable) orch.designIssues.push(`still not acceptable after ${round} rounds: ${v.verdict}`);
      break;
    }
    for (const d of v.defects) {
      console.log(`   ⟳ re-queue ${d.id}`);
      orch.addFixTask(`${idPrefix}${d.id}-r${round}`, d.fixSpec, []);
    }
    await orch.pump();
  }
  type.buildDist(workspace);
  return verdicts;
}
