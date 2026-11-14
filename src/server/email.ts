import nodemailer, { type Transporter } from "nodemailer";

/**
 * Outbound email boundary. Provider-agnostic: any provider that offers SMTP works (SES, Postmark,
 * SendGrid, Mailgun, Google Workspace relay). Choose with environment variables:
 *
 *   EMAIL_TRANSPORT = dev | smtp          (default dev; production requires smtp)
 *   SMTP_URL        = smtps://user:pass@smtp.example.com:465   (keep in a secret store)
 *   EMAIL_FROM      = "Crisis Compass <no-reply@your-domain>"  (a domain you have authenticated with SPF/DKIM/DMARC)
 *
 * The dev transport sends nothing: jobs stay PENDING and are readable at /dev/outbox.
 */
export type OutgoingEmail = { to: string; subject: string; text: string };
export interface EmailTransport {
  readonly name: string;
  /** True when messages really leave the machine. */
  readonly delivers: boolean;
  send(msg: OutgoingEmail): Promise<void>;
}

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** Reject anything that could add headers or extra recipients, before the message reaches a provider. */
export function sanitizeEmail(msg: OutgoingEmail): OutgoingEmail {
  const to = msg.to.trim();
  if (!ADDRESS.test(to) || to.length > 254) throw new Error("invalid recipient address");
  const subject = msg.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  if (!subject) throw new Error("empty subject");
  return { to, subject, text: msg.text };
}

class DevTransport implements EmailTransport {
  readonly name = "dev";
  readonly delivers = false;
  async send(): Promise<void> {
    throw new Error("dev transport does not deliver");
  }
}

class SmtpTransport implements EmailTransport {
  readonly name = "smtp";
  readonly delivers = true;
  private readonly t: Transporter;
  constructor(url: string, private readonly from: string) {
    this.t = nodemailer.createTransport(url, { disableFileAccess: true, disableUrlAccess: true });
  }
  async send(msg: OutgoingEmail): Promise<void> {
    const m = sanitizeEmail(msg);
    await this.t.sendMail({ from: this.from, to: m.to, subject: m.subject, text: m.text });
  }
}

/** Throws when configuration is unsafe, so a misconfigured production deploy fails loudly instead of silently dropping mail. */
export function createTransport(env: Record<string, string | undefined> = process.env): EmailTransport {
  const kind = env.EMAIL_TRANSPORT ?? "dev";
  if (kind === "dev") {
    if (env.NODE_ENV === "production") throw new Error("EMAIL_TRANSPORT=smtp is required in production.");
    return new DevTransport();
  }
  if (kind !== "smtp") throw new Error(`Unknown EMAIL_TRANSPORT "${kind}".`);
  const url = env.SMTP_URL;
  const from = env.EMAIL_FROM;
  if (!url || !/^smtps?:\/\//.test(url)) throw new Error("SMTP_URL must be an smtp:// or smtps:// URL.");
  if (!from || /[\r\n]/.test(from) || !/<?[^\s@<>]+@[^\s@<>]+>?$/.test(from)) throw new Error("EMAIL_FROM must be a single valid address.");
  return new SmtpTransport(url, from);
}
