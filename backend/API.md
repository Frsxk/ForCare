# Implemented backend API

Base path: `/api/v1`. This reference covers the implemented backend: identity, profiles, clinical sources/care instructions, check-ins, observations and assessment availability. Frontend integration, booking, AI analysis, notifications and push delivery are pending. Numerical scoring is explicitly unavailable until its clinical policy is approved.

## Browser session contract

Use a same-origin HTTPS frontend/proxy and configure its exact origin in `AUTH_ALLOWED_ORIGINS`. Send cookies with requests. Cross-origin CORS deployment is not configured.

- Registration and login set `__Host-forcare_session`: HttpOnly, Secure, SameSite=Lax, Path=/, no Domain.
- Sessions expire 24 hours after creation, without refresh. A successful login creates a separate session; logging out one session does not log out other devices.
- Every POST/PUT/PATCH/DELETE request needs an exact allowed `Origin`. Login/register are pre-session; all other unsafe authenticated requests also need `X-CSRF-Token` from the current session response.
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

`GET /patients?scope=assigned&search=...&limit=20&cursor=...` requires an eligible nurse. Scope is required. Search matches display name or record number inside active primary grants only, before pagination. It never searches NIK. The response has `data.scope`, `data.items` and `data.page`. Items contain `id`, `displayName`, `recordNumber`, `latestCheckIn` and `nextVisit: null`. `latestCheckIn` is null until a report is submitted; otherwise it contains that report’s `id`, `condition`, `localDate` and `submittedAt`. Private drafts are excluded. Visits remain absent.

`GET /patients/:patientId/summary` requires a current primary grant and returns the same summary fields plus the count of current published order heads whose status is `active`. This count is status-based; patient care-guide/order reads additionally enforce the effective time window.

`GET /patients/:patientId?scope=assigned` returns a limited profile projection: `id`, `displayName`, `recordNumber`, `version`, `access`, `profile:{birthDate,gender}`, `primaryNurse`, `availableSections:["profile","care_guide"]`. It includes no NIK, insurance, chart body or internal notes. Another nurse's patient returns 404 `NOT_FOUND`.

List `request_intake` and `visit:<id>` scopes are gated (503 `GATE_UNAVAILABLE`, G03/G04). Patient detail does not allow intake scope; visit-scoped detail is G04-gated. Those grants never widen into primary chart access.

Lists default to 20, maximum 100. Cursors expire after 15 minutes and bind to the account, session, scope and search filter; keep them opaque and do not reuse them across logins or filters.

## Capabilities and limits

`GET /capabilities` requires authentication. Identity, profiles, patient scope, nurse directory, clinical records and check-ins are enabled. Assessment/scoring, analysis and retrieval/push remain gated; availability/bookings are missing. The assessment read endpoint is available to report the unavailable score state, not to calculate a numerical score.

Rate limits return 429 `RATE_LIMITED` with `Retry-After`: login 5 attempts per IP/email per 15 minutes plus 30 per IP, registration 3 per IP per hour, authenticated requests 120 per account per minute. Limits are per process and use the direct socket address, not forwarded headers. Run one API process; proxy-aware client IP policy and shared limiting remain deployment work.

## Medical records and care instructions

These routes implement the synthetic demo's explicit primary-nurse approval policy. They record source-backed information; they do not create prescriptions, provide a global reference corpus, or run AI analysis. Intake/visit grants do not authorize these clinical routes.

All domain writes below require Origin, cookie, CSRF and `Idempotency-Key`. Server-owned actors and approval fields are rejected in request bodies. Content corrections create new UUIDs and immutable revision numbers; `version` is a separate workflow counter.

### Medical record snapshots

Current primary nurse only:
- `POST /patients/:patientId/medical-record-versions`
- `GET /patients/:patientId/medical-record-versions?limit=&cursor=`
- `GET /patients/:patientId/medical-record-versions/:id`

Patients cannot read raw snapshots. A snapshot's internal note is never copied into patient care projections. POST returns 201. Example first snapshot:

```json
{
  "expectedVersion": 0,
  "sourceReference": "Synthetic discharge fixture; software demonstration only",
  "payload": {
    "primaryDiagnosis": null,
    "secondaryDiagnoses": [],
    "admittedAt": null,
    "dischargedAt": null,
    "allergies": [],
    "procedures": [],
    "complaints": null,
    "observations": [],
    "internalNote": "Synthetic staff-only note"
  }
}
```

Every payload field shown is required; null/empty means not recorded, not medically ruled out. `sourceReference` is a manually entered label, not a URL to fetch. `admittedAt`/`dischargedAt`, when supplied, must be UTC timestamps. Source observation entries accept `type`, optional `value`, `unit`, `observedAt`; these are manual source facts, separate from typed patient check-in measurements below.

The response includes `id`, `patientId`, `revisionNumber`, `supersedesId`, `sourceReference`, `payload`, `recordedAt`, `enteredBy`, `version`. The first revision is 1; `version` remains 0 for immutable snapshot content. For a correction, send the latest `revisionNumber` as `expectedVersion` and that snapshot's ID as `supersedesId`, plus the complete replacement snapshot. A stale predecessor returns 409. Old records remain readable to the current primary nurse.

### Patient-bound source revisions

Current primary nurse only:
- `POST /clinical-sources`
- `GET /clinical-sources/:id`
- `PATCH /clinical-sources/:id`
- `POST /clinical-sources/:id/publish`

Create body:

```json
{
  "patientId": "<patient UUID>",
  "medicalRecordVersionId": "<current medical snapshot UUID>",
  "kind": "activity",
  "title": "Synthetic activity source",
  "body": "Synthetic source text for software verification."
}
```

Both patient and medical-record bindings are required. `kind` is `protocol|medication|wound_care|diet|activity|danger_sign`. Optional `supersedesId` selects the current source-lineage head. No source is approved by creation.

PATCH takes `{expectedVersion,medicalRecordVersionId,kind,title,body}`. It derives the patient/lineage from the selected resource and returns 201 with a new draft UUID; it never edits the old content. Drafts can be corrected before approval. Source responses contain the immutable `revisionNumber`, mutable `version`, `status`, checksum, predecessor and approval provenance.

Publish takes `{expectedVersion}`. First publication checks the current primary grant, medical snapshot, source head and exact version. A draft superseded by a correction cannot be published instead of that correction. An already-approved revision returns its original approval after current access checks, without rechecking its old version/snapshot/head; this does not publish new content. Global clinical-source approval is not enabled; even `protocol` sources are patient-bound and excluded from the patient guide.

### Existing care orders and patient projections

- `POST /orders`: primary nurse; body `{patientId,kind,sourceDocumentId,sourceVersion,payload,effectiveFrom,effectiveTo?,supersedesId?}`.
- `GET /orders/:id`: primary nurse can recover drafts/history; the owning patient sees only the current published `active` revision inside its effective window. Superseded, cancelled, future-effective and expired revisions return 404 to patients.
- `PATCH /orders/:id`: primary nurse; `{expectedVersion,kind,sourceDocumentId,sourceVersion,payload,effectiveFrom,effectiveTo?}` creates a new draft revision.
- `POST /orders/:id/publish`: primary nurse; `{expectedVersion,status:"active|completed|cancelled"}` explicitly publishes that revision/decision.
- `GET /patients/:patientId/orders?limit=&cursor=`: self/current primary; paginated current published heads, with active/effective filtering for patients.
- `GET /patients/:patientId/care-guide`: self/current primary; approved patient-facing source revisions and currently active/effective order heads.

`kind` is `medication|followup|care`. `sourceDocumentId` + `sourceVersion` must reference the current approved source head for the same patient and current medical snapshot. Creation, replacement and first publication all enforce this binding. An approved source correction or a new medical snapshot makes affected old pending order drafts stale (409); an unapproved correction draft does not replace the approved head. Historical approved content remains unchanged.

Order payload keeps a required plain-text `instructions` field and optional ordered items:

```json
{
  "instructions": "Synthetic instructions entered by the nurse.",
  "items": [
    {"type":"activity","text":"Synthetic first instruction."},
    {"type":"followup","text":"Synthetic second instruction."}
  ]
}
```

Item types are `medication|storage|wound_care|device_care|diet|activity|danger_sign|first_aid|followup`. They preserve manual wording and order; no dose or clinical plan is inferred. Patient order projections retain `id`, `kind`, `revisionNumber`, `version`, source references, instructions/items, effective window and status, but omit staff-only provenance. Raw snapshots/internal notes are never included.

The guide response contains `patientId`, `sources`, `sourceVersions`, `orders`. Its order projection is capped at 100; use the paginated orders route for larger collections. It is not an emergency or medication-dispatch service.

## Patient check-ins

The owning patient creates, edits and submits reports. Nurses can read only submitted reports for currently assigned patients; even the primary nurse cannot read a private draft.

- `POST /check-ins` → 201 private draft.
- `GET /check-ins?status=draft|submitted&limit=&cursor=` → own reports; omit status to list both.
- `GET /check-ins/:id` → owner draft/submission, or current primary nurse's submitted report.
- `PUT /check-ins/:id` → full draft replacement.
- `PATCH /check-ins/:id` → partial draft update.
- `POST /check-ins/:id/submit` → immutable submitted report.
- `GET /patients/:patientId/check-ins?limit=&cursor=` → submitted reports for self/current primary.

Strict POST example (all four editable fields required):

```json
{
  "condition": "ok",
  "note": null,
  "medicationAdherence": "regular",
  "observations": [
    {"type":"temperature_c","value":36.8,"unit":"c","observedAt":"2026-11-13T12:00:00Z"}
  ]
}
```

`condition` is exactly `ok|complaint`; medication adherence is the scalar `regular|missed_once|none`, not a per-medication array. `note` may be null. Missing measurements are omitted from the observations array; they are never replaced by zero or a normal value.

Observation type/unit pairs:
- `temperature_c` → `c`
- `heart_rate_bpm` → `bpm`
- `bp_systolic_mmhg`, `bp_diastolic_mmhg` → `mmhg`
- `weight_kg` → `kg`
- `spo2_pct` → `pct`

Units are exact lowercase tokens. Values must be finite, positive and representable as `numeric(8,3)` without rounding (at most three decimal places). These are storage checks, not approved clinical ranges or alert thresholds. Each type appears at most once in a report. Measurement timestamps require UTC `Z`, with zero or three fractional digits.

The server derives patient identity, local date and time zone from the session; do not send them. Only one draft is allowed per patient/local day (409 `VERSION_CONFLICT`, `details.reason="DRAFT_EXISTS"`). PUT requires `expectedVersion` and all four editable fields. PATCH requires `expectedVersion` and at least one editable field; omitted values and observation IDs remain unchanged, while a supplied array replaces the whole observation set.

Submission takes `{expectedVersion}`. Exact-key retries replay the original outcome; a new key still has to satisfy current version rules. Both submitted parent content and observation/adherence child membership are immutable at the database boundary. PUT/PATCH after submission return 409 `INVALID_TRANSITION`.

To correct a submitted report, create a new draft with `supersedesCheckInId` referencing an owned submitted report. The original remains. Responses include `id`, `patientId`, `localDate`, `timeZone`, `version`, `status`, `condition`, `note`, scalar `medicationAdherence`, observations with stable IDs, `supersedesCheckInId`, `submittedAt`, `createdAt`, `updatedAt`. Cursor filters are bound to status as well as session/ownership.

## Observations, confirmation and score availability

`GET /patients/:patientId/observations?type=&limit=&cursor=` is self/current primary only. Its `data` shape is:

```json
{
  "latestObservation": {"id":"<observation UUID>","checkInId":"<report UUID>","type":"temperature_c","value":36.8,"unit":"c","observedAt":"2026-11-13T12:00:00Z","source":"patient_check_in"},
  "lastConfirmed": null,
  "history": {"items":[],"page":{"nextCursor":null,"hasMore":false}},
  "trend": {"status":"unavailable","reason":"G02_NOT_APPROVED"}
}
```

Only submitted measurements enter this view. `latestObservation` stays the newest recorded patient value; `lastConfirmed` is separately selected by confirmation time. Confirming an older observation never changes the patient's original measurement or turns it into a new value.

`POST /observations/:id/confirm` is current-primary only; body `{expectedVersion,note?}` binds the exact submitted check-in version. It creates one append-only confirmation; an exact repeat returns the stored confirmation, while a different decision returns 409. The staff response can include its internal note. Patient `lastConfirmed` is flat `{value,unit,observedAt,confirmedAt,confirmedByStaffId,observationId,checkInId}` and excludes that note. This confirms a recorded observation, not a clinical scoring policy.

`GET /patients/:patientId/assessments?limit=&cursor=` is self/current primary only:

```json
{
  "patientId": "<patient UUID>",
  "score": {"status":"unavailable","reason":"G02_NOT_APPROVED"},
  "lastConfirmedAssessment": null,
  "history": {"items":[],"page":{"nextCursor":null,"hasMore":false}},
  "trend": {"status":"unavailable","reason":"G02_NOT_APPROVED"}
}
```

History exposes bounded non-numeric metadata only. No formula, thresholds, instrument seed, numeric score, automatic improvement, AI assessment, or public instrument-approval/score-writing endpoint exists. An operator-inserted row cannot enable numerical output. New timestamp columns use millisecond precision to match API/cursor serialization, with UUIDs breaking ties.

## Controlled operator operations

The operator CLI can assign a staff-reviewed record number to an already-owned profile and assign/reassign a primary nurse with `expectedVersion` and an approval reference. Assignment synchronizes the primary nurse, active/revoked grants, redacted audit event and outbox event transactionally. No public admin route exists. There is no unowned hospital-record import, account merge, automatic RM/NIK matching or patient-to-nurse conversion. See [README.md](README.md#identity-operations) for commands.
