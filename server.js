import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import fetch from "node-fetch";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());
app.use(express.static("public"));

// === توليد PDF من نص العميل ===
function generatePDF(title, body, filename) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const filePath = path.join(__dirname, "digital-products", filename);
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(25).text(title, { align: "center" });
    doc.moveDown();
    doc.fontSize(16).text(body);

    doc.end();
    stream.on("finish", () => resolve(filePath));
    stream.on("error", reject);
  });
}

// === endpoint لإضافة النص وإنشاء PDF ===
app.post("/add-text", async (req, res) => {
  const { title, body, orderId, customerEmail } = req.body;
  if (!title || !body) return res.status(400).send("Title and body are required");

  const filename = `${Date.now()}-slide.pdf`;
  try {
    // توليد PDF
    const filePath = await generatePDF(title, body, filename);

    // رابط التحميل على Render
    const fileUrl = `https://sa1ma-1-shopify-slides-generator.onrender.com/digital-products/${filename}`;

    // إرسال الرابط تلقائيًا للعميل عبر Shopify Admin API
    if (orderId && customerEmail) {
      await fetch(`https://${process.env.SHOPIFY_STORE_URL}/admin/api/2026-01/orders/${orderId}/fulfillments.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN
        },
        body: JSON.stringify({
          fulfillment: {
            line_items: [{ id: orderId }],
            tracking_urls: [fileUrl],
            notify_customer: true
          }
        })
      });
    }

    res.send(`تم إنشاء الملف! يمكن للعميل التحميل من: ${fileUrl}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("حدث خطأ أثناء إنشاء الملف PDF");
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
