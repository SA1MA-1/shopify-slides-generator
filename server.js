import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { google } from "googleapis";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());
app.use("/digital-products", express.static(path.join(__dirname, "digital-products")));

// ===== قاعدة بيانات مؤقتة =====
const orders = {}; // { orderId: { email, filename, status } }

// ===== إعداد Google API =====
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDS),
  scopes: [
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/drive"
  ]
});

const slides = google.slides({ version: "v1", auth });
const drive = google.drive({ version: "v3", auth });

// ===== نسخ قالب Slides وتوليد PDF =====
async function generatePDFfromSlides(orderId, customerName) {
  // 1️⃣ نسخ قالب Google Slides
  const copy = await drive.files.copy({
    fileId: process.env.TEMPLATE_ID,
    requestBody: { name: `Order-${orderId}` }
  });
  const presentationId = copy.data.id;

  // 2️⃣ استبدال placeholders
  await slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [
        { replaceAllText: { containsText: { text: "{{NAME}}", matchCase: true }, replaceText: customerName } },
        { replaceAllText: { containsText: { text: "{{ORDER_ID}}", matchCase: true }, replaceText: orderId.toString() } }
      ]
    }
  });

  // 3️⃣ تصدير PDF من Slides عبر Drive export
  const destFolder = path.join(__dirname, "digital-products");
  if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder);

  const filename = `${Date.now()}-order-${orderId}.pdf`;
  const filePath = path.join(destFolder, filename);

  const dest = fs.createWriteStream(filePath);

  await drive.files.export(
    { fileId: presentationId, mimeType: "application/pdf" },
    { responseType: "stream" },
    (err, res) => {
      if (err) throw err;
      res.data
        .on("end", () => console.log(`PDF generated: ${filename}`))
        .on("error", err => console.error(err))
        .pipe(dest);
    }
  );

  // ننتظر حتى يكتمل الإنشاء
  await new Promise(resolve => dest.on("finish", resolve));

  return filename;
}

// ===== Webhook Shopify =====
app.post("/webhook/order-paid", async (req, res) => {
  const order = req.body;
  const orderId = order.id;
  const customerName = order.customer.first_name;
  const customerEmail = order.customer.email;

  try {
    const filename = await generatePDFfromSlides(orderId, customerName);

    // حفظ البيانات
    orders[orderId] = { email: customerEmail, filename, status: "ready" };

    // رابط صفحة التحميل الخارجية
    const downloadLink = `${process.env.SERVER_URL}/download?order_id=${orderId}&email=${encodeURIComponent(customerEmail)}`;

    // إرسال إيميل للعميل
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: customerEmail,
      subject: "منتجك الرقمي جاهز للتحميل",
      html: `
        <p>مرحبًا ${customerName},</p>
        <p>شكرًا لطلبك! يمكنك تحميل منتجك الرقمي من الرابط أدناه:</p>
        <a href="${downloadLink}" target="_blank" style="padding:10px 15px;background:#000;color:#fff;text-decoration:none;">📥 تحميل المنتج</a>
      `
    });

    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ===== صفحة تحميل خارجية =====
app.get("/download", (req, res) => {
  const { order_id, email } = req.query;
  const order = orders[order_id];

  if (!order || order.email !== email || order.status !== "ready") {
    return res.status(404).send("الملف غير موجود أو غير جاهز بعد.");
  }

  const fileUrl = `/digital-products/${order.filename}`;
  res.send(`
    <h2>تحميل المنتج</h2>
    <p>اضغط على الرابط أدناه لتحميل المنتج:</p>
    <a href="${fileUrl}" download style="padding:10px 15px;background:#000;color:#fff;text-decoration:none;">📥 تحميل المنتج</a>
  `);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
