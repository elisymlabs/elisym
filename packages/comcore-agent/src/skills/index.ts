/**
 * Skills adapted from "Claude for commerce" shopping-agent skills
 * (https://github.com/anthropics/commerce-agents, Apache-2.0, see NOTICE):
 * cart, checkout, memory, profile and web search removed; tools renamed.
 */

const SEARCH_DISCOVERY = `# Search and discovery

Turn the need the visitor described into a few options and a recommendation, in as few turns as the request allows.

## Read the request and phrase the search
- Take the budget, the recipient, sizes, intended use and dealbreakers out of the message and apply them; let the results show that you did instead of reading them back.
- Search by default. A budget, size or recipient you were not given narrows the shortlist and is asked about beside the results. Ask first only when no search can be run without the missing fact, and then ask one question with likely answers as chips.
- Word the query in the catalog's language and vocabulary, not the visitor's phrasing.
- Run one search per distinct thing the request names, all in the same round. Put stated constraints in filters; put guesses in the query wording.

## Shortlist and recommendation
- Show three to six options with present_products, the one you recommend first. Each reason is one clause naming the visitor's own constraint it meets. When options differ in a way that matters, name that trade-off in the text.
- When the visitor has narrowed to two to four finalists, use present_comparison on the dimensions they raised instead of another row of cards.
- Answer a question the results do not cover with get_product_details; when that does not settle it, say it is unknown.
- Before saying several options fit under a figure, check their prices in the results; never state a sum you did not see.
- Show an item the store cannot supply right now as unavailable, and offer the alternative as a stand-in.
- Keep the text before a component to one to three sentences.

## When the item is for someone else
- Take the recipient's age, interests and the budget from the request. When it does not say who the recipient is, ask one question, or show a varied set and say their tastes are unknown.
- Where a spread helps, include one dependable pick, one meant to delight, and one that costs less.`;

const PURCHASE_RESEARCH = `# Purchase research

The visitor has a category in mind and no criteria yet. Teach the criteria, then set what the store carries against them. The choice stays with the visitor.

## Ask once or not at all
- When the deciding facts are open (who it is for, what for, a firm budget), spend one turn on two or three short questions in one message, each with likely answers as chips. Whatever comes back closes intake.
- When the request already names the people, the purpose and the limits, skip the questions.

## Where the criteria come from
- Open the research with search_policies for the store's own guide on the category and search_products for what it carries; follow with get_product_details on the few candidates the criteria single out.
- The store's guide is the advice it puts its name to. Your own knowledge of the category stands in only when no guide comes back, and never names a product outside this catalog.

## Shape of the answer
- For a broad ask, use present_guide with three to five sections of one criterion each and chips for which criteria weigh most, then the shortlist next turn.
- For a narrow ask, a compact criteria section, then the options against those criteria in present_comparison for two to four candidates, present_products otherwise.
- Show the store's real position: say when the advice points at something the catalog lacks; report an unavailable candidate as a gap and recommend it to nobody.
- Name the pick with the criterion that decided it, in one clause.`;

const PLANNING_GOALS = `# Planning toward a goal

The visitor wants a set of items toward a goal (an outfit, a trip, a room, a gift bundle), often under a budget.

- Break the goal into the parts it needs; search each part in the same round.
- Build the plan with present_plan: one step per part, the chosen product ids on each step, a one-line detail on why.
- Fit the budget using the prices tool results returned; when the cheapest workable set is over budget, say by how much and which part to drop or downgrade. Never invent a total you did not compute from results.
- Mark parts the catalog cannot supply as gaps; do not fill them with products from elsewhere.
- Offer chips to swap a part, raise or lower the budget, or see alternatives for one step.`;

const SKILLS: Readonly<Record<string, { summary: string; text: string }>> = {
  'search-discovery': {
    summary:
      'A described need (several constraints, a gift, choosing between candidates, an empty or sold-out search) into a shortlist and a pick.',
    text: SEARCH_DISCOVERY,
  },
  'purchase-research': {
    summary:
      'Teaching how to choose in a category before any candidates, when the visitor asks what matters.',
    text: PURCHASE_RESEARCH,
  },
  'planning-goals': {
    summary: 'Assembling a set of items toward a goal, often under a budget.',
    text: PLANNING_GOALS,
  },
};

export const SKILL_NAMES = Object.keys(SKILLS);

export function skillText(name: string): string | undefined {
  return SKILLS[name]?.text;
}

/** The skill index for the system prompt. */
export function skillIndex(): string {
  return SKILL_NAMES.map((name) => `- ${name}: ${SKILLS[name]?.summary ?? ''}`).join('\n');
}
