# 🏴‍☠️ PirateRadio

Ζωντανό ραδιόφωνο από το browser. Ένας/μία broadcaster ανοίγει μια σελίδα,
πατάει "On Air", και οι ακροατές ακούνε από ένα απλό link — καμία εγκατάσταση
στη δική τους συσκευή.

## Πώς δουλεύει

```
[broadcaster browser] --WebSocket--> [bridge: Render, ffmpeg] --Icecast protocol--> [Icecast: Fly.io, MP3] <--HTTP-- [listener <audio>]
```

- **Icecast** (`icecast/`) — ο streaming server, τρέχει στο **Fly.io**. Δέχεται
  το live audio (MP3) και το αναμεταδίδει σε όποιον ανοίγει το mount URL.
- **bridge** (`bridge/`) — μικρό Node server, τρέχει στο **Render**. Παίρνει
  το mic audio (webm/opus) από τον broadcaster μέσω WebSocket και το περνάει
  σε ένα `ffmpeg` process που το μετατρέπει σε MP3 και το στέλνει στο Icecast
  μιλώντας απευθείας το πρωτόκολλο source του (πιο αξιόπιστο από να το κάνουμε
  εμείς με το χέρι). Η μετατροπή σε MP3 χρειάζεται γιατί οι browsers δεν
  παίζουν αξιόπιστα ένα ατέρμονο webm/opus live stream μέσω `<audio>` tag —
  το MP3 είναι το format που δουλεύει παντού για live radio.
- **docs/** — οι δύο web σελίδες: `docs/index.html` (ακρόαση) και
  `docs/broadcast/index.html` (εκπομπή), σερβιρισμένες από **GitHub Pages**.

Μόνο ένας broadcaster μπορεί να είναι on-air τη φορά.

Γιατί δύο διαφορετικά hosting providers: το Icecast χρειάζεται μια
απευθείας, ατέρμονη HTTP σύνδεση (το live audio feed) — το Render's free
"web service" tier αποδείχτηκε ότι δεν την υποστηρίζει αξιόπιστα (η σύνδεση
"κρεμούσε" χωρίς σφάλμα, το mount ποτέ δεν ενεργοποιούνταν). Το Fly.io έχει
πιο άμεση πρόσβαση δικτύου και είναι σύνηθες για τέτοιου τύπου streaming.
Το bridge δεν έχει αυτό το πρόβλημα (μιλάει μέσω WebSocket) οπότε έμεινε στο
Render.

## Deploy (χωρίς Docker/CLI στη δική σου συσκευή)

Όλο το deploy γίνεται μέσω **GitHub** — Actions για το Icecast (Fly.io),
Blueprint για το bridge (Render), Pages για τις δύο σελίδες. Το μόνο που
χρειάζεται να κάνεις εσύ είναι λογαριασμοί + μερικά secrets.

### 1. Icecast στο Fly.io (μέσω GitHub Actions)

1. Δημιούργησε λογαριασμό στο https://fly.io (θέλει κάρτα για επαλήθευση
   ταυτότητας, αλλά ο μικρός αυτός server μένει μέσα στο δωρεάν μηνιαίο
   credit τους).
2. Πήγαινε **Account → Access Tokens** και δημιούργησε ένα token.
3. Στο GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret** και πρόσθεσε:
   - `FLY_API_TOKEN` = το token από το βήμα 2
   - `ICECAST_SOURCE_PASSWORD` = δικός σου τυχαίος κωδικός
   - `ICECAST_ADMIN_PASSWORD` = δικός σου τυχαίος κωδικός
4. Το workflow `.github/workflows/deploy-icecast.yml` τρέχει αυτόματα σε κάθε
   push στο `main` που αγγίζει το `icecast/` — δημιουργεί το Fly app, βάζει
   τα secrets, κάνει deploy. Μπορείς και να το τρέξεις χειροκίνητα από το tab
   **Actions** του repo (**Run workflow**).
5. Αν το όνομα `pirateradio-icecast` είναι ήδη πιασμένο στο Fly (τα ονόματα
   είναι global), άλλαξε το `app = "..."` στο `icecast/fly.toml` **και** το
   `--app pirateradio-icecast` στο workflow **και** το hostname στα
   `docs/index.html` / Render env vars παρακάτω, ώστε να ταιριάζουν όλα.
6. Μετά από επιτυχές run, το Icecast είναι στο
   `https://<app-name>.fly.dev`.

### 2. Bridge στο Render (μέσω Blueprint)

1. Δωρεάν λογαριασμός στο https://render.com (π.χ. με GitHub login).
2. Dashboard: **New → Blueprint** → διάλεξε αυτό το repo/branch. Θα διαβάσει
   το `render.yaml` και θα προτείνει το service `pirateradio-bridge`. Πάτα
   **Apply**.
3. Συμπλήρωσε τα env vars (`sync: false`, οπότε ζητούνται χειροκίνητα):
   - `ICECAST_HOST` = `<app-name>.fly.dev` (χωρίς `https://`)
   - `ICECAST_PORT` = `443`
   - `ICECAST_SOURCE_PASSWORD` = **ίδιο** με του Fly (βήμα 1)
   - `BROADCAST_PASSWORD` = ο κωδικός που θα βάζεις εσύ στη σελίδα εκπομπής
4. Μετά το deploy, σημείωσε το bridge URL (π.χ.
   `https://pirateradio-bridge.onrender.com`).

> Είχες ήδη δημιουργήσει ένα `pirateradio-icecast` service στο Render από
> προηγούμενη προσπάθεια — δεν χρειάζεται πια, μπορείς να το σβήσεις από το
> Render dashboard μόλις επιβεβαιωθεί ότι το Fly.io setup δουλεύει.

### 3. Frontend στο GitHub Pages

1. Επιβεβαίωσε ότι το `docs/index.html` δείχνει στο σωστό Fly hostname
   (`src="https://<app-name>.fly.dev/radio.mp3"`).
2. Άνοιξε `docs/broadcast/index.html` και βάλε το bridge URL σε `wss://`
   μορφή (π.χ. `wss://pirateradio-bridge.onrender.com`).
3. Commit & push.
4. GitHub repo: **Settings → Pages → Source: Deploy from a branch → Branch:
   main, folder: /docs**.
5. Links:
   - https://vaglar.github.io/PirateRadio/ — ακρόαση (στείλ' το).
   - https://vaglar.github.io/PirateRadio/broadcast/ — εκπομπή.

### Local test (πριν το deploy)

```
docker compose up --build
```
Ανοίγει Icecast στο `:8000` και bridge στο `:3001` — τοπικά, χωρίς Fly/Render.
Άνοιξε `docs/index.html` και `docs/broadcast/index.html` σε browser, με
bridge URL `ws://localhost:3001`.

## Γνωστοί περιορισμοί

- **iPhone/iPad ως broadcaster**: το Safari δεν υποστηρίζει αξιόπιστα
  webm/opus εγγραφή μέσω `MediaRecorder` — η σελίδα εκπομπής θα δείξει σαφές
  μήνυμα λάθους σε iOS αντί να χαλάσει σιωπηλά. Ακρόαση από iPhone/iPad
  δουλεύει κανονικά.
- Το Fly.io mount (`Mount Point /radio.mp3`, peak listeners > 0) έχει
  επιβεβαιωθεί ζωντανά ότι δουλεύει — το TLS handshake→response πήρε ~1
  δευτερόλεπτο (έναντι 30+ στο Render). Το ffmpeg→MP3 κομμάτι του bridge
  έχει δοκιμαστεί end-to-end **τοπικά** (webm chunks μέσω WebSocket → ffmpeg
  → Icecast → valid, ακούσιμο MP3, επιβεβαιωμένο και με `volumedetect`, όχι
  απλά ότι το αρχείο είναι έγκυρο) — όχι όμως ακόμα σε πραγματικό deploy.

## Επόμενα βήματα (προαιρετικά)

- Πιο ωραίο listener player (station name, "on air" indicator, ένταση).
- Login για broadcaster μέσω κάτι καλύτερου από shared password.
- Καταγραφή/replay παλιών εκπομπών.
