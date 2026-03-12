export async function encryptApiKey(plaintext: string, masterKey: string): Promise<string> {
	const keyBytes = Uint8Array.from(atob(masterKey), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
		'encrypt'
	]);

	const iv = crypto.getRandomValues(new Uint8Array(12));

	const encodedPlaintext = new TextEncoder().encode(plaintext);
	const ciphertextWithTag = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, tagLength: 128 },
		key,
		encodedPlaintext
	);

	const result = new Uint8Array(iv.byteLength + ciphertextWithTag.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(ciphertextWithTag), iv.byteLength);

	return btoa(String.fromCharCode(...result));
}

export async function decryptApiKey(encrypted: string, masterKey: string): Promise<string> {
	const data = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));

	const iv = data.slice(0, 12);
	const ciphertextWithTag = data.slice(12);

	const keyBytes = Uint8Array.from(atob(masterKey), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [
		'decrypt'
	]);

	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv, tagLength: 128 },
		key,
		ciphertextWithTag
	);

	return new TextDecoder().decode(plaintext);
}
