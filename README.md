# 🏴‍☠️ PirateRadio

Ζωντανό ραδιόφωνο από το browser. Ένας/μία broadcaster ανοίγει μια σελίδα,
πατάει "On Air", και οι ακροατές ακούνε από ένα απλό link — καμία εγκατάσταση
στη δική τους συσκευή.

## Πώς δουλεύει

```
[broadcaster browser] --WebSocket--> [bridge: Fly.io, ffmpeg] --internal TCP--> [Icecast: Fly.io, MP3] <--HTTPS-- [listener <audio>]
```

- **Icecast** (`icecast/`) — ο streaming server, τρέχει στο **Fly.io**. Δέχεται
  το live audio (MP3) και το αναμεταδίδει σε όποιον ανοίγει το mount URL.
- **bridge** (`bridge/`) — μικρό Node server, τρέχει κι αυτό στο **Fly.io**
  (ίδιος οργανισμός, ίδια region). Παίρνει το mic audio (webm/opus) από τον
  broadcaster μέσω WebSocket και το περνάει σε ένα `ffmpeg` process που το
  μετατρέπει σε MP3 και το στέλνει στο Icecast μέσω του **εσωτερικού δικτύου**
  του Fly (`*.internal`) — όχι μέσω δημόσιου internet.
- **docs/** — οι δύο web σελίδες: `docs/index.html` (ακρόαση) και
  `docs/broadcast/index.html` (εκπομπή), σερβιρισμένες από **GitHub Pages**.

Μόνο ένας broadcaster μπορεί να είναι on-air τη φορά.

### Γιατί όλο το backend στο Fly.io

Δοκιμάστηκαν με τη σειρά:
1. Bridge + Icecast στο **Render** (free tier): η σύνδεση bridge→Icecast
   "κρεμούσε" σιωπηλά, το mount ποτέ δεν ενεργοποιούνταν.
2. Icecast στο **Fly.io** (HTTP-aware proxy), bridge στο Render: η σύνδεση
   έσπαγε ξανά και ξανά στα ~30-32 δευτερόλεπτα.
3. Icecast στο Fly.io με **raw TCP passthrough** (όχι HTTP proxy), bridge
   ακόμα στο Render: το mount δούλευε σωστά, αλλά η σύνδεση *πάλι* έσπαγε
   στα ~30-32". Ο κοινός παρονομαστής σε όλες τις αποτυχίες ήταν το Render
   (η πλευρά που κάνει την εξερχόμενη σύνδεση) — πιθανό όριο διάρκειας σε
   μακρόχρονες εξερχόμενες συνδέσεις στο free tier.
4. Μετακόμισε και το bridge στο Fly.io, ίδιο δίκτυο με το Icecast — η
   σύνδεση bridge→Icecast δεν περνάει πια καθόλου από δημόσιο internet.

## Deploy (χωρίς Docker/CLI στη δική σου συσκευή)

Όλο το backend γίνεται deploy μέσω **GitHub Actions** (flyctl), τα secrets
μπαίνουν σε ένα μέρος (GitHub repo secrets), οι σελίδες μέσω **GitHub
Pages**.

### 1. Λογαριασμός Fly.io + secrets

1. Δημιούργησε λογαριασμό στο https://fly.io (θέλει κάρτα για επαλήθευση
   ταυτότητας, αλλά αυτοί οι δύο μικροί servers μένουν μέσα στο δωρεάν
   μηνιαίο credit τους).
2. **Account → Access Tokens** → δημιούργησε token.
3. GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret**, πρόσθεσε:
   - `FLY_API_TOKEN` = το token από το βήμα 2
   - `ICECAST_SOURCE_PASSWORD` = δικός σου τυχαίος κωδικός
   - `ICECAST_ADMIN_PASSWORD` = δικός σου τυχαίος κωδικός
   - `BROADCAST_PASSWORD` = ο κωδικός που θα βάζεις εσύ στη σελίδα εκπομπής

### 2. Deploy

Τα workflows `.github/workflows/deploy-icecast.yml` και `deploy-bridge.yml`
τρέχουν αυτόματα σε κάθε push στο `main` που αγγίζει το αντίστοιχο φάκελο —
δημιουργούν το Fly app, βάζουν τα secrets, κάνουν deploy. Μπορείς και να τα
τρέξεις χειροκίνητα από το tab **Actions** του repo (**Run workflow**).

Deploy πρώτα το Icecast, μετά το bridge (το bridge χρειάζεται το Icecast να
υπάρχει ήδη ώστε το εσωτερικό DNS `pirateradio-icecast.internal` να λύνεται).

Αν τα ονόματα `pirateradio-icecast` / `pirateradio-bridge` είναι ήδη
πιασμένα στο Fly (global namespace), άλλαξέ τα σε **και τα δύο**
`fly.toml` **και** στα workflows **και** στο `bridge/fly.toml`'s
`ICECAST_HOST` **και** στα `docs/*.html`, ώστε να ταιριάζουν όλα.

### 3. Frontend στο GitHub Pages

1. Επιβεβαίωσε ότι το `docs/index.html` δείχνει στο σωστό Icecast hostname
   (`src="https://<icecast-app>.fly.dev/radio.mp3"`).
2. Επιβεβαίωσε ότι το `docs/broadcast/index.html` δείχνει στο σωστό bridge
   hostname (`value="wss://<bridge-app>.fly.dev"`).
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
Ανοίγει Icecast στο `:8000` και bridge στο `:3001` — τοπικά, χωρίς Fly.
Άνοιξε `docs/index.html` και `docs/broadcast/index.html` σε browser, με
bridge URL `ws://localhost:3001`.

## Γνωστοί περιορισμοί

- **iPhone/iPad ως broadcaster**: το Safari δεν υποστηρίζει αξιόπιστα
  webm/opus εγγραφή μέσω `MediaRecorder` — η σελίδα εκπομπής θα δείξει σαφές
  μήνυμα λάθους σε iOS αντί να χαλάσει σιωπηλά. Ακρόαση από iPhone/iPad
  δουλεύει κανονικά.
- Η σελίδα εκπομπής έχει live μετρητή έντασης + επιλογέα μικροφώνου
  ("🎤 Δοκιμή μικροφώνου") — χρησιμοποίησέ τον πριν πατήσεις On Air αν δεν
  ακούγεται τίποτα, πολύ συχνά είναι θέμα λάθος συσκευής εισόδου.
- Η μετακόμιση bridge→Fly.io (βήμα 4 παραπάνω) δεν έχει επαληθευτεί ζωντανά
  ακόμα από αυτό το session. Ό,τι έχει ελεγχθεί μέχρι τώρα ζωντανά: το
  Icecast mount στο Fly.io ενεργοποιείται σωστά με raw TCP passthrough. Αν
  η μετακόμιση του bridge δεν λύσει τα ~30s disconnects, το επόμενο βήμα θα
  ήταν πραγματικό VPS αντί για PaaS.

## Επόμενα βήματα (προαιρετικά)

- Πιο ωραίο listener player (station name, "on air" indicator, ένταση).
- Login για broadcaster μέσω κάτι καλύτερου από shared password.
- Καταγραφή/replay παλιών εκπομπών.
