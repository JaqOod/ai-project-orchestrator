# AI Project Orchestrator — Design Foundations

**Version:** 0.2 (supersedes the v0.1 vision document)
**Status:** Foundational design document — read this before any implementation or design chat.
**Purpose:** This is the single source of truth for the project's intent. It is written to be read *cold* by a fresh AI chat or a new human collaborator with no prior context. It captures WHAT the system should become and WHY, plus the key design decisions and open questions. It does not lock down HOW every component is implemented.

---

## 1. One-paragraph summary

We are building a general-purpose AI software-engineering platform that behaves like an intelligent software company rather than a single smart assistant. It takes a large idea (initially: a fully-described video game) and delivers a finished, coherent piece of software by **recursively decomposing** the work into thousands of tiny, independent tasks, each handed to a fresh, short-lived AI worker with only the minimal context it needs, then **integrating** the results back together. The intelligence is disposable; the knowledge is permanent. Games are the first proving ground, but the architecture must never assume a specific software category — it should equally be able to build desktop apps, web apps, APIs, services, tooling, and documentation.

---

## 2. The core thesis (the thing that must not get lost)

**LLMs don't fail because they can't write code. They fail because they're asked to reason about too much at once.**

Therefore the central mechanic — the *most important* part of the whole system — is **relentless recursive decomposition**:

```
Understand the work
      │
      ▼
Break it into children  ◄─────┐
      │                        │  repeat until each task
      ▼                        │  meets the "atomic" criteria
Is each child atomic? ── no ───┘
      │ yes
      ▼
Execute each atomic task with a fresh, minimally-scoped worker
```

A top-end coding model can polish a *small, well-specified* thing to a very high standard. The bet of this project is that a sufficiently large piece of software is just a very large number of such small things — **provided they are cut apart correctly and stitched back together correctly.** Everything else in this document exists to make that bet pay off.

---

## 3. The two fundamental principles

1. **Persistent Knowledge.** Everything important lives in the *Project Model* — a permanent, central store. If every AI worker vanished this instant, nothing important would be lost.
2. **Disposable Intelligence.** Every worker is temporary. It receives work, performs one responsibility, writes its result back as an artifact, and terminates. Workers are never long-running conversations; a fresh worker is always preferred over a growing one.

> Intelligence is temporary. Knowledge is permanent. Workers are musicians; the orchestrator is the conductor; the Project Model is the score.

---

## 4. THE CRITICAL REFINEMENT — decomposition is about *seams*, not just *splitting*

This is the most important addition to the v0.1 vision, and the thing most "spawn a swarm of agents" designs get wrong. Read it twice.

**The hard part of building big software with agents is not the splitting. It is the seams — the interfaces where the pieces meet.**

The pieces of a program are *not* independent. If you split a game into 100,000 tiny tasks and hand them to 100,000 parallel agents that have never spoken to each other, each agent will invent its *own* version of every shared interface. One agent decides an item's durability is an integer; another wraps it in a struct; a third never models durability at all. Individually, all 100,000 files can be beautiful and well-polished. Together they will not compile, and if they compile they will not fit. The integration cost explodes. **This — not the coding — is the real reason AI struggles to build large software.**

The fix, and the design rule that must run through the whole system:

> **A planner that only splits produces confetti. A planner that splits AND freezes the contract between the children produces software.**

Concretely, when a planner breaks a parent task (e.g. "combat system") into children ("weapons", "damage", "hit detection"), its output is **not** just three sub-tasks. It is three sub-tasks **plus the frozen interface contract they all share** — the exact function signatures, event names, data shapes, and file/naming conventions that pass between them. Only *after* an interface is frozen may its children be built in parallel, because now every child codes *against a fixed contract* instead of inventing one.

This mirrors how real engineering organisations scale: senior engineers argue about interfaces in design review; once those interfaces are frozen, dozens of engineers implement behind them in parallel without needing to talk to each other. **Interface definition is the primary intellectual product of planning.** Task-splitting is the by-product.

---

## 5. The Project Model (permanent memory)

The Project Model is the heart of the system — the permanent memory that everything belongs to. It stores (non-exhaustively):

- Vision, requirements, and design decisions
- User choices, standards, and constraints
- The task tree (features → subsystems → atomic tasks) and their status
- **Interface contracts** between tasks (see §4) — first-class, versioned objects
- Knowledge, assets, code references, and documentation
- Open questions / Design Issues
- Relationships and dependencies between tasks
- Validation and review history
- Capability requirements

Workers never own long-term knowledge. They read from the Project Model (via a context package) and write back to it (via artifacts).

---

## 6. Universal reference documents (shared standards)

To stop every worker reinventing style and conventions, a small set of **immutable-ish reference documents** are authored early and read by every relevant worker. Examples:

`ArtStyle.md` · `CodingStandard.md` · `Architecture.md` · `NamingConvention.md` · `GameplayRules.md` · `PerformanceTargets.md` · `Networking.md`

Every coding prompt begins with an instruction to read the reference documents relevant to its task type. These are how consistency is enforced cheaply across thousands of agents. They can carry variants (e.g. an art style that varies by biome/location) but the *rules* for choosing a variant are fixed and written down.

---

## 7. Context philosophy

Context is expensive and large context reduces both reliability and scalability. Therefore each worker receives **only** what one task requires — never the whole project.

The orchestrator builds a task-specific **Context Package**, which may include: the parent task, the relevant requirements, the frozen interface contracts the task must honour, applicable style/standards docs, prior artifacts it depends on, tool availability, and constraints. Different task types get different context builders (programming context ≠ art context ≠ audio context ≠ writing context ≠ UI context ≠ testing context).

**Note on the "understand the whole game first" step:** the Architect must *not* literally hold the entire project in one context window — that would reintroduce exactly the problem we're escaping. The Architect works **top-down over the tree**, expanding one node at a time, with the Project Model (not the model's context) serving as memory.

---

## 8. Planning vs. execution (reason once, execute many)

Planning and execution are deliberately separated.

- **Planner workers think.** They decompose, and they freeze interfaces. They never write production code.
- **Executor workers do.** They implement a single atomic task against a frozen contract.

Planner output is an *artifact* (an execution plan + interface contracts). Executors follow that artifact. This buys repeatability, auditing, cheap retries, review-against-a-known-plan, and the ability to swap execution models without redesigning the work.

---

## 9. When to stop decomposing (atomic criteria)

Do **not** decompose to a fixed number like "10,000 tasks." Decompose until each task objectively meets atomic criteria for the model doing the work. A task is atomic when it:

- touches only a small number of source files (rule of thumb: < ~5),
- can plausibly be completed in a single model call,
- has a clear, checkable success test,
- has no unresolved dependencies (all upstream contracts are frozen),
- can be reviewed automatically or cheaply.

The planner stops splitting a branch the moment its leaves satisfy these. Different branches will bottom out at different depths — that's expected.

---

## 10. Recursive decomposition, worked example

```
Build combat system
   └─ too large → split (freeze the combat-wide interfaces: IDamageable, OnHit event, DamagePacket shape)
      ├─ weapons
      │    └─ too large → split (freeze IWeapon)
      │       ├─ melee
      │       │    └─ too large → split
      │       │       ├─ sword
      │       │       │    └─ too large → split
      │       │       │       ├─ swing animation  → ATOMIC → "implement animation controller X"
      │       │       │       ├─ collision        → ATOMIC
      │       │       │       └─ durability        → ATOMIC (codes against frozen durability contract)
      │       │       └─ axe ...
      │       └─ ranged ...
      ├─ damage ...
      └─ hit detection ...
```

Planners never touch the leaves' code. Executors only ever see a single leaf plus its frozen contracts and relevant reference docs.

---

## 11. Worker / agent taxonomy

Specialised, single-purpose worker types (a worker does exactly one of these and then dies):

1. **Architect** — understands the project top-down; never codes. Produces the top-level structure and the earliest interface contracts.
2. **Planner** — decomposes one node into children *and freezes the contract between them*; never codes.
3. **Coding Agent (Executor)** — implements exactly one atomic task against frozen contracts; nothing else.
4. **Reviewer** — checks code quality/correctness against the plan and standards.
5. **Integration Agent** — merges work, resolves conflicts, confirms pieces fit the frozen contracts.
6. **Gameplay Tester** — runs the software and hunts for behavioural bugs.
7. **Visual QA** — inspects screenshots/video against the art style and spec.
8. **Performance Agent** — profiles and optimises against `PerformanceTargets.md`.
9. **Regression Agent** — runs the automated test suite.
10. **Director** — watches overall progress, sets priorities, and (importantly) can operate at a *zoomed-out* level: it knows the general intent without holding all detail, reviews screenshots/video, and says "that's wrong, work on this."

The Director role captures the user's real-world observation: an AI on the sidelines that only knows the *general* idea is an excellent technical director for a huge project, precisely because it isn't drowning in detail.

---

## 12. Artifacts (the only communication channel)

Workers communicate **only** through artifacts, never through shared conversation. Artifact types include: Execution Plans, **Interface Contracts**, Research Notes, Source Code, Assets, Tests, Validation Reports, Review Reports, Capability Requests, and Design Issues. Artifacts are permanent; workers are not.

---

## 13. Capability discovery precedes execution

Execution does not begin blindly. Planning includes discovering what a task *needs*: tools, APIs, credentials, assets, software, datasets. If a requirement can't be satisfied, the worker records a **Capability Requirement** artifact and does **not** make infrastructure decisions itself. Workers identify needs; the orchestrator satisfies them (install a tool, request approval, switch environment, or ask the user). Tool availability is *context*; infrastructure management belongs to orchestration.

---

## 14. Risk-based validation

Validation is proportional to risk, not uniform. Trivial tasks may be auto-approved. Critical tasks may require multiple reviewers, automated testing, static analysis, and/or human approval. The orchestrator decides the validation path per task.

---

## 15. Design Issues (never halt the whole project)

A worker that hits ambiguity does **not** stop the project. It records a **Design Issue** artifact and continues wherever possible. Unresolved issues are batched and presented to the human for decisions, rather than blocking on each one.

---

## 16. Dependency management — the second hard problem

After interfaces (§4), the next hardest problem is dependencies. With thousands of tasks, some can't start until others finish, and the whole thing forms a large dependency graph (a DAG). The orchestrator must track this graph, schedule only tasks whose upstream contracts are frozen and whose prerequisites are done, and feed failures back into the queue. This is a real, known-hard-but-solvable scheduling problem (conceptually adjacent to build systems like Bazel/Buck and to project schedulers), now driven by AI workers.

---

## 17. Project strategies (how a project begins)

The user chooses the starting posture:

- **Blueprint Mode** — complete discovery before any implementation.
- **Hybrid Mode (recommended)** — discover the stable architecture, start implementing the stable parts immediately, keep discovering the rest in parallel.
- **Rapid Prototype Mode** — start building immediately with current knowledge; accept future refactoring.

---

## 18. Human role

Humans provide vision, priorities, creative direction, business decisions, approvals, and high-level architecture. The AI performs execution wherever possible. The human is the studio's creative director and executive, not a line worker.

---

## 19. Orchestrator responsibilities

The orchestrator is the conductor. It owns: scheduling, dependency tracking, context-package generation, worker spawning, artifact routing, validation routing, retry logic, Project Model updates, capability management, and user interaction.

---

## 20. Cost & scale realities (be honest about these)

- The naive "one bot reads the whole game" step secretly reintroduces the context problem — avoid it (see §7).
- Execution calls are the floor, not the ceiling. Add planners, reviewers, testers, and **retries** (agents fail and re-run), and a naive design can multiply raw execution cost several times over.
- The architecture's virtue is **parallelism and speed**, and **reliability through small context** — not necessarily low absolute token cost. Design accordingly (e.g. cheaper models for atomic execution, expensive models reserved for architecture, interface design, and hard reviews).

---

## 21. Scalability goal

The architecture should eventually support thousands of workers running simultaneously. This is only possible if: workers stay stateless, context stays minimal, knowledge stays centralised in the Project Model, and all communication happens through artifacts.

---

## 22. Prior art / landscape (as understood, to be verified)

The idea sits in a real and active research direction. It is essentially **Hierarchical Task Networks (HTN)** — a classical AI-planning concept — with an LLM at every node. Existing systems (SWE-agent, OpenHands, Devin/Cognition, Factory, background-agent products, and various "agent swarm" runners) attack *fragments* of this, but they generally think in terms of "solve one issue" rather than "build an entire product," and most under-invest in the interface-freezing step from §4. **This landscape moves monthly and should be re-scanned with live web research before committing to build-vs-reuse decisions.** (Model names the user referenced — e.g. newer Kimi/GPT/Fable variants — are beyond the assistant's knowledge cutoff and were deliberately not assessed; the architecture is intentionally model-agnostic anyway.)

---

## 23. Non-goals

This project is **not** a chatbot, not code autocomplete, not a single massive prompt, not a permanently-running AI conversation, and not a model-specific framework.

---

## 24. Guiding principles (quick reference)

- The Project Model is the source of truth.
- Workers are disposable; knowledge is persistent.
- Context should be minimal and task-specific.
- **Decomposition freezes interfaces, not just splits tasks.**
- Planning and execution are separate ("reason once, execute many").
- Decompose to objective atomic criteria, never to a fixed count.
- Every stage produces artifacts; workers communicate only through artifacts.
- Validation is risk-based.
- Capability discovery precedes execution.
- Orchestration is centralised.
- The architecture must outlive today's AI models.

---

## 25. Implementation mindset

The first implementation is not meant to prove intelligence — it is meant to **prove the architecture.** If the orchestration model is correct, more capable models and more tools can be introduced later without redesigning the system. This deliberately prioritises longevity, modularity, explainability, and scalability over short-term convenience.

---

## 26. Suggested first build (smallest thing that can fail)

Before building the full factory, prototype the **core loop** on a deliberately tiny target (e.g. a single small mechanic or a trivial "game"):

1. **Recursive planner** that, given a spec node, either (a) declares it atomic, or (b) emits children **plus a frozen interface contract** between them.
2. A **swarm executor** that builds each atomic leaf against its frozen contract in an isolated workspace (e.g. a git worktree per agent).
3. An **integration + review** pass that confirms the leaves actually fit the contracts and compiles/runs.
4. A **Director/verify** pass (ideally able to view a screenshot or short video of the result) that flags what's wrong and re-queues it.

The goal of the prototype is to find *where the idea actually breaks* (almost certainly at the seams and the dependency scheduling), cheaply, before scaling to thousands of tasks. Note: the environment this design was drafted in already provides much of the raw machinery for step 2 (parallel subagents, per-agent isolated git worktrees, structured result collection, a verify pass), which makes the core loop cheap to prototype.

---

## 27. Open questions to resolve next (Design Issues for the fresh chat)

1. **Interface representation.** In what concrete form is a "frozen interface contract" stored and passed to executors — typed stubs/headers, a schema, a natural-language contract, or generated interface files the executor must implement against?
2. **Contract enforcement.** How do we *verify* an executor actually honoured the contract (compile against stubs? contract tests? a reviewer whose only job is contract-conformance)?
3. **Re-planning & change.** When a frozen interface turns out to be wrong mid-build, what is the amendment/versioning process, and how are already-built children invalidated and re-queued?
4. **Decomposition control.** What exactly makes the planner decide "atomic vs. split further," and how do we stop it splitting forever or stopping too early?
5. **Dependency scheduler.** Build custom, or sit on an existing workflow/DAG engine? What's the minimal version for the prototype?
6. **Model routing / cost.** Which tiers of model do which roles (architect vs. planner vs. atomic executor vs. reviewer), and how is that decided per task?
7. **Persistence tech.** What actually stores the Project Model (files in a repo? a database? a document store + vector index?) for the prototype vs. at scale?
8. **Build vs. reuse.** After a live landscape scan (§22), which parts do we build and which do we adopt?

---

*End of document. This file is intended to be handed to a fresh chat verbatim as the project's foundational context.*
