import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { emailConst } from '../src/const/entity-const.js';
import { processWebhook, verifyWebhook } from '../src/service/resend-webhook-handler.js';

function createBody(type, data = {}) {
	return {
		type,
		created_at: '2026-08-05T06:15:16.000Z',
		data: {
			email_id: 'email_123',
			...data
		}
	};
}

function createPersistence({ updatedEmail = null, existingEmail = null, reconciliation } = {}) {
	const calls = [];
	const queued = [];
	const reconciled = [];
	return {
		calls,
		queued,
		reconciled,
		async updateEmailStatus(params) {
			calls.push(params);
			return updatedEmail;
		},
		async selectByResendEmailId() {
			return existingEmail;
		},
		async queueEmailStatus(params) {
			queued.push(params);
		},
		async applyQueuedEmailStatus(resendEmailId) {
			reconciled.push(resendEmailId);
			return reconciliation ?? { applied: false, reason: 'email-not-found', email: null };
		}
	};
}

describe('Resend webhook verification', () => {
	it('verifies the unmodified raw payload', () => {
		const payload = JSON.stringify(createBody('email.sent'));
		const id = 'msg_test';
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const secretBytes = Buffer.from('01234567890123456789012345678901');
		const webhookSecret = `whsec_${secretBytes.toString('base64')}`;
		const signature = createHmac('sha256', secretBytes)
			.update(`${id}.${timestamp}.${payload}`)
			.digest('base64');

		const result = verifyWebhook(payload, {
			id,
			timestamp,
			signature: `v1,${signature}`
		}, webhookSecret);

		assert.equal(result.type, 'email.sent');
		assert.equal(result.data.email_id, 'email_123');
	});
});

describe('Resend email event processing', () => {
	it('acknowledges unsupported events without changing email state', async () => {
		const persistence = createPersistence();
		const result = await processWebhook(createBody('email.opened'), persistence);

		assert.deepEqual(result, { handled: false, reason: 'unsupported-event' });
		assert.equal(persistence.calls.length, 0);
	});

	it('acknowledges email.sent when the D1 insert is still pending', async () => {
		const result = await processWebhook(createBody('email.sent'), createPersistence());

		assert.deepEqual(result, {
			handled: true,
			updated: false,
			reason: 'pending-email-insert'
		});
	});

	it('queues a later delivery event when the email insert is still pending', async () => {
		const persistence = createPersistence();
		const result = await processWebhook(createBody('email.delivered'), persistence);

		assert.deepEqual(result, {
			handled: true,
			updated: false,
			reason: 'queued-for-email-insert'
		});
		assert.equal(persistence.queued.length, 1);
		assert.equal(persistence.queued[0].resendEmailId, 'email_123');
		assert.deepEqual(persistence.reconciled, ['email_123']);
	});

	it('reconciles a delivery event when the email appears during queueing', async () => {
		const persistence = createPersistence({
			reconciliation: { applied: true, reason: 'updated', email: { emailId: 1 } }
		});
		const result = await processWebhook(createBody('email.delivered'), persistence);

		assert.deepEqual(result, {
			handled: true,
			updated: true,
			reason: 'reconciled-after-queue'
		});
		assert.equal(persistence.queued.length, 1);
		assert.deepEqual(persistence.reconciled, ['email_123']);
		assert.equal(persistence.calls.length, 1);
	});

	it('keeps a newer stored status when a queued event is stale', async () => {
		const persistence = createPersistence({
			reconciliation: { applied: false, reason: 'stale-event', email: { emailId: 1 } }
		});
		const result = await processWebhook(createBody('email.delivered'), persistence);

		assert.deepEqual(result, {
			handled: true,
			updated: false,
			reason: 'stale-event'
		});
	});

	it('ignores an older event instead of regressing the stored status', async () => {
		const persistence = createPersistence({ existingEmail: { emailId: 1 } });
		const result = await processWebhook(createBody('email.sent'), persistence);

		assert.deepEqual(result, {
			handled: true,
			updated: false,
			reason: 'stale-event'
		});
	});

	it('maps bounced events to the stored status and message', async () => {
		const persistence = createPersistence({ updatedEmail: { emailId: 1 } });
		const bounce = { type: 'Permanent', message: 'Mailbox unavailable' };
		const result = await processWebhook(createBody('email.bounced', { bounce }), persistence);

		assert.deepEqual(result, { handled: true, updated: true });
		assert.deepEqual(persistence.calls[0], {
			resendEmailId: 'email_123',
			status: emailConst.status.BOUNCED,
			message: JSON.stringify(bounce),
			eventTime: '2026-08-05T06:15:16.000Z'
		});
	});
});
