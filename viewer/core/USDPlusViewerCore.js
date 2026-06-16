// /viewer/core/USDPlusViewerCore.js
// Main iframe core used by usdplus_viewer_main.js.
// It keeps the original BUILD131 USD+ solver untouched, while exposing a
// createViewer-like facade that matches the AutoMindCloud viewer structure.

import { USDPLUS_VIEWER_HTML } from './USDPlusStandaloneTemplate.js';
import { buildUSDPlusAssetDataURLs } from './USDPlusAssetDB.js';

function safeJson(value) {
  return JSON.stringify(value).replace(/<\/script/gi, '<\\/script');
}

export function createUSDPlusIframeViewer(opts = {}) {
  const container = opts.container || document.body;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.title = opts.title || 'AutoMind USD+ Viewer';
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
  Object.assign(iframe.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0',
    display: 'block', background: '#fff', overflow: 'hidden'
  });

  const boot = {
    usdName: opts.usdName || opts.filename || 'AutoMindUSDPlus.usda',
    usdContent: opts.usdContent || opts.usdText || '',
    assetDataURLs: buildUSDPlusAssetDataURLs(opts.assetDB || opts.textureDB || opts.meshDB || {}),
    hideDropOnBoot: opts.hideDropOnBoot !== false,
  };

  iframe.srcdoc = USDPLUS_VIEWER_HTML.replace('__AUTOMIND_USDPLUS_BOOT_JSON__', safeJson(boot));
  container.appendChild(iframe);

  return {
    iframe,
    container,
    resize(width, height) {
      if (width) iframe.style.width = `${Math.max(1, Math.round(width))}px`;
      if (height) iframe.style.height = `${Math.max(1, Math.round(height))}px`;
    },
    postLoad(payload = {}) {
      iframe.contentWindow?.postMessage({ type: 'AUTOMIND_USDPLUS_LOAD', payload }, '*');
    },
    destroy() {
      try { iframe.remove(); } catch (_) {}
    },
  };
}

export default { createUSDPlusIframeViewer };
