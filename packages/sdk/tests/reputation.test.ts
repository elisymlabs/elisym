import { finalizeEvent, type Event } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { KIND_JOB_FEEDBACK, KIND_JOB_REQUEST, KIND_JOB_RESULT } from '../src/constants';
import { ElisymIdentity } from '../src/primitives/identity';
import { requestJobIds, tallyReputation } from '../src/services/reputation';
import type { Network } from '../src/types';

const provider = ElisymIdentity.generate();
const customer = ElisymIdentity.generate();
const attacker = ElisymIdentity.generate();

let seq = 0;
function ts(): number {
  // Distinct, increasing timestamps so latest-wins is deterministic in tests.
  seq += 1;
  return 1_700_000_000 + seq;
}

function sign(
  identity: ElisymIdentity,
  kind: number,
  tags: string[][],
  content = '',
  createdAt: number = ts(),
): Event {
  return finalizeEvent({ kind, created_at: createdAt, tags, content }, identity.secretKey);
}

/** A signed job request J (kind 5xxx) authored by the customer, targeting an agent. */
function request(
  author: ElisymIdentity,
  agentPubkey: string,
  opts: { capability?: string; extraTargets?: string[] } = {},
): Event {
  const tags: string[][] = [['p', agentPubkey]];
  for (const t of opts.extraTargets ?? []) {
    tags.push(['p', t]);
  }
  tags.push(['t', 'elisym']);
  if (opts.capability) {
    tags.push(['t', opts.capability]);
  }
  return sign(author, KIND_JOB_REQUEST, tags);
}

/** A provider result R (kind 6xxx) addressed to a customer. */
function result(jobId: string, customerPubkey: string): Event {
  return sign(provider, KIND_JOB_RESULT, [
    ['e', jobId],
    ['p', customerPubkey],
    ['t', 'elisym'],
  ]);
}

/** A rating F (kind 7000). */
function rating(
  author: ElisymIdentity,
  jobId: string,
  agentPubkey: string,
  positive: boolean,
  opts: { network?: Network; capability?: string; tx?: string; extraTags?: string[][] } = {},
): Event {
  const tags: string[][] = [
    ['e', jobId],
    ['p', agentPubkey],
    ['status', 'success'],
    ['rating', positive ? '1' : '0'],
    ['t', 'elisym'],
  ];
  if (opts.capability) {
    tags.push(['t', opts.capability]);
  }
  if (opts.tx) {
    tags.push(['tx', opts.tx, 'solana']);
  }
  if (opts.network) {
    tags.push(['network', opts.network]);
  }
  for (const extra of opts.extraTags ?? []) {
    tags.push(extra);
  }
  return sign(author, KIND_JOB_FEEDBACK, tags);
}

/** A payment-completed F (kind 7000). */
function paymentCompleted(
  author: ElisymIdentity,
  jobId: string,
  agentPubkey: string,
  tx: string,
  opts: { network?: Network; createdAt?: number } = {},
): Event {
  const tags: string[][] = [
    ['e', jobId],
    ['p', agentPubkey],
    ['status', 'payment-completed'],
    ['tx', tx, 'solana'],
    ['t', 'elisym'],
  ];
  if (opts.network) {
    tags.push(['network', opts.network]);
  }
  return sign(author, KIND_JOB_FEEDBACK, tags, '', opts.createdAt);
}

const scope = [provider.publicKey];
function tally(input: {
  requests?: Event[];
  results?: Event[];
  feedback?: Event[];
  network?: Network;
}) {
  return tallyReputation({
    agentPubkeys: scope,
    requestEvents: input.requests ?? [],
    resultEvents: input.results ?? [],
    feedbackEvents: input.feedback ?? [],
    network: input.network ?? 'devnet',
  });
}

describe('tallyReputation - authorship anchor', () => {
  it('counts a rating whose author signed the job request (Nostr-verified)', () => {
    const req = request(customer, provider.publicKey);
    const feedback = rating(customer, req.id, provider.publicKey, true);
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
    }).get(provider.publicKey);
    expect(rep?.nostrVerified).toEqual({ total: 1, positive: 1 });
    expect(rep?.unverified).toEqual({ total: 0, positive: 0 });
  });

  it('does NOT count a third-party rating (author != request author) in the verified tier', () => {
    const req = request(customer, provider.publicKey);
    // Attacker posts a rating for the same job; they never signed J.
    const feedback = rating(attacker, req.id, provider.publicKey, false);
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
    }).get(provider.publicKey);
    // Not verified; and the legacy fallback binds to the result's customer
    // (customer.publicKey), which the attacker is not, so unverified is 0 too.
    expect(rep?.nostrVerified).toEqual({ total: 0, positive: 0 });
    expect(rep?.unverified).toEqual({ total: 0, positive: 0 });
  });

  it('falls back to the unverified tier when the request is unfetchable', () => {
    const req = request(customer, provider.publicKey);
    const feedback = rating(customer, req.id, provider.publicKey, true);
    // No request events supplied -> J unfetchable -> weaker result-p-tag binding.
    const rep = tally({
      requests: [],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
    }).get(provider.publicKey);
    expect(rep?.nostrVerified).toEqual({ total: 0, positive: 0 });
    expect(rep?.unverified).toEqual({ total: 1, positive: 1 });
  });

  it('rejects a broadcast job (no J.p) from the verified tier', () => {
    // Request with no `p` tag -> broadcast.
    const req = sign(customer, KIND_JOB_REQUEST, [['t', 'elisym']]);
    const feedback = rating(customer, req.id, provider.publicKey, true);
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
    }).get(provider.publicKey);
    // Strong anchor fails (no single J.p == agent); legacy fallback holds.
    expect(rep?.nostrVerified.total).toBe(0);
    expect(rep?.unverified.total).toBe(1);
  });

  it('rejects a request with two provider targets from the verified tier', () => {
    const other = ElisymIdentity.generate();
    const req = request(customer, provider.publicKey, { extraTargets: [other.publicKey] });
    const feedback = rating(customer, req.id, provider.publicKey, true);
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
    }).get(provider.publicKey);
    expect(rep?.nostrVerified.total).toBe(0);
    expect(rep?.unverified.total).toBe(1);
  });

  it('rejects a non-5xxx request kind from the verified tier', () => {
    const req = sign(customer, 1234, [
      ['p', provider.publicKey],
      ['t', 'elisym'],
    ]);
    const feedback = rating(customer, req.id, provider.publicKey, true);
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
    }).get(provider.publicKey);
    // Wrong-kind request is not indexed; legacy fallback binds by customer.
    expect(rep?.nostrVerified.total).toBe(0);
    expect(rep?.unverified.total).toBe(1);
  });

  it('does not count a rating with no delivered result', () => {
    const req = request(customer, provider.publicKey);
    const feedback = rating(customer, req.id, provider.publicKey, true);
    const rep = tally({ requests: [req], results: [], feedback: [feedback] }).get(
      provider.publicKey,
    );
    // No delivered result and no other legit activity => no reputation entry at all
    // (the rating is not counted and no longer bumps activity into a phantom entry).
    expect(rep?.nostrVerified.total ?? 0).toBe(0);
    expect(rep?.unverified.total ?? 0).toBe(0);
  });
});

describe('tallyReputation - lastActivityAt', () => {
  it('does not bump lastActivityAt from a third-party feedback with no legit job', () => {
    // Any key can sign a kind-7000 tagging `p=<victim agent>`; without the delivered-
    // result + authorship binding it must NOT count as activity (else anyone could
    // pin a victim to the top of a recency sort).
    const feedback = rating(attacker, 'f'.repeat(64), provider.publicKey, true);
    const rep = tally({ feedback: [feedback] }).get(provider.publicKey);
    expect(rep?.lastActivityAt).toBeUndefined();
  });

  it('bumps lastActivityAt from a classifier-legit rating', () => {
    const req = request(customer, provider.publicKey);
    const res = result(req.id, customer.publicKey);
    const feedback = rating(customer, req.id, provider.publicKey, true);
    const rep = tally({ requests: [req], results: [res], feedback: [feedback] }).get(
      provider.publicKey,
    );
    expect(rep?.lastActivityAt).toBeGreaterThan(0);
  });
});

describe('tallyReputation - lastPaidJobAt clamp', () => {
  it('clamps a future-dated payment-completed to now', () => {
    const req = request(customer, provider.publicKey);
    const res = result(req.id, customer.publicKey);
    const nowSecs = Math.floor(Date.now() / 1000);
    // A verified customer future-dates the payment-completed to pin the provider.
    const pc = paymentCompleted(customer, req.id, provider.publicKey, 'tx-future', {
      createdAt: nowSecs + 100 * 365 * 24 * 3600,
    });
    const rep = tally({ requests: [req], results: [res], feedback: [pc] }).get(provider.publicKey);
    expect(rep?.lastPaidJobAt).toBeDefined();
    expect(rep?.lastPaidJobAt ?? Infinity).toBeLessThanOrEqual(nowSecs + 300);
  });
});

describe('tallyReputation - network scoping', () => {
  it('ignores a rating tagged for a different network', () => {
    const req = request(customer, provider.publicKey);
    const feedback = rating(customer, req.id, provider.publicKey, true, { network: 'mainnet' });
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
      network: 'devnet',
    }).get(provider.publicKey);
    expect(rep?.nostrVerified.total ?? 0).toBe(0);
  });

  it('treats a missing network tag as devnet', () => {
    const req = request(customer, provider.publicKey);
    const feedback = rating(customer, req.id, provider.publicKey, true); // no network tag
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
      network: 'devnet',
    }).get(provider.publicKey);
    expect(rep?.nostrVerified.total).toBe(1);
  });
});

describe('tallyReputation - dedupe and tags', () => {
  it('latest-wins on a rating flip (positive then negative)', () => {
    const req = request(customer, provider.publicKey);
    const first = rating(customer, req.id, provider.publicKey, true);
    const second = rating(customer, req.id, provider.publicKey, false); // newer ts
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [first, second],
    }).get(provider.publicKey);
    expect(rep?.nostrVerified).toEqual({ total: 1, positive: 0 });
  });

  it('drops an event with a conflicting duplicate single-valued tag', () => {
    const req = request(customer, provider.publicKey);
    const feedback = rating(customer, req.id, provider.publicKey, true, {
      extraTags: [['rating', '0']], // second, conflicting rating tag
    });
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
    }).get(provider.publicKey);
    expect(rep?.nostrVerified.total ?? 0).toBe(0);
    expect(rep?.unverified.total ?? 0).toBe(0);
  });

  it('reads a multi-valued t tag: capability survives alongside t=elisym', () => {
    const req = request(customer, provider.publicKey, { capability: 'text-gen' });
    const feedback = rating(customer, req.id, provider.publicKey, true);
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [feedback],
    }).get(provider.publicKey);
    expect(rep?.byCapability['text-gen']?.nostrVerified).toEqual({ total: 1, positive: 1 });
  });

  it('per-capability keys by the request tag and the fallback tier is agent-level only', () => {
    // Verified rating: capability from J.
    const reqA = request(customer, provider.publicKey, { capability: 'image-gen' });
    const fbA = rating(customer, reqA.id, provider.publicKey, true);
    // Fallback rating (no J supplied) with an attacker-chosen capability tag on F.
    const reqB = request(customer, provider.publicKey, { capability: 'text-gen' });
    const fbB = rating(customer, reqB.id, provider.publicKey, true, { capability: 'flagship' });
    const rep = tally({
      requests: [reqA], // reqB intentionally omitted -> fallback tier
      results: [result(reqA.id, customer.publicKey), result(reqB.id, customer.publicKey)],
      feedback: [fbA, fbB],
    }).get(provider.publicKey);
    expect(rep?.byCapability['image-gen']?.nostrVerified.total).toBe(1);
    // The fallback rating must NOT land in any capability bucket (not 'flagship').
    expect(rep?.byCapability['flagship']).toBeUndefined();
    expect(rep?.unverified.total).toBe(1);
  });
});

describe('tallyReputation - lastPaidJobAt ranking bucket', () => {
  it('mints lastPaidJobAt from a request-authored payment-completed', () => {
    const req = request(customer, provider.publicKey);
    const pc = paymentCompleted(customer, req.id, provider.publicKey, 'sig-real');
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [pc],
    }).get(provider.publicKey);
    expect(rep?.lastPaidJobAt).toBe(pc.created_at);
    expect(rep?.lastPaidJobTx).toBe('sig-real');
  });

  it('a third-party payment-completed does NOT mint the victim lastPaidJobAt', () => {
    // Broadcast job the victim served; attacker posts payment-completed p=victim.
    const req = sign(customer, KIND_JOB_REQUEST, [['t', 'elisym']]); // broadcast, no J.p
    const pc = paymentCompleted(attacker, req.id, provider.publicKey, 'sig-fake');
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [pc],
    }).get(provider.publicKey);
    expect(rep?.lastPaidJobAt).toBeUndefined();
    expect(rep?.lastPaidJobTx).toBeUndefined();
  });

  it('does not mint lastPaidJobAt without a tx tag', () => {
    const req = request(customer, provider.publicKey);
    const pcNoTx = sign(customer, KIND_JOB_FEEDBACK, [
      ['e', req.id],
      ['p', provider.publicKey],
      ['status', 'payment-completed'],
      ['t', 'elisym'],
    ]);
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [pcNoTx],
    }).get(provider.publicKey);
    expect(rep?.lastPaidJobAt).toBeUndefined();
  });
});

describe('requestJobIds', () => {
  it('unions rating and payment-completed job ids', () => {
    const ratedOnly = 'job-rated';
    const paidOnly = 'job-paid';
    const ids = requestJobIds([
      rating(customer, ratedOnly, provider.publicKey, true),
      paymentCompleted(customer, paidOnly, provider.publicKey, 'sig'),
    ]);
    expect(new Set(ids)).toEqual(new Set([ratedOnly, paidOnly]));
  });
});

describe('tallyReputation - no RPC dependency', () => {
  it('is a pure function taking only events (no rpc/pool argument in its input)', () => {
    // The TallyInput shape has no rpc/pool/connection field; a full tally runs
    // with only event arrays. This guards the "zero Solana RPC" constraint at
    // the type/usage level.
    const req = request(customer, provider.publicKey);
    const rep = tally({
      requests: [req],
      results: [result(req.id, customer.publicKey)],
      feedback: [rating(customer, req.id, provider.publicKey, true)],
    });
    expect(rep.get(provider.publicKey)?.nostrVerified.total).toBe(1);
  });
});
