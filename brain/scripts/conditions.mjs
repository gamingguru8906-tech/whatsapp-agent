// Turns the readers' written conditions ("psychic = 1 AND month in {Jun, Jul}") into the brain's `when` objects.
// Only patterns listed here are understood; anything else returns null and the rule goes to the owner for review.
// Never guesses: a clause it cannot read exactly makes the whole condition unreadable.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const nums = s => (String(s).match(/\d+/g) || []).map(Number);

// Split on a connective at depth 0 (outside parentheses and braces).
function splitTop(s, word) {
  const parts = []; let depth = 0, cur = '';
  const re = new RegExp(`^\\s${word}\\s`);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '{') depth++;
    if (ch === ')' || ch === '}') depth--;
    if (depth === 0 && re.test(s.slice(i, i + word.length + 2))) { parts.push(cur); cur = ''; i += word.length + 1; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}
const unwrap = s => { s = s.trim(); while (s.startsWith('(') && s.endsWith(')') && balanced(s.slice(1, -1))) s = s.slice(1, -1).trim(); return s; };
function balanced(s) { let d = 0; for (const c of s) { if (c === '(') d++; if (c === ')') d--; if (d < 0) return false; } return d === 0; }

function dayMonth(s) {
  const m = /^(\d{1,2})\s+([a-z]{3})/i.exec(s.trim());
  return m && MONTHS[m[2].toLowerCase()] ? [MONTHS[m[2].toLowerCase()], Number(m[1])] : null;
}

// One clause -> a `when` fragment, or null.
function clause(raw) {
  const c = unwrap(raw.replace(/\s*\((?:health claim|claim|downside|also [^)]*|born [^)]*|e\.g\.[^)]*|sic)\)\s*/gi, ' ').trim());
  let m;
  if ((m = /^date in (.+)$/i.exec(c))) {
    const ranges = m[1].split(/\s+OR\s+/i).map(r => r.split(/\s+-\s+/).map(dayMonth));
    return ranges.every(r => r.length === 2 && r[0] && r[1]) ? { dateIn: ranges } : null;
  }
  const ors = splitTop(c, 'OR');
  if (ors.length > 1) { const xs = ors.map(clause); return xs.every(Boolean) ? { any: xs } : null; }

  const SUBJ = { psychic: 'psychic', 'psychic number': 'psychic', destiny: 'destiny', 'destiny number': 'destiny', master: 'master',
    karmic: 'karmic', maturity: 'maturity', personality: 'personality', 'personal year': 'personalYear',
    day: 'psychic', 'day number': 'psychic', life: 'destiny', 'life number': 'destiny',
    'name compound': 'nameCompound', compound: 'nameCompound', 'name number (reduced)': 'nameRoot', 'name number': 'nameRoot',
    'full name number': 'nameRoot', 'full name': 'nameRoot', 'first name': 'firstNameRoot', 'first letter': 'firstLetter' };
  // "day or life number in 6, 8, 7", "day or life = 9"
  if ((m = /^day,? or life(?: number)?\s*(=|in)\s*\{?([\d,\s or]+)\}?$/i.exec(c))) {
    const v = nums(m[2]); return { any: [{ psychic: v }, { destiny: v }] };
  }
  if ((m = /^day,? life or name number\s*(=|in)\s*\{?([\d,\s]+)\}?$/i.exec(c))) {
    const v = nums(m[2]); return { any: [{ psychic: v }, { destiny: v }, { nameRoot: v }] };
  }
  // "subject = N", "subject != N", "subject in {a, b}", "subject in 3, 8"
  if ((m = /^([a-z ()]+?)\s*(!=|=|in|not in)\s*\{?([\dA-Z,\s/]+?)\}?$/i.exec(c))) {
    const key = SUBJ[m[1].trim().toLowerCase()];
    if (key) {
    const val = key === 'firstLetter' ? m[3].split(/[,\s]+/).filter(x => /^[A-Z]$/.test(x)) : nums(m[3]);
    if (!val.length) return null;
    return /^(!=|not in)$/i.test(m[2]) ? { not: { [key]: val } } : { [key]: val };
    }
  }
  if ((m = /^(?:name begins with letter|first letter is)\s+([A-Z])$/i.exec(c))) return { firstLetter: [m[1].toUpperCase()] };
  if ((m = /^an initial in \{([A-Z,\s]+)\}$/i.exec(c))) return { initialLetter: m[1].split(/[,\s]+/).filter(Boolean) };
  if ((m = /^(?:an? |any )?(?:initial|component word|word)(?: or (?:an? )?(?:initial|component word))?(?: totals?)? reduces? to ([\d,\s or]+?)(?: \(negative\))?$/i.exec(c))) return { partRoot: nums(m[1]) };
  if ((m = /^DOB lacks (\d)$/i.exec(c))) return { lacks: [Number(m[1])] };
  if ((m = /^DOB (?:grid )?has (\d)$/i.exec(c))) return { has: [Number(m[1])] };
  if ((m = /^DOB has (\d) (once|twice|three times|four times|four or five times)$/i.exec(c))) {
    const t = { once: [1], twice: [2], 'three times': [3], 'four times': [4], 'four or five times': [4, 5] }[m[2].toLowerCase()];
    return { repeat: { digit: Number(m[1]), times: t } };
  }
  if ((m = /^Lo Shu missing plane (\d)-(\d)-(\d)/i.exec(c))) return { plane: { id: `LS-${m[1]}${m[2]}${m[3]}`, state: 'missing' } };
  if ((m = /^karmic debt \(any\)$/i.exec(c))) return { karmic: [13, 14, 16, 19] };
  if ((m = /^master in \{([\d,\s]+)\}$/i.exec(c))) return { master: nums(m[1]) };
  if ((m = /^\(psychic, destiny\) in \{([\d,\s-]+)\}$/i.exec(c))) {
    return { pair: m[1].split(',').map(p => nums(p)).filter(p => p.length === 2) };
  }
  if ((m = /^month in \{([A-Za-z,\s]+)\}$/i.exec(c))) {
    const ms = m[1].split(/[,\s]+/).map(x => MONTHS[x.slice(0, 3).toLowerCase()]);
    return ms.every(Boolean) ? { month: ms } : null;
  }
  if ((m = /^date in (.+)$/i.exec(c))) {
    const ranges = m[1].split(/\s+OR\s+/i).map(r => r.split(/\s+-\s+/).map(dayMonth));
    return ranges.every(r => r.length === 2 && r[0] && r[1]) ? { dateIn: ranges } : null;
  }
  return null;
}

export function parseCondition(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  const parts = splitTop(t, 'AND');
  const out = parts.map(clause);
  if (out.some(x => !x)) return null;
  return out.length === 1 ? out[0] : { all: out };
}
