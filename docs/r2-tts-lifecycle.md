# R2 lifecycle rules for the TTS audio cache

Synthesized speech is cached durably in the `MEDIA` R2 bucket under two key prefixes so a clip is
paid for at the speech provider **once**, not regenerated on every edge-cache eviction:

| Prefix      | Holds                          | Lifecycle (delete after) |
| ----------- | ------------------------------ | ------------------------ |
| `tts/std/`  | unpinned audio (idle window)   | **30 days**              |
| `tts/pin/`  | exam-pinned audio (long-keep)  | **180 days**             |

Retention is driven entirely by R2's native **object lifecycle rules** — there is no cron job or
sweeper. The app converts R2's "age since write" expiry into effective *idle* expiry by re-writing
(refreshing) an object on access when it nears its cutoff, so a clip that keeps being played keeps
living and an abandoned one ages out. The day windows above must match
`STD_RETENTION_DAYS` / `PIN_RETENTION_DAYS` in `src/lib/server/tts-store.ts`.

> ⚠️ These rules are **not** managed by `wrangler.jsonc`. Apply them once per bucket
> (`ankitalk-media` for prod and `ankitalk-staging-media` for staging).

## Apply via the Cloudflare dashboard

R2 → the bucket → **Settings** → **Object lifecycle rules** → add two rules:

1. Name `tts-std-expire` · prefix `tts/std/` · **Delete objects 30 days after they were uploaded**.
2. Name `tts-pin-expire` · prefix `tts/pin/` · **Delete objects 180 days after they were uploaded**.

## Or apply via the S3 API (`PutBucketLifecycleConfiguration`)

```json
{
  "Rules": [
    {
      "ID": "tts-std-expire",
      "Status": "Enabled",
      "Filter": { "Prefix": "tts/std/" },
      "Expiration": { "Days": 30 }
    },
    {
      "ID": "tts-pin-expire",
      "Status": "Enabled",
      "Filter": { "Prefix": "tts/pin/" },
      "Expiration": { "Days": 180 }
    }
  ]
}
```

Until the rules are configured, the cache still works and still saves regeneration cost — objects
simply accumulate instead of being reclaimed.
