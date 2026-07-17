import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import type {
  Artifact,
  ArtifactKind,
  Contract,
  ContractRelation,
  ContractShape,
  Edge,
  EdgeKind,
  RiskTier,
  StatusEvent,
  Task,
  TaskStatus,
} from './types.js';

/** Injectable clock so tests are deterministic. */
export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

export interface NewTask {
  id: string;
  title: string;
  spec?: string;
  parentId?: string | null;
  status?: TaskStatus;
  depth?: number;
  atomic?: boolean;
  riskTier?: RiskTier;
  createdBy?: string;
}

export interface NewContract {
  id: string;
  stubPath?: string;
  shape?: ContractShape;
  rationale?: string;
  authoredBy?: string;
}

const emptyShape = (): ContractShape => ({
  functions: [],
  events: [],
  dataTypes: [],
  conventions: {},
});

/**
 * The Project Model: the permanent, central store. Every worker reads from and
 * writes to this — never to each other (§3, §5).
 */
export class ProjectModel {
  private readonly db: DatabaseSync;
  private readonly now: Clock;

  constructor(db: DatabaseSync, clock: Clock = systemClock) {
    this.db = db;
    this.now = clock;
  }

  /** Convenience factory: open a DB (default in-memory) and wrap it. */
  static open(path?: string, clock?: Clock): ProjectModel {
    return new ProjectModel(openDatabase(path), clock);
  }

  // ---- Tasks -------------------------------------------------------------

  addTask(input: NewTask): Task {
    const task: Task = {
      id: input.id,
      parentId: input.parentId ?? null,
      title: input.title,
      spec: input.spec ?? '',
      status: input.status ?? 'draft',
      depth: input.depth ?? 0,
      atomic: input.atomic ?? false,
      riskTier: input.riskTier ?? 'normal',
      createdBy: input.createdBy ?? 'system',
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, parent_id, title, spec, status, depth, atomic, risk_tier, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.parentId,
        task.title,
        task.spec,
        task.status,
        task.depth,
        task.atomic ? 1 : 0,
        task.riskTier,
        task.createdBy,
      );
    this.recordEvent(task.id, null, task.status, 'created');
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTask(row) : undefined;
  }

  allTasks(): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks').all() as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  setStatus(id: string, status: TaskStatus, note?: string): void {
    const current = this.getTask(id);
    if (!current) throw new Error(`setStatus: unknown task ${id}`);
    if (current.status === status) return;
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, id);
    this.recordEvent(id, current.status, status, note);
  }

  private recordEvent(taskId: string, from: TaskStatus | null, to: TaskStatus, note?: string): void {
    this.db
      .prepare(
        'INSERT INTO status_events (task_id, from_status, to_status, at, note) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, from, to, this.now(), note ?? null);
  }

  statusEvents(taskId: string): StatusEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM status_events WHERE task_id = ? ORDER BY rowid')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      taskId: r.task_id as string,
      from: (r.from_status as TaskStatus | null) ?? null,
      to: r.to_status as TaskStatus,
      at: r.at as string,
      note: (r.note as string | null) ?? undefined,
    }));
  }

  // ---- Edges (the DAG) ---------------------------------------------------

  addEdge(from: string, to: string, kind: EdgeKind): void {
    this.db
      .prepare('INSERT OR IGNORE INTO edges (from_id, to_id, kind) VALUES (?, ?, ?)')
      .run(from, to, kind);
  }

  /** Edges pointing INTO `taskId` (its prerequisites). */
  edgesInto(taskId: string): Edge[] {
    const rows = this.db.prepare('SELECT * FROM edges WHERE to_id = ?').all(taskId) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToEdge);
  }

  /** Edges pointing OUT of `taskId` (its dependents). */
  edgesFrom(taskId: string): Edge[] {
    const rows = this.db.prepare('SELECT * FROM edges WHERE from_id = ?').all(taskId) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToEdge);
  }

  // ---- Contracts (versioned, immutable) ----------------------------------

  /** Author a new contract at version 1 in 'proposed' state. */
  proposeContract(input: NewContract): Contract {
    return this.insertContractVersion({
      id: input.id,
      version: 1,
      supersedes: null,
      status: 'proposed',
      stubPath: input.stubPath ?? '',
      shape: input.shape ?? emptyShape(),
      rationale: input.rationale ?? '',
      authoredBy: input.authoredBy ?? 'system',
    });
  }

  /** Freeze a specific contract version. Only frozen contracts unblock consumers. */
  freezeContract(id: string, version: number): void {
    const res = this.db
      .prepare(`UPDATE contracts SET status = 'frozen' WHERE id = ? AND version = ?`)
      .run(id, version);
    if (res.changes === 0) throw new Error(`freezeContract: no contract ${id}@${version}`);
  }

  /**
   * Publish a superseding version (§27.3). Marks the current version superseded
   * and inserts a new, higher, 'proposed' version. Does NOT auto-freeze — the
   * caller freezes when ready. Returns the new contract version.
   */
  publishNewVersion(id: string, changes: Partial<NewContract> = {}): Contract {
    const current = this.currentContract(id);
    if (!current) throw new Error(`publishNewVersion: no contract ${id}`);
    this.db
      .prepare(`UPDATE contracts SET status = 'superseded' WHERE id = ? AND version = ?`)
      .run(id, current.version);
    const next = current.version + 1;
    return this.insertContractVersion({
      id,
      version: next,
      supersedes: `${id}@${current.version}`,
      status: 'proposed',
      stubPath: changes.stubPath ?? current.stubPath,
      shape: changes.shape ?? current.shape,
      rationale: changes.rationale ?? current.rationale,
      authoredBy: changes.authoredBy ?? current.authoredBy,
    });
  }

  /** The live version of a contract id: highest version that isn't superseded. */
  currentContract(id: string): Contract | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM contracts
         WHERE id = ? AND status != 'superseded'
         ORDER BY version DESC LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToContract(row) : undefined;
  }

  getContractVersion(id: string, version: number): Contract | undefined {
    const row = this.db
      .prepare('SELECT * FROM contracts WHERE id = ? AND version = ?')
      .get(id, version) as Record<string, unknown> | undefined;
    return row ? rowToContract(row) : undefined;
  }

  private insertContractVersion(c: Contract): Contract {
    this.db
      .prepare(
        `INSERT INTO contracts (id, version, supersedes, status, stub_path, shape_json, rationale, authored_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.version,
        c.supersedes,
        c.status,
        c.stubPath,
        JSON.stringify(c.shape),
        c.rationale,
        c.authoredBy,
      );
    return c;
  }

  // ---- Task <-> Contract links -------------------------------------------

  linkContract(taskId: string, contractId: string, relation: ContractRelation): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO task_contracts (task_id, contract_id, relation) VALUES (?, ?, ?)',
      )
      .run(taskId, contractId, relation);
  }

  contractsForTask(taskId: string, relation: ContractRelation): string[] {
    const rows = this.db
      .prepare('SELECT contract_id FROM task_contracts WHERE task_id = ? AND relation = ?')
      .all(taskId, relation) as Record<string, unknown>[];
    return rows.map((r) => r.contract_id as string);
  }

  /** Task ids that consume a given contract id (its blast radius on change). */
  consumersOfContract(contractId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT task_id FROM task_contracts WHERE contract_id = ? AND relation = 'consumes'`,
      )
      .all(contractId) as Record<string, unknown>[];
    return rows.map((r) => r.task_id as string);
  }

  // ---- Artifacts (the only communication channel, §12) -------------------

  addArtifact(input: Omit<Artifact, 'createdAt'> & { createdAt?: string }): Artifact {
    const artifact: Artifact = { ...input, createdAt: input.createdAt ?? this.now() };
    this.db
      .prepare(
        `INSERT INTO artifacts (id, kind, task_id, path, produced_by, created_at, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.kind,
        artifact.taskId,
        artifact.path,
        artifact.producedBy,
        artifact.createdAt,
        JSON.stringify(artifact.meta ?? {}),
      );
    return artifact;
  }

  artifactsForTask(taskId: string, kind?: ArtifactKind): Artifact[] {
    const rows = (
      kind
        ? this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? AND kind = ?').all(taskId, kind)
        : this.db.prepare('SELECT * FROM artifacts WHERE task_id = ?').all(taskId)
    ) as Record<string, unknown>[];
    return rows.map(rowToArtifact);
  }
}

// ---- row mappers ---------------------------------------------------------

function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string,
    parentId: (r.parent_id as string | null) ?? null,
    title: r.title as string,
    spec: r.spec as string,
    status: r.status as TaskStatus,
    depth: r.depth as number,
    atomic: (r.atomic as number) === 1,
    riskTier: r.risk_tier as RiskTier,
    createdBy: r.created_by as string,
  };
}

function rowToEdge(r: Record<string, unknown>): Edge {
  return { from: r.from_id as string, to: r.to_id as string, kind: r.kind as EdgeKind };
}

function rowToContract(r: Record<string, unknown>): Contract {
  return {
    id: r.id as string,
    version: r.version as number,
    supersedes: (r.supersedes as string | null) ?? null,
    status: r.status as Contract['status'],
    stubPath: r.stub_path as string,
    shape: JSON.parse(r.shape_json as string) as ContractShape,
    rationale: r.rationale as string,
    authoredBy: r.authored_by as string,
  };
}

function rowToArtifact(r: Record<string, unknown>): Artifact {
  return {
    id: r.id as string,
    kind: r.kind as ArtifactKind,
    taskId: r.task_id as string,
    path: r.path as string,
    producedBy: r.produced_by as string,
    createdAt: r.created_at as string,
    meta: JSON.parse(r.meta_json as string) as Record<string, unknown>,
  };
}
