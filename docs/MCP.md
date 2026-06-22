# AnkiTalk MCP

AnkiTalk exposes a stateless Streamable HTTP MCP server at `/api/mcp`. It uses the
official MCP TypeScript SDK's Web Standard transport so each request can run safely
on a different Cloudflare isolate.

## Deployment

Apply D1 migrations before deploying the application:

```sh
npx wrangler d1 migrations apply ankitalk-db --remote
npx wrangler d1 migrations apply ankitalk-staging-db --remote --env preview
```

Migration `0016_mcp_product_architecture.sql` adds scoped credentials, expiry,
audit and idempotency tables, plus the D1 FTS5 index and synchronization triggers.
It backfills existing notes automatically.

## Client configuration

1. In AnkiTalk Settings, create either a **Study** token (read-only) or **Author**
   token (read plus card creation). The secret is shown once and expires after one
   year.
2. Configure the client's MCP server URL as `https://<host>/api/mcp`.
3. Send the token as `Authorization: Bearer <token>`.

For an ElevenLabs agent, require user approval for `create_notes`. The server marks
that tool as a non-read-only, idempotent write and requires an Author token.

## Surface

- Tools: `get_card_context`, `search_study_material`, `find_cards`,
  `get_study_progress`; Author tokens also receive `validate_card_drafts` and
  `create_notes`.
- Resources: `ankitalk://study/summary` and
  `ankitalk://cards/{card_id}`.
- Prompts: `tutor-card`; Author tokens also receive `draft-cards`.

Card content is rendered through AnkiTalk's canonical template/cloze renderer.
Search uses D1 FTS5 for candidate retrieval and BM25 ranking; the index is not a
second rendering implementation.

## Operational notes

- Tokens are stored only as SHA-256 hashes, are scope-filtered, and have expiry.
- Browser-origin requests must match the endpoint origin. Server-to-server clients
  generally omit `Origin` and authenticate with the bearer token.
- Calls are rate-limited per token. Tool executions write duration, status, result
  size, and stable error code to `mcp_tool_audit`; study content and tool arguments
  are deliberately not logged.
- `create_notes` validates before writing, uses a D1 batch, and requires a stable
  idempotency key for safe retries.
- Cloudflare logs are enabled and traces are sampled in `wrangler.jsonc`.

OAuth, Durable Object coordination, Queues, Vectorize, and Workflows should only be
added when their product need exists. The current server is stateless; D1 FTS5 is
the authoritative lexical search path, and KV rate limiting is intentionally a soft
abuse guard rather than a strict billing quota.
