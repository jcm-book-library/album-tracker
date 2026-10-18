# Sleeves & Grooves

Album tracker, a sister app to the book tracker "Jackets & Manuscripts"
(`jcm-book-library/my-book-library`). It is a friendlier front end for the
🎸 tab of the "Entertainment Tracker" Google Sheet, which stays the source of truth.

Status: planning. The sheet changes and first build are waiting on approval.
See [ROADMAP.md](ROADMAP.md).

## Hosting (planned)

- `app.html`: single self-contained page, published as a private claude.ai
  artifact (Sheets through the artifact `mcp` capability).
- `index.html`: built from `app.html` by `tools/build-pages.py` for GitHub Pages
  at `jcm-book-library.github.io/album-tracker/`, using Google sign-in.

## Sheet rules

- The app only touches the 🎸 tab and tabs whose names start with 🎸.
- Rows are found by `id` right before every write; only changed cells are written.
- Dates as yyyy-mm-dd, numbers as numbers, text prefixed with `'`.
