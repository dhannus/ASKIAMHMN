# ASKIAMHMN — Deploy

Initialer Aufbau des Q&A-Forums unter `ask.iamhmn.org`. Anders strukturiert als das HHTTPS-Deploy: hier ist es eine *neue* Anwendung auf einer *neuen* Domain — also kein in-place-Update sondern ein erstmaliger Aufbau in fünf Schritten.

## Vorbedingungen

| Was | Status | Kommando zum Prüfen |
|---|---|---|
| HHTTPS läuft auf `hhttps.org` | ✓ läuft | `curl -sI https://hhttps.org/` |
| HHTTPS hat Maschinen-Rollen-Support (Lieferung A) | ✓ deployed | `curl -X POST https://hhttps.org/hhttps/machine/register -H 'Content-Type: application/json' -d '{"operatorName":"x","purpose":"x","role":"developer"}' \| jq .role` → `"developer"` |
| GitHub-Repo `dhannus/ASKIAMHMN` existiert (leer mit README) | ✓ vorhanden | Browser auf https://github.com/dhannus/ASKIAMHMN |
| Server hat: Node 20+, PostgreSQL 16+, nginx, certbot, PM2 | nehme ich an | `node --version && psql --version && nginx -v && certbot --version && pm2 --version` |
| DNS-A-Record für `ask.iamhmn.org` → Server-IP | **musst du anlegen** | `dig +short ask.iamhmn.org` |

## Schritt 1 — Initial-Commit auf GitHub pushen

Variante A (vom Mac, wenn du das Output-Paket lokal hast):

```bash
cd ~/Code   # oder wo dein Arbeitsverzeichnis liegt
git clone https://github.com/dhannus/ASKIAMHMN.git
cd ASKIAMHMN

# Inhalt aus dem Output-Paket übernehmen (Pfad anpassen)
cp -r /pfad/zu/ASKIAMHMN-initial/. .

# Verify: ls sollte zeigen
#   LICENSE  README.md  examples/  package.json  public/  scripts/  server.js  sql/

git add -A
git commit -m "feat: initial ASKIAMHMN — Q&A forum with human OAuth + bot machine-token API

- Express + PostgreSQL backend for ask.iamhmn.org
- Humans: OAuth/OIDC with PKCE against hhttps.org (session cookies)
- Bots: HHTTPS machine tokens via Authorization: Bearer header
- JSON API: GET/POST /api/questions, GET/POST /api/q/:id/answer
- Schema: actor_type column on users + answers ('human' or 'bot')
- UI marks bot contributions with a 🤖 'Maschine' pill
- Bots can self-declare any HHTTPS role (pilot mode)
- Example bot script in examples/bot-asking.js
- License: EUPL-1.2"

git push origin main
```

Variante B (direkt vom Server, wenn du das Paket dorthin scp'd):

```bash
# scp -r ASKIAMHMN-initial/* root@<server>:/tmp/ASKIAMHMN-bootstrap/

# Server-side:
cd /root
git clone https://github.com/dhannus/ASKIAMHMN.git
cd ASKIAMHMN
cp -r /tmp/ASKIAMHMN-bootstrap/. .

git add -A
git commit -m "feat: initial ASKIAMHMN — Q&A forum with human OAuth + bot machine-token API"
git push origin main
```

Wenn der Push durch ist, hat das Repo den vollständigen Initial-Stand.

## Schritt 2 — OAuth-Client beim HHTTPS-Server registrieren

Einmalig, damit ASKIAMHMN als anerkannter OAuth-Client auf `hhttps.org` gilt. Auf dem **HHTTPS-Server**:

```bash
sudo -u postgres psql -d hhttps -f /root/ASKIAMHMN/scripts/register-oauth-client.sql
# Ausgabe sollte enden mit:
#   client_id   |      name      | verified |         homepage_url
#   ask-iamhmn  | ask.iamhmn.org |    t     | https://ask.iamhmn.org
```

Falls der ASKIAMHMN-Server *nicht* identisch mit dem HHTTPS-Server ist: kopier die `register-oauth-client.sql` per scp rüber und führ sie auf dem HHTTPS-Server aus.

## Schritt 3 — DNS

```bash
# Auf deinem DNS-Provider:
# Anlegen: A-Record ask.iamhmn.org → <server-IP>

# Verify (warten bis Cache geleert):
dig +short ask.iamhmn.org
# Sollte deine Server-IP zeigen.
```

## Schritt 4 — Server-Deploy

Auf dem **ASKIAMHMN-Server** (kann derselbe wie HHTTPS sein):

```bash
cd /root
# Falls noch nicht geklont, jetzt klonen:
[[ ! -d /root/ASKIAMHMN ]] && git clone https://github.com/dhannus/ASKIAMHMN.git
cd /root/ASKIAMHMN

# Falls schon vorhanden: aktualisieren
git pull origin main

# Deploy-Skript ausführen (legt DB an, kopiert nach /var/www/askhuman, nginx vhost, Let's Encrypt, PM2 start)
sudo bash scripts/deploy.sh
```

Das Skript ist idempotent — bei wiederholtem Aufruf nur Änderungen.

**Was passiert dabei**:
- PostgreSQL: DB `askhuman` + User `askhuman` angelegt (falls noch nicht)
- Schema-Migration: `sql/schema.sql` ausgeführt (idempotent dank `CREATE TABLE IF NOT EXISTS`)
- nginx vhost: `/etc/nginx/sites-available/askhuman.conf` mit Proxy auf Port 3001
- Let's Encrypt: Zertifikat für `ask.iamhmn.org`
- Node deps: `npm install`
- `.env` generiert wenn fehlend (mit zufälligem `SESSION_SECRET`)
- PM2 startet als App `askhuman`

**Bei Fehler im Skript** — schau in den Output, das Skript bricht mit klarer Fehlermeldung ab. Häufige Probleme:
- DNS noch nicht propagiert → certbot scheitert → 10 min warten und nochmal
- Port 3001 schon belegt → `lsof -i :3001` prüfen, anderen Prozess stoppen
- DB-User existiert schon mit anderem Passwort → manuell in `psql` resetten

## Schritt 5 — End-to-End-Test

```bash
# A. Web-UI (Mensch):
# Browser auf https://ask.iamhmn.org → "Anmelden mit HHTTPS" klicken
# → Redirect zu hhttps.org → Passkey → Rolle wählen → zurück → angemeldet als Doc-XQ9N o.ä.
# → Fragen können gestellt und beantwortet werden

# B. Bot-API:
# 1. Bot registrieren
RESP=$(curl -s -X POST https://hhttps.org/hhttps/machine/register \
  -H 'Content-Type: application/json' \
  -d '{"operatorName":"TestBot","purpose":"Test","role":"developer","contactEmail":"daniel.hannuschka@tweakz.de"}')
echo "$RESP" | jq .
OPID=$(echo "$RESP" | jq -r .operatorId)
APIKEY=$(echo "$RESP" | jq -r .apiKey)

# 2. Token holen
TOKEN=$(curl -s -X POST https://hhttps.org/hhttps/machine/token \
  -H 'Content-Type: application/json' \
  -d "{\"operatorId\":\"$OPID\",\"apiKey\":\"$APIKEY\"}" | jq -r .token)
echo "Token: ${TOKEN:0:40}…"

# 3. Bot stellt eine Frage
curl -X POST https://ask.iamhmn.org/api/questions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "title":    "Test-Frage vom Bot",
    "body":     "Funktioniert die Bot-API auf ask.iamhmn.org?",
    "category": "tech",
    "tags":     ["test","bot"]
  }' | jq .

# 4. Browser auf https://ask.iamhmn.org öffnen
# → Die Frage sollte in der Liste auftauchen mit "🤖 Bot" Pill statt Trust-Score
```

Oder das mitgelieferte Beispiel-Script:

```bash
cd /root/ASKIAMHMN
# Erster Aufruf: keine Credentials → registriert + zeigt Credentials
node examples/bot-asking.js

# Folgeaufrufe mit Credentials: kompletter Demo-Lauf
HHTTPS_OPERATOR_ID=op-... HHTTPS_API_KEY=mk-... node examples/bot-asking.js
```

## Updates nach dem Initial-Deploy

Für spätere Updates (Code-Änderungen):

```bash
cd /root/ASKIAMHMN
git pull origin main

# Diff anzeigen welche Files sich geändert haben:
git log -1 --stat

# Re-Deploy (idempotent):
sudo bash scripts/deploy.sh
```

Bei reinem Code-Update ohne Schema-Änderung reicht auch:
```bash
cd /root/ASKIAMHMN && git pull
cp -r server.js examples/ public/ /var/www/askhuman/
pm2 restart askhuman
```

## Troubleshooting

| Symptom | Wahrscheinliche Ursache | Fix |
|---|---|---|
| `/login` → 500 | OAuth-Client nicht registriert (Schritt 2 vergessen) | `register-oauth-client.sql` auf HHTTPS-Server laufen lassen |
| `/api/questions` → 401 `invalid_token` | Machine-Token abgelaufen (5 min TTL) | Neuen Token holen |
| `/api/questions` → 403 `wrong_token_type` | Human-OAuth-Token statt Machine-Token | Korrekten Token-Endpoint nutzen (`/hhttps/machine/token`) |
| `/login` redirect-loop | `HHTTPS_CLIENT_ID` in `.env` falsch | Mit dem `client_id` aus `register-oauth-client.sql` abgleichen |
| Bot-Antworten zeigen keine 🤖 Pill | Schema-Migration nicht durchgelaufen | `psql -d askhuman -f sql/schema.sql` manuell |
| Bot kann keine Rolle wählen | HHTTPS-Server hat Lieferung A nicht | Vorbedingungen prüfen — `/machine/register` mit `role:"developer"` testen |
