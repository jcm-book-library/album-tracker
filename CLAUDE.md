# Music Collection: notes for Claude

**Read the house rules first:** [HOUSE-RULES.md](https://github.com/jcm-book-library/control-room/blob/main/HOUSE-RULES.md) in `control-room` (plain text: https://raw.githubusercontent.com/jcm-book-library/control-room/main/HOUSE-RULES.md). They cover Google Sheet safety, branches and pull requests into `main`, using cheaper models to save usage credits, and the build template. The notes below are this repo's own; where they are more specific, they win. The project charter is `project.json`.

## This repo
- `app.html` is the app source, published as a private claude.ai artifact.
- `python3 tools/build-pages.py` rebuilds `index.html` from `app.html` for GitHub Pages.
- Data lives in the `🎸` tab (and tabs starting with 🎸) of the Entertainment Tracker Google Sheet.
- Sheet rules from the README: "The app only touches the 🎸 tab and tabs whose names start with 🎸."
- Rows are found by `id` right before every write and only changed cells are written; dates as yyyy-mm-dd, numbers as numbers, text prefixed with `'`.
- See `ROADMAP.md` for the plan.
