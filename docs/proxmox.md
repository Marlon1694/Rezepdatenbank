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

### Container wird gebaut, startet aber nicht

```
runc create failed: unable to start container process: error during container init:
open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied
```

Das liegt **nicht** an diesem Projekt, sondern trifft jeden Docker-Container in einem
unprivilegierten Proxmox-LXC.

Hintergrund: `containerd.io` ab Version `1.7.28-2` schliesst eine Ausbruchsluecke
(CVE-2025-52881). Der Patch oeffnet dafuer Dateideskriptoren unter `/proc` neu — und
AppArmor auf dem Proxmox-Host verwechselt den Pfad dabei mit `/sys/net/...` und
blockiert ihn.

**Weg 1 — Proxmox-Host aktualisieren (empfohlen).** Seit `lxc-pve` 6.0.0-2 ist das
sauber behoben. Auf dem **Host**, nicht im Container:

```bash
apt update && apt full-upgrade
pct stop <CTID> && pct start <CTID>
```

Danach im Container `docker compose up -d` erneut. Das ist die einzige Loesung, die
den Sicherheitspatch erhaelt.

**Weg 2 — containerd herabstufen (nur wenn Weg 1 nicht geht).** Im **Container**:

```bash
apt-cache madison containerd.io | head        # zeigt die passenden Versionen
apt install -y containerd.io=<version mit -1 am Ende>
apt-mark hold containerd.io
systemctl restart docker
```

Die genaue Versionsbezeichnung haengt von der Distribution ab, etwa
`1.7.28-1~debian.12~bookworm` oder `1.7.28-1~ubuntu.24.04~noble` — deshalb vorher
`apt-cache madison`.

> **Abwaegung:** Damit laeuft CVE-2025-52881 wieder offen. In einem Heimnetz, in dem
> nur eigene Container laufen, ist das Risiko ueberschaubar — aber es ist eine
> bewusste Entscheidung, keine Nebensaechlichkeit. `apt-mark unhold containerd.io`
> macht es rueckgaengig, sobald Weg 1 verfuegbar ist.

**Weg 3 — AppArmor abschalten (letzte Wahl).** Auf dem Host in
`/etc/pve/lxc/<CTID>.conf`:

```ini
lxc.apparmor.profile: unconfined
```

Das hebt die AppArmor-Isolation des gesamten Containers auf. Nur nehmen, wenn Weg 1
und 2 ausscheiden.

### Weitere Stolpersteine

| Symptom | Ursache |
|---|---|
| Docker startet nicht im LXC | Nesting fehlt (siehe oben) |
| `port is already allocated` | Port 3000 ist belegt → in `docker-compose.yml` auf z. B. `3001:3000` ändern |
| Transkription bricht mit Speicherfehler ab | RAM erhöhen oder kleineres `WHISPER_MODEL` |
| Instagram schlägt immer fehl | Cookies fehlen → `docs/cookies.md` |
