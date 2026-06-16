// /viewer/usdplus_viewer_main.js
// AutoMind USD+ JavaScript entry point, matching the AutoMindCloudExperimental
// modular viewer pattern: render(opts) returns a small facade for Colab/GitHub.

import { createUSDPlusIframeViewer } from './core/USDPlusViewerCore.js';

export function render(opts = {}) {
  return createUSDPlusIframeViewer(opts);
}

export default { render };
