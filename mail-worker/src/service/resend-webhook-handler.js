import { Resend } from 'resend';
import { emailConst } from '../const/entity-const.js';
import BizError from '../error/biz-error.js';

const resendWebhookVerifier = new Resend('webhook-verification');

const emailEventConfig = Object.freeze({
	'email.sent': {
		status: emailConst.status.SENT,
		retryWhenMissing: false
	},
	'email.delivered': {
		status: emailConst.status.DELIVERED
	},
	'email.complained': {
		status: emailConst.status.COMPLAINED
	},
	'email.bounced': {
		status: emailConst.status.BOUNCED,
		message: data => JSON.stringify(data.bounce ?? null)
	},
	'email.delivery_delayed': {
		status: emailConst.status.DELAYED
	},
	'email.failed': {
		status: emailConst.status.FAILED,
		message: data => data.failed?.reason ?? JSON.stringify(data.failed ?? null)
	}
});

function normalizeEventTime(value) {
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		throw new BizError('Webhook event time is invalid', 400);
	}
	return new Date(timestamp).toISOString();
}

export function verifyWebhook(payload, headers, webhookSecret) {
	return resendWebhookVerifier.webhooks.verify({
		payload,
		headers,
		webhookSecret
	});
}

export async function processWebhook(body, emailPersistence) {
	const config = emailEventConfig[body?.type];
	if (!config) {
		return { handled: false, reason: 'unsupported-event' };
	}

	const resendEmailId = body.data?.email_id;
	if (!resendEmailId) {
		throw new BizError('Webhook email id is missing', 400);
	}

	const params = {
		resendEmailId,
		status: config.status,
		message: config.message ? config.message(body.data) : null,
		eventTime: normalizeEventTime(body.created_at)
	};

	const emailRow = await emailPersistence.updateEmailStatus(params);
	if (emailRow) {
		return { handled: true, updated: true };
	}

	const existingEmail = await emailPersistence.selectByResendEmailId(resendEmailId);
	if (existingEmail) {
		return { handled: true, updated: false, reason: 'stale-event' };
	}

	// email.sent 可能先于发送接口写入 D1；本地插入时已经会保存 SENT 状态。
	if (config.retryWhenMissing === false) {
		return { handled: true, updated: false, reason: 'pending-email-insert' };
	}

	throw new BizError('更新邮件状态记录失败', 500);
}
