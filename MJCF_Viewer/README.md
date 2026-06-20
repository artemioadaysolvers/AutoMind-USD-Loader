
## BUILD175 — textured CAD visibility repair

- MJCF OBJ textures now use the standard Three.js/OBJ `flipY=true` convention, matching the working USD/URDF loaders. The previous MJCF-only `flipY=false` path could sample the black/transparent half of a texture atlas.
- Textured CAD mesh materials are displayed with `MeshBasicMaterial` in the inspection viewport, so source texture colour is not dependent on fragile WebGL light uniforms.
- Missing texture bindings no longer combine with the common black exporter fallback to hide a complete model; they use a visible neutral CAD fallback.
- Meshes whose UVs genuinely extend beyond `[0,1]` automatically use repeat wrapping rather than black `ClampToEdge` border sampling.

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

## BUILD176 — MJCF closed-loop parity with the USD/URDF viewers

- Uses the same constrained interactive-drag policy as the USD/URDF viewers: a damped least-squares closure solve, adaptive damping, passive-joint projection, and a binary feasibility search so impossible pointer deltas are not accepted as visibly open mechanisms.
- Corrects the MJCF frame convention for `equality/connect`: `anchor` is local to `body1`, not a global point. The viewer now derives `body2`'s corresponding anchor from the imported reference pose.
- Adds proper `equality/weld` handling: reference-pose and explicit `relpose` frames, positional and rotational residuals, and `torquescale=0` behaving as a positional-only weld.
- Supports omitted `body2` as the world body and preserves multi-joint MJCF bodies as a complete DOF chain for closed-loop solving.
- The yellow loop decoration and the numeric closure residual now use exactly the same local frames as the solver, so the visual indication cannot be based on a different coordinate convention from the articulated geometry.


BUILD177 notes
- Loop overlays now refresh link matrices before drawing and use the model's own solver frame reconstruction (`_frameForLoopSide`) when available. This keeps the orange closed-loop lines attached to the same anchors the solver is using, preventing the visible 'line below the mechanism' drift seen in MJCF grippers.
- MJCF texture fallback now follows the USD/URDF visibility policy more closely: unresolved textured parts use an unlit visible CAD fallback instead of remaining dark silhouettes.
- Texture candidate search now also probes `mesh/`, `texture/`, `images/`, `materials/`, and parent directories, which improves parity with the more tolerant URDF/USD asset lookup behavior.


BUILD178 critical MJCF repairs
- Skips raw `<geom class="collision">` duplicates. MuJoCo expands class defaults at compile time, but a direct XML viewer does not; rendering both copies put an untextured collision mesh exactly on top of each textured visual mesh, producing the all-black robot.
- Handles legacy BUILD170 `equality/connect anchor` values that were exported in CAD/world coordinates instead of required body1-local coordinates. The viewer detects the unambiguous out-of-model case and corrects it for visualization.
- For physically correct MuJoCo simulation, use the separately supplied corrected Robot_Gripper.xml with local anchors; the viewer compatibility path cannot repair the XML sent to a real MuJoCo compiler.


BUILD180 — verified diagnosis repair
- Orange loop segments are solver residuals. In a closed pin they should collapse to approximately zero length; visible segments prove that passive loop coordinates were not converging.
- The solver now protects actuated motor joints from the DLS variables and solves only passive closure members, with a line-search DLS update modeled after the USD/URDF+ solver.
- Equality/connect now receives a pin-axis alignment residual, retaining free spin around the axis but removing the visual rotational nullspace.
- The gripper PNGs were inspected: all 20 are uniform 32×32 colour swatches. BUILD180 reads a confirmed uniform swatch as its exact unlit material colour, which removes the black rendering path while preserving detailed maps for non-uniform textures.


BUILD181 — root-cause fix
The prior MJCF loader stored each link's solver `currentMatrix` from `bodyPose`, the static body reference group. The moving mesh and descendants live below `pivot → motion → inverse`, so solver anchors remained at the zero pose while geometry moved. BUILD181 stores the post-joint `content` group as the kinematic frame. This matches the matrix convention used by USD/URDF+ (`currentMatrix` after joint motion).

Runtime verification: after importing this package, `window.MJCFViewer.__build` must equal `BUILD181_POST_JOINT_FRAMES`.
