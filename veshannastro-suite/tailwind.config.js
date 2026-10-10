/** Veshannastro tokens (HSL values live in web/src/styles.css), shared with the mobile-number site. */
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
        muted: { DEFAULT: v('muted'), foreground: v('muted-foreground') },
        primary: { DEFAULT: v('primary'), soft: v('primary-soft'), dark: v('primary-dark') },
        maroon: { DEFAULT: v('maroon'), soft: v('maroon-soft') },
        success: { DEFAULT: v('success'), soft: v('success-soft'), dark: v('success-dark') },
        whatsapp: { DEFAULT: v('whatsapp'), dark: v('whatsapp-dark') }
      },
      // League Spartan (brand) for titles and anything you tap; Literata for sentences.
      fontFamily: {
        display: ['"League Spartan"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        sans: ['"League Spartan"', '-apple-system', 'BlinkMacSystemFont', 'system-ui', 'sans-serif'],
        serif: ['Literata', 'Georgia', '"Noto Serif"', '"Times New Roman"', 'serif']
      }
    }
  },
  plugins: []
};
