# Music Collection: roadmap

Started 2026-10-18.

## Core stages (agreed plan, pending OK)

1. Sheet prep (backup, id + plan columns, 🎸 Log, 🎸 Settings), app shell, Log, Library, build script, both hosts
2. Plan (Up next, Soon, backlog, sort deck)
3. Dashboard
4. Tools and Discover (album of the day, on this day, anniversaries)

## Later: listening and visuals

### V1. Local player with a real visualiser (recommended first)
- Plays a whole album in order, from files or a folder you pick; can log the play to 🎸 Log when an album finishes (asks first).
- Play your own MP3/FLAC/AAC files in the app with a built-in player.
- The visualiser reads the actual audio through the Web Audio API (AnalyserNode): spectrum bars, waveform, radial ring, in the month accent colour.
- Reads ID3 tags (artist, album, year, cover art) with a small inline parser, matches the album in 🎸 by artist + title, and offers to log the play to 🎸 Log.
- Files stay on the device; nothing is uploaded.
- Limits: on desktop Chrome/Edge a picked music folder can be remembered (File System Access API). On iPhone/Safari you re-pick files each session. Background playback with the screen locked is unreliable on iOS.

### V1b. MP3 converter (pairs with V1 and V4)
- Converts audio files you already have (WAV, FLAC, AAC/M4A, OGG, and V4's vinyl recordings) to MP3 in the browser; nothing is uploaded.
- The browser decodes the file; a small MP3 encoder library (lamejs, loaded from cdnjs) encodes it. Roughly 1–3 minutes per album on a laptop, slower on a phone.
- Fills in the MP3 tags (artist, album, year, track, cover) from the 🎸 row, so V1's player matches it back to the album.
- Saving: a normal download on GitHub Pages; inside the claude.ai artifact it needs the downloads capability (you confirm each save). GitHub Pages is the better home for it.
- Can't: read audio CDs directly (rip with a CD app first), or convert anything copy-protected (Spotify, Apple Music downloads) or from YouTube.
- Keep the originals: converting FLAC or WAV to MP3 loses some quality for good.

### V2. "Room" visualiser for anything (Spotify, vinyl, radio)
- Uses the microphone, so it reacts to whatever is playing out loud, including vinyl on the turntable.
- Lower fidelity than V1 (picks up room noise) and needs mic permission (the artifact needs the microphone capability).
- Off by default; nothing recorded or stored.

### V3. Spotify "now playing" + auto-log (no true visualiser)
- Spotify's Web API can show what's playing (cover, track, album) and your recently played tracks.
- Use: show the current album with art, and suggest log entries ("You played most of Violator today, log it?").
- Ambient visual driven by the cover art colours and play progress, not the audio.
- Not possible: a real Spotify visualiser. Spotify's audio is DRM-protected so a web page can't read the samples, and the audio-analysis / audio-features endpoints are closed to new apps (since Nov 2024).
- Needs a Spotify developer app (Client ID, redirect to the Pages URL). Check Spotify's current development-mode rules before building; they've tightened them recently. Embedded playback (Web Playback SDK) needs Premium.

### V4. Record an album, replay it with a synced visual
- Record an album playing (best via line-in from the turntable or a USB interface; a mic in a quiet room works but picks up the room).
- Option A (recommended): keep the recording. The V1 player replays it and the visualiser is generated live from it, so it's always perfectly in sync and the visual style can change later. Effectively "digitise my vinyl", saved as Opus/WebM (~40 MB per album).
- Option B: keep only a "visual track" (spectrum data, ~1–2 MB per album), no audio. Replay it alongside Spotify by lining it up with Spotify's play position. Sync will be close but not exact (expect drift and a manual nudge), and it only matches the same pressing/master.
- Option C: export a video (canvas + audio via MediaRecorder) of the album with its visual, to keep or share.
- Storage: on the device (IndexedDB) or Google Drive, never in the Sheet.
- Format-shifting music you own for private use is generally allowed in Australia; sharing the recordings isn't.

### Cover art (both hosts, same method as the sports tracker)
- Covers are image files in a private Google Drive folder (never in the public repo). The folder's id is kept in `🎸 Settings`
  (key `coverFolder`), set once by pasting the folder link in the app, so it never appears in code.
- GitHub Pages: read with the owner's own Google sign-in (Drive read-only scope, already used by the sports tracker with the shared Client ID).
  The claude.ai app: read through the Google Drive connector (`search_files`, `download_file_content`); the artifact must declare that connector.
- The Drive connector is signed in as the owner's second Google account, so the folder must be shared with that account (Editor, as for the logo folders).
- File format: one JPEG per album, square (1:1), about 600 x 600 px (300 minimum, 1000 maximum), under about 200 KB, no transparency.
- File name: the album's `id` from the 🎸 tab plus `.jpg`, e.g. `1043.jpg`. The id never changes, so renaming an album can't break the link.
- The app loads only the covers on screen, shrinks each to about 256 px, caches it in the browser (IndexedDB, keyed by folder, file and modified time),
  and falls back to the generated sleeve when a file is missing or Drive isn't reachable.

### Not planned
- Running on hardware MP3 players (iPod-style devices can't run web apps).
- A full streaming service of our own.
