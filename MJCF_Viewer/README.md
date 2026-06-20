# AutoMind MJCF Viewer — BUILD172

- Textured materials retain their original PNG map and base color during component isolation / camera focus.
- Grid and ground are frozen once at model load in world coordinates; articulated bounds never resize or shift them.
- MJCF direct loader now calls `refreshRobotContext()` so the static-grid setup is applied outside the USD path.

# AutoMind XML_Viewer — MJCF BUILD171

Modular MJCF viewer paired with the AutoMind Inventor exporter. It loads one
`<mujoco>...</mujoco>` XML and OBJ/MTL/PNG assets from `assetDB` or a base64 ZIP.

## BUILD171 repairs

- **Textures:** waits for PNG/JPG decode before creating each material, assigns the
  texture as `map` and prevents `rgba` from multiplying CAD color textures twice.
- **Static grid:** captures the initial CAD bounds once. Grid and ground no longer
  resize or translate when a hinge/slide changes the model bounding box.
- **Show Joints / Show Loops:** exposes `body0`, `body1`, link world matrices and
  local loop anchors, matching the modular decoration contract.
- **Couplings:** applies valid `equality/joint` relations exactly and solves valid
  `equality/connect` closure residuals by damped least squares after a driven joint
  moves. Invalid multi-joint solver hints are preserved as diagnostics, never treated
  as a MuJoCo equality.
- **Explode:** moves one dedicated visual root per `<geom>`, not a kinematic body
  subtree, so individual gripper parts separate.
- **Component focus:** camera target, position and orthographic framing now tween
  from the exact visible pose at click time.

## Entry point

```js
import { render } from './XML_Viewer/mjcf_viewer_main.js';

const app = render({
  container: document.getElementById('viewer'),
  mjcfContent: xmlText,
  assetDB: {
    'robot.xml': xmlText,
    'assets/link_0.obj': objBase64,
    'assets/link_0.png': pngBase64
  }
});
await app.ready;
```

The Colab bridge defaults to the repository path
`MJCF_Viewer/mjcf_viewer_main.js`; use the same contents under that directory name
when committing this folder to GitHub.

## Supported MJCF

- Nested `worldbody/body` transforms with `hinge` and `slide` joints.
- `compiler meshdir`, `texturedir`, `asset/mesh`, `asset/texture` and
  `asset/material`.
- Scalar `equality/joint` ratios and physical `equality/connect` closures.
- `position` / `motor` actuator ranges.

This is a CAD inspection viewer. Validate contact dynamics and actuator behavior in
MuJoCo itself.

## BUILD173 — startup, grid and articulated bounds fix

- `createViewer()` begins rendering before the model exists. The render loop no longer invokes any bounding-box calculation before a valid robot is assigned.
- `getObjectBounds()` now safely returns `null` for missing or partially-built objects and manually walks valid visual nodes.
- The CAD grid and ground are frozen exclusively by `refreshRobotContext(validModel)` after successful loading; articulation and browser resize cannot recenter or resize them.
- Orthographic resize uses the immutable model dimension captured at load instead of the current gripper pose.


## BUILD174 fixes

- Static world grid with frozen matrices after first successful model load.
- Hardened WebGL vec3 uniform uploads for Colab/Chromium.
- Thumbnail warm-up is lazy by default; pass `eagerThumbnails: true` only when desired.
