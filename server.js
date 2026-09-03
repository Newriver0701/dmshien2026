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

app.listen(Number(PORT), () => {
  console.log(`listening on port ${PORT}`);
});
