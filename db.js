import pg from "pg";

const { Pool } = pg;

let disabledReason = "";

let pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("railway.internal")
        ? false
        : { rejectUnauthorized: false }
    })
  : null;

export function hasDatabase() {
  return Boolean(pool);
}

export function getDatabaseStatus() {
  return {
    configured: Boolean(process.env.DATABASE_URL),
    connected: Boolean(pool),
    disabledReason
  };
}

export async function initDatabase() {
  if (!pool) return false;

  try {
    await pool.query(`
      create table if not exists media_flows (
        media_id text primary key,
        marker text,
        caption text,
        matched boolean not null default false,
        checked_at timestamptz not null default now()
      );

      create table if not exists processed_comments (
        comment_id text primary key,
        media_id text,
        choice text,
        username text,
        comment_text text,
        created_at timestamptz not null default now()
      );

      create table if not exists events (
        id bigserial primary key,
        status text not null,
        reason text,
        media_id text,
        comment_id text,
        choice text,
        username text,
        comment_text text,
        marker text,
        message text,
        created_at timestamptz not null default now()
      );
    `);
    return true;
  } catch (error) {
    disabledReason = error instanceof Error ? error.message : String(error);
    console.error("Postgres disabled; falling back to memory:", disabledReason);

    await pool.end().catch(() => {});
    pool = null;
    return false;
  }
}

export async function getStoredMediaFlow(mediaId) {
  if (!pool) return null;

  const result = await pool.query(
    "select media_id, marker, caption, matched from media_flows where media_id = $1",
    [mediaId]
  );

  return result.rows[0] ?? null;
}

export async function saveMediaFlow({ mediaId, marker, caption, matched }) {
  if (!pool) return;

  await pool.query(
    `
      insert into media_flows (media_id, marker, caption, matched, checked_at)
      values ($1, $2, $3, $4, now())
      on conflict (media_id) do update set
        marker = excluded.marker,
        caption = excluded.caption,
        matched = excluded.matched,
        checked_at = now()
    `,
    [mediaId, marker, caption, matched]
  );
}

export async function hasProcessedComment(commentId) {
  if (!pool) return false;

  const result = await pool.query("select 1 from processed_comments where comment_id = $1", [
    commentId
  ]);

  return result.rowCount > 0;
}

export async function saveProcessedComment({ commentId, mediaId, choice, username, text }) {
  if (!pool) return;

  await pool.query(
    `
      insert into processed_comments (comment_id, media_id, choice, username, comment_text)
      values ($1, $2, $3, $4, $5)
      on conflict (comment_id) do nothing
    `,
    [commentId, mediaId, choice, username, text]
  );
}

export async function saveEvent(event) {
  if (!pool) return;

  await pool.query(
    `
      insert into events
        (status, reason, media_id, comment_id, choice, username, comment_text, marker, message)
      values
        ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      event.status,
      event.reason ?? null,
      event.mediaId ?? null,
      event.commentId ?? null,
      event.choice ?? null,
      event.username ?? null,
      event.text ?? null,
      event.marker ?? null,
      event.message ?? null
    ]
  );
}

export async function getRecentEvents(limit = 100) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        created_at as at,
        status,
        reason,
        media_id as "mediaId",
        comment_id as "commentId",
        choice,
        username,
        comment_text as text,
        marker,
        message
      from events
      order by id desc
      limit $1
    `,
    [limit]
  );

  return result.rows;
}

export async function getStats() {
  if (!pool) return null;

  const [processed, cached, events] = await Promise.all([
    pool.query("select count(*)::int as count from processed_comments"),
    pool.query("select count(*)::int as count from media_flows"),
    pool.query("select count(*)::int as count from events")
  ]);

  return {
    processedComments: processed.rows[0].count,
    cachedMedia: cached.rows[0].count,
    recentEvents: events.rows[0].count
  };
}
