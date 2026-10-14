// lib/fingerprint.js — content fingerprinting used by the storage optimizer
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");
const AdmZip = require("adm-zip");

// ---- Exact identity: SHA-256 of the raw bytes ----
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// ---- Images: 8x8 average hash (perceptual) ----
// Survives resizing / recompression / format changes, unlike SHA-256.
async function imagePHash(buffer) {
  const img = await Jimp.read(buffer);
  img.resize(8, 8).grayscale();
  const px = [];
  img.scan(0, 0, 8, 8, function (x, y, idx) { px.push(this.bitmap.data[idx]); });
  const avg = px.reduce((a, b) => a + b, 0) / px.length;
  return px.map((v) => (v >= avg ? "1" : "0")).join("");
}

function imageSimilarity(hashA, hashB) {
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) if (hashA[i] !== hashB[i]) diff++;
  return 1 - diff / hashA.length;
}

// ---- Documents: pull plain text out of .txt/.md/.csv/.json/.log and .docx ----
const TEXT_EXT = [".txt", ".md", ".csv", ".json", ".log"];

function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function extractText(filePath, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  try {
    if (ext === ".docx") {
      const xml = new AdmZip(filePath).readAsText("word/document.xml");
      if (!xml) return null;
      return decodeXml(xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, ""));
    }
    if (TEXT_EXT.includes(ext)) return fs.readFileSync(filePath, "utf8");
  } catch { /* unreadable -> not comparable as text */ }
  return null;
}

// ---- Text fingerprint: overlapping word shingles, hashed, bounded sample ----
function textFingerprint(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const k = Math.min(5, words.length);
  const set = new Set();
  for (let i = 0; i + k <= words.length; i++) {
    set.add(crypto.createHash("md5").update(words.slice(i, i + k).join(" ")).digest("hex").slice(0, 8));
  }
  return [...set].sort().slice(0, 300);
}

function textSimilarity(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const mimeFromName = (name) => IMAGE_MIME[path.extname(name).toLowerCase()] || "application/octet-stream";

module.exports = { sha256, imagePHash, imageSimilarity, extractText, textFingerprint, textSimilarity, mimeFromName };
