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

## Access knowledge

Server-owned scheduling evidence that ranks jobs by curated ATS defaults, user deferments, and live-probe observations. It can schedule or defer work but can never authorize form filling. Every selected job still requires a fresh non-mutating live probe.

## Access review

The `nextAction` that returns a bounded access-review proposal before any
browser work. It may contain ordinary OPEN or neutral candidates that still
require explicit approval, or it may contain zero members when all remaining
candidates are deferred or exact recovery is blocked by a user deferment.
Trackly opens nothing and does not report the queue as exhausted; an empty
all-deferred or recovery-blocked proposal is handled by clearing explicitly
returned job/company/provider deferments, stopping, or expiry rather than by
sending an empty approval.

## User deferment

An explicit, persistent, reversible per-user preference to skip a Trackly job,
company, or provider scope. The server derives identity from `jobId`; agents
cannot submit URLs or raw chat. Provider scope is a global policy boundary that
applies across companies until explicitly cleared. Global policy is never
trained from individual deferments.

## Service-authoritative safety guard

A destructive-action invariant enforced by the backend operation that owns the mutation, so old, alternate, or faulty agent callers using backend-classified agent surfaces cannot bypass it by omitting newer client-side checks.

Clients may present the challenge and relay confirmation, but they do not independently decide whether the destructive operation is permitted.
