import "dotenv/config";
import express from "express";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findDbFlowByMarker,
  addTaskStep,
  claimDueSendTasks,
  createAutomationTask,
  getOutboundSendCount,
  getAutomationTask,
  getAutomationTaskSteps,
  getAutomationTasks,
  getAutomationTasksForMedia,
  getComment,
  getFlows,
  getLinkedFlowForMedia,
  getMediaComments,
  getMediaPost,
  getMediaPosts,
  getMediaTarotReading,
  getOmikujiAsset,
  getOmikujiAssets,
  getRecentEvents,
  getRandomOmikujiAssetByResult,
  getSettings,
  getStats,
  getWebhookTodaySummary,
  getDatabaseStatus,
  hasDatabase,
  hasQueuedOrProcessedComment,
  initDatabase,
  markPrivateReplySent,
  markPublicReplySent,
  markSendTaskError,
  rescheduleSendTask,
  saveEvent,
  saveMediaTarotReading,
  saveProcessedComment,
  scheduleAutomationTask,
  setFlowEnabled,
  setOmikujiAssetEnabled,
  updateAutomationTask,
  updateFlowChoices,
  updateSettings,
  updateCommentStatus,
  upsertOmikujiAsset,
  upsertMediaComment,
  upsertMediaPost
} from "./db.js";
import { findFlow, flows, normalizeChoices, normalizePublicReplies, parseChoice } from "./flows.js";
import { pickTarotCards } from "./tarot.js";

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
  APP_SECRET,
  IG_USERNAME,
  GRAPH_BASE_URL = "https://graph.instagram.com",
  GRAPH_API_VERSION = "v26.0",
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL = "https://api.deepseek.com",
  DEEPSEEK_MODEL = "deepseek-v4-flash",
  GOOGLE_DRIVE_API_KEY,
  OMIKUJI_FOLDER_KYOU,
  OMIKUJI_FOLDER_SUEKICHI,
  OMIKUJI_FOLDER_SHOKICHI,
  OMIKUJI_FOLDER_CHUKICHI,
  OMIKUJI_FOLDER_KICHI,
  OMIKUJI_FOLDER_DAIKICHI,
  PUBLIC_BASE_URL,
  RAILWAY_PUBLIC_DOMAIN
} = process.env;

const processedComments = new Set();
const recentEvents = [];
const mediaFlowCache = new Map();
const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2)}`;
let sendQueueBusy = false;
const COMMENT_FIELDS = "id,text,username,timestamp,like_count,hidden,from";
const COMMENT_FIELDS_DETAILED = "id,text,username,timestamp,like_count,hidden,from{id,username}";
const OMIKUJI_RESULTS = ["凶", "末吉", "小吉", "中吉", "吉", "大吉"];

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

app.get("/omikuji-image/:assetId", async (req, res) => {
  try {
    const asset = await getOmikujiAsset(req.params.assetId);
    if (!asset || asset.enabled === false) return res.status(404).send("not found");
    const image = await fetchDriveImage(asset.driveFileId);
    res.setHeader("Content-Type", image.contentType || asset.mimeType || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(await image.response.arrayBuffer()));
  } catch (error) {
    res.status(500).send(errorMessage(error));
  }
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
  const settings = await getSettings();

  res.json({
    ok: true,
    settings,
    env: {
      VERIFY_TOKEN: Boolean(VERIFY_TOKEN),
      IG_USER_ID: Boolean(IG_USER_ID),
      ACCESS_TOKEN: Boolean(ACCESS_TOKEN),
      ADMIN_TOKEN: Boolean(ADMIN_TOKEN),
      ADMIN_AUTH_ENABLED,
      DATABASE_URL: Boolean(DATABASE_URL),
      APP_SECRET: Boolean(APP_SECRET),
      IG_USERNAME: Boolean(IG_USERNAME),
      DEEPSEEK_API_KEY: Boolean(DEEPSEEK_API_KEY),
      DEEPSEEK_BASE_URL,
      DEEPSEEK_MODEL,
      GOOGLE_DRIVE_API_KEY: Boolean(GOOGLE_DRIVE_API_KEY),
      OMIKUJI_FOLDER_KYOU: Boolean(OMIKUJI_FOLDER_KYOU),
      OMIKUJI_FOLDER_SUEKICHI: Boolean(OMIKUJI_FOLDER_SUEKICHI),
      OMIKUJI_FOLDER_SHOKICHI: Boolean(OMIKUJI_FOLDER_SHOKICHI),
      OMIKUJI_FOLDER_CHUKICHI: Boolean(OMIKUJI_FOLDER_CHUKICHI),
      OMIKUJI_FOLDER_KICHI: Boolean(OMIKUJI_FOLDER_KICHI),
      OMIKUJI_FOLDER_DAIKICHI: Boolean(OMIKUJI_FOLDER_DAIKICHI),
      PUBLIC_BASE_URL: publicBaseUrl() ?? "",
      GRAPH_BASE_URL,
      GRAPH_API_VERSION
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
      tasksToday: 0,
      readyTasks: 0,
      recentEvents: recentEvents.length
    },
    webhookTodayByMedia: dbWebhookToday ?? memoryWebhookToday,
    recentEvents: dbEvents ?? recentEvents
  });
});

app.get("/api/flows", requireAdmin, async (_req, res) => {
  res.json({ ok: true, flows: normalizeFlowList((await getFlows()) ?? localFlows()) });
});

app.get("/api/settings", requireAdmin, async (_req, res) => {
  res.json({ ok: true, settings: await getSettings() });
});

app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const incoming = req.body?.settings ?? req.body ?? {};
    const settings = {};

    if (Object.hasOwn(incoming, "automationEnabled")) {
      settings.automationEnabled = Boolean(incoming.automationEnabled);
      settings.tarotDmEnabled = Boolean(incoming.automationEnabled);
    }
    if (Object.hasOwn(incoming, "tarotDmEnabled")) {
      settings.tarotDmEnabled = Boolean(incoming.tarotDmEnabled);
      settings.automationEnabled = Boolean(incoming.tarotDmEnabled);
    }
    if (Object.hasOwn(incoming, "omikujiEnabled")) {
      settings.omikujiEnabled = Boolean(incoming.omikujiEnabled);
    }
    if (Object.hasOwn(incoming, "targetMode")) {
      settings.targetMode = incoming.targetMode === "marker_only" ? "marker_only" : "all_posts";
    }
    if (Object.hasOwn(incoming, "aiChoiceEnabled")) {
      settings.aiChoiceEnabled = Boolean(incoming.aiChoiceEnabled);
    }
    if (Object.hasOwn(incoming, "aiReadingEnabled")) {
      settings.aiReadingEnabled = Boolean(incoming.aiReadingEnabled);
    }
    if (Object.hasOwn(incoming, "publicReplyTemplates")) {
      settings.publicReplyTemplates = normalizeTemplates(incoming.publicReplyTemplates);
      if (settings.publicReplyTemplates.length === 0) {
        return res.status(400).json({ ok: false, error: "公開返信テンプレートを1つ以上入れてください" });
      }
    }
    if (Object.hasOwn(incoming, "privateReplyTemplate")) {
      settings.privateReplyTemplate = String(incoming.privateReplyTemplate ?? "").trim();
      if (!settings.privateReplyTemplate.includes("{reading}")) {
        return res.status(400).json({ ok: false, error: "DM本文フォーマットには {reading} を入れてください" });
      }
    }
    if (Object.hasOwn(incoming, "omikujiTextTemplate")) {
      settings.omikujiTextTemplate = String(incoming.omikujiTextTemplate ?? "").trim();
      if (!settings.omikujiTextTemplate.includes("{result}")) {
        return res.status(400).json({ ok: false, error: "おみくじ本文フォーマットには {result} を入れてください" });
      }
    }
    const numericSettings = {
      publicReplyMinDelaySec: [0, 3600],
      publicReplyMaxDelaySec: [0, 3600],
      dmAfterPublicMinDelaySec: [0, 3600],
      dmAfterPublicMaxDelaySec: [0, 3600],
      maxSendsPerHour: [1, 5000],
      maxSendsPerDay: [1, 50000],
      maxParallelSends: [1, 50],
      rateLimitPauseMinutes: [1, 1440]
    };
    for (const [key, [min, max]] of Object.entries(numericSettings)) {
      if (Object.hasOwn(incoming, key)) {
        settings[key] = clampNumber(incoming[key], min, max);
      }
    }
    if (Object.hasOwn(incoming, "pauseOnRateLimit")) {
      settings.pauseOnRateLimit = Boolean(incoming.pauseOnRateLimit);
    }
    if (Object.hasOwn(incoming, "sendPausedUntil")) {
      settings.sendPausedUntil = incoming.sendPausedUntil || null;
    }
    if (
      Object.hasOwn(settings, "publicReplyMinDelaySec") ||
      Object.hasOwn(settings, "publicReplyMaxDelaySec")
    ) {
      const current = await getSettings();
      const min = settings.publicReplyMinDelaySec ?? current.publicReplyMinDelaySec;
      const max = settings.publicReplyMaxDelaySec ?? current.publicReplyMaxDelaySec;
      if (min > max) return res.status(400).json({ ok: false, error: "公開返信の最小秒数は最大秒数以下にしてください" });
    }
    if (
      Object.hasOwn(settings, "dmAfterPublicMinDelaySec") ||
      Object.hasOwn(settings, "dmAfterPublicMaxDelaySec")
    ) {
      const current = await getSettings();
      const min = settings.dmAfterPublicMinDelaySec ?? current.dmAfterPublicMinDelaySec;
      const max = settings.dmAfterPublicMaxDelaySec ?? current.dmAfterPublicMaxDelaySec;
      if (min > max) return res.status(400).json({ ok: false, error: "DM送信の最小秒数は最大秒数以下にしてください" });
    }

    res.json({ ok: true, settings: await updateSettings(settings) });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
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

app.post("/api/instagram/exchange-token", requireAdmin, async (req, res) => {
  try {
    const shortToken = cleanToken(req.body?.shortToken);
    if (!shortToken) return res.status(400).json({ ok: false, error: "shortToken is required" });
    if (!APP_SECRET) {
      return res.status(400).json({
        ok: false,
        error: "APP_SECRET must be set in Railway Variables"
      });
    }

    const url = new URL(`${GRAPH_BASE_URL}/access_token`);
    url.searchParams.set("grant_type", "ig_exchange_token");
    url.searchParams.set("client_secret", APP_SECRET);
    url.searchParams.set("access_token", shortToken);

    const token = await fetchJson(url);
    res.json({
      ok: true,
      accessToken: token.access_token,
      tokenType: token.token_type,
      expiresIn: token.expires_in,
      expiresAt: expiresAt(token.expires_in),
      note: "このaccessTokenをRailwayのACCESS_TOKENに入れて再デプロイしてください。"
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/instagram/refresh-token", requireAdmin, async (req, res) => {
  try {
    const longToken = cleanToken(req.body?.longToken ?? ACCESS_TOKEN);
    if (!longToken) return res.status(400).json({ ok: false, error: "longToken is required" });

    const url = new URL(`${GRAPH_BASE_URL}/refresh_access_token`);
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", longToken);

    const token = await fetchJson(url);
    res.json({
      ok: true,
      accessToken: token.access_token,
      tokenType: token.token_type,
      expiresIn: token.expires_in,
      expiresAt: expiresAt(token.expires_in),
      note: "返ってきたaccessTokenをRailwayのACCESS_TOKENに入れて再デプロイしてください。"
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/instagram/check-token", requireAdmin, async (req, res) => {
  try {
    const token = cleanToken(req.body?.token ?? ACCESS_TOKEN);
    if (!token) return res.status(400).json({ ok: false, error: "token is required" });

    const url = new URL(`${GRAPH_BASE_URL}/${GRAPH_API_VERSION}/me`);
    url.searchParams.set("fields", "id,username,account_type");
    url.searchParams.set("access_token", token);

    const profile = await fetchJson(url);
    res.json({
      ok: true,
      profile,
      note: "このTokenはInstagram APIで有効です。表示されたidをIG_USER_IDに使ってください。"
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: errorMessage(error),
      hint:
        "Instagram Loginで生成したAccess Tokenか確認してください。Facebook/Page Token、期限切れ、権限取り消し、余分なBearer/引用符/改行があるTokenは失敗します。"
    });
  }
});

app.get("/api/tasks", requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 200);
  res.json({ ok: true, tasks: (await getAutomationTasks(limit)) ?? [] });
});

app.get("/api/tasks/:taskId", requireAdmin, async (req, res) => {
  const task = await getAutomationTask(req.params.taskId);
  if (!task) return res.status(404).json({ ok: false, error: "task not found" });
  res.json({ ok: true, task, steps: (await getAutomationTaskSteps(req.params.taskId)) ?? [] });
});

app.post("/api/tasks/:taskId/retry", requireAdmin, async (req, res) => {
  try {
    const task = await getAutomationTask(req.params.taskId);
    if (!task) return res.status(404).json({ ok: false, error: "task not found" });
    await addTaskStep(task.taskId, "retry", "started", "タスクを再実行します");
    await updateAutomationTask(task.taskId, { status: "retrying", errorMessage: null });
    const result = await runAutomationTask(task, { forceSend: true });
    res.json({ ok: true, task: result });
  } catch (error) {
    await updateAutomationTask(req.params.taskId, { status: "error", errorMessage: errorMessage(error) });
    await addTaskStep(req.params.taskId, "retry", "error", errorMessage(error));
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/tasks/:taskId/send-omikuji", requireAdmin, async (req, res) => {
  try {
    const task = await getAutomationTask(req.params.taskId);
    if (!task) return res.status(404).json({ ok: false, error: "task not found" });
    const sent = await sendOmikujiForTask(task, { manual: true });
    res.json({ ok: true, task: sent });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/ai/check", requireAdmin, async (_req, res) => {
  try {
    const content = await deepseekText([
      { role: "system", content: "Return only the plain text word ok." },
      { role: "user", content: "ok" }
    ], { maxTokens: 20 });
    res.json({ ok: true, model: DEEPSEEK_MODEL, content });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/ai/test-choice", requireAdmin, async (req, res) => {
  try {
    const text = String(req.body?.text ?? "");
    const sanitizedText = sanitizeText(text);
    const ruleChoice = parseChoice(sanitizedText);
    if (ruleChoice) {
      return res.json({ ok: true, choice: ruleChoice, method: "rule", sanitizedText });
    }

    const choice = await detectChoiceWithAi(sanitizedText);
    res.json({ ok: true, choice, method: choice === "unknown" ? "unknown" : "deepseek", sanitizedText });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.post("/api/ai/generate-media-reading", requireAdmin, async (req, res) => {
  try {
    const mediaId = String(req.body?.mediaId ?? "").trim();
    if (!mediaId) return res.status(400).json({ ok: false, error: "mediaId is required" });
    let media = await getMediaPost(mediaId);
    if (!media) {
      const fetched = await getMedia(mediaId);
      const flow = await findFlowForCaption(fetched.caption ?? "");
      await upsertMediaPost(fetched, flow);
      media = await getMediaPost(mediaId);
    }
    const reading = await generateAndSaveReading(media);
    res.json({ ok: true, reading });
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

app.get("/api/omikuji-assets", requireAdmin, async (_req, res) => {
  const assets = (await getOmikujiAssets()) ?? [];
  res.json({
    ok: true,
    assets,
    counts: countOmikujiAssets(assets),
    folders: omikujiFolderStatus()
  });
});

app.post("/api/omikuji-assets/sync", requireAdmin, async (_req, res) => {
  try {
    const synced = await syncOmikujiFolders();
    res.json({ ok: true, ...synced });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
});

app.put("/api/omikuji-assets/:id", requireAdmin, async (req, res) => {
  try {
    const asset = await setOmikujiAssetEnabled(req.params.id, Boolean(req.body?.enabled));
    if (!asset) return res.status(404).json({ ok: false, error: "asset not found" });
    res.json({ ok: true, asset });
  } catch (error) {
    res.status(500).json({ ok: false, error: errorMessage(error) });
  }
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
  res.json({
    ok: true,
    media,
    reading: await getMediaTarotReading(req.params.mediaId),
    tasks: (await getAutomationTasksForMedia(req.params.mediaId)) ?? []
  });
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
    const settings = await getSettings();
    const flow = await getFlowForMedia(mediaId);
    const targetAllowed = isTargetAllowed(flow, settings);
    let saved = 0;
    let prepared = 0;
    let skipped = 0;
    let errors = 0;

    for (const comment of comments) {
      const normalized = normalizeComment({ ...comment, media: { id: mediaId } });
      const isOwner = isOwnerComment(normalized);
      await upsertMediaComment({
        ...normalized,
        isOwnerComment: isOwner,
        automationStatus: isOwner ? "owner_comment" : "unprocessed"
      });
      saved += 1;

      if (isOwner || !normalized.commentId || !targetAllowed) {
        skipped += 1;
        continue;
      }

      const task = await createAutomationTask({
        ...normalized,
        sanitizedText: sanitizeText(normalized.text),
        status: "received"
      });

      try {
        const choiceResult = await detectChoice(sanitizeText(normalized.text), settings, task?.taskId);
        const choice = choiceResult.choice === "unknown" ? null : choiceResult.choice;
        await updateAutomationTask(task?.taskId, {
          choice,
          choiceMethod: choiceResult.method,
          status: choice ? "choice_detected" : "ignored",
          errorMessage: choice ? null : "番号を判定できませんでした"
        });

        await upsertMediaComment({
          ...normalized,
          text: sanitizeText(normalized.text) || normalized.text,
          choice,
          isOwnerComment: false,
          automationStatus: choice ? "received" : "ignored",
          errorMessage: choice ? null : "番号を判定できませんでした"
        });

        if (!choice) {
          skipped += 1;
          continue;
        }

        if (processedComments.has(normalized.commentId) || (await hasQueuedOrProcessedComment(normalized.commentId))) {
          if (isTerminalOrQueuedStatus(task?.status)) {
            await updateCommentStatus(normalized.commentId, task.status === "sent" ? "dm_sent" : task.status);
            await addTaskStep(task?.taskId, "duplicate_check", "skipped", "送信待機中または送信済みのため再処理しません");
          } else {
            await updateCommentStatus(normalized.commentId, "already_processed");
            await updateAutomationTask(task?.taskId, { status: "already_processed", errorMessage: "すでに返信済みです" });
          }
          skipped += 1;
          continue;
        }

        const result = await prepareAutomationTask(
          {
            ...(task ?? {}),
            commentId: normalized.commentId,
            mediaId,
            username: normalized.username,
            text: normalized.text,
            sanitizedText: sanitizeText(normalized.text),
            choice,
            choiceMethod: choiceResult.method
          },
          { settings, flow }
        );
        await updateCommentStatus(normalized.commentId, "ready_to_send");
        await addTaskStep(result.task?.taskId, "send_gate", "skipped", "コメント取得から準備しました。最後の送信だけ待機しています");
        prepared += 1;
      } catch (error) {
        errors += 1;
        await updateCommentStatus(normalized.commentId, "error", errorMessage(error));
        await updateAutomationTask(task?.taskId, { status: "error", errorMessage: errorMessage(error) });
        await addTaskStep(task?.taskId, "prepare_from_sync", "error", errorMessage(error));
      }
    }

    addEvent({ status: "sync", mediaId, message: `${saved}件のコメントを同期し、${prepared}件を送信待ちにしました` });
    res.json({ ok: true, count: saved, prepared, skipped, errors });
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

    const settings = await getSettings();
    const sanitizedText = sanitizeText(text);
    const choiceResult = await detectChoice(sanitizedText, settings);
    const choice = choiceResult.choice === "unknown" ? null : choiceResult.choice;
    const flow = await getFlowForMedia(mediaId);
    const targetAllowed = isTargetAllowed(flow, settings);
    const reading = choice && targetAllowed ? await getMediaTarotReading(mediaId) : null;
    const publicReply = choice ? pickPublicReply(settings.publicReplyTemplates, choice) : null;
    const privateReply = choice && reading?.readings?.[choice]
      ? formatPrivateReply(settings.privateReplyTemplate, {
          theme: reading.theme,
          reading: reading.readings[choice],
          username: "",
          choice,
          card: reading.cards?.[choice]
        })
      : null;

    res.json({
      ok: true,
      mediaId,
      text,
      sanitizedText,
      choice,
      choiceMethod: choiceResult.method,
      matched: Boolean(flow),
      marker: flow?.marker ?? null,
      targetMode: settings.targetMode,
      targetAllowed,
      automationEnabled: Boolean(settings.tarotDmEnabled),
      tarotDmEnabled: Boolean(settings.tarotDmEnabled),
      omikujiEnabled: Boolean(settings.omikujiEnabled),
      wouldSend: Boolean(settings.tarotDmEnabled && choice && targetAllowed && privateReply),
      needsReading: Boolean(choice && targetAllowed && !privateReply),
      publicReply,
      publicReplyTemplates: settings.publicReplyTemplates,
      privateReply
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
  const sanitizedText = sanitizeText(normalized.text);
  const { commentId, mediaId, username } = normalized;

  addEvent({
    status: "received",
    commentId,
    mediaId,
    username,
    text: normalized.text
  });

  const task = await createAutomationTask({
    ...normalized,
    sanitizedText,
    status: "received"
  });
  await addTaskStep(task?.taskId, "webhook_received", "success", "Webhookコメントを受信しました", {
    commentId,
    mediaId,
    text: normalized.text
  });

  const ownerComment = isOwnerComment(normalized);
  if (commentId) {
    await upsertMediaComment({
      ...normalized,
      isOwnerComment: ownerComment,
      automationStatus: ownerComment ? "owner_comment" : "received",
      choice: null
    });
  }

  if (!normalized.username && !normalized.userId) {
    addEvent({
      status: "received",
      reason: "user_info_missing",
      commentId,
      mediaId,
      message: "ユーザー情報未取得。comment_idがあればPrivate Replyは可能です"
    });
  }

  if (ownerComment) {
    await updateAutomationTask(task?.taskId, { status: "ignored", errorMessage: "自分のコメントなので送信しません" });
    await addTaskStep(task?.taskId, "owner_check", "skipped", "自分のコメントなので送信しません");
    addEvent({ status: "ignored", reason: "owner_comment", commentId, mediaId, username });
    return;
  }

  if (!commentId || !mediaId) {
    await updateCommentStatus(commentId, "ignored");
    await updateAutomationTask(task?.taskId, { status: "ignored", errorMessage: "comment_idまたはmedia_idがありません" });
    await addTaskStep(task?.taskId, "required_ids", "error", "comment_idまたはmedia_idがありません");
    addEvent({ status: "ignored", reason: "missing_id", commentId, mediaId });
    return;
  }

  const settings = await getSettings();
  const choiceResult = await detectChoice(sanitizedText, settings, task?.taskId);
  const choice = choiceResult.choice === "unknown" ? null : choiceResult.choice;
  await updateAutomationTask(task?.taskId, {
    choice,
    choiceMethod: choiceResult.method,
    status: choice ? "choice_detected" : "ignored",
    errorMessage: choice ? null : "番号を判定できませんでした"
  });

  await upsertMediaComment({
    ...normalized,
    text: sanitizedText || normalized.text,
    choice,
    isOwnerComment: false,
    automationStatus: choice ? "received" : "ignored",
    errorMessage: choice ? null : "番号を判定できませんでした"
  });

  if (!choice) {
    await updateCommentStatus(commentId, "ignored", "番号を判定できませんでした");
    addEvent({ status: "ignored", reason: "missing_id_or_choice", commentId, mediaId, choice: null });
    return;
  }

  if (processedComments.has(commentId) || (await hasQueuedOrProcessedComment(commentId))) {
    if (isTerminalOrQueuedStatus(task?.status)) {
      await updateCommentStatus(commentId, task.status === "sent" ? "dm_sent" : task.status);
      await addTaskStep(task?.taskId, "duplicate_check", "skipped", "送信待機中または送信済みのため再処理しません");
    } else {
      await updateCommentStatus(commentId, "already_processed");
      await updateAutomationTask(task?.taskId, { status: "already_processed", errorMessage: "すでに返信済みです" });
      await addTaskStep(task?.taskId, "duplicate_check", "skipped", "すでに返信済みです");
    }
    addEvent({ status: "ignored", reason: "already_processed", commentId, mediaId, choice });
    return;
  }

  const flow = await getFlowForMedia(mediaId);
  const targetAllowed = isTargetAllowed(flow, settings);
  await addTaskStep(task?.taskId, "media_flow_check", targetAllowed ? "success" : "skipped", targetAllowed ? "対象投稿として処理します" : "対象リールではありません", {
    marker: flow?.marker ?? null,
    targetMode: settings.targetMode
  });
  if (!targetAllowed) {
    await updateCommentStatus(commentId, "outside_target");
    await updateAutomationTask(task?.taskId, { status: "outside_target", errorMessage: "対象リールではありません" });
    addEvent({ status: "ignored", reason: "no_caption_marker", commentId, mediaId, choice });
    return;
  }
  if (settings.targetMode === "marker_only" && flow?.enabled === false) {
    await updateCommentStatus(commentId, "flow_paused");
    await updateAutomationTask(task?.taskId, { status: "flow_paused", errorMessage: "フローが停止中です" });
    await addTaskStep(task?.taskId, "flow_enabled", "skipped", "フローが停止中です");
    addEvent({ status: "ignored", reason: "flow_paused", commentId, mediaId, choice });
    return;
  }

  try {
    const prepared = await prepareAutomationTask(
      {
        ...(task ?? {}),
        commentId,
        mediaId,
        username,
        text: normalized.text,
        sanitizedText,
        choice,
        choiceMethod: choiceResult.method
      },
      { settings, flow }
    );

    if (!settings.tarotDmEnabled) {
      await updateCommentStatus(commentId, "ready_to_send");
      await addTaskStep(task?.taskId, "send_gate", "skipped", "鑑定DM OFFのため、最後の送信だけ待機しています");
      addEvent({ status: "ready_to_send", reason: "manual_send_required", commentId, mediaId, choice });
      return prepared.task;
    }

    const result = hasDatabase()
      ? await schedulePreparedTask(prepared)
      : await runAutomationTask(prepared.task, { forceSend: true, settings, flow, prepared });
    console.log(`queued reply: media=${mediaId} comment=${commentId} choice=${choice}`);
    return result;
  } catch (error) {
    addEvent({
      status: "error",
      commentId,
      mediaId,
      choice,
      message: error instanceof Error ? error.message : String(error)
    });
    await updateCommentStatus(commentId, "error", errorMessage(error));
    await updateAutomationTask(task?.taskId, { status: "error", errorMessage: errorMessage(error) });
    await addTaskStep(task?.taskId, "automation_error", "error", errorMessage(error));
    throw error;
  }
}

async function runAutomationTask(task, options = {}) {
  const prepared = options.prepared ?? (await prepareAutomationTask(task, options));
  const { settings, flow, task: preparedTask, publicReply, privateReply } = prepared;
  const taskId = preparedTask.taskId;

  if (!options.forceSend && !settings.tarotDmEnabled) {
    await updateCommentStatus(preparedTask.commentId, "ready_to_send");
    await addTaskStep(taskId, "send_gate", "skipped", "鑑定DM OFFのため、最後の送信だけ待機しています");
    return getAutomationTask(taskId);
  }

  const publicResult = await replyToComment(preparedTask.commentId, publicReply);
  await markPublicReplySent(taskId, publicResult.headers);
  await addTaskStep(taskId, "public_reply", "success", "公開コメント返信を送信しました", {
    publicReply,
    apiUsage: publicResult.headers
  });

  const privateResult = await sendPrivateReply(preparedTask.commentId, privateReply);
  await markPrivateReplySent(taskId, privateResult.headers);
  await addTaskStep(taskId, "private_reply", "success", "Private Reply DMを送信しました", {
    privateReply,
    apiUsage: privateResult.headers
  });

  processedComments.add(preparedTask.commentId);
  await saveProcessedComment({
    commentId: preparedTask.commentId,
    mediaId: preparedTask.mediaId,
    choice: preparedTask.choice,
    username: preparedTask.username,
    text: preparedTask.text,
    publicReply,
    privateReply,
    status: "sent"
  });
  await updateCommentStatus(preparedTask.commentId, "dm_sent");
  await updateAutomationTask(taskId, {
    status: "sent",
    publicReply,
    privateReply,
    errorMessage: null
  });
  addEvent({ status: "sent", commentId: preparedTask.commentId, mediaId: preparedTask.mediaId, choice: preparedTask.choice, marker: flow?.marker ?? null });

  return getAutomationTask(taskId);
}

async function schedulePreparedTask(prepared) {
  const { settings, task, flow } = prepared;
  const publicDelaySec = randomInt(
    settings.publicReplyMinDelaySec,
    settings.publicReplyMaxDelaySec
  );
  const dmDelaySec = randomInt(
    settings.dmAfterPublicMinDelaySec,
    settings.dmAfterPublicMaxDelaySec
  );
  const publicAt = new Date(Date.now() + publicDelaySec * 1000);
  const dmAt = new Date(publicAt.getTime() + dmDelaySec * 1000);
  const scheduled = await scheduleAutomationTask(task.taskId, publicAt.toISOString(), dmAt.toISOString());

  await updateCommentStatus(task.commentId, "scheduled_to_send");
  await addTaskStep(task.taskId, "send_waiting", "success", "時間を空けて送信するため待機に入りました", {
    publicReplyDelaySec: publicDelaySec,
    dmAfterPublicDelaySec: dmDelaySec,
    publicReplyScheduledAt: publicAt.toISOString(),
    dmScheduledAt: dmAt.toISOString()
  });
  addEvent({
    status: "scheduled",
    reason: "send_queue",
    commentId: task.commentId,
    mediaId: task.mediaId,
    choice: task.choice,
    marker: flow?.marker ?? null,
    message: `公開返信は${publicDelaySec}秒後、DMはその${dmDelaySec}秒後に送信待機へ入りました`
  });

  return scheduled ?? getAutomationTask(task.taskId);
}

async function processSendQueue() {
  if (sendQueueBusy || !hasDatabase()) return;

  sendQueueBusy = true;
  try {
    const settings = await getSettings();
    if (!settings.tarotDmEnabled) return;
    if (settings.sendPausedUntil && new Date(settings.sendPausedUntil).getTime() > Date.now()) return;

    const hourly = await getOutboundSendCount(60);
    const daily = await getOutboundSendCount(1440);
    const remainingHour = Number(settings.maxSendsPerHour ?? 150) - hourly;
    const remainingDay = Number(settings.maxSendsPerDay ?? 1000) - daily;
    const available = Math.min(remainingHour, remainingDay, Number(settings.maxParallelSends ?? 8));
    if (available <= 0) {
      return;
    }

    const tasks = await claimDueSendTasks(workerId, available);
    if (tasks.length === 0) return;

    await Promise.all(tasks.map((task) => processQueuedSendTask(task, settings)));
  } catch (error) {
    console.error("send queue worker error:", error);
  } finally {
    sendQueueBusy = false;
  }
}

async function processQueuedSendTask(task, settings) {
  try {
    if (task.status === "sending_public") {
      const result = await replyToComment(task.commentId, task.publicReply);
      await markPublicReplySent(task.taskId, result.headers);
      await updateCommentStatus(task.commentId, "public_reply_sent");
      await addTaskStep(task.taskId, "public_reply", "success", "待機時間が過ぎたため公開コメント返信を送信しました", {
        publicReply: task.publicReply,
        apiUsage: result.headers
      });
      addEvent({ status: "public_reply_sent", reason: "send_queue", commentId: task.commentId, mediaId: task.mediaId, choice: task.choice });
      return;
    }

    if (task.status === "sending_dm") {
      const result = await sendPrivateReply(task.commentId, task.privateReply);
      await markPrivateReplySent(task.taskId, result.headers);
      processedComments.add(task.commentId);
      await saveProcessedComment({
        commentId: task.commentId,
        mediaId: task.mediaId,
        choice: task.choice,
        username: task.username,
        text: task.text,
        publicReply: task.publicReply,
        privateReply: task.privateReply,
        status: "sent"
      });
      await updateCommentStatus(task.commentId, "dm_sent");
      await addTaskStep(task.taskId, "private_reply", "success", "待機時間が過ぎたためPrivate Reply DMを送信しました", {
        privateReply: task.privateReply,
        apiUsage: result.headers
      });
      addEvent({ status: "sent", reason: "send_queue", commentId: task.commentId, mediaId: task.mediaId, choice: task.choice });

      if (settings.omikujiEnabled) {
        await sendOmikujiForTask(task, { manual: false }).catch((error) => {
          console.error("omikuji send failed:", error);
        });
      } else {
        await updateAutomationTask(task.taskId, { omikujiStatus: "skipped", omikujiError: null });
      }
    }
  } catch (error) {
    await handleQueuedSendError(task, error, settings);
  }
}

async function sendOmikujiForTask(task, options = {}) {
  const taskId = task.taskId;
  if (!task.userId) {
    const message = "user_id未取得のため追加DM不可";
    await updateAutomationTask(taskId, { omikujiStatus: "error", omikujiError: message });
    await addTaskStep(taskId, "omikuji_required_user", "error", message);
    throw new Error(message);
  }

  const settings = await getSettings();
  const asset = await pickOmikujiAsset();
  const imageUrl = `${publicBaseUrlOrThrow()}/omikuji-image/${asset.id}`;
  const reading = task.mediaId ? await getMediaTarotReading(task.mediaId) : null;
  const omikujiText = formatOmikujiText(settings.omikujiTextTemplate, {
    result: asset.result,
    username: task.username,
    choice: task.choice,
    card: reading?.cards?.[task.choice] ?? "",
    theme: reading?.theme ?? ""
  });

  await updateAutomationTask(taskId, {
    omikujiResult: asset.result,
    omikujiAssetId: asset.id,
    omikujiText,
    omikujiImageUrl: imageUrl,
    omikujiStatus: "sending",
    omikujiError: null
  });
  await addTaskStep(taskId, "omikuji_selected", "success", "おみくじ画像を選びました", {
    result: asset.result,
    assetId: asset.id,
    driveFileId: asset.driveFileId,
    manual: Boolean(options.manual)
  });

  try {
    const textResult = await sendTextMessageToUser(task.userId, omikujiText);
    await addTaskStep(taskId, "omikuji_text", "success", "おみくじテキストDMを送信しました", {
      omikujiText,
      apiUsage: textResult.headers
    });

    const imageResult = await sendImageMessageToUser(task.userId, imageUrl);
    await addTaskStep(taskId, "omikuji_image", "success", "おみくじ画像DMを送信しました", {
      imageUrl,
      apiUsage: imageResult.headers
    });

    const updated = await updateAutomationTask(taskId, {
      omikujiStatus: "sent",
      omikujiError: null,
      lastApiHeaders: imageResult.headers
    });
    addEvent({
      status: "omikuji_sent",
      reason: options.manual ? "manual_omikuji" : "auto_omikuji",
      commentId: task.commentId,
      mediaId: task.mediaId,
      choice: task.choice,
      message: `${asset.result}のおみくじを送信しました`
    });
    return updated ?? getAutomationTask(taskId);
  } catch (error) {
    const message = errorMessage(error);
    if (settings.pauseOnRateLimit && isRateLimitError(error)) {
      const resumeAt = new Date(Date.now() + Number(settings.rateLimitPauseMinutes ?? 30) * 60 * 1000);
      await updateSettings({ sendPausedUntil: resumeAt.toISOString() });
    }
    await updateAutomationTask(taskId, {
      omikujiStatus: "error",
      omikujiError: message,
      lastApiHeaders: error?.metaHeaders ?? null
    });
    await addTaskStep(taskId, "omikuji_error", "error", message, {
      apiUsage: error?.metaHeaders ?? null
    });
    addEvent({
      status: "error",
      reason: "omikuji_failed",
      commentId: task.commentId,
      mediaId: task.mediaId,
      choice: task.choice,
      message
    });
    throw error;
  }
}

async function handleQueuedSendError(task, error, settings) {
  const message = errorMessage(error);
  const apiHeaders = error?.metaHeaders ?? null;
  const rateLimited = settings.pauseOnRateLimit && isRateLimitError(error);
  const phase = task.status === "sending_dm" ? "dm" : "public";
  const resumableStatus = phase === "dm" ? "public_reply_sent" : "scheduled_to_send";

  if (rateLimited) {
    const pauseMinutes = Number(settings.rateLimitPauseMinutes ?? 30);
    const resumeAt = new Date(Date.now() + pauseMinutes * 60 * 1000);
    await updateSettings({ sendPausedUntil: resumeAt.toISOString() });
    await rescheduleSendTask(task.taskId, resumableStatus, resumeAt.toISOString(), message, apiHeaders);
    await updateCommentStatus(task.commentId, "rate_limited", message);
    await addTaskStep(task.taskId, phase === "dm" ? "private_reply" : "public_reply", "error", `Metaの制限らしき応答のため${pauseMinutes}分後に延期しました: ${message}`, {
      apiUsage: apiHeaders
    });
    addEvent({ status: "error", reason: "rate_limited", commentId: task.commentId, mediaId: task.mediaId, choice: task.choice, message });
    return;
  }

  await markSendTaskError(task.taskId, message, apiHeaders);
  await updateCommentStatus(task.commentId, "send_error", message);
  await addTaskStep(task.taskId, phase === "dm" ? "private_reply" : "public_reply", "error", message, {
    apiUsage: apiHeaders
  });
  addEvent({ status: "error", reason: "send_failed", commentId: task.commentId, mediaId: task.mediaId, choice: task.choice, message });
}

async function prepareAutomationTask(task, options = {}) {
  const settings = options.settings ?? (await getSettings());
  const taskId = task.taskId;

  if (!task.choice) {
    const choiceResult = await detectChoice(task.sanitizedText ?? task.text ?? "", settings, taskId);
    task.choice = choiceResult.choice === "unknown" ? null : choiceResult.choice;
    task.choiceMethod = choiceResult.method;
    await updateAutomationTask(taskId, {
      choice: task.choice,
      choiceMethod: task.choiceMethod,
      status: task.choice ? "choice_detected" : "ignored",
      errorMessage: task.choice ? null : "番号を判定できませんでした"
    });
  }

  if (!task.choice) throw new Error("番号を判定できませんでした");

  const flow = options.flow ?? (await getFlowForMedia(task.mediaId));
  if (!isTargetAllowed(flow, settings)) throw new Error("対象リールではありません");
  if (settings.targetMode === "marker_only" && flow?.enabled === false) throw new Error("フローが停止中です");

  const media = (await getMediaPost(task.mediaId)) ?? (await getMedia(task.mediaId));
  const reading = await getOrCreateMediaReading(media, taskId, settings);
  const readingText = reading?.readings?.[task.choice];
  if (!readingText) throw new Error(`${task.choice}番の鑑定文がありません`);
  const privateReply = formatPrivateReply(settings.privateReplyTemplate, {
    theme: reading.theme,
    reading: readingText,
    username: task.username,
    choice: task.choice,
    card: reading.cards?.[task.choice]
  });

  const publicReply = task.publicReply || pickPublicReply(settings.publicReplyTemplates, task.choice);
  const preparedTask = await updateAutomationTask(taskId, {
    status: "ready_to_send",
    publicReply,
    privateReply,
    errorMessage: null
  });
  await addTaskStep(taskId, "reply_prepared", "success", "公開返信とDM本文を準備しました", {
    publicReply,
    privateReply
  });

  return {
    settings,
    flow,
    task: preparedTask ?? {
      ...task,
      status: "ready_to_send",
      publicReply,
      privateReply
    },
    publicReply,
    privateReply
  };
}

async function detectChoice(text, settings, taskId = null) {
  const ruleChoice = parseChoice(text);
  if (ruleChoice) {
    await addTaskStep(taskId, "choice_detection", "success", "ルールで番号を判定しました", {
      choice: ruleChoice,
      method: "rule"
    });
    return { choice: ruleChoice, method: "rule" };
  }

  if (!settings.aiChoiceEnabled) {
    await addTaskStep(taskId, "choice_detection", "skipped", "番号を判定できませんでした");
    return { choice: "unknown", method: "unknown" };
  }

  const choice = await detectChoiceWithAi(text);
  await addTaskStep(taskId, "choice_detection", choice === "unknown" ? "skipped" : "success", "DeepSeekで番号を判定しました", {
    choice,
    method: choice === "unknown" ? "unknown" : "deepseek"
  });
  return { choice, method: choice === "unknown" ? "unknown" : "deepseek" };
}

async function detectChoiceWithAi(text) {
  const result = await deepseekJson([
    {
      role: "system",
      content:
        "あなたはInstagramコメントの番号判定AIです。必ずjsonだけを返してください。出力は {\"choice\":\"1\"}, {\"choice\":\"2\"}, {\"choice\":\"3\"}, {\"choice\":\"unknown\"} のどれかだけです。"
    },
    {
      role: "user",
      content: `comment_text = ${JSON.stringify(text)}

タスク: comment_text の内容から、ユーザーが選んだ番号を判定してください。

判定ルール:
- 1: 1, １, ①, ❶, Ⅰ, 一, いち, 1番, 1です, 1で, 1お願いします, １番で, No.1
- 2: 2, ２, ②, ❷, Ⅱ, 二, に, 2番, 2です, 2で, 2お願いします, ２番で, No.2
- 3: 3, ３, ③, ❸, Ⅲ, 三, さん, 3番, 3です, 3で, 3お願いします, ３番で, No.3
- 複数候補、否定、日付/時間、意味不明は unknown

jsonのみで返してください。`
    }
  ], { maxTokens: 80 });

  return ["1", "2", "3"].includes(result.choice) ? result.choice : "unknown";
}

async function getOrCreateMediaReading(media, taskId = null, settings = null) {
  const theme = extractTheme(media?.caption ?? "");
  if (!theme) {
    await addTaskStep(taskId, "reading_theme", "error", "テーマ未設定のため鑑定文を生成できません");
    throw new Error("テーマ未設定のため鑑定文を生成できません");
  }

  const hash = hashText(theme);
  const existing = media?.id || media?.mediaId ? await getMediaTarotReading(media.id ?? media.mediaId) : null;

  if (existing && existing.captionHash === hash && existing.readings?.["1"] && existing.readings?.["2"] && existing.readings?.["3"]) {
    await addTaskStep(taskId, "reading_ready", "success", "保存済み鑑定文を使用します", {
      mediaId: existing.mediaId
    });
    return existing;
  }

  if (settings && settings.aiReadingEnabled === false) {
    await addTaskStep(taskId, "reading_ready", "skipped", "AI鑑定文生成がOFFです");
    throw new Error("AI鑑定文生成がOFFです");
  }

  const reading = await generateAndSaveReading(media, taskId);
  await addTaskStep(taskId, "reading_ready", "success", "DeepSeekで鑑定文を生成しました", {
    mediaId: reading.mediaId,
    cards: reading.cards
  });
  return reading;
}

async function generateAndSaveReading(media, taskId = null) {
  const mediaId = media?.mediaId ?? media?.id;
  if (!mediaId) throw new Error("mediaId is required for reading generation");

  const theme = extractTheme(media?.caption ?? "");
  if (!theme) {
    await addTaskStep(taskId, "reading_theme", "error", "テーマ未設定のため鑑定文を生成できません");
    throw new Error("テーマ未設定のため鑑定文を生成できません");
  }

  const cards = pickTarotCards(3);
  const readings = {};
  const cardMap = {
    "1": cards[0],
    "2": cards[1],
    "3": cards[2]
  };

  for (const choice of ["1", "2", "3"]) {
    await addTaskStep(taskId, `reading_generate_${choice}`, "started", `${choice}番の鑑定文を生成します`, {
      choice,
      card: cardMap[choice]
    });

    try {
      readings[choice] = neutralizeGenderedReading(await generateSingleReadingWithAi({
        theme,
        choice,
        card: cardMap[choice]
      }));
      await addTaskStep(taskId, `reading_generate_${choice}`, "success", `${choice}番の鑑定文を生成しました`, {
        choice,
        card: cardMap[choice]
      });
    } catch (error) {
      await addTaskStep(taskId, `reading_generate_${choice}`, "error", `${choice}番の鑑定文生成に失敗しました: ${errorMessage(error)}`, {
        choice,
        card: cardMap[choice]
      });
      throw error;
    }
  }

  const rawText = ["1", "2", "3"].map((choice) => readings[choice]).join("\n\n");
  const reading = await saveMediaTarotReading({
    mediaId,
    theme,
    captionHash: hashText(theme),
    cards: cardMap,
    readings,
    rawText
  });

  await addTaskStep(taskId, "reading_generated", "success", "鑑定文を生成して保存しました", {
    mediaId,
    theme,
    cards
  });
  return reading ?? {
    mediaId,
    theme,
    captionHash: hashText(theme),
    cards: cardMap,
    readings,
    rawText
  };
}

async function generateSingleReadingWithAi({ theme, choice, card }) {
  const mark = choiceMark(choice);
  return deepseekText([
    {
      role: "system",
      content:
        "あなたは「紫炎（しえん）｜御魂導師」専属のタロット鑑定ライターです。Instagramリール専用の、静かでエモーショナルな三択タロット鑑定文を作成してください。相手の性別は不明なので、彼、彼女、男性、女性など性別を断定する語は禁止し、相手は必ず「あの人」または「お相手」と表現してください。JSON、コードブロック、箇条書き、CTAは禁止。プレーンテキストのみで出力してください。"
    },
    {
      role: "user",
      content: `【入力（テーマ）】
theme: "${theme}"

【選択番号】
${mark}

【カード】
${card}

【出力形式】
以下の形式だけをそのまま出力してください。

🔮${mark}を選んだあなたへ
－${card}－
本文（8〜12行・改行あり）

【紫炎トーン】
霊視、神託口調。視えました／感じました／流れが来ています。
静か、夜、余白、気配、鼓動、光、風など情景描写中心。
説明しない。理由・解説・分析は禁止。
感情を直接言語化しすぎず、匂わせる。
詩的で、映画のワンシーンのように描く。
読後に余韻が残る文章。

【性別表現】
相手の性別は不明です。
彼、彼女、男性、女性、男、女、旦那、奥さん、夫、妻など、性別や関係性を断定する言葉は禁止。
相手を指す言葉は「あの人」「お相手」「その人」に統一してください。

【禁止事項】
CTA、占い解説、アドバイス口調、箇条書き、説明文、JSON、構造化出力、性別断定。

本文は約250〜350文字。${mark}と🔮は必ず入れてください。`
    }
  ], { maxTokens: 700 });
}

async function deepseekJson(messages, options = {}) {
  const text = await deepseekText(messages, {
    ...options,
    responseFormat: { type: "json_object" }
  });
  return JSON.parse(text);
}

async function deepseekText(messages, options = {}) {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is not set");

  const response = await fetch(`${DEEPSEEK_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      max_tokens: options.maxTokens ?? 600,
      temperature: options.temperature ?? 0.2,
      response_format: options.responseFormat,
      thinking: { type: "disabled" }
    })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json?.error?.message ?? `DeepSeek API error: ${response.status}`;
    throw new Error(message);
  }

  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned empty content");
  return content.trim();
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

async function graphRequestWithMeta(path, options = {}) {
  const url = new URL(`${GRAPH_BASE_URL}/${GRAPH_API_VERSION}/${path.replace(/^\//, "")}`);
  url.searchParams.set("access_token", ACCESS_TOKEN);

  if (options.fields) {
    url.searchParams.set("fields", options.fields);
  }

  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  return fetchJsonWithMeta(url, {
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
    const error = new Error(detail);
    error.metaJson = json;
    error.metaHeaders = pickMetaHeaders(response.headers);
    throw error;
  }

  return json;
}

async function fetchJsonWithMeta(url, options = {}) {
  const response = await fetch(url, options);
  const json = await response.json().catch(() => ({}));
  const headers = pickMetaHeaders(response.headers);
  if (!response.ok) {
    const message = json?.error?.message ?? `Meta API error: ${response.status}`;
    const detail = Object.keys(json).length ? `${message} ${JSON.stringify(json)}` : message;
    const error = new Error(detail);
    error.metaJson = json;
    error.metaHeaders = headers;
    throw error;
  }

  return { json, headers };
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
  return graphRequestWithMeta(`/${commentId}/replies`, {
    method: "POST",
    body: { message }
  });
}

async function sendPrivateReply(commentId, message) {
  return graphRequestWithMeta(`/${IG_USER_ID}/messages`, {
    method: "POST",
    body: {
      recipient: { comment_id: commentId },
      message: { text: message }
    }
  });
}

async function sendTextMessageToUser(userId, message) {
  return graphRequestWithMeta(`/${IG_USER_ID}/messages`, {
    method: "POST",
    body: {
      recipient: { id: userId },
      message: { text: message }
    }
  });
}

async function sendImageMessageToUser(userId, imageUrl) {
  return graphRequestWithMeta(`/${IG_USER_ID}/messages`, {
    method: "POST",
    body: {
      recipient: { id: userId },
      message: {
        attachment: {
          type: "image",
          payload: {
            url: imageUrl
          }
        }
      }
    }
  });
}

async function syncOmikujiFolders() {
  if (!GOOGLE_DRIVE_API_KEY) throw new Error("GOOGLE_DRIVE_API_KEY is not set");

  const folders = omikujiFolders();
  const synced = [];
  const configuredFolders = folders.filter((folder) => folder.folderId);
  if (configuredFolders.length === 0) {
    throw new Error("おみくじフォルダーが1つも設定されていません");
  }

  for (const folder of configuredFolders) {
    const files = await listDriveImages(folder.folderId);
    for (const file of files) {
      const asset = await upsertOmikujiAsset({
        result: folder.result,
        driveFileId: file.id,
        name: file.name,
        mimeType: file.mimeType,
        enabled: true
      });
      synced.push(asset);
    }
    addEvent({
      status: "sync",
      reason: "omikuji_drive",
      message: `${folder.result}: ${files.length}件のおみくじ画像を同期しました`
    });
  }

  const assets = (await getOmikujiAssets()) ?? [];
  return {
    count: synced.length,
    counts: countOmikujiAssets(assets),
    assets
  };
}

async function listDriveImages(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("key", GOOGLE_DRIVE_API_KEY);
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,size)");
  url.searchParams.set("q", `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`);

  const json = await fetchJson(url);
  return json.files ?? [];
}

async function fetchDriveImage(fileId) {
  if (!GOOGLE_DRIVE_API_KEY) throw new Error("GOOGLE_DRIVE_API_KEY is not set");
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  url.searchParams.set("key", GOOGLE_DRIVE_API_KEY);
  url.searchParams.set("alt", "media");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Drive image fetch failed: ${response.status}`);
  }
  return {
    response,
    contentType: response.headers.get("content-type")
  };
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

function expiresAt(expiresIn) {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds)) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function cleanToken(value) {
  return String(value ?? "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, "");
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&rarr;/g, "→")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/^\s*\d+\.\s*[^:]{0,80}:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTheme(caption) {
  return sanitizeText(caption)
    .replace(/\[auto:[^\]]+\]/gi, " ")
    .replace(/#[^\s#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizeTemplates(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split("\n");
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function pickPublicReply(templates = [], choice = "") {
  const normalized = normalizeTemplates(templates);
  const fallback = "{choice}を選びましたね。鑑定結果をDMに送りました。";
  const template = normalized[Math.floor(Math.random() * normalized.length)] ?? fallback;
  return template.replaceAll("{choice}", choice);
}

function formatPrivateReply(template, values = {}) {
  const username = String(values.username ?? "").replace(/^@/, "").trim();
  const displayName = username || "あなた";
  const replacements = {
    theme: values.theme ?? "",
    reading: values.reading ?? "",
    username: username || "あなた",
    displayName,
    honorific: username ? "さん" : "",
    choice: values.choice ?? "",
    card: values.card ?? ""
  };
  const source = String(template || "{reading}");
  return Object.entries(replacements).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    source
  ).trim();
}

function formatOmikujiText(template, values = {}) {
  const username = String(values.username ?? "").replace(/^@/, "").trim();
  const displayName = username || "あなた";
  const replacements = {
    theme: values.theme ?? "",
    result: values.result ?? "",
    username: username || "あなた",
    displayName,
    honorific: username ? "さん" : "",
    choice: values.choice ?? "",
    card: values.card ?? ""
  };
  const source = String(template || "{result}");
  return Object.entries(replacements).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    source
  ).trim();
}

async function pickOmikujiAsset() {
  const assets = await getOmikujiAssets();
  const counts = countOmikujiAssets(assets);
  const availableResults = OMIKUJI_RESULTS.filter((result) => counts[result] > 0);
  if (availableResults.length === 0) throw new Error("有効なおみくじ画像がありません。Drive同期を確認してください");
  const result = availableResults[Math.floor(Math.random() * availableResults.length)];
  const asset = await getRandomOmikujiAssetByResult(result);
  if (!asset) throw new Error(`${result}のおみくじ画像がありません。Drive同期を確認してください`);
  return asset;
}

function omikujiFolders() {
  return [
    { result: "凶", folderId: parseDriveFolderId(OMIKUJI_FOLDER_KYOU) },
    { result: "末吉", folderId: parseDriveFolderId(OMIKUJI_FOLDER_SUEKICHI) },
    { result: "小吉", folderId: parseDriveFolderId(OMIKUJI_FOLDER_SHOKICHI) },
    { result: "中吉", folderId: parseDriveFolderId(OMIKUJI_FOLDER_CHUKICHI) },
    { result: "吉", folderId: parseDriveFolderId(OMIKUJI_FOLDER_KICHI) },
    { result: "大吉", folderId: parseDriveFolderId(OMIKUJI_FOLDER_DAIKICHI) }
  ];
}

function omikujiFolderStatus() {
  return Object.fromEntries(omikujiFolders().map((folder) => [folder.result, Boolean(folder.folderId)]));
}

function countOmikujiAssets(assets = []) {
  const counts = Object.fromEntries(OMIKUJI_RESULTS.map((result) => [result, 0]));
  for (const asset of assets) {
    if (asset.enabled !== false && Object.hasOwn(counts, asset.result)) counts[asset.result] += 1;
  }
  return counts;
}

function parseDriveFolderId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const folderMatch = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch) return folderMatch[1];
  const idParam = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParam) return idParam[1];
  return raw;
}

function publicBaseUrl() {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/$/, "");
  if (RAILWAY_PUBLIC_DOMAIN) return `https://${RAILWAY_PUBLIC_DOMAIN}`.replace(/\/$/, "");
  return null;
}

function publicBaseUrlOrThrow() {
  const baseUrl = publicBaseUrl();
  if (!baseUrl) throw new Error("PUBLIC_BASE_URL または RAILWAY_PUBLIC_DOMAIN が必要です");
  return baseUrl;
}

function neutralizeGenderedReading(text) {
  return String(text ?? "")
    .replaceAll("彼女", "あの人")
    .replaceAll("彼", "あの人")
    .replaceAll("男性", "あの人")
    .replaceAll("女性", "あの人")
    .replaceAll("旦那さん", "お相手")
    .replaceAll("旦那", "お相手")
    .replaceAll("奥さん", "お相手")
    .replaceAll("夫", "お相手")
    .replaceAll("妻", "お相手");
}

function randomInt(minValue, maxValue) {
  const min = Math.max(0, Number(minValue ?? 0));
  const max = Math.max(min, Number(maxValue ?? min));
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function pickMetaHeaders(headers) {
  const picked = {};
  for (const key of [
    "x-app-usage",
    "x-business-use-case-usage",
    "x-page-usage",
    "x-fb-trace-id"
  ]) {
    const value = headers.get(key);
    if (value) picked[key] = value;
  }
  return picked;
}

function isRateLimitError(error) {
  const code = Number(error?.metaJson?.error?.code);
  const subcode = Number(error?.metaJson?.error?.error_subcode);
  const message = errorMessage(error).toLowerCase();
  return (
    [4, 17, 32, 613, 80002, 80006].includes(code) ||
    [2207004, 2207006].includes(subcode) ||
    message.includes("rate limit") ||
    message.includes("too many calls") ||
    message.includes("temporarily blocked")
  );
}

function isTerminalOrQueuedStatus(status) {
  return [
    "scheduled_to_send",
    "public_reply_sent",
    "sending_public",
    "sending_dm",
    "sent"
  ].includes(status);
}

function isTargetAllowed(flow, settings = {}) {
  return settings.targetMode === "all_posts" || Boolean(flow);
}

function choiceMark(choice) {
  return {
    "1": "①",
    "2": "②",
    "3": "③"
  }[choice] ?? choice;
}

function normalizeComment(comment) {
  const text = comment?.text ?? "";
  return {
    commentId: comment?.id,
    mediaId: comment?.media?.id,
    username: comment?.from?.username ?? comment?.username ?? "",
    userId: comment?.from?.id ?? "",
    text,
    choice: parseChoice(sanitizeText(text)),
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
      startSendQueueWorker();
    });
  })
  .catch((error) => {
    console.error("unexpected startup error:", error);
    app.listen(Number(PORT), () => {
      console.log(`listening on port ${PORT}`);
      console.log("Postgres disabled; using memory only");
    });
  });

function startSendQueueWorker() {
  if (!hasDatabase()) return;
  setTimeout(() => processSendQueue(), 5000);
  setInterval(() => processSendQueue(), 15000);
}
