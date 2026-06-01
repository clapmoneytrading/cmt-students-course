require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-this";
const PAYMENT_UPI_ID = process.env.PAYMENT_UPI_ID || "";
const PAYMENT_PHONE = process.env.PAYMENT_PHONE || "";
const PAYMENT_NAME = process.env.PAYMENT_NAME || "Clap Money Trading";
const PAYMENT_QR_IMAGE = process.env.PAYMENT_QR_IMAGE || "/qr-payment.png";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MAX_ACTIVE_SESSIONS = Math.max(1, Number(process.env.MAX_ACTIVE_SESSIONS || 1));
const COURSE_PRICE = Math.max(0, Number(process.env.COURSE_PRICE || 0));
const SUPPORT_WHATSAPP = process.env.SUPPORT_WHATSAPP || "919999999999";
const OTP_EXPIRY_MINUTES = Math.max(5, Number(process.env.OTP_EXPIRY_MINUTES || 30));
const WHATSAPP_GROUP_FREE_URL = process.env.WHATSAPP_GROUP_FREE_URL || "";
const WHATSAPP_GROUP_PAID_URL = process.env.WHATSAPP_GROUP_PAID_URL || "";

const FREE_TOPICS = [
  {
    slug: "price-action-basics",
    title: "Price Action Basics",
    metaDescription: "Learn candlestick reading, support/resistance, and simple setups for beginners.",
    intro: "Build a strong trading foundation using practical price action concepts.",
    bullets: ["Candlestick structure", "Support and resistance zones", "Entry and exit examples"]
  },
  {
    slug: "risk-management-foundations",
    title: "Risk Management Foundations",
    metaDescription: "Understand position sizing, stop loss discipline, and capital protection rules.",
    intro: "Protecting capital is the first job of every trader.",
    bullets: ["1-2% risk model", "Stop-loss planning", "Risk-to-reward setup"]
  },
  {
    slug: "intraday-setup-checklist",
    title: "Intraday Setup Checklist",
    metaDescription: "Use a simple intraday checklist to avoid emotional decisions and improve consistency.",
    intro: "Trade with structure using a repeatable pre-trade checklist.",
    bullets: ["Market bias check", "Volume confirmation", "Post-trade journal routine"]
  }
];

const rootDir = __dirname;
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(rootDir, "database.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const uploadDir = path.join(rootDir, "uploads", "videos");
const paymentProofDir = path.join(rootDir, "uploads", "payments");

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(paymentProofDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      has_paid_access INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      access_type TEXT CHECK(access_type IN ('free', 'paid')) NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS modules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      access_type TEXT CHECK(access_type IN ('free', 'paid')) NOT NULL DEFAULT 'free',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS video_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      progress_seconds REAL NOT NULL DEFAULT 0,
      duration_seconds REAL NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (video_id) REFERENCES videos(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_progress_user_video
      ON video_progress (user_id, video_id);

    CREATE TABLE IF NOT EXISTS payment_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      transaction_ref TEXT DEFAULT '',
      screenshot_filename TEXT DEFAULT '',
      promo_code TEXT DEFAULT '',
      discount_amount REAL NOT NULL DEFAULT 0,
      expected_amount REAL NOT NULL DEFAULT 0,
      status TEXT CHECK(status IN ('pending', 'approved', 'rejected')) NOT NULL DEFAULT 'pending',
      admin_note TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS email_verification_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS active_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_token TEXT UNIQUE NOT NULL,
      user_agent TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS promo_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT CHECK(discount_type IN ('percent', 'fixed')) NOT NULL,
      discount_value REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      usage_limit INTEGER,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (video_id) REFERENCES videos(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_favorites_unique
      ON user_favorites (user_id, video_id);

    CREATE TABLE IF NOT EXISTS certificate_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS email_otp_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      otp_code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_data TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_activity_logs_user_created
      ON user_activity_logs (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS lead_captures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT DEFAULT '',
      interest_topic TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      access_type TEXT CHECK(access_type IN ('free', 'paid')) NOT NULL DEFAULT 'free',
      created_by INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS help_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      admin_reply TEXT DEFAULT '',
      status TEXT CHECK(status IN ('open', 'replied')) NOT NULL DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      replied_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  const videoColumns = db.prepare("PRAGMA table_info(videos)").all();
  const hasModuleId = videoColumns.some((c) => c.name === "module_id");
  const hasLessonOrder = videoColumns.some((c) => c.name === "lesson_order");
  const hasTopic = videoColumns.some((c) => c.name === "topic");
  const hasLevel = videoColumns.some((c) => c.name === "level");
  const hasSourceType = videoColumns.some((c) => c.name === "source_type");
  const hasYoutubeUrl = videoColumns.some((c) => c.name === "youtube_url");
  const hasExternalUrl = videoColumns.some((c) => c.name === "external_url");

  if (!hasModuleId) {
    db.exec("ALTER TABLE videos ADD COLUMN module_id INTEGER");
  }

  if (!hasLessonOrder) {
    db.exec("ALTER TABLE videos ADD COLUMN lesson_order INTEGER NOT NULL DEFAULT 0");
  }

  if (!hasTopic) {
    db.exec("ALTER TABLE videos ADD COLUMN topic TEXT DEFAULT ''");
  }

  if (!hasLevel) {
    db.exec("ALTER TABLE videos ADD COLUMN level TEXT CHECK(level IN ('beginner', 'intermediate', 'advanced')) NOT NULL DEFAULT 'beginner'");
  }

  if (!hasSourceType) {
    db.exec("ALTER TABLE videos ADD COLUMN source_type TEXT CHECK(source_type IN ('upload', 'youtube')) NOT NULL DEFAULT 'upload'");
  }

  if (!hasYoutubeUrl) {
    db.exec("ALTER TABLE videos ADD COLUMN youtube_url TEXT DEFAULT ''");
  }

  if (!hasExternalUrl) {
    db.exec("ALTER TABLE videos ADD COLUMN external_url TEXT DEFAULT ''");
  }

  db.exec("UPDATE videos SET youtube_url = '' WHERE youtube_url IS NULL");
  db.exec("UPDATE videos SET external_url = '' WHERE external_url IS NULL");

  const moduleColumns = db.prepare("PRAGMA table_info(modules)").all();
  const hasModuleLevel = moduleColumns.some((c) => c.name === "level");
  if (!hasModuleLevel) {
    db.exec("ALTER TABLE modules ADD COLUMN level TEXT CHECK(level IN ('beginner', 'intermediate', 'advanced')) NOT NULL DEFAULT 'beginner'");
  }

  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  const hasEmailVerified = userColumns.some((c) => c.name === "email_verified");
  const hasSessionVersion = userColumns.some((c) => c.name === "session_version");
  const hasPhone = userColumns.some((c) => c.name === "phone");

  if (!hasPhone) {
    db.exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''");
  }

  if (!hasEmailVerified) {
    db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1");
  }

  if (!hasSessionVersion) {
    db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
  }

  const paymentColumns = db.prepare("PRAGMA table_info(payment_requests)").all();
  const hasPromoCode = paymentColumns.some((c) => c.name === "promo_code");
  const hasDiscountAmount = paymentColumns.some((c) => c.name === "discount_amount");
  const hasExpectedAmount = paymentColumns.some((c) => c.name === "expected_amount");

  if (!hasPromoCode) {
    db.exec("ALTER TABLE payment_requests ADD COLUMN promo_code TEXT DEFAULT ''");
  }

  if (!hasDiscountAmount) {
    db.exec("ALTER TABLE payment_requests ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0");
  }

  if (!hasExpectedAmount) {
    db.exec("ALTER TABLE payment_requests ADD COLUMN expected_amount REAL NOT NULL DEFAULT 0");
  }
}

function ensureAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.log("Admin credentials not set in .env. Skipping admin seed.");
    return;
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(adminEmail.toLowerCase());

  if (existing) {
    return;
  }

  const hash = bcrypt.hashSync(adminPassword, 10);

  db.prepare(
    "INSERT INTO users (name, email, password_hash, is_admin, has_paid_access, email_verified) VALUES (?, ?, ?, 1, 1, 1)"
  ).run("Admin", adminEmail.toLowerCase(), hash);

  console.log(`Seeded admin user: ${adminEmail}`);
}

initDatabase();
ensureAdmin();

app.set("view engine", "ejs");
app.set("views", path.join(rootDir, "views"));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(rootDir, "public")));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax"
    }
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `video-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["video/mp4", "video/webm", "video/ogg", "video/quicktime"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only video files are allowed (mp4/webm/ogg/mov)."));
    }
    cb(null, true);
  }
});

const paymentProofStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, paymentProofDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `payment-${uniqueSuffix}${ext}`);
  }
});

const uploadPaymentProof = multer({
  storage: paymentProofStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Upload payment screenshot as JPG, PNG, WEBP, or HEIC."));
    }
    cb(null, true);
  }
});

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }

  if (!req.session.sessionToken) {
    req.session.destroy(() => {});
    return res.redirect("/login");
  }

  const active = db
    .prepare("SELECT id FROM active_sessions WHERE user_id = ? AND session_token = ? AND revoked_at IS NULL")
    .get(req.session.user.id, req.session.sessionToken);

  if (!active) {
    req.session.destroy(() => {});
    return res.redirect("/login");
  }

  db.prepare("UPDATE active_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?").run(active.id);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).send("Forbidden");
  }
  next();
}

function refreshSessionUser(req, userId) {
  const user = db
    .prepare("SELECT id, name, email, is_admin, has_paid_access, email_verified FROM users WHERE id = ?")
    .get(userId);

  if (!user) {
    req.session.destroy(() => {});
    return;
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    is_admin: !!user.is_admin,
    has_paid_access: !!user.has_paid_access,
    email_verified: !!user.email_verified
  };
}

function isAjaxRequest(req) {
  return req.get("X-Requested-With") === "XMLHttpRequest";
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function makeOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function makeExpiry(hours) {
  const ms = Math.max(0, Number(hours || 0)) * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function getYouTubeEmbedUrl(urlRaw) {
  const value = (urlRaw || "").trim();
  if (!value) {
    return null;
  }

  try {
    const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(normalized);
    const host = url.hostname.toLowerCase();
    let videoId = "";

    if (host.includes("youtu.be")) {
      videoId = (url.pathname.split("/").filter(Boolean)[0] || "").trim();
    } else if (host.includes("youtube.com") || host.includes("youtube-nocookie.com")) {
      videoId = (url.searchParams.get("v") || "").trim();

      if (!videoId) {
        const parts = url.pathname.split("/").filter(Boolean);
        const marker = parts.findIndex((p) => ["embed", "shorts", "live"].includes(p));
        if (marker >= 0 && parts[marker + 1]) {
          videoId = parts[marker + 1].trim();
        }
      }
    }

    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return null;
    }

    return `https://www.youtube-nocookie.com/embed/${videoId}?rel=0`;
  } catch (e) {
    return null;
  }
}

function getExternalVideoUrl(urlRaw) {
  const value = (urlRaw || "").trim();
  if (!value) {
    return null;
  }

  try {
    const normalized = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString();
  } catch (e) {
    return null;
  }
}

function getMailTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = String(process.env.SMTP_SECURE || (port === 465 ? "true" : "false")).toLowerCase() === "true";
  const requireTLS = String(process.env.SMTP_REQUIRE_TLS || (port === 587 ? "true" : "false")).toLowerCase() === "true";
  const forceIPv4 = String(process.env.SMTP_FORCE_IPV4 || "true").toLowerCase() === "true";

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    requireTLS,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 20000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 12000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 25000),
    family: forceIPv4 ? 4 : 0,
    tls: {
      minVersion: "TLSv1.2"
    },
    auth: { user, pass }
  });
}

async function sendEmail(to, subject, text, html) {
  const transporter = getMailTransport();
  if (!transporter) {
    console.log("SMTP not configured. Skipping email send.");
    console.log(subject);
    console.log(text);
    return;
  }

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  await transporter.sendMail({ from, to, subject, text, html });
}

async function sendVerificationEmail(email, token) {
  const verifyUrl = `${BASE_URL}/verify-email?token=${encodeURIComponent(token)}`;
  const subject = "Verify your Clap Money Trading account";
  const text = `Please verify your email by opening this link: ${verifyUrl}`;
  const html = `<p>Please verify your email by clicking this link:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`;
  await sendEmail(email, subject, text, html);
}

async function sendOtpEmail(email, otpCode) {
  const subject = "Your Clap Money Trading verification code";
  const text = `Use this OTP to verify your account: ${otpCode}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`;
  const html = `<p>Use this OTP to verify your account:</p><h2>${otpCode}</h2><p>It expires in ${OTP_EXPIRY_MINUTES} minutes.</p>`;
  await sendEmail(email, subject, text, html);
}

async function sendResetEmail(email, token) {
  const resetUrl = `${BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const subject = "Reset your Clap Money Trading password";
  const text = `Reset your password using this link: ${resetUrl}`;
  const html = `<p>Reset your password using this link:</p><p><a href="${resetUrl}">${resetUrl}</a></p>`;
  await sendEmail(email, subject, text, html);
}

async function sendWelcomeEmail(name, email) {
  const loginUrl = `${BASE_URL}/login`;
  const forgotUrl = `${BASE_URL}/forgot-password`;
  const subject = "Congratulations! Your Clap Money Trading account is verified";
  const text = [
    `Hi ${name},`,
    "",
    "Congratulations! Your account is verified and ready to use.",
    "",
    "Login details:",
    `Username: ${email}`,
    "Password: The password you created during registration.",
    "",
    `Login here: ${loginUrl}`,
    `Forgot password: ${forgotUrl}`,
    "",
    "Welcome to Clap Money Trading!"
  ].join("\n");
  const html = `
    <p>Hi ${name},</p>
    <p>Congratulations! Your account is verified and ready to use.</p>
    <p><strong>Login details:</strong><br />
    Username: ${email}<br />
    Password: The password you created during registration.</p>
    <p><a href="${loginUrl}">Login Now</a></p>
    <p>If you forgot your password, use <a href="${forgotUrl}">Forgot Password</a>.</p>
    <p>Welcome to Clap Money Trading!</p>
  `;
  await sendEmail(email, subject, text, html);
}

async function sendGroupInviteEmail(name, email, includePaidGroup) {
  const loginUrl = `${BASE_URL}/login`;
  const lines = [`Hi ${name},`, "", "Your WhatsApp learning groups:"];

  if (WHATSAPP_GROUP_FREE_URL) {
    lines.push(`Free Group: ${WHATSAPP_GROUP_FREE_URL}`);
  }

  if (includePaidGroup && WHATSAPP_GROUP_PAID_URL) {
    lines.push(`Paid Group: ${WHATSAPP_GROUP_PAID_URL}`);
  }

  lines.push("", `Login: ${loginUrl}`);

  const subject = includePaidGroup
    ? "Paid access unlocked: Join your WhatsApp groups"
    : "Join your Free WhatsApp group";

  const htmlFree = WHATSAPP_GROUP_FREE_URL
    ? `<p><a href="${WHATSAPP_GROUP_FREE_URL}">Join Free WhatsApp Group</a></p>`
    : "";
  const htmlPaid = includePaidGroup && WHATSAPP_GROUP_PAID_URL
    ? `<p><a href="${WHATSAPP_GROUP_PAID_URL}">Join Paid WhatsApp Group</a></p>`
    : "";

  const html = `
    <p>Hi ${name},</p>
    <p>Your WhatsApp learning groups are ready:</p>
    ${htmlFree}
    ${htmlPaid}
    <p><a href="${loginUrl}">Open Student Login</a></p>
  `;

  await sendEmail(email, subject, lines.join("\n"), html);
}

function logUserActivity(userId, eventType, eventData = "") {
  db.prepare("INSERT INTO user_activity_logs (user_id, event_type, event_data) VALUES (?, ?, ?)").run(
    userId,
    eventType,
    eventData
  );
}

function csvEscape(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function getStudentProgressRows(filters = {}) {
  const planFilter = filters.planFilter === "paid" || filters.planFilter === "free" ? filters.planFilter : "all";
  const moduleFilter = Number.isInteger(filters.moduleFilter) ? filters.moduleFilter : null;

  let studentSql =
    "SELECT id, name, email, has_paid_access, created_at, (SELECT MAX(created_at) FROM user_activity_logs l WHERE l.user_id = users.id AND l.event_type = 'login') AS last_login FROM users WHERE is_admin = 0";
  const studentParams = [];

  if (planFilter === "paid") {
    studentSql += " AND has_paid_access = 1";
  } else if (planFilter === "free") {
    studentSql += " AND has_paid_access = 0";
  }

  studentSql += " ORDER BY created_at DESC";

  const students = db.prepare(studentSql).all(...studentParams);

  return students.map((student) => {
    const moduleCondition = moduleFilter === null
      ? ""
      : moduleFilter === 0
        ? " AND v.module_id IS NULL"
        : " AND v.module_id = ?";

    const countParams = moduleFilter === null
      ? [student.has_paid_access ? 1 : 0, student.has_paid_access ? 1 : 0]
      : moduleFilter === 0
        ? [student.has_paid_access ? 1 : 0, student.has_paid_access ? 1 : 0]
        : [student.has_paid_access ? 1 : 0, student.has_paid_access ? 1 : 0, moduleFilter];

    const completedParams = moduleFilter === null
      ? [student.id, student.has_paid_access ? 1 : 0, student.has_paid_access ? 1 : 0]
      : moduleFilter === 0
        ? [student.id, student.has_paid_access ? 1 : 0, student.has_paid_access ? 1 : 0]
        : [student.id, student.has_paid_access ? 1 : 0, student.has_paid_access ? 1 : 0, moduleFilter];

    const totalLessons = db
      .prepare(
        `SELECT COUNT(*) as count FROM videos v LEFT JOIN modules m ON m.id = v.module_id WHERE ((v.access_type = 'free' OR ? = 1) AND (m.id IS NULL OR m.access_type = 'free' OR ? = 1))${moduleCondition}`
      )
      .get(...countParams).count;

    const completedLessons = db
      .prepare(
        `SELECT COUNT(*) as count FROM video_progress vp JOIN videos v ON v.id = vp.video_id LEFT JOIN modules m ON m.id = v.module_id WHERE vp.user_id = ? AND vp.completed = 1 AND ((v.access_type = 'free' OR ? = 1) AND (m.id IS NULL OR m.access_type = 'free' OR ? = 1))${moduleCondition}`
      )
      .get(...completedParams).count;

    const completionPercent = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

    return {
      ...student,
      total_lessons: totalLessons,
      completed_lessons: completedLessons,
      completion_percent: completionPercent
    };
  });
}

function getModules() {
  return db
    .prepare("SELECT id, title, description, access_type, level, sort_order, created_at FROM modules ORDER BY sort_order ASC, created_at ASC")
    .all();
}

function buildCourseModules(user) {
  const modules = getModules();
  const videos = db
    .prepare(
      "SELECT v.id, v.title, v.description, v.access_type, v.topic, v.level, v.source_type, v.youtube_url, v.external_url, v.module_id, v.lesson_order, v.created_at, m.access_type AS module_access_type, m.level AS module_level FROM videos v LEFT JOIN modules m ON m.id = v.module_id ORDER BY COALESCE(m.sort_order, 9999) ASC, m.created_at ASC, v.lesson_order ASC, v.created_at ASC"
    )
    .all();

  const moduleBuckets = modules.map((module) => ({
    id: module.id,
    title: module.title,
    description: module.description,
    access_type: module.access_type,
    level: module.level,
    locked: module.access_type === "paid" && !user.has_paid_access && !user.is_admin,
    lessons: []
  }));

  const bucketById = new Map(moduleBuckets.map((bucket) => [bucket.id, bucket]));

  const generalBucket = {
    id: 0,
    title: "General Lessons",
    description: "Lessons not assigned to a module",
    access_type: "free",
    level: "beginner",
    locked: false,
    lessons: []
  };

  videos.forEach((video) => {
    const moduleLocked = video.module_access_type === "paid" && !user.has_paid_access && !user.is_admin;
    if (moduleLocked) {
      return;
    }

    const canWatchVideo = user.is_admin || user.has_paid_access || video.access_type === "free";
    if (!canWatchVideo) {
      return;
    }

    if (!video.module_id) {
      generalBucket.lessons.push(video);
      return;
    }

    const bucket = bucketById.get(video.module_id);
    if (bucket) {
      bucket.lessons.push(video);
    }
  });

  const visibleModules = moduleBuckets.filter((m) => m.locked || m.lessons.length > 0);
  if (generalBucket.lessons.length > 0) {
    visibleModules.push(generalBucket);
  }

  return visibleModules;
}

function getCompletionSnapshot(user) {
  const modules = buildCourseModules(user);
  const allVisibleLessons = modules
    .filter((m) => !m.locked)
    .flatMap((m) => m.lessons)
    .map((l) => l.id);

  if (!allVisibleLessons.length) {
    return {
      totalLessons: 0,
      completedLessons: 0,
      completionPercent: 0,
      completedModules: [],
      badges: []
    };
  }

  const placeholders = allVisibleLessons.map(() => "?").join(",");
  const completedRows = db
    .prepare(
      `SELECT video_id FROM video_progress WHERE user_id = ? AND completed = 1 AND video_id IN (${placeholders})`
    )
    .all(user.id, ...allVisibleLessons);

  const completedSet = new Set(completedRows.map((r) => r.video_id));
  const completedModules = modules
    .filter((m) => !m.locked && m.lessons.length > 0)
    .filter((m) => m.lessons.every((l) => completedSet.has(l.id)))
    .map((m) => ({ id: m.id, title: m.title, level: m.level }));

  const completionPercent = Math.round((completedSet.size / allVisibleLessons.length) * 100);
  const badges = completedModules.map((m) => `${m.level.toUpperCase()} - ${m.title}`);

  return {
    totalLessons: allVisibleLessons.length,
    completedLessons: completedSet.size,
    completionPercent,
    completedModules,
    badges
  };
}

function getValidPromo(codeRaw) {
  const code = (codeRaw || "").trim().toUpperCase();
  if (!code) {
    return null;
  }

  const promo = db
    .prepare(
      "SELECT id, code, discount_type, discount_value, is_active, usage_limit, used_count, expires_at FROM promo_codes WHERE code = ?"
    )
    .get(code);

  if (!promo || !promo.is_active) {
    return null;
  }

  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return null;
  }

  if (promo.usage_limit !== null && promo.used_count >= promo.usage_limit) {
    return null;
  }

  return promo;
}

function calculateDiscount(coursePrice, promo) {
  if (!promo || coursePrice <= 0) {
    return 0;
  }

  if (promo.discount_type === "percent") {
    return Math.min(coursePrice, (coursePrice * promo.discount_value) / 100);
  }

  return Math.min(coursePrice, promo.discount_value);
}

app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  res.render("landing", {
    error: null,
    success: null,
    freeTopics: FREE_TOPICS,
    supportWhatsapp: SUPPORT_WHATSAPP
  });
});

app.get(["/learn", "/learn/"], (req, res) => {
  return res.redirect("/login");
});

app.post("/lead-capture", (req, res) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const phone = (req.body.phone || "").trim();
  const interestTopic = (req.body.interest_topic || "").trim();

  if (!name || !email) {
    return res.status(400).render("landing", {
      error: "Name and email are required.",
      success: null,
      freeTopics: FREE_TOPICS,
      supportWhatsapp: SUPPORT_WHATSAPP
    });
  }

  db.prepare("INSERT INTO lead_captures (name, email, phone, interest_topic) VALUES (?, ?, ?, ?)").run(
    name,
    email,
    phone,
    interestTopic
  );

  return res.render("landing", {
    error: null,
    success: "Thanks! We received your details and will contact you.",
    freeTopics: FREE_TOPICS,
    supportWhatsapp: SUPPORT_WHATSAPP
  });
});

app.get("/topics/:slug", (req, res) => {
  const topic = FREE_TOPICS.find((t) => t.slug === req.params.slug);
  if (!topic) {
    return res.status(404).send("Topic page not found.");
  }

  res.render("topic", { topic, supportWhatsapp: SUPPORT_WHATSAPP });
});

app.get("/register", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  res.render("register", { error: null });
});

app.post("/register", async (req, res) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const countryCode = (req.body.country_code || "+91").trim();
  const phoneRaw = (req.body.phone || "").trim();
  const password = req.body.password || "";
  const allowedCountryCodes = new Set(["+91", "+1", "+44", "+61", "+65", "+971"]);

  if (!name || !email || !phoneRaw || !password) {
    return res.status(400).render("register", { error: "All fields are required." });
  }

  if (!allowedCountryCodes.has(countryCode)) {
    return res.status(400).render("register", { error: "Please select a valid country code." });
  }

  const phoneDigits = phoneRaw.replace(/\D/g, "");
  if (phoneDigits.length < 7 || phoneDigits.length > 15) {
    return res.status(400).render("register", { error: "Enter a valid phone number." });
  }

  const phone = `${countryCode}${phoneDigits}`;

  if (password.length < 6) {
    return res.status(400).render("register", { error: "Password must be at least 6 characters." });
  }

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) {
    return res.status(400).render("register", { error: "Email already registered." });
  }

  const hash = bcrypt.hashSync(password, 10);
  db
    .prepare(
      "INSERT INTO users (name, email, phone, password_hash, is_admin, has_paid_access, email_verified) VALUES (?, ?, ?, ?, 0, 0, 1)"
    )
    .run(name, email, phone, hash);

  return res.redirect("/login?message=register_success");
});

app.get("/verify-otp", (req, res) => {
  return res.redirect("/login?message=otp_disabled");
});

app.post("/verify-otp", async (req, res) => {
  return res.redirect("/login?message=otp_disabled");
});

app.post("/verify-otp/resend", async (req, res) => {
  return res.redirect("/login?message=otp_disabled");
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  res.render("login", { error: null, message: req.query.message || null });
});

app.post("/login", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    return res.status(400).render("login", { error: "Invalid email or password.", message: null });
  }

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    return res.status(400).render("login", { error: "Invalid email or password.", message: null });
  }

  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    is_admin: !!user.is_admin,
    has_paid_access: !!user.has_paid_access,
    email_verified: !!user.email_verified
  };

  const sessionToken = makeToken();
  req.session.sessionToken = sessionToken;

  db.prepare("INSERT INTO active_sessions (user_id, session_token, user_agent) VALUES (?, ?, ?)").run(
    user.id,
    sessionToken,
    (req.get("user-agent") || "").slice(0, 255)
  );

  const activeSessions = db
    .prepare("SELECT id FROM active_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .all(user.id);

  if (activeSessions.length > MAX_ACTIVE_SESSIONS) {
    const overflow = activeSessions.slice(MAX_ACTIVE_SESSIONS).map((row) => row.id);
    if (overflow.length) {
      const placeholders = overflow.map(() => "?").join(",");
      db.prepare(`UPDATE active_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...overflow);
    }
  }

  logUserActivity(user.id, "login", req.get("user-agent") || "");

  res.redirect("/dashboard");
});

app.get("/verify-email", async (req, res) => {
  const token = (req.query.token || "").trim();
  if (!token) {
    return res.redirect("/login?message=verify_invalid");
  }

  const row = db
    .prepare(
      "SELECT id, user_id, expires_at, used_at FROM email_verification_tokens WHERE token = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(token);

  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return res.redirect("/login?message=verify_invalid");
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET email_verified = 1 WHERE id = ?").run(row.user_id);
    db.prepare("UPDATE email_verification_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
  });
  tx();

  const verifiedUser = db.prepare("SELECT name, email FROM users WHERE id = ?").get(row.user_id);
  if (verifiedUser) {
    try {
      await sendWelcomeEmail(verifiedUser.name, verifiedUser.email);
      await sendGroupInviteEmail(verifiedUser.name, verifiedUser.email, false);
    } catch (e) {
      console.error("Failed to send welcome email", e);
    }
  }

  return res.redirect("/login?message=verify_success");
});

app.get("/forgot-password", (req, res) => {
  res.render("forgot-password", { error: null, message: null });
});

app.post("/forgot-password", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const user = db.prepare("SELECT id, email FROM users WHERE email = ?").get(email);

  if (user) {
    const token = makeToken();
    db.prepare("INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)").run(
      user.id,
      token,
      makeExpiry(1)
    );

    try {
      await sendResetEmail(user.email, token);
    } catch (e) {
      console.error("Failed to send reset email", e);
    }
  }

  return res.render("forgot-password", {
    error: null,
    message: "If this email exists, a reset link has been sent."
  });
});

app.get("/reset-password", (req, res) => {
  const token = (req.query.token || "").trim();
  const row = token
    ? db
        .prepare(
          "SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(token)
    : null;

  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return res.render("reset-password", { error: "Reset link is invalid or expired.", token: null });
  }

  return res.render("reset-password", { error: null, token });
});

app.post("/reset-password", (req, res) => {
  const token = (req.body.token || "").trim();
  const password = req.body.password || "";

  const row = token
    ? db
        .prepare(
          "SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(token)
    : null;

  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    return res.status(400).render("reset-password", { error: "Reset link is invalid or expired.", token: null });
  }

  if (password.length < 6) {
    return res.status(400).render("reset-password", { error: "Password must be at least 6 characters.", token });
  }

  const hash = bcrypt.hashSync(password, 10);
  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, row.user_id);
    db.prepare("UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?").run(row.id);
    db.prepare("UPDATE active_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").run(
      row.user_id
    );
  });
  tx();

  return res.redirect("/login?message=reset_success");
});

app.post("/logout", requireAuth, (req, res) => {
  if (req.session.user && req.session.sessionToken) {
    db.prepare("UPDATE active_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND session_token = ?").run(
      req.session.user.id,
      req.session.sessionToken
    );
  }

  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/dashboard", requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);

  const user = req.session.user;
  const modules = buildCourseModules(user);
  const progressRows = db
    .prepare(
      "SELECT video_id, progress_seconds, duration_seconds, completed, updated_at FROM video_progress WHERE user_id = ?"
    )
    .all(user.id);

  const visibleLessonIds = modules.flatMap((m) => m.lessons).map((l) => l.id);
  const favorites = visibleLessonIds.length
    ? db
        .prepare(
          `SELECT video_id FROM user_favorites WHERE user_id = ? AND video_id IN (${visibleLessonIds
            .map(() => "?")
            .join(",")})`
        )
        .all(user.id, ...visibleLessonIds)
    : [];
  const favoriteSet = new Set(favorites.map((row) => row.video_id));

  const progressByVideo = Object.fromEntries(
    progressRows.map((row) => [
      row.video_id,
      {
        progress_seconds: row.progress_seconds,
        duration_seconds: row.duration_seconds,
        completed: !!row.completed,
        updated_at: row.updated_at
      }
    ])
  );

  const progressByVideoId = new Map(progressRows.map((r) => [r.video_id, r]));
  const continueWatching = modules
    .flatMap((module) => module.lessons)
    .map((lesson) => {
      const p = progressByVideoId.get(lesson.id);
      if (!p || p.completed || p.progress_seconds <= 0) {
        return null;
      }
      return {
        ...lesson,
        progress_percent:
          p.duration_seconds > 0 ? Math.max(1, Math.min(99, Math.round((p.progress_seconds / p.duration_seconds) * 100))) : 0,
        updated_at: p.updated_at
      };
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 6);

  const topicOptions = Array.from(
    new Set(
      modules
        .flatMap((m) => m.lessons)
        .map((l) => (l.topic || "").trim())
        .filter(Boolean)
    )
  ).sort();

  const levelOptions = ["beginner", "intermediate", "advanced"];
  const snapshot = getCompletionSnapshot(user);

  let certTokenRow = db.prepare("SELECT token FROM certificate_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(user.id);
  if (snapshot.totalLessons > 0 && snapshot.completedLessons === snapshot.totalLessons && !certTokenRow) {
    const token = makeToken();
    db.prepare("INSERT INTO certificate_tokens (user_id, token) VALUES (?, ?)").run(user.id, token);
    certTokenRow = { token };
  }

  res.render("dashboard", {
    modules,
    progressByVideo,
    favoriteVideoIds: Array.from(favoriteSet),
    continueWatching,
    topicOptions,
    levelOptions,
    completion: snapshot,
    roadmap: ["beginner", "intermediate", "advanced"],
    certificateToken: certTokenRow ? certTokenRow.token : null,
    freeGroupUrl: WHATSAPP_GROUP_FREE_URL,
    paidGroupUrl: WHATSAPP_GROUP_PAID_URL
  });
});

app.get(["/posts", "/announcements"], requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);

  const posts = req.session.user.has_paid_access || req.session.user.is_admin
    ? db
        .prepare("SELECT id, title, content, access_type, created_at FROM posts ORDER BY created_at DESC")
        .all()
    : db
        .prepare("SELECT id, title, content, access_type, created_at FROM posts WHERE access_type = 'free' ORDER BY created_at DESC")
        .all();

  res.render("posts", { posts });
});

app.get("/help", requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);

  const helpRequests = db
    .prepare(
      "SELECT id, title, message, admin_reply, status, created_at, replied_at FROM help_requests WHERE user_id = ? ORDER BY created_at DESC"
    )
    .all(req.session.user.id);

  res.render("help", {
    helpRequests,
    helpError: null,
    helpSuccess: req.query.submitted === "1" ? "Your help request has been sent to admin." : null
  });
});

app.post("/help-requests", requireAuth, (req, res) => {
  const title = (req.body.title || "").trim();
  const message = (req.body.message || "").trim();

  refreshSessionUser(req, req.session.user.id);

  const helpRequests = db
    .prepare(
      "SELECT id, title, message, admin_reply, status, created_at, replied_at FROM help_requests WHERE user_id = ? ORDER BY created_at DESC"
    )
    .all(req.session.user.id);

  if (!title || !message) {
    return res.status(400).render("help", {
      helpRequests,
      helpError: "Help title and message are required.",
      helpSuccess: null
    });
  }

  db.prepare("INSERT INTO help_requests (user_id, title, message) VALUES (?, ?, ?)").run(
    req.session.user.id,
    title,
    message
  );

  return res.redirect("/help?submitted=1");
});

app.post("/api/favorites/:videoId", requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);

  const videoId = Number(req.params.videoId);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return res.status(400).json({ error: "Invalid video ID." });
  }

  const video = db
    .prepare("SELECT v.id, v.access_type, m.access_type AS module_access_type FROM videos v LEFT JOIN modules m ON m.id = v.module_id WHERE v.id = ?")
    .get(videoId);

  if (!video) {
    return res.status(404).json({ error: "Video not found." });
  }

  const moduleLocked = video.module_access_type === "paid" && !req.session.user.has_paid_access && !req.session.user.is_admin;
  const canWatch = req.session.user.is_admin || req.session.user.has_paid_access || video.access_type === "free";
  if (moduleLocked || !canWatch) {
    return res.status(403).json({ error: "No access." });
  }

  const existing = db
    .prepare("SELECT id FROM user_favorites WHERE user_id = ? AND video_id = ?")
    .get(req.session.user.id, videoId);

  if (existing) {
    db.prepare("DELETE FROM user_favorites WHERE id = ?").run(existing.id);
    return res.json({ ok: true, favorited: false });
  }

  db.prepare("INSERT INTO user_favorites (user_id, video_id) VALUES (?, ?)").run(req.session.user.id, videoId);
  return res.json({ ok: true, favorited: true });
});

app.get("/certificate/download", requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);
  const snapshot = getCompletionSnapshot(req.session.user);

  if (snapshot.totalLessons === 0 || snapshot.completedLessons !== snapshot.totalLessons) {
    return res.status(403).send("Complete all available lessons to unlock certificate.");
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="certificate-${req.session.user.name.replace(/\s+/g, "-").toLowerCase()}.pdf"`);

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  doc.pipe(res);

  doc.rect(30, 30, 535, 782).lineWidth(2).stroke("#0f766e");
  doc.fontSize(28).fillColor("#0f172a").text("Certificate of Completion", { align: "center" });
  doc.moveDown();
  doc.fontSize(14).fillColor("#334155").text("This certifies that", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(30).fillColor("#0b3f6d").text(req.session.user.name, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(14).fillColor("#334155").text("has successfully completed the Clap Money Trading course roadmap", {
    align: "center"
  });
  doc.moveDown();
  doc.fontSize(12).fillColor("#475569").text(`Completed Lessons: ${snapshot.completedLessons}/${snapshot.totalLessons}`, {
    align: "center"
  });
  doc.moveDown(2);
  doc.fontSize(12).fillColor("#64748b").text(`Issued on ${new Date().toLocaleDateString()}`, { align: "center" });
  doc.end();
});

app.get("/certificate/share", requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);
  const snapshot = getCompletionSnapshot(req.session.user);

  if (snapshot.totalLessons === 0 || snapshot.completedLessons !== snapshot.totalLessons) {
    return res.status(403).json({ error: "Certificate not unlocked yet." });
  }

  let row = db.prepare("SELECT token FROM certificate_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(
    req.session.user.id
  );
  if (!row) {
    const token = makeToken();
    db.prepare("INSERT INTO certificate_tokens (user_id, token) VALUES (?, ?)").run(req.session.user.id, token);
    row = { token };
  }

  return res.json({ url: `${BASE_URL}/certificate/view/${row.token}` });
});

app.get("/certificate/view/:token", (req, res) => {
  const token = (req.params.token || "").trim();
  const row = db
    .prepare(
      "SELECT u.name, u.email FROM certificate_tokens c JOIN users u ON u.id = c.user_id WHERE c.token = ? LIMIT 1"
    )
    .get(token);

  if (!row) {
    return res.status(404).send("Certificate link not found.");
  }

  return res.render("certificate-view", { student: row });
});

app.post("/api/progress/:videoId", requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);

  const videoId = Number(req.params.videoId);
  const progressSeconds = Math.max(0, Number(req.body.progress_seconds || 0));
  const durationSeconds = Math.max(0, Number(req.body.duration_seconds || 0));
  const completed = req.body.completed === "1" ? 1 : 0;

  if (!Number.isInteger(videoId) || videoId <= 0) {
    return res.status(400).json({ error: "Invalid video ID." });
  }

  const video = db
    .prepare("SELECT v.id, v.access_type, m.access_type AS module_access_type FROM videos v LEFT JOIN modules m ON m.id = v.module_id WHERE v.id = ?")
    .get(videoId);

  if (!video) {
    return res.status(404).json({ error: "Video not found." });
  }

  const moduleLocked = video.module_access_type === "paid" && !req.session.user.has_paid_access && !req.session.user.is_admin;
  const canWatch = req.session.user.is_admin || req.session.user.has_paid_access || video.access_type === "free";

  if (moduleLocked || !canWatch) {
    return res.status(403).json({ error: "No access." });
  }

  const prev = db
    .prepare("SELECT completed FROM video_progress WHERE user_id = ? AND video_id = ?")
    .get(req.session.user.id, videoId);

  db.prepare(
    "INSERT INTO video_progress (user_id, video_id, progress_seconds, duration_seconds, completed, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(user_id, video_id) DO UPDATE SET progress_seconds = excluded.progress_seconds, duration_seconds = excluded.duration_seconds, completed = CASE WHEN video_progress.completed = 1 OR excluded.completed = 1 THEN 1 ELSE 0 END, updated_at = CURRENT_TIMESTAMP"
  ).run(req.session.user.id, videoId, progressSeconds, durationSeconds, completed);

  if (!prev?.completed && completed === 1) {
    logUserActivity(req.session.user.id, "video_completed", String(videoId));
  }

  return res.json({ ok: true });
});

app.get("/pay", requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);

  const requests = db
    .prepare(
      "SELECT id, amount, transaction_ref, screenshot_filename, promo_code, discount_amount, expected_amount, status, admin_note, created_at FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC"
    )
    .all(req.session.user.id);

  res.render("pay", {
    error: null,
    success: null,
    requests,
    payment: {
      upiId: PAYMENT_UPI_ID,
      phone: PAYMENT_PHONE,
      name: PAYMENT_NAME,
      qrImage: PAYMENT_QR_IMAGE,
      coursePrice: COURSE_PRICE
    },
    promoMessage: null
  });
});

app.post("/pay", requireAuth, (req, res) => {
  uploadPaymentProof.single("proof")(req, res, (err) => {
    if (err) {
      const requests = db
        .prepare(
          "SELECT id, amount, transaction_ref, screenshot_filename, promo_code, discount_amount, expected_amount, status, admin_note, created_at FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC"
        )
        .all(req.session.user.id);
      return res.status(400).render("pay", {
        error: err.message,
        success: null,
        requests,
        payment: {
          upiId: PAYMENT_UPI_ID,
          phone: PAYMENT_PHONE,
          name: PAYMENT_NAME,
          qrImage: PAYMENT_QR_IMAGE,
          coursePrice: COURSE_PRICE
        },
        promoMessage: null
      });
    }

    const amount = Number(req.body.amount || 0);
    const transactionRef = (req.body.transaction_ref || "").trim();
    const promoCodeInput = (req.body.promo_code || "").trim().toUpperCase();
    const screenshotFilename = req.file ? req.file.filename : "";

    const promo = promoCodeInput ? getValidPromo(promoCodeInput) : null;
    const discountAmount = calculateDiscount(COURSE_PRICE, promo);
    const expectedAmount = Math.max(0, COURSE_PRICE - discountAmount);

    if (!Number.isFinite(amount) || amount <= 0) {
      const requests = db
        .prepare(
          "SELECT id, amount, transaction_ref, screenshot_filename, promo_code, discount_amount, expected_amount, status, admin_note, created_at FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC"
        )
        .all(req.session.user.id);
      return res.status(400).render("pay", {
        error: "Enter a valid payment amount.",
        success: null,
        requests,
        payment: {
          upiId: PAYMENT_UPI_ID,
          phone: PAYMENT_PHONE,
          name: PAYMENT_NAME,
          qrImage: PAYMENT_QR_IMAGE,
          coursePrice: COURSE_PRICE
        },
        promoMessage: null
      });
    }

    if (promoCodeInput && !promo) {
      const requests = db
        .prepare(
          "SELECT id, amount, transaction_ref, screenshot_filename, promo_code, discount_amount, expected_amount, status, admin_note, created_at FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC"
        )
        .all(req.session.user.id);
      return res.status(400).render("pay", {
        error: "Promo code is invalid or expired.",
        success: null,
        requests,
        payment: {
          upiId: PAYMENT_UPI_ID,
          phone: PAYMENT_PHONE,
          name: PAYMENT_NAME,
          qrImage: PAYMENT_QR_IMAGE,
          coursePrice: COURSE_PRICE
        },
        promoMessage: null
      });
    }

    if (!transactionRef && !screenshotFilename) {
      const requests = db
        .prepare(
          "SELECT id, amount, transaction_ref, screenshot_filename, promo_code, discount_amount, expected_amount, status, admin_note, created_at FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC"
        )
        .all(req.session.user.id);
      return res.status(400).render("pay", {
        error: "Add transaction reference or upload screenshot proof.",
        success: null,
        requests,
        payment: {
          upiId: PAYMENT_UPI_ID,
          phone: PAYMENT_PHONE,
          name: PAYMENT_NAME,
          qrImage: PAYMENT_QR_IMAGE,
          coursePrice: COURSE_PRICE
        },
        promoMessage: null
      });
    }

    db.prepare(
      "INSERT INTO payment_requests (user_id, amount, transaction_ref, screenshot_filename, promo_code, discount_amount, expected_amount, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')"
    ).run(
      req.session.user.id,
      amount,
      transactionRef,
      screenshotFilename,
      promo ? promo.code : "",
      discountAmount,
      expectedAmount
    );

    const requests = db
      .prepare(
        "SELECT id, amount, transaction_ref, screenshot_filename, promo_code, discount_amount, expected_amount, status, admin_note, created_at FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC"
      )
      .all(req.session.user.id);

    res.render("pay", {
      error: null,
      success: "Payment submitted. Admin will verify and unlock your paid course.",
      requests,
      payment: {
        upiId: PAYMENT_UPI_ID,
        phone: PAYMENT_PHONE,
        name: PAYMENT_NAME,
        qrImage: PAYMENT_QR_IMAGE,
        coursePrice: COURSE_PRICE
      },
      promoMessage: promo
        ? `Promo ${promo.code} applied. Discount: ${discountAmount.toFixed(2)}.`
        : null
    });
  });
});

app.get("/payment-proof/:id", requireAdmin, (req, res) => {
  const payment = db
    .prepare("SELECT screenshot_filename FROM payment_requests WHERE id = ?")
    .get(req.params.id);

  if (!payment || !payment.screenshot_filename) {
    return res.status(404).send("Payment proof not found");
  }

  const filePath = path.join(paymentProofDir, payment.screenshot_filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Proof file missing on server.");
  }

  res.sendFile(filePath);
});

app.get("/video/:id", requireAuth, (req, res) => {
  refreshSessionUser(req, req.session.user.id);

  const video = db
    .prepare("SELECT v.*, m.access_type AS module_access_type FROM videos v LEFT JOIN modules m ON m.id = v.module_id WHERE v.id = ?")
    .get(req.params.id);
  if (!video) {
    return res.status(404).send("Video not found");
  }

  const moduleLocked = video.module_access_type === "paid" && !req.session.user.has_paid_access && !req.session.user.is_admin;
  const canWatch = video.access_type === "free" || req.session.user.has_paid_access;
  if ((moduleLocked || !canWatch) && !req.session.user.is_admin) {
    return res.status(403).send("You do not have access to this video.");
  }

  if (video.source_type === "youtube") {
    return res.status(400).send("This lesson is hosted on YouTube and should be viewed from dashboard.");
  }

  const externalUrl = (video.external_url || "").trim();
  if (externalUrl) {
    return res.redirect(externalUrl);
  }

  const filePath = path.join(uploadDir, video.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video file missing on server.");
  }

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("X-Content-Type-Options", "nosniff");

  res.type(video.mime_type);
  res.sendFile(filePath);
});

app.get("/admin", requireAdmin, (req, res) => {
  const paymentStatus = ["pending", "approved", "rejected"].includes(req.query.payment_status)
    ? req.query.payment_status
    : "all";

  const users = db
    .prepare(
      "SELECT u.id, u.name, u.email, u.phone, u.is_admin, u.has_paid_access, u.created_at, (SELECT MAX(created_at) FROM user_activity_logs l WHERE l.user_id = u.id AND l.event_type = 'login') AS last_login, (SELECT COUNT(*) FROM video_progress vp WHERE vp.user_id = u.id AND vp.completed = 1) AS watched_count FROM users u ORDER BY u.created_at DESC"
    )
    .all();

  const summary = {
    total_students: users.filter((u) => !u.is_admin).length,
    paid_students: users.filter((u) => !u.is_admin && u.has_paid_access).length,
    free_students: users.filter((u) => !u.is_admin && !u.has_paid_access).length,
    pending_payments: 0,
    approved_payments: 0,
    rejected_payments: 0,
    open_help_requests: 0
  };

  const videos = db
    .prepare("SELECT v.id, v.title, v.description, v.topic, v.level, v.source_type, v.youtube_url, v.external_url, v.access_type, v.lesson_order, v.created_at, m.title AS module_title, m.sort_order AS module_sort_order FROM videos v LEFT JOIN modules m ON m.id = v.module_id ORDER BY COALESCE(m.sort_order, 9999) ASC, v.lesson_order ASC, v.created_at ASC")
    .all();

  const modules = getModules();

  const payments = db
    .prepare(
      `SELECT p.id, p.amount, p.transaction_ref, p.screenshot_filename, p.promo_code, p.discount_amount, p.expected_amount, p.status, p.admin_note, p.created_at, u.id as user_id, u.name as user_name, u.email as user_email FROM payment_requests p JOIN users u ON p.user_id = u.id ${
        paymentStatus === "all" ? "" : "WHERE p.status = ?"
      } ORDER BY p.created_at DESC`
    )
    .all(...(paymentStatus === "all" ? [] : [paymentStatus]));

  summary.pending_payments = db
    .prepare("SELECT COUNT(*) as count FROM payment_requests WHERE status = 'pending'")
    .get().count;
  summary.approved_payments = db
    .prepare("SELECT COUNT(*) as count FROM payment_requests WHERE status = 'approved'")
    .get().count;
  summary.rejected_payments = db
    .prepare("SELECT COUNT(*) as count FROM payment_requests WHERE status = 'rejected'")
    .get().count;
  summary.open_help_requests = db
    .prepare("SELECT COUNT(*) as count FROM help_requests WHERE status = 'open'")
    .get().count;

  const postSummary = {
    total_posts: db.prepare("SELECT COUNT(*) as count FROM posts").get().count,
    paid_posts: db.prepare("SELECT COUNT(*) as count FROM posts WHERE access_type = 'paid'").get().count,
    free_posts: db.prepare("SELECT COUNT(*) as count FROM posts WHERE access_type = 'free'").get().count
  };

  const recentActivity = db
    .prepare(
      "SELECT l.created_at, l.event_type, l.event_data, u.name as user_name, u.email as user_email FROM user_activity_logs l JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC LIMIT 40"
    )
    .all();

  const leads = db
    .prepare("SELECT id, name, email, phone, interest_topic, created_at FROM lead_captures ORDER BY created_at DESC LIMIT 50")
    .all();

  const promoCodes = db
    .prepare(
      "SELECT id, code, discount_type, discount_value, is_active, usage_limit, used_count, expires_at, created_at FROM promo_codes ORDER BY created_at DESC"
    )
    .all();

  res.render("admin", {
    users,
    videos,
    payments,
    modules,
    promoCodes,
    paymentStatus,
    recentActivity,
    leads,
    summary,
    postSummary
  });
});

app.get("/admin/reports", requireAdmin, (req, res) => {
  const planFilter = ["all", "free", "paid"].includes(req.query.plan)
    ? req.query.plan
    : "all";
  const moduleFilterRaw = req.query.module;
  const moduleFilter = moduleFilterRaw === undefined || moduleFilterRaw === ""
    ? null
    : Number(moduleFilterRaw);
  const hasValidModuleFilter = moduleFilter === null || Number.isInteger(moduleFilter);

  const studentProgress = getStudentProgressRows({
    planFilter,
    moduleFilter: hasValidModuleFilter ? moduleFilter : null
  });
  const modules = getModules();

  const overview = {
    total_students: studentProgress.length,
    paid_students: studentProgress.filter((s) => s.has_paid_access).length,
    free_students: studentProgress.filter((s) => !s.has_paid_access).length,
    avg_completion:
      studentProgress.length > 0
        ? Math.round(
            studentProgress.reduce((sum, row) => sum + row.completion_percent, 0) / studentProgress.length
          )
        : 0
  };

  res.render("admin-reports", {
    overview,
    studentProgress,
    filters: {
      plan: planFilter,
      module: hasValidModuleFilter ? moduleFilter : null
    },
    modules
  });
});

app.get("/admin/posts", requireAdmin, (req, res) => {
  const posts = db
    .prepare(
      "SELECT p.id, p.title, p.content, p.access_type, p.created_at, u.name as author_name FROM posts p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.created_at DESC"
    )
    .all();

  res.render("admin-posts", { posts, error: null });
});

app.post("/admin/posts", requireAdmin, (req, res) => {
  const title = (req.body.title || "").trim();
  const content = (req.body.content || "").trim();
  const accessType = req.body.access_type === "paid" ? "paid" : "free";

  if (!title || !content) {
    const posts = db
      .prepare(
        "SELECT p.id, p.title, p.content, p.access_type, p.created_at, u.name as author_name FROM posts p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.created_at DESC"
      )
      .all();
    return res.status(400).render("admin-posts", {
      posts,
      error: "Title and content are required."
    });
  }

  db.prepare("INSERT INTO posts (title, content, access_type, created_by) VALUES (?, ?, ?, ?)").run(
    title,
    content,
    accessType,
    req.session.user.id
  );

  res.redirect("/admin/posts");
});

app.post("/admin/posts/:id/delete", requireAdmin, (req, res) => {
  const postId = Number(req.params.id);
  db.prepare("DELETE FROM posts WHERE id = ?").run(postId);
  res.redirect("/admin/posts");
});

app.get("/admin/help", requireAdmin, (req, res) => {
  const requests = db
    .prepare(
      "SELECT h.id, h.title, h.message, h.admin_reply, h.status, h.created_at, h.replied_at, u.name AS student_name, u.email AS student_email FROM help_requests h JOIN users u ON u.id = h.user_id ORDER BY CASE WHEN h.status = 'open' THEN 0 ELSE 1 END, h.created_at DESC"
    )
    .all();

  res.render("admin-help", { requests, error: null });
});

app.post("/admin/help/:id/reply", requireAdmin, (req, res) => {
  const requestId = Number(req.params.id);
  const reply = (req.body.admin_reply || "").trim();

  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).send("Invalid request ID");
  }

  if (!reply) {
    const requests = db
      .prepare(
        "SELECT h.id, h.title, h.message, h.admin_reply, h.status, h.created_at, h.replied_at, u.name AS student_name, u.email AS student_email FROM help_requests h JOIN users u ON u.id = h.user_id ORDER BY CASE WHEN h.status = 'open' THEN 0 ELSE 1 END, h.created_at DESC"
      )
      .all();
    return res.status(400).render("admin-help", { requests, error: "Reply message is required." });
  }

  const existing = db.prepare("SELECT id FROM help_requests WHERE id = ?").get(requestId);
  if (!existing) {
    return res.status(404).send("Help request not found");
  }

  db.prepare("UPDATE help_requests SET admin_reply = ?, status = 'replied', replied_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    reply,
    requestId
  );

  return res.redirect("/admin/help");
});

app.post("/admin/users/bulk-access", requireAdmin, (req, res) => {
  const userIdsRaw = req.body.user_ids;
  const action = req.body.action === "revoke" ? "revoke" : "grant";

  const ids = Array.isArray(userIdsRaw)
    ? userIdsRaw.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
    : userIdsRaw
      ? [Number(userIdsRaw)].filter((n) => Number.isInteger(n) && n > 0)
      : [];

  if (!ids.length) {
    return res.redirect("/admin");
  }

  let paidInviteTargets = [];
  if (action === "grant") {
    const placeholders = ids.map(() => "?").join(",");
    paidInviteTargets = db
      .prepare(`SELECT id, name, email FROM users WHERE is_admin = 0 AND has_paid_access = 0 AND id IN (${placeholders})`)
      .all(...ids);
  }

  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE users SET has_paid_access = ? WHERE is_admin = 0 AND id IN (${placeholders})`).run(
    action === "grant" ? 1 : 0,
    ...ids
  );

  if (action === "grant" && paidInviteTargets.length) {
    Promise.all(
      paidInviteTargets.map((u) => sendGroupInviteEmail(u.name, u.email, true))
    ).catch((e) => {
      console.error("Failed to send paid group invites", e);
    });
  }

  res.redirect("/admin");
});

app.get("/admin/export/students.csv", requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      "SELECT u.id, u.name, u.email, u.phone, u.has_paid_access, u.created_at, (SELECT MAX(created_at) FROM user_activity_logs l WHERE l.user_id = u.id AND l.event_type = 'login') AS last_login, (SELECT COUNT(*) FROM video_progress vp WHERE vp.user_id = u.id AND vp.completed = 1) AS watched_count FROM users u ORDER BY u.created_at DESC"
    )
    .all();

  const header = ["id", "name", "email", "phone", "has_paid_access", "created_at", "last_login", "watched_count"].join(",");
  const body = rows
    .map((r) =>
      [r.id, r.name, r.email, r.phone || "", r.has_paid_access, r.created_at, r.last_login || "", r.watched_count].map(csvEscape).join(",")
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=students-export.csv");
  res.send(`${header}\n${body}`);
});

app.get("/admin/export/payments.csv", requireAdmin, (req, res) => {
  const paymentStatus = ["pending", "approved", "rejected"].includes(req.query.payment_status)
    ? req.query.payment_status
    : "all";
  const rows = db
    .prepare(
      `SELECT p.id, u.name as student_name, u.email as student_email, p.amount, p.promo_code, p.discount_amount, p.expected_amount, p.transaction_ref, p.status, p.created_at, p.reviewed_at FROM payment_requests p JOIN users u ON u.id = p.user_id ${
        paymentStatus === "all" ? "" : "WHERE p.status = ?"
      } ORDER BY p.created_at DESC`
    )
    .all(...(paymentStatus === "all" ? [] : [paymentStatus]));

  const header = [
    "id",
    "student_name",
    "student_email",
    "amount",
    "promo_code",
    "discount_amount",
    "expected_amount",
    "transaction_ref",
    "status",
    "created_at",
    "reviewed_at"
  ].join(",");
  const body = rows
    .map((r) =>
      [
        r.id,
        r.student_name,
        r.student_email,
        r.amount,
        r.promo_code || "",
        r.discount_amount,
        r.expected_amount,
        r.transaction_ref,
        r.status,
        r.created_at,
        r.reviewed_at || ""
      ]
        .map(csvEscape)
        .join(",")
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=payments-export.csv");
  res.send(`${header}\n${body}`);
});

app.post("/admin/modules", requireAdmin, (req, res) => {
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim();
  const accessType = req.body.access_type === "paid" ? "paid" : "free";
  const level = ["beginner", "intermediate", "advanced"].includes(req.body.level)
    ? req.body.level
    : "beginner";
  const sortOrder = Number.isFinite(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0;

  if (!title) {
    return res.status(400).send("Module title is required.");
  }

  db.prepare("INSERT INTO modules (title, description, access_type, level, sort_order) VALUES (?, ?, ?, ?, ?)").run(
    title,
    description,
    accessType,
    level,
    sortOrder
  );

  res.redirect("/admin");
});

app.get("/admin/modules/:id/edit", requireAdmin, (req, res) => {
  const moduleId = Number(req.params.id);
  const module = db
    .prepare("SELECT id, title, description, access_type, level, sort_order FROM modules WHERE id = ?")
    .get(moduleId);

  if (!module) {
    return res.status(404).send("Module not found");
  }

  res.render("edit-module", { error: null, module });
});

app.post("/admin/modules/:id/edit", requireAdmin, (req, res) => {
  const moduleId = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim();
  const accessType = req.body.access_type === "paid" ? "paid" : "free";
  const level = ["beginner", "intermediate", "advanced"].includes(req.body.level)
    ? req.body.level
    : "beginner";
  const sortOrder = Number.isFinite(Number(req.body.sort_order)) ? Number(req.body.sort_order) : 0;

  const existing = db
    .prepare("SELECT id, title, description, access_type, level, sort_order FROM modules WHERE id = ?")
    .get(moduleId);

  if (!existing) {
    return res.status(404).send("Module not found");
  }

  if (!title) {
    return res.status(400).render("edit-module", {
      error: "Module title is required.",
      module: {
        id: moduleId,
        title,
        description,
        access_type: accessType,
        level,
        sort_order: sortOrder
      }
    });
  }

  db.prepare("UPDATE modules SET title = ?, description = ?, access_type = ?, level = ?, sort_order = ? WHERE id = ?").run(
    title,
    description,
    accessType,
    level,
    sortOrder,
    moduleId
  );

  res.redirect("/admin");
});

app.post("/admin/modules/:id/delete", requireAdmin, (req, res) => {
  const moduleId = Number(req.params.id);
  const module = db.prepare("SELECT id FROM modules WHERE id = ?").get(moduleId);

  if (!module) {
    return res.status(404).send("Module not found");
  }

  const lessonCount = db.prepare("SELECT COUNT(*) as count FROM videos WHERE module_id = ?").get(moduleId).count;
  if (lessonCount > 0) {
    return res.status(400).send("Module has lessons. Reassign or delete those videos first.");
  }

  db.prepare("DELETE FROM modules WHERE id = ?").run(moduleId);
  res.redirect("/admin");
});

app.post("/admin/payments/:id/approve", requireAdmin, (req, res) => {
  const paymentId = Number(req.params.id);
  const adminNote = (req.body.admin_note || "").trim();

  const payment = db
    .prepare("SELECT id, user_id, status FROM payment_requests WHERE id = ?")
    .get(paymentId);

  const student = payment
    ? db.prepare("SELECT id, name, email, has_paid_access FROM users WHERE id = ?").get(payment.user_id)
    : null;

  if (!payment) {
    return res.status(404).send("Payment request not found");
  }

  if (payment.status !== "pending") {
    return res.redirect("/admin");
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET has_paid_access = 1 WHERE id = ?").run(payment.user_id);
    db.prepare(
      "UPDATE payment_requests SET status = 'approved', admin_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(adminNote, paymentId);

    const promo = db
      .prepare("SELECT promo_code FROM payment_requests WHERE id = ?")
      .get(paymentId);

    if (promo && promo.promo_code) {
      db.prepare("UPDATE promo_codes SET used_count = used_count + 1 WHERE code = ?").run(promo.promo_code);
    }
  });

  tx();

  if (student && !student.has_paid_access) {
    sendGroupInviteEmail(student.name, student.email, true).catch((e) => {
      console.error("Failed to send paid group invite", e);
    });
  }
  res.redirect("/admin");
});

app.post("/admin/promos", requireAdmin, (req, res) => {
  const code = (req.body.code || "").trim().toUpperCase();
  const discountType = req.body.discount_type === "fixed" ? "fixed" : "percent";
  const discountValue = Number(req.body.discount_value || 0);
  const usageLimitRaw = (req.body.usage_limit || "").trim();
  const expiresAtRaw = (req.body.expires_at || "").trim();

  if (!code || !/^[A-Z0-9_-]{3,20}$/.test(code)) {
    return res.status(400).send("Promo code must be 3-20 chars (A-Z, 0-9, _, -).");
  }

  if (!Number.isFinite(discountValue) || discountValue <= 0) {
    return res.status(400).send("Discount value must be greater than 0.");
  }

  if (discountType === "percent" && discountValue > 100) {
    return res.status(400).send("Percent discount cannot be above 100.");
  }

  const usageLimit = usageLimitRaw ? Number(usageLimitRaw) : null;
  if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit <= 0)) {
    return res.status(400).send("Usage limit must be a positive integer.");
  }

  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).toISOString() : null;
  if (expiresAtRaw && Number.isNaN(new Date(expiresAtRaw).getTime())) {
    return res.status(400).send("Invalid expiry date.");
  }

  try {
    db.prepare(
      "INSERT INTO promo_codes (code, discount_type, discount_value, usage_limit, expires_at, is_active) VALUES (?, ?, ?, ?, ?, 1)"
    ).run(code, discountType, discountValue, usageLimit, expiresAt);
  } catch (e) {
    return res.status(400).send("Promo code already exists.");
  }

  res.redirect("/admin");
});

app.post("/admin/promos/:id/toggle", requireAdmin, (req, res) => {
  const promoId = Number(req.params.id);
  const promo = db.prepare("SELECT id, is_active FROM promo_codes WHERE id = ?").get(promoId);

  if (!promo) {
    return res.status(404).send("Promo code not found.");
  }

  db.prepare("UPDATE promo_codes SET is_active = ? WHERE id = ?").run(promo.is_active ? 0 : 1, promoId);
  res.redirect("/admin");
});

app.post("/admin/payments/:id/reject", requireAdmin, (req, res) => {
  const paymentId = Number(req.params.id);
  const adminNote = (req.body.admin_note || "").trim();

  const payment = db.prepare("SELECT id FROM payment_requests WHERE id = ?").get(paymentId);
  if (!payment) {
    return res.status(404).send("Payment request not found");
  }

  db.prepare(
    "UPDATE payment_requests SET status = 'rejected', admin_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(adminNote, paymentId);

  res.redirect("/admin");
});

app.post("/admin/users/:id/access", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);

  if (userId === req.session.user.id) {
    return res.status(400).send("You cannot change your own paid access here.");
  }

  const user = db.prepare("SELECT id, name, email, has_paid_access, is_admin FROM users WHERE id = ?").get(userId);
  if (!user || user.is_admin) {
    return res.redirect("/admin");
  }

  const hasPaidAccess = req.body.has_paid_access === "on" ? 1 : 0;
  db.prepare("UPDATE users SET has_paid_access = ? WHERE id = ? AND is_admin = 0").run(hasPaidAccess, userId);

  if (hasPaidAccess && !user.has_paid_access) {
    sendGroupInviteEmail(user.name, user.email, true).catch((e) => {
      console.error("Failed to send paid group invite", e);
    });
  }

  res.redirect("/admin");
});

app.post("/admin/users/:id/delete", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  if (userId === req.session.user.id) {
    return res.status(400).send("You cannot delete your own account.");
  }

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM active_sessions WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM email_otp_codes WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM video_progress WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM user_favorites WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM certificate_tokens WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM user_activity_logs WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM help_requests WHERE user_id = ?").run(userId);
    db.prepare("UPDATE posts SET created_by = NULL WHERE created_by = ?").run(userId);
    db.prepare("DELETE FROM payment_requests WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM users WHERE id = ? AND is_admin = 0").run(userId);
  });

  tx();
  res.redirect("/admin");
});

app.get("/admin/videos/upload", requireAdmin, (req, res) => {
  res.render("upload-video", { error: null, modules: getModules() });
});

app.post("/admin/videos/upload", requireAdmin, (req, res) => {
  upload.single("video")(req, res, (err) => {
    if (err) {
      if (isAjaxRequest(req)) {
        return res.status(400).json({ error: err.message });
      }
      return res.status(400).render("upload-video", { error: err.message, modules: getModules() });
    }

    const title = (req.body.title || "").trim();
    const description = (req.body.description || "").trim();
    const topic = (req.body.topic || "").trim();
    const level = ["beginner", "intermediate", "advanced"].includes(req.body.level)
      ? req.body.level
      : "beginner";
    const accessType = req.body.access_type === "paid" ? "paid" : "free";
    const sourceMode = ["upload", "youtube", "external"].includes(req.body.source_type) ? req.body.source_type : "upload";
    const sourceType = sourceMode === "youtube" ? "youtube" : "upload";
    const youtubeEmbedUrl = sourceMode === "youtube" ? getYouTubeEmbedUrl(req.body.youtube_url) : "";
    const externalUrl = sourceMode === "external" ? getExternalVideoUrl(req.body.external_url) : "";
    const moduleId = Number(req.body.module_id || 0) > 0 ? Number(req.body.module_id) : null;
    const lessonOrder = Number.isFinite(Number(req.body.lesson_order)) ? Number(req.body.lesson_order) : 0;

    if (moduleId) {
      const module = db.prepare("SELECT id FROM modules WHERE id = ?").get(moduleId);
      if (!module) {
        if (isAjaxRequest(req)) {
          return res.status(400).json({ error: "Selected module does not exist." });
        }
        return res.status(400).render("upload-video", { error: "Selected module does not exist.", modules: getModules() });
      }
    }

    if (!title) {
      if (isAjaxRequest(req)) {
        return res.status(400).json({ error: "Video title is required." });
      }
      return res.status(400).render("upload-video", { error: "Video title is required.", modules: getModules() });
    }

    if (sourceMode === "upload" && !req.file) {
      if (isAjaxRequest(req)) {
        return res.status(400).json({ error: "Please choose a video file for upload source." });
      }
      return res.status(400).render("upload-video", { error: "Please choose a video file for upload source.", modules: getModules() });
    }

    if (sourceMode === "youtube" && !youtubeEmbedUrl) {
      if (isAjaxRequest(req)) {
        return res.status(400).json({ error: "Enter a valid YouTube video URL." });
      }
      return res.status(400).render("upload-video", { error: "Enter a valid YouTube video URL.", modules: getModules() });
    }

    if (sourceMode === "external" && !externalUrl) {
      if (isAjaxRequest(req)) {
        return res.status(400).json({ error: "Enter a valid external video URL (http/https)." });
      }
      return res.status(400).render("upload-video", { error: "Enter a valid external video URL (http/https).", modules: getModules() });
    }

    db.prepare(
      "INSERT INTO videos (title, description, topic, level, source_type, youtube_url, external_url, filename, mime_type, access_type, module_id, lesson_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      title,
      description,
      topic,
      level,
      sourceType,
      sourceMode === "youtube" ? youtubeEmbedUrl : "",
      sourceMode === "external" ? externalUrl : "",
      sourceMode === "upload" ? req.file.filename : "",
      sourceMode === "upload" ? req.file.mimetype : "",
      accessType,
      moduleId,
      lessonOrder
    );

    if (isAjaxRequest(req)) {
      return res.json({ ok: true, redirect: "/admin" });
    }

    res.redirect("/admin");
  });
});

app.get("/admin/videos/:id/edit", requireAdmin, (req, res) => {
  const video = db
    .prepare("SELECT id, title, description, topic, level, source_type, youtube_url, external_url, access_type, module_id, lesson_order FROM videos WHERE id = ?")
    .get(req.params.id);

  if (!video) {
    return res.status(404).send("Video not found");
  }

  video.source_mode = video.source_type === "youtube"
    ? "youtube"
    : ((video.external_url || "").trim() ? "external" : "upload");

  res.render("edit-video", { error: null, video, modules: getModules() });
});

app.post("/admin/videos/:id/edit", requireAdmin, (req, res) => {
  const videoId = Number(req.params.id);
  const title = (req.body.title || "").trim();
  const description = (req.body.description || "").trim();
  const topic = (req.body.topic || "").trim();
  const level = ["beginner", "intermediate", "advanced"].includes(req.body.level)
    ? req.body.level
    : "beginner";
  const sourceMode = ["upload", "youtube", "external"].includes(req.body.source_type) ? req.body.source_type : "upload";
  const sourceType = sourceMode === "youtube" ? "youtube" : "upload";
  const youtubeEmbedUrl = sourceMode === "youtube" ? getYouTubeEmbedUrl(req.body.youtube_url) : "";
  const externalUrl = sourceMode === "external" ? getExternalVideoUrl(req.body.external_url) : "";
  const accessType = req.body.access_type === "paid" ? "paid" : "free";
  const moduleId = Number(req.body.module_id || 0) > 0 ? Number(req.body.module_id) : null;
  const lessonOrder = Number.isFinite(Number(req.body.lesson_order)) ? Number(req.body.lesson_order) : 0;

  const existing = db
    .prepare("SELECT id, title, description, topic, level, source_type, youtube_url, external_url, filename, access_type, module_id, lesson_order FROM videos WHERE id = ?")
    .get(videoId);

  if (!existing) {
    return res.status(404).send("Video not found");
  }

  if (moduleId) {
    const module = db.prepare("SELECT id FROM modules WHERE id = ?").get(moduleId);
    if (!module) {
      return res.status(400).render("edit-video", {
        error: "Selected module does not exist.",
        video: {
          id: videoId,
          title,
          description,
          topic,
          level,
          source_type: sourceType,
          source_mode: sourceMode,
          youtube_url: req.body.youtube_url || "",
          external_url: req.body.external_url || "",
          access_type: accessType,
          module_id: moduleId,
          lesson_order: lessonOrder
        },
        modules: getModules()
      });
    }
  }

  if (!title) {
    return res.status(400).render("edit-video", {
      error: "Video title is required.",
      video: {
        id: videoId,
        title,
        description,
        topic,
        level,
        source_type: sourceType,
        source_mode: sourceMode,
        youtube_url: req.body.youtube_url || "",
        external_url: req.body.external_url || "",
        access_type: accessType,
        module_id: moduleId,
        lesson_order: lessonOrder
      },
      modules: getModules()
    });
  }

  if (sourceMode === "youtube" && !youtubeEmbedUrl) {
    return res.status(400).render("edit-video", {
      error: "Enter a valid YouTube video URL.",
      video: {
        id: videoId,
        title,
        description,
        topic,
        level,
        source_type: sourceType,
        source_mode: sourceMode,
        youtube_url: req.body.youtube_url || "",
        external_url: req.body.external_url || "",
        access_type: accessType,
        module_id: moduleId,
        lesson_order: lessonOrder
      },
      modules: getModules()
    });
  }

  if (sourceMode === "external" && !externalUrl) {
    return res.status(400).render("edit-video", {
      error: "Enter a valid external video URL (http/https).",
      video: {
        id: videoId,
        title,
        description,
        topic,
        level,
        source_type: sourceType,
        source_mode: sourceMode,
        youtube_url: req.body.youtube_url || "",
        external_url: req.body.external_url || "",
        access_type: accessType,
        module_id: moduleId,
        lesson_order: lessonOrder
      },
      modules: getModules()
    });
  }

  const existingMode = existing.source_type === "youtube"
    ? "youtube"
    : ((existing.external_url || "").trim() ? "external" : "upload");

  if (sourceMode === "upload" && existingMode !== "upload") {
    return res.status(400).render("edit-video", {
      error: "Linked lessons cannot be switched to upload here. Create a new uploaded lesson instead.",
      video: {
        id: videoId,
        title,
        description,
        topic,
        level,
        source_type: sourceType,
        source_mode: sourceMode,
        youtube_url: existing.youtube_url || "",
        external_url: existing.external_url || "",
        access_type: accessType,
        module_id: moduleId,
        lesson_order: lessonOrder
      },
      modules: getModules()
    });
  }

  db.prepare("UPDATE videos SET title = ?, description = ?, topic = ?, level = ?, source_type = ?, youtube_url = ?, external_url = ?, access_type = ?, module_id = ?, lesson_order = ? WHERE id = ?").run(
    title,
    description,
    topic,
    level,
    sourceType,
    sourceMode === "youtube" ? youtubeEmbedUrl : "",
    sourceMode === "external" ? externalUrl : "",
    accessType,
    moduleId,
    lessonOrder,
    videoId
  );

  if (existingMode === "upload" && sourceMode !== "upload" && existing.filename) {
    const filePath = path.join(uploadDir, existing.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  res.redirect("/admin");
});

app.post("/admin/videos/:id/delete", requireAdmin, (req, res) => {
  const videoId = Number(req.params.id);
  const video = db.prepare("SELECT id, filename FROM videos WHERE id = ?").get(videoId);

  if (!video) {
    return res.status(404).send("Video not found");
  }

  db.prepare("DELETE FROM videos WHERE id = ?").run(videoId);

  const filePath = path.join(uploadDir, video.filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  res.redirect("/admin");
});

app.use((req, res) => {
  res.status(404).send("Page not found");
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
