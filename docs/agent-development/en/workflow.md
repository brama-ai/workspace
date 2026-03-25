# Pipeline Workflow — Agent Orchestration

Diagrams below describe the current workflow, public entrypoints, and task-state storage.

## Runtime Model

Public entrypoints:

- `./agentic-development/foundry.sh`
- `./agentic-development/ultraworks.sh`

Task-local state:

```text
tasks/<slug>--foundry/
tasks/<slug>--ultraworks/
```

Each task directory is the durable source of truth for:

- `task.md`
- `handoff.md`
- `state.json`
- `events.jsonl`
- `summary.md`
- `meta.json`

Wrapper-level logs live in:

```text
agentic-development/runtime/logs/
```

---

## 1. Architecture Overview

```mermaid
graph TB
    subgraph "Entry Points"
        CMD_AUTO["/auto<br/>(Sisyphus)"]
        CMD_PIPE["foundry.sh<br/>(manual/runtime)"]
        CMD_IMPL["/implement"]
        CMD_VAL["/validate"]
        CMD_AUDIT["/audit"]
        CMD_FINISH["/finish"]
        BP["Foundry Planner<br/>(E2E → bug delegation)"]
    end

    subgraph "Orchestration"
        PLANNER["Planner<br/>claude-opus-4-6"]
        PLAN_JSON["pipeline-plan.json"]
    end

    subgraph "Pipeline Agents (u-* subagents)"
        ARCH["Architect<br/>claude-opus-4-6"]
        CODER["Coder<br/>claude-sonnet-4-6"]
        REVIEWER["Reviewer<br/>minimax"]
        VAL["Validator<br/>minimax"]
        TEST["Tester<br/>kimi-k2.5"]
        AUDITOR["Auditor<br/>claude-opus-4-6"]
        DOC["Documenter<br/>gpt-5.4"]
        SUM["Summarizer<br/>gpt-5.4"]
        INV["Investigator<br/>claude-opus-4-6"]
    end

    subgraph "Phase 8 — Deployment & Ops (opt-in)"
        DEPLOY["Deployer<br/>claude-sonnet-4-6"]
        OPS["Ops Agent<br/>claude-sonnet-4-6"]
    end

    subgraph "Server (46.62.135.86)"
        K3S["K3s Cluster<br/>namespace: brama"]
        CF["Cloudflare Tunnel<br/>brama.dev"]
    end

    subgraph "Artifacts"
        TASKDIR["tasks/<slug>--workflow/<br/>task.md + state + summary"]
        SPEC["OpenSpec<br/>proposal.md + tasks.md"]
    end

    CMD_AUTO --> PLANNER
    CMD_PIPE --> PLANNER
    CMD_IMPL --> CODER
    CMD_VAL --> VAL & TEST
    CMD_AUDIT --> AUDITOR
    CMD_FINISH --> TASKDIR
    BP -->|delegates bugs| CMD_AUTO

    PLANNER --> PLAN_JSON
    PLAN_JSON -->|profile routing| ARCH & INV & CODER

    ARCH --> SPEC
    SPEC --> CODER
    INV --> CODER
    CODER --> REVIEWER
    REVIEWER --> VAL & TEST
    VAL --> DOC & SUM
    TEST --> DOC & SUM
    AUDITOR --> CODER

    SUM -->|deploy: true| DEPLOY
    DEPLOY -->|SSH + helm| K3S
    OPS -->|SSH + kubectl| K3S
    K3S --> CF

    ARCH -.->|write| TASKDIR
    CODER -.->|write| TASKDIR
    VAL -.->|write| TASKDIR
    TEST -.->|write| TASKDIR
    SUM -.->|read all| TASKDIR
    DEPLOY -.->|write| TASKDIR
```

---

## 2. Feature Development Flow (standard / complex)

```mermaid
sequenceDiagram
    participant U as User / Command
    participant P as Planner
    participant A as Architect
    participant C as Coder
    participant R as Reviewer
    participant V as Validator
    participant T as Tester
    participant D as Documenter
    participant S as Summarizer

    U->>P: Task description
    P->>P: Analyze complexity
    P-->>P: Output pipeline-plan.json

    alt No tasks.md exists
        P->>A: Create OpenSpec proposal + tasks
        A-->>C: proposal.md + tasks.md ready
    else tasks.md exists
        P->>C: Skip architect, go to implementation
    end

    C->>C: Implement tasks.md items
    C->>R: Code ready for review

    R->>R: Quality improvements

    par Parallel quality gate
        R->>V: Run PHPStan + CS-Fixer
        R->>T: Run tests + write missing
    end

    par Parallel finalization
        V->>D: Docs (if needed)
        V->>S: Write summary
        T->>D: Docs (if needed)
        T->>S: Write summary
    end

    S-->>U: Summary artifact

    opt deploy: true in task metadata
        S->>S: Verify all stages passed
        Note over S: Phase 8 — opt-in only
        create participant DEP as Deployer
        S->>DEP: Deploy to K3s
        DEP->>DEP: Build on server (nerdctl)
        DEP->>DEP: helm upgrade + rollout
        DEP->>DEP: Health check
        DEP-->>U: Deployment result + PR URL
    end
```

---

## 3. Bug Fix Flow (bugfix profile)

```mermaid
sequenceDiagram
    participant U as User / E2E failure
    participant P as Planner
    participant I as Investigator
    participant C as Coder
    participant V as Validator
    participant T as Tester
    participant S as Summarizer

    U->>P: Bug report
    P->>P: Choose profile: bugfix
    Note over P: NO Architect — bug is an implementation fix

    P->>I: Investigate root cause
    I->>I: Read-only analysis
    I-->>C: Root cause + reproduction steps

    C->>C: Fix the bug

    par Parallel quality gate
        C->>V: Validate fix
        C->>T: Verify fix + regression tests
    end

    T->>S: Write summary
    S-->>U: Summary artifact
```

---

## 4. Bug Fix + Spec Change Flow (bugfix+spec profile)

```mermaid
sequenceDiagram
    participant U as User
    participant P as Planner
    participant I as Investigator
    participant A as Architect
    participant C as Coder
    participant V as Validator
    participant T as Tester
    participant S as Summarizer

    U->>P: Bug report (spec is wrong)
    P->>P: Choose profile: bugfix+spec
    Note over P: Architect included — spec itself needs change

    P->>I: Investigate root cause
    I->>I: Read-only analysis
    I-->>A: Root cause + spec mismatch

    A->>A: Update OpenSpec proposal
    A-->>C: Updated tasks.md

    C->>C: Implement fix

    par Parallel quality gate
        C->>V: Validate
        C->>T: Test
    end

    T->>S: Write summary
    S-->>U: Summary artifact
```

---

## 5. Foundry Planner Flow (E2E to Bug Delegation)

Daily entrypoint for this flow:

```bash
./agentic-development/foundry.sh autotest 3 --smoke --start
./agentic-development/foundry.sh autotest -n 10 --start
./agentic-development/foundry.sh autotest 5 --from-report .opencode/pipeline/reports/e2e-autofix-20260324_154309.json
```

```mermaid
sequenceDiagram
    participant BP as Foundry Planner
    participant E2E as make e2e
    participant PL as Pipeline (per bug)

    BP->>E2E: Run E2E tests
    E2E-->>BP: Test results

    alt All tests pass
        BP-->>BP: Success, stop
    else Failures found (max 5)
        loop For each failure
            BP->>PL: Delegate bug fix task
            Note over PL: Launches independent<br/>bugfix pipeline
        end
        BP-->>BP: Stop after delegation
    end
```

---

## 6. Profile Selection Matrix

```mermaid
flowchart TD
    START[Task received] --> IS_BUG{Bug report?}

    IS_BUG -->|No| HAS_CODE{Changes code?}
    IS_BUG -->|Yes| TRIVIAL{Trivial?<br/>typo / null check}

    TRIVIAL -->|Yes| QF[quick-fix<br/>coder - validator - summarizer]
    TRIVIAL -->|No| SPEC_WRONG{Spec is wrong?}

    SPEC_WRONG -->|No| BUGFIX[bugfix<br/>investigator - coder - validator<br/>- tester - summarizer]
    SPEC_WRONG -->|Yes| BUGFIX_SPEC[bugfix+spec<br/>investigator - architect - coder<br/>- validator - tester - summarizer]

    HAS_CODE -->|No| DOCS[docs-only<br/>documenter - summarizer]
    HAS_CODE -->|Yes| LINT_ONLY{Lint/CS only?}

    LINT_ONLY -->|Yes| QG[quality-gate<br/>coder - validator - summarizer]
    LINT_ONLY -->|No| TESTS_ONLY{Tests only?}

    TESTS_ONLY -->|Yes| TO[tests-only<br/>coder - tester - summarizer]
    TESTS_ONLY -->|No| SCOPE{Multi-service?<br/>Migrations?}

    SCOPE -->|Simple| STD[standard<br/>coder - validator - tester - summarizer]
    SCOPE -->|Complex| AGENT{Modifies agent?}

    AGENT -->|No| CMPLX[complex<br/>coder - validator - tester - summarizer]
    AGENT -->|Yes| CMPLX_A[complex+agent<br/>coder - auditor - validator<br/>- tester - summarizer]

    SCOPE -->|Deploy needed| DEPLOY_Q{Deploy after?}
    DEPLOY_Q -->|Yes| STD_DEP[standard+deploy<br/>coder - validator - tester<br/>- deployer - summarizer]
    DEPLOY_Q -->|No| STD

    START --> IS_OPS{Server ops?<br/>logs / DB / restart}
    IS_OPS -->|Yes| OPS_PROF[ops<br/>ops-agent]

    style BUGFIX fill:#f9d71c,stroke:#333
    style BUGFIX_SPEC fill:#f9d71c,stroke:#333
    style QF fill:#90EE90,stroke:#333
    style STD fill:#87CEEB,stroke:#333
    style CMPLX fill:#DDA0DD,stroke:#333
    style STD_DEP fill:#FF8C00,stroke:#333
    style OPS_PROF fill:#FF6347,stroke:#333
```

---

## 7. Inter-Agent Communication

All agents communicate via the task directory, with **`handoff.md`** as the human-readable bus:

| Agent | Writes to handoff | Reads handoff |
|-------|------------------|---------------|
| Planner | Initializes: task + profile | For resume |
| Architect | Spec decisions | -- |
| Investigator | Root cause + findings | -- |
| Coder | Files changed, migrations, deviations | -- |
| Validator | PHPStan/CS results per app | -- |
| Tester | Test results, new tests | -- |
| Auditor | Verdict + findings | -- |
| Documenter | Docs created/updated | -- |
| **Summarizer** | **Final summary** | **Reads ALL** |
| **Deployer** | **Deployment result, PR URL, health check** | **Reads ALL (verify stages passed)** |
| **Ops Agent** | **Server state, logs, DB query results** | **On-demand (no pipeline context)** |

> **CONTEXT-CONTRACT**: Agents receive context via prompt `CONTEXT`, **not** by reading handoff.md directly (exception: Planner, Summarizer, Deployer).

> **Deployer** is Phase 8 — opt-in only. Runs after Summarizer when `deploy: true` is in task metadata and all previous stages passed. See [deployer-agent.md](../../pipeline/en/deployer-agent.md).

> **Ops Agent** is standalone — not part of the pipeline. Use the `ops` profile to query live server state: logs, DB, pod status, image builds. See [deploy-to-kube.md](../../deploy-to-kube.md).
