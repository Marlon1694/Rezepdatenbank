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
  $("photoCard").hidden = true;
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
  checkPhotoSupport();
}

/* Fotos brauchen Gemini. Fehlt der Key, bleibt die Karte weg - besser als ein
   Fehler, der erst nach dem Hochladen kommt. */
async function checkPhotoSupport() {
  try {
    const res = await fetch("/api/health");
    const health = await res.json();
    $("photoCard").hidden = !health.fotos;
    if (health.maxPhotos) maxPhotos = health.maxPhotos;
  } catch {
    $("photoCard").hidden = true;
  }
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

/* ── Fotos ────────────────────────────────────────────────────────────────── */

/* Die lange Kante, auf die verkleinert wird. Gemini braucht keine 12 Megapixel,
   um eine Buchseite zu lesen - und über die VPN zählt jedes Megabyte. Ein
   iPhone-Foto schrumpft damit von rund 3 MB auf gut 300 kB. */
const MAX_EDGE = 1800;
const JPEG_QUALITY = 0.85;

let photos = [];      // { blob, url, name }
let maxPhotos = 6;

/* Verkleinert ein Bild im Browser. Schlägt das fehl - etwa weil iOS ein HEIC
   nicht in den Canvas lässt - geht die Originaldatei raus. Lieber ein großer
   Upload als gar keiner. */
async function shrink(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const faktor = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));

    if (faktor === 1 && file.size < 1_500_000) {
      bitmap.close?.();
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * faktor);
    canvas.height = Math.round(bitmap.height * faktor);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", JPEG_QUALITY));
    if (!blob) return file;
    // Nur übernehmen, wenn es wirklich kleiner wurde.
    return blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

function renderThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  box.hidden = photos.length === 0;
  $("photoSubmit").hidden = photos.length === 0;
  // Bewusst ohne Zahlwort fürs Ergebnis: Aus acht Bildern können acht Rezepte
  // werden, aus zweien auch nur eines. Was es wird, weiß erst die Leseschicht.
  $("photoSubmit").textContent =
    photos.length > 1 ? `${photos.length} Fotos auswerten` : "Foto auswerten";

  photos.forEach((foto, i) => {
    const el = document.createElement("div");
    el.className = "thumb";

    const img = document.createElement("img");
    img.src = foto.url;
    img.alt = `Foto ${i + 1}`;
    el.appendChild(img);

    // Bei mehrseitigen Rezepten zählt die Reihenfolge - also sichtbar machen.
    const nr = document.createElement("span");
    nr.className = "thumb-nr";
    nr.textContent = String(i + 1);
    el.appendChild(nr);

    const del = document.createElement("button");
    del.className = "thumb-del";
    del.type = "button";
    del.title = "Entfernen";
    del.setAttribute("aria-label", `Foto ${i + 1} entfernen`);
    del.textContent = "✕";
    del.addEventListener("click", () => {
      URL.revokeObjectURL(foto.url);
      photos.splice(i, 1);
      renderThumbs();
    });
    el.appendChild(del);

    box.appendChild(el);
  });
}

async function addFiles(fileList) {
  const msg = $("photoMsg");
  const dateien = Array.from(fileList || []);
  if (!dateien.length) return;

  const platz = maxPhotos - photos.length;
  if (platz <= 0) {
    msg.hidden = false;
    msg.className = "msg err";
    msg.textContent = `Mehr als ${maxPhotos} Fotos nimmt der Server nicht an.`;
    return;
  }

  msg.hidden = false;
  msg.className = "msg";
  msg.textContent = "Bilder werden vorbereitet …";

  for (const file of dateien.slice(0, platz)) {
    const blob = await shrink(file);
    photos.push({ blob, url: URL.createObjectURL(blob), name: file.name || "foto.jpg" });
  }

  if (dateien.length > platz) {
    msg.className = "msg err";
    msg.textContent = `Nur die ersten ${platz} Bilder übernommen (Grenze: ${maxPhotos}).`;
  } else {
    msg.hidden = true;
  }
  renderThumbs();
}

$("cameraBtn").addEventListener("click", () => $("cameraInput").click());
$("pickBtn").addEventListener("click", () => $("pickInput").click());

for (const id of ["cameraInput", "pickInput"]) {
  $(id).addEventListener("change", async (e) => {
    await addFiles(e.target.files);
    // Zurücksetzen, sonst löst dasselbe Bild beim zweiten Mal kein Ereignis aus.
    e.target.value = "";
  });
}

$("photoSubmit").addEventListener("click", async () => {
  if (!photos.length) return;
  const msg = $("photoMsg");
  const btn = $("photoSubmit");

  btn.disabled = true;
  msg.hidden = false;
  msg.className = "msg";
  msg.textContent = "Fotos werden hochgeladen …";

  const form = new FormData();
  photos.forEach((foto, i) => {
    // Der Server vergibt den Dateinamen selbst und nutzt nur die Endung - der
    // Name hier dient bloß dazu, dass eine mitkommt.
    const endung = /\.(jpe?g|png|webp|heic|heif|gif)$/i.test(foto.name) ? "" : ".jpg";
    form.append("foto", foto.blob, `${i + 1}-${foto.name}${endung}`);
  });

  try {
    const res = await fetch("/api/jobs/foto", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    photos.forEach((f) => URL.revokeObjectURL(f.url));
    photos = [];
    renderThumbs();
    msg.className = "msg ok";
    msg.textContent = `${data.photos} Foto(s) eingereiht. Das Lesen dauert einen Moment.`;
    refresh();
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
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

    const istFoto = job.kind === "foto";
    // Ein Stapel ist der Sammeleintrag, aus dem die einzelnen Rezepte
    // entstanden sind - er hat selbst kein Rezept.
    const istStapel = job.textSource === "Stapel";
    const title =
      job.recipeTitle || job.title || (istFoto ? `📷 ${job.photos.length} Foto(s)` : job.url);
    const meta = [];
    if (istStapel) meta.push("📚 Stapel");
    else if (job.parentId) meta.push("aus Stapel");
    else if (job.platform) meta.push(job.platform);
    else if (istFoto) meta.push("Foto");
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

/* Bilder hinter dem Token: <img src> schickt keine Authorization-Kopfzeile,
   deshalb selbst holen und als Objekt-URL einhängen.

   Der umschließende Link bekommt dieselbe Objekt-URL. Zeigte er weiter auf
   /api/..., käme beim Antippen nur ein 401 als JSON — ein toter Link. */
async function loadProtectedImage(img, anchor, url) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const blob = await res.blob();
    const objektUrl = URL.createObjectURL(blob);
    img.src = objektUrl;
    if (anchor) anchor.href = objektUrl;
    // Nicht nach dem Laden freigeben: Die Adresse wird noch gebraucht, solange
    // die Ansicht offen ist. closeDetail() räumt auf.
    objektUrls.push(objektUrl);
  } catch {
    /* Ohne Vorschau ist die Ansicht immer noch brauchbar. */
  }
}

/* Objekt-URLs der gerade offenen Detailansicht. */
let objektUrls = [];

function releaseObjektUrls() {
  objektUrls.forEach((u) => URL.revokeObjectURL(u));
  objektUrls = [];
}

async function openDetail(id) {
  openJobId = id;
  const job = await api(`/api/jobs/${id}`);
  const box = $("detail");
  // Beim Wechsel auf einen anderen Job die Bilder des vorigen freigeben.
  releaseObjektUrls();
  box.innerHTML = "";

  const link = $("notionLink");
  link.hidden = !job.notionPageUrl;
  if (job.notionPageUrl) link.href = job.notionPageUrl;

  const head = document.createElement("div");
  // Ein Foto hat keine Adresse - dort wäre der Link nur ein toter Platzhalter.
  const herkunft =
    job.kind === "foto"
      ? `<p class="muted small">📷 Eigenes Foto${
          job.photos.length > 1 ? ` · ${job.photos.length} Bilder` : ""
        }${job.parentId ? " · aus einem Stapel" : ""}</p>`
      : `<p class="muted small">
           <a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.url)}</a>
         </p>`;
  head.innerHTML = `
    <h2>${escapeHtml(job.recipe ? `${job.recipe.emoji} ${job.recipe.titel}` : job.title || "Ohne Titel")}</h2>
    ${herkunft}
    ${job.error ? `<p class="error">${escapeHtml(job.error)}</p>` : ""}
    ${!job.recipe && !job.error ? `<p class="muted">${escapeHtml(job.step || "Läuft …")}</p>` : ""}
  `;
  box.appendChild(head);

  if (job.textSource === "Stapel") {
    const hinweis = document.createElement("p");
    hinweis.className = "muted";
    hinweis.textContent =
      "Aus diesen Fotos sind mehrere eigenständige Rezepte entstanden. " +
      "Du findest sie im Verlauf als einzelne Einträge — jedes mit eigener " +
      "Notion-Seite und eigener Korrekturansicht.";
    box.appendChild(hinweis);
  }

  if (job.kind === "foto" && job.photosDeleted) {
    const hinweis = document.createElement("p");
    hinweis.className = "muted small";
    hinweis.textContent =
      "Die Fotos wurden gelöscht, nachdem das Rezept in Notion stand. " +
      "Das Rezept unten kannst du weiterhin bearbeiten und erneut speichern.";
    box.appendChild(hinweis);
  }

  // Die Vorlage mit anzeigen: Stimmt etwas am Rezept nicht, ist die erste
  // Frage immer, ob das Bild überhaupt lesbar war.
  if (job.kind === "foto" && job.photos.length && !job.photosDeleted) {
    const galerie = document.createElement("div");
    galerie.className = "thumbs";
    job.photos.forEach((_, i) => {
      const a = document.createElement("a");
      a.className = "thumb";
      a.href = `/api/jobs/${job.id}/fotos/${i}`;
      a.target = "_blank";
      a.rel = "noopener";
      const img = document.createElement("img");
      img.alt = `Foto ${i + 1}`;
      loadProtectedImage(img, a, a.href);
      a.appendChild(img);
      galerie.appendChild(a);
    });
    box.appendChild(galerie);
  }

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

  // Ohne Bilder gibt es nichts zu wiederholen - der Server wiese den Versuch
  // ohnehin ab, und ein Knopf, der nur eine Fehlermeldung produziert, hilft
  // niemandem.
  if (job.status === "failed" && !(job.kind === "foto" && job.photosDeleted)) {
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
    const frage =
      job.textSource === "Stapel"
        ? "Diesen Stapel und die daraus entstandenen Rezept-Einträge aus dem Verlauf " +
          "löschen? Die Notion-Seiten bleiben bestehen."
        : "Diesen Eintrag aus dem Verlauf löschen? Die Notion-Seite bleibt bestehen.";
    if (!confirm(frage)) {
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
  releaseObjektUrls();
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
/* Alles nach "?url=" nehmen, nicht nur bis zum ersten "&".
   Der Kurzbefehl haengt die geteilte Adresse unveraendert an. Enthaelt sie
   selbst Parameter (TikTok: "?is_from_webapp=1&sender_device=pc"), wuerde
   URLSearchParams beim "&" abschneiden und den Rest als eigene Parameter lesen. */
function sharedUrlFromQuery(search) {
  const marker = search.indexOf("url=");
  if (marker === -1) return "";
  const raw = search.slice(marker + 4);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    // Ein einzelnes "%" im Link laesst decodeURIComponent scheitern - dann
    // eben unveraendert, das ist immer noch besser als gar nichts.
    return raw;
  }
}

const shared = sharedUrlFromQuery(location.search);
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
