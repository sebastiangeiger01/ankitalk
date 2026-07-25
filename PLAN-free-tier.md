# Umsetzungsplan: Free-Tier (ohne Billing)

> Ziel: Anmelden und sofort loslernen — ohne API-Keys, ohne Bezahlung. Pro/Max und Stripe
> kommen später. Strategischer Rahmen: `PLAN-pricing-tiers.md`.
>
> **Status: Planung, noch nichts implementiert.**

## 1. Wichtiger Befund vorab: STT ist der Kostentreiber, nicht TTS

Die Quote „50 vertonte Karten/Monat" aus dem Zielbild deckelt den **falschen** Posten:

| Posten | Free-Verbrauch/Monat | Kosten |
|---|---|---:|
| TTS (50 Karten ≈ 10.000 Zeichen, OpenAI) | gedeckelt | **0,16 $** |
| STT (Dauer-Stream, 30 Sitzungen à 20 Min) | **ungedeckelt** | **4,62 $** |

**Spracherkennung kostet ~29× so viel wie Sprachausgabe** — und war im Zielbild als einziger
Posten ohne Obergrenze geplant. Ein Free-Tier, der TTS sorgfältig deckelt und STT offen
lässt, deckelt an der falschen Stelle.

Grund: `src/lib/client/deepgram.ts:108` holt **einen Token pro Sitzung**, danach läuft ein
WebSocket über die volle Sitzungsdauer. Abgerechnet wird jede gestreamte Minute — auch die,
in denen niemand spricht.

### Zweiter Befund: die STT-Nutzungserfassung untertreibt massiv

`src/routes/api/deepgram-token/+server.ts:38` protokolliert pauschal **60 Sekunden pro
Token-Ausgabe**:

```ts
logUsage(db, userId, 'deepgram', 'stt_token', 60, calculateSttCost(60));
```

Eine 20-Minuten-Sitzung wird also als 1 Minute verbucht — **~20× zu niedrig**. Zusammen mit
den falschen TTS-Raten (`PLAN-pricing-tiers.md` §8) ist die gesamte Kostenanzeige unbrauchbar.
Das muss vor der Quota-Einführung stimmen, sonst deckeln wir gegen falsche Zahlen.

## 2. Umfang dieses Schritts

**Enthalten:**
- `user_plan`-Tabelle, alle Nutzer standardmäßig `free`
- Platform-Keys für TTS und STT (Nutzer braucht keine eigenen Keys mehr)
- Quoten für TTS **und** STT
- Onboarding ohne API-Key-Schritt
- Korrekte Kostenerfassung als Voraussetzung

**Nicht enthalten:** Stripe, Umsatzsteuer, Pro/Max, Tutor, Listen-Feature, VAD,
lokale Spracherkennung.

**BYOK bleibt unverändert funktionsfähig** und umgeht jede Quote.

## 3. Provider-Wahl für v1

**OpenAI TTS + Deepgram STT** — beide sind bereits vollständig implementiert
(`synthesizeOpenAISpeech`, `/api/deepgram-token`). Es ändert sich nur die Herkunft des
Schlüssels: Platform statt Nutzer.

Damit ist der Hörtest (`PLAN-pricing-tiers.md` §9, Schritt 0) **kein Blocker mehr** — der
Provider ist über `tts_provider` austauschbar, und ein Wechsel auf Voxtral bleibt jederzeit
möglich, ohne die Tier-Logik anzufassen.

Deepgram gibt Neukonten **200 $ nicht verfallendes Startguthaben** (≈430 Stunden). Das ist
die Anschubfinanzierung für die ersten Nutzer: bei ungedeckeltem Dauer-Stream reicht es für
~43 Nutzermonate, mit Deckelung entsprechend länger.

## 4. Quoten

| Ressource | Free-Grenze | Worst-Case-Kosten |
|---|---|---:|
| Vertonte Karten | 50 / Monat | 0,16 $ |
| Sprachsteuerung | keine harte Grenze — Kosten sinken über VAD (§4a) | ~0,5–1,4 $ |
| Erklären / Hinweis | nicht enthalten (BYOK) | 0 $ |
| Karten erstellen, MCP, Review, FSRS, Import/Export, Statistiken | unbegrenzt | 0 $ |

## 4a. VAD: viel kleiner als gedacht — der Mechanismus existiert bereits

Entscheidung: Statt die Sprachsteuerung zu deckeln, wird die Ursache behoben. Zwei Funde
machen das erheblich einfacher als im Zielbild angenommen:

**1. Deepgram rechnet nach gesendetem Audio ab, nicht nach Verbindungsdauer.** Ein offener
WebSocket ohne Audio kostet nichts, KeepAlive-Nachrichten ebenfalls nicht. Es genügt also,
*während Stille keine Frames zu senden* — die Verbindung darf offen bleiben.

**2. Genau dieser Mechanismus ist schon gebaut und in Produktion erprobt.**
`src/lib/client/deepgram.ts` hat bereits:

```ts
processor.onaudioprocess = (event) => {
    if (paused || socket?.readyState !== WebSocket.OPEN) return;   // :47–48
    …
}
```
und ein `pause()` (:205), das `paused` setzt **und** ein KeepAlive-Intervall startet, sowie
`resume()` (:224), das es wieder abräumt.

**VAD ist damit im Kern: das manuelle `paused`-Flag durch eine automatische Entscheidung im
selben Callback ersetzen.** Kein neuer Endpunkt, kein Workers AI, kein Whisper, kein
40-MB-Modell.

### Warum das die ursprünglich geplante Variante schlägt

| | Zielbild-Variante (VAD + Whisper-Batch) | **Diese Variante (VAD-Gating)** |
|---|---|---|
| Neuer Endpunkt / Provider | ja | **nein** |
| Modell-Download | ~40 MB | **0** |
| Latenz | ~1 s (Batch nach Sprechende) | **~300 ms (unverändert)** |
| Kommt BYOK-Nutzern zugute | nein | **ja, sofort** |

Die Latenz bleibt also bei Deepgrams `endpointing: 300` — die Sprachsteuerung wird nicht
langsamer, nur billiger.

### Umsetzung: energiebasiert zuerst

`connectAudioProcessor` nutzt `createScriptProcessor` (:43), **nicht** AudioWorklet — läuft
also auf iOS bereits nachweislich. Der Callback bekommt den PCM-Puffer ohnehin in die Hand:

1. RMS des Puffers berechnen (wenige Zeilen, keine Abhängigkeit)
2. Sprache/Stille mit Hysterese halten, plus Nachlauf (~1 s weitersenden nach Sprechende,
   damit Wortenden nicht abgeschnitten werden)
3. **Vorlauf-Ringpuffer** (~300 ms), der beim Auslösen vorangestellt wird — sonst fehlt der
   Wortanfang. Das ist der einzige wirklich neue Baustein.
4. Während Stille: KeepAlive senden (Mechanismus vorhanden)

Echo- und Rauschunterdrückung sind bereits aktiv (`echoCancellation`, `noiseSuppression`
bei `getUserMedia`), das Signal ist also vorgereinigt — gute Voraussetzung für ein
Energieverfahren.

**Risikoprofil ist günstig:** Löst die Erkennung fälschlich aus, wird etwas mehr Audio
gesendet — nur Kosten, kein Funktionsverlust. Verpasst sie leise Sprache, geht ein Befehl
verloren; dagegen helfen niedrige Schwelle, großzügiger Vorlauf und Nachlauf.

Erwartete Ersparnis: ~70–80 % (statt ~90 % mit Silero), also **4,62 $ → ~1,00–1,40 $**.
Bei ~100 Zeilen ohne neue Abhängigkeit und ohne iOS-Risiko ist das der richtige erste Schritt.

**Ausbaustufe**, falls das Energieverfahren zu undicht ist: Silero VAD (ONNX/WASM) hinter
derselben Schnittstelle — dann greifen die iOS-Risiken aus `PLAN-pricing-tiers.md` §4, aber
erst dann und nur, wenn Messdaten es rechtfertigen.

Dasselbe Muster gilt für `elevenlabs.ts` (Scribe-Pfad) und sollte dort gespiegelt werden.

## 5. Technische Umsetzung

### 5.1 Migration `0023_user_plan.sql`
```sql
CREATE TABLE user_plan (
  user_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Zählt vertonte Karten pro Monat. Eine Karte zählt genau einmal, egal wie oft
-- Vorder-/Rückseite synthetisiert werden — und nie erneut in Folgemonaten.
CREATE TABLE voiced_cards (
  user_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  month TEXT NOT NULL,              -- 'YYYY-MM'
  PRIMARY KEY (user_id, card_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_voiced_cards_month ON voiced_cards(user_id, month);
```

Fehlende `user_plan`-Zeile wird wie `tier = 'free'` behandelt — kein Backfill nötig.

### 5.2 Platform-Keys
- Cloudflare-Secrets `PLATFORM_OPENAI_API_KEY`, `PLATFORM_DEEPGRAM_API_KEY`
- `src/app.d.ts`: beide als optional in `App.Platform.env` ergänzen
- **`src/lib/server/user-keys.ts`**: neue Funktion
  ```ts
  resolveKey(db, userId, service, env) → { key, source: 'user' | 'platform' } | null
  ```
  Nutzer-Key zuerst (umgeht Quote), sonst Platform-Key. Alle Aufrufer von `getUserApiKey`
  in den Audio-Endpunkten wechseln darauf.

### 5.3 Quota-Modul `src/lib/server/quota.ts` (neu)
- `checkVoicedCardQuota(db, userId, cardId, tier)` — prüft und registriert eine Karte
- `checkSttQuota(db, userId, tier)` — prüft die Sprachsteuerungsgrenze
- Grenzen als eine Konstante pro Tier, analog zu `RATE_LIMITS` in `rate-limit.ts`

### 5.4 Durchsetzung
- **`/api/tts`**: nach allen Cache-Schichten, direkt vor dem Provider-Aufruf (dort, wo heute
  `enforceRateLimit` steht, ~Zeile 263). Damit zählen nur echte Kosten — Edge-, R2- und
  In-Flight-Treffer bleiben unbegrenzt. Der Endpunkt nimmt bereits `deckId` entgegen;
  `cardId` kommt analog dazu, der Aufrufer in `audio.ts` reicht sie durch.
- **`/api/deepgram-token`**: Quotenprüfung vor der Token-Ausgabe.

Nur bei `source: 'platform'` wird die Quote geprüft — eigene Keys bleiben unbegrenzt.

### 5.5 Kostenerfassung korrigieren (Voraussetzung)
- `usage.ts`: TTS-Raten berichtigen (OpenAI 15 $/1M statt 0,6)
- STT: tatsächliche Sitzungsdauer erfassen statt pauschal 60 s. Der Client kennt die Dauer;
  ein kleiner `POST /api/stt/session-end` mit der Dauer genügt und liefert zugleich die
  Daten, um die Quote später sauber zu justieren.

### 5.6 Onboarding und Einstellungen
- `OnboardingChecklist.svelte`: Schritt „API-Keys hinterlegen" entfällt für Free-Nutzer;
  `hasRequiredKeys` wird für sie konstant `true`. Übrig bleibt „Deck importieren → Erste
  Sitzung starten".
- Einstellungen: API-Key-Bereich wird zu einem eingeklappten „Eigene Keys verwenden
  (optional)"-Abschnitt statt einer Pflichtsektion.
- Neue Anzeige: verbrauchte Quote („12 von 50 vertonten Karten diesen Monat").

### 5.7 Verhalten bei erschöpfter Quote
Vorschlag: **keine harte Sperre.** Bereits vertonte Karten bleiben abspielbar (sie liegen im
Cache), neue Karten werden stumm angezeigt, mit einem klaren Hinweis. Die Lernsitzung
funktioniert also weiter — nur ohne neue Stimme. Das ist deutlich freundlicher als eine
blockierte Sitzung und erhält den FSRS-Fluss.

## 6. Reihenfolge

| # | Schritt | Aufwand | Ergebnis |
|---|---|---|---|
| 1 | Kostenerfassung korrigieren (§5.5) | XS–S | Zahlen stimmen, bevor wir gegen sie deckeln |
| 2 | Migration + `resolveKey` + Platform-Keys (§5.1/5.2) | S | **Schwester kann sich ohne eigene Keys anmelden und lernen** |
| 3 | VAD-Gating in `deepgram.ts` (§4a) | S–M | STT-Kosten ~70–80 % runter, kommt auch BYOK zugute |
| 4 | TTS-Quota + Durchsetzung (§5.3/5.4) | M | Betrieb für Fremde abgesichert |
| 5 | Onboarding + Einstellungen + Quotenanzeige (§5.6/5.7) | M | Einrichtungshürde weg |

Nach **Schritt 2** ist der eigentliche Anlassfall erledigt. Die Schritte 3–5 machen daraus
etwas, das man Fremden geben kann.

## 7. Offene Punkte

- **Höhe der TTS-Quote.** 50 Karten/Monat ist gesetzt, sollte aber nach den ersten echten
  Nutzungsdaten überprüft werden — mit korrigierter Erfassung (§5.5) sehen wir erstmals
  belastbare Zahlen.
- **Silero-Ausbaustufe** nur, falls das Energieverfahren messbar zu undicht ist (§4a).
- **Missbrauchsschutz** bei offener Registrierung: Die bestehenden `RATE_LIMITS` decken
  Burst-Missbrauch ab, aber ein Konto pro E-Mail ohne weitere Hürde lädt zu Mehrfachkonten
  ein. Relevant erst, wenn die Registrierung wirklich öffentlich ist — vorher nicht lösen.
