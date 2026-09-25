'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const COLORS = {
  canvas: '#F1F4FC',
  white: '#FFFFFF',
  navy: '#29304A',
  slate: '#53617B',
  line: '#E8EBF3',
  lavender: '#B9B5F1',
  lavenderLight: '#F4F3FE',
  warning: '#FFF7E8',
  warningInk: '#78581C',
  soft: '#F7F8FC'
};

function inr(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Invoice amounts must be finite, non-negative numbers.');
  return `INR ${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function safeText(value, fallback = 'Not provided') {
  return String(value ?? '').trim() || fallback;
}

/** Creates an A4 receipt using the supplied invoice reference's navy/lavender layout. */
function generateInvoice(data) {
  return new Promise((resolve, reject) => {
    try {
      const amountPaid = Number(data.amountPaid);
      if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
        throw new Error('Invoice requires a verified positive numeric amount.');
      }
      const basePrice = Number(data.basePrice ?? amountPaid);
      if (!Number.isFinite(basePrice) || basePrice < 0) {
        throw new Error('Invoice requires a valid published service price.');
      }

      const doc = new PDFDocument({ size: 'A4', margin: 0, compress: true, info: {
        Title: `Payment receipt ${safeText(data.invoiceNumber, 'Receipt')}`,
        Author: 'Veshannastro',
        Subject: data.isGatewayTest ? 'Gateway validation receipt - not consultation payment' : 'Consultation payment receipt'
      } });
      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const pageW = 595.28;
      const pageH = 841.89;
      const card = { x: 13, y: 10, w: pageW - 26, h: pageH - 20 };
      const left = 45;
      const right = pageW - 45;

      // Reference's pale dotted canvas and large white invoice card.
      doc.rect(0, 0, pageW, pageH).fill(COLORS.canvas);
      doc.fillColor('#DDE3F1');
      for (let x = 4; x < pageW; x += 40) {
        for (let y = 4; y < pageH; y += 40) doc.circle(x, y, 1.15).fill();
      }
      doc.roundedRect(card.x, card.y, card.w, card.h, 14)
        .fillAndStroke(COLORS.white, '#E6EAF3');

      // Business title and the invoice-number block echo the supplied template.
      doc.font('Helvetica-Bold').fontSize(22).fillColor(COLORS.navy)
        .text('VESHANNASTRO', 45, 40, { characterSpacing: 1.1, width: 390 });
      doc.font('Helvetica').fontSize(14).fillColor(COLORS.slate)
        .text('Consultation', 45, 68);
      doc.font('Helvetica-Bold').fontSize(27).fillColor(COLORS.navy)
        .text('PAYMENT RECEIPT', 45, 127, { width: 390 });
      doc.font('Helvetica').fontSize(12).fillColor(COLORS.slate)
        .text(`#${safeText(data.invoiceNumber, 'PENDING')}`, 45, 160, { width: 390 });

      // Lavender brand tile with a simple VN monogram, like the sample's square mark.
      doc.roundedRect(496, 120, 54, 54, 11).fill(COLORS.lavender);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.white)
        .text('VN', 496, 139, { width: 54, align: 'center' });

      doc.font('Helvetica').fontSize(11).fillColor(COLORS.slate)
        .text('AMOUNT RECEIVED', left, 208);
      doc.font('Helvetica').fontSize(19).fillColor(COLORS.navy)
        .text(inr(amountPaid), left, 229);
      doc.roundedRect(415, 205, 135, 28, 5).fill(COLORS.lavenderLight);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.navy)
        .text(data.isGatewayTest ? 'GATEWAY TEST' : 'PAYMENT RECEIVED', 421, 214, { width: 123, align: 'center' });

      doc.moveTo(30, 270).lineTo(pageW - 30, 270).lineWidth(1).strokeColor(COLORS.line).stroke();

      // Invoice date, service slot, customer information.
      const rows = [
        ['Receipt Date', safeText(data.date)],
        ['Consultation', safeText(data.serviceName)],
        ['Requested Slot', safeText(data.appointmentDate, 'Not yet provided')]
      ];
      rows.forEach((row, index) => {
        const y = 289 + index * 31;
        doc.font('Helvetica').fontSize(11).fillColor(COLORS.slate).text(row[0], left, y, { width: 105 });
        doc.font('Helvetica').fontSize(11).fillColor(COLORS.slate).text(':', 151, y);
        doc.font('Helvetica').fontSize(11).fillColor(COLORS.navy).text(row[1], 168, y, { width: 255, ellipsis: true });
      });

      doc.font('Helvetica').fontSize(10).fillColor(COLORS.slate).text('Billed To', 430, 289, { width: 120 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.navy)
        .text(safeText(data.customerName, 'Customer'), 430, 307, { width: 120, height: 30, ellipsis: true });
      if (data.phone) doc.font('Helvetica').fontSize(9).fillColor(COLORS.slate).text(String(data.phone), 430, 340, { width: 120, ellipsis: true });
      if (data.email) doc.font('Helvetica').fontSize(8).fillColor(COLORS.slate).text(String(data.email), 430, 355, { width: 120, ellipsis: true });

      if (data.meetLink) {
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.slate).text('Google Meet', left, 385);
        doc.font('Helvetica').fontSize(9).fillColor(COLORS.navy)
          .text(String(data.meetLink), 168, 385, { width: 360, link: String(data.meetLink), ellipsis: true });
      }

      // Dark rounded table head and a single paid line item.
      const tableY = 421;
      doc.roundedRect(30, tableY, pageW - 60, 44, 8).fill(COLORS.navy);
      doc.font('Helvetica').fontSize(11).fillColor(COLORS.white);
      doc.text('Item & Description', 53, tableY + 15, { width: 235 });
      doc.text('Qty', 306, tableY + 15, { width: 40, align: 'right' });
      doc.text('Rate', 365, tableY + 15, { width: 75, align: 'right' });
      doc.text('Amount', 455, tableY + 15, { width: 85, align: 'right' });

      const itemY = tableY + 68;
      doc.font('Helvetica').fontSize(12).fillColor(COLORS.navy)
        .text(data.isGatewayTest ? 'Razorpay gateway validation' : safeText(data.serviceName), 53, itemY, { width: 235, ellipsis: true });
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.slate)
        .text(data.isGatewayTest ? 'Test only - consultation remains unpaid' : 'Consultation payment', 53, itemY + 21, { width: 235, ellipsis: true });
      doc.font('Helvetica').fontSize(12).fillColor(COLORS.navy);
      doc.text('1', 306, itemY, { width: 40, align: 'right' });
      doc.text(inr(amountPaid), 365, itemY, { width: 75, align: 'right' });
      doc.text(inr(amountPaid), 455, itemY, { width: 85, align: 'right' });

      doc.moveTo(30, 533).lineTo(pageW - 30, 533).lineWidth(1).strokeColor(COLORS.line).stroke();
      doc.font('Helvetica').fontSize(11).fillColor(COLORS.slate).text('Sub Total', 350, 555, { width: 90, align: 'right' });
      doc.font('Helvetica').fontSize(11).fillColor(COLORS.navy).text(inr(amountPaid), 455, 555, { width: 85, align: 'right' });
      doc.font('Helvetica').fontSize(11).fillColor(COLORS.slate).text('Total Received', 350, 586, { width: 90, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.navy).text(inr(amountPaid), 455, 585, { width: 85, align: 'right' });

      doc.roundedRect(330, 620, 220, 47, 8).fill(COLORS.soft);
      doc.font('Helvetica').fontSize(10).fillColor(COLORS.slate)
        .text(data.isGatewayTest ? 'Consultation fee still due' : 'Balance', 345, 638, { width: 113 });
      doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.navy)
        .text(inr(data.isGatewayTest ? basePrice : Math.max(0, basePrice - amountPaid)), 455, 636, { width: 85, align: 'right' });

      if (data.isGatewayTest) {
        doc.roundedRect(45, 695, pageW - 90, 57, 7).fill(COLORS.warning);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(COLORS.warningInk)
          .text('TEST PAYMENT ONLY - NOT A CONSULTATION INVOICE', 58, 707, { width: pageW - 116 });
        doc.font('Helvetica').fontSize(8).fillColor(COLORS.warningInk)
          .text(`INR ${amountPaid.toFixed(2)} validates the payment gateway only. It does not pay for or confirm a consultation. Published consultation price: ${inr(basePrice)}.`, 58, 725, { width: pageW - 116, height: 23 });
      }

      doc.moveTo(30, 775).lineTo(pageW - 30, 775).lineWidth(1).strokeColor(COLORS.line).stroke();
      doc.font('Helvetica').fontSize(9).fillColor(COLORS.slate)
        .text('Thank you. Please retain this payment receipt for your records.', 45, 791, { width: pageW - 90, align: 'center' });
      if (data.paymentId) {
        doc.font('Helvetica').fontSize(7).fillColor(COLORS.slate)
          .text(`Razorpay Payment ID: ${String(data.paymentId)}`, 45, 808, { width: pageW - 90, align: 'center', ellipsis: true });
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Builds the unpaid, non-GST payment request sent with the Razorpay link.
 * Kept separate from generateInvoice(), which remains the existing paid receipt.
 */
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

      const qrBuffer = await QRCode.toBuffer(String(data.paymentUrl), {
        type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 220,
        color: { dark: '#111111', light: '#FFFFFF' }
      });
      const doc = new PDFDocument({ size: 'A4', margin: 0, compress: true, info: {
        Title: `Payment request ${safeText(data.invoiceNumber, 'Invoice')}`,
        Author: 'Veshannastro',
        Subject: 'Unpaid non-GST consultation payment request'
      } });
      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(buffers)));

      const pageW = 595.28;
      const ink = '#202020';
      const muted = '#505050';
      const rule = '#8A8A8A';
      const left = 42;
      const right = pageW - 42;
      doc.rect(0, 0, pageW, 841.89).fill('#FFFFFF');
      doc.font('Helvetica-Bold').fontSize(14).fillColor(ink)
        .text('INVOICE / PAYMENT REQUEST', left, 27, { width: pageW - 84, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(13).fillColor(ink).text('Veshannastro', left + 8, 55);
      doc.font('Helvetica').fontSize(9).fillColor(ink)
        .text('Shashank Agrawal', left + 8, 73)
        .text('Currency Tower, G.E. Road, VIP Road, Raipur, Chhattisgarh 492001', left + 8, 87)
        .text('veshannastro7@gmail.com  |  +91 7646952745  |  veshannastro.co.in', left + 8, 101);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Invoice No.', 355, 58)
        .text('Issue Date', 355, 80).text('Status', 355, 102);
      doc.font('Helvetica').fontSize(9).fillColor(ink)
        .text(safeText(data.invoiceNumber), 424, 58, { width: 125 })
        .text(safeText(data.issueDate), 424, 80, { width: 125 })
        .text('UNPAID - PAYMENT REQUEST', 424, 102, { width: 130 });

      doc.moveTo(left, 124).lineTo(right, 124).lineWidth(0.6).strokeColor(rule).stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Bill To', left + 8, 134);
      doc.font('Helvetica').fontSize(9).fillColor(ink)
        .text(safeText(data.customerName), left + 8, 150, { width: 250 })
        .text(safeText(data.billingAddress), left + 8, 164, { width: 300, height: 36 })
        .text(`Email: ${safeText(data.email)}`, left + 8, 202, { width: 280 })
        .text(`Phone: ${safeText(data.phone)}`, left + 8, 216, { width: 280 })
        .text(`Customer ID: ${safeText(data.customerId)}`, left + 8, 230, { width: 280 });
      if (data.customerGstin) {
        doc.font('Helvetica').fontSize(8).fillColor(ink)
          .text(`Customer GSTIN (provided): ${String(data.customerGstin)}`, left + 8, 244, { width: 300, ellipsis: true });
      }
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Consultation', 355, 134);
      doc.font('Helvetica').fontSize(9).fillColor(ink)
        .text(safeText(data.serviceName), 355, 150, { width: 185, height: 28 })
        .text(`Appointment: ${safeText(data.appointmentDate)}`, 355, 181, { width: 185, height: 30 });

      // Plain bordered table, deliberately distinct from the existing receipt.
      const tableX = left;
      const tableY = 270;
      const tableW = right - left;
      const headerH = 28;
      const rowH = 42;
      const totalDiscount = websiteDiscount + additionalDiscount;
      const websiteDiscountPercent = normalRate > 0
        ? Number((websiteDiscount / normalRate * 100).toFixed(1))
        : 0;
      const discountCaption = websiteDiscount > 0 && additionalDiscount > 0
        ? `Website ${websiteDiscountPercent}% + approved extra`
        : websiteDiscount > 0
          ? `Website offer (${websiteDiscountPercent}%)`
          : additionalDiscount > 0 ? 'Approved additional discount' : '';
      const rows = [
        [safeText(data.serviceName), '1', inr(normalRate), totalDiscount > 0
          ? `- ${inr(totalDiscount)}\n${discountCaption}` : '', inr(serviceTotal)]
      ];
      const cols = [tableX, tableX + 205, tableX + 255, tableX + 345, tableX + 425, tableX + tableW];
      doc.rect(tableX, tableY, tableW, headerH).fill('#F1F1F1').strokeColor(rule).lineWidth(0.6).stroke();
      for (const x of cols.slice(1, -1)) doc.moveTo(x, tableY).lineTo(x, tableY + headerH + rowH * rows.length).stroke();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(ink)
        .text('Item & Description', cols[0] + 6, tableY + 9, { width: cols[1] - cols[0] - 12 })
        .text('Qty', cols[1], tableY + 9, { width: cols[2] - cols[1], align: 'center' })
        .text('Rate (INR)', cols[2] + 3, tableY + 9, { width: cols[3] - cols[2] - 6, align: 'right' })
        .text('Discount', cols[3] + 3, tableY + 9, { width: cols[4] - cols[3] - 6, align: 'right' })
        .text('Amount', cols[4] + 3, tableY + 9, { width: cols[5] - cols[4] - 9, align: 'right' });

      rows.forEach((row, index) => {
        const y = tableY + headerH + index * rowH;
        doc.rect(tableX, y, tableW, rowH).strokeColor(rule).lineWidth(0.45).stroke();
        doc.font('Helvetica').fontSize(8.5).fillColor(ink)
          .text(row[0], cols[0] + 6, y + 9, { width: cols[1] - cols[0] - 12, ellipsis: true })
          .text(row[1], cols[1], y + 9, { width: cols[2] - cols[1], align: 'center' })
          .text(row[2], cols[2] + 3, y + 9, { width: cols[3] - cols[2] - 6, align: 'right' })
          .text(row[4], cols[4] + 3, y + 9, { width: cols[5] - cols[4] - 9, align: 'right' });
        const [discountAmount, discountLabel] = row[3].split('\n');
        if (discountAmount) {
          doc.font('Helvetica').fontSize(8).fillColor(ink)
            .text(discountAmount, cols[3] + 3, y + 6, { width: cols[4] - cols[3] - 6, align: 'right' });
        }
        if (discountLabel) {
          doc.font('Helvetica').fontSize(6.5).fillColor(muted)
            .text(discountLabel, cols[3] + 3, y + 23, { width: cols[4] - cols[3] - 6, align: 'right', ellipsis: true });
        }
      });

      const totalY = tableY + headerH + rowH * rows.length + 20;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(ink)
        .text('Consultation total (INR)', 320, totalY, { width: 135, align: 'right' })
        .text(inr(serviceTotal), 460, totalY, { width: 90, align: 'right' });
      const testOnly = Boolean(data.isGatewayTest);
      const paymentDue = testOnly ? linkAmount : serviceTotal;
      const noteY = totalY + 48;
      doc.rect(left + 6, noteY, tableW - 12, 104)
        .fill(testOnly ? '#FFF7E8' : '#F7F7F7').strokeColor('#B8B8B8').lineWidth(0.5).stroke();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ink)
        .text(testOnly ? `Amount due on this link: ${inr(paymentDue)}` : `Amount due: ${inr(paymentDue)}`, left + 15, noteY + 10, { width: 330 });
      doc.font('Helvetica').fontSize(7.5).fillColor(ink).text(
        testOnly
          ? `LIVE GATEWAY TEST ONLY. This INR ${linkAmount.toFixed(2)} charge does not pay toward the consultation, confirm the appointment, or reduce the consultation total. Consultation amount remains due: ${inr(serviceTotal)}.`
          : 'Payment is pending. This document is not a payment receipt. Your appointment is finalized only after payment verification.',
        left + 15, noteY + 26, { width: 350, height: testOnly ? 28 : 16 }
      );
      doc.image(qrBuffer, 438, noteY + 7, { fit: [82, 82], align: 'center', valign: 'center' });
      doc.font('Helvetica').fontSize(7).fillColor(muted)
        .text('Scan to open this Razorpay payment link', 420, noteY + 90, { width: 120, align: 'center' });

      const signPath = path.join(__dirname, 'assets', 'shashank-signature.png');
      const signY = 700;
      doc.moveTo(left, signY).lineTo(right, signY).lineWidth(0.5).strokeColor(rule).stroke();
      if (fs.existsSync(signPath)) doc.image(signPath, right - 155, signY + 9, { fit: [125, 44] });
      doc.font('Helvetica-Bold').fontSize(8).fillColor(ink)
        .text('Authorized Signatory', right - 155, signY + 57, { width: 125, align: 'center' });
      doc.font('Helvetica').fontSize(8).fillColor(ink)
        .text('Shashank Agrawal', right - 155, signY + 70, { width: 125, align: 'center' });
      doc.font('Helvetica').fontSize(7.5).fillColor(muted)
        .text('Payment request generated electronically. Please retain this document for your records.', left, 792, { width: tableW, align: 'center' });
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

module.exports = { generateInvoice, generatePaymentRequestInvoice };
