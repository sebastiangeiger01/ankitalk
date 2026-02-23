export function getDb(platform: App.Platform): D1Database {
	return platform.env.DB;
}

export function newId(): string {
	return crypto.randomUUID();
}
