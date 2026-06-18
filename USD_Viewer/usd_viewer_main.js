// AutoMind USD Viewer entrypoint
// EXACT MECHANISM BRIDGE: this module deliberately uses the full USD_Viewer(2).html system
// inside an iframe, instead of reimplementing its kinematic/drag solver in modular JS.
// That keeps the mechanism behavior byte-for-behavior aligned with the standalone HTML.

export let Base64Images = [];

function resolveExactHtmlUrl() {
  try { return new URL('./USD_Viewer_EXACT_MECHANISM.html', import.meta.url).href; }
  catch (_) { return './USD_Viewer_EXACT_MECHANISM.html'; }
}

function normalizeContainer(container) {
  if (container instanceof HTMLElement) return container;
  if (container && container.nodeType === 1) return container;
  return document.body;
}

function makeHost(container) {
  const host = document.createElement('div');
  host.className = 'automind-usd-exact-host';
  host.style.position = 'relative';
  host.style.width = '100%';
  host.style.height = '100%';
  host.style.minHeight = '240px';
  host.style.overflow = 'hidden';
  host.style.background = '#fff';
  container.innerHTML = '';
  container.appendChild(host);
  return host;
}

function makeIframe() {
  const iframe = document.createElement('iframe');
  iframe.className = 'automind-usd-exact-frame';
  iframe.setAttribute('title', 'AutoMind USD Exact Mechanism Viewer');
  iframe.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');
  iframe.style.position = 'absolute';
  iframe.style.inset = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.display = 'block';
  iframe.style.background = '#fff';
  iframe.src = resolveExactHtmlUrl();
  return iframe;
}

function postPayloadWhenReady(iframe, payload) {
  let stopped = false;
  let tries = 0;
  const send = () => {
    if (stopped) return;
    tries += 1;
    try {
      iframe.contentWindow?.postMessage?.({ type:'AUTOMIND_USD_EXACT_LOAD_PAYLOAD', payload }, '*');
    } catch (err) {
      console.warn('[AutoMind USD] payload post failed:', err);
    }
    if (tries < 80) setTimeout(send, tries < 10 ? 100 : 250);
  };
  const onMessage = (event) => {
    const data = event.data || {};
    if (data.type !== 'AUTOMIND_USD_EXACT_LOADED') return;
    stopped = true;
    window.removeEventListener('message', onMessage);
    if (!data.ok) console.error('[AutoMind USD] exact viewer payload error:', data.error);
  };
  window.addEventListener('message', onMessage);
  iframe.addEventListener('load', () => setTimeout(send, 50), { once:true });
  setTimeout(send, 350);
  return () => { stopped = true; window.removeEventListener('message', onMessage); };
}

export function render(options = {}) {
  const container = normalizeContainer(options.container);
  const host = makeHost(container);
  const iframe = makeIframe();
  host.appendChild(iframe);

  const payload = {
    usdContent: options.usdContent || options.usda || '',
    usdName: options.usdName || options.name || 'model.usda',
    assetDB: options.assetDB || options.assets || {}
  };

  let cancelPosting = null;
  if (payload.usdContent) cancelPosting = postPayloadWhenReady(iframe, payload);

  return {
    host,
    iframe,
    exactMechanism: true,
    load(payload2 = {}) {
      const p = {
        usdContent: payload2.usdContent || payload2.usda || '',
        usdName: payload2.usdName || payload2.name || 'model.usda',
        assetDB: payload2.assetDB || payload2.assets || {}
      };
      cancelPosting?.();
      cancelPosting = postPayloadWhenReady(iframe, p);
    },
    destroy() {
      cancelPosting?.();
      try { iframe.remove(); } catch (_) {}
      try { host.remove(); } catch (_) {}
    }
  };
}

export default render;
