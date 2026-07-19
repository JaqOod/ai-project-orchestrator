/**
 * Product types: the pluggable backend per kind of product the factory builds.
 * Each type owns its fixtures, conventions, build gate, dist build, verifier,
 * and run hint. writeFixtures is NON-destructive — wiping a workspace is the
 * fresh-build entry point's decision, never the type's.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { runWorker } from '@orchestrator/workers';
import type { StudioProductType } from './studio-state.js';

export const VERDICT_SCHEMA = {
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

export interface Verdict {
  acceptable: boolean;
  verdict: string;
  defects: { id: string; fixSpec: string }[];
}

export interface ProductType {
  readonly id: StudioProductType;
  conventions(): string;
  /** Write missing scaffold files only; never overwrites existing ones. */
  writeFixtures(workspace: string, name: string): void;
  /** null on success or an error report string. */
  buildGate(workspace: string): string | null;
  buildDist(workspace: string): void;
  verify(workspace: string, spec: string): Promise<Verdict>;
  runHint(workspace: string): string;
}

const SHARED_TS = `- TypeScript, strict. All source files live in src/; the entry point MUST be src/main.ts.
- Every relative import MUST include the .ts extension (e.g. import { x } from './contracts.ts').
- Shared types live only in the frozen contract file(s); modules communicate only through contract types.
- No external dependencies — must compile with tsc alone. Keep each file under ~120 lines.`;

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content);
}

function tsFixtures(workspace: string, name: string, web: boolean): void {
  mkdirSync(join(workspace, 'src'), { recursive: true });
  const tsconfig = (extra: object) =>
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: web ? 'ESNext' : 'NodeNext',
          moduleResolution: web ? 'Bundler' : 'NodeNext',
          strict: true,
          lib: web ? ['ES2022', 'DOM'] : ['ES2023'],
          ...extra,
        },
        include: ['src/**/*'],
      },
      null,
      2,
    );
  writeIfMissing(join(workspace, 'tsconfig.json'), tsconfig({ noEmit: true, allowImportingTsExtensions: true }));
  writeIfMissing(join(workspace, 'tsconfig.build.json'), tsconfig({ outDir: 'dist', rewriteRelativeImportExtensions: true }));
  if (web) {
    writeIfMissing(
      join(workspace, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title>
<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#222;color:#eee;font-family:system-ui}canvas{border:2px solid #555}</style></head>
<body><div id="ui"></div><canvas id="game" width="400" height="400"></canvas>
<script type="module" src="dist/main.js"></script></body></html>`,
    );
  }
}

function gate(cwd: string, bin: string, args: string[]): string | null {
  try {
    execFileSync(bin, args, { cwd, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? '') + (err.stderr ?? '');
  }
}

const tscGate = (ws: string) => gate(ws, 'npx', ['tsc', '-p', 'tsconfig.json']);

function buildTsDist(ws: string): void {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: ws, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---- verifiers -------------------------------------------------------------

async function verifyRun(workspace: string, spec: string, entryHint: string): Promise<Verdict> {
  const res = await runWorker<Verdict>({
    role: 'verifier',
    model: 'sonnet',
    cwd: workspace,
    allowWrites: true, // needs bash to actually run the product
    maxTurns: 20,
    schema: VERDICT_SCHEMA,
    systemPrompt:
      'You are a VERIFIER. You never fix code — you exercise the built product like a real user and judge it against its spec. Modify nothing; only run commands and read files.',
    prompt: `The product spec:\n${spec}\n\nThe product is already built (${entryHint}). Exercise its behaviours from the spec — normal flows AND error cases — by running it. Then report: acceptable (true only if it meets the spec), a short verdict, and up to 3 defects with complete self-contained fixSpecs naming exact source files.`,
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

async function verifyWeb(workspace: string, spec: string): Promise<Verdict> {
  const server = createServer(async (req, res) => {
    try {
      const p = join(workspace, req.url === '/' ? 'index.html' : req.url!.slice(1));
      const body = await readFile(p); // read BEFORE writing headers
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }).end(body);
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  }).listen(4173);
  try {
    mkdirSync(join(workspace, 'shots'), { recursive: true });
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 520, height: 560 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 1200));
    await page.screenshot({ path: join(workspace, 'shots', 'start.png') as `${string}.png` });
    for (const key of ['ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'Space', 'Enter'] as const) {
      await page.keyboard.press(key);
      await new Promise((r) => setTimeout(r, 400));
    }
    await page.screenshot({ path: join(workspace, 'shots', 'later.png') as `${string}.png` });
    await browser.close();
    writeFileSync(join(workspace, 'shots', 'console-errors.txt'), errors.join('\n'));
  } finally {
    server.close();
  }
  const res = await runWorker<Verdict>({
    role: 'director',
    model: 'sonnet',
    cwd: workspace,
    allowWrites: false,
    maxTurns: 12,
    schema: VERDICT_SCHEMA,
    systemPrompt:
      'You are the DIRECTOR: you know the general intent and judge only observable behaviour. You never write code — you diagnose and hand out precise fix tasks.',
    prompt: `The product spec:\n${spec}\n\nEvidence: Read shots/start.png (at load) and shots/later.png (~3s later, after arrow keys / space / enter presses). Read shots/console-errors.txt — any runtime error is a defect. You may read src/*.ts to pinpoint causes. Report: acceptable, short verdict, up to 3 defects with complete fixSpecs naming exact files.`,
  });
  if (!res.ok || !res.output) throw new Error(`director failed: ${res.error}`);
  return res.output;
}

// ---- the types -------------------------------------------------------------

const web: ProductType = {
  id: 'web',
  conventions: () =>
    `${SHARED_TS}\n- Browser-only (vanilla DOM, no Node APIs). The page provides <canvas id="game" width="400" height="400"> and an empty <div id="ui"></div>; src/main.ts boots the app against them.`,
  writeFixtures: (ws, name) => tsFixtures(ws, name, true),
  buildGate: tscGate,
  buildDist: buildTsDist,
  verify: verifyWeb,
  runHint: () => 'serve it: npx serve .  (then open the printed URL)',
};

const node: ProductType = {
  id: 'node',
  conventions: () => `${SHARED_TS}\n- Node 22+ ESM; only node:* built-in modules. The product runs as "node dist/main.js [args]".`,
  writeFixtures: (ws, name) => tsFixtures(ws, name, false),
  buildGate: tscGate,
  buildDist: buildTsDist,
  verify: (ws, spec) => verifyRun(ws, spec, 'entry: node dist/main.js'),
  runHint: () => 'run: node dist/main.js',
};

const rust: ProductType = {
  id: 'rust',
  conventions: () => `- Rust 2021 edition, terminal product. Entry point src/main.rs; modules as separate files in src/.
- Shared types/traits live only in the frozen contract file src/contracts.rs; modules communicate only through contract items. Declare every module in src/main.rs (mod contracts; mod foo; ...).
- The ONLY allowed dependency is crossterm 0.28 (already in Cargo.toml). "cargo check" must pass with zero errors. Keep each file under ~120 lines.`,
  writeFixtures: (ws, name) => {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeIfMissing(
      join(ws, 'Cargo.toml'),
      `[package]\nname = "${name.replace(/[^a-z0-9_-]/g, '-')}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ncrossterm = "0.28"\n`,
    );
    writeIfMissing(join(ws, 'src', 'main.rs'), 'fn main() {\n    println!("scaffold");\n}\n');
  },
  buildGate: (ws) => gate(ws, 'cargo', ['check', '--message-format=short']),
  buildDist: (ws) => {
    execFileSync('cargo', ['build'], { cwd: ws, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  },
  verify: (ws, spec) => verifyRun(ws, spec, 'entry: cargo run --  (debug binary in target/debug/)'),
  runHint: () => 'run: cargo run',
};

export const PRODUCT_TYPES: Record<StudioProductType, ProductType> = { web, node, rust };
