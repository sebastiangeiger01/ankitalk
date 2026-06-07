import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import type { RequestHandler } from './$types';

interface ElevenLabsVoice {
	voice_id: string;
	name: string;
	category?: string;
	labels?: Record<string, string>;
	preview_url?: string;
}

export interface VoiceOption {
	voiceId: string;
	name: string;
	category: string;
	description: string;
	previewUrl: string | null;
}

function summarizeLabels(labels: Record<string, string> | undefined): string {
	if (!labels) return '';
	return ['accent', 'gender', 'age', 'use_case', 'description']
		.map((key) => labels[key])
		.filter(Boolean)
		.join(' · ');
}

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const apiKey = await getUserApiKey(db, locals.userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your ElevenLabs API key in Settings to browse voices' }, { status: 400 });

	const res = await fetch('https://api.elevenlabs.io/v1/voices', {
		headers: { 'xi-api-key': apiKey }
	});

	if (!res.ok) {
		throw error(res.status === 401 ? 400 : 502, 'Failed to load ElevenLabs voices');
	}

	const data = (await res.json().catch(() => ({}))) as { voices?: ElevenLabsVoice[] };
	const voices: VoiceOption[] = (data.voices ?? []).map((v) => ({
		voiceId: v.voice_id,
		name: v.name,
		category: v.category ?? 'generated',
		description: summarizeLabels(v.labels),
		previewUrl: v.preview_url ?? null
	}));

	return json(
		{ voices },
		{ headers: { 'Cache-Control': 'private, max-age=300' } }
	);
};
