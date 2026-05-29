const Database = require("better-sqlite3");

const db = new Database("database.sqlite");
db.pragma("foreign_keys = ON");

const email = `otp-fix-${Date.now()}@example.com`;
const user = db
  .prepare(
    "INSERT INTO users (name, email, password_hash, is_admin, has_paid_access, email_verified) VALUES (?, ?, ?, 0, 0, 0)"
  )
  .run("OTP Fix User", email, "x");

const userId = user.lastInsertRowid;

try {
  // Simulate resend behavior: old OTP is invalidated, only newest unused OTP should pass.
  db.prepare("INSERT INTO email_otp_codes (user_id, otp_code, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))").run(
    userId,
    "111111"
  );
  db.prepare("UPDATE email_otp_codes SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL").run(userId);
  db.prepare("INSERT INTO email_otp_codes (user_id, otp_code, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))").run(
    userId,
    "222222"
  );

  const oldOtpRow = db
    .prepare(
      "SELECT id FROM email_otp_codes WHERE user_id = ? AND otp_code = ? AND used_at IS NULL AND datetime(expires_at) >= datetime('now') ORDER BY id DESC LIMIT 1"
    )
    .get(userId, "111111");

  const newOtpRow = db
    .prepare(
      "SELECT id FROM email_otp_codes WHERE user_id = ? AND otp_code = ? AND used_at IS NULL AND datetime(expires_at) >= datetime('now') ORDER BY id DESC LIMIT 1"
    )
    .get(userId, "222222");

  if (oldOtpRow) {
    throw new Error("Old OTP should not validate after resend.");
  }

  if (!newOtpRow) {
    throw new Error("Newest OTP should validate.");
  }

  console.log("OTP verify check passed.");
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
} finally {
  db.prepare("DELETE FROM email_otp_codes WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}
