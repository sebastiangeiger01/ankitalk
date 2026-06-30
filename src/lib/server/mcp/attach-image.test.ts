// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpToolContext } from './tools';
import type { McpScope } from './auth';

// audited() writes an audit row via ctx.db; a no-op prepare/bind/run chain is all these tools need.
const fakeDb = {
	prepare: () => ({ bind: () => ({ run: () => Promise.resolve() }) })
} as unknown as D1Database;

const fakeMedia = {} as unknown as R2Bucket;

function fakeKv() {
	const store = new Map<string, string>();
	return {
		put: (k: string, v: string) => {
			store.set(k, v);
			return Promise.resolve();
		},
		get: (k: string) => Promise.resolve(store.get(k) ?? null)
	} as unknown as KVNamespace;
}

async function connectedClient(ctx: McpToolContext): Promise<Client> {
	const server = createMcpServer(ctx);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test', version: '0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

function ctx(): McpToolContext {
	return {
		db: fakeDb,
		userId: 'user-1',
		tokenId: 'token-1',
		scopes: new Set<McpScope>(['cards:write']),
		media: fakeMedia,
		kv: fakeKv(),
		origin: 'https://test.local',
		waitUntil: () => {}
	};
}

describe('image-ingestion tool surface', () => {
	it('exposes only the out-of-band upload tools (base64 attach tools were removed)', async () => {
		const client = await connectedClient(ctx());
		const names = (await client.listTools()).tools.map((t) => t.name);

		expect(names).toContain('attach_image_from_url');
		expect(names).toContain('create_image_upload');
		expect(names).not.toContain('attach_image');
		expect(names).not.toContain('attach_images');

		await client.close();
	});
});

describe('create_image_upload MCP tool', () => {
	it('returns a result matching its output schema', async () => {
		const client = await connectedClient(ctx());

		// The SDK validates structuredContent against the tool's output schema — the same check that
		// originally caught the attach_image content_type mismatch, kept here on a surviving tool.
		const result = await client.callTool({ name: 'create_image_upload', arguments: {} });

		expect(result.isError).toBeFalsy();
		const out = result.structuredContent as {
			upload_url: string;
			method: string;
			curl_example: string;
			max_uploads: number;
			max_bytes: number;
			accepts: string[];
		};
		expect(out.method).toBe('PUT');
		expect(out.upload_url).toMatch(/^https:\/\/test\.local\/api\/media\/upload\/[0-9a-f]+$/);
		expect(out.curl_example).toContain('--data-binary');
		expect(out.max_uploads).toBeGreaterThan(0);
		expect(out.accepts).toContain('png');

		await client.close();
	});
});
