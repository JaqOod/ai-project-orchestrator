import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the real claude executable (spawning the .exe directly avoids cmd quoting bugs). */
function claudeBin(): { cmd: string; shell: boolean } {
  const exe = join(
    process.env.APPDATA ?? '',
    'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  );
  if (process.platform === 'win32' && existsSync(exe)) return { cmd: exe, shell: false };
  return { cmd: 'claude', shell: process.platform === 'win32' };
}

/**
 * Worker runner: each worker is a fresh, short-lived `claude -p` process
 * (disposable intelligence). Runs on the user's Claude subscription — no API
 * key. Returns the schema-validated structured output.
 */

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export interface WorkerSpec {
  /** role name, for logging */
  role: string;
  prompt: string;
  systemPrompt?: string;
  /** JSON Schema the worker's answer must conform to */
  schema: object;
  model: ModelTier;
  /** working directory (a git worktree for executors) */
  cwd: string;
  maxTurns?: number;
  /** allow file edits / bash inside cwd (executors). Planners get no write tools. */
  allowWrites?: boolean;
}

export interface WorkerResult<T = unknown> {
  ok: boolean;
  output: T | null;
  durationMs: number;
  numTurns: number;
  raw?: string;
  error?: string;
}

export async function runWorker<T = unknown>(spec: WorkerSpec): Promise<WorkerResult<T>> {
  const args = [
    '-p',
    spec.prompt,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(spec.schema),
    '--model',
    spec.model,
    '--max-turns',
    String(spec.maxTurns ?? 30),
  ];
  if (spec.systemPrompt) args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.allowWrites) {
    // unattended but sandboxed: the worker can only touch its own cwd/worktree
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--allowedTools', 'Read,Glob,Grep');
  }

  const started = Date.now();
  const stdout = await new Promise<string>((resolve, reject) => {
    const bin = claudeBin();
    const child = spawn(bin.cmd, args, { cwd: spec.cwd, shell: bin.shell });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 || out.length > 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err}`)),
    );
  }).catch((e: Error) => e);

  const durationMs = Date.now() - started;
  if (stdout instanceof Error) {
    return { ok: false, output: null, durationMs, numTurns: 0, error: stdout.message };
  }

  try {
    const parsed = JSON.parse(stdout.trim().split('\n').pop()!) as {
      is_error: boolean;
      num_turns: number;
      structured_output?: T;
      result?: string;
    };
    const output = parsed.structured_output ?? null;
    return {
      ok: !parsed.is_error && output !== null,
      output,
      durationMs,
      numTurns: parsed.num_turns,
      raw: parsed.result,
      error: parsed.is_error ? parsed.result : undefined,
    };
  } catch {
    return { ok: false, output: null, durationMs, numTurns: 0, error: `unparseable output: ${stdout.slice(0, 500)}` };
  }
}
