# Demo store

A local store page that sells one product through the production checkout. Use it to try a
purchase end to end on devnet or on mainnet, in USDC on Solana or in a stablecoin on Tempo,
without a domain or a hosting account.

The page is plain HTML. It loads the checkout from `pay.elisym.network` with the
`<elisym-buy>` element: a Buy button that opens the checkout in a modal (tick "Show the
checkout in the page" for the inline layout). It logs the `elisym-status` events the checkout
sends, and when the modal opens and closes. The product and the network come from the page
URL, so one page serves any store.

A store with no `nip05` is trust level C: the checkout shows that no domain vouches for it. A
payout list published in the last 72 hours also asks the buyer to confirm where the money goes.
Both are expected for a new demo store. A level A store (one whose domain vouches for it, see
[the node's README](../../packages/merchant-node/README.md)) sells only on its own domain, so
this page cannot show it.

## What you need

- Node.js 22.4 or newer for the store's node, and Bun to serve the page.
- A wallet for the buyer: Phantom (or another Solana wallet) for Solana, MetaMask (or another
  EIP-6963 wallet) for Tempo.
- A payout address that is **not** the buyer's wallet. A wallet paying itself moves no money,
  and the node cannot credit that payment.

## 1. Start a store on devnet

```bash
npx @elisym/merchant-node init --network devnet --home ~/.elisym-demo-devnet
```

Set the payout address and the price (put your own devnet Solana address):

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.elisym-demo-devnet/config.json`;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.name = "elisym demo store";
config.rpcUrl = "https://api.devnet.solana.com";
config.product = {
  d: "demo",
  title: "Demo product",
  description: "A test purchase through the elisym checkout.",
  priceUsd: "0.01",
  delivery: { method: "access", value: "https://elisym.network" },
};
config.payouts[0].address = "<your devnet payout address>";
fs.writeFileSync(path, JSON.stringify(config, null, 2));
'
npx @elisym/merchant-node setup --home ~/.elisym-demo-devnet
npx @elisym/merchant-node run --home ~/.elisym-demo-devnet
```

`setup` prints a line starting with `naddr`: that is the product. Keep `run` running in its own
terminal.

## 2. Open the page

From the repository root:

```bash
bun examples/demo-store/serve.ts
```

Open http://localhost:5190, paste the `naddr`, pick the network and open the store. The URL
then carries the product, so you can bookmark it.

The buyer's wallet needs devnet USDC (the [Circle faucet](https://faucet.circle.com) gives it on
Solana devnet) and a little devnet SOL for the fee.

## 3. Add Tempo (optional)

Stop `run`, add a Tempo payout, publish again and restart. On devnet the store takes pathUSD on
Moderato, Tempo's testnet (put your own Tempo address, lowercase):

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.elisym-demo-devnet/config.json`;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.tempo = { network: "moderato" };
config.payouts.push({
  caip19: "eip155:42431/erc20:0x20c0000000000000000000000000000000000000",
  address: "<your Tempo payout address, lowercase>",
});
fs.writeFileSync(path, JSON.stringify(config, null, 2));
'
npx @elisym/merchant-node setup --home ~/.elisym-demo-devnet
npx @elisym/merchant-node run --home ~/.elisym-demo-devnet
```

Reload the page: the checkout now offers a choice of payouts. Connecting MetaMask asks it to add
the Tempo network. The buyer needs a little more of the coin than the price, because the wallet
takes its fee in the same coin; Tempo's
[getting funds guide](https://tempo.xyz/developers/docs/guide/getting-funds) has the testnet
faucet.

## 4. Mainnet (real money)

Use a separate home, so the devnet store keeps working:

```bash
npx @elisym/merchant-node init --network mainnet --home ~/.elisym-demo-mainnet
```

Fill in `~/.elisym-demo-mainnet/config.json` the way step 1 did, with the mainnet home and your
own product. The template's delivery link is a placeholder that passes the checks, so a real
buyer would get it: the snippet empties it instead. `setup` then refuses the config until you put the link the
buyer gets in `delivery.value`, the RPC URL in `rpcUrl` and your address in the payout.

```bash
node -e '
const fs = require("fs");
const path = `${process.env.HOME}/.elisym-demo-mainnet/config.json`;
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.name = "elisym demo store";
config.rpcUrl = "<a server-side Solana RPC URL>";
config.product = {
  d: "demo",
  title: "Demo product",
  description: "A test purchase through the elisym checkout.",
  priceUsd: "1",
  delivery: { method: "access", value: "" },
};
config.payouts[0].address = "<your mainnet payout address>";
fs.writeFileSync(path, JSON.stringify(config, null, 2));
'
```

For `rpcUrl`, a provider key restricted to a browser origin answers 403 from a server: use a
server key, or `https://api.mainnet-beta.solana.com` for a test.

For Tempo, add `"tempo": { "network": "mainnet" }` (it must match the node's network: a mainnet
store never takes Moderato) and one payout per coin you take, with your Tempo address in
lowercase:

```json
{ "caip19": "eip155:4217/erc20:0x20c000000000000000000000b9537d11c60e8b50", "address": "0x..." },
{ "caip19": "eip155:4217/erc20:0x20c0000000000000000000000000000000000000", "address": "0x..." }
```

The first is USDC.e (USDC bridged to Tempo), the second pathUSD. To get USDC.e, bridge USDC to
Tempo from another chain, for example with [Across](https://app.across.to) or
[Relay](https://relay.link/bridge).

Then `setup` and `run` with `--home ~/.elisym-demo-mainnet`, and open the page with the new
`naddr` and `mainnet`.

## Stopping

Stop `run` with Ctrl+C. A restart catches up on the orders and payments it missed while it was
down. The homes in `~/.elisym-demo-*` hold the stores' keys: delete one only when you are done
with that store.
