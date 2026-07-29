# ATS playbook

## Greenhouse

- Accept employer-hosted Greenhouse forms and `job-boards.greenhouse.io` / `boards.greenhouse.io` application hosts after matching the employer and role.
- Expect resume parsing, React selects, correction banners, demographic sections, and final consent checkboxes.
- Use the visible file chooser or its semantic file input; never click a nearby decorative upload region by coordinates.
- For custom selects and checkbox groups, verify the selected label or checked element in the live DOM after the real click. A displayed answer with a remaining required error is uncommitted.
- Treat red required-field text as authoritative even when a value is visible.
- A Greenhouse “Thank you for applying” page is a valid submission signal.

## Ashby

- Accept `jobs.ashbyhq.com` only after matching the employer and role.
- Expect rerenders, masked contact inputs, and controls whose visible text can differ from committed state.
- Resolve binary button groups by the live selected/active state and semantic Yes/No label, never by button order or styling alone.
- Treat education as repeatable structured rows. After activating `+ Add Education`, require the row count to increase before filling the new row. If Playwright reports a click but the submit-typed control does not add a row, retry with the visible semantic DOM control; stop if the row remains absent.
- Select localized school suggestions by the exact intended institution and then verify the committed row value.
- Best effort: stop when browser and accessibility state disagree.
- An explicit application-success banner/page is a valid submission signal.

## Lever

- Accept `jobs.lever.co` and verified employer-hosted Lever forms after matching the employer and role.
- Expect native inputs mixed with custom selects and optional resume parsing.
- Best effort: stop when a required or semantic control cannot pass the integrity gate.
- A Lever confirmation/thank-you page is a valid submission signal.

## Guided enterprise ATS

This group includes Workday, Oracle Recruiting/Taleo, SAP SuccessFactors, iCIMS, Phenom, Eightfold, Jibe, and Avature when the current protocol marks them `guided`.

- Expect account or login steps, multi-page state, custom comboboxes, employer-hosted shells, embedded frames, and resume parsing.
- Before uploading, confirm there is a semantic path from the current page to review that does not require the agent to enter credentials, solve verification, or cross to an unexpected origin.
- Reclaim and revalidate the exact requisition after every page transition. Recheck prior-step values when the page exposes them.
- Stop immediately when committed state is hidden, the only next control submits the application, or an authentication/verification wall appears.

## Guided mid-market ATS

This group includes SmartRecruiters, Workable, BambooHR, Recruitee, Jobvite, Teamtailor, Comeet, Rippling, Gem, JazzHR, Breezy HR, Freshteam, Personio, Pinpoint, Zoho Recruit, Gusto, HiBob, Paylocity, and ADP when the current protocol marks them `guided`. YC Work at a Startup is currently `manual_only` because its shared job URL does not expose a company tenant that Trackly can verify.

- Expect a mixture of native controls, custom widgets, employer subdomains, embedded frames, shared profile data, and optional resume parsing.
- Match the live HTTPS origin, employer, role, and requisition before entering private data.
- Use the same committed-state and required-error gate as Greenhouse. Familiar-looking controls do not lower the evidence requirement.
- On HiBob, treat document upload as a two-step commit when the UI requires choosing the file and then confirming the upload. Verify the final filename/attachment state; a selected local file alone is not an attached resume.

## Unknown employer-hosted form

- Use only when the protocol resolves the run to `generic_web_form` in guided mode and supplies `originPolicy.authorized: true` with `verification: verified_employer_domain` or `trackly_employer_source_exact_origin`. The latter authorizes only the exact stored origin.
- Inventory every step, origin transition, control type, required error, file input, and review/submit boundary before any upload.
- Never claim provider support from visual similarity. Stop if any critical control cannot be observed semantically.

## Manual-only or verification state

- Do not automate LinkedIn-hosted applications. If Trackly already stores a separate external application URL, evaluate that stored URL under its own backend-issued ATS and origin policy; otherwise let the user complete the LinkedIn form manually.
- Pause for login credentials, OTP, email verification, CAPTCHA, or other human verification. Never read or store credentials or a verification code as a profile answer.
- Report closed/inactive postings as blockers; do not dismiss the saved job unless the user requests it.
