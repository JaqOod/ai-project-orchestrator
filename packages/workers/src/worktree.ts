import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Per-worker git worktree isolation: each executor works on its own branch/copy. */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Initialise a product workspace repo if needed. */
export function ensureWorkspaceRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.name', 'orchestrator');
    git(dir, 'config', 'user.email', 'orchestrator@local');
    git(dir, 'commit', '--allow-empty', '-q', '-m', 'workspace init');
  }
}

/** Create a fresh worktree + branch for one worker. Returns its path. */
export function createWorktree(repoDir: string, name: string): string {
  const path = join(repoDir, '.worktrees', name);
  try {
    git(repoDir, 'worktree', 'remove', '--force', path);
  } catch {
    rmSync(path, { recursive: true, force: true });
    try {
      git(repoDir, 'worktree', 'prune');
    } catch {
      /* fine */
    }
  }
  try {
    git(repoDir, 'branch', '-q', '-D', `wt/${name}`);
  } catch {
    /* didn't exist */
  }
  git(repoDir, 'worktree', 'add', '-q', '-b', `wt/${name}`, path);
  return path;
}

/** Merge a worker's branch back into the workspace main branch. */
export function mergeWorktree(repoDir: string, name: string): void {
  const path = join(repoDir, '.worktrees', name);
  git(path, 'add', '-A');
  try {
    git(path, 'commit', '-q', '-m', `worker ${name} output`);
  } catch {
    /* nothing to commit */
  }
  git(repoDir, 'merge', '-q', '--no-ff', '-m', `integrate ${name}`, `wt/${name}`);
}

export function removeWorktree(repoDir: string, name: string): void {
  const path = join(repoDir, '.worktrees', name);
  try {
    git(repoDir, 'worktree', 'remove', '--force', path);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}
