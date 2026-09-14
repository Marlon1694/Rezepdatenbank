# Auf dem Proxmox einrichten

Docker läuft in einem LXC-Container oder in einer VM. Der LXC ist sparsamer, braucht
aber eine Einstellung, ohne die Docker gar nicht erst startet.

## Variante A: LXC (empfohlen)

### Container anlegen

Proxmox-Oberfläche → **Create CT**:

| Einstellung | Wert |
|---|---|
| Template | `debian-12-standard` |
| Unprivileged container | ✅ ja |
| **Nesting** | ✅ **ja** (Options → Features) |
| Cores | 4 (2 reichen, dann dauert Whisper länger) |
| RAM | 4096 MB |
| Disk | 16 GB |
| Netzwerk | statische IP **oder** DHCP-Reservierung |

> **Nesting ist Pflicht.** Ohne diese Option startet der Docker-Daemon im
> unprivilegierten LXC nicht. Nachträglich: Container stoppen → Options → Features →
> Nesting ankreuzen → starten.

Nachträglich per Shell:

```bash
pct set <CTID> --features nesting=1
```

### Eine feste Adresse vergeben

Die IP steht später im Kurzbefehl auf deinem iPhone. Ändert sie sich, funktioniert er
nicht mehr. Entweder eine statische IP im Container oder — angenehmer — in UniFi eine
**DHCP-Reservierung** auf die MAC-Adresse des Containers.

Noch besser: in UniFi unter *Settings → Networks → DNS* einen lokalen Eintrag
anlegen, z. B. `rezepte.home.arpa` → die IP. Dann steht im Kurzbefehl ein Name, der
sich nie ändert.

### Docker installieren

```bash
apt update && apt install -y curl git
curl -fsSL https://get.docker.com | sh
```

### Projekt holen und starten

```bash
cd /opt
git clone <dein-repo> rezepte
cd rezepte

cp .env.example .env
openssl rand -hex 32          # Ausgabe als APP_TOKEN in die .env
nano .env                     # NOTION_TOKEN, NOTION_DATABASE_ID, GEMINI_API_KEY eintragen

docker compose up -d --build
docker compose logs -f
```

Erreichbar unter `http://<container-ip>:3000`.

## Variante B: VM

Wenn du den LXC-Sonderfällen aus dem Weg gehen willst: eine kleine Debian-12-VM mit
2 vCPU und 4 GB RAM, sonst identisch. Kostet etwas mehr Overhead, dafür entfällt das
Thema Nesting vollständig.

## Erster Start

Beim ersten Transkribieren lädt faster-whisper sein Modell herunter (~500 MB für
`small`). Das passiert einmalig und landet in `data/models/` — durch den Bind-Mount
überlebt es jeden Neustart und jeden Rebuild.

## Nützliche Befehle

```bash
docker compose logs -f app          # Live-Protokoll
docker compose restart app          # Neustart
docker compose down && docker compose up -d --build   # nach einem git pull
docker compose exec app npx tsx scripts/inspect-notion-db.ts   # Notion prüfen
```

## Ressourcenbedarf

| Modell (`WHISPER_MODEL`) | RAM | Tempo auf CPU | Qualität Deutsch |
|---|---|---|---|
| `tiny` | ~0,5 GB | ~20× Echtzeit | mäßig |
| `base` | ~0,7 GB | ~12× Echtzeit | brauchbar |
| **`small`** (Standard) | ~1,5 GB | ~7× Echtzeit | gut |
| `medium` | ~3 GB | ~2× Echtzeit | sehr gut, aber spürbar langsam |

„7× Echtzeit" heißt: ein 10-Minuten-Video ist in gut 80 Sekunden transkribiert.

Läuft deine Hardware ins Schwitzen, ist `base` ein guter Kompromiss. Umgekehrt gilt:
Die meisten Rezepte brauchen **gar keine** Transkription, weil Untertitel oder
Beschreibung bereits ausreichen.

## Wenn etwas klemmt

| Symptom | Ursache |
|---|---|
| Docker startet nicht im LXC | Nesting fehlt (siehe oben) |
| `port is already allocated` | Port 3000 ist belegt → in `docker-compose.yml` auf z. B. `3001:3000` ändern |
| Transkription bricht mit Speicherfehler ab | RAM erhöhen oder kleineres `WHISPER_MODEL` |
| Instagram schlägt immer fehl | Cookies fehlen → `docs/cookies.md` |
