# Repository Instructions

These instructions apply to the entire repository.

## Before changing code

1. Read `.ai/context.md` for the project map and current facts.
2. Read `.ai/conventions.md` and `docs/coding-guidelines.md` for working rules.
3. Read the product, architecture, decision, roadmap, or sprint documents relevant to the task.
4. Inspect the existing code and tests; do not assume the documentation is perfectly current.

## While working

- Preserve the intent and scope of the request.
- Prefer small, reviewable changes that fit existing patterns.
- Add or update tests when behavior changes.
- Never add secrets, credentials, or sensitive user data.
- Surface contradictions between code, tests, and documentation instead of silently choosing one.

## Before finishing

- Run the relevant checks and report their results.
- Update documentation only when the source of truth changed.
- Record consequential, durable choices in `docs/decision-log.md`.
- Refresh `docs/current-sprint.md` when delivery state changes.
- Summarize changed files, validation, assumptions, and remaining risks.
