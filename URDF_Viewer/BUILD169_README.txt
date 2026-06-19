BUILD169 - USD camera presets exact

- Iso / Top / Front / Right in URDF ToolsDock now use the exact camera tween implementation copied from USD_Viewer/ui/ToolsDock.js.
- URDF+ showAll/viewPreset now uses the same linear USD-style camera tween: it captures the visible camera.position + controls.target at click time and tweens from there.
- No pre-teleport/orbital re-projection before tween.
- Keeps BUILD168 fixes: fast base64 textures, stable render modes, uniform shadow/grid, realtime URDF+ joints/loops.
