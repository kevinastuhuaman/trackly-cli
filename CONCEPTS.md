# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary and expanded as durable project learnings emerge; direct edits are fine. Glossary only, not a spec or catch-all.

## Trackly Apply execution

A durable, server-owned orchestration record that freezes the user's approved application scope and governs progress independently from any browser session.

## Exact recovery

The process that recreates actionable server lineage for one explicitly confirmed immutable candidate set without substitution or replenishment.

Exact recovery does not restore browser tabs, employer draft values, or write authority. Each recovered member requires a fresh browser binding, form inspection, and current mutation authority before a write.

## Inspection epoch

The version of a member's browser inspection authority; evidence from an earlier epoch cannot authorize the current form after recovery or rebinding.

## Review handoff

A durable receipt identifying the exact application members ready for human review and reconciliation, without granting submission authority or storing employer-form values.

## Manual Submit boundary

The invariant that the agent prepares and verifies the application through final review while only the user activates the employer's submission control.

## Service-authoritative safety guard

A destructive-action invariant enforced by the backend operation that owns the mutation, so old, alternate, or faulty agent callers using backend-classified agent surfaces cannot bypass it by omitting newer client-side checks.

Clients may present the challenge and relay confirmation, but they do not independently decide whether the destructive operation is permitted.
