"""Build the private claude.ai artifact copy of app.html with the sheet id filled in.

app.html is public, so it doesn't carry the sheet id. The artifact is private, so its copy can:
this writes app.html with BUILT_SHEET_ID set to the id you give, to a path OUTSIDE the repo.
Publish that file to the existing artifact URL (see README). Never commit the output.

  python3 tools/build-artifact.py <sheet link or id> <output.html>
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 3:
    sys.exit(__doc__)
raw, out = sys.argv[1].strip(), Path(sys.argv[2]).resolve()
m = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]{20,})", raw)
sid = m.group(1) if m else raw
if not re.fullmatch(r"[A-Za-z0-9_-]{30,}", sid):
    sys.exit("That doesn't look like a sheet link or id.")
if root in out.parents:
    sys.exit("Write the output outside the repo, so the sheet id is never committed.")
src = (root / "app.html").read_text(encoding="utf-8")
marker = "const BUILT_SHEET_ID = '';"
if src.count(marker) != 1:
    sys.exit("Couldn't find the BUILT_SHEET_ID line in app.html.")
out.write_text(src.replace(marker, f"const BUILT_SHEET_ID = '{sid}';"), encoding="utf-8")
print("artifact build written to", out)
