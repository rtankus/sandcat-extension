// ============================================================
// SandCat Community Admin
// Fill in your Firebase project config below.
// Get it from: Firebase console → Project settings → Your apps → Web app → Config
// ============================================================
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDYQReOUdp4meu80UbSLvc4c2GxSY5FUtA",
  authDomain:        "atc-feed.firebaseapp.com",
  projectId:         "atc-feed",
  storageBucket:     "atc-feed.firebasestorage.app",
  messagingSenderId: "263900215191",
  appId:             "1:263900215191:web:b52d6815006cd5e47d36d2",
};


firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db   = firebase.firestore();
const googleProvider = new firebase.auth.GoogleAuthProvider();

// ── UI refs ──────────────────────────────────────────────────
const loginSection  = document.getElementById("loginSection");
const adminSection  = document.getElementById("adminSection");
const userEmailEl   = document.getElementById("userEmail");
const signInBtn     = document.getElementById("signInBtn");
const signOutBtn    = document.getElementById("signOutBtn");

// ── Access control — add all allowed email addresses here ─────
const ALLOWED_EMAILS = [
  "tankusraina@gmail.com",   // ← replace with real emails before deploying
  "desmondmanoj21@gmail.com",
  "ghoshaan@gmail.com",
  "itslanceboyer@gmail.com",
  "xpilotyt@gmail.com",
  "katjasulima@gmail.com"
];

// ── Auth ─────────────────────────────────────────────────────
signInBtn.addEventListener("click", () => auth.signInWithPopup(googleProvider));
signOutBtn.addEventListener("click", () => auth.signOut());

auth.onAuthStateChanged(user => {
  if (user) {
    if (!ALLOWED_EMAILS.includes(user.email)) {
      auth.signOut();
      alert(`Access denied for ${user.email}.\nContact the admin to be added.`);
      return;
    }
    loginSection.style.display = "none";
    adminSection.style.display = "flex";
    userEmailEl.textContent = user.email;
    loadAll();
  } else {
    loginSection.style.display = "flex";
    adminSection.style.display = "none";
  }
});

// ── Tab switching ─────────────────────────────────────────────
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ── Load everything ───────────────────────────────────────────
function loadAll() {
  loadWaypointSubmissions();
  loadEdgeCaseSubmissions();
  loadPublishedFeed();
}

// ── Helpers ───────────────────────────────────────────────────
function esc(str) {
  return String(str || "").replace(/[&<>"']/g, m =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[m])
  );
}

function fmt(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ── Approve waypoint submission → add to feed ─────────────────
async function approveWaypoint(docId, data) {
  const title = `Waypoint: ${data.name || "?"}`;
  const body  = [
    data.wpType ? `Type: ${data.wpType}` : "",
    data.notes  ? `Notes: ${data.notes}` : "",
    data.globalKey ? `Audio: ${data.globalKey}` : "",
  ].filter(Boolean).join("\n");

  await db.collection("feed").add({
    title,
    body,
    category:  "waypoint",
    date:      todayStr(),
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("waypoint_submissions").doc(docId).delete();
  loadWaypointSubmissions();
  loadPublishedFeed();
}

// ── Approve edge case submission → add to feed ────────────────
async function approveEdgeCase(docId, data) {
  const title = data.phrase || "Edge Case";
  const body  = [
    data.resolution ? `Transcribe as: ${data.resolution}` : "",
    data.notes      ? `Notes: ${data.notes}` : "",
    data.globalKey  ? `Audio: ${data.globalKey}` : "",
  ].filter(Boolean).join("\n");

  await db.collection("feed").add({
    title,
    body,
    category:  "edge_case",
    date:      todayStr(),
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
  });
  await db.collection("edge_case_submissions").doc(docId).delete();
  loadEdgeCaseSubmissions();
  loadPublishedFeed();
}

// ── Load waypoint submissions ─────────────────────────────────
function loadWaypointSubmissions() {
  const el = document.getElementById("waypointList");
  el.innerHTML = '<div class="empty-msg">Loading…</div>';
  db.collection("waypoint_submissions").orderBy("timestamp", "desc").get()
    .then(snap => {
      if (snap.empty) { el.innerHTML = '<div class="empty-msg">No pending waypoint submissions.</div>'; return; }
      el.innerHTML = "";
      snap.forEach(doc => {
        const d = doc.data();
        const card = document.createElement("div");
        card.className = "submission-card";
        card.innerHTML = `
          <div class="field"><strong>${esc(d.name)}</strong> <span style="color:#6b7280">(${esc(d.wpType || "?")})</span></div>
          ${d.notes    ? `<div class="field">Notes: ${esc(d.notes)}</div>` : ""}
          ${d.globalKey ? `<div class="field">Audio: <span class="gk-val">${esc(d.globalKey)}</span></div>` : ""}
          <div class="ts">${fmt(d.timestamp?.toDate?.())}</div>
          <div class="card-actions">
            <button class="approve-btn">Approve → Feed</button>
            <button class="reject-btn">Reject</button>
          </div>
        `;
        card.querySelector(".approve-btn").addEventListener("click", () => approveWaypoint(doc.id, d));
        card.querySelector(".reject-btn").addEventListener("click", async () => {
          await db.collection("waypoint_submissions").doc(doc.id).delete();
          loadWaypointSubmissions();
        });
        el.appendChild(card);
      });
    })
    .catch(err => { el.innerHTML = `<div class="empty-msg">Error: ${esc(err.message)}</div>`; });
}

// ── Load edge case submissions ────────────────────────────────
function loadEdgeCaseSubmissions() {
  const el = document.getElementById("edgecaseList");
  el.innerHTML = '<div class="empty-msg">Loading…</div>';
  db.collection("edge_case_submissions").orderBy("timestamp", "desc").get()
    .then(snap => {
      if (snap.empty) { el.innerHTML = '<div class="empty-msg">No pending edge case submissions.</div>'; return; }
      el.innerHTML = "";
      snap.forEach(doc => {
        const d = doc.data();
        const card = document.createElement("div");
        card.className = "submission-card";
        card.innerHTML = `
          <div class="field">Heard: <strong>${esc(d.phrase)}</strong></div>
          ${d.resolution ? `<div class="field">Transcribe as: <strong>${esc(d.resolution)}</strong></div>` : ""}
          ${d.notes      ? `<div class="field">Notes: ${esc(d.notes)}</div>` : ""}
          ${d.globalKey  ? `<div class="field">Audio: <span class="gk-val">${esc(d.globalKey)}</span></div>` : ""}
          <div class="ts">${fmt(d.timestamp?.toDate?.())}</div>
          <div class="card-actions">
            <button class="approve-btn">Approve → Feed</button>
            <button class="reject-btn">Reject</button>
          </div>
        `;
        card.querySelector(".approve-btn").addEventListener("click", () => approveEdgeCase(doc.id, d));
        card.querySelector(".reject-btn").addEventListener("click", async () => {
          await db.collection("edge_case_submissions").doc(doc.id).delete();
          loadEdgeCaseSubmissions();
        });
        el.appendChild(card);
      });
    })
    .catch(err => { el.innerHTML = `<div class="empty-msg">Error: ${esc(err.message)}</div>`; });
}

// ── Load published feed ───────────────────────────────────────
function loadPublishedFeed() {
  const el = document.getElementById("publishedList");
  el.innerHTML = '<div class="empty-msg">Loading…</div>';
  db.collection("feed").orderBy("timestamp", "desc").get()
    .then(snap => {
      if (snap.empty) { el.innerHTML = '<div class="empty-msg">No published posts yet.</div>'; return; }
      el.innerHTML = "";
      snap.forEach(doc => {
        const d = doc.data();
        const cat = d.category || "";
        const card = document.createElement("div");
        card.className = "feed-card";
        card.innerHTML = `
          <div class="feed-title">${esc(d.title)} <span class="badge ${esc(cat)}">${esc(cat.replace("_"," "))}</span></div>
          <div class="feed-body">${esc(d.body || "")}</div>
          <div class="feed-meta">${esc(d.date || "")} · ${fmt(d.timestamp?.toDate?.())}</div>
          <button class="delete-btn">Delete</button>
        `;
        card.querySelector(".delete-btn").addEventListener("click", async () => {
          if (!confirm("Delete this post from the feed?")) return;
          await db.collection("feed").doc(doc.id).delete();
          loadPublishedFeed();
        });
        el.appendChild(card);
      });
    })
    .catch(err => { el.innerHTML = `<div class="empty-msg">Error: ${esc(err.message)}</div>`; });
}

// ── Direct post ───────────────────────────────────────────────
document.getElementById("dpSubmitBtn").addEventListener("click", async () => {
  const title = document.getElementById("dpTitle").value.trim();
  const body  = document.getElementById("dpBody").value.trim();
  const cat   = document.getElementById("dpCategory").value;
  const status = document.getElementById("directPostStatus");
  if (!title) { status.textContent = "Title is required."; status.style.color = "#fca5a5"; return; }
  status.textContent = "Publishing…"; status.style.color = "#6b7280";
  try {
    await db.collection("feed").add({
      title,
      body,
      category:  cat,
      date:      todayStr(),
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    });
    status.textContent = "Published!"; status.style.color = "#86efac";
    document.getElementById("dpTitle").value = "";
    document.getElementById("dpBody").value = "";
    loadPublishedFeed();
  } catch (err) {
    status.textContent = `Error: ${err.message}`; status.style.color = "#fca5a5";
  }
});
