/** Veshannastro site tokens (HSL values live in web/src/styles.css). */
const v = name => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  // Hover styles only where a real pointer can hover, so nothing stays stuck after a tap on a phone.
  future: { hoverOnlyWhenSupported: true },
  content: ['./web/index.html', './web/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        background: v('background'),
        foreground: v('foreground'),
        card: v('card'),
        border: v('border'),
        input: v('input'),
        ring: v('ring'),
        muted: { DEFAULT: v('muted'), foreground: v('muted-foreground') },
        faint: v('text-faint'),
        primary: { DEFAULT: v('primary'), foreground: v('primary-foreground'), soft: v('primary-soft'), dark: v('primary-dark') },
        accent: { DEFAULT: v('accent'), foreground: v('accent-foreground'), soft: v('accent-soft') },
        success: { DEFAULT: v('success'), soft: v('success-soft'), dark: v('success-dark') },
        danger: { DEFAULT: v('danger'), soft: v('danger-soft'), dark: v('danger-dark') },
        warning: { DEFAULT: v('warning'), soft: v('warning-soft'), dark: v('warning-dark') },
        care: { DEFAULT: v('care'), soft: v('care-soft'), dark: v('care-dark') },
        whatsapp: { DEFAULT: v('whatsapp'), dark: v('whatsapp-dark') },
        maroon: { DEFAULT: v('maroon'), dark: v('maroon-dark'), soft: v('maroon-soft') },
        gold: { DEFAULT: v('gold'), soft: v('gold-soft') }
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      // Three faces, three jobs: Bricolage Grotesque for titles, Poppins for what you tap, pick or scan,
      // Instrument Sans for the sentences of the reading.
      fontFamily: {
        display: ['"Bricolage Grotesque"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        // Interface text (labels, controls, notes): the phone's own UI face — SF on Apple devices, Roboto on Android.
        ui: ['Poppins', '-apple-system', 'BlinkMacSystemFont', 'system-ui', '"Segoe UI"', 'Roboto', 'Arial', 'sans-serif'],
        sans: ['"Instrument Sans"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        serif: ['"Instrument Sans"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif']
      },
      transitionTimingFunction: {
        ios: 'cubic-bezier(0.32, 0.72, 0, 1)',        // iOS sheet / segmented motion
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)'   // a small overshoot for ticks
      },
      boxShadow: { soft: '0 1px 2px hsl(240 10% 10% / 0.04), 0 12px 32px hsl(240 10% 10% / 0.08)' },
      keyframes: {
        reveal: { '0%': { transform: 'translateY(14px)', opacity: '0' }, '100%': { transform: 'none', opacity: '1' } },
        swap: { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'none' } },
        pop: { '0%': { transform: 'translateY(6px) scale(0.92)', opacity: '0.4' }, '100%': { transform: 'none', opacity: '1' } },
        rise: { '0%': { transform: 'translateY(8px)', opacity: '0.6' }, '100%': { transform: 'none', opacity: '1' } }
      },
      animation: { pop: 'pop 0.35s ease-out both', rise: 'rise 0.45s ease-out both',
        reveal: 'reveal 0.6s cubic-bezier(0.32, 0.72, 0, 1) both', swap: 'swap 0.35s cubic-bezier(0.32, 0.72, 0, 1) both' }
    }
  },
  plugins: []
};
