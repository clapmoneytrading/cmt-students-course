const Database = require("better-sqlite3");

const db = new Database("database.sqlite");

const otpRows = db
  .prepare(
    "SELECT id, user_id, otp_code, expires_at, used_at, datetime(expires_at) AS exp_dt, datetime('now') AS now_dt, CASE WHEN datetime(expires_at) >= datetime('now') THEN 1 ELSE 0 END AS is_valid FROM email_otp_codes ORDER BY id DESC LIMIT 15"
  )
  .all();

const users = db
  .prepare("SELECT id, name, email, email_verified FROM users ORDER BY id DESC LIMIT 10")
  .all();

console.log("Recent OTP rows:");
console.table(otpRows);
console.log("Recent users:");
console.table(users);
