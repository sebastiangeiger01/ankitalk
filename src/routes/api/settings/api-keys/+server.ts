import { error, json } from '@sveltejs/kit';
import { encryptApiKey } from '$lib/server/crypto';
import { getUserApiKeyStatus } from '$lib/server/user-keys';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';
import type { ServiceName } from '$lib/server/user-keys';

const ALLOWED_SERVICES: ServiceName[] = ['openai', 'deepgram', 'anthropic'];

function isAllowedService(value: unknown): value is ServiceName {
	return typeof value === 'string' && (ALLOWED_SERVICES as string[]).includes(value);
}

function validateKeyFormat(service: ServiceName, key: string): boolean {
	switch (service) {
		case 'openai':
			return key.startsWith('sk-');
		case 'anthropic':
			return key.startsWith('sk-ant-');
		case 'deepgram':
			return /^[a-zA-Z0-9]+$/.test(key);
	}
}

async function testApiKey(service: ServiceName, key: string): Promise<void> {
	let response: Response;

	try {
		if (service === 'openai') {
			response = await fetch('https://api.openai.com/v1/models', {
				headers: { Authorization: 'Bearer ' + key }
			});
		} else if (service === 'deepgram') {
			response = await fetch('https://api.deepgram.com/v1/auth/grant', {
				method: 'POST',
				headers: {
					Authorization: 'Token ' + key,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ time_to_live_in_seconds: 10 })
			});
		} else {
			// anthropic
			response = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				headers: {
					'x-api-key': key,
					'anthropic-version': '2023-06-01',
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					model: 'claude-haiku-4-5-20251001',
					max_tokens: 1,
					messages: [{ role: 'user', content: 'hi' }]
				})
			});
		}
	} catch {
		throw error(502, 'Could not verify key');
	}

	if (response.ok) return;

	switch (response.status) {
		case 401:
			throw error(400, 'Invalid API key');
		case 403:
			throw error(400, 'Insufficient permissions');
		case 429:
			throw error(400, 'Rate limited');
		default:
			throw error(400, 'Could not verify key');
	}
}

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const status = await getUserApiKeyStatus(db, locals.userId);

	return json(status);
};

export const PUT: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as { service: unknown; key: unknown };
	const { service, key } = body;

	if (!isAllowedService(service)) {
		throw error(400, 'Invalid service. Must be one of: openai, deepgram, anthropic');
	}

	if (!key || typeof key !== 'string' || key.trim().length === 0) {
		throw error(400, 'Missing key');
	}

	const trimmedKey = key.trim();

	if (!validateKeyFormat(service, trimmedKey)) {
		throw error(400, `Invalid key format for ${service}`);
	}

	await testApiKey(service, trimmedKey);

	const encryptionKey = platform?.env.ENCRYPTION_KEY;
	if (!encryptionKey) throw error(500, 'Encryption key not configured');

	const encrypted = await encryptApiKey(trimmedKey, encryptionKey);

	const db = getDb(platform!);
	await db
		.prepare(
			'INSERT OR REPLACE INTO user_api_keys (user_id, service, encrypted_key, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
		)
		.bind(locals.userId, service, encrypted)
		.run();

	return json({ success: true });
};

export const DELETE: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as { service: unknown };
	const { service } = body;

	if (!isAllowedService(service)) {
		throw error(400, 'Invalid service. Must be one of: openai, deepgram, anthropic');
	}

	const db = getDb(platform!);
	await db
		.prepare('DELETE FROM user_api_keys WHERE user_id = ? AND service = ?')
		.bind(locals.userId, service)
		.run();

	return json({ success: true });
};
