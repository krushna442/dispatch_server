/**
 * mailQueue.js
 * Asynchronous background mail delivery queue.
 * Ensures scanning and HTTP endpoints respond immediately (<50ms)
 * without awaiting SMTP handshakes. Delivers messages with controlled pacing
 * to avoid SMTP connection drops or server rate-limiting.
 */

import { sendMail } from './mailer.js';

class MailQueue {
  constructor() {
    /** @type {Array<{to: string|string[], subject: string, html: string, attachments?: any[], cc?: string, retries: number, enqueuedAt: Date}>} */
    this.queue = [];
    this.isProcessing = false;
    this.totalSent = 0;
    this.totalFailed = 0;
    this.lastProcessedAt = null;
    this.intervalMs = 1200; // 1.2s delay between messages to respect SMTP pool limits
  }

  /**
   * Enqueue an email for background delivery.
   * Returns immediately without blocking the calling thread.
   */
  enqueue(mailOptions) {
    if (!mailOptions || !mailOptions.to || (Array.isArray(mailOptions.to) && mailOptions.to.length === 0)) {
      return;
    }

    this.queue.push({
      ...mailOptions,
      retries: 0,
      enqueuedAt: new Date()
    });

    console.log(`[MailQueue] Enqueued: "${mailOptions.subject}". Queue size: ${this.queue.length}`);

    // Trigger queue processing asynchronously
    if (!this.isProcessing) {
      setImmediate(() => this.process());
    }
  }

  async process() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        await sendMail({
          to: item.to,
          subject: item.subject,
          html: item.html,
          attachments: item.attachments || [],
          cc: item.cc
        });
        this.totalSent++;
        this.lastProcessedAt = new Date();
        console.log(`[MailQueue] Delivered: "${item.subject}" (Remaining in queue: ${this.queue.length})`);
      } catch (err) {
        this.totalFailed++;
        console.error(`[MailQueue] Failed sending "${item.subject}":`, err.message || err);

        // Retry transient errors once if retries < 1
        if (item.retries < 1) {
          item.retries++;
          this.queue.push(item);
          console.warn(`[MailQueue] Re-queued "${item.subject}" for retry.`);
        }
      }

      // Small pacing delay to avoid SMTP rate limits
      if (this.queue.length > 0) {
        await new Promise((res) => setTimeout(res, this.intervalMs));
      }
    }

    this.isProcessing = false;
  }

  getStats() {
    return {
      pending: this.queue.length,
      totalSent: this.totalSent,
      totalFailed: this.totalFailed,
      isProcessing: this.isProcessing,
      lastProcessedAt: this.lastProcessedAt
    };
  }
}

export const mailQueue = new MailQueue();
export const enqueueMail = (options) => mailQueue.enqueue(options);
