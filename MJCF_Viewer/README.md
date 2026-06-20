# AutoMind XML_Viewer — MJCF BUILD170

This is the modular viewer counterpart of `URDF_Viewer` and `USD_Viewer`, adapted for MuJoCo MJCF (`<mujoco>...</mujoco>`) with OBJ + PNG assets.

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

Alternatively pass a single `MJCF_Zip` / `mjcfZip` base64 ZIP containing the XML and the `assets/` directory.

## Supported MJCF

- Nested `worldbody/body` transforms and `hinge` / `slide` joints.
- Mesh assets declared through `compiler meshdir="assets"`, `asset/mesh`, `asset/texture`, and `asset/material`.
- `equality/joint` ratio and offset couplings.
- `equality/connect` and `equality/weld` loop records for inspection.
- `position`, `motor` and other actuator ranges as UI joint limits.

It is a CAD inspection viewer; it does not execute MuJoCo contact dynamics. Use MuJoCo itself for physics validation.
