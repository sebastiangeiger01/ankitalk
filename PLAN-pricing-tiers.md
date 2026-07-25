# Zielbild: Studenten-taugliches Pricing (Free / Pro / Max)

> Ausgangsfrage: Wie kann eine Studentin AnkiTalk kostenlos oder sehr günstig nutzen,
> statt heute ~42 €/Monat (ElevenLabs Creator 22 € + Claude Pro 20 €) zu zahlen?
>
> **Status: Planung. Noch nichts implementiert.** Dieses Dokument hält das vollständige
> Zielbild fest; offene Entscheidungen stehen in §10.

## 1. Ausgangslage

AnkiTalk ist heute vollständig BYOK. Es gibt im Code **keinerlei** Tier-, Plan- oder
Billing-Konzept — nur `user_api_keys` (verschlüsselt pro Nutzer) und `api_usage`
(Kostenprotokoll). Der Einstieg zwingt Nutzer in fremde Abo-Verträge, und die aufwendigste
Einrichtung (Tutor) verlangt manuelle Konfiguration in einem fremden Dashboard.

Zwei Dinge sind dabei wirtschaftlich falsch verstanden worden:

1. **Nicht „Audio ist teuer", sondern „das ElevenLabs-Abo ist teuer".** Pro Zeichen liegt
   ElevenLabs um ein Vielfaches über den Alternativen — und das Abo läuft weiter, egal ob
   gelernt wird.
2. **TTS-Kosten fallen einmalig pro Karte an, nicht pro Wiederholung.** Der Cache in
   `src/routes/api/tts/+server.ts` (Edge → R2 → In-Flight-Dedupe → KV-Lock) synthetisiert
   jeden Kartentext genau einmal. Kosten skalieren mit *neuen Karten*, nicht mit Lernvolumen.
   Diese Architektur ist bereits vorhanden und exzellent — sie ist das Fundament, auf dem
   ein kostenloser Tier überhaupt tragfähig wird.

## 2. Preislandschaft (Stand Juli 2026, verifiziert)

> ⚠️ ElevenLabs hat am **7. Mai 2026** Pay-as-you-go eingeführt und die Self-Serve-Preise
> gesenkt (TTS bis −55 %, STT bis −45 %, Agents bis −20 %). Ältere Annahmen im Repo und in
> früheren Überlegungen sind damit überholt.

### Text-to-Speech, $ pro 1M Zeichen

| Option | $ / 1M | Deutsch? | Anmerkung |
|---|---:|:---:|---|
| ElevenLabs Multilingual v2/v3 (PAYG) | 100 | ✅ | höchste Qualität |
| **ElevenLabs Flash/Turbo (PAYG)** | **50** | ✅ | heutiger Default im Code |
| ElevenLabs Flash über Creator-Abo (22 $ / 121k Credits) | ≈ 91 | ✅ | **PAYG ist hier ~2× günstiger als das Abo** |
| Azure Neural | 16 | ✅ | 500k Zeichen/Monat gratis |
| **Voxtral TTS (Mistral)** | **16** | ✅ | EU-Anbieter, OpenAI-kompatible API |
| OpenAI tts-1 | 15 | ✅ | **bereits implementiert** |
| Google Standard (nicht-neural) | 4 | ✅ | hörbar schlechter, OAuth2-Aufwand |
| MeloTTS (Workers AI) | ≈ 0,22 | ❌ **kein Deutsch** | – |

**Voxtral ist ~3,1× günstiger als ElevenLabs Flash**, nicht 5,7× — der Abstand ist durch die
Mai-Preissenkung kleiner geworden als zunächst angenommen.

> **Cloudflare Workers AI fällt für TTS aus.** MeloTTS wäre mit ~0,22 $/1M konkurrenzlos,
> kann aber nur EN/ES/FR/ZH/JP/KO. Aura-1 ist Englisch-only, Aura-2 nur EN/ES. Für die
> Zielnutzerin ist kein einziges Workers-AI-**TTS**-Modell brauchbar. Für **STT** gilt das
> nicht — Whisper ist mehrsprachig und in Deutsch sehr gut.

### Speech-to-Text, $ pro Minute

| Option | $ / Min | Streaming-fähig? |
|---|---:|:---:|
| Workers AI Whisper large-v3-turbo | **0,0005** | ❌ (Batch, siehe §4) |
| Voxtral Mini Transcribe 2 (Batch) | 0,003 | ❌ |
| ElevenLabs Scribe v2 (0,22 $/h) | 0,0037 | ❌ |
| Voxtral Realtime | 0,006 | ✅ echtes Streaming |
| ElevenLabs Scribe v2 Realtime (0,39 $/h) | 0,0065 | ✅ echtes Streaming |

Bemerkenswert: Voxtral Realtime und ElevenLabs Scribe Realtime sind preislich praktisch
identisch. **Das STT-Kostenproblem war nie der Minutenpreis, sondern dass durchgehend
gestreamt wird** (§4).

### Conversational AI (Tutor)

ElevenAgents: **0,08 $/Min**, LLM-Kosten separat. Verfügbar auch über PAYG.

## 3. Die drei Tiers

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
- **200.000 Zeichen/Monat** (≈ 1.000 neue Karten).
- Erklären/Hinweis inklusive.
- **Listen-Feature** (Dokumente → Audio) mit eigener Quote — der zeichenintensivste Teil des
  Produkts, gehört deshalb nicht in Free.
- Flüssigere Spracherkennung (echtes Streaming statt Batch, §4).

### Max — 12 €/Monat
- Alles aus Pro, plus **60 Tutor-Minuten/Monat** über unseren ElevenLabs-Account —
  **ohne jedes Setup**.
- Größere TTS-Quote und die höchste verfügbare Stimmqualität (Provider offen, §10.1).

### BYOK bleibt auf jeder Stufe erhalten
Wer eigene Keys hinterlegt, umgeht jede Quote und zahlt direkt beim Provider. Der heutige
Power-User-Pfad kostet uns nichts und sollte **nicht** abgeschafft, sondern von der Pflicht
zur Option werden.

## 4. Sprachsteuerung: warum VAD, und warum Whisper nicht streamen kann

### VAD ist kein Push-to-Talk

Das Mikrofon bleibt durchgehend an — genau wie heute. Ein kleines Netz (Silero VAD, ~1–2 MB
ONNX über die Web Audio API) läuft *lokal im Browser* mit und erkennt, wann jemand spricht.
Nur diese 1–2 Sekunden gehen nach oben; Stille verlässt das Gerät nie. Für die Nutzerin
ändert sich nichts: sprechen, Befehl wird ausgeführt.

**Das ist der eigentliche Kostenhebel.** Heute streamt das Mikro die komplette Sitzung:
20 Minuten × 0,0065 $ = 0,13 $ pro Sitzung, ~3,90 $/Monat bei 30 Sitzungen. Real gesprochen
werden aber ~90 Sekunden. VAD-gated sind es ~0,24 $/Monat — bei **identischer Bedienung**.

### Warum Whisper nicht „einfach mitstreamen" kann

Whisper ist ein Encoder-Decoder-Modell, das auf **festen 30-Sekunden-Fenstern** trainiert
wurde. Es ist architektonisch kein Streaming-Modell: Es gibt keine Möglichkeit, ihm ein
laufendes Signal zu geben und inkrementelle Teilergebnisse zu bekommen. Der Workers-AI-
Endpunkt nimmt entsprechend einen fertigen Audio-Blob entgegen.

Was existiert, ist **Pseudo-Streaming** (whisper_streaming, LocalAgreement-2): überlappende
Chunks werden wiederholt neu transkribiert. Das hat für uns zwei Haken:

1. **Es ist langsamer, nicht schneller.** Die Referenzimplementierung erreicht ~3,3 s
   Latenz — deutlich schlechter als VAD + Batch.
2. **Es vervielfacht die Kosten.** Dieselben Sekunden werden mehrfach transkribiert, bei
   Abrechnung pro Minute zahlt man sie mehrfach. Das kehrt den Zweck der Übung um.

Dazu kommt: Unsere Befehle sind **einzelne Wörter** („gut", „nochmal", „zeigen"). Ein
Teilergebnis nach 300 ms eines 900-ms-Wortes bringt nichts — man kann auf ein halbes
„nochmal" nicht reagieren, ohne es mit „nein" zu verwechseln.

### Die echten Latenzhebel

| Hebel | Wirkung | Aufwand |
|---|---|---|
| **Kurzes End-of-Speech-Fenster.** Einzelwort-Befehle werden von echter Stille gefolgt, das Fenster kann auf ~200–300 ms statt 600 ms | ~1,2 s → ~0,6 s | XS |
| **Voxtral/Scribe Realtime** (echtes Streaming, während des Sprechens transkribiert) | ~0,3 s | S |
| **Lokale Schlüsselworterkennung** (siehe unten) | ~0 s, 0 $ | M–L |

### Lokale Spracherkennung im Browser (hoch priorisiert)

Unsere Sprachbefehle sind ein **geschlossener Satz von ~11 Kommandos** mit deutschen und
englischen Aliassen. Dafür braucht es kein Cloud-STT. Läuft die Erkennung lokal im Browser,
ist der häufigste Pfad **ohne Netzwerk, ohne Kosten, ohne Round-Trip-Latenz und offline** —
schneller als jede Cloud-Lösung. Server-STT bliebe nur für freie Sprache (Tutor-Fragen).

#### Warum das hier ungewöhnlich einfach ist

Die Befehlserkennung ist bereits vollständig vom Audio-Pfad entkoppelt:

- `src/lib/commands.ts` bietet `matchCommand(transcript, phase) → VoiceCommand | null`.
  Sie arbeitet auf **reinem Text**, kennt keinen Provider, ist bereits **zweisprachig**
  (DE+EN in einer Aliasliste) und in `commands.test.ts` abgedeckt — inklusive der kniffligen
  „nochmal"-Kollision.
- `src/lib/client/speech.ts` definiert den `SpeechClient`-Vertrag; `deepgram.ts` und
  `elevenlabs.ts` implementieren ihn bereits.
- `review-engine.ts:790` ruft schlicht `matchCommand(transcript, phase)`.

**Eine lokale Erkennung muss also nur einen String liefern.** Weder die Kommandologik noch
die Review-Engine werden angefasst — es kommt eine dritte `SpeechClient`-Implementierung
dazu. Die Integrationsfläche ist genau eine Funktion.

#### Modellwahl

| Modell | Größe | Deutsch? | Bewertung |
|---|---:|:---:|---|
| **Whisper-tiny (multilingual)** | ~40 MB | ✅ | **bester Startpunkt** |
| Moonshine | klein | ❌ **nur Englisch** | 5× schneller als Whisper, Rechenzeit skaliert mit Audiolänge statt fixer 30-s-Fenster — technisch ideal, scheitert aber an Deutsch |
| Eigenes Keyword-Spotting-Modell | <1 MB | trainierbar | <10 ms — machbar, aber als *zweiter* Schritt (siehe unten) |

Whisper-tiny läuft über **Transformers.js / ONNX Runtime Web**, mit WebGPU (5–10× schneller)
und automatischem WASM-Fallback. Moonshine ist der bessere Ansatz, sobald es Deutsch kann.

#### Ein eigenes Befehlsmodell: machbar, aber nicht zuerst

Der Aufwand hängt vollständig vom gewählten Weg ab:

| Weg | Datenbedarf | Aufwand | Bewertung |
|---|---|---|---|
| Von Grund auf trainieren | ~1.000–3.000 Äußerungen **pro Wort** | Wochen | unrealistisch nebenher |
| Nur mit TTS erzeugten Daten | keine echten Aufnahmen | Tage | **funktioniert nicht** — in der Literatur ~46 % False-Reject-Rate |
| **Few-Shot über Sprach-Embeddings** | **~5–50 echte Aufnahmen pro Befehl** | Tage | **realistisch** |

Der Few-Shot-Ansatz (prototypische Netze auf einem vortrainierten mehrsprachigen
Sprach-Embedding) macht es tatsächlich machbar: Ein Befehl wird durch wenige Beispiele
„eingelernt", statt ein Modell von Null zu trainieren. Für Deutsch + Englisch gibt es
genau dafür mehrsprachige Embeddings.

**Drei Gründe, es trotzdem nicht als Ersten Schritt zu machen:**

1. **Neue Befehle werden teuer.** Heute ist ein neuer Sprachbefehl *eine Zeile* in der
   Aliasliste von `commands.ts` — die Liste hat schon ~63 Sprechformen und wächst. Mit einem
   eigenen Modell bedeutet jeder neue Befehl Neu-Einlernen und ein neu ausgeliefertes Modell.
2. **Fehlauslöser sind hier besonders schädlich.** Das Mikrofon läuft die ganze Sitzung und
   hört Vorlesung, Gespräche, Verkehr. Ein Klassifikator gibt *immer* eine Klasse aus, wenn
   man die Rückweisung nicht sehr sorgfältig baut. `matchCommand` liefert dagegen `null` für
   alles Unbekannte — ein sicherer No-Op. Ein falsch erkanntes „easy" bewertet still eine
   Karte falsch und verfälscht die FSRS-Planung.
3. **Freie Sprache braucht es ohnehin.** Der Tutor verarbeitet ganze Fragen. Ein
   Befehlsmodell könnte den allgemeinen Pfad also nie ersetzen, nur überholen.

**Die elegante Reihenfolge:** Erst Whisper-tiny messen. Zeigt der Spike, dass deutsche
Einzelwörter zu ungenau oder zu langsam sind, wird Few-Shot-KWS für die ~7 häufigsten
Befehle als schneller Pfad davor gesetzt — und der **Shadow-Modus aus Schritt 2 hat bis dahin
genau die echten Aufnahmen geliefert, die man zum Einlernen braucht.** Die Stufen bauen also
aufeinander auf, statt sich zu ersetzen.

#### Ehrliche Risiken — alle nur durch Messen zu klären

1. **Deutsche Genauigkeit bei Einzelwörtern.** Tiny ist das schwächste multilinguale
   Whisper-Modell. Ausgaben wie „gud"/„guht" für „gut" sind zu erwarten.
   → Gegenmittel: toleranter Abgleich (Levenshtein) gegen die Aliasliste. Das hilft auch dem
   Server-Pfad. Aber Vorsicht, es erhöht Fehlauslöser („gut"/„Blut", „schwer"/„sehr") —
   die bestehende Testsuite ist die Grundlage, um das abzusichern.
2. **iOS Safari.** WASM-Speichergrenzen und AudioWorklet-Verhalten in der PWA. Genau hier
   ist bei euch schon die Web Speech API gescheitert.
3. **Latenz auf Mittelklasse-Android** ohne WebGPU (reines WASM).
4. **40 MB Erstdownload** — über Mobilfunk spürbar. Braucht bewusstes Lazy-Loading.

#### Vorgehen: erst messen, dann integrieren

**Schritt 1 — Spike als eigenständige Testseite, ohne die App anzufassen.** Mikrofon → VAD →
Whisper-tiny → Transkript + Latenz anzeigen. Auf echten Geräten testen (iPhone, Android).
Beantwortet Risiken 1–4, bevor irgendetwas integriert wird.

**Schritt 2 — Shadow-Modus.** Lokale Erkennung *parallel* zum Server-Pfad laufen lassen,
nur die Übereinstimmungsrate protokollieren, ausgeführt wird weiter der Server-Befehl. Kein
Nutzerrisiko, echte Daten. Das Telemetriemuster existiert bereits (`recordCacheEvent`,
`mcp_tool_audit`).

**Schritt 3 — Umschalten mit Fallback.** Lokal zuerst; bei niedriger Konfidenz, fehlendem
Modell oder freier Sprache automatisch auf Server-STT. Die Kosten können dadurch nur sinken.

Dieses Vorgehen ist bewusst risikoarm: Jede Stufe ist für sich nützlich, und der Abbruch ist
auf jeder Stufe folgenlos.

### Risiko, das auf Staging zu prüfen ist

VAD braucht AudioWorklet + WebAssembly. Beides ist auf iOS Safari ab 14.1/16.4 unterstützt,
und `getUserMedia` funktioniert in eurer PWA nachweislich (`RESEARCH.md`). Die
Bibliotheksdoku bestätigt iOS aber nicht explizit — das muss real getestet werden.
**Fallback**, falls es klemmt: energiebasierte Erkennung über `AnalyserNode` (RMS-Schwelle).
Weniger robust bei Straßenlärm, aber ohne WASM und garantiert iOS-tauglich.

## 5. Randbedingung: kein Rückfall auf Browser-Sprachausgabe

Naheliegend wäre, Free mit `speechSynthesis` zu bauen (kostenlos, überall deutsche Stimmen).
**Das würde den Kern des Produkts zerstören:** Auf iOS pausiert `speechSynthesis`, sobald der
Bildschirm gesperrt wird. Vorlesen beim Spazierengehen oder Pendeln — der eigentliche Zweck
von AnkiTalk — funktioniert dann nicht.

`src/lib/client/audio.ts` spielt bewusst MP3s über ein einzelnes, per Nutzergeste entsperrtes
`HTMLAudioElement` ab (`unlockAudioForGesture`). Das läuft bei gesperrtem Bildschirm weiter.
Serverseitiges TTS ist deshalb auch im Free-Tier richtig — und laut §2 ohnehin günstig.

## 6. Wirtschaftlichkeit

Alle Zahlen pro Nutzer und Monat, bei **Vollausnutzung** der Quote. TTS mit Voxtral (16 $/1M).

| | Free | Pro (4 € ≈ 4,30 $) | Max (12 € ≈ 13 $) |
|---|---:|---:|---:|
| TTS | 10k Zeichen → **0,16 $** | 200k → **3,20 $** | 300k → **4,80 $** |
| STT (VAD-gated) | 0,02 $ | 0,22 $ | 0,22 $ |
| Tutor (0,08 $/Min) | – | – | 60 Min → **4,80 $** + LLM ~0,50 $ |
| **Summe** | **0,18 $** | **3,62 $** | **10,32 $** |
| **Marge** | −0,18 $ | +0,68 $ | +2,68 $ |

Typische Nutzung liegt deutlich darunter, weil der Cache Wiederholungen gratis macht — real
ist die Pro-Marge eher 2–3 $.

### Pay-as-you-go beseitigt die Sockelkosten

Bis Mai 2026 hätte der *erste* Max-Nutzer ein ElevenLabs-Creator-Abo (22 $/Monat) erzwungen,
mit Break-even bei 2 Nutzern. **Mit PAYG entfällt das vollständig:** Guthaben wird vorab
gekauft, ist 12 Monate gültig, kein Abo, keine Mindestabnahme. Max ist damit **ab dem ersten
Nutzer profitabel** und kann sofort starten — die Warteliste aus der früheren Planung ist
hinfällig.

Zu beachten: PAYG-Guthaben wird als Dollarwert gespeichert und beim Wechsel eines
Abo-Plans zum dann gültigen Satz umgerechnet. Solange wir rein auf PAYG bleiben, ist das
irrelevant.

### ElevenLabs für Karten-TTS in Max ist jetzt finanzierbar

Mit dem PAYG-Satz von 50 $/1M (statt der 91 $/1M aus dem Creator-Abo) passt ElevenLabs-TTS
in Max, wenn die Quote entsprechend gewählt wird:

| Max-Variante | TTS | Tutor | Summe | Marge bei 12 € |
|---|---:|---:|---:|---:|
| Voxtral, 300k Zeichen | 4,80 $ | 5,30 $ | 10,10 $ | +2,90 $ |
| **ElevenLabs Flash, 100k Zeichen** | **5,00 $** | 5,30 $ | 10,30 $ | +2,70 $ |
| ElevenLabs Flash, 200k Zeichen | 10,00 $ | 5,30 $ | 15,30 $ | **−2,30 $** |

Der Tausch ist also: **ElevenLabs-Qualität gegen ein Drittel der Kartenmenge.** Bei 100.000
Zeichen (≈ 500 neue Karten/Monat) trägt es sich. Diese Entscheidung sollte am realen Hörtest
hängen (§10.1), nicht an der Theorie.

### Free-Tier im Gesamten

100 Nutzer ≈ 18 $/Monat, 1.000 Nutzer ≈ 180 $/Monat. Die 50-Karten-Quote ist das, was diese
Zahl unter Kontrolle hält — sie ist kein Detail, sondern die zentrale Stellschraube.

## 7. Zielarchitektur

### 7.1 Provider-Abstraktion
`TtsProvider` in `src/lib/voice.ts` wird um die Platform-Provider erweitert. Die
Voxtral-API ist **OpenAI-kompatibel** (`POST /v1/audio/speech` mit `model`, `input`, `voice`,
`response_format: mp3`, `speed`, `stream`; Input-Limit 4096 Zeichen — identisch zum
bestehenden `text.slice(0, 4096)`). Damit lässt sich `synthesizeOpenAISpeech` in
`src/lib/server/tts.ts` über eine abweichende `baseURL` wiederverwenden; es braucht keinen
neuen HTTP-Client.

`normalizeVoiceSettings` behandelt unbekannte/alte Werte bereits tolerant — die
Provider-Erweiterung ist rückwärtskompatibel.

⚠️ Latenz prüfen: Time-to-first-audio liegt bei MP3 laut Mistral bei ~3 s (PCM ~0,8 s). Der
Preload-Mechanismus in `audio.ts` (`audioPreloads`) verdeckt das im Review-Flow weitgehend —
auf Staging verifizieren, ggf. auf PCM/Opus wechseln.

### 7.2 Key-Auflösung
`src/lib/server/user-keys.ts` bekommt `resolveKey(userId, service)`: Nutzer-Key zuerst,
sonst Platform-Key, sofern der Tier das erlaubt. Platform-Keys als Cloudflare-Secrets
(`PLATFORM_VOXTRAL_API_KEY`, `PLATFORM_ELEVENLABS_API_KEY`) analog zu `ENCRYPTION_KEY`,
Ergänzung in `src/app.d.ts`. Alle Endpunkte rufen künftig `resolveKey` statt `getUserApiKey`.

### 7.3 Tier & Quota
- **Migration** `0023_user_plan.sql`:
  - `user_plan (user_id PK, tier TEXT NOT NULL DEFAULT 'free', ...)`
  - `voiced_cards (user_id, card_id, month, PRIMARY KEY (user_id, card_id))` — zählt
    „vertonte Karten pro Monat" als *distinct card_id*, damit Vorder- und Rückseite zusammen
    eine Karte ergeben und eine einmal vertonte Karte nie erneut zählt.
- **`src/lib/server/quota.ts`** (neu): Monatsverbrauch je Nutzer und Tier.
- **Durchsetzung** in `src/routes/api/tts/+server.ts` **nach** allen Cache-Schichten, direkt
  vor dem Provider-Aufruf (wo heute `enforceRateLimit` steht, ~Zeile 263). Damit zählt die
  Quote automatisch nur echte Kosten — Edge-, R2- und In-Flight-Treffer bleiben unlimitiert.
  Der Endpunkt nimmt mit `deckId` bereits Kartenkontext entgegen; `cardId` kommt analog dazu.

### 7.4 Spracherkennung
- Client-VAD schneidet Äußerungen aus; nur diese gehen nach oben.
- Neuer Endpunkt `/api/stt` → Workers AI `@cf/openai/whisper-large-v3-turbo` (Free).
- Pro/Max: Streaming-Provider über denselben `SpeechClient`-Vertrag.
- `src/lib/client/speech.ts` definiert das Interface bereits; `deepgram.ts` und
  `elevenlabs.ts` implementieren es — weitere Implementierungen fügen sich ohne Umbau ein.

### 7.5 Tutor über Platform-Account
Wir konfigurieren Agent und MCP-Server **einmal zentral** statt pro Nutzer.
`src/lib/server/agent-readiness.ts` kennt heute **12 Fehlerzustände**, weil jede Nutzerin
selbst einen Agenten anlegen, Auth aktivieren, vier Overrides setzen, einen MCP-Server
registrieren und zuweisen muss. Das **entfällt komplett**; die Datei schrumpft zu einem
internen Health-Check. Das ist der größte UX-Gewinn des ganzen Vorhabens.

Zu klären: Der Tutor greift per MCP auf Nutzerdaten zu. Bei einem zentralen Agenten muss die
Trennung pro Nutzer über die MCP-Token-Scopes laufen (das Token-Modell in
`0016_mcp_product_architecture.sql` ist dafür bereits ausgelegt) — hier ist besondere
Sorgfalt nötig, damit kein Nutzer Karten eines anderen sieht.

### 7.6 Billing
Stripe Checkout + Customer Portal, Webhook → `user_plan.tier`. Zusätzlich: EU-OSS-
Umsatzsteuer (Stripe Tax nimmt das weitgehend ab), Kündigungs- und Mahnprozesse, sowie
Verhalten bei Downgrade — bereits vertonte Karten bleiben abspielbar, weil sie im Cache
liegen.

### 7.7 Onboarding
Free-Nutzer sehen **keine** API-Key-Sektion mehr. `OnboardingChecklist.svelte` schrumpft auf
„Deck importieren → Erste Sitzung starten".

## 8. Bekannte Fehler, die dabei mitgehen

`src/lib/server/usage.ts` rechnet mit Raten, die nicht stimmen:

```ts
openai_tts:     0.6 / 1_000_000,   // real: 15 $/1M → Faktor 25 zu niedrig
elevenlabs_tts: 0.36 / 1_000_000,  // real: 50 $/1M (PAYG) → Faktor ~139 zu niedrig
```

Die „Usage & Costs"-Anzeige ist damit faktisch Fiktion — und lässt ausgerechnet ElevenLabs
am günstigsten aussehen. Zusätzlich konzeptionell: Für Abo-Provider ist ein USD-Betrag die
falsche Metrik (dort zählt „Credits / Kontingent", was `ElevenLabsSettings.svelte` bereits
korrekt zeigt); USD nur für Pay-as-you-go.

## 9. Umsetzungsreihenfolge

| # | Schritt | Aufwand | Wirkung |
|---|---|---|---|
| 0 | **Hörtest: Voxtral vs. OpenAI vs. ElevenLabs** an echten deutschen Karten | S | Entscheidet §10.1, blockiert Schritt 2 |
| 0b | **Spike: lokale Spracherkennung** als Testseite (§4) | S | Klärt die vier Risiken, bevor irgendetwas integriert wird |
| 1 | Kostenraten in `usage.ts` korrigieren | XS | Ehrliche Zahlen als Grundlage |
| 2 | Platform-TTS-Provider ergänzen (§7.1) | S | Günstigeres TTS, sofort auch für BYOK-Nutzer |
| 3 | VAD + Whisper-STT (§7.4) | M | Senkt STT-Kosten um ~90 %, unabhängig vom Provider |
| 4 | Tier + Quota + Platform-Key (§7.2/7.3) | M | Ermöglicht Free-Tier ohne Setup |
| 5 | Onboarding auf Free zuschneiden (§7.7) | S | Beseitigt die Einrichtungshürde |
| 6 | Stripe-Billing (§7.6) | L | Schaltet Pro frei |
| 7 | Tutor über Platform-Account (§7.5) | M | Schaltet Max frei, entfernt 12 Fehlerzustände |

Schritte 1–3 senken die Kosten **ohne** Billing und ohne Tier-Logik. Wenn es schnell gehen
soll, liefern sie bereits den Großteil: Ein voll vertontes 2.000-Karten-Deck kostet mit
Voxtral **6,40 $ einmalig statt 22 €/Monat**.

## 10. Offene Entscheidungen

1. **TTS-Provider für Free/Pro — offen bis zum Hörtest (Schritt 0).** Voice-Cloning ist
   für AnkiTalk irrelevant und fällt als Argument weg; damit liegen Voxtral (16 $/1M,
   EU-Anbieter, ein Vendor für TTS+STT) und OpenAI tts-1 (15 $/1M, **bereits implementiert**)
   preislich gleichauf. Die Entscheidung sollte allein an der deutschen Sprachqualität
   hängen. ElevenLabs Flash (50 $/1M) ist für Free/Pro zu teuer, für **Max aber tragfähig**
   (§6) — falls der Hörtest den Qualitätsunterschied bestätigt.
2. **Pro-Quote 200.000 Zeichen** — trägt bei 4 € gerade so. Großzügiger geht nur über einen
   billigeren Provider oder einen höheren Preis.
3. **Verhalten bei erschöpfter Quote** — harte Sperre oder Rückfall auf eine günstigere
   Stimme? Letzteres ist freundlicher, erfordert aber einen zweiten Provider im Free-Pfad.
4. **Eigener Tutor statt ElevenLabs?** Perspektivisch ließe sich der Tutor aus Bausteinen
   selbst bauen (Streaming-STT → LLM → Streaming-TTS). Das würde die 0,08 $/Min deutlich
   unterbieten, weil man nur die drei Einzelkomponenten zahlt. Dagegen steht erheblicher
   Aufwand für Turn-Taking, Unterbrechbarkeit und Latenz — genau das, wofür man ElevenLabs
   Agents eigentlich bezahlt. Sinnvoll erst, wenn Max läuft und die Nutzung das Volumen
   rechtfertigt. **Nicht für v1.**
