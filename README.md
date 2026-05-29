# CMT Students Course Portal

This project adds a separate login page and student portal for:
- Student registration and login
- Email verification for signup and secure password reset
- Basic anti-sharing control with active session/device limit
- Free vs paid course video access
- Course modules and lesson ordering with free/paid module lock
- Watch progress tracking and resume playback
- Admin upload of free/paid videos
- Admin edit and delete for uploaded videos
- Admin module create/edit/delete management
- Admin control to grant/revoke paid access
- Admin ability to delete student users
- QR payment submission from phone with admin approval
- Promo code/discount support in payment flow
- Custom logo, icon-only logo, favicon, and brand kit
- Continue watching, topic/level filters, and favorite lessons
- Roadmap (Beginner/Intermediate/Advanced) milestones and badges
- Certificate PDF generation and shareable certificate link
- Bulk admin access controls, activity logs, payment status filter, and CSV exports
- Landing page with testimonials/results/FAQ, WhatsApp support, trial lead form, and SEO topic pages

## Tech Stack
- Node.js + Express
- SQLite (local DB)
- EJS templates
- Multer for video uploads
- PDFKit for certificate PDF export

## Brand Kit
- Full logo: `public/logo.svg`
- Icon-only logo: `public/logo-icon.svg`
- Favicon: `public/favicon.svg`
- Brand kit reference: `BRAND-KIT.md`

## 1) Setup
1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Update `.env` values:
   - `SESSION_SECRET`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `PAYMENT_NAME`
   - `PAYMENT_UPI_ID`
   - `PAYMENT_PHONE`
   - `PAYMENT_QR_IMAGE`
   - `COURSE_PRICE`
   - `MAX_ACTIVE_SESSIONS`
   - `BASE_URL`
   - SMTP settings for email verification and reset flow

## QR Payment Setup (Phone Scan)
1. Add your QR image file at `public/qr-payment.png` (or update `PAYMENT_QR_IMAGE`).
2. Student opens `/pay` page, scans QR from mobile, and pays.
3. Student submits amount + UTR/transaction ID + screenshot proof.
4. Admin opens `/admin` and approves payment request.
5. On approve, paid access is granted automatically.

## 2) Install and Run
```bash
npm install
npm start
```

Then open:
- `http://localhost:3000/login`
- Admin panel: login with your admin credentials, then go to `/admin`

## 3) How Access Works
- New students get only **free** access by default.
- In admin panel, you can toggle paid access per student.
- Videos uploaded as `free` are visible to all logged-in students.
- Videos uploaded as `paid` are only visible to students with paid access.
- Students can also request paid upgrade through QR payment proof submission.

## 4) Security Features
- Signup requires OTP/email verification before first login.
- Forgot password flow sends secure reset links.
- Active session/device limit enforced via `MAX_ACTIVE_SESSIONS`.

## 5) Business Features
- Promo codes can be created and toggled from `/admin`.
- Discount type supports percent or fixed amount.
- Promo usage is counted when payment is approved.
- Payment requests store expected amount, applied promo, and discount.

## 6) Better Admin Controls
- Bulk grant/revoke paid access for selected users.
- User activity logs with login and video completion events.
- Student and payment export to CSV.
- Payment status filter: all/pending/approved/rejected.

## 7) Video Upload Storage
- Uploaded video files are stored on your server in `uploads/videos/`.
- Database file is `database.sqlite`.
- Upload form includes a progress bar for large files.

## 8) Video Management (Admin)
- Edit any uploaded video title, description, and access type from `/admin`.
- Assign video to a module and lesson order position.
- Delete videos from `/admin` (deletes DB record and file from server).

## 9) Modules and Progress
- Create free/paid modules from `/admin`.
- Set module roadmap level: `beginner`, `intermediate`, `advanced`.
- Lock paid modules for free users automatically.
- Lessons are ordered by module sort order + lesson order.
- Add lesson topic and level for better search and filtering.
- Student watch progress auto-saves and resumes from last position.
- Continue Watching section appears on dashboard.
- Students can mark favorites.

## 10) Certificates and Milestones
- Complete all visible lessons to unlock certificate.
- Download certificate PDF from dashboard.
- Generate shareable certificate verification link.
- Module completion creates milestone badges.

## 11) Marketing Pages
- Landing page at `/` with testimonials, results, FAQ, and lead form.
- WhatsApp floating support button from `SUPPORT_WHATSAPP`.
- SEO-ready free topic pages under `/topics/:slug`.

## 12) Deploy on Your Server
1. Upload the project to your server (same domain or subdomain).
2. Run `npm install`.
3. Set `.env` with secure values.
4. Start with process manager (recommended PM2):
   - `npm install -g pm2`
   - `pm2 start server.js --name cmt-students`
5. Configure reverse proxy (Nginx/Apache) to route traffic.

## Important Security Notes
- Use HTTPS in production.
- Set a strong `SESSION_SECRET`.
- Keep regular backups of `database.sqlite` and `uploads/videos/`.
- Add firewall and fail2ban/rate-limiting on server.
