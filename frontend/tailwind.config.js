/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // "Control room" ink — sidebar + primary text
        ink: {
          DEFAULT: '#101826',
          800: '#182233',
          700: '#212D42',
          600: '#3A4863',
          // Secondary text on light surfaces. Darkened from #6B7A93 (4.35:1 on
          // white, 4.02:1 on surface-muted) to clear WCAG AA on both.
          400: '#5E6C84',
          // Secondary text on the dark ink sidebar/drawer. ink-400 is now too
          // dark to read there, so light-on-dark text uses this instead.
          300: '#8A97AD',
        },
        // Neutral surfaces
        surface: {
          DEFAULT: '#FFFFFF',
          muted: '#F5F6F8',
          border: '#E4E7EC',
        },
        // "Signal" gold — the single reserved accent
        signal: {
          DEFAULT: '#C6862E',
          50: '#FBF3E6',
          100: '#F5E3C4',
          600: '#A96E22',
        },
        // Semantic status colors, kept muted rather than neon
        success: {
          DEFAULT: '#1F8A5F',
          50: '#E8F5EF',
        },
        danger: {
          DEFAULT: '#C1432E',
          50: '#FBEAE7',
        },
        info: {
          DEFAULT: '#2F6FB0',
          50: '#EAF1F9',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '6px',
      },
      // Short enter animations for modals, drawers and menus. Reduced motion
      // is honoured globally in index.css and per-element with motion-reduce.
      keyframes: {
        'overlay-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'panel-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'overlay-in': 'overlay-in 140ms ease-out both',
        'panel-in': 'panel-in 170ms cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [],
};
