# AnkiTalk - Technical Research & Architecture

> AI-powered voice-based flashcard review assistant. Study your Anki decks hands-free during commutes, walks, or chores.

## Decisions Made

| Decision | Choice | Rationale |
|---|---|---|
| Anki Integration | .apkg file upload/export | No official Anki REST API exists; this is the most portable approach |
| Text-to-Speech | OpenAI TTS | Best value ($0.60/1M chars), good quality, ~250ms latency |
| Speech-to-Text | Deepgram Nova-3 | Web Speech API is broken on iOS PWA; Deepgram works everywhere |
| AI Model | Claude Haiku 4.5 | Cheapest (~$0.02/session), fast, structured output via tool use |
| Auth | Hanko Cloud | Passkey-first, free <10K MAU, drop-in web components |
| Framework | SvelteKit | Smallest bundles, native Cloudflare adapter, reactive primitives |
| Hosting | Cloudflare Pages + Workers | Edge deployment, D1/KV/R2 storage, free tier generous |
| App Type | PWA | Single codebase, installable, works on all platforms |
| MVP Scope | Voice review + minimal dashboard UI | Deck list, upload/export, basic stats, and the core voice review loop |
| Review UX | Self-rated, no AI answer evaluation | User thinks silently, says "show" to reveal, self-rates with voice. Saves Claude costs. |
| Card Types | Cloze + images supported | Cloze → voice-friendly fill-in-the-blank; image cards displayed on screen with TTS |
| STT Mode | Real-time streaming via Durable Objects | Commands feel instant; only short utterances (commands/ratings), not full answers |
| AI Role | "Explain" command only | Claude not invoked per-card; only when user asks for explanation. Major cost savings. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User's Device (PWA)                   │
│  ┌─────────┐   ┌──────────┐   ┌──────────────────────┐  │
│  │ Mic In  │──▶│getUserMed│──▶│  WebSocket to Worker  │  │
│  └─────────┘   │ia/Record │   └──────────┬───────────┘  │
│                └──────────┘              │               │
│  ┌─────────┐   ┌──────────┐              │               │
│  │ Speaker │◀──│Audio Play│◀─────────────┤               │
│  └─────────┘   └──────────┘              │               │
│  ┌──────────────────────┐                │               │
│  │  <hanko-auth /> UI   │                │               │
│  └──────────────────────┘                │               │
└──────────────────────────────────────────┼───────────────┘
                                           │
┌──────────────────────────────────────────┼───────────────┐
│              Cloudflare Workers / Pages                   │
│  ┌──────────┐  ┌───────────┐  ┌─────────┴────────────┐  │
│  │ SvelteKit│  │ API Routes│  │  Cloudflare D1 / KV  │  │
│  │   SSR    │  │ (+server) │  │  (cards, scheduling)  │  │
│  └──────────┘  └─────┬─────┘  └──────────────────────┘  │
│                      │         ┌──────────────────────┐  │
│                      │         │  Durable Object      │  │
│                      │         │  (WebSocket relay)   │  │
│                      │         └──────────────────────┘  │
└──────────────────────┼────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌──────────┐  ┌───────────┐  ┌───────────┐
  │ Deepgram │  │  Claude   │  │ OpenAI    │
  │ Nova-3   │  │ Haiku 4.5 │  │ TTS       │
  │  (STT)   │  │(explain)  │  │           │
  └──────────┘  └───────────┘  └───────────┘

  ┌───────────┐
  │Hanko Cloud│  (passkey auth, JWT sessions)
  └───────────┘
```

---

## 1. Anki Integration

### The Problem

There is no official Anki REST API. AnkiWeb's sync protocol is undocumented and changes between versions. AnkiConnect (the community plugin) requires desktop Anki running and only listens on localhost.

### Solution: .apkg File Upload/Export

The `.apkg` format is a ZIP containing:
- `collection.anki21` — SQLite database with cards, notes, decks, and models
- `media` file — JSON mapping of numeric filenames to original media filenames
- Media files (images, audio) stored as numbered files

**Parsing stack:**
- `anki-reader` npm package (uses sql.js/WASM to parse the SQLite DB)
- Alternative: `sql.js` directly to query the `collection.anki21` database

**Key database tables:**
- `notes` — the actual content (fields separated by `\x1f`)
- `cards` — card instances linked to notes
- `decks` (in `col.decks` JSON) — deck metadata
- `models` (in `col.models` JSON) — note type definitions (field names, templates)

**Workflow:**
1. User uploads `.apkg` file via the dashboard
2. Server-side Worker extracts the ZIP, parses SQLite, stores cards in D1
3. Media files (images/audio) stored in R2
4. AnkiTalk runs its own FSRS scheduling (see below)
5. User can export back to `.apkg` for re-import into Anki

### FSRS Scheduling

FSRS (Free Spaced Repetition Scheduler) is the modern scheduling algorithm used by Anki 23.10+. TypeScript implementations exist:
- `ts-fsrs` npm package

FSRS parameters per card:
- `stability` — how long until 90% recall probability
- `difficulty` — inherent card difficulty (0-10)
- `due` — next review date
- `state` — New/Learning/Review/Relearning

Rating scale (1-4):
| Rating | Meaning | Effect |
|---|---|---|
| 1 (Again) | No recall | Reset, show again soon |
| 2 (Hard) | Partial recall | Short interval |
| 3 (Good) | Correct with effort | Medium interval |
| 4 (Easy) | Perfect instant recall | Long interval |

---

## 2. Voice Pipeline

### Why NOT Web Speech API

| Platform | SpeechRecognition Status |
|---|---|
| Chrome Desktop | Works (sends audio to Google servers) |
| Chrome Android | Delegates to Android; continuous mode broken |
| Safari macOS | Broken if Siri is enabled |
| **iOS PWA** | **Silently fails — unfixed WebKit bug since 2021** |
| Firefox | Not supported at all |

The Web Speech API is a non-starter for a PWA that must work on iPhones.

### Speech-to-Text: Deepgram Nova-3

- **Real-time streaming** via WebSocket — sub-300ms latency
- **Cost**: $0.0077/min (pay-per-use, no minimums)
- **Works everywhere** because we capture audio with `getUserMedia` / `MediaRecorder` (which DOES work on iOS PWAs) and stream it server-side
- Smart formatting, punctuation, endpointing built-in

**Integration pattern:**
```
[Browser] --getUserMedia--> [MediaRecorder] --WebSocket--> [CF Worker] --WebSocket--> [Deepgram]
                                                                                         |
[Browser] <--transcript text-- [CF Worker] <--transcript JSON--------------------------+
```

Cloudflare Workers support WebSocket connections via Durable Objects or direct WebSocket upgrade. The Worker acts as a relay between the browser and Deepgram, adding authentication and session management.

### Text-to-Speech: OpenAI TTS

- **Models**: `tts-1` (fast, lower quality) or `tts-1-hd` (higher quality)
- **Voices**: alloy, echo, fable, onyx, nova, shimmer
- **Cost**: $0.60 per 1M characters ($15/1M for HD)
- **Formats**: mp3, opus, aac, flac, wav, pcm
- **Streaming**: Yes — response body streams audio chunks
- **Latency**: ~250ms to first byte

**Integration pattern:**
```typescript
const response = await openai.audio.speech.create({
  model: "tts-1",
  voice: "nova",
  input: "What is the powerhouse of the cell?",
  response_format: "opus", // smallest, good quality
});
// Stream audio bytes back to the browser
```

### Session Flow (UX)

The core design principle: **the user self-rates**, just like in Anki. Claude is NOT invoked per-card — only when the user explicitly asks for an explanation. This keeps costs low and the flow fast.

#### States & Transitions

```
┌─────────────┐
│ SESSION START│  User selects deck, taps "Start Review"
└──────┬──────┘
       ▼
┌─────────────┐  TTS reads the card front aloud.
│  QUESTION   │  Image cards: image displayed on screen.
│  PHASE      │  Cloze: "Fill in the blank: The ___ is the powerhouse..."
│             │  User thinks of the answer silently.
│             │
│  Commands:  │  "answer"  → TTS reads the correct answer aloud → go to RATING
│             │  "hint"    → TTS reads first few words of answer
│             │  "repeat"  → TTS re-reads the question
│             │  "stop"    → end session
│             │
│  Ratings:   │  "again" / "hard" / "good" / "easy" → rate directly, next card
│             │  (user rates without hearing answer — trusts self-assessment)
└──────┬──────┘
       │ user says "answer"
       ▼
┌─────────────┐  TTS reads the correct answer aloud.
│  RATING     │  Answer also displayed on screen.
│  PHASE      │
│  Commands:  │  "explain" → Claude explains, TTS reads, chime when done
│             │  "repeat"  → TTS re-reads the answer
│             │  "stop"    → end session
│             │
│  Ratings:   │  "again" / "hard" / "good" / "easy" → rate, next card
└──────┬──────┘
       │ user says rating
       ▼
┌─────────────┐  FSRS scheduler updates card state.
│  NEXT CARD  │  Auto-advance to next due card → back to QUESTION PHASE.
│             │  If no cards left → session summary.
└─────────────┘
```

#### Voice Commands Summary

| Command | Available In | Effect |
|---|---|---|
| **"answer"** | Question | TTS reads the correct answer aloud, transition to Rating Phase |
| **"hint"** | Question | TTS reads first few words/letters of the answer |
| **"repeat"** | Question, Rating | Re-read the last spoken text (question or answer) |
| **"explain"** | Rating | Claude explains the answer in context, TTS reads it, chime when done |
| **"again"** | Question, Rating | Rate as Again (1), advance to next card |
| **"hard"** | Question, Rating | Rate as Hard (2), advance to next card |
| **"good"** | Question, Rating | Rate as Good (3), advance to next card |
| **"easy"** | Question, Rating | Rate as Easy (4), advance to next card |
| **"stop"** | Any | End the review session, show summary |

#### Card Type Handling

| Card Type | Voice Behavior | Visual |
|---|---|---|
| **Basic (front/back)** | TTS reads front, then back on reveal | Text displayed |
| **Cloze deletion** | "Fill in the blank: The ___ is the powerhouse of the cell" | Cloze text displayed |
| **Image cards** | TTS reads any text; image shown on screen | Image + text displayed |
| **Audio cards** | Play original audio from Anki media | Playback controls shown |

#### Voice Flow (per card)

```
1. Select next due card (FSRS scheduler)
2. Send card front text → OpenAI TTS → stream audio to user
3. Image cards: display image on screen alongside TTS
4. Cloze cards: convert {{c1::answer}} to "___" in TTS, display on screen
5. STT listens for voice commands via Deepgram streaming WebSocket
6. On rating (again/hard/good/easy) → Update FSRS schedule → next card
7. On "answer" → TTS reads correct answer aloud → enter Rating Phase
8. On "explain" (Rating Phase) → Send {question, answer} to Claude → TTS reads explanation
9. On rating → Update FSRS schedule → next card
10. Repeat
```

---

## 3. Claude AI Integration

### Role: "Explain" Command Only

Claude is **not invoked per-card**. The user self-rates (Again/Hard/Good/Easy), so there's no need for AI answer evaluation on every card. Claude is only called when the user says **"explain"** during the Reveal Phase.

This dramatically reduces costs: from ~$2-3/month to pennies, since most cards won't trigger an explanation.

### Model: Claude Haiku 4.5

- **Model ID**: `claude-haiku-4-5-20250710`
- **Input**: $1.00/1M tokens | **Output**: $5.00/1M tokens
- **Cost per "explain"**: ~$0.001 (small prompt, short response)
- **Monthly cost**: ~$0.10-0.50 (assuming 5-10 explains/session, 3 sessions/day)

### System Prompt

```
You are a study assistant helping a user understand flashcard answers.
When asked to explain, provide a brief, clear explanation of why the answer is correct.

Rules:
- Keep explanations concise (2-4 sentences) — the user is listening, not reading
- Add helpful context, mnemonics, or connections to aid memory
- If the card has a cloze deletion, explain the concept behind the missing word
- Be conversational and encouraging
```

### Explain Endpoint

```typescript
const message = await anthropic.messages.create({
  model: "claude-haiku-4-5-20250710",
  max_tokens: 200,
  system: [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" }
    }
  ],
  messages: [{
    role: "user",
    content: `Flashcard question: ${card.front}\nCorrect answer: ${card.back}\n\nPlease explain this answer briefly.`
  }],
  stream: true // Stream to TTS for low-latency audio
});
```

### Key API Features Used

| Feature | Purpose |
|---|---|
| **Prompt caching** | 90% discount on system prompt across session |
| **Streaming** | Feed explanation text to TTS as tokens arrive for low-latency audio |

---

## 4. Authentication: Hanko Cloud

### Why Hanko

- **Passkey-first** — modern, phishing-resistant auth
- **Email passcode fallback** — works for users without passkey support
- **Free tier**: up to 10,000 MAU
- **Drop-in web components**: `<hanko-auth>`, `<hanko-profile>`
- **JWT sessions** — verified in Cloudflare Workers with JWKS
- **Self-hostable** later (AGPL v3)

### SvelteKit Integration

```typescript
// src/lib/hanko.ts
import { Hanko } from "@teamhanko/hanko-elements";
export const hanko = new Hanko(PUBLIC_HANKO_API_URL);

// src/routes/login/+page.svelte
<script>
  import { onMount } from "svelte";
  import { register } from "@teamhanko/hanko-elements";
  import { PUBLIC_HANKO_API_URL } from "$env/static/public";

  onMount(() => register(PUBLIC_HANKO_API_URL));
</script>

<hanko-auth />
```

### Backend JWT Verification

```typescript
// src/hooks.server.ts — SvelteKit server hook
import * as jose from "jose";

const JWKS = jose.createRemoteJWKSet(
  new URL(`${HANKO_API_URL}/.well-known/jwks.json`)
);

export const handle = async ({ event, resolve }) => {
  const token = event.cookies.get("hanko");
  if (token) {
    const { payload } = await jose.jwtVerify(token, JWKS);
    event.locals.userId = payload.sub;
  }
  return resolve(event);
};
```

---

## 5. Cloudflare Infrastructure

### SvelteKit on Cloudflare Pages

```bash
npx sv create ankitalk    # choose SvelteKit skeleton
npm i -D @sveltejs/adapter-cloudflare
```

```javascript
// svelte.config.js
import adapter from "@sveltejs/adapter-cloudflare";

export default {
  kit: {
    adapter: adapter({
      routes: { include: ["/*"], exclude: ["<all>"] }
    })
  }
};
```

### Storage

| Service | Use | Free Tier |
|---|---|---|
| **D1** (SQLite) | Users, cards, notes, decks, FSRS state, review history | 5M reads/day, 100K writes/day |
| **KV** | Session data, user preferences, feature flags | 100K reads/day, 1K writes/day |
| **R2** | Media files from Anki decks (images, audio) | 10 GB storage, 10M reads/month |

### D1 Schema (draft)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,        -- from Hanko JWT sub
  created_at INTEGER NOT NULL,
  settings TEXT               -- JSON preferences
);

CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  anki_deck_id INTEGER,       -- original Anki deck ID
  card_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  deck_id TEXT NOT NULL REFERENCES decks(id),
  anki_note_id INTEGER,
  model_name TEXT,            -- note type name
  fields TEXT NOT NULL,       -- JSON array of field values
  tags TEXT,                  -- space-separated tags
  created_at INTEGER NOT NULL
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  note_id TEXT NOT NULL REFERENCES notes(id),
  deck_id TEXT NOT NULL REFERENCES decks(id),
  card_ord INTEGER DEFAULT 0, -- card ordinal within note
  -- FSRS state
  fsrs_state TEXT DEFAULT 'new', -- new/learning/review/relearning
  fsrs_stability REAL DEFAULT 0,
  fsrs_difficulty REAL DEFAULT 0,
  due_at INTEGER NOT NULL,
  last_review_at INTEGER,
  review_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  rating INTEGER NOT NULL,    -- 1-4
  feedback TEXT,              -- Claude's feedback
  transcript TEXT,            -- user's spoken answer
  duration_ms INTEGER,        -- time to answer
  reviewed_at INTEGER NOT NULL
);

CREATE INDEX idx_cards_due ON cards(user_id, deck_id, due_at);
CREATE INDEX idx_reviews_user ON reviews(user_id, reviewed_at);
```

---

## 6. PWA Configuration

### Service Worker Strategy

- **Cache-first** for static assets (SvelteKit build output)
- **Network-first** for API routes
- **No offline card review** in MVP (requires Deepgram + Claude API)
- Use SvelteKit's `$service-worker` module or `vite-plugin-pwa`

### Manifest

```json
{
  "name": "AnkiTalk",
  "short_name": "AnkiTalk",
  "description": "Voice-powered Anki flashcard review",
  "start_url": "/",
  "display": "standalone",
  "theme_color": "#1a1a2e",
  "background_color": "#1a1a2e",
  "icons": [...]
}
```

### iOS PWA Considerations

- `getUserMedia` works in PWA mode on iOS (even though Web Speech API doesn't)
- Audio playback requires user gesture to start (Web Audio API unlock pattern)
- No push notifications on iOS PWAs
- Add `<meta name="apple-mobile-web-app-capable" content="yes">`

---

## 7. Cost Estimates (Per User Per Month)

Assuming 3 study sessions/day, 50 cards/session:

| Service | Monthly Cost | Notes |
|---|---|---|
| Claude Haiku 4.5 | ~$0.10-0.50 | Only invoked on "explain" command, not per-card |
| Deepgram STT | ~$1-2 | Short commands only, not full answers (~5 min audio/day) |
| OpenAI TTS | ~$1-2 | ~2000 chars/session (questions + answers + explanations) |
| Cloudflare | $0 (free tier) | Durable Objects: $0.15/M requests (negligible at personal scale) |
| Hanko | $0 (free tier) | Until 10K MAU |
| **Total** | **~$2-4.50/user/month** | Significantly lower due to self-rating UX |

---

## 8. MVP Feature Set

### Dashboard (Minimal UI)
- Deck list with card counts and due counts
- Upload .apkg file
- Export deck back to .apkg
- Basic stats (cards reviewed today, streak)
- Settings (voice selection, playback speed)

### Voice Review Mode
- Hands-free card review loop (self-rated, like native Anki)
- TTS reads question aloud → user thinks silently → says "show" → TTS reads answer
- User self-rates by saying "again", "hard", "good", or "easy"
- "Easy" during question phase skips reveal (power-user shortcut)
- Voice commands: "answer", "hint", "repeat", "explain", "again", "hard", "good", "easy", "stop"
- "Explain" invokes Claude for deeper context (only AI call in the flow)
- Cloze cards rendered as fill-in-the-blank for TTS
- Image cards displayed on screen with TTS for any text
- FSRS scheduling updates automatically based on user rating
- Deepgram real-time STT via Durable Object WebSocket relay

### Not in MVP
- Card editing/creation in the web UI
- Shared decks / social features
- Offline mode
- Desktop app (Tauri)
- AnkiConnect integration
- Multi-language TTS voice auto-detection

---

## 9. External Dependencies

| Package | Purpose | License |
|---|---|---|
| `@sveltejs/kit` | Framework | MIT |
| `@sveltejs/adapter-cloudflare` | Cloudflare deployment | MIT |
| `@anthropic-ai/sdk` | Claude API client | MIT |
| `@deepgram/sdk` | Speech-to-text | MIT |
| `openai` | TTS API client | Apache-2.0 |
| `@teamhanko/hanko-elements` | Auth UI components | MIT |
| `jose` | JWT verification | MIT |
| `ts-fsrs` | FSRS scheduling algorithm | MIT |
| `anki-reader` | .apkg file parsing | MIT |
| `sql.js` | SQLite in WASM (used by anki-reader) | MIT |
| `jszip` | ZIP extraction for .apkg | MIT/GPLv3 |

---

## 10. SRS Implementation Phases

### Phase 1 (done) — Learning steps, daily limits, card ordering, sibling burying
- `deck_settings` table with `new_cards_per_day`, `max_reviews_per_day`
- Learning/relearning queue (intra-session re-presentation of short-interval cards)
- Sibling burying (one card per note per day)
- Daily limit enforcement in card fetch query
- Undo last rating (5s window)

### Phase 2 (done) — FSRS tuning, leeches, suspension, statistics
- Per-deck FSRS parameters (`desired_retention`, `max_interval`) via deck settings UI
- Leech detection: auto-suspend cards exceeding `leech_threshold` lapses
- Manual card suspension (voice command, keyboard shortcut `S`, button)
- Suspended cards excluded from all review/due-count queries
- Deck statistics page: card state breakdown, retention rate, daily review chart (SVG)
- Deck settings page: retention slider, max interval, leech threshold, daily limits

### Phase 3 (planned) — Card management, export, browse

**Gaps to close:**

1. **Card browser / management UI** — No way to see all cards in a deck, search by content, or view card state. Users need this to find suspended cards, check schedules, and manage problem cards.

2. **Unsuspend / bulk actions** — Cards get auto-suspended as leeches but there's no UI to find and unsuspend them. Need a filtered view (suspended, leeches, state-based).

3. **Card editing** — Currently import-only. Users should be able to edit card content (front/back fields) and create new cards directly in the app.

4. **Export to .apkg** — Listed in MVP scope but not yet implemented. Users need to get their updated scheduling data back into Anki.

5. **Tag-based review** — Anki users organize with tags heavily. Allow filtering review sessions by tag (e.g., review only `chapter-5` cards).

6. **Custom study / cram mode** — Study cards outside normal schedule: preview new cards, review ahead, study by tag, or re-study recent mistakes.

7. **Server-side undo** — Current undo is client-only (5s window). A proper undo would reverse the review record and restore previous FSRS state.

**Implementation sketch:**

- `GET /api/decks/:id/cards?state=suspended&q=search&page=1` — paginated card browser API
- `/decks/:id/cards` — browse page with search, state filters, bulk suspend/unsuspend
- `PUT /api/cards/:id` — edit card fields
- `POST /api/decks/:id/cards` — create new card (creates note + card)
- `GET /api/decks/:id/export` — generate .apkg ZIP and stream it
- `GET /api/cards/next?deckId=X&tags=tag1,tag2` — tag filtering in review
- `POST /api/cards/:id/review/undo` — server-side undo (delete review, restore previous FSRS snapshot)
