export const de: Record<string, string> = {
	// Layout / Nav
	'nav.title': 'AnkiTalk',
	'nav.logout': 'Abmelden',
	'nav.settings': 'Einstellungen',

	// Login
	'login.title': 'AnkiTalk',
	'login.subtitle': 'Sprachgesteuerte Karteikarten-Abfrage',
	'login.loading': 'Laden...',

	// Dashboard
	'dashboard.title': 'Deine Stapel',
	'dashboard.import': '.apkg-Datei importieren',
	'dashboard.importing': 'Importiere...',
	'dashboard.loading': 'Stapel laden...',
	'dashboard.cards': '{count} Karten',
	'dashboard.due': '{count} f\u00e4llig',
	'dashboard.browse': 'Durchsuchen',
	'dashboard.export': 'Exportieren',
	'dashboard.settings': 'Einstellungen',
	'dashboard.stats': 'Statistiken',
	'dashboard.delete': 'L\u00f6schen',
	'dashboard.deleteConfirm': '"{name}" und alle Karten l\u00f6schen?',
	'dashboard.exportFailed': 'Export fehlgeschlagen: {error}',

	// Dashboard - import status
	'import.parsing': '.apkg-Datei wird analysiert...',
	'import.found': '{cards} Karten in {decks} Stapel(n) gefunden. Hochladen...',
	'import.done': '{cards} Karten und {media} Mediendateien importiert.',
	'import.error': 'Fehler: {message}',

	// Onboarding
	'onboarding.welcome': 'Willkommen bei AnkiTalk',
	'onboarding.desc': '\u00dcberpr\u00fcfe deine Anki-Karteikarten freih\u00e4ndig mit Sprachbefehlen. Sprich einfach, um Karten zu bewerten, Antworten zu h\u00f6ren und KI-Erkl\u00e4rungen zu erhalten.',
	'onboarding.steps': 'Exportiere zuerst einen Stapel aus <strong>Anki</strong> als <strong>.apkg-Datei</strong> (Datei \u2192 Exportieren), dann importiere ihn hier.',

	// Review - Start screen
	'review.readyTitle': 'Bereit zur Abfrage',
	'review.startHint': 'Tippe auf den Button, um deine Abfragesitzung zu starten.',
	'review.startReview': 'Abfrage starten',
	'review.startCram': 'Pauken starten',
	'review.filterTags': 'Nach Tags filtern',
	'review.tagPlaceholder': 'tag1, tag2',
	'review.cramMode': 'Paukmodus',
	'review.cramHint': '(F\u00e4lligkeiten & Limits ignorieren)',
	'review.cramStateFilter': 'Pauk-Statusfilter',
	'review.allStates': 'Alle Status',
	'review.newOnly': 'Nur neue',
	'review.learningOnly': 'Nur lernende',
	'review.reviewOnly': 'Nur wiederholende',
	'review.showHelp': 'Sprachbefehle & Tastenkombinationen anzeigen',
	'review.hideHelp': 'Sprachbefehle & Tastenkombinationen ausblenden',

	// Review - Help commands
	'help.answer': 'antwort / zeig',
	'help.answerDesc': 'Antwort anzeigen',
	'help.hint': 'hinweis / tipp',
	'help.hintDesc': 'Erste W\u00f6rter h\u00f6ren',
	'help.ratings': 'nochmal / schwer / gut / einfach',
	'help.ratingsDesc': 'Bewerten',
	'help.repeat': 'wiederholen / nochmal bitte',
	'help.repeatDesc': 'Nochmal h\u00f6ren',
	'help.explain': 'erkl\u00e4r / warum',
	'help.explainDesc': 'KI-Erkl\u00e4rung anfordern',
	'help.stop': 'stopp / aufh\u00f6ren',
	'help.stopDesc': 'Sitzung beenden',

	// Review - Active session
	'review.muteAudio': 'Audio stumm',
	'review.unmuteAudio': 'Audio ein',
	'review.muteMic': 'Mikrofon stumm',
	'review.unmuteMic': 'Mikrofon ein',
	'review.hint': 'Hinweis',
	'review.explain': 'Erkl\u00e4ren',
	'review.suspend': 'Aussetzen',
	'review.stop': 'Sitzung beenden',
	'review.showAnswer': 'Antwort zeigen',
	'review.undo': 'R\u00fcckg\u00e4ngig',
	'review.cardSuspended': 'Karte ausgesetzt',
	'review.waitingCard': 'Karte kommt in {seconds}s zur\u00fcck...',

	// Review - Ratings
	'rating.again': 'Nochmal',
	'rating.hard': 'Schwer',
	'rating.good': 'Gut',
	'rating.easy': 'Einfach',

	// Review - Session complete
	'session.completeTitle': 'Sitzung abgeschlossen',
	'session.cardsReviewed': 'Karten abgefragt',
	'session.duration': 'Dauer',
	'session.backToDashboard': 'Zur\u00fcck zur \u00dcbersicht',

	// Deck Settings
	'settings.title': 'Einstellungen',
	'settings.dashboard': '\u00dcbersicht',
	'settings.loading': 'Laden...',
	'settings.newPerDay': 'Neue Karten pro Tag',
	'settings.maxReviews': 'Max. Wiederholungen pro Tag',
	'settings.retention': 'Gew\u00fcnschte Merkrate: {pct}%',
	'settings.retentionHelper': 'H\u00f6her = mehr Wiederholungen, aber bessere Erinnerung. Standard 90%.',
	'settings.maxInterval': 'Max. Intervall (Tage)',
	'settings.maxIntervalYears': '{years} Jahre',
	'settings.maxIntervalDays': '{days} Tage',
	'settings.leechThreshold': 'Blutegel-Schwelle (R\u00fcckf\u00e4lle)',
	'settings.leechHelper': 'Karten mit so vielen R\u00fcckf\u00e4llen werden automatisch ausgesetzt.',
	'settings.learningSteps': 'Lernschritte (Minuten)',
	'settings.learningStepsHelper': 'Kommagetrennt. Karten durchlaufen diese Schritte vor dem Abschluss. Standard: 1, 10',
	'settings.relearningSteps': 'Wiederlernschritte (Minuten)',
	'settings.relearningStepsHelper': 'Schritte f\u00fcr vergessene Karten. Standard: 10',
	'settings.save': 'Speichern',
	'settings.saving': 'Speichere...',
	'settings.saved': 'Gespeichert',
	'settings.saveFailed': 'Speichern fehlgeschlagen',
	'settings.loadFailed': 'Einstellungen konnten nicht geladen werden',
	'settings.dangerZone': 'Gefahrenzone',
	'settings.resetTitle': 'Fortschritt zur\u00fccksetzen',
	'settings.resetHelper': 'Alle Karten werden auf Neu gesetzt, alle Abfragen werden gel\u00f6scht.',
	'settings.resetButton': 'Zur\u00fccksetzen',
	'settings.resetConfirm': 'Gesamten Fortschritt f\u00fcr "{name}" zur\u00fccksetzen? Dies kann nicht r\u00fcckg\u00e4ngig gemacht werden.',
	'settings.resetDone': 'Fortschritt zur\u00fcckgesetzt',

	// App Settings
	'appSettings.title': 'App-Einstellungen',
	'appSettings.language': 'Sprache',
	'appSettings.dashboard': '\u00dcbersicht',

	// Card Browser
	'cards.title': 'Karten',
	'cards.dashboard': '\u00dcbersicht',
	'cards.search': 'Karten suchen...',
	'cards.newCard': 'Neue Karte',
	'cards.loading': 'Laden...',
	'cards.empty': 'Keine Karten gefunden.',
	'cards.selected': '{count} ausgew\u00e4hlt',
	'cards.suspendAction': 'Aussetzen',
	'cards.unsuspendAction': 'Fortsetzen',
	'cards.front': 'Vorderseite',
	'cards.state': 'Status',
	'cards.due': 'F\u00e4llig',
	'cards.reps': 'Wdh.',
	'cards.lapses': 'R\u00fcckf\u00e4lle',
	'cards.prev': 'Zur\u00fcck',
	'cards.next': 'Weiter',

	// Card states
	'state.all': 'Alle',
	'state.new': 'Neu',
	'state.learning': 'Lernend',
	'state.review': 'Wiederholung',
	'state.suspended': 'Ausgesetzt',
	'state.unknown': 'Unbekannt',

	// Stats
	'stats.title': 'Statistiken',
	'stats.dashboard': '\u00dcbersicht',
	'stats.loading': 'Laden...',
	'stats.cardStates': 'Kartenstatus',
	'stats.retentionRate': 'Merkrate',
	'stats.retentionLabel': 'der reifen Karten-Abfragen bestanden',
	'stats.noRetention': 'Noch nicht gen\u00fcgend reife Karten-Abfragen',
	'stats.dailyReviews': 'T\u00e4gliche Abfragen',
	'stats.noReviews': 'Keine Abfragen in diesem Zeitraum',

	// Common
	'common.loading': 'Laden...',
	'common.error': 'Fehler',
};
