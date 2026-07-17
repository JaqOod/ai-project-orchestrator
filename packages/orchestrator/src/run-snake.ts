/**
 * Phase 3 — build Snake end-to-end through the orchestrator, then run the
 * Director loop: serve the game, screenshot it in real Chrome, let a Director
 * worker judge the screenshots, and re-queue fixes.
 *
 * Run: pnpm --filter @orchestrator/orchestrator snake
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { runWorker } from '@orchestrator/workers';
import { Orchestrator } from './orchestrator.js';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const ROOT = resolve(import.meta.dirname, '../../..');
const WS = join(ROOT, 'workspaces', 'snake');

const SPEC = `A complete, playable Snake game in the browser, rendered on the existing <canvas id="game" width="400" height="400"> element.
Rules: a 20x20 grid of 20px cells. The snake starts length 3 in the centre moving right, advancing one cell every 120ms. Arrow keys change direction (no 180° reversals). One red food cell at a random empty position; eating it grows the snake by 1 and increments the score. Hitting a wall or the snake's own body ends the game, showing "Game Over — score N" and restarting on any key. Score is drawn in the top-left corner. Snake is green, food red, background black.`;

const CONVENTIONS = `- TypeScript, strict, browser-only (no Node APIs, no DOM libraries beyond vanilla).
- All source files live in src/. The entry point MUST be src/main.ts which boots the game against canvas#game.
- Every relative import MUST include the .ts extension (e.g. import { tick } from './engine.ts').
- Shared types live only in the frozen contract file(s); modules communicate only through contract types.
- No external dependencies, no build tools — the code must compile with tsc alone.
- Keep each file under ~120 lines.`;

// fixtures the orchestrator owns (not worker-built): html shell + ts configs
function writeFixtures() {
  rmSync(WS, { recursive: true, force: true });
  mkdirSync(join(WS, 'src'), { recursive: true });
  writeFileSync(
    join(WS, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Snake</title>
<style>body{margin:0;display:grid;place-items:center;height:100vh;background:#222}canvas{border:2px solid #555}</style></head>
<body><canvas id="game" width="400" height="400"></canvas>
<script type="module" src="dist/main.js"></script></body></html>`,
  );
  writeFileSync(
    join(WS, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          lib: ['ES2022', 'DOM'],
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(WS, 'tsconfig.build.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          strict: true,
          outDir: 'dist',
          rewriteRelativeImportExtensions: true,
          lib: ['ES2022', 'DOM'],
        },
        include: ['src/**/*'],
      },
      null,
      2,
    ),
  );
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
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: WS, shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ---- tiny static server ----------------------------------------------------
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
function serve(dir: string, port: number) {
  const server = createServer(async (req, res) => {
    const path = join(dir, req.url === '/' ? 'index.html' : req.url!.slice(1));
    try {
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  server.listen(port);
  return server;
}

// ---- screenshots via the user's installed Chrome (headless) ---------------
function chromePath(): string {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  ];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Chrome not found for Director screenshots');
  return found;
}

async function screenshots(port: number): Promise<string[]> {
  mkdirSync(join(WS, 'shots'), { recursive: true });
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 500, height: 500 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1000));
  const s1 = join(WS, 'shots', 'start.png');
  await page.screenshot({ path: s1 as `${string}.png` });
  for (const key of ['ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowRight'] as const) {
    await page.keyboard.press(key);
    await new Promise((r) => setTimeout(r, 500));
  }
  const s2 = join(WS, 'shots', 'playing.png');
  await page.screenshot({ path: s2 as `${string}.png` });
  await browser.close();
  if (errors.length) writeFileSync(join(WS, 'shots', 'console-errors.txt'), errors.join('\n'));
  return [s1, s2];
}

// ---- Director --------------------------------------------------------------
const DIRECTOR_SCHEMA = {
  type: 'object',
  required: ['playable', 'verdict', 'defects'],
  properties: {
    playable: { type: 'boolean' },
    verdict: { type: 'string' },
    defects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'fixSpec'],
        properties: {
          id: { type: 'string', description: 'kebab-case fix task id, e.g. fix-food-render' },
          fixSpec: { type: 'string', description: 'complete standalone instructions to fix it, naming the file(s)' },
        },
      },
    },
  },
} as const;

interface DirectorOut {
  playable: boolean;
  verdict: string;
  defects: { id: string; fixSpec: string }[];
}

async function directorPass(): Promise<DirectorOut> {
  const res = await runWorker<DirectorOut>({
    role: 'director',
    model: 'sonnet',
    cwd: WS,
    allowWrites: false,
    maxTurns: 12,
    schema: DIRECTOR_SCHEMA,
    systemPrompt:
      'You are the DIRECTOR: you know the general intent of the product but review only its observable behaviour. You never write code — you diagnose and hand out precise fix tasks.',
    prompt: `The product is: ${SPEC}\n\nInspect the evidence: Read shots/start.png and shots/playing.png (screenshots at load and after some arrow-key presses ~3s later). If shots/console-errors.txt exists, read it too — any runtime error is a defect. You may also read src/*.ts to pinpoint causes.\n\nJudge whether this is a working Snake game per the spec. Report defects (max 3, most important first) with complete self-contained fixSpecs naming the exact file(s) to change.`,
  });
  if (!res.ok || !res.output) throw new Error(`director failed: ${res.error}`);
  return res.output;
}

// ---- main ------------------------------------------------------------------
async function main() {
  console.log(bold('\n══ Phase 3: build Snake end-to-end ══\n'));
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
  console.log(bold(`\nBuild pass: ${result.done} done, ${result.failed} failed, ${result.issues.length} design issues`));

  // Director loop: up to 2 rounds of look -> flag -> fix
  for (let round = 1; round <= 2; round++) {
    buildDist();
    const server = serve(WS, 4173);
    console.log(bold(`\n◇ DIRECTOR round ${round} — serving on :4173, capturing screenshots`));
    try {
      await screenshots(4173);
    } finally {
      server.close();
    }
    const verdict = await directorPass();
    console.log(`   ${verdict.playable ? green('playable') : red('not playable')} — ${verdict.verdict.slice(0, 200)}`);
    if (verdict.playable && verdict.defects.length === 0) break;
    if (verdict.defects.length === 0) break;
    for (const d of verdict.defects) {
      console.log(`   ⟳ re-queue ${d.id}`);
      orch.addFixTask(`${d.id}-r${round}`, d.fixSpec, []);
    }
    result = await orch.pump();
  }

  buildDist();
  console.log(bold(green('\n══ SNAKE RUN COMPLETE ══')));
  console.log(`Open workspaces/snake/index.html via a static server, or: npx serve workspaces/snake`);
  if (result.issues.length) {
    console.log(bold('\nDesign issues for the human:'));
    for (const i of result.issues) console.log(` - ${i.split('\n')[0]}`);
  }
}

main().catch((e) => {
  console.error(red(`snake run failed: ${e.message}`));
  process.exit(1);
});
