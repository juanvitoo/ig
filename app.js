/* Unfollow Tracker — 100% client-side.
 * Parses an Instagram "Download Your Information" export to find:
 *   - accounts that don't follow you back
 *   - fans you don't follow
 *   - and, by comparing against a saved snapshot, who unfollowed you or
 *     deactivated / got banned (they silently disappear from your followers).
 * No network calls except an optional, lazy JSZip load for .zip convenience.
 */

const SNAPSHOT_KEY = "ig-unfollow-tracker:snapshot:v1";
const JSZIP_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

// ----- State -----
let current = null; // { followers: Set, following: Set, users: Map<lower, {username, href}>, takenAt }
let activeTab = "lost";
let diff = null; // computed against snapshot

// ----- DOM helpers -----
const $ = (id) => document.getElementById(id);
const lc = (s) => String(s || "").toLowerCase();

// ===================================================================
// Instagram JSON parsing
// ===================================================================

// Instagram nests usernames as: { string_list_data: [{ value, href, timestamp }] }.
// Followers files are usually a bare array; following.json wraps it under
// `relationships_following`. We accept either shape defensively.
function extractEntries(json) {
  let arr = null;
  if (Array.isArray(json)) {
    arr = json;
  } else if (json && typeof json === "object") {
    const key = Object.keys(json).find((k) => Array.isArray(json[k]));
    if (key) arr = json[key];
  }
  if (!arr) return [];

  const out = [];
  for (const item of arr) {
    const sld = item && item.string_list_data;
    let username = "", href = "", timestamp = 0;
    if (Array.isArray(sld) && sld.length) {
      // Followers files carry the username in string_list_data[0].value;
      // following.json omits `value` and stores the username in `title`.
      const e = sld[0];
      username = e.value || item.title || "";
      href = e.href || "";
      timestamp = e.timestamp || 0;
    } else if (item && (item.value || item.title)) {
      username = item.value || item.title;
      href = item.href || "";
    }
    if (username) out.push({ username, href, timestamp });
  }
  return out;
}

// Decide whether a given file's content is a followers or following list,
// using the filename first, then the JSON's wrapper key as a fallback.
function classify(name, json) {
  const n = lc(name);
  if (n.includes("following")) return "following";
  if (n.includes("follower")) return "followers";
  if (json && !Array.isArray(json) && typeof json === "object") {
    const keys = Object.keys(json).map(lc).join(" ");
    if (keys.includes("following")) return "following";
    if (keys.includes("follower")) return "followers";
  }
  // Bare arrays in IG exports are the followers files.
  if (Array.isArray(json)) return "followers";
  return "unknown";
}

async function readFileText(file) {
  return await file.text();
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = JSZIP_CDN;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Could not load ZIP support (offline?). Upload the JSON files instead."));
    document.head.appendChild(s);
  });
  return window.JSZip;
}

// Returns { followers: [entries], following: [entries] }
async function parseFiles(fileList) {
  const files = Array.from(fileList);
  const result = { followers: [], following: [] };

  for (const file of files) {
    const name = lc(file.name);

    if (name.endsWith(".zip")) {
      const JSZip = await loadJSZip();
      const zip = await JSZip.loadAsync(file);
      const jsonPaths = Object.keys(zip.files).filter(
        (p) => lc(p).endsWith(".json") &&
               (lc(p).includes("follower") || lc(p).includes("following"))
      );
      for (const p of jsonPaths) {
        let json;
        try { json = JSON.parse(await zip.files[p].async("string")); }
        catch { continue; }
        // Classify by filename, NOT the full path: the export folder is named
        // "followers_and_following", whose name contains "following" and would
        // otherwise misclassify followers_*.json as a following file.
        const base = p.split("/").pop();
        const kind = classify(base, json);
        if (kind === "followers") result.followers.push(...extractEntries(json));
        else if (kind === "following") result.following.push(...extractEntries(json));
      }
    } else if (name.endsWith(".json")) {
      let json;
      try { json = JSON.parse(await readFileText(file)); }
      catch { throw new Error(`${file.name} isn't valid JSON.`); }
      const kind = classify(file.name, json);
      if (kind === "followers") result.followers.push(...extractEntries(json));
      else if (kind === "following") result.following.push(...extractEntries(json));
      else throw new Error(`Couldn't tell if ${file.name} is followers or following. Rename it to include "followers" or "following".`);
    } else {
      throw new Error(`Unsupported file: ${file.name}. Use the .zip or the JSON files.`);
    }
  }
  return result;
}

// ===================================================================
// Build current state + diff against snapshot
// ===================================================================

function buildCurrent(parsed, takenAt) {
  const users = new Map(); // lower -> {username, href}
  const remember = (e) => {
    const key = lc(e.username);
    if (!users.has(key)) users.set(key, { username: e.username, href: e.href });
  };
  parsed.followers.forEach(remember);
  parsed.following.forEach(remember);

  return {
    followers: new Set(parsed.followers.map((e) => lc(e.username))),
    following: new Set(parsed.following.map((e) => lc(e.username))),
    users,
    takenAt,
  };
}

function computeDiff() {
  const snap = loadSnapshot();
  if (!snap) { diff = null; return; }
  const prevFollowers = new Set(snap.followers);
  const lost = [];
  const gained = [];
  for (const u of prevFollowers) {
    if (!current.followers.has(u)) lost.push(u);
  }
  for (const u of current.followers) {
    if (!prevFollowers.has(u)) gained.push(u);
  }
  diff = { lost, gained, snapTakenAt: snap.takenAt };
}

// ===================================================================
// Snapshot persistence (localStorage)
// ===================================================================

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveSnapshot() {
  const snap = {
    followers: Array.from(current.followers),
    following: Array.from(current.following),
    takenAt: current.takenAt,
  };
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  computeDiff();
  render();
  flash("Snapshot saved. Re-upload a fresh export later to spot unfollowers.", "ok");
}

function clearSnapshot() {
  localStorage.removeItem(SNAPSHOT_KEY);
  computeDiff();
  render();
  flash("Snapshot history cleared.", "ok");
}

// ===================================================================
// Rendering
// ===================================================================

function userObj(key) {
  return (current && current.users.get(key)) || { username: key, href: "" };
}

function profileUrl(u) {
  // Build a clean web URL from the username. The export's hrefs are often
  // /_u/<name> app deep-links that don't open well in a browser.
  return `https://www.instagram.com/${encodeURIComponent(u.username)}/`;
}

function listFor(tab) {
  const followers = current.followers;
  const following = current.following;
  switch (tab) {
    case "notback": // you follow, they don't follow back
      return [...following].filter((u) => !followers.has(u)).map((u) => ({ key: u }));
    case "fans": // they follow you, you don't follow them
      return [...followers].filter((u) => !following.has(u)).map((u) => ({ key: u }));
    case "mutual":
      return [...following].filter((u) => followers.has(u)).map((u) => ({ key: u }));
    case "gained":
      return diff ? diff.gained.map((u) => ({ key: u, tag: "new" })) : [];
    case "lost":
    default:
      return diff ? diff.lost.map((u) => ({ key: u, tag: "gone" })) : [];
  }
}

function render() {
  if (!current) return;
  $("results-section").classList.remove("hidden");
  $("upload-section").classList.add("hidden");

  const notBack = [...current.following].filter((u) => !current.followers.has(u)).length;
  $("stat-followers").textContent = current.followers.size;
  $("stat-following").textContent = current.following.size;
  $("stat-notback").textContent = notBack;
  $("stat-lost").textContent = diff ? diff.lost.length : "–";

  // Snapshot bar
  const snap = loadSnapshot();
  if (snap) {
    $("snapshot-info").textContent = `Comparing against snapshot from ${fmtDate(snap.takenAt)}.`;
    $("snapshot-hint").textContent = diff && diff.lost.length
      ? `${diff.lost.length} account(s) that followed you then are gone now — unfollowed, deactivated, or banned.`
      : "No followers lost since your last snapshot. 🎉";
    $("clear-snapshot").classList.remove("hidden");
  } else {
    $("snapshot-info").textContent = "No previous snapshot saved.";
    $("snapshot-hint").textContent = "Save a snapshot now, then come back after your next export to detect unfollowers & deactivations.";
    $("clear-snapshot").classList.add("hidden");
  }

  // Badges
  $("badge-lost").textContent = diff ? diff.lost.length : 0;
  $("badge-gained").textContent = diff ? diff.gained.length : 0;
  $("badge-notback").textContent = notBack;
  $("badge-fans").textContent = [...current.followers].filter((u) => !current.following.has(u)).length;
  $("badge-mutual").textContent = [...current.following].filter((u) => current.followers.has(u)).length;

  renderList();
}

function renderList() {
  const ul = $("user-list");
  const empty = $("empty-state");
  const q = lc($("search").value.trim());
  let items = listFor(activeTab);

  if (q) items = items.filter((it) => lc(userObj(it.key).username).includes(q));
  items.sort((a, b) => userObj(a.key).username.localeCompare(userObj(b.key).username));

  $("list-caption").textContent = `${items.length} account${items.length === 1 ? "" : "s"}`;

  ul.innerHTML = "";
  if (!items.length) {
    empty.classList.remove("hidden");
    empty.textContent = emptyMessage(activeTab);
    return;
  }
  empty.classList.add("hidden");

  const frag = document.createDocumentFragment();
  for (const it of items) {
    const u = userObj(it.key);
    const li = document.createElement("li");
    li.className = "user-item";

    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "uname";
    name.textContent = "@" + u.username;
    left.appendChild(name);
    if (it.tag) {
      const t = document.createElement("span");
      t.className = "tag " + it.tag;
      t.textContent = it.tag === "gone" ? "gone since snapshot" : "new follower";
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.appendChild(t);
      left.appendChild(meta);
    }

    const link = document.createElement("a");
    link.className = "open";
    link.href = profileUrl(u);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open ↗";

    li.appendChild(left);
    li.appendChild(link);
    frag.appendChild(li);
  }
  ul.appendChild(frag);
}

function emptyMessage(tab) {
  switch (tab) {
    case "lost":
      return loadSnapshot()
        ? "No followers lost since your last snapshot. 🎉"
        : "Save a snapshot now. After your next Instagram export, this tab shows who unfollowed or deactivated.";
    case "gained":
      return loadSnapshot() ? "No new followers since your last snapshot." : "Save a snapshot to start tracking new followers.";
    case "notback": return "Everyone you follow follows you back. 🙌";
    case "fans": return "No one-sided fans found.";
    case "mutual": return "No mutual follows found.";
    default: return "Nothing here.";
  }
}

// ===================================================================
// Utilities
// ===================================================================

function fmtDate(ts) {
  if (!ts) return "an earlier date";
  const d = new Date(ts);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function flash(msg, kind) {
  const el = $("parse-status");
  el.textContent = msg;
  el.className = "status " + (kind || "");
}

// ===================================================================
// Wire-up
// ===================================================================

async function handleFiles(fileList) {
  if (!fileList || !fileList.length) return;
  flash("Reading your export…", "");
  try {
    const parsed = await parseFiles(fileList);
    if (!parsed.followers.length && !parsed.following.length) {
      throw new Error("No follower/following data found. Make sure you exported in JSON format and selected 'Followers and following'.");
    }
    current = buildCurrent(parsed, Date.now());
    computeDiff();
    flash("", "");
    activeTab = loadSnapshot() ? "lost" : "notback";
    syncActiveTab();
    render();
    $("results-section").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    flash(err.message || "Something went wrong parsing the files.", "error");
  }
}

function syncActiveTab() {
  document.querySelectorAll(".tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === activeTab)
  );
}

function init() {
  const dz = $("dropzone");
  const input = $("file-input");

  dz.addEventListener("click", () => input.click());
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener("change", () => handleFiles(input.files));

  $("tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    activeTab = btn.dataset.tab;
    syncActiveTab();
    renderList();
  });

  $("search").addEventListener("input", renderList);
  $("save-snapshot").addEventListener("click", saveSnapshot);
  $("clear-snapshot").addEventListener("click", clearSnapshot);
  $("reset-all").addEventListener("click", (e) => {
    e.preventDefault();
    current = null;
    diff = null;
    $("file-input").value = "";
    $("results-section").classList.add("hidden");
    $("upload-section").classList.remove("hidden");
    flash("", "");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

document.addEventListener("DOMContentLoaded", init);
