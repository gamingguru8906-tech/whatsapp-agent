'use strict';
// Reports delivered on WhatsApp (report clarity, Phase 3).
//
// When the owner taps "Send through Kamala" on the report backend's Make a report page, the backend posts the report
// here (POST /report-ready, signed with REPORTS_SECRET) with short-lived links to the PDF and the summary card. Kamala
// sends three things: the PDF, the 9:16 summary card, and a one-minute Hinglish voice note reading that summary.
// A buyer whose chat window is closed gets the PDF as the approved template; the card and the voice note wait for their
// reply (WhatsApp allows nothing else until then). The report is marked delivered on the dashboard.
//
// Two days later she asks two questions, "Was your report clear, 1 to 5?" and "What did you do first?", catches the two
// answers before her normal chat, tells the owner (a low rating straight to his WhatsApp) and keeps them for the Sheet.
// Every step runs once (report_deliveries.steps), so a retry never sends anything twice.

const FEEDBACK_AFTER_HOURS = 48;
const ANSWER_WINDOW_DAYS = 10;

const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'ji';
const andList = xs => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} aur ${xs[xs.length - 1]}` : xs.join(''));
const sentence = t => { const s = String(t || '').trim(); return s && !/[.!?]$/.test(s) ? s + '.' : s; };

/** About a minute of Kamala's voice, built only from the report's own facts (nothing invented). */
function voiceScript(summary, name) {
  const s = summary || {};
  const f = firstName(name || s.first);
  const year = s.year || new Date().getFullYear() + 1;
  const dos = (s.dos || []).slice(0, 3).map(sentence);
  const ord = ['Pehli', 'Doosri', 'Aur teesri'];
  const parts = [
    `Namaste ${f} ji, main Kamala, Veshannastro se.`,
    `Aapki ${year} ki report aapke WhatsApp par aa gayi hai, aur saath mein ek summary card bhi.`,
    'Ek minute mein main aapko short mein bata deti hoon.'
  ];
  if (s.theme) parts.push(`Aapke liye ${year} ka theme hai: ${sentence(s.theme)}`);
  if (dos.length) parts.push(`Is saal ${dos.length === 3 ? 'teen' : dos.length === 2 ? 'do' : 'ek'} cheezein zaroor kijiye.`, ...dos.map((d, i) => `${dos.length === 1 ? '' : ord[i] + ', '}${d}`));
  if ((s.best_months || []).length) parts.push(`Aapke sabse acche mahine hain ${andList(s.best_months)}.`);
  const nums = (s.lucky_numbers || []).map(String);
  if (nums.length) parts.push(`Aapke lucky numbers hain ${andList(nums)}${s.colour ? `, aur pehenne ke liye colours: ${sentence(s.colour)}` : '.'}`);
  parts.push('Report mein har mahine ka plan detail mein diya hai, aaram se padhiye.', 'Koi bhi sawaal ho toh isi chat par pooch lijiye. Aapka saal bahut accha jaaye!');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5 };

/** "4", "4/5", "5 stars", "rating 3", "⭐⭐⭐⭐", "chaar" -> 1..5; anything else -> null. */
function parseRating(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!🙏👍\s]+$/u, '');
  if (!t || t.length > 30) return null;
  const stars = t.match(/^(?:⭐|🌟)+$/u);
  if (stars) { const n = [...t].length; return n >= 1 && n <= 5 ? n : null; }
  let m = /^(?:rating\s*[:-]?\s*|i give\s+)?([1-5])\s*(?:\/\s*5|out\s*of\s*5|stars?)?\s*(?:hai|h|ji|dunga|dungi)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(one|two|three|four|five|ek|do|teen|chaar|char|paanch|panch)\s*(?:hai|ji)?$/.exec(t);
  return m ? WORDS[m[1]] : null;
}

/** A message that is clearly something else (a question, a long message) is left to Kamala's normal chat. */
function looksLikeAnswer(text) {
  const t = String(text || '').trim();
  return t.length >= 2 && t.length <= 400 && !/\?\s*$/.test(t);
}

function create(deps) {
  const db = () => deps.pool;

  async function migrate(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS report_deliveries (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL,
        name TEXT, title TEXT, filename TEXT,
        pdf_url TEXT, card_url TEXT,
        summary JSONB,
        status TEXT NOT NULL DEFAULT 'sending',
        steps JSONB NOT NULL DEFAULT '{}'::jsonb,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        sent_at TIMESTAMPTZ,
        feedback_status TEXT,
        feedback_ask_at TIMESTAMPTZ,
        asked_at TIMESTAMPTZ,
        rating INTEGER,
        rating_at TIMESTAMPTZ,
        first_action TEXT,
        first_action_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS report_deliveries_phone_idx ON report_deliveries (phone, created_at DESC);
      ALTER TABLE voice_pending_messages ADD COLUMN IF NOT EXISTS media_type TEXT;
    `);
  }

  /** Checks the backend's request. Returns the clean delivery or null. */
  function read(b) {
    const x = b || {};
    const id = String(x.job_id || '');
    const phone = String(x.phone || '').replace(/\D/g, '');
    const https = u => (u && /^https:\/\/[^\s]+$/i.test(String(u)) ? String(u) : null);
    if (!/^[\w.:-]{4,80}$/.test(id) || !/^\d{11,15}$/.test(phone) || !https(x.pdf_url)) return null;
    return {
      id, phone, name: String(x.name || '').slice(0, 80), title: String(x.title || 'your report').slice(0, 120),
      filename: /^[\w .()-]{1,120}\.pdf$/i.test(String(x.filename || '')) ? String(x.filename) : 'Report.pdf',
      pdfUrl: https(x.pdf_url), cardUrl: https(x.card_url),
      summary: x.summary && typeof x.summary === 'object' ? x.summary : null
    };
  }

  /** Records the delivery (or a re-send) and starts sending. Returns { status, job }. */
  async function ready(body) {
    const pool = db();
    if (!pool) throw new Error('No database');
    const d = read(body);
    if (!d) return { status: 'invalid' };
    const r = await pool.query(`INSERT INTO report_deliveries (id, phone, name, title, filename, pdf_url, card_url, summary, status, attempts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'sending',1)
      ON CONFLICT (id) DO UPDATE SET phone=EXCLUDED.phone, name=EXCLUDED.name, title=EXCLUDED.title, filename=EXCLUDED.filename,
        pdf_url=EXCLUDED.pdf_url, card_url=EXCLUDED.card_url, summary=EXCLUDED.summary, status='sending',
        steps = report_deliveries.steps - 'pdf' - 'card' - 'voice', attempts = report_deliveries.attempts + 1, updated_at=NOW()
      WHERE report_deliveries.status <> 'sending' OR report_deliveries.updated_at < NOW() - INTERVAL '10 minutes'
      RETURNING id`, [d.id, d.phone, d.name, d.title, d.filename, d.pdfUrl, d.cardUrl, JSON.stringify(d.summary)]);
    if (!r.rows.length) return { status: 'busy' };
    const job = send(d.id);
    if (deps.track) deps.track(job);
    return { status: 'started', job };
  }

  async function send(id) {
    const pool = db();
    try {
      const row = (await pool.query('SELECT * FROM report_deliveries WHERE id=$1', [id])).rows[0];
      const steps = row.steps || {};
      const once = async (name, fn) => {
        if (Object.prototype.hasOwnProperty.call(steps, name)) return steps[name];
        const value = await fn();
        steps[name] = value === undefined ? true : value;
        await pool.query(`UPDATE report_deliveries SET steps = COALESCE(steps,'{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb), updated_at=NOW()
          WHERE id=$1`, [id, name, JSON.stringify(steps[name])]);
        return steps[name];
      };
      const f = firstName(row.name);
      const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000);

      // 1. The PDF: a normal document in an open chat, else the approved template with the PDF as its header.
      const pdf = await once('pdf', async () => {
        const buf = await deps.download(row.pdf_url);
        const mediaId = await deps.uploadMedia(buf, row.filename, 'application/pdf');
        if (!mediaId) throw new Error('WhatsApp did not accept the PDF upload');
        return deps.deliver(row.phone, {
          mediaId, filename: row.filename,
          body: `Namaste ${f} ji 🙏 Yeh rahi aapki ${row.title}. Aaram se padhiye, aur koi bhi sawaal ho toh yahin pooch lijiye.`,
          template: [f, row.title], templateName: deps.readyTemplate || 'report_ready', expiresAt: expires
        });
      });
      const open = pdf === 'sent';

      // 2. The summary card (sent now in an open chat, else kept until they reply).
      const card = row.card_url ? await once('card', async () => {
        const buf = await deps.download(row.card_url);
        const mediaId = await deps.uploadMedia(buf, row.filename.replace(/\.pdf$/i, '_card.png'), 'image/png');
        if (!mediaId) throw new Error('WhatsApp did not accept the summary card upload');
        const caption = `Aapka ${(row.summary && row.summary.year) || ''} ek nazar mein. Ise save kar lijiye.`.replace('  ', ' ');
        if (open && await deps.sendImage(row.phone, mediaId, caption)) return 'sent';
        await deps.hold(row.phone, { mediaId, mediaType: 'image', body: caption, expiresAt: expires });
        return 'awaiting_reply';
      }) : 'none';

      // 3. The voice note: about a minute reading the summary. Best effort; the report is already delivered.
      const voice = row.summary ? await once('voice', async () => {
        try {
          const script = voiceScript(row.summary, row.name);
          const ogg = await deps.speak(script);
          const mediaId = await deps.uploadMedia(ogg, 'report-summary.ogg', 'audio/ogg');
          if (!mediaId) return 'upload_failed';
          if (open && await deps.sendAudio(row.phone, mediaId)) { deps.saveTurn(row.phone, `[Voice note] ${script}`); return 'sent'; }
          await deps.hold(row.phone, { mediaId, mediaType: 'audio', body: `[Voice note] ${script}`, expiresAt: expires });
          return 'awaiting_reply';
        } catch (e) {
          console.error('Report voice note failed:', e.message);
          return 'failed';
        }
      }) : 'none';

      // 4. Delivered on the dashboard: their latest paid report that is not marked delivered yet.
      await once('dashboard', async () => {
        const m = await pool.query(`UPDATE wa_payment_links SET report_delivered_at=NOW()
          WHERE payment_link_id = (SELECT payment_link_id FROM wa_payment_links WHERE phone=$1 AND status='paid'
            AND delivery_kind='delivered' AND report_delivered_at IS NULL ORDER BY paid_at DESC NULLS LAST LIMIT 1)
          RETURNING payment_link_id, report_delivered_at`, [row.phone]);
        if (m.rows[0]) deps.emit({ type: 'invoice_update', payment_link_id: m.rows[0].payment_link_id, report_delivered_at: m.rows[0].report_delivered_at });
        return m.rows[0] ? m.rows[0].payment_link_id : 'no_open_order';
      });

      // 5. Feedback two days from now (once per delivery, even if it is sent again).
      await pool.query(`UPDATE report_deliveries SET status='sent', sent_at=COALESCE(sent_at, NOW()), last_error=NULL,
        feedback_status=COALESCE(feedback_status, 'scheduled'),
        feedback_ask_at=COALESCE(feedback_ask_at, NOW() + INTERVAL '${FEEDBACK_AFTER_HOURS} hours'), updated_at=NOW() WHERE id=$1`, [id]);
      const how = v => (v === 'sent' ? 'sent' : v === 'sent_template' ? 'sent (template)' : v === 'awaiting_hi' || v === 'awaiting_reply' ? 'waiting for their reply' : v === 'none' ? 'none' : `not sent (${v})`);
      await once('owner_note', () => deps.notifyOwner(`📄 Report sent to ${row.name || 'the customer'} (+${row.phone}): ${row.title}.\n`
        + `PDF: ${how(pdf)}. Summary card: ${how(card)}. Voice note: ${how(voice)}.\nKamala asks for their feedback in two days.`, 'Report sent').then(() => true));
      if (pdf === 'awaiting_hi') {
        await once('pdf_alert', () => deps.notifyOwner(`⚠️ ${row.name || 'A customer'} (+${row.phone}): the report could not go out on WhatsApp yet (their chat window is closed and the report_ready template is not approved or failed). It goes out the moment they message. You may want to message them or email the PDF.`, 'Report waiting to be delivered').then(() => true));
      }
      return 'sent';
    } catch (e) {
      console.error(`Report delivery ${id} failed:`, e.message);
      await pool.query(`UPDATE report_deliveries SET status='failed', last_error=$2, updated_at=NOW() WHERE id=$1`, [id, String(e.message).slice(0, 400)]).catch(() => {});
      await deps.notifyOwner(`⚠️ Kamala could not send the report ${id}: ${e.message}. Send it yourself from the Make a report page, or tap Send through Kamala again.`, 'Report not delivered').catch(() => {});
      return 'failed';
    }
  }

  /** Asks the feedback questions that are due (two days after delivery). */
  async function askDue() {
    const pool = db();
    if (!pool) return 0;
    const due = await pool.query(`UPDATE report_deliveries SET feedback_status='asking', updated_at=NOW()
      WHERE id IN (SELECT id FROM report_deliveries WHERE feedback_status='scheduled' AND feedback_ask_at <= NOW() ORDER BY feedback_ask_at LIMIT 10)
      RETURNING id, phone, name, title`);
    let n = 0;
    for (const row of due.rows) {
      const f = firstName(row.name);
      try {
        const r = await deps.deliver(row.phone, {
          body: `Namaste ${f} ji 🙏 Do din pehle aapko aapki ${row.title} bheji thi. Ek chhota sa sawaal: kya report clear thi? 1 se 5 mein reply kijiye (5 matlab bilkul clear).`,
          template: [f, row.title], templateName: deps.feedbackTemplate || 'report_feedback',
          expiresAt: new Date(Date.now() + 5 * 24 * 3600 * 1000)
        });
        await pool.query(`UPDATE report_deliveries SET feedback_status='asked', asked_at=NOW(), steps = steps || jsonb_build_object('feedback_ask', $2::text), updated_at=NOW() WHERE id=$1`, [row.id, r]);
        n++;
      } catch (e) {
        console.error(`Feedback question for ${row.id} failed:`, e.message);
        await pool.query(`UPDATE report_deliveries SET feedback_status='scheduled', feedback_ask_at=NOW() + INTERVAL '1 hour' WHERE id=$1`, [row.id]).catch(() => {});
      }
    }
    return n;
  }

  /** When feedback questions are due (for the server's wake-up schedule). */
  async function nextAskAt() {
    const pool = db();
    if (!pool) return null;
    const r = await pool.query(`SELECT MIN(feedback_ask_at) AS t FROM report_deliveries WHERE feedback_status='scheduled'`).catch(() => ({ rows: [] }));
    return r.rows[0] && r.rows[0].t ? new Date(r.rows[0].t) : null;
  }

  /**
   * A message from someone with a feedback question open. Returns Kamala's reply when the message answers it (and
   * records the answer), or null to let her chat as usual.
   */
  async function reply(phone, text) {
    const pool = db();
    if (!pool) return null;
    const row = (await pool.query(`SELECT id, name, title, feedback_status, rating FROM report_deliveries
      WHERE phone=$1 AND feedback_status IN ('asked','rated') AND asked_at > NOW() - INTERVAL '${ANSWER_WINDOW_DAYS} days'
      ORDER BY asked_at DESC LIMIT 1`, [phone]).catch(() => ({ rows: [] }))).rows[0];
    if (!row) return null;
    if (row.feedback_status === 'asked') {
      const rating = parseRating(text);
      if (!rating) return null;
      await pool.query(`UPDATE report_deliveries SET rating=$2, rating_at=NOW(), feedback_status='rated', updated_at=NOW() WHERE id=$1`, [row.id, rating]);
      if (rating <= 2) {
        await deps.notifyOwner(`⚠️ ${row.name || 'A customer'} (+${phone}) rated the clarity of their ${row.title} ${rating}/5. Worth a personal message.`, 'Low report rating').catch(() => {});
      }
      return rating >= 4
        ? 'Thank you ji, bahut accha laga sunkar 🙏 Ek aur chhota sa sawaal: report padhne ke baad aapne sabse pehle kya kiya?'
        : 'Thank you ji, aapne honestly bataya 🙏 Ek aur chhota sa sawaal: report padhne ke baad aapne sabse pehle kya kiya? Aur kya cheez clear nahi thi, woh bhi likh dijiye.';
    }
    if (!looksLikeAnswer(text)) return null;
    await pool.query(`UPDATE report_deliveries SET first_action=$2, first_action_at=NOW(), feedback_status='done', updated_at=NOW() WHERE id=$1`, [row.id, String(text).trim().slice(0, 500)]);
    await deps.notifyOwner(`📝 Report feedback from ${row.name || 'a customer'} (+${phone}), ${row.title}: clarity ${row.rating}/5. What they did first: "${String(text).trim().slice(0, 300)}"`, 'Report feedback').catch(() => {});
    return 'Bahut accha, thank you for sharing ji 🙏 Koi bhi sawaal ho toh yahin pooch lijiye.';
  }

  return { migrate, read, ready, send, askDue, nextAskAt, reply };
}

module.exports = { create, voiceScript, parseRating, looksLikeAnswer, FEEDBACK_AFTER_HOURS };
