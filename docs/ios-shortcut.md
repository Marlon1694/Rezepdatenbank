# Der Kurzbefehl fürs iPhone

Ziel: In TikTok, Instagram oder YouTube auf **Teilen** tippen, deinen Kurzbefehl
wählen — fertig. Kein App Store, keine Installation.

Du brauchst zweierlei:

- **Basis-URL** — `http://192.168.1.50:3000` (deine Server-IP) oder
  `https://rezepte.<tailnet>.ts.net`, falls du Tailscale nutzt
- **Token** — der Wert von `APP_TOKEN` aus der `.env`

---

## Variante 1: Eine Aktion (empfohlen)

Der Kurzbefehl öffnet nur eine Adresse — die Web-App schickt den Link dann selbst
ab. Kein Header, kein JSON, keine Fehlerquellen.

Deine fertige Adresse steht unter `http://<server-ip>:3000/setup` zum Kopieren.
Sie sieht so aus, mit dem `?url=` am Ende:

```
http://192.168.1.50:3000/?url=
```

1. **Kurzbefehle** öffnen → **+** → oben auf den Namen tippen → *Rezept erfassen*
2. Auf das **Info-Symbol** tippen und **Bei Teilen-Blatt anzeigen** einschalten.
   Bei *Teilen-Blatt-Typen* alles abwählen außer **URLs** und **Text**.
3. Aktion **„URL öffnen"** hinzufügen (im Suchfeld danach suchen)
4. Adresse von oben in das Feld einfügen
5. Ans **Ende** des Feldes tippen und aus der Variablenleiste über der Tastatur
   **Kurzbefehlseingabe** wählen

Fertig. Das Feld enthält dann die Adresse und direkt dahinter die blaue Variable.

> **Der häufigste Fehler:** Steht dort das Wort „Kurzbefehlseingabe" als normaler
> Text statt als blaue Variable, kommt beim Server keine URL an. Antippen und aus
> der Leiste über der Tastatur auswählen.

Richtig sieht das Feld so aus — Adresse mit `?url=` am Ende, direkt gefolgt von der
blauen Variablen:

```
http://192.168.1.50:3000/?url=[Kurzbefehlseingabe]
```

Bei **„… von Share-Sheet erhalten"** oben lohnt es sich, die Eingabetypen auf
**URLs** und **Text** einzugrenzen. Sonst nimmt der Kurzbefehl auch Bilder entgegen,
mit denen er nichts anfangen kann.

Beim ersten Teilen fragt die Web-App einmalig nach dem Token. Danach nie wieder —
der Link wird dann sofort erfasst, du siehst kurz die Bestätigung und wechselst zurück.

### Was passiert

Safari öffnet sich kurz, zeigt „✓ … eingereiht" und du gehst zurück. Das ist der
einzige Unterschied zum API-Weg unten, der still im Hintergrund läuft — dafür ist
hier nichts einzustellen, was schiefgehen kann.

## Variante 2: Im Hintergrund (API)

Ohne Browserfenster, dafür mit Header und JSON-Anfragetext. Nimm diesen Weg, wenn
Variante 1 läuft und dich das kurze Aufblitzen von Safari stört.

Werte wieder unter `/setup`.

**Aktion 1 — „Text"**
```
http://192.168.1.50:3000
```

**Aktion 2 — „Inhalte von URL abrufen"**

| Feld | Wert |
|---|---|
| URL | die Variable `Text` + `/api/jobs` dahinter getippt |
| Methode | **POST** |
| Header | `Authorization` = `Bearer DEIN_TOKEN` |
| Anfragetext | **JSON** |
| → Feld | `url` (Typ *Text*) = **Kurzbefehlseingabe** |

**Aktion 3 — „Mitteilung anzeigen"** mit einem beliebigen Text.

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
