---
name: sol-transfer-call
description: Builds an unsigned Solana transfer for you to sign yourself - this agent never holds your funds. Put YOUR wallet address first in the message, then the destination, then the amount, for example "from <your address> to <their address>, 0.01 SOL".
capabilities:
  - onchain-call
  - transfer
price: 0.01
token: usdc
mode: onchain
script: ./scripts/build_transfer.py
onchain:
  kind: transfer
  # Quoted: the System program's address is all digits, and bare YAML reads it as a number.
  programs:
    - '11111111111111111111111111111111'
  token: sol
  max_per_call: '0.1'
  params:
    - { name: wallet, type: address, required: true, description: The wallet that signs and pays }
    - { name: destination, type: address, required: true, description: Where the SOL goes }
    - { name: amount, type: amount, required: true, description: How much SOL to send }
---
