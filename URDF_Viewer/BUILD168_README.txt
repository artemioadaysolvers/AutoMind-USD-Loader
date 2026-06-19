BUILD168 · View preset orbit tween + uniform shadow ground
- Iso/Top/Front/Right now use an orbit-style tween from the current camera pose, not a straight cartesian slide or abrupt view jump.
- Show all uses the exact same Iso preset tween as the Iso button.
- Ground & shadows no longer draws a visible square over the grid: ground uses ShadowMaterial so only shadows render.
- Keeps BUILD166 behavior: stable Solid/Wireframe Show all, fast base64 textures, URDF+ loops/joints realtime, clean minimal scripts.

BUILD168: view buttons and Show all capture exact current camera before tween; Trackball inertia is frozen; ground/shadow plane and shadow frustum enlarged to remove square boundary on grid.
