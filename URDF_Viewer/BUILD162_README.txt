BUILD162 clean minimal URDF+ viewer package.

Changes from BUILD161:
- Theme.js lighting restored exactly to requested ambient/key/fill values.
- Viewport and thumbnails use only THEME.lighting; no HemisphereLight or extra ambient environment.
- Grid keeps the clean uniform finite LineSegments behavior but uses the previous teal grid color/opactiy.
- Legacy/reference/patch files remain removed; only runtime scripts are included.
