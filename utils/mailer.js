import nodemailer from "nodemailer";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// ─── Pooled SMTP transporter ────────────────────────────────────────────────
// pool:true  → nodemailer keeps one persistent SMTP connection open and
//              queues all outgoing messages through it instead of opening
//              a new TCP+TLS handshake for every email.
// maxConnections:2 → never open more than 2 simultaneous connections to Gmail.z
// rateDelta / rateLimit → max 3 messages per 5 s to avoid SMTP rate limiting.
const transporter = nodemailer.createTransport({
  service: "gmail",
  pool: true,            // ← reuse connection instead of reconnecting each time
  maxConnections: 2,     // ← cap concurrent connections (was unlimited)
  maxMessages: Infinity,
  rateDelta: 5000,       // sliding window in ms
  rateLimit: 3,          // max messages per rateDelta window
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASSWORD,
  },
});

// Log transporter events for debugging
transporter.on("error", (err) => {
  console.error("[Mailer] Transporter error:", err.message);
});

// ─── Retry helper ───────────────────────────────────────────────────────────
// Retries on transient SMTP errors (connection reset, timeout, 4xx codes).
// Permanent failures (5xx auth, bad recipient) are NOT retried.
const RETRY_DELAYS = [5_000, 15_000, 30_000]; // ms between attempts

async function sendWithRetry(mailOptions, attempt = 0) {
  try {
    const info = await transporter.sendMail(mailOptions);
    return info;
  } catch (err) {
    const isTransient =
      err.code === "ECONNECTION"  ||
      err.code === "ETIMEDOUT"    ||
      err.code === "ECONNRESET"   ||
      err.code === "ESOCKET"      ||
      (err.responseCode >= 400 && err.responseCode < 500); // 4xx SMTP = transient

    if (isTransient && attempt < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[attempt];
      console.warn(
        `[Mailer] Transient error on attempt ${attempt + 1} — retrying in ${delay / 1000}s. ` +
        `Error: ${err.message}`
      );
      await new Promise((r) => setTimeout(r, delay));
      return sendWithRetry(mailOptions, attempt + 1);
    }
    // Permanent failure or retries exhausted — rethrow
    throw err;
  }
}

// ─── Public sendMail ─────────────────────────────────────────────────────────
export const sendMail = async ({ to, subject, html, attachments = [] }) => {
  try {
    if (!to || to.length === 0) return;

    // Log attachment summary so oversized emails are easy to spot in logs
    if (attachments.length > 0) {
      let totalBytes = 0;
      for (const att of attachments) {
        if (att.path) {
          try { totalBytes += fs.statSync(att.path).size; } catch (_) {}
        } else if (att.content) {
          totalBytes += Buffer.byteLength(att.content);
        }
      }
      console.log(
        `[Mailer] Sending "${subject}" → ${Array.isArray(to) ? to.join(", ") : to} | ` +
        `${attachments.length} attachment(s), ~${(totalBytes / 1024).toFixed(0)} KB total`
      );
    }

    const mailOptions = {
      from:        process.env.MAIL_USER,
      to:          Array.isArray(to) ? to.join(",") : to,
      subject,
      html,
      attachments,
    };

    const info = await sendWithRetry(mailOptions);
    console.log("[Mailer] Message sent:", info.messageId);
    return info;
  } catch (error) {
    console.error("[Mailer] Failed to send email:", error.message || error);
    // Re-throw so callers (cron jobs) can catch and log per-report
    throw error;
  }
};
