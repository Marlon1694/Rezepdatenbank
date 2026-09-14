# Der Kurzbefehl fürs iPhone

Ziel: In TikTok, Instagram oder YouTube auf **Teilen** tippen, deinen Kurzbefehl
wählen — fertig. Kein App Store, keine Installation.

Du brauchst zweierlei:

- **Basis-URL** — `http://192.168.1.50:3000` (deine Server-IP) oder
  `https://rezepte.<tailnet>.ts.net`, falls du Tailscale nutzt
- **Token** — der Wert von `APP_TOKEN` aus der `.env`

---

## Variante 1: Feuer und vergiss

Reicht völlig: Link abschicken, Bestätigung sehen, das Rezept landet im Hintergrund
in Notion.

1. **Kurzbefehle** öffnen → **+** → oben auf den Namen tippen → *Rezept erfassen*
2. **ⓘ (Info)** → **Bei Teilen-Blatt anzeigen** einschalten
3. Darunter bei **Teilen-Blatt-Typen** alles abwählen außer **URLs** und **Text**
4. Aktionen hinzufügen:

**Aktion 1 — „Text"**
```
http://192.168.1.50:3000
```
*(deine Basis-URL, ohne Schrägstrich am Ende)*

**Aktion 2 — „Inhalte von URL abrufen"**

| Feld | Wert |
|---|---|
| URL | `Text` (die Variable aus Aktion 1) + `/api/jobs` direkt dahinter tippen |
| Methode | **POST** |
| Header | `Authorization` = `Bearer DEIN_TOKEN` |
| Anfragetext | **JSON** |
| → Feld | `url` (Typ *Text*) = **Kurzbefehlseingabe** |

**Aktion 3 — „Mitteilung anzeigen"**
```
Rezept wird verarbeitet …
```

Fertig.

> **Zum JSON-Feld:** Auf *Neues Feld hinzufügen* → **Text** → als Schlüssel `url`
> eintippen. Für den Wert ins Feld tippen, dann in der Variablenleiste über der
> Tastatur **Kurzbefehlseingabe** wählen. Steht dort stattdessen der Text
> „Kurzbefehlseingabe" als Buchstaben, ist es keine Variable und es funktioniert nicht.

---

## Variante 2: Mit Rückmeldung

Wartet, bis das Rezept fertig ist, und zeigt eine Mitteilung mit dem Notion-Link.
Dauert je nach Video ein paar Sekunden bis zwei Minuten.

Aktionen 1 und 2 wie oben, danach:

**Aktion 3 — „Wörterbuchwert abrufen"**
Schlüssel `id` aus *Inhalte von URL abrufen* → benenne das Ergebnis `JobID`.

**Aktion 4 — „Wiederholen" (30-mal)**

Darin:

1. **Warten** — `5` Sekunden
2. **Inhalte von URL abrufen**
   - URL: `Text` + `/api/jobs/` + `JobID`
   - Methode: **GET**
   - Header: `Authorization` = `Bearer DEIN_TOKEN`
3. **Wörterbuchwert abrufen** — Schlüssel `status`
4. **Wenn** *Wert* **ist** `done`
   - **Wörterbuchwert abrufen** — Schlüssel `notionPageUrl` aus Schritt 2
   - **Mitteilung anzeigen** — Text: das Ergebnis
   - **Aus Kurzbefehl austreten**
5. **Sonst wenn** *Wert* **ist** `failed`
   - **Wörterbuchwert abrufen** — Schlüssel `error`
   - **Mitteilung anzeigen** — das Ergebnis
   - **Aus Kurzbefehl austreten**

---

## Web-App auf den Home-Screen

1. Safari öffnen → deine Basis-URL aufrufen
2. **Teilen** → **Zum Home-Bildschirm**
3. Beim ersten Start das Token eingeben — es wird im Browser gespeichert

Dort siehst du den Verlauf, kannst Rezepte vor dem Speichern korrigieren und
fehlgeschlagene Durchläufe wiederholen.

> Über HTTP bekommst du ein Icon und die Vollbild-Darstellung. Offline-Funktionen
> (Service Worker) verlangen HTTPS — dafür gibt es `docs/tailscale.md`. Für diese App
> ist das folgenlos, sie braucht den Server ohnehin.

---

## Wenn der Kurzbefehl fehlschlägt

| Meldung | Ursache |
|---|---|
| „Der Vorgang konnte nicht abgeschlossen werden" | Kein Netz zum Server — ist die VPN aktiv? Siehe `docs/vpn-zugriff.md` |
| `Nicht autorisiert. Stimmt das Token?` | Tippfehler im Header. Er muss lauten: `Bearer ` **mit Leerzeichen**, dann das Token |
| `Bitte eine gültige http(s)-URL schicken` | Der JSON-Wert ist Text statt Variable (siehe Hinweis oben) |
| Nichts passiert, keine Meldung | In der Web-App unter Verlauf nachsehen — dort steht der Fehler im Klartext |

**Test ohne iPhone**, vom Rechner aus:

```bash
curl -X POST http://192.168.1.50:3000/api/jobs \
  -H "Authorization: Bearer DEIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=..."}'
```
