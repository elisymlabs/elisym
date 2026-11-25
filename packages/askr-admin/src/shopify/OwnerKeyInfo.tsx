import { Section } from '../components/Section';

interface Props {
  npub: string;
}

/** What the owner key saved at setup is for (askr-shopify 5.2). */
export function OwnerKeyInfo({ npub }: Props) {
  return (
    <Section
      title="Your owner key"
      description="The key you saved at setup is the root of your Askr store. The app manages the store for you; with the key you can always take it over yourself, or cut the app off."
    >
      <p className="text-13 text-text-2 break-all">Store ID: {npub}</p>
      <p className="text-13 text-text-2">
        Keep the key private. Whoever has it controls your store. Nobody can recover it for you.
      </p>
    </Section>
  );
}
