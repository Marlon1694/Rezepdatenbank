# Optional: HTTPS über Tailscale

Ohne eigene Domain, ohne offenen Port am Router, kostenlos. Der Container ist bereits
in der `docker-compose.yml` enthalten, aber hinter einem Profil — ohne das Flag
existiert er nicht.

## Was du davon hast

- **Gültiges HTTPS-Zertifikat** (Let's Encrypt) auf einer Adresse wie
  `https://rezepte.dein-tailnet.ts.net`
- **Kein VPN-Umschalten** — Tailscale ist von Haus aus Split Tunnel und auf
  Dauerbetrieb ausgelegt
- Die Web-App wird damit zur vollwertigen PWA (Service Worker verlangen HTTPS)

Der Weg über die UniFi-VPN bleibt daneben unverändert bestehen. Du kannst das Profil
jederzeit an- und wieder abschalten.

## Einrichten

### 1. Konto und HTTPS

1. Kostenloses Konto auf [tailscale.com](https://tailscale.com) anlegen
2. Admin-Konsole → **DNS** → **HTTPS Certificates** → **Enable**

Ohne Schritt 2 gibt es kein Zertifikat und `tailscale serve` schlägt fehl.

### 2. Auth-Key erzeugen

Admin-Konsole → **Settings → Keys** → **Generate auth key**

- **Reusable** ✅ (sonst brauchst du nach jedem Neuaufbau des Containers einen neuen)
- **Ephemeral** ❌ (der Container soll dauerhaft im Tailnet bleiben)

Key in die `.env`:

```dotenv
TS_AUTHKEY=tskey-auth-...
```

### 3. Starten

```bash
docker compose --profile tailscale up -d
```

### 4. Prüfen

```bash
docker compose exec tailscale tailscale status        # Gerät online?
docker compose exec tailscale tailscale serve status  # Proxy auf app:3000 aktiv?
```

### 5. Aufs iPhone

1. Tailscale aus dem App Store, mit demselben Konto anmelden
2. Safari → `https://rezepte.<dein-tailnet>.ts.net`
3. Grünes Schloss, keine Zertifikatswarnung
4. Diese Adresse dann auch im Kurzbefehl als Basis-URL eintragen

Den genauen Namen deines Tailnets zeigt die Admin-Konsole (etwas wie `pango-lin.ts.net`).

## Warum `TS_USERSPACE=true`

Normalerweise braucht Tailscale das Gerät `/dev/net/tun`. In einem **unprivilegierten
Proxmox-LXC** ist das nicht ohne Weiteres vorhanden — man müsste es erst umständlich
durchreichen (`lxc.cgroup2.devices.allow` plus Bind-Mount).

Im Userspace-Modus entfällt das vollständig, und für eingehendes `tailscale serve`
reicht er ohne Einschränkung aus. Echtes TUN bräuchtest du nur, wenn der Container
als Subnet-Router oder Exit-Node Verkehr für *andere* Geräte weiterleiten soll — beides
brauchen wir hier nicht.

## Funnel bleibt aus

Tailscale kann mit **Funnel** einen Dienst öffentlich ins Internet stellen. Das ist
hier bewusst **nicht** konfiguriert: Deine Rezept-App soll im Tailnet bleiben.

Der Bearer-Token schützt zwar zusätzlich, aber ein Dienst, den niemand von außen
erreichen kann, ist die deutlich ruhigere Variante.

## Wieder abschalten

```bash
docker compose --profile tailscale down
docker compose up -d      # Weg A läuft unverändert weiter
```
