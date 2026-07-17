/**
 * Project Model domain types.
 *
 * These mirror §3 of BUILD-PLAN.md. They are the permanent knowledge of the
 * system: if every worker vanished, everything important would still live here.
 */

export type TaskStatus =
  | 'draft' // created, not yet scheduled or planned
  | 'planning' // a planner is decomposing it
  | 'atomic' // determined to be a leaf; awaits execution
  | 'blocked' // gated: deps unfinished or consumed contracts not frozen
  | 'ready' // all gates satisfied; runnable now
  | 'in_progress' // a worker is executing it
  | 'in_review' // executed; passing through gates
  | 'done' // completed and integrated
  | 'stale' // must re-run (e.g. a consumed contract was superseded)
  | 'failed'; // gave up after retries

export type RiskTier = 'trivial' | 'normal' | 'critical';

/** How a task relates to a contract. */
export type ContractRelation = 'produces' | 'consumes';

/** Edge kinds in the dependency DAG (§16). */
export type EdgeKind = 'depends-on' | 'consumes-contract';

export type ContractStatus = 'proposed' | 'frozen' | 'superseded';

export type ArtifactKind =
  | 'ExecutionPlan'
  | 'Contract'
  | 'ResearchNote'
  | 'SourceCode'
  | 'Asset'
  | 'Test'
  | 'ValidationReport'
  | 'ReviewReport'
  | 'CapabilityRequest'
  | 'DesignIssue';

export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  spec: string;
  status: TaskStatus;
  depth: number;
  atomic: boolean;
  riskTier: RiskTier;
  createdBy: string;
}

/** The structured, machine-readable part of a frozen interface contract (§4). */
export interface ContractShape {
  functions: { name: string; signature: string }[];
  events: { name: string; payloadType: string }[];
  dataTypes: { name: string; fields: { name: string; type: string }[] }[];
  conventions: { naming?: string; files?: string; other?: string[] };
}

/**
 * A versioned, immutable interface contract. A given `id` may have several
 * versions; you never edit a version, you publish a superseding one (§27.3).
 */
export interface Contract {
  id: string;
  version: number;
  supersedes: string | null; // "id@version" of the contract this replaces
  status: ContractStatus;
  stubPath: string; // path to the .d.ts / interface file executors implement against
  shape: ContractShape;
  rationale: string;
  authoredBy: string;
}

export interface Edge {
  from: string; // task id
  to: string; // task id that depends on `from`
  kind: EdgeKind;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  taskId: string;
  path: string;
  producedBy: string;
  createdAt: string;
  meta: Record<string, unknown>;
}

/** A record of a task's status change, for auditability. */
export interface StatusEvent {
  taskId: string;
  from: TaskStatus | null;
  to: TaskStatus;
  at: string;
  note?: string;
}
