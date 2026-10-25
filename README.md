# Music Collection

Album tracker (named Sleeves & Grooves until 24 Oct 2026; the repo keeps the name `album-tracker`), a sister app to the book tracker "Jackets & Manuscripts"
(`jcm-book-library/my-book-library`). It is a friendlier front end for the
🎸 tab of the "Entertainment Tracker" Google Sheet, which stays the source of truth.

Status: Log, Plan, Library, Dashboard, Tools, Discover and Tracks built. Private artifact: https://claude.ai/artifact/7WTduYo8DU1jx1Hjx25vd3
See [ROADMAP.md](ROADMAP.md).

## Hosting

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

### 2026-10-24 (Tracks)

- New tab `🎸 Tracks`, one row per track:
  `id | albumId | album | side | no | title | length | copied | note`.
  - `id`: permanent number from 5001, highest + 1; duplicates highlighted red.
  - `albumId` links to the album's `id` in 🎸. `copied` is the date the track was copied to MP3 (blank = not yet).
  - Deleting a track in the app clears that row's cells (found by id first). The row itself
    stays, empty, so no other row moves; the app skips empty rows.
  - New tracks (and albums) are appended below the last used row, so a cleared row is never refilled or overwritten.
- 🎸 itself is unchanged.

### 2026-10-25 (Favourites)

- Backup: full copy of 🎸 kept as `🎸 backup 2026-10-25`.
- 🎸 gained column Q, `Favourite`: a date (yyyy-mm-dd). A date means favourited that day; blank means not a favourite.
  Tapping the guitar pick writes today's date or clears the cell, so one cell changes. It doesn't depend on the rating.
  Every kind of thing gets its own `Favourite` column in its own tab (albums now; artists, tracks and shows when those tabs exist),
  and the Home page gathers them all.
- Status dropdown: "Didn't like" added (chip style kept).
- 🎸 gained column R, `Labelled`: the date of the album's last label change (the Status shelf it was moved to).
  Optional: the app works without it, and writes it only when the header exists. It orders the Didn't like shelf,
  so the newest albums sit at the far end and the oldest are closest to the incinerator.
  Backup before this change: `🎸 backup 2026-10-25 (before Labelled)`.
- Checked by script afterwards: A–P identical to the backup, Favourite column empty, dropdown chips intact; later A–Q identical to the second backup and Labelled empty.

## Look

- Dark, with a marbled coloured record behind solid panels. Approved preview: `design/music-collection-preview.html`.
- Six pressings, two months each, changing on the 1st (no daily drift):
  Jan–Feb Emerald, Mar–Apr Canary, May–Jun Midnight blue, Jul–Aug Tangerine, Sep–Oct Magenta, Nov–Dec Crimson.
  The Tools tab's Look panel can override the pressing or switch to a plain dark background (this browser only).
- Type: Bricolage Grotesque for headings and big numbers, Lexend for body text.
- Installed icon: the record in the Magenta pressing, drawn inside a circle so round crops don't clip it.
