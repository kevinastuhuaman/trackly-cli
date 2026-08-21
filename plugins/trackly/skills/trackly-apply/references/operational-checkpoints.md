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

1. **Selection:** latest target retained; exact accessible set shown; approval
   recorded; no form mutation occurred first.
2. **Access:** exact requisition/origin/tenant verified; non-mutating probe;
   typed access state recorded; no private data transmitted.
3. **Fill:** every visible control has a committed receipt or typed exception;
   known omissions are zero; deterministic fields preceded questions; writing
   passed Humanizer when available and the local gate.
4. **Review:** final integrity and per-run truth confirmation passed; Submit was
   not activated; exact tabs were durably handed off and proven visible.
5. **Reconciliation:** positive submission evidence preceded outcome; fresh
   state proves `submitted` plus `applied_confirmed`; cleanup follows the saved
   preference and complete inventory proof.

Do not claim a phase complete when any listed fact is unknown.
