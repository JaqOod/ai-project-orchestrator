import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// `node:sqlite` is a prefix-only builtin. Load it via a real Node require so
// bundlers (e.g. Vite/vitest) don't statically resolve and mangle the specifier.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/**
 * Opens (or creates) a Project Model database and ensures its schema exists.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5) so persistence needs no
 * native build toolchain. Pass ':memory:' for tests.
 */
export function openDatabase(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSyncCtor(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  createSchema(db);
  return db;
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      parent_id   TEXT REFERENCES tasks(id),
      title       TEXT NOT NULL,
      spec        TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL,
      depth       INTEGER NOT NULL DEFAULT 0,
      atomic      INTEGER NOT NULL DEFAULT 0,
      risk_tier   TEXT NOT NULL DEFAULT 'normal',
      created_by  TEXT NOT NULL DEFAULT 'system'
    );

    -- Contracts are versioned & immutable: (id, version) is the identity.
    CREATE TABLE IF NOT EXISTS contracts (
      id          TEXT NOT NULL,
      version     INTEGER NOT NULL,
      supersedes  TEXT,
      status      TEXT NOT NULL,
      stub_path   TEXT NOT NULL DEFAULT '',
      shape_json  TEXT NOT NULL DEFAULT '{}',
      rationale   TEXT NOT NULL DEFAULT '',
      authored_by TEXT NOT NULL DEFAULT 'system',
      PRIMARY KEY (id, version)
    );

    -- Which task produces / consumes which contract id.
    CREATE TABLE IF NOT EXISTS task_contracts (
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      contract_id TEXT NOT NULL,
      relation    TEXT NOT NULL,           -- 'produces' | 'consumes'
      PRIMARY KEY (task_id, contract_id, relation)
    );

    -- The dependency DAG (§16).
    CREATE TABLE IF NOT EXISTS edges (
      from_id     TEXT NOT NULL REFERENCES tasks(id),
      to_id       TEXT NOT NULL REFERENCES tasks(id),
      kind        TEXT NOT NULL,           -- 'depends-on' | 'consumes-contract'
      PRIMARY KEY (from_id, to_id, kind)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      path        TEXT NOT NULL,
      produced_by TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      meta_json   TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS status_events (
      task_id     TEXT NOT NULL REFERENCES tasks(id),
      from_status TEXT,
      to_status   TEXT NOT NULL,
      at          TEXT NOT NULL,
      note        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_task_contracts_contract ON task_contracts(contract_id);
    CREATE INDEX IF NOT EXISTS idx_status_events_task ON status_events(task_id);
  `);
}
