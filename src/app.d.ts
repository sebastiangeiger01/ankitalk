/// <reference types="@sveltejs/kit" />
/// <reference types="@cloudflare/workers-types" />

declare global {
	namespace App {
		interface Platform {
			env: {
				DB: D1Database;
				KV: KVNamespace;
				MEDIA: R2Bucket;
				HANKO_API_URL: string;
				OPENAI_API_KEY: string;
				DEEPGRAM_API_KEY: string;
				ANTHROPIC_API_KEY: string;
			};
			context: ExecutionContext;
		}

		interface Locals {
			userId: string | null;
		}
	}
}

export {};
