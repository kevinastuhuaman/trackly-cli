---
title: Durable exact recovery after browser state loss
date: 2026-08-13
category: integration-issues
module: Trackly Apply durable recovery
problem_type: integration_issue
component: assistant
symptoms:
  - Restored browser tabs had lost unsaved application-form values after a browser or laptop restart
  - A Zoox submission attempt reached ERR_FILE_NOT_FOUND without evidence identifying the failed upload stage or cause
  - Earlier browser observations could appear valid even though they belonged to an obsolete inspection epoch
  - Authentication and pre-form challenge pages risked being mistaken for completed accessible applications
root_cause: missing_workflow_step
resolution_type: code_fix
severity: high
related_components: [service_object, tooling, development_workflow]
tags: [trackly-apply, exact-recovery, browser-restart, inspection-epoch, manual-submit, durable-handoff]
---

# Durable exact recovery after browser state loss

## Problem

Trackly Apply previously had no complete recovery contract for the gap between durable execution state and ephemeral browser state. A laptop restart, browser relaunch, renderer crash, lost automation connection, or missing local upload artifact could leave a server execution intact while destroying the tab handle, DOM snapshot, unsaved employer-form values, field provenance, or upload handle that had authorized the next mutation.

The shipped recovery contract separates those layers. Exact recovery restores only a user-confirmed, server-retained candidate lineage; the agent must independently restore the browser surface, revalidate or reconstruct the form, and reacquire current mutation authority before writing anything.

## Symptoms

- Session evidence from the August 4–5 Apply run: after Chrome relaunched, previously filled Ontic and Lila forms appeared empty even though their tabs had been restored. The tab list survived, but the unsaved application DOM did not.
- Session evidence from the same run: a Zoox submission attempt navigated to Chrome's `ERR_FILE_NOT_FOUND`. The failed upload stage and underlying cause were not captured, so the cause remains unknown.
- A tab could remain visible to the user while disappearing from the automation controller, or the controller could retain a stale handle after navigation or a renderer restart. Application identity must not be inferred from window position, a transient tab number, or title text alone (`skills/trackly-apply/references/browser-lifecycle.md`, opening identity rules).
- Earlier field checks, upload evidence, and review receipts could look plausible after recovery while belonging to an obsolete inspection epoch (`skills/trackly-apply/references/batch-orchestration.md`, “Exact recovery after local context loss”).
- Authentication, account creation, OTP, and pre-form CAPTCHA pages could be mistakenly counted toward the review-ready target even though no safely accessible form existed. These classifications consume no completed slot (`skills/trackly-apply/references/batch-orchestration.md`, “Parent execution and child waves”).

## What Didn't Work

### Choosing external Chrome or the in-app browser as the persistence strategy

Neither browser is a durable store. External Chrome can restore tabs without restoring page-local draft state; an in-app renderer or its automation connection can also restart or lose its controller inventory. Changing browser hosts may improve control availability, but it cannot make DOM state, tab handles, file chooser handles, or local upload paths authoritative.

### Treating tab presence as proof of saved form state

A restored URL proves only that a page can be reopened. It does not prove that the employer saved the draft, that the same requisition is loaded, that user edits survived, or that Trackly still authorizes mutation. Recovery therefore requires three separate proofs: tab restoration, form-state restoration or safe reconstruction, and current mutation authority (`skills/trackly-apply/references/browser-lifecycle.md`, “Missing-tab recovery”).

### Reusing cached resume paths

Regardless of the unclassified Zoox failure's cause, an earlier local path cannot be reused as attachment evidence. A prepared artifact may expire, move, or be deleted while the browser still displays an old reference. The supported sequence verifies the prepared resume immediately before attachment, checks the employer-facing committed filename, and rechecks parser-sensitive fields (`skills/trackly-apply/references/browser-upload.md`, “Capability gate”).

### Using generic advancement or replacement after context loss

Generic “continue with the next job” behavior is wrong for exact recovery because it can substitute newly saved or similar jobs for the user's original applications. Fixed membership may not be replaced, rescored, or expanded (`skills/trackly-apply/references/batch-orchestration.md`, “Freeze before browser work”). Recovery must use one retained source snapshot and exactly the candidates the user confirmed.

### Refilling from profile data without provenance

Blind autofill can overwrite a correction the user made after the agent's last observation. After ledger loss, every unexplained non-empty field becomes `unknown_external_change` and must be preserved; only safely empty or still agent-owned fields may be filled (`skills/trackly-apply/references/browser-lifecycle.md`, “Local tab ledger”).

## Solution

The durable recovery work shipped through [trackly-cli PR #100](https://github.com/trackly-app/trackly-cli/pull/100) and the corresponding backend implementation in [close-ai PR #1391](https://github.com/trackly-app/close-ai/pull/1391).

### 1. Discover a bounded, value-free recovery menu

When there is no active execution but the server may retain unfinished lineage, call `trackly_list_recoverable_apply_executions`. The response exposes stable source execution IDs, snapshot hashes, candidate IDs, job IDs, queue positions, and eligibility codes; duplicate source and candidate identities are rejected (`mcp/apply-tools.js`, `recoverableCandidateSchema` and `recoverableExecutionsResponseSchema`). Resolve each job through Trackly and present the exact company, role, requisition identity when available, and source execution. Never reconstruct identity from chat, tab order, page copy, or search results (`skills/trackly-apply/references/batch-orchestration.md`, “Exact recovery after local context loss”).

### 2. Require explicit confirmation of one exact set

Call `trackly_recover_exact_apply_members` only with one discovered source execution, that source's snapshot hash, unique confirmed candidate IDs, `explicitExactSetConfirmation: true`, and a fresh idempotency key. Before the write, the CLI rejects an undiscovered source, changed snapshot hash, or candidate outside the latest discovery menu (`mcp/apply-tools.js`, `trackly_recover_exact_apply_members` registration).

Recovery is all-or-nothing at the client boundary. The response validator requires `assertedCandidateIds`, `eligibleCandidateIds`, and every eligibility row to equal the requested set exactly, without duplicates or non-recoverable results (`mcp/apply-tools.js`, `validateExactRecoveryResponse`). This prevents partial recovery, substitution, and replenishment. Frozen order and membership remain server-owned.

### 3. Restore browser state and authority independently

Branch on the recovered member's run binding. If `runId` is absent, call `trackly_start_apply_run` with the exact recovered batch/member/version/epoch/lease binding before entering private data. If `runId` exists but its browser surface is missing, reuse that run and bind the exact backend-stored requisition URL with `recovery_binding`; never start a replacement run merely because browser control was interrupted. The returned member version and inspection epoch are authoritative, and prior-epoch evidence is invalid (`skills/trackly-apply/SKILL.md`, “Start every run”; `skills/trackly-apply/references/browser-lifecycle.md`, “Reconciliation”). Revalidate HTTPS origin, ATS tenant, employer, role, requisition, job identity, and semantic controls before entering private data. Reinventory the entire form because a draft must never be assumed to have survived a crash or handoff (`skills/trackly-apply/references/browser-lifecycle.md`, “Missing-tab recovery”).

The operator receipt must separately report whether the exact tab was restored, whether employer form state was restored or safely reconstructed, and whether current mutation authority was reacquired. A missing original tab may be reopened from the exact backend URL; mutation requires the resulting form to be restored or safely reconstructed and current authority to be reacquired, while the tab-restoration fact remains independently reported.

### 4. Preserve user-owned and unknown values

Take a fresh semantic inventory before the first write. Maintain provenance by execution, run, inspection epoch, and semantic field fingerprint. Preserve `user_edited` values byte-for-byte. If the ledger was lost, classify every unknown non-empty value as `unknown_external_change` instead of refilling (`skills/trackly-apply/references/browser-lifecycle.md`, “Local tab ledger”). Resume parsing, rerendering, recovery, and final validation cannot overwrite those values (`skills/trackly-apply/SKILL.md`, “Fill the form”).

### 5. Reverify the exact resume at attachment time

Discover a real semantic Resume/CV control first. Arm and prove the chooser, run `trackly_verify_prepared_resume`, and immediately attach only that verified artifact. Then verify the visible employer-facing filename and recheck every field the parser may have changed (`skills/trackly-apply/references/browser-upload.md`, “Capability gate”). An earlier approval proves which content the user authorized; it does not prove which bytes the current employer form received.

### 6. Park access barriers without counting them

Classify live probes with the typed value-free set: `accessible`, `authentication_required`, `account_creation_required`, `otp_required`, `captcha_before_form`, `captcha_at_submit`, `manual_only`, or `unknown_unobservable` (`skills/trackly-apply/references/batch-orchestration.md`, “Parent execution and child waves”). Authentication, account creation, OTP, and pre-form CAPTCHA consume no target slot. A submit-time CAPTCHA can remain review-ready because the user owns the final action; the agent never solves, stores, or bypasses it (`skills/trackly-apply/references/batch-orchestration.md`, “Challenge placement”).

### 7. Stop at manual review

Submit remains a hard human boundary. The skill forbids the agent from clicking Submit even when the user previously approved submission (`skills/trackly-apply/SKILL.md`, “Non-negotiable rules”). The agent verifies the current form and leaves the review tab visible. Submission is recorded only from a real success page or explicit user confirmation after the human acts (`skills/trackly-apply/SKILL.md`, “Review handoff”).

## Why This Works

The solution places authority in records that survive a browser crash: the server-retained source execution, immutable snapshot hash, exact candidate identities, member versions, inspection epochs, and idempotent mutation receipts. Browser state remains evidence, never authority by itself.

Set equality closes substitution. Discovery establishes the eligible menu, explicit confirmation binds user intent to it, the pre-write cache rejects undiscovered candidates, and post-write validation requires every candidate collection to equal the request. A partially eligible response cannot be rationalized into a “close enough” recovery.

Inspection epochs close stale-evidence reuse. Field provenance protects user corrections. Point-of-use resume verification distinguishes authorized content from the file actually committed to the employer form. Parking access barriers and preserving manual Submit prevent recovery pressure from weakening authentication, anti-bot, or consent boundaries.

## Prevention

- Model browser tabs, DOM snapshots, control handles, chooser handles, and local artifact paths as leases or observations, never durable state.
- Bind the exact run only for its initial surface or after a missing-tab recovery/handoff, accepting the new inspection epoch each time. After ordinary navigation or rerender, retain that binding and revalidate identity, form state, and the semantic DOM before mutation.
- Keep tab restored, form restored/reconstructed, and mutation authority reacquired as separate assertions in code, tests, and operator output.
- Preserve exact recovery as a dedicated operation; never route it through normal advancement, refill, replacement, or “next candidate” logic.
- Assert set equality and uniqueness on both sides of the mutation. Cover duplicate discovery identities, undiscovered candidates, changed snapshot hashes, partial eligible sets, substitutions, and non-recoverable rows.
- Treat every unexplained non-empty field as protected after provenance loss.
- Verify resume identity immediately before attachment, verify the committed filename immediately afterward, and re-snapshot parser-sensitive fields.
- Keep authentication, account creation, OTP, and pre-form CAPTCHA parked and value-free; never count or auto-resume them.
- Keep “Never Submit” in behavioral tests and handoff templates.

## Related Issues

- [Trackly CLI PR #100](https://github.com/trackly-app/trackly-cli/pull/100) — CLI, MCP, and skill-side durable exact recovery contract.
- [Close AI PR #1391](https://github.com/trackly-app/close-ai/pull/1391) — backend durable recovery lineage and exact-member control plane.
- [Durable recovery implementation plan](../../plans/2026-08-05-001-trackly-apply-durable-recovery-reconciliation-plan.md) — historical design record aligned with the released all-or-nothing recovery contract.
