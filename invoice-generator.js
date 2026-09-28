'use strict';

// Veshannastro invoices in the classic Indian accounting layout (Tally style): one ruled A4 sheet with the
// seller and buyer on the left, the reference grid on the right, a ruled item table, the amount in words,
// a payment summary, the declaration and the authorised signatory.
// The same layout is used for the proforma invoice sent with the payment link and for the paid invoice.
// Veshannastro is not registered under GST, so no GST is charged and the documents are never "Tax Invoices".

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const SELLER = {
  name: 'Veshannastro',
  lines: [
    'Shashank Agrawal',
    'Currency Tower, G.E. Road, VIP Road',
    'Raipur, Chhattisgarh 492001'
  ],
  gstin: 'Unregistered (not registered under GST)',
  state: 'Chhattisgarh, Code : 22',
  email: 'veshannastro7@gmail.com',
  phone: '+91 76469 52745',
  web: 'veshannastro.co.in'
};

const PAGE = { w: 595.28, h: 841.89 };
const L = 34;
const R = PAGE.w - 34;
const W = R - L;
const MID = L + 272; // left block | right grid
const MID2 = MID + (R - MID) / 2;
const INK = '#000000';
const MUTED = '#333333';
const LINE = 0.6;

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('Invoice amounts must be finite, non-negative numbers.');
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function inr(value) {
  return `INR ${money(value)}`;
}

function safeText(value, fallback = 'Not provided') {
  return String(value ?? '').trim() || fallback;
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}

function below1000(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? below100(rest) : ''].filter(Boolean).join(' ');
}

/** Indian numbering in words: 65237 -> "Sixty Five Thousand Two Hundred Thirty Seven". */
function numberToWords(num) {
  let n = Math.floor(Number(num));
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return 'Zero';
  const parts = [];
  for (const [size, name] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
    if (n >= size) {
      const chunk = Math.floor(n / size);
      parts.push(`${size === 10000000 ? numberToWords(chunk) : below100(chunk)} ${name}`);
      n %= size;
    }
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

/** "INR Two Thousand Two Hundred Forty Nine Only" (with paise when present). */
function amountInWords(value) {
  const n = Math.round(Number(value) * 100);
  const rupees = Math.floor(n / 100);
  const paise = n % 100;
  return `INR ${numberToWords(rupees)}${paise ? ` and ${below100(paise)} paise` : ''} Only`;
}

function hline(doc, y, x1 = L, x2 = R) {
  doc.moveTo(x1, y).lineTo(x2, y).lineWidth(LINE).strokeColor(INK).stroke();
}

function vline(doc, x, y1, y2) {
  doc.moveTo(x, y1).lineTo(x, y2).lineWidth(LINE).strokeColor(INK).stroke();
}

function label(doc, text, x, y, opts = {}) {
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(text, x, y, { lineBreak: false, ...opts });
}

function value(doc, text, x, y, opts = {}) {
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(text, x, y, { ...opts });
}

/**
 * Draws one invoice page from a plain model:
 * { title, invoiceNo, date, status, customerId, paymentTerms, consultMode, appointment, reference,
 *   deliveryTerms, buyer: { name, address, phone, email, gstin },
 *   item: { name, detail, rate }, adjustments: [{ label, rateText, amount }], total,
 *   summary: [[heading, value], ...], notice, payUrl, qr }
 */
function drawInvoice(doc, m) {
  doc.rect(0, 0, PAGE.w, PAGE.h).fill('#FFFFFF');
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(m.title, L, 26, { width: W, align: 'center' });
  const top = 46;

  // ---- Right reference grid ----
  const cellH = 29;
  const grid = [
    [['Invoice No.', m.invoiceNo], ['Dated', m.date]],
    [['Customer ID', m.customerId], ['Mode/Terms of Payment', m.paymentTerms]],
    [['Consultation Mode', m.consultMode], ['Appointment (IST)', m.appointment]],
    [['Reference No.', m.reference], ['Status', m.status]]
  ];
  grid.forEach((row, i) => {
    const y = top + i * cellH;
    row.forEach(([k, v], j) => {
      const x = j ? MID2 : MID;
      label(doc, k, x + 4, y + 3);
      value(doc, safeText(v, '-'), x + 4, y + 14, { width: (R - MID) / 2 - 8, height: 12, ellipsis: true, lineBreak: false });
    });
  });
  const gridBottom = top + grid.length * cellH;
  label(doc, 'Terms of Delivery', MID + 4, gridBottom + 3);
  doc.font('Helvetica').fontSize(8.5).fillColor(INK)
    .text(m.deliveryTerms, MID + 4, gridBottom + 15, { width: R - MID - 8 });
  const termsBottom = doc.y + 6;

  // ---- Left: seller, then buyer ----
  const lw = MID - L - 8;
  let y = top + 4;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(SELLER.name, L + 4, y, { width: lw });
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  for (const line of SELLER.lines) doc.text(line, L + 4, doc.y, { width: lw });
  doc.text(`GSTIN/UIN: ${SELLER.gstin}`, L + 4, doc.y, { width: lw })
    .text(`State Name : ${SELLER.state}`, L + 4, doc.y, { width: lw })
    .text(`E-Mail : ${SELLER.email}`, L + 4, doc.y, { width: lw })
    .text(`Phone : ${SELLER.phone}  |  ${SELLER.web}`, L + 4, doc.y, { width: lw });
  const sellerBottom = doc.y + 4;
  hline(doc, sellerBottom, L, MID);

  label(doc, 'Buyer (Bill to)', L + 4, sellerBottom + 3);
  const b = m.buyer || {};
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(safeText(b.name, 'Customer'), L + 4, sellerBottom + 16, { width: lw });
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  if (String(b.address || '').trim()) doc.text(String(b.address).trim(), L + 4, doc.y, { width: lw });
  const kv = (k, v) => doc.text(`${k.padEnd(10)}: ${v}`, L + 4, doc.y, { width: lw });
  if (b.phone) kv('Phone', b.phone);
  if (b.email) kv('E-Mail', b.email);
  if (b.gstin) kv('GSTIN/UIN', b.gstin);
  const buyerBottom = doc.y + 6;

  const headBottom = Math.max(buyerBottom, termsBottom, gridBottom + 60);
  // grid rules
  for (let i = 1; i <= grid.length; i++) hline(doc, top + i * cellH, MID, R);
  vline(doc, MID2, top, gridBottom);
  vline(doc, MID, top, headBottom);

  // ---- Item table ----
  const cols = [L, L + 26, L + 250, L + 298, L + 358, L + 418, L + 456, R];
  const heads = ['Sl\nNo.', 'Description of Services', 'Mode', 'Quantity', 'Rate', 'per', 'Amount'];
  const th = headBottom;
  hline(doc, th);
  doc.font('Helvetica').fontSize(8.5).fillColor(INK);
  heads.forEach((h, i) => doc.text(h, cols[i] + 2, th + 4, { width: cols[i + 1] - cols[i] - 4, align: i === 1 ? 'center' : (i === 0 ? 'left' : 'center') }));
  const bodyTop = th + 26;
  hline(doc, bodyTop);

  let ry = bodyTop + 8;
  const it = m.item;
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text('1', cols[0] + 2, ry, { width: 20, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10).text(it.name, cols[1] + 4, ry, { width: cols[2] - cols[1] - 8 });
  const nameBottom = doc.y;
  doc.font('Helvetica').fontSize(9.5)
    .text('Online', cols[2] + 2, ry, { width: cols[3] - cols[2] - 4, align: 'center' });
  doc.font('Helvetica-Bold').text('1 Session', cols[3] + 2, ry, { width: cols[4] - cols[3] - 6, align: 'right' });
  doc.font('Helvetica').text(money(it.rate), cols[4] + 2, ry, { width: cols[5] - cols[4] - 6, align: 'right' })
    .text('Session', cols[5] + 2, ry, { width: cols[6] - cols[5] - 4, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10).text(money(it.rate), cols[6] + 2, ry, { width: cols[7] - cols[6] - 6, align: 'right' });
  ry = nameBottom + 1;
  if (it.detail) {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(it.detail, cols[1] + 4, ry, { width: cols[2] - cols[1] - 8 });
    ry = doc.y;
  }

  const adjustments = (m.adjustments || []).filter(a => Number(a.amount) > 0.004);
  if (adjustments.length) {
    ry += 10;
    hline(doc, ry, cols[6] + 6, R - 4);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK)
      .text(money(it.rate), cols[6] + 2, ry + 4, { width: cols[7] - cols[6] - 6, align: 'right' });
    ry += 22;
    for (const a of adjustments) {
      doc.font('Helvetica-BoldOblique').fontSize(9.5).fillColor(INK)
        .text(a.label, cols[1] + 4, ry, { width: cols[2] - cols[1] - 8, align: 'right' });
      if (a.rateText) {
        doc.font('Helvetica-Oblique').fontSize(9.5)
          .text(a.rateText, cols[4] + 2, ry, { width: cols[5] - cols[4] - 6, align: 'right' })
          .text('%', cols[5] + 2, ry, { width: cols[6] - cols[5] - 4, align: 'left' });
      }
      doc.font('Helvetica-Bold').fontSize(9.5)
        .text(`(-) ${money(a.amount)}`, cols[6] + 2, ry, { width: cols[7] - cols[6] - 6, align: 'right' });
      ry += 15;
    }
  }

  const bodyBottom = Math.max(ry + 24, bodyTop + 170);
  hline(doc, bodyBottom);
  for (const x of cols.slice(1, -1)) vline(doc, x, th, bodyBottom + 22);
  // Total row
  doc.font('Helvetica').fontSize(9.5).fillColor(INK)
    .text('Total', cols[1] + 4, bodyBottom + 6, { width: cols[2] - cols[1] - 8, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(9.5)
    .text('1 Session', cols[3] + 2, bodyBottom + 6, { width: cols[4] - cols[3] - 6, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11)
    .text(`Rs. ${money(m.total)}`, cols[5] + 2, bodyBottom + 5, { width: R - cols[5] - 6, align: 'right' });
  const totalBottom = bodyBottom + 22;
  hline(doc, totalBottom);

  // ---- Amount in words ----
  label(doc, 'Amount Chargeable (in words)', L + 4, totalBottom + 4);
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(INK).text('E. & O.E', R - 80, totalBottom + 4, { width: 76, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(amountInWords(m.total), L + 4, totalBottom + 17, { width: W - 8 });
  let sy = doc.y + 8;

  // ---- Payment summary (in place of the GST tax table) ----
  const summary = m.summary;
  const sx = [L + 150];
  const sw = (R - sx[0]) / summary.length;
  for (let i = 1; i <= summary.length; i++) sx.push(sx[0] + i * sw);
  hline(doc, sy);
  summary.forEach(([h, v], i) => {
    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(h, sx[i] + 2, sy + 4, { width: sw - 4, align: 'center' });
    doc.font('Helvetica').fontSize(9).text(v, sx[i] + 2, sy + 28, { width: sw - 6, align: 'right' });
  });
  hline(doc, sy + 24, sx[0], R);
  for (const x of sx) vline(doc, x, sy, sy + 44);
  doc.font('Helvetica-Bold').fontSize(9).text('Payment Summary :', L + 4, sy + 28, { width: sx[0] - L - 10, align: 'right' });
  sy += 44;
  hline(doc, sy);
  label(doc, 'Tax Amount :', L + 4, sy + 6);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK)
    .text('Nil. GST not applicable, as the supplier is not registered under GST.', L + 62, sy + 5, { width: W - 66 });
  sy = doc.y + 6;

  if (m.notice) {
    hline(doc, sy);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(m.notice, L + 4, sy + 5, { width: W - 8 });
    sy = doc.y + 6;
  }

  // ---- Bottom block: QR + declaration | payment details + signatory ----
  const blockTop = Math.max(sy, 560);
  const blockBottom = PAGE.h - 58;
  hline(doc, blockTop);
  hline(doc, blockBottom);
  vline(doc, MID + 20, blockTop, blockBottom);
  vline(doc, L, top, blockBottom);
  vline(doc, R, top, blockBottom);
  hline(doc, top);

  // left: QR and declaration
  if (m.qr) {
    doc.image(m.qr, L + 8, blockTop + 8, { fit: [78, 78] });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('Scan to Pay', L + 94, blockTop + 14);
    doc.font('Helvetica').fontSize(8.5).text('UPI, cards and net banking\nthrough Razorpay\'s secure page.', L + 94, blockTop + 28, { width: MID - L - 100 });
  }
  if (!m.qr && m.leftNote) {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(m.leftNote, L + 8, blockTop + 10, { width: MID + 20 - L - 16 });
  }
  const declY = blockBottom - 62;
  label(doc, 'Declaration', L + 4, declY);
  doc.font('Helvetica').fontSize(9).fillColor(INK).text(
    'We declare that this invoice shows the actual price of the services described and that all particulars are true and correct.',
    L + 4, declY + 12, { width: MID + 20 - L - 10 });

  // right: payment details, "for Veshannastro", signature
  const rx = MID + 26;
  const rw = R - rx - 6;
  doc.font('Helvetica').fontSize(9).fillColor(INK).text('Company\'s Payment Details', rx, blockTop + 6);
  const pay = [
    ['A/c Holder\'s Name', SELLER.name],
    ['Payment Gateway', 'Razorpay (UPI, Cards)'],
    ['Payment Link', m.payUrl || 'Not applicable']
  ];
  let py = blockTop + 20;
  for (const [k, v] of pay) {
    doc.font('Helvetica').fontSize(8.5).text(k, rx, py, { width: 82 });
    doc.text(':', rx + 82, py);
    doc.font('Helvetica-Bold').fontSize(8.5).text(v, rx + 90, py, { width: rw - 90, ellipsis: true, lineBreak: false,
      link: /^https:\/\//.test(v) ? v : undefined });
    py += 13;
  }
  doc.font('Helvetica-Bold').fontSize(9).text(`for ${SELLER.name}`, rx, py + 4, { width: rw, align: 'right' });
  const signPath = path.join(__dirname, 'assets', 'shashank-signature.png');
  if (fs.existsSync(signPath)) doc.image(signPath, R - 136, py + 18, { fit: [120, 36] });
  doc.font('Helvetica').fontSize(8.5).text('Authorised Signatory', rx, blockBottom - 14, { width: rw, align: 'right' });

  doc.font('Helvetica').fontSize(9).fillColor(INK)
    .text('This is a Computer Generated Invoice', L, blockBottom + 10, { width: W, align: 'center' });
}

function newDoc(title, subject, resolve, reject) {
  const doc = new PDFDocument({ size: 'A4', margin: 0, compress: true, info: { Title: title, Author: SELLER.name, Subject: subject } });
  const buffers = [];
  doc.on('data', chunk => buffers.push(chunk));
  doc.on('error', reject);
  doc.on('end', () => resolve(Buffer.concat(buffers)));
  return doc;
}

function discountRows(normalRate, websiteDiscount, additionalDiscount) {
  const pct = normalRate > 0 ? Number((websiteDiscount / normalRate * 100).toFixed(1)) : 0;
  return [
    { label: 'Less : Website Offer', rateText: pct ? String(pct) : '', amount: websiteDiscount },
    { label: 'Less : Additional Discount', rateText: normalRate > 0 && additionalDiscount > 0 ? String(Number((additionalDiscount / normalRate * 100).toFixed(1))) : '', amount: additionalDiscount }
  ];
}

/**
 * Paid invoice sent after Razorpay verifies the payment (same contract as before:
 * invoiceNumber, customerId, customerName, email, phone, serviceName, amountPaid, basePrice,
 * isGatewayTest, date, appointmentDate, paymentId, meetLink; optionally billingAddress, customerGstin,
 * normalRate, websiteDiscount, additionalDiscount, serviceTotal).
 */
function generateInvoice(data) {
  return new Promise((resolve, reject) => {
    try {
      const amountPaid = Number(data.amountPaid);
      if (!Number.isFinite(amountPaid) || amountPaid <= 0) throw new Error('Invoice requires a verified positive numeric amount.');
      const basePrice = Number(data.basePrice ?? amountPaid);
      if (!Number.isFinite(basePrice) || basePrice < 0) throw new Error('Invoice requires a valid published service price.');
      const test = Boolean(data.isGatewayTest);

      // Price breakdown: use the booking's own figures when they reconcile, otherwise the plain price.
      let normalRate = Number(data.normalRate);
      let webDisc = Number(data.websiteDiscount || 0);
      let addDisc = Number(data.additionalDiscount || 0);
      let serviceTotal = Number(data.serviceTotal);
      const reconciles = [normalRate, webDisc, addDisc, serviceTotal].every(Number.isFinite) && normalRate > 0 && serviceTotal > 0
        && Math.abs(normalRate - webDisc - addDisc - serviceTotal) <= 0.01;
      if (!reconciles) {
        serviceTotal = test ? basePrice : amountPaid;
        normalRate = Math.max(serviceTotal, basePrice);
        webDisc = normalRate - serviceTotal;
        addDisc = 0;
      }
      const received = amountPaid;
      const due = test ? serviceTotal : Math.max(0, serviceTotal - received);

      const doc = newDoc(`Invoice ${safeText(data.invoiceNumber, '')}`,
        test ? 'Gateway validation payment - consultation fee not paid' : 'Consultation invoice (paid)', resolve, reject);
      drawInvoice(doc, {
        title: test ? 'INVOICE (GATEWAY TEST)' : 'INVOICE',
        invoiceNo: safeText(data.invoiceNumber, '-'),
        date: safeText(data.date, '-'),
        status: test ? 'TEST PAYMENT RECEIVED' : (due > 0 ? 'PART PAID' : 'PAID'),
        customerId: safeText(data.customerId, 'Allotted on confirmation'),
        paymentTerms: 'Online - Razorpay',
        consultMode: 'Google Meet',
        appointment: safeText(data.appointmentDate, 'To be scheduled'),
        reference: safeText(data.paymentId, '-'),
        deliveryTerms: data.meetLink
          ? `Online consultation on Google Meet: ${data.meetLink}\nPlease join 5 minutes before your appointment time.`
          : 'Online consultation on Google Meet. The meeting link is shared on WhatsApp and e-mail.',
        buyer: { name: data.customerName, address: data.billingAddress, phone: data.phone ? `+${String(data.phone).replace(/^\+/, '')}` : '', email: data.email, gstin: data.customerGstin },
        item: { name: safeText(data.serviceName, 'Consultation'), detail: data.appointmentDate ? `Appointment: ${data.appointmentDate}` : '', rate: normalRate },
        adjustments: discountRows(normalRate, webDisc, addDisc),
        total: serviceTotal,
        summary: [
          ['Service\nValue', money(normalRate)],
          ['Discount', money(webDisc + addDisc)],
          ['Net\nAmount', money(serviceTotal)],
          [test ? 'Received\n(test only)' : 'Amount\nReceived', money(received)],
          ['Balance\nDue', money(due)]
        ],
        notice: test
          ? `Gateway test only: INR ${money(received)} was received to validate the live payment gateway. It does not pay for or confirm the consultation. Consultation amount due: ${inr(serviceTotal)}.`
          : '',
        payUrl: '',
        qr: null,
        leftNote: test
          ? `Gateway test amount of ${inr(received)} received via Razorpay. The consultation fee of ${inr(serviceTotal)} is still due.`
          : `Received with thanks ${inr(received)} via Razorpay${data.paymentId ? ` (Payment ID ${data.paymentId})` : ''}.`
      });
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** Proforma invoice sent with the Razorpay payment link, before payment. */
function generatePaymentRequestInvoice(data) {
  return new Promise(async (resolve, reject) => {
    try {
      const normalRate = Number(data.normalRate);
      const websiteDiscount = Number(data.websiteDiscount || 0);
      const additionalDiscount = Number(data.additionalDiscount || 0);
      const serviceTotal = Number(data.serviceTotal);
      const linkAmount = Number(data.linkAmount);
      if (![normalRate, websiteDiscount, additionalDiscount, serviceTotal, linkAmount].every(Number.isFinite)
        || normalRate <= 0 || websiteDiscount < 0 || additionalDiscount < 0 || serviceTotal <= 0 || linkAmount <= 0) {
        throw new Error('Payment request requires valid catalogue, discount and payment amounts.');
      }
      if (Math.abs(normalRate - websiteDiscount - additionalDiscount - serviceTotal) > 0.01) {
        throw new Error('Invoice discount arithmetic does not reconcile to the service total.');
      }
      if (!data.paymentUrl || !/^https:\/\//i.test(String(data.paymentUrl))) {
        throw new Error('A secure Razorpay payment URL is required for the invoice QR.');
      }
      const test = Boolean(data.isGatewayTest);
      const payNow = test ? linkAmount : serviceTotal;
      const qr = await QRCode.toBuffer(String(data.paymentUrl), {
        type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 240, color: { dark: '#000000', light: '#FFFFFF' }
      });

      const doc = newDoc(`Proforma invoice ${safeText(data.invoiceNumber, '')}`, 'Proforma invoice - payment pending', resolve, reject);
      drawInvoice(doc, {
        title: 'PROFORMA INVOICE',
        invoiceNo: safeText(data.invoiceNumber, '-'),
        date: safeText(data.issueDate, '-'),
        status: 'UNPAID',
        customerId: safeText(data.customerId, 'Allotted on payment'),
        paymentTerms: '100% Advance - Online',
        consultMode: 'Google Meet',
        appointment: safeText(data.appointmentDate, 'To be scheduled'),
        reference: String(data.paymentUrl).replace(/^https:\/\//i, ''),
        deliveryTerms: 'Online consultation on Google Meet. The appointment is confirmed once the payment is verified; the meeting link is then sent on WhatsApp and e-mail.',
        buyer: { name: data.customerName, address: data.billingAddress, phone: data.phone ? `+${String(data.phone).replace(/^\+/, '')}` : '', email: data.email, gstin: data.customerGstin },
        item: { name: safeText(data.serviceName, 'Consultation'), detail: data.appointmentDate ? `Appointment: ${data.appointmentDate}` : '', rate: normalRate },
        adjustments: discountRows(normalRate, websiteDiscount, additionalDiscount),
        total: serviceTotal,
        summary: [
          ['Service\nValue', money(normalRate)],
          ['Discount', money(websiteDiscount + additionalDiscount)],
          ['Net\nAmount', money(serviceTotal)],
          ['Payable\nNow', money(payNow)],
          ['Balance\nDue', money(test ? serviceTotal : 0)]
        ],
        notice: test
          ? `Gateway test only: this Razorpay link collects INR ${money(linkAmount)} to validate the live payment gateway. It does not pay for or confirm the consultation. Consultation amount due: ${inr(serviceTotal)}.`
          : 'Payment pending. This proforma invoice is not a payment receipt; the paid invoice is sent automatically once Razorpay confirms your payment.',
        payUrl: String(data.paymentUrl),
        qr
      });
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { generateInvoice, generatePaymentRequestInvoice, amountInWords, numberToWords };
