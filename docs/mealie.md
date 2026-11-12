# Mealie, Atelier und Bring!

Ziel: Jedes Rezept, das die App erfasst, landet zusätzlich in **Mealie**. Mealie
Atelier zeigt die Küche im Home-Assistant-Dashboard, und die Einkaufsliste läuft
nach **Bring!**.

```
LXC 227 „Rezeptdatenbank" (192.168.2.227)
├── rezepte  :3000   die App  ──┬──▶ Notion   (wie bisher, abschaltbar)
│                               └──▶ Mealie
└── mealie   :9925   Mealie 3.29
Home Assistant 2026.11
├── Mealie Atelier Bridge  ──▶ http://192.168.2.227:9925
├── Mealie Atelier Cards   (Dashboard)
└── Bring!-Integration     ◀── Einkaufs-Sync
```

Zeitbedarf: etwa eine Stunde. Die Schritte bauen aufeinander auf.

---

## 0. Vorher

- **Snapshot** des LXC: Proxmox → CT 227 → *Snapshots* → *Take Snapshot*, Name
  `vor-mealie`. In der Handy-Ansicht von Proxmox fehlt der Reiter manchmal — dann
  im Browser die Desktop-Ansicht nehmen.
- Am PC per SSH arbeiten (`ssh root@192.168.2.227`), nicht in der Proxmox-Konsole
  auf dem iPhone. Dort funktioniert Einfügen kaum.

## 1. Mealie installieren

Den ganzen Block ins SSH-Fenster kopieren:

```bash
mkdir -p ~/mealie && cd ~/mealie && cat > docker-compose.yaml <<'EOF'
services:
  mealie:
    image: ghcr.io/mealie-recipes/mealie:v3.29.0
    container_name: mealie
    restart: always
    ports:
      - "9925:9000"
    deploy:
      resources:
        limits:
          memory: 1000M
    volumes:
      - mealie-data:/app/data/
    environment:
      ALLOW_SIGNUP: "false"
      PUID: 1000
      PGID: 1000
      TZ: Europe/Berlin
      BASE_URL: http://192.168.2.227:9925

volumes:
  mealie-data:
EOF
docker compose up -d && docker compose logs -f mealie
```

Warten, bis keine neuen Zeilen mehr kommen (erster Start: 1–2 Minuten), dann
`Strg+C`. Mealie läuft weiter.

**v3.29.0 und nicht die neueste Version:** Atelier ist mit 3.29 getestet. Später
aktualisieren heißt: Versionsnummer in der Datei ändern, `docker compose up -d`.

## 2. Mealie einrichten

Im Browser `http://192.168.2.227:9925` (vom iPhone über die VPN genauso):

1. Anmelden mit `changeme@example.com` / `MyPassword`.
2. **Sofort** im Profil E-Mail und Passwort ändern.
3. Sprache auf **Deutsch**.
4. Wenn Mealie beim ersten Start anbietet, **Lebensmittel und Einheiten** für
   Deutsch anzulegen: annehmen. Dann findet die App „Esslöffel" unter „EL" und
   legt weniger selbst an.
5. *Einstellungen → Admin-Einstellungen → Sicherungen* → erstes Backup.

## 3. Zwei API-Token anlegen

Profil → Kachel **API-Token** → *Verwalte deine API-Token*. Fehlt die Kachel: im
Profil den Haken **Erweiterte Funktionen anzeigen** setzen.

| Name | Wofür |
|---|---|
| `Home Assistant Atelier` | für die Bridge in Home Assistant |
| `Rezept-App` | für diese App |

Jedes Token wird **nur einmal angezeigt** — sofort kopieren. Eins pro Programm,
dann lässt sich jedes einzeln widerrufen. **Nicht in einen Chat kopieren.**

## 4. Die App mit Mealie verbinden

```bash
cd ~/rezepte && git pull
nano .env
```

Unten ergänzen:

```
MEALIE_URL=http://192.168.2.227:9925
MEALIE_API_TOKEN=<das Token „Rezept-App">
```

`MEALIE_URL` ist **nicht** `localhost` — aus dem App-Container heraus wäre das die
App selbst. Speichern (`Strg+O`, `Enter`, `Strg+X`), dann:

```bash
docker compose up -d --build
curl -s -H "Authorization: Bearer $(grep ^APP_TOKEN= .env | cut -d= -f2)" \
  localhost:3000/api/mealie
```

Erwartet: `{"ok":true, … "user":"…", "group":"home"}`. Eine Fehlermeldung sagt,
woran es liegt — Adresse oder Token.

Ab jetzt geht **jedes neue Rezept in beide**: Notion und Mealie. Fällt eines aus,
landet das Rezept trotzdem im anderen. In der Web-App steht dann
„⚠️ fehlt in Mealie" und ein Knopf **In Mealie nachtragen** — ohne neue KI-Anfrage.

## 5. Atelier in Home Assistant

1. *Einstellungen → Marketplace* → Hinweis bestätigen.
2. Reiter **Durchstöbern** → **Mealie Atelier Bridge** → *Installieren*.
3. Dasselbe mit **Mealie Atelier Cards** (Typ *Dashboard*). Browser neu laden,
   wenn Home Assistant fragt.
4. *Einstellungen → Geräte & Dienste → Integration hinzufügen* → **Mealie Atelier
   Bridge** (nicht „Mealie").
   - URL: `http://192.168.2.227:9925`
   - Token: `Home Assistant Atelier`
5. Dashboard → Stift → *Karte hinzufügen* → Reiter **Nach Karte** → „Mealie
   Atelier" → **Komplette Küche**.

Findet die Suche Bridge oder Karten nicht: *Über Link hinzufügen* mit
`https://github.com/mealie-atelier/mealie-atelier-bridge` bzw.
`https://github.com/mealie-atelier/mealie-atelier-cards`.

Die Küchentimer richtest du im nächsten Abschnitt ein.

## Küchentimer auf allen Geräten

Die Timer laufen **in Home Assistant**, nicht auf dem Gerät: Am iPad stellen, iPad
weglegen — der Timer läuft weiter. Läuft er ab, meldet Atelier das zweifach:

1. als Benachrichtigung in Home Assistant (Glocke in der Seitenleiste) — auf jedem
   Gerät zu sehen, auf dem Home Assistant offen ist
2. als Push an **einen** Benachrichtigungsdienst aus den Bridge-Optionen

**Timer gehören einem Home-Assistant-Benutzer.** Andere Benutzer sehen ihn in der
Karte nicht, Administratoren sehen alle. Am einfachsten: auf iPhone, iPad und
Küchentablet mit demselben Benutzer anmelden.

**Push auf mehrere Geräte:** Weil Atelier nur einen Dienst kennt, fasst eine
Benachrichtigungsgruppe die Geräte zusammen. In der `configuration.yaml`:

```yaml
notify:
  - platform: group
    name: kueche
    services:
      - action: mobile_app_dein_iphone
      - action: mobile_app_dein_ipad
      - action: mobile_app_tablet
```

Die genauen Namen zeigt *Entwicklerwerkzeuge → Aktionen*, wenn du „notify.mobile_app"
eintippst. Home Assistant neu starten, dann in den Bridge-Optionen (Zahnrad) bei
**Benachrichtigungsdienst für Timer** `notify.kueche` wählen. Ein Gerät bekommt den
Push nur, wenn die Home-Assistant-App darauf installiert und angemeldet ist.

**Wandtablet ohne Home-Assistant-App** (Dashboard im Browser oder in einer Kiosk-App):
Dort kommt kein Push an. Stattdessen eine Ansage, ausgelöst von der Atelier-Meldung:

```yaml
alias: Küchentimer abgelaufen – Ansage
triggers:
  - trigger: persistent_notification
    update_type: [added]
conditions:
  - "{{ trigger.notification.notification_id.startswith('mealie_atelier_') }}"
actions:
  - action: tts.speak
    target:
      entity_id: tts.DEINE_SPRACHAUSGABE
    data:
      media_player_entity_id: media_player.KUECHE
      message: "{{ trigger.notification.message }}"
```

`media_player.KUECHE` ist ein Küchenlautsprecher — oder das Tablet selbst, wenn es
als Mediaplayer eingebunden ist (z.B. über Fully Kiosk).

> **Nicht den Nur-Lesen-Modus der Bridge einschalten.** Dann laufen Timer laut
> Atelier-Anleitung nur noch auf dem jeweiligen Gerät — und der Modus gilt für die
> ganze Bridge, nicht nur für ein Tablet.

Die Gruppe `notify.kueche` eignet sich auch für die Sonntags-Erinnerung weiter unten:
Dann kommt sie auf allen Geräten an.

## 6. Bring!

1. *Integration hinzufügen* → **Bring!** → mit deinem Bring!-Konto anmelden.
2. In Bring! eine **eigene, leere Liste** anlegen, z.B. „Mealie" — für den Anfang
   nicht deine Hauptliste.
3. In der Atelier-Karte: *Einkaufsliste → Einkaufs-Sync → Sync-Regel hinzufügen*
   - Quelle: **Wocheneinkauf** (die Liste legt die App beim ersten Freigeben selbst
     an — gibt es sie noch nicht, einmal in der App einen Einkauf freigeben oder
     sie in Mealie von Hand anlegen)
   - Ziel: die neue Bring!-Liste
   - Modus: **Kopieren**
   - Wann: **„Auf Änderungen an anderer Stelle achten" einschalten.** Wichtig: Die
     App schreibt direkt in Mealie, nicht über Atelier. Ohne diesen Haken bemerkt
     Atelier die freigegebenen Zutaten nicht.
   - Duplikate: **Identische überspringen und gleiche Einheiten zusammenfassen**
4. Vorschau ansehen → ersten Stapel bestätigen.

So kommt **nur nach Bring!, was du freigegeben hast**: Die App schreibt erst nach
deiner Freigabe in „Wocheneinkauf", und nur diese Liste hat eine Regel nach Bring!.

## Wochenplan, Einkauf, Was kochen?

In der Web-App gibt es mit Mealie eine Karte **🍽️ Küche**:

| | |
|---|---|
| **📅 Wochenplan** | Die KI wählt aus deinen Mealie-Rezepten und meidet, was in den letzten Wochen schon dran war. Unter der Woche eher Schnelles, am Wochenende Aufwendigeres, dazu deine Wünsche („freitags Fisch"). Einzelne Tage lassen sich tauschen oder freilassen. Erst **Übernehmen** schreibt in den Mealie-Plan. Bereits Geplantes bleibt unangetastet. Ist die KI nicht erreichbar, plant die App nach „am längsten nicht gegessen" und sagt das dazu. |
| **🛒 Einkauf** | Alle Zutaten der geplanten Gerichte, über die Woche zusammengefasst und mit dem Portionsfaktor aus dem Plan gerechnet. Was in Mealie als **vorrätig** markiert ist (Lebensmittel → „Vorrätig"), ist abgewählt, ebenso Salz, Pfeffer, Öl. **Freigeben** schreibt in „Wocheneinkauf" — und Atelier von dort nach Bring!. Gibst du dieselbe Woche zweimal frei, warnt die App vorher. |
| **🥕 Was kochen?** | Eingeben, was da ist — Mealie sucht passende Rezepte und sagt, was fehlt. |

Den Grundvorrat pflegst du am besten **in Mealie**: *Datenverwaltung → Lebensmittel*
→ bei Butter, Mehl, Zucker usw. „Vorrätig" anhaken. Das zählt dann für den Einkauf
und für „Was kochen?".

## Sonntags: Einkauf prüfen

Eine Home-Assistant-Automation erinnert dich und öffnet mit einem Tipp direkt die
Freigabe. *Einstellungen → Automationen → Neu → YAML bearbeiten*:

```yaml
alias: Wocheneinkauf prüfen
triggers:
  - trigger: time
    at: "17:00:00"
conditions:
  - condition: time
    weekday: [sun]
actions:
  - action: notify.kueche   # oder nur ein Gerät: notify.mobile_app_DEIN_IPHONE
    data:
      title: "🛒 Wocheneinkauf"
      message: "Wochenplan prüfen und Zutaten freigeben"
      data:
        url: "http://192.168.2.227:3000/#einkauf"
```

`notify.kueche` ist die Gruppe aus dem Abschnitt zu den Küchentimern. Ohne Gruppe
nimmst du `notify.mobile_app_…` mit dem Namen aus *Einstellungen → Geräte & Dienste →
Mobile App*. Lieber erst planen? Dann `#wochenplan` statt `#einkauf`.

> **Beim ersten Antippen** öffnet iOS den Link in Safari, nicht in der App auf dem
> Home-Bildschirm. Safari kennt dein Zugriffs-Token noch nicht — einmal eingeben,
> danach merkt Safari es sich.

## 7. Bestand übernehmen

Erst wenn Schritt 4 klappt. Zuerst nur anschauen, was passieren würde:

```bash
docker compose exec app npm run migrate:mealie -- --aufwerten
```

Dann wirklich:

```bash
docker compose exec app npm run migrate:mealie -- --ausfuehren --aufwerten
```

Übernommen werden alle Rezepte aus dem Verlauf der App und alle Notion-Seiten —
mit Zutaten, Schritten, Tags und Titelbild. Was schon in Mealie steht, wird
übersprungen. Ein zweiter Lauf ist also unschädlich.

**`--aufwerten`** ergänzt Rezepte, die vor den zerlegten Zutaten gespeichert wurden.
Je Rezept eine KI-Anfrage, nur mit dem Rezepttext:

- **Mealie:** Menge, Einheit und Lebensmittel getrennt — Portionen umrechnen,
  Einkaufsliste fasst zusammen — und die Zutaten neben den Schritten im Kochmodus.
- **Notion:** unter jeden Schritt die graue Zeile „↳ 200 g Mehl · 2 Eier". Sonst
  bleibt die Seite, wie sie ist: Kommentare, eigene Notizen, Titelbild, in Notion
  korrigierte Mengen. Passt die Zahl der Schritte in Notion nicht mehr zum
  Rezept, bleibt die Seite ganz unverändert; die Liste am Ende nennt sie.

Titel, Zutatentexte und Schritte ändert die KI nicht — sie liefert nur Nummern und
die drei Zutatenfelder zurück.

**`--neu`** zusammen mit `--aufwerten` zerlegt auch schon aufgewertete Rezepte noch
einmal — etwa nachdem die Regeln dafür besser geworden sind. Kostet je Rezept eine
KI-Anfrage; bei vielen Rezepten auf zwei Tage verteilen, falls das Gemini-Kontingent
knapp wird.

**Notion-Seiten ohne Gliederung** — etwa aus Notions Rezeptvorlage, deren Inhalt in
einem KI-Block steht: Den Block in Notion erst in normalen Text umwandeln (in den
Block klicken → „Darunter einfügen", dann den leeren KI-Block löschen). Den Inhalt
von KI-Blöcken gibt Notion über keine Schnittstelle heraus. Danach liest die
Übernahme den Seitentext mit der KI, übernimmt nur, was dasteht, und nimmt Titel,
Tags, Zeit und Schwierigkeit aus den Spalten. Statt des Unsplash-Standardbilds der
Vorlage gibt es ein erzeugtes Titelbild, wenn `COVER_SOURCE=ai` gesetzt ist. Deine
Notizen unter „Verbesserungen für das nächste Mal" bleiben in Notion.

**Spannen** wie „1–2 Zehen" speichert Mealie als untere Zahl, die ganze Angabe steht
als Notiz dabei: „1 Zehe Knoblauch — 1–2 Zehen, gehackt".

## Wenn etwas hakt

| Meldung | Ursache |
|---|---|
| „Mealie ist unter … nicht erreichbar" | Container läuft nicht (`docker ps`), oder `MEALIE_URL` ist `localhost` |
| „API-Token abgelehnt" | Token unvollständig kopiert oder in Mealie gelöscht → neues anlegen |
| „MEALIE_URL und MEALIE_API_TOKEN gehören zusammen" | nur eines der beiden in der `.env` |
| Bridge: „nicht erreichbar" | in Home Assistant `localhost` eingetragen — es muss die IP sein |
| Nichts kommt in Bring! an | Sync-Regel nur gespeichert, ersten Stapel nicht bestätigt |

## Notion abschalten

Später, wenn Mealie sich bewährt hat:

```
NOTION_ENABLED=false
```

Dann gehen neue Rezepte nur noch nach Mealie. Die Notion-Seiten bleiben stehen,
werden aber nicht mehr befüllt.
