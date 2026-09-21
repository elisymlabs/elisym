# elisym-config-evm

`ElisymConfig` holds the protocol fee (basis points, capped at 10%) and the treasury of
elisym on one EVM chain. It is the twin of the `elisym-config` Solana program in
`programs/`: clients read both values at run time and ship no fallback, so the chain is
the only source of truth. The contract holds no funds and moves none, and it is not a
proxy - a new version is a new address in the SDK registry (`CHAINS` in
`packages/sdk/src/payment/chains.ts`).

- `config()` returns `(feeBps, treasury)` in one call, so a reader never pairs a fee
  from one block with a treasury from another.
- `setFeeBps`, `setTreasury` - the owner only; every change emits an event.
- `proposeOwner` / `acceptOwner` / `cancelPendingOwner` - a two-step handover, so the
  successor proves it can sign before it owns anything.

## Build and test

[Foundry](https://getfoundry.sh). No dependencies are installed: the tests declare the
few cheatcodes they use (`test/Vm.sol`) instead of vendoring `forge-std`, because this
repository takes no git submodules.

```bash
forge build
forge test
forge fmt --check
```

It runs in no CI job: the output of `forge test` goes into the pull request that
changes the contract.

## Deployments

See [`DEPLOYMENTS.md`](./DEPLOYMENTS.md). Before an address enters the SDK registry, its
runtime code hash, `owner()`, `treasury()` and `config()` are read back over rpc and
recorded there.
