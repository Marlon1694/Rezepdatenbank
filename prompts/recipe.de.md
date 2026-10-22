# Rezept-Prompt

Diese Datei wird **bei jedem Job frisch gelesen**. Änderungen wirken sofort beim
nächsten Rezept — kein Neustart nötig.

Die Abschnitte `{{...}}` werden vom Programm ersetzt. Bitte stehen lassen.

`{{MODUS}}` bleibt bei Videos leer. Bei Fotos steht dort, ob das Rezept exakt
abgetippt, nur in den Lücken ergänzt oder anhand des Bildes neu entwickelt werden
soll. Fehlt der Platzhalter, hängt das Programm den Abschnitt am Ende an.

---

Ich gebe dir gleich ein Transkript, eine Beschreibung eines Kochvideos oder die
Abschrift eines abfotografierten Rezepts. Bitte erstelle mir daraus eine
strukturierte Rezept-Karte für meine Notion-Datenbank nach exakt diesem Schema:

1. **Titel:** Name des Gerichts mit einem passenden Koch-Emoji.
2. **Tags:** 3-5 Schlagworte (z.B. Schnell, Vegetarisch, LowCarb).
3. **Zubereitungszeit:** Geschätzte Gesamtdauer.
4. **Zutatenliste:** Unterteile sie logisch (z.B. 'Hauptzutaten', 'Gewürze'). Nutze die
   exakten Mengenangaben.
5. **Schritt-für-Schritt Anleitung:** Nummerierte Liste, kurze und prägnante Sätze.
6. **Pro-Tipp:** Ein spezieller Kniff oder eine Variationsmöglichkeit aus dem Material.

## Ausgaberegeln

- **Antworte ausschließlich als JSON** nach dem vorgegebenen Schema. Kein Fließtext,
  keine Markdown-Codeblöcke drumherum.
- **Titel:** Das Emoji gehört in das Feld `emoji`, der Name **ohne** Emoji in `titel`.
- **Tags:** ohne führendes `#` — das ergänzt die Datenbank selbst. Bevorzuge Tags aus
  dieser Liste, wenn sie inhaltlich passen, statt neue Synonyme zu erfinden:
  {{BEKANNTE_TAGS}}
- **Tags beschreiben das Rezept, nicht das Video.** Übernimm keine Anpreisungen aus
  Titel oder Beschreibung. Heißt das Video „in 5 Minuten“ oder „so schnell“, das
  Rezept braucht aber zwei Stunden, ist es **nicht** schnell. Prüfe solche Tags gegen
  die Zubereitungszeit und die Schritte, die du selbst ermittelt hast.
- **Sprache:** Immer Deutsch, auch wenn das Video englisch ist. Übersetze Zutaten- und
  Gerätenamen in die im deutschen Sprachraum übliche Bezeichnung.
- **Mengen:** Die Originalangabe bleibt exakt stehen. Ist sie nicht metrisch, hängst du
  die Umrechnung in Klammern an — `1 cup Mehl (ca. 120 g)`, `350 °F (175 °C)`,
  `2 tbsp Öl (ca. 30 ml)`. So geht nichts verloren und du kannst trotzdem direkt
  danach kochen.
- **Nichts erfinden.** Was im Material nicht vorkommt, wird nicht ergänzt. Fehlt eine
  Menge, lass `menge` leer, statt zu raten. Findest du keinen Pro-Tipp im Material,
  lass `pro_tipp` leer — erfinde keinen allgemeinen Kochratschlag.
  *Ausnahme:* Steht unten ein Abschnitt „Sonderfall“, gilt dort das, was er sagt.
- **Unsicheres kennzeichnen:** Hast du eine Menge nur aus dem Zusammenhang erschlossen,
  schreib `ca.` davor.
- **Zutatengruppen:** Nur gruppieren, wenn es das Rezept hergibt. Ein simples Rezept
  bekommt eine einzige Gruppe namens `Zutaten` — erzwinge keine künstliche Aufteilung.
- **Schritte:** Ein Arbeitsschritt pro Eintrag, Imperativ ("Zwiebeln würfeln."),
  keine Nummerierung im Text selbst (die macht Notion).

{{ZUSATZFELDER}}

{{MODUS}}

## Quelle

{{QUELLE}}

## Input

{{INPUT}}
