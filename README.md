# Sleeves & Grooves

Album tracker, a sister app to the book tracker "Jackets & Manuscripts"
(`jcm-book-library/my-book-library`). It is a friendlier front end for the
🎸 tab of the "Entertainment Tracker" Google Sheet, which stays the source of truth.

Status: Stage 1 (Log, Library) live. Artifact: https://claude.ai/artifact/7WTduYo8DU1jx1Hjx25vd3
See [ROADMAP.md](ROADMAP.md).

## Hosting (planned)

- `app.html`: single self-contained page, published as a private claude.ai
  artifact (Sheets through the artifact `mcp` capability).
- `index.html`: built from `app.html` by `tools/build-pages.py` for GitHub Pages
  at `jcm-book-library.github.io/album-tracker/`, using Google sign-in.

## Sheet id (kept out of this public repo)

- `app.html` ships with an empty `BUILT_SHEET_ID`. On GitHub Pages the app asks once for the
  sheet link and keeps it in that browser only (`sg-config`).
- The private claude.ai artifact is built with the id filled in, to a file outside the repo:
  `python3 tools/build-artifact.py "<sheet link>" /path/outside/repo/app.html`, then publish that
  file to the existing artifact URL. Never commit that output.
- Tests use made-up albums (`tests/fixture-albums.json`) and a fake sheet id.

## Sheet rules

- The app only touches the 🎸 tab and tabs whose names start with 🎸.
- Rows are found by `id` right before every write; only changed cells are written.
- Dates as yyyy-mm-dd, numbers as numbers, text prefixed with `'`.

## Sheet changes

### 2026-10-18 (Stage 1 prep)

- Backup: full copy of 🎸 kept as `🎸 backup 2026-10-18`.
- 🎸 gained columns J–O: `id | Plan | Up next # | Why | Added | Planned`.
  - `id`: permanent number, 1001–1127 in the row order of that day. Never renumber, never a formula.
    New albums get highest id + 1. Duplicate ids are highlighted red.
  - `Plan`: chip dropdown Up next / Soon / Someday.
  - `Added` and `Planned`: dates (yyyy-mm-dd), blank for albums that existed before the app.
- Status dropdown: "Owned" added (12 rows already used it). Still chip style, strict.
- Status, Genre, Format and Plan dropdowns now run to row 300, so new rows get chips.
- New tab `🎸 Log`: `date | albumId | title | artist | plays | loggedAt | source | note`.
- New tab `🎸 Settings`: `key | value` (`yearGoalAlbums` 52, `rotationDays` 14,
  `upNextSize` 10, `albumOfDayMin` 8).
- Checked by script afterwards: A–I identical to the backup, ids unique and sequential.

### 2026-10-23 (Stage 2 prep)

- Backup: full copy of 🎸 kept as `🎸 backup 2026-10-23`.
- 🎸 gained column P, `Buy link`: the shop URL behind each "JB" / "HERE" note,
  copied from the Notes hyperlinks (24 albums), stored as plain text so the app can read it.
  Notes keeps its text and links as before.
- Checked by script afterwards: A–O identical to the backup, all 24 links match their Notes hyperlink.
