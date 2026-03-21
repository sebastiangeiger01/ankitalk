#!/usr/bin/env python3
"""
AnkiTalk GitHub Task Board Setup
=================================
Creates GitHub Issues, Labels, and a Project Board (v2) for coordinating
development work on AnkiTalk.

Usage:
    GH_TOKEN=your_github_token python3 scripts/setup-task-board.py

Requirements:
    pip install requests

The GH_TOKEN needs these scopes:
    - repo (for creating issues and labels)
    - project (for creating and managing project boards)
"""

import os
import sys
import json
import time
import requests

OWNER = "sebastiangeiger01"
REPO = "ankitalk"
BASE_URL = "https://api.github.com"

TOKEN = os.environ.get("GH_TOKEN")
if not TOKEN:
    print("Error: GH_TOKEN environment variable not set.")
    print("Usage: GH_TOKEN=your_token python3 scripts/setup-task-board.py")
    sys.exit(1)

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
}


def gh_post(path, body):
    r = requests.post(f"{BASE_URL}{path}", headers=HEADERS, json=body)
    if not r.ok:
        print(f"  ERROR {r.status_code}: {r.text[:200]}")
    return r


def gh_get(path):
    r = requests.get(f"{BASE_URL}{path}", headers=HEADERS)
    return r


def graphql(query, variables=None):
    r = requests.post(
        "https://api.github.com/graphql",
        headers=HEADERS,
        json={"query": query, "variables": variables or {}},
    )
    return r.json()


# ─── Labels ────────────────────────────────────────────────────────────────────

LABELS = [
    # Area
    {"name": "area: feature",    "color": "0075ca", "description": "New functionality"},
    {"name": "area: bug",        "color": "d73a4a", "description": "Something isn't working"},
    {"name": "area: ux",         "color": "7057ff", "description": "User experience / interface"},
    {"name": "area: infra",      "color": "e4e669", "description": "Infrastructure, CI, deployment"},
    # Priority
    {"name": "priority: high",   "color": "b60205", "description": "Must ship soon"},
    {"name": "priority: medium", "color": "fbca04", "description": "Important but not urgent"},
    {"name": "priority: low",    "color": "0e8a16", "description": "Nice to have"},
    # Phase
    {"name": "phase: next",      "color": "c2e0c6", "description": "Up next to implement"},
    {"name": "phase: backlog",   "color": "e0e0e0", "description": "Planned but not scheduled"},
    # Concern
    {"name": "voice",            "color": "d4c5f9", "description": "Voice / audio pipeline"},
    {"name": "srs",              "color": "fef2c0", "description": "Spaced repetition / scheduling"},
    {"name": "api-keys",         "color": "cfd3d7", "description": "BYOK / API key management"},
    {"name": "pwa",              "color": "bfd4f2", "description": "PWA / mobile / installability"},
]


def create_labels():
    print("\n── Creating labels ─────────────────────────────────────────")
    existing = {l["name"] for l in gh_get(f"/repos/{OWNER}/{REPO}/labels").json()}
    for label in LABELS:
        if label["name"] in existing:
            print(f"  skip (exists): {label['name']}")
            continue
        r = gh_post(f"/repos/{OWNER}/{REPO}/labels", label)
        if r.ok:
            print(f"  created: {label['name']}")
        time.sleep(0.3)


# ─── Issues ────────────────────────────────────────────────────────────────────

ISSUES = [
    # ── HIGH PRIORITY / NEXT UP ───────────────────────────────────────────────
    {
        "title": "Export deck to .apkg",
        "labels": ["area: feature", "priority: high", "phase: next", "srs"],
        "body": """\
## Summary
The current `/api/decks/[id]/export-data` endpoint returns raw JSON, not a proper \
`.apkg` file. Users can't round-trip their decks back into Anki with their updated \
scheduling data.

## Acceptance criteria
- [ ] `GET /api/decks/[id]/export` generates a valid `.apkg` ZIP containing:
  - `collection.anki21` SQLite database with notes, cards, and deck metadata
  - `media` manifest JSON
- [ ] The exported file imports cleanly into Anki desktop
- [ ] FSRS scheduling state is preserved in the standard Anki schema fields
- [ ] Media files (images/audio) from R2 are included

## Notes
- Use `fflate` (already in deps) for ZIP creation
- `sql.js` (already in deps) for building the SQLite database in-memory
- Reference: `scripts/apkg-format.md` for the .apkg schema
""",
    },
    {
        "title": "Large deck import progress indicator",
        "labels": ["area: ux", "priority: high", "phase: next", "pwa"],
        "body": """\
## Summary
Importing a large Anki deck (5k–20k cards) gives no feedback — the UI just \
appears frozen. Users don't know if the import succeeded or is still running.

## Acceptance criteria
- [ ] Upload button shows a spinner with "Uploading…" state
- [ ] After upload, a progress bar shows parsing progress (cards processed / total)
- [ ] Server streams progress events via SSE or the client polls `/api/decks/[id]/import-status`
- [ ] On completion, the deck list refreshes and shows the new deck with card count
- [ ] Errors (corrupt file, unsupported format) are shown clearly with a retry option
""",
    },
    {
        "title": "Voice command visual feedback",
        "labels": ["area: ux", "priority: high", "phase: next", "voice"],
        "body": """\
## Summary
When the user speaks a command (e.g. "good", "explain"), there's no visual \
confirmation that the command was heard. This is especially confusing when STT \
is processing or a command is not recognised.

## Acceptance criteria
- [ ] While listening: show a subtle waveform or pulsing mic indicator
- [ ] On command recognised: flash the recognised command text briefly (e.g. "✓ Good")
- [ ] On command not recognised: show "?" or play a soft error chime
- [ ] Indicator is non-intrusive and doesn't cover card content
""",
    },

    # ── MEDIUM PRIORITY ───────────────────────────────────────────────────────
    {
        "title": "Review history view",
        "labels": ["area: feature", "priority: medium", "phase: backlog", "srs"],
        "body": """\
## Summary
Users have no way to look back at past review sessions. Adding a history view \
helps them track progress over time.

## Acceptance criteria
- [ ] `/decks/[id]/history` page showing per-session summaries
- [ ] Each row: date, cards reviewed, ratings breakdown (Again/Hard/Good/Easy), duration
- [ ] Clicking a session shows the individual card-level results
- [ ] Retention rate graph (% Good+Easy over last 30 days)
- [ ] Data is loaded from the `reviews` table via a new API endpoint

## API
`GET /api/decks/[id]/reviews?page=1&limit=20` — paginated review history
""",
    },
    {
        "title": "Keyboard shortcuts for desktop",
        "labels": ["area: ux", "priority: medium", "phase: backlog"],
        "body": """\
## Summary
Power users on desktop want to control the review flow without voice commands. \
Keyboard shortcuts are the standard Anki UX.

## Acceptance criteria
- [ ] `Space` or `Enter` — trigger "answer" (reveal answer)
- [ ] `1` / `2` / `3` / `4` — rate Again / Hard / Good / Easy
- [ ] `R` — repeat current TTS
- [ ] `E` — explain (invoke AI)
- [ ] `Esc` — stop session
- [ ] Shortcuts visible in a keyboard help overlay (`?` key)
- [ ] Shortcuts disabled when STT is active (to avoid conflicts)
""",
    },
    {
        "title": "Multi-language TTS voice auto-detection",
        "labels": ["area: feature", "priority: medium", "phase: backlog", "voice"],
        "body": """\
## Summary
Users studying foreign-language decks (e.g. Spanish, Japanese) get the default \
English TTS voice, which sounds wrong for non-English cards.

## Acceptance criteria
- [ ] Detect card/deck language from content using a lightweight heuristic or \
the `lang` tag if present in the Anki note
- [ ] Map detected language to the best available OpenAI TTS voice + language code
- [ ] Fall back to the user's default voice setting if detection is uncertain
- [ ] Show the detected/active language in the review screen

## Out of scope
- Per-field language detection (just per-deck for now)
- Custom voice-per-deck in settings (future)
""",
    },
    {
        "title": "PWA install prompt",
        "labels": ["area: ux", "priority: medium", "phase: backlog", "pwa"],
        "body": """\
## Summary
Users who visit the app in a mobile browser aren't prompted to install it as a \
PWA, so they miss the native-app experience (no browser chrome, home screen icon).

## Acceptance criteria
- [ ] Intercept the `beforeinstallprompt` event on Android/Chrome
- [ ] Show a custom install banner after the user completes their first review session
- [ ] iOS: show a "Add to Home Screen" instruction sheet (Safari doesn't support \
`beforeinstallprompt`)
- [ ] Banner is dismissible and doesn't re-appear for 7 days after dismissal
- [ ] Dismissal stored in localStorage
""",
    },
    {
        "title": "Usage spending alerts",
        "labels": ["area: feature", "priority: medium", "phase: backlog", "api-keys"],
        "body": """\
## Summary
Users want to be notified when their API spending exceeds a budget they set, \
so they don't get a surprise bill.

## Acceptance criteria
- [ ] Settings page: input for monthly spending threshold (default: $10)
- [ ] Stored in `users.settings` JSON column
- [ ] After each API call that logs usage, check if monthly total > threshold
- [ ] If threshold exceeded: show a persistent banner on the dashboard + settings page
- [ ] Banner links to the Usage & Costs section
- [ ] Email notification (stretch goal — requires email infrastructure)

## Out of scope (this issue)
- Email/push notifications
""",
    },
    {
        "title": "STT duration tracking from client",
        "labels": ["area: feature", "priority: medium", "phase: backlog", "voice", "api-keys"],
        "body": """\
## Summary
Deepgram cost is currently estimated from token grant events (not actual audio duration). \
This leads to inaccurate cost estimates. We should track actual audio seconds from the client.

## Plan
- Client tracks audio recording duration in the review session
- On session end (or periodically), POST actual seconds to a new endpoint
- Server logs `api_usage` with the real duration instead of an estimate

## Acceptance criteria
- [ ] `ReviewEngine` accumulates total audio duration sent to Deepgram
- [ ] `POST /api/usage/stt` — accepts `{ sessionId, durationSeconds }` and upserts \
the usage record
- [ ] The settings usage display shows actual seconds/cost, not estimate
- [ ] Gracefully handles sessions that end without sending the final duration
""",
    },

    # ── LOW PRIORITY / BACKLOG ────────────────────────────────────────────────
    {
        "title": "Offline review mode (PWA)",
        "labels": ["area: feature", "priority: low", "phase: backlog", "pwa"],
        "body": """\
## Summary
AnkiTalk currently requires an internet connection for every card (TTS + STT + AI). \
An offline mode would let users review cards using on-device TTS and no STT.

## Approach
- Service worker caches the app shell + last N decks' card content
- Offline review: use Web Speech API (synthesis only) for TTS instead of OpenAI
- STT replaced with tap-to-reveal flow (user taps "show answer" instead of speaking)
- FSRS scheduling runs fully client-side (ts-fsrs already in deps)
- Reviews synced to the server when connectivity is restored

## Acceptance criteria
- [ ] App loads from cache when offline
- [ ] Offline banner shown when no internet detected
- [ ] Offline review flow works for basic card types
- [ ] Review results queue and sync on reconnect

## Notes
This is a significant undertaking. Requires careful service worker design.
""",
    },
    {
        "title": "Shared deck library",
        "labels": ["area: feature", "priority: low", "phase: backlog"],
        "body": """\
## Summary
Allow users to publish their decks to a public library that other users can browse \
and clone (like Anki's shared deck platform).

## Acceptance criteria
- [ ] "Publish deck" option on the deck settings page
- [ ] Public deck library page (no auth required to browse)
- [ ] Clone a public deck into your own account
- [ ] Basic metadata: title, description, card count, language, category tags
- [ ] Deck author shown with link to their public profile

## Notes
Requires content moderation strategy and ToS update.
""",
    },
    {
        "title": "AnkiConnect integration",
        "labels": ["area: feature", "priority: low", "phase: backlog"],
        "body": """\
## Summary
Power users want live two-way sync with Anki desktop via AnkiConnect, instead of \
manual .apkg import/export.

## Approach
- AnkiConnect listens on localhost:8765 — direct connection not possible from the web
- Solution: a small companion app (or browser extension) that proxies AnkiConnect → AnkiTalk API
- OR: guide users to use the .apkg workflow until the companion app is built

## Acceptance criteria
- [ ] Companion proxy app (Electron or native) connects to AnkiConnect locally
- [ ] Pushes deck changes to AnkiTalk API using a user API token
- [ ] Pulls FSRS scheduling updates back to Anki
""",
    },
    {
        "title": "Per-card cost breakdown in session summary",
        "labels": ["area: feature", "priority: low", "phase: backlog", "api-keys"],
        "body": """\
## Summary
After a review session, show a cost breakdown so users understand exactly what \
they spent on TTS, STT, and AI explanations for that session.

## Acceptance criteria
- [ ] Session summary screen includes a collapsible "API cost" section
- [ ] Shows: TTS cost, STT cost, explain cost, total
- [ ] Optionally per-card (requires `session_id` field on `api_usage` records)
""",
    },
    {
        "title": "API key rotation reminders",
        "labels": ["area: feature", "priority: low", "phase: backlog", "api-keys"],
        "body": """\
## Summary
Security best practice is to rotate API keys periodically. Add an optional reminder \
to nudge users to regenerate their keys.

## Acceptance criteria
- [ ] Settings page shows "last updated" date for each key
- [ ] Optional reminder toggle: "Remind me to rotate keys every 90 days"
- [ ] Banner on dashboard when a key is older than the configured interval
- [ ] Dismissible, won't re-appear for 7 days after dismissal
""",
    },
    {
        "title": "Deck statistics: heatmap + retention graph",
        "labels": ["area: ux", "priority: low", "phase: backlog", "srs"],
        "body": """\
## Summary
The current stats page shows basic card state breakdown. Add richer visualisations \
to help users track their study habit and retention over time.

## Acceptance criteria
- [ ] GitHub-style activity heatmap showing review count per day (last 52 weeks)
- [ ] Retention rate line graph: % Good+Easy per day over last 30/90 days
- [ ] Average interval distribution histogram
- [ ] Data served from a new `GET /api/decks/[id]/stats?range=30d` endpoint
""",
    },
]


def create_issues():
    print("\n── Creating issues ─────────────────────────────────────────")
    created = []
    for issue in ISSUES:
        r = gh_post(
            f"/repos/{OWNER}/{REPO}/issues",
            {"title": issue["title"], "body": issue["body"], "labels": issue["labels"]},
        )
        if r.ok:
            data = r.json()
            print(f"  #{data['number']}: {issue['title']}")
            created.append(data)
        time.sleep(0.5)  # be polite to rate limits
    return created


# ─── Project board (GitHub Projects v2 via GraphQL) ───────────────────────────

CREATE_PROJECT = """
mutation CreateProject($ownerId: ID!, $title: String!) {
  createProjectV2(input: {ownerId: $ownerId, title: $title}) {
    projectV2 {
      id
      url
      number
    }
  }
}
"""

ADD_ITEM = """
mutation AddItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
    item {
      id
    }
  }
}
"""

GET_VIEWER = """
query {
  viewer {
    id
    login
  }
}
"""

GET_FIELD = """
query GetField($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      fields(first: 20) {
        nodes {
          ... on ProjectV2Field {
            id
            name
          }
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
            }
          }
        }
      }
    }
  }
}
"""

SET_FIELD = """
mutation SetField($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item {
      id
    }
  }
}
"""


STATUS_MAP = {
    # Map label → desired Status column value in the board
    "priority: high":   "In Progress",   # high-pri items start In Progress
    "priority: medium": "Todo",
    "priority: low":    "Backlog",
}

# We create these status options in the board
STATUSES = ["Backlog", "Todo", "In Progress", "Done"]


def get_viewer_id():
    result = graphql(GET_VIEWER)
    return result["data"]["viewer"]["id"]


def create_project(owner_id, title):
    result = graphql(CREATE_PROJECT, {"ownerId": owner_id, "title": title})
    if "errors" in result:
        print(f"  GraphQL error: {result['errors']}")
        return None
    proj = result["data"]["createProjectV2"]["projectV2"]
    print(f"  Created project: {proj['url']}")
    return proj


def add_issue_to_project(project_id, issue_node_id):
    result = graphql(ADD_ITEM, {"projectId": project_id, "contentId": issue_node_id})
    if "errors" in result:
        return None
    return result["data"]["addProjectV2ItemById"]["item"]["id"]


def get_status_field(project_id):
    result = graphql(GET_FIELD, {"projectId": project_id})
    fields = result["data"]["node"]["fields"]["nodes"]
    for f in fields:
        if f.get("name") == "Status":
            return f
    return None


def set_item_status(project_id, item_id, field_id, option_id):
    graphql(SET_FIELD, {
        "projectId": project_id,
        "itemId": item_id,
        "fieldId": field_id,
        "optionId": option_id,
    })


def setup_project(created_issues):
    print("\n── Creating project board ──────────────────────────────────")
    owner_id = get_viewer_id()
    print(f"  Owner node ID: {owner_id}")

    project = create_project(owner_id, "AnkiTalk Development")
    if not project:
        print("  Failed to create project.")
        return

    project_id = project["id"]

    # Get Status field options
    status_field = get_status_field(project_id)
    if not status_field:
        print("  Could not find Status field — items added without status.")

    print("\n── Adding issues to project ────────────────────────────────")
    for issue in created_issues:
        item_id = add_issue_to_project(project_id, issue["node_id"])
        if not item_id:
            print(f"  Failed to add #{issue['number']}")
            continue

        # Set status based on priority label
        if status_field and item_id:
            issue_labels = {l["name"] for l in issue.get("labels", [])}
            desired_status = "Backlog"  # default
            for label, status in STATUS_MAP.items():
                if label in issue_labels:
                    desired_status = status
                    break

            # Find the option ID for the desired status
            option_id = next(
                (o["id"] for o in status_field["options"] if o["name"] == desired_status),
                None,
            )
            if option_id:
                set_item_status(project_id, item_id, status_field["id"], option_id)
                print(f"  Added #{issue['number']} → {desired_status}")
            else:
                print(f"  Added #{issue['number']} (status '{desired_status}' not found)")
        else:
            print(f"  Added #{issue['number']}")

        time.sleep(0.3)

    print(f"\n✓ Done! Project board: {project['url']}")


# ─── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("AnkiTalk task board setup")
    print(f"Repo: {OWNER}/{REPO}")

    create_labels()
    created_issues = create_issues()
    if created_issues:
        setup_project(created_issues)
    else:
        print("\nNo issues created — skipping project board setup.")
