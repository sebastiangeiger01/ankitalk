# Plan: PDF Read-Aloud Mode

## Overview

A free/near-free alternative to Speechify and ElevenReader. Reads born-digital PDFs aloud
faithfully — no summarisation, no AI narration. Differentiator: local TTS (free forever)
or cheap BYOK OpenAI TTS, not a subscription. PDF is processed entirely client-side and
never leaves the device.

---

## Architecture

```
Browser (client-side only)
  │
  ├─ PDF upload (File API)
  │     │  pdfjs-dist (WASM worker)
  │     ▼
  │  Text extraction per page
  │     │  column-order sort, header/footer strip
  │     ▼
  │  Page classification
  │     │  plain text → TTS directly
  │     │  non-text (figures/equations) → optional vision preprocessing
  │     ▼
  │  [Vision path — BYOK OpenAI key required]
  │     │  render page to <canvas> → base64 PNG
  │     │  POST /api/pdf-vision   (server sends to GPT-4o-mini)
  │     │  returns: spoken descriptions, equation text, cleaned paragraphs
  │     ▼
  │  TTS Engine (sentence queue)
  │     ├─ Free tier:  Web Worker → Kokoro ONNX (EN)
  │     │                         → Piper Thorsten ONNX (DE)
  │     │              Model files cached in OPFS after one-time download
  │     └─ BYOK tier: POST /api/tts  (existing OpenAI TTS endpoint)
  │
  └─ Reader UI
        ├─ Click paragraph → jump there
        ├─ Sentence highlight advances with speech
        ├─ Auto-scroll document view
        └─ Fixed playback bar (play/pause, speed, skip, position)
```

---

## Data Model (client-side only — IndexedDB)

All data lives in the browser. Nothing is stored server-side.

```typescript
// Object store: "documents"
interface PdfDocument {
  id: string;               // UUID generated on upload
  filename: string;
  pageCount: number;
  language: 'en' | 'de' | 'unknown';
  createdAt: number;        // unix ms
  lastOpenedAt: number;
}

// Object store: "pages"  (keyed by [docId, pageNum])
interface PdfPage {
  docId: string;
  pageNum: number;          // 1-indexed
  paragraphs: PdfParagraph[];
  hasNonText: boolean;      // true when figures/equations detected
  visionProcessed: boolean;
}

interface PdfParagraph {
  id: string;               // `${pageNum}-${idx}`
  text: string;             // full paragraph text
  sentences: string[];      // split via Intl.Segmenter
  skip: boolean;            // true for page numbers / headers / footers
}

// Object store: "progress"  (keyed by docId)
interface PdfProgress {
  docId: string;
  pageNum: number;
  paragraphIdx: number;
  sentenceIdx: number;
  updatedAt: number;
}
```

---

## Implementation Steps

### Step 1: Install Dependencies

```
pdfjs-dist          — client-side PDF parsing (Mozilla, battle-tested)
kokoro-js           — Kokoro TTS (EN) via Transformers.js + ONNX runtime (~82 MB model)
sherpa-onnx-wasm    — Piper Thorsten TTS (DE) via ONNX WASM (~60 MB model)
```

`vite.config.ts` changes:
- Copy `pdfjs-dist/build/pdf.worker.min.mjs` to `static/` via `vite-plugin-static-copy`
  (same pattern already used for sql.js WASM)
- Mark `kokoro-js` and `sherpa-onnx-wasm` as `optimizeDeps.exclude` so Vite doesn't
  try to bundle the WASM files

---

### Step 2: PDF Parser (`src/lib/client/pdf-parser.ts`)

Wraps `pdfjs-dist`. Exposes:

```typescript
async function parsePdf(file: File): Promise<PdfDocument>
async function extractPage(docId: string, pageNum: number): Promise<PdfPage>
```

**Text extraction with reading order correction:**

pdfjs returns each text item with `(x, y, width, height, str)`. The algorithm:

1. Group items by approximate y-band (within 2pt → same line).
2. Detect multi-column layout: if items cluster into 2+ x-ranges with a clear gap
   between them, treat each cluster as a column.
3. Sort columns left-to-right; sort items top-to-bottom within each column.
4. Merge adjacent items into lines, then cluster lines into paragraphs (gap > 1.5× line height).

**Header/footer stripping:**
- Items in the top 7% or bottom 7% of page height → flagged `skip: true`.
- Short runs (< 6 chars) that are purely numeric or match "Page N of M" → `skip: true`.

**Footnote handling:**
- Footnotes typically appear below a horizontal rule near the bottom of the page.
- Collect them as separate, `skip: true` paragraphs (not injected mid-sentence).
- Could be read after the main page body in a future version.

**Non-text detection (for vision preprocessing gate):**
- Inspect the pdfjs operator list for each page.
- If operators contain `paintImageXObject`, `paintInlineImageXObject`, or the page
  contains very few text items relative to its area → `hasNonText = true`.
- Paragraphs containing ≥ 3 math symbols (∫ ∑ ∏ √ ∂ ∈ ≤ ≥ ≠ ±, or lone uppercase
  letters surrounded by operators) → also mark the page `hasNonText = true`.

**Language detection:**
- Sample first 500 words of extracted text.
- Simple heuristic: count German stopwords (der, die, das, und, ist, nicht, …) vs
  English stopwords. Whichever set has more matches wins.
- Store result in `PdfDocument.language`.
- Falls back to `'en'` if ambiguous.

**Sentence segmentation:**
- Use `new Intl.Segmenter(lang, { granularity: 'sentence' })` — built into all modern
  browsers, handles German and English correctly, zero bundle cost.

---

### Step 3: IndexedDB Store (`src/lib/client/pdf-store.ts`)

Opens an IndexedDB database named `ankitalk-pdf` with three object stores:
`documents`, `pages`, `progress`.

```typescript
// Documents
export async function saveDocument(doc: PdfDocument): Promise<void>
export async function listDocuments(): Promise<PdfDocument[]>
export async function deleteDocument(id: string): Promise<void>

// Pages (lazy: only extracted pages are stored)
export async function savePage(page: PdfPage): Promise<void>
export async function getPage(docId: string, pageNum: number): Promise<PdfPage | undefined>

// Progress
export async function saveProgress(p: PdfProgress): Promise<void>
export async function getProgress(docId: string): Promise<PdfProgress | undefined>
```

The PDF binary itself is **not** stored in IndexedDB — pages are extracted on demand
and cached in the store. This avoids storing tens of MB per document.

---

### Step 4: Local TTS (`src/lib/client/local-tts.ts`)

Runs in a dedicated Web Worker (`src/lib/client/local-tts.worker.ts`) so synthesis
never blocks the main thread.

```typescript
// Main thread API (message-based, wrapped in a promise interface)
export async function initLocalTts(lang: 'en' | 'de'): Promise<void>  // triggers download if needed
export async function synthesise(text: string, speed: number): Promise<Float32Array>  // returns PCM
export function isModelCached(lang: 'en' | 'de'): Promise<boolean>
```

**Model storage:**
- Use the Origin Private File System (OPFS) via `navigator.storage.getDirectory()`.
- Store model files under `tts-models/kokoro-en/` and `tts-models/piper-de/`.
- On first use per language: show a download prompt with file size and progress bar
  before downloading. Never download silently.

**Engine selection:**
| Language | Engine | Package | Model size |
|----------|--------|---------|------------|
| `en` | Kokoro v0.19 | `kokoro-js` | ~82 MB |
| `de` | Piper Thorsten | `sherpa-onnx-wasm` | ~60 MB |

**Playback:**
- Worker returns raw PCM (`Float32Array`, 22 050 Hz mono).
- Main thread creates an `AudioBuffer` from it and plays via existing `AudioContext`
  (same context as `src/lib/client/audio.ts` — exported and shared).
- Speed control applied via `AudioBufferSourceNode.playbackRate`.

**Fallback chain:**
1. Local WASM model (if downloaded).
2. BYOK OpenAI TTS via existing `/api/tts` (if user has OpenAI key).
3. Error state with "Download model or add OpenAI key" prompt.

---

### Step 5: TTS Engine for PDF (`src/lib/client/pdf-tts-engine.ts`)

Manages the sentence-level playback queue. Decoupled from the UI — fires events.

```typescript
export type PdfTtsEvent =
  | { type: 'sentence-start'; pageNum: number; paragraphIdx: number; sentenceIdx: number }
  | { type: 'sentence-end' }
  | { type: 'page-end'; pageNum: number }
  | { type: 'doc-end' }
  | { type: 'error'; message: string };

export class PdfTtsEngine {
  constructor(options: {
    getPage: (pageNum: number) => Promise<PdfPage>;
    pageCount: number;
    ttsMode: 'local' | 'openai';
    language: 'en' | 'de';
    onEvent: (e: PdfTtsEvent) => void;
  })

  async play(from?: { pageNum: number; paragraphIdx: number; sentenceIdx: number }): Promise<void>
  pause(): void
  resume(): void
  skipSentence(direction: 1 | -1): void
  skipParagraph(direction: 1 | -1): void
  setSpeed(speed: 0.75 | 1 | 1.25 | 1.5 | 2): void
  get position(): { pageNum: number; paragraphIdx: number; sentenceIdx: number }
  destroy(): void
}
```

**Lookahead:**
- While the current sentence plays, synthesise the next sentence in the background.
- For OpenAI TTS: pre-fetch the next sentence via `/api/tts` and store the decoded
  `AudioBuffer` (reusing existing `preloadTTS` pattern from `audio.ts`).
- For local WASM: send next sentence to Web Worker while current one is playing.

**Skipped paragraphs:**
- `paragraph.skip === true` paragraphs (headers, footers, page numbers) are silently
  stepped over without synthesis.

---

### Step 6: Vision Preprocessing Endpoint (`src/routes/api/pdf-vision/+server.ts`)

**POST** — requires auth + user's OpenAI key.

Request:
```json
{
  "pageImageBase64": "<base64 PNG, max 1024×1024px>",
  "pageText": "<extracted text for this page, for context>"
}
```

Processing (via GPT-4o-mini vision):
```
System: You are processing a PDF page for text-to-speech playback.
        Return JSON with:
          paragraphs: string[]   — full readable text of each paragraph,
                                   with equations written out in words
                                   (e.g. "E equals m c squared")
          figureDescriptions: string[]  — one spoken description per figure/chart
          citationsFlagged: boolean     — true if inline citations were stripped
```

Response:
```json
{
  "paragraphs": ["...", "..."],
  "figureDescriptions": ["Figure 1: a bar chart showing..."],
  "citationsFlagged": true
}
```

**Cost and key:**
- Uses the user's BYOK OpenAI key (same `getUserApiKey(db, userId, 'openai', ...)` pattern).
- Logs usage to `api_usage` table as service `openai`, operation `pdf-vision`.
- Estimated cost: ~$0.01 per page image at GPT-4o-mini vision pricing.
- Client only calls this for pages where `hasNonText === true`.
- Client sends a downscaled image (max 1024px on longest side, 85% JPEG) to keep
  cost and latency low.

---

### Step 7: Routes

#### `/read` — Upload & Document List (`src/routes/read/+page.svelte`)

- Client-only page (`export const ssr = false`).
- Drag-and-drop / click-to-upload zone for PDF files.
- On upload: parse with pdfjs, save `PdfDocument` to IndexedDB, navigate to `/read/[id]`.
- Below upload zone: list of previously opened documents (from IndexedDB).
  - Each entry shows: filename, page count, language flag, last opened date.
  - "Resume" button (highlighted if progress exists), "Delete" button.
- Privacy note: "Your PDF is processed locally and never uploaded."

#### `/read/[docId]` — Reader (`src/routes/read/[docId]/+page.svelte`)

- Client-only (`export const ssr = false`).
- Load `PdfDocument` and `PdfProgress` from IndexedDB on mount.
- Extract pages on demand (first visible + next 2 preloaded).
- If progress exists: show "Resume from page N" banner with Accept / Start Over options.

**Document view:**
- Renders paragraph text for the current and adjacent pages.
- Three visual states per paragraph (via CSS classes):
  - `.para-active` — background tint on the currently playing paragraph.
  - `.sentence-highlight` — distinct highlight on the currently playing sentence (inline `<mark>`).
  - `.para-read` — slightly dimmed opacity on already-read paragraphs.
- `IntersectionObserver` watches current-sentence element; scrolls it into view smoothly.
- Click on any paragraph → `engine.play({ pageNum, paragraphIdx, sentenceIdx: 0 })`.

**Fixed playback bar (`src/lib/components/PdfPlaybackBar.svelte`):**
```
[ ⏮ ] [ ⏭ ]   ▶ / ⏸   [ 0.75× 1× 1.25× 1.5× 2× ]   Page 4 of 12
```
- Fixed to bottom of viewport, visible whenever a document is loaded.
- Play/pause is the primary action — large 48×48 tap target.
- Speed buttons are a segmented control (highlight active speed).
- Skip back/forward moves by one sentence; long-press skips by paragraph.
- Position shows "Page N of M" updating as playback advances.

---

### Step 8: Navigation Link

**`src/routes/+layout.svelte`** — add a "Read" link in the nav bar (between title and settings icon):

```svelte
<a href="/read" class="nav-icon" aria-label={t('nav.read')} title={t('nav.read')}>
  <!-- book/headphones SVG icon -->
</a>
```

---

### Step 9: i18n Strings

Add to `src/lib/i18n/en.ts` and `src/lib/i18n/de.ts`:

```typescript
// Navigation
'nav.read': 'Read',

// Read — upload page
'read.title': 'Read Aloud',
'read.uploadPrompt': 'Drop a PDF here or click to upload',
'read.uploadHint': 'Born-digital PDFs only — lecture slides, papers, ebooks',
'read.privacyNote': 'Your PDF is processed locally and never uploaded to any server.',
'read.recentDocs': 'Recent Documents',
'read.resume': 'Resume (page {page})',
'read.startOver': 'Start over',
'read.delete': 'Delete',
'read.noDocuments': 'No documents yet. Upload a PDF to get started.',

// Read — reader page
'read.page': 'Page {current} of {total}',
'read.resumeBanner': 'Resume from page {page}?',
'read.resumeAccept': 'Resume',
'read.resumeDecline': 'Start from beginning',

// Read — model download
'read.modelDownloadTitle': 'Download voice model',
'read.modelDownloadDesc': 'One-time download of {size} for offline text-to-speech. Cached forever after.',
'read.modelDownloadConfirm': 'Download',
'read.modelDownloadProgress': 'Downloading… {pct}%',
'read.modelDownloadDone': 'Voice model ready.',

// Read — vision preprocessing
'read.visionPrompt': 'Page {page} contains figures or equations.',
'read.visionDesc': 'Send this page to GPT-4o-mini (~$0.01) for spoken descriptions?',
'read.visionProcess': 'Process with AI',
'read.visionSkip': 'Skip (read raw text)',
'read.visionRequiresKey': 'Add your OpenAI key in Settings to enable this.',

// Read — TTS fallback
'read.noTtsTitle': 'No voice available',
'read.noTtsDesc': 'Download the free voice model or add your OpenAI key in Settings.',
'read.downloadModel': 'Download free model ({size})',
'read.goToSettings': 'Go to Settings',

// Read — errors
'read.parseError': 'Could not read this PDF. Make sure it is a born-digital (not scanned) PDF.',
'read.loadError': 'Document not found. It may have been deleted.',
```

---

### Step 10: Service Worker — Model Cache Hint

**`src/service-worker.ts`** — add a `fetch` handler for OPFS model writes:
- No changes needed to the service worker itself; OPFS writes bypass it.
- However, add the pdfjs worker script to the static assets list so it is cached
  after the first load and works offline: `static/pdf.worker.min.mjs`.

---

### Step 11: Usage Tracking

Extend the existing `api_usage` table with two new operations:

| Service | Operation | Units | Rate |
|---------|-----------|-------|------|
| `openai` | `pdf_vision` | image pages | ~$0.01/page (GPT-4o-mini) |
| `openai` | `pdf_tts` | characters | $0.60/1M chars (tts-1) |

- `pdf_vision` logged in `/api/pdf-vision/+server.ts` after each successful call.
- `pdf_tts` logged in the existing `/api/tts/+server.ts` — no code change needed;
  already logs `openai` + `tts` operations. The reader reuses this endpoint as-is.
- Local WASM TTS has zero cost — nothing to log.

---

## File Changes Summary

| File | Action | Notes |
|------|--------|-------|
| `src/routes/read/+page.svelte` | **New** | Upload zone + document list |
| `src/routes/read/+page.ts` | **New** | `export const ssr = false` |
| `src/routes/read/[docId]/+page.svelte` | **New** | Reader view |
| `src/routes/read/[docId]/+page.ts` | **New** | `export const ssr = false` |
| `src/routes/api/pdf-vision/+server.ts` | **New** | Vision preprocessing endpoint |
| `src/lib/client/pdf-parser.ts` | **New** | pdfjs wrapper, column detection, lang detect |
| `src/lib/client/pdf-store.ts` | **New** | IndexedDB CRUD (documents, pages, progress) |
| `src/lib/client/pdf-tts-engine.ts` | **New** | Sentence queue, playback state machine |
| `src/lib/client/local-tts.ts` | **New** | Main-thread API wrapping the Web Worker |
| `src/lib/client/local-tts.worker.ts` | **New** | Kokoro / Piper WASM synthesis in worker |
| `src/lib/components/PdfPlaybackBar.svelte` | **New** | Fixed playback bar |
| `src/routes/+layout.svelte` | **Edit** | Add "Read" nav link |
| `src/lib/i18n/en.ts` | **Edit** | Add `read.*` and `nav.read` strings |
| `src/lib/i18n/de.ts` | **Edit** | Add `read.*` and `nav.read` strings (German) |
| `vite.config.ts` | **Edit** | Copy pdf.worker.min.mjs; exclude WASM packages from optimizeDeps |
| `package.json` | **Edit** | Add `pdfjs-dist`, `kokoro-js`, `sherpa-onnx-wasm` |

---

## Key Technical Decisions & Rationale

**Why pdfjs-dist?**
The only production-grade PDF parser that runs entirely in the browser. Provides text
items with precise position data (required for column detection) and an operator list
(required for figure detection). Already used by Firefox's PDF viewer — very well tested.

**Why Intl.Segmenter for sentence splitting?**
Zero bundle cost, handles German compound sentences and abbreviations correctly, ships
in all modern browsers. No external library needed.

**Why OPFS for model storage?**
OPFS provides persistent, quota-exempt storage (up to ~60% of available disk) without
the serialisation overhead of IndexedDB for binary blobs. Ideal for 60–82 MB ONNX
model files. Not affected by browser cache eviction unlike Cache API.

**Why a dedicated Web Worker for local TTS?**
WASM synthesis can take 50–200 ms per sentence. Running this on the main thread would
cause frame drops and jank in the scrolling reader. The Worker keeps the UI thread free.

**Why BYOK pattern for vision preprocessing?**
Consistent with the rest of AnkiTalk. Users who don't want to pay $0.01/page can skip
vision processing entirely — raw text is still read aloud. No mandatory cost.

**Why not store progress server-side?**
The PDF itself is never on the server (privacy requirement). Storing page position
without the document is low value. IndexedDB is sufficient; it persists across browser
restarts and is not cleared by normal cache eviction.

**Column detection heuristic vs. ML:**
ML-based layout analysis (e.g. Detectron2) is far too heavy for the browser. The
x-range clustering heuristic handles the common case (2-column academic papers, single
column ebooks) correctly. Edge cases (3-column newspapers, mixed layouts) are acceptable
v1 failures — the user can still tap the right paragraph to jump there.

---

## Phased Rollout

| Phase | Scope | What ships |
|-------|-------|------------|
| **1** | Foundation | PDF upload, text extraction, IndexedDB store, `/read` routes, nav link |
| **2** | Basic TTS | Sentence queue engine, BYOK OpenAI TTS path, playback bar (no local WASM yet) |
| **3** | Highlighting | Sentence highlight, paragraph tint, auto-scroll, click-to-jump |
| **4** | Local TTS | Kokoro EN worker, Piper DE worker, OPFS model cache, download prompt |
| **5** | Vision | `/api/pdf-vision` endpoint, figure description, equation transcription, usage tracking |
| **6** | Polish | Progress resume, screen wake lock, German i18n review |

Phases 1–3 are fully free to run (no API calls for users with no OpenAI key once Phase 4
lands). Phase 2 requires an OpenAI key only if the user hasn't downloaded the local model.

---

## Out of Scope (v1)

- Scanned PDFs / OCR
- Flashcard generation from PDF content
- Voice commands while reading
- Server-side PDF storage or sync
- 3-column or complex magazine layouts
- Footnote read-aloud (they are silently skipped in v1)
- Offline vision preprocessing (requires local vision model — too large for v1)
- Android TTS via WebView (tested on desktop Chrome, Firefox, Safari, iOS Safari only)
