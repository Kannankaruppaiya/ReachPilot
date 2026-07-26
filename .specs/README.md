# .specs — Spec-Driven Development

ReachPilot is built spec-first: before writing code for a non-trivial feature we
write a **spec** so humans and AI agents share the same plan. Each feature is a
folder with three files:

| File | Purpose |
| --- | --- |
| `requirements.md` | **What & why** — user stories + acceptance criteria in EARS format. No solution detail. |
| `design.md` | **How** — architecture, data model, APIs, sequence, edge cases, trade-offs. |
| `tasks.md` | **Steps** — an ordered, checkable task list an agent can execute and tick off. |

## Workflow

1. **Requirements** → agree on the problem and acceptance criteria first.
2. **Design** → decide the approach; list edge cases and non-goals.
3. **Tasks** → break design into small, verifiable steps (each maps to a commit).
4. **Execute** → work the tasks top-down, ticking `[x]`; keep the spec in sync.

Keep specs in the repo next to the code they describe. When a decision has
long-lived architectural weight, also record an ADR in [`docs/adr/`](../docs/adr).

## EARS quick reference (requirements syntax)

- **Ubiquitous:** The system SHALL `<requirement>`.
- **Event:** WHEN `<trigger>`, the system SHALL `<response>`.
- **State:** WHILE `<state>`, the system SHALL `<response>`.
- **Conditional:** IF `<condition>`, THEN the system SHALL `<response>`.
- **Optional feature:** WHERE `<feature is present>`, the system SHALL `<response>`.

## Index

Current spec folders (see [`roadmap.md`](roadmap.md) for the full remaining-work picture):

| Spec | Status | Priority |
| --- | --- | --- |
| [auth-session-reliability](auth-session-reliability/) | Ready to build | P0 |
| [linkedin-driver-hardening](linkedin-driver-hardening/) | Ready to build | P0 |
| _(create a folder per feature as you pick it up from the roadmap)_ | — | — |
