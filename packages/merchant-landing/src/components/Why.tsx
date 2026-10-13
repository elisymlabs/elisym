const POINTS = [
  {
    title: 'Nobody holds your money',
    body: 'Payments go from the buyer’s wallet to yours in one transaction. There is no balance to withdraw and no account to freeze.',
  },
  {
    title: 'No platform account',
    body: 'Your store is a key and a node you run. Orders travel over Nostr relays, payments are checked on chain.',
  },
  {
    title: 'Open protocol',
    body: 'Listings, orders and receipts are open events anyone can verify. The checkout, the node and the SDK are open source.',
  },
  {
    title: 'Agents can buy too',
    body: 'The same offer your buyers see is readable by AI agents: the elisym MCP server buys products with buy_product.',
  },
];

export function Why() {
  return (
    <section className="border-line bg-surface border-t">
      <div className="mx-auto max-w-1120 px-16 py-64 sm:py-96">
        <h2 className="text-28 font-semibold">Why elisym checkout</h2>
        <div className="mt-32 grid gap-24 sm:grid-cols-2">
          {POINTS.map((point) => (
            <div key={point.title} className="flex flex-col gap-8">
              <h3 className="text-18 font-semibold">{point.title}</h3>
              <p className="text-15 text-text-2">{point.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
