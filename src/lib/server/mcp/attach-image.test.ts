// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpToolContext } from './tools';
import type { McpScope } from './auth';

// audited() writes an audit row via ctx.db; a no-op prepare/bind/run chain is all attach_image needs.
const fakeDb = {
	prepare: () => ({ bind: () => ({ run: () => Promise.resolve() }) })
} as unknown as D1Database;

function fakeMedia() {
	const store = new Map<string, Uint8Array>();
	const media = {
		put(key: string, value: ArrayBuffer | Uint8Array) {
			store.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
			return Promise.resolve();
		}
	} as unknown as R2Bucket;
	return { media, store };
}

async function connectedClient(ctx: McpToolContext): Promise<Client> {
	const server = createMcpServer(ctx);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test', version: '0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

describe('attach_image MCP tool', () => {
	it('returns a result matching its output schema (filename + content_type + bytes)', async () => {
		const { media } = fakeMedia();
		const ctx: McpToolContext = {
			db: fakeDb,
			userId: 'user-1',
			tokenId: 'token-1',
			scopes: new Set<McpScope>(['cards:write']),
			media,
			waitUntil: () => {}
		};
		const client = await connectedClient(ctx);

		// The SDK validates structuredContent against the tool's output schema, which is exactly
		// what caught the original content_type mismatch.
		const result = await client.callTool({
			name: 'attach_image',
			arguments: { filename: 'pixel.png', content_base64: 'AAAA' }
		});

		expect(result.isError).toBeFalsy();
		const structured = result.structuredContent as { filename: string; content_type: string; size_bytes: number };
		expect(typeof structured.content_type).toBe('string');
		expect(structured.content_type).toBe('image/png');
		expect(structured.filename).toMatch(/^[0-9a-f]{64}\.png$/);
		expect(structured.size_bytes).toBeGreaterThan(0);

		await client.close();
	});
});

describe('attach_images MCP tool', () => {
	const ctx = (media: R2Bucket): McpToolContext => ({
		db: fakeDb,
		userId: 'user-1',
		tokenId: 'token-1',
		scopes: new Set<McpScope>(['cards:write']),
		media,
		waitUntil: () => {}
	});

	it('uploads a batch and reports per-item integrity failures instead of failing the call', async () => {
		const { media } = fakeMedia();
		const client = await connectedClient(ctx(media));

		const result = await client.callTool({
			name: 'attach_images',
			arguments: {
				images: [
					{ filename: 'a.png', content_base64: 'AAAA' },
					// size_bytes intentionally wrong → flagged as a transit-corruption mismatch.
					{ filename: 'b.png', content_base64: 'AAAA', size_bytes: 999 }
				]
			}
		});

		expect(result.isError).toBeFalsy();
		const out = result.structuredContent as {
			uploaded: number;
			failed: number;
			results: Array<{ source_filename: string; filename?: string; error?: string }>;
		};
		expect(out.uploaded).toBe(1);
		expect(out.failed).toBe(1);
		expect(out.results[0].filename).toMatch(/^[0-9a-f]{64}\.png$/);
		expect(out.results[1].error).toMatch(/IMAGE_INTEGRITY_MISMATCH/);

		await client.close();
	});
});
