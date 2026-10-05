# @elisym/merchant-node

The self-hosted store behind the elisym checkout. It publishes your products to Nostr, takes
orders sent by the checkout widget, checks each payment on chain (USDC on Solana, or a
stablecoin on Tempo), and sends the buyer what they bought.

You do not need an account or a server of ours. The node holds your store's keys and a small
ledger on your own disk.

## What you need

- Node.js 22.4 or newer, or Docker.
- A Solana wallet address to be paid to (USDC), a Tempo address, or both.
- For Solana payouts, a Solana RPC endpoint for the node itself. On mainnet, use your own
  provider key (Helius, Triton, ...). A key restricted to a browser origin does not work from a
  server. Tempo is read through its public endpoint unless you set your own.
- What the buyer gets once paid: a link (a Blossom URL, a course page, a download) or text
  (a license key).

## Quick start (devnet)

```bash
npx @elisym/merchant-node init --network devnet
```

This creates `~/.elisym-merchant/` with a `config.json` to edit, one product to edit in
`products/my-product/PRODUCT.md`, and the store's keys. Edit `config.json`:

- `name`: the store's name.
- `payouts[0].address`: your Solana wallet address, paid for every product.

Then edit `products/my-product/PRODUCT.md` (see [Products](#products)): the title, the price in
USD (paid 1:1 in USDC) and the link or text the buyer gets. Add a directory per further
product. Then publish the store and start taking orders:

```bash
npx @elisym/merchant-node setup
npx @elisym/merchant-node run
```

`setup` prints each product's `naddr`. Put it in a checkout snippet on your page, one
`<elisym-buy>` per product:

```html
<elisym-buy product="naddr1..." network="devnet" theme="dark"></elisym-buy>
<script
  src="https://pay.elisym.network/v3/embed.js"
  integrity="sha384-FPsJfAuhwQU0mlPKTKLwCTp1YGK6aFRh0pT+Gl1T3UML2jlIK7EkW8FW5ue2qFJX"
  crossorigin="anonymous"
></script>
```

Keep `run` running. If it stops, a restart catches up on the orders and payments it missed.
Gift wraps stay on the relays for two days, and payments are read back from the chain.

## Commands

| Command                            | What it does                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`                             | Creates the home: a `config.json` template (never overwritten), an example product in `products/my-product/PRODUCT.md`, and the store's keys, encrypted when a passphrase is set (see [Keys at rest](#keys-at-rest))                                   |
| `setup`                            | Checks the inbox relays, publishes the store and the listing of every new or changed product, and records the terms it offers                                                                                                                          |
| `run`                              | Takes orders, verifies payments and delivers                                                                                                                                                                                                           |
| `orders`                           | Lists the orders: open, paid, delivered, the product, the buyer's email, the customer reference, and for a paid order its webhook state and event id                                                                                                   |
| `check`                            | Checks the inbox relays, the owner's payout list and the domain                                                                                                                                                                                        |
| `deliver`                          | Answers an unpaid order by hand with its product's delivery (node stopped); `--product <d>` names the product of an order the ledger no longer holds, required when the store has several products                                                     |
| `refund`                           | Answers an unpaid order by hand with a refund you already sent (node stopped); `--asset <caip19>` names the refunded coin, required when the store has several payouts; a rerun of an answer kept by an older node is sent unchanged, without an asset |
| `encrypt-keys`                     | Encrypts the keys of an existing home with the passphrase (both by default, `--owner-only` for the owner key only); node stopped                                                                                                                       |
| `store-key`                        | Prints the store's secret key (nsec), for the admin page on this machine: only to a terminal, or with `--yes`                                                                                                                                          |
| `admin`                            | Serves the admin page on `127.0.0.1` (`--port`, default 5199): paste the store key there to see the orders (see [Admin](#admin)); reads no home                                                                                                        |
| `webhook test`                     | Sends a signed `test` event to the configured webhook; fails unless the receiver answers 2xx (see [Credit an account](#credit-an-account-the-webhook))                                                                                                 |
| `webhook retry <buyer>:<orderId>`  | Sends a pending or failed `order.paid` webhook again now, with a fresh 7-day deadline (node stopped)                                                                                                                                                   |
| `webhook resend <buyer>:<orderId>` | Sends the `order.paid` webhook of any paid order again, also one paid before the webhook was configured (node stopped)                                                                                                                                 |

Every command takes `--home <dir>`. Without it, the home is `$ELISYM_MERCHANT_HOME`, else
`~/.elisym-merchant`.

Run `setup` again after every change to `config.json` or to a product. Stop `run` first: `setup`
refuses to run while a node holds the home. Run `run` again afterwards. `setup` publishes the
payout list first, then the listing of each product that is new or changed (or that the relays
no longer serve), then the store-wide events; an unchanged listing is not republished. A relay
that cannot be reached is skipped for the rest of that setup. If only part of a change reaches
the relays (for example the payout list but not a listing), `setup` records what buyers can now
see, says so and fails: run it again. Each event it publishes must also reach at least one of
the relays every checkout reads (`wss://relay.elisym.network`, `wss://relay.damus.io`,
`wss://nos.lol`), whatever inbox relays the store uses; `setup` fails until one takes it. It
prints one line per product: on sale or stopped, published, unchanged or failed, and its `naddr`.

A home made by merchant-node 0.7 or earlier (a `config.json` with `product`, or an older ledger)
is not upgraded: every command refuses it. Create a new home with `init`.

The home's lock (`run.lock`) keeps two processes from writing the ledger at once, wherever they
run (containers and hosts sharing the home included). Its holder refreshes it every 20 seconds.
A node that stopped without releasing it leaves it behind, and the lock frees itself 90 seconds
after its last refresh. A container restarted at once may therefore fail for that long before
it starts.

## The config

| Field         | Meaning                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | The store's name, shown in the checkout                                                                                                         |
| `nip05`       | Optional. `_@your-domain.com` for level A (see below)                                                                                           |
| `network`     | `devnet` or `mainnet`                                                                                                                           |
| `rpcUrl`      | The node's Solana RPC (`https:`). Needed with a Solana payout                                                                                   |
| `tempo`       | Optional. `{ "network": ... }` matching `network` (`moderato` on devnet), plus an optional `rpcUrl`                                             |
| `inboxRelays` | 1 to 5 relays (`wss:`) where the store reads orders and replies                                                                                 |
| `payouts`     | One `{ "caip19": ..., "address": ... }` per coin, for every product, see [Tempo payouts](#tempo-payouts)                                        |
| `webhook`     | Optional. `{ "url": "https://..." }`: where the node tells your backend about payments, see [Credit an account](#credit-an-account-the-webhook) |

The node refuses to start with a config it cannot use, and names every problem.

## Products

Each product is a directory under `products/` in the home, named with the product's id (its
`d`): `products/<d>/PRODUCT.md`. The name is 1 to 64 letters, digits, dots, dashes or
underscores, starting with a letter or digit. A `PRODUCT.md` is YAML frontmatter between two
`---` lines, then the description in markdown:

```markdown
---
title: Deposit 10 USD
priceUsd: '10'
summary: Adds 10 USD to your account balance.
delivery:
  method: access
  value: https://example.com/<the link the buyer gets>
---

What the buyer gets, in markdown. This body is the listing's description.
```

| Key               | Meaning                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `title`           | Title (1 to 200 characters)                                                             |
| `priceUsd`        | Price in USD, quoted: `"49"` or `"0.50"`. A bare number is refused                      |
| `onSale`          | Optional, `true` by default. `false` stops selling the product (see below)              |
| `summary`         | Optional short line                                                                     |
| `delivery.method` | `access`, `download`, `license`, `api` or `webhook`: how the checkout labels it         |
| `delivery.value`  | The link or text the buyer gets (up to 1024 characters), quoted if it reads as a number |

- An unknown or misspelled key is refused, also inside `delivery`: a misspelled `onSale` would
  otherwise leave the product on sale.
- A malformed `PRODUCT.md` stops `setup`, `run` and `check`, naming the file: a product is never
  skipped. A link, a pipe or a directory without `PRODUCT.md` is refused too. Entries starting
  with `.` (such as `.git`) and files placed directly in `products/` are ignored.
- `setup` refuses a product whose delivery is still the example `init` wrote.
- A delivery value can be a secret link: never publish the `products/` directory or commit it to
  a public repository.

**Stopping a product.** Set `onSale: false` and run `setup`: its listing is republished as sold
out, every checkout shows Sold out, and its terms end once that listing reached a relay. An
order already placed is still honored within the usual window. **Never delete the directory of a
product that was published** (or ever had terms): `setup`, `run` and `check` refuse to start
without it, because its orders could be paid and never delivered. A product's id cannot change:
a new directory is a new product, and the old one stays, stopped with `onSale: false`.

### Inbox relays

The store replies to one-time buyer keys, which have no inbox of their own. Each inbox relay
must therefore accept a gift wrap (kind 1059) addressed to any key and serve it back to that
key. It must also keep gift wraps for at least two days past their date. `setup` and `check`
test the first two by writing a probe and reading it back. Every relay must pass, or `setup`
stops: buyers send orders to all of them. Retention cannot be tested, so pick relays that keep events. `wss://nos.lol`
and `wss://relay.elisym.network` passed when this was written. `wss://relay.damus.io` did
not: it accepts gift wraps but does not serve them back.

A delivery counts as done once two inbox relays accept it (or all of them, when only one is
configured). While one relay is down, the node retries only that relay, each minute. An hour
after the payment, one relay is enough. If a relay later drops a delivery, the node sends the
status again when it reads that order or a receipt for it again: at most every ten minutes per
order, and a few at a time (the rest wait until the order is read again).

### Tempo payouts

A store can also take a Tempo stablecoin, paid with an EIP-6963 wallet such as MetaMask. Add a
`tempo` block naming the Tempo network that matches the node's `network` (`mainnet` on mainnet,
`moderato` on devnet), and one payout per coin, with your Tempo address in
lowercase:

| Network            | `tempo.network` | Coin    | `caip19`                                                        |
| ------------------ | --------------- | ------- | --------------------------------------------------------------- |
| Tempo mainnet      | `mainnet`       | USDC.e  | `eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50`  |
| Tempo mainnet      | `mainnet`       | pathUSD | `eip155:4217/erc20:0x20c0000000000000000000000000000000000000`  |
| Moderato (testnet) | `moderato`      | pathUSD | `eip155:42431/erc20:0x20c0000000000000000000000000000000000000` |

A Tempo payout is refused without the `tempo` block, and a store with only Tempo payouts needs
no Solana `rpcUrl`, but it still names its network: `"network": "mainnet"` for Tempo mainnet
(`init` writes `devnet` unless told `--network mainnet`). A page shows the store's payouts on its own network, and the buyer picks
one. Upgrade
the node before the payout list names a Tempo address, and do not downgrade it afterwards: once
the node has seen a Tempo order, an older node refuses its ledger.

## Level A: your domain vouches for the store

Without `nip05`, the store is level C. The checkout then shows the buyer that no domain vouches
for it. For level A:

1. Set `"nip05": "_@your-domain.com"` and run `setup`.
2. Serve the `nostr.json` that `setup` writes to the home at
   `https://your-domain.com/.well-known/nostr.json`, with the header
   `Access-Control-Allow-Origin: *`.
3. Run `check`: it fetches the file and says whether the domain now vouches for the store.

Only the domain-wide name `_` gives level A. A named address such as `shop@your-domain.com`
stays level C.

## Keys at rest

`keys.json` holds two secret keys: the store key (it signs the listing, the store profile and
every reply) and the owner key (it signs the payout list). Set a passphrase before `init` and
both are encrypted (AES-256-GCM, a key from scrypt), with their public keys kept in the clear.
The first line makes a random passphrase in a file of its own, once, and never overwrites it.
Back that file up off this machine: without it the keys are lost.

```bash
[ -s ~/.elisym-merchant-passphrase ] || (umask 077 && openssl rand -base64 32 > ~/.elisym-merchant-passphrase)
export ELISYM_MERCHANT_PASSPHRASE_FILE=~/.elisym-merchant-passphrase
npx @elisym/merchant-node init
```

`ELISYM_MERCHANT_PASSPHRASE_FILE` names the file (a Docker or systemd secret works the same
way). `ELISYM_MERCHANT_PASSPHRASE` holds the passphrase itself instead. One trailing newline in
the file is ignored. Setting both is an error. `init` on a home that is already encrypted
checks that the passphrase opens it, so a passphrase file made anew by mistake is caught there. A home created without a passphrase is encrypted in place
with `encrypt-keys` (node stopped).

Every command that needs an encrypted key reads the passphrase from there, and says so when
it is missing. Back the passphrase up: without it the encrypted keys are lost.

What it protects: a copy of the home on its own (a backup, a snapshot, a copied volume). It
does not protect a host that also holds the passphrase: `docker run -e` keeps it in the
container config and in shell history, and a secret file or `EnvironmentFile` sits on the same
host. Keep the passphrase source out of the volume and out of its backups. Older backups and
snapshots taken before encrypting still hold the plain keys.

Both keys, the default, is what protects buyers: the store key signs the profile that names the
owner, so a plain store key lets whoever copies the home publish a profile naming another owner
and redirect new buyers. `--owner-only` (on `init` or `encrypt-keys`) encrypts the owner key
only, for a node that must run without the passphrase: `run`, `check`, `deliver` and `refund`
then need none, but only buyers who bought before (and so pinned the owner) are protected.

`store-key` prints the store key for the admin page. In Docker run it with a terminal and
without keeping the container, so the key is not kept in its log:
`docker run --rm -it --mount type=bind,src=$HOME/.elisym-merchant-passphrase,dst=/run/secrets/merchant,readonly -e ELISYM_MERCHANT_PASSPHRASE_FILE=/run/secrets/merchant -v elisym-merchant:/data elisym-merchant store-key`.
A logging driver that ships stdout elsewhere would keep it there too.

## Admin

`admin` serves a page on this machine where you see the store's orders:

```bash
npx @elisym/merchant-node store-key   # copy the nsec it prints
npx @elisym/merchant-node admin       # open http://127.0.0.1:5199/ and paste it
```

The page reads the store's inbox relays (its inbox list, or the default relays when it has
none) with the store key and shows each order: when it was placed, its product, the total the
buyer's order claims, the email, the customer reference, the state, what the node credited and the
transaction. The totals add up what the node credited, per coin. A product list shows each product
the loaded orders name, with its price and whether it is on sale or sold out. Orders naming a
product whose listing was not found (an unknown product, or relays that did not answer) are
hidden, and one line counts them.

| State            | Meaning                                                               |
| ---------------- | --------------------------------------------------------------------- |
| ordered          | an order, nothing more yet                                            |
| payment reported | the buyer reported a payment the node has not confirmed (not counted) |
| delivered        | the node credited a payment and delivered (counted in the totals)     |
| released by hand | answered with `deliver` without a payment (not counted)               |
| refunded         | answered with `refund` (the refund is shown, not counted)             |

- The key stays in the tab's memory: it is never stored and never sent anywhere (it only
  answers relays that ask the store to authenticate). Close the tab when you are done. Whoever
  has the store key can redirect payments from new buyers.
- Only what the store key signed counts as the node's word: the node's answers come from the
  copies it wraps to its own key. A buyer's claims (an order's total, a reported payment) are
  shown as claims. The claimed total is checked against the current listing only for orders
  placed well after the listing changed.
- History is what the inbox relays still hold. Many keep private messages for about two days;
  `wss://relay.elisym.network` keeps them. The page opens at most 1000 messages per load and
  offers to load more; a relay that does not answer in time marks the view partial.
- Orders the node answered before it kept copies of its answers (before 0.4.0) show at most
  "payment reported". The `orders` command is the reference.
- The server listens on `127.0.0.1` only and serves the page's own files, nothing else. Do not
  run `admin` in Docker: a server on the container's `127.0.0.1` is unreachable from the host.
  Run it with `npx` on the machine whose browser opens it.

## Docker

Build from the repository root:

```bash
docker build -f packages/merchant-node/Dockerfile -t elisym-merchant .
```

The home is the volume at `/data`. Its files belong to the image's user (uid 1000).

With encrypted keys, first make the passphrase file once (as in "Keys at rest"):

```bash
[ -s ~/.elisym-merchant-passphrase ] || (umask 077 && openssl rand -base64 32 > ~/.elisym-merchant-passphrase)
```

Back it up off this machine. The container reads it as uid 1000: Docker Desktop on macOS needs
nothing more. On a Linux host where your user is not uid 1000, give the file to that uid with
`sudo chown 1000 ~/.elisym-merchant-passphrase && sudo chmod 400 ~/.elisym-merchant-passphrase`
(read it later with `sudo`). Do not open it to group 1000 instead: on most hosts that group
belongs to another account.

Every command below mounts the file read-only with `--mount` (which fails on a missing file
rather than creating anything) and names it with `-e`. The first line checks that the
container can read it before anything else runs:

```bash
docker run --rm --mount type=bind,src=$HOME/.elisym-merchant-passphrase,dst=/run/secrets/merchant,readonly --entrypoint cat elisym-merchant /run/secrets/merchant > /dev/null && docker run --rm --mount type=bind,src=$HOME/.elisym-merchant-passphrase,dst=/run/secrets/merchant,readonly -e ELISYM_MERCHANT_PASSPHRASE_FILE=/run/secrets/merchant -v elisym-merchant:/data elisym-merchant init --network devnet
```

Edit `config.json` and `products/my-product/PRODUCT.md` in the volume, then publish and start the node:

```bash
docker run --rm --mount type=bind,src=$HOME/.elisym-merchant-passphrase,dst=/run/secrets/merchant,readonly -e ELISYM_MERCHANT_PASSPHRASE_FILE=/run/secrets/merchant -v elisym-merchant:/data elisym-merchant setup
docker run -d --name shop --restart unless-stopped --mount type=bind,src=$HOME/.elisym-merchant-passphrase,dst=/run/secrets/merchant,readonly -e ELISYM_MERCHANT_PASSPHRASE_FILE=/run/secrets/merchant -v elisym-merchant:/data elisym-merchant run
docker logs -f shop
```

A store already running in Docker with plain keys is encrypted in place, from an image built
from this version (rebuild it first: an older image does not know `encrypt-keys`), then started
from a new container (the old one has no passphrase mount and would restart in a loop). Make
the passphrase file as above first. The chain assumes the container `shop` and the volume
`elisym-merchant` from the steps above, and each step runs only if the one before it succeeded.
The old container is removed only after the keys are encrypted: if a step fails before that,
`docker start shop` brings the store back unchanged.

```bash
docker build -f packages/merchant-node/Dockerfile -t elisym-merchant . && docker run --rm --mount type=bind,src=$HOME/.elisym-merchant-passphrase,dst=/run/secrets/merchant,readonly --entrypoint cat elisym-merchant /run/secrets/merchant > /dev/null && docker stop shop && docker run --rm --mount type=bind,src=$HOME/.elisym-merchant-passphrase,dst=/run/secrets/merchant,readonly -e ELISYM_MERCHANT_PASSPHRASE_FILE=/run/secrets/merchant -v elisym-merchant:/data elisym-merchant encrypt-keys && docker rm shop && docker run -d --name shop --restart unless-stopped --mount type=bind,src=$HOME/.elisym-merchant-passphrase,dst=/run/secrets/merchant,readonly -e ELISYM_MERCHANT_PASSPHRASE_FILE=/run/secrets/merchant -v elisym-merchant:/data elisym-merchant run
```

Leave the `--mount` and `-e` out for plain keys: `init` then says `keys    plain`. With
`--owner-only` keys, `run` needs no passphrase.

To edit the config in the volume, mount a host directory instead, for example
`-v "$PWD/shop:/data"`, and edit `shop/config.json` and the products in `shop/products/`. The directory must be writable by uid 1000.

## Credit an account: the webhook

To credit a user's account on your own backend after a payment (a deposit, a top-up), let the
node tell your backend. The node, and only the node, sends a signed `order.paid` webhook once it
has verified the payment on chain. Never credit from the browser: anything a page reports can be
forged by the buyer. The page passes your id of the account as `customer-ref` (v3 loader, level A
store on its own domain); [Credit an account](https://docs.elisym.network/commerce/credit-an-account)
walks through the page, the webhook and the receiver.

```json
"webhook": { "url": "https://shop.example.com/elisym/webhook" }
```

The URL must be `https:` on a public DNS name. For a local test receiver, add
`"allowInsecure": true` (it allows `http:` and local or private hosts). The node signs with a
secret only it and your backend hold, read from `ELISYM_MERCHANT_WEBHOOK_SECRET` or from the file
`ELISYM_MERCHANT_WEBHOOK_SECRET_FILE` names (the passphrase's rules: one trailing newline dropped,
an empty file or both set is an error). It must be at least 32 bytes:

```bash
[ -s ~/.elisym-merchant-webhook ] || (umask 077 && openssl rand -hex 32 > ~/.elisym-merchant-webhook)
export ELISYM_MERCHANT_WEBHOOK_SECRET_FILE=~/.elisym-merchant-webhook
npx @elisym/merchant-node webhook test
```

`run` refuses to start with a webhook and no secret. The secret is never written to the home,
never logged and never shown by `orders`. In Docker, mount the file and name it with `-e`, as the
passphrase above.

Each request is a `POST` with `Content-Type: application/json` and these headers:

| Header               | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| `X-Elisym-Event`     | `order.paid` (or `test` from `webhook test`)                            |
| `X-Elisym-Event-Id`  | The event id, also in the body                                          |
| `X-Elisym-Timestamp` | Unix seconds of this attempt                                            |
| `X-Elisym-Signature` | `v1=` and the hex HMAC-SHA256, keyed by the secret, of `timestamp.body` |

The body (compact JSON; `customerRef` and `email` only when the order has them; the display
fields only for a coin the node knows):

```json
{
  "event": "order.paid",
  "eventId": "<hex>",
  "store": "<store pubkey hex>",
  "orderId": "<uuid>",
  "buyerPubkey": "<hex>",
  "customerRef": "user-123",
  "product": { "address": "30402:<store>:<d>" },
  "payment": {
    "asset": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "1000000",
    "amountDisplay": "1",
    "decimals": 6,
    "symbol": "USDC",
    "tx": "<transaction>",
    "medium": "solana",
    "paidAt": 1791100000
  },
  "email": "buyer@example.com"
}
```

`payment.amount` is what the node verified on chain, in subunits: credit that, never a total the
buyer claims. `customerRef` is your own id for the account, which the page passed to the checkout.

What your receiver does, in this order:

1. Read the raw body. Refuse a timestamp more than 300 seconds from your clock, and a signature
   that does not match (compare with `crypto.timingSafeEqual` on equal-length buffers).
2. Answer `test` with 2xx and credit nothing. For `order.paid`, check that `store` is your
   store's key, `product.address` is in your own allowlist of deposit products, `payment.asset`
   is in your own allowlist of exact asset ids (take the decimals from it, not from the body),
   and `customerRef` names an account you know. The product check matters: any buyer can add a
   `customer-ref` in devtools, so without it a buyer of another product of yours would get that
   product and an equal balance. An event that fails a check is inserted as `queued` with what
   the node verified, credits nothing and answers 2xx (an error would be retried for 7 days).
3. In one database transaction: insert the event as `credited`, and credit the account only when
   the row was inserted. A duplicate (the node sends at least once) answers 2xx and credits
   nothing.
4. Answer 2xx only after the commit. Any other answer, or none within 10 seconds, is retried: keep
   5xx for your own failures (the database is down).

The events table keeps every row for good, with two unique keys: the event id, and the order
itself, so neither a resend nor a hand credit of the same order credits twice:

```sql
CREATE TABLE elisym_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     TEXT UNIQUE,               -- null for an order answered by hand (no webhook)
  store        TEXT NOT NULL,
  buyer_pubkey TEXT NOT NULL,
  order_id     TEXT NOT NULL,
  product      TEXT,                      -- product.address
  customer_ref TEXT,                      -- as the body names it, unchecked
  asset        TEXT,                      -- payment.asset
  amount       NUMERIC,                   -- payment.amount, subunits verified on chain
  account      TEXT,                      -- the account credited
  status       TEXT NOT NULL,             -- 'credited' or 'queued'
  UNIQUE (store, buyer_pubkey, order_id)
);

-- From the webhook, every check passed, in the transaction that credits:
-- credit $8 (in your allowlist's decimals) to $9 only when a row comes back.
INSERT INTO elisym_events
  (event_id, store, buyer_pubkey, order_id, product, customer_ref, asset, amount, account, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'credited')
ON CONFLICT DO NOTHING
RETURNING id;

-- Anything else that is signed (no or unknown customerRef, another store, an asset or a
-- product not on your lists): kept with what the node verified, nothing credited, answer 2xx.
INSERT INTO elisym_events
  (event_id, store, buyer_pubkey, order_id, product, customer_ref, asset, amount, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')
ON CONFLICT DO NOTHING;

-- Crediting a queued event by hand, in one transaction with the credit: credit the row's own
-- asset and amount (RETURNING) to $1, only when a row comes back.
UPDATE elisym_events SET status = 'credited', account = $1
WHERE event_id = $2 AND status = 'queued'
RETURNING id, asset, amount;
```

A queued row keeps the asset and the amount the node verified: a hand credit uses those. An order
answered by hand sends no webhook: credit it with the plain insert, `event_id` null and the
order's store, buyer and order id (`orders` lists them), in the same transaction as the credit.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const SECRET = process.env.ELISYM_MERCHANT_WEBHOOK_SECRET;
if (!SECRET) {
  throw new Error('set ELISYM_MERCHANT_WEBHOOK_SECRET');
}
const MAX_BODY_BYTES = 64 * 1024;

createServer((request, response) => {
  const chunks = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const timestamp = String(request.headers['x-elisym-timestamp'] ?? '');
    const mac = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    const expected = Buffer.from(`v1=${mac}`);
    const given = Buffer.from(String(request.headers['x-elisym-signature'] ?? ''));
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
    if (!fresh || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      response.writeHead(401).end();
      return;
    }
    try {
      await creditOnce(JSON.parse(body)); // steps 2 and 3: queues, never throws, on a failed check
      response.writeHead(200).end();
    } catch {
      response.writeHead(500).end(); // the node sends it again later
    }
  });
}).listen(8080);
```

Delivery and retries:

- The entry is written in the same ledger save that records the payment, so a crash never loses
  it: a restarted node sends what is pending. Delivery to the buyer never waits on it.
- A failed attempt is retried after 30 seconds, doubling to an hour, for 7 days; then it is
  `failed`. `orders` shows each paid order's webhook state (`pending`, `sent`, `failed`, or
  `none`) and its event id. `webhook retry` sends a pending or failed one again now (node stopped).
- No redirect is followed, the answer body is read up to 4 KiB and ignored.
- Under Bun (the Docker image runs the node with Bun), the webhook request goes through the proxy
  that `HTTP_PROXY` / `HTTPS_PROXY` name, as every other request of the node does; Bun has no
  per-request way to turn that off. Unset them for the node, or list your backend's host in
  `NO_PROXY` when the node starts, unless you mean the webhook to go through that proxy. Under
  Node.js (`npx`), it uses no proxy unless Node is told to (`NODE_USE_ENV_PROXY=1`).
- `eventId` is the hex sha256 of `<store pubkey>:<buyer>:<orderId>:<payment transaction>`: the
  same for every send of a payment, and different for two orders one Tempo transaction paid.
- To rotate the secret, let the receiver accept the old and the new one, set the new one and
  restart the node (it signs every attempt afresh, pending ones too), then drop the old one.

What sends no webhook on its own (a credit made by hand records the event id, or the order key
when there is none, so a later webhook never credits it twice):

- A payment verified while no webhook was configured, or by a node older than 0.7.0:
  `webhook resend <buyer>:<orderId>` sends it now.
- An order answered by hand (`deliver`, `refund`): `orders` and the command show its reference.
- A payment the node never saw: a node offline for longer than the three-day catch-up window
  can miss payments for orders placed before it went down.

The [admin page](#admin) shows each order's reference; the webhook state is in `orders` only.

## Keeping it safe

- `keys.json` holds the store key and the owner key. Whoever has them can publish a different
  payout address in your store's name. Keep the home private (the node creates it as `0700`)
  and back it up. A lost key means a new store.
- The owner's payout list must name only payouts this node checks: on its networks, at the
  addresses its ledger records. `run` refuses to start when the published list names another
  one, for example a Tempo address added from elsewhere without a `tempo` block, or an address
  `setup` did not record. A buyer could pay that address and never get a delivery. It refuses the same way
  when the published listing asks a price the ledger does not record (a `setup` killed
  between publishing and recording, for example by `docker stop`), and when the published
  inbox list names a relay the node does not read (the config changed without `setup`). Run
  `setup` to publish what the config names, then `run`.
- The node never sends email. It records the buyer's email when the checkout asked for one
  (`orders` lists it), and sending anything is up to you.
- `ledger.json` records which transaction paid which order. Do not edit it or restore an older
  copy while orders are open: a payment could then be credited twice.

## Limits

- One network per node; any number of products, each in its own directory: USDC on Solana and
  stablecoins on Tempo (Moderato on devnet). Every product shares the store's payout list.
- Delivery is each product's link or text. Uploading a file to Blossom is up to you; the link
  goes in the product's `delivery.value`.
- Refunds are made by hand from your wallet. `refund` reports one to the buyer of an order the
  node did not credit; a refund of a delivered order is between you and the buyer.
- Every answer the node sends a buyer (a delivery, a hand answer) is also wrapped to the store's
  own key and published to its inbox relays, so the [admin page](#admin) can read what the node
  answered. These copies are never read back as orders.
