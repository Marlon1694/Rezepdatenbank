/* Küche: Wochenplan, Einkauf, Was kochen? — alles über Mealie.
   Nutzt aus app.js: $, api, escapeHtml, closeDetail. */

/* ── Hilfen ───────────────────────────────────────────────────────────────── */

const pad2 = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/* Ab Freitag plant man meist schon die nächste Woche: dann der kommende Montag,
   sonst heute. */
function defaultStart() {
  const d = new Date();
  const tag = d.getDay(); // 0 = Sonntag
  if (tag === 0 || tag >= 5) d.setDate(d.getDate() + ((8 - tag) % 7 || 7));
  return isoDate(d);
}

function kurzDatum(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" });
}

function el(tag, attrs = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kinder) if (k) e.append(k);
  return e;
}

function feld(label, input) {
  return el("label", { class: "k-field" }, el("span", { text: label }), input);
}

function meldung() {
  const m = el("p", { class: "msg" });
  m.hidden = true;
  m.zeige = (text, art = "") => {
    m.hidden = !text;
    m.className = `msg ${art}`;
    m.textContent = text;
  };
  return m;
}

/* Gemeinsamer Zeitraum für Wochenplan und Einkauf: Wer gerade eine Woche
   geplant hat, will genau diese Woche einkaufen. */
const zeitraum = { start: defaultStart(), days: 7, type: "dinner" };

function zeitraumFelder() {
  const start = el("input", { type: "date", value: zeitraum.start });
  const days = el("select");
  for (const n of [3, 4, 5, 6, 7, 10, 14]) {
    const o = el("option", { value: String(n), text: `${n} Tage` });
    if (n === zeitraum.days) o.selected = true;
    days.append(o);
  }
  start.addEventListener("change", () => (zeitraum.start = start.value || defaultStart()));
  days.addEventListener("change", () => (zeitraum.days = Number(days.value)));
  return el("div", { class: "k-row" }, feld("Ab", start), feld("Zeitraum", days));
}

function openSheet(titel) {
  const box = $("detail");
  box.innerHTML = "";
  $("notionLink").hidden = true;
  $("mealieLink").hidden = true;
  box.append(el("h2", { text: titel }));
  $("overlay").hidden = false;
  document.body.style.overflow = "hidden";
  return box;
}

/* ── Wochenplan ───────────────────────────────────────────────────────────── */

const MAHLZEITEN = [
  ["dinner", "Abendessen"],
  ["lunch", "Mittagessen"],
  ["breakfast", "Frühstück"],
];

function openWochenplan() {
  const box = openSheet("📅 Wochenplan");
  box.append(
    el("p", {
      class: "muted small",
      text:
        "Die KI wählt aus deinen Mealie-Rezepten und meidet, was du in letzter Zeit " +
        "schon hattest. Erst nach „Übernehmen“ landet etwas im Plan.",
    }),
  );

  const typ = el("select");
  for (const [v, t] of MAHLZEITEN) {
    const o = el("option", { value: v, text: t });
    if (v === zeitraum.type) o.selected = true;
    typ.append(o);
  }
  typ.addEventListener("change", () => (zeitraum.type = typ.value));
  const wuensche = el("textarea", {
    rows: "2",
    placeholder: "Wünsche, z.B. freitags Fisch, einmal vegetarisch, Mittwoch wenig Zeit",
  });

  box.append(zeitraumFelder(), feld("Mahlzeit", typ), feld("Wünsche (optional)", wuensche));

  const los = el("button", { class: "primary", text: "Vorschlag erstellen" });
  const msg = meldung();
  const ergebnis = el("div", { class: "k-result" });
  box.append(los, msg, ergebnis);

  los.addEventListener("click", async () => {
    los.disabled = true;
    ergebnis.innerHTML = "";
    msg.zeige("Die KI plant … (ein paar Sekunden)");
    try {
      const plan = await api("/api/kitchen/plan/suggest", {
        method: "POST",
        body: JSON.stringify({ ...zeitraum, wishes: wuensche.value }),
      });
      msg.zeige("");
      zeigePlan(plan, ergebnis);
    } catch (err) {
      msg.zeige(err.message, "err");
    } finally {
      los.disabled = false;
    }
  });
}

function zeigePlan(plan, box) {
  if (plan.fallback) box.append(el("p", { class: "error", text: plan.fallback }));
  if (plan.skipped?.length) {
    box.append(
      el("p", {
        class: "muted small",
        text: `Schon geplant und unverändert: ${plan.skipped.map(kurzDatum).join(", ")}`,
      }),
    );
  }
  if (!plan.days.length) {
    box.append(el("p", { class: "muted", text: "Im Zeitraum ist schon alles geplant." }));
    return;
  }

  const tage = plan.days.map((d) => ({ ...d }));
  const liste = el("div", { class: "k-list" });
  box.append(liste);

  const render = () => {
    liste.innerHTML = "";
    for (const [i, t] of tage.entries()) {
      const tauschen = el("button", { class: "ghost small-btn", text: "Tauschen" });
      const raus = el("button", { class: "ghost small-btn", title: "Tag freilassen", text: "✕" });
      tauschen.addEventListener("click", async () => {
        tauschen.disabled = true;
        try {
          const alt = await api("/api/kitchen/plan/alternative", {
            method: "POST",
            body: JSON.stringify({ ...zeitraum, exclude: tage.map((x) => x.recipeId) }),
          });
          tage[i] = { ...alt, date: t.date };
          render();
        } catch (err) {
          alert(err.message);
          tauschen.disabled = false;
        }
      });
      raus.addEventListener("click", () => {
        tage.splice(i, 1);
        render();
      });

      liste.append(
        el(
          "div",
          { class: "k-day" },
          el("div", { class: "k-date", text: kurzDatum(t.date) }),
          el(
            "div",
            { class: "k-main" },
            el("a", { href: t.url, target: "_blank", rel: "noopener", text: t.name }),
            el("div", { class: "muted small", text: t.reason || "" }),
          ),
          el("div", { class: "k-actions" }, tauschen, raus),
        ),
      );
    }
    uebernehmen.hidden = !tage.length;
  };

  const uebernehmen = el("button", { class: "primary", text: "In Mealie übernehmen" });
  const msg = meldung();
  box.append(uebernehmen, msg);
  render();

  uebernehmen.addEventListener("click", async () => {
    uebernehmen.disabled = true;
    try {
      const r = await api("/api/kitchen/plan/apply", {
        method: "POST",
        body: JSON.stringify({
          ...zeitraum,
          entries: tage.map((t) => ({ date: t.date, recipeId: t.recipeId })),
        }),
      });
      msg.zeige(`${r.added} Tag(e) in den Mealie-Wochenplan übernommen.`, "ok");
      uebernehmen.hidden = true;
      box.append(el("button", { class: "primary", text: "Weiter zum Einkauf →", onclick: openEinkauf }));
    } catch (err) {
      msg.zeige(err.message, "err");
      uebernehmen.disabled = false;
    }
  });
}

/* ── Einkauf ──────────────────────────────────────────────────────────────── */

function openEinkauf() {
  const box = openSheet("🛒 Einkauf freigeben");
  box.append(
    el("p", {
      class: "muted small",
      text:
        "Die Zutaten aller Gerichte im Wochenplan, zusammengefasst. Vorrätiges ist " +
        "abgewählt. Erst nach „Freigeben“ geht etwas in die Einkaufsliste – und von " +
        "dort nach Bring!.",
    }),
  );
  const laden = el("button", { class: "primary", text: "Zutaten laden" });
  const msg = meldung();
  const ergebnis = el("div", { class: "k-result" });
  box.append(zeitraumFelder(), laden, msg, ergebnis);

  const holen = async () => {
    laden.disabled = true;
    ergebnis.innerHTML = "";
    msg.zeige("Wird geladen …");
    try {
      const q = new URLSearchParams({ start: zeitraum.start, days: String(zeitraum.days) });
      const data = await api(`/api/kitchen/shopping?${q}`);
      msg.zeige("");
      zeigeEinkauf(data, ergebnis);
    } catch (err) {
      msg.zeige(err.message, "err");
    } finally {
      laden.disabled = false;
    }
  };
  laden.addEventListener("click", holen);
  holen();
}

function zeigeEinkauf(data, box) {
  if (!data.recipes.length) {
    box.append(
      el("p", {
        class: "muted",
        text: "Im Zeitraum steht nichts im Wochenplan. Plane zuerst – oder wähle einen anderen Zeitraum.",
      }),
      el("button", { class: "ghost", text: "📅 Zum Wochenplan", onclick: openWochenplan }),
    );
    return;
  }

  box.append(
    el(
      "div",
      { class: "k-recipes muted small" },
      ...data.recipes.map((r) =>
        el(
          "div",
          {},
          `${kurzDatum(r.date)} · `,
          el("a", { href: r.url, target: "_blank", rel: "noopener", text: r.name }),
          r.scale !== 1 ? ` (×${String(r.scale).replace(".", ",")})` : "",
        ),
      ),
    ),
  );

  if (data.approvals?.length) {
    const a = data.approvals[0];
    const wann = new Date(a.createdAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
    box.append(
      el("p", {
        class: "error",
        text: `Achtung: Für diesen Zeitraum wurden am ${wann} schon ${a.lines} Zutaten freigegeben. Ein zweites Freigeben setzt sie erneut auf die Liste.`,
      }),
    );
  }

  const boxen = [];
  const liste = el("div", { class: "k-shop" });
  let vorratTitel = false;
  for (const line of data.lines) {
    if (line.onHand && !vorratTitel) {
      liste.append(el("div", { class: "k-sub", text: "Vermutlich vorrätig" }));
      vorratTitel = true;
    }
    const cb = el("input", { type: "checkbox" });
    cb.checked = !line.onHand;
    cb.addEventListener("change", aktualisieren);
    boxen.push({ cb, key: line.key });
    liste.append(
      el(
        "label",
        { class: "k-item" },
        cb,
        el(
          "span",
          {},
          el("span", { text: line.label }),
          line.recipes.length > 1
            ? el("span", { class: "muted small", text: ` · ${line.recipes.join(", ")}` })
            : "",
        ),
      ),
    );
  }

  const frei = el("button", { class: "primary" });
  const msg = meldung();
  box.append(liste, frei, msg);

  function aktualisieren() {
    const n = boxen.filter((b) => b.cb.checked).length;
    frei.textContent = `${n} Zutat${n === 1 ? "" : "en"} freigeben → „${data.list}“`;
    frei.disabled = n === 0;
  }
  aktualisieren();

  frei.addEventListener("click", async () => {
    frei.disabled = true;
    msg.zeige("Wird freigegeben …");
    try {
      const r = await api("/api/kitchen/shopping", {
        method: "POST",
        body: JSON.stringify({
          start: zeitraum.start,
          days: zeitraum.days,
          keys: boxen.filter((b) => b.cb.checked).map((b) => b.key),
        }),
      });
      msg.zeige(
        `✓ ${r.lines} Zutaten aus ${r.recipes} Gericht(en) stehen in „${r.list}“. ` +
          "Atelier schickt sie innerhalb weniger Minuten nach Bring!.",
        "ok",
      );
      frei.hidden = true;
    } catch (err) {
      msg.zeige(err.message, "err");
      frei.disabled = false;
    }
  });
}

/* ── Was kochen? ──────────────────────────────────────────────────────────── */

function openKochen() {
  const box = openSheet("🥕 Was kann ich kochen?");
  const have = el("textarea", { rows: "3", placeholder: "z.B. Hähnchen, Paprika, Reis, Sahne" });
  const missing = el("select");
  for (const [v, t] of [
    ["0", "nichts fehlt"],
    ["1", "höchstens 1 Zutat fehlt"],
    ["2", "höchstens 2 fehlen"],
    ["3", "höchstens 3 fehlen"],
  ]) {
    const o = el("option", { value: v, text: t });
    if (v === "2") o.selected = true;
    missing.append(o);
  }
  const los = el("button", { class: "primary", text: "Rezepte finden" });
  const msg = meldung();
  const ergebnis = el("div", { class: "k-list" });
  box.append(
    el("p", {
      class: "muted small",
      text: "Sucht in deinen Mealie-Rezepten. Was in Mealie als vorrätig markiert ist, zählt automatisch mit.",
    }),
    feld("Was ist da?", have),
    feld("Darf noch etwas fehlen?", missing),
    los,
    msg,
    ergebnis,
  );

  los.addEventListener("click", async () => {
    if (!have.value.trim()) return;
    los.disabled = true;
    ergebnis.innerHTML = "";
    msg.zeige("Wird gesucht …");
    try {
      const q = new URLSearchParams({ have: have.value, missing: missing.value });
      const r = await api(`/api/kitchen/cook?${q}`);
      const hinweis = r.unknown.length
        ? `Nicht als Lebensmittel in Mealie gefunden: ${r.unknown.join(", ")}. `
        : "";
      msg.zeige(r.items.length ? hinweis : `${hinweis}Keine passenden Rezepte.`, r.unknown.length ? "err" : "");
      for (const i of r.items) {
        ergebnis.append(
          el(
            "div",
            { class: "k-day" },
            el(
              "div",
              { class: "k-main" },
              el("a", { href: i.url, target: "_blank", rel: "noopener", text: i.name }),
              el("div", {
                class: "muted small",
                text: i.missing.length ? `Fehlt: ${i.missing.join(", ")}` : "Alles da ✓",
              }),
            ),
          ),
        );
      }
    } catch (err) {
      msg.zeige(err.message, "err");
    } finally {
      los.disabled = false;
    }
  });
}

/* ── Einstieg ─────────────────────────────────────────────────────────────── */

const VIEWS = { wochenplan: openWochenplan, einkauf: openEinkauf, kochen: openKochen };

for (const b of document.querySelectorAll("#kitchenCard [data-view]")) {
  b.addEventListener("click", () => {
    // Im Adressfeld festhalten - so lässt sich jede Ansicht direkt verlinken,
    // etwa aus der Sonntags-Nachricht von Home Assistant.
    history.replaceState(null, "", `#${b.dataset.view}`);
    VIEWS[b.dataset.view]();
  });
}

let kitchenGestartet = false;
function kitchenInit(health) {
  const an = (health.targets || []).includes("mealie");
  $("kitchenCard").hidden = !an;
  if (!an || kitchenGestartet) return;
  kitchenGestartet = true;
  // Mit #einkauf, #wochenplan oder #kochen in der Adresse direkt dorthin.
  const view = VIEWS[location.hash.slice(1)];
  if (view) view();
}

// Auch wenn sich nur der Teil hinter # ändert - dann lädt der Browser die
// Seite nicht neu, und ohne das bliebe ein Link wie …/#einkauf wirkungslos,
// solange die App schon offen ist.
window.addEventListener("hashchange", () => {
  if (!kitchenGestartet) return;
  const view = VIEWS[location.hash.slice(1)];
  if (view) view();
});
