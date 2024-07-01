import { isProd } from '#root/utils/envUtils.js';
import { getSecret } from '#root/utils/secretUtils.js';
import sgMail from '@sendgrid/mail';

const SENDGRID_API_KEY = await getSecret('SENDGRID_API_KEY');
sgMail.setApiKey(SENDGRID_API_KEY);

const EMAIL_FROM = await getSecret('EMAIL_FROM');
const EMAIL_TO = await getSecret('EMAIL_TO');

export async function sendSendGridEmail({
  subject = `WE-NOTIF: some subject -- env:${isProd ? 'prod' : 'dev'}`,
  body = 'some body data text',
  to = EMAIL_TO,
  from = EMAIL_FROM,
  force = false,
}) {
  console.log('fromemail1212', from);
  if (!isProd && !force) {
    return;
  }
  try {
    const msg = {
      to: to,
      from: from,
      subject: `WE-NOTIF: ${subject} -- env:${isProd ? 'prod' : 'dev'}`,
      html: body,
      replyTo: from,
    };


    const sgSendResp = await sgMail.send(msg);

    console.log('Email sent successfully', sgSendResp);
  } catch (err) {
    console.error('SendGrid error:', err);
    throw new Error('Sendgrid error');
  }
}
