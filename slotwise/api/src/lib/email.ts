import nodemailer from 'nodemailer';
import { config } from '../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: { filename: string; content: string; contentType: string }[];
}

let smtp: nodemailer.Transporter | undefined;

/** Resend when an API key is configured, SMTP when a URL is, else the log. */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (config.email.resendApiKey) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.email.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        reply_to: msg.replyTo,
        attachments: msg.attachments?.map((a) => ({
          filename: a.filename,
          content: Buffer.from(a.content).toString('base64'),
          content_type: a.contentType,
        })),
      }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
    return;
  }
  if (config.email.smtpUrl) {
    smtp ??= nodemailer.createTransport(config.email.smtpUrl);
    await smtp.sendMail({
      from: config.email.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      replyTo: msg.replyTo,
      attachments: msg.attachments,
    });
    return;
  }
  console.log(`[email:log] to=${msg.to} subject=${JSON.stringify(msg.subject)}\n${msg.text}\n`);
}
