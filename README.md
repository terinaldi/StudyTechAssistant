# StudyTechAssistant — a student dictionary

A fast, mobile-first dictionary website. No build step, no server, no API keys: just static files.

**Features**
- Four reading levels: **Beginner, Student, Advanced, Expert**. Definitions, examples, word history and extras grow with the level, and switching is instant.
- An example sentence for every main sense.
- Pronunciation: a recorded audio clip when one exists (otherwise the device voice), a **Slow** button, IPA, an easy respelling (e.g. *DIK-shuh-neh-ree*) and a per-word **Sound key**.
- Word history: a visual chain (e.g. Latin *dīcō* → Medieval Latin → Middle English → English) plus a written etymology sized to the level.
- Autocomplete as you type, including close spellings.
- Tap any word inside a definition to look it up. Recent words stay in a strip under the search bar, and the clock icon opens your full history (saved on your device).
- Light and dark mode, and it can be added to a phone's home screen.

**Data sources** (all free and keyless, called directly from the browser)
| What | Source |
|---|---|
| Definitions, examples, IPA, audio, etymology | [Wiktionary](https://en.wiktionary.org) |
| Beginner-level definitions | [Simple English Wiktionary](https://simple.wiktionary.org) |
| Backup example sentences | [Tatoeba](https://tatoeba.org) |
| Autocomplete | [Datamuse](https://www.datamuse.com/api/) |

## Put it online

### Option A: GitHub Pages
1. Create a new public repository on GitHub, e.g. `studytechassistant`.
2. Click **Add file → Upload files** and drag in: `index.html`, `app.js`, `style.css`, `icon.svg`, `manifest.webmanifest`, `.nojekyll`.
3. Go to **Settings → Pages**, set **Source** to *Deploy from a branch*, choose `main` / `(root)` and save.
4. After about a minute the site is live at `https://<your-username>.github.io/studytechassistant/`.

### Option B: Netlify (easiest)
1. Go to <https://app.netlify.com/drop>.
2. Drag the whole folder onto the page. You get a live link right away.

## Tweaking
All level behaviour lives in the `CFG` object at the top of `app.js`: senses per part of speech, examples per sense, etymology length, word-history steps, and so on. Colours and fonts are CSS variables at the top of `style.css`.
