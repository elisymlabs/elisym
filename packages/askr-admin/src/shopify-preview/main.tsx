import '../app.css';
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ManagedByShopify } from '../components/ManagedByShopify';
import { ShopifyApi } from '../shopify/api';
import { ShopifyApp } from '../shopify/ShopifyApp';
import { PREVIEW_SHOP, type PreviewScenario, createMockServer } from './mock-server';
import { PreviewBar } from './PreviewBar';

/** The embedded admin on a fake server, with a bar to play the scenarios (dev only). */
function Preview() {
  const [scenario] = useState<PreviewScenario>({
    ownerManages: false,
    replaceNextFinish: false,
    suspended: false,
  });
  const [, setTick] = useState(0);
  const [round, setRound] = useState(0);
  const [page, setPage] = useState<'app' | 'standalone'>('app');
  const server = useMemo(() => createMockServer(scenario), [scenario]);
  const api = useMemo(
    () =>
      new ShopifyApi({
        token: () => Promise.resolve('preview-token'),
        base: '',
        fetch: server.fetch,
      }),
    [server],
  );
  return (
    <>
      <PreviewBar
        scenario={scenario}
        page={page}
        onChange={(next) => {
          Object.assign(scenario, next);
          setTick((tick) => tick + 1);
          setRound((value) => value + 1);
        }}
        onPage={setPage}
        onReset={() => {
          server.reset();
          setRound((value) => value + 1);
        }}
      />
      {page === 'app' ? (
        <ShopifyApp key={round} api={api} shop={PREVIEW_SHOP} apiKey="preview-client-id" />
      ) : (
        <ManagedByShopify onSignOut={() => setPage('app')} />
      )}
    </>
  );
}

const root = document.getElementById('root');
if (root === null) {
  throw new Error('the preview page has no #root');
}
createRoot(root).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
