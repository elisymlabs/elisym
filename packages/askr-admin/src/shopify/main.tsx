import '../app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Notice } from '../components/Notice';
import { ShopifyApi } from './api';
import { appApiKey, sessionToken, shopOf } from './bridge';
import { ShopifyApp } from './ShopifyApp';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('the page has no #root');
}
const shop = shopOf();
createRoot(root).render(
  <StrictMode>
    {shop === undefined ? (
      <div className="p-24">
        <Notice tone="error">Open Askr from your Shopify admin.</Notice>
      </div>
    ) : (
      <ShopifyApp api={new ShopifyApi({ token: sessionToken })} shop={shop} apiKey={appApiKey()} />
    )}
  </StrictMode>,
);
