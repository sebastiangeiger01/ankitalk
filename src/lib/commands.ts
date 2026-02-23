import type { ReviewPhase, VoiceCommand } from './types';

interface CommandDef {
	command: VoiceCommand;
	aliases: string[];
	phases: ReviewPhase[];
}

const COMMANDS: CommandDef[] = [
	{
		command: 'answer',
		aliases: [
			'answer', 'show', 'show answer', 'show me', 'flip',
			'antwort', 'zeig', 'zeig mir', 'umdrehen'
		],
		phases: ['question']
	},
	{
		command: 'hint',
		aliases: [
			'hint', 'give me a hint', 'clue',
			'hinweis', 'tipp'
		],
		phases: ['question']
	},
	{
		command: 'repeat',
		aliases: [
			'repeat', 'say again', 'again please', 'say it again', 'one more time',
			'wiederholen', 'nochmal bitte', 'noch einmal', 'nochmals'
		],
		phases: ['question', 'rating']
	},
	{
		command: 'again',
		aliases: ['again', 'nochmal'],
		phases: ['question', 'rating']
	},
	{
		command: 'hard',
		aliases: ['hard', 'difficult', 'schwer', 'schwierig'],
		phases: ['question', 'rating']
	},
	{
		command: 'good',
		aliases: ['good', 'okay', 'ok', 'gut'],
		phases: ['question', 'rating']
	},
	{
		command: 'easy',
		aliases: ['easy', 'simple', 'leicht', 'einfach'],
		phases: ['question', 'rating']
	},
	{
		command: 'explain',
		aliases: [
			'explain', 'explain this', 'explain it', 'why',
			'erklär', 'erklären', 'erkläre', 'warum'
		],
		phases: ['rating']
	},
	{
		command: 'stop',
		aliases: [
			'stop', 'quit', 'end', 'finish', 'done', 'end session',
			'stopp', 'aufhören', 'ende', 'fertig', 'schluss'
		],
		phases: ['question', 'rating']
	}
];

/**
 * Match a transcript to a voice command, respecting the current review phase.
 *
 * Handles the "again" collision:
 * - "say again" / "again please" → repeat
 * - bare "again" → rating (again)
 */
export function matchCommand(transcript: string, phase: ReviewPhase): VoiceCommand | null {
	const normalized = transcript.toLowerCase().trim();

	if (!normalized) return null;

	// Check "repeat" aliases first (handles "say again", "again please")
	const repeatDef = COMMANDS.find((c) => c.command === 'repeat')!;
	for (const alias of repeatDef.aliases) {
		if (alias === 'repeat' && normalized === 'repeat') {
			if (repeatDef.phases.includes(phase)) return 'repeat';
		} else if (alias !== 'repeat' && normalized.includes(alias)) {
			if (repeatDef.phases.includes(phase)) return 'repeat';
		}
	}

	// Check all other commands (skip repeat since we already checked it)
	for (const def of COMMANDS) {
		if (def.command === 'repeat') continue;
		if (!def.phases.includes(phase)) continue;

		for (const alias of def.aliases) {
			if (normalized === alias || normalized.includes(alias)) {
				return def.command;
			}
		}
	}

	return null;
}
