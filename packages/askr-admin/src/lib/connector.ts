const VERIFICATION_REASONS: Readonly<Record<string, string>> = {
  not_configured: 'is not among your allowed or link origins',
  not_found:
    'does not show your store ID (add the askr-verification meta tag or /.well-known/askr)',
  fetch_failed: 'could not be read',
};

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A connector sync or preview result in one plain sentence. */
export function connectorResultSentence(result: unknown): string {
  const status = field(result, 'status');
  if (status === 'ok') {
    const diff = field(result, 'diff');
    const counts = ['created', 'updated', 'hidden', 'unchanged'].map(
      (name) => `${list(field(diff, name)).length} ${name}`,
    );
    return `Products read: ${counts.join(', ')}.`;
  }
  if (status === 'verification_failed') {
    const failures = list(field(result, 'failures')).map((failure) => {
      const origin = String(field(failure, 'origin') ?? 'a site');
      const reason =
        VERIFICATION_REASONS[String(field(failure, 'reason'))] ?? 'could not be verified';
      return `${origin} ${reason}`;
    });
    return `Your site could not be verified, so nothing was synced: ${failures.join('; ')}.`;
  }
  if (status === 'source_closed') {
    return `The source is closed: ${String(field(result, 'url') ?? '')} answered ${String(field(result, 'reason') ?? 'with an error')}. Check that your products are public.`;
  }
  if (status === 'error') {
    return `The sync failed: ${String(field(result, 'message') ?? 'unknown error')}.`;
  }
  return 'No sync has run yet.';
}
