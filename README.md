# Music Collection

Album tracker (named Sleeves & Grooves until 24 Oct 2026; the repo keeps the name `album-tracker`), a sister app to the book tracker "Jackets & Manuscripts"
(`jcm-book-library/my-book-library`). It is a friendlier front end for the
🎸 tab of the "Entertainment Tracker" Google Sheet, which stays the source of truth.

Status: Log, Plan, Library, Dashboard, Tools, Discover, Tracks and Artists built. Private artifact: https://claude.ai/artifact/7WTduYo8DU1jx1Hjx25vd3
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

## What's in the app

- Tabs: Home, Collection, Artists, Plan, Playlists, Dashboard, Tools.
- **Artists** lists the artists with an album count and an owned count, a search (name or alias), a sort (A to Z, Most albums, Favourites first)
  and a Favourites filter. An artist page shows the details (aliases, established, origin, influences, bio, status, notes) with an Edit form,
  the artist's albums, **Relationships** (Member, Former member, Side project, Collaboration, Previously known as, Influenced by; the other artist's
  page shows the reverse, e.g. "Member of") and **Resources** (books, documentaries and so on, with a link when the address starts with http:// or https://).
  Data lives in `🎸 Artists`, `🎸 Links` and `🎸 Resources`. An album belongs to an artist when its Artist matches the artist's name or one of their
  aliases (`knownAs`, separated by `;`); no artist, or "Various", belongs to nobody. "N albums have no artist page yet" with **Add them** creates the
  missing artists as drafts after a confirm. The guitar pick works as it does for albums (it writes that artist's `favourite` date).
  Deleting a relationship or resource clears its row and offers Undo (Undo adds it back under its own id, below the last used row).
- **Playlists** builds playlists from a pool of tracks (the `Classical` tab, read-only; another sheet and tab; or an uploaded CSV): Browse the pool,
  Build with presets and rules (era, form, mood, work-friendly, energy, BPM, composer, target length; ordered by energy, key flow, era or shuffle),
  and Save to `🎸 Playlists`. "Copy for Spotify" copies track links in order to paste into a Spotify playlist. The listening log is hidden unless "Show listening log" is switched on in Tools
  (this browser only); its code and the `🎸 Log` tab are kept for the later MP3 player.
- **Find cover** picks a cover for an album from Cover Art Archive when it has no Drive file. A **Find cover** button (it reads **Change cover** once a cover is chosen)
  sits in the floating album panel and in the Edit album footer; Tools → Look → Covers says "N albums have no cover yet" and **Find covers** works through them:
  favourites first, then Owned, then rated 8 to 10, then the rest, ties by title, with "3 of 41" and the reason (Favourite, Owned, Rated 9). The picker searches MusicBrainz
  (one call about every 1.3 seconds, never closer than 1.1) and shows up to six candidates with their pictures; tap one, or choose **None of these** (the album is not offered again
  unless "Show ones I said none to" is on), **Skip** (writes nothing, offered again next time) or **Done for now**. **Remove cover choice** clears the row, with Undo.
  The choice is stored as a small reference in `🎸 Covers`, never as an image; the picture is loaded straight from coverartarchive.org. A Drive file always wins over a reference,
  and a picture that fails to load leaves the generated sleeve. Everything is hidden until the `🎸 Covers` tab exists (Tools says "Create the 🎸 Covers tab first.").
- **Collection** shows the albums as shelves. A shelf is a label; the label is worked out from the album's row, first match wins:
  Didn't like (Status) → Owned (Status Owned, or Format Vinyl (Owned)) → Vinyl wish list (Status Purchase, or Format Vinyl (Wanted))
  → Upcoming (Coming Soon) → To hear (Listen) → Heard (Listened, or any rating).
- Changing a label (the chip, or dragging to another shelf) writes `Status`, plus `Format` when it pairs with the move
  (Vinyl (Wanted) ↔ Vinyl (Owned); cleared when a wanted vinyl moves to a non-vinyl label), plus `Labelled` (today) when that column exists.
  An album whose Format is Vinyl (Owned) can't quick-move to To hear, Heard or Upcoming. Each change has an Undo.
- Selecting a sleeve opens its details in a **floating panel** instead of a strip under the shelf, so it is in view however long a shelf is. On wide screens it is a card
  docked on the left (the page moves over just far enough to clear it, and the shelves stay scrollable and clickable); on phones (900px and narrower) it is
  a bottom sheet. It has the label chip, Favourite, Tracks, Edit, Find cover and Buy buttons. Click another sleeve to swap it, or click the selected sleeve again, press the × or Escape
  to close it; it also closes when you change tab. It is a small generic component (`floatPanel`), written up in `design/float-panel.md` for the other collection apps.
- **Favourites** are a guitar pick that writes the `Favourite` date (or clears it), independent of the label and the rating.
- The Didn't like shelf has an incinerator: the newest four albums stand in a row, and older ones are "incinerated" on screen only.
  They keep their label and stay in the sheet; "Show all" lists them as ash tiles and they can be moved back.
- Shelves show the first five albums standing and the rest as a packed stack that fans open on hover (tap on a phone).
- Tests: `cd tests && npm test`. Test data is dated from the run (`RUN_START=2026-12-31T23:57:00 npm test` checks another day).

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

### 2026-10-25 (Artists)

- New tabs, all read and written by the app; 🎸 itself is unchanged (no new columns):
  - `🎸 Artists`: `id | name | knownAs | established | origin | bio | influences | favourite | status | notes`.
    `id` is a permanent number from 2001 (highest + 1; duplicates highlighted red). `knownAs` holds aliases separated by `;` (also used to match albums).
    `established` is a year or blank. `favourite` is a date (yyyy-mm-dd), blank = not a favourite, the same meaning as the albums' Favourite column.
    `status` is `draft` or `done` (blank = draft).
  - `🎸 Links`: `id | artistId | otherId | otherName | type | note`. `id` from 3001. Reads "<artist> <type> <other>"; `otherId` is an artist in `🎸 Artists`
    (the row then shows on both pages), or blank with `otherName` for someone without a page (`otherId` wins if both are set).
    `type` is Member, Former member, Side project, Collaboration, Previously known as or Influenced by.
  - `🎸 Resources`: `id | artistId | kind | title | url | note`. `id` from 4001. `kind` is Book, Documentary, Film, Article, Website, Podcast, Video or Other.
    `url` is optional text; the app links it only when it starts with http:// or https://.
  - Deleting in the app clears the row's cells (found by id first); the row stays, empty, and new rows go below the last used row.

### 2026-10-25 (Playlists)

- New tab `🎸 Playlists`, one row per saved playlist: `id | name | purpose | source | created | tracks | minutes | rules | trackIds | notes`.
  - `id`: permanent number from 7001, highest + 1; duplicates highlighted red.
  - `trackIds`: the playlist's Spotify track ids in order, comma-separated text. `rules` is the rule set as compact JSON text.
  - Deleting a playlist in the app clears that row's cells (found by id first); the row stays, empty, and new rows go below the last used row.
- The app also **reads** (never writes) the `Classical` tab, and any sheet link and tab the owner pastes into the Playlists tab, as the pool of tracks.
  The only writes in this feature go to `🎸 Playlists`.

### 2026-10-28 (Find cover)

- New tab `🎸 Covers`, one row per album that has had a cover chosen (or looked for): `id | source | sourceId | chosen | note`.
  - `id`: the album's own `id` from 🎸 (a number; the key, so one row per album and a second row for the same id is an error, "appears 2 times", and nothing is written).
  - `source`: `caa-rg` (a Cover Art Archive picture for a MusicBrainz release-group) or `none` (you looked and nothing fit; the album is not offered again until retried).
  - `sourceId`: the release-group id (text) for `caa-rg`, blank for `none`. The app shows `https://coverartarchive.org/release-group/<sourceId>/front-500`; no image is ever stored.
  - `chosen`: a date (yyyy-mm-dd). `note`: free text.
  - Changing a choice writes only the changed cells of that row (found by id first). Removing a choice clears that row's cells (the row stays, empty); new rows go below the last used row and the id is checked afterwards.
- The tab is created by hand (header row only); until it exists the app hides every Find cover control. 🎸 itself is unchanged (no new columns).

## Look

- Dark, with a marbled coloured record behind solid panels. Approved preview: `design/music-collection-preview.html`.
- Six pressings, two months each, changing on the 1st (no daily drift):
  Jan–Feb Emerald, Mar–Apr Canary, May–Jun Midnight blue, Jul–Aug Tangerine, Sep–Oct Magenta, Nov–Dec Crimson.
  The Tools tab's Look panel can override the pressing or switch to a plain dark background (this browser only).
- Type: Bricolage Grotesque for headings and big numbers, Lexend for body text.
- Installed icon: the record in the Magenta pressing, drawn inside a circle so round crops don't clip it.
