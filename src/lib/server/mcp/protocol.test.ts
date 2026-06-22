import { describe, it, expect } from 'vitest';
import {
	ErrorCode,
	failure,
	isJsonRpcRequest,
	isNotification,
	success,
	textResult,
	errorResult
} from './protocol';

describe('JSON-RPC envelope', () => {
	it('recognizes a valid request', () => {
		expect(isJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(true);
	});

	it('rejects a non-2.0 envelope', () => {
		expect(isJsonRpcRequest({ jsonrpc: '1.0', method: 'foo' })).toBe(false);
		expect(isJsonRpcRequest({ method: 'foo' })).toBe(false);
		expect(isJsonRpcRequest(null)).toBe(false);
	});

	it('treats requests without id as notifications', () => {
		expect(isNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true);
		expect(isNotification({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe(false);
		// `id: null` is also a notification per JSON-RPC 2.0 § 4.2 (only requests with a
		// non-null id receive responses).
		expect(isNotification({ jsonrpc: '2.0', id: null, method: 'ping' })).toBe(true);
	});

	it('builds success envelopes with null id when id is missing', () => {
		expect(success(undefined, { ok: true })).toEqual({ jsonrpc: '2.0', id: null, result: { ok: true } });
		expect(success(7, { v: 1 })).toEqual({ jsonrpc: '2.0', id: 7, result: { v: 1 } });
	});

	it('builds failure envelopes with code+message', () => {
		const env = failure(3, ErrorCode.MethodNotFound, 'gone');
		expect(env).toEqual({
			jsonrpc: '2.0',
			id: 3,
			error: { code: ErrorCode.MethodNotFound, message: 'gone', data: undefined }
		});
	});
});

describe('tool result helpers', () => {
	it('textResult wraps a string into the content array', () => {
		expect(textResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
	});

	it('textResult attaches structuredContent when provided', () => {
		const r = textResult('hi', { x: 1 });
		expect(r.structuredContent).toEqual({ x: 1 });
		expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
	});

	it('errorResult sets isError=true', () => {
		expect(errorResult('bad')).toEqual({ content: [{ type: 'text', text: 'bad' }], isError: true });
	});
});
