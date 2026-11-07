import { CopyField } from '../../components/CopyField';
import { CLOUD_DOCS_URL } from '../../constants';

/** The cloud guide's products step, which an agent follows to add products by the API. */
export const PRODUCTS_STEP_URL = `${CLOUD_DOCS_URL}#7-add-the-products`;

/** What a merchant pastes into a coding agent to add many products at once. */
export const PRODUCTS_AGENT_PROMPT = [
  `Add products to my Pay Core store in elisym Cloud. Follow the products step of ${PRODUCTS_STEP_URL}.`,
  'Read my current products first, then send the whole set back with the new ones in one call: the call replaces every product, so any product you leave out is removed.',
  'My access key file is <path to the key file>. Ask me for the products: each with its name, price in USD and description.',
].join(' ');

/** "Many products?": the copyable prompt that lets a coding agent add them by the API. */
export function ProductsCallout() {
  return (
    <section
      aria-labelledby="products-agent-title"
      className="rounded-16 border-line bg-surface-2 flex flex-col gap-10 border p-16"
    >
      <h2 id="products-agent-title" className="text-15 font-semibold">
        Adding many products? Let your AI agent do it
      </h2>
      <p className="text-14 text-text-2 leading-relaxed">
        Paste this prompt into a coding agent such as Claude Code. The agent reads your access key
        file, so it can do anything you can here: give it the key only if you trust it.
      </p>
      <CopyField label="the prompt for your agent" value={PRODUCTS_AGENT_PROMPT} />
    </section>
  );
}
