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
│                      │                                    │
└──────────────────────┼────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌──────────┐  ┌───────────┐  ┌───────────┐
  │ Deepgram │  │  Claude   │  │ OpenAI    │
  │ Nova-3   │  │ Haiku 4.5 │  │ TTS       │
  │  (STT)   │  │(eval/chat)│  │           │
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

### Voice Flow (per card)

```
1. Select next due card (FSRS scheduler)
2. Send card front text → OpenAI TTS → stream audio to user
3. User listens, then speaks their answer
4. getUserMedia captures audio → stream to Deepgram → get transcript
5. Send {question, correct_answer, user_transcript} → Claude Haiku 4.5
6. Claude returns {rating: 1-4, feedback: "...", correct: bool} via tool use
7. Stream feedback → OpenAI TTS → play for user
8. Update card schedule with FSRS using the rating
9. Repeat
```

---

## 3. Claude AI Integration

### Model: Claude Haiku 4.5

- **Model ID**: `claude-haiku-4-5-20250710`
- **Input**: $1.00/1M tokens | **Output**: $5.00/1M tokens
- **Cost per 50-card session**: ~$0.02-0.03
- **Monthly cost** (3 sessions/day): ~$2-3

### System Prompt

```
You are a study assistant helping a user review flashcards through spoken conversation.
You evaluate the user's verbal answers against correct answers on flashcards.

Rules:
- Be encouraging but honest about answer quality
- Accept answers that demonstrate understanding even if wording differs from the card
- Consider partial knowledge — not everything is pass/fail
- Keep responses concise and conversational (the user is listening, not reading)
- When the user's answer is wrong, briefly explain why before revealing the correct answer
```

### Answer Evaluation (Tool Use)

Use forced tool use for structured, parseable output:

```typescript
const message = await anthropic.messages.create({
  model: "claude-haiku-4-5-20250710",
  max_tokens: 150,
  system: [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" } // cached across session
    }
  ],
  tools: [
    {
      name: "rate_answer",
      description: "Rate the user's answer and provide brief spoken feedback",
      input_schema: {
        type: "object",
        properties: {
          rating: {
            type: "integer",
            enum: [1, 2, 3, 4],
            description: "1=no recall, 2=partial, 3=correct with effort, 4=perfect"
          },
          feedback: {
            type: "string",
            description: "1-2 sentence conversational feedback (spoken aloud)"
          },
          correct: {
            type: "boolean",
            description: "Whether the core concept was understood"
          }
        },
        required: ["rating", "feedback", "correct"]
      }
    }
  ],
  tool_choice: { type: "tool", name: "rate_answer" },
  messages: [{
    role: "user",
    content: `Question: ${card.front}\nCorrect answer: ${card.back}\nUser said: ${transcript}`
  }]
});
```

### Key API Features Used

| Feature | Purpose |
|---|---|
| **Tool use** | Structured {rating, feedback, correct} output |
| **Forced tool_choice** | Guarantees tool call, no free-form parsing needed |
| **Prompt caching** | 90% discount on system prompt for all cards in a session |
| **Streaming** | Feed feedback text to TTS as tokens arrive (for hints/explanations) |

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
| Claude Haiku 4.5 | ~$2-3 | With prompt caching |
| Deepgram STT | ~$3-5 | ~15 min audio/day |
| OpenAI TTS | ~$1-2 | ~2000 chars/session |
| Cloudflare | $0 (free tier) | Until significant scale |
| Hanko | $0 (free tier) | Until 10K MAU |
| **Total** | **~$6-10/user/month** | |

---

## 8. MVP Feature Set

### Dashboard (Minimal UI)
- Deck list with card counts and due counts
- Upload .apkg file
- Export deck back to .apkg
- Basic stats (cards reviewed today, streak)
- Settings (voice selection, playback speed)

### Voice Review Mode
- Hands-free card review loop
- AI reads question aloud (OpenAI TTS)
- User speaks answer (Deepgram STT)
- Claude evaluates and gives feedback
- FSRS scheduling updates automatically
- Voice commands: "skip", "hint", "repeat", "stop"

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
