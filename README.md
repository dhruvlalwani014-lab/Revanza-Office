# Docket Console

Task, case, attendance and voice-note tracking for a small office. A Next.js 14 application (App Router) with Postgres, deployed on Vercel.

---

## The config is now nearly empty

`next.config.mjs` no longer sets `serverComponentsExternalPackages` or `outputFileTracingIncludes`. Neither is needed any more — the driver is imported lazily and there is a dependency-free fallback — and every option in a config file is one more thing that can misbehave on a platform you cannot inspect from here. What is left is `reactStrictMode`, the lint exclusion, and three security headers.

## Before pushing: `npm run verify`

It checks the repository is this release and nothing else — required files present, superseded folders gone, and no route importing anything at the top of the file. Leftovers from an earlier ZIP are the most likely cause of a build that succeeds and a backend that then crashes, because a stale route still imports a `lib/` folder this version no longer ships.

## Nothing loads at the top of a route file

Every `app/api/**/route.js` now imports nothing. The real handler is loaded inside the request, inside a `try`, and any failure comes back as JSON naming the module and the first lines of the stack.

This matters because a module that throws while being *loaded* kills the function before any handler exists, and Next answers with its own HTML error page — no message, no stack, nothing to act on. That is exactly what produced the bare "500: Internal Server Error" page.

Proven by sabotaging `lib/db.js` so it throws at import:

```
route module itself loads: true
GET /api/auth -> 500
  error : The server could not load the sign-in module: simulated module-load failure inside lib/db.js
  where : the sign-in module
  stack : Error: simulated module-load failure inside lib/db.js
GET /api/ping -> 200 (unaffected)
```

## Diagnosing it in one URL

`/api/diag` — no sign-in, no database, imports nothing that can fail. It reports the build number, the Node version, which of the five accepted database variables was found, whether `pg` loaded, whether the connection worked, which driver is actually in use, and what to do about anything missing. It never prints a secret or a connection string.

The console also shows the build number under Setup, Board health — so you can tell at a glance whether the deployment is running the code you last pushed.

## The database can no longer take the backend down

`pg` is tried first. If it cannot be loaded — a bundling problem, a missing module, an interop mismatch — the app falls back to talking to Neon over plain HTTPS with `fetch`, which needs no npm package and cannot be broken by a bundler. Vercel Postgres is Neon, so this path fits your database.

Tested with `pg` deleted from `node_modules` entirely:

```
PASS  module loads with no pg installed
PASS  GET /api/auth works over the HTTP fallback -> 200
PASS  sign-in works with no pg at all -> 200
PASS  wrong PIN still 401
PASS  diag says which driver is in use: neon-http
PASS  diag explains the situation
```

The fallback only triggers when the driver itself is unavailable, never when the database rejects a query — a genuine SQL error still surfaces as a genuine SQL error.

## Three failures this project has already been through

**`500 FUNCTION_INVOCATION_FAILED` on every request.** That code means the function died while its modules were being loaded — before any `try`/`catch` existed, which is why nothing readable ever reached the browser. `lib/sql.js` did this at the top of the file:

```js
import pg from 'pg';
const { Pool } = pg;      // throws at load if pg is absent or interop-wrapped
```

If `pg` was missing from the traced bundle, or the bundler handed back `{ default: undefined }` instead of the module, that destructure threw during import and took the whole function with it.

**Now:** nothing in `lib/sql.js` runs at import time. The driver is imported on the first query, inside a `try`, and both interop shapes are accepted (`mod.Pool` or `mod.default.Pool`). If the ESM import fails there is a second attempt via `createRequire`. If both fail you get a 500 with the actual reason in the body instead of a platform crash — and `/api/diag` will tell you which piece is missing.

Proven against all three original conditions:

```
pg module deleted        -> module loads; GET /api/auth -> 500 "The Postgres driver could not be loaded (Cannot find package 'pg')"
pg present, wrong shape  -> module loads; GET /api/auth -> 500 "loaded but is the wrong shape. Keys: default"
no SESSION_SECRET, no DB -> /api/diag -> 503 listing both, with the fix for each
```

## Two earlier failures

**"No Next.js version detected."** The first export was a static site with functions in `/api` — valid on Vercel only under the *Other* preset. This is now a real Next.js application.

**"Cannot find module .../@vercel/postgres/dist/index-node.cjs" at runtime.** The build passed and every request then crashed. That package picks its entry point through conditional exports, and Next's file tracer did not copy the resulting `.cjs` into the deployed function, so `node_modules` was complete during the build and incomplete inside the lambda.

Fixed in three ways rather than one:

1. `@vercel/postgres` is gone. `lib/sql.js` uses `pg` directly — a plain CommonJS main entry with nothing conditional about it — and provides the same tagged-template API, so no calling code changed.
2. `next.config.mjs` lists `pg` under `serverComponentsExternalPackages`, so Next never bundles it and simply requires it at runtime.
3. The same config force-includes `pg` and its dependencies via `outputFileTracingIncludes`, whatever the tracer decides on its own.

It also accepts `POSTGRES_URL`, `DATABASE_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_PRISMA_URL` or `PGURL`, because different Vercel Postgres integrations set different names, and picking the wrong one is the next thing that would have failed.

## Why the first version failed

The previous export was a static site with serverless functions in `/api` — a valid Vercel project, but only under the **Other** framework preset. Your project was set to **Next.js**, so the build looked for a `next` dependency and stopped.

This version is an actual Next.js application. `next`, `react` and `react-dom` are declared, there is an `app/` directory, a `next.config.mjs`, and `next build` is the build command. It deploys under the Next.js preset, which is also what Vercel auto-detects.

---

## Structure

```
app/
  layout.js                 root layout and metadata
  page.js                   front door: redirects to the console
  not-found.js              404
  api/docket/route.js       the entire backend, in one file
  api/ping/route.js         a heartbeat that imports nothing
public/
  console.html              the entire front end, one self-contained file
  manifest.webmanifest, icon.png, apple-touch-icon.png
next.config.mjs, jsconfig.json, .eslintrc.json, vercel.json, .env.example
```

**Why the backend is one file.** Three deployments failed in a row, each time inside the shared module graph: a file under `lib/` that would not load inside the deployed function, taking the whole route down before any error handling existed. `/api/ping` kept working for one reason — it imported nothing.

So `app/api/docket/route.js` imports nothing from this project either. No `lib/`, no helpers, no handlers. The only imports in the whole backend are Node's own `crypto` and the Postgres driver, and both are loaded inside a request, inside a `try`. It is longer than it would be split across files. That is the trade: one file that loads, instead of six that might not.

Everything reaches it through one endpoint:

| Request | Who | Purpose |
|---|---|---|
| `GET /api/docket?action=staff` | anyone | Names for the sign-in list |
| `GET /api/docket?action=board` | signed in | The whole board |
| `GET /api/docket?action=media&id=` | signed in | One photo or recording |
| `GET /api/docket?action=diag` | anyone | Deployment report, no secrets in it |
| `POST {action:'signIn'}` | anyone | Name and PIN, returns a token |
| `POST {action:'setPin'}` | self / owner | Change or reset a PIN |
| `POST {action:'save'}` | signed in | Save the board, with a revision check |
| `POST {action:'media'}` | signed in | Upload a photo or recording |
| `POST {action:'reminders'}` | owner or cron | Send the reminder emails |

## Setup

Step by step in [`docs/DEPLOY.md`](docs/DEPLOY.md). In short:

1. Push to GitHub, import in Vercel (preset: **Next.js**, detected automatically).
2. **Storage → Create Database → Postgres.** Sets `POSTGRES_URL`.
3. Add `SESSION_SECRET` — any 32+ character random string.
4. Redeploy. The first request creates the tables and adds the team.
5. Visit `/api/health` to confirm.
6. Optional: `RESEND_API_KEY`, `MAIL_FROM`, `APP_URL` for the reminder emails.

**Starting PINs** are the last four digits of each person's mobile; `0000` for anyone without one on file. Change those before you share the link.

---

## Local development

```bash
npm install
npx vercel link
npx vercel env pull .env.local
npm run dev            # http://localhost:3000
npm run build          # production build
npm run lint
```

There is **no lockfile in this repo on purpose.** A lockfile written by hand rather than by npm is worse than none — `npm ci` fails on any mismatch. Vercel runs `npm install` when it finds no lockfile, which resolves the ranges in `package.json` cleanly. Run `npm install` locally once and commit the `package-lock.json` it produces if you want pinned builds.

---

## What I could and could not verify

Built and audited offline, with no network access, so I want to be exact about this rather than claim more than I did.

**Executed, not just inspected.** The route handlers were run against a test double for `pg` — the real handler code, real auth, real responses:

```
PASS  auth route exports GET/POST/runtime/dynamic
PASS  GET /api/auth returns the sign-in list
PASS  sign-in list leaks no PIN or email
PASS  wrong PIN -> clean 401 JSON
PASS  unknown person -> same 401, no leak
PASS  correct PIN -> 200 with token
PASS  unknown action -> 400
PASS  malformed body -> 400 not 500
PASS  GET /api/board with token
PASS  board response strips pin_hash
PASS  GET /api/board without token -> 401
PASS  forged token -> 401
PASS  malformed save -> 400
PASS  media rejects a disallowed type -> 415
PASS  media accepts a jpeg -> 200 with id
PASS  health reports ready
PASS  cron without auth -> 401
PASS  cron as owner, no mail configured -> 200 and says so
PASS  pool uses TLS for a hosted database
PASS  pool sized for serverless
```

That run found a real bug, now fixed: `/api/auth` returned `signIn(body)` without awaiting it, so a wrong PIN escaped the `try` block and crashed the function instead of returning a 401.

**Verified mechanically:**
- Every `.js` file parses (`node --check` on all 12).
- Every relative import resolves to a file that exists.
- Every bare import is either a Node builtin, a Next/React internal, or a package declared in `package.json`.
- Every `/api/...` path the browser calls has a matching `route.js`.
- Every asset the console references exists in `public/`.
- Every `data-act` button in the UI has a handler, and every handler has a button.
- All JSON files parse; JSX in the three React files is tag-balanced.

**Not verified, because it needs the network:** `npm install` and `npm run build` were not run — this environment has no network access, so npm cannot reach the registry. Every dependency version is pinned exactly (no `^`), so what installs is what I designed against. The build surface is deliberately small — no TypeScript, no CSS pipeline, no image optimisation, lint excluded from the build — so the usual causes of a failed first deploy are absent, but I am not going to tell you I ran a command I didn't.

If the first build does fail, the log will name the file, and it will almost certainly be a version resolution rather than the code. Send me the log and I'll fix it.

---

## Known limits, stated plainly

- **Media lives in Postgres** as base64 text. Photos compress to roughly 150 KB, so the free 0.5 GB tier holds a few thousand. When it fills, move `app/api/media/route.js` to Vercel Blob or S3 — the ids stay the same.
- **PINs are not passwords.** Four digits stop the wrong colleague posting as someone else; they don't stop a determined attacker.
- **Speech-to-text is the browser's own**, so quality varies by device and struggles with noise and heavy code-switching. The audio is always kept and the text is editable before saving.
- **A gallery photo is accepted** when the camera can't open, and is stamped "added from phone" rather than passed off as a live capture. Attendance with no photo is flagged unverified on the owner's board.
- **Cron on Vercel's Hobby plan** fires approximately, within the hour, not on the minute.
