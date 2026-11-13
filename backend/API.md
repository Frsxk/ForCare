# Implemented identity and profile API

Base path: `/api/v1`. This reference covers the implemented backend only. The frontend integration, booking, clinical records, check-ins, analysis, notifications and push delivery are not available yet.

## Browser session contract

Use a same-origin HTTPS frontend/proxy and configure its exact origin in `AUTH_ALLOWED_ORIGINS`. Send cookies with requests. Cross-origin CORS deployment is not configured.

- Registration and login set `__Host-forcare_session`: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain.
- Sessions expire 24 hours after creation, without refresh. A successful login creates a separate session; logging out one session does not log out other devices.
- Every POST/PATCH request needs an exact allowed `Origin`. Login/register are pre-session; all other unsafe authenticated requests also need `X-CSRF-Token` from the current session response.
- The server stores session and CSRF hashes only. It can derive the same CSRF token from the opaque session cookie when `/auth/session` is read.
- Public signup always creates a patient, even for an address at `nurse.invalid`. Never send a role selector. Nurses must be provisioned by the operator.

Success responses are `{ "data": ..., "requestId": "<uuid-v4>" }`. Errors are `{ "error": { "code": "...", "message": "...", "requestId": "<uuid-v4>", "details": {} } }`, with `details` omitted when absent. API responses set `Cache-Control: no-store` and `X-Request-Id`. A valid UUID-v4 `X-Request-Id` is echoed; otherwise the server generates one. Logout returns 204 without JSON.

JSON request bodies are limited to 32 KiB. The application returns 413 `PAYLOAD_TOO_LARGE` above that size. Bodies above Bun's separate 64 KiB transport backstop may receive a bare 413 before routing. Inspect the HTTP status before parsing JSON. Unknown body fields return 422 `UNKNOWN_FIELD`; validation messages name fields rather than echoing submitted values.

## Register and log in

`POST /auth/register` accepts exactly:

```json
{
  "fullName": "Synthetic Patient",
  "birthDate": "1990-03-12",
  "gender": "undisclosed",
  "email": "patient@example.invalid",
  "phone": "+628000000001",
  "password": "<locally chosen password>"
}
```

All fields are required. `gender` is `male|female|other|undisclosed`; `birthDate` must be a real, non-future calendar date. Password length is 8–128 characters. Email is trimmed and lowercased. The account, patient profile and session are created in one transaction. A duplicate email returns generic 409 `REGISTRATION_UNAVAILABLE`, whether the existing account is a patient or nurse.

The 201 response has this shape; angle-bracket values below describe server-generated values, not literal request data:

```json
{
  "data": {
    "account": { "id": "<uuid-v4>", "email": "patient@example.invalid", "status": "active", "roles": ["patient"] },
    "patientProfile": { "id": "<uuid-v4>", "fullName": "Synthetic Patient", "recordNumber": null },
    "session": { "csrfToken": "<opaque>", "expiresAt": "<UTC ISO timestamp>" }
  },
  "requestId": "<uuid-v4>"
}
```

`POST /auth/login` takes only `{ "email": "...", "password": "..." }`. Success is 200 with `account`, `session` and `access`. Invalid credentials, disabled accounts and ineligible nurse identities return the same 401 `INVALID_CREDENTIALS`.

`GET /auth/session` requires the cookie. It returns `account`, `session`, `access`, `displayTimeZone`, `expiresAt` and `capabilities`. Keep `session.csrfToken` for authenticated writes. A revoked/missing session returns 401 `UNAUTHENTICATED`; an expired one returns 401 `SESSION_EXPIRED`.

`POST /auth/logout` accepts an empty body or `{}` and returns 204 after server-side revocation and cookie clearing. The optional UUID `pushSubscriptionId` is accepted for the future contract, but this implementation has no push subscription resources to revoke. It never prevents session logout.

## Own profile and contact editing

`GET /me/profile` derives identity from the session. It accepts no patient selector.

Patient `data` fields:

```json
{
  "role": "patient",
  "id": "<patient uuid>",
  "accountId": "<account uuid>",
  "fullName": "Synthetic Patient",
  "birthDate": "1990-03-12",
  "gender": "undisclosed",
  "phone": "+628000000001",
  "addressLine": null,
  "emergencyContactName": null,
  "emergencyContactPhone": null,
  "recordNumber": null,
  "primaryNurse": null,
  "version": 0
}
```

Nurse `data` contains `role`, `id`, `accountId`, `staffCode`, `displayName`, `discipline`, `email`, `phone`, `displayTimeZone` and `version`. A nurse may read their own email/phone; the public nurse directory never includes those fields.

`PATCH /me/profile` requires the cookie, Origin, CSRF token and `Idempotency-Key`. For example:

```http
PATCH /api/v1/me/profile
X-CSRF-Token: <current session CSRF>
Idempotency-Key: <fresh UUID-v4>
Content-Type: application/json
```

```json
{ "expectedVersion": 0, "phone": "+628000000002", "addressLine": "Synthetic address" }
```

Patients may edit `phone`, `addressLine`, `emergencyContactName`, `emergencyContactPhone`. Optional contacts can be cleared with null; patient `phone` cannot be null. Nurses may edit only `phone`, including null to clear it. At least one editable field is required. Name, birth date, account/role/patient IDs, RM, NIK and clinical fields are rejected. Success returns the updated own-profile shape with an incremented version.

- A stale version returns 409 `VERSION_CONFLICT`, with `error.details.currentVersion`.
- A key may be UUID-v4 or 32–128 URL-safe characters. Missing/invalid key returns 400 `IDEMPOTENCY_KEY_REQUIRED`.
- Within 24 hours, the same actor/session/method/resource/key and body replays the stored data/status after fresh authentication and CSRF checks. The envelope gets the current request ID. A different body with that key returns 409 `IDEMPOTENCY_CONFLICT`.
- A key from another session is not the same receipt. Revoked sessions cannot replay anything.

## Directory, access and assigned patients

`GET /nurses?limit=20&cursor=...` is available to authenticated patients and nurses. It returns:

```json
{
  "data": {
    "items": [
      { "id": "<staff uuid>", "displayName": "Ayu Pratama", "staffCode": "NUR-001", "workingWindowSummary": null, "active": true }
    ],
    "page": { "nextCursor": null, "hasMore": false }
  },
  "requestId": "<uuid-v4>"
}
```

Only active accounts with an active, approved nurse identity matching the exact configured domain are listed. Availability is not built, so `workingWindowSummary` is null. The approved synthetic seed creates Ayu Pratama (`ayu@nurse.invalid`), Bima Santoso (`bima@nurse.invalid`) and Citra Lestari (`citra@nurse.invalid`). Passwords are generated privately, never fixed in source.

`GET /me/access` returns `scopes` and `accessContexts`. Patients have `patient:self`; the directory is also intentionally patient-accessible. Nurses have `nurse:directory`, plus scopes derived from their actual active grants: `primary` → `nurse:assigned`, `request_intake` → `nurse:request_intake`, `visit` → `nurse:visit`. A reported grant is not a promise that its future booking/visit API is implemented. Expired/revoked grants are excluded. Capabilities and resource checks still apply.

`GET /patients?scope=assigned&search=...&limit=20&cursor=...` requires an eligible nurse. Scope is required. Search matches display name or record number inside active primary grants only, before pagination. It never searches NIK. The response has `data.scope`, `data.items` and `data.page`. Items contain `id`, `displayName`, `recordNumber`, `latestCheckIn: null`, `nextVisit: null`; monitoring and visits are absent.

`GET /patients/:patientId/summary` requires a current primary grant and returns the same summary fields plus `activeOrderCount: 0` because no order records exist yet.

`GET /patients/:patientId?scope=assigned` returns a limited profile projection: `id`, `displayName`, `recordNumber`, `version`, `access`, `profile:{birthDate,gender}`, `primaryNurse`, `availableSections:["profile"]`. It includes no NIK, insurance, chart body or internal notes. Another nurse's patient returns 404 `NOT_FOUND`.

List `request_intake` and `visit:<id>` scopes are gated (503 `GATE_UNAVAILABLE`, G03/G04). Patient detail does not allow intake scope; visit-scoped detail is G04-gated. Those grants never widen into primary chart access.

Lists default to 20, maximum 100. Cursors expire after 15 minutes and bind to the account, session, scope and search filter; keep them opaque and do not reuse them across logins or filters.

## Capabilities and limits

`GET /capabilities` requires authentication. `identitySessions`, `patientProfiles`, `patientScope` and `nurseDirectory` are enabled. Availability/bookings are missing; clinical records, scoring, analysis, retrieval and push remain missing/gated. There are no numerical score placeholders.

Rate limits return 429 `RATE_LIMITED` with `Retry-After`: login 5 attempts per IP/email per 15 minutes plus 30 per IP, registration 3 per IP per hour, authenticated requests 120 per account per minute. Limits are per process and use the direct socket address, not forwarded headers. Run one API process; proxy-aware client IP policy and shared limiting remain deployment work.

## Controlled operator operations

The operator CLI can assign a staff-reviewed record number to an already-owned profile and assign/reassign a primary nurse with `expectedVersion` and an approval reference. Assignment synchronizes the primary nurse, active/revoked grants, redacted audit event and outbox event transactionally. No public admin route exists. There is no unowned hospital-record import, account merge, automatic RM/NIK matching or patient-to-nurse conversion. See [README.md](README.md#identity-operations) for commands.
