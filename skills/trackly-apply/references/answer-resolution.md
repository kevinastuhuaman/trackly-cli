# Deterministic answer resolution

Run this resolver after reading the current application-profile revision and
inventorying a visible employer form, but before generating that form's
question packet or writing an answer. Profile onboarding that happens before
an employer form exists uses the profile schema's field metadata instead.
This resolver reduces questions without weakening truthfulness.

## Resolution pipeline

For each visible question:

1. Normalize its label, help text, expected input type, choices, employer scope,
   jurisdiction, and whether it is required.
2. Map it to one exact current schema key. Do not map by a single keyword.
3. Resolve one authority class:
   - `exact_profile`: an answered canonical key with matching scope and type.
   - `safe_derivation`: a deterministic derivation allowed below.
   - `supported_draft`: free text whose every factual claim has evidence.
   - `missing_fact`: no authoritative value exists; ask at point of use.
   - `live_consent`: a notice, acknowledgement, certification, or choice that
     must be made against the current form.
   - `forbidden_inference`: a legal, identity, relationship, or specialized
     claim that cannot be inferred.
4. Validate the expected input type before translating or committing a value.
5. Fill only the first three classes. Put only visible `missing_fact`,
   `live_consent`, and user-resolvable `forbidden_inference` items in one
   grouped question packet with expected type and scope.

Keep this value-free local provenance for each resolved control: profile
revision, schema key, scope, authority class, derivation rule when any,
expected type, and committed-control receipt. Never send the answer value in
an observation.

## Typed answer-memory lookup

Before asking, query every applicable scope in this narrow-to-broad order:
run-only live choice, exact question and version, exact office, jurisdiction,
company, provider, then global. A candidate is reusable only when its canonical
intent, type, sensitivity, question version when applicable, and permitted
scope all match. The first compatible narrower answer wins; an answer never
flows to a broader scope without explicit user confirmation.

Question-ontology aliases, semantic retrieval, and form-schema history may
identify candidate canonical intents, but they are not answer authority. Exact
typed profile or contextual state must still resolve the value. Fail closed to
`missing_fact`, `live_consent`, or `forbidden_inference` when intent, type,
scope, version, or confidence is ambiguous. Record only per-scope counts and a
lowercase SHA-256 over value-free lookup inputs and decisions; never hash or
persist labels, answers, page text, or private values in the checkpoint.

## Source precedence

The current profile revision is the only reusable answer authority. A
transcript or conversation, screenshot, parser output, browser autocomplete,
or cached value is never authority. Resume parsing is a suggestion only: it may
help identify a schema key, but the parser never becomes authority and never
overwrites an answered profile value or a user-edited control.

For a frozen batch, distinguish its frozen profile revision (the audit and
certification baseline) from the current bounded snapshot projection used to
resolve visible answers. A later scoped answer may legitimately appear in the
current projection while the frozen baseline number remains unchanged. Do not
treat that difference as corruption, do not silently substitute the stale
baseline value, and do not mutate until the current work receipt authorizes the
projection and certification behavior.

Contact details and addresses must resolve from exact current profile keys.
Verify their live committed state even when the browser initially displays a
masked or formatted value.

For an ordinary application name, use the canonical first and last name and
reconcile parser-created casing. A government-ID full legal name is different:
use it only when the form explicitly asks for a government-ID or legal-document
name and the dedicated restricted profile field is explicitly answered. Never
derive it from ordinary name fields.

Employment status outranks legacy employer columns. When status is
`not_employed`, current company and current title are non-authoritative even if
legacy values remain populated. For a current-employer control, commit boolean
No, an exact “Not currently employed” option, or an intentionally blank optional
text control according to the visible control semantics. Ask only when a
required control offers no truthful non-employed representation. Answer
prior-employer questions from
`employment.most_recent_company` and `employment.most_recent_title`, and leave current-employer
questions unresolved unless the schema supplies an applicable authoritative
answer. `student`, `other`, or unknown status fails closed when applicability
is ambiguous.

## Safe experience derivation

Read the wording semantically:

- A minimum qualification/profile range asks whether experience meets the
  lower threshold. A profile value of 7 years answers “2–4 years?” as Yes when
  the choices mean “at least 2 years” or a qualification bracket.
- An exact bounded band asks whether the value lies inside both bounds. With 7
  years, “exactly between 2 and 4 years?” is No.
- An explicit disqualifying maximum is a ceiling. With 7 years, “no more than 4 years?” is No.

Never infer specialized experience from total product-management tenure.
Financial-infrastructure years, growth-focused software PM years, enterprise
SaaS PM years, health-tech experience, and named platform/tool experience need
their own schema keys or an explicit user answer.

Type must match the control. Returning Yes for “financial-infrastructure
years” is a type mismatch; ask for a whole number. Returning C2 for SQL
proficiency is a type mismatch when the field expects a proficiency enum.
English C2 is valid when the English field expects a CEFR level. Never coerce a
type mismatch into a plausible-looking answer.

## Employer relationships and legal boundaries

A direct prior-employment No may be derived only under the complete-history
rule in the main skill. It never proves no contractor, affiliate, subsidiary,
acquisition, family, friendship, referral, or other relationship. Those need
an exact matching scoped field or a user answer.

Region authorization is separate from country authorization. A region may be
answered Yes only when it is explicitly present in
`authorization.legally_authorized_regions`; absence is unknown, never No, and a
region answer must not be stored under a country jurisdiction.

Commute willingness and days-per-week commitments are employer-office facts,
not company-wide facts. Resolve them only from an exact `office` scope whose
identity combines the backend company ID and the specific office; another
office at the same employer remains unknown.

A named applicant privacy notice may be acknowledged only as the current
notice policy allows and with its current fingerprint. Marketing, data
retention, arbitration, background check, and interview recording are separate
choices. Onsite willingness does not prove that a workplace policy was read or
accepted. Truthfulness certification is always per-run and never reusable.

## Supported writing

For a useful optional motivation or experience prompt, `supported_draft` means
fill it when every factual claim is supported. Build from canonical facts and
evidence claims, state explicit gaps instead of inventing bridge facts, match
the saved voice rules, lint, commit, and reread. The user's final truth review
still governs the complete review-ready subset.

Ask the user only for a genuinely new fact, subjective choice, live consent,
or unsupported claim that the visible application requires. A visible employer
accuracy checkbox is a live consent resolved before the review-ready
checkpoint; the separate Trackly truth certification is requested only
afterward for the exact durable review-ready subset. Defer reusable
gaps that no current visible form needs.
