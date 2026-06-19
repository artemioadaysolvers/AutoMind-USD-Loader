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

  // ✅ ADD THIS BLOCK
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

export default THEME;
