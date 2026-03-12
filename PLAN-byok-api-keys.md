# Plan: Bring Your Own Key (BYOK) API Key Management

## Overview

Allow users to securely store and use their own API keys for OpenAI (TTS), Deepgram (STT), and Anthropic (AI explanations). No platform key fallback — every user must provide their own keys.

## Architecture

```
Settings Page (client)
  │  user enters API key
  ▼
POST /api/settings/api-keys (server)
  │  validate key format
  │  encrypt with AES-256-GCM (Web Crypto API)
  │  store in D1 (user_api_keys table)
  ▼
API request (e.g. POST /api/tts)
  │  load encrypted key from D1
  │  decrypt server-side
  │  use for API call
  │  if no key → return 400 "Add your key in Settings"
```

## Implementation Steps

### Step 1: Database Migration (`migrations/0005_user_api_keys.sql`)

New table:

```sql
CREATE TABLE user_api_keys (
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,          -- 'openai' | 'deepgram' | 'anthropic'
  encrypted_key TEXT NOT NULL,    -- base64(iv + ciphertext + tag)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, service),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

Composite primary key `(user_id, service)` — one key per service per user, upsert on save.

### Step 2: Encryption Module (`src/lib/server/crypto.ts`)

New file with two functions:

- `encryptApiKey(plaintext: string, masterKey: string): Promise<string>`
  - Generates random 12-byte IV
  - Encrypts with AES-256-GCM using Web Crypto API
  - Returns base64-encoded `iv + ciphertext + authTag` as single string

- `decryptApiKey(encrypted: string, masterKey: string): Promise<string>`
  - Decodes base64, splits IV (first 12 bytes), ciphertext+tag (rest)
  - Decrypts with AES-256-GCM
  - Returns plaintext key

The master key is a 256-bit key stored as a Cloudflare secret (`ENCRYPTION_KEY`). Generated once via `openssl rand -base64 32`.

### Step 3: Cloudflare Config Changes

**`src/app.d.ts`** — Add `ENCRYPTION_KEY: string` to `App.Platform.env`

**`wrangler.jsonc`** — No change needed (secret set via `wrangler secret put ENCRYPTION_KEY`)

**Remove** `OPENAI_API_KEY`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY` from platform env declarations (no longer used as platform keys).

### Step 4: API Key Management Endpoints

**`src/routes/api/settings/api-keys/+server.ts`**

- `GET` — Returns which services have keys configured (NOT the keys themselves)
  - Response: `{ openai: boolean, deepgram: boolean, anthropic: boolean }`

- `PUT` — Validate, then upsert an API key for a service
  - Body: `{ service: 'openai' | 'deepgram' | 'anthropic', key: string }`
  - Validates key format (basic prefix check: `sk-` for OpenAI, `sk-ant-` for Anthropic, etc.)
  - **Makes a test API call to verify the key works** (see Step 4b)
  - If test fails → return error with specific reason, do NOT store
  - If test passes → encrypt and store in D1
  - Response: `{ success: true }`

- `DELETE` — Remove an API key
  - Body: `{ service: 'openai' | 'deepgram' | 'anthropic' }`
  - Deletes from D1
  - Response: `{ success: true }`

### Step 4b: API Key Validation (test calls on save)

Before encrypting and storing a key, the PUT endpoint makes a lightweight test call:

| Service | Test Call | Cost | Why |
|---------|-----------|------|-----|
| **OpenAI** | `GET /v1/models` | Free | Lists available models, confirms key is valid and active |
| **Deepgram** | `POST /v1/auth/grant` (60s TTL token) | Free | Already have this logic, confirms key works |
| **Anthropic** | `POST /v1/messages` with `max_tokens: 1`, prompt "Hi" | ~$0.00001 | Cheapest possible call, confirms key + model access |

Error handling returns specific messages:
- 401 → "Invalid API key — please check and try again"
- 403 → "API key lacks required permissions"
- 429 → "API key is rate-limited — try again in a moment"
- Network error → "Could not reach {service} — check your key and try again"

### Step 5: Helper to Load User Keys (`src/lib/server/user-keys.ts`)

New file:

- `getUserApiKey(db: D1Database, userId: string, service: string, encryptionKey: string): Promise<string | null>`
  - Queries `user_api_keys` for the user+service
  - Decrypts and returns the key, or null if not set

This keeps the decryption logic DRY across all API endpoints.

### Step 6: Update API Endpoints

Each endpoint changes from reading `platform.env.API_KEY` to loading the user's encrypted key.

**`src/routes/api/tts/+server.ts`**
- Replace `platform.env.OPENAI_API_KEY` with `await getUserApiKey(db, userId, 'openai', encryptionKey)`
- If null, return `400` with message: `"Add your OpenAI API key in Settings to use text-to-speech"`

**`src/routes/api/explain/+server.ts`**
- Replace `platform.env.ANTHROPIC_API_KEY` with `await getUserApiKey(db, userId, 'anthropic', encryptionKey)`
- If null, return `400` with message: `"Add your Anthropic API key in Settings to use AI explanations"`

**`src/routes/api/deepgram-token/+server.ts`**
- Replace `platform.env.DEEPGRAM_API_KEY` with `await getUserApiKey(db, userId, 'deepgram', encryptionKey)`
- If null, return `400` with message: `"Add your Deepgram API key in Settings to use voice input"`
- Note: this endpoint is currently in the public paths list in `hooks.server.ts` — it needs to be moved to require auth (since we need `userId` to look up the key)

### Step 7: Update Auth Middleware (`src/hooks.server.ts`)

- Remove `/api/deepgram-token` from the public paths list (now requires auth to look up user key)

### Step 8: Settings Page UI (`src/routes/settings/+page.svelte`)

Add an "API Keys" section below the existing language selector:

- Three input fields (OpenAI, Deepgram, Anthropic)
- Each shows:
  - Status indicator (configured / not configured) — loaded via GET on mount
  - Password-type input for entering/updating key
  - Save button per key (calls PUT)
  - Remove button if key exists (calls DELETE)
- Keys are never displayed back to the user after saving (only boolean status)
- Brief help text with links to where users can get each key:
  - OpenAI: platform.openai.com/api-keys
  - Deepgram: console.deepgram.com
  - Anthropic: console.anthropic.com/settings/keys

### Step 9: i18n Strings (`src/lib/i18n/en.ts` and `src/lib/i18n/de.ts`)

Add translation keys for:
- `settings.apiKeys.title` — "API Keys"
- `settings.apiKeys.description` — "Add your own API keys to use AnkiTalk. Your keys are encrypted and stored securely."
- `settings.apiKeys.openai` — "OpenAI (Text-to-Speech)"
- `settings.apiKeys.deepgram` — "Deepgram (Speech-to-Text)"
- `settings.apiKeys.anthropic` — "Anthropic (AI Explanations)"
- `settings.apiKeys.configured` — "Configured"
- `settings.apiKeys.notConfigured` — "Not configured"
- `settings.apiKeys.save` — "Save"
- `settings.apiKeys.remove` — "Remove"
- `settings.apiKeys.saved` — "Key saved successfully"
- `settings.apiKeys.removed` — "Key removed"
- `settings.apiKeys.required` — "Add your {service} API key in Settings to use {feature}"
- `settings.apiKeys.getKey` — "Get your key at"
- `settings.apiKeys.placeholder` — "Paste your API key here"

### Step 10: Onboarding Checklist on Dashboard

When a new user lands on the dashboard (no keys, no decks), show a friendly onboarding checklist instead of an empty state:

**Component:** `src/lib/components/OnboardingChecklist.svelte`

```
Welcome to AnkiTalk! Let's get you set up:

  [✓] Create account                        ← always done
  [ ] Add API keys (2 required, 1 optional) ← links to Settings
  [ ] Import your first Anki deck           ← links to import flow
  [ ] Start your first review session       ← enabled once above are done
```

- Loaded via the dashboard's `+page.server.ts` or `+layout.server.ts` — query `user_api_keys` and `decks` count
- Each step shows ✓ when complete, links to the relevant page when not
- **Required vs optional is clear:** OpenAI + Deepgram marked as "Required", Anthropic marked as "Optional — for AI explanations"
- Checklist disappears once all required steps are done (user has keys + at least one deck)
- Can be dismissed manually (store dismissal in a cookie or D1)

### Step 11: Required vs Optional Key Distinction

In the Settings page API key section, clearly separate:

**Required for voice review:**
- OpenAI (Text-to-Speech) — "Reads your cards aloud"
- Deepgram (Speech-to-Text) — "Listens to your voice commands"

**Optional:**
- Anthropic (AI Explanations) — "Explains cards when you say 'explain'. You can review without this."

The review flow should:
- Block entry if OpenAI or Deepgram keys are missing → show banner with link to Settings
- Allow entry without Anthropic key → the "explain" command just returns a friendly message ("Add your Anthropic key in Settings to use explanations")

### Step 12: Cost Transparency in Settings

Next to each API key input, show estimated costs:

- **OpenAI TTS:** "~$0.003 per card read aloud (front + back avg 500 chars)"
- **Deepgram STT:** "~$0.01–0.03 per review session"
- **Anthropic:** "~$0.02 per explanation (only when you ask)"

### Step 13: Live Cost Tracking

Track API usage costs per user in real time so users can see what they're spending.

**New table** (`migrations/0005_user_api_keys.sql` — same migration):

```sql
CREATE TABLE api_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,           -- 'openai' | 'deepgram' | 'anthropic'
  operation TEXT NOT NULL,         -- 'tts' | 'stt_token' | 'explain'
  units INTEGER NOT NULL,          -- characters (TTS), seconds (STT), tokens (Anthropic)
  estimated_cost_usd REAL NOT NULL,-- calculated cost in USD
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_api_usage_user_date ON api_usage(user_id, created_at);
```

**Cost calculation** (server-side, logged after each successful API call):

| Service | Unit | Rate | Tracking |
|---------|------|------|----------|
| OpenAI TTS | characters | $0.60 / 1M chars | `text.length` from TTS request |
| Deepgram STT | seconds | ~$0.0043 / sec (Nova-3) | Estimated from session duration |
| Anthropic | input+output tokens | $1.00/$5.00 per 1M tokens (Haiku) | From API response `usage` field |

**New endpoint:** `GET /api/settings/usage`
- Returns usage summary: today, this week, this month, all time
- Response: `{ today: { openai: 0.02, deepgram: 0.01, anthropic: 0.00, total: 0.03 }, week: {...}, month: {...} }`

**Settings page UI addition:**
- "Usage & Costs" section below API keys
- Simple breakdown: per-service cost for today / this week / this month
- Total across all services
- Note: "Costs are estimated based on published API pricing and may differ slightly from your provider's invoice"

**API endpoint changes** — each service endpoint logs usage after a successful call:
- TTS: log `text.length` characters → calculate cost
- Deepgram token: log token grant (actual STT duration tracked client-side, sent back on session end)
- Explain: log input/output tokens from Anthropic response `usage` object

### Step 14: Missing Key Banner in Review Flow

If a user reaches `/review/[deckId]` without required keys:
- Show a clear banner: "You need OpenAI and Deepgram API keys to start reviewing. [Go to Settings]"
- Don't initialize the microphone or TTS — just show the banner
- Check via a server-side load function or client-side fetch to `/api/settings/api-keys`

## File Changes Summary

| File | Action |
|------|--------|
| `migrations/0005_user_api_keys.sql` | **New** — `user_api_keys` + `api_usage` tables |
| `src/lib/server/crypto.ts` | **New** — encrypt/decrypt functions |
| `src/lib/server/user-keys.ts` | **New** — helper to load+decrypt user keys |
| `src/lib/server/usage.ts` | **New** — cost tracking/logging helper |
| `src/routes/api/settings/api-keys/+server.ts` | **New** — GET/PUT/DELETE endpoints with key validation |
| `src/routes/api/settings/usage/+server.ts` | **New** — GET usage/cost summary |
| `src/lib/components/OnboardingChecklist.svelte` | **New** — onboarding checklist component |
| `src/app.d.ts` | **Edit** — add `ENCRYPTION_KEY`, remove 3 API key vars |
| `src/hooks.server.ts` | **Edit** — remove deepgram-token from public paths |
| `src/routes/api/tts/+server.ts` | **Edit** — use user key, log usage |
| `src/routes/api/explain/+server.ts` | **Edit** — use user key, log usage |
| `src/routes/api/deepgram-token/+server.ts` | **Edit** — use user key, require auth, log usage |
| `src/routes/settings/+page.svelte` | **Edit** — API key management + usage display UI |
| `src/routes/+page.svelte` | **Edit** — add onboarding checklist |
| `src/routes/+page.server.ts` (or `+layout.server.ts`) | **Edit** — load onboarding state |
| `src/routes/review/[deckId]/+page.svelte` | **Edit** — missing key banner |
| `src/lib/i18n/en.ts` | **Edit** — add BYOK + onboarding + usage strings |
| `src/lib/i18n/de.ts` | **Edit** — add BYOK + onboarding + usage strings (German) |
| `wrangler.jsonc` | **Edit** — remove API key vars from config |

## Security Considerations

- Keys encrypted at rest with AES-256-GCM (authenticated encryption)
- Master encryption key stored as Cloudflare secret (never in code/config)
- Keys only decrypted in-memory, server-side, at request time
- Keys never sent back to client (only boolean "configured" status)
- Each encrypted value has a unique random IV (no IV reuse)
- Auth required on all key management endpoints
- Input validation on key format before storage

## Out of Scope (Future)

- Payment tiers / subscription gating
- Key rotation reminders
- Usage alerts (e.g., "you've spent $5 this month")
- Detailed per-card cost breakdown
- STT duration tracking from client (for now, estimate from token grants)
