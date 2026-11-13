# ForCare

ForCare is a web application for hospitals and homecare providers to coordinate patient check-ins, nurse visits and care records.

The repository currently has a Next.js starter, a Bun/Elysia backend, PostgreSQL and a LangChain connectivity check. Patient records, booking, authentication and check-in analysis are still to be implemented. Nurses and doctors will review health-related AI output before it is used in care.

## Run the backend and database

You need Docker Engine and Docker Compose v2 or later.

```sh
cp .env.example .env
# Set POSTGRES_PASSWORD in .env to a unique password.
docker compose up --build -d --wait
curl --fail http://127.0.0.1:3001/health/ready
```

The backend listens on `127.0.0.1:3001`. Set `BACKEND_PORT` in `.env` if that port is occupied. PostgreSQL is available to containers at `db:5432`; it has no published host port.

Keep `.env` out of Git. Optional blank entries use the defaults in `compose.yaml`. To validate the configuration without printing credentials, run `docker compose config --quiet`.

```sh
docker compose ps
docker compose logs --tail 50 backend
docker compose down
```

`down` preserves the database volume. Removing the volume deletes its data. If the database has already been initialized, changing `POSTGRES_PASSWORD` in `.env` alone will not rotate its stored password.

## Run the frontend

```sh
cd frontend
npm ci
npm run dev
```

Open `http://localhost:3000`. The frontend is not included in Compose yet, and its API integration is pending. See [frontend/README.md](frontend/README.md) for its setup instructions.

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

## Structure

- `frontend/`: Next.js application.
- `backend/`: Elysia API and LangChain setup. [Backend configuration](backend/README.md).
- `compose.yaml`: backend and PostgreSQL services.
- `.env.example`: environment variable names without secret values.

```mermaid
flowchart LR
    F[Next.js frontend] -. API integration pending .-> B[Bun / Elysia]
    B --> D[(PostgreSQL)]
    S[Connectivity CLI] --> L[LangChain]
    L --> M[Model API]
```

## Dependencies and AI use

- [Next.js](https://github.com/vercel/next.js), [React](https://github.com/facebook/react) and [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss): MIT.
- [Elysia](https://github.com/elysiajs/elysia), [Bun](https://github.com/oven-sh/bun), [LangChain.js](https://github.com/langchain-ai/langchainjs) and [Zod](https://github.com/colinhacks/zod): MIT.
- [TypeScript](https://github.com/microsoft/TypeScript): Apache-2.0.
- [PostgreSQL](https://www.postgresql.org/about/licence/): PostgreSQL License.

OpenAI Codex (`gpt-6.1-sol`) assisted with backend setup, Docker configuration and tests. Application AI currently consists of the optional LangChain connectivity check through `@langchain/openai`; patient-analysis workflows and the production model have not been selected.
