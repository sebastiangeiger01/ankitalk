import { describe, it, expect } from 'vitest';
import { matchCommand } from './commands';

describe('matchCommand', () => {
	describe('German "nochmal" vs "noch mal" (ElevenLabs splits the word)', () => {
		it('matches the joined spelling as the Again rating', () => {
			expect(matchCommand('Nochmal', 'rating')).toBe('again');
		});

		it('matches the split spelling as the Again rating', () => {
			expect(matchCommand('Noch mal', 'rating')).toBe('again');
		});

		it('matches the split spelling with trailing punctuation', () => {
			expect(matchCommand('Noch mal.', 'rating')).toBe('again');
		});

		it('keeps "nochmal bitte" as repeat, not a rating', () => {
			expect(matchCommand('Nochmal bitte', 'rating')).toBe('repeat');
		});

		it('keeps the split "noch mal bitte" as repeat, not a rating', () => {
			expect(matchCommand('Noch mal bitte', 'rating')).toBe('repeat');
		});

		it('treats "noch einmal" as repeat in both phases', () => {
			expect(matchCommand('noch einmal', 'question')).toBe('repeat');
			expect(matchCommand('noch einmal', 'rating')).toBe('repeat');
		});

		it('does not rate in the question phase (Again only exists while rating)', () => {
			expect(matchCommand('Noch mal', 'question')).toBeNull();
			expect(matchCommand('Nochmal', 'question')).toBeNull();
		});

		it('still repeats in the question phase with the polite form', () => {
			expect(matchCommand('Noch mal bitte', 'question')).toBe('repeat');
		});
	});

	describe('English "again" collision handling', () => {
		it('bare "again" rates Again', () => {
			expect(matchCommand('again', 'rating')).toBe('again');
		});

		it('"again please" and "say again" are repeat', () => {
			expect(matchCommand('again please', 'rating')).toBe('repeat');
			expect(matchCommand('say again', 'rating')).toBe('repeat');
		});
	});

	describe('normalization and whole-word matching', () => {
		it('strips trailing smart_format punctuation', () => {
			expect(matchCommand('Gut.', 'rating')).toBe('good');
			expect(matchCommand('Easy!', 'rating')).toBe('easy');
		});

		it('does not match aliases inside longer words', () => {
			// "gut" inside "argument" must not rate Good
			expect(matchCommand('argument', 'rating')).toBeNull();
			// "ende" inside "spende" must not stop the session
			expect(matchCommand('spende', 'rating')).toBeNull();
		});

		it('matches aliases as whole words inside longer utterances', () => {
			expect(matchCommand('das war gut', 'rating')).toBe('good');
		});

		it('returns null for empty or unrelated transcripts', () => {
			expect(matchCommand('', 'rating')).toBeNull();
			expect(matchCommand('Das Wetter ist heute super', 'rating')).toBeNull();
		});
	});

	describe('phase gating', () => {
		it('answer/hint only in the question phase', () => {
			expect(matchCommand('antwort', 'question')).toBe('answer');
			expect(matchCommand('antwort', 'rating')).toBeNull();
			expect(matchCommand('hinweis', 'question')).toBe('hint');
			expect(matchCommand('hinweis', 'rating')).toBeNull();
		});

		it('explain only in the rating phase', () => {
			expect(matchCommand('warum', 'rating')).toBe('explain');
			expect(matchCommand('warum', 'question')).toBeNull();
		});

		it('stop works in both phases', () => {
			expect(matchCommand('aufhören', 'question')).toBe('stop');
			expect(matchCommand('stopp', 'rating')).toBe('stop');
		});
	});
});
