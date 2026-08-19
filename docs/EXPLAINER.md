# Transmat in Plain English

The no-jargon companion to [ARCHITECTURE.md](ARCHITECTURE.md). Same system, explained as **a locker room at the post office** — because that is genuinely what we're building.

There are three layers here. Read as far down as you feel like.

---

## Part 1 — Explain it like I'm 5

**You put a thing in a box. Someone's doorbell rings. They open the box.**

That's the product. The someone can be your own laptop, or a friend. The box waits patiently if nobody's home, and gets thrown out after a week if nobody comes for it.

### The cast — four characters, and only four

| Character | What it does | What it really is |
|---|---|---|
| **The front desk clerk** | Knows who you are, which devices are yours, who your friends are, and which boxes belong to whom. Writes it all in a ledger. *Never touches a box.* | API server + Postgres |
| **The locker room** | A huge cheap room full of lockers where your actual files sit. Rents for pennies, and charges nothing to take things out. | Cloudflare R2 |
| **The doorbell** | Runs to the receiver and shouts "package for you." Carries the *message*, never the package — too small to carry packages. | Push notifications |
| **The janitor** | Empties lockers nobody claimed, plus half-packed ones people abandoned. | Expiry + cleanup jobs |

### What happens when you send a file

1. You tap **share** on your phone and pick who gets it — "my MacBook," or "Sam."
2. Your phone asks the clerk for a locker. The clerk writes it in the ledger and hands back a **ticket**: *locker 4471, opens for the next 5 minutes.*
3. Your phone walks the box to the locker **itself** — not through the front desk. The clerk stays free while your 2GB video goes straight into storage.
4. Your phone tells the clerk "done." The clerk **goes and checks the locker** to see what actually landed — it never saw the box, so it can't take your word for how big it was.
5. The clerk sends the doorbell running. Sam's phone buzzes.
6. Sam's device fetches the box with its own fresh ticket, and tells the clerk it arrived.

**The one structural decision everything hangs off: the file never passes through the server.** That's why the server stays small and cheap forever, no matter how big files get.

### Why your iPhone is a strict doorman

On a laptop, a file that arrives just arrives. On iPhone there's a doorman deciding what may happen while you're not looking. He **always rings the bell** — that part is reliable even with the app closed. What he limits is *carrying*.

| Situation | What he allows |
|---|---|
| App open on screen | Anything. Instant. No limits. |
| App closed, small file (<10MB) | He carries it up while ringing — 30 seconds and a small trolley. It's already there when you look. |
| App closed, big file | Bell only: *"1.2GB — tap to receive."* One tap starts a download that keeps running after you leave the app. |
| You swiped the app away | Bell still rings. Quiet background work is switched off until you next open the app. |
| You denied notifications | **No bell at all.** Transmat becomes a mailbox you have to check. |

So the honest promise is: **small things appear by magic, big things are one tap.**

---

## Part 2 — Explain it like I'm 10

Same system, one level deeper. Now with names you'd actually type.

### The pieces, and why each exists

**The API server** (TypeScript, Hono) is a small program that answers questions: *who are you, what are your devices, who may open this file, when does it expire.* It's the only thing that writes to the database. It stays small on purpose — it never handles file bytes, so a thousand people uploading 2GB videos doesn't make it break a sweat.

**Postgres** is the ledger: users, devices, contacts, transfers, who-got-what, when things expire. Everything except the files themselves.

**Cloudflare R2** is the locker room — object storage. We picked it over Amazon S3 for one reason: **R2 doesn't charge for downloads.** In a file-transfer app downloads *are* the product, so S3's egress fees would grow exactly in proportion to success. Storage runs about $0.015/GB/month; 2TB is ~$30.

**Presigned URLs** are the tickets. A presigned URL is a normal storage link with a signature glued on that says *"whoever holds this may PUT to this exact key, until 3:47pm."* It lets your phone talk straight to storage without us handing out our master credentials. Important caveat we had to correct: **they are not single-use.** They're bearer tokens — anyone holding one can use it repeatedly until it expires. So we keep TTLs to minutes and issue a fresh one per request.

**Multipart upload** is how a big file goes up: cut into fixed-size chunks (5–8MB), each uploaded separately, reassembled by storage at the end. Two reasons — resumability (lose signal at 80%, resume at 80%) and memory (an iPhone share extension gets ~120MB of RAM, so you can never hold a 2GB video in memory; you stream it chunk by chunk from disk).

**APNs / FCM / Web Push** are the doorbell services. You cannot make a phone ring by yourself — only Apple can wake an iPhone. So our server tells Apple "wake this device with this message," and Apple does. This is also why the notification can't *contain* the file: these are small message channels, not delivery trucks.

**SSE (Server-Sent Events)** is a connection the app holds open while it's on screen, so arrivals appear instantly with no push involved. One-directional (server → app), which is all we need, and it survives flaky networks with less code than WebSockets.

**The janitor jobs** are boring and load-bearing: delete blobs nothing references anymore, abort multipart uploads somebody started and abandoned (those bill as storage until aborted — a silent money leak), and expire transfers on schedule.

**The share extension and the notification service extension** are the two Apple-specific pieces. They're not part of the app exactly — they're separate mini-programs the OS launches on demand, with their own tight memory and time budgets. The share extension is what puts Transmat in every share sheet on the phone. The notification extension gets ~30 seconds to intercept an incoming notification and change it — that's how a small file is already downloaded, with a thumbnail, before you've even tapped.

### How the encryption actually works

Three different things get called "encryption," and they protect against completely different attackers.

**Layer 1 — TLS (the `https://`).** Encrypts the tunnel between your device and our server. Stops the café wifi and your ISP from reading your files in transit. Does nothing about us: at the far end of the tunnel, the server sees everything.

**Layer 2 — encryption at rest.** The storage provider encrypts its disks. Protects against someone physically stealing a drive from a datacenter. Also does nothing about us — the service decrypts transparently for anyone with valid credentials.

**This is all v1 has, and we say so plainly.** No E2EE theater.

**Layer 3 — end-to-end encryption (v2).** The file is locked *before* it leaves your device and only unlocked *after* it arrives on the recipient's. We hold gibberish and cannot do otherwise. Here's the machinery:

There are two families of lock:

- **Symmetric** — one key both locks and unlocks, like a padlock with one key. Very fast, fine for a 2GB video. (AES-256, XChaCha20.)
- **Asymmetric / public-key** — *two* keys: a public one that can only lock, and a private one that can only unlock. You can publish the locking key to the whole world safely. But it's slow and can only handle tiny amounts of data. (X25519.)

So you use both, which is called envelope encryption:

1. Your phone generates a **brand-new random key for this one file**.
2. It locks the file with that key — fast symmetric lock, handles the 2GB fine.
3. Now the recipient needs that file key. So your phone takes **each recipient device's public key** and uses it to lock a tiny copy of the file key. One small sealed envelope per recipient device.
4. The server stores the locked file plus the locked envelopes. It can't open either.
5. The recipient's device uses its **private key** — which never leaves the device, stored in the Secure Enclave — to open its envelope, get the file key, and unlock the file.

Three details that are easy to get wrong, and one we did get wrong:

- **Chunking.** You can't lock a 2GB file in one operation on a phone, so you lock it in 64KB pieces. But if each piece is independently sealed, an attacker can reorder them, duplicate them, or **delete the last few** — and every remaining piece still verifies perfectly. Our first draft hand-rolled exactly this and was vulnerable. The fix is to use a construction designed for it (libsodium's `secretstream`, or the age file format), which numbers every chunk and marks the final one, so any tampering with order or length is detected.
- **Signing.** Locking proves nobody *read* it. It does not prove who *sent* it — anyone can look up your public key and send you a file claiming to be from your boss. So the sender also signs the package with their private key. That's what makes "a file from Kirby" trustworthy rather than decorative.
- **Key distribution — the real hard part.** How does your phone learn your laptop's public key? From our server. But then couldn't our server hand out *its own* key instead, read everything, and re-encrypt so nobody notices? Yes. That attack is the entire reason Signal has "safety numbers." Our answer is QR-code pairing: when you add a device, the two devices show each other their real keys directly, screen to camera, with the server cut out of the loop.

And the nice consequence we found while deciding whether to encrypt filenames: the notification extension **has the device key**, so it can decrypt the filename locally, in the moment, and rewrite the notification before you see it. The server stores an opaque blob; your lock screen still says `report.pdf from Kirby`.

---

## Part 3 — What could we build in a weekend?

The instinct is "the Phase 0 spike." That's a trap: an Apple Developer account, provisioning profiles, App Group entitlements, APNs keys, a share extension target, and background `URLSession` is not a weekend for someone new to iOS — it's a weekend of Xcode error messages with no working demo at the end.

So invert it. **Ask what proves the magic with the least platform bureaucracy** — and it turns out you can get the real send ergonomics *and* a real iPhone lock-screen doorbell with **no Xcode, no Swift, and no $99 developer account.**

### Weekend 0 — the no-Xcode proof

| Piece | Weekend version | Why it works |
|---|---|---|
| **Send from iPhone** | An **iOS Shortcut** with "Show in Share Sheet" on, running `Get Contents of URL` (POST, file as body) | Shortcuts can add themselves to the system share sheet. You get a real Transmat entry in the real share sheet, for free, today. |
| **Send from laptop** | Web page with drag & drop | Trivial |
| **Store** | R2 with presigned PUT | Same as the real design — worth doing properly, it's an afternoon |
| **Receive** | PWA added to the iPhone **home screen** + Web Push | iOS 16.4+ supports Web Push for home-screen web apps. A genuine lock-screen notification, no native app. |
| **Auth** | One hardcoded bearer token in a header | It's your phone and your laptop |
| **Database** | SQLite file | Postgres can wait |
| **Encryption** | TLS only | E2EE is Phase 4 |

**A rough two days:**

- **Sat morning** — Hono server, SQLite, R2 bucket, `POST /transfers` + `GET /transfers/:id` behind a bearer token.
- **Sat afternoon** — the web app: upload, list, download. Deploy to Fly or Railway so you have a real HTTPS URL (needed for both push and PWA install).
- **Sun morning** — Web Push: generate VAPID keys, write the service worker, subscribe from the phone, fire a notification on new transfer. *Budget the most time here* — service workers are the classic weekend-eater.
- **Sun afternoon** — build the Shortcut, put it on the share sheet, and make tapping the notification land directly on the file. Then send yourself things all evening.

**What this genuinely tests:** whether the loop feels magical. Whether a share-sheet send is actually faster than emailing yourself. Whether a doorbell on the lock screen changes how the thing feels versus checking an inbox. That's the thesis, and you'd have an answer by Sunday night.

**What it deliberately doesn't test:** background upload reliability (a Shortcut wants you to stay put while it uploads), NSE prefetch, big-file behavior, and multi-device fan-out. Those are exactly what Phase 0 exists for — you'd be buying the *product* answer cheap, and deferring the *platform* answers.

**If it goes sideways:** if service workers eat Sunday, drop Web Push and use SSE with the page open. The transfer loop still proves out; the doorbell waits a week.

### Weekend 1, if the itch persists

Swap the Shortcut for a real share extension, and Web Push for APNs. That's when you pay Apple $99 and meet the provisioning system. By then you'll have a working server to point it at, which makes the iOS part a much smaller mountain.
