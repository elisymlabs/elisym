# @elisym/merchant-node

The self-hosted store behind the elisym checkout. It publishes your product to Nostr, takes
orders sent by the checkout widget, checks each Solana payment on chain, and sends the
buyer what they bought.

You do not need an account or a server of ours. The node holds your store's keys and a small
ledger on your own disk.

## What you need

- Node.js 22.4 or newer, or Docker.
- A Solana wallet address to be paid to (USDC).
- A Solana RPC endpoint for the node itself. On mainnet, use your own provider key
  (Helius, Triton, ...). A key restricted to a browser origin does not work from a server.
- What the buyer gets once paid: a link (a Blossom URL, a course page, a download) or text
  (a license key).

## Quick start (devnet)

```bash
npx @elisym/merchant-node init --network devnet
```

This creates `~/.elisym-merchant/` with a `config.json` to edit and the store's keys. Edit
`config.json`:

- `name`, `product.title`, `product.description` and `product.priceUsd`: what the store
  sells, at what price, in USD. It is paid 1:1 in USDC.
- `payouts[0].address`: your Solana wallet address.
- `product.delivery.value`: the link or text the buyer gets.

Then publish the store and start taking orders:

```bash
npx @elisym/merchant-node setup
npx @elisym/merchant-node run
```

`setup` prints the product's `naddr`. Put it in the checkout snippet on your page:

```html
<elisym-buy product="naddr1..." network="devnet"></elisym-buy>
<script
  src="https://pay.elisym.network/v1/embed.js"
  integrity="<see the checkout docs>"
  crossorigin="anonymous"
></script>
```

Keep `run` running. If it stops, a restart catches up on the orders and payments it missed.
Gift wraps stay on the relays for two days, and payments are read back from the chain.

## Commands

| Command  | What it does                                                                        |
| -------- | ----------------------------------------------------------------------------------- |
| `init`   | Creates the home: a `config.json` template (never overwritten) and the store's keys |
| `setup`  | Checks the inbox relays, publishes the store, and records the terms it offers       |
| `run`    | Takes orders, verifies payments and delivers                                        |
| `orders` | Lists the orders: open, paid, delivered, and the buyer's email                      |
| `check`  | Checks the inbox relays, the owner's payout list and the domain                     |

Every command takes `--home <dir>`. Without it, the home is `$ELISYM_MERCHANT_HOME`, else
`~/.elisym-merchant`.

Run `setup` again after every change to `config.json`, except `product.d`: a store sells one
product, and `setup` refuses a new id (the old listing would stay payable with no one taking its
orders). Give a new product its own home. Stop `run` first: `setup` refuses to
run while a node holds the home. Run `run` again afterwards. If only part of a change reaches
the relays (for example the payout list but not the listing), `setup` records what buyers can
now see, says so and fails: run it again. Each of the listing, the payout list and the inbox
list must also reach at least one of the relays every checkout reads
(`wss://relay.elisym.network`, `wss://relay.damus.io`, `wss://nos.lol`,
`wss://relay.nostr.band`), whatever inbox relays the store uses; `setup` fails until one
takes it.

The home's lock (`run.lock`) keeps two processes from writing the ledger at once, wherever they
run (containers and hosts sharing the home included). Its holder refreshes it every 20 seconds.
A node that stopped without releasing it leaves it behind, and the lock frees itself 90 seconds
after its last refresh. A container restarted at once may therefore fail for that long before
it starts.

## The config

| Field                     | Meaning                                                                         |
| ------------------------- | ------------------------------------------------------------------------------- |
| `name`                    | The store's name, shown in the checkout                                         |
| `nip05`                   | Optional. `_@your-domain.com` for level A (see below)                           |
| `network`                 | `devnet` or `mainnet`                                                           |
| `rpcUrl`                  | The node's Solana RPC (`https:`)                                                |
| `inboxRelays`             | 1 to 5 relays (`wss:`) where the store reads orders and replies                 |
| `product.d`               | The product's id in the store (letters, digits, `.`, `-`, `_`)                  |
| `product.title`           | Title                                                                           |
| `product.description`     | Description                                                                     |
| `product.summary`         | Optional short line                                                             |
| `product.priceUsd`        | Price in USD, such as `"49"` or `"0.50"`                                        |
| `product.delivery.method` | `access`, `download`, `license`, `api` or `webhook`: how the checkout labels it |
| `product.delivery.value`  | The link or text the buyer gets (up to 1024 characters)                         |
| `payouts`                 | One `{ "caip19": ..., "address": ... }` per coin. Solana, on `network`, only    |

The node refuses to start with a config it cannot use, and names every problem.

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

## Docker

Build from the repository root:

```bash
docker build -f packages/merchant-node/Dockerfile -t elisym-merchant .
```

The home is the volume at `/data`. Its files belong to the image's user (uid 1000).

```bash
docker run --rm -v elisym-merchant:/data elisym-merchant init --network devnet
# edit config.json in the volume, then:
docker run --rm -v elisym-merchant:/data elisym-merchant setup
docker run -d --name shop --restart unless-stopped -v elisym-merchant:/data elisym-merchant run
docker logs -f shop
```

To edit the config in the volume, mount a host directory instead, for example
`-v "$PWD/shop:/data"`, and edit `shop/config.json`. The directory must be writable by uid 1000.

## Keeping it safe

- `keys.json` holds the store key and the owner key. Whoever has them can publish a different
  payout address in your store's name. Keep the home private (the node creates it as `0700`)
  and back it up. A lost key means a new store.
- The owner's payout list must name only payouts this node checks: Solana, on its network,
  at the addresses its ledger records. `run` refuses to start when the published list names
  another one, for example a Tempo address added from elsewhere or an address `setup` did not
  record. A buyer could pay that address and never get a delivery. It refuses the same way
  when the published listing asks a price the ledger does not record (a `setup` killed
  between publishing and recording, for example by `docker stop`), and when the published
  inbox list names a relay the node does not read (the config changed without `setup`). Run
  `setup` to publish what the config names, then `run`.
- The node never sends email. It records the buyer's email when the checkout asked for one
  (`orders` lists it), and sending anything is up to you.
- `ledger.json` records which transaction paid which order. Do not edit it or restore an older
  copy while orders are open: a payment could then be credited twice.

## Limits

- One product per node, paid on Solana (USDC) on one network.
- Delivery is the configured link or text. Uploading a file to Blossom is up to you; the link
  goes in `product.delivery.value`.
- Refunds are made by hand from your wallet.
