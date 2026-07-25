/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./renderer/index.html', './renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Body text and most UI — a distinct, legible sans, not the Inter-everywhere default.
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // The wordmark, the Nexus label, mood names — the app's one display voice.
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Real monospace for real data: timestamps, hex codes, the activity log.
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
};
