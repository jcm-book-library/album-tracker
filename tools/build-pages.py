"""Build index.html for GitHub Pages from app.html.

app.html is the single source. It is also what gets published as the claude.ai
artifact (which adds its own document skeleton), so it has no <head>. This adds
the doctype, metadata, icons and manifest that a normal website needs.

Also writes manifest.webmanifest.

Run from the repo root:  python3 tools/build-pages.py
"""
import json
from pathlib import Path

HEAD = """<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#202230">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Sleeves">
<title>Sleeves &amp; Grooves</title>
<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<link rel="manifest" href="manifest.webmanifest">
<!-- Built from app.html by tools/build-pages.py. Edit app.html, not this file. -->
"""

MANIFEST = {
    "name": "Sleeves & Grooves",
    "short_name": "Sleeves",
    "description": "Album tracker",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "background_color": "#202230",
    "theme_color": "#202230",
    "icons": [
        {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
    ],
}

root = Path(__file__).resolve().parent.parent
app = (root / "app.html").read_text(encoding="utf-8")
(root / "index.html").write_text(HEAD + app, encoding="utf-8")
(root / "manifest.webmanifest").write_text(json.dumps(MANIFEST, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("index.html built,", len(HEAD + app), "bytes; manifest.webmanifest written")
