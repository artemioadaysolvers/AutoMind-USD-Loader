// /URDF_Viewer/urdfplus_viewer_main.js
// BUILD154_DIRECT_URDFPLUS_CORE
// Entrypoint real, sin iframe y sin HTML standalone adapter.
// Exporta directamente el renderer modular URDF+ corregido.
// Firma pública: import(...).then(m => m.render(opts)).

import { render, Base64Images } from './urdfplus_viewer_main_core.js';

export { render, Base64Images };

export default { render };
