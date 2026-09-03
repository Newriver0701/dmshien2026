import "dotenv/config";
import express from "express";
import { findFlow, parseChoice } from "./flows.js";

const app = express();
app.use(express.json());

const {
  PORT = 3000,
  VERIFY_TOKEN,
  IG_USER_ID,
  ACCESS_TOKEN,
  GRAPH_BASE_URL = "https://graph.facebook.com",
  GRAPH_API_VERSION = "v25.0"
} = process.env;

const processedComments = new Set();

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "instagram-tarot-auto-simple" });
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

  if (!commentId || !mediaId || !choice) return;
  if (processedComments.has(commentId)) return;

  const caption = await getMediaCaption(mediaId);
  const flow = findFlow(caption);
  if (!flow) return;

  const reply = flow.choices[choice];
  await replyToComment(commentId, reply.publicReply);
  await sendPrivateReply(commentId, reply.privateReply);

  processedComments.add(commentId);
  console.log(`sent reply: media=${mediaId} comment=${commentId} choice=${choice}`);
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

app.listen(Number(PORT), () => {
  console.log(`listening on port ${PORT}`);
});
