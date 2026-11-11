/**
 * Wochenplan-Vorschlag - die Teile ohne Netz.
 *
 * Die KI waehlt aus DEINEN Rezepten aus. Was sie zurueckgibt, wird hier
 * geprueft und notfalls ersetzt: Ein Modell, das eine ID erfindet, dasselbe
 * Gericht zweimal in eine Woche setzt oder einen Tag auslaesst, darf den Plan
 * nicht kaputt machen. Lieber ein lokal gewaehltes Gericht als ein Loch.
 */

export interface RecipeOption {
  id: string;
  slug: string;
  name: string;
  tags: string[];
  category?: string;
  totalTime?: string | null;
  rating?: number | null;
}

export interface HistoryEntry {
  date: string;
  recipeId: string | null;
}

export interface Recency {
  /** Wann zuletzt im Plan, YYYY-MM-DD. */
  last?: string;
  count: number;
}

export interface ProposalDay {
  date: string;
  recipeId: string;
  /** Kurze Begruendung - von der KI, oder "Lange nicht gegessen" beim Ersatz. */
  reason: string;
  /** true, wenn die KI hier nichts Brauchbares geliefert hat. */
  substituted?: boolean;
}

/** Datum als YYYY-MM-DD plus n Tage - in UTC gerechnet, damit Sommerzeit nichts verschiebt. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

const WOCHENTAG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
export function weekday(date: string): string {
  return WOCHENTAG[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? "";
}

/** Die Tage im Zeitraum, an denen fuer diese Mahlzeit noch nichts geplant ist. */
export function freeSlots(start: string, days: number, belegt: Set<string>): string[] {
  const result: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    if (!belegt.has(d)) result.push(d);
  }
  return result;
}

export function recency(history: HistoryEntry[]): Map<string, Recency> {
  const map = new Map<string, Recency>();
  for (const h of history) {
    if (!h.recipeId) continue;
    const r = map.get(h.recipeId) ?? { count: 0 };
    r.count++;
    if (!r.last || h.date > r.last) r.last = h.date;
    map.set(h.recipeId, r);
  }
  return map;
}

/**
 * Ein Ersatzgericht: das, was am laengsten nicht auf dem Tisch stand.
 * Nie gegessenes zuerst - unter gleich alten per Zufall, damit "Tauschen"
 * nicht immer dasselbe liefert.
 */
export function pickAlternative(
  recipes: RecipeOption[],
  exclude: Set<string>,
  rec: Map<string, Recency>,
  random: () => number = Math.random,
): RecipeOption | undefined {
  const frei = recipes.filter((r) => !exclude.has(r.id));
  if (!frei.length) return undefined;
  const rang = (r: RecipeOption) => rec.get(r.id)?.last ?? "0000-00-00";
  const sortiert = [...frei].sort((a, b) => rang(a).localeCompare(rang(b)));
  // Aus den am laengsten nicht gegessenen ein paar zur Auswahl.
  const spitze = sortiert.slice(0, Math.min(8, sortiert.length));
  return spitze[Math.floor(random() * spitze.length)];
}

/**
 * Prueft den KI-Vorschlag und fuellt Luecken.
 *
 * Erlaubt ist nur, was es gibt: ein freier Tag, ein vorhandenes Rezept, jedes
 * Rezept hoechstens einmal pro Woche. Alles andere wird lokal ersetzt.
 */
export function validateProposal(
  raw: unknown,
  slots: string[],
  recipes: RecipeOption[],
  rec: Map<string, Recency>,
  random: () => number = Math.random,
): ProposalDay[] {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const vorgeschlagen = new Map<string, { recipeId: string; reason: string }>();

  const liste = (raw as { tage?: unknown })?.tage;
  if (Array.isArray(liste)) {
    for (const e of liste) {
      const t = e as { datum?: unknown; rezept_id?: unknown; grund?: unknown };
      if (typeof t.datum !== "string" || typeof t.rezept_id !== "string") continue;
      if (!slots.includes(t.datum) || vorgeschlagen.has(t.datum)) continue;
      vorgeschlagen.set(t.datum, {
        recipeId: t.rezept_id,
        reason: typeof t.grund === "string" ? t.grund.trim() : "",
      });
    }
  }

  const benutzt = new Set<string>();
  const result: ProposalDay[] = [];
  for (const date of slots) {
    const v = vorgeschlagen.get(date);
    if (v && byId.has(v.recipeId) && !benutzt.has(v.recipeId)) {
      benutzt.add(v.recipeId);
      result.push({ date, recipeId: v.recipeId, reason: v.reason });
      continue;
    }
    const alt = pickAlternative(recipes, benutzt, rec, random);
    if (!alt) continue; // weniger Rezepte als Tage - dann bleibt der Tag frei
    benutzt.add(alt.id);
    const last = rec.get(alt.id)?.last;
    result.push({
      date,
      recipeId: alt.id,
      reason: last ? `Zuletzt am ${last.split("-").reverse().join(".")}` : "Noch nie im Plan",
      substituted: true,
    });
  }
  return result;
}

export function plannerPrompt(opts: {
  recipes: RecipeOption[];
  rec: Map<string, Recency>;
  slots: string[];
  today: string;
  mahlzeit: string;
  wishes: string;
}): string {
  const zeilen = opts.recipes.map((r) => {
    const last = opts.rec.get(r.id)?.last;
    const zuletzt = last ? `vor ${daysBetween(last, opts.today)} Tagen` : "nie";
    return [
      r.id,
      r.name,
      r.tags.length ? `Tags: ${r.tags.join(", ")}` : "",
      r.category ? `Küche: ${r.category}` : "",
      r.totalTime ? `Zeit: ${r.totalTime}` : "",
      `zuletzt: ${zuletzt}`,
    ]
      .filter(Boolean)
      .join(" | ");
  });

  const tage = opts.slots.map((d) => `- ${d} (${weekday(d)})`).join("\n");

  return `Du planst das ${opts.mahlzeit} für die folgenden Tage. Wähle für jeden Tag genau ein
Rezept aus meiner Sammlung. Erfinde keine Rezepte und keine IDs.

## Tage
${tage}

## Regeln
- Jedes Rezept höchstens einmal in diesem Plan.
- Was ich in den letzten Wochen schon hatte („zuletzt: vor N Tagen" mit kleinem N),
  nur wenn es nicht anders geht. Was lange nicht oder nie dran war, bevorzugen.
- Unter der Woche (Montag bis Freitag) eher Schnelles, am Wochenende darf es
  aufwendiger sein.
- Abwechslung: nicht zwei Tage hintereinander dieselbe Küche oder dieselbe
  Hauptzutat, soweit die Namen und Tags das erkennen lassen.
- Begründe jede Wahl in höchstens acht Wörtern auf Deutsch.

## Meine Wünsche für diese Woche
${opts.wishes.trim() || "(keine)"}

## Meine Rezepte (ID | Name | …)
${zeilen.join("\n")}

Antworte als JSON: {"tage": [{"datum": "YYYY-MM-DD", "rezept_id": "…", "grund": "…"}]}`;
}

export const PLANNER_SCHEMA = {
  type: "object",
  properties: {
    tage: {
      type: "array",
      items: {
        type: "object",
        properties: {
          datum: { type: "string" },
          rezept_id: { type: "string" },
          grund: { type: "string" },
        },
        required: ["datum", "rezept_id"],
      },
    },
  },
  required: ["tage"],
} as const;
