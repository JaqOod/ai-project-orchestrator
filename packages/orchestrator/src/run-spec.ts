/**
 * Generic entry point: build ANY product from a plain-text spec file.
 *
 *   node dist/run-spec.js <spec.md> [--name <workspace-name>] [--type web|node] [--rounds N]
 *
 * - type node (default): a Node/CLI/library product; verified by a worker that
 *   builds and actually runs it against the spec.
 * - type web: a browser product on canvas#game; verified by the Director via
 *   headless-Chrome screenshots.
 *
 * The finished product lands in workspaces/<name>/ (its own git repo).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { runWorker } from '@orchestrator/workers';
import { Orchestrator } from './orchestrator.js';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const specPath = argv.find((a) => !a.startsWith('--'));
if (!specPath || !existsSync(specPath)) {
  console.error('usage: run-spec <spec-file> [--name <name>] [--type web|node] [--rounds N]');
  process.exit(1);
}
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};
const SPEC = readFileSync(specPath, 'utf8');
const NAME = flag('name', basename(specPath).replace(/\.[^.]+$/, ''));
const TYPE = flag('type', 'node') as 'web' | 'node';
const ROUNDS = Number(flag('rounds', '2'));

const ROOT = resolve(import.meta.dirname, '../../..');
const WS = join(ROOT, 'workspaces', NAME);

// ---- conventions per product type -----------------------------------------
const SHARED = `- TypeScript, strict. All source files live in src/; the entry point MUST be src/main.ts.
- Every relative import MUST include the .ts extension (e.g. import { x } from './contracts.ts').
- Shared types live only in the frozen contract file(s); modules communicate only through contract types.
- No external dependencies — must compile with tsc alone. Keep each file under ~120 lines.`;

const CONVENTIONS =
  TYPE === 'web'
    ? `${SHARED}\n- Browser-only (vanilla DOM, no Node APIs). The page provides <canvas id="game" width="400" height="400"> and an empty <div id="ui"></div>; src/main.ts boots the app against them.`
    : `${SHARED}\n- Node 22+ ESM; only node:* built-in modules. The product runs as "node dist/main.js [args]".`;

// ---- fixtures --------------------------------------------------------------
function writeFixtures() {
  rmSync(WS, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  mkdirSync(join(WS, 'src'), { recursive: true });
  const tsconfig = (extra: object) =>
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: TYPE === 'web' ? 'ESNext' : 'NodeNext',
          moduleResolution: TYPE === 'web' ? 'Bundler' : 'NodeNext',
          strict: true,
          lib: TYPE === 'web' ? ['ES2022', 'DOM'] : ['ES2023'],
          ...extra,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    );
  writeFileSync(join(WS, 'tsconfig.json'), tsconfig({ noEmit: true, allowImportingTsExtensions: true }));
  writeFileSync(join(WS, 'tsconfig.build.json'), tsconfig({ outDir: 'dist', rewriteRelativeImportExtensions: true }));
  if (TYPE === 'web') {
    writeFileSync(
      join(WS, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><title>${NAME}</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#222;color:#eee;font-family:system-ui}canvas{border:2px solid #555}</style></head>
<body><div id="ui"></div><canvas id="game" width="400" height="400"></canvas>
<script type="module" src="dist/main.js"></script></body></html>`,
    );
  }
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
function buildDist(): void {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: WS, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---- verify workers --------------------------------------------------------
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['acceptable', 'verdict', 'defects'],
  properties: {
    acceptable: { type: 'boolean' },
    verdict: { type: 'string' },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'fixSpec'],
        properties: {
          id: { type: 'string', description: 'kebab-case fix task id' },
          fixSpec: { type: 'string', description: 'complete standalone fix instructions naming the file(s)' },
        },
      },
    },
  },
} as const;
interface Verdict {
  acceptable: boolean;
  verdict: string;
  defects: { id: string; fixSpec: string }[];
}

async function verifyNode(): Promise<Verdict> {
  const res = await runWorker<Verdict>({
    role: 'verifier',
    model: 'sonnet',
    cwd: WS,
    allowWrites: true, // needs bash to actually run the product
    maxTurns: 20,
    schema: VERDICT_SCHEMA,
    systemPrompt:
      'You are a VERIFIER. You never fix code — you exercise the built product like a real user and judge it against its spec. Modify nothing; only run commands and read files.',
    prompt: `The product spec:\n${SPEC}\n\nThe product is already built to dist/ (entry: node dist/main.js). Exercise its behaviours from the spec — normal flows AND error cases — by running it. Then report: acceptable (true only if it meets the spec), a short verdict, and up to 3 defects with complete self-contained fixSpecs naming exact files in src/.`,
  });
  if (!res.ok || !res.output) throw new Error(`verifier failed: ${res.error}`);
  return res.output;
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
function chromePath(): string {
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  ].find(existsSync);
  if (!c) throw new Error('Chrome not found');
  return c;
}
async function verifyWeb(): Promise<Verdict> {
  const server = createServer(async (req, res) => {
    try {
      const p = join(WS, req.url === '/' ? 'index.html' : req.url!.slice(1));
      const body = await readFile(p); // read BEFORE writing headers
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  }).listen(4173);
  try {
    mkdirSync(join(WS, 'shots'), { recursive: true });
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 520, height: 560 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: join(WS, 'shots', 'start.png') as `${string}.png` });
    for (const key of ['ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'Space', 'Enter'] as const) {
      await page.keyboard.press(key);
      await new Promise((r) => setTimeout(r, 400));
    }
    await page.screenshot({ path: join(WS, 'shots', 'later.png') as `${string}.png` });
    await browser.close();
    writeFileSync(join(WS, 'shots', 'console-errors.txt'), errors.join('\n'));
  } finally {
    server.close();
  }
  const res = await runWorker<Verdict>({
    role: 'director',
    model: 'sonnet',
    cwd: WS,
    allowWrites: false,
    maxTurns: 12,
    schema: VERDICT_SCHEMA,
    systemPrompt:
      'You are the DIRECTOR: you know the general intent and judge only observable behaviour. You never write code — you diagnose and hand out precise fix tasks.',
    prompt: `The product spec:\n${SPEC}\n\nEvidence: Read shots/start.png (at load) and shots/later.png (~3s later, after arrow keys / space / enter presses). Read shots/console-errors.txt — any runtime error is a defect. You may read src/*.ts to pinpoint causes. Report: acceptable, short verdict, up to 3 defects with complete fixSpecs naming exact files.`,
  });
  if (!res.ok || !res.output) throw new Error(`director failed: ${res.error}`);
  return res.output;
}

// ---- main ------------------------------------------------------------------
async function main() {
  console.log(bold(`\n══ Orchestrate: ${NAME} (${TYPE}) ══\n`));
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

  for (let round = 1; round <= ROUNDS; round++) {
    buildDist();
    console.log(bold(`\n◇ VERIFY round ${round} (${TYPE})`));
    const v = await (TYPE === 'web' ? verifyWeb() : verifyNode());
    console.log(`   ${v.acceptable ? green('acceptable') : red('not acceptable')} — ${v.verdict.slice(0, 200)}`);
    if (v.acceptable && v.defects.length === 0) break;
    if (round === ROUNDS || v.defects.length === 0) {
      if (!v.acceptable) orch.designIssues.push(`still not acceptable after ${round} rounds: ${v.verdict}`);
      break;
    }
    for (const d of v.defects) {
      console.log(`   ⟳ re-queue ${d.id}`);
      orch.addFixTask(`${d.id}-r${round}`, d.fixSpec, []);
    }
    result = await orch.pump();
  }

  buildDist();
  orch.printStats();
  console.log(bold(green(`\n══ ${NAME.toUpperCase()} COMPLETE ══`)));
  console.log(`Product: workspaces/${NAME}/` + (TYPE === 'web' ? ' (serve it: npx serve .)' : ' (run: node dist/main.js)'));
  for (const i of result.issues) console.log(red(` - design issue: ${i.split('\n')[0]}`));
}

main().catch((e) => {
  console.error(red(`run failed: ${e.message}`));
  process.exit(1);
});
