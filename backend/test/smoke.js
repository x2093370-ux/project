// End-to-end smoke test. Usage: BASE=http://localhost:4100 MODE=local|ai node test/smoke.js
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const Jimp = require("jimp");

const BASE = process.env.BASE || "http://localhost:4000";
const MODE = process.env.MODE || "local";
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name} ${extra}`); if (!cond) failures++; };

async function call(path, { token, method = "GET", json, form } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  let body;
  if (json) { headers["Content-Type"] = "application/json"; body = JSON.stringify(json); }
  if (form) body = form;
  const res = await fetch(BASE + path, { method, headers, body });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, data: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

async function uploadChunked(token, name, buffer, chunkSize = 64 * 1024) {
  const total = Math.max(1, Math.ceil(buffer.length / chunkSize));
  const init = await call("/api/upload/init", { token, method: "POST", json: { fileName: name, totalChunks: total, totalSizeBytes: buffer.length } });
  const sid = init.data.uploadSessionId;
  for (let i = 0; i < total; i++) {
    const part = buffer.subarray(i * chunkSize, (i + 1) * chunkSize);
    const form = new FormData();
    form.append("checksum", crypto.createHash("sha256").update(part).digest("hex"));
    form.append("chunk", new Blob([part]), "chunk");
    const r = await call(`/api/upload/${sid}/chunk/${i}`, { token, method: "POST", form });
    if (r.status !== 200) throw new Error(`chunk ${i} failed: ${JSON.stringify(r.data)}`);
  }
  return call(`/api/upload/${sid}/complete`, { token, method: "POST" });
}

function makeDocx(text) {
  const zip = new AdmZip();
  const paras = text.split("\n").map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.addFile("word/document.xml", Buffer.from(`<?xml version="1.0"?><w:document><w:body>${paras}</w:body></w:document>`));
  return zip.toBuffer();
}
const words = (n, changeEvery, marker) =>
  Array.from({ length: n }, (_, i) => (changeEvery && i % changeEvery === 0 ? `${marker}${i}` : `w${i}x`)).join(" ");

(async () => {
  const email = `t${Date.now()}@test.com`;
  const reg = await call("/api/auth/register", { method: "POST", json: { name: "Tester", email, password: "secret12" } });
  check("register", reg.status === 201);
  const token = reg.data.token;

  // --- exact duplicate (SHA-256) ---
  const signals = makeDocx("Signals and systems lecture notes\n" + words(80));
  const a = await uploadChunked(token, "SIGNALS.docx", signals);
  check("first upload stored", a.status === 201 && a.data.sha256 === crypto.createHash("sha256").update(signals).digest("hex"));
  const b = await uploadChunked(token, "SIGNALS.docx", signals);
  check("same file again -> exact duplicate, nothing stored", b.status === 200 && b.data.exactDuplicate === true, b.data.message || "");
  const list = await call("/api/items", { token });
  check("only ONE SIGNALS.docx listed", list.data.items.filter((i) => i.name === "SIGNALS.docx").length === 1);
  const st1 = await call("/api/stats", { token });
  check("savedBytes counts the refused duplicate", st1.data.savedBytes >= signals.length, `(saved ${st1.data.savedBytes})`);

  // --- near-duplicate docx (light edit, high local similarity) ---
  const v2 = makeDocx("Signals and systems lecture notes\n" + words(80, 40, "edit"));
  const c = await uploadChunked(token, "SIGNALS-v2.docx", v2);
  check("edited copy is stored (not byte-identical)", c.status === 201);
  let cands = (await call("/api/merge-candidates", { token })).data.candidates;
  check("edited docx flagged as near-duplicate", cands.length === 1 && cands[0].type === "text", cands[0] ? `(${Math.round(cands[0].similarity * 100)}% via ${cands[0].source})` : "");

  // merge it and verify space is reclaimed
  const before = (await call("/api/stats", { token })).data;
  const m = await call(`/api/merge-candidates/${cands[0].id}/merge`, { token, method: "POST" });
  const after = (await call("/api/stats", { token })).data;
  check("merge reports reclaimed bytes", m.status === 200 && m.data.reclaimedBytes > 0);
  check("physical storage went down after merge", after.usedBytes < before.usedBytes, `(${before.usedBytes} -> ${after.usedBytes})`);

  // --- gray-zone pair: ~50% local similarity. Only the AI should catch it ---
  const g1 = makeDocx(words(150));
  const g2 = makeDocx(words(150, 15, "rw"));
  await uploadChunked(token, "report.docx", g1);
  await uploadChunked(token, "report-reworded.docx", g2);
  cands = (await call("/api/merge-candidates", { token })).data.candidates.filter((x) => x.item_name === "report-reworded.docx");
  if (MODE === "ai") {
    check("AI catches reworded document that local similarity misses", cands.length === 1 && cands[0].source === "ai", cands[0] ? `reason: ${cands[0].reason}` : "");
    // AI veto: similar wording but the AI says they are different documents
    const d1 = makeDocx(words(150, 0) + " ZZZ_DIFFERENT");
    await uploadChunked(token, "other-a.docx", makeDocx(words(100) + " alpha"));
    await uploadChunked(token, "other-b.docx", d1);
    const vetoed = (await call("/api/merge-candidates", { token })).data.candidates.filter((x) => x.item_name === "other-b.docx");
    check("AI can veto a false local match", vetoed.length === 0);
  } else {
    check("without AI, the reworded document is NOT flagged (local threshold)", cands.length === 0);
  }

  // --- images: same picture, different size + format ---
  const img = new Jimp(200, 200, 0xffffffff);
  img.scan(0, 0, 200, 200, function (x, y, idx) { this.bitmap.data[idx] = 200; this.bitmap.data[idx + 1] = 50 + (x % 50); this.bitmap.data[idx + 2] = 50 + (y % 50); });
  const png = await img.getBufferAsync(Jimp.MIME_PNG);
  const jpg = await img.clone().resize(180, 180).resize(200, 200).quality(85).getBufferAsync(Jimp.MIME_JPEG);
  await uploadChunked(token, "sunset.png", png);
  await uploadChunked(token, "sunset-resaved.jpg", jpg);
  const imgCands = (await call("/api/merge-candidates", { token })).data.candidates.filter((x) => x.type === "image");
  check("resized/recompressed image flagged as near-duplicate", imgCands.length === 1, imgCands[0] ? `(${Math.round(imgCands[0].similarity * 100)}% via ${imgCands[0].source})` : "");

  // --- multi-chunk upload integrity + download ---
  const big = crypto.randomBytes(200 * 1024);
  const up = await uploadChunked(token, "big.bin", big, 70000);
  check("3-chunk upload assembled", up.status === 201);
  const dl = await call(`/api/files/${up.data.id}/download`, { token });
  check("downloaded bytes hash equals original SHA-256", crypto.createHash("sha256").update(dl.data).digest("hex") === up.data.sha256);

  // --- bad chunk checksum is rejected ---
  const init = await call("/api/upload/init", { token, method: "POST", json: { fileName: "x.bin", totalChunks: 1, totalSizeBytes: 3 } });
  const badForm = new FormData();
  badForm.append("checksum", "0".repeat(64));
  badForm.append("chunk", new Blob([Buffer.from("abc")]), "chunk");
  const bad = await call(`/api/upload/${init.data.uploadSessionId}/chunk/0`, { token, method: "POST", form: badForm });
  check("corrupted chunk rejected (checksum mismatch)", bad.status === 422);

  // --- sharing ---
  const share = await call("/api/share/link", { token, method: "POST", json: { itemId: up.data.id, role: "VIEWER", expiresInHours: 1 } });
  const pub = await call(share.data.url);
  check("share link downloads without login", pub.status === 200 && crypto.createHash("sha256").update(pub.data).digest("hex") === up.data.sha256);

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("test crashed:", e); process.exit(1); });
