import pg from "pg";

const { Pool } = pg;

let disabledReason = "";
export const DEFAULT_SETTINGS = {
  automationEnabled: false,
  targetMode: "all_posts",
  aiChoiceEnabled: true,
  aiReadingEnabled: true,
  publicReplyTemplates: [
    "{choice}を選びましたね。鑑定結果をDMに送りました。",
    "{choice}ですね。カードからのメッセージをDMに送っています。",
    "{choice}番ですね。静かな鑑定結果をDMへお届けしました。"
  ]
};

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

export async function initDatabase(flows = []) {
  if (!pool) return false;

  try {
    await pool.query(`
      create table if not exists automation_flows (
        id text primary key,
        name text not null,
        marker text not null unique,
        enabled boolean not null default true,
        choices jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists media_posts (
        media_id text primary key,
        caption text,
        media_type text,
        media_product_type text,
        media_url text,
        thumbnail_url text,
        permalink text,
        timestamp timestamptz,
        comments_count integer,
        like_count integer,
        matched_marker text,
        active boolean not null default false,
        first_seen_at timestamptz not null default now(),
        last_synced_at timestamptz not null default now()
      );

      create table if not exists media_flow_links (
        media_id text primary key references media_posts(media_id) on delete cascade,
        flow_id text references automation_flows(id) on delete set null,
        marker text,
        active boolean not null default true,
        linked_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists media_comments (
        comment_id text primary key,
        media_id text,
        username text,
        user_id text,
        comment_text text,
        choice text,
        like_count integer,
        hidden boolean,
        is_owner_comment boolean not null default false,
        automation_status text not null default 'unprocessed',
        error_message text,
        created_at timestamptz,
        first_seen_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists processed_comments (
        comment_id text primary key,
        media_id text,
        choice text,
        username text,
        comment_text text,
        public_reply text,
        private_reply text,
        status text not null default 'sent',
        error_message text,
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

      create table if not exists app_settings (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists media_tarot_readings (
        media_id text primary key references media_posts(media_id) on delete cascade,
        theme text not null,
        caption_hash text not null,
        cards jsonb not null,
        readings jsonb not null,
        raw_text text,
        error_message text,
        generated_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists automation_tasks (
        id bigserial primary key,
        comment_id text unique,
        media_id text,
        username text,
        comment_text text,
        sanitized_text text,
        choice text,
        choice_method text,
        status text not null default 'received',
        public_reply text,
        private_reply text,
        error_message text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists automation_task_steps (
        id bigserial primary key,
        task_id bigint references automation_tasks(id) on delete cascade,
        step_key text not null,
        status text not null,
        message text,
        metadata jsonb,
        created_at timestamptz not null default now()
      );
    `);

    await pool.query(`
      alter table media_posts add column if not exists media_type text;
      alter table media_posts add column if not exists media_product_type text;
      alter table media_posts add column if not exists media_url text;
      alter table media_posts add column if not exists thumbnail_url text;
      alter table media_posts add column if not exists permalink text;
      alter table media_posts add column if not exists comments_count integer;
      alter table media_posts add column if not exists like_count integer;
      alter table media_posts add column if not exists matched_marker text;
      alter table media_posts add column if not exists active boolean not null default false;
      alter table media_posts add column if not exists first_seen_at timestamptz not null default now();
      alter table media_posts add column if not exists last_synced_at timestamptz not null default now();

      alter table media_flow_links add column if not exists marker text;
      alter table media_flow_links add column if not exists active boolean not null default true;
      alter table media_flow_links add column if not exists linked_at timestamptz not null default now();
      alter table media_flow_links add column if not exists updated_at timestamptz not null default now();

      alter table media_comments add column if not exists username text;
      alter table media_comments add column if not exists user_id text;
      alter table media_comments add column if not exists comment_text text;
      alter table media_comments add column if not exists choice text;
      alter table media_comments add column if not exists like_count integer;
      alter table media_comments add column if not exists hidden boolean;
      alter table media_comments add column if not exists is_owner_comment boolean not null default false;
      alter table media_comments add column if not exists automation_status text not null default 'unprocessed';
      alter table media_comments add column if not exists error_message text;
      alter table media_comments add column if not exists created_at timestamptz;
      alter table media_comments add column if not exists first_seen_at timestamptz not null default now();
      alter table media_comments add column if not exists updated_at timestamptz not null default now();

      alter table processed_comments add column if not exists public_reply text;
      alter table processed_comments add column if not exists private_reply text;
      alter table processed_comments add column if not exists status text not null default 'sent';
      alter table processed_comments add column if not exists error_message text;

      alter table events add column if not exists reason text;
      alter table events add column if not exists media_id text;
      alter table events add column if not exists comment_id text;
      alter table events add column if not exists choice text;
      alter table events add column if not exists username text;
      alter table events add column if not exists comment_text text;
      alter table events add column if not exists marker text;
      alter table events add column if not exists message text;
    `);

    await seedSettings();
    await seedFlows(flows);
    return true;
  } catch (error) {
    disabledReason = error instanceof Error ? error.message : String(error);
    console.error("Postgres disabled; falling back to memory:", disabledReason);

    await pool.end().catch(() => {});
    pool = null;
    return false;
  }
}

async function seedSettings() {
  if (!pool) return;

  await pool.query(
    `
      insert into app_settings (key, value, updated_at)
      values ('main', $1, now())
      on conflict (key) do nothing
    `,
    [JSON.stringify(DEFAULT_SETTINGS)]
  );
}

async function seedFlows(flows) {
  if (!pool) return;

  for (const flow of flows) {
    await pool.query(
      `
        insert into automation_flows (id, name, marker, enabled, choices, updated_at)
        values ($1, $2, $3, $4, $5, now())
        on conflict (id) do update set
          name = excluded.name,
          marker = excluded.marker,
          updated_at = now()
      `,
      [flow.id, flow.name, flow.marker, flow.enabled !== false, JSON.stringify(flow.choices)]
    );
  }
}

export async function updateFlowChoices(flowId, choices) {
  if (!pool) return null;

  const result = await pool.query(
    `
      update automation_flows
      set choices = $2, updated_at = now()
      where id = $1
      returning id, name, marker, enabled, choices
    `,
    [flowId, JSON.stringify(choices)]
  );

  return result.rows[0] ?? null;
}

export async function getFlows() {
  if (!pool) return null;

  const result = await pool.query(`
    select
      f.id,
      f.name,
      f.marker,
      f.enabled,
      f.choices,
      count(l.media_id)::int as "linkedMediaCount"
    from automation_flows f
    left join media_flow_links l on l.flow_id = f.id and l.active = true
    group by f.id
    order by f.created_at asc
  `);

  return result.rows;
}

export async function setFlowEnabled(flowId, enabled) {
  if (!pool) return null;

  const result = await pool.query(
    `
      update automation_flows
      set enabled = $2, updated_at = now()
      where id = $1
      returning id, name, marker, enabled, choices
    `,
    [flowId, enabled]
  );

  return result.rows[0] ?? null;
}

export async function findDbFlowByMarker(marker) {
  if (!pool || !marker) return null;

  const result = await pool.query(
    "select id, name, marker, enabled, choices from automation_flows where marker = $1",
    [marker]
  );

  return result.rows[0] ?? null;
}

export async function getLinkedFlowForMedia(mediaId) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select f.id, f.name, f.marker, f.enabled, f.choices
      from media_flow_links l
      join automation_flows f on f.id = l.flow_id
      where l.media_id = $1 and l.active = true
    `,
    [mediaId]
  );

  return result.rows[0] ?? null;
}

export async function upsertMediaPost(post, flow = null) {
  if (!pool) return { saved: false, changes: [] };

  const previous = await pool.query("select * from media_posts where media_id = $1", [post.id]);
  const old = previous.rows[0];
  const changes = diffPost(old, post, flow);

  await pool.query(
    `
      insert into media_posts (
        media_id, caption, media_type, media_product_type, media_url, thumbnail_url,
        permalink, timestamp, comments_count, like_count, matched_marker, active,
        first_seen_at, last_synced_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
      on conflict (media_id) do update set
        caption = excluded.caption,
        media_type = excluded.media_type,
        media_product_type = excluded.media_product_type,
        media_url = excluded.media_url,
        thumbnail_url = excluded.thumbnail_url,
        permalink = excluded.permalink,
        timestamp = excluded.timestamp,
        comments_count = excluded.comments_count,
        like_count = excluded.like_count,
        matched_marker = excluded.matched_marker,
        active = excluded.active,
        last_synced_at = now()
    `,
    [
      post.id,
      post.caption ?? "",
      post.media_type ?? null,
      post.media_product_type ?? null,
      post.media_url ?? null,
      post.thumbnail_url ?? null,
      post.permalink ?? null,
      post.timestamp ?? null,
      post.comments_count ?? null,
      post.like_count ?? null,
      flow?.marker ?? null,
      Boolean(flow)
    ]
  );

  if (flow) {
    await pool.query(
      `
        insert into media_flow_links (media_id, flow_id, marker, active, linked_at, updated_at)
        values ($1, $2, $3, true, now(), now())
        on conflict (media_id) do update set
          flow_id = excluded.flow_id,
          marker = excluded.marker,
          active = true,
          updated_at = now()
      `,
      [post.id, flow.id, flow.marker]
    );
  } else {
    await pool.query(
      `
        insert into media_flow_links (media_id, flow_id, marker, active, linked_at, updated_at)
        values ($1, null, null, false, now(), now())
        on conflict (media_id) do update set
          flow_id = null,
          marker = null,
          active = false,
          updated_at = now()
      `,
      [post.id]
    );
  }

  return { saved: true, changes };
}

function diffPost(old, post, flow) {
  if (!old) return ["new_post"];

  const pairs = [
    ["caption", old.caption ?? "", post.caption ?? ""],
    ["thumbnail_url", old.thumbnail_url ?? "", post.thumbnail_url ?? ""],
    ["media_url", old.media_url ?? "", post.media_url ?? ""],
    ["comments_count", old.comments_count, post.comments_count ?? null],
    ["like_count", old.like_count, post.like_count ?? null],
    ["matched_marker", old.matched_marker ?? "", flow?.marker ?? ""],
    ["active", old.active, Boolean(flow)]
  ];

  return pairs.filter(([, before, after]) => before !== after).map(([field]) => field);
}

export async function getMediaPosts() {
  if (!pool) return null;

  const result = await pool.query(`
    select
      p.media_id as "mediaId",
      p.caption,
      p.media_type as "mediaType",
      p.media_product_type as "mediaProductType",
      p.media_url as "mediaUrl",
      p.thumbnail_url as "thumbnailUrl",
      p.permalink,
      p.timestamp,
      p.comments_count as "commentsCount",
      p.like_count as "likeCount",
      p.matched_marker as "matchedMarker",
      p.active,
      p.first_seen_at as "firstSeenAt",
      p.last_synced_at as "lastSyncedAt",
      f.id as "flowId",
      f.name as "flowName",
      f.enabled as "flowEnabled"
    from media_posts p
    left join media_flow_links l on l.media_id = p.media_id
    left join automation_flows f on f.id = l.flow_id
    order by p.timestamp desc nulls last, p.last_synced_at desc
  `);

  return result.rows;
}

export async function getMediaPost(mediaId) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        p.media_id as "mediaId",
        p.caption,
        p.media_type as "mediaType",
        p.media_product_type as "mediaProductType",
        p.media_url as "mediaUrl",
        p.thumbnail_url as "thumbnailUrl",
        p.permalink,
        p.timestamp,
        p.comments_count as "commentsCount",
        p.like_count as "likeCount",
        p.matched_marker as "matchedMarker",
        p.active,
        p.first_seen_at as "firstSeenAt",
        p.last_synced_at as "lastSyncedAt",
        f.id as "flowId",
        f.name as "flowName",
        f.enabled as "flowEnabled"
      from media_posts p
      left join media_flow_links l on l.media_id = p.media_id
      left join automation_flows f on f.id = l.flow_id
      where p.media_id = $1
    `,
    [mediaId]
  );

  return result.rows[0] ?? null;
}

export async function upsertMediaComment(comment) {
  if (!pool) return;

  await pool.query(
    `
      insert into media_comments (
        comment_id, media_id, username, user_id, comment_text, choice, like_count,
        hidden, is_owner_comment, automation_status, error_message, created_at,
        first_seen_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
      on conflict (comment_id) do update set
        media_id = excluded.media_id,
        username = coalesce(nullif(excluded.username, ''), media_comments.username),
        user_id = coalesce(nullif(excluded.user_id, ''), media_comments.user_id),
        comment_text = excluded.comment_text,
        choice = excluded.choice,
        like_count = excluded.like_count,
        hidden = excluded.hidden,
        is_owner_comment = excluded.is_owner_comment,
        automation_status = excluded.automation_status,
        error_message = excluded.error_message,
        created_at = coalesce(excluded.created_at, media_comments.created_at),
        updated_at = now()
    `,
    [
      comment.commentId,
      comment.mediaId,
      comment.username ?? null,
      comment.userId ?? null,
      comment.text ?? "",
      comment.choice ?? null,
      comment.likeCount ?? null,
      comment.hidden ?? null,
      Boolean(comment.isOwnerComment),
      comment.automationStatus ?? "unprocessed",
      comment.errorMessage ?? null,
      comment.createdAt ?? null
    ]
  );
}

export async function updateCommentStatus(commentId, status, errorMessage = null) {
  if (!pool || !commentId) return;

  await pool.query(
    `
      update media_comments
      set automation_status = $2, error_message = $3, updated_at = now()
      where comment_id = $1
    `,
    [commentId, status, errorMessage]
  );
}

export async function getMediaComments(mediaId) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        c.comment_id as "commentId",
        c.media_id as "mediaId",
        c.username,
        c.user_id as "userId",
        c.comment_text as text,
        c.choice,
        c.like_count as "likeCount",
        c.hidden,
        c.is_owner_comment as "isOwnerComment",
        c.automation_status as "automationStatus",
        c.error_message as "errorMessage",
        c.created_at as "createdAt",
        c.first_seen_at as "firstSeenAt",
        c.updated_at as "updatedAt",
        p.status as "sendStatus",
        p.public_reply as "publicReply",
        p.private_reply as "privateReply"
      from media_comments c
      left join processed_comments p on p.comment_id = c.comment_id
      where c.media_id = $1
      order by coalesce(c.created_at, c.first_seen_at) desc
    `,
    [mediaId]
  );

  return result.rows;
}

export async function getComment(commentId) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        c.comment_id as "commentId",
        c.media_id as "mediaId",
        c.username,
        c.user_id as "userId",
        c.comment_text as text,
        c.choice,
        c.like_count as "likeCount",
        c.hidden,
        c.is_owner_comment as "isOwnerComment",
        c.automation_status as "automationStatus",
        c.error_message as "errorMessage",
        c.created_at as "createdAt",
        c.first_seen_at as "firstSeenAt",
        c.updated_at as "updatedAt",
        p.status as "sendStatus",
        p.public_reply as "publicReply",
        p.private_reply as "privateReply"
      from media_comments c
      left join processed_comments p on p.comment_id = c.comment_id
      where c.comment_id = $1
    `,
    [commentId]
  );

  return result.rows[0] ?? null;
}

export async function hasProcessedComment(commentId) {
  if (!pool) return false;

  const result = await pool.query("select 1 from processed_comments where comment_id = $1", [
    commentId
  ]);

  return result.rowCount > 0;
}

export async function saveProcessedComment({
  commentId,
  mediaId,
  choice,
  username,
  text,
  publicReply,
  privateReply,
  status = "sent",
  errorMessage = null
}) {
  if (!pool) return;

  await pool.query(
    `
      insert into processed_comments (
        comment_id, media_id, choice, username, comment_text,
        public_reply, private_reply, status, error_message
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (comment_id) do update set
        username = coalesce(nullif(excluded.username, ''), processed_comments.username),
        comment_text = excluded.comment_text,
        public_reply = coalesce(excluded.public_reply, processed_comments.public_reply),
        private_reply = coalesce(excluded.private_reply, processed_comments.private_reply),
        status = excluded.status,
        error_message = excluded.error_message
    `,
    [commentId, mediaId, choice, username, text, publicReply, privateReply, status, errorMessage]
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

export async function getWebhookTodaySummary(limit = 20) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        e.media_id as "mediaId",
        count(*)::int as count,
        max(e.created_at) as "lastReceivedAt",
        p.caption,
        p.media_type as "mediaType",
        p.media_product_type as "mediaProductType",
        p.media_url as "mediaUrl",
        p.thumbnail_url as "thumbnailUrl",
        p.permalink,
        p.active,
        p.matched_marker as "matchedMarker",
        f.name as "flowName"
      from events e
      left join media_posts p on p.media_id = e.media_id
      left join media_flow_links l on l.media_id = e.media_id
      left join automation_flows f on f.id = l.flow_id
      where
        e.status = 'received'
        and (e.created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date
        and coalesce(e.reason, '') <> 'user_info_missing'
      group by
        e.media_id,
        p.caption,
        p.media_type,
        p.media_product_type,
        p.media_url,
        p.thumbnail_url,
        p.permalink,
        p.active,
        p.matched_marker,
        f.name
      order by max(e.created_at) desc
      limit $1
    `,
    [limit]
  );

  return result.rows;
}

export async function getSettings() {
  if (!pool) return { ...DEFAULT_SETTINGS };

  const result = await pool.query("select value from app_settings where key = 'main'");
  return {
    ...DEFAULT_SETTINGS,
    ...(result.rows[0]?.value ?? {})
  };
}

export async function updateSettings(settings) {
  const merged = {
    ...(await getSettings()),
    ...settings
  };

  if (!pool) return merged;

  const result = await pool.query(
    `
      insert into app_settings (key, value, updated_at)
      values ('main', $1, now())
      on conflict (key) do update set
        value = excluded.value,
        updated_at = now()
      returning value
    `,
    [JSON.stringify(merged)]
  );

  return {
    ...DEFAULT_SETTINGS,
    ...(result.rows[0]?.value ?? {})
  };
}

export async function createAutomationTask(task) {
  if (!pool) return null;

  const result = await pool.query(
    `
      insert into automation_tasks (
        comment_id, media_id, username, comment_text, sanitized_text,
        choice, choice_method, status, public_reply, private_reply, error_message,
        created_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
      on conflict (comment_id) do update set
        media_id = coalesce(excluded.media_id, automation_tasks.media_id),
        username = coalesce(nullif(excluded.username, ''), automation_tasks.username),
        comment_text = excluded.comment_text,
        sanitized_text = excluded.sanitized_text,
        choice = coalesce(excluded.choice, automation_tasks.choice),
        choice_method = coalesce(excluded.choice_method, automation_tasks.choice_method),
        status = excluded.status,
        updated_at = now()
      returning ${taskSelectFields()}
    `,
    [
      task.commentId ?? null,
      task.mediaId ?? null,
      task.username ?? null,
      task.text ?? "",
      task.sanitizedText ?? "",
      task.choice ?? null,
      task.choiceMethod ?? null,
      task.status ?? "received",
      task.publicReply ?? null,
      task.privateReply ?? null,
      task.errorMessage ?? null
    ]
  );

  return result.rows[0] ?? null;
}

export async function updateAutomationTask(taskId, patch) {
  if (!pool || !taskId) return null;

  const fields = [];
  const values = [];
  const map = {
    mediaId: "media_id",
    username: "username",
    text: "comment_text",
    sanitizedText: "sanitized_text",
    choice: "choice",
    choiceMethod: "choice_method",
    status: "status",
    publicReply: "public_reply",
    privateReply: "private_reply",
    errorMessage: "error_message"
  };

  for (const [key, column] of Object.entries(map)) {
    if (Object.hasOwn(patch, key)) {
      values.push(patch[key]);
      fields.push(`${column} = $${values.length}`);
    }
  }

  if (fields.length === 0) return getAutomationTask(taskId);

  values.push(taskId);
  const result = await pool.query(
    `
      update automation_tasks
      set ${fields.join(", ")}, updated_at = now()
      where id = $${values.length}
      returning ${taskSelectFields()}
    `,
    values
  );

  return result.rows[0] ?? null;
}

export async function addTaskStep(taskId, stepKey, status, message = "", metadata = null) {
  if (!pool || !taskId) return null;

  await pool.query(
    `
      insert into automation_task_steps (task_id, step_key, status, message, metadata)
      values ($1, $2, $3, $4, $5)
    `,
    [taskId, stepKey, status, message, metadata ? JSON.stringify(metadata) : null]
  );
}

export async function getAutomationTasks(limit = 100) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        ${taskSelectFields("t")},
        p.caption,
        p.thumbnail_url as "thumbnailUrl",
        p.media_url as "mediaUrl",
        p.active as "mediaActive",
        p.matched_marker as "matchedMarker"
      from automation_tasks t
      left join media_posts p on p.media_id = t.media_id
      order by t.created_at desc
      limit $1
    `,
    [limit]
  );

  return result.rows;
}

export async function getAutomationTask(taskId) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        ${taskSelectFields("t")},
        p.caption,
        p.thumbnail_url as "thumbnailUrl",
        p.media_url as "mediaUrl",
        p.active as "mediaActive",
        p.matched_marker as "matchedMarker"
      from automation_tasks t
      left join media_posts p on p.media_id = t.media_id
      where t.id = $1
    `,
    [taskId]
  );

  return result.rows[0] ?? null;
}

export async function getAutomationTaskSteps(taskId) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        id as "stepId",
        task_id as "taskId",
        step_key as "stepKey",
        status,
        message,
        metadata,
        created_at as "createdAt"
      from automation_task_steps
      where task_id = $1
      order by id asc
    `,
    [taskId]
  );

  return result.rows;
}

export async function getAutomationTasksForMedia(mediaId, limit = 30) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select ${taskSelectFields()}
      from automation_tasks
      where media_id = $1
      order by created_at desc
      limit $2
    `,
    [mediaId, limit]
  );

  return result.rows;
}

export async function getMediaTarotReading(mediaId) {
  if (!pool) return null;

  const result = await pool.query(
    `
      select
        media_id as "mediaId",
        theme,
        caption_hash as "captionHash",
        cards,
        readings,
        raw_text as "rawText",
        error_message as "errorMessage",
        generated_at as "generatedAt",
        updated_at as "updatedAt"
      from media_tarot_readings
      where media_id = $1
    `,
    [mediaId]
  );

  return result.rows[0] ?? null;
}

export async function saveMediaTarotReading(reading) {
  if (!pool) return null;

  const result = await pool.query(
    `
      insert into media_tarot_readings (
        media_id, theme, caption_hash, cards, readings, raw_text, error_message,
        generated_at, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, now(), now())
      on conflict (media_id) do update set
        theme = excluded.theme,
        caption_hash = excluded.caption_hash,
        cards = excluded.cards,
        readings = excluded.readings,
        raw_text = excluded.raw_text,
        error_message = excluded.error_message,
        updated_at = now()
      returning
        media_id as "mediaId",
        theme,
        caption_hash as "captionHash",
        cards,
        readings,
        raw_text as "rawText",
        error_message as "errorMessage",
        generated_at as "generatedAt",
        updated_at as "updatedAt"
    `,
    [
      reading.mediaId,
      reading.theme,
      reading.captionHash,
      JSON.stringify(reading.cards),
      JSON.stringify(reading.readings),
      reading.rawText ?? null,
      reading.errorMessage ?? null
    ]
  );

  return result.rows[0] ?? null;
}

export async function getStats() {
  if (!pool) return null;

  const [flows, posts, processed, errors, webhook, tasks, events] = await Promise.all([
    pool.query("select count(*)::int as count from automation_flows where enabled = true"),
    pool.query("select count(*)::int as count from media_posts where active = true"),
    pool.query(
      `
        select count(*)::int as count
        from processed_comments
        where
          status = 'sent'
          and (created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date
      `
    ),
    pool.query(
      `
        select count(*)::int as count
        from events
        where
          status = 'error'
          and (created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date
      `
    ),
    pool.query(
      `
        select count(*)::int as count
        from events
        where
          status = 'received'
          and (created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date
          and coalesce(reason, '') <> 'user_info_missing'
      `
    ),
    pool.query(
      `
        select count(*)::int as count
        from automation_tasks
        where (created_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date
      `
    ),
    pool.query("select count(*)::int as count from events")
  ]);

  return {
    activeFlows: flows.rows[0].count,
    activePosts: posts.rows[0].count,
    sentToday: processed.rows[0].count,
    errorsToday: errors.rows[0].count,
    webhookToday: webhook.rows[0].count,
    tasksToday: tasks.rows[0].count,
    recentEvents: events.rows[0].count
  };
}

function taskSelectFields(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `
    ${prefix}id as "taskId",
    ${prefix}comment_id as "commentId",
    ${prefix}media_id as "mediaId",
    ${prefix}username,
    ${prefix}comment_text as text,
    ${prefix}sanitized_text as "sanitizedText",
    ${prefix}choice,
    ${prefix}choice_method as "choiceMethod",
    ${prefix}status,
    ${prefix}public_reply as "publicReply",
    ${prefix}private_reply as "privateReply",
    ${prefix}error_message as "errorMessage",
    ${prefix}created_at as "createdAt",
    ${prefix}updated_at as "updatedAt"
  `;
}
