import "dotenv/config";
import express from "express";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findFlow, flows, parseChoice } from "./flows.js";

const app = express();
app.use(express.json());

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  PORT = 3000,
  VERIFY_TOKEN,
  IG_USER_ID,
  ACCESS_TOKEN,
  ADMIN_TOKEN,
  GRAPH_BASE_URL = "https://graph.facebook.com",
  GRAPH_API_VERSION = "v25.0"
} = process.env;

const processedComments = new Set();
const recentEvents = [];
const mediaFlowCache = new Map();

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

app.get("/api/status", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    env: {
      VERIFY_TOKEN: Boolean(VERIFY_TOKEN),
      IG_USER_ID: Boolean(IG_USER_ID),
      ACCESS_TOKEN: Boolean(ACCESS_TOKEN),
      ADMIN_TOKEN: Boolean(ADMIN_TOKEN),
      GRAPH_BASE_URL,
      GRAPH_API_VERSION
    },
    flows: flows.map((flow) => ({
      marker: flow.marker,
      choices: Object.keys(flow.choices)
    })),
    stats: {
      processedComments: processedComments.size,
      cachedMedia: mediaFlowCache.size,
      recentEvents: recentEvents.length
    },
    recentEvents
  });
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
    const reply = choice && flow ? flow.choices[choice] : null;

    res.json({
      ok: true,
      mediaId,
      text,
      choice,
      matched: Boolean(flow),
      marker: flow?.marker ?? null,
      wouldSend: Boolean(reply),
      publicReply: reply?.publicReply ?? null,
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
    for (const change of entry.changes ?? []) {
      if (change.field === "comments") {
        handleComment(change.value).catch(console.error);
      }
    }
  }
});

async function handleComment(comment) {
  const commentId = comment?.id;
  const mediaId = comment?.media?.id;
  const choice = parseChoice(comment?.text);
  const username = comment?.from?.username ?? "";

  addEvent({
    status: "received",
    commentId,
    mediaId,
    username,
    text: comment?.text ?? "",
    choice
  });

  if (!commentId || !mediaId || !choice) {
    addEvent({ status: "ignored", reason: "missing_id_or_choice", commentId, mediaId, choice });
    return;
  }
  if (processedComments.has(commentId)) {
    addEvent({ status: "ignored", reason: "already_processed", commentId, mediaId, choice });
    return;
  }

  const flow = await getFlowForMedia(mediaId);
  if (!flow) {
    addEvent({ status: "ignored", reason: "no_caption_marker", commentId, mediaId, choice });
    return;
  }

  const reply = flow.choices[choice];
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
    throw error;
  }

  processedComments.add(commentId);
  addEvent({ status: "sent", commentId, mediaId, choice, marker: flow.marker });
  console.log(`sent reply: media=${mediaId} comment=${commentId} choice=${choice}`);
}

async function getFlowForMedia(mediaId) {
  if (mediaFlowCache.has(mediaId)) {
    return mediaFlowCache.get(mediaId);
  }

  const caption = await getMediaCaption(mediaId);
  const flow = findFlow(caption) ?? null;
  mediaFlowCache.set(mediaId, flow);
  return flow;
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

  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.error?.message ?? `Meta API error: ${response.status}`);
  }

  return json;
}

async function getMediaCaption(mediaId) {
  const media = await graphRequest(`/${mediaId}`, {
    fields: "id,caption"
  });
  return media.caption ?? "";
}

async function getLatestMedia(limit) {
  const response = await graphRequest(`/${IG_USER_ID}/media`, {
    fields: "id,caption,media_type,media_product_type,permalink,timestamp",
    query: { limit: String(limit) }
  });

  return response.data ?? [];
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
  if (!ADMIN_TOKEN) return next();

  const token = req.query.token || req.header("x-admin-token");
  if (token === ADMIN_TOKEN) return next();

  return res.status(401).send("Unauthorized");
}

function addEvent(event) {
  recentEvents.unshift({
    at: new Date().toISOString(),
    ...event
  });

  if (recentEvents.length > 100) {
    recentEvents.length = 100;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

app.listen(Number(PORT), () => {
  console.log(`listening on port ${PORT}`);
});
