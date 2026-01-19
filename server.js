import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { google } from "googleapis";
import nodemailer from "nodemailer";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

/* ===== إصلاح __dirname في ES Modules ===== */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ===== Middlewares ===== */
app.use(bodyParser.json());
app.use("/digital-products", express.static(path.join(__dirname, "digital-products")));

/* ===== قاعدة بيانات مؤقتة (RAM) ===== */
const orders = {}; 
// { orderId: { email, filename, status } }

/* ===== إعداد Google API ===== */
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDS),
  scopes: [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive"
  ]
});

const slides = google.slides({ version: "v1", auth });
const drive = google.drive({ version: "v3", auth });

/* ===== توليد PDF من Google Slides ===== */
async function generatePDFfromSlides(orderId, customerName) {
  // 1️⃣ نسخ قالب Slides
  const copy = await drive.files.copy({
    fileId: process.env.TEMPLATE_ID,
    requestBody: { name: `Order-${orderId}` }
  });

  const presentationId = copy.data.id;

  // 2️⃣ استبدال Placeholders
  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [
        {
          replaceAllText: {
            containsText: { text: "{{NAME}}", matchCase: true },
            replaceText: customerName
          }
        },
        {
          replaceAllText: {
            containsText: { text: "{{ORDER_ID}}", matchCase: true },
            replaceText: orderId.toString()
          }
        }
      ]
    }
  });

  // 3️⃣ تصدير PDF
  const destFolder = path.join(__dirname, "digital-products");
  if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder);

  const filename = `${Date.now()}-order-${orderId}.pdf`;
  const filePath = path.join(destFolder, filename);
  const dest = fs.createWriteStream(filePath);

  const response = await drive.files.export(
    { fileId: presentationId, mimeType: "application/pdf" },
    { responseType: "stream" }
  );

  await new Promise((resolve, reject) => {
    response.data
      .on("end", resolve)
      .on("error", reject)
      .pipe(dest);
  });

  console.log(`✅ PDF generated: ${filename}`);
  return filename;
}

/* ===== Webhook Shopify (Order Paid) ===== */
app.post("/webhook/order-paid", async (req, res) => {
  const order = req.body;

  const orderId = order.id;
  const customerName = order.customer?.first_name || "Customer";
  const customerEmail = order.customer?.email;

  if (!customerEmail) {
    return res.status(400).send("No customer email");
  }

  try {
    const filename = await generatePDFfromSlides(orderId, customerName);

    orders[orderId] = {
      email: customerEmail,
      filename,
      status: "ready"
    };

    /* ===== (اختياري) إرسال إيميل بدون رابط ===== */
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: customerEmail,
      subject: "منتجك الرقمي جاهز",
      html: `
        <p>مرحبًا ${customerName} 👋</p>
        <p>تم تجهيز منتجك الرقمي بنجاح.</p>
        <p>يمكنك تحميله مباشرة من صفحة تأكيد الطلب.</p>
      `
    });

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Error generating PDF:", error);
    res.sendStatus(500);
  }
});

/* ===== API لصفحة Thank You في Shopify ===== */
app.get("/api/download-status", (req, res) => {
  const { order_id } = req.query;
  const order = orders[order_id];

  if (!order || order.status !== "ready") {
    return res.json({ ready: false });
  }

  res.json({
    ready: true,
    url: `${process.env.SERVER_URL}/digital-products/${order.filename}`
  });
});

/* ===== تشغيل السيرفر ===== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
