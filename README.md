# 🏴‍☠️ PirateRadio

Ζωντανό ραδιόφωνο από το browser. Ένας/μία broadcaster ανοίγει μια σελίδα,
πατάει "On Air", και οι ακροατές ακούνε από ένα απλό link — καμία εγκατάσταση
στη δική τους συσκευή.

## Πώς δουλεύει

```
[broadcaster browser] --WebSocket--> [bridge] --HTTP PUT--> [Icecast] <--HTTP-- [listener <audio>]
```

- **Icecast** (`icecast/`) — ο streaming server. Δέχεται το live audio και το
  αναμεταδίδει σε όποιον ανοίγει το mount URL.
- **bridge** (`bridge/`) — μικρό Node server που παίρνει το mic audio από τον
  broadcaster μέσω WebSocket και το προωθεί στο Icecast (ο browser δεν μιλάει
  απευθείας το πρωτόκολλο source του Icecast).
- **docs/** — οι δύο web σελίδες: `docs/index.html` (ακρόαση) και
  `docs/broadcast/index.html` (εκπομπή). Ο φάκελος λέγεται `docs/` επίτηδες
  ώστε να μπορεί να σερβιριστεί απευθείας από **GitHub Pages**.

Μόνο ένας broadcaster μπορεί να είναι on-air τη φορά.

Το core pipeline (bridge → Icecast, chunked audio) έχει δοκιμαστεί end-to-end
με πραγματικό webm/opus audio· βγαίνει καθαρό, valid stream στην άλλη άκρη.

## Deploy (χωρίς Docker στη δική σου συσκευή)

Ο streaming server + bridge πρέπει να τρέχουν κάπου συνέχεια — δεν μπορούν να
μείνουν "μέσα στο GitHub" (το GitHub Pages σερβίρει μόνο static αρχεία). Το
repo έχει έτοιμο ένα **Render Blueprint** (`render.yaml`) που τα στήνει και τα
δύο με λίγα κλικ, χωρίς να χρειαστεί να δώσεις κάπου API key.

### 1. Backend στο Render (Icecast + bridge)

1. Δημιούργησε δωρεάν λογαριασμό στο https://render.com (π.χ. με GitHub login).
2. Στο dashboard: **New → Blueprint** → διάλεξε αυτό το repo/branch.
3. Το Render θα διαβάσει το `render.yaml` και θα προτείνει δύο services:
   `pirateradio-icecast` και `pirateradio-bridge`. Πάτα **Apply**.
4. Θα σου ζητηθεί να συμπληρώσεις μη αυτόματα (`sync: false`) κάποια env vars:
   - Στο `pirateradio-icecast`: `ICECAST_SOURCE_PASSWORD`, `ICECAST_ADMIN_PASSWORD` —
     βάλε δικούς σου τυχαίους κωδικούς.
   - Στο `pirateradio-bridge`: `ICECAST_SOURCE_PASSWORD` (**ίδιο** με πάνω),
     `BROADCAST_PASSWORD` (ο κωδικός που θα βάζεις εσύ στη σελίδα εκπομπής).
5. Περίμενε να γίνουν deploy και τα δύο services. Σημείωσε τα public URLs τους
   (κάτι σαν `https://pirateradio-icecast.onrender.com` και
   `https://pirateradio-bridge.onrender.com`).

> ⚠️ Το free plan του Render "κοιμίζει" τα services μετά από ανενεργία και
> χρειάζονται ~30-60s για να ξυπνήσουν στο πρώτο request. Αν το ραδιόφωνο
> μείνει αδρανές πολλή ώρα, το πρώτο "On Air" μετά μπορεί να αργήσει λίγο ή
> να χρειαστεί δεύτερη προσπάθεια.

### 2. Frontend στο GitHub Pages

1. Άνοιξε `docs/index.html` και άλλαξε το `EDIT_ME_ICECAST_URL` στο πραγματικό
   Icecast URL (π.χ. `https://pirateradio-icecast.onrender.com`).
2. Άνοιξε `docs/broadcast/index.html` και άλλαξε το `EDIT_ME_BRIDGE_URL` σε
   `wss://` + το bridge URL (π.χ. `wss://pirateradio-bridge.onrender.com`).
3. Commit & push.
4. Στο GitHub repo: **Settings → Pages → Source: Deploy from a branch →
   Branch: main, folder: /docs**.
5. Μετά από λίγο θα έχεις:
   - https://vaglar.github.io/PirateRadio/ — το link για ακρόαση (στείλ' το).
   - https://vaglar.github.io/PirateRadio/broadcast/ — το link για εκπομπή.

### Local test (πριν το deploy)

```
docker compose up --build
```
Ανοίγει Icecast στο `:8000` και bridge στο `:3001`. Άνοιξε
`docs/index.html` και `docs/broadcast/index.html` τοπικά σε browser, με
bridge URL `ws://localhost:3001`.

## Γνωστοί περιορισμοί

- **iPhone/iPad ως broadcaster**: το Safari δεν υποστηρίζει αξιόπιστα
  webm/opus εγγραφή μέσω `MediaRecorder` — η σελίδα εκπομπής θα δείξει σαφές
  μήνυμα λάθους σε iOS αντί να χαλάσει σιωπηλά. Ακρόαση από iPhone/iPad
  δουλεύει κανονικά.
- Το deploy config (`render.yaml`, Dockerfiles) δεν έχει δοκιμαστεί με
  πραγματικό Render deploy από αυτό το session (το sandbox μπλοκάρει έξοδο
  προς render.com) — μόνο το local pipeline έχει επαληθευτεί με πραγματικό
  audio. Αν κάτι σκάσει στο πρώτο deploy, στείλε το error και θα διορθωθεί.

## Επόμενα βήματα (προαιρετικά)

- Πιο ωραίο listener player (station name, "on air" indicator, ένταση).
- Login για broadcaster μέσω κάτι καλύτερου από shared password.
- Καταγραφή/replay παλιών εκπομπών.
