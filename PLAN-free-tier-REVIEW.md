# Review: `PLAN-free-tier.md` und `PLAN-pricing-tiers.md`

> Prüfung der beiden Pläne auf Branch `claude/ankitalk-student-pricing-gyrhoq` gegen den
> tatsächlichen Code-Stand. Frage: Sind sie ausführbar, vollständig, und ist das der
> intelligenteste Weg zu einem Free-Tier?
>
> Kurzfassung: **Der strategische Kern stimmt, die Kostenrechnung nicht.** Die beiden
> größten Kostenhebel kommen in keinem der Pläne vor, und der Free-Tier ist mit
> 50 Karten/Monat für genau den Fall zu klein, der ihn ausgelöst hat. Dazu vier
> Punkte, an denen der Plan wie geschrieben nicht lauffähig ist.

---

## 1. Was verifiziert wurde und hält

Damit klar ist, was *nicht* neu geprüft werden muss:

| Behauptung | Status |
|---|---|
| Deepgram rechnet nach **gesendetem Audio** ab; offener Socket und KeepAlive kosten nichts | ✅ bestätigt (Deepgram Discussion #1423) — VAD-Gating spart tatsächlich |
| `deepgram.ts` hat den Gating-Mechanismus (`paused`-Flag, KeepAlive) bereits | ✅ `deepgram.ts:47–48, 205–240` |
| `createScriptProcessor` statt AudioWorklet, also iOS-erprobt | ✅ `deepgram.ts:43` |
| STT-Erfassung verbucht pauschal 60 s pro Token | ✅ `api/deepgram-token/+server.ts:40` |
| TTS-Raten in `usage.ts` sind grob falsch | ✅ `usage.ts:6,8` — Faktor 25 bzw. ~139 |
| Durchsetzungspunkt „nach allen Cache-Schichten, wo `enforceRateLimit` steht" | ✅ `api/tts/+server.ts:263`, exakt richtig gewählt |
| `/api/tts` nimmt `deckId` entgegen, `cardId` ließe sich analog ergänzen | ✅ `+server.ts:124`, `audio.ts:104` |
| Preloads verbrennen keine Quote | ✅ `preloadTTS` sendet `generate: false` → 204 vor dem Provider |
| Deepgram $200 Startguthaben, PAYG ohne Abo | ✅ bestätigt |
| OpenAI tts-1 ≈ 15 $/1M Zeichen | ✅ bestätigt |
| Kein Rückfall auf `speechSynthesis` (iOS pausiert bei gesperrtem Bildschirm) | ✅ richtig und wichtig |

Auch strategisch richtig: Quote **nach** dem Cache prüfen, BYOK als Umgehung erhalten,
weiche Degradation statt harter Sperre, und die Erkenntnis, dass STT und nicht TTS der
ungedeckelte Posten war.

---

## 2. Die zwei fehlenden Kostenhebel

Beide Pläne bauen auf dem Satz auf: *„TTS-Kosten fallen einmalig pro Karte an, nicht pro
Wiederholung."* (`PLAN-pricing-tiers.md` §1.2). **Der Satz ist im aktuellen Code falsch**,
und zwar aus zwei unabhängigen Gründen.

### 2.1 Der Cache ist pro Nutzer, nicht pro Inhalt

`src/lib/server/tts-cache.ts:12` nimmt `userId` in den Hash-Payload auf:

```ts
const parts: unknown[] = [userId, provider, model, text.slice(0, 5000), voice, speed];
```

Zwei Nutzerinnen mit demselben Deck, derselben Stimme und denselben Einstellungen
erzeugen **zwei verschiedene Hashes** und werden zweimal beim Provider abgerechnet.
Bei BYOK ist das egal — jede zahlt selbst. **Mit Platform-Keys zahlen wir jede Kopie.**

Alle anderen Synthese-Parameter (Provider, Modell, Stimme, Speed, ElevenLabs-Tuning)
stecken bereits im Schlüssel — `userId` trägt zur Identität des Clips *nichts* bei. Es ist
reine Duplikation.

**Vorschlag:** Für Platform-Synthesen `userId` durch die Konstante `'platform'` ersetzen.
Damit teilen sich alle Free-Nutzer einen inhaltsadressierten Cache; BYOK-Clips bleiben
nutzerprivat (niemand „verschenkt" Audio, das er mit eigenem Key bezahlt hat).
Wirkung: Bei einem Kurs mit demselben Semester-Deck sinken die TTS-Kosten pro
zusätzlicher Nutzerin gegen **null**. Aufwand: eine Zeile plus ein bewusster
Cache-Bruch (alte Clips laufen über die Lifecycle-Regel aus).

Nebeneffekt beachten: R2-Objekte werden dann geteilt, d. h. eine Kontolöschung entfernt
den abgeleiteten Audio-Cache nicht mehr mit. Das ist vertretbar (Cache-Objekt, keine
personenbezogene Ablage, begrenzte Retention), gehört aber in die Datenschutzerklärung
(→ §5).

### 2.2 30 Tage Retention treffen frontal auf FSRS

`docs/r2-tts-lifecycle.md` und `tts-store.ts:28`: unpinned Audio wird **30 Tage** nach
letztem Zugriff gelöscht. FSRS-Intervalle reifer Karten liegen systematisch **darüber**
(1, 3, 6 Monate). Genau die Karten, die am längsten leben, fallen also vor jeder
Wiederholung aus dem Cache und werden **erneut synthetisiert und erneut bezahlt** — für
immer, in jedem Zyklus.

Größenordnung für ein 2.000-Karten-Deck im Gleichgewicht (200 Zeichen/Karte, OpenAI):

| Ø-Intervall | Wiederholungen/Tag | Re-Synthese-Kosten/Monat, falls ungecacht |
|---|---:|---:|
| 30 Tage | 67 | 6,00 $ |
| 60 Tage | 33 | 3,00 $ |
| 120 Tage | 17 | 1,50 $ |

Der Plan veranschlagt für Free **0,16 $/Monat**. Realistisch sind, sobald die Nutzerin
über die Anfangsphase hinaus ist, eher **1–3 $/Monat** — und diese Kosten sind unter dem
vorgeschlagenen `voiced_cards`-Schema **von der Quote ausgenommen**, weil die Karte schon
einmal registriert wurde (PK `(user_id, card_id)`). Die Quote deckelt also ausgerechnet
den einmaligen Posten und lässt den wiederkehrenden laufen.

**Vorschlag:** Retention ist hier die falsche Sparschraube. R2-Speicher kostet
0,015 $/GB/Monat. Das komplette vertonte 2.000-Karten-Deck (≈ 4.000 Clips à ~40 KB)
sind ~156 MB → **0,0023 $/Monat**. Die Neusynthese desselben Decks kostet **6,00 $**.
Speichern ist etwa **1.000× billiger** als neu erzeugen.

Also: für Platform-Audio `STD_RETENTION_DAYS` auf 180–365 anheben (oder einen dritten
Prefix `tts/plat/` mit langer Retention einführen). Das ist eine Konstante plus eine
R2-Lifecycle-Regel — und spart mit hoher Wahrscheinlichkeit mehr als das gesamte
VAD-Vorhaben.

> Zusammen sind §2.1 und §2.2 vermutlich **der günstigste Punkt im ganzen Plan**:
> zwei Konfigurationsänderungen, kein neues Modul, kein neuer Provider — und sie
> wirken sofort auch für BYOK-Nutzer.

---

## 3. Vier Punkte, an denen der Plan so nicht läuft

### 3.1 Die Voreinstellung zeigt auf ElevenLabs (Blocker)

`src/lib/voice.ts` → `DEFAULT_VOICE_SETTINGS`:

```ts
tts_provider: 'elevenlabs',
stt_provider: 'elevenlabs',
```

Ein neu angelegter Nutzer ohne `user_voice_settings`-Zeile bekommt **ElevenLabs für beides**.
Der Plan liefert Platform-Keys nur für OpenAI und Deepgram. Ergebnis nach Schritt 2 des
Plans: Die Schwester meldet sich an, startet eine Sitzung und bekommt
*„Add your ElevenLabs API key in Settings"* (`api/tts/+server.ts:270`). Der Free-Tier ist
funktional nicht vorhanden.

Der Plan erwähnt die Umstellung nirgends — obwohl `PLAN-pricing-tiers.md` §0 exakt diesen
Befund („das Onboarding führt an ElevenLabs vorbei") als eine der zwei *nicht* verfrühten
Maßnahmen benennt. Der Befund ist im Free-Tier-Plan verlorengegangen.

Nötig: Default auf `openai`/`deepgram` umstellen, und in der Einstellungs-UI
(`settings/+page.svelte:859/:899`) Provider ohne verfügbaren Key für Free-Nutzer
deaktivieren oder klar als „braucht eigenen Key" markieren. Sonst wählt jemand
ElevenLabs und der Ton bricht ohne erklärbaren Grund weg.

Zusatz: `voice_command_language` steht per Default auf `'en'` — für eine deutsche
Studentin die falsche Voreinstellung, wenn es ohnehin angefasst wird.

### 3.2 Weiche Degradation ist Client-Arbeit, nicht nur Server-Arbeit

§5.7 („keine harte Sperre, neue Karten werden stumm angezeigt") ist die richtige
Entscheidung, aber sie ist im Plan als reine Serverentscheidung beschrieben. Tatsächlich:

- `audio.ts:283` wirft bei fehlendem Audio `'TTS audio was not generated'`.
- `review-engine.ts:250 ff.` fängt das und emittiert `{ type: 'error' }` → Fehlerbanner.

Eine erschöpfte Quote würde also als Fehler erscheinen, nicht als Stille. Erforderlich
sind: eine eigene, *erfolgreiche* Antwortform für „Quote aufgebraucht" (z. B. 204 mit
`X-TTS-Quota: exhausted`), Behandlung in `audio.ts`, und in `speakText` ein Pfad, der
ohne Ton direkt nach `listening`/`idle` weitergeht, damit der FSRS-Fluss und die
Mikrofonsteuerung intakt bleiben. Plus einmalige, nicht wiederholte Nutzerinfo.

### 3.3 `cardId` als Quotenschlüssel ist manipulierbar und zählt das Falsche

Drei getrennte Probleme mit „50 vertonte Karten":

1. **`cardId` kommt vom Client.** Ohne serverseitige Prüfung, dass die Karte dem Nutzer
   gehört *und* dass der gesendete Text zu dieser Karte passt, genügt ein konstanter
   `cardId`, um beliebig viel Text unter einem Quotenplatz zu synthetisieren.
   Die Text↔Karte-Bindung serverseitig zu prüfen ist unangenehm (der Client schickt
   gerenderten, sanitisierten Text, nicht das Feld).
2. **Kartenlängen streuen um Faktor 25.** `MAX_TTS_TEXT_CHARS = 5000`
   (`api/tts/+server.ts:25`). 50 Karten kosten je nach Deck **0,15 $ oder 3,75 $**.
   Der Plan rechnet mit 200 Zeichen/Karte als wäre das eine Konstante.
3. **Stimmwechsel ist gratis.** Der Cache-Schlüssel enthält Stimme, Speed, Modell und
   Tuning — ein Wechsel erzeugt neue Clips. Unter `voiced_cards` (PK `(user_id, card_id)`)
   ist die Karte aber schon registriert: ein Nutzer kann ein ganzes Deck beliebig oft in
   neuen Stimmen neu vertonen, ohne Quote zu verbrauchen.

**Vorschlag: in Zeichen deckeln, nicht in Karten.** Der Endpunkt kennt `text.length`
bereits und protokolliert es sogar schon (`recordCacheEvent(..., text.length, ...)`).
Eine Zeichenquote ist nicht manipulierbar, direkt proportional zu den echten Kosten,
immun gegen alle drei Punkte oben — und der Zähler existiert praktisch schon.
„50 Karten" kann in der UI trotzdem als Übersetzung angezeigt werden
(„noch ~380 Karten übrig"), aber die Buchhaltung muss in Zeichen laufen.

Nebenbei: `voiced_cards.month` speichert bei PK `(user_id, card_id)` nur den *ersten*
Monat, und die „prüfen-dann-einfügen"-Sequenz ist in D1 nicht atomar (paralleles
Vor-/Rückseiten-Synthetisieren kann die Grenze überschreiten). Mit einer Zeichenquote
entfällt die Tabelle ersatzlos — man summiert über `api_usage` bzw. `tts_cache_events`.

### 3.4 STT: Die Quote wurde durch etwas ersetzt, das keine Grenze ist

Der Commit „Replace the STT quota with VAD gating" tauscht eine **Durchsetzung** gegen
eine **Optimierung**. Beides ist nützlich, aber es ist kein Ersatz:

- `/api/deepgram-token` gibt dem Browser ein **Bearer-Token für unser Deepgram-Konto**.
  Die TTL von 60 s (`+server.ts:26`) begrenzt nur, wie lange man eine Verbindung
  *aufbauen* kann — nicht, wie lange sie danach läuft und wie viel Audio hindurchgeht.
- **VAD läuft im Browser.** Ein manipulierter oder einfach nur fehlerhafter Client
  (Straßenlärm, ein hängendes `paused`-Flag) sendet weiter Vollstrom.
- Das vorgeschlagene `POST /api/stt/session-end` mit der Dauer ist eine
  **Selbstauskunft des Clients** — als Telemetrie brauchbar, als Abrechnungsgrundlage
  oder Quotenbasis nicht.
- Übrig bleibt `stt_token_per_minute: 30` (`rate-limit.ts:44`) — das begrenzt
  Verbindungs*starts*, nicht Minuten.

Serverseitig durchsetzbar sind stattdessen: **Sitzungen pro Tag** und **eine aktive
Sitzung pro Nutzer** (beides KV, wenige Zeilen) — das gibt eine harte Obergrenze
`Sitzungen × maximale Sitzungslänge`. Dazu ein globaler Ausgabenwächter (§4.1) und,
falls STT je nennenswert wird, die eigentlich saubere Lösung: **den WebSocket durch
einen Worker/Durable Object proxen** und Bytes zählen. Dann ist die Messung echt, und
VAD kann serverseitig erzwungen werden statt erbeten.

VAD selbst bleibt richtig und sollte gebaut werden — die Einschätzung „~100 Zeilen,
keine neue Abhängigkeit, kommt BYOK sofort zugute" hält. Es ist nur eine
Kostensenkung, keine Kostengrenze.

---

## 4. Blinde Flecken, die in beiden Plänen fehlen

### 4.1 Kein Not-Aus

Nirgends steht ein globales Ausgabenlimit. Ein durchgereichter Cookie, ein
Endlos-`$effect`, ein Bot auf der offenen Registrierung — nichts davon trifft auf eine
Bremse, außer per-Nutzer-Rate-Limits, die einzeln großzügig sind
(`tts_per_minute: 60` × 5.000 Zeichen = 300.000 Zeichen/Minute ≈ **4,50 $/Minute**
pro Nutzer).

Ein Monatszähler in KV, der bei Überschreitung `/api/tts` in den Cache-only-Modus
schaltet und die Token-Ausgabe stoppt, sind ~30 Zeilen. **Das gehört vor den ersten
Platform-Key, nicht danach** — es ist die einzige Maßnahme, die die Kosten nach oben
tatsächlich beschränkt, und sie ist unabhängig von jeder Quotenlogik korrekt.
Dazu Ausgabenwarnungen direkt bei OpenAI und Deepgram (unabhängige zweite Ebene).

### 4.2 Die Registrierung ist der eigentliche Schalter

`hooks.server.ts:149–156` legt für **jedes gültige Hanko-Token** automatisch einen
Nutzer an. Ob sich Fremde registrieren können, entscheidet damit allein die
Hanko-Konsole (Sign-up an/aus, Domain-Allowlist), nicht der Code.

Der Plan verschiebt Missbrauchsschutz auf „relevant erst, wenn die Registrierung
wirklich öffentlich ist". Aber: **Platform-Keys machen die Hanko-Einstellung zu einer
Kostenkontrolle.** Beides muss im selben Schritt entschieden werden. Für die reale
Ausgangslage (Schwester + Bekanntenkreis) ist die richtige Antwort vermutlich:
Sign-up geschlossen bzw. Allowlist, dann darf der Free-Tier großzügig sein (§6).

Ergänzend: `users` (Migration `0001`) hat nur `hanko_id`, **keine E-Mail**. Weder
Mehrfachkonten-Erkennung noch „wir müssen dich mal erreichen" ist damit in der App
möglich.

### 4.3 `resolveKey` darf kein Blanko-Fallback werden

Es gibt heute **12 Aufrufstellen** von `getUserApiKey`. `PLAN-pricing-tiers.md` §7.2
schreibt: *„Alle Endpunkte rufen künftig `resolveKey`."* So umgesetzt bezahlt die
Plattform, sobald der jeweilige Secret gesetzt ist, auch:

- `/api/explain`, `/api/hint` (Anthropic) — laut Plan ausdrücklich **nicht** in Free,
- `/api/listen/[id]/stream` (ElevenLabs) — der zeichenintensivste Teil des Produkts,
- `/api/agent/session` (ElevenLabs) — der Tutor.

Und drei Endpunkte sind schlimmer als teuer: `/api/elevenlabs/subscription`,
`/api/elevenlabs/voices` und `/api/elevenlabs/usage-breakdown` würden mit einem
Platform-Key **unser Konto** ausliefern — fremde Nutzer sähen unser Abo, unsere
Restkontingente und unsere Verbrauchsaufschlüsselung.

`resolveKey` braucht deshalb eine explizite Freigabeliste pro Feature (nicht pro
Service), und die drei `/api/elevenlabs/*`-Informationsendpunkte müssen dauerhaft auf
`getUserApiKey` bleiben. Der Free-Tier-Plan formuliert es enger („in den
Audio-Endpunkten") — diese engere Fassung ist die richtige und sollte auch im
Zielbild-Dokument stehen.

### 4.4 Ein geteilter Key ist ein geteiltes Rate-Limit

Mit einem Platform-OpenAI-Key laufen alle Free-Nutzer gegen **ein** Org-Rate-Limit; der
Burst der einen erzeugt 429er bei der anderen. Heute wird ein Provider-Fehler zu einem
502 mit Fehlerbanner (`api/tts/+server.ts:87–98`) — für einen geteilten Key braucht es
mindestens einen Retry mit Backoff und im Zweifel dieselbe stille Degradation wie bei
erschöpfter Quote.

### 4.5 Datenschutz ändert sich mit dem Platform-Key grundlegend

Heute ist AnkiTalk reines BYOK: die Nutzerin schließt den Vertrag mit OpenAI/ElevenLabs
selbst ab. Mit Platform-Keys senden **wir** ihren Kartentext und ihr Mikrofonaudio an
US-Anbieter. Das ist keine Formalie, sondern ein Rollenwechsel:

- AV-Verträge/DPAs mit OpenAI und Deepgram,
- Auftragsverarbeiter-Liste + Datenschutzerklärung (Mikrofonaudio ist besonders
  erklärungsbedürftig),
- Zero-Retention/kein-Training bewusst konfigurieren (beide Anbieter bieten das an),
- Impressum und Nutzungsbedingungen, sobald sich Fremde registrieren können,
- Löschkonzept inkl. des in §2.1 geteilten Audio-Caches.

Das ist deutlich billiger *vor* der Öffnung der Registrierung als danach — und es ist
ein realer Grund, die Registrierung zunächst geschlossen zu halten.

### 4.6 Kleinere Korrekturen

- **STT-Rate ebenfalls falsch.** `usage.ts:7` rechnet mit 0,0043 $/min. Der Client
  streamt `model: nova-3, language: multi` (`deepgram.ts:137–138`) → Streaming
  *multilingual*, real ~0,0058 $/min. §5.5 korrigiert die TTS-Raten und die Dauer,
  die STT-Rate aber nicht. (Auch die 4,62 $ in §1 des Free-Plans setzen einen zu hohen
  Satz an; die Aussage „STT ≫ TTS" bleibt richtig, die Zahl ist ~30 % zu hoch.)
- **Monatsgrenze in UTC** (`month TEXT 'YYYY-MM'`) vs. lokaler Monat der Nutzerin —
  bei einer Zeichenquote ohnehin besser über ein rollierendes 30-Tage-Fenster.
- **Quotenanzeige braucht einen Endpunkt** — in §5.6 als UI-Punkt genannt, ohne die
  serverseitige Hälfte.
- **Statusanzeige „Usage & Costs"**: Für Free-Nutzer zeigt sie künftig Kosten an, die
  sie gar nicht tragen. Entweder umbenennen („Verbrauch") oder für Free ausblenden.

---

## 5. Wo die zwei Dokumente sich widersprechen

`PLAN-pricing-tiers.md` §0 sagt ausdrücklich, Platform-Keys, Tiers und Quoten seien
*„Skalierungsprobleme ohne Skalierung"* und verfrüht. `PLAN-free-tier.md` baut genau
das. Beide Aussagen sind für sich vertretbar, aber das Repo enthält damit zwei
gegensätzliche Empfehlungen ohne Kennzeichnung, welche gilt.

Ebenso: §9 Schritt 0 („Hörtest blockiert Schritt 2") vs. Free-Plan §3 („kein Blocker
mehr"); Voxtral vs. OpenAI als v1-Provider; `resolveKey`-Reichweite (§4.3 oben).

**Vorschlag:** In `PLAN-pricing-tiers.md` §0 einen Satz ergänzen, dass die
Auslösebedingung „Leute außerhalb des Bekanntenkreises" mittlerweile eingetreten ist
(bzw. bewusst vorweggenommen wird) und `PLAN-free-tier.md` das Vorgehen für Free
verbindlich festlegt. Sonst liest der nächste Durchgang §0 und stoppt.

---

## 6. Die eigentliche Frage: Ist 50 Karten/Monat der richtige Free-Tier?

Nein — jedenfalls nicht heute. Der Anlass ist *eine* Studentin mit einem Semester-Deck.
Die Zahlen:

- Ein 2.000-Karten-Deck komplett vertonen: **6,00 $ einmalig**.
- Free-Quote 50 Karten/Monat: **0,15 $/Monat** — also ~2,5 % dessen, was im ersten Monat
  gebraucht wird. Das Deck wäre nach **40 Monaten** vertont.

Die Quote ist aus der 1.000-Nutzer-Rechnung (§6 des Zielbilds, 180 $/Monat) abgeleitet,
gilt aber ab Nutzer eins. Damit optimiert der Plan gegen ein Risiko, das erst bei
offener Registrierung existiert, und zerstört dabei genau den Anwendungsfall, für den er
geschrieben wurde („beim Spazierengehen das Deck hören").

**Sinnvollere Form desselben Schutzes:**

1. **Einmaliges Willkommens-Kontingent** (z. B. 150.000–400.000 Zeichen, lebenslang),
   das den Import-Stoß am Anfang abdeckt — der ist einmalig, nicht wiederkehrend.
2. **Kleinere monatliche Nachfüllung** danach (z. B. 30.000–50.000 Zeichen ≈
   150–250 neue Karten/Monat) — deckt den realen Zuwachs im Semester.
3. **Globaler Ausgabenwächter** (§4.1) als eigentliche Obergrenze.
4. **Geschlossene Registrierung**, solange 1–3 großzügig sind (§4.2).

Das schützt exakt so gut (harte Obergrenze bleibt der globale Wächter), ist aber für die
Zielnutzerin brauchbar. Und wenn §2.1/§2.2 umgesetzt sind, fällt der Preis pro
zusätzlicher Nutzerin mit demselben Deck ohnehin gegen null.

**Und die Basislinie nicht vergessen:** Solange es um eine einzige Person geht, ist der
billigste korrekte Weg der aus `PLAN-pricing-tiers.md` §0 — ihr in den Einstellungen
OpenAI + Deepgram auswählen und einen Key hinterlegen. Null Zeilen Code, sofort, und
Deepgrams 200 $ Guthaben deckt STT auf Jahre. Jeder Schritt des Free-Tier-Plans sollte
sich daran messen lassen, ob er mehr bringt als diese fünf Minuten Einrichtung. (Er
bringt mehr — aber erst ab dem Punkt, an dem *Fremde* sich anmelden sollen, und dann
zählen §4.2 und §4.5 mehr als die Quotenhöhe.)

---

## 7. Vorgeschlagene Reihenfolge (überarbeitet)

| # | Schritt | Aufwand | Warum an dieser Stelle |
|---|---|---|---|
| 0 | **Globaler Ausgabenwächter** (KV-Monatszähler → Cache-only + Token-Stopp) + Provider-Ausgabenwarnungen | XS–S | Einzige echte Obergrenze; muss **vor** dem ersten Platform-Key stehen |
| 1 | Kostenerfassung korrigieren: TTS-Raten, **STT-Rate**, echte STT-Dauer | XS–S | Wie im Plan — nur mit der STT-Rate ergänzt |
| 2 | **Default-Provider auf OpenAI/Deepgram**, UI markiert Provider ohne Key | XS | Sonst ist Schritt 3 wirkungslos (§3.1) |
| 3 | Platform-Keys + `resolveKey` **mit Feature-Allowlist**, nur `/api/tts` + `/api/deepgram-token` | S | Der eigentliche Anlassfall ist damit erledigt |
| 4 | **Cache-Key ohne `userId` für Platform-Synthesen** + **Retention 30 → 180/365 Tage** | XS | Größter Kostenhebel im ganzen Plan, zwei Konstanten (§2) |
| 5 | **Zeichenquote** (Willkommens-Kontingent + monatliche Nachfüllung) + stille Degradation im Client | M | Ersetzt `voiced_cards`; §3.2, §3.3, §6 |
| 6 | STT: Sitzungen/Tag + eine aktive Sitzung, serverseitig | S | Echte Grenze statt Selbstauskunft (§3.4) |
| 7 | VAD-Gating in `deepgram.ts` (+ gespiegelt in `elevenlabs.ts`) | S–M | Bleibt richtig — als Kostensenkung, nicht als Grenze |
| 8 | Onboarding + Einstellungen + Verbrauchsanzeige | M | Wie im Plan |
| 9 | **Rechtspaket** (AVV, Auftragsverarbeiter, Datenschutz, Impressum, Zero-Retention) | M | Vor dem Öffnen der Registrierung, nicht danach (§4.5) |

Gegenüber dem Originalplan: Schritt 0, 2, 4, 6 und 9 sind neu; „TTS-Quota" wird zur
Zeichenquote; VAD rutscht hinter die beiden Cache-Änderungen, weil die mehr sparen und
weniger kosten.

---

## 8. Offene Fragen an dich

1. **Ist die Hanko-Registrierung derzeit offen?** Das entscheidet, ob Schritt 0 und die
   Quotenhöhe scharf sind oder Vorsorge (§4.2).
2. **Wie viel darf der Free-Tier insgesamt pro Monat kosten?** Eine Zahl (z. B. 10 $)
   macht Schritt 0 sofort konkret und die Quotendiskussion überflüssig.
3. **Sollen Free-Nutzer denselben Cache teilen?** (§2.1) — ich halte es für richtig,
   es ist aber eine bewusste Entscheidung mit Datenschutz-Nebenwirkung.
4. **Wann sollen sich Fremde anmelden können?** Davon hängt ab, ob §4.5 jetzt oder
   später fällig ist.
