# @elisym/merchant-node

The self-hosted store behind the elisym checkout. It publishes your product to Nostr, takes
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

| Command        | What it does                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init`         | Creates the home: a `config.json` template (never overwritten) and the store's keys, encrypted when a passphrase is set (see [Keys at rest](#keys-at-rest))                                                                                            |
| `setup`        | Checks the inbox relays, publishes the store, and records the terms it offers                                                                                                                                                                          |
| `run`          | Takes orders, verifies payments and delivers                                                                                                                                                                                                           |
| `orders`       | Lists the orders: open, paid, delivered, and the buyer's email                                                                                                                                                                                         |
| `check`        | Checks the inbox relays, the owner's payout list and the domain                                                                                                                                                                                        |
| `deliver`      | Answers an unpaid order by hand with the configured delivery (node stopped)                                                                                                                                                                            |
| `refund`       | Answers an unpaid order by hand with a refund you already sent (node stopped); `--asset <caip19>` names the refunded coin, required when the store has several payouts; a rerun of an answer kept by an older node is sent unchanged, without an asset |
| `encrypt-keys` | Encrypts the keys of an existing home with the passphrase (both by default, `--owner-only` for the owner key only); node stopped                                                                                                                       |
| `store-key`    | Prints the store's secret key (nsec), for the admin page on this machine: only to a terminal, or with `--yes`                                                                                                                                          |

Every command takes `--home <dir>`. Without it, the home is `$ELISYM_MERCHANT_HOME`, else
`~/.elisym-merchant`.

Run `setup` again after every change to `config.json`, except `product.d`: a store sells one
product, and `setup` refuses a new id (the old listing would stay payable with no one taking its
orders). Give a new product its own home. Stop `run` first: `setup` refuses to
run while a node holds the home. Run `run` again afterwards. If only part of a change reaches
the relays (for example the payout list but not the listing), `setup` records what buyers can
now see, says so and fails: run it again. Each of the listing, the payout list and the inbox
list must also reach at least one of the relays every checkout reads
(`wss://relay.elisym.network`, `wss://relay.damus.io`, `wss://nos.lol`), whatever inbox
relays the store uses; `setup` fails until one takes it.

The home's lock (`run.lock`) keeps two processes from writing the ledger at once, wherever they
run (containers and hosts sharing the home included). Its holder refreshes it every 20 seconds.
A node that stopped without releasing it leaves it behind, and the lock frees itself 90 seconds
after its last refresh. A container restarted at once may therefore fail for that long before
it starts.

## The config

| Field                     | Meaning                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `name`                    | The store's name, shown in the checkout                                                             |
| `nip05`                   | Optional. `_@your-domain.com` for level A (see below)                                               |
| `network`                 | `devnet` or `mainnet`                                                                               |
| `rpcUrl`                  | The node's Solana RPC (`https:`). Needed with a Solana payout                                       |
| `tempo`                   | Optional. `{ "network": ... }` matching `network` (`moderato` on devnet), plus an optional `rpcUrl` |
| `inboxRelays`             | 1 to 5 relays (`wss:`) where the store reads orders and replies                                     |
| `product.d`               | The product's id in the store (letters, digits, `.`, `-`, `_`)                                      |
| `product.title`           | Title                                                                                               |
| `product.description`     | Description                                                                                         |
| `product.summary`         | Optional short line                                                                                 |
| `product.priceUsd`        | Price in USD, such as `"49"` or `"0.50"`                                                            |
| `product.delivery.method` | `access`, `download`, `license`, `api` or `webhook`: how the checkout labels it                     |
| `product.delivery.value`  | The link or text the buyer gets (up to 1024 characters)                                             |
| `payouts`                 | One `{ "caip19": ..., "address": ... }` per coin, see [Tempo payouts](#tempo-payouts)               |

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

Edit `config.json` in the volume, then publish and start the node:

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
`-v "$PWD/shop:/data"`, and edit `shop/config.json`. The directory must be writable by uid 1000.

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

- One product per node, on one network: USDC on Solana and stablecoins on Tempo (Moderato on
  devnet).
- Delivery is the configured link or text. Uploading a file to Blossom is up to you; the link
  goes in `product.delivery.value`.
- Refunds are made by hand from your wallet. `refund` reports one to the buyer of an order the
  node did not credit; a refund of a delivered order is between you and the buyer.
- Every answer the node sends a buyer (a delivery, a hand answer) is also wrapped to the store's
  own key and published to its inbox relays, so a later admin view can read what the node
  answered. These copies are never read back as orders.
