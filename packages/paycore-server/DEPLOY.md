# Deploying the PayCore server

One image (`packages/paycore-server/Dockerfile`) runs the server and the operator CLI. The server runs every hosted store's node in one process: each store it leases in Postgres gets its own relay pool and control queue, and its ledger lives in the `ledgers` row. Several instances may share one database: each store is served by one lease holder at a time.

Build from the repository root (`docker build` is not run in CI):

```bash
docker build -f packages/paycore-server/Dockerfile -t paycore-server .
```

## Settings

Read once at startup (`src/config.ts`); a bad value stops the process before anything starts. An empty variable counts as unset.

| Variable                                                    | Required | Meaning                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                              | yes      | Postgres connection string. Migrations run at startup (and before CLI commands other than `stats`).                                                                                                                                                                                                                                                              |
| `PAYCORE_MASTER_KEY_FILE`                                   | one of   | Path of the master key file (a Docker secret). Preferred.                                                                                                                                                                                                                                                                                                        |
| `PAYCORE_MASTER_KEY`                                        | one of   | The master key itself. Never both.                                                                                                                                                                                                                                                                                                                               |
| `PAYCORE_PUBLIC_BASE`                                       | yes      | The public origin (and path) the admin API answers on; NIP-98 `u` is checked against it. `https:`, or `http:` on localhost only. A trailing slash is ignored.                                                                                                                                                                                                    |
| `PORT`                                                      | no       | HTTP port, default `8790`.                                                                                                                                                                                                                                                                                                                                       |
| `PAYCORE_TRUST_PROXY`                                       | no       | `1` behind our proxy: the client address is the last `X-Forwarded-For` hop (rate limits). `0` or unset: the socket address.                                                                                                                                                                                                                                      |
| `PAYCORE_INBOX_RELAYS`                                      | no       | Comma-separated allowlist of inbox relays hosted stores may name (`wss:` on a public DNS name). Default `wss://relay.elisym.network`. A stored relay outside it is never connected to.                                                                                                                                                                           |
| `PAYCORE_OPERATOR`                                          | no       | The `operator` tag of every hosted store's 30490: a lowercase DNS name. Default: the host of `PAYCORE_PUBLIC_BASE`.                                                                                                                                                                                                                                              |
| `PAYCORE_REQUIRED_RELAY`                                    | no       | The offer relay every hosted store's newest events are mirrored to (a sweep every 15 min copies the exact signed events the default relays serve and it lacks). Must be one of the offer relays. Default `wss://relay.elisym.network`.                                                                                                                           |
| `PAYCORE_ADMIN_ORIGIN`                                      | no       | The hosted admin's origin, exactly as the browser sends it in `Origin` (e.g. `https://admin.elisym.network`: `https:`, or `http:` on localhost only; no path, no trailing slash, default port omitted, lowercase host). The admin API and `/v1/meta` answer that one origin with CORS headers; unset: no CORS headers at all. Any other spelling stops the boot. |
| `PAYCORE_SOLANA_RPC_MAINNET` / `_DEVNET`                    | no       | The Solana rail's RPC per network (server-side key). Without it, Solana payouts on that network run off: the store is `degraded` with a `rail_unavailable` alert.                                                                                                                                                                                                |
| `PAYCORE_FEE_RPC_MAINNET` / `_DEVNET`                       | no       | Where the protocol fee config is read. Default: the Solana RPC of the network, else its public endpoint.                                                                                                                                                                                                                                                         |
| `PAYCORE_TEMPO_RPC_MAINNET` / `_DEVNET`                     | no       | The Tempo rail's RPC (Tempo mainnet on `mainnet`, Moderato on `devnet`).                                                                                                                                                                                                                                                                                         |
| `PAYCORE_EVM_RPC_{ETHEREUM,ARBITRUM,BASE}_{MAINNET,DEVNET}` | no       | USDC (EIP-3009) RPC per chain and network.                                                                                                                                                                                                                                                                                                                       |

Stores never name an RPC: every rail uses the operator's, each URL behind its own rate limiter (10 requests/s). The fee config reads have a limiter of their own on the fee config URL (a fixed 2 requests/s: a read is two calls, about once a minute per network), so the stores' traffic never delays them past their 10 s deadline. **A URL that is both a Solana rail's RPC and the fee config RPC can therefore receive up to 12 requests/s from one instance** (10 for the stores, 2 for the fee config), times the number of instances: size the RPC plan for that. Each store sweeps at its own fixed moment of every minute (derived from the owner key, the same across restarts), so the stores' sweeps do not reach the RPC as one burst and a store restarted often still sweeps every minute.

### What the boot checks

In this order, before any store starts: migrations, the master key, then the fee config of every **network in use** (the network of every store that is not `pending`, plus every network with an operator RPC configured). A fee config RPC serving another cluster stops the boot; one that cannot be reached is only logged and read again later. Then the EIP-3009 start check of every operator EVM chain of those networks: a wrong answer stops the boot, a transient one is retried in the background (payments on that chain are not scanned until it passes). Then the supervisor, the leases (LISTEN `paycore_stores`, renewed every 20 s), the owner event publisher, the required-relay mirror sweep (a first pass at once, then a tick every minute; each store is swept at most once per 15 min across all instances), the request pump (LISTEN `paycore_requests`, a 60 s poll) and HTTP.

`GET /healthz` answers `{"status":"ok"}` once the boot is done; use it as the container health check (the image has bun, not curl):

`GET /v1/meta` (public, no authorization) answers what the hosted admin reads before it signs in: `publicBase`, `operator`, per network the USD coins a payout may use (those whose rail has an operator RPC; the RPC URLs are never shown), the inbox relay allowlist and the product cap of a pending store.

### CORS for the hosted admin

With `PAYCORE_ADMIN_ORIGIN` set, every answer under `/v1/admin/` and `/v1/meta` to a request whose `Origin` is byte for byte that origin carries `access-control-allow-origin: <origin>`, `access-control-expose-headers: date` (the admin sets its NIP-98 clock from `Date`) and `vary: origin` - the early 401 (no NIP-98 header) and 413 (body over the cap) included. A preflight `OPTIONS` is answered `204` before any body or authorization check, adding `access-control-allow-methods: GET, POST, PUT, DELETE`, `access-control-allow-headers: authorization, content-type` and `access-control-max-age: 600`. No credentials. Any other origin gets no CORS headers (only `vary: origin`). A proxy in front must pass `OPTIONS` and the `Origin` header through and must not add CORS headers of its own. Smoke after deploy:

```sh
curl -si -X OPTIONS https://<public base host>/v1/admin/store -H 'Origin: https://admin.elisym.network' -H 'Access-Control-Request-Method: PUT' | grep -i '^access-control\|^HTTP'
curl -si https://<public base host>/v1/meta -H 'Origin: https://admin.elisym.network' | grep -i '^access-control\|^date'
curl -si https://<public base host>/v1/meta -H 'Origin: https://other.example' | grep -ci '^access-control'   # 0
```

In production set `PAYCORE_ADMIN_ORIGIN=https://admin.elisym.network` (the hosted admin, `packages/merchant-admin`, page `/hosted/`). The admin side is turned on in the same release window: its committed `PAYCORE_API_BASE` must equal this server's `PAYCORE_PUBLIC_BASE` and its `PAYCORE_OPERATOR` this server's operator (`packages/merchant-admin/DEPLOY.md`, "Hosted mode").

#### Admin smoke

The whole hosted flow runs in CI against the real admin API on pglite with the admin's own browser client (`tests/hosted-smoke.test.ts`: create, config with wallet proofs, both owner events, activation, a product, an order in the ledger, the orders view, a hand answer applied by a holder). After a deploy, check it live:

1. The three `curl` lines above (CORS for the admin origin only, `Date` exposed).
2. Open `https://admin.elisym.network/hosted/`, sign in with a test owner key and create a store; the browser devtools show every call to the public base answered without a CORS error.
3. Run the manual devnet checklist in `packages/merchant-admin/DEPLOY.md` (Phantom and MetaMask proofs, owner events, activation with `store activate`, products, an order, the webhook secret).
4. Suspend the test store from Settings (or `store suspend`) when done.

```yaml
healthcheck:
  test:
    [
      'CMD',
      'bun',
      '-e',
      "fetch('http://127.0.0.1:8790/healthz').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))",
    ]
  interval: 10s
  timeout: 5s
  retries: 12
  start_period: 60s
```

## Master key

32 random bytes as 64 lowercase hex characters (`openssl rand -hex 32`), created once on the server and never committed or copied around. It seals every store key and webhook secret in Postgres (AES-256-GCM, bound to the store and purpose): **losing it loses every store**. Keep an offline copy apart from the database backups. Mount it as a Docker secret:

```yaml
services:
  paycore-server:
    environment:
      - PAYCORE_MASTER_KEY_FILE=/run/secrets/paycore_master_key
    secrets:
      - paycore_master_key
secrets:
  paycore_master_key:
    file: ./secrets/paycore_master_key # owner 1000:1000 (the image's `bun` user), mode 400
```

## Shutdown

`docker stop` sends SIGTERM (tini is PID 1 and forwards it). The server then, each step awaited before the next:

1. stops accepting HTTP and stops the lease loop (a lease round in progress is awaited, so no lease is taken after they are given up);
2. `pump.stop()` - no new request round; the round in progress and the drains it started finish;
3. `holder.idle()` - every drain, suspension round and offer check still running finishes;
4. the owner event publisher stops;
5. the mirror sweep stops: it claims no further store and abandons the one in progress at once (its reads and sends are dropped and its relay pool destroyed), so this step takes at most the one database call in flight; the abandoned store is swept again next period;
6. `supervisor.shutdown()` - every store node stops (each awaits its running task: a sweep, a webhook send, a save) and the leases are released, so another instance takes the stores at once;
7. the webhook slots and relay pools close, then the database.

A second SIGTERM / SIGINT kills the process at once. Set compose `stop_grace_period` **above the longest task**: a sweep on a slow RPC can take minutes. If Docker kills the process first, nothing is lost (every ledger change is saved before its effect is acted on), but the leases are not released and the stores wait out their 60 s TTL before another instance serves them.

```yaml
stop_grace_period: 5m
```

Measured with `scripts/load.ts` (fake chains, a 10 requests/s RPC URL, 200 stores): shutdown 10 ms and the longest sweep 45 ms once the stores' sweeps are spread over the minute (19 s and ~36 s while they all swept in the same second). A real sweep is its RPC calls times the RPC's latency, plus a backlog when the stores of one URL near its rate: 5m leaves wide headroom.

## Losing the database

The lease loop renews this instance's leases every 20 s; a lease runs out 60 s (`LEASE_TTL_SECS`) after the start of the round that renewed it, and another instance may then take the store. A renewal that fails is tried again 5 s later (not only at the next 20 s tick), so one transient failure, or one slow renewal, costs nothing. When no renewal has succeeded for 55 s since the start of the last one that did (the TTL less a 5 s margin: the database down, or a renewal still hanging), the server **stops every store node itself**, on a timer at that deadline, and logs `no lease renewed for <n> s: stopping every store until a renewal succeeds`: it does not wait for a node's next save to be refused. The process keeps running (HTTP, `/healthz`) and keeps trying; on the first renewal that succeeds it logs `leases renewed again: serving the leased stores` and starts the stores it leases again from the database (a store whose lease ran out comes back with a new epoch). A renewal answered only after that deadline counts as failed. Nothing is lost while stopped: buyers' messages wait on the relays and the listener resumes from its saved point; payments are found by the next sweep.

What this guarantees, and what it does not:

- **Ledger saves are fenced by the row version**: once another instance took a store and saved, a save by the old holder is refused and its node halts. Two instances never both write a store's ledger.
- The old holder stops its nodes 5 s before its leases run out by its own clock. If the two instances' clocks disagree by more than that margin (or the old process is frozen past it, e.g. a paused VM), both may serve a store for a short overlap: a buyer may get a reply twice, and a webhook may be sent twice. Keep the hosts' clocks in sync (NTP).
- Webhook receivers must treat the webhook `eventId` as idempotent anyway (a retry after a timeout, a restore, or such an overlap sends it again) and check the payment on-chain.

## Backups

- Nightly `pg_dump` of the database (RPO 24 h), kept off the host, e.g. `docker compose exec -T postgres pg_dump -U paycore -Fc paycore > paycore-$(date +%F).dump`. Restore with `pg_restore` into an empty database, with the same master key.
- A restore rolls the ledgers back to the dump. Orders paid after it are found again by the sweep from the chains, and a webhook sent after the dump may be sent again: receivers must treat the webhook `eventId` as idempotent and check the payment on-chain (the phase 2 docs say so to merchants).
- The master key is not in the dump (see above); a dump without it cannot open any store.

## Operator CLI

The same image with a subcommand runs the operator CLI on the same database and exits with its code (an unknown command prints the usage, `CLI_USAGE` in `src/cli.ts`):

```bash
docker compose exec paycore-server bun packages/paycore-server/dist/main.js store list
docker compose run --rm paycore-server tier set basic --max-products 20
docker compose run --rm paycore-server store activate <owner npub> --tier basic
docker compose run --rm paycore-server alert list
docker compose run --rm paycore-server stats
```

`store list|activate|suspend|tier` (`store tier <owner> <tier>` moves an active, degraded or halted store to another tier; refused while it has more products on sale than the new tier allows), `tier list|set|delete`, `alert list|clear`, `stats` (read-only), and `import <home> --tier <name> --node-stopped [--webhook-secret-file <path>]` to take over a stopped self-host merchant-node store (the home directory mounted into the container; its store key passphrase from `ELISYM_MERCHANT_PASSPHRASE(_FILE)`; the owner key is never read). `--node-stopped` is the operator's word that the self-host node no longer runs: two nodes on one ledger would double-serve orders.

Before an import:

- **Stop the self-host node yourself and make sure it stays stopped** (disable its service, remove its container). `--node-stopped` is required and is the only real check: import also reads the home's `run.lock`, but only its age - a lock refreshed in the last 90 s refuses the import (so wait 90 s after the node stopped), and an old or missing lock proves nothing. A home **copied from another machine** says nothing about the node still running there: stop that one before copying.
- **The container runs as uid 1000** (the image's `USER bun`): the mounted home must be readable by it. merchant-node writes `keys.json` (and often the ledger) with mode 0600 for its own user, so either mount a copy owned by 1000:1000, or run the import with `--user` set to the home's owner (`docker compose run --rm --user "$(stat -c %u:%g <home>)" paycore-server import ...`).
- **`keys.json` must be written by merchant-node 0.5.0 or later**: import reads the owner's public key from it (the owner key itself is never read or decrypted), and an older file does not name it, so the import is refused. Rewrite it first on the self-host machine with a current node (`elisym-merchant encrypt-keys`).
- The node's last `elisym-merchant setup` must be the one the relays serve: its ledger records the payout list the relays' newest 10133 carries (same date), else the import is refused.
