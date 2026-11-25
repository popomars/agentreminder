# AI Context Map

> Purpose: give ChatGPT, Codex, and other AI collaborators a fast route into the repository without duplicating every document. Keep this concise and factual. Link to canonical sources; do not turn it into a second product specification.

## Project snapshot

- Project: [Name]
- Purpose: [One sentence; align with `docs/vision.md`]
- Lifecycle stage: [Discovery / MVP / Growth / Maintenance]
- Primary stack: [Languages, frameworks, infrastructure]
- Default branch: `main`

## Source-of-truth map

| Question | Read first |
| --- | --- |
| Why does this exist? | `docs/vision.md` |
| What should it do? | `docs/product.md` |
| How is it designed? | `docs/architecture.md` |
| Why was a choice made? | `docs/decision-log.md` |
| What direction comes next? | `docs/roadmap.md` |
| What is active now? | `docs/current-sprint.md` |
| How should code be changed? | `docs/coding-guidelines.md` and `.ai/conventions.md` |

## Repository map

- `src/`: [Production code organization]
- `tests/`: [Test organization]
- `docs/`: Durable product and engineering knowledge
- `.ai/`: AI collaboration and onboarding guidance

## Current facts

- [Fact that is useful across sessions and not obvious from code]
- [Known constraint or compatibility requirement]

## Commands

```sh
# Setup
[command]

# Run locally
[command]

# Verify
[command]
```

## Important boundaries

- [Security, privacy, API compatibility, platform, or scope boundary]

## Known uncertainties

- [Unverified assumption or documentation/code mismatch]

## Maintenance

Update this file when the stack, repository map, standard commands, or cross-session constraints change. Put decisions in `docs/decision-log.md` and temporary execution detail in `docs/current-sprint.md` instead.
