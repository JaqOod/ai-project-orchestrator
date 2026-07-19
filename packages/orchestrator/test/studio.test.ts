import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectModel } from '@orchestrator/core';
import { loadStudioState, saveStudioState, modelPath } from '../src/studio-state.js';
import { PRODUCT_TYPES } from '../src/product-types.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'studio-'));

describe('Project Model persistence', () => {
  it('round-trips tasks and contracts across re-open', () => {
    const dbPath = join(tmp(), 'model.db');
    const m1 = ProjectModel.open(dbPath);
    m1.addTask({ id: 'root', title: 'root', spec: 'the spec', status: 'done' });
    m1.addTask({ id: 'child', title: 'c', parentId: 'root', atomic: true });
    m1.proposeContract({ id: 'game.IState', stubPath: 'src/contracts.ts' });
    m1.freezeContract('game.IState', 1);

    const m2 = ProjectModel.open(dbPath);
    expect(m2.getTask('root')?.status).toBe('done');
    expect(m2.allTasks().map((t) => t.id).sort()).toEqual(['child', 'root']);
    expect(m2.currentContract('game.IState')?.status).toBe('frozen');
  });

  it('re-open does not duplicate root (INSERT would throw on PK)', () => {
    const dbPath = join(tmp(), 'model.db');
    const m1 = ProjectModel.open(dbPath);
    m1.addTask({ id: 'root', title: 'root' });
    const m2 = ProjectModel.open(dbPath);
    // the orchestrator's guard: only seed when absent
    if (!m2.getTask('root')) m2.addTask({ id: 'root', title: 'root' });
    expect(m2.allTasks()).toHaveLength(1);
  });
});

describe('studio state', () => {
  it('save/load round-trip + model path layout', () => {
    const ws = tmp();
    expect(loadStudioState(ws)).toBeNull();
    saveStudioState(ws, {
      name: 'breakout',
      type: 'web',
      specPath: 'SPEC.md',
      createdAt: 't0',
      rounds: [{ at: 't1', kind: 'build', verdict: 'ok', acceptable: true }],
    });
    const s = loadStudioState(ws)!;
    expect(s.name).toBe('breakout');
    expect(s.rounds).toHaveLength(1);
    expect(modelPath(ws)).toBe(join(ws, '.orchestrator', 'model.db'));
    // model.db is git-ignored inside the state dir
    expect(readFileSync(join(ws, '.orchestrator', '.gitignore'), 'utf8')).toContain('model.db');
  });
});

describe('product-type fixtures are non-destructive', () => {
  it('web fixtures never overwrite existing files', () => {
    const ws = tmp();
    writeFileSync(join(ws, 'index.html'), 'MINE');
    PRODUCT_TYPES.web.writeFixtures(ws, 'game');
    expect(readFileSync(join(ws, 'index.html'), 'utf8')).toBe('MINE');
    expect(existsSync(join(ws, 'tsconfig.json'))).toBe(true);
    // second call is a no-op on existing scaffold
    const before = readFileSync(join(ws, 'tsconfig.json'), 'utf8');
    PRODUCT_TYPES.web.writeFixtures(ws, 'other');
    expect(readFileSync(join(ws, 'tsconfig.json'), 'utf8')).toBe(before);
  });

  it('rust fixtures scaffold Cargo.toml + main.rs once', () => {
    const ws = tmp();
    PRODUCT_TYPES.rust.writeFixtures(ws, 'my game');
    const cargo = readFileSync(join(ws, 'Cargo.toml'), 'utf8');
    expect(cargo).toContain('crossterm');
    expect(cargo).toContain('name = "my-game"');
    writeFileSync(join(ws, 'src', 'main.rs'), 'REAL');
    PRODUCT_TYPES.rust.writeFixtures(ws, 'my game');
    expect(readFileSync(join(ws, 'src', 'main.rs'), 'utf8')).toBe('REAL');
  });
});
