# CloudVault

A personal cloud storage system with **intelligent storage optimization**: it never stores the same
content twice. Identical files are caught with SHA-256, and near-identical files (edited documents,
resized photos) are caught with fingerprinting and an AI judge, then merged to save space.

```
cloudvault/
├── backend/    Node.js + Express API, SQLite database
│   ├── lib/fingerprint.js   SHA-256, image perceptual hash, text shingles, .docx text extraction
│   ├── lib/ai.js            AI "is this the same content?" judge (Claude API, optional)
│   └── test/                automated end-to-end tests
└── frontend/   Plain HTML/CSS/JS dashboard (served by the backend)
```

## Run it

```bash
cd backend
npm install
npm start
```

Open **http://localhost:4000**. One server runs both the API and the UI; SQLite is created automatically.

### Optional: switch on the AI
```bash
cp .env.example .env      # then put your key in ANTHROPIC_API_KEY=
npm start
```
The sidebar shows "AI duplicate detection: on". Without a key everything still works using local similarity.

## How the duplicate handling works

| Situation | What CloudVault does |
|---|---|
| Same file uploaded again (same SHA-256) | Refused as an exact duplicate. No second copy is stored or listed; the bytes are counted as "saved". |
| Edited document / resized or re-saved image | Stored, then flagged as a **possible duplicate**. You choose *Merge & save space* or *Keep both*. |
| Merge confirmed | The duplicate is re-pointed at the kept copy and its own bytes are deleted. |

Near-duplicate detection, in order:
1. **Local fingerprints** — images: 8×8 perceptual hash; documents (`.txt .md .csv .json .log .docx`): 5-word shingles + Jaccard similarity.
2. **AI judge** (when a key is set) — for borderline matches (≥35% text / ≥75% image similarity) Claude reads both files and decides whether they are the same content, with a one-line reason. The AI can also *veto* a false local match. If the API is unreachable, the local score is used instead.

Near-duplicates are never merged automatically — the user always confirms.

## Features
- Register / login (bcrypt + JWT)
- Folders and files: create, rename, delete, download, breadcrumb navigation, cycle-safe moves (API)
- Chunked upload (2 MB chunks), SHA-256 verified per chunk, automatic per-chunk retry, drag-and-drop, multi-file
- Expiring public share links
- Live storage meter and "saved by deduplication" counter

## Tests
```bash
npm test          # end-to-end suite, local similarity
npm run test:ai   # same suite with the AI path, against a mock of the Claude API
```
(`npm test` uses `bash`; on Windows run it from Git Bash.)

## API summary
`POST /api/auth/register|login` · `GET /api/items` · `POST /api/folders` · `PATCH|DELETE /api/items/:id` ·
`POST /api/upload/init` → `POST /api/upload/:id/chunk/:n` → `POST /api/upload/:id/complete` ·
`GET /api/files/:id/download` · `GET /api/merge-candidates` · `POST /api/merge-candidates/:id/merge|dismiss` ·
`POST /api/share/link` · `GET /api/share/:token/download` · `GET /api/stats` · `GET /api/health`

## Known limitations
Sharing is link-based only (no per-user permissions UI), there is no version-history UI, and the
frontend has no move-by-drag UI (the move API exists). Sessions use a 7-day JWT stored in localStorage.

Last updated: 2026-10-15
