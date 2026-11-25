# AI Project Template

A repository template for software projects developed collaboratively by people, ChatGPT, and Codex. It keeps durable product knowledge, technical decisions, and current delivery state close to the code and under version control.

## Start a project

1. Create a repository from this template.
2. Replace placeholder text in `docs/vision.md` and `docs/product.md`.
3. Record the initial architecture and constraints in `docs/architecture.md`.
4. Turn the first roadmap milestone into a small, concrete `docs/current-sprint.md`.
5. Review `.ai/context.md`, `.ai/conventions.md`, and `AGENTS.md` for project-specific instructions.

Delete instructional blockquotes as sections become real project documentation.

## Repository map

| Path | Purpose |
| --- | --- |
| `docs/vision.md` | Stable product direction, users, outcomes, and boundaries |
| `docs/product.md` | Current product behavior, requirements, and user flows |
| `docs/architecture.md` | System design, boundaries, interfaces, and quality attributes |
| `docs/decision-log.md` | Chronological record of consequential decisions |
| `docs/roadmap.md` | Outcome-based direction across multiple milestones |
| `docs/current-sprint.md` | Short-lived execution state and immediate priorities |
| `docs/coding-guidelines.md` | Project-specific engineering and verification rules |
| `.ai/context.md` | Fast orientation and canonical context map for AI collaborators |
| `.ai/conventions.md` | Rules for safe, consistent AI-assisted changes |
| `.ai/onboarding.md` | Repeatable checklist for a new human or AI session |
| `src/` | Product source code |
| `tests/` | Automated tests and test support files |

## Collaboration loop

Before implementation, ChatGPT or Codex should read `AGENTS.md`, `.ai/context.md`, and the documents relevant to the task. During work, code and tests remain the authority for actual runtime behavior. After a meaningful decision or status change, update only the documents whose truth changed.

Suggested end-of-session prompt:

> Synchronize project state: summarize the conclusions, update the affected project documents, keep stable and temporary information separate, and show me the resulting diff.

AI-generated changes should be reviewed, tested, and committed like any other contribution. Do not store credentials, personal data, or private conversation transcripts in this repository.

## Document lifecycle

- Stable: `vision.md`, `architecture.md`, `coding-guidelines.md`
- Evolving: `product.md`, `roadmap.md`, `decision-log.md`
- Frequently refreshed: `current-sprint.md`, `.ai/context.md`

When documents disagree, resolve the conflict explicitly. A newer accepted decision in `decision-log.md` overrides older prose; tested code describes current behavior; `vision.md` defines intended direction.

## License

Choose and add a license appropriate for the new project.
