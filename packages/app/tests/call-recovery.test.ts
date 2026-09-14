/**
 * Which signature blocks a confirm sheet after this browser's store is lost.
 *
 * The claim a signed call leaves behind lives only in IndexedDB, so a thread
 * restored from relays carries the call envelope and nothing to stop the sheet
 * offering it again. These reports are the recovery. Picking the wrong one
 * either refuses a retry the customer is entitled to or sends them to check a
 * transaction that is not theirs.
 */
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { newestCallSignatures } from '~/routes/Agent/useChatHydration';

const KIND_JOB_FEEDBACK = 7000;
const JOB = 'a'.repeat(64);

function report(secretKey: Uint8Array, tags: string[][], createdAt: number): Event {
  return finalizeEvent(
    { kind: KIND_JOB_FEEDBACK, created_at: createdAt, tags, content: 'Call signed and sent' },
    secretKey,
  );
}

describe('newestCallSignatures', () => {
  const viewerKey = generateSecretKey();
  const viewer = getPublicKey(viewerKey);

  it('takes the newest report for a job, whatever order the relay returns', () => {
    // A job carries more than one whenever a first call failed and a later one
    // was signed. Taking whichever arrived first resurrects the dead signature.
    const older = report(
      viewerKey,
      [
        ['e', JOB],
        ['call_tx', 'old-sig', 'solana'],
      ],
      1_000,
    );
    const newer = report(
      viewerKey,
      [
        ['e', JOB],
        ['call_tx', 'new-sig', 'solana'],
      ],
      2_000,
    );
    expect(newestCallSignatures([newer, older], viewer).get(JOB)).toBe('new-sig');
    expect(newestCallSignatures([older, newer], viewer).get(JOB)).toBe('new-sig');
  });

  it('ignores a report signed by anyone but the viewer', () => {
    // The filter asked for the viewer's own events; a relay is bound only by
    // its own honesty, so somebody else's claim must never block this sheet.
    const strangerKey = generateSecretKey();
    const stranger = report(
      strangerKey,
      [
        ['e', JOB],
        ['call_tx', 'their-sig', 'solana'],
      ],
      3_000,
    );
    expect(newestCallSignatures([stranger], viewer).size).toBe(0);
  });

  it('ignores a forged event that does not verify', () => {
    const genuine = report(
      viewerKey,
      [
        ['e', JOB],
        ['call_tx', 'real-sig', 'solana'],
      ],
      1_000,
    );
    // Rebuilt field by field rather than spread: nostr-tools stamps a verified
    // event with a symbol that says "already checked", and a spread would
    // carry it onto the tampered copy - which no relay payload ever does.
    const forged: Event = {
      id: genuine.id,
      pubkey: genuine.pubkey,
      created_at: genuine.created_at,
      kind: genuine.kind,
      sig: genuine.sig,
      content: genuine.content,
      tags: [
        ['e', JOB],
        ['call_tx', 'forged-sig', 'solana'],
      ],
    };
    expect(newestCallSignatures([forged], viewer).size).toBe(0);
  });

  it('ignores the viewer’s other feedback, which carries no call', () => {
    // A rating is the same kind authored by the same person. Nothing about it
    // says a call was signed, so it must not block one.
    const rating = report(
      viewerKey,
      [
        ['e', JOB],
        ['rating', '1'],
      ],
      4_000,
    );
    expect(newestCallSignatures([rating], viewer).size).toBe(0);
  });
});
