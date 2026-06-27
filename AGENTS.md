# AGENTS.md

Guidance for AI agents working in this repository.

## Deploy & testing workflow (important)

- **There is no useful local runtime for this app.** It depends on Cloudflare
  bindings (D1 `DB`, KV `KV`, R2 `MEDIA`), the edge Cache API, and Hanko auth —
  none of which behave like production locally. Features are tested on the
  **staging** Pages deploy (`https://staging.ankitalk.pages.dev`).
- **The user tests ONLY on staging, never locally.** To test, they must merge a
  PR into the `staging` branch, which triggers the Pages deploy.
- **Therefore: if the user comes back with test results, the relevant PR has
  ALREADY been merged to `staging` and deployed.** Do not assume they tested
  locally, and do not ask them to "run it locally." Their next round of feedback
  always implies a prior merge + deploy.
- Because a tested PR is already merged, **follow-up changes need a NEW PR** —
  you cannot keep pushing to the old one and expect it to redeploy. Open a fresh
  PR to `staging` for each new batch of changes.

## Branches & PRs

- Develop on the feature branch `claude/elevenlabs-integration-49vjva`.
- Feature PRs target **`staging`**. Production is a separate **`staging` → `main`** PR.
- Only open a PR when the user asks. Each merged-then-revised cycle = a new PR.

## Database migrations

- Migrations in `migrations/` are **applied by hand** via the Cloudflare D1
  console (Pages does not run them on build). Provide the raw SQL when a PR adds
  a migration. Apply to staging D1 first; production D1 only when promoting
  `staging` → `main`.
- Never run `wrangler` against the production database.

## R2 / TTS audio cache

- Synthesized audio is cached in the `MEDIA` R2 bucket under `tts/std/` and
  `tts/pin/` prefixes; retention is via R2 object-lifecycle rules configured
  per bucket (see `docs/r2-tts-lifecycle.md`) — a manual, one-time setup.
- `/api/tts` emits diagnostic headers (`X-TTS-Cache`, `X-TTS-Store`, `X-TTS-Hash`)
  and logs hit/miss outcomes to the settings cache monitor.

## Conventions

- Don't disable TLS verification or unset `HTTPS_PROXY`.
- Keep model identifiers out of commits, PR text, and code comments.
- Run `npm run check`, `npm run build`, and `npx vitest run` before pushing.
