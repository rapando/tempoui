# Tempo Deck

A local console for [Temporal](https://temporal.io) servers: workflows with status counts, a timeline per execution, event history, payloads, pending work, schedules and task queues. It has no dependencies; Node 18 or newer is enough.

```sh
npm start          # or: node server.mjs
open http://localhost:8299
```

## Connecting

**Local (default).** On startup Tempo Deck looks for a Temporal server on this machine and connects to it:

- ports 7243 (the usual frontend `--http-port`), 8233 (Web UI), 8080, 8088
- every port a running `temporal` process listens on (found with `lsof`), which covers `temporal server start-dev`, since it picks a random HTTP port

A direct frontend HTTP API wins over the Web UI proxy. Tempo Deck checks the server every 10 seconds; if it stops or comes back on another port, Tempo Deck finds it again.

**Another server.** Click the connection button (top right) and enter the server's HTTP API URL (frontend `--http-port`, usually 7243) or a Temporal Web UI URL. Don't use the gRPC port 7233. You can add an optional API key, which is sent as a `Bearer` token and kept only in the server process's memory. The dialog also lists every local server it found and the URLs you used recently.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8299` | Port Tempo Deck listens on |
| `HOST` | `127.0.0.1` | Bind address |
| `TEMPORAL_HTTP_URL` | | Connect to this server at startup instead of auto-detecting |
| `TEMPORAL_API_KEY` | | API key for `TEMPORAL_HTTP_URL` |

## How it works

`server.mjs` serves `public/` and proxies `/api/v1/*` to the chosen Temporal HTTP API, which gets around CORS. It also adds the CSRF token the Web UI asks for when you cancel, terminate or patch something. Requests to the proxy must carry an `X-TempoUI` header and a localhost `Host`, so other websites can't reach your Temporal server through it.

## Search

Plain text matches the start of a workflow ID or type. Anything containing `=`, `<`, `>`, `STARTS_WITH`, `BETWEEN`, `IN (…)` and so on is sent as-is as a [visibility query](https://docs.temporal.io/list-filter), for example `ExecutionStatus="Running" AND StartTime > "2026-10-01T00:00:00Z"`.
