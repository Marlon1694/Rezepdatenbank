# 🍲 Rezeptdatenbank

Rezept-Links von **YouTube, Instagram, TikTok und Food-Blogs** per Teilen-Menü aufs
iPhone-Icon tippen — transkribieren, strukturieren, fertig in deiner **Notion-Rezept-
Datenbank**.

Läuft auf deinem eigenen Proxmox. **Laufende Kosten: 0 €.**

```
iPhone: Teilen (TikTok/Insta/YouTube) → Kurzbefehl
            │  POST /api/jobs { url }
            ▼
   Fastify + Worker + SQLite   (ein Docker-Container)
            │
   1. yt-dlp        → Titel, Beschreibung, Untertitel
   2. Gratis-Text?  → reicht das schon? dann Transkription überspringen
   3. faster-whisper → lokal, kostenlos, ohne Limit
   4. Gemini Flash  → dein Prompt → strukturiertes Rezept
   5. Notion        → Seite anlegen oder bestehende aktualisieren
            ▼
      Rezept-Karte in Notion
```

## Was daraus in Notion entsteht

Genau die sechs Felder deines Prompts:

| | |
|---|---|
| **Titel** | Gerichtname mit Koch-Emoji — das Emoji wird auch das Seiten-Icon |
| **Tags** | 3–5 Schlagworte, abgeglichen gegen deine vorhandenen Optionen |
| **Zubereitungszeit** | als Text oder Minuten, je nach Spaltentyp |
| **Zutaten** | als **echte Notion-Checkboxen** zum Abhaken beim Einkaufen, nach Gruppen gegliedert |
| **Zubereitung** | nummerierte Liste |
| **Pro-Tipp** | als 💡-Callout |

Dazu die Quelle als Link und das Original-Transkript in einem zugeklappten Block —
falls die KI mal etwas falsch verstanden hat.

## Der Trick: transkribieren ist meistens unnötig

Whisper ist der langsamste Schritt. Deshalb wird zuerst geprüft, ob es schon
brauchbaren Text gibt:

- **YouTube** liefert Untertitel bzw. Auto-Captions — kostenlos und sofort
- **TikTok / Instagram** haben das Rezept oft komplett in der Caption
- **Food-Blogs** betten fast immer `schema.org/Recipe` als JSON-LD ein — fertig
  strukturierte Daten, ganz ohne Ratespiel

Erst wenn davon nichts Verwertbares übrig bleibt, läuft faster-whisper an — mit
`small` und int8 etwa siebenfache Echtzeit, ein 10-Minuten-Video also in gut
80 Sekunden.

## Schnellstart

Auf dem Proxmox (LXC oder VM mit Docker):

```bash
git clone <dein-repo> rezepte && cd rezepte
bash setup.sh
```

Das Skript fragt die drei Zugangsdaten ab und **prüft jede einzeln gegen die echte
API**, bevor irgendetwas startet — du merkst also sofort, wenn das Notion-Token nicht
freigegeben ist, statt erst beim ersten Rezept. Danach erzeugt es das Zugriffs-Token,
baut den Container, startet ihn und liest deine Notion-Spalten aus.

Am Ende steht dort die Adresse und das Token. Fertig.

<details>
<summary>Lieber von Hand?</summary>

```bash
cp .env.example .env
openssl rand -hex 32        # als APP_TOKEN eintragen
nano .env                   # NOTION_TOKEN, NOTION_DATABASE_ID, GEMINI_API_KEY

docker compose up -d --build
docker compose exec app npx tsx scripts/inspect-notion-db.ts
```
</details>

Dann `http://<server-ip>:3000` im Browser öffnen. Unter
`http://<server-ip>:3000/setup` stehen die fertigen Werte für den iPhone-Kurzbefehl
zum Kopieren — mit deiner echten Adresse und deinem Token bereits eingesetzt.

### Was du dafür brauchst

| | Wo | Kosten |
|---|---|---|
| Notion-Integration-Token | [notion.so/profile/integrations](https://www.notion.so/profile/integrations) | — |
| Notion-Datenbank-ID | aus der URL deiner Datenbank | — |
| Gemini-API-Key | [aistudio.google.com](https://aistudio.google.com) → *Get API key* | kostenlos, ohne Kreditkarte |
| `cookies.txt` *(optional)* | nur für Instagram nötig | — |

Details: [`docs/notion.md`](docs/notion.md)

## Einrichtung

| Schritt | Anleitung |
|---|---|
| Alles in einem Rutsch | `bash setup.sh` |
| Container auf Proxmox aufsetzen | [`docs/proxmox.md`](docs/proxmox.md) |
| Notion verbinden und Spalten zuordnen | [`docs/notion.md`](docs/notion.md) |
| Kurzbefehl fürs Teilen-Menü bauen | [`docs/ios-shortcut.md`](docs/ios-shortcut.md) |
| VPN so einstellen, dass sie anbleiben kann | [`docs/vpn-zugriff.md`](docs/vpn-zugriff.md) |
| HTTPS über Tailscale *(optional)* | [`docs/tailscale.md`](docs/tailscale.md) |
| Instagram-Cookies hinterlegen | [`docs/cookies.md`](docs/cookies.md) |

## Pinterest

Ein Pinterest-Pin **enthält kein Rezept** — er ist ein Bild, ein Satz Beschreibung
und ein Link auf die Seite, wo das Rezept tatsächlich steht. Wird ein Pin geteilt,
löst die App ihn deshalb erst auf und verarbeitet die verlinkte Seite.

Findet sich dort kein Verweis, bricht der Job mit einem Hinweis ab, statt aus der
Pin-Überschrift eine Karte zu bauen, die nach Rezept aussieht und keines ist.

## Unvollständige Quellen

Vor dem Schreiben nach Notion wird geprüft, ob überhaupt ein brauchbares Rezept
herauskam. Abgelehnt wird, was offensichtlich keines ist:

- die Anleitung besteht aus einem einzigen Schritt
- weniger als drei Zutaten
- keine einzige Mengenangabe (außer bei sechs oder mehr Zutaten — manche Rezepte
  sind bewusst ungefähr gehalten)

Das Modell antwortet auch auf eine dünne Vorlage pflichtschuldig im richtigen
Format. Ein formal gültiges, aber leeres Rezept ist in der Datenbank schlimmer als
gar kein Eintrag: Es sieht aus wie ein Ergebnis.

## Denselben Link zweimal erfassen

Passiert nichts Schlimmes: Vor dem Anlegen wird nach einer Seite mit derselben
Quell-URL gesucht. Gibt es sie, wird sie **aktualisiert** statt eine zweite
anzulegen — Eigenschaften und Seiteninhalt werden neu geschrieben.

Nicht angetastet werden dabei:

- **Status** — wird nur beim Anlegen gesetzt. Ein auf *Perfektioniert* stehendes
  Rezept fällt durch einen erneuten Import nicht auf Anfang zurück.
- **Bewertung** — wird grundsätzlich nie geschrieben.
- **Titelbild** — nur, wenn tatsächlich ein neues entstanden ist.

Damit das greift, werden verschiedene Schreibweisen derselben Seite auf eine Form
gebracht: `youtu.be/ABC`, `youtube.com/watch?v=ABC`, `m.youtube.com/...` und
`youtube.com/shorts/ABC` gelten als dasselbe Video, Tracking-Parameter und ein
abschließender Schrägstrich spielen keine Rolle. Kurzlinks wie `vm.tiktok.com/XYZ`
löst yt-dlp beim Abruf auf — in Notion landet dann die vollständige Adresse.

> Voraussetzung ist eine Spalte für die Quelle (bei dir `URL`). Ohne sie kann derselbe
> Link nicht wiedererkannt werden und jeder Lauf legt eine neue Seite an.

## Titelbild

Gesteuert über `COVER_SOURCE`:

| Wert | Woher das Bild kommt |
|---|---|
| **`thumbnail`** *(Standard)* | Vorschaubild des Videos, bei Blogs das Bild aus `schema.org/Recipe`, sonst `og:image`. Kostenlos, zeigt das Gericht aus genau diesem Rezept. |
| `ai` | Erzeugtes Bild nach [`prompts/cover.de.md`](prompts/cover.de.md). **Kostenpflichtig** — siehe unten. |
| `thumbnail+ai` | Vorschaubild, und nur wenn keines vorhanden ist, ein erzeugtes. |
| `none` | Kein Titelbild. |

Das Bild wird zu Notion **hochgeladen**, nicht verlinkt. CDN-Adressen von TikTok und
Instagram sind signiert und laufen ab — als hochgeladene Datei gehört es dauerhaft
zur Seite.

Bei einem erneuten Erfassen desselben Links wird ein vorhandenes Titelbild nur
überschrieben, wenn tatsächlich ein neues entstanden ist. Ein selbst gesetztes
bleibt also bestehen.

Schlägt etwas fehl — kein Vorschaubild, Abruf klemmt, Upload scheitert — landet das
Rezept trotzdem in Notion, nur ohne Bild.

> **Zu `ai`:** Die freie Gemini-Stufe sieht für Bildmodelle kein Kontingent vor. Die
> API antwortet mit `429` und `limit: 0` — das ist kein aufgebrauchtes Kontingent,
> sondern gar keines. Dafür muss in der Google-Cloud-Konsole die Abrechnung aktiv
> sein. Abgesehen davon zeigt ein erzeugtes Bild ein plausibles, aber erfundenes
> Gericht; für ein Rezeptbuch ist das Vorschaubild der Quelle meist die bessere Wahl.

## Der Prompt gehört dir

[`prompts/recipe.de.md`](prompts/recipe.de.md) enthält deinen Prompt im Wortlaut.
Die Datei wird **bei jedem Rezept frisch gelesen** — Änderungen wirken sofort beim
nächsten Durchlauf, ohne Neustart.

Zum Ausprobieren einer Änderung:

```bash
npm run recipe -- "https://www.youtube.com/watch?v=..." --dry-run
```

Das zeigt das fertige Rezept im Terminal, ohne etwas nach Notion zu schreiben.

## Bedienung

**Vom iPhone:** Teilen-Menü → Kurzbefehl. Oder die Web-App vom Home-Screen, dort
siehst du auch den Verlauf und kannst Rezepte vor dem Speichern korrigieren.

**Von der Kommandozeile:**

```bash
npm run recipe -- <url>              # nach Notion schreiben
npm run recipe -- <url> --dry-run    # nur anzeigen
npm run inspect:notion               # Datenbank-Schema prüfen
npm run models                       # verfügbare Gemini-Modelle auflisten
```

### Wenn TikTok fehlschlägt

TikTok lässt nur Anfragen durch, die den TLS-Fingerabdruck eines echten Browsers
vorweisen. Prüfen:

```bash
curl -s localhost:3000/api/health
```

Steht dort `"impersonation": false`, fehlt die Bibliothek `curl_cffi` — dann das
Image neu bauen (`docker compose build --no-cache`). Im Image ist sie über
`yt-dlp[default,curl-cffi]` enthalten.

Bleibt es dabei, ist der Extraktor veraltet. TikTok ändert seine Seite häufig;
Korrekturen erscheinen zuerst im nächtlichen Kanal — deshalb ist `YTDLP_CHANNEL`
standardmäßig `nightly`. Der stabile Kanal hinkt Wochen hinterher.

> Nicht über `yt-dlp -U` aktualisieren: Bei einer pip-Installation prüft das zwar
> die GitHub-Releases, ersetzt sich aber nicht selbst und meldet fälschlich
> „up to date". Die App aktualisiert deshalb über pip.

### Wenn Gemini mit HTTP 503 antwortet

Das Modell ist vorübergehend überlastet. Die App wiederholt den Aufruf bis zu
viermal mit wachsender Wartezeit (3 s, 8 s, 20 s, 40 s) und wechselt danach auf
`GEMINI_FALLBACK_MODEL`, falls gesetzt.

Passiert es häufig, liegt es meist am Modellnamen: Die **`-latest`-Aliase zeigen auf
experimentelle Modelle** mit engeren Limits und ohne zugesicherte Verfügbarkeit.
`npm run models` listet auf, was dein Key kennt — trag von dort ein stabiles Modell
als `GEMINI_MODEL` ein.

## Konfiguration

Alles über die `.env`, Vorlage in [`.env.example`](.env.example). Die wichtigsten:

| Variable | Standard | Bedeutung |
|---|---|---|
| `APP_TOKEN` | — | Zugriffsschutz für API und Web-App |
| `TRANSCRIBE_PROVIDER` | `local` | `local` (faster-whisper) oder `gemini` |
| `WHISPER_MODEL` | `small` | `tiny`/`base`/`small`/`medium` — Tempo gegen Qualität |
| `FREE_TEXT_MIN_CHARS` | `400` | ab wann vorhandener Text als ausreichend gilt |
| `TAGS_WITH_HASH` | `false` | Tags mit führendem `#` speichern |
| `NEW_RECIPE_STATUS` | — | Status für neu erfasste Rezepte (nur beim Anlegen) |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Modell für die Rezept-Extraktion |
| `GEMINI_FALLBACK_MODEL` | `gemini-2.5-flash` | Ausweichmodell bei Überlastung |
| `GEMINI_TRANSCRIBE_MODEL` | `gemini-3.5-transcribe` | nur bei `TRANSCRIBE_PROVIDER=gemini` |
| `COVER_SOURCE` | `thumbnail` | `thumbnail`, `ai`, `thumbnail+ai` oder `none` |
| `IMAGE_MODEL` | — | Bildmodell für `ai` (`npm run models` zeigt die Namen) |
| `YTDLP_AUTO_UPDATE` | `true` | yt-dlp beim Start aktualisieren |
| `YTDLP_CHANNEL` | `nightly` | `nightly` oder `stable` — siehe unten |

## Entwicklung

```bash
npm install
npm run dev          # mit Auto-Reload
npm test             # 79 Tests, alle ohne Netzwerk
npm run typecheck
```

Die Tests decken die Teile ab, an denen es erfahrungsgemäß bricht: den VTT-Parser
(inklusive der berüchtigten Duplikat-Zeilen der YouTube-Auto-Captions), die
JSON-LD-Extraktion, die Zuordnung auf Notion-Spaltentypen und den Tag-Abgleich.

## Aufbau

```
src/
  server.ts          Fastify: API + Web-App
  extract/           yt-dlp, VTT-Parser, JSON-LD, Seitentext
  transcribe/        faster-whisper (lokal) | Gemini
  llm/               Prompt-Aufbau, Gemini, Rezept-Schema
  notion/            Client, Spalten-Zuordnung, Blöcke, Upsert
  jobs/              SQLite-Queue, Worker, Pipeline
  web/               PWA ohne Build-Schritt
prompts/recipe.de.md ► dein Prompt
config/              notion-mapping.json, cookies.txt, ts-serve.json
```

Bewusst **kein Redis und kein BullMQ**: Bei ein paar Rezepten am Tag reicht eine
SQLite-gestützte Queue im selben Prozess. Ein zweiter Dienst wäre hier reiner
Betriebsaufwand ohne Gegenwert.
