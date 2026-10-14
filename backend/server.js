// server.js — CloudVault core API
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { v4: uuid } = require("uuid");
const db = require("./db");
const fp = require("./lib/fingerprint");
const ai = require("./lib/ai");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const CHUNK_DIR = path.join(STORAGE_DIR, "chunks");
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
fs.mkdirSync(CHUNK_DIR, { recursive: true });

// Near-duplicate thresholds
const TEXT_LOCAL_THRESHOLD = 0.7;   // used when AI is unavailable
const TEXT_AI_GRAY_ZONE = 0.35;     // ask the AI whenever local similarity is at least this
const IMAGE_LOCAL_THRESHOLD = 0.88;
const IMAGE_AI_GRAY_ZONE = 0.75;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(FRONTEND_DIR));
const upload = multer({ dest: CHUNK_DIR });

const storagePath = (key) => path.join(STORAGE_DIR, key);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "cloudvault-api", aiEnabled: ai.enabled(), time: new Date().toISOString() });
});

// ---------- Auth ----------
function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.post("/api/auth/register", (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "name, email, and password are required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }
  const id = uuid();
  db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)")
    .run(id, name, email, bcrypt.hashSync(password, 10));
  const token = jwt.sign({ id, name, email }, JWT_SECRET, { expiresIn: "7d" });
  res.status(201).json({ token, user: { id, name, email } });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

// ---------- Stats (real numbers, computed from what is actually stored) ----------
function statsFor(userId) {
  const physical = db.prepare(
    `SELECT COALESCE(SUM(sz),0) AS n FROM
       (SELECT MAX(size_bytes) AS sz FROM items WHERE owner_id = ? AND type = 'file' GROUP BY storage_key)`
  ).get(userId).n;
  const logical = db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM items WHERE owner_id = ? AND type = 'file'").get(userId).n;
  const user = db.prepare("SELECT saved_bytes, storage_limit_mb FROM users WHERE id = ?").get(userId);
  return {
    usedBytes: physical,
    limitBytes: user.storage_limit_mb * 1024 * 1024,
    // space saved = uploads refused as exact duplicates + files merged onto one copy
    savedBytes: user.saved_bytes + (logical - physical),
    aiEnabled: ai.enabled(),
  };
}
app.get("/api/stats", authRequired, (req, res) => res.json(statsFor(req.user.id)));

// ---------- Items ----------
app.get("/api/items", authRequired, (req, res) => {
  const parentId = req.query.parent || null;
  const items = parentId
    ? db.prepare("SELECT id, type, name, size_bytes, mime_type, created_at FROM items WHERE owner_id = ? AND parent_id = ? ORDER BY type DESC, name ASC").all(req.user.id, parentId)
    : db.prepare("SELECT id, type, name, size_bytes, mime_type, created_at FROM items WHERE owner_id = ? AND parent_id IS NULL ORDER BY type DESC, name ASC").all(req.user.id);
  res.json({ items });
});

app.post("/api/folders", authRequired, (req, res) => {
  const { name, parentId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Folder name is required" });
  const id = uuid();
  db.prepare("INSERT INTO items (id, type, name, owner_id, parent_id) VALUES (?, 'folder', ?, ?, ?)")
    .run(id, name.trim(), req.user.id, parentId || null);
  res.status(201).json({ id, name: name.trim(), type: "folder" });
});

app.patch("/api/items/:id", authRequired, (req, res) => {
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND owner_id = ?").get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: "Item not found" });
  const { name, parentId } = req.body;

  if (parentId !== undefined) {
    // Cycle prevention: a folder cannot be moved into itself or its own descendants
    if (item.type === "folder") {
      let cursor = parentId;
      while (cursor) {
        if (cursor === item.id) return res.status(400).json({ error: "Cannot move a folder into its own subfolder" });
        const p = db.prepare("SELECT parent_id FROM items WHERE id = ?").get(cursor);
        cursor = p ? p.parent_id : null;
      }
    }
    db.prepare("UPDATE items SET parent_id = ?, updated_at = datetime('now') WHERE id = ?").run(parentId || null, item.id);
  }
  if (name && name.trim()) {
    db.prepare("UPDATE items SET name = ?, updated_at = datetime('now') WHERE id = ?").run(name.trim(), item.id);
  }
  res.json({ ok: true });
});

// Delete an item (and descendants), then remove any stored bytes nobody references anymore
app.delete("/api/items/:id", authRequired, (req, res) => {
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND owner_id = ?").get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: "Item not found" });

  const keys = new Set();
  const stack = [item.id];
  while (stack.length) {
    const cur = db.prepare("SELECT id, type, storage_key FROM items WHERE id = ?").get(stack.pop());
    if (!cur) continue;
    if (cur.type === "file" && cur.storage_key) keys.add(cur.storage_key);
    db.prepare("SELECT id FROM items WHERE parent_id = ?").all(cur.id).forEach((c) => stack.push(c.id));
  }
  db.prepare("DELETE FROM items WHERE id = ?").run(item.id); // cascades to children
  for (const key of keys) {
    const stillUsed = db.prepare("SELECT 1 FROM items WHERE storage_key = ? LIMIT 1").get(key);
    if (!stillUsed && fs.existsSync(storagePath(key))) fs.unlinkSync(storagePath(key));
  }
  res.json({ ok: true });
});

app.get("/api/files/:id/download", authRequired, (req, res) => {
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND owner_id = ? AND type = 'file'").get(req.params.id, req.user.id);
  if (!item || !fs.existsSync(storagePath(item.storage_key))) return res.status(404).json({ error: "File not found" });
  res.download(storagePath(item.storage_key), item.name);
});

// ============================================================
//  Storage optimization pipeline
//  1. SHA-256 the file  -> exact duplicate? refuse to store a second copy
//  2. fingerprint (image pHash / text shingles)
//  3. near-duplicate check: AI judge when available, local similarity otherwise
// ============================================================
async function findTextNearDuplicate({ ownerId, itemId, fileName, text, fingerprint }) {
  const candidates = db.prepare(
    "SELECT * FROM items WHERE owner_id = ? AND type = 'file' AND text_fingerprint IS NOT NULL AND id != ?"
  ).all(ownerId, itemId);
  let best = null;
  for (const c of candidates) {
    const sim = fp.textSimilarity(fingerprint, JSON.parse(c.text_fingerprint));
    if (!best || sim > best.sim) best = { item: c, sim };
  }
  if (!best) return null;

  if (ai.enabled() && best.sim >= TEXT_AI_GRAY_ZONE) {
    const otherText = fp.extractText(storagePath(best.item.storage_key), best.item.name);
    if (otherText) {
      const verdict = await ai.compareText(fileName, text, best.item.name, otherText);
      if (verdict) {
        return verdict.sameContent
          ? { item: best.item, similarity: Math.max(verdict.similarity, best.sim), source: "ai", reason: verdict.reason }
          : null; // the AI looked at both and says they are different documents
      }
    }
  }
  if (best.sim >= TEXT_LOCAL_THRESHOLD) {
    return { item: best.item, similarity: best.sim, source: "local", reason: "Matching wording detected by shingle fingerprint" };
  }
  return null;
}

async function findImageNearDuplicate({ ownerId, itemId, fileName, mime, buffer, phash }) {
  const candidates = db.prepare(
    "SELECT * FROM items WHERE owner_id = ? AND type = 'file' AND image_phash IS NOT NULL AND id != ?"
  ).all(ownerId, itemId);
  let best = null;
  for (const c of candidates) {
    const sim = fp.imageSimilarity(phash, c.image_phash);
    if (!best || sim > best.sim) best = { item: c, sim };
  }
  if (!best) return null;

  if (ai.enabled() && best.sim >= IMAGE_AI_GRAY_ZONE) {
    const otherPath = storagePath(best.item.storage_key);
    if (fs.existsSync(otherPath)) {
      const verdict = await ai.compareImages(
        { name: fileName, mime, buffer },
        { name: best.item.name, mime: best.item.mime_type || fp.mimeFromName(best.item.name), buffer: fs.readFileSync(otherPath) }
      );
      if (verdict) {
        return verdict.sameContent
          ? { item: best.item, similarity: Math.max(verdict.similarity, best.sim), source: "ai", reason: verdict.reason }
          : null;
      }
    }
  }
  if (best.sim >= IMAGE_LOCAL_THRESHOLD) {
    return { item: best.item, similarity: best.sim, source: "local", reason: "Matching perceptual hash (same picture, different encoding)" };
  }
  return null;
}

// filePath: fully assembled file already on disk at STORAGE_DIR/<fileId>
async function ingestFile({ ownerId, parentId, fileName, fileId, filePath }) {
  const buffer = fs.readFileSync(filePath);
  const sizeBytes = buffer.length;
  const hash = fp.sha256(buffer);

  // 1) exact duplicate -> do not store, do not list a second entry
  const exact = db.prepare("SELECT id, name FROM items WHERE owner_id = ? AND type = 'file' AND content_hash = ?").get(ownerId, hash);
  if (exact) {
    fs.unlinkSync(filePath);
    db.prepare("UPDATE users SET saved_bytes = saved_bytes + ? WHERE id = ?").run(sizeBytes, ownerId);
    return {
      status: 200,
      body: {
        exactDuplicate: true, existingItem: exact, savedBytes: sizeBytes, sha256: hash,
        message: `Identical to "${exact.name}" (same SHA-256). No second copy was stored — ${sizeBytes} bytes saved.`,
      },
    };
  }

  // quota
  const st = statsFor(ownerId);
  if (st.usedBytes + sizeBytes > st.limitBytes) {
    fs.unlinkSync(filePath);
    return { status: 413, body: { error: "Storage quota exceeded" } };
  }

  // 2) fingerprints
  const mime = fp.mimeFromName(fileName);
  let phash = null, text = null, textFp = null;
  if (mime.startsWith("image/")) {
    try { phash = await fp.imagePHash(buffer); } catch { /* undecodable image */ }
  } else {
    text = fp.extractText(filePath, fileName);
    if (text && text.trim()) textFp = fp.textFingerprint(text);
  }

  db.prepare(
    `INSERT INTO items (id, type, name, owner_id, parent_id, size_bytes, mime_type, storage_key, content_hash, image_phash, text_fingerprint)
     VALUES (?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(fileId, fileName, ownerId, parentId || null, sizeBytes, mime, fileId, hash, phash, textFp ? JSON.stringify(textFp) : null);

  // 3) near-duplicate detection
  let near = null;
  if (phash) near = await findImageNearDuplicate({ ownerId, itemId: fileId, fileName, mime, buffer, phash });
  else if (textFp && textFp.length) near = await findTextNearDuplicate({ ownerId, itemId: fileId, fileName, text, fingerprint: textFp });

  if (near) {
    db.prepare(
      `INSERT INTO merge_candidates (id, item_id, matched_item_id, owner_id, type, similarity, source, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(uuid(), fileId, near.item.id, ownerId, phash ? "image" : "text", near.similarity, near.source, near.reason);
  }

  return {
    status: 201,
    body: { id: fileId, name: fileName, sizeBytes, sha256: hash, exactDuplicate: false, possibleDuplicateOf: near ? near.item.name : null },
  };
}

// ---------- Simple (non-chunked) upload ----------
app.post("/api/files/upload", authRequired, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    const fileId = uuid();
    const filePath = storagePath(fileId);
    fs.renameSync(req.file.path, filePath);
    const result = await ingestFile({
      ownerId: req.user.id, parentId: req.body.parentId, fileName: req.file.originalname, fileId, filePath,
    });
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

// ---------- Chunked, resumable upload ----------
app.post("/api/upload/init", authRequired, (req, res) => {
  const { fileName, totalChunks, totalSizeBytes, parentId } = req.body;
  if (!fileName || !Number.isInteger(totalChunks) || totalChunks < 1) return res.status(400).json({ error: "fileName and totalChunks are required" });
  const id = uuid();
  db.prepare(
    `INSERT INTO upload_sessions (id, file_name, owner_id, parent_id, total_chunks, total_size_bytes, status)
     VALUES (?, ?, ?, ?, ?, ?, 'uploading')`
  ).run(id, fileName, req.user.id, parentId || null, totalChunks, totalSizeBytes || 0);
  fs.mkdirSync(path.join(CHUNK_DIR, id), { recursive: true });
  res.status(201).json({ uploadSessionId: id });
});

app.get("/api/upload/:sessionId/status", authRequired, (req, res) => {
  const s = db.prepare("SELECT * FROM upload_sessions WHERE id = ? AND owner_id = ?").get(req.params.sessionId, req.user.id);
  if (!s) return res.status(404).json({ error: "Upload session not found" });
  const done = db.prepare("SELECT chunk_index FROM chunks WHERE upload_session_id = ? AND uploaded = 1 ORDER BY chunk_index").all(s.id).map((r) => r.chunk_index);
  res.json({ status: s.status, totalChunks: s.total_chunks, uploadedChunks: done });
});

app.post("/api/upload/:sessionId/chunk/:index", authRequired, upload.single("chunk"), (req, res) => {
  const session = db.prepare("SELECT * FROM upload_sessions WHERE id = ? AND owner_id = ?").get(req.params.sessionId, req.user.id);
  if (!session || !req.file) return res.status(404).json({ error: "Upload session or chunk not found" });

  const idx = Number(req.params.index);
  const checksum = fp.sha256(fs.readFileSync(req.file.path));
  // Integrity check: the client sends the SHA-256 it computed before sending
  if (req.body.checksum && req.body.checksum !== checksum) {
    fs.unlinkSync(req.file.path);
    return res.status(422).json({ error: `Checksum mismatch on chunk ${idx}, please retry` });
  }
  fs.renameSync(req.file.path, path.join(CHUNK_DIR, session.id, String(idx)));
  db.prepare("DELETE FROM chunks WHERE upload_session_id = ? AND chunk_index = ?").run(session.id, idx);
  db.prepare("INSERT INTO chunks (id, upload_session_id, chunk_index, checksum, uploaded) VALUES (?, ?, ?, ?, 1)")
    .run(uuid(), session.id, idx, checksum);
  const uploadedCount = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE upload_session_id = ? AND uploaded = 1").get(session.id).n;
  res.json({ chunkIndex: idx, checksum, uploadedCount, totalChunks: session.total_chunks });
});

app.post("/api/upload/:sessionId/complete", authRequired, async (req, res, next) => {
  try {
    const session = db.prepare("SELECT * FROM upload_sessions WHERE id = ? AND owner_id = ?").get(req.params.sessionId, req.user.id);
    if (!session) return res.status(404).json({ error: "Upload session not found" });

    const chunkDir = path.join(CHUNK_DIR, session.id);
    const buffers = [];
    for (let i = 0; i < session.total_chunks; i++) {
      const p = path.join(chunkDir, String(i));
      if (!fs.existsSync(p)) return res.status(400).json({ error: `Missing chunk ${i}, cannot assemble file` });
      buffers.push(fs.readFileSync(p));
    }
    const fileId = uuid();
    const filePath = storagePath(fileId);
    fs.writeFileSync(filePath, Buffer.concat(buffers));
    fs.rmSync(chunkDir, { recursive: true, force: true });
    db.prepare("UPDATE upload_sessions SET status = 'completed' WHERE id = ?").run(session.id);

    const result = await ingestFile({
      ownerId: req.user.id, parentId: session.parent_id, fileName: session.file_name, fileId, filePath,
    });
    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

// ---------- Merge candidates (near-duplicates awaiting the user's decision) ----------
app.get("/api/merge-candidates", authRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT mc.id, mc.type, mc.similarity, mc.source, mc.reason,
            a.name AS item_name, a.size_bytes AS item_size, b.name AS matched_name
     FROM merge_candidates mc
     JOIN items a ON a.id = mc.item_id
     JOIN items b ON b.id = mc.matched_item_id
     WHERE mc.owner_id = ? AND mc.status = 'pending'
     ORDER BY mc.created_at DESC`
  ).all(req.user.id);
  res.json({ candidates: rows });
});

app.post("/api/merge-candidates/:id/merge", authRequired, (req, res) => {
  const c = db.prepare("SELECT * FROM merge_candidates WHERE id = ? AND owner_id = ? AND status = 'pending'").get(req.params.id, req.user.id);
  if (!c) return res.status(404).json({ error: "Merge candidate not found" });
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(c.item_id);
  const target = db.prepare("SELECT * FROM items WHERE id = ?").get(c.matched_item_id);
  if (!item || !target) return res.status(404).json({ error: "One of the files no longer exists" });

  const reclaimedBytes = item.size_bytes;
  const oldKey = item.storage_key;
  // Re-point the duplicate at the kept copy's bytes, then drop its own bytes if nobody else uses them
  db.prepare(
    `UPDATE items SET storage_key = ?, size_bytes = ?, content_hash = ?, image_phash = ?, text_fingerprint = ?,
            mime_type = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(target.storage_key, target.size_bytes, target.content_hash, target.image_phash, target.text_fingerprint, target.mime_type, item.id);
  if (oldKey !== target.storage_key) {
    const stillUsed = db.prepare("SELECT 1 FROM items WHERE storage_key = ? LIMIT 1").get(oldKey);
    if (!stillUsed && fs.existsSync(storagePath(oldKey))) fs.unlinkSync(storagePath(oldKey));
  }
  db.prepare("UPDATE merge_candidates SET status = 'merged' WHERE id = ?").run(c.id);
  res.json({ ok: true, reclaimedBytes, keptFile: target.name });
});

app.post("/api/merge-candidates/:id/dismiss", authRequired, (req, res) => {
  const r = db.prepare("UPDATE merge_candidates SET status = 'dismissed' WHERE id = ? AND owner_id = ? AND status = 'pending'").run(req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: "Merge candidate not found" });
  res.json({ ok: true });
});

// ---------- Sharing ----------
app.post("/api/share/link", authRequired, (req, res) => {
  const { itemId, role, expiresInHours } = req.body;
  const item = db.prepare("SELECT * FROM items WHERE id = ? AND owner_id = ? AND type = 'file'").get(itemId, req.user.id);
  if (!item) return res.status(404).json({ error: "File not found" });
  const token = crypto.randomBytes(16).toString("hex");
  const expiresAt = expiresInHours ? new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString() : null;
  db.prepare("INSERT INTO share_links (id, item_id, token, role, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(uuid(), itemId, token, role === "EDITOR" ? "EDITOR" : "VIEWER", expiresAt);
  res.status(201).json({ token, expiresAt, url: `/api/share/${token}/download` });
});

function resolveShare(token) {
  const link = db.prepare("SELECT * FROM share_links WHERE token = ?").get(token);
  if (!link) return { status: 404, error: "Share link not found" };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { status: 410, error: "This share link has expired" };
  const item = db.prepare("SELECT * FROM items WHERE id = ?").get(link.item_id);
  if (!item) return { status: 404, error: "File no longer exists" };
  return { item, link };
}
app.get("/api/share/:token", (req, res) => {
  const r = resolveShare(req.params.token);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ name: r.item.name, sizeBytes: r.item.size_bytes, role: r.link.role, expiresAt: r.link.expires_at });
});
app.get("/api/share/:token/download", (req, res) => {
  const r = resolveShare(req.params.token);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.download(storagePath(r.item.storage_key), r.item.name);
});

// ---------- Frontend fallback + errors ----------
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`CloudVault running at http://localhost:${PORT}`);
  console.log(ai.enabled() ? "AI duplicate detection: ON (Claude API)" : "AI duplicate detection: OFF (set ANTHROPIC_API_KEY to enable) — using local similarity");
});
