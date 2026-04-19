interface SubmitJobResultArgs {
  jobEventId: string;
  resultContent: string;
}

export interface FakeRelayResult {
  content: string;
  senderPubkey: string;
  decryptionFailed: boolean;
}

export interface FakeClientOptions {
  /**
   * Pre-canned result events the customer-side recovery will pick up via
   * queryJobResults. Keyed by jobEventId.
   */
  results?: Map<string, FakeRelayResult>;
  /**
   * If set, the next `submitJobResultWithRetry` call rejects with this error
   * exactly once, then succeeds on subsequent calls. Used to simulate a
   * relay flake during recovery.
   */
  failNextSubmit?: Error;
}

/**
 * Minimal `ElisymClient`-shaped stub that records publishes and replays
 * canned query results. Replaces the full SDK client / Nostr pool for
 * recovery integration tests.
 */
export class FakeClient {
  readonly published: SubmitJobResultArgs[] = [];
  readonly queries: { jobIds: string[]; provider?: string }[] = [];
  private failNextSubmit?: Error;
  private results: Map<string, FakeRelayResult>;

  constructor(options: FakeClientOptions = {}) {
    this.results = options.results ?? new Map();
    this.failNextSubmit = options.failNextSubmit;
  }

  setResult(jobEventId: string, result: FakeRelayResult): void {
    this.results.set(jobEventId, result);
  }

  marketplace = {
    submitJobResultWithRetry: async (
      _identity: unknown,
      event: { id: string },
      content: string,
    ): Promise<string> => {
      if (this.failNextSubmit) {
        const error = this.failNextSubmit;
        this.failNextSubmit = undefined;
        throw error;
      }
      this.published.push({ jobEventId: event.id, resultContent: content });
      return 'result-event-id';
    },
    queryJobResults: async (
      _identity: unknown,
      requestIds: string[],
      _kindOffsets: number[],
      providerPubkey?: string,
    ): Promise<Map<string, FakeRelayResult>> => {
      this.queries.push({ jobIds: requestIds, provider: providerPubkey });
      const result = new Map<string, FakeRelayResult>();
      for (const id of requestIds) {
        const entry = this.results.get(id);
        if (entry) {
          result.set(id, entry);
        }
      }
      return result;
    },
  };
}
