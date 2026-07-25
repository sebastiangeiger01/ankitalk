# Plan: Studenten-taugliches Pricing (Free / Pro / Max)

> Ausgangsfrage: Wie kann eine Studentin AnkiTalk kostenlos oder sehr günstig nutzen,
> statt heute ~42 €/Monat (ElevenLabs Creator 22 € + Claude Pro 20 €) zu zahlen?

## 1. Befund: Das Problem ist nicht „Audio ist teuer", sondern „ElevenLabs ist teuer"

AnkiTalk ist heute vollständig BYOK. Es gibt im Code **keinerlei** Tier-, Plan- oder
Billing-Konzept — nur `user_api_keys` (verschlüsselt pro Nutzer) und `api_usage`
(Kostenprotokoll). Der Einstieg zwingt Nutzer damit in fremde Abo-Verträge.

### Effektiver Preis pro 1M Zeichen TTS

| Option | $ / 1M Zeichen | Deutsch? | Status |
|---|---:|:---:|---|
| ElevenLabs Flash v2.5 (Creator 22 $ / 121k Credits, 0,5 Cr/Zeichen) | **≈ 91** | ✅ | implementiert, heutiger Default |
| Deepgram Aura-2 (Workers AI) | 30 | ❌ nur EN/ES | – |
| **Voxtral TTS (Mistral)** | **16** | ✅ | **gewählt** |
| Azure Neural | 16 | ✅ | – |
| OpenAI tts-1 | 15 | ✅ | implementiert |
| Google Standard (nicht-neural) | 4 | ✅ | – |
| MeloTTS (Workers AI) | ≈ 0,22 | ❌ **kein Deutsch** | – |

**ElevenLabs ist ~5,7× teurer pro Zeichen als Voxtral.** Genau daraus entsteht die gesamte
Ersparnis — nicht daraus, Voxtral gegenüber OpenAI/Azure zu wählen (die liegen preislich
gleichauf; Voxtral gewinnt über Features, siehe §3).

> ⚠️ **Cloudflare Workers AI fällt für TTS aus.** MeloTTS wäre mit ~0,22 $/1M Zeichen
> konkurrenzlos, kann aber nur EN/ES/FR/ZH/JP/KO — **kein Deutsch**. Aura-1 ist Englisch-only,
> Aura-2 nur EN/ES. Für die Zielnutzerin ist kein einziges Workers-AI-**TTS**-Modell brauchbar.
> Für **STT** gilt das nicht — Whisper ist mehrsprachig und in Deutsch sehr gut (§4).

### Der entscheidende ökonomische Punkt: TTS-Kosten sind einmalig, nicht monatlich

Der Cache in `src/routes/api/tts/+server.ts` (Edge → R2 → In-Flight-Dedupe → KV-Lock)
synthetisiert jeden Kartentext **genau einmal**. Wiederholungen sind ab dann gratis.
Kosten skalieren also mit *neuen Karten*, nicht mit Lernvolumen.

Beispiel: 2.000 Karten × ~200 Zeichen = 400.000 Zeichen einmalig.

| Provider | Einmalig fürs ganze Deck |
|---|---:|
| ElevenLabs Flash (Creator) | ≈ 36 $ *(1,65 Monatskontingente)* |
| Voxtral TTS | **6,40 $** |
| OpenAI tts-1 | 6,00 $ |

## 2. Bug: Die Kostenanzeige ist grob falsch

`src/lib/server/usage.ts` rechnet mit Raten, die nicht stimmen:

```ts
openai_tts:     0.6 / 1_000_000,   // real: 15 $/1M  → Faktor 25 zu niedrig
elevenlabs_tts: 0.36 / 1_000_000,  // real: ≈91 $/1M → Faktor 252 zu niedrig
```

Die „Usage & Costs"-Anzeige ist damit faktisch Fiktion — und lässt ausgerechnet ElevenLabs
am günstigsten aussehen. Unabhängig von jeder Tier-Frage ein Fehler, der zuerst weg sollte.

Konzeptionell zusätzlich: Für **Abo-Provider** ist ein USD-Betrag die falsche Metrik — dort
zählt „Credits / Monatskontingent" (das zeigt `ElevenLabsSettings.svelte` bereits korrekt).
USD nur für Pay-as-you-go.

## 3. Die drei Tiers (entschieden)

Leitgedanke: **AnkiTalk Free ist ein besseres Anki mit KI-Kartenerstellung.
Bezahlt wird die Stimme.**

### Free — 0 €
- **Unbegrenzt Karten erstellen**, inkl. **MCP-Zugang** (Karten aus Studien-PDFs mit dem
  eigenen KI-Tool). Kostet uns nichts — der Nutzer bringt sein Claude/Cowork mit, es laufen
  nur D1-Zugriffe. Das Alleinstellungsmerkmal bleibt gratis.
- **50 vertonte Karten pro Monat.** Cache-Treffer zählen *nicht* — einmal vertonte Karten
  bleiben für immer frei abspielbar.
- **Sprachsteuerung inklusive**, voll hands-free (§4).
- Unbegrenzt und grenzkostenfrei: Review, FSRS, Import/Export, Kartenbrowser, Statistiken,
  Deck-Settings.
- Nicht enthalten: Erklären/Hinweis, Listen-Feature, Tutor.

### Pro — 4 €/Monat
- **200.000 Zeichen/Monat** (≈ 1.000 neue Karten) in Voxtral-Qualität.
- Erklären/Hinweis inklusive.
- **Listen-Feature** (Dokumente → Audio) mit eigener Quote — der zeichenintensivste Teil
  des Produkts, gehört deshalb nicht in Free.
- Flüssigere Spracherkennung (Voxtral Realtime statt Whisper-Batch, §4).

### Max — 12 €/Monat
- Alles aus Pro, plus **60 Tutor-Minuten/Monat** über unseren ElevenLabs-Account —
  **ohne jedes Setup**.
- **Voice-Cloning**: eigene Stimme aus 3 Sekunden Referenzaudio (Voxtral-Feature).
- Größere TTS-Quote (~300.000 Zeichen/Monat).

> **Abweichung von deinem Vorschlag — bitte prüfen:** Du wolltest ElevenLabs für Max.
> Ich empfehle, ElevenLabs in Max **nur für den Tutor** zu nutzen und das Karten-TTS auch
> dort bei Voxtral zu lassen. Grund: ElevenLabs-TTS kostet ~91 $/1M Zeichen — allein
> 100.000 Zeichen wären 9,10 $ und würden die 12 € fast aufbrauchen. Voxtral kann
> Voice-Cloning zum sechstel Preis. ElevenLabs ist nur beim **Conversational-AI-Tutor**
> wirklich unersetzlich; genau dort behalten wir es.

### BYOK bleibt auf jeder Stufe erhalten
Wer eigene Keys hinterlegt, umgeht jede Quote und zahlt direkt beim Provider. Der heutige
Power-User-Pfad kostet uns nichts und sollte **nicht** abgeschafft, sondern von der Pflicht
zur Option werden.

## 4. Sprachsteuerung: Was VAD ist, und warum hands-free erhalten bleibt

**VAD = Voice Activity Detection. Das ist ausdrücklich kein Push-to-Talk.** Niemand drückt
etwas. Das Mikrofon bleibt durchgehend an — genau wie heute.

Der Unterschied liegt nur darin, *was nach oben geschickt und abgerechnet wird*:

- **Heute:** Das Mikro streamt die komplette Sitzung zum Provider. Eine 20-Minuten-Sitzung
  wird als 20 Minuten Audio abgerechnet — obwohl real vielleicht 90 Sekunden gesprochen
  wurden („gut", „nochmal", „zeigen").
- **Mit VAD:** Ein kleines neuronales Netz (Silero VAD, ~1–2 MB ONNX über die Web Audio API)
  läuft lokal im Browser auf dem Mikrofonsignal. Es erkennt, *wann* jemand spricht,
  schneidet die Äußerung mit etwas Vorlauf heraus und schickt nur diese 1–2 Sekunden zur
  Transkription. Stille verlässt das Gerät nie.

Für die Nutzerin ändert sich nichts: sprechen, Befehl wird ausgeführt. Für uns sinkt die
abgerechnete Audiomenge um ~90 %.

**Ehrlicher Nachteil:** VAD muss das Ende einer Äußerung bestätigen (~300–600 ms Stille),
danach folgt die Transkription. Vom Ende des Sprechens bis zur Ausführung vergehen so
~0,7–1,2 s, gegenüber ~300 ms bei durchgehendem Streaming. Für kurze Kommandos ist das gut
benutzbar, aber spürbar — und genau daraus entsteht ein echter, *hörbarer* Tier-Unterschied:

| Tier | STT | Preis | Reaktion |
|---|---|---:|---|
| Free | Workers AI Whisper (VAD-gated) | 0,0005 $/Min | ~1 s |
| Pro / Max | Voxtral Realtime (VAD-gated) | 0,006 $/Min | ~0,3 s |

> **Wichtig:** VAD wird auch in Pro/Max eingesetzt. Voxtral Realtime *ungated* würde bei
> 20 Min × 30 Sitzungen = 600 Min/Monat **3,60 $** kosten und die 4 €-Marge fast vollständig
> aufzehren. VAD-gated sind es ~37 Min/Monat → **0,22 $**. Die Realtime-Variante bringt
> trotzdem den Latenzvorteil, weil während des Sprechens transkribiert wird statt danach.

**Risiko, das auf Staging zu prüfen ist:** VAD braucht AudioWorklet + WebAssembly. Beides
ist auf iOS Safari ab 14.1/16.4 unterstützt, und `getUserMedia` funktioniert in eurer PWA
nachweislich (siehe `RESEARCH.md`). Die Bibliotheksdoku bestätigt iOS aber nicht explizit —
das muss real getestet werden. **Fallback**, falls es klemmt: energiebasierte Erkennung über
`AnalyserNode` (RMS-Schwellwert). Deutlich weniger robust bei Straßenlärm, aber ohne WASM
und garantiert iOS-tauglich.

## 5. Randbedingung: kein Rückfall auf Browser-Sprachausgabe

Naheliegend wäre, Free mit `speechSynthesis` zu bauen (kostenlos, überall deutsche Stimmen).
**Das würde den Kern des Produkts zerstören:** Auf iOS pausiert `speechSynthesis`, sobald der
Bildschirm gesperrt wird. Vorlesen beim Spazierengehen oder Pendeln — der eigentliche Zweck
von AnkiTalk — funktioniert dann nicht.

`src/lib/client/audio.ts` spielt bewusst MP3s über ein einzelnes, per Nutzergeste entsperrtes
`HTMLAudioElement` ab (`unlockAudioForGesture`). Das läuft bei gesperrtem Bildschirm weiter.
Serverseitiges TTS ist deshalb auch im Free-Tier richtig — und laut §1 ohnehin billig.

## 6. Wirtschaftlichkeit

Alle Zahlen pro Nutzer und Monat.

| | Free | Pro (4 € ≈ 4,30 $) | Max (12 € ≈ 13 $) |
|---|---:|---:|---:|
| TTS | 10k Zeichen → **0,16 $** | 200k → max **3,20 $** | 300k → max **4,80 $** |
| STT (VAD-gated) | 0,02 $ | 0,22 $ | 0,22 $ |
| Tutor (0,08 $/Min) | – | – | 60 Min → **4,80 $** + LLM ~0,50 $ |
| **Summe (Vollausnutzung)** | **0,18 $** | **3,62 $** | **10,32 $** |
| **Marge** | −0,18 $ | +0,68 $ | +2,68 $ |

Typische Nutzung liegt deutlich unter Vollausnutzung, weil der Cache Wiederholungen gratis
macht — die realistische Marge ist bei Pro eher 2–3 $.

**Zwei Dinge im Auge behalten:**

1. **Pro ist bei Vollausnutzung knapp.** Die Quote von 200.000 Zeichen ist bewusst so
   gewählt, dass sie bei 4 € gerade trägt. Wenn Pro großzügiger werden soll, ist der
   günstigere TTS-Preis der Hebel — Google Standard (4 $/1M) würde die Quote vervierfachen,
   kostet aber hörbar Qualität (nicht-neural) und OAuth2-Integrationsaufwand.
2. **Max hat Sockelkosten.** Tutor-Minuten setzen einen ElevenLabs-Plan voraus: Creator
   22 $/Monat für 275 Minuten. Der *erste* Max-Nutzer kostet uns also 22 $, unabhängig von
   der Nutzung. **Break-even liegt bei 2 Max-Nutzern** (24 € > 22 $); 275 Minuten decken
   ~4 Nutzer à 60 Min. Danach skaliert es sauber (Pro-Plan 99 $ → 1.238 Min ≈ 20 Nutzer).
   → Empfehlung: Max erst öffentlich schalten, wenn Pro läuft, oder anfangs mit Warteliste.

**Free-Tier gesamt:** 100 Nutzer ≈ 18 $/Monat, 1.000 Nutzer ≈ 180 $/Monat. Die
50-Karten-Quote ist das, was diese Zahl unter Kontrolle hält — sie ist kein Detail.

## 7. Technischer Plan

### A. Kostenwahrheit (klein, sofort, unabhängig vom Rest)
- `src/lib/server/usage.ts`: Raten korrigieren, Voxtral-Raten ergänzen.
- Anzeige trennen: Credits/Kontingent für Abo-Provider, USD für Pay-as-you-go.

### B. Voxtral als TTS-Provider
Die Voxtral-API ist **OpenAI-kompatibel**: `POST /v1/audio/speech` mit `model`, `input`,
`voice`, `response_format` (mp3), `speed`, `stream`; Input-Limit 4096 Zeichen — identisch
zum bestehenden `text.slice(0, 4096)`.

- In `src/lib/server/tts.ts` lässt sich `synthesizeOpenAISpeech` fast unverändert
  wiederverwenden: das `openai`-SDK akzeptiert eine abweichende `baseURL`. Neue Funktion
  `synthesizeVoxtralSpeech` als dünner Wrapper, kein neuer HTTP-Client.
- `TtsProvider` in `src/lib/voice.ts` um `'voxtral'` erweitern; `normalizeVoiceSettings`
  behandelt Altzeilen bereits tolerant.
- Cache-Key: `cacheProvider` in `+server.ts` muss `'voxtral'` sauber einschließen, damit
  bestehende Clips nicht kollidieren (das Muster für Legacy-Labels ist dort schon angelegt).
- ⚠️ Latenz prüfen: Time-to-first-audio liegt bei MP3 laut Mistral bei ~3 s (PCM ~0,8 s).
  Der Preload-Mechanismus in `audio.ts` (`audioPreloads`) verdeckt das im Review-Flow
  weitgehend — auf Staging verifizieren, ggf. auf PCM/Opus wechseln.

### C. Tier- und Quota-Fundament
- **Migration** `0023_user_plan.sql`: `user_plan (user_id PK, tier TEXT NOT NULL DEFAULT
  'free', ...)` plus `voiced_cards (user_id, card_id, month, PRIMARY KEY(user_id, card_id))`
  — letztere zählt „vertonte Karten pro Monat" als *distinct card_id*, damit Vorder- und
  Rückseite zusammen eine Karte sind und eine einmal vertonte Karte nie erneut zählt.
- **Platform-Keys** als Cloudflare-Secrets (`PLATFORM_VOXTRAL_API_KEY`,
  `PLATFORM_ELEVENLABS_API_KEY`), analog zu `ENCRYPTION_KEY`; Ergänzung in `src/app.d.ts`.
- **`src/lib/server/quota.ts`** (neu): Monatsverbrauch je Nutzer und Tier.
- **`src/lib/server/user-keys.ts`**: neue Funktion `resolveKey(userId, service)` —
  Nutzer-Key zuerst, sonst Platform-Key, falls der Tier das erlaubt.

### D. Quota-Durchsetzung an der einzig richtigen Stelle
In `src/routes/api/tts/+server.ts` sitzt der Check **nach** allen Cache-Schichten, direkt
vor dem Provider-Aufruf (wo heute `enforceRateLimit` steht, ~Zeile 263). Damit zählt die
Quote automatisch nur echte Kosten — Edge-, R2- und In-Flight-Treffer bleiben unlimitiert.
Diese Struktur ist bereits ideal vorbereitet; `/api/tts` nimmt mit `deckId` sogar schon
Kartenkontext entgegen, `cardId` kommt analog dazu.

### E. STT: VAD + Whisper (Free) / Voxtral Realtime (Pro)
- Client-VAD (Silero via ONNX) schneidet Äußerungen aus; nur diese gehen nach oben.
- Neuer Endpunkt `/api/stt` → Workers AI `@cf/openai/whisper-large-v3-turbo`.
- Sauberer Einstiegspunkt: Das `SpeechClient`-Interface in `src/lib/client/speech.ts`
  existiert bereits, `deepgram.ts` und `elevenlabs.ts` implementieren es — weitere
  Implementierungen fügen sich ohne Umbau ein.

### F. Billing (neu, größter Einzelposten)
Stripe Checkout + Customer Portal, Webhook → `user_plan.tier`. Zusätzlich zu bedenken:
EU-OSS-Umsatzsteuer (Stripe Tax nimmt das weitgehend ab), Kündigungs- und Mahnprozesse,
sowie Verhalten bei Downgrade (Quote sinkt — bereits vertonte Karten bleiben abspielbar,
weil sie im Cache liegen).

### G. Onboarding entrümpeln
- Free-Nutzer sehen **keine** API-Key-Sektion mehr. `OnboardingChecklist.svelte` schrumpft
  auf „Deck importieren → Erste Sitzung starten".
- Die heutige Tutor-Einrichtung ist der eigentliche Usability-Killer:
  `src/lib/server/agent-readiness.ts` kennt **12 Fehlerzustände**, weil jede Nutzerin selbst
  einen ElevenLabs-Agenten anlegen, Auth aktivieren, vier Overrides setzen, einen MCP-Server
  registrieren und zuweisen muss. Mit dem Platform-Account in Max **entfällt das komplett** —
  wir konfigurieren Agent und MCP-Server einmal zentral. Das ist der größte UX-Gewinn des
  ganzen Plans, und `agent-readiness.ts` schrumpft zu einem internen Health-Check.

## 8. Empfohlene Reihenfolge

| # | Schritt | Aufwand | Wirkung |
|---|---|---|---|
| 1 | Kostenraten in `usage.ts` korrigieren | XS | Ehrliche Zahlen als Grundlage |
| 2 | Voxtral-Provider ergänzen (§7B) | S | 5,7× günstigeres TTS, sofort auch für BYOK-Nutzer |
| 3 | VAD + Whisper-STT (§7E) | M | Macht Sprachsteuerung praktisch gratis |
| 4 | Tier + Quota + Platform-Key (§7C/D) | M | Ermöglicht Free-Tier ohne Setup |
| 5 | Onboarding auf Free zuschneiden (§7G) | S | Beseitigt die Einrichtungshürde |
| 6 | Stripe-Billing (§7F) | L | Schaltet Pro frei |
| 7 | Tutor über Platform-Account (§7G) | M | Schaltet Max frei, entfernt 12 Fehlerzustände |

Schritte 1–3 senken die Kosten schon **ohne** Billing und ohne Tier-Logik drastisch — und
sind unabhängig voneinander umsetzbar. Wenn du deiner Schwester schnell helfen willst,
liefern die drei bereits den Großteil: mit Voxtral statt ElevenLabs kostet ein voll vertontes
2.000-Karten-Deck **6,40 $ einmalig statt 22 €/Monat**.

## 9. Offene Punkte

1. **ElevenLabs-TTS in Max** — meine Empfehlung ist, dort Voxtral zu behalten und ElevenLabs
   auf den Tutor zu beschränken (§3). Bitte bestätigen oder widersprechen.
2. **Pro-Quote 200.000 Zeichen** — trägt bei 4 € gerade so. Großzügiger geht nur über einen
   billigeren TTS-Provider oder einen höheren Preis.
3. **Verhalten bei erschöpfter Quote** — harte Sperre oder Rückfall auf eine günstigere
   Stimme? Letzteres ist freundlicher, erfordert aber einen zweiten Provider im Free-Pfad.
4. **Max-Start** — wegen der 22 $-Sockelkosten (§6) erst nach Pro oder mit Warteliste.
