# Operational checkpoints

Use these gates with the public facade's authoritative execution and work
receipts.

## Run invariants

- Retain the latest explicit target as the hard target. A smaller returned wave
  is interim work, not completion; continue only through the facade's prepared
  next-wave receipt until target or queue exhaustion.
- Prove genuine applicant controls, then show the exact jobs and require them to
  be approved before any form mutation.
- After job approval, inventory and fill every known answer before producing one
  grouped question packet containing only true gaps.
- Use current projected profile data, complete education and employment rows,
  confirmed EEO, exact jurisdiction authorization, and the intended resume.
  Preserve user-edited or unknown non-empty controls.
- Run Humanizer automatically for supported employer-specific writing when it is
  available, followed by the local writing integrity gate. Never invent claims.
- Never activate Submit. Preserve every review-ready tab for the user.
- After manual submission, record positive evidence and require a fresh work
  receipt proving `submitted` and `applied_confirmed` before cleanup. Report
  lifecycle, Trackly job state, and tab state separately; claim
  `closed_verified` only from the complete close-proof chain.

## Phase gates

1. **Access:** exact requisition and complete origin policy verified, including
   any policy-required tenant; non-mutating probe;
   typed access state recorded; no private data transmitted.
2. **Selection:** after access proof, latest target retained; exact accessible
   set shown; approval recorded; no form mutation occurred first.
3. **Fill:** whole-form control accounting assigns every visible control one
   committed result or typed exception; known omissions are zero. Typed answer
   lookup across run-only, exact-question, office, jurisdiction, company,
   provider, and global scopes precedes questions. Canonical education records
   and position-level employment records reconcile in reverse chronological
   order without invented date precision. Every attachment-capable form audits
   resume approval, pre-attach verification, committed filename, parser
   recheck, and final sweep separately. Writing passed Humanizer when available
   and the local gate.
4. **Review:** final integrity and per-run truth confirmation passed; the
   `review/manual_submit` action used literal `continuationAllowed: false` and
   the checkpoint was accepted under the current action
   contract; Submit was not activated; exact tabs were durably handed off and
   proven visible. A preserved tab with visibility unverified is reported as a
   blocked handoff, never review-ready.
5. **Reconciliation:** positive submission evidence preceded outcome; fresh
   state proves `submitted` plus `applied_confirmed`; cleanup follows the saved
   preference and complete inventory proof.

Do not claim a phase complete when any listed fact is unknown.

Every handoff reports employer application state, trackly member/job state,
and browser presence/visibility state independently. No state in one system
implies a state in another.
