/* Rezept diktieren — als Text (Tastatur-Mikrofon), als Sprachmemo oder als
   Aufnahme direkt in der App. Nutzt aus app.js: $, api, token, refresh. */

function diktatMeldung(text, art = "") {
  const m = $("diktatMsg");
  m.hidden = !text;
  m.className = `msg ${art}`;
  m.textContent = text;
}

function diktatFertig() {
  diktatMeldung("✓ Eingereiht. Das Rezept erscheint gleich im Verlauf.", "ok");
  refresh();
}

/* ── Text ─────────────────────────────────────────────────────────────────── */

$("diktatSubmit").addEventListener("click", async () => {
  const text = $("diktatText").value.trim();
  if (!text) {
    $("diktatText").focus();
    return;
  }
  $("diktatSubmit").disabled = true;
  diktatMeldung("Wird eingereiht …");
  try {
    await api("/api/jobs/diktat", { method: "POST", body: JSON.stringify({ text }) });
    $("diktatText").value = "";
    diktatFertig();
  } catch (err) {
    diktatMeldung(err.message, "err");
  } finally {
    $("diktatSubmit").disabled = false;
  }
});

/* ── Audio hochladen ──────────────────────────────────────────────────────── */

async function diktatHochladen(blob, name) {
  diktatMeldung("Aufnahme wird hochgeladen …");
  const form = new FormData();
  form.append("audio", blob, name);
  const res = await fetch("/api/jobs/diktat/audio", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  diktatFertig();
}

$("diktatUploadBtn").addEventListener("click", () => $("diktatFile").click());
$("diktatFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    await diktatHochladen(file, file.name || "sprachmemo.m4a");
  } catch (err) {
    diktatMeldung(err.message, "err");
  }
});

/* ── Aufnahme in der App ──────────────────────────────────────────────────── */

/* Browser geben das Mikrofon nur in einem sicheren Kontext frei: über HTTPS
   oder auf localhost. Über http://<server-ip> ginge der Knopf ins Leere - dann
   blenden wir ihn gar nicht erst ein. Das Tastatur-Mikrofon funktioniert
   davon unabhängig, es gehört zu iOS, nicht zur Webseite. */
const kannAufnehmen =
  window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && "MediaRecorder" in window;
$("diktatRecord").hidden = !kannAufnehmen;

let aufnahme = null; // { recorder, chunks, stream, start, timer }

function aufnahmeEndung(mime) {
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

$("diktatRecord").addEventListener("click", async () => {
  const knopf = $("diktatRecord");

  if (aufnahme) {
    aufnahme.recorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data));
    recorder.addEventListener("stop", async () => {
      clearInterval(aufnahme.timer);
      stream.getTracks().forEach((t) => t.stop());
      const mime = recorder.mimeType || "audio/webm";
      aufnahme = null;
      knopf.textContent = "🎙️ Aufnehmen";
      knopf.classList.remove("recording");
      try {
        await diktatHochladen(new Blob(chunks, { type: mime }), `diktat.${aufnahmeEndung(mime)}`);
      } catch (err) {
        diktatMeldung(err.message, "err");
      }
    });

    recorder.start();
    const start = Date.now();
    aufnahme = {
      recorder,
      timer: setInterval(() => {
        const s = Math.floor((Date.now() - start) / 1000);
        knopf.textContent = `⏹ Stopp (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")})`;
      }, 500),
    };
    knopf.textContent = "⏹ Stopp (0:00)";
    knopf.classList.add("recording");
    diktatMeldung("Aufnahme läuft – sprich dein Rezept oder deinen Wunsch.");
  } catch (err) {
    diktatMeldung(
      err?.name === "NotAllowedError"
        ? "Kein Zugriff aufs Mikrofon. In den Einstellungen des Browsers erlauben."
        : `Aufnahme nicht möglich: ${err?.message || err}`,
      "err",
    );
  }
});
