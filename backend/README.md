# Lumora API

Express + TypeScript + PostgreSQL (Kysely). Architecture lives in
[`docs/03-backend.md`](../docs/03-backend.md); this file covers running it.

```bash
cp .env.example .env     # then edit
npm run migrate          # apply pending migrations
npm run dev              # tsx watch on :4000
```

---

## Mail

Delivery sits behind the `MailProvider` interface
(`src/providers/mail/mail-provider.interface.ts`). Providers are selected by
configuration alone — no code change, no rebuild.

| `MAIL_DRIVER` | Behaviour |
|---|---|
| `console` | Writes the message to the log instead of sending it. The default, and the right choice for local work: no credentials, no rate limits, and the verification link is in your terminal. |
| `smtp` | Real delivery through Nodemailer. `SMTP_*` become required and the process refuses to start without them. |

Adding Resend, SES, or Mailgun later is one file implementing `MailProvider`,
one member on the `MAIL_DRIVER` enum, and one arm in `mail.factory.ts`. The
`switch` has no `default`, so forgetting the arm is a compile error rather than
a silent fallback to `console` in production.

### Startup verification

On boot the server calls `mailProvider.verify()` — for SMTP that opens a
connection, completes the TLS handshake, and authenticates without sending
anything. The result is logged:

```
INFO: Mail provider ready                    driver=smtp latencyMs=812
```

A failure is logged at `error` and **the server still starts**:

```
ERROR: SMTP verification failed              code=EAUTH
ERROR: Mail provider unavailable — verification and password-reset emails
       will fail until this is fixed
       reason="authentication rejected — check SMTP_USER and SMTP_PASSWORD
               (Gmail requires an App Password)"
```

This asymmetry with the database is deliberate. Without Postgres nothing works,
so that failure is fatal. Without mail, everything except verification and
password reset works, and both have a resend path — killing the process would
take chat and documents down to protect an email nobody was waiting for.

---

## Gmail setup

Gmail will not accept your account password over SMTP. You need an **App
Password**: a 16-character credential scoped to one application, revocable on
its own, and unaffected by rotating your real password.

### 1 — Turn on 2-Step Verification

App Passwords do not exist without it.

1. Go to <https://myaccount.google.com/security>
2. Under *How you sign in to Google*, choose **2-Step Verification**
3. Follow the prompts

### 2 — Create an App Password

1. Go to <https://myaccount.google.com/apppasswords>
   (the page 404s or redirects if 2-Step Verification is off — that is the
   usual reason people cannot find it)
2. Type a name — `Lumora` — and select **Create**
3. Copy the 16-character value. **It is shown once.**

The spaces Google displays are cosmetic; `abcd efgh ijkl mnop` and
`abcdefghijklmnop` are the same secret.

### 3 — Configure `.env`

```dotenv
MAIL_DRIVER=smtp
MAIL_FROM="Lumora <yourgmail@gmail.com>"

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=yourgmail@gmail.com
SMTP_PASSWORD=abcdefghijklmnop

SMTP_CONNECTION_TIMEOUT=10000
SMTP_GREETING_TIMEOUT=10000
SMTP_SOCKET_TIMEOUT=10000
```

**`MAIL_FROM` must contain the same address as `SMTP_USER`.** Google silently
rewrites a mismatched `From` to the authenticated account. Mail still arrives,
but DKIM alignment breaks and it tends to land in spam — a failure that looks
like "our emails go to junk" rather than "the config is wrong".

### Port and TLS

`587` + `SMTP_SECURE=false` is STARTTLS; `465` + `SMTP_SECURE=true` is implicit
TLS. Either works. **They must agree** — a mismatch produces a connection that
hangs until the socket timeout rather than a clean refusal, so the config
schema rejects the combination at boot rather than letting you debug it as a
network problem.

Either way the session is encrypted: with `SMTP_SECURE=false` the transport
sets `requireTLS`, so it fails the send if STARTTLS is unavailable instead of
falling back to cleartext.

### Verifying it works

```bash
npm run build && npm start
```

Look for `Mail provider ready`. Then:

```bash
curl -X POST http://localhost:4000/api/v1/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"Test","email":"you@gmail.com","password":"a-long-passphrase-1A"}'
```

### Troubleshooting

| Symptom | Cause |
|---|---|
| `code=EAUTH` | Account password instead of an App Password, or 2-Step Verification off. |
| `apppasswords` page 404s | 2-Step Verification is not enabled. |
| Connection hangs ~10s then times out | `SMTP_PORT` / `SMTP_SECURE` mismatch, or egress on 587 is blocked. |
| Mail arrives but lands in spam | `MAIL_FROM` does not match `SMTP_USER`. |
| `code=EDNS` | `SMTP_HOST` typo, or no DNS from the container. |

### Limits

A consumer Gmail account allows roughly **500 recipients per day**; Workspace
allows about 2,000. That is fine for development and for a demo, and is not a
transactional-email service: it has no per-message delivery reporting, no
suppression list, and no bounce webhooks. A real deployment moves to a
transactional provider — which is one new file behind the same interface.

---

## Environment

Every variable is validated by Zod at boot (`src/config/env.ts`); the process
exits non-zero and names the offending variable if any is missing or malformed.
`.env.example` is the complete list.

`process.env` is readable **only** inside `src/config/env.ts` — an ESLint rule
enforces it, so every configuration value is typed and its existence proven.

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Watch mode on :4000 |
| `npm run build` | Compile to `dist/` and copy migrations |
| `npm start` | Run the compiled output |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:status` | Show applied / pending / modified |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

Migrations are forward-only, applied in a transaction, guarded by a Postgres
advisory lock, and checksummed — editing an applied migration is refused rather
than silently diverging from what production ran.
