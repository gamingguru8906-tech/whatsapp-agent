// The site's pages: their addresses, titles, descriptions and share pictures. Used by the Worker (written into the
// HTML for search engines and link previews) and by the page itself (updated on in-page navigation).

export const ORIGIN = 'https://veshannastro-numerology.veshannastro.workers.dev';

export const PAGES = {
  mobile: {
    path: '/',
    title: 'Free Mobile Number Numerology Reading | Veshannastro',
    description: "What is your mobile number doing to your life? Free reading of every digit pair, the yogas on your number's grid, your year ahead and your remedies.",
    ogTitle: 'What is your mobile number doing to your life?',
    ogDescription: 'Free mobile number numerology reading by Veshannastro.',
    image: '/og-mobile.jpg'
  },
  watch: {
    path: '/watch',
    title: 'What does your watch say about you? | Veshannastro',
    description: "Add one photo of your watch. See what its dial colour, metal, strap and the wrist you wear it on say about you, and whether it suits your year. Free.",
    ogTitle: 'What does your watch say about you?',
    ogDescription: 'Free watch reading by Veshannastro: dial, metal, strap and wrist, read with your birth date.',
    image: '/og-watch.jpg'
  },
  wrist: {
    path: '/watch/year',
    title: 'Which watch should you wear this year? | Veshannastro',
    description: 'A photo of your wrist and your birth date: the watch to wear this year, with its metal, dial colour, size and strap. Free.',
    ogTitle: 'Which watch should you wear this year?',
    ogDescription: 'Your watch for the year from Veshannastro: metal, dial, size and strap, from your wrist and your birth date.',
    image: '/og-watch.jpg'
  },
  my: {
    path: '/my',
    title: 'My readings | Veshannastro',
    description: 'Sign in with WhatsApp to see every reading made with your mobile number: watch, watch for the year and mobile number readings.',
    ogTitle: 'My readings | Veshannastro',
    ogDescription: 'Every Veshannastro reading made with your mobile number, in one place.',
    image: '/og-watch.jpg'
  }
};

/** The page for an address ("/watch/", "/watch") or null when the site has no such page. */
export function pageFor(pathname) {
  const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  return Object.entries(PAGES).find(([, v]) => v.path === p)?.[0] ?? null;
}
