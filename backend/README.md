# ForCare backend

The backend uses Bun, Elysia and LangChain TypeScript. Follow the [root README](../README.md) to run it with PostgreSQL in Docker.

## Development checks

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

`bun run dev` starts a watched server; `bun run start` starts it without watch. Native execution needs a PostgreSQL instance and the environment settings below. The Compose database has no host port, so a native process cannot reach it at `localhost:5432`.

## Endpoints

- `GET /`: returns `Hello Elysia`.
- `GET /health/live`: returns `200` without contacting PostgreSQL or AI.
- `GET /health/ready`: runs `SELECT 1`, then returns `200`. It returns `503` if the database probe fails, without exposing connection details.

The `/api/v1` routes cover accounts/sessions, owned profiles, nurse directory and patient scope, versioned medical records, patient-bound clinical sources and care instructions, check-in drafts/submissions, observation history/confirmation, assessment availability metadata, approved knowledge search, and asynchronous cited analysis drafts. Authenticated mutations require CSRF; domain writes also require `Idempotency-Key` and version checks where specified. Analysis generation is only a draft: the current primary nurse must review it, graph reconciliation must complete, and publication is a separate explicit write. Patients see only published patient-facing projections, never raw medical snapshots or internal notes. Numerical scoring is gated; booking, notifications and push are absent. [API.md](API.md) lists the exact payloads and access rules.

## Environment

- `HOST`: default `127.0.0.1`; Compose sets `0.0.0.0` inside the container.
- `PORT`: native default `3001`; container port `3000`.
- `DATABASE_HOST`: default `db`. Use your database hostname for native development.
- `DATABASE_PORT`: default `5432`.
- `POSTGRES_DB`, `POSTGRES_USER`: default `forcare`.
- `POSTGRES_PASSWORD`: required. The SQL client receives it as a separate connection field, not part of a URL.
- `AI_ENABLED`: `true` or `false`, default `false`.
- `AI_API_KEY`, `AI_MODEL`: required when AI is enabled.
- `AI_BASE_URL`: optional HTTPS Chat Completions endpoint. HTTP is accepted only for loopback development endpoints. Credentials, query strings and fragments are not allowed in the URL.
- `AI_TIMEOUT_MS`: integer from `1` to `120000`, default `30000`. Provider retries are disabled.
- `GOOGLE_API_KEY`: required by the analysis worker only; never supplied by the browser.
- `AUTH_ALLOWED_ORIGINS`: required comma-separated exact origins. Production origins must be HTTPS; there is no wildcard or guessed default.
- `AUTH_SESSION_SECRET`: required at least 32 characters for session IP hashing and cursor signing.
- `AUTH_NURSE_EMAIL_DOMAIN`: optional exact nurse email domain. Leave unset to block nurse provisioning and nurse login; this deployment's approved synthetic value is `nurse.invalid`.
- `AUTH_LOCAL_HTTP_TEST`: `true` only for loopback HTTP tests; it is rejected when `HOST` is not loopback.

`BACKEND_PORT` controls the Compose host port, not the container listener. Compose disables `LANGSMITH_TRACING` and `LANGCHAIN_TRACING_V2`.

Run migrations first, then start `bun run worker:analysis` as a separate process. The worker owns its LangGraph `PostgresSaver` setup, uses bounded PostgreSQL leases/attempt receipts, and resumes persisted review interrupts. It does not publish analyses. The API can persist reviews without a running worker; publication remains unavailable until a worker reconciles that exact gate.

Rate limits are per API process. Cursors use the configured secret, expire after 15 minutes and are bound to the account, session, scope and filter. Run one API process until a shared limiter exists. Limits are 5 login attempts per IP/email pair per 15 minutes, an additional 30 login requests per IP per 15 minutes, 3 registrations per IP per hour, and 120 authenticated requests per account per minute. A full limiter rejects new buckets rather than evicting active limits. Client addresses come from the direct socket, not `X-Forwarded-For`; a same-host proxy therefore shares its IP limit across clients until a trusted-proxy policy is configured.

API JSON bodies are limited to 32 KiB. The application returns a structured 413 for that limit. Bun also has a 64 KiB transport backstop, which may return a bare 413 before routing; clients must inspect the HTTP status before parsing JSON. `AUTH_LOCAL_HTTP_TEST` allows loopback HTTP origins only and never relaxes the Secure cookie. Native HTTP test clients must manage that cookie explicitly; browser HTTPS/proxy integration remains separate.

For native commands, supply a private environment or use Bun's `--env-file` option. An optional blank setting in a native environment file is not necessarily equivalent to an unset variable; the root Compose file supplies its own defaults.

## Database migrations and integration tests

Run `bun run migrate` with the database environment configured before using the account API. It applies each pending migration from `0001_identity` through `0005_assessments` transactionally and verifies checksum history on repeat runs. It never seeds demo users. Do not edit an applied migration file.

`bun run test:integration` runs migration, authentication, patient-scope, clinical-record, check-in, schema-contract and assessment-availability checks. It requires `FORCARE_TEST_DATABASE_URL` pointing to a dedicated loopback database with an explicit non-5432 port and a name ending in `_test`. The test role must be allowed to create/drop the suite's temporary databases on that isolated server. Do not use a production or shared application database. The command fails if opt-in is missing; ordinary `bun test` skips live database suites. The LangGraph checkpoint suite has its own opt-in below.

See [API.md](API.md) for implemented routes, request examples and error handling.

## Identity operations

`bun run seed:demo -- --confirm synthetic-demo-nurses --output /absolute/private/path/demo-nurses.json --operator <name> --approval-ref <reference>` provisions only the three approved synthetic nurses when `AUTH_NURSE_EMAIL_DOMAIN=nurse.invalid`. It writes generated passwords to a new mode-0600 file outside the repository, requires all three identities to be free, and changes nothing on collision. It never prints passwords and never runs at startup.

`bun run patient:assign -- record --patient-id <uuid> --record-number RM-2026-001 --expected-version <n> --operator <name> --approval-ref <reference>` assigns a staff-reviewed display record number to an already-owned patient profile. `primary` uses `--nurse-id <uuid>` instead and atomically updates the primary nurse, primary access grant and revoked prior grant. Neither command accepts NIK, auto-matches RM, merges accounts or exposes an HTTP admin route.

## LangChain check

`bun run ai:smoke` runs a fixed, non-medical connectivity check. It exits nonzero when disabled, misconfigured or unsuccessful. It does not accept patient input, grant tools, write records or run clinical analysis.

The tests use synthetic responses from a local HTTP server. An actual model connection requires your own provider credential.

## Checkpoint integration check

`bun run test:checkpoint` runs the LangGraph interrupt/restart spike against a real PostgreSQL server. It needs `FORCARE_CHECKPOINT_TEST_DATABASE_URL`, a dedicated loopback database whose name starts with `forcare_checkpoint_test`. The port must be explicit and must not be 5432. There is no `DATABASE_URL` or `.env` fallback, and the script exits nonzero when the variable is missing or unsafe. Plain `bun test` skips the integration suite.

The fixture stores synthetic draft ids and publication markers only. It proves that a paused graph can be resumed by a separate process and that duplicate resumes keep one publication row. It performs structural binding checks between the pause and the decision, not user authentication or domain authorization.

A failed task retains its first resume payload in the tested LangGraph version. The tests characterize explicit re-entry with a fresh nonce; they do not implement the application's review-recovery policy.
