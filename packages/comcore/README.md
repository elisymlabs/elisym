# @elisym/comcore

The ComCore protocol: a shopping assistant a merchant embeds on their site, built on Nostr.

- Catalog listings (NIP-99 kind 30402, no payment tags), policies (kind 30495) and the store's
  assistant config (kind 30496, private part encrypted to the assistant key).
- Catalog-key authority (kind 30497): the owner authorizes the keys that publish the catalog,
  read with the same semantics as Pay Core's store authorization.
- Encrypted visitor <-> assistant chat (NIP-59 gift wraps with NIP-40 expiration), session
  tickets, and `syncCatalog` to keep a key's listings in line with the merchant's data.

Event kinds other than 30402 are provisional.
