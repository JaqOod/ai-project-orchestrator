/**
 * Studio state: the small durable record that lets a workspace be picked up
 * again in a later session (name, product type, spec, round history). Lives at
 * <workspace>/.orchestrator/studio.json next to the persisted Project Model.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type StudioProductType = 'web' | 'node' | 'rust';

export interface StudioRound {
  at: string;
  kind: 'build' | 'amend';
  feedback?: string;
  verdict: string;
  acceptable: boolean;
}

export interface StudioState {
  name: string;
  type: StudioProductType;
  /** workspace-relative path of the living spec, e.g. 'SPEC.md' */
  specPath: string;
  createdAt: string;
  rounds: StudioRound[];
}

export function stateDir(workspace: string): string {
  return join(workspace, '.orchestrator');
}

export function modelPath(workspace: string): string {
  return join(stateDir(workspace), 'model.db');
}

export function loadStudioState(workspace: string): StudioState | null {
  const p = join(stateDir(workspace), 'studio.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as StudioState;
}

export function saveStudioState(workspace: string, state: StudioState): void {
  const dir = stateDir(workspace);
  mkdirSync(dir, { recursive: true });
  // studio.json is committed; the SQLite model (and its WAL churn) is not
  writeFileSync(join(dir, '.gitignore'), 'model.db*\n');
  writeFileSync(join(dir, 'studio.json'), JSON.stringify(state, null, 2));
}
