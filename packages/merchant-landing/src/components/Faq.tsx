import { LOCAL_ADMIN_COMMAND, PRODUCT_NAME } from '../constants';
import { Icon } from './Icon';
import { SectionHeading } from './SectionHeading';

const QUESTIONS = [
  {
    question: 'Do I need a server?',
    answer:
      'Not necessarily. Your store is a small node: run it on your laptop, a server or in Docker, or let us host it for a monthly fee (see Run it in our cloud). It publishes your products, receives orders and confirms payments on chain. Your website itself can stay a static page.',
  },
  {
    question: 'Where does the money go?',
    answer: `From the buyer's wallet to the wallet you list, in one transaction. ${PRODUCT_NAME} never holds funds, so there is nothing to withdraw and no platform account that can be frozen.`,
  },
  {
    question: 'Which networks and wallets work?',
    answer:
      'USDC on Solana, Ethereum, Base and Arbitrum, and USDC.e or pathUSD on Tempo. Buyers pay from a browser wallet, for example Phantom on Solana, or MetaMask on Tempo, Ethereum, Base or Arbitrum.',
  },
  {
    question: 'Can AI agents buy from my store?',
    answer:
      'Yes. Your offer is an open Nostr event, and the elisym MCP server buys it with its buy_product tool, so an agent in an MCP client pays you without a browser.',
  },
  {
    question: 'How do I see my orders?',
    answer: `Sign in to the ${PRODUCT_NAME} admin with your store key, or run the same admin on your own machine with ${LOCAL_ADMIN_COMMAND}.`,
  },
  {
    question: 'Is it open source?',
    answer: 'Yes. The checkout, the store node and the SDK are all on GitHub.',
  },
];

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-1160 px-16 py-80 sm:px-24 sm:py-112">
      <div className="grid gap-48 lg:grid-cols-[0.8fr_1.2fr]">
        <SectionHeading eyebrow="FAQ" title="Questions merchants ask" />
        <div className="divide-line border-line flex flex-col divide-y border-y">
          {QUESTIONS.map((item) => (
            <details key={item.question} className="group py-4">
              <summary className="text-16 flex cursor-pointer items-center justify-between gap-16 py-16 font-medium">
                {item.question}
                <span className="faq-plus text-text-2 shrink-0 transition-transform">
                  <Icon name="plus" className="size-20" />
                </span>
              </summary>
              <p className="text-15 text-text-2 max-w-640 pb-16 leading-relaxed">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
