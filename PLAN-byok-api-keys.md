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

- `PUT` — Upsert an API key for a service
  - Body: `{ service: 'openai' | 'deepgram' | 'anthropic', key: string }`
  - Validates key format (basic prefix check: `sk-` for OpenAI, `sk-ant-` for Anthropic, etc.)
  - Encrypts and stores in D1
  - Response: `{ success: true }`

- `DELETE` — Remove an API key
  - Body: `{ service: 'openai' | 'deepgram' | 'anthropic' }`
  - Deletes from D1
  - Response: `{ success: true }`

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

### Step 10: Update Dashboard / Review Flow

When a user tries to start a review session without any keys configured:
- Show a clear message directing them to Settings
- Don't let them enter the review flow with missing keys (check on the review page load or via a layout data loader)

## File Changes Summary

| File | Action |
|------|--------|
| `migrations/0005_user_api_keys.sql` | **New** — create table |
| `src/lib/server/crypto.ts` | **New** — encrypt/decrypt functions |
| `src/lib/server/user-keys.ts` | **New** — helper to load+decrypt user keys |
| `src/routes/api/settings/api-keys/+server.ts` | **New** — GET/PUT/DELETE endpoints |
| `src/app.d.ts` | **Edit** — add `ENCRYPTION_KEY`, remove 3 API key vars |
| `src/hooks.server.ts` | **Edit** — remove deepgram-token from public paths |
| `src/routes/api/tts/+server.ts` | **Edit** — use user key |
| `src/routes/api/explain/+server.ts` | **Edit** — use user key |
| `src/routes/api/deepgram-token/+server.ts` | **Edit** — use user key, require auth |
| `src/routes/settings/+page.svelte` | **Edit** — add API key management UI |
| `src/lib/i18n/en.ts` | **Edit** — add BYOK strings |
| `src/lib/i18n/de.ts` | **Edit** — add BYOK strings (German) |
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

- Key validation by making a test API call (could add later as "test key" button)
- Usage tracking / rate limiting per user
- Payment tiers / subscription gating
- Key rotation reminders
