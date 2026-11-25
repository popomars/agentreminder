# Onboarding for Human and AI Contributors

> Purpose: make the start of every new session repeatable. ChatGPT can use this checklist before product or architecture discussions. Codex should follow it before implementation so decisions are grounded in the same repository context.

## First 10 minutes

1. Read `README.md` and root `AGENTS.md`.
2. Read `.ai/context.md` and `.ai/conventions.md`.
3. Read `docs/vision.md` and the task-relevant product or architecture sections.
4. Check `docs/decision-log.md` for related accepted decisions.
5. Check `docs/current-sprint.md` for current scope, blockers, and handoff notes.
6. Inspect the relevant source and tests.
7. Run the smallest useful verification command to confirm the environment.

## Before proposing work

- State the problem and expected outcome.
- Identify affected users, contracts, components, and data.
- Note relevant accepted decisions and constraints.
- Separate known facts, assumptions, and open questions.
- Define observable acceptance criteria.

## Before implementing

- Confirm the requested scope and locate the owning code.
- Check for unrelated local changes.
- Choose a verification plan proportional to risk.
- Identify which documents would become inaccurate if the change succeeds.

## Before handing off

- Review the final diff for scope and sensitive data.
- Run relevant format, analysis, test, and build commands.
- Update changed sources of truth and the sprint handoff.
- Record a decision if the work introduced a durable tradeoff.
- Report what changed, evidence, and remaining uncertainty.

## Suggested prompts

### Product discussion

> Read the project context and relevant product documents. Help me explore this idea, identify conflicts with the vision or accepted decisions, and propose testable acceptance criteria. Do not edit files until I ask.

### Implementation

> Read the repository instructions and task-relevant context, inspect the existing code and tests, implement the requested change, run appropriate checks, and synchronize only the documents whose truth changed.

### Project-state synchronization

> Review this session's accepted conclusions against the repository. Update the affected canonical documents, preserve decision history, refresh the sprint handoff, and show a concise diff summary before publishing.
