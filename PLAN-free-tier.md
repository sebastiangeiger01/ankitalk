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
| Sprachsteuerung | **noch zu entscheiden** (§7) | – |
| Erklären / Hinweis | nicht enthalten (BYOK) | 0 $ |
| Karten erstellen, MCP, Review, FSRS, Import/Export, Statistiken | unbegrenzt | 0 $ |

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

| # | Schritt | Aufwand |
|---|---|---|
| 1 | Kostenerfassung korrigieren (§5.5) | XS–S |
| 2 | Migration + `resolveKey` + Platform-Keys (§5.1/5.2) | S |
| 3 | Quota-Modul + Durchsetzung (§5.3/5.4) | M |
| 4 | Onboarding + Einstellungen + Quotenanzeige (§5.6/5.7) | M |

Nach Schritt 2 kann sich deine Schwester bereits **ohne eigene Keys** anmelden und lernen —
Schritte 3–4 sichern den Betrieb für Fremde ab. Bei Bedarf ist also nach Schritt 2 schon
etwas Nutzbares da.

## 7. Zu entscheiden: Grenze für die Sprachsteuerung

Der einzige offene Punkt. Da STT ~29× teurer ist als TTS, braucht es eine Grenze — die Frage
ist welche Art:

| Variante | Umsetzung | Bewertung |
|---|---|---|
| **Sitzungsminuten/Monat** (z. B. 300) | braucht Dauererfassung aus §5.5 | am ehrlichsten, deckelt genau die Kosten |
| **Sitzungen/Monat** (z. B. 40) | trivial, zählt nur Token-Ausgaben | grob — eine lange Sitzung zählt wie eine kurze |
| **Vorerst offen lassen** | nichts zu tun | Deepgram-Guthaben als Puffer (~43 Nutzermonate), Daten sammeln, später justieren |

Empfehlung: **Sitzungsminuten**, weil §5.5 die Dauererfassung ohnehin einführt und es die
einzige Variante ist, die den tatsächlichen Kostenposten trifft. 300 Minuten/Monat sind
10 Minuten täglich — für den Anlassfall reichlich, und im Worst Case 2,31 $/Nutzer.
