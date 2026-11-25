# Coding Guidelines

> Purpose: define the project-specific engineering bar. ChatGPT should use these rules when proposing designs or reviewing changes. Codex should follow them during implementation and keep commands and conventions accurate as the toolchain evolves.

## Core principles

- Prefer the smallest design that clearly satisfies the requirement.
- Preserve public contracts unless a breaking change is explicitly accepted.
- Keep business rules separate from transport, storage, and UI concerns.
- Make invalid states difficult to represent and failures easy to diagnose.
- Match established project patterns before introducing new abstractions.

## Structure and naming

- Put production code in `src/` and tests in `tests/` unless the chosen ecosystem has a stronger convention.
- Name modules by responsibility, not implementation mechanism.
- Keep files focused; split them when responsibilities or change reasons diverge.
- Document non-obvious constraints and rationale, not line-by-line behavior.

## Testing

- Add tests for new behavior and regressions.
- Prefer deterministic tests with clear arrange/act/assert structure.
- Test public behavior and important boundaries; avoid coupling tests to incidental internals.
- Record the real project commands below as soon as the toolchain is selected.

```sh
# Format
[command]

# Lint or static analysis
[command]

# Test
[command]

# Build or package
[command]
```

## Security and data handling

- Never commit secrets, tokens, credentials, production data, or unredacted personal data.
- Validate untrusted input at system boundaries.
- Use least privilege and safe defaults.
- Redact sensitive values from logs and error reports.
- Review dependencies and generated code before adoption.

## Changes and reviews

- Keep commits coherent and messages outcome-oriented.
- Explain user impact, design tradeoffs, validation, and remaining risks in reviews.
- Do not mix unrelated cleanup with behavior changes without a clear reason.
- Update architecture, product, or decision documents when their source of truth changes.

## Definition of done

- The requested behavior works and acceptance criteria are met.
- Relevant formatting, analysis, tests, and builds pass.
- Errors and edge cases have appropriate behavior.
- Documentation is accurate.
- No secrets or unrelated changes are included.
