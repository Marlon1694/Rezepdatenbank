#!/usr/bin/env bash
#
# Einrichtung in einem Durchlauf.
#
#   bash setup.sh
#
# Fragt die drei Zugangsdaten ab, prueft jede einzeln gegen die echte API,
# startet den Container und richtet die Notion-Zuordnung ein.

set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
YELLOW=$'\033[33m'; BLUE=$'\033[34m'; OFF=$'\033[0m'

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$OFF"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$OFF" "$*"; }
die()  { printf '\n  %s✗ %s%s\n\n' "$RED" "$*" "$OFF" >&2; exit 1; }

cd "$(dirname "$0")"

cat <<BANNER

  ${BOLD}🍲 Rezeptdatenbank — Einrichtung${OFF}

  Ich frage gleich drei Zugangsdaten ab und pruefe jede sofort,
  damit du nicht erst beim ersten Rezept merkst, dass etwas fehlt.

  Bereitlegen:
    1. Notion-Integration-Token   notion.so/profile/integrations
    2. Notion-Datenbank-ID        aus der URL deiner Rezept-Datenbank
    3. Gemini-API-Key             aistudio.google.com  (kostenlos)

  Details dazu: docs/notion.md
BANNER

# ── Voraussetzungen ──────────────────────────────────────────────────────────
step "Voraussetzungen"

command -v docker >/dev/null 2>&1 || die "Docker fehlt. Installieren mit:
     curl -fsSL https://get.docker.com | sh"
ok "Docker $(docker --version | sed 's/Docker version //; s/,.*//')"

docker compose version >/dev/null 2>&1 || die "Docker Compose fehlt (Plugin 'docker-compose-plugin')."
ok "Docker Compose"

docker info >/dev/null 2>&1 || die "Der Docker-Daemon laeuft nicht oder ist nicht erreichbar.
     Im Proxmox-LXC ist meist die Option 'Nesting' nicht gesetzt:
       pct set <CTID> --features nesting=1
     Danach den Container neu starten. Siehe docs/proxmox.md"
ok "Docker-Daemon erreichbar"

command -v curl >/dev/null 2>&1 || die "curl fehlt:  apt install -y curl"

# ── Bestehende .env ──────────────────────────────────────────────────────────
if [ -f .env ]; then
  warn ".env existiert bereits."
  read -r -p "  Neu anlegen? Bestehende Werte gehen verloren. [j/N] " answer
  case "$answer" in
    [jJyY]*) cp .env ".env.backup.$(date +%Y%m%d-%H%M%S)"
             ok "Sicherung angelegt: .env.backup.*" ;;
    *) say ""; say "  Abgebrochen. Zum Starten:  docker compose up -d --build"; exit 0 ;;
  esac
fi

# ── Zugangsdaten ─────────────────────────────────────────────────────────────
step "Notion"

say ""
say "  ${DIM}Wichtig: Die Integration muss in deiner Datenbank freigegeben sein —${OFF}"
say "  ${DIM}Datenbank oeffnen -> ••• -> Verbindungen -> Integration hinzufuegen.${OFF}"
say "  ${DIM}Ohne diesen Schritt sieht die API sie nicht, egal wie gut das Token ist.${OFF}"
say ""

while :; do
  read -r -s -p "  Notion-Token (ntn_…): " NOTION_TOKEN; echo
  [ -n "$NOTION_TOKEN" ] || { warn "Bitte eingeben."; continue; }

  read -r -p "  Notion-Datenbank-ID  : " NOTION_DATABASE_ID
  NOTION_DATABASE_ID="$(printf '%s' "$NOTION_DATABASE_ID" | tr -d ' ')"

  # Falls die ganze URL eingefuegt wurde: die ID herausloesen.
  # Notion schreibt sie in zwei Formen - 32 Hex-Zeichen am Stueck oder als UUID
  # mit Bindestrichen. Beide muessen erkannt werden, ohne die UUID zu zerschneiden.
  if printf '%s' "$NOTION_DATABASE_ID" | grep -q 'notion\.so'; then
    path="${NOTION_DATABASE_ID%%\?*}"
    found="$(printf '%s' "$path" | grep -oE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}' | tail -1)"
    if [ -n "$found" ]; then
      NOTION_DATABASE_ID="$found"
      say "  ${DIM}Aus der URL gelesen: $NOTION_DATABASE_ID${OFF}"
    else
      warn "In dieser URL steckt keine erkennbare Datenbank-ID."
      say "     ${DIM}Sie besteht aus 32 Zeichen (0-9, a-f), meist direkt vor dem '?v='.${OFF}"
      say ""
      continue
    fi
  fi
  [ -n "$NOTION_DATABASE_ID" ] || { warn "Bitte eingeben."; continue; }

  printf '  Pruefe … '
  response="$(curl -s -w '\n%{http_code}' \
    -H "Authorization: Bearer $NOTION_TOKEN" \
    -H "Notion-Version: 2025-09-03" \
    "https://api.notion.com/v1/databases/$NOTION_DATABASE_ID" 2>/dev/null || true)"
  code="$(printf '%s' "$response" | tail -n1)"
  body="$(printf '%s' "$response" | sed '$d')"

  case "$code" in
    200)
      title="$(printf '%s' "$body" | grep -o '"plain_text":"[^"]*"' | head -1 | cut -d'"' -f4)"
      echo; ok "Verbunden mit: ${title:-（ohne Titel）}"
      break ;;
    401)
      echo; warn "Token wurde abgelehnt. Tippfehler, oder es ist kein Internal Integration Secret." ;;
    404)
      echo
      warn "Datenbank nicht gefunden."
      say "     ${DIM}Fast immer ist die Integration nicht mit der Datenbank geteilt:${OFF}"
      say "     ${DIM}Datenbank -> ••• -> Verbindungen -> deine Integration hinzufuegen.${OFF}"
      say "     ${DIM}Seltener: die ID stimmt nicht (32 Zeichen vor dem ?v= in der URL).${OFF}" ;;
    000)
      echo
      warn "Keine Verbindung zu api.notion.com."
      say "     ${DIM}Hat der Container/Server Internetzugang? Teste:  curl -I https://api.notion.com${OFF}" ;;
    *)
      echo; warn "Notion antwortete mit HTTP $code." ;;
  esac
  say ""
done

step "Gemini"
say ""
say "  ${DIM}Kostenlos unter aistudio.google.com -> 'Get API key'. Keine Kreditkarte.${OFF}"
say ""

while :; do
  read -r -s -p "  Gemini-API-Key: " GEMINI_API_KEY; echo
  [ -n "$GEMINI_API_KEY" ] || { warn "Bitte eingeben."; continue; }

  printf '  Pruefe … '
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" 2>/dev/null || true)"

  case "$code" in
    200) echo; ok "Key gueltig"; break ;;
    400|403) echo; warn "Key wurde abgelehnt. Nochmal aus dem AI Studio kopieren." ;;
    000)
      echo
      warn "Keine Verbindung zu Google."
      say "     ${DIM}Teste:  curl -I https://generativelanguage.googleapis.com${OFF}" ;;
    *) echo; warn "Google antwortete mit HTTP $code." ;;
  esac
  say ""
done

# ── .env schreiben ───────────────────────────────────────────────────────────
step "Konfiguration schreiben"

APP_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

umask 077
sed \
  -e "s|^APP_TOKEN=.*|APP_TOKEN=$APP_TOKEN|" \
  -e "s|^NOTION_TOKEN=.*|NOTION_TOKEN=$NOTION_TOKEN|" \
  -e "s|^NOTION_DATABASE_ID=.*|NOTION_DATABASE_ID=$NOTION_DATABASE_ID|" \
  -e "s|^GEMINI_API_KEY=.*|GEMINI_API_KEY=$GEMINI_API_KEY|" \
  .env.example > .env
umask 022

ok ".env angelegt (nur fuer dich lesbar)"
ok "Zugriffs-Token automatisch erzeugt"

# ── Bauen und starten ────────────────────────────────────────────────────────
step "Container bauen und starten"
say "  ${DIM}Das dauert beim ersten Mal einige Minuten.${OFF}"
say ""

docker compose up -d --build

printf '\n  Warte auf den Dienst '
for _ in $(seq 1 60); do
  if curl -sf --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    echo; ok "Laeuft"
    break
  fi
  printf '.'
  sleep 2
done

curl -sf --max-time 5 http://127.0.0.1:3000/api/health >/dev/null 2>&1 || {
  echo
  die "Der Dienst antwortet nicht. Protokoll ansehen mit:
     docker compose logs app"
}

# ── Notion-Zuordnung ─────────────────────────────────────────────────────────
step "Notion-Spalten zuordnen"
docker compose exec -T app npx tsx scripts/inspect-notion-db.ts || \
  warn "Die Spaltenanzeige ist fehlgeschlagen — von Hand: docker compose exec app npx tsx scripts/inspect-notion-db.ts"

# ── Fertig ───────────────────────────────────────────────────────────────────
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-<server-ip>}"

cat <<DONE

${BOLD}  Fertig.${OFF}

  ${BOLD}Web-App${OFF}
    http://$IP:3000
    Beim ersten Start fragt sie nach dem Token (siehe unten).

  ${BOLD}Dein Zugriffs-Token${OFF}
    ${BLUE}$APP_TOKEN${OFF}
    Steht auch in der .env. Der Kurzbefehl braucht es als Header:
      Authorization: Bearer $APP_TOKEN

  ${BOLD}Naechste Schritte${OFF}
    1. Web-App im Browser oeffnen und einen Rezept-Link ausprobieren
    2. Kurzbefehl fuers iPhone anlegen      -> docs/ios-shortcut.md
       (die fertigen Werte zeigt dir auch  http://$IP:3000/setup )
    3. VPN auf Dauerbetrieb einstellen      -> docs/vpn-zugriff.md
    4. Nur fuer Instagram noetig: Cookies   -> docs/cookies.md

  ${BOLD}Schnelltest von hier aus${OFF}
    curl -X POST http://127.0.0.1:3000/api/jobs \\
      -H "Authorization: Bearer $APP_TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{"url":"https://www.youtube.com/watch?v=..."}'

DONE
