import type { ElisymClient, ElisymIdentity } from '@elisym/sdk';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { useJobHistory } from '~/hooks/useJobHistory';
import { usePageVisible } from '~/hooks/usePageVisible';
import { SOLANA_CLUSTER } from '~/lib/cluster';
import { decodeResult, resultDisplay } from '~/lib/fileResult';
import { isTerminalJobStatus, localJobNetwork, readJobs } from '~/lib/jobHistory';
import { buildJobRows, type JobRowData } from './lib/rows';

/** Relay merge window and request limit (plan decision 7). */
const RELAY_WINDOW_SECS = 30 * 24 * 60 * 60;
const RELAY_FETCH_LIMIT = 300;

interface DecryptedJobResult {
  content: string;
  decryptionFailed: boolean;
}

interface RelaySide {
  jobs: Awaited<ReturnType<ElisymClient['marketplace']['fetchRecentJobs']>>;
  results: Map<string, DecryptedJobResult>;
}

/**
 * Side-effect-free relay fetch: requests authored by this identity, plus a
 * decrypted-results batch for LOCAL NON-TERMINAL rows only - the page never
 * displays result content (that lives on the agent's Chat tab), the batch
 * exists solely to flip stuck local rows (decision 2). Local rows are read
 * fresh (non-reactively) here - the id set depends on them, but the query
 * must not re-run on every store write.
 */
async function fetchRelaySide(
  client: ElisymClient,
  identity: ElisymIdentity,
  wallet: string,
): Promise<RelaySide> {
  const identityPubkey = identity.publicKey;
  const since = Math.floor(Date.now() / 1000) - RELAY_WINDOW_SECS;
  const fetched = await client.marketplace.fetchRecentJobs(
    undefined,
    RELAY_FETCH_LIMIT,
    since,
    undefined,
    identityPubkey,
  );
  // Relay-distrust verification (the MCP precedent): a relay ignoring the
  // `authors` filter must not inject other customers' jobs.
  const jobs = fetched.filter((job) => job.customer === identityPubkey);

  // Local non-terminal rows are queried for results, independent of
  // request-event retention on the relays (the `submitted`-forever free-job
  // case has no resumable poller path) - but only within the same 30-day
  // window: some rows can never turn terminal (an error feedback that landed
  // while the tab was closed is not fetched here), and without the cutoff
  // the id list would grow forever. Past the window the result has expired
  // off the relays anyway, so querying it is futile. Bound to the local
  // row's provider - an unbound id would accept a forged higher-created_at
  // result.
  const localCutoffMs = Date.now() - RELAY_WINDOW_SECS * 1000;
  const providerByRequest = new Map<string, string>();
  const resultIds: string[] = [];
  for (const local of readJobs(wallet)) {
    // Wrong-network rows are hidden by the merge (D13) - do not spend result
    // queries flipping entries the page will never show.
    if (
      localJobNetwork(local) !== SOLANA_CLUSTER ||
      isTerminalJobStatus(local.status) ||
      local.createdAt < localCutoffMs
    ) {
      continue;
    }
    resultIds.push(local.jobEventId);
    providerByRequest.set(local.jobEventId, local.agentPubkey);
  }

  let results = new Map<string, DecryptedJobResult>();
  if (resultIds.length > 0) {
    const decrypted = await client.marketplace.queryJobResults(
      identity,
      resultIds,
      undefined,
      undefined,
      providerByRequest,
    );
    results = new Map(
      [...decrypted.entries()].map(([id, value]) => [
        id,
        { content: value.content, decryptionFailed: value.decryptionFailed },
      ]),
    );
  }
  return { jobs, results };
}

export function useJobsMerge(): {
  rows: JobRowData[];
  wallet: string;
  merged: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
} {
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58() ?? '';
  const idCtx = useIdentity();
  const identity = idCtx.identity;
  const { client } = useElisymClient();
  const { jobs: localJobs, flipJob } = useJobHistory({ wallet });

  const query = useQuery({
    queryKey: ['jobs-relay-merge', identity?.publicKey ?? '', wallet],
    enabled: identity !== null,
    staleTime: 60_000,
    retry: 1,
    queryFn: () => {
      if (identity === null) {
        throw new Error('Jobs merge queried without an identity.');
      }
      return fetchRelaySide(client, identity, wallet);
    },
  });

  // Flip persistence runs in an effect, never inside the queryFn: a local
  // non-terminal row whose decrypted result arrived flips to `completed`,
  // with the poller's missing/undecryptable-result guard (a decryption
  // failure must not falsely complete a paid job). `unseen` is stamped only
  // when the document is hidden: "the user is looking at the page" is false
  // for a /jobs tab opened in the background, and an unstamped flip there
  // would keep the badge dark for a result the user never saw. A visible
  // page clears the stamp in the same version tick anyway.
  const pageVisible = usePageVisible();
  const data = query.data;
  useEffect(() => {
    if (!data || !wallet) {
      return;
    }
    for (const local of readJobs(wallet)) {
      if (isTerminalJobStatus(local.status)) {
        continue;
      }
      const res = data.results.get(local.jobEventId);
      if (!res || res.decryptionFailed) {
        continue;
      }
      flipJob(
        local.jobEventId,
        { status: 'completed', result: resultDisplay(decodeResult(res.content)) },
        { stampUnseen: !pageVisible },
      );
    }
  }, [data, wallet, flipJob, pageVisible]);

  const rows = useMemo(
    () => buildJobRows(localJobs, data?.jobs ?? [], SOLANA_CLUSTER),
    [localJobs, data],
  );

  return {
    rows,
    wallet,
    merged: data !== undefined,
    isFetching: query.isFetching,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
