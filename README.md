# 🏴‍☠️ PirateRadio

Ζωντανό ραδιόφωνο από το browser. Ένας/μία broadcaster ανοίγει μια σελίδα, πατάει
"On Air", και οι ακροατές ακούνε από ένα απλό link — καμία εγκατάσταση.

## Πώς δουλεύει

```
[broadcaster browser]  --WebSocket-->  [bridge/server.js]  --HTTP PUT-->  [Icecast]  <--HTTP-- [listener <audio>]
```

- **Icecast** είναι ο streaming server — δέχεται ένα live audio feed και το
  αναμεταδίδει σε όσους ανοίγουν το mount URL.
- **bridge/** είναι ένα μικρό Node server: παίρνει το mic audio από τον
  broadcaster μέσω WebSocket και το προωθεί στο Icecast (ο browser δεν μπορεί
  να μιλήσει απευθείας το πρωτόκολλο source του Icecast).
- **broadcaster/** είναι η σελίδα που ανοίγει όποιος κάνει εκπομπή.
- **listener/** είναι η σελίδα/link που ανοίγουν οι ακροατές.

Μόνο ένας broadcaster μπορεί να είναι on-air τη φορά.

## Local test (πριν πάει live)

1. **Icecast**
   ```
   docker compose up -d
   ```
   Πριν το τρέξεις, άλλαξε τους κωδικούς μέσα στο `icecast.xml`
   (`source-password`, `admin-password`).

2. **Bridge**
   ```
   cd bridge
   cp .env.example .env   # βάλε τους ίδιους κωδικούς με το icecast.xml
   npm install
   npm start
   ```

3. **Broadcaster page**: άνοιξε `broadcaster/index.html` σε browser (ή σέρβιρέ το
   με έναν static server), βάλε τον κωδικό εκπομπής και `ws://localhost:3001`,
   πάτα On Air.

4. **Listener page**: άνοιξε `listener/index.html` — θα ακούς ό,τι λέγεται στο
   μικρόφωνο του broadcaster σχεδόν σε πραγματικό χρόνο.

## Deploy (ώστε να δουλεύει έξω από το τοπικό δίκτυο)

Χρειάζεσαι ένα μικρό cloud VPS/PaaS (π.χ. Fly.io, Railway, DigitalOcean droplet
$5-6/μήνα) ώστε να μην εξαρτάσαι από το firewall του γραφείου:

1. Ανέβασε το `docker-compose.yml` + `icecast.xml` στο VPS και κάνε
   `docker compose up -d` εκεί (άνοιξε port 8000 στο firewall).
2. Τρέξε το `bridge/server.js` στο ίδιο VPS (ή σε PaaS όπως Railway), με
   `ICECAST_HOST=localhost` (ή το internal hostname) και άνοιξε το
   `BRIDGE_PORT` (π.χ. 3001) — χρησιμοποίησε `wss://` (TLS) αν το PaaS σου
   δίνει HTTPS, αλλιώς browsers μπορεί να μπλοκάρουν mixed content.
3. Άλλαξε στο `broadcaster/index.html` το default bridge URL, και στο
   `listener/index.html` το `src` του `<audio>` ώστε να δείχνουν στο public
   hostname του VPS (π.χ. `https://radio.example.com:8000/radio.webm`).
4. Σέρβιρε τα `broadcaster/` και `listener/` σαν static σελίδες (μπορούν να
   μείνουν και στο ίδιο VPS, π.χ. πίσω από nginx / Caddy).
5. Βάλε πραγματικούς, τυχαίους κωδικούς παντού πριν το ανοίξεις σε
   οποιονδήποτε — `source-password`/`admin-password` στο `icecast.xml` και
   `ICECAST_SOURCE_PASSWORD`/`BROADCAST_PASSWORD` στο `bridge/.env`.

## Επόμενα βήματα (προαιρετικά)

- Πιο ωραίο listener player (station name, "on air" indicator, ένταση).
- Login για broadcaster μέσω κάτι καλύτερου από shared password.
- Καταγραφή/replay παλιών εκπομπών.
