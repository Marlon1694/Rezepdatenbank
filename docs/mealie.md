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

Optional in den Optionen der Bridge (Zahnrad): **Benachrichtigungsdienst für Timer**
= `notify.mobile_app_<dein_iphone>`. Denselben Dienst brauchen wir später für die
Sonntags-Nachricht.

## 6. Bring!

1. *Integration hinzufügen* → **Bring!** → mit deinem Bring!-Konto anmelden.
2. In Bring! eine **eigene, leere Liste** anlegen, z.B. „Mealie" — für den Anfang
   nicht deine Hauptliste.
3. In der Atelier-Karte: *Einkaufsliste → Einkaufs-Sync → Sync-Regel hinzufügen*
   - Quelle: deine Mealie-Einkaufsliste
   - Ziel: die neue Bring!-Liste
   - Modus: **Kopieren**
   - Duplikate: **Identische überspringen und gleiche Einheiten zusammenfassen**
4. Vorschau ansehen → ersten Stapel bestätigen.

Test: In Mealie bei einem Rezept *Zutaten einkaufen* → nach etwa 30 Sekunden
stehen sie in Bring!.

> **Die Freigabe vor dem Einkauf** (Wochenplan → Zutaten prüfen → erst dann nach
> Bring!) kommt als eigener Schritt. Dafür bekommt die Sync-Regel später eine
> eigene Quellliste. Für heute reicht der einfache Weg.

## 7. Bestand übernehmen

Erst wenn Schritt 4 klappt. Zuerst nur anschauen, was passieren würde:

```bash
docker compose exec app npm run migrate:mealie
```

Dann wirklich:

```bash
docker compose exec app npm run migrate:mealie -- --ausfuehren
```

Übernommen werden alle Rezepte aus dem Verlauf der App — mit Zutaten, Schritten,
Tags und Titelbild. Was schon in Mealie steht, wird übersprungen. Ein zweiter Lauf
ist also unschädlich.

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
