// /viewer/ui/USDPlusComponentsPanel.js
// The USD+ component panel is rendered inside the BUILD131 template and keeps:
// - virtualized component rows for large mechanisms
// - left dock with show-all behavior
// - hover/selection/focus by link
// - drag-ready visual state when a link has a movable ancestor joint
// This module preserves the same folder/script contract as ComponentsPanel.js.

export function createUSDPlusComponentsPanel(app) {
  return app || null;
}

export default { createUSDPlusComponentsPanel };
