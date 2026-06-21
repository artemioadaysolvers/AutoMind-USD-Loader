// Theme.js

export const THEME = {
  colors: {
    teal: '#0ea5a6',
    tealSoft: '#14b8b9',
    tealFaint: 'rgba(20,184,185,0.12)',
    panelBg: '#ffffff',
    canvasBg: 0xffffff,
    stroke: '#d7e7e7',
    text: '#0b3b3c',
    textMuted: '#577e7f',
  },

  // Ambiente único usado por el viewport y por las miniaturas.
  // No agregar HemisphereLight ni luces extra aquí: esto mantiene el color
  // igual entre render principal, screenshots y thumbnails.
  lighting: {
    ambient: { color: 0xffffff, intensity: 0.9 },
    key:     { color: 0xffffff, intensity: 0.75, position: [3, 5, 4] },
    fill:    { color: 0xffffff, intensity: 0.35, position: [-4, 2, -3] }
  },

  shadows: {
    sm: '0 4px 12px rgba(0,0,0,0.08)',
    md: '0 8px 24px rgba(0,0,0,0.12)',
    lg: '0 12px 36px rgba(0,0,0,0.14)',
  }
};

// Flat aliases kept for ComponentsPanel/ToolsDock compatibility.
THEME.teal = THEME.colors.teal;
THEME.tealSoft = THEME.colors.tealSoft;
THEME.tealFaint = THEME.colors.tealFaint;
THEME.bgPanel = THEME.colors.panelBg;
THEME.bgCanvas = THEME.colors.canvasBg;
THEME.stroke = THEME.colors.stroke;
THEME.text = THEME.colors.text;
THEME.textMuted = THEME.colors.textMuted;
THEME.shadow = THEME.shadows.lg || THEME.shadows.md || THEME.shadows.sm;

export default THEME;
