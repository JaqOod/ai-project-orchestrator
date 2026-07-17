/**
 * Phase 5 — generality proof: build a NON-GAME product (a todo CLI) through
 * the exact same orchestrator. Only the spec, conventions, and verify gate
 * differ; if this works, nothing game-specific leaked into the engine.
 *
 * Run: pnpm --filter @orchestrator/orchestrator cli
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Orchestrator } from './orchestrator.js';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const ROOT = resolve(import.meta.dirname, '../../..');
const WS = join(ROOT, 'workspaces', 'todo-cli');

const SPEC = `A command-line todo manager run as "node dist/main.js <command> [args]".
Commands:
- add <text...>   : adds a todo (joins remaining args as the text), prints "added #<id>: <text>"
- list            : prints each todo as "#<id> [ ] <text>" or "#<id> [x] <text>" (done), in id order; prints "no todos" if empty
- done <id>       : marks that id done, prints "done #<id>"; prints "not found #<id>" to stderr and exits 1 if missing
Todos persist between invocations in ./todos.json (in the current working directory): an array of {id:number, text:string, done:boolean}. Ids start at 1 and increment. The file may not exist on first run.`;

const CONVENTIONS = `- TypeScript, strict, Node 22+ (ESM). May use node:fs, node:process only.
- All source files live in src/. The entry point MUST be src/main.ts (parses argv and dispatches).
- Every relative import MUST include the .ts extension.
- Shared types live only in the frozen contract file(s); modules communicate only through contract types.
- No external dependencies. Keep each file under ~100 lines.
- Print exactly the formats given in the spec — they are contract-tested verbatim.`;

function writeFixtures() {
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, 'src'), { recursive: true });
  const tsconfig = (extra: object) =>
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          lib: ['ES2023'],
          ...extra,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    );
  writeFileSync(join(WS, 'tsconfig.json'), tsconfig({ noEmit: true, allowImportingTsExtensions: true }));
  writeFileSync(join(WS, 'tsconfig.build.json'), tsconfig({ outDir: 'dist', rewriteRelativeImportExtensions: true }));
}

function tscGate(ws: string): string | null {
  try {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: ws, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

// deterministic functional verify — the non-visual analogue of the Director
function smokeTest(): string | null {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: WS, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  rmSync(join(WS, 'todos.json'), { force: true });
  const run = (args: string[], expectFail = false): string => {
    try {
      return execFileSync('node', ['dist/main.js', ...args], { cwd: WS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (expectFail) return String((e as { stderr?: string }).stderr ?? '');
      throw new Error(`command "${args.join(' ')}" failed: ${(e as { stderr?: string }).stderr}`);
    }
  };
  const checks: [string, () => boolean][] = [
    ['add prints confirmation', () => run(['add', 'buy', 'milk']).includes('added #1: buy milk')],
    ['second add increments id', () => run(['add', 'walk dog']).includes('added #2: walk dog')],
    ['list shows open todos', () => {
      const out = run(['list']);
      return out.includes('#1 [ ] buy milk') && out.includes('#2 [ ] walk dog');
    }],
    ['done marks a todo', () => run(['done', '1']).includes('done #1')],
    ['list shows done state', () => run(['list']).includes('#1 [x] buy milk')],
    ['missing id fails politely', () => run(['done', '99'], true).includes('not found #99')],
  ];
  const failures: string[] = [];
  for (const [name, fn] of checks) {
    try {
      if (!fn()) failures.push(`FAILED: ${name}`);
    } catch (e) {
      failures.push(`ERROR in "${name}": ${(e as Error).message.slice(0, 300)}`);
    }
  }
  return failures.length ? failures.join('\n') : null;
}

async function main() {
  console.log(bold('\n══ Phase 5: generality proof — todo CLI through the same engine ══\n'));
  writeFixtures();

  const orch = new Orchestrator({
    workspace: WS,
    spec: SPEC,
    conventions: CONVENTIONS,
    maxDepth: 2,
    concurrency: 3,
    maxRetries: 1,
    buildGate: tscGate,
  });

  let result = await orch.run();
  console.log(bold(`\nBuild pass: ${result.done} done, ${result.failed} failed`));

  // verify loop: functional smoke test instead of screenshots (same shape as the Director)
  for (let round = 1; round <= 2; round++) {
    console.log(bold(`\n◇ VERIFY round ${round} — running functional smoke test`));
    const failures = smokeTest();
    if (!failures) {
      console.log(green('   ✓ all smoke checks pass'));
      break;
    }
    console.log(red(`   ✗ smoke failures:\n${failures.split('\n').map((l) => '     ' + l).join('\n')}`));
    if (round === 2) {
      console.log(red('   giving up after 2 rounds → DesignIssue'));
      orch.designIssues.push(`smoke test still failing:\n${failures}`);
      break;
    }
    orch.addFixTask(`fix-smoke-r${round}`, `The todo CLI fails its functional test. Original spec:\n${SPEC}\n\nFailing checks:\n${failures}\n\nRead the existing src/*.ts files, find the cause, and fix the responsible file(s).`, []);
    result = await orch.pump();
  }

  orch.printStats();
  console.log(bold(green('\n══ CLI RUN COMPLETE ══')));
  console.log(`Try it: cd workspaces/todo-cli && node dist/main.js add hello && node dist/main.js list`);
  if (result.issues.length) for (const i of result.issues) console.log(` - issue: ${i.split('\n')[0]}`);
}

main().catch((e) => {
  console.error(red(`cli run failed: ${e.message}`));
  process.exit(1);
});
