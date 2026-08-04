/**
 * The entire backend, in one file, importing nothing from the project.
 *
 * Every previous failure came from the shared module graph: a file under lib/
 * that would not load inside the deployed function, taking the whole route with
 * it before any error handling existed. /api/ping worked precisely because it
 * imported nothing. So this route imports nothing either — no lib/, no handlers,
 * no helpers. The only imports are Node's own crypto and the Postgres driver,
 * both loaded inside a request and inside a try.
 *
 * It is longer than it would be split across files. That is the trade: one file
 * that loads, instead of six that might not.
 *
 * Actions, all through this one endpoint:
 *   GET  ?action=staff              the sign-in list         (open)
 *   GET  ?action=board              the whole board          (signed in)
 *   GET  ?action=media&id=...       one photo or recording   (signed in)
 *   GET  ?action=diag               deployment report        (open, no secrets)
 *   POST {action:'signIn'}          name + PIN -> token      (open)
 *   POST {action:'setPin'}          change or reset a PIN    (self / owner)
 *   POST {action:'save'}            save the board           (signed in)
 *   POST {action:'media'}           upload a photo or audio  (signed in)
 *   POST {action:'reminders'}       send the emails          (owner or cron)
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const VERSION = '1.8.0';

/* ============================================================ responses */

function json(body, status = 200) {
  return new Response(JSON.stringify({ serverNow: new Date().toISOString(), ...body }, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function fail(e) {
  const status = e && e.status ? e.status : 500;
  const message = e && e.message ? e.message : 'Something went wrong.';
  if (status >= 500) console.error('[docket]', e);
  return json(
    {
      ok: false,
      error: message,
      version: VERSION,
      stack: String((e && e.stack) || '').split('\n').slice(0, 4)
    },
    status
  );
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'That request was not readable.');
  }
}

/* ============================================================ crypto */

let CRYPTO = null;

async function nodeCrypto() {
  if (CRYPTO) return CRYPTO;
  const mod = await import('node:crypto');
  CRYPTO = mod.default || mod;
  return CRYPTO;
}

async function hashPin(pin) {
  const c = await nodeCrypto();
  const salt = c.randomBytes(16).toString('hex');
  return `${salt}:${c.scryptSync(String(pin), salt, 32).toString('hex')}`;
}

async function checkPin(pin, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const c = await nodeCrypto();
  const [salt, hash] = stored.split(':');
  try {
    const test = c.scryptSync(String(pin), salt, 32);
    const known = Buffer.from(hash, 'hex');
    return known.length === test.length && c.timingSafeEqual(known, test);
  } catch {
    return false;
  }
}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new HttpError(
      500,
      'SESSION_SECRET is missing or too short. Add it under Settings, Environment Variables, then redeploy.'
    );
  }
  return s;
}

async function signToken(id) {
  const c = await nodeCrypto();
  const exp = Date.now() + 30 * 86400000;
  const body = `${id}.${exp}`;
  return `${body}.${c.createHmac('sha256', secret()).update(body).digest('base64url')}`;
}

async function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const c = await nodeCrypto();
  const [id, exp, sig] = parts;
  const expect = c.createHmac('sha256', secret()).update(`${id}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !c.timingSafeEqual(a, b)) return null;
  if (!Number(exp) || Number(exp) < Date.now()) return null;
  return id;
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/* ============================================================ database */

const URL_KEYS = ['POSTGRES_URL', 'DATABASE_URL', 'POSTGRES_URL_NON_POOLING', 'POSTGRES_PRISMA_URL', 'PGURL'];

let pool = null;
let PoolCtor = null;
let driverKind = '';

function connectionString() {
  for (const key of URL_KEYS) {
    const v = process.env[key];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

function whichUrlKey() {
  for (const key of URL_KEYS) if (process.env[key] && String(process.env[key]).trim()) return key;
  return '';
}

async function loadDriver() {
  if (PoolCtor) return PoolCtor;
  let mod;
  let first = '';
  try {
    mod = await import('pg');
  } catch (e) {
    first = e && e.message ? e.message : String(e);
    try {
      const { createRequire } = await import('node:module');
      mod = createRequire(`${process.cwd()}/`)('pg');
    } catch (e2) {
      throw new Error(`pg would not load (${first} | require: ${e2 && e2.message ? e2.message : e2})`);
    }
  }
  PoolCtor = mod.Pool || (mod.default && mod.default.Pool) || null;
  if (typeof PoolCtor !== 'function') {
    throw new Error(`pg loaded but exposed no Pool. Keys: ${Object.keys(mod).join(', ') || 'none'}`);
  }
  driverKind = 'pg';
  return PoolCtor;
}

async function getPool() {
  if (pool) return pool;
  const cs = connectionString();
  if (!cs) {
    throw new HttpError(
      500,
      `No database URL. In Vercel: Storage, Create Database, Postgres, then redeploy. Looked for ${URL_KEYS.join(', ')}.`
    );
  }
  const Pool = await loadDriver();
  const local = /localhost|127\.0\.0\.1/.test(cs);
  const off = /sslmode=disable/.test(cs);
  pool = new Pool({
    connectionString: cs,
    ssl: local || off ? false : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', (err) => console.error('[docket] idle client:', err && err.message));
  return pool;
}

/** Neon speaks SQL over plain HTTPS, which needs no package at all. */
function neonEndpoint(cs) {
  try {
    const u = new URL(cs.replace(/^postgres(ql)?:\/\//, 'https://'));
    return /\.neon\.tech$/i.test(u.hostname) ? `https://${u.hostname}/sql` : '';
  } catch {
    return '';
  }
}

async function neonQuery(cs, text, values) {
  const endpoint = neonEndpoint(cs);
  if (!endpoint) throw new Error('This database cannot be reached over HTTP.');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'neon-connection-string': cs,
      'neon-array-mode': 'false'
    },
    body: JSON.stringify({ query: text, params: values })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`Neon HTTP ${res.status}: ${raw.slice(0, 200)}`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Neon returned something unreadable: ${raw.slice(0, 120)}`);
  }
  return { rows: parsed.rows || [], rowCount: parsed.rowCount ?? (parsed.rows || []).length };
}

async function q(text, values = []) {
  try {
    const p = await getPool();
    return await p.query(text, values);
  } catch (e) {
    const driverGone = /pg would not load|exposed no Pool/i.test(e.message || '');
    if (!driverGone) throw e;
    const cs = connectionString();
    if (!cs || !neonEndpoint(cs)) throw e;
    driverKind = 'neon-http';
    return neonQuery(cs, text, values);
  }
}

/** Tagged template: values always become $1, $2 … never string concatenation. */
async function sql(strings, ...values) {
  let text = '';
  strings.forEach((part, i) => {
    text += part;
    if (i < values.length) text += `$${i + 1}`;
  });
  return q(text, values);
}

/* ============================================================ schema and seed */

const SEED_STAFF = [
  ['u1', 'Sushil', 'Owner', '', '9841344444', 'sushillalwani@gmail.com'],
  ['u2', 'Mrithula', 'Legal', '', '6382813293', ''],
  ['u3', 'Prathik', 'Legal', '', '9042425922', ''],
  ['u4', 'Shivani', 'Documentation', '', '7550171306', ''],
  ['u5', 'Vijay', 'Accounts', 'Accounts head', '9841498198', ''],
  ['u6', 'Prem', 'Accounts', 'Bank handling', '9514300000', ''],
  ['u7', 'Senthil', 'Executive', '', '9094551555', ''],
  ['u8', 'Mariya', 'Executive', '', '9930723456', ''],
  ['u9', 'Vinoth', 'Executive', '', '9648223456', ''],
  ['u10', 'Sneka', 'Admin', '', '', ''],
  ['u11', 'Swetha', 'Admin', '', '', ''],
  ['u12', 'Rajashekar', 'Engineer', '', '', ''],
  ['u13', 'Adv Praveen', 'Legal', 'Advocate', '8122858262', 'legal@revanza.in']
];

const DEFAULT_SETTINGS = {
  officeName: 'Revanza',
  eod: '18:30',
  reminderHour: '09:00',
  shiftStart: '09:30',
  dial: '91',
  properties: [
    'Digital Zone',
    'Fortune Greens',
    "Kelly's Court",
    'Revanza Leasing India Private Limited',
    'Thoraipakkam',
    'Others'
  ]
};

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS staff (
    id text PRIMARY KEY, name text NOT NULL, role text NOT NULL DEFAULT 'Executive',
    note text DEFAULT '', phone text DEFAULT '', email text DEFAULT '',
    pin_hash text NOT NULL, force_pin boolean DEFAULT false, pin_set_at timestamptz,
    active boolean DEFAULT true, created_at timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id text PRIMARY KEY, no text, property text DEFAULT '', title text NOT NULL,
    detail text DEFAULT '', type text DEFAULT 'General', assignee text, assigner text,
    priority text DEFAULT 'Medium', deadline text DEFAULT '', status text DEFAULT 'Not started',
    follow_up text DEFAULT '', created_at timestamptz DEFAULT now(), completed_at timestamptz,
    case_json jsonb, stages_json jsonb DEFAULT '[]', history_json jsonb DEFAULT '[]',
    links_json jsonb DEFAULT '[]', archived boolean DEFAULT false)`,
  // Migration for databases created before 1.7.0 — idempotent, safe every boot.
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS updates (
    id bigserial PRIMARY KEY, task_id text NOT NULL, seq int NOT NULL,
    at timestamptz NOT NULL DEFAULT now(), author text, status text, comment text,
    end_time timestamptz, delay text, issues text, link_issue text, follow_up text,
    next_process text, priority text, photo_id text, gps_json jsonb, gps_note text,
    audio_id text, voice_text text, late boolean DEFAULT false, reassign_to text,
    stage text, is_edit boolean DEFAULT false, upload boolean DEFAULT false,
    UNIQUE (task_id, seq))`,
  `CREATE TABLE IF NOT EXISTS attendance (
    id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), person text NOT NULL,
    kind text NOT NULL, gps_json jsonb, note text DEFAULT '', photo_id text,
    unverified boolean DEFAULT false, upload boolean DEFAULT false)`,
  `CREATE TABLE IF NOT EXISTS notes (
    id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), person text NOT NULL,
    title text DEFAULT '', body text DEFAULT '', audio_id text, dur int DEFAULT 0,
    task_id text DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS media (
    id text PRIMARY KEY, owner text, kind text, mime text, data text NOT NULL,
    created_at timestamptz DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS updates_task_idx ON updates (task_id)`,
  `CREATE INDEX IF NOT EXISTS attendance_at_idx ON attendance (at DESC)`,
  `CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee)`
];

let schemaReady = false;

async function ensureSchema() {
  if (schemaReady) return;

  // One statement at a time: the HTTP fallback accepts only one per request.
  for (const statement of STATEMENTS) await q(statement);

  const { rows } = await q('SELECT count(*)::int AS n FROM staff');
  if (!Number(rows[0] && rows[0].n)) {
    const values = [];
    const chunks = [];
    for (let i = 0; i < SEED_STAFF.length; i++) {
      const [id, name, role, note, phone, email] = SEED_STAFF[i];
      values.push(id, name, role, note, phone, email, await hashPin((phone || '').slice(-4) || '0000'));
      const b = i * 7;
      chunks.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, now())`);
    }
    await q(
      `INSERT INTO staff (id, name, role, note, phone, email, pin_hash, pin_set_at)
       VALUES ${chunks.join(', ')} ON CONFLICT (id) DO NOTHING`,
      values
    );
    await setSetting('settings', DEFAULT_SETTINGS);
    await setSetting('rev', 0);
    await setSetting('seq', 0);
  }

  schemaReady = true;
}

async function getSetting(key, fallback = null) {
  const { rows } = await sql`SELECT value FROM settings WHERE key = ${key}`;
  return rows.length ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await sql`INSERT INTO settings (key, value) VALUES (${key}, ${JSON.stringify(value)})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

/* ============================================================ the board */

const iso = (d) => (d ? new Date(d).toISOString() : '');

function tidy(o) {
  const out = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === null || v === undefined || v === '' || v === false) continue;
    out[k] = v;
  }
  return out;
}

async function loadBoard() {
  await ensureSchema();

  const staffRows = await q('SELECT * FROM staff WHERE active ORDER BY created_at');
  const taskRows = await q('SELECT * FROM tasks WHERE NOT archived ORDER BY created_at');
  const archivedRows = await q(
    `SELECT id, no, property, title, assignee, assigner, priority, status, deadline,
            created_at, completed_at
       FROM tasks WHERE archived ORDER BY created_at`
  );
  const updateRows = await q('SELECT * FROM updates ORDER BY task_id, seq');
  const attRows = await q('SELECT * FROM attendance ORDER BY at DESC LIMIT 2000');
  const noteRows = await q('SELECT * FROM notes ORDER BY at DESC LIMIT 1000');

  const logs = new Map();
  for (const u of updateRows.rows) {
    if (!logs.has(u.task_id)) logs.set(u.task_id, []);
    logs.get(u.task_id).push(
      tidy({
        at: iso(u.at),
        by: u.author,
        status: u.status,
        comment: u.comment,
        endTime: iso(u.end_time),
        delay: u.delay,
        issues: u.issues,
        linkIssue: u.link_issue,
        followUp: u.follow_up,
        next: u.next_process,
        priority: u.priority,
        photo: u.photo_id,
        gps: u.gps_json,
        gpsNote: u.gps_note,
        upload: u.upload,
        audio: u.audio_id,
        voiceText: u.voice_text,
        late: u.late,
        reassignTo: u.reassign_to,
        stage: u.stage,
        edit: u.is_edit
      })
    );
  }

  return {
    rev: Number(await getSetting('rev', 0)),
    seq: Number(await getSetting('seq', 0)),
    settings: (await getSetting('settings', DEFAULT_SETTINGS)) || DEFAULT_SETTINGS,
    staff: staffRows.rows.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      note: s.note || '',
      phone: s.phone || '',
      email: s.email || '',
      forcePin: !!s.force_pin,
      pinSetAt: iso(s.pin_set_at)
    })),
    tasks: taskRows.rows.map((t) => ({
      id: t.id,
      no: t.no,
      property: t.property || '',
      title: t.title,
      desc: t.detail || '',
      type: t.type,
      assignee: t.assignee,
      assigner: t.assigner,
      priority: t.priority,
      deadline: t.deadline || '',
      status: t.status,
      followUp: t.follow_up || '',
      createdAt: iso(t.created_at),
      completedAt: iso(t.completed_at),
      case: t.case_json || null,
      stages: t.stages_json || [],
      history: t.history_json || [],
      links: t.links_json || [],
      log: logs.get(t.id) || []
    })),
    att: attRows.rows.map((a) => ({
      id: a.id,
      at: iso(a.at),
      by: a.person,
      kind: a.kind,
      gps: a.gps_json,
      note: a.note || '',
      photo: a.photo_id || '',
      unverified: !!a.unverified,
      upload: !!a.upload
    })),
    notes: noteRows.rows.map((n) => ({
      id: n.id,
      at: iso(n.at),
      by: n.person,
      title: n.title || '',
      text: n.body || '',
      audio: n.audio_id || '',
      doc: '',
      dur: n.dur || 0,
      task: n.task_id || ''
    })),
    archived: archivedRows.rows.map((t) => ({
      id: t.id,
      no: t.no,
      property: t.property || '',
      title: t.title,
      assignee: t.assignee,
      assigner: t.assigner,
      priority: t.priority || 'Medium',
      status: t.status,
      deadline: t.deadline || '',
      createdAt: iso(t.created_at),
      completedAt: iso(t.completed_at)
    }))
  };
}

/**
 * The browser sends the whole board back. It is folded in rather than trusted:
 * update history is append-only, and every new row is stamped by the database.
 */
async function saveBoard(next, expectRev, actor) {
  await ensureSchema();

  const currentRev = Number(await getSetting('rev', 0));
  if (expectRev !== undefined && expectRev !== null && Number(expectRev) !== currentRev) {
    return { conflict: true };
  }

  if (next.settings) await setSetting('settings', next.settings);
  if (next.seq !== undefined) await setSetting('seq', Number(next.seq) || 0);

  const known = new Set();
  for (const s of next.staff || []) {
    known.add(s.id);
    const res = await sql`UPDATE staff SET name = ${s.name}, role = ${s.role}, note = ${s.note || ''},
      phone = ${s.phone || ''}, email = ${s.email || ''}, active = true WHERE id = ${s.id}`;
    if (!res.rowCount) {
      const pin = String(s.phone || '').replace(/\D/g, '').slice(-4) || '0000';
      const hash = await hashPin(pin);
      await sql`INSERT INTO staff (id, name, role, note, phone, email, pin_hash, force_pin, pin_set_at)
        VALUES (${s.id}, ${s.name}, ${s.role}, ${s.note || ''}, ${s.phone || ''}, ${s.email || ''},
                ${hash}, true, now()) ON CONFLICT (id) DO NOTHING`;
    }
  }
  const existing = await q('SELECT id FROM staff WHERE active');
  for (const row of existing.rows) {
    if (!known.has(row.id)) await sql`UPDATE staff SET active = false WHERE id = ${row.id}`;
  }

  const counts = await q('SELECT task_id, count(*)::int AS n FROM updates GROUP BY task_id');
  const seen = new Map(counts.rows.map((r) => [r.task_id, Number(r.n)]));

  for (const t of next.tasks || []) {
    const caseJson = t.case ? JSON.stringify(t.case) : null;
    const res = await sql`UPDATE tasks SET no = ${t.no}, property = ${t.property || ''},
      title = ${t.title}, detail = ${t.desc || ''}, type = ${t.type || 'General'},
      assignee = ${t.assignee}, assigner = ${t.assigner}, priority = ${t.priority || 'Medium'},
      deadline = ${t.deadline || ''}, status = ${t.status}, follow_up = ${t.followUp || ''},
      completed_at = ${t.completedAt || null}, case_json = ${caseJson},
      stages_json = ${JSON.stringify(t.stages || [])},
      history_json = ${JSON.stringify(t.history || [])},
      links_json = ${JSON.stringify(t.links || [])} WHERE id = ${t.id}`;

    if (!res.rowCount) {
      await sql`INSERT INTO tasks (id, no, property, title, detail, type, assignee, assigner,
        priority, deadline, status, follow_up, created_at, case_json, stages_json, history_json, links_json)
        VALUES (${t.id}, ${t.no}, ${t.property || ''}, ${t.title}, ${t.desc || ''},
        ${t.type || 'General'}, ${t.assignee}, ${t.assigner}, ${t.priority || 'Medium'},
        ${t.deadline || ''}, ${t.status}, ${t.followUp || ''}, now(), ${caseJson},
        ${JSON.stringify(t.stages || [])}, ${JSON.stringify(t.history || [])},
        ${JSON.stringify(t.links || [])}) ON CONFLICT (id) DO NOTHING`;
    }

    const have = seen.get(t.id) || 0;
    const log = t.log || [];
    for (let i = have; i < log.length; i++) {
      const l = log[i];
      await sql`INSERT INTO updates (task_id, seq, at, author, status, comment, end_time, delay,
        issues, link_issue, follow_up, next_process, priority, photo_id, gps_json, gps_note,
        audio_id, voice_text, late, reassign_to, stage, is_edit, upload)
        VALUES (${t.id}, ${i}, now(), ${l.by || actor}, ${l.status || ''}, ${l.comment || ''},
        ${l.endTime || null}, ${l.delay || ''}, ${l.issues || ''}, ${l.linkIssue || ''},
        ${l.followUp || ''}, ${l.next || ''}, ${l.priority || ''}, ${l.photo || null},
        ${l.gps ? JSON.stringify(l.gps) : null}, ${l.gpsNote || ''}, ${l.audio || null},
        ${l.voiceText || ''}, ${!!l.late}, ${l.reassignTo || null}, ${l.stage || ''},
        ${!!l.edit}, ${!!l.upload}) ON CONFLICT (task_id, seq) DO NOTHING`;
    }
  }

  for (const a of next.att || []) {
    await sql`INSERT INTO attendance (id, at, person, kind, gps_json, note, photo_id, unverified, upload)
      VALUES (${a.id}, now(), ${a.by || actor}, ${a.kind}, ${a.gps ? JSON.stringify(a.gps) : null},
      ${a.note || ''}, ${a.photo || null}, ${!!a.unverified}, ${!!a.upload})
      ON CONFLICT (id) DO NOTHING`;
  }

  for (const n of next.notes || []) {
    await sql`INSERT INTO notes (id, at, person, title, body, audio_id, dur, task_id)
      VALUES (${n.id}, now(), ${n.by || actor}, ${n.title || ''}, ${n.text || ''},
      ${n.audio || null}, ${Number(n.dur) || 0}, ${n.task || ''}) ON CONFLICT (id) DO NOTHING`;
  }

  const rev = currentRev + 1;
  await setSetting('rev', rev);
  return { rev };
}

/* ============================================================ people */

async function currentUser(request) {
  const id = await readToken(bearer(request));
  if (!id) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const { rows } = await sql`SELECT * FROM staff WHERE id = ${id} AND active`;
  if (!rows.length) throw new HttpError(401, 'That name is no longer on the board.');
  return rows[0];
}

function requireOwner(user) {
  if (user.role !== 'Owner') throw new HttpError(403, 'Only the owner can do that.');
  return user;
}

/* ============================================================ email */

function mailConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

async function sendMail({ to, subject, html }) {
  if (!mailConfigured()) throw new Error('Email is not set up (RESEND_API_KEY and MAIL_FROM).');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject, html })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Email refused (${res.status}). ${text.slice(0, 200)}`);
  }
  return res.json();
}

function tzOffset() {
  const n = Number(process.env.TZ_OFFSET_MIN);
  return Number.isFinite(n) ? n : 330;
}

function todayLocal() {
  return new Date(Date.now() + tzOffset() * 60000).toISOString().slice(0, 10);
}

function localDate(at) {
  return new Date(new Date(at).getTime() + tzOffset() * 60000).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

function pendingFor(board, person, today) {
  const mine = board.tasks.filter((t) => t.assignee === person.id && t.status !== 'Completed');
  const stale = mine.filter((t) => {
    const last = t.log[t.log.length - 1];
    return !last || localDate(last.at) !== today;
  });
  const over = mine.filter((t) => t.deadline && t.deadline < today);
  const foll = mine.filter((t) => t.followUp && t.followUp <= today);
  const hear = mine.filter((t) => {
    const h = t.case && t.case.nextHearing;
    return h && h >= today && daysBetween(today, h) <= 7;
  });
  const stage = [];
  for (const t of mine) {
    for (const s of t.stages || []) {
      if (!s.done && s.due && s.due <= today) stage.push({ no: t.no, title: t.title, n: s.n, due: s.due });
    }
  }
  const noAtt = !board.att.some((a) => a.by === person.id && a.kind === 'in' && localDate(a.at) === today);
  return {
    stale,
    over,
    foll,
    hear,
    stage,
    noAtt,
    total: stale.length + over.length + foll.length + hear.length + stage.length + (noAtt ? 1 : 0)
  };
}

function digestHtml(person, d, board, kind, today) {
  const eod = board.settings.eod || '18:30';
  const url = process.env.APP_URL || '';
  const line = (t) => `${t.no} — ${t.property ? `${t.property} · ` : ''}${t.title}`;
  const block = (title, items, fmt) =>
    items.length ? `<p style="margin:14px 0 0"><b>${title}</b><br>${items.map(fmt).join('<br>')}</p>` : '';

  return `<div style="font:14px/1.5 system-ui,Segoe UI,Roboto,Arial;color:#16213e">
    <p>${kind === 'evening' ? 'Before you close for the day, ' : 'Good morning '}${person.name},</p>
    <p>Pending on your docket as on ${today}.</p>
    ${block('No update posted today', d.stale, (t) => `${line(t)}${t.deadline ? ` (due ${t.deadline})` : ''}`)}
    ${block('Past deadline', d.over, (t) => `${line(t)} (due ${t.deadline})`)}
    ${block('Stage due or overdue', d.stage, (s) => `${s.no} — ${s.n} (due ${s.due})`)}
    ${block('Follow-up due', d.foll, (t) => `${line(t)} (${t.followUp})`)}
    ${block('Hearing within 7 days', d.hear, (t) => `${line(t)} · ${t.case.nextHearing} · ${t.case.court || ''}`)}
    ${d.noAtt ? '<p style="margin:14px 0 0"><b>Attendance</b><br>Entry not marked today.</p>' : ''}
    <p style="margin-top:16px">Please post your update before ${eod}.</p>
    ${url ? `<p><a href="${url}" style="background:#7c1f2b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the console</a></p>` : ''}
  </div>`;
}

async function runReminders(kind) {
  if (!mailConfigured()) {
    return { ok: true, sent: 0, skipped: 'Email is not set up yet. Add RESEND_API_KEY and MAIL_FROM.' };
  }

  const today = todayLocal();
  const board = await loadBoard();
  let sent = 0;
  const failures = [];
  const summary = [];

  for (const person of board.staff) {
    const d = pendingFor(board, person, today);
    if (!d.total) continue;
    summary.push(
      `${person.name}: ${d.stale.length} without today's update, ${d.over.length} past deadline, ` +
        `${d.stage.length} stages due, ${d.foll.length} follow-ups${d.noAtt ? ', attendance not marked' : ''}`
    );
    if (!person.email) continue;
    try {
      await sendMail({
        to: person.email,
        subject: `[Docket] ${d.total} pending — ${today}`,
        html: digestHtml(person, d, board, kind, today)
      });
      sent++;
    } catch (e) {
      failures.push(`${person.name}: ${e.message}`);
    }
  }

  const owner = board.staff.find((s) => s.role === 'Owner');
  if (owner && owner.email && summary.length) {
    const url = process.env.APP_URL || '';
    try {
      await sendMail({
        to: owner.email,
        subject: `[Docket] Office summary — ${today}`,
        html: `<div style="font:14px/1.6 system-ui,Segoe UI,Roboto,Arial;color:#16213e">
          <p>Pending as on ${today}:</p><p>${summary.join('<br>')}</p>
          ${url ? `<p><a href="${url}">Open the console</a></p>` : ''}</div>`
      });
    } catch (e) {
      failures.push(`owner summary: ${e.message}`);
    }
  }

  return { ok: true, kind, sent, failures };
}

/* ============================================================ diagnosis */

async function diagnose() {
  const secretSet = process.env.SESSION_SECRET
    ? process.env.SESSION_SECRET.length >= 16
      ? 'set'
      : 'too short (needs 16+ characters)'
    : 'missing';

  const report = {
    ok: false,
    version: VERSION,
    node: process.version,
    region: process.env.VERCEL_REGION || null,
    environment: process.env.VERCEL_ENV || 'unknown',
    env: {
      SESSION_SECRET: secretSet,
      databaseVariable: whichUrlKey() || null,
      RESEND_API_KEY: !!process.env.RESEND_API_KEY,
      MAIL_FROM: !!process.env.MAIL_FROM,
      APP_URL: !!process.env.APP_URL
    },
    database: { connected: false, driver: '', error: '' },
    nextSteps: []
  };

  try {
    const row = await q('SELECT now() AS now');
    report.database.connected = true;
    report.database.driver = driverKind || 'pg';
    report.database.time = row.rows[0] && row.rows[0].now;
  } catch (e) {
    report.database.error = e && e.message ? e.message : String(e);
  }

  if (secretSet !== 'set') {
    report.nextSteps.push('Add SESSION_SECRET (32+ random characters) in Settings, Environment Variables, then redeploy.');
  }
  if (!report.env.databaseVariable) {
    report.nextSteps.push('No database URL found. Vercel, Storage, Create Database, Postgres. Then redeploy.');
  }
  if (report.database.error) report.nextSteps.push(report.database.error);

  report.ok = secretSet === 'set' && report.database.connected;
  if (report.ok) report.nextSteps.push('Everything the backend needs is in place.');
  return report;
}

/* ============================================================ requests */

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const action = params.get('action') || 'staff';

    if (action === 'diag') {
      const report = await diagnose();
      return json(report, report.ok ? 200 : 503);
    }

    if (action === 'staff') {
      await ensureSchema();
      const { rows } = await q('SELECT id, name, role, note FROM staff WHERE active ORDER BY created_at');
      return json({ ok: true, staff: rows, version: VERSION });
    }

    if (action === 'board') {
      await currentUser(request);
      const data = await loadBoard();
      return json({ ok: true, rev: data.rev, data });
    }

    if (action === 'media') {
      await currentUser(request);
      const id = params.get('id') || '';
      const { rows } = await sql`SELECT mime, data FROM media WHERE id = ${id}`;
      if (!rows.length) throw new HttpError(404, 'That file is no longer here.');
      return json({ ok: true, dataUrl: `data:${rows[0].mime};base64,${rows[0].data}` });
    }

    // Scheduled reminders arrive as a GET carrying the cron secret.
    if (action === 'reminders') {
      const fromCron = process.env.CRON_SECRET && bearer(request) === process.env.CRON_SECRET;
      if (!fromCron) requireOwner(await currentUser(request));
      const kind = params.get('kind') || (new Date().getUTCHours() < 8 ? 'morning' : 'evening');
      return json(await runReminders(kind));
    }

    throw new HttpError(400, `Unknown action: ${action}`);
  } catch (e) {
    return fail(e);
  }
}

const ALLOWED_MEDIA = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'audio/webm',
  'audio/mp4',
  'audio/ogg',
  'audio/mpeg'
];

export async function POST(request) {
  try {
    const body = await readBody(request);
    const action = body.action;

    if (action === 'signIn') {
      await ensureSchema();
      const { rows } = await sql`SELECT * FROM staff WHERE id = ${String(body.who || '')} AND active`;
      const person = rows[0];
      await new Promise((r) => setTimeout(r, 250));
      if (!person || !(await checkPin(String(body.pin || ''), person.pin_hash))) {
        throw new HttpError(401, 'Wrong PIN.');
      }
      return json({
        ok: true,
        token: await signToken(person.id),
        user: { id: person.id, name: person.name, role: person.role, forcePin: !!person.force_pin }
      });
    }

    if (action === 'setPin') {
      const me = await currentUser(request);
      const target = String(body.target || me.id);
      const forSomeoneElse = target !== me.id;
      if (forSomeoneElse) requireOwner(me);

      const pin = String(body.newPin || '').replace(/\D/g, '');
      if (pin.length !== 4) throw new HttpError(400, 'A PIN is four digits.');
      if (!forSomeoneElse && ['0000', '1234'].includes(pin)) {
        throw new HttpError(400, 'Pick something less obvious.');
      }

      const { rows } = await sql`SELECT * FROM staff WHERE id = ${target} AND active`;
      const who = rows[0];
      if (!who) throw new HttpError(404, 'That person is not on the board.');

      const hash = await hashPin(pin);
      await sql`UPDATE staff SET pin_hash = ${hash}, force_pin = ${forSomeoneElse}, pin_set_at = now()
                WHERE id = ${target}`;

      let emailed = false;
      let mailError = '';
      if (body.notify && forSomeoneElse) {
        if (!who.email) mailError = `No email address on file for ${who.name}.`;
        else {
          try {
            const url = process.env.APP_URL || '';
            await sendMail({
              to: who.email,
              subject: 'Your Docket PIN has been reset',
              html: `<div style="font:14px/1.6 system-ui,Segoe UI,Roboto,Arial;color:#16213e">
                <p>${who.name},</p>
                <p>Your PIN for the task console has been reset. Your new PIN is:</p>
                <p style="font:700 30px ui-monospace,Menlo,monospace;letter-spacing:.3em;background:#f2f4f8;padding:14px 18px;border-radius:8px;display:inline-block">${pin}</p>
                <p>Sign in with it and the console will ask you to choose one of your own straight away.</p>
                ${url ? `<p><a href="${url}" style="background:#7c1f2b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open the console</a></p>` : ''}
                <p style="font-size:12px;color:#3b4763">Anyone holding this PIN can post as you. Do not pass it on.</p></div>`
            });
            emailed = true;
          } catch (e) {
            mailError = e.message;
          }
        }
      }

      const data = await loadBoard();
      return json({ ok: true, emailed, to: who.email || '', mailError, rev: data.rev, data });
    }

    if (action === 'save') {
      const me = await currentUser(request);
      if (!body.data || !Array.isArray(body.data.tasks) || !Array.isArray(body.data.staff)) {
        throw new HttpError(400, 'That save did not arrive properly.');
      }
      const result = await saveBoard(body.data, body.expectRev, me.id);
      const data = await loadBoard();
      if (result.conflict) return json({ ok: false, conflict: true, rev: data.rev, data });
      return json({ ok: true, rev: data.rev, data });
    }

    // Archive or restore a task. Owner only. Nothing is deleted — the row and its
    // whole update history stay; `archived` just hides it from every normal view.
    if (action === 'archive') {
      await ensureSchema();
      requireOwner(await currentUser(request));
      const id = String(body.id || '');
      if (!id) throw new HttpError(400, 'No task was named.');
      const archived = body.archived !== false; // defaults to archiving
      const res = await sql`UPDATE tasks SET archived = ${archived} WHERE id = ${id}`;
      if (!res.rowCount) throw new HttpError(404, 'That task is not on the board.');
      await setSetting('rev', Number(await getSetting('rev', 0)) + 1);
      const data = await loadBoard();
      return json({ ok: true, rev: data.rev, data });
    }

    if (action === 'media') {
      const me = await currentUser(request);
      const match = /^data:([^;]+);base64,(.+)$/.exec(String(body.dataUrl || ''));
      if (!match) throw new HttpError(400, 'That file did not arrive properly.');

      const mime = match[1];
      const data = match[2];
      if (!ALLOWED_MEDIA.includes(mime)) throw new HttpError(415, `${mime} files are not accepted.`);
      if (data.length > 6 * 1024 * 1024) {
        throw new HttpError(413, 'That file is too large. Take the photo again at a smaller size.');
      }

      const c = await nodeCrypto();
      const id = c.randomUUID();
      await sql`INSERT INTO media (id, owner, kind, mime, data)
                VALUES (${id}, ${me.id}, ${String(body.kind || 'file')}, ${mime}, ${data})`;
      return json({ ok: true, id });
    }

    if (action === 'reminders') {
      requireOwner(await currentUser(request));
      return json(await runReminders('manual'));
    }

    throw new HttpError(400, `Unknown action: ${action}`);
  } catch (e) {
    return fail(e);
  }
}
