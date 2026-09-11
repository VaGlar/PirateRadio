# 🏴‍☠️ PirateRadio

Ζωντανό ραδιόφωνο από το browser. Ένας ή δύο broadcasters ανοίγουν μια
σελίδα, πατάνε "On Air", και οι ακροατές ακούνε από ένα απλό link — καμία
εγκατάσταση στη δική τους συσκευή.

## Πώς δουλεύει

```
[broadcaster browser] --WebSocket--> [bridge: Fly.io, ffmpeg] --HTTPS--> [Icecast: Fly.io, MP3] <--HTTPS-- [listener <audio>]
```

- **Icecast** (`icecast/`) — ο streaming server, τρέχει στο **Fly.io**
  (raw TCP passthrough, όχι HTTP-aware proxy — βλ. "Γιατί όλο το backend
  στο Fly.io" παρακάτω). Δέχεται το live audio (MP3) και το αναμεταδίδει σε
  όποιον ανοίγει το mount URL.
- **bridge** (`bridge/`) — μικρό Node server, τρέχει κι αυτό στο **Fly.io**.
  Παίρνει το μείγμα ήχου (webm/opus) από τον broadcaster μέσω WebSocket και
  το περνάει σε ένα `ffmpeg` process που το μετατρέπει σε MP3 και το στέλνει
  στο Icecast μέσω του δημόσιου HTTPS URL του (η προσπάθεια να περάσει από
  το εσωτερικό δίκτυο του Fly `*.internal` εγκαταλείφθηκε — αρνιόταν τη
  σύνδεση ακόμα και με ένα μόνο running machine, χωρίς προφανή λόγο). Το
  ίδιο WebSocket endpoint εξυπηρετεί και τους ακροατές: chat προς τον
  broadcaster, live roster ονομάτων, live στατιστικά ακροατών.
- **docs/** — οι δύο web σελίδες, σερβιρισμένες από **GitHub Pages**:
  - `docs/index.html` — σελίδα ακρόασης.
  - `docs/broadcast/index.html` — σελίδα εκπομπής.

Μόνο ένας broadcaster (μία σύνδεση) μπορεί να είναι on-air τη φορά, αλλά
μπορεί να στέλνει ήχο από **δύο μικρόφωνα ταυτόχρονα** (δύο άτομα, ίδιο
laptop) — βλ. "Χαρακτηριστικά" παρακάτω.

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
4. Μετακόμισε και το bridge στο Fly.io, ίδιο οργανισμό με το Icecast — αυτό
   έλυσε οριστικά το πρόβλημα (επαληθευμένο ζωντανά, καθαρός ήχος χωρίς
   διακοπές).
5. Δοκιμάστηκε το εσωτερικό δίκτυο του Fly (`*.internal`) ανάμεσα σε
   bridge και Icecast, για να μην περνάει καν από δημόσιο internet —
   αρνιόταν σύνδεση ("Connection refused") ακόμα και με ένα μόνο running
   Icecast machine. Εγκαταλείφθηκε· το bridge μιλάει στο Icecast μέσω του
   δημόσιου `https://<icecast-app>.fly.dev` URL, το οποίο ήδη είχε
   αποδειχθεί ότι δουλεύει σωστά.

## Χαρακτηριστικά

**Σελίδα εκπομπής** (`docs/broadcast/`):
- Δύο ξεχωριστά μικρόφωνα (δύο co-hosts, ίδιο laptop) — καθένα με δικό του
  όνομα, test button, μετρητή έντασης, και λαμπάκι· η δοκιμή του ενός
  κλείνει αυτόματα το άλλο ώστε να μην ακούγονται μεταξύ τους.
- Μείξη με ήχο συστήματος (π.χ. Spotify) μέσω `getDisplayMedia` tab-audio
  capture — καμία εγκατάσταση OS-level audio driver. Crossfader
  μικρόφωνο/μουσική με ομαλή (ramped) μετάβαση, limiter για να μην
  κόβεται ο ήχος, de-esser στο "σ" της φωνής, αυτόματη αναπροσαρμογή
  έντασης μικροφώνου/μουσικής.
- Master ON AIR / mute (neon sign, ίδιο ύφος με τον ακροατή) + ανεξάρτητο
  mute ανά άτομο (Marshall-amp-style rocker switch) που συγχρονίζεται με
  το master όποτε αλλάζει.
- Self-monitor ("άκου τον εαυτό σου") μέσω Web Audio graph για ελάχιστη
  καθυστέρηση· με δύο headsets, κάθε άτομο διαλέγει τη δική του συσκευή
  εξόδου (`setSinkId`).
- Live στατιστικά (διάρκεια, ακροατές, peak) από το Icecast
  `/status-json.xsl`, live roster ονομάτων ακροατών από το bridge.
- Inbox με μηνύματα ακροατών (one-way, δεν είναι δημόσιο chatroom),
  rate-limited στο bridge (token bucket: burst 5 μηνυμάτων, μετά 1 ανά 5").
- Προβολή/αλλαγή του κοινού κωδικού εισόδου των ακροατών, ζωντανά, χωρίς
  redeploy (βλ. "Κωδικός ακροατών" παρακάτω).
- Προειδοποίηση αν το laptop δεν φορτίζει (Battery Status API) — το
  power-saving του Windows/Chrome σε μπαταρία είναι συχνή αιτία τριξίματος
  στον ήχο.
- Προαιρετική τοπική εγγραφή: με το "Off Air" εμφανίζεται pop-up αν θες να
  κατεβάσεις την εγγραφή (`.webm`) στον υπολογιστή σου — καμία αποθήκευση
  στον server, μηδενικό κόστος, αλλά χάνεται αν κλείσεις το tab χωρίς να
  απαντήσεις.

**Σελίδα ακρόασης** (`docs/`):
- Login gate: όνομα + κοινός κωδικός πριν φανεί οτιδήποτε άλλο.
- Custom player bar (play/pause, reload, ένταση, mute, AirPlay σε Safari)
  αντί για τα native controls του browser.
- Auto-reconnect αν κοπεί το stream, live αριθμός ακροατών, neon "ON AIR"
  sign που ανάβει όταν παίζει ήχος.

### Κωδικός ακροατών

Ο κοινός κωδικός εισόδου ζει **στο bridge** (in-memory, όχι hardcoded στη
σελίδα) — έτσι είναι ίδιος για όλους ανεξαρτήτως συσκευής, και ο
broadcaster μπορεί να τον αλλάξει ζωντανά από το κουμπί "🔑 Κωδικός
ακροατών" στη σελίδα εκπομπής (χρειάζεται τον broadcast password για να
τον δει/αλλάξει). Πώς φτάνει ο νέος κωδικός στους ακροατές είναι δική σας
δουλειά (Slack, προφορικά) — δεν αυτοματοποιείται.

Χωρίς persistent storage (κόστος), ο κωδικός επιστρέφει στο env var
default (`LISTENER_PASSPHRASE`, fallback `yohoho`) σε κάθε restart του
bridge (π.χ. redeploy). Αυτό είναι φράγμα ευγένειας για την ομάδα, **όχι
πραγματική ασφάλεια** — το raw URL του stream παραμένει τεχνικά
προσβάσιμο σε όποιον το βρει.

## Deploy (χωρίς Docker/CLI στη δική σου συσκευή)

Όλο το backend γίνεται deploy μέσω **GitHub Actions** (flyctl), τα secrets
μπαίνουν σε ένα μέρος (GitHub repo secrets), οι σελίδες μέσω **GitHub
Pages**.

### 1. Λογαριασμός Fly.io + secrets

1. Δημιούργησε λογαριασμό στο https://fly.io (θέλει κάρτα για επαλήθευση
   ταυτότητας· αυτοί οι δύο μικροί servers, χωρίς persistent volumes,
   μένουν σε πολύ χαμηλό μηνιαίο κόστος).
2. **Account → Access Tokens** → δημιούργησε token.
3. GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret**, πρόσθεσε:
   - `FLY_API_TOKEN` = το token από το βήμα 2
   - `ICECAST_SOURCE_PASSWORD` = δικός σου τυχαίος κωδικός
   - `ICECAST_ADMIN_PASSWORD` = δικός σου τυχαίος κωδικός
   - `BROADCAST_PASSWORD` = ο κωδικός που θα βάζεις εσύ στη σελίδα εκπομπής
   - `LISTENER_PASSPHRASE` (προαιρετικό) = αρχικός κωδικός ακροατών· αν
     λείπει, πέφτει στο default `yohoho` μέχρι να τον αλλάξεις από τη
     σελίδα εκπομπής

### 2. Deploy

Τα workflows `.github/workflows/deploy-icecast.yml` και `deploy-bridge.yml`
τρέχουν αυτόματα σε κάθε push στο `main` που αγγίζει το αντίστοιχο φάκελο —
δημιουργούν το Fly app, βάζουν τα secrets, κάνουν deploy, και φροντίζουν να
μείνει ακριβώς 1 machine (`flyctl scale count 1`). Μπορείς και να τα τρέξεις
χειροκίνητα από το tab **Actions** του repo (**Run workflow**).

Deploy πρώτα το Icecast, μετά το bridge.

Αν τα ονόματα `pirateradio-icecast` / `pirateradio-bridge` είναι ήδη
πιασμένα στο Fly (global namespace), άλλαξέ τα σε **και τα δύο**
`fly.toml` **και** στα workflows **και** στο `bridge/fly.toml`'s
`ICECAST_HOST` **και** στα `docs/*.html`, ώστε να ταιριάζουν όλα.

### 3. Frontend στο GitHub Pages

1. Επιβεβαίωσε ότι το `docs/index.html` δείχνει στο σωστό Icecast hostname
   (`src="https://<icecast-app>.fly.dev/radio.mp3"`) και το
   `ICECAST_STATUS_URL` στο `docs/app.js`.
2. Επιβεβαίωσε ότι `docs/broadcast/app.js` και `docs/app.js` δείχνουν στο
   σωστό bridge hostname (`BRIDGE_URL = 'wss://<bridge-app>.fly.dev'`).
3. Commit & push.
4. GitHub repo: **Settings → Pages → Source: Deploy from a branch → Branch:
   main, folder: /docs**.
5. Links:
   - https://vaglar.github.io/PirateRadio/ — ακρόαση (στείλ' το).
   - https://vaglar.github.io/PirateRadio/broadcast/ — εκπομπή.

**Cache-busting**: τα `<script>` tags στα δύο `docs/*.html` έχουν
`?v=N` στο `app.js`. Ανέβασε το `N` κάθε φορά που αλλάζεις το αντίστοιχο
`app.js`, αλλιώς κάποιοι browsers (ειδικά iOS Safari) μπορεί να κρατήσουν
παλιά κρυφή έκδοση για ώρες.

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
- Ο μετρητής ακροατών του Icecast μετράει **ανοιχτές συνδέσεις**, όχι
  μοναδικά άτομα — πολλαπλά tabs/devices από το ίδιο άτομο, ή συνδέσεις
  που "κρέμασαν" χωρίς σωστό TCP close, μπορεί να τον κάνουν να δείχνει
  ελαφρώς παραπάνω από την πραγματικότητα. Το live roster ονομάτων (μέσω
  login) είναι πιο ακριβές ως προς το "ποιος είναι μέσα", αλλά μετράει
  διαφορετικό πράγμα (σελίδα ανοιχτή, όχι απαραίτητα ήχος να παίζει).
- Ο κωδικός ακροατών (βλ. πάνω) δεν είναι πραγματική ασφάλεια — απαιτεί
  listener authentication στο ίδιο το Icecast για κάτι τέτοιο, που δεν
  έχει γίνει.
- Recording: μόνο τοπικά στο browser tab του broadcaster (κατέβασμα κατά
  το Off Air) — καμία αποθήκευση/backup στον server.

## Επόμενα βήματα (προαιρετικά)

- Reactions/emoji από ακροατές — αξίζει μόνο αν φαίνονται συγκεντρωτικά σε
  όλους τους ακροατές, όχι μόνο στον broadcaster (αλλιώς δεν έχει νόημα
  για όποιον τα στέλνει).
- Live poll broadcaster→ακροατές — χρειάζεται το bridge να κρατάει λίστα
  ακροατών (μερικώς υπάρχει ήδη μέσω του roster) και νέο μηχανισμό
  broadcast-σε-όλους αντί για ένα-προς-ένα.
- Πραγματικό listener authentication στο Icecast, αν ποτέ χρειαστεί
  κάτι παραπάνω από το σημερινό courtesy lock.
