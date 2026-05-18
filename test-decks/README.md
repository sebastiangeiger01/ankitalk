# AnkiTalk Test Decks

These tiny APKG fixtures are for manual staging checks.

## Should Import

- `ankitalk-good-mixed.apkg`
  - Basic card
  - Media card with PNG, SVG, WAV, spaces, Unicode, and apostrophes in media filenames
  - Cloze note with `c1` and `c2` cards
  - Expected: imports successfully with 4 cards.

- `ankitalk-hostile-html-should-import-sanitized.apkg`
  - Contains `<script>`, `onclick`, `javascript:` links, unsafe relative media path, and mixed safe/unsafe inline styles.
  - Expected: imports successfully, but dangerous HTML/URLs are stripped or neutralized when browsed/reviewed.

- `ankitalk-svg-should-import-sanitized.apkg`
  - Media manifest contains `payload.svg` with script/event/external URL payloads.
  - Expected: imports successfully, stores a sanitized SVG, and renders it as an image.

## Should Be Rejected

- `ankitalk-reject-path-traversal-media.apkg`
  - Media manifest contains `../evil.png`.
  - Expected: rejected during parsing/import with a path traversal media filename error.
