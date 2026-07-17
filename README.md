# AI Project Orchestrator

An AI software-engineering platform that behaves like a software company, not a single
assistant: it recursively decomposes a large idea into thousands of tiny tasks, **freezes the
interface contracts between them**, and builds each atomic task with a fresh, minimally-scoped
worker — then integrates the results.

- **Why / what** — `AI-Project-Orchestrator-Design-Foundations.md` (the constitution)
- **How / roadmap** — `BUILD-PLAN.md` (the plan, with locked decisions)

## Status: Phase 0 complete ✅

The spine is in place: the **Project Model** (permanent knowledge) and the **DAG scheduler**
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
```

## Prerequisites

- Node **>= 22.5** (uses the built-in `node:sqlite`; developed on Node 24)
- pnpm (`npm install -g pnpm`)

## Run it

```bash
pnpm install
pnpm test        # run the Phase 0 exit test (7 passing)
pnpm typecheck   # strict TypeScript, clean
pnpm demo        # watch the scheduler drive the combat-seam DAG to completion
```

## Next: Phase 1 — the seam proof

Wire the Claude Code CLI worker runner (`claude -p --output-format json --json-schema …`) so a
**planner** freezes one contract and two **executors** independently implement against it in
isolated git worktrees — proving that frozen contracts make independent workers fit together
*without ever seeing each other's code*. See `BUILD-PLAN.md` §7.
