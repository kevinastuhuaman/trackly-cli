# Access probe

Treat provider hints as scheduling input only. Start from the frozen requisition,
verify HTTPS, company, role, requisition, origin, and tenant, then follow ordinary
application-entry controls without changing applicant fields or transmitting
private data.

Use these states:

- `requisition_loaded`
- `apply_entry_found`
- `intermediate_apply_shell`
- `applicant_fields_reached`
- `authentication_required`
- `account_creation_required`
- `otp_required`
- `captcha_before_form`
- `captcha_at_submit`
- `inactive`
- `manual_only`
- `unknown_unobservable`

An Apply button, chooser, modal, overview, readable guest page, or application
shell remains `intermediate_apply_shell`. Count access only after semantically
editable applicant controls prove `applicant_fields_reached`. Workday Create
Account is `account_creation_required`; Amazon, Adobe, or Microsoft login before
fields is `authentication_required`. Park pre-form login, account, OTP, CAPTCHA,
manual-only, inactive, and unobservable states without beginning a draft. A
submit-time CAPTCHA may remain reviewable because the user owns Submit.

Never enter credentials, create an account, solve OTP/CAPTCHA, or enter private
data during the probe. Revalidate identity after every redirect. When browser
and accessibility evidence conflict, use `unknown_unobservable`, never access.
