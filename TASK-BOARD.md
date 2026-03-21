# AnkiTalk — Task Board

This document describes the planned work for coordinating development between contributors.
Run `scripts/setup-task-board.py` to automatically create GitHub Issues and a Project board from this list.

## Current Status

| Phase | Feature area | Status |
|-------|-------------|--------|
| Phase 1 — SRS core | Learning steps, daily limits, sibling burying | ✅ Done |
| Phase 2 — SRS advanced | FSRS tuning, leeches, suspension, deck stats | ✅ Done |
| Phase 3 — Card management | Card browser, editing, bulk actions, cram mode | ✅ Done |
| BYOK — API key management | Encryption, user keys, settings UI, usage tracking | ✅ Done |
| Export to .apkg | Real round-trip export back to Anki format | 🔴 Missing |
| Voice UX polish | Visual feedback for commands, error chimes | 🟡 Partial |
| Desktop UX | Keyboard shortcuts | 🔴 Missing |
| PWA | Install prompt, offline mode | 🔴 Missing |

---

## Issues

### 🔴 High Priority — Next Up

#### Export deck to .apkg
The current `/api/decks/[id]/export-data` returns raw JSON, not a valid `.apkg` file.
Users can't get their updated scheduling data back into Anki desktop.

**Tasks:**
- Build `.apkg` ZIP using `fflate` + `sql.js` (both already in deps)
- Populate `collection.anki21` SQLite schema with notes, cards, deck metadata
- Bundle media files from R2
- Wire up "Export" button on deck page

**Labels:** `area: feature`, `priority: high`, `phase: next`, `srs`

---

#### Large deck import progress indicator
Importing 5k–20k card decks gives no feedback — UI appears frozen.

**Tasks:**
- Stream SSE progress events or implement polling endpoint
- Show upload progress → parse progress → completion
- Clear error states for corrupt files

**Labels:** `area: ux`, `priority: high`, `phase: next`

---

#### Voice command visual feedback
No visual confirmation when a voice command is heard or fails.

**Tasks:**
- Animated mic waveform while listening
- Flash recognised command text briefly ("✓ Good")
- Soft error chime + indicator on unrecognised command

**Labels:** `area: ux`, `priority: high`, `phase: next`, `voice`

---

### 🟡 Medium Priority

#### Review history view
Users can't look back at past sessions. Add per-session history with retention graph.

**Tasks:**
- `GET /api/decks/[id]/reviews` paginated endpoint
- `/decks/[id]/history` page
- Retention rate graph (30d)

**Labels:** `area: feature`, `priority: medium`, `srs`

---

#### Keyboard shortcuts for desktop
Standard Anki UX: Space/Enter to reveal, 1–4 to rate.

**Tasks:**
- `Space`/`Enter` → reveal, `1`/`2`/`3`/`4` → rate, `R` → repeat, `E` → explain
- Keyboard help overlay (`?`)
- Disable when STT active

**Labels:** `area: ux`, `priority: medium`

---

#### Multi-language TTS voice auto-detection
English TTS voice sounds wrong for foreign-language decks.

**Tasks:**
- Language heuristic from card content (or Anki `lang` tag)
- Map language → OpenAI voice + language code
- Fallback to user default

**Labels:** `area: feature`, `priority: medium`, `voice`

---

#### PWA install prompt
Mobile users aren't prompted to install the app.

**Tasks:**
- Intercept `beforeinstallprompt` (Android/Chrome)
- Custom banner after first review session
- iOS: "Add to Home Screen" instruction sheet

**Labels:** `area: ux`, `priority: medium`, `pwa`

---

#### Usage spending alerts
Notify users when API spending exceeds their budget.

**Tasks:**
- Settings: monthly threshold input
- Post-call check vs threshold
- Dashboard banner when exceeded

**Labels:** `area: feature`, `priority: medium`, `api-keys`

---

#### STT duration tracking from client
Deepgram cost currently estimated from token grants — inaccurate.

**Tasks:**
- `ReviewEngine` accumulates actual audio seconds
- `POST /api/usage/stt` endpoint for session-end reporting
- Update usage display to show real cost

**Labels:** `area: feature`, `priority: medium`, `voice`, `api-keys`

---

### 🟢 Low Priority / Backlog

| Title | Labels |
|-------|--------|
| Offline review mode (PWA) | `area: feature`, `priority: low`, `pwa` |
| Shared deck library | `area: feature`, `priority: low` |
| AnkiConnect integration | `area: feature`, `priority: low` |
| Per-card cost breakdown in session summary | `area: feature`, `priority: low`, `api-keys` |
| API key rotation reminders | `area: feature`, `priority: low`, `api-keys` |
| Deck statistics: heatmap + retention graph | `area: ux`, `priority: low`, `srs` |

---

## Project Board Columns

| Column | Meaning |
|--------|---------|
| **Backlog** | Planned, low-priority items |
| **Todo** | Ready to pick up, medium priority |
| **In Progress** | Currently being worked on (high priority items start here) |
| **Done** | Shipped to main |

---

## Setting Up the Project Board

```bash
# 1. Generate a GitHub personal access token with scopes: repo, project
# 2. Run the setup script:
pip install requests
GH_TOKEN=ghp_your_token python3 scripts/setup-task-board.py
```

This will create all the labels, issues, and a "AnkiTalk Development" Project board
linked to this repo, with issues pre-sorted into the right columns.
