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

These checks do not test AI access or application schemas. Patient-data and AI HTTP routes have not been added.

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

`BACKEND_PORT` controls the Compose host port, not the container listener. Compose disables `LANGSMITH_TRACING` and `LANGCHAIN_TRACING_V2`.

For native commands, supply a private environment or use Bun's `--env-file` option. An optional blank setting in a native environment file is not necessarily equivalent to an unset variable; the root Compose file supplies its own defaults.

## LangChain check

`bun run ai:smoke` runs a fixed, non-medical connectivity check. It exits nonzero when disabled, misconfigured or unsuccessful. It does not accept patient input, grant tools, write records or run clinical analysis.

The tests use synthetic responses from a local HTTP server. An actual model connection requires your own provider credential.
