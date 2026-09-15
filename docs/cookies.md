# Cookies für Instagram und YouTube

Instagram verlangt inzwischen praktisch für jeden Abruf einen Login. YouTube fragt
zunehmend ebenfalls nach, besonders bei Zugriffen aus Rechenzentren und von Servern,
die häufig abrufen.

TikTok und die meisten Food-Blogs funktionieren ohne.

## Cookies exportieren

**Nimm Firefox.** Chrome verschlüsselt seinen Cookie-Speicher seit Version 127 unter
Windows so, dass externe Werkzeuge ihn nicht mehr lesen können. Firefox legt seine
Cookies in einer schlichten SQLite-Datei ab und funktioniert deshalb zuverlässig.

1. Firefox installieren, bei Instagram (und/oder YouTube) anmelden
2. Erweiterung **„cookies.txt"** installieren
   ([Firefox Add-ons](https://addons.mozilla.org/firefox/addon/cookies-txt/))
3. Auf instagram.com die Erweiterung öffnen → **Export** → als `cookies.txt` speichern
4. Datei auf den Server legen:

```bash
scp cookies.txt root@<server-ip>:/opt/rezepte/config/cookies.txt
docker compose restart app
```

Die Datei wird automatisch erkannt — sie muss unter `config/cookies.txt` liegen (oder
dort, wohin `COOKIES_FILE` in der `.env` zeigt).

## Alternative: direkt aus dem Browser auf dem Server

Läuft auf dem Server ein Firefox mit angemeldetem Konto:

```bash
yt-dlp --cookies-from-browser firefox --cookies config/cookies.txt --skip-download <url>
```

Das ist auf einem LXC ohne Oberfläche allerdings selten der Fall.

## Sicherheit

`config/cookies.txt` enthält gültige Anmelde-Sitzungen für dein Konto. Wer die Datei
hat, ist bei Instagram als du angemeldet.

- Die Datei steht in `.gitignore` und landet **nicht** im Repository
- Sie liegt nur auf deinem eigenen Server
- Bei Verdacht: bei Instagram *Einstellungen → Sicherheit → Aktive Sitzungen* abmelden,
  dann sind die Cookies wertlos

Erwäge einen Zweitaccount, wenn dir dabei unwohl ist.

## Haltbarkeit

Instagram-Cookies halten typischerweise einige Wochen bis Monate. Wenn Reels plötzlich
wieder fehlschlagen, ist meist einfach die Sitzung abgelaufen — dann exportierst du
die Datei neu.

Die Web-App zeigt in so einem Fall die Meldung:

> *Die Plattform verlangt einen Login. Hinterlege Cookies unter config/cookies.txt*

## TikTok: "Unexpected response from webpage request"

Das ist kein Cookie-Problem. TikTok laesst nur Anfragen durch, die den
TLS-Fingerabdruck eines echten Browsers vorweisen. yt-dlp kann das, braucht dafuer
aber die Bibliothek `curl_cffi`. Fehlt sie, meldet

```bash
docker compose exec app yt-dlp --list-impersonate-targets
```

hinter jedem Eintrag `(unavailable)` - und TikTok schlaegt zuverlaessig fehl.

Im Image ist sie ueber `yt-dlp[default,curl-cffi]` enthalten. Solltest du yt-dlp
anderswo von Hand installiert haben:

```bash
pip install -U "yt-dlp[default,curl-cffi]"
```

Bleibt es dabei, ist meist der Extraktor selbst veraltet: TikTok aendert seine
Seite haeufig, und Korrekturen erscheinen erst im naechtlichen Kanal
(`YTDLP_CHANNEL=nightly`, Standard), im stabilen erst Wochen spaeter.

## Wenn es trotz Cookies nicht geht

1. **yt-dlp aktualisieren.** Die Plattformen ändern ständig etwas; das ist mit Abstand
   die häufigste Ursache. Der Container tut das beim Start automatisch
   (`YTDLP_AUTO_UPDATE=true`). Manuell:
   ```bash
   docker compose exec app pip install -U yt-dlp
   docker compose restart app
   ```
2. **Privates Konto?** Nicht-öffentliche Beiträge sind auch mit Cookies nur abrufbar,
   wenn dein Konto dem Profil folgt.
3. **Zu viele Abrufe.** Instagram drosselt. Ein paar Stunden warten hilft meist.
