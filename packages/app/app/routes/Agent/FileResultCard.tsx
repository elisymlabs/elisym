import { fetchEncryptedFileOutput, LIMITS, type FileAttachment } from '@elisym/sdk';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useElisymClient } from '~/hooks/useElisymClient';
import { useIdentity } from '~/hooks/useIdentity';
import { formatBytes, mediaKind, saveDecryptedFile, type MediaKind } from '~/lib/fileResult';

interface Props {
  attachment: FileAttachment;
  providerPubkey: string;
}

interface Loaded {
  url: string;
  bytes: Uint8Array;
  name: string;
  mime: string;
}

// Auto-render a preview on open only for small images; larger files and audio/video
// wait for an explicit click, so opening a modal never silently fetches up to 100 MiB.
const AUTO_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

// Single stroke-icon path per media kind (avoids a second component in this file).
const ICON_PATHS: Record<MediaKind, string> = {
  image:
    'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3M21 16l-5-5L5 21',
  audio: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  video: 'M3 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM22 7l-5 5 5 5z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
};

export function FileResultCard({ attachment, providerPubkey }: Props) {
  const { client } = useElisymClient();
  const idCtx = useIdentity();
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  const unmountedRef = useRef(false);

  const kind = mediaKind(attachment.mime);

  // `attachment.size` is a provider-declared hint (not enforced), so the auto-preview
  // path passes the small cap as `maxBytes` too - otherwise a provider that lies about
  // the size could make opening the modal silently fetch+decrypt up to 100 MiB.
  async function load(
    maxBytes: number = LIMITS.MAX_BLOSSOM_ENCRYPTED_BYTES,
  ): Promise<Loaded | null> {
    if (loadedRef.current) {
      return loadedRef.current;
    }
    setLoading(true);
    try {
      const out = await fetchEncryptedFileOutput({
        attachment,
        providerPubkey,
        identity: idCtx.identity,
        blossom: client.blossom,
        maxBytes,
      });
      const blob = new Blob([out.bytes], { type: out.mime || 'application/octet-stream' });
      const next: Loaded = {
        url: URL.createObjectURL(blob),
        bytes: out.bytes,
        name: out.name,
        mime: out.mime,
      };
      // The modal may have closed mid-fetch; the unmount cleanup already ran and
      // won't run again, so revoke here rather than leaking the (up to 100 MiB) URL.
      if (unmountedRef.current) {
        URL.revokeObjectURL(next.url);
        return null;
      }
      loadedRef.current = next;
      setLoaded(next);
      return next;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to fetch the file');
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function handleDownload() {
    const data = await load();
    if (data) {
      saveDecryptedFile(data.bytes, data.name, data.mime);
    }
  }

  useEffect(() => {
    // Re-arm on every (re)mount: React StrictMode runs setup→cleanup→setup, and the
    // cleanup below sets this true - without resetting it here the second mount's
    // fetch would see `unmounted` and bail, leaving the auto-preview blank.
    unmountedRef.current = false;
    if (kind === 'image' && attachment.size <= AUTO_PREVIEW_MAX_BYTES) {
      void load(AUTO_PREVIEW_MAX_BYTES);
    }
    return () => {
      unmountedRef.current = true;
      if (loadedRef.current) {
        URL.revokeObjectURL(loadedRef.current.url);
        loadedRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);

  let preview: ReactNode = null;
  if (loaded && kind === 'image') {
    preview = (
      <img
        src={loaded.url}
        alt={attachment.name}
        className="mt-12 max-h-[480px] w-full rounded-xl object-contain"
      />
    );
  } else if (loaded && kind === 'audio') {
    preview = <audio src={loaded.url} controls className="mt-12 w-full" />;
  } else if (loaded && kind === 'video') {
    preview = <video src={loaded.url} controls className="mt-12 max-h-[480px] w-full rounded-xl" />;
  }

  const showPreviewButton = kind !== 'file' && !loaded;

  return (
    <div className="rounded-2xl border border-black/8 bg-surface-2/40 p-12 sm:p-16">
      <div className="flex items-center gap-12">
        <svg
          aria-hidden
          className="size-24 shrink-0 text-text-2"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={ICON_PATHS[kind]} />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-text">{attachment.name}</div>
          <div className="text-xs text-text-2 tabular-nums">{formatBytes(attachment.size)}</div>
        </div>
        <div className="flex shrink-0 items-center gap-8">
          {showPreviewButton && (
            <button
              onClick={() => void load()}
              disabled={loading}
              className="cursor-pointer rounded-xl border border-black/10 bg-surface px-12 py-8 text-xs font-medium text-text transition-colors hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Preview'}
            </button>
          )}
          <button
            onClick={() => void handleDownload()}
            disabled={loading}
            className="cursor-pointer rounded-xl border-none bg-surface-dark px-14 py-8 text-xs font-semibold text-white transition-colors hover:bg-[#2a2a2e] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Download'}
          </button>
        </div>
      </div>
      {preview}
    </div>
  );
}
