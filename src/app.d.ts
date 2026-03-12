/// <reference types="@sveltejs/kit" />
/// <reference types="@cloudflare/workers-types" />

declare global {
	const __COMMIT_HASH__: string;
	namespace App {
		interface Platform {
			env: {
				DB: D1Database;
				KV: KVNamespace;
				MEDIA: R2Bucket;
				HANKO_API_URL: string;
				ENCRYPTION_KEY: string;
			};
			context: ExecutionContext;
		}

		interface Locals {
			userId: string | null;
		}
	}
}

export {};
