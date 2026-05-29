const Database = require("better-sqlite3");

const db = new Database("database.sqlite");
db.pragma("foreign_keys = ON");

const email = `fk-delete-${Date.now()}@example.com`;
const user = db
  .prepare(
    "INSERT INTO users (name, email, password_hash, is_admin, has_paid_access, email_verified) VALUES (?, ?, ?, 0, 0, 1)"
  )
  .run("FK User", email, "x");

const userId = user.lastInsertRowid;

try {
  db.prepare("INSERT INTO email_otp_codes (user_id, otp_code, expires_at) VALUES (?, ?, datetime('now', '+10 minutes'))").run(
    userId,
    "123456"
  );
  db.prepare("INSERT INTO email_verification_tokens (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 day'))").run(
    userId,
    `tok-${Date.now()}`
  );
  db.prepare("INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))").run(
    userId,
    `rst-${Date.now()}`
  );
  db.prepare("INSERT INTO certificate_tokens (user_id, token) VALUES (?, ?)").run(userId, `cert-${Date.now()}`);
  db.prepare("INSERT INTO user_activity_logs (user_id, event_type, event_data) VALUES (?, ?, ?)").run(
    userId,
    "login",
    "ua"
  );
  db.prepare("INSERT INTO payment_requests (user_id, amount, transaction_ref, status) VALUES (?, 100, ?, ?)").run(
    userId,
    "tref",
    "pending"
  );

  const tx = db.transaction((uid) => {
    db.prepare("DELETE FROM active_sessions WHERE user_id = ?").run(uid);
    db.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(uid);
    db.prepare("DELETE FROM email_otp_codes WHERE user_id = ?").run(uid);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(uid);
    db.prepare("DELETE FROM video_progress WHERE user_id = ?").run(uid);
    db.prepare("DELETE FROM user_favorites WHERE user_id = ?").run(uid);
    db.prepare("DELETE FROM certificate_tokens WHERE user_id = ?").run(uid);
    db.prepare("DELETE FROM user_activity_logs WHERE user_id = ?").run(uid);
    db.prepare("UPDATE posts SET created_by = NULL WHERE created_by = ?").run(uid);
    db.prepare("DELETE FROM payment_requests WHERE user_id = ?").run(uid);
    db.prepare("DELETE FROM users WHERE id = ? AND is_admin = 0").run(uid);
  });

  tx(userId);

  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (exists) {
    throw new Error("Delete failed: user still exists");
  }

  console.log("Delete FK check passed.");
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
