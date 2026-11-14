# ForCare

ForCare is a web application for hospitals and homecare providers to coordinate patient check-ins and care records.

The Next.js frontend provides real cookie-backed patient and provisioned primary-nurse workspaces through a same-origin API proxy. Patient registration, profile/contact editing, draft and submitted check-ins, active care guides, and published patient-facing analyses are implemented. Primary nurses can read their assigned patients' records, create and correct versioned medical snapshots, review cited AI drafts, and explicitly publish an approved revision. Review and publication are separate operations; recorded observations and nurse confirmations also remain separate.

The Elysia API stores application data in PostgreSQL. A separate analysis worker uses the fixed approved knowledge corpus and Google AI Studio's `gemini-4-hydrogen`, with `gemini-3.5-flash-lite` attempted only after a numeric HTTP 429 response. Its durable nurse-review pause does not publish content automatically.

Numerical clinical scoring, homecare booking/scheduling, visits, notifications, and browser push remain unavailable. The older mock-only frontend source is retained but is not the active product implementation.

## Run the backend and database

You need Docker Engine and Docker Compose v2 or later.

```sh
cp .env.example .env
# Set POSTGRES_PASSWORD and AUTH_SESSION_SECRET to unique secrets in .env.
# Set AUTH_ALLOWED_ORIGINS to the exact HTTPS frontend origin.
# Set AUTH_NURSE_EMAIL_DOMAIN=nurse.invalid for the synthetic nurses.
docker compose build backend
docker compose up -d --wait db
docker compose run --rm --no-deps backend bun run migrate
docker compose up -d --wait backend
curl --fail http://127.0.0.1:3001/health/ready
```

The backend listens on `127.0.0.1:3001`. Set `BACKEND_PORT` in `.env` if that port is occupied. PostgreSQL is available to containers at `db:5432`; it has no published host port. Compose currently provides only the API and database; start Next.js and the analysis worker separately as described below.

Keep `.env` out of Git. Optional blank entries use the defaults in `compose.yaml`; the database password, allowed origins and session secret are required. `AUTH_SESSION_SECRET` must contain at least 32 characters. To validate without printing credentials, run `docker compose config --quiet`.

Run migrations explicitly after building the backend and before using account routes. The runner verifies previously applied checksums and does not seed users or erase data. Production browser authentication requires an HTTPS frontend with an exact allowed origin. The loopback backend health URL above is not a browser-auth deployment.

Native loopback HTTP testing is a separate, narrow path: explicitly enable `AUTH_LOCAL_HTTP_TEST=true` and start the API with `HOST=127.0.0.1`. Only exact loopback HTTP origins are accepted, and the `Secure` `__Host-` session-cookie attributes remain unchanged. A native API client must manage that cookie explicitly; this does not refer to a bundled authenticated smoke-client script. The existing Next.js same-origin rewrite also provides a localhost browser path for Chromium: default to frontend `http://localhost:3000` and API `127.0.0.1:3001`. If using frontend port `3400`, set `AUTH_ALLOWED_ORIGINS=http://localhost:3400` exactly. This is not a guarantee for arbitrary hosts, browsers, or HTTP deployments, and production HTTPS is unchanged. See the [reproducible native localhost demo](backend/README.md#reproducible-native-localhost-demo) and [implemented API reference](backend/API.md).

```sh
docker compose ps
docker compose logs --tail 50 backend
docker compose down
```

`down` preserves the database volume. Removing the volume deletes its data. If the database has already been initialized, changing `POSTGRES_PASSWORD` in `.env` alone will not rotate its stored password.

## Run the frontend and analysis worker

The frontend and analysis worker are separate processes and are not included in Compose. Use frontend `http://localhost:3000` and API `127.0.0.1:3001` consistently. For the isolated native localhost reproduction—including Bun 1.4.2, the disposable PostgreSQL 16 container on `127.0.0.1:55432`, migrations, private environment, worker key, operator steps, and scoped cleanup—follow [backend setup](backend/README.md#reproducible-native-localhost-demo).

Independently of that native procedure, the frontend can be started from `frontend/` with `npm ci` and `npm run dev`. `FORCARE_BACKEND_ORIGIN` defaults to `http://127.0.0.1:3001`. Next.js rewrites only same-origin `/api/v1/:path*` requests to that origin and does not expose backend credentials to browser code. Set a changed API origin before starting Next.js; for a production server it is used during `npm run build`, so changing the API port requires a rebuild. The worker requires its own private `GOOGLE_API_KEY` and the same PostgreSQL configuration. The `ai:smoke` CLI below is only a non-medical provider-connectivity check, not this clinical draft worker.

Browser production still requires HTTPS and exact allowed origins. The native loopback browser path is qualified only for Chromium on localhost, not general browser or Compose behavior. See [frontend/README.md](frontend/README.md) for routes and production scripts, and [backend setup](backend/README.md#reproducible-native-localhost-demo) for the native procedure, worker, and environment details.

## Check the backend

Bun 1.4.2 is used for the backend and pinned Docker image.

```sh
cd backend
bun install --frozen-lockfile
bun run typecheck
bun test
```

The LangChain tests use a synthetic local HTTP provider. They test the graph and transport without contacting a paid model service.

## Check a model connection

AI is disabled by default. To test a provider, set these values in the root `.env`:

- `AI_ENABLED=true`
- `AI_API_KEY`: your provider credential.
- `AI_MODEL`: a model available to your account.
- `AI_BASE_URL`: optional OpenAI-compatible Chat Completions endpoint. Leave it blank for OpenAI.
- `AI_TIMEOUT_MS`: optional request timeout, default `30000`.

```sh
docker compose up -d --wait backend
docker compose exec -T backend bun run ai:smoke
```

A successful call prints `FORCARE_LANGCHAIN_OK`. The check sends a fixed software-connectivity prompt, not patient data, and may incur a provider charge. It has no tools or database access. Startup and health checks do not call the model, and Compose disables LangChain tracing.

## Rehearse a synthetic local demo

Use only synthetic data in an isolated, project-owned database. This is a rehearsal guide, not a claim that every full-stack step has been verified end to end, that a public demo is deployed, or that final submission is complete. A real model draft needs your own `GOOGLE_API_KEY` and may incur provider charges.

1. Follow the [native localhost demo](backend/README.md#reproducible-native-localhost-demo) for a disposable rehearsal database, migrations, private settings, frontend/API defaults, and separate worker startup. That browser path is qualified for Chromium on localhost only. For any production browser deployment, terminate HTTPS at the Next.js origin and configure that exact allowed origin; never disable `Secure` cookies or generalize this loopback setting to arbitrary hosts or browsers.
2. Open `/daftar` and register a synthetic patient (public registration is patient-only). Sign in at `/login`, edit contact details at `/pasien/profil/kontak`, then create a check-in at `/pasien/check-in`. Save its draft, correct it, and explicitly submit it.
3. Using the controlled CLI operations in [backend setup](backend/README.md), run `seed:demo` with the approved `nurse.invalid` domain to provision the three synthetic nurses, then use `patient:assign record` and `patient:assign primary` for the patient record number and primary-nurse assignment. Keep generated credentials private; there are no shared demo passwords in this repository.
4. Sign in as that primary nurse and open the assigned patient through `/pasien-rekam-medis`. Create the full medical source snapshot, then save a separate immutable correction and reload to inspect its revision.
5. Prepare the fixed bundled corpus using the exact import and operator-attested synthetic approval procedure in [corpus setup](backend/src/knowledge/README.md). With the separate analysis worker running, generate a cited draft from the submitted check-in. Review or revise it as the nurse and explicitly approve the chosen revision; approval is not publication.
6. After the worker reconciles the durable review gate, use the separate publish action. Return to the patient workspace and open `/pasien/panduan` to inspect only the published patient-facing projection, never the internal note or raw medical snapshot. Log out from the workspace to end that cookie-backed session.

Do not fabricate the unavailable scoring, booking/scheduling, visit, notification, or browser-push workflows during the rehearsal. Compose does not start the frontend or worker, so this is intentionally not a one-command full-stack procedure. Cleanup must target only the demo container selected in the backend procedure; the disposable database, generated credentials, and private environment files are discarded afterward, leaving no ready public accounts.

## Structure

- `frontend/`: Next.js patient and nurse workspaces, cookie-backed sessions, and same-origin API proxy.
- `backend/`: Elysia API, separate durable analysis worker, and PostgreSQL schema. [Backend configuration](backend/README.md).
- `backend/src/knowledge/`: fixed approved retrieval corpus and its operator-attested importer. [Corpus setup](backend/src/knowledge/README.md).
- `compose.yaml`: API and PostgreSQL services only.
- `.env.example`: environment variable names without secret values.

```mermaid
flowchart LR
    U[Patient or nurse browser] -->|HTTPS + session cookie| F[Next.js workspaces]
    F -->|same-origin /api/v1 rewrite| B[Bun / Elysia API]
    B --> D[(PostgreSQL)]
    W[Separate analysis worker] --> D
    W --> K[Approved knowledge corpus]
    W --> L[LangChain Google adapter]
    L --> M[Gemini Hydrogen; Flash Lite only on HTTP429]
    B -->|durable draft, review, explicit publish| D
    S[ai:smoke connectivity CLI] --> O[Configured OpenAI-compatible provider]
```

## Dependencies and AI use

- [Next.js](https://github.com/vercel/next.js), [React](https://github.com/facebook/react) and [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss): MIT.
- [Elysia](https://github.com/elysiajs/elysia), [Bun](https://github.com/oven-sh/bun), [LangChain.js](https://github.com/langchain-ai/langchainjs) and [Zod](https://github.com/colinhacks/zod): MIT.
- [TypeScript](https://github.com/microsoft/TypeScript): Apache-2.0.
- [PostgreSQL](https://www.postgresql.org/about/licence/): PostgreSQL License.

OpenAI Codex (`gpt-6.1-sol`) and DeepSeek (`DeepSeek-V4.1-Flash-1017`) assisted with backend implementation, reviews, Docker configuration and tests. The now-implemented analysis workflow produces cited nurse-review drafts through LangChain's Google AI Studio transport. It uses `gemini-4-hydrogen` and falls back to `gemini-3.5-flash-lite` only for a numeric HTTP 429. The independent `ai:smoke` command still uses its separately configured OpenAI-compatible provider and never runs clinical analysis.
