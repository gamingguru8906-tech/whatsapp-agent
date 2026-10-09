/** Veshannastro site tokens (HSL values live in web/src/styles.css). */
const v = name => `hsl(var(--${name}) / <alpha-value>)`;

export default {
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
        care: { DEFAULT: v('care'), soft: v('care-soft'), dark: v('care-dark') }
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
      fontFamily: { sans: ['"League Spartan"', '"League Spartan Fallback"', 'system-ui', 'sans-serif'] },
      boxShadow: { soft: '0 1px 2px hsl(222 40% 10% / 0.05), 0 8px 24px hsl(338 60% 40% / 0.07)' },
      keyframes: {
        pop: { '0%': { transform: 'translateY(6px) scale(0.92)', opacity: '0.4' }, '100%': { transform: 'none', opacity: '1' } },
        rise: { '0%': { transform: 'translateY(8px)', opacity: '0.6' }, '100%': { transform: 'none', opacity: '1' } }
      },
      animation: { pop: 'pop 0.35s ease-out both', rise: 'rise 0.45s ease-out both' }
    }
  },
  plugins: []
};
