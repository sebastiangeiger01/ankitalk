import { decryptApiKey } from './crypto';

export type ServiceName = 'openai' | 'deepgram' | 'anthropic' | 'elevenlabs';

export type ApiKeyStatus = Record<ServiceName, boolean>;

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
): Promise<ApiKeyStatus> {
	const { status } = await getUserApiKeyOverview(db, userId);
	return status;
}

export interface ApiKeyOverview {
	status: ApiKeyStatus;
	/**
	 * Masked previews ("…abcd", last 4 characters) for each configured key so users can
	 * verify which key is stored without ever exposing the full secret.
	 */
	suffixes: Partial<Record<ServiceName, string>>;
}

export async function getUserApiKeyOverview(
	db: D1Database,
	userId: string,
	encryptionKey?: string
): Promise<ApiKeyOverview> {
	const rows = await db
		.prepare('SELECT service, encrypted_key FROM user_api_keys WHERE user_id = ?')
		.bind(userId)
		.all<{ service: string; encrypted_key: string }>();

	const status: ApiKeyStatus = {
		openai: false,
		deepgram: false,
		anthropic: false,
		elevenlabs: false
	};
	const suffixes: Partial<Record<ServiceName, string>> = {};

	for (const row of rows.results) {
		if (!(row.service in status)) continue;
		const service = row.service as ServiceName;
		status[service] = true;
		if (!encryptionKey) continue;
		try {
			const key = await decryptApiKey(row.encrypted_key, encryptionKey);
			if (key.length >= 4) suffixes[service] = `…${key.slice(-4)}`;
		} catch {
			// Undecryptable row: still report the key as configured, just without a preview.
		}
	}

	return { status, suffixes };
}
