import { decryptApiKey } from './crypto';

export type ServiceName = 'openai' | 'deepgram' | 'anthropic';

export async function getUserApiKey(
	db: D1Database,
	userId: string,
	service: ServiceName,
	encryptionKey: string
): Promise<string | null> {
	const row = await db
		.prepare('SELECT encrypted_key FROM user_api_keys WHERE user_id = ? AND service = ?')
		.bind(userId, service)
		.first<{ encrypted_key: string }>();

	if (!row) return null;

	return decryptApiKey(row.encrypted_key, encryptionKey);
}

export async function getUserApiKeyStatus(
	db: D1Database,
	userId: string
): Promise<{ openai: boolean; deepgram: boolean; anthropic: boolean }> {
	const rows = await db
		.prepare('SELECT service FROM user_api_keys WHERE user_id = ?')
		.bind(userId)
		.all<{ service: string }>();

	const services = new Set(rows.results.map((r) => r.service));

	return {
		openai: services.has('openai'),
		deepgram: services.has('deepgram'),
		anthropic: services.has('anthropic')
	};
}
