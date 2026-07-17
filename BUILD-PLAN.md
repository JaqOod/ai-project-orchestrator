# AI Project Orchestrator — Build Plan

**Version:** 1.0
**Status:** Implementation plan. Read `AI-Project-Orchestrator-Design-Foundations.md` first — this document says *how* we build what that document describes.
**Locked decisions (from planning session):**
- **Stack:** TypeScript / Node (v24 present; pnpm via corepack).
- **Worker backend:** the **Claude Code CLI in headless mode** (`claude -p --output-format json --json-schema ... --model ...`), using the user's existing Claude subscription — **no Anthropic API key required.** Each worker is a fresh short-lived `claude -p` process that does one job and exits.
- **Strategy:** Reuse the Claude Code CLI's built-in machinery (subagents, tool allowlisting, structured output, git worktrees) to prove the core loop, then extract a standalone engine.
- **First target:** a tiny browser (HTML5/JS) **Snake** game — runnable, screenshottable, Director-verifiable.

**Locked setup decisions (planning session, round 2):**
- **Package manager:** pnpm monorepo (enabled via `corepack enable pnpm`).
- **Concurrency:** configurable, **default 2–3** parallel workers (stay under subscription usage limits; dial up later).
- **Model routing:** tiered — Haiku for executors + trivial reviews; Opus/Sonnet for Architect, Planner, hard reviews, Director.
- **Worker permissions:** `--dangerously-skip-permissions` **scoped to the worker's git worktree** via `--add-dir` + a tool allowlist (unattended but sandboxed).
- **Observability:** rich structured **terminal logs** first; React dashboard deferred to Phase 5.
- **Version control:** `git init` the whole project; product workspaces use git worktrees for per-worker isolation.

---

## 0. The one thing this plan optimises for

The design doc is explicit (§4, §26): **the system does not fail at coding, it fails at the seams and at scheduling.** So this plan is deliberately shaped to *hit the seams as early and as cheaply as possible.* We do not build the factory first. We build the smallest loop that can produce a mis-fitting seam, watch it break, and fix the mechanism — then scale.

Every phase below has a single question it is designed to answer. If a phase doesn't answer its question, we stop and fix the mechanism before adding scale.

---

## 1. Resolving the 8 open questions (§27) — concrete decisions

These are the load-bearing choices. Everything else follows from them.

| # | Question | Decision for the prototype | Path to scale |
|---|----------|---------------------------|---------------|
| 1 | **Interface representation** | A **hybrid artifact**: a machine-checkable part (a real TypeScript `.d.ts` / interface stub file the executor must implement against) **plus** a structured JSON contract (events, data shapes, file/naming conventions) **plus** a short natural-language rationale. The stub is the enforceable core; JSON is what the scheduler and reviewers read; NL is for the model. | Same shape; add per-language stub generators (C#/Unity, Python) behind one `ContractStub` interface. |
| 2 | **Contract enforcement** | **Three gates, cheapest first:** (a) executor's output must *compile against the frozen stub* (type check), (b) auto-generated **contract tests** derived from the JSON contract run green, (c) a **Contract-Conformance Reviewer** agent whose *only* job is "does this honour the contract," nothing about style. A leaf isn't "done" until all three pass. | Add static analysis + property tests for critical contracts. |
| 3 | **Re-planning & change** | Contracts are **versioned & immutable**; you never edit v1, you publish v2. Publishing v2 marks every task that consumed v1 as `stale`, which re-queues it. A `ContractAmendment` artifact records why. Blast radius is computed from the dependency graph. | Add partial invalidation (only re-run children whose consumed fields actually changed). |
| 4 | **Decomposition control** | A **scored atomic-check** (not vibes). The planner emits, for each candidate leaf, estimates against the §9 criteria (file count, single-call feasibility, has-checkable-test, deps-frozen, cheap-to-review). A leaf is atomic iff all pass a threshold. Hard guards: **max depth**, **min task size** (don't split below a floor), and a "**split budget**" per parent to stop infinite recursion. | Learn thresholds from real completion/retry data. |
| 5 | **Dependency scheduler** | **Build a minimal custom DAG scheduler** (a few hundred lines): nodes have status, edges are `depends-on` + `consumes-contract`. Ready = all deps `done` and all consumed contracts `frozen`. Do **not** adopt Bazel/Temporal yet — too heavy for a prototype and would hide the seam problem. | Consider Temporal / a durable workflow engine when we need crash-recovery and thousands of concurrent workers. |
| 6 | **Model routing** | A single `modelRouter(role, riskTier)` table. Cheap/fast model for atomic execution; strong model for Architect, Planner (interface freezing), and hard Reviews. Configurable per role, not hardcoded at call sites. | Add cost/latency feedback loop and per-task escalation on retry. |
| 7 | **Persistence** | **SQLite (via better-sqlite3) for the structured Project Model** (tasks, contracts, artifacts index, DAG edges, status/history) **+ files on disk** for artifact *bodies* (code, stubs, reports) **+ git** for the actual product workspace. No vector DB yet. | Add Postgres + a vector index for knowledge retrieval when the Project Model gets large. |
| 8 | **Build vs reuse** | **Reuse** the Claude Code CLI (`claude -p`): headless structured output (`--json-schema`), per-worker model (`--model`), tool allowlisting (`--allowedTools`), and directory scoping (`--add-dir`) into a git worktree — all on the user's subscription, no API key. **Build** the Project Model, the DAG scheduler, the contract system, and the context-package builder — these are the actual IP and don't exist off the shelf. | Re-scan the landscape (§22) before Phase 4; swap the worker layer (CLI → SDK/API) if something better appears. The `core` ↔ `workers` boundary keeps that a swap, not a rewrite. |

---

## 2. Architecture at a glance

```
┌────────────────────────────────────────────────────────────────┐
│                        ORCHESTRATOR (the conductor)              │
│                                                                  │
│  ┌────────────┐   ┌──────────────┐   ┌────────────────────────┐ │
│  │ Scheduler  │──▶│ Context-Pkg  │──▶│  Worker Runner         │ │
│  │  (DAG)     │   │  Builder     │   │  (Agent SDK: subagent  │ │
│  │            │◀──│              │◀──│   + git worktree)      │ │
│  └─────┬──────┘   └──────┬───────┘   └───────────┬────────────┘ │
│        │                 │                       │              │
│        ▼                 ▼                       ▼              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     PROJECT MODEL                          │  │
│  │  SQLite: tasks · contracts · edges · status · history      │  │
│  │  Disk:   artifact bodies (code, stubs, reports, assets)    │  │
│  │  Git:    the product workspace being built                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│        ▲                                                         │
│        │ artifacts only (no shared conversation)                │
│  ┌─────┴──────────────────────────────────────────────────┐    │
│  │ WORKERS (disposable, single-purpose, spawned & killed): │    │
│  │ Architect · Planner · Executor · Reviewer · Integration │    │
│  │ · Tester · Visual-QA · Director                          │    │
│  └──────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
                              ▲
                              │ vision, priorities, approvals, Design-Issue answers
                         ┌────┴─────┐
                         │  HUMAN   │  (creative director / executive)
                         └──────────┘
```

**Invariant that must never be violated:** workers talk to nothing but the Project Model, and only via artifacts. No worker holds another worker's conversation. If we ever pass one agent's chat into another, we've reintroduced the context problem (§7, §20) and the plan has failed.

---

## 3. Data model (the Project Model schema)

This is the spine. Build it first, in Phase 0, because every other component reads/writes it.

```ts
// ---- Tasks: the recursive tree + the DAG live in one table ----
type TaskStatus =
  | 'draft' | 'planning' | 'atomic' | 'ready'
  | 'in_progress' | 'in_review' | 'done'
  | 'stale' | 'blocked' | 'failed';

interface Task {
  id: string;                 // stable, e.g. "combat.weapons.melee.sword.swing"
  parentId: string | null;    // the tree edge
  title: string;
  spec: string;               // what this node must achieve (NL)
  status: TaskStatus;
  depth: number;
  atomic: boolean;
  atomicScore?: AtomicScore;  // the §9 scored check (see below)
  producesContractIds: string[];  // contracts this task FREEZES (planner output)
  consumesContractIds: string[];  // contracts this task must HONOUR (executor input)
  riskTier: 'trivial' | 'normal' | 'critical';
  referenceDocIds: string[];  // which universal docs apply (§6)
  createdBy: string;          // worker run id
  history: StatusEvent[];
}

// ---- Interface contracts: first-class, versioned, immutable (§4, §27.1/3) ----
interface Contract {
  id: string;                 // "combat.IDamageable"
  version: number;            // immutable per version; v2 supersedes v1
  supersedes?: string;        // prior contract id@version
  status: 'proposed' | 'frozen' | 'superseded';
  stubPath: string;           // path to the .d.ts / interface file executors implement against
  shape: ContractShape;       // structured: functions, events, data types, naming/file rules
  rationale: string;          // short NL "why it's shaped this way"
  authoredBy: string;         // planner run id
}

interface ContractShape {
  functions: { name: string; signature: string }[];
  events:    { name: string; payloadType: string }[];
  dataTypes: { name: string; fields: { name: string; type: string }[] }[];
  conventions: { naming?: string; files?: string; other?: string[] };
}

// ---- Dependency edges (the DAG the scheduler walks, §16) ----
interface Edge {
  from: string;               // task id
  to: string;                 // task id that depends on `from`
  kind: 'depends-on' | 'consumes-contract';
}

// ---- Artifacts: the ONLY communication channel (§12) ----
type ArtifactKind =
  | 'ExecutionPlan' | 'Contract' | 'ResearchNote' | 'SourceCode'
  | 'Asset' | 'Test' | 'ValidationReport' | 'ReviewReport'
  | 'CapabilityRequest' | 'DesignIssue';

interface Artifact {
  id: string;
  kind: ArtifactKind;
  taskId: string;
  path: string;               // body on disk
  producedBy: string;         // worker run id
  createdAt: string;
  meta: Record<string, unknown>;
}

// ---- The scored atomic check (§27.4) ----
interface AtomicScore {
  fileCountEstimate: number;      // pass if < ~5
  singleCallFeasible: boolean;
  hasCheckableTest: boolean;
  depsAllFrozen: boolean;
  cheapToReview: boolean;
  verdict: 'atomic' | 'split';
  // hard guards
  depth: number;                  // vs MAX_DEPTH
  splitBudgetRemaining: number;   // per-parent, stops infinite recursion
}
```

Design Issues and Capability Requests are just artifacts with their own `kind` — they never block the whole run (§13, §15). They accumulate and get batched to the human.

---

## 4. The core loop, precisely

This is the heart (§2, §26). Implement it as a small state machine driven by the scheduler.

```
                 ┌─────────────────────────────────────────────┐
                 │  Scheduler picks a READY task from the DAG    │
                 └───────────────────────┬─────────────────────┘
                                         │
                          atomic? ───────┴────────
                         no │                      │ yes
                            ▼                      ▼
                 ┌────────────────────┐   ┌──────────────────────┐
                 │ PLANNER            │   │ CONTEXT-PKG BUILDER   │
                 │ splits into children│  │ (parent + frozen      │
                 │ AND freezes the     │  │  contracts + ref docs │
                 │ contract between    │  │  + deps) — minimal     │
                 │ them (§4).          │  └──────────┬───────────┘
                 │ Children go into DAG│             ▼
                 │ as new tasks + edges│   ┌──────────────────────┐
                 │ + Contract artifacts│   │ EXECUTOR (fresh, in a │
                 └─────────┬──────────┘    │ git worktree) writes   │
                           │               │ one leaf against the   │
                           │ children      │ frozen stub            │
                           │ become new    └──────────┬───────────┘
                           │ ready-checks              ▼
                           │               ┌──────────────────────┐
                           │               │ 3 CONTRACT GATES:      │
                           │               │ compile vs stub →      │
                           │               │ contract tests →       │
                           │               │ conformance reviewer   │
                           │               └──────────┬───────────┘
                           │                   pass │      │ fail
                           │                        ▼      ▼ (retry / DesignIssue)
                           │               ┌──────────────────────┐
                           │               │ INTEGRATION merges the │
                           │               │ worktree, confirms fit │
                           │               └──────────┬───────────┘
                           │                          ▼
                           │               ┌──────────────────────┐
                           └──────────────▶│ mark done; unblock     │
                                           │ dependents in the DAG  │
                                           └──────────┬───────────┘
                                                      ▼
                           (periodically) DIRECTOR/VERIFY runs the built product,
                           screenshots/records it, flags what's wrong, re-queues tasks.
```

Notes that matter:
- **Planners never write product code. Executors never split.** (§8) Enforce this in code — planner runner has no write access to the product workspace; executor runner cannot create child tasks.
- **A contract is `frozen` before any child that consumes it becomes `ready`.** This is the seam guarantee. The scheduler enforces it via the `consumes-contract` edge kind.
- **Retries are first-class.** Failed gates → re-queue with the failure report in the next executor's context, up to N attempts, then escalate to a Design Issue (never silently drop).

---

## 5. Worker specs (what each agent type is, as SDK subagents)

Each is a subagent definition (system prompt + tool allowlist + model tier + output schema). All produce structured output via schema so the orchestrator gets data, not prose.

| Worker | Reads (context pkg) | Writes (artifacts) | Model tier | Key guardrail |
|--------|--------------------|--------------------|-----------|----------------|
| **Architect** | Vision, requirements, top-level ref docs | Top-level task tree + earliest contracts | Strong | Works top-down over the tree, never holds whole project in-context (§7) |
| **Planner** | One node + parent contracts + ref docs | Children tasks + **frozen contract** + edges | Strong | Must emit a contract when it splits, or the split is rejected |
| **Executor** | One leaf + frozen stubs + relevant ref docs only | SourceCode, Test | Cheap/fast | No write outside its worktree; cannot see siblings |
| **Contract-Conformance Reviewer** | Leaf output + the frozen stub | ReviewReport | Cheap | Judges *only* contract fit, nothing else |
| **Quality Reviewer** | Leaf output + CodingStandard.md | ReviewReport | Mid | Risk-gated (§14) — skipped for trivial tasks |
| **Integration** | Worktree diff + target workspace | merge result, ValidationReport | Mid | Resolves conflicts; confirms compile/run |
| **Tester / Regression** | Built product + tests | ValidationReport | Cheap | Runs suite, reports failures as tasks |
| **Visual-QA** | Screenshots/video + ArtStyle.md | ReviewReport | Mid (vision) | Compares render to spec |
| **Director** | *Zoomed-out* intent + screenshots/video | re-queue decisions, priorities | Strong | Deliberately NOT given full detail (§11) |

Universal reference docs (§6) — `ArtStyle.md`, `CodingStandard.md`, `Architecture.md`, `NamingConvention.md`, etc. — are authored by an early Architect pass and stored as artifacts. Every context package auto-includes the docs tagged for that task type.

---

## 6. Repo layout

```
gamemakingtool/
├─ AI-Project-Orchestrator-Design-Foundations.md   (the why)
├─ BUILD-PLAN.md                                    (this file)
├─ packages/
│  ├─ core/                 # engine — provider-agnostic, the real IP
│  │  ├─ project-model/     # SQLite schema + repository (tasks, contracts, edges, artifacts)
│  │  ├─ scheduler/         # the DAG scheduler + ready-set computation
│  │  ├─ contracts/         # contract representation, freezing, versioning, stub gen
│  │  ├─ context/           # per-task-type Context-Package builders
│  │  ├─ atomic/            # the scored atomic-check + guards
│  │  └─ artifacts/         # artifact store (disk bodies + index)
│  ├─ workers/              # worker layer — the swappable part
│  │  ├─ runner/            # Claude Code CLI adapter: spawn `claude -p` in a worktree, collect JSON
│  │  ├─ agents/            # Architect/Planner/Executor/... system prompts + json-schemas
│  │  └─ model-router/      # role+risk → --model flag
│  ├─ orchestrator/         # wires scheduler ↔ context ↔ runner ↔ project-model; the loop
│  └─ dashboard/            # React + Vite: live task tree, DAG, contracts, artifacts, Design Issues
├─ workspaces/              # git product workspaces the system builds INTO (one per project)
└─ examples/
   └─ tiny-game/            # the Phase 3 first target spec
```

The `core` ↔ `workers` boundary is the build-vs-reuse seam (§27.8). If we later drop the Agent SDK for a bespoke runner or a different provider, only `packages/workers` changes.

---

## 7. Phased roadmap

Each phase names the **one question it must answer** and its **exit test**. Do not advance until the exit test passes.

### Phase 0 — Skeleton & Project Model  *(foundation)*
**Question:** can we represent tasks, contracts, edges, and artifacts, and walk the DAG?
- Scaffold the monorepo (pnpm workspaces, TypeScript, vitest).
- Implement the SQLite Project Model + repository from §3.
- Implement the DAG scheduler: `ready-set = tasks whose deps are done AND consumed contracts are frozen`.
- No AI yet — seed a tiny hand-written tree + contracts and prove the scheduler releases tasks in the right order.
- **Exit test:** a scripted 5-task DAG with one contract executes in correct order in a unit test; freezing/staleness/versioning behave correctly.

### Phase 1 — The core loop on one leaf  *(the vertical slice)*
**Question:** can a planner freeze a contract and an executor build one leaf against it, gated?
- Wire the CLI worker runner: spawn `claude -p --output-format json --json-schema … --model … --add-dir <worktree>`, capture structured output.
- Implement Planner (splits + freezes one contract) and Executor (builds one leaf).
- Implement the 3 contract gates (compile-vs-stub → contract tests → conformance reviewer).
- Run on a trivial 1-split / 2-leaf example (e.g. "a module with a producer and a consumer of one interface").
- **Exit test:** planner output includes a frozen stub; two executors independently implement against it; the pieces compile and the contract tests pass **without the executors ever seeing each other's code.** This is the seam proof.

### Phase 2 — Recursion, retries, integration, Design Issues
**Question:** does the loop hold when it recurses several levels and things fail?
- Recursive planning with the scored atomic check + hard guards (depth, min-size, split budget).
- Integration agent merges worktrees; retry logic on gate failure; Design-Issue batching for ambiguity.
- Contract versioning path: publish v2 → mark consumers `stale` → re-queue (§27.3).
- **Exit test:** a 3–4 level tree (~15–30 leaves) builds, integrates, and compiles; a deliberately-wrong contract is amended to v2 and only the correct subset of tasks re-runs.

### Phase 3 — First real target: the tiny browser game  *(where it should break)*
**Question:** where does the idea actually break on a real, runnable artifact?
- Author the `examples/tiny-game` spec (one mechanic — e.g. Snake/Pong/a one-screen platformer).
- Architect pass authors the universal ref docs (`ArtStyle.md`, `CodingStandard.md`, `Architecture.md`, `NamingConvention.md`) from the spec.
- Full run: architect → recursive plan → swarm execute → integrate → verify.
- **Director/Visual-QA pass:** run the game headless (Playwright), screenshot + short video, feed to the Director, which flags wrong things and re-queues them.
- **Exit test:** a playable build exists and runs in a browser; the Director loop catches at least one real defect and successfully re-queues + fixes it. **Write down every place it broke — that list drives Phase 4.**

### Phase 4 — Harden the seams & scale the swarm
**Question:** can we run many workers in parallel reliably and control cost?
- Fix the top failure modes found in Phase 3 (almost certainly seam/contract precision and scheduling edge cases).
- Model router tuning (cheap execution, strong planning/review); parallel worker pool with a concurrency cap.
- Risk-based validation routing (§14): trivial → auto-approve; critical → multi-reviewer + tests + optional human gate.
- Capability discovery (§13): workers emit CapabilityRequests; orchestrator satisfies or asks the human.
- Re-scan the landscape (§22) before committing to any heavier infra.
- **Exit test:** rebuild the Phase-3 game (or a slightly bigger one) with N-way parallelism, measured token cost, and a clean Design-Issue/Capability report — no manual babysitting of individual tasks.

### Phase 5 — Extract the standalone engine & generalise beyond games
**Question:** is the architecture genuinely software-category-agnostic (§1, §23)?
- Solidify the `core` ↔ `workers` boundary; make the worker layer a swappable adapter.
- Prove generality by running the **non-game** target (a small CLI or REST API) through the *same* engine with only new reference docs + context builders — no engine changes.
- Dashboard to full fidelity (live DAG, contract browser, Design-Issue inbox, cost view).
- **Exit test:** the same engine builds a non-game deliverable end-to-end; nothing game-specific leaked into `core`.

---

## 8. The first prototype in detail (Phase 3 target)

- **Target:** a single-mechanic HTML5 canvas game (recommend **Snake** — trivial rules, clear seams: input, game-state/tick, collision, render, score). Pure TS + canvas, no framework, so the build has real interfaces but zero install friction.
- **Why it exposes seams:** input→state→collision→render is a chain of contracts. If any two executors disagree on the state shape or the tick contract, it visibly breaks — exactly the failure we want to surface cheaply.
- **Run & verify:** Playwright loads the built `index.html` headless, drives keypresses, screenshots frames, and records a short clip. The Director/Visual-QA agent judges "is this Snake, and is anything obviously wrong?" and re-queues.
- **Success = the loop, not the game:** the game being playable is nice; the point is proving that *frozen contracts made independent executors fit together* and that *the Director loop closes.*

---

## 9. Cost & model routing (§20)

- **Billing model:** workers run on the user's **Claude subscription via `claude -p`**, not metered API tokens. So the real constraints are **subscription rate/usage limits and wall-clock**, not a per-token bill. This changes the guardrails: we manage *concurrency and request volume*, not dollars-per-token.
- **Default router table:** Executor + trivial reviews → cheap/fast model (`--model` haiku-tier); Architect, Planner (interface freezing), hard/critical reviews, Director → strong model (opus/sonnet-tier).
- **Budget guardrails:** a **concurrency cap** so a runaway recursion can't fan out unbounded and trip usage limits; per-worker `--max-turns` ceilings; retry caps; every worker run records model + duration + turn count so we can see the real multiplier (execution floor × planners × reviewers × retries) and back off before hitting subscription limits.
- **The plan's honesty clause:** we optimise for *parallel speed and reliability-through-small-context*. The levers if we hit usage ceilings are the router table (push more work to the cheap model), the concurrency cap, and the retry policy — all centralised, all tunable without redesign.

---

## 10. Risk register & how the plan de-risks each

| Risk | Where it bites | Mitigation baked into the plan |
|------|---------------|-------------------------------|
| **Seams don't hold** (the core bet) | Phase 1–3 | Contract-first planning + 3 enforcement gates + the Phase-1 seam exit test *before* any scale |
| **Infinite / premature decomposition** | Phase 2 | Scored atomic check + max-depth + min-size + per-parent split budget |
| **Scheduling deadlocks / wrong order** | Phase 0, 2 | Custom DAG with explicit `consumes-contract` edges; unit-tested ready-set logic |
| **Change invalidation storms** | Phase 2 | Versioned immutable contracts + computed blast radius; partial invalidation later |
| **Cost explosion** | Phase 4 | Centralised model router + budget ceilings + per-task token accounting |
| **Context creep** (reintroducing the whole-project-in-context problem) | Everywhere | Hard invariant: workers see only their context package; enforced by the Context-Package builder, not by convention |
| **Over-building infra** | Phase 0–3 | Reuse Agent SDK; build only Project Model + scheduler + contracts; defer Temporal/Postgres/vector DB until proven needed |
| **Game-specificity leaks in** | Phase 5 | `core` has no game concepts; generality proven by running a non-game target through the same engine |

---

## 11. Immediate next steps (start of Phase 0)

1. Scaffold the pnpm + TypeScript monorepo and the `packages/` layout from §6.
2. Implement the Project Model SQLite schema + repository (§3) with unit tests.
3. Implement the DAG scheduler and its ready-set / freeze / staleness logic (§4, §7-Phase0) with the scripted-DAG exit test.
4. Stand up the Agent SDK worker runner as a thin spike (spawn one subagent in a worktree, get structured output back) so Phase 1 can start immediately after.

When Phase 0's exit test is green, we have a spine that everything else clips onto — and we start Phase 1, the seam proof, which is the moment of truth for the whole idea.

---

*End of build plan. Pair this with the design foundations doc; that one is the constitution, this one is the roadmap.*
