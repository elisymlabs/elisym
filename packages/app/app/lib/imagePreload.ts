import type { Agent } from '@elisym/sdk';

// Browser-only: relies on `new Image()`. packages/app is a React 19 SPA, so
// this file never runs in Node.

export function preloadFirstBatchPictures(
  agents: Agent[],
  batchSize: number,
  timeoutMs: number,
): Promise<void> {
  if (batchSize <= 0) {
    return Promise.resolve();
  }
  const urls: string[] = [];
  for (const agent of agents) {
    if (urls.length >= batchSize) {
      break;
    }
    if (agent.picture) {
      urls.push(agent.picture);
    }
  }
  if (urls.length === 0) {
    return Promise.resolve();
  }

  const loadPromises = urls.map(
    (url) =>
      new Promise<void>((resolve) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => resolve();
        image.src = url;
      }),
  );

  const allLoaded = Promise.allSettled(loadPromises).then(() => undefined);
  const timeoutFallback = new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
  return Promise.race([allLoaded, timeoutFallback]);
}
