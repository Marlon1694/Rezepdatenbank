/* Rezepte → Notion — Web-App. Bewusst ohne Framework und ohne Build-Schritt:
   so bleibt das Deployment ein einziges "docker compose up". */

const TOKEN_KEY = "rezepte.token";
const $ = (id) => document.getElementById(id);

let token = "";
let pollTimer = null;
let openJobId = null;

try {
  token = localStorage.getItem(TOKEN_KEY) || "";
} catch {
  /* Privater Modus: dann eben pro Sitzung neu eingeben. */
}

/* ── API ──────────────────────────────────────────────────────────────────── */

async function api(path, options = {}) {
  // Content-Type nur setzen, wenn auch wirklich ein Body mitgeht. Fastify weist
  // einen leeren Body mit "application/json" sonst mit HTTP 400 ab - was die
  // Knöpfe "Erneut versuchen" und "Löschen" wirkungslos gemacht hat.
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { ...options, headers });

  if (res.status === 401) {
    showSetup("Token wurde nicht akzeptiert.");
    throw new Error("Nicht autorisiert");
  }
  if (res.status === 204) return null;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ── Einrichtung ──────────────────────────────────────────────────────────── */

function showSetup(message) {
  $("setup").hidden = false;
  $("submit").hidden = true;
  $("listSection").hidden = true;
  const err = $("setupError");
  err.hidden = !message;
  err.textContent = message || "";
  stopPolling();
}

function showApp() {
  $("setup").hidden = true;
  $("submit").hidden = false;
  $("listSection").hidden = false;
  refresh();
}

$("saveToken").addEventListener("click", async () => {
  const value = $("tokenInput").value.trim();
  if (!value) return;
  token = value;
  try {
    await api("/api/jobs?limit=1");
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* egal */ }
    start();
  } catch {
    /* showSetup hat die Meldung bereits gesetzt */
  }
});

$("tokenInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("saveToken").click();
});

$("settingsBtn").addEventListener("click", () => {
  $("tokenInput").value = token;
  showSetup("");
});

/* ── Einreichen ───────────────────────────────────────────────────────────── */

async function submitUrl(auto = false) {
  const input = $("urlInput");
  const url = input.value.trim();
  const msg = $("submitMsg");

  if (!url) return;

  $("submitBtn").disabled = true;
  msg.hidden = false;
  msg.className = "msg";
  msg.textContent = "Wird eingereiht …";

  try {
    const job = await api("/api/jobs", { method: "POST", body: JSON.stringify({ url }) });
    input.value = "";
    msg.className = "msg ok";
    msg.textContent = auto
      ? `✓ ${job.platform}-Link eingereiht. Du kannst zurück zur App wechseln.`
      : `Eingereiht (${job.platform}). Der Verlauf aktualisiert sich von selbst.`;
    // Aus dem Teilen-Menü heraus ist der Bildschirm oft nur kurz zu sehen -
    // die Bestätigung muss auf einen Blick erkennbar sein.
    if (auto) {
      msg.style.fontSize = "17px";
      msg.style.fontWeight = "700";
      msg.scrollIntoView({ block: "center" });
    }
    refresh();
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = err.message;
  } finally {
    $("submitBtn").disabled = false;
  }
}

$("submitBtn").addEventListener("click", () => submitUrl());
$("urlInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitUrl();
});

$("pasteBtn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $("urlInput").value = text.trim();
  } catch {
    $("urlInput").focus();
  }
});

$("refreshBtn").addEventListener("click", refresh);

/* ── Verlauf ──────────────────────────────────────────────────────────────── */

const STATUS_LABEL = { queued: "Wartet", running: "Läuft", done: "Fertig", failed: "Fehler" };

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const std = Math.round(min / 60);
  if (std < 24) return `vor ${std} Std.`;
  return new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "short" });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function renderJobs(jobs) {
  const box = $("jobs");
  $("empty").hidden = jobs.length > 0;
  box.innerHTML = "";

  for (const job of jobs) {
    const el = document.createElement("div");
    el.className = "job";
    el.tabIndex = 0;

    const title = job.recipeTitle || job.title || job.url;
    const meta = [];
    if (job.platform) meta.push(job.platform);
    if (job.status === "running" && job.step) meta.push(job.step);
    if (job.status === "done") {
      if (job.textSource) meta.push(job.textSource);
      if (job.durationMs) meta.push(`${(job.durationMs / 1000).toFixed(0)} s`);
      if (job.notionUpdated) meta.push("aktualisiert");
    }
    meta.push(relativeTime(job.createdAt));

    el.innerHTML = `
      <div class="job-top">
        <span class="job-title">${escapeHtml(title)}</span>
        <span class="badge ${job.status}">${STATUS_LABEL[job.status] || job.status}</span>
      </div>
      <div class="job-meta">${escapeHtml(meta.join(" · "))}</div>
      ${job.error ? `<div class="job-err">${escapeHtml(job.error)}</div>` : ""}
    `;

    const open = () => {
      openDetail(job.id).catch((err) => {
        // Sonst versandet der Klick wortlos.
        alert(`Details konnten nicht geladen werden: ${err.message}`);
      });
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    box.appendChild(el);
  }
}

async function refresh() {
  try {
    const jobs = await api("/api/jobs?limit=50");
    renderJobs(jobs);

    // Solange etwas laeuft, haeufiger nachsehen.
    const busy = jobs.some((j) => j.status === "queued" || j.status === "running");
    schedulePoll(busy ? 3000 : 20000);

    if (openJobId && busy) {
      const current = jobs.find((j) => j.id === openJobId);
      if (current && current.status !== "running" && current.status !== "queued") {
        openDetail(openJobId);
      }
    }
  } catch {
    schedulePoll(15000);
  }
}

function schedulePoll(ms) {
  stopPolling();
  pollTimer = setTimeout(refresh, ms);
}

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token) refresh();
  else stopPolling();
});

/* ── Detailansicht ────────────────────────────────────────────────────────── */

function textarea(value, rows = 2) {
  const t = document.createElement("textarea");
  t.value = value ?? "";
  t.rows = rows;
  return t;
}

function input(value, placeholder = "") {
  const i = document.createElement("input");
  i.type = "text";
  i.value = value ?? "";
  i.placeholder = placeholder;
  return i;
}

async function openDetail(id) {
  openJobId = id;
  const job = await api(`/api/jobs/${id}`);
  const box = $("detail");
  box.innerHTML = "";

  const link = $("notionLink");
  link.hidden = !job.notionPageUrl;
  if (job.notionPageUrl) link.href = job.notionPageUrl;

  const head = document.createElement("div");
  head.innerHTML = `
    <h2>${escapeHtml(job.recipe ? `${job.recipe.emoji} ${job.recipe.titel}` : job.title || "Ohne Titel")}</h2>
    <p class="muted small">
      <a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.url)}</a>
    </p>
    ${job.error ? `<p class="error">${escapeHtml(job.error)}</p>` : ""}
    ${!job.recipe && !job.error ? `<p class="muted">${escapeHtml(job.step || "Läuft …")}</p>` : ""}
  `;
  box.appendChild(head);

  if (job.recipe) box.appendChild(buildEditor(job));

  const actions = document.createElement("div");
  actions.className = "actions";

  const actionMsg = document.createElement("p");
  actionMsg.className = "msg err";
  actionMsg.hidden = true;

  /** Knopf, der bei einem Fehler nicht stumm stehenbleibt, sondern ihn anzeigt. */
  function wire(btn, run) {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      actionMsg.hidden = true;
      try {
        await run();
      } catch (err) {
        actionMsg.hidden = false;
        actionMsg.textContent = err.message;
        btn.disabled = false;
      }
    });
  }

  if (job.status === "failed") {
    const retry = document.createElement("button");
    retry.textContent = "Erneut versuchen";
    retry.className = "primary";
    retry.style.marginTop = "0";
    wire(retry, async () => {
      await api(`/api/jobs/${id}/retry`, { method: "POST" });
      closeDetail();
      refresh();
    });
    actions.appendChild(retry);
  }

  const del = document.createElement("button");
  del.textContent = "Aus Verlauf löschen";
  del.className = "danger";
  wire(del, async () => {
    if (!confirm("Diesen Eintrag aus dem Verlauf löschen? Die Notion-Seite bleibt bestehen.")) {
      del.disabled = false;
      return;
    }
    await api(`/api/jobs/${id}`, { method: "DELETE" });
    closeDetail();
    refresh();
  });
  actions.appendChild(del);
  box.appendChild(actions);
  box.appendChild(actionMsg);

  if (job.transcript) {
    const details = document.createElement("details");
    details.className = "transcript";
    const label = job.textSource ? `Ausgangstext (${job.textSource})` : "Ausgangstext";
    details.innerHTML = `<summary>${escapeHtml(label)}</summary><pre>${escapeHtml(job.transcript)}</pre>`;
    box.appendChild(details);
  }

  $("overlay").hidden = false;
  document.body.style.overflow = "hidden";
}

/** Editierbares Rezept-Formular. Speichern schreibt die Notion-Seite neu. */
function buildEditor(job) {
  const r = job.recipe;
  const wrap = document.createElement("div");

  const titleRow = document.createElement("div");
  titleRow.className = "field row";
  const emojiEl = input(r.emoji);
  emojiEl.style.flex = "0 0 62px";
  emojiEl.style.textAlign = "center";
  const titelEl = input(r.titel);
  titleRow.append(emojiEl, titelEl);
  wrap.append(sectionLabel("Titel"), titleRow);

  const zeitEl = input(r.zeit_text, "ca. 30 Minuten");
  wrap.append(sectionLabel("Zubereitungszeit"), field(zeitEl));

  const tagsEl = input((r.tags || []).join(", "), "Schnell, Vegetarisch");
  wrap.append(sectionLabel("Tags (mit Komma getrennt)"), field(tagsEl));

  wrap.append(sectionLabel("Zutaten"));
  const ingBox = document.createElement("div");
  const groupEls = [];
  for (const gruppe of r.zutaten || []) {
    const g = document.createElement("div");
    g.className = "ing-group";
    const name = input(gruppe.gruppe);
    name.style.fontWeight = "600";
    name.style.marginBottom = "6px";
    g.appendChild(name);

    const rows = [];
    for (const e of gruppe.eintraege) {
      const row = document.createElement("div");
      row.className = "ing";
      const menge = input(e.menge || "", "Menge");
      const zutat = input(e.zutat, "Zutat");
      row.append(menge, zutat);
      g.appendChild(row);
      rows.push({ menge, zutat });
    }
    ingBox.appendChild(g);
    groupEls.push({ name, rows });
  }
  wrap.appendChild(ingBox);

  wrap.append(sectionLabel("Zubereitung"));
  const stepEls = [];
  for (const [i, schritt] of (r.schritte || []).entries()) {
    const row = document.createElement("div");
    row.className = "step";
    const no = document.createElement("div");
    no.className = "step-no";
    no.textContent = `${i + 1}.`;
    const ta = textarea(schritt);
    row.append(no, ta);
    wrap.appendChild(row);
    stepEls.push(ta);
  }

  const tippEl = textarea(r.pro_tipp || "", 3);
  wrap.append(sectionLabel("Pro-Tipp"), field(tippEl));

  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = job.notionPageUrl ? "Korrigieren & Notion aktualisieren" : "Nach Notion schreiben";
  const msg = document.createElement("p");
  msg.className = "msg";
  msg.hidden = true;

  save.addEventListener("click", async () => {
    save.disabled = true;
    msg.hidden = false;
    msg.className = "msg";
    msg.textContent = "Wird gespeichert …";

    const payload = {
      emoji: emojiEl.value.trim() || "🍽️",
      titel: titelEl.value.trim(),
      tags: tagsEl.value.split(",").map((t) => t.trim()).filter(Boolean),
      zeit_text: zeitEl.value.trim(),
      zeit_minuten: r.zeit_minuten ?? undefined,
      zutaten: groupEls
        .map((g) => ({
          gruppe: g.name.value.trim() || "Zutaten",
          eintraege: g.rows
            .filter((row) => row.zutat.value.trim())
            .map((row) => ({
              menge: row.menge.value.trim() || undefined,
              zutat: row.zutat.value.trim(),
            })),
        }))
        .filter((g) => g.eintraege.length),
      schritte: stepEls.map((t) => t.value.trim()).filter(Boolean),
      pro_tipp: tippEl.value.trim(),
      portionen: r.portionen ?? undefined,
      kueche: r.kueche ?? undefined,
    };

    try {
      const res = await api(`/api/jobs/${job.id}/recipe`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      msg.className = "msg ok";
      msg.textContent = res.updated ? "Notion-Seite aktualisiert." : "Nach Notion geschrieben.";
      if (res.pageUrl) {
        $("notionLink").href = res.pageUrl;
        $("notionLink").hidden = false;
      }
      refresh();
    } catch (err) {
      msg.className = "msg err";
      msg.textContent = err.message;
    } finally {
      save.disabled = false;
    }
  });

  wrap.append(save, msg);
  return wrap;
}

function sectionLabel(text) {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

function field(el) {
  const d = document.createElement("div");
  d.className = "field";
  d.appendChild(el);
  return d;
}

function closeDetail() {
  $("overlay").hidden = true;
  document.body.style.overflow = "";
  openJobId = null;
}

$("closeDetail").addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("overlay").hidden) closeDetail();
});

/* ── Start ────────────────────────────────────────────────────────────────── */

/* Aus dem Kurzbefehl heraus kommt der Link als ?url=… herein.
   Ist das Token schon hinterlegt, wird er sofort abgeschickt - dann besteht der
   Kurzbefehl aus einer einzigen Aktion und es gibt nichts falsch zu machen. */
const params = new URLSearchParams(location.search);
const shared = params.get("url");
if (shared) {
  $("urlInput").value = shared;
  // Parameter aus der Adresszeile nehmen, sonst wird beim Neuladen erneut gesendet.
  history.replaceState(null, "", location.pathname);
}

function start() {
  showApp();
  if (shared) submitUrl(true);
}

if (token) {
  api("/api/jobs?limit=1").then(start).catch(() => {});
} else {
  showSetup(
    shared ? "Token eingeben — danach wird der geteilte Link direkt erfasst." : "",
  );
}
