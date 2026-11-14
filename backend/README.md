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
- `AI_ENABLED`: `true` or `false`, default `false`; this gates only the non-medical `bun run ai:smoke` CLI. It does not enable or configure the analysis worker.
- `AI_API_KEY`, `AI_MODEL`: required by `ai:smoke` when `AI_ENABLED=true`; they are not the analysis worker's key or model selectors.
- `AI_BASE_URL`: optional HTTPS Chat Completions endpoint for `ai:smoke`, not the fixed analysis provider endpoint. HTTP is accepted only for loopback development endpoints. Credentials, query strings and fragments are not allowed in the URL.
- `AI_TIMEOUT_MS`: integer from `1` to `120000`, default `30000`, used by `ai:smoke` and the analysis worker. Provider retries are disabled.
- `GOOGLE_API_KEY`: required by the separate fixed-Google analysis worker; its models and endpoint are selected in source, not by `AI_MODEL` or `AI_BASE_URL`. Never supply this key to the browser. `ai:smoke` does not use it.
- `AUTH_ALLOWED_ORIGINS`: required comma-separated exact origins. Production origins must be HTTPS; there is no wildcard or guessed default.
- `AUTH_SESSION_SECRET`: required at least 32 characters for session IP hashing and cursor signing.
- `AUTH_NURSE_EMAIL_DOMAIN`: optional exact nurse email domain. Leave unset to block nurse provisioning and nurse login; this deployment's approved synthetic value is `nurse.invalid`.
- `AUTH_LOCAL_HTTP_TEST`: `true` only for loopback HTTP tests; it is rejected when `HOST` is not loopback.

`BACKEND_PORT` controls the Compose host port, not the container listener. Compose disables `LANGSMITH_TRACING` and `LANGCHAIN_TRACING_V2`. The existing Compose file starts only PostgreSQL and the API: it neither passes `GOOGLE_API_KEY` nor starts the analysis worker or frontend. Use a separate private native environment for those processes; do not put the Google key in browser configuration.

Analysis requires the API and worker as separate processes sharing the same PostgreSQL database. After migrations and corpus attestation, start the API with `bun run dev` (watched) or `bun run start`, and independently start `bun run worker:analysis` with the server, database and auth settings plus `GOOGLE_API_KEY`. The worker owns its LangGraph `PostgresSaver` setup, uses bounded PostgreSQL leases/attempt receipts, and resumes persisted review interrupts. The API queues analysis and can persist a nurse's review without a running worker, but saving that review does not publish it. First let the worker reconcile its exact persisted gate; only then make the separate explicit `POST /api/v1/analyses/:id/publish` request described in [API.md](API.md#cited-analysis-drafts). Publication never happens automatically from generation or approval.

Rate limits are per API process. Cursors use the configured secret, expire after 15 minutes and are bound to the account, session, scope and filter. Run one API process until a shared limiter exists. Limits are 5 login attempts per IP/email pair per 15 minutes, an additional 30 login requests per IP per 15 minutes, 3 registrations per IP per hour, and 120 authenticated requests per account per minute. A full limiter rejects new buckets rather than evicting active limits. Client addresses come from the direct socket, not `X-Forwarded-For`; a same-host proxy therefore shares its IP limit across clients until a trusted-proxy policy is configured.

For native loopback HTTP checks, keep `HOST=127.0.0.1` (or another supported loopback spelling such as `localhost`, `::1` or `[::1]`), set `AUTH_LOCAL_HTTP_TEST=true`, and include the exact loopback HTTP origin with its explicit non-default port in `AUTH_ALLOWED_ORIGINS`. Without the explicit HTTP-test flag, allowed origins must be HTTPS. Compose sets `HOST=0.0.0.0`, so it cannot use this loopback-only mode.

The setting permits loopback HTTP origins only and never removes the session cookie's `Secure` or `__Host-` attributes. An API-only native HTTP client can explicitly retain and send that cookie; this is an explanation of the required client behavior, not a reference to a bundled authenticated smoke-client script. Separately, the existing Next.js same-origin `/api/v1/:path*` rewrite provides a browser path for the localhost-only configuration below. Use frontend `http://localhost:3000` and API `127.0.0.1:3001`; a non-default frontend port such as `3400` must instead appear exactly in `AUTH_ALLOWED_ORIGINS`. This path is supported for Chromium on localhost, but it is not a general guarantee for arbitrary browsers, hosts, or HTTP deployments. The setting adds neither cross-origin CORS support nor a trusted-proxy client-IP policy or shared rate limiter. Never disable `Secure` cookies as a workaround; production browser authentication still requires HTTPS.

API JSON bodies are limited to 32 KiB. The application returns a structured 413 for that limit. Bun also has a 64 KiB transport backstop, which may return a bare 413 before routing; clients must inspect the HTTP status before parsing JSON.

For native commands, supply a private environment or use Bun's `--env-file` option. An optional blank setting in a native environment file is not necessarily equivalent to an unset variable; the root Compose file supplies its own defaults.

## Reproducible native localhost demo

This procedure uses only the existing scripts: PostgreSQL 16 in one disposable Docker container, the native API on `127.0.0.1:3001`, Next.js on `http://localhost:3000`, and a separately started native worker. It is separate from Compose, whose database has no host port and whose API cannot enable this loopback-only mode. It creates no ready public accounts, public URL, or deployment. Use synthetic patient data only.

Use Bun **1.4.2** (the backend's pinned `packageManager` version) and locked dependency installs. Create a private environment file outside the repository; do not copy real credentials into documentation or use credentials shared with another environment. The root `.env.example` is only a Compose-variable template, not this complete native configuration or a source of secrets.

```dotenv
# /absolute/private/path/forcare-native-demo.env -- keep outside the repository.
# Generate unique private values locally; never print or commit them.
POSTGRES_PASSWORD=
AUTH_SESSION_SECRET=
# Required only for cited analysis generation; may incur provider charges.
GOOGLE_API_KEY=

POSTGRES_DB=forcare_native_demo
POSTGRES_USER=forcare
HOST=127.0.0.1
PORT=3001
DATABASE_HOST=127.0.0.1
DATABASE_PORT=55432
AUTH_LOCAL_HTTP_TEST=true
AUTH_ALLOWED_ORIGINS=http://localhost:3000
AUTH_NURSE_EMAIL_DOMAIN=nurse.invalid
```

Fill both secret blanks with newly generated values (`AUTH_SESSION_SECRET` needs at least 32 characters), and add your own Google key only when exercising analysis. Do not echo the file or its secrets. The following POSIX-shell commands export the file's values for Docker without printing them, then pass only the three PostgreSQL settings to the container. Choose a unique suffix for the project/container name; `55432` on the loopback interface must be free.

```sh
# Adjust FORCARE_ENV and choose a unique DEMO_ID before running these commands.
export FORCARE_ENV=/absolute/private/path/forcare-native-demo.env
export DEMO_ID=forcare-native-demo-YOUR_UNIQUE_SUFFIX
set -a
. "$FORCARE_ENV"
set +a

docker run -d \
  --name "$DEMO_ID" \
  --label "com.docker.compose.project=$DEMO_ID" \
  --publish 127.0.0.1:55432:5432 \
  --tmpfs /var/lib/postgresql/data:rw \
  --env POSTGRES_DB \
  --env POSTGRES_USER \
  --env POSTGRES_PASSWORD \
  postgres:16

cd backend
bun install --frozen-lockfile
bun --env-file "$FORCARE_ENV" run migrate
bun --env-file "$FORCARE_ENV" run start
```

Leave the API in that terminal. In a second terminal, install and start the frontend with the existing lockfile and scripts:

```sh
cd frontend
npm ci
npm run dev
```

Open `http://localhost:3000`. The existing Next rewrite sends its same-origin `/api/v1/:path*` requests to `FORCARE_BACKEND_ORIGIN`, defaulting to `http://127.0.0.1:3001`; no CORS path or cookie modification is needed. If you change the API port, set that exact origin before starting Next.js. The existing build uses the default `3001`; for a production Next.js server the value is incorporated by `npm run build`, so rebuilding is required after changing it, and `npm start` alone does not rebuild.

This browser path is qualified for Chromium on localhost only, not arbitrary hosts, other browsers, general HTTP browser compatibility, or production. Production still requires HTTPS and its exact allowed origin.

For cited analysis, run migrations first as above, then start the worker in its own terminal with the same native server/database/auth environment plus `GOOGLE_API_KEY`:

```sh
cd backend
bun --env-file "$FORCARE_ENV" run worker:analysis
```

After registering the synthetic patient through the browser, perform the operator writes explicitly from `backend/`. The Docker-exported shell above provides the private values. The Windows operator CLI now works with the current path handling; on Windows, load the same values privately in your shell or place `--env-file /absolute/private/path/forcare-native-demo.env` after `bun` in each command instead of relying on POSIX `export`. Never commit the generated credential file or print its contents.

```sh
bun run seed:demo -- \
  --confirm synthetic-demo-nurses \
  --output /absolute/private/path/demo-nurses.json \
  --operator OPERATOR_NAME --approval-ref APPROVAL_REFERENCE

bun run patient:assign -- record \
  --patient-id PATIENT_UUID --record-number RM-2026-001 \
  --expected-version CURRENT_VERSION \
  --operator OPERATOR_NAME --approval-ref APPROVAL_REFERENCE

bun run patient:assign -- primary \
  --patient-id PATIENT_UUID --nurse-id SEEDED_NURSE_STAFF_UUID \
  --expected-version CURRENT_VERSION \
  --operator OPERATOR_NAME --approval-ref APPROVAL_REFERENCE

bun run scripts/knowledge-corpus.ts
bun run scripts/knowledge-corpus.ts \
  --approve-by SEEDED_NURSE_STAFF_UUID
```

Use the actual patient/staff UUIDs and current profile version returned by the application; see [Identity operations](#identity-operations) for the independent record and primary-assignment semantics. Importing and approving the fixed bundled corpus are separate explicit steps, as described under [Controlled knowledge corpus](#controlled-knowledge-corpus). Seed credentials permit local sign-in only after provisioning; they are not pre-existing public demo accounts.

When finished, stop the frontend, worker, and API, then remove only the container selected above:

```sh
docker rm -f "$DEMO_ID"
```

Do not use broad Docker prune commands or remove other containers/volumes. This demo's PostgreSQL data directory is container-local temporary storage, so removing this chosen container discards its database. Delete the private environment and generated nurse-credential files securely when they are no longer needed; all ephemeral generated credentials and database records then cease to be usable. This cleanup does not delete unrelated Docker resources.

## Database migrations and integration tests

Run `bun run migrate` with the database environment configured before using the account API. It discovers and applies each pending bundled migration, currently `0001_identity` through `0008_reviews`, transactionally and verifies checksum history on repeat runs. Later names in the source migration manifest are not bundled migrations to apply. It never seeds demo users. Do not edit an applied migration file.

`bun run test:integration` runs migration, authentication, patient-scope, clinical-record, check-in, schema-contract and assessment-availability checks. It requires `FORCARE_TEST_DATABASE_URL` pointing to a dedicated loopback database with an explicit non-5432 port and a name ending in `_test`. The test role must be allowed to create/drop the suite's temporary databases on that isolated server. Do not use a production or shared application database. The command fails if opt-in is missing; ordinary `bun test` skips live database suites. The LangGraph checkpoint suite has its own opt-in below.

See [API.md](API.md) for implemented routes, request examples and error handling.

## Identity operations

Run these commands from `backend/` with the same private database/auth environment as the API. No command seeds automatically at startup.

`bun run seed:demo -- --confirm synthetic-demo-nurses --output /absolute/private/path/demo-nurses.json --operator <name> --approval-ref <reference>` provisions only the three approved synthetic nurses when `AUTH_NURSE_EMAIL_DOMAIN=nurse.invalid`. Replace the example output with a new file at a private path outside the repository. It writes generated passwords to that new mode-0600 file, requires all three identities to be free, and aborts without changing records if an email or staff-code collision exists; it does not resume or rotate an existing seed or overwrite its credential file. It never prints passwords. The seed does not create a patient or an assignment.

Register the synthetic patient through the API first. The record and primary-assignment operations below require that owned patient's existing profile and current version; each is an independent explicit operator write.

`bun run patient:assign -- record --patient-id <uuid> --record-number RM-2026-001 --expected-version <n> --operator <name> --approval-ref <reference>` assigns a staff-reviewed display record number to an already-owned patient profile.

`bun run patient:assign -- primary --patient-id <uuid> --nurse-id <staff-uuid> --expected-version <n> --operator <name> --approval-ref <reference>` atomically updates the primary nurse, primary access grant and revoked prior grant. Use the current patient-profile version and the seeded nurse's staff UUID. Neither command accepts NIK, auto-matches RM, merges accounts or exposes an HTTP admin route. A displayed record number does not itself establish primary access.

## Controlled knowledge corpus

The fixed corpus is not imported by migrations, application startup or the seed. With the standard server/database and auth environment configured, import the bundled bilingual falls-prevention and handwashing education from `backend/` using:

```sh
bun run scripts/knowledge-corpus.ts
```

The no-argument command creates the fixed corpus as DRAFT. It accepts no custom content, file, URL or publication option. Re-running it verifies the immutable manifest rather than approving it.

For an authorized synthetic-only operator attestation, first use the API session for the intended seeded primary nurse to obtain its own nurse staff UUID from `GET /api/v1/me/profile`, then run:

```sh
bun run scripts/knowledge-corpus.ts --approve-by STAFF_UUID
```

`STAFF_UUID` must identify an existing active, approved, provisioned nurse in the configured nurse domain; an account UUID or arbitrary role label is insufficient. This explicitly records that nurse and the operator attestation in the audit trail. It is an attestation that the bundled synthetic fixture may be used for this local demonstration, **not clinical validation**, individual care orders or a new HTTP approval authority. A repeat does not silently change content or bypass a manifest mismatch; changed content requires a separately reviewed new corpus revision. Draft-only import cannot satisfy the approved-corpus G05 gate used by retrieval and analysis.

## LangChain check

`bun run ai:smoke` runs a fixed, non-medical connectivity check. It exits nonzero when disabled, misconfigured or unsuccessful. It does not accept patient input, grant tools, write records or run clinical analysis.

The tests use synthetic responses from a local HTTP server. An actual model connection requires your own provider credential.

## Checkpoint integration check

`bun run test:checkpoint` runs the LangGraph interrupt/restart spike against a real PostgreSQL server. It needs `FORCARE_CHECKPOINT_TEST_DATABASE_URL`, a dedicated loopback database whose name starts with `forcare_checkpoint_test`. The port must be explicit and must not be 5432. There is no `DATABASE_URL` or `.env` fallback, and the script exits nonzero when the variable is missing or unsafe. Plain `bun test` skips the integration suite.

The fixture stores synthetic draft ids and publication markers only. It proves that a paused graph can be resumed by a separate process and that duplicate resumes keep one publication row. It performs structural binding checks between the pause and the decision, not user authentication or domain authorization.

A failed task retains its first resume payload in the tested LangGraph version. The tests characterize explicit re-entry with a fresh nonce; they do not implement the application's review-recovery policy.
