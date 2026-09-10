#!/usr/bin/env python3
"""Build an UNSIGNED Solana transfer for the customer to sign.

mode: onchain - the buyer's text arrives on stdin, one call envelope goes to
stdout. This agent never signs and never holds the funds; it only knows how to
shape the call. Standard library only, so the skill runs anywhere python does.

The buyer's text is the ONLY input: no wallet address is handed to a provider,
so the signer has to be named in the message, and so does the destination.
"""

import base64
import json
import os
import re
import struct
import sys
import time
import urllib.request

SYSTEM_PROGRAM = "11111111111111111111111111111111"
TRANSFER_DISCRIMINATOR = 2
LAMPORTS_PER_SOL = 1_000_000_000
CALL_TTL_SECONDS = 600
B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

NETWORK = os.environ.get("ELISYM_NETWORK", "devnet")
RPC_URL = os.environ.get(
    "SOLANA_RPC_URL",
    "https://api.devnet.solana.com" if NETWORK == "devnet" else "https://api.mainnet-beta.solana.com",
)


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


def b58decode(text):
    number = 0
    for character in text:
        index = B58_ALPHABET.find(character)
        if index < 0:
            fail(f"'{text}' is not a Solana address")
        number = number * 58 + index
    decoded = number.to_bytes(32, "big") if number.bit_length() <= 256 else b""
    leading_zeros = len(text) - len(text.lstrip("1"))
    body = decoded[leading_zeros:] if leading_zeros else decoded
    result = b"\x00" * leading_zeros + body
    if len(result) != 32:
        fail(f"'{text}' is not a 32-byte Solana address")
    return result


def compact_u16(value):
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def latest_blockhash():
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "getLatestBlockhash", "params": [{"commitment": "confirmed"}]}
    ).encode()
    request = urllib.request.Request(RPC_URL, data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        body = json.load(response)
    if "result" not in body:
        fail(f"the cluster would not give a blockhash: {body.get('error')}")
    return body["result"]["value"]["blockhash"]


def build_wire_transaction(payer, destination, lamports, blockhash):
    """A v0 message with one System transfer, and an empty signature slot."""
    if payer == destination:
        fail("the destination is the signer's own wallet, so this call would move nothing")
    keys = [b58decode(payer), b58decode(destination), b58decode(SYSTEM_PROGRAM)]

    message = bytearray()
    message.append(0x80)  # v0
    message += bytes([1, 0, 1])  # 1 signer, 0 readonly signed, 1 readonly unsigned
    message += compact_u16(len(keys))
    for key in keys:
        message += key
    message += b58decode(blockhash)

    data = struct.pack("<IQ", TRANSFER_DISCRIMINATOR, lamports)
    message += compact_u16(1)  # one instruction
    message.append(2)  # program: the System program, at index 2
    message += compact_u16(2) + bytes([0, 1])  # accounts: payer, destination
    message += compact_u16(len(data)) + data
    message += compact_u16(0)  # no address lookup tables

    return base64.b64encode(compact_u16(1) + bytes(64) + bytes(message)).decode()


def parse_request(text):
    addresses = re.findall(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b", text)
    if len(addresses) < 2:
        fail(
            "name two Solana addresses: your own wallet first (it signs and pays), "
            "then where the SOL should go"
        )
    amounts = re.findall(r"(\d+(?:\.\d+)?)\s*(?:sol\b|$)", text, flags=re.IGNORECASE)
    if not amounts:
        fail("say how much SOL to send, for example '0.01 SOL'")
    lamports = int(round(float(amounts[0]) * LAMPORTS_PER_SOL))
    if lamports <= 0:
        fail("the amount has to be more than zero")
    return addresses[0], addresses[1], lamports


def main():
    signer, destination, lamports = parse_request(sys.stdin.read())
    envelope = {
        "elisym_call": "v1",
        "network": NETWORK,
        "transaction": build_wire_transaction(signer, destination, lamports, latest_blockhash()),
        "signer": signer,
        "expires_at": int(time.time()) + CALL_TTL_SECONDS,
        "explain": [
            {
                "kind": "transfer",
                "asset": "sol",
                "amount": f"{lamports / LAMPORTS_PER_SOL:g}",
                "to": destination,
            }
        ],
    }
    json.dump(envelope, sys.stdout)


main()
