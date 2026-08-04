# Deploying

> **If you are replacing an earlier version, read "Replacing an earlier deploy" at the bottom first.**
> Files left behind by a previous ZIP are the most likely reason a build succeeds and the backend then crashes.


About 25 minutes on a laptop. Free tiers throughout.

---

## 1. Put it on GitHub

Unzip the project, then in that folder:

```bash
npm install          # optional locally, but it writes the lockfile
git init
git add .
git commit -m "Docket console"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/docket-console.git
git push -u origin main
```

Make the repository **private**. It carries your team's names, mobile numbers and email addresses.

If you'd rather avoid the command line: create an empty private repo on github.com, then use the **Add file → Upload files** button and drag the whole folder in.

---

## 2. Import into Vercel

1. Sign in at vercel.com with GitHub.
2. **Add New → Project**, pick the repository, click **Import**.
3. Framework preset should read **Next.js** — Vercel detects it. Leave build command, output directory and install command on their defaults.
4. Click **Deploy**. The build will succeed; the app won't work yet, because there's no database. That's expected.

---

## 3. Attach the database

1. In the project: **Storage → Create Database → Postgres** (Neon), pick a region near you — Mumbai or Singapore.
2. Connect it to the project. `POSTGRES_URL` and its siblings are added for you.

---

## 4. Add the secret

**Settings → Environment Variables → Add**:

- Name `SESSION_SECRET`
- Value: a long random string. Generate one with
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  or mash the keyboard for 40 characters.
- Apply to Production, Preview and Development.

Then **Deployments → ⋯ on the latest → Redeploy** so the new variables take effect.

---

## The console diagnoses itself

If the first call fails, the console now runs a server check on its own and prints the result on screen: the HTTP status and the first part of the response body for `/api/ping`, `/api/diag` and `/api/auth`. There is a **Copy this report** button. That report is the fastest way to get a fix — it contains no password and no connection string.

## Reading the report

- **`/api/ping` fails** — the deployment or the platform is the problem, not the code. That route imports nothing at all. Compare the commit hash in Vercel's Deployments tab with your latest push.
- **`/api/ping` works, `/api/diag` fails** — the failure is in the shared server chunk. The body of the reply names the module.
- **All three return JSON, but `/api/auth` is 500** — read its `error` and `where` fields; they name the module and the reason.
- **Next's HTML error page instead of JSON** — the crash is happening outside the route handler entirely: check Vercel → your project → **Logs**, filter on `/api/auth`, and open the newest entry. The real stack trace is there.

## When the backend misbehaves, in order

Three URLs, in this order. Each one narrows the problem.

**1. `/api/ping`** — imports nothing at all.
- Returns JSON → the deployment and the platform are fine; the problem is in the app.
- Fails or 404s → the build did not deploy what you think it did. Compare the commit hash in Vercel's Deployments tab with your latest push.

**2. `/api/docket?action=diag`** — no sign-in, no database.
- Reports the build number, which database variable was found, whether the driver loaded, which driver is in use, and what to fix.
- If the build number is not the one you just pushed, Vercel is serving an older deployment.

**3. `/api/docket?action=staff`** — the real thing.
- Any failure now returns JSON naming the module that failed and the first lines of the stack. No more blank HTML error pages.

## Before anything else: `/api/diag`

Whatever state the deployment is in, open:

```
https://your-project.vercel.app/api/docket?action=diag
```

It needs no sign-in and no database, and it imports nothing that can crash, so it answers even when the rest of the backend cannot. It reports the build number, which database variable it found, whether the driver loaded, whether the connection succeeded, and a numbered list of what to fix.

If that URL returns **404**, the deployment is running older code — the push did not land, or Vercel built a different commit. Check the Deployments tab against your latest commit hash.

## 5. First run

Open `https://your-project.vercel.app/api/docket?action=diag` first. It needs no sign-in and reports exactly what is and is not in place — the Node version, which database variable it found, whether the driver loaded, whether the connection succeeded, and a numbered list of what to do about anything missing. It never prints a connection string or a secret.

Then `https://your-project.vercel.app/api/health`. You want:

```json
{ "ok": true, "checks": { "sessionSecret": true, "database": true, ... } }
```

If `database` is false, the message tells you what Postgres said. If `sessionSecret` is false, the variable didn't take — add it and redeploy.

Then open the site itself. The first request builds the tables and adds the thirteen people.

Sign in as **Sushil**, PIN **4444** (the last four digits of the mobile on file). Everyone's starting PIN follows the same rule; Sneka, Swetha and Rajashekar have no number on file, so theirs is **0000**.

Straight away:

1. **Setup → PINs** — reset the 0000 ones and change your own.
2. **Setup → Properties & companies** — adjust the list.
3. **Setup** — office name, shift start, end-of-day cut-off.
4. **Setup → Team list** — fill in the missing email addresses. Email is how the reminders reach people.

---

## 6. Turn the reminder emails on

1. Sign up free at **resend.com**, add and verify your domain (`revanzadevelopers.com`), and create an API key.
2. In Vercel → Settings → Environment Variables, add:
   - `RESEND_API_KEY` — the key
   - `MAIL_FROM` — `Docket <docket@revanzadevelopers.com>`
   - `APP_URL` — `https://your-project.vercel.app`
3. Redeploy.
4. Test it: sign in as the owner, go to **Reminders**, and press **Email everyone pending now**.

The scheduled runs are set in `vercel.json` for 09:30 and 17:30 India time (04:00 and 12:00 UTC). To move them, edit the two `schedule` lines — standard cron, in UTC — and push. Vercel's Hobby plan runs cron approximately, within the hour.

The morning or evening wording is chosen from the hour, so the two schedules share one route.

---

## 7. Point your domain at it

**Settings → Domains → Add**, enter `tasks.revanzadevelopers.com`, and add the CNAME record Vercel shows you at your DNS host. It's live within minutes.

If you'd rather keep the address you've already given people, upload the small launcher page to `revanzadevelopers.com/task-console.html` with the Vercel URL pasted in.

Update `APP_URL` afterwards so the email buttons point at the right place.

---

## 8. Get it onto everyone's phone

Send the link. On the phone: open it, then **Share → Add to Home Screen**. It opens full screen like an app, and the sign-in is remembered for 30 days.

Ask everyone to allow **camera** and **location** when prompted — attendance needs both.

---

## Making changes later

Push to `main` and Vercel redeploys within a minute. Nobody has to do anything; the next time they open the console they have the new version.

To try something risky first, push to a branch — Vercel builds it at its own preview URL with the same database. If you want a preview that can't touch live data, attach a second Postgres database to the preview environment.

---

## If something goes wrong

**Everything 500s, or `FUNCTION_INVOCATION_FAILED`.** Open `/api/diag`. It answers without a session and without a database, so it works even when everything else is broken. If it says the pg driver did not load, open `next.config.mjs` and remove `'pg'` from `experimental.serverComponentsExternalPackages`, then redeploy — that switches it from being required at runtime to being bundled into the function, and one of the two always works.

Also check `/api/health` — it names the missing piece. Otherwise Vercel → Deployments → the deployment → **Functions**, and read the log. Almost always a missing `SESSION_SECRET` or `POSTGRES_URL`.

**"No Next.js version detected."** The repo you pushed isn't this one, or the push didn't include `package.json`. Confirm `next` appears under dependencies in the file on GitHub.

**Build fails on a dependency version.** Delete `node_modules` and any `package-lock.json`, run `npm install` locally, commit the lockfile it writes, and push.

**"Cannot find module @vercel/postgres" or similar at runtime.** That package is no longer used — the driver is `pg`, kept out of the bundle by `serverComponentsExternalPackages` in `next.config.mjs`. If you ever add a database library that loads its entry point dynamically, add it to that list too, or it will pass the build and crash on first request.

**"No database URL."** The Postgres integration set a variable name this app does not read. It accepts `POSTGRES_URL`, `DATABASE_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_PRISMA_URL` and `PGURL`. Check Settings → Environment Variables and copy your connection string into `POSTGRES_URL` if it is under some other name.

**"Your session has expired" straight after signing in.** `SESSION_SECRET` changed, or differs between environments. Set it in all three and redeploy.

**Photos won't upload.** Check the camera permission in the browser, and that the phone isn't in Low Data mode. The console falls back to the phone camera button and, failing that, lets attendance be saved flagged as unverified.

**Reminders don't arrive.** Reminders tab → **Email everyone pending now** reports the exact refusal from Resend. Usually an unverified sending domain, or `MAIL_FROM` on a domain the key doesn't cover.

**Someone can't see their tasks.** Have them sign out and back in. If the board revision at the bottom of Setup differs between two people, one is on a cached page — pull to refresh.

---

## Backing up

Neon takes its own snapshots, but keep your own too:

```bash
npx vercel env pull .env.local
psql "$(grep POSTGRES_URL .env.local | cut -d= -f2- | tr -d '\"')" -c "\copy (select * from tasks) to 'tasks.csv' csv header"
```

Or simply use **Export CSV** from All tasks and Attendance in the console once a month.


---

## Replacing an earlier deploy

Extracting a new ZIP *over* the old folder leaves the old files in place. That is fatal here, because earlier versions had routes at `/api/auth`, `/api/diag`, `/api/board`, `/api/media` and `/api/cron` which imported a `lib/` folder that this version deletes. Those stale routes still deploy, still get requests — and throw while loading, which is what produces Next's blank HTML 500 while `/api/ping` carries on working.

**The safe way, from the project folder:**

```bash
npm run verify        # names anything left over; exits non-zero if the repo is dirty
```

If it reports stale paths, delete them and run it again:

```bash
git rm -r --cached lib app/api/auth app/api/board app/api/media app/api/diag app/api/health app/api/cron 2>/dev/null
rm -rf lib app/api/auth app/api/board app/api/media app/api/diag app/api/health app/api/cron
npm run verify
git add -A && git commit -m "Replace backend with single route" && git push
```

**The certain way** — start clean, which takes five minutes and removes every doubt about both stale files and stale project settings:

1. Create a **new** private repository on GitHub.
2. Unzip this release into an empty folder. Do not copy anything from the old one.
3. `npm run verify` — it should say "Clean. Safe to push."
4. Push, then create a **new** Vercel project from that repository.
5. Attach Postgres, add `SESSION_SECRET`, deploy.
6. Point your domain at the new project when it works, and delete the old one.

## Confirming what is actually deployed

`/api/ping` reports the build number and the commit it came from:

```json
{ "ok": true, "version": "1.6.0", "theOnlyApiRoute": "/api/docket", "commit": "a1b2c3d" }
```

If that version does not match the one under Setup, Board health in the console, the deployment is a mixture of releases. This version has exactly **two** API routes — `/api/docket` and `/api/ping`. Any other `/api/...` path answering at all means old files are still there.
