import emailService from './email-service';
import { processWebhook, verifyWebhook } from './resend-webhook-handler.js';

const resendService = {
	verifyWebhook,

	async webhooks(c, body) {
		await emailService.ensureResendWebhookSchema(c);
		return processWebhook(body, {
			updateEmailStatus: params => emailService.updateEmailStatus(c, params),
			selectByResendEmailId: resendEmailId => emailService.selectByResendEmailId(c, resendEmailId),
			queueEmailStatus: params => emailService.queueResendEmailStatus(c, params),
			applyQueuedEmailStatus: resendEmailId => emailService.applyQueuedResendEmailStatus(c, resendEmailId)
		});
	}
};

export default resendService;
