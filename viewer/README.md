# viewer/ — AutoMind USD+ Viewer

Carpeta limpia para visualizar USD+ en JavaScript. Incluye únicamente el runtime y módulos USD+.

Entrada local/GitHub:

```text
viewer/USDPlus_GitHub_Drop_Viewer.html
```

Entrada modular:

```js
import { render } from './viewer/usdplus_viewer_main.js';
render({ container: document.getElementById('app') });
```

Carga `.usda` o `.usd` ASCII y carpetas con texturas locales. `.usdc/.usdz` binario no se parsea directamente en navegador puro.
