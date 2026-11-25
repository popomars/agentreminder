# Decision Log

> Purpose: preserve why consequential choices were made so future contributors do not repeatedly reopen settled questions. ChatGPT should help compare options and draft entries. Codex should read relevant entries before changing architecture or contracts and append an entry when a new durable decision is accepted. Never rewrite history; mark superseded entries and link to the replacement.

## Status vocabulary

- **Proposed**: under discussion; not yet authoritative.
- **Accepted**: current direction.
- **Superseded**: replaced by a newer linked decision.
- **Rejected**: considered and intentionally not chosen.

## Entry template

Copy this section for each decision. Use IDs such as `ADR-0001`.

### ADR-XXXX: [Decision title]

- Date: YYYY-MM-DD
- Status: Proposed
- Owners: [Names or roles]
- Related: [Issue, PR, document, or replacing ADR]

#### Context

[What forces, constraints, or problem require a decision?]

#### Decision

[State the chosen direction clearly.]

#### Options considered

1. **[Option]** — [Key advantages and disadvantages]
2. **[Option]** — [Key advantages and disadvantages]

#### Consequences

- Positive: [Expected benefit]
- Negative: [Accepted cost or limitation]
- Follow-up: [Required work or validation]

---

## Decisions

### ADR-0001: Install the host from GitHub and enroll over USB

- Date: 2026-11-25
- Status: Accepted

The installer copies the host runtime from one GitHub commit or a local checkout.
A physical confirmation on the single attached device enrolls its ID on the host.
The enrolled host sends approval cards and notifications over that USB connection.
This works with the existing firmware and keeps setup independent of the firmware toolchain.

### ADR-0002: Mirror native Codex approvals through the App Server

- Date: 2026-11-25
- Status: Accepted

Codex's desktop launcher mirrors the App Server's native command and file
requests over USB. The first decision wins. The pre-prompt AgentReminder
permission hook yields inside this launch mode so the native prompt can open.
