# Access-probe state machine

Use this reference for every candidate whose current access state is not already
durably terminal. A provider hint is scheduling input, never sufficient proof.

## States

- `requisition_loaded`: the exact stored HTTPS requisition loaded and its
  employer, role, requisition, origin, and tenant identity passed.
- `apply_entry_found`: a genuine application-entry control exists.
- `intermediate_apply_shell`: a modal, chooser, overview, marketing shell,
  guest landing page, resume-choice screen, or routing page. Accessibility is
  still unknown.
- `applicant_fields_reached`: genuine applicant controls are visible,
  semantically editable, and reachable without credentials.
- `authentication_required`: an existing-account login blocks applicant fields.
- `account_creation_required`: a new account blocks applicant fields.
- `otp_required`: email or SMS verification blocks applicant fields.
- `captcha_before_form`: human verification blocks applicant fields.
- `captcha_at_submit`: applicant fields are usable, but the user must solve a
  final challenge at Submit.
- `inactive`: the exact posting is removed, closed, or no longer accepts
  applications.
- `manual_only`: provider policy forbids automated form mutation.
- `unknown_unobservable`: the adapter cannot prove committed semantic controls.

## Transition contract

1. Begin from only the exact backend-stored requisition URL.
2. Validate HTTPS, employer, role, requisition, origin, and ATS tenant.
3. Follow ordinary non-sensitive application-entry controls while remaining in
   `intermediate_apply_shell`.
4. Stop only at genuine applicant controls or one typed blocker. An Apply button,
   modal, guest shell, overview, or readable job page is not access proof.
5. Never enter private data, credentials, create an account, solve OTP or
   CAPTCHA, or change an applicant control during the probe.
6. Count a job as accessible only after `applicant_fields_reached` is durably
   proven and the active contract's `accessible` disposition is durably
   recorded. Use `accessible`, not the local state name, in the access checkpoint.
   `captcha_at_submit` may continue through review because the user owns Submit;
   every other access wall is parked without consuming capacity.
7. Revalidate origin, tenant, and exact requisition after every redirect.
8. Keep `inactive` as the exact local page observation, but do not claim that
   Trackly stored a disposition its active contract does not expose. Under MCP
   contract 3.7.3, persist and checkpoint the conservative non-counting
   `unknown_unobservable` disposition with `applicantControlsObserved: false`,
   and report the local inactive reason separately without raw page text. Use a
   future exact `inactive` disposition only when the fetched contract exposes
   it. Preserve a typed control-plane conflict rather than inventing a
   replacement run.

## Provider evidence

| Provider or pattern | Insufficient | Accessible | Blocker |
|---|---|---|---|
| Greenhouse | Job description or Apply button | Editable name/contact or equivalent applicant controls on the exact tenant and requisition | Login or challenge before fields |
| Ashby | Overview tab | Application tab with editable applicant controls | Account or challenge before controls |
| Workday | Start Application modal or Apply Manually choice | Actual applicant-data page without a credential wall | Create Account, Sign In, OTP, or pre-form challenge means `account_creation_required`, `authentication_required`, `otp_required`, or `captcha_before_form` |
| Adobe or Microsoft style | Readable guest landing page or application shell | Editable applicant controls before login | Login before fields means `authentication_required` |
| Amazon | Job description and Apply button | Editable applicant fields before Amazon Jobs authentication | Amazon sign-in means `authentication_required` |

When browser and accessibility surfaces disagree, use
`unknown_unobservable`. Never upgrade uncertainty to accessibility.
