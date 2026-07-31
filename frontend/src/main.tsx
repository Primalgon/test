import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { applyDirection, site } from './site.config';
import { detectQuality } from './three/quality';
import { hydrateFromApi } from './lib/manifest';
import './styles/base.css';

// Direction goes on <html> before React mounts, so there is no flash of an
// unstyled or wrongly-styled identity.
applyDirection(site);

// Records the tier on <html> so CSS can respond too (see base.css motion policy).
document.documentElement.dataset.quality = detectQuality().tier;

// Pick up any 3D assets that have been upgraded since this bundle was built.
// Non-blocking: the bundled manifest is always valid on its own.
void hydrateFromApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
