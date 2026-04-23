import { useState, useEffect, useCallback } from 'react';
import type { Artifact } from './types';

export function useArtifacts(agentPubkey: string) {
  const storageKey = `elisym:artifacts:${agentPubkey}`;
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setArtifacts(raw ? (JSON.parse(raw) as Artifact[]) : []);
    } catch {
      setArtifacts([]);
    }
  }, [storageKey]);

  const append = useCallback(
    (artifact: Artifact) => {
      setArtifacts((prev) => {
        if (prev.some((existing) => existing.id === artifact.id)) {
          return prev;
        }
        const next = [artifact, ...prev];
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // storage quota or unavailable, ignore
        }
        return next;
      });
    },
    [storageKey],
  );

  const update = useCallback(
    (id: string, patch: Partial<Artifact>) => {
      setArtifacts((prev) => {
        let changed = false;
        const next = prev.map((artifact) => {
          if (artifact.id !== id) {
            return artifact;
          }
          const merged = { ...artifact, ...patch };
          if (JSON.stringify(merged) !== JSON.stringify(artifact)) {
            changed = true;
          }
          return merged;
        });
        if (!changed) {
          return prev;
        }
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // storage quota or unavailable, ignore
        }
        return next;
      });
    },
    [storageKey],
  );

  return { artifacts, append, update };
}
