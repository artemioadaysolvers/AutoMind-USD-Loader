AutoMind URDF+ Viewer BUILD165

- Texture/thumbnail pacing is 3x faster than BUILD164 while keeping the serial deterministic pipeline.
- Show all now fades hidden components back into the active render mode instead of instantly toggling visibility or passing through Ghost/X-Ray.
- Fixed Ground & Shadows toggle crash: ViewerCore.setSceneToggles now keeps a scoped key light reference.
- Kept BUILD164 viewport/thumb material matching and minimal script package.
