// /viewer/interaction/USDPlusSelectionAndDrag.js
// USD+ interaction lives inside the BUILD131 runtime template:
// - link hover and selection
// - component click/focus/isolate behavior
// - joint drag on revolute/prismatic axes
// - passive dependent joint routing through the single active driver
// - DLS loop-closure refresh after drag
// This file is kept as the structural equivalent of SelectionAndDrag.js so
// downstream projects can import a USD+ interaction module without changing
// the AutoMindCloud folder contract.

export function attachUSDPlusInteraction(app) {
  return app || null;
}

export default { attachUSDPlusInteraction };
