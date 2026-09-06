import "dotenv/config";
import express from "express";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findDbFlowByMarker,
  getComment,
  getFlows,
  getLinkedFlowForMedia,
  getMediaComments,
  getMediaPost,
  getMediaPosts,
  getRecentEvents,
  getStats,
  getWebhookTodaySummary,
  getDatabaseStatus,
  hasDatabase,
  hasProcessedComment,
  initDatabase,
  saveEvent,
  saveProcessedComment,
  setFlowEnabled,
  updateFlowChoices,
  updateCommentStatus,
  upsertMediaComment,
  upsertMediaPost
} from "./db.js";
import { findFlow, flows, normalizeChoices, normalizePublicReplies, parseChoice } from "./flows.js";

const app = express();
app.use(express.json());

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  PORT = 3000,
  VERIFY_TOKEN,
  IG_USER_ID,
  ACCESS_TOKEN,
  ADMIN_TOKEN,
  ADMIN_AUTH_ENABLED = "false",
  DATABASE_URL,
  APP_ID,
  APP_SECRET,
  IG_USERNAME,
  API_MODE = "instagram",
  GRAPH_BASE_URL = "https://graph.instagram.com",
  GRAPH_API_VERSION = "v26.0",
  FACEBOOK_GRAPH_BASE_URL = "https://graph.facebook.com"
} = process.env;

const processedComments = new Set();
const recentEvents = [];
const mediaFlowCache = new Map();
const COMMENT_FIELDS = "id,text,username,timestamp,like_count,hidden,from";
const COMMENT_FIELDS_DETAILED = "id,text,username,timestamp,like_count,hidden,from{id,username}";

app.get("/", (_req, res) => {
  res.redirect("/admin");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "instagram-tarot-auto-simple" });
});

app.get("/privacy", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Privacy Policy</title>
    <style>
      body {
        max-width: 760px;
        margin: 40px auto;
        padding: 0 20px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.8;
        color: #1f2937;
      }
      h1 {
        line-height: 1.3;
      }
    </style>
  </head>
  <body>
    <h1>プライバシーポリシー</h1>
    <p>このアプリは、Instagramのコメントに対する自動返信機能をテスト・運用するためのアプリです。</p>
    <h2>取得する情報</h2>
    <p>このアプリは、Instagramコメントの処理に必要な範囲で、コメントID、投稿またはメディアID、コメント本文、Instagramユーザー名などを取得する場合があります。</p>
    <h2>利用目的</h2>
    <p>取得した情報は、対象投稿へのコメント判定、自動返信、DMでの返信、動作確認、エラー調査のために利用します。</p>
    <h2>第三者提供</h2>
    <p>取得した情報を第三者に販売することはありません。法令に基づく場合を除き、本人の同意なく第三者に提供しません。</p>
    <h2>保存期間</h2>
    <p>取得した情報は、動作確認および不具合調査に必要な期間のみ保存し、不要になった場合は削除します。</p>
    <h2>お問い合わせ</h2>
    <p>情報の削除やお問い合わせについては、このアプリの管理者までご連絡ください。</p>
    <p>最終更新日: 2026年9月4日</p>
  </body>
</html>`);
});

app.get("/admin", requireAdmin, async (_req, res) => {
  const html = await readFile(join(__dirname, "admin.html"), "utf8");
  res.type("html").send(html);
});

app.get("/api/status", requireAdmin, async (_req, res) => {
  const dbStats = await getStats();
  const dbEvents = await getRecentEvents(100);
  const dbWebhookToday = await getWebhookTodaySummary(20);
  const memoryWebhookToday = getMemoryWebhookTodaySummary();

  res.json({
    ok: true,
    env: {
      VERIFY_TOKEN: Boolean(VERIFY_TOKEN),
      IG_USER_ID: Boolean(IG_USER_ID),
      ACCESS_TOKEN: Boolean(ACCESS_TOKEN),
      ADMIN_TOKEN: Boolean(ADMIN_TOKEN),
      ADMIN_AUTH_ENABLED,
      DATABASE_URL: Boolean(DATABASE_URL),
      APP_ID: Boolean(APP_ID),
      APP_SECRET: Boolean(APP_SECRET),
      IG_USERNAME: Boolean(IG_USERNAME),
      API_MODE,
      GRAPH_BASE_URL,
      GRAPH_API_VERSION,
      FACEBOOK_GRAPH_BASE_URL
    },
    database: {
      ...getDatabaseStatus()
    },
    flows: (await getFlows()) ?? localFlows(),
    stats: dbStats ?? {
      activeFlows: flows.filter((flow) => flow.enabled !== false).length,
      activePosts: mediaFlowCache.size,
      sentToday: processedComments.size,
      errorsToday: recentEvents.filter((event) => event.status === "error").length,
      webhookToday: memoryWebhookToday.reduce((total, item) => total + item.count, 0),
      recentEvents: recentEvents.length
    },
    webhookTodayByMedia: dbWebhookToday ?? memoryWebhookToday,
    recentEvents: dbEvents ?? recentEvents
  });
});

app.get("/api/flows", requireAdmin, async (_req, res) => {
  res.json({ ok: true, flows: normalizeFlowList((await getFlows()) ?? localFlows()) });
});

app.post("/api/flows/:flowId/toggle", requireAdmin, async (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const flow = await setFlowEnabled(req.params.flowId, enabled);
    mediaFlowCache.clear();
    res.json({ ok: true, flow });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.put("/api/flows/:flowId/replies", requireAdmin, async (req, res) => {
  try {
    const incoming = req.body?.choices ?? {};
    const choices = {};

    for (const choice of ["1", "2", "3"]) {
      const reply = incoming[choice] ?? {};
      const publicReplies = Array.isArray(reply.publicReplies)
        ? reply.publicReplies.map((item) => String(item).trim()).filter(Boolean)
        : String(reply.publicRepliesText ?? "")
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean);

      if (publicReplies.length === 0) {
        return res.status(400).json({
          ok: false,
          error: `${choice}番の公開返信を1つ以上入れてください`
        });
      }

      choices[choice] = {
        publicReplies,
        privateReply: String(reply.privateReply ?? "").trim()
      };
    }

    const flow = await updateFlowChoices(req.params.flowId, choices);
    mediaFlowCache.clear();
    res.json({ ok: true, flow: normalizeFlow(flow) });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/exchange-token", requireAdmin, async (req, res) => {
  try {
    const shortToken = String(req.body?.shortToken ?? "").trim();
    if (!shortToken) return res.status(400).json({ ok: false, error: "shortToken is required" });
    if (!APP_ID || !APP_SECRET) {
      return res.status(400).json({
        ok: false,
        error: "APP_ID and APP_SECRET must be set in Railway Variables"
      });
    }

    const url = new URL(`${FACEBOOK_GRAPH_BASE_URL}/${GRAPH_API_VERSION}/oauth/access_token`);
    url.searchParams.set("grant_type", "fb_exchange_token");
    url.searchParams.set("client_id", APP_ID);
    url.searchParams.set("client_secret", APP_SECRET);
    url.searchParams.set("fb_exchange_token", shortToken);

    const token = await fetchJson(url);
    res.json({
      ok: true,
      longUserToken: token.access_token,
      tokenType: token.token_type,
      expiresIn: token.expires_in
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/page-tokens", requireAdmin, async (req, res) => {
  try {
    const longUserToken = String(req.body?.longUserToken ?? "").trim();
    if (!longUserToken) {
      return res.status(400).json({ ok: false, error: "longUserToken is required" });
    }

    const url = new URL(`${FACEBOOK_GRAPH_BASE_URL}/${GRAPH_API_VERSION}/me/accounts`);
    url.searchParams.set("fields", "name,id,access_token,instagram_business_account");
    url.searchParams.set("access_token", longUserToken);

    const pages = await fetchJson(url);
    res.json({
      ok: true,
      pages: pages.data ?? []
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/api/latest-media", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 10), 25);
    const media = await getLatestMedia(limit);
    res.json({
      ok: true,
      media: media.map((item) => ({
        ...item,
        matchedFlow: findFlow(item.caption ?? "")?.marker ?? null
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/api/media", requireAdmin, async (_req, res) => {
  res.json({ ok: true, media: (await getMediaPosts()) ?? [] });
});

app.post("/api/sync-media", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.body?.limit ?? 25), 50);
    const media = await getLatestMedia(limit);
    const saved = [];

    for (const item of media) {
      const flow = await findFlowForCaption(item.caption ?? "");
      const result = await upsertMediaPost(item, flow);
      saved.push({
        mediaId: item.id,
        matchedMarker: flow?.marker ?? null,
        active: Boolean(flow),
        changes: result.changes
      });

      if (result.changes.length > 0) {
        addEvent({
          status: "sync",
          mediaId: item.id,
          marker: flow?.marker ?? null,
          message: `投稿を同期しました: ${result.changes.join(", ")}`
        });
      }
    }

    res.json({ ok: true, count: saved.length, saved });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/api/media/:mediaId", requireAdmin, async (req, res) => {
  const media = await getMediaPost(req.params.mediaId);
  if (!media) return res.status(404).json({ ok: false, error: "media not found" });
  res.json({ ok: true, media });
});

app.get("/api/media/:mediaId/comments", requireAdmin, async (req, res) => {
  res.json({ ok: true, comments: (await getMediaComments(req.params.mediaId)) ?? [] });
});

app.get("/api/media/:mediaId/comments/raw", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 50);
    const raw = await getMediaCommentsRaw(req.params.mediaId, limit);
    const data = raw.data ?? [];
    const missingIdentityCount = data.filter((comment) => !comment.username && !comment.from).length;
    res.json({
      ok: true,
      fields: raw._requestedFields ?? COMMENT_FIELDS,
      count: data.length,
      missingIdentityCount,
      identityNote:
        missingIdentityCount > 0
          ? "Meta API response did not include username/from for some comments. comment_id can still be used for Private Reply."
          : "username/from was included for returned comments.",
      raw: redactAccessTokens(raw)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/media/:mediaId/sync-comments", requireAdmin, async (req, res) => {
  try {
    const mediaId = req.params.mediaId;
    const limit = Math.min(Number(req.body?.limit ?? 50), 50);
    const comments = await getMediaCommentsFromInstagram(mediaId, limit);
    let saved = 0;

    for (const comment of comments) {
      const normalized = normalizeComment({ ...comment, media: { id: mediaId } });
      const isOwner = isOwnerComment(normalized);
      await upsertMediaComment({
        ...normalized,
        isOwnerComment: isOwner,
        automationStatus: isOwner ? "owner_comment" : "unprocessed"
      });
      saved += 1;
    }

    addEvent({ status: "sync", mediaId, message: `${saved}件のコメントを同期しました` });
    res.json({ ok: true, count: saved });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/comments/:commentId/refresh", requireAdmin, async (req, res) => {
  try {
    const commentId = req.params.commentId;
    const existing = await getComment(commentId);
    const raw = await getCommentFromInstagram(commentId);
    const normalized = normalizeComment({
      ...raw,
      media: { id: raw?.media?.id ?? existing?.mediaId }
    });
    const isOwner = isOwnerComment(normalized);

    await upsertMediaComment({
      ...normalized,
      mediaId: normalized.mediaId ?? existing?.mediaId,
      isOwnerComment: isOwner,
      automationStatus: isOwner ? "owner_comment" : existing?.automationStatus ?? "unprocessed"
    });

    res.json({ ok: true, raw, comment: await getComment(commentId) });
  } catch (error) {
    await updateCommentStatus(req.params.commentId, "error", errorMessage(error));
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/test-media", requireAdmin, async (req, res) => {
  try {
    const mediaId = String(req.body?.mediaId ?? "").trim();
    if (!mediaId) return res.status(400).json({ ok: false, error: "mediaId is required" });

    const caption = await getMediaCaption(mediaId);
    const flow = findFlow(caption);
    res.json({
      ok: true,
      mediaId,
      matched: Boolean(flow),
      marker: flow?.marker ?? null,
      caption
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/dry-run-comment", requireAdmin, async (req, res) => {
  try {
    const mediaId = String(req.body?.mediaId ?? "").trim();
    const text = String(req.body?.text ?? "").trim();
    if (!mediaId || !text) {
      return res.status(400).json({ ok: false, error: "mediaId and text are required" });
    }

    const choice = parseChoice(text);
    const flow = await getFlowForMedia(mediaId);
    const reply = choice && flow ? pickReply(flow.choices[choice]) : null;

    res.json({
      ok: true,
      mediaId,
      text,
      choice,
      matched: Boolean(flow),
      marker: flow?.marker ?? null,
      wouldSend: Boolean(reply),
      publicReply: reply?.publicReply ?? null,
      publicReplies: flow && choice ? normalizePublicReplies(flow.choices[choice]) : [],
      privateReply: reply?.privateReply ?? null
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200);

  const entries = req.body?.entry ?? [];
  for (const entry of entries) {
    if (entry.field === "comments" && entry.value) {
      handleComment(entry.value).catch(console.error);
    } else if (entry.field && entry.value) {
      addEvent({
        status: "ignored",
        reason: "unsupported_webhook_field",
        message: `未対応Webhook field: ${entry.field}`
      });
    }

    for (const change of entry.changes ?? []) {
      if (change.field === "comments") {
        handleComment(change.value).catch(console.error);
      } else {
        addEvent({
          status: "ignored",
          reason: "unsupported_webhook_field",
          message: `未対応Webhook field: ${change.field ?? "unknown"}`
        });
      }
    }
  }
});

async function handleComment(comment) {
  const normalized = normalizeComment(comment);
  const { commentId, mediaId, choice, username } = normalized;

  addEvent({
    status: "received",
    commentId,
    mediaId,
    username,
    text: normalized.text,
    choice
  });

  const ownerComment = isOwnerComment(normalized);
  if (commentId) {
    await upsertMediaComment({
      ...normalized,
      isOwnerComment: ownerComment,
      automationStatus: ownerComment ? "owner_comment" : "received"
    });
  }

  if (!normalized.username && !normalized.userId) {
    addEvent({
      status: "received",
      reason: "user_info_missing",
      commentId,
      mediaId,
      choice,
      message: "ユーザー情報未取得。comment_idがあればPrivate Replyは可能です"
    });
  }

  if (ownerComment) {
    addEvent({ status: "ignored", reason: "owner_comment", commentId, mediaId, choice, username });
    return;
  }

  if (!commentId || !mediaId || !choice) {
    await updateCommentStatus(commentId, "ignored");
    addEvent({ status: "ignored", reason: "missing_id_or_choice", commentId, mediaId, choice });
    return;
  }
  if (processedComments.has(commentId) || (await hasProcessedComment(commentId))) {
    await updateCommentStatus(commentId, "already_processed");
    addEvent({ status: "ignored", reason: "already_processed", commentId, mediaId, choice });
    return;
  }

  const flow = await getFlowForMedia(mediaId);
  if (!flow) {
    await updateCommentStatus(commentId, "outside_target");
    addEvent({ status: "ignored", reason: "no_caption_marker", commentId, mediaId, choice });
    return;
  }
  if (flow.enabled === false) {
    await updateCommentStatus(commentId, "flow_paused");
    addEvent({ status: "ignored", reason: "flow_paused", commentId, mediaId, choice });
    return;
  }

  const reply = pickReply(flow.choices[choice]);
  try {
    await replyToComment(commentId, reply.publicReply);
    await sendPrivateReply(commentId, reply.privateReply);
  } catch (error) {
    addEvent({
      status: "error",
      commentId,
      mediaId,
      choice,
      message: error instanceof Error ? error.message : String(error)
    });
    await updateCommentStatus(commentId, "error", errorMessage(error));
    await saveProcessedComment({
      commentId,
      mediaId,
      choice,
      username,
      text: normalized.text,
      publicReply: reply.publicReply,
      privateReply: reply.privateReply,
      status: "error",
      errorMessage: errorMessage(error)
    });
    throw error;
  }

  processedComments.add(commentId);
  await saveProcessedComment({
    commentId,
    mediaId,
    choice,
    username,
    text: normalized.text,
    publicReply: reply.publicReply,
    privateReply: reply.privateReply,
    status: "sent"
  });
  await updateCommentStatus(commentId, "dm_sent");
  addEvent({ status: "sent", commentId, mediaId, choice, marker: flow.marker });
  console.log(`sent reply: media=${mediaId} comment=${commentId} choice=${choice}`);
}

async function getFlowForMedia(mediaId) {
  if (mediaFlowCache.has(mediaId)) {
    return mediaFlowCache.get(mediaId);
  }

  const stored = await getLinkedFlowForMedia(mediaId);
  if (stored) {
    const normalizedStored = normalizeFlow(stored);
    mediaFlowCache.set(mediaId, normalizedStored);
    return normalizedStored;
  }

  const media = await getMedia(mediaId);
  const flow = await findFlowForCaption(media.caption ?? "");
  mediaFlowCache.set(mediaId, flow);
  await upsertMediaPost(media, flow);
  return flow;
}

async function findFlowForCaption(caption) {
  const localFlow = findFlow(caption) ?? null;
  if (!localFlow) return null;
  const dbFlow = await findDbFlowByMarker(localFlow.marker);
  return normalizeFlow(dbFlow ?? localFlow);
}

async function graphRequest(path, options = {}) {
  const url = new URL(`${GRAPH_BASE_URL}/${GRAPH_API_VERSION}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", ACCESS_TOKEN);

  if (options.fields) {
    url.searchParams.set("fields", options.fields);
  }

  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  return fetchJson(url, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json?.error?.message ?? `Meta API error: ${response.status}`;
    const detail = Object.keys(json).length ? `${message} ${JSON.stringify(json)}` : message;
    throw new Error(detail);
  }

  return json;
}

async function getMediaCaption(mediaId) {
  const media = await getMedia(mediaId);
  return media.caption ?? "";
}

async function getMedia(mediaId) {
  return graphRequest(`/${mediaId}`, {
    fields:
      "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count"
  });
}

async function getLatestMedia(limit) {
  const response = await graphRequest(`/${IG_USER_ID}/media`, {
    fields:
      "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,comments_count,like_count",
    query: { limit: String(limit) }
  });

  return response.data ?? [];
}

async function getMediaCommentsFromInstagram(mediaId, limit) {
  const response = await getMediaCommentsRaw(mediaId, limit);
  return response.data ?? [];
}

async function getMediaCommentsRaw(mediaId, limit) {
  try {
    const raw = await graphRequest(`/${mediaId}/comments`, {
      fields: COMMENT_FIELDS_DETAILED,
      query: { limit: String(limit) }
    });
    raw._requestedFields = COMMENT_FIELDS_DETAILED;
    return raw;
  } catch (error) {
    const raw = await graphRequest(`/${mediaId}/comments`, {
      fields: COMMENT_FIELDS,
      query: { limit: String(limit) }
    });
    raw._requestedFields = COMMENT_FIELDS;
    raw._fieldFallbackReason = errorMessage(error);
    return raw;
  }
}

async function getCommentFromInstagram(commentId) {
  try {
    const raw = await graphRequest(`/${commentId}`, {
      fields: `${COMMENT_FIELDS_DETAILED},media`
    });
    raw._requestedFields = `${COMMENT_FIELDS_DETAILED},media`;
    return raw;
  } catch (error) {
    const raw = await graphRequest(`/${commentId}`, {
      fields: `${COMMENT_FIELDS},media`
    });
    raw._requestedFields = `${COMMENT_FIELDS},media`;
    raw._fieldFallbackReason = errorMessage(error);
    return raw;
  }
}

async function replyToComment(commentId, message) {
  await graphRequest(`/${commentId}/replies`, {
    method: "POST",
    body: { message }
  });
}

async function sendPrivateReply(commentId, message) {
  await graphRequest(`/${IG_USER_ID}/messages`, {
    method: "POST",
    body: {
      recipient: { comment_id: commentId },
      message: { text: message }
    }
  });
}

function requireAdmin(req, res, next) {
  if (ADMIN_AUTH_ENABLED !== "true") return next();
  if (!ADMIN_TOKEN) return next();

  const token = req.query.token || req.header("x-admin-token");
  if (token === ADMIN_TOKEN) return next();

  return res.status(401).send("Unauthorized");
}

function addEvent(event) {
  const fullEvent = {
    at: new Date().toISOString(),
    ...event
  };

  recentEvents.unshift(fullEvent);
  saveEvent(fullEvent).catch((error) => {
    console.error("failed to save event:", error);
  });

  if (recentEvents.length > 100) {
    recentEvents.length = 100;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeComment(comment) {
  const text = comment?.text ?? "";
  return {
    commentId: comment?.id,
    mediaId: comment?.media?.id,
    username: comment?.from?.username ?? comment?.username ?? "",
    userId: comment?.from?.id ?? "",
    text,
    choice: parseChoice(text),
    likeCount: comment?.like_count ?? null,
    hidden: comment?.hidden ?? null,
    createdAt: comment?.timestamp ?? null
  };
}

function redactAccessTokens(value) {
  if (Array.isArray(value)) return value.map(redactAccessTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key.toLowerCase().includes("token") ? "[REDACTED]" : redactAccessTokens(item)
      ])
    );
  }
  if (typeof value === "string") {
    return value.replace(/([?&]access_token=)[^&\s)]+/g, "$1[REDACTED]");
  }
  return value;
}

function normalizeFlow(flow) {
  if (!flow) return null;
  return {
    ...flow,
    choices: normalizeChoices(flow.choices ?? {})
  };
}

function normalizeFlowList(flowList) {
  return flowList.map(normalizeFlow).filter(Boolean);
}

function pickReply(reply) {
  const publicReplies = normalizePublicReplies(reply);
  const publicReply =
    publicReplies[Math.floor(Math.random() * publicReplies.length)] ?? reply?.publicReply ?? "";
  return {
    publicReply,
    privateReply: reply?.privateReply ?? ""
  };
}

function isOwnerComment(comment) {
  if (comment.userId && IG_USER_ID && comment.userId === IG_USER_ID) return true;
  if (!comment.username || !IG_USERNAME) return false;
  return comment.username.toLowerCase() === IG_USERNAME.replace(/^@/, "").toLowerCase();
}

function localFlows() {
  return flows.map((flow) => ({
    id: flow.id,
    name: flow.name,
    marker: flow.marker,
    enabled: flow.enabled !== false,
    choices: normalizeChoices(flow.choices),
    linkedMediaCount: 0
  }));
}

function getMemoryWebhookTodaySummary() {
  const today = new Date().toISOString().slice(0, 10);
  const grouped = new Map();

  for (const event of recentEvents) {
    if (event.status !== "received") continue;
    if (event.reason === "user_info_missing") continue;
    if (!event.at?.startsWith(today)) continue;

    const mediaId = event.mediaId ?? "unknown";
    const item = grouped.get(mediaId) ?? {
      mediaId,
      count: 0,
      lastReceivedAt: event.at,
      caption: "",
      mediaType: "",
      mediaProductType: "",
      mediaUrl: "",
      thumbnailUrl: "",
      permalink: "",
      active: false,
      matchedMarker: null,
      flowName: null
    };

    item.count += 1;
    if (event.at > item.lastReceivedAt) item.lastReceivedAt = event.at;
    grouped.set(mediaId, item);
  }

  return [...grouped.values()].sort((a, b) => String(b.lastReceivedAt).localeCompare(String(a.lastReceivedAt)));
}

initDatabase(flows)
  .then(() => {
    app.listen(Number(PORT), () => {
      console.log(`listening on port ${PORT}`);
      console.log(hasDatabase() ? "Postgres connected" : "Postgres disabled; using memory only");
    });
  })
  .catch((error) => {
    console.error("unexpected startup error:", error);
    app.listen(Number(PORT), () => {
      console.log(`listening on port ${PORT}`);
      console.log("Postgres disabled; using memory only");
    });
  });
