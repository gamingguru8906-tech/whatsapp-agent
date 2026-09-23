const PDFDocument = require('pdfkit');

/**
 * Generates an invoice PDF buffer in memory.
 * 
 * @param {Object} data 
 * @param {string} data.invoiceNumber
 * @param {string} data.customerName
 * @param {string} data.email
 * @param {string} data.phone
 * @param {string} data.serviceName
 * @param {number} data.amountPaid
 * @param {string} data.date
 * @returns {Promise<Buffer>}
 */
function generateInvoice(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        resolve(Buffer.concat(buffers));
      });

      // Colors matching the 'Continental' style
      const primaryColor = '#1e1e1e';
      const secondaryColor = '#4a4a4a';
      const accentColor = '#5e50a5'; // Zoho purple-ish accent
      const tableHeaderBg = '#2c303f'; // Dark header bg

      // Header: VESHANNASTRO
      doc.fontSize(10).fillColor(secondaryColor).text('VESHANNASTRO', 50, 50, { characterSpacing: 2 });
      doc.fontSize(20).fillColor(primaryColor).text('Consultation Invoice', 50, 65).moveDown();

      // INVOICE text & Logo text
      doc.fontSize(28).fillColor(primaryColor).text('INVOICE', 50, 110);
      doc.fontSize(12).fillColor(secondaryColor).text(`#${data.invoiceNumber}`, 50, 140);
      
      // "Logo" representation in top right
      doc.fillColor(primaryColor).fontSize(16).font('Helvetica-Bold').text('VESHANNASTRO', 380, 115, { align: 'right' }).font('Helvetica');

      // Balance Due (Paid)
      doc.fontSize(10).fillColor(primaryColor).text('Balance Due', 50, 180);
      doc.fontSize(16).fillColor(primaryColor).text('INR 0.00', 50, 195);
      
      // Invoice Details
      doc.fontSize(11).fillColor(primaryColor);
      doc.text('Invoice Date', 50, 240);
      doc.text(':', 150, 240);
      doc.fillColor(primaryColor).text(data.date, 170, 240);

      doc.fillColor(primaryColor);
      doc.text('Due Date', 50, 260);
      doc.text(':', 150, 260);
      doc.fillColor(primaryColor).text(data.date, 170, 260);

      // Customer Details (Right aligned under Logo)
      doc.fontSize(10).fillColor(secondaryColor).text('Billed To', 400, 240);
      doc.fontSize(12).fillColor(primaryColor).text(data.customerName, 400, 255);
      
      let customerY = 270;
      if (data.phone) {
        doc.fontSize(10).fillColor(secondaryColor).text(data.phone, 400, customerY);
        customerY += 15;
      }
      if (data.email) {
        doc.fontSize(10).fillColor(secondaryColor).text(data.email, 400, customerY);
      }

      // Table Header Background
      doc.roundedRect(50, 310, 495, 30, 5).fill(tableHeaderBg);

      // Table Header Text
      const tableY = 320;
      doc.fontSize(10).fillColor('white');
      doc.text('Item & Description', 70, tableY);
      doc.text('Qty', 280, tableY, { width: 50, align: 'right' });
      doc.text('Rate', 360, tableY, { width: 80, align: 'right' });
      doc.text('Amount', 450, tableY, { width: 80, align: 'right' });

      // Line Item
      const itemY = 360;
      doc.fontSize(11).fillColor(primaryColor);
      doc.text(data.serviceName, 70, itemY);
      doc.fontSize(9).fillColor(secondaryColor).text('Consultation Fee', 70, itemY + 15);
      
      doc.fontSize(11).fillColor(primaryColor);
      doc.text('1', 280, itemY, { width: 50, align: 'right' });
      doc.text(data.amountPaid.toFixed(2), 360, itemY, { width: 80, align: 'right' });
      doc.text(data.amountPaid.toFixed(2), 450, itemY, { width: 80, align: 'right' });

      // Divider Line
      doc.moveTo(50, 420).lineTo(545, 420).lineWidth(0.5).strokeColor('#e5e5e5').stroke();

      // Totals
      doc.fontSize(10).fillColor(secondaryColor).text('Sub Total', 360, 440, { width: 80, align: 'right' });
      doc.fontSize(11).fillColor(primaryColor).text(data.amountPaid.toFixed(2), 450, 440, { width: 80, align: 'right' });

      doc.fontSize(10).fillColor(secondaryColor).text('Total', 360, 465, { width: 80, align: 'right' });
      doc.fontSize(12).fillColor(primaryColor).text(data.amountPaid.toFixed(2), 450, 465, { width: 80, align: 'right' });

      // Balance
      doc.roundedRect(360, 490, 185, 30, 5).fill('#f9f9fb');
      doc.fontSize(10).fillColor(secondaryColor).text('Balance', 380, 500, { width: 50, align: 'left' });
      doc.fontSize(12).fillColor(primaryColor).text('0.00', 450, 498, { width: 80, align: 'right' });
      
      // Footer
      doc.fontSize(10).fillColor(secondaryColor).fillOpacity(1);
      doc.text('Thank you for choosing Veshannastro.', 50, 700, { align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { generateInvoice };
