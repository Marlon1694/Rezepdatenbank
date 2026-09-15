# Zugriff über deine UniFi-VPN

Der Dienst läuft nur in deinem Heimnetz. Damit der Kurzbefehl auch unterwegs
funktioniert, muss dein iPhone per VPN ins Heimnetz kommen.

Die Frage ist nicht *ob* das geht, sondern ob du die VPN **jedes Mal manuell
einschalten** musst. Das entscheidet eine einzige Zeile in deiner Konfiguration.

## Die entscheidende Zeile: `AllowedIPs`

In deiner WireGuard-Konfiguration steht im `[Peer]`-Block:

```ini
[Peer]
PublicKey = ...
Endpoint = dein-anschluss.example:51820
AllowedIPs = 0.0.0.0/0, ::/0     # ← diese Zeile
```

`AllowedIPs` legt fest, **welcher** Verkehr durch den Tunnel geht:

| Wert | Bedeutung | Alltag |
|---|---|---|
| `0.0.0.0/0, ::/0` | **Full Tunnel** — *aller* iPhone-Verkehr läuft über deinen Hausanschluss: Instagram, YouTube, alles | Langsamer (begrenzt durch deinen Upload), mehr Akkuverbrauch, und bei Internetausfall zu Hause ist dein iPhone offline. Schaltest du bewusst an und wieder aus. |
| `192.168.1.0/24` *(dein LAN)* | **Split Tunnel** — nur Verkehr *zu deinem Heimnetz* nimmt den Tunnel, alles andere geht normal über LTE/WLAN | Der Tunnel ist fast immer im Leerlauf → kein spürbarer Akku- oder Tempoverlust. **Das kannst du dauerhaft anlassen.** |

Ändere die Zeile also auf dein LAN-Subnetz:

```ini
AllowedIPs = 192.168.1.0/24
```

*(Ersetze `192.168.1.0/24` durch dein tatsächliches Subnetz. Mehrere Netze mit Komma
trennen.)*

## On-Demand: die VPN verbindet sich selbst

In der **WireGuard**-App:

1. Tunnel antippen → **Bearbeiten**
2. **On-Demand** aktivieren
3. Sowohl **WLAN** als auch **Mobilfunk** ankreuzen

iOS hält die Verbindung damit selbst am Leben und baut sie automatisch wieder auf.
Zusammen mit dem Split Tunnel ergibt das „einmal einrichten, nie wieder anfassen" —
du teilst aus TikTok und es funktioniert einfach.

> Möchtest du im heimischen WLAN keinen Tunnel, kannst du unter *On-Demand* dein
> Heim-WLAN als Ausnahme eintragen. Zu Hause bist du ohnehin schon im richtigen Netz.

## Wenn du UniFi Teleport benutzt

Teleport ist UniFis eigene VPN aus der UniFi-App. Sie ist **Full Tunnel** und wird
manuell eingeschaltet — die obigen Einstellungen gibt es dort nicht. Du hättest also
vor jedem Teilen zwei zusätzliche Taps.

Zwei Auswege:

1. **In UniFi zusätzlich einen WireGuard-VPN-Server anlegen**
   (*Settings → VPN → VPN Server → WireGuard*), das Profil per QR-Code aufs iPhone
   holen und wie oben einrichten.
2. **Tailscale benutzen** — siehe `docs/tailscale.md`. Das ist ohnehin die
   angenehmere Lösung: von Haus aus Split Tunnel, auf Dauerbetrieb ausgelegt, und
   du bekommst echtes HTTPS dazu.

## Prüfen, ob es klappt

Auf dem iPhone, mit **deaktiviertem WLAN** (also über Mobilfunk):

1. VPN aktiv? (Settings zeigt oben `VPN`)
2. Safari öffnen → `http://<server-ip>:3000` → die Web-App muss erscheinen
3. Flugmodus kurz an und wieder aus, dann erneut versuchen — mit On-Demand muss es
   ohne manuelles Einschalten funktionieren

## Nur zu Hause reicht dir?

Völlig in Ordnung. Dann brauchst du gar keine VPN: Im heimischen WLAN ist
`http://<server-ip>:3000` direkt erreichbar, und der Kurzbefehl funktioniert dort
genauso. Unterwegs gesehene Rezepte sammelst du dann eben, bis du zu Hause bist.
