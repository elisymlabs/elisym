# Deployments of `ElisymConfig`

Each entry was read back over rpc after deployment. `runtime code keccak256` is the hash
of `eth_getCode` and equals the hash of the compiled `deployedBytecode` of the commit
that deployed it (metadata is stripped: `bytecode_hash = "none"`, `cbor_metadata = false`
in `foundry.toml`, so the same source gives the same bytes).

## Tempo Moderato (testnet) - `eip155:42431`

| Field                    | Value                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| Address                  | `0x5fbde74a7ddc8133123e824ffbe161a909342b3d`                           |
| Deployment transaction   | `0x722e6cf1976a46f2883ddcb5a2cfaff55d3b51afa6bdb093030d2cff6beaa462`   |
| Block                    | 36177167 (2026-09-20)                                                  |
| Runtime code keccak256   | `0x85c2c8ec7b81dab08f32be4c4d834e7b45f6d6be5262de88a3118210529d4520`   |
| `owner()`                | `0x716EBf6Bef1C3f27ea5c315eCfc60527d97041A2` (the devnet deployer key) |
| `treasury()`             | `0x716EBf6Bef1C3f27ea5c315eCfc60527d97041A2`                           |
| `pendingOwner()`         | `0x0000000000000000000000000000000000000000` (no handover in flight)   |
| `MAX_FEE_BPS()`          | 1000                                                                   |
| `feeBps()` at deployment | 0                                                                      |

The steady-state fee on Moderato is 0: MetaMask does not batch there, so a fee would make
every purchase on the dev web app two confirmations. Test runs that need a fee raise it
for the length of the run and set it back.

To check it yourself:

```bash
cast call 0x5fbde74a7ddc8133123e824ffbe161a909342b3d "config()(uint16,address)" \
  --rpc-url https://rpc.moderato.tempo.xyz
cast call 0x5fbde74a7ddc8133123e824ffbe161a909342b3d "pendingOwner()(address)" \
  --rpc-url https://rpc.moderato.tempo.xyz
cast keccak "$(cast code 0x5fbde74a7ddc8133123e824ffbe161a909342b3d --rpc-url https://rpc.moderato.tempo.xyz)"
```

## Tempo mainnet - `eip155:4217`

Not deployed. It is the first step of the release phase, from an owner chosen for
mainnet, and the address enters the registry only after the same read-back.
