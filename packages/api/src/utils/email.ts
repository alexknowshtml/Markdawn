import { createTransport, type Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (transporter) return transporter;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM;

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !smtpFrom) {
    return null;
  }

  transporter = createTransport({
    host: smtpHost,
    port: Number(smtpPort),
    secure: Number(smtpPort) === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  return transporter;
}

type EmailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export async function sendEmail(payload: EmailPayload): Promise<void> {
  const mailer = getTransporter();
  const from = process.env.SMTP_FROM;

  if (!mailer || !from) {
    return;
  }

  await mailer.sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });
}

export async function sendShareInviteEmail({
  to,
  entityTitle,
  entityType,
  sharedByName,
  permission,
  entityUrl,
}: {
  to: string;
  entityTitle: string;
  entityType: 'page' | 'folder';
  sharedByName: string;
  permission: string;
  entityUrl: string;
}): Promise<void> {
  const subject = `${sharedByName} shared a ${entityType} with you on Markdawn`;
  const text = `${sharedByName} shared "${entityTitle}" with you. You have ${permission} access.\n\nView it here: ${entityUrl}`;

  await sendEmail({ to, subject, text });
}
