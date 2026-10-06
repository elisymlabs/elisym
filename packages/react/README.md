# @elisym/react

The [elisym checkout](https://docs.elisym.network/commerce/widget) as a React component: the
`<elisym-buy>` element, on the pinned v3 loader. React 18 and 19.

```bash
npm install @elisym/react
```

```tsx
import { ElisymBuy } from '@elisym/react';

export function Deposit({ accountId }: { accountId: string | undefined }) {
  return (
    <ElisymBuy
      product="naddr1..."
      network="mainnet"
      theme="dark"
      label="Deposit 1 USD"
      customerRef={accountId}
      requireCustomerRef
      onPaid={() => console.log('thanks')}
    />
  );
}
```

The component renders `<elisym-buy>` and, in the browser, adds the loader's `<script>` once per
document, pinned by its `integrity` hash (`V3_LOADER_SRC`, `V3_LOADER_INTEGRITY`). Server
rendering writes the element only. Allow `https://pay.elisym.network` in your page's
`script-src` and `frame-src`.

| Prop                 | Attribute       | Meaning                                                                                  |
| -------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| `product`            | `product`       | The product's `naddr1...`, as the node's `setup` printed it. Required.                   |
| `network`            | `network`       | `mainnet` or `devnet`: only payouts on this network are offered.                         |
| `theme`              | `theme`         | `auto`, `light` or `dark`.                                                               |
| `display`            | `display`       | `modal` (a Buy button opens the checkout) or `inline`.                                   |
| `label`              | `label`         | The Buy button's text.                                                                   |
| `collectEmail`       | `collect-email` | Ask the buyer for an email (optional for them).                                          |
| `strictOrigin`       | `strict-origin` | Also refuse a store no domain vouches for. Always on with a customer reference.          |
| `customerRef`        | `customer-ref`  | Your own id of the account a payment credits (see below).                                |
| `requireCustomerRef` | `customer-ref`  | With no reference yet, the button shows disabled and nothing is framed until one is set. |
| `className`          | `class`         | The element's class.                                                                     |

A `false` boolean leaves its attribute out.

Events: `onOpen` and `onClose` (modal display; `onClose` also when the element is removed while
open), `onStatus(state)` for every state the checkout reports, and `onPaid` once the store
completed the order (`completed`). It is for your UI only: act only on your node's signed webhook.

The package's entry is client code (`'use client'`). For the loader's pin in server code, such as a
Server Component or a `Content-Security-Policy` header, import the plain values from
`@elisym/react/constants`:

```ts
import { V3_LOADER_INTEGRITY, V3_LOADER_SRC } from '@elisym/react/constants';
```

Tested with React 19; the same test suite passes on React 18.3.

## Crediting an account

`onPaid` and `onStatus` are for your UI only: a buyer can fake anything the page hears. To credit
an account, pass `customerRef` and credit only from the signed `order.paid` webhook your node
sends once it has verified the payment on chain. See
[Credit an account](https://docs.elisym.network/commerce/credit-an-account).

- A reference is honoured only for a level A store, on its own domain, in the top-level page.
- Take the reference from your server session, never from the URL, and send
  `Content-Security-Policy: frame-ancestors 'self'` on the page.
- Render the component once the reference is known (`requireCustomerRef` keeps it waiting), and
  do not change it while the checkout is open.

One loader per page: if another loader defined `<elisym-buy>` first, the component adds no
script and logs an error when it passes a reference, because an older loader ignores it.

## License

MIT
