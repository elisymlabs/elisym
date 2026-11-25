/**
 * This site's `/llms.txt` (the llms.txt form: an H1, a one-line summary, then sections of
 * links), for AI agents. Written at build time (`vite.config.ts`) from the same constants the
 * page shows, so its plans, prices and links never drift from the landing.
 */
import { AGENT_PROMPT } from './agent-prompt';
import {
  ADMIN_URL,
  AGENT_SETUP_ID,
  API_ORIGIN,
  CHOOSE_PLAN_TEXT,
  CONTACT_REDIRECT_URL,
  CONTRACT_PRICE_NOTE,
  type ContractPlan,
  DOCS,
  DOCS_LLMS_TXT_URL,
  type FlatPlan,
  GITHUB_URL,
  PLANS,
  PRICE_TAX_NOTE,
  PRICING_SMALL_PRINT,
  PRICING_URL,
  PRODUCT_NAME,
  PRODUCT_PITCH,
  SITE_URL,
  WIDGET_SRC,
  WORKS_WITH_TEXT,
  isContractPlan,
  isFlatPlan,
} from './constants';
import { PRIVACY_PATH, TERMS_PATH } from './legal';

/** Where the file is served on this site. */
export const LLMS_TXT_PATH = '/llms.txt';
/** A store's public files on the Askr server, with the placeholder the docs use for its ID. */
const STORE_FILES_BASE = `${API_ORIGIN}/s/npub1...`;
/** How every setup command runs, as the prompt says it (a test keeps it in the prompt). */
export const CLI_COMMAND = 'npx -y @elisym/cli@latest askr <command>';

/** A plan's features as one sentence: the first as written, the rest from a lower-case letter. */
function features(plan: FlatPlan | ContractPlan): string {
  const [first = '', ...rest] = plan.features;
  const tail = rest.map((feature) => `${feature.charAt(0).toLowerCase()}${feature.slice(1)}`);
  return `${[first, ...tail].join('; ')}.`;
}

/** A flat plan as one list item, with every price as the card shows it. */
function flatPlanLine(plan: FlatPlan): string {
  const { price } = plan;
  const cost =
    price.monthly === '$0'
      ? `${price.monthly} / month, no payment needed`
      : `${price.monthly} / month ${PRICE_TAX_NOTE} billed monthly, or ${price.yearlyPerMonth} / month ${PRICE_TAX_NOTE} billed yearly (${price.yearlyTotal} a year)`;
  return `- **${plan.name}**: ${cost}. ${plan.blurb} ${features(plan)}`;
}

function contractPlanLine(plan: ContractPlan): string {
  return `- **${plan.name}**: from ${plan.price.monthly} / month ${PRICE_TAX_NOTE}. ${CONTRACT_PRICE_NOTE}. ${plan.blurb} ${features(plan)}`;
}

function planLines(): string[] {
  return PLANS.flatMap((plan) => {
    if (isFlatPlan(plan)) {
      return [flatPlanLine(plan)];
    }
    if (isContractPlan(plan)) {
      return [contractPlanLine(plan)];
    }
    return [];
  });
}

export function renderLlmsTxt(): string {
  return [
    `# ${PRODUCT_NAME}`,
    '',
    `> ${PRODUCT_PITCH}`,
    '',
    `${PRODUCT_NAME} is an AI shopping assistant for online stores: a chat on the store's own pages. ${WORKS_WITH_TEXT} This file is for AI agents: how to set ${PRODUCT_NAME} up for a store, what it costs, and how a shopper's agent reads a store that uses it.`,
    '',
    `## Set up ${PRODUCT_NAME} for a store`,
    '',
    `An AI coding agent with a terminal can do the whole setup for a merchant with the ${PRODUCT_NAME} CLI, every command as \`${CLI_COMMAND}\` (Node 22 or newer), reading its JSON output. It reads the store's site, asks the merchant its questions once, creates the store (\`askr init\`), publishes the products and policies, adds the chat widget (\`askr embed\`) and checks that it answers (\`askr status --probe\`). The merchant chooses the plan. The full prompt to follow is under "Setup prompt" at the end of this file, the same one this site copies and the docs show.`,
    '',
    `- [Set up with an AI agent](${DOCS.agentSetup}): the guide, the prompt and what each step does`,
    `- [The prompt on the landing](${SITE_URL}/#${AGENT_SETUP_ID}): with a Copy button for the merchant`,
    `- [Embed the widget](${DOCS.embed}): the script tag (\`${WIDGET_SRC}\`) and its options`,
    `- [Catalog from an agent](${DOCS.catalogFromAnAgent}): publishing a catalog with the store's own catalog key`,
    '',
    '## Plans and prices',
    '',
    ...planLines(),
    '',
    `${PRICING_SMALL_PRINT} ${CHOOSE_PLAN_TEXT}`,
    '',
    `- [Pricing](${PRICING_URL}): the plans on this site`,
    `- [Contact](${CONTACT_REDIRECT_URL}): message us about a plan`,
    '',
    "## How a shopper's agent reads a store",
    '',
    `Every active store has two public, read-only files on the ${PRODUCT_NAME} server, with its Store ID (its npub) in place of \`npub1...\`. Reading them opens no chat and costs the store none of its chat budget. Nothing is bought there: purchases happen on the store's own site.`,
    '',
    `- \`${STORE_FILES_BASE}/llms.txt\`: the store's products (title, price, link to its page) and its policies, as Markdown`,
    `- \`${STORE_FILES_BASE}/catalog.json\`: the same store, policies and products as JSON, for programs`,
    '',
    `A store's own site may link both from its own \`/llms.txt\`, under a "Shopping assistant" heading.`,
    '',
    `- [AI agents and your store](${DOCS.aiAgents}): both files in full, and the store site's llms.txt`,
    `- [${PRODUCT_NAME} server](${API_ORIGIN}${LLMS_TXT_PATH}): the server's own llms.txt`,
    '',
    '## Docs',
    '',
    `- [Overview](${DOCS.overview}): how ${PRODUCT_NAME}, its keys and the store data fit together`,
    `- [The admin, field by field](${DOCS.admin}): every section and field of the admin`,
    `- [Docs for AI agents](${DOCS_LLMS_TXT_URL}): the whole documentation`,
    '',
    '## Links',
    '',
    `- [Admin](${ADMIN_URL}): where a merchant starts free and runs the store, signed in with the store's secret key`,
    `- [Privacy policy](${SITE_URL}${PRIVACY_PATH})`,
    `- [Terms of service](${SITE_URL}${TERMS_PATH})`,
    `- [Contact](${CONTACT_REDIRECT_URL})`,
    `- [Source code](${GITHUB_URL})`,
    '',
    '## Setup prompt',
    '',
    `The prompt a merchant pastes into an AI coding agent to set up ${PRODUCT_NAME}. An agent asked to set up ${PRODUCT_NAME} follows it as written.`,
    '',
    '```text',
    AGENT_PROMPT,
    '```',
    '',
  ].join('\n');
}
