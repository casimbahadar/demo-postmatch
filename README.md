# Postmatch maintainer kit

Tests and notes for whoever maintains Postmatch. The app itself is the 25 files in `postmatch.zip`. This kit is not part of the website: do not upload it to the app's repository.

## The files in the app

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | The page and its look. The security policy is the `<meta>` tag in `index.html`. |
| `app.js` | Every screen, and moving between them. All text goes in with `textContent`, never `innerHTML`. |
| `reader.js` | Reads an end-of-match screenshot: finds the panel, the result colour, the rows and the numbers. Its measurement thresholds are in the `T` object at the top. |
| `importer.js` | Runs the reader with the self-hosted OCR engine (Tesseract.js) and cuts the row strips. |
| `model.js` | The rules for a valid match, used when saving and when restoring. |
| `db.js` | Storage on the phone (IndexedDB), with a schema version and one migration step per version. |
| `backup.js` | Backup files out, and the checks on any file coming back in. |
| `stats.js` | Win rate and averages. Averages are summed as whole numbers so halves round correctly. |
| `heroes.js` | The hero list and mode names. The only file most owners will edit. |
| `sw.js` | Offline support and the Android share sheet. |
| `guide.html` | The player guide. |
| `tesseract*.js`, `worker.min.js`, `eng.traineddata.gz` | The OCR engine and its English data, served from the site itself. |

## Rules when changing anything

1. Raise `VERSION` at the top of `sw.js` with every change, or phones keep the old files.
2. Changing how matches are stored: raise `SCHEMA_VERSION` in `db.js`, add a step to `MIGRATIONS`, add a matching step to `UPGRADES` in `backup.js`, and never edit an old step.
3. Keep the fan content rules: free; no "Vainglory", "Super Evil" or "SEMC" in the name, address or repository; the exact disclaimer in Settings and the guide; hero names as text only; no game art; never read the game's traffic, memory or files.
4. Never commit or publish the test screenshots. They contain other players' names and the game's art.

## Running the tests

You need Python 3, Node 18 or later, and Playwright with Chromium:

```
pip install playwright
python3 -m playwright install chromium
```

Put the folders side by side:

```
postmatch/            the 25 app files (unzipped postmatch.zip)
kit/                  this kit
kit/screenshots/      the private test screenshots
```

Other locations work too: set `POSTMATCH_APP`, `POSTMATCH_SHOTS` and `POSTMATCH_OUT`. Results and images go to `kit/results/`.

Screenshot names: `a1.png` to `a4.png` are the client's Community Edition screenshots, `a5.png` is his 5v5 match, and `s1.jpg` to `s4.jpg` are the four early samples (`s3` and `s4` are 640 px copies, used to test the size check).

Run from inside `kit/`:

| Command | What it checks |
| --- | --- |
| `node test_stats.mjs` | The 20-match stats set against the answer table. |
| `python3 test_reader.py --user=Dessembrae` then `python3 score_reader.py` | Every field the reader finds, compared with `truth.json`. |
| `python3 test_app.py` | Import, check screen, save, reload, hero filter, edit, delete and undo, error messages (27 checks). |
| `python3 test_backup_offline.py` | Offline use, backup round trip between two browser profiles, refused files, injected markup, Android share (26 checks). |

All of them passed on November 19, 2026 against the shipped files, with every field correct on all five client screenshots and both full-size samples. They prove behaviour in headless Chromium, not on a real phone. Check phone-only behaviour (speed, the share sheet, Home Screen storage) on a real iPhone and Android phone.

## Adding a new test screenshot

1. Save it as `a5.png` (and so on) in `screenshots/`.
2. Add its true values to `truth.json`, following the existing entries. Rows run left team top to bottom, then right team. `player` is the row index of the player's own row, or `null` when only the username can find it. `layout` is `a` (K/D/A only), `b` (with gold and minion kills) or `p` (Blitz points).
3. Run `test_reader.py a5` and `score_reader.py`.

If a field type keeps failing, retune the thresholds in `reader.js` against the failing screenshot. If that doesn't fix it, try digit template matching: `test_reader.py --templates` learns digit shapes from `s2` and reads with those instead of Tesseract. On the screenshots so far it matched Tesseract's accuracy.

## Other files in this kit

- `postmatch-stats-check.json`: a backup holding the 20 stats-check matches. Restore it in a browser tab for the hand check in the handover document.
- `harness.html`, `share-test.html`: pages the tests load. `serve.py` is the shared helper that serves everything locally.
