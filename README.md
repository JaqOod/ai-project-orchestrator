# AI Project Orchestrator

An AI software-engineering platform that behaves like a software company, not a single
assistant: it recursively decomposes a large idea into thousands of tiny tasks, **freezes the
interface contracts between them**, and builds each atomic task with a fresh, minimally-scoped
worker — then integrates the results.

- **Why / what** — `AI-Project-Orchestrator-Design-Foundations.md` (the constitution)
- **How / roadmap** — `BUILD-PLAN.md` (the plan, with locked decisions)

## Status: Phases 0–3 built

- **Phase 0 ✅** — Project Model + DAG scheduler (7 unit tests)
- **Phase 1 ✅** — the seam proof: planner froze a contract, two blind executors' code fit (`pnpm --filter @orchestrator/workers seam-proof`)
- **Phase 2 ✅** — orchestrator: recursive planning, executor pool, serialized merges + compile gate, retry-with-feedback, DesignIssues
- **Phase 3 ✅** — Snake built end-to-end; Director caught a real rendering bug from screenshots and its fix merged green (`pnpm --filter @orchestrator/orchestrator snake`)
- **Phase 4 ✅** — dependency-aware planning (planner emits inter-child `dependsOn` edges) + per-worker run stats
- **Phase 5 ✅** — generality proof: a non-game todo CLI built through the *identical* engine, all 6 functional smoke checks passing first try (`pnpm --filter @orchestrator/orchestrator cli`)

The spine: the **Project Model** (permanent knowledge) and the **DAG scheduler**
that enforces the one rule everything depends on —

> A task is READY only when every dependency is `done` **and** every interface contract it
> consumes is `frozen`.

Contracts are versioned and immutable; publishing a new version re-queues exactly the blast
radius (its consumers + their downstream) and nothing else.

### Layout

```
packages/core/           @orchestrator/core — provider-agnostic engine
  src/types.ts           Project Model domain types (§3 of the plan)
  src/db.ts              SQLite schema (built-in node:sqlite — no native build)
  src/project-model.ts   the permanent store: tasks, contracts, edges, artifacts
  src/scheduler.ts       the DAG scheduler + freeze/staleness/versioning
  test/dag.test.ts       Phase 0 exit test (the §4 combat seam, 7 cases)
  demo/run.mjs           runnable, colourised walkthrough of the scheduler
packages/workers/        @orchestrator/workers — the swappable worker layer
  src/runner.ts          claude -p headless worker (structured output, no API key)
  src/worktree.ts        per-worker git worktree isolation + merge
  src/seam-proof.ts      Phase 1 exit test (planner freezes, 2 blind executors fit)
packages/orchestrator/   @orchestrator/orchestrator — the conductor
  src/orchestrator.ts    recursive plan/execute pump, gates, retries, DesignIssues
  src/run-snake.ts       Phase 3: Snake + Director screenshot-verify loop
workspaces/              product repos the system builds INTO (generated)
```

## Prerequisites

- Node **>= 22.5** (uses the built-in `node:sqlite`; developed on Node 24)
- pnpm (`npm install -g pnpm`)

## Run it

```bash
pnpm install
pnpm test        # Phase 0 exit test (7 passing)
pnpm typecheck   # strict TypeScript, clean
pnpm demo        # watch the scheduler drive the combat-seam DAG

# AI runs (need a logged-in Claude Code subscription; no API key):
pnpm --filter @orchestrator/workers seam-proof     # Phase 1 exit test
pnpm --filter @orchestrator/orchestrator snake     # Phase 3: build Snake end-to-end
```

The Snake run: a Sonnet planner splits the spec and freezes the contract file; Haiku
executors implement each module in parallel git worktrees; every merge must pass the tsc
gate (failures retry once with the error fed back, then become DesignIssues); then the
**Director** serves the game, screenshots it in headless Chrome, judges the screenshots,
and re-queues fix tasks for up to two rounds. The finished game lands in `workspaces/snake`.
