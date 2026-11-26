/**
 * The payout addresses whose wallet proof was made and checked in this browser
 * session (A13): the confirm step marks them, and asks for an explicit tick
 * for every other address a payout list names. Page memory only: a reload
 * forgets them, as it should (the page cannot tell where a stored proof came from).
 */
export class ProvenPayouts {
  private readonly proven = new Set<string>();

  private static keyOf(caip19: string, address: string): string {
    const canonical = caip19.startsWith('eip155:') ? address.toLowerCase() : address;
    return `${caip19}\n${canonical}`;
  }

  add(caip19: string, address: string): void {
    this.proven.add(ProvenPayouts.keyOf(caip19, address));
  }

  has(caip19: string, address: string): boolean {
    return this.proven.has(ProvenPayouts.keyOf(caip19, address));
  }
}
