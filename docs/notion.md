# Notion verbinden

Drei Dinge brauchst du: ein Token, die Datenbank-ID und — leicht zu übersehen — die
Freigabe der Integration für genau deine Datenbank.

## 1. Integration anlegen

1. [notion.so/profile/integrations](https://www.notion.so/profile/integrations) öffnen
2. **New integration** → Name z. B. `Rezept-Import`, Workspace auswählen
3. Typ: **Internal**
4. Unter *Capabilities* müssen **Read content**, **Update content** und
   **Insert content** aktiv sein
5. **Internal Integration Secret** kopieren → das ist dein `NOTION_TOKEN`
   (beginnt mit `ntn_`)

## 2. Die Integration für deine Datenbank freigeben

**Das ist der Schritt, an dem es fast immer hakt.** Ein gültiges Token allein reicht
nicht — die Integration sieht ausschließlich Seiten, die ausdrücklich mit ihr geteilt
wurden.

1. Deine Rezept-Datenbank in Notion öffnen
2. Oben rechts auf **•••**
3. **Verbindungen** → **Verbindung hinzufügen** → `Rezept-Import` auswählen

Ohne diesen Schritt meldet die API `object_not_found` — und zwar auch dann, wenn die
Datenbank-ID völlig korrekt ist. Die Fehlermeldung klingt also nach einem Tippfehler,
ist aber ein Rechteproblem.

## 3. Datenbank-ID herausfinden

Datenbank im Browser öffnen. Die URL sieht so aus:

```
https://www.notion.so/dein-workspace/a1b2c3d4e5f67890a1b2c3d4e5f67890?v=...
                                     └────────── das ist die ID ──────────┘
```

Die 32 Zeichen **vor** dem `?v=`. Bindestriche darin sind egal.

> Benutzt du die Desktop-App: **•••** → **Link kopieren**, dann ist dieselbe ID enthalten.

Beides in die `.env`:

```dotenv
NOTION_TOKEN=ntn_...
NOTION_DATABASE_ID=a1b2c3d4e5f67890a1b2c3d4e5f67890
```

## 4. Prüfen

```bash
npm run inspect:notion
```

Das listet alle Spalten deiner Datenbank mit ihrem Typ auf, zeigt die automatisch
erkannte Zuordnung und legt `config/notion-mapping.json` an.

## 5. Zuordnung anpassen

`config/notion-mapping.json` ordnet die Rezeptfelder deinen Spaltennamen zu:

```json
{
  "titel": "Name",
  "tags": "Tags",
  "zeit": "Zubereitungszeit",
  "quelle": "Quelle",
  "portionen": "Portionen",
  "kueche": "Küche",
  "datum": "Hinzugefügt"
}
```

- Spaltennamen müssen **exakt** so geschrieben sein wie in Notion (Umlaute inklusive).
- Ein Feld auf `null` setzen schaltet es ab.
- Steht ein Feld gar nicht drin, sucht das Programm selbst nach einem passenden Namen.
- Fehlt eine Spalte, wird das Feld einfach übersprungen — das bricht nichts ab.

### Welcher Spaltentyp passt wozu?

| Feld | Empfohlener Typ | Anmerkung |
|---|---|---|
| `titel` | Title | Die Title-Spalte wird über ihren *Typ* gefunden, nicht über ihren Namen |
| `tags` | Mehrfachauswahl | Vorhandene Optionen werden wiederverwendet statt verdoppelt |
| `zeit` | Text **oder** Zahl | Bei *Zahl* landen die Minuten darin, bei *Text* der Klartext |
| `quelle` | URL | **Wichtig für die Duplikat-Erkennung** — siehe unten |
| `portionen` | Text oder Zahl | optional |
| `kueche` | Auswahl oder Text | optional |
| `datum` | Datum | wird auf den Tag des Imports gesetzt |

## Duplikat-Erkennung

Gibt es eine **Quelle**-Spalte vom Typ URL (oder Text), wird vor dem Anlegen geprüft,
ob zu diesem Link bereits eine Seite existiert. Wenn ja, wird sie **aktualisiert**
statt eine zweite anzulegen.

Ohne eine solche Spalte entsteht bei jedem Lauf eine neue Seite. Eine `Quelle`-Spalte
vom Typ URL anzulegen dauert zehn Sekunden und lohnt sich.

## Tags: mit oder ohne `#`?

Standardmäßig werden Tags **ohne** führendes `#` gespeichert — in einer
Mehrfachauswahl sind es ohnehin schon Tags.

Führt deine Datenbank ihre Tags bereits mit `#`, wird das automatisch erkannt und
beibehalten. Der Abgleich ignoriert Groß-/Kleinschreibung und das `#`, damit nicht
über die Monate `Schnell`, `#Schnell` und `schnell` als drei getrennte Optionen
entstehen.

Erzwingen lässt es sich mit `TAGS_WITH_HASH=true` in der `.env`.
