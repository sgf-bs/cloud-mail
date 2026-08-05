import resendService from '../service/resend-service';
import app from '../hono/hono';

app.post('/webhooks', async (c) => {
	const webhookSecret = c.env.resend_webhook_secret;
	if (!webhookSecret) {
		console.error('Resend webhook secret is not configured');
		return c.text('Webhook secret is not configured', 503);
	}

	const payload = await c.req.text();
	const headers = {
		id: c.req.header('svix-id'),
		timestamp: c.req.header('svix-timestamp'),
		signature: c.req.header('svix-signature')
	};

	let body;
	try {
		body = resendService.verifyWebhook(payload, headers, webhookSecret);
	} catch (e) {
		console.warn('Invalid Resend webhook signature', e.message);
		return c.text('Invalid webhook signature', 400);
	}

	try {
		const result = await resendService.webhooks(c, body);
		if (!result.handled) {
			console.info(`Ignored Resend webhook event: ${body?.type ?? 'unknown'}`);
		} else {
			console.info('Processed Resend webhook', {
				id: headers.id,
				type: body?.type,
				updated: result.updated,
				reason: result.reason ?? 'updated'
			});
		}
		return c.text('success', 200);
	} catch (e) {
		console.error('Failed to process Resend webhook', {
			id: headers.id,
			type: body?.type,
			message: e.message
		});
		return c.text(e.message, e.code || 500);
	}
});
