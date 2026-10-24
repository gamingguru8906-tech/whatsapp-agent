'use strict';
// The website's own description of itself (https://www.veshannastro.co.in/services.json), written by the site's build
// from the same price table its payment server charges from: every service with its price, the 2027 report offer,
// what is inside the report, the report page's FAQ and the blog. Kamala reads it every hour.

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

/** Checks and trims services.json. Returns { categories, facts } or null when it holds no usable service. */
function read(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.categories)) return null;
  const categories = data.categories
    .filter(c => c && c.id && c.name && Array.isArray(c.services))
    .map(c => ({ ...c, services: c.services.filter(svc => svc && svc.t && svc.p) }))
    .filter(c => c.services.length);
  if (!categories.length) return null;
  return {
    categories,
    facts: {
      offer: str(data.offer, 600),
      inside: list(data.inside, 12).map(x => str(x, 300)),
      faq: list(data.faq, 25).filter(f => f && f.q && f.a).map(f => ({ q: str(f.q, 200), a: str(f.a, 600) })),
      blog: list(data.blog, 20).filter(b => b && b.title && /^https:\/\//.test(String(b.url || '')))
        .map(b => ({ title: str(b.title, 120), about: str(b.about, 200), url: str(b.url, 200) }))
    }
  };
}

/** The facts as a block for Kamala's system prompt (empty when there are none). */
function factsText(facts) {
  if (!facts) return '';
  const parts = [];
  if (facts.offer) parts.push(`2027 REPORT OFFER: ${facts.offer}`);
  if (facts.inside && facts.inside.length) parts.push(`INSIDE EVERY 2027 REPORT:\n${facts.inside.map(x => `- ${x}`).join('\n')}`);
  if (facts.faq && facts.faq.length) parts.push(`2027 REPORT PAGE FAQ:\n${facts.faq.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n')}`);
  if (facts.blog && facts.blog.length) {
    parts.push(`FREE BLOG ARTICLES (share the link when it answers their question):\n${facts.blog.map(b => `- ${b.title}: ${b.about} ${b.url}`).join('\n')}`);
  }
  if (!parts.length) return '';
  return `\n--- WEBSITE FACTS (veshannastro.co.in: the 2027 report page and the blog; all true, use them freely) ---\n${parts.join('\n')}\n`;
}

module.exports = { read, factsText };
