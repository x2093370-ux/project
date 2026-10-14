// app.js — CloudVault frontend logic
const API_BASE = "/api"; // same-origin: the backend serves this frontend
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB chunks
const MAX_RETRIES = 3;

const $ = (id) => document.getElementById(id);
const state = {
  token: localStorage.getItem("cv_token"),
  user: JSON.parse(localStorage.getItem("cv_user") || "null"),
  currentFolderId: null,
  breadcrumb: [{ id: null, name: "My Files" }],
};

// ---------- helpers ----------
async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
  });
  if (res.status === 401 && state.token) { logout(); throw new Error("Session expired, please log in again"); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}
const jsonOpts = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function notice(message, isError = false, ms = 6000) {
  const el = $("notice");
  el.textContent = message;
  el.className = `notice ${isError ? "error" : ""}`;
  clearTimeout(notice._t);
  notice._t = setTimeout(() => el.classList.add("hidden"), ms);
}

async function sha256Hex(blob) {
  if (!(window.crypto && crypto.subtle)) return null; // needs a secure context (localhost counts)
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- auth ----------
document.querySelectorAll(".tab-btn").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  $("login-form").classList.toggle("hidden", btn.dataset.tab !== "login");
  $("register-form").classList.toggle("hidden", btn.dataset.tab !== "register");
}));

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").textContent = "";
  try {
    const d = await api("/auth/login", jsonOpts("POST", { email: $("login-email").value, password: $("login-password").value }));
    startSession(d.token, d.user);
  } catch (err) { $("login-error").textContent = err.message; }
});

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("register-error").textContent = "";
  try {
    const d = await api("/auth/register", jsonOpts("POST", {
      name: $("register-name").value, email: $("register-email").value, password: $("register-password").value,
    }));
    startSession(d.token, d.user);
  } catch (err) { $("register-error").textContent = err.message; }
});

function logout() {
  localStorage.removeItem("cv_token");
  localStorage.removeItem("cv_user");
  state.token = null; state.user = null;
  $("app").classList.add("hidden");
  $("auth-screen").classList.remove("hidden");
}
$("logout-btn").addEventListener("click", logout);

function startSession(token, user) {
  state.token = token; state.user = user;
  state.currentFolderId = null;
  state.breadcrumb = [{ id: null, name: "My Files" }];
  localStorage.setItem("cv_token", token);
  localStorage.setItem("cv_user", JSON.stringify(user));
  $("auth-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  refreshAll();
}

// ---------- stats ----------
async function loadStats() {
  const s = await api("/stats");
  $("storage-fill").style.width = `${Math.min(100, (s.usedBytes / s.limitBytes) * 100)}%`;
  $("storage-label").textContent = `${formatSize(s.usedBytes)} of ${formatSize(s.limitBytes)} used`;
  $("saved-num").textContent = formatSize(s.savedBytes);
  $("ai-label").textContent = s.aiEnabled ? "AI duplicate detection: on" : "AI duplicate detection: off (local similarity)";
}

// ---------- breadcrumb / navigation ----------
function renderBreadcrumb() {
  const el = $("breadcrumb");
  el.innerHTML = "";
  state.breadcrumb.forEach((crumb, i) => {
    const btn = document.createElement("button");
    btn.textContent = crumb.name;
    btn.addEventListener("click", () => {
      state.breadcrumb = state.breadcrumb.slice(0, i + 1);
      state.currentFolderId = crumb.id;
      loadItems();
    });
    el.appendChild(btn);
    if (i < state.breadcrumb.length - 1) el.appendChild(Object.assign(document.createElement("span"), { textContent: "/" }));
  });
}

// ---------- merge candidates (near-duplicates) ----------
async function loadMergeCandidates() {
  const { candidates } = await api("/merge-candidates");
  const panel = $("dedup-panel"), list = $("dedup-list");
  list.innerHTML = "";
  panel.classList.toggle("hidden", candidates.length === 0);

  candidates.forEach((c) => {
    const row = document.createElement("div");
    row.className = "dedup-row";

    const main = document.createElement("div");
    main.className = "dedup-main";
    const title = document.createElement("span");
    title.append(`"${c.item_name}" looks ${Math.round(c.similarity * 100)}% like "${c.matched_name}"`);
    const badge = document.createElement("span");
    badge.className = `badge ${c.source === "ai" ? "ai" : "local"}`;
    badge.textContent = c.source === "ai" ? "AI verified" : "fingerprint match";
    title.appendChild(badge);
    main.appendChild(title);
    if (c.reason) main.appendChild(Object.assign(document.createElement("span"), { className: "dedup-reason", textContent: c.reason }));

    const actions = document.createElement("span");
    actions.className = "dedup-actions";
    const mergeBtn = Object.assign(document.createElement("button"), { className: "merge-btn", textContent: "Merge & save space" });
    mergeBtn.addEventListener("click", async () => {
      try {
        const r = await api(`/merge-candidates/${c.id}/merge`, { method: "POST" });
        notice(`Merged onto "${r.keptFile}" — reclaimed ${formatSize(r.reclaimedBytes)}.`);
        refreshAll();
      } catch (err) { notice(err.message, true); }
    });
    const dismissBtn = Object.assign(document.createElement("button"), { textContent: "Keep both" });
    dismissBtn.addEventListener("click", async () => { await api(`/merge-candidates/${c.id}/dismiss`, { method: "POST" }); loadMergeCandidates(); });
    actions.append(mergeBtn, dismissBtn);

    row.append(main, actions);
    list.appendChild(row);
  });
}

// ---------- item list ----------
const ICON_FOLDER = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 5a1 1 0 0 1 1-1h4l1.5 2H15a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5Z" stroke="currentColor" stroke-width="1.4"/></svg>`;
const ICON_FILE = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M5 2h6l3 3v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.4"/><path d="M11 2v3h3" stroke="currentColor" stroke-width="1.4"/></svg>`;

function actionButton(label, onClick, cls = "") {
  const b = Object.assign(document.createElement("button"), { textContent: label, className: cls });
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

async function downloadFile(item) {
  const res = await fetch(`${API_BASE}/files/${item.id}/download`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) return notice("Download failed", true);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: item.name });
  a.click();
  URL.revokeObjectURL(url);
}

async function loadItems() {
  renderBreadcrumb();
  const q = state.currentFolderId ? `?parent=${state.currentFolderId}` : "";
  const { items } = await api(`/items${q}`);
  const listEl = $("item-list");
  listEl.innerHTML = "";
  $("empty-state").classList.toggle("hidden", items.length > 0);

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = `item-row ${item.type === "folder" ? "is-folder" : ""}`;
    row.append(
      Object.assign(document.createElement("span"), { className: "item-icon", innerHTML: item.type === "folder" ? ICON_FOLDER : ICON_FILE }),
      Object.assign(document.createElement("span"), { className: "item-name", textContent: item.name }),
      Object.assign(document.createElement("span"), { className: "item-meta", textContent: item.type === "file" ? formatSize(item.size_bytes) : "" }),
    );
    const actions = Object.assign(document.createElement("span"), { className: "item-actions" });
    if (item.type === "file") {
      actions.append(actionButton("Download", () => downloadFile(item)), actionButton("Share", () => openShareModal(item)));
    }
    actions.append(
      actionButton("Rename", async () => {
        const name = prompt("New name:", item.name);
        if (name) { await api(`/items/${item.id}`, jsonOpts("PATCH", { name })); loadItems(); }
      }),
      actionButton("Delete", async () => {
        if (confirm(`Delete "${item.name}"? This cannot be undone.`)) { await api(`/items/${item.id}`, { method: "DELETE" }); refreshAll(); }
      }, "danger"),
    );
    row.appendChild(actions);
    if (item.type === "folder") {
      row.addEventListener("click", () => { state.currentFolderId = item.id; state.breadcrumb.push({ id: item.id, name: item.name }); loadItems(); });
    }
    listEl.appendChild(row);
  });
}

function refreshAll() { return Promise.all([loadItems(), loadMergeCandidates(), loadStats()]).catch((e) => notice(e.message, true)); }

$("new-folder-btn").addEventListener("click", async () => {
  const name = prompt("Folder name:");
  if (!name) return;
  try { await api("/folders", jsonOpts("POST", { name, parentId: state.currentFolderId })); loadItems(); }
  catch (err) { notice(err.message, true); }
});

// ---------- chunked upload (SHA-256 verified, retried per chunk) ----------
async function uploadChunk(sessionId, index, blob) {
  const checksum = await sha256Hex(blob);
  for (let attempt = 1; ; attempt++) {
    try {
      const form = new FormData();
      if (checksum) form.append("checksum", checksum);
      form.append("chunk", blob);
      return await api(`/upload/${sessionId}/chunk/${index}`, { method: "POST", body: form });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function uploadFile(file, label) {
  const bar = $("upload-progress"), fill = $("upload-progress-fill");
  bar.classList.remove("hidden");
  fill.style.width = "0%";
  $("upload-progress-label").textContent = `${label}Uploading ${file.name}…`;

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const { uploadSessionId } = await api("/upload/init", jsonOpts("POST", {
    fileName: file.name, totalChunks, totalSizeBytes: file.size, parentId: state.currentFolderId,
  }));
  for (let i = 0; i < totalChunks; i++) {
    await uploadChunk(uploadSessionId, i, file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    fill.style.width = `${Math.round(((i + 1) / totalChunks) * 100)}%`;
  }
  $("upload-progress-label").textContent = `${label}Checking ${file.name} for duplicates…`;
  return api(`/upload/${uploadSessionId}/complete`, { method: "POST" });
}

async function uploadMany(files) {
  const list = [...files];
  for (let i = 0; i < list.length; i++) {
    const label = list.length > 1 ? `(${i + 1}/${list.length}) ` : "";
    try {
      const r = await uploadFile(list[i], label);
      if (r.exactDuplicate) notice(r.message);
      else if (r.possibleDuplicateOf) notice(`"${list[i].name}" uploaded — it looks like "${r.possibleDuplicateOf}". Review the suggestion below.`);
    } catch (err) { notice(`Upload failed for ${list[i].name}: ${err.message}`, true); }
  }
  $("upload-progress").classList.add("hidden");
  refreshAll();
}

$("file-input").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) uploadMany(f); });

const dropZone = $("drop-zone");
["dragenter", "dragover"].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("dragging"); }));
["dragleave", "drop"].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("dragging"); }));
dropZone.addEventListener("drop", (e) => { if (e.dataTransfer.files.length) uploadMany(e.dataTransfer.files); });

// ---------- share ----------
let shareTarget = null;
function openShareModal(item) {
  shareTarget = item;
  $("share-item-name").textContent = item.name;
  $("share-link-result").classList.add("hidden");
  $("share-modal").classList.remove("hidden");
}
$("close-share-modal").addEventListener("click", () => $("share-modal").classList.add("hidden"));
$("generate-link-btn").addEventListener("click", async () => {
  try {
    const exp = $("share-expiry").value;
    const d = await api("/share/link", jsonOpts("POST", { itemId: shareTarget.id, role: "VIEWER", expiresInHours: exp ? Number(exp) : null }));
    $("share-link-value").value = `${location.origin}${d.url}`;
    $("share-link-result").classList.remove("hidden");
  } catch (err) { notice(err.message, true); }
});
$("copy-link-btn").addEventListener("click", () => { $("share-link-value").select(); navigator.clipboard.writeText($("share-link-value").value); });

// ---------- boot ----------
if (state.token && state.user) {
  $("auth-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  refreshAll();
}
