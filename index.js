import { ChannelType, Client, GatewayIntentBits, REST, Routes } from "discord.js";
import fs from "fs/promises";
import fetch from "node-fetch";
import { startKeepAlive } from "./keepAlive.js";
import { slashCommands } from "./slash-commands.js";

// =======================
// CONFIG
// =======================
const PH_TZ = "Asia/Manila";
const DATA_FILE = "./timesheet.json";
const TOPUP_FILE = "./topup.json";
const TIME_TRACKER_CHANNEL_NAME = "time-tracker";
const TIME_TRACKER_CHANNEL_ID_FALLBACK = "1460301758940188733";
const FREECASH_REPORTS_FORUM_NAME = "freecash-reports";
const FREECASH_REPORTS_FORUM_ID_FALLBACK = "1478653159529381980";
const REPORT_INACTIVITY_THRESHOLD_MINUTES = 20;
const REPORT_INACTIVITY_CHECK_INTERVAL_MS = 60_000;
const REPORT_REMINDER_REPEAT_INTERVAL_MS = 5 * 60_000;
const MANAGER_IDS = ["769554444534153238", "854713123851337758","921936530778517614"];
const LEADER_IDS = ["769554444534153238", "854713123851337758","921936530778517614","1452657680090136664","726049317256691734","385856951114006528","1401902812299919520"];
const GIT_TOKEN = process.env.GIT_TOKEN;
const GIT_USER = process.env.GIT_USER;
const GIT_REPO = process.env.GIT_REPO;
const GIT_BRANCH = process.env.GIT_BRANCH || "main";
// =======================
// DISCORD CLIENT
// =======================



const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Prevent crashes from unhandled Discord errors
client.on("error", (err) => {
  console.error("Discord client error:", err);
});

client.on("shardError", (err, shardId) => {
  console.error(`Discord shard ${shardId} websocket error:`, err);
});

client.on("shardDisconnect", (event, shardId) => {
  console.warn(
    `Discord shard ${shardId} disconnected (code=${event.code}, reason=${event.reason || "unknown"}).`
  );
});

client.on("shardReconnecting", (shardId) => {
  console.log(`Discord shard ${shardId} reconnecting...`);
});

client.on("shardResume", (shardId, replayedEvents) => {
  console.log(`Discord shard ${shardId} resumed (replayed ${replayedEvents} events).`);
});

const slashCommandRest = new REST({ version: "10" });
let slashCommandsSynced = false;

async function syncSlashCommandsForGuild(guildId) {
  try {
    if (!process.env.DISCORD_TOKEN) {
      console.warn("⚠ Skipping slash command sync: DISCORD_TOKEN is missing.");
      return;
    }

    if (!client.user?.id) {
      console.warn("⚠ Skipping slash command sync: bot user is not available yet.");
      return;
    }

    slashCommandRest.setToken(process.env.DISCORD_TOKEN);

    await slashCommandRest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: slashCommands }
    );

    console.log(`✅ Synced ${slashCommands.length} slash commands for guild ${guildId}`);
  } catch (err) {
    console.error(`❌ Failed to sync slash commands for guild ${guildId}:`, err);
  }
}

client.on("ready", async () => {
  if (slashCommandsSynced) return;
  slashCommandsSynced = true;

  const guildIds = [...client.guilds.cache.keys()];
  if (!guildIds.length) {
    console.warn("⚠ Bot is not in any guild yet, skipping initial slash command sync.");
    return;
  }

  for (const guildId of guildIds) {
    await syncSlashCommandsForGuild(guildId);
  }
});

client.on("guildCreate", async (guild) => {
  await syncSlashCommandsForGuild(guild.id);
});

const PUBLIC_COMMANDS = new Set([
  "clockin",
  "clockout",
  "forceclockout",
  "topup",
]);

let timesheet = {};
let topupData = { channels: {} };
let gitCommitTimer = null;
let topupGitCommitTimer = null;
let reportInactivitySweepRunning = false;
const reportReminderState = new Map();

function mergeUserData(oldKey, newUserId) {
  const oldData = timesheet[oldKey];
  if (!oldData) return;

  // If target doesn't exist, create it
  if (!timesheet[newUserId]) {
    timesheet[newUserId] = {
      userId: newUserId,
      name: oldData.name || oldKey,
      lastKnownNames: oldData.lastKnownNames || [oldData.name || oldKey],
      logs: [],
      active: oldData.active || null,
    };
  }

  const target = timesheet[newUserId];

  // Merge logs, avoid duplicates
  const allLogs = [...(target.logs || []), ...(oldData.logs || [])];
  const seen = new Set();
  const mergedLogs = [];
  for (const log of allLogs) {
    const key = `${log.start}|${log.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      mergedLogs.push(log);
    }
  }
  target.logs = mergedLogs;

  // Merge lastKnownNames
  target.lastKnownNames = Array.from(new Set([
    ...(target.lastKnownNames || []),
    ...(oldData.lastKnownNames || []),
    oldData.name || oldKey
  ]));

  // Preserve active if target has none
  if (!target.active && oldData.active) target.active = oldData.active;

  // Preserve name if missing
  if (!target.name && oldData.name) target.name = oldData.name;

  // Verify logs copied successfully
  if ((oldData.logs?.length || 0) <= (target.logs?.length || 0)) {
    delete timesheet[oldKey];
    console.log(`✅ Merged ${oldKey} → ${newUserId}`);
  }
}

/**
 * Iterate over all keys and migrate old username keys
 */
function autoMergeOldUsers() {
  const keys = Object.keys(timesheet);
  for (const key of keys) {
    const data = timesheet[key];
    // Skip proper userId entries
    if (data.userId && data.userId === key) continue;

    // If old key has logs + name
    if (data.name && data.logs) {
      // Try to find existing userId entry with same name
      const targetKey = Object.keys(timesheet).find(
        k => k !== key && timesheet[k].userId && timesheet[k].name === data.name
      );

      if (targetKey) {
        mergeUserData(key, targetKey);
      } else if (data.userId) {
        mergeUserData(key, data.userId);
      }
    }
  }
}

function formatElapsedLive(startISO) {
  const ms = Date.now() - new Date(startISO).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${h}h ${m}m ${s}s`;
}


function formatSession(startISO, endISO) {
  const dateOpts = {
    timeZone: PH_TZ,
    month: "long",
    day: "numeric",
  };

  const timeOpts = {
    timeZone: PH_TZ,
    hour: "numeric",
    minute: "2-digit",
  };

  const s = new Date(startISO);
  const e = new Date(endISO);

  const sameDay =
    s.toLocaleDateString("en-PH", dateOpts) ===
    e.toLocaleDateString("en-PH", dateOpts);

  const datePart = sameDay
    ? s.toLocaleDateString("en-PH", dateOpts)
    : `${s.toLocaleDateString("en-PH", dateOpts)} – ${e.toLocaleDateString("en-PH", dateOpts)}`;

  const timePart =
    `${s.toLocaleTimeString("en-PH", timeOpts)} - ${e.toLocaleTimeString("en-PH", timeOpts)}`;

  return `${datePart}, ${timePart}`;
}


async function loadFromDisk() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    timesheet = JSON.parse(raw);
  } catch {
    timesheet = {};
  }
}

function ensureTopupShape(input) {
  if (!input || typeof input !== "object") return { channels: {} };
  if (!input.channels || typeof input.channels !== "object") input.channels = {};
  return input;
}

async function loadTopupFromDisk() {
  try {
    const raw = await fs.readFile(TOPUP_FILE, "utf8");
    topupData = ensureTopupShape(JSON.parse(raw));
  } catch {
    topupData = { channels: {} };
  }
}

function queueTopupCommit() {
  if (topupGitCommitTimer) return;

  topupGitCommitTimer = setTimeout(async () => {
    topupGitCommitTimer = null;
    await commitTopupToGitHub();
  }, 3000);
}

async function persistTopup() {
  topupData = ensureTopupShape(topupData);
  await fs.writeFile(TOPUP_FILE, JSON.stringify(topupData, null, 2));
  queueTopupCommit();
}

function extractTopupAmounts(content) {
  if (!content || typeof content !== "string") return [];

  const candidates = content
    .split("|")
    .map(part => part.trim())
    .filter(Boolean);

  const amounts = [];

  for (const candidate of candidates) {
    const normalized = candidate.replace(/,/g, "").trim();

    // Supported formats:
    // - 20$
    // - $20
    // - 20 $
    // - USD 20
    // - 20 USD
    const patterns = [
      /^(\d+(?:\.\d{1,2})?)\s*\$$/i,
      /^\$\s*(\d+(?:\.\d{1,2})?)$/i,
      /^usd\s*(\d+(?:\.\d{1,2})?)$/i,
      /^(\d+(?:\.\d{1,2})?)\s*usd$/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;

      const value = Number(match[1]);
      if (Number.isFinite(value)) {
        amounts.push(value);
      }
      break;
    }
  }

  return amounts;
}

function normalizeKey(value, fallback) {
  return (value || fallback).toLowerCase().trim();
}

function getTopupContext(channel, fallback = {}) {
  const fallbackChannelName = fallback.channelName || "unknown-channel";
  const fallbackThreadName = fallback.threadName || fallbackChannelName || "unknown-thread";
  const isThread = !!channel && typeof channel.isThread === "function" && channel.isThread();
  const channelName = isThread
    ? (channel.parent?.name || fallbackChannelName)
    : (channel?.name || fallbackChannelName);
  const threadName = channel?.name || fallbackThreadName;

  const fallbackChannelId = fallback.channelId || `name:${normalizeKey(channelName, "unknown-channel")}`;
  const resolvedChannelId = isThread
    ? (channel.parentId || fallbackChannelId)
    : (channel?.id || fallbackChannelId);
  const shouldForceTimeTrackerFallbackId =
    normalizeKey(channelName, "") !== TIME_TRACKER_CHANNEL_NAME;
  const channelId = shouldForceTimeTrackerFallbackId
    ? TIME_TRACKER_CHANNEL_ID_FALLBACK
    : resolvedChannelId;
  const fallbackThreadId = fallback.threadId || fallbackChannelId;

  return {
    channelId,
    channelName,
    threadId: channel?.id || fallbackThreadId,
    threadName,
    isThread,
  };
}

function getOrCreateTopupThreadBucket(channel, fallback = {}) {
  const ctx = getTopupContext(channel, fallback);

  topupData = ensureTopupShape(topupData);
  const channels = topupData.channels;

  if (!channels[ctx.channelId]) {
    channels[ctx.channelId] = {
      channelId: ctx.channelId,
      channelName: ctx.channelName,
      threads: {},
    };
  }

  const channelBucket = channels[ctx.channelId];
  channelBucket.channelName = ctx.channelName;
  channelBucket.threads ??= {};

  if (!channelBucket.threads[ctx.threadId]) {
    channelBucket.threads[ctx.threadId] = {
      threadId: ctx.threadId,
      threadName: ctx.threadName,
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
      entries: [],
    };
  }

  return { bucket: channelBucket.threads[ctx.threadId], ctx };
}

async function safeEdit(interaction, payload) {
  try {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(payload);
    } else {
      await interaction.editReply(payload);
    }
    return { ok: true };
  } catch (err) {
    // Interaction tokens can expire while a live updater is still running.
    if (err.code === 10062 || err.code === 50027) {
      return { ok: false, code: err.code };
    }
    console.error("Interaction update failed:", err);
    return { ok: false, code: err.code ?? "UNKNOWN" };
  }
}

async function readFileFromGitHub(path) {
  const api = `https://api.github.com/repos/${GIT_USER}/${GIT_REPO}/contents/${path}`;

  const res = await fetch(api, {
    headers: {
      Authorization: `token ${GIT_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to read ${path} from GitHub`);
  }

  const data = await res.json();
  const decoded = Buffer.from(data.content, "base64").toString("utf8");
  return JSON.parse(decoded);
}



function isFallbackTimeTrackerId(channelId) {
  return String(channelId || "") === TIME_TRACKER_CHANNEL_ID_FALLBACK;
}

function isTimeTrackerChannel(channel) {
  if (!channel) return false;

  if (typeof channel.isThread === "function" && channel.isThread()) {
    return (
      channel.parent?.name === TIME_TRACKER_CHANNEL_NAME ||
      isFallbackTimeTrackerId(channel.parentId)
    );
  }

  return (
    channel.name === TIME_TRACKER_CHANNEL_NAME ||
    isFallbackTimeTrackerId(channel.id)
  );
}

function isTimeTrackerInteractionContext(interaction, resolvedChannel) {
  if (isTimeTrackerChannel(resolvedChannel)) return true;
  if (isFallbackTimeTrackerId(interaction?.channelId)) return true;
  if (isFallbackTimeTrackerId(interaction?.channel?.parentId)) return true;
  if (isFallbackTimeTrackerId(resolvedChannel?.parentId)) return true;
  return false;
}

async function findTimeTrackerChannel() {
  const fromCache = client.channels.cache.find(
    (ch) => isTimeTrackerChannel(ch) && typeof ch.send === "function"
  );
  if (fromCache) return fromCache;

  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) continue;

    const match = channels.find(
      (ch) => isTimeTrackerChannel(ch) && typeof ch.send === "function"
    );

    if (match) return match;
  }

  return null;
}

async function safeGetMember(interaction, userId) {
  if (!interaction.inGuild()) return null;
  if (!interaction.guild) return null;

  return (
    interaction.guild.members.cache.get(userId) ||
    await interaction.guild.members.fetch(userId).catch(() => null)
  );
}

async function resolveInteractionChannel(interaction) {
  if (interaction.channel) return interaction.channel;

  // 1) Global fetch can resolve threads that may not be in guild channel cache.
  const fromClient = await client.channels.fetch(interaction.channelId).catch(() => null);
  if (fromClient) return fromClient;

  if (!interaction.inGuild() || !interaction.guild) return null;

  // 2) Guild channel fetch fallback.
  const fromGuild = await interaction.guild.channels.fetch(interaction.channelId).catch(() => null);
  if (fromGuild) return fromGuild;

  // 3) Active thread lookup fallback.
  try {
    const active = await interaction.guild.channels.fetchActiveThreads();
    const fromActive = active.threads?.get(interaction.channelId);
    if (fromActive) return fromActive;
  } catch {
    // ignore
  }

  return null;
}

async function commitFileToGitHub({
  path,
  content,
  message,
}) {
  const api = `https://api.github.com/repos/${GIT_USER}/${GIT_REPO}/contents/${path}`;
  const headers = {
    Authorization: `token ${GIT_TOKEN}`,
    Accept: "application/vnd.github+json",
  };

  // Get existing file SHA (if exists)
  let sha = null;
  const existing = await fetch(api, { headers });
  if (existing.ok) {
    const data = await existing.json();
    sha = data.sha;
  }

  const res = await fetch(api, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString("base64"),
      sha,
      branch: process.env.GIT_BRANCH || "main",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub commit failed: ${err}`);
  }
}

// =======================
// STRICT USER RESOLUTION (ID-FIRST)
// =======================
function resolveStrictUser(interaction) {
  const user = interaction.user;
  const member = interaction.member;

  if (!user?.id) return null;

  const name =
    member?.displayName ||
    user.globalName ||
    user.username ||
    null;

  if (!name) return null;

  return {
    userId: user.id,
    name,
  };
}

function ensureUserRecord(userId, name) {
  if (!userId || !name) return null;

  if (!timesheet[userId]) {
    // create new record if doesn't exist
    timesheet[userId] = {
      userId,
      name,
      lastKnownNames: [name],
      logs: [],
      active: null,
    };
    return timesheet[userId];
  }

  const record = timesheet[userId];

  // Update username if changed
  if (record.name !== name) {
    if (!record.lastKnownNames.includes(record.name)) {
      record.lastKnownNames.push(record.name);
    }
    record.name = name;
  }

  // Ensure logs array and active are valid
  if (!Array.isArray(record.logs)) record.logs = [];
  if (record.active === undefined) record.active = null;

  return record;
}

/**
 * Append new logs safely
 * Only adds logs that are not duplicates (by start+end)
 */
function appendLogs(userId, newLogs) {
  const record = timesheet[userId];
  if (!record) return;

  for (const log of newLogs) {
    const exists = record.logs.some(
      (l) => l.start === log.start && l.end === log.end
    );
    if (!exists) {
      record.logs.push(log);
    }
  }
}



/**
 * Parse HH:MM string into a Date in PH timezone on a given date.
 * If dateStr is provided (MM/DD/YYYY), use that day; otherwise today.
 */
function parsePHTime(timeStr, dateStr) {
  if (!timeStr) return null;

  let dateObj = new Date();
  if (dateStr) {
    const [m, d, y] = dateStr.split("/").map(Number);
    if (!m || !d || !y) return null;
    dateObj = new Date(y, m - 1, d);
  }

  const [h, min] = timeStr.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;

  // PH = UTC+8 → adjust UTC so stored date is correct
  const utcDate = new Date(Date.UTC(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate(),
    h - 8, // offset PH → UTC
    min,
    0,
    0
  ));

  return utcDate;
}

/**
 * Parse end time allowing 24:00+ style inputs.
 * Example: 25:30 means next day 1:30.
 */
function parseExtendedEndPHTime(timeStr, dateStr) {
  if (!timeStr || !dateStr) return null;

  const [m, d, y] = dateStr.split("/").map(Number);
  if (!m || !d || !y) return null;

  const match = timeStr.match(/^(\d{1,2}):([0-5]\d)$/);
  if (!match) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

  const dayOffset = Math.floor(hour / 24);
  const normalizedHour = hour % 24;

  const utcDate = new Date(Date.UTC(
    y,
    m - 1,
    d + dayOffset,
    normalizedHour - 8,
    minute,
    0,
    0
  ));

  return utcDate;
}
/**
 * Format a UTC ISO string for display in PH timezone
 */
function formatPH(isoStr) {
  return new Date(isoStr).toLocaleString("en-PH", {
    timeZone: PH_TZ,
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Format session start/end
 */
function formatSessionPH(startISO, endISO) {
  const s = new Date(startISO);
  const e = new Date(endISO);

  const dateOpts = { timeZone: PH_TZ, month: "long", day: "numeric", year: "numeric" };
  const timeOpts = { timeZone: PH_TZ, hour: "numeric", minute: "2-digit" };

  const sameDay = s.toLocaleDateString("en-PH", dateOpts) === e.toLocaleDateString("en-PH", dateOpts);
  const datePart = sameDay
    ? s.toLocaleDateString("en-PH", dateOpts)
    : `${s.toLocaleDateString("en-PH", dateOpts)} – ${e.toLocaleDateString("en-PH", dateOpts)}`;

  const timePart = `${s.toLocaleTimeString("en-PH", timeOpts)} - ${e.toLocaleTimeString("en-PH", timeOpts)}`;

  return `${datePart}, ${timePart}`;
}


function parseDatePH(str, end = false) {
  if (!str) return null;

  str = str.replace(/,/g, "").trim();
  const parts = str.split("/");
  if (parts.length !== 3) return null;

  const m = Number(parts[0]);
  const d = Number(parts[1]);
  const y = Number(parts[2]);

  if (!Number.isInteger(m) || !Number.isInteger(d) || !Number.isInteger(y)) {
    return null;
  }

  // Create PH midnight explicitly, then convert to UTC
  const phDate = new Date(
    Date.UTC(y, m - 1, d, end ? 15 : -8, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0)
  );

  return phDate;
}


// Track live status updates per user
const liveStatusTimers = new Map();
// Serialize timesheet load/mutate/persist operations to prevent race conditions
// between interaction handlers and the background auto clock-out sweep.
let timesheetWriteQueue = Promise.resolve();
let topupWriteQueue = Promise.resolve();

function withTimesheetWriteLock(task) {
  const run = timesheetWriteQueue.then(task, task);
  timesheetWriteQueue = run.catch(() => {});
  return run;
}

function withTopupWriteLock(task) {
  const run = topupWriteQueue.then(task, task);
  topupWriteQueue = run.catch(() => {});
  return run;
}

/**
 * Merge old username keys into proper userId entries before saving
 */

function mergeBeforePersist() {
  const keys = Object.keys(timesheet);

  for (const key of keys) {
    const data = timesheet[key];
    if (!data || typeof data !== "object") continue;

    // Skip already-correct userId records
    if (data.userId && key === data.userId) continue;

    if (!Array.isArray(data.logs) || !data.name) continue;

    // Find correct target by userId first
    let target = null;

    if (data.userId && timesheet[data.userId]) {
      target = timesheet[data.userId];
    } else {
      // Fallback: find by name with userId
      target = Object.values(timesheet).find(
        u => u.userId && u.name === data.name
      );
    }

    if (!target) continue;

    // --- ENSURE STRUCTURE ---
    target.logs ??= [];
    target.lastKnownNames ??= [];
    if (target.active === undefined) target.active = null;

    // --- MERGE LOGS ---
    for (const log of data.logs) {
      if (
        log?.start &&
        log?.end &&
        !target.logs.some(l => l.start === log.start && l.end === log.end)
      ) {
        target.logs.push(log);
      }
    }

    // --- MERGE ACTIVE ---
    if (!target.active && data.active) {
      target.active = data.active;
    }

    // --- MERGE NAMES ---
    if (data.name && !target.lastKnownNames.includes(data.name)) {
      target.lastKnownNames.push(data.name);
    }

    // --- DELETE OLD KEY ---
    delete timesheet[key];
    console.log(`✅ Migrated ${key} → ${target.userId}`);
  }
}

// =======================
// Updated persist
// =======================
async function persist() {
  mergeBeforePersist(); // merge before writing

  await fs.writeFile(DATA_FILE, JSON.stringify(timesheet, null, 2));
  queueGitCommit();
}


// =======================
// TIME HELPERS
// =======================
const nowISO = () => new Date().toISOString();
const AUTO_CLOCK_OUT_LIMIT_MS = 12 * 3600000;
const AUTO_CLOCK_OUT_INTERVAL_MS = 60000;

const diffHours = (s, e) =>
  (new Date(e) - new Date(s)) / 3600000;

const getAutoClockOutEndISO = (startISO) =>
  new Date(new Date(startISO).getTime() + AUTO_CLOCK_OUT_LIMIT_MS).toISOString();


const formatDate = iso =>
  new Date(iso).toLocaleString("en-PH", {
    timeZone: PH_TZ,
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });


function elapsed(startISO) {
  const ms = Date.now() - new Date(startISO).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

let autoClockOutSweepRunning = false;

async function sendAutoClockOutEmbed({ userId, name, start, end, hours }) {
  if (!client.isReady()) {
    console.warn("⚠ Auto clock-out embed skipped: Discord client is not ready yet.");
    return;
  }

  try {
    const channel = await findTimeTrackerChannel();
    if (!channel || typeof channel.send !== "function") {
      console.warn("⚠ Auto clock-out embed skipped: target channel is not sendable.");
      return;
    }

    await channel.send({
      embeds: [{
        title: "⏲️ Auto Clock-Out (12 Hours)",
        color: 0xe67e22,
        fields: [
          { name: "👤 User", value: name || userId, inline: true },
          { name: "🆔 User ID", value: userId, inline: true },
          { name: "▶️ Started", value: formatDate(start), inline: false },
          { name: "⏹ Ended (Auto)", value: formatDate(end), inline: false },
          { name: "⏱ Duration", value: `${Math.round(hours * 100) / 100}h`, inline: true },
          {
            name: "ℹ️ Reason",
            value: "Session reached the 12-hour limit and was automatically clocked out.",
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
      }],
    });

    console.log(`✅ Auto clock-out embed sent for user=${userId}`);
  } catch (err) {
    console.error("Failed to send auto clock-out embed:", err);
  }
}

async function sendAutoClockOutDM({ userId, start, end, hours }) {
  if (!client.isReady()) return;

  try {
    const user = await client.users.fetch(userId);
    if (!user) return;

    await user.send({
      embeds: [{
        title: "⏲️ You were automatically clocked out",
        color: 0xe67e22,
        description: "You reached the 12-hour maximum session length and were clocked out automatically.",
        fields: [
          { name: "▶️ Started", value: formatDate(start), inline: false },
          { name: "⏹ Ended (Auto)", value: formatDate(end), inline: false },
          { name: "⏱ Duration", value: `${Math.round(hours * 100) / 100}h`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    });

    console.log(`✅ Auto clock-out DM sent to user=${userId}`);
  } catch (err) {
    console.warn(`⚠ Failed to send auto clock-out DM to user=${userId}:`, err?.message || err);
  }
}

async function autoClockOutReachedSessions() {
  if (autoClockOutSweepRunning) return;
  autoClockOutSweepRunning = true;

  try {
    await withTimesheetWriteLock(async () => {
      await loadFromDisk();

      let hasChanges = false;
      const now = Date.now();

      for (const [userId, record] of Object.entries(timesheet)) {
        if (!record?.active) continue;

        const startMs = new Date(record.active).getTime();
        if (Number.isNaN(startMs)) {
          console.warn(`⚠ Invalid active timestamp for ${userId}: ${record.active}`);
          continue;
        }

        if (now - startMs < AUTO_CLOCK_OUT_LIMIT_MS) continue;

        const start = record.active;
        const end = getAutoClockOutEndISO(start);
        const hours = diffHours(start, end);
        const displayName = record.name || userId;

        record.logs ??= [];
        record.logs.push({
          start,
          end,
          hours,
          source: "auto_12h",
        });
        record.active = null;
        hasChanges = true;

        console.log(
          `⏲ AUTO_12H clock-out user=${userId} start=${start} end=${end}`
        );

        await sendAutoClockOutEmbed({
          userId,
          name: displayName,
          start,
          end,
          hours,
        });

        await sendAutoClockOutDM({
          userId,
          start,
          end,
          hours,
        });
      }

      if (hasChanges) {
        await persist();
      }
    });
  } catch (err) {
    console.error("❌ Auto clock-out sweep failed:", err);
  } finally {
    autoClockOutSweepRunning = false;
  }
}

function startAutoClockOutWatcher() {
  setInterval(() => {
    autoClockOutReachedSessions().catch((err) => {
      console.error("❌ Auto clock-out interval failure:", err);
    });
  }, AUTO_CLOCK_OUT_INTERVAL_MS);
}

async function resolveFreecashReportsForumChannel() {
  const fromCache = client.channels.cache.find(
    (channel) =>
      channel?.type === ChannelType.GuildForum &&
      channel?.name === FREECASH_REPORTS_FORUM_NAME
  );
  if (fromCache) {
    console.log(
      `[REPORT_DEBUG] forumResolved source=cache_name forumChannelId=${fromCache.id} fallbackId=${FREECASH_REPORTS_FORUM_ID_FALLBACK}`
    );
    return fromCache;
  }

  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch().catch(() => null);
    if (!channels) continue;

    const match = channels.find(
      (channel) =>
        channel?.type === ChannelType.GuildForum &&
        channel?.name === FREECASH_REPORTS_FORUM_NAME
    );

    if (match) {
      console.log(
        `[REPORT_DEBUG] forumResolved source=guild_name forumChannelId=${match.id} fallbackId=${FREECASH_REPORTS_FORUM_ID_FALLBACK} guildId=${guild.id}`
      );
      return match;
    }
  }

  const fallback = await client.channels.fetch(FREECASH_REPORTS_FORUM_ID_FALLBACK).catch(() => null);
  if (fallback?.type === ChannelType.GuildForum) {
    console.log(
      `[REPORT_DEBUG] forumResolved source=fallback_id forumChannelId=${fallback.id} fallbackId=${FREECASH_REPORTS_FORUM_ID_FALLBACK}`
    );
    return fallback;
  }

  console.warn(
    `[REPORT_DEBUG] forumResolved source=none forumChannelId=none fallbackId=${FREECASH_REPORTS_FORUM_ID_FALLBACK}`
  );
  return null;
}

function messageHasImageAttachment(message) {
  if (!message?.attachments?.size) return false;

  for (const attachment of message.attachments.values()) {
    const contentType = attachment?.contentType?.toLowerCase() || "";
    const name = attachment?.name?.toLowerCase() || "";

    if (contentType.startsWith("image/")) return true;
    if (/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?)$/i.test(name)) return true;
  }

  return false;
}

async function getLatestForumMessageForUser(forumChannel, userId, sessionStartMs = 0) {
  const threadMap = new Map();

  const guildActive = await forumChannel.guild.channels.fetchActiveThreads().catch((err) => {
    console.warn(
      `[REPORT_DEBUG] forumChannelId=${forumChannel.id} action=fetch_active_threads_failed reason=${err?.message || err}`
    );
    return null;
  });

  if (guildActive?.threads) {
    for (const [threadId, thread] of guildActive.threads) {
      if (thread?.parentId === forumChannel.id) {
        threadMap.set(threadId, thread);
      }
    }
  }

  const archived = await forumChannel.threads.fetchArchived({ limit: 100 }).catch((err) => {
    console.warn(
      `[REPORT_DEBUG] forumChannelId=${forumChannel.id} action=fetch_archived_threads_failed reason=${err?.message || err}`
    );
    return null;
  });

  if (archived?.threads) {
    for (const [threadId, thread] of archived.threads) {
      threadMap.set(threadId, thread);
    }
  }

  const scannedThreadIds = Array.from(threadMap.keys());
  console.log(
    `[REPORT_DEBUG] user=${userId} forumChannelId=${forumChannel.id} scannedThreadCount=${scannedThreadIds.length} scannedThreadIds=${scannedThreadIds.join(",") || "none"}`
  );

  let latestMessage = null;

  for (const thread of threadMap.values()) {
    const messages = await thread.messages.fetch({ limit: 100 }).catch((err) => {
      console.warn(
        `[REPORT_DEBUG] user=${userId} threadId=${thread.id} action=fetch_messages_failed reason=${err?.message || err}`
      );
      return null;
    });

    if (!messages) continue;

    for (const message of messages.values()) {
      if (message.author?.id !== userId || message.author?.bot) continue;
      if (message.createdTimestamp < sessionStartMs) continue;
      if (!messageHasImageAttachment(message)) continue;

      if (!latestMessage || message.createdTimestamp > latestMessage.createdTimestamp) {
        latestMessage = message;
      }
    }

    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (
      starter?.author?.id === userId &&
      !starter.author?.bot &&
      starter.createdTimestamp >= sessionStartMs &&
      messageHasImageAttachment(starter) &&
      (!latestMessage || starter.createdTimestamp > latestMessage.createdTimestamp)
    ) {
      latestMessage = starter;
    }
  }

  return latestMessage;
}

async function sweepInactiveFreecashReports() {
  if (reportInactivitySweepRunning) return;
  if (!client.isReady()) return;

  reportInactivitySweepRunning = true;

  try {
    const forumChannel = await resolveFreecashReportsForumChannel();
    if (!forumChannel) return;

    const activeUsers = await withTimesheetWriteLock(async () => {
      await loadFromDisk();
      return Object.entries(timesheet)
        .filter(([, record]) => !!record?.active)
        .map(([userId, record]) => ({
          userId,
          activeStart: record.active,
        }));
    });

    console.log(
      `[REPORT_DEBUG] sweepStart forumChannelId=${forumChannel.id} activeClockedInUsers=${activeUsers.length}`
    );

    for (const activeUser of activeUsers) {
      const sessionStartMs = new Date(activeUser.activeStart).getTime();
      const latestMessage = await getLatestForumMessageForUser(
        forumChannel,
        activeUser.userId,
        Number.isFinite(sessionStartMs) ? sessionStartMs : 0
      );

      if (!latestMessage) {
        console.log(
          `[REPORT_DEBUG] user=${activeUser.userId} latestMessageId=none threadId=none ageMinutes=none action=skip_no_messages_with_image_in_session sessionStart=${activeUser.activeStart || "unknown"}`
        );
        continue;
      }

      const ageMinutes = (Date.now() - latestMessage.createdTimestamp) / 60_000;
      const state = reportReminderState.get(activeUser.userId);
      const overLimit = ageMinutes >= REPORT_INACTIVITY_THRESHOLD_MINUTES;

      console.log(
        `[REPORT_DEBUG] user=${activeUser.userId} latestMessageId=${latestMessage.id} threadId=${latestMessage.channelId} ageMinutes=${ageMinutes.toFixed(2)} overLimit=${overLimit}`
      );

      if (!overLimit) {
        reportReminderState.delete(activeUser.userId);
        continue;
      }

      const now = Date.now();
      const sameLatestMessage = state?.lastMessageId === latestMessage.id;
      const shouldRepeatReminder =
        sameLatestMessage &&
        state?.remindedAt &&
        now - state.remindedAt >= REPORT_REMINDER_REPEAT_INTERVAL_MS;
      const shouldSendReminder = !sameLatestMessage || shouldRepeatReminder;

      if (!shouldSendReminder) {
        continue;
      }

      const messageAgeMinutes = Math.floor(ageMinutes);

      await latestMessage.channel.send(
        `⚠️ <@${activeUser.userId}> please send your report in this thread. Your latest message is over ${messageAgeMinutes} minutes old.`
      ).catch((err) => {
        console.warn(
          `[REPORT_DEBUG] user=${activeUser.userId} action=reminder_failed threadId=${latestMessage.channelId} reason=${err?.message || err}`
        );
      });

      reportReminderState.set(activeUser.userId, {
        lastMessageId: latestMessage.id,
        remindedAt: now,
      });
    }
  } catch (err) {
    console.error("❌ Freecash report inactivity sweep failed:", err);
  } finally {
    reportInactivitySweepRunning = false;
  }
}

function startFreecashReportInactivityWatcher() {
  setInterval(() => {
    sweepInactiveFreecashReports().catch((err) => {
      console.error("❌ Freecash report inactivity interval failure:", err);
    });
  }, REPORT_INACTIVITY_CHECK_INTERVAL_MS);
}

// =======================
// GITHUB LOAD (SAFE)
// =======================
async function loadFromGitHub() {
  if (!GIT_TOKEN) {
    console.warn("⚠ GIT_TOKEN missing, GitHub sync disabled");
    return;
  }

  const url = `https://api.github.com/repos/${GIT_USER}/${GIT_REPO}/contents/timesheet.json?ref=${GIT_BRANCH}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GIT_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "clocking-bot",
    },
  });

  if (!res.ok) {
    console.warn("⚠ No timesheet.json on GitHub yet");
    timesheet = {};
    await persist(); // create file on GitHub
    return;
  }

  const json = await res.json();
  const decoded = Buffer.from(json.content, "base64").toString("utf8");

  timesheet = JSON.parse(decoded);
  await fs.writeFile(DATA_FILE, decoded);

  console.log("✅ Loaded timesheet from GitHub");
}

async function loadTopupFromGitHub() {
  if (!GIT_TOKEN) return;

  const url = `https://api.github.com/repos/${GIT_USER}/${GIT_REPO}/contents/topup.json?ref=${GIT_BRANCH}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GIT_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "clocking-bot",
    },
  });

  if (!res.ok) {
    console.warn("⚠ No topup.json on GitHub yet");
    topupData = { channels: {} };
    await persistTopup();
    return;
  }

  const json = await res.json();
  const decoded = Buffer.from(json.content, "base64").toString("utf8");

  try {
    topupData = ensureTopupShape(JSON.parse(decoded));
  } catch (err) {
    console.warn("⚠ Invalid topup.json on GitHub; resetting topup data:", err?.message || err);
    topupData = { channels: {} };
    await persistTopup();
    return;
  }

  await fs.writeFile(TOPUP_FILE, JSON.stringify(topupData, null, 2));

  console.log("✅ Loaded topup from GitHub");
}

function queueGitCommit() {
  if (gitCommitTimer) return;

  gitCommitTimer = setTimeout(async () => {
    gitCommitTimer = null;
    await commitToGitHub();
  }, 3000);
}

// =======================
// GITHUB COMMIT (FIXED)
// =======================
async function commitToGitHub() {
  if (!GIT_TOKEN) return;

  const api = `https://api.github.com/repos/${GIT_USER}/${GIT_REPO}/contents/timesheet.json`;
  const content = Buffer.from(
    JSON.stringify(timesheet, null, 2)
  ).toString("base64");

  let sha = null;

  const get = await fetch(api, {
    headers: {
      Authorization: `Bearer ${GIT_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "clocking-bot",
    },
  });

  if (get.ok) {
    sha = (await get.json()).sha;
  }

  const put = await fetch(api, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GIT_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "clocking-bot",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Update timesheet",
      content,
      sha,
      branch: GIT_BRANCH,
    }),
  });

  if (!put.ok) {
    const err = await put.text();
    console.error("❌ GitHub commit failed:", err);
    return;
  }

  console.log("✅ Timesheet committed to GitHub");
}

async function commitTopupToGitHub() {
  if (!GIT_TOKEN) return;

  const api = `https://api.github.com/repos/${GIT_USER}/${GIT_REPO}/contents/topup.json`;
  const content = Buffer.from(
    JSON.stringify(ensureTopupShape(topupData), null, 2)
  ).toString("base64");

  let sha = null;

  const get = await fetch(api, {
    headers: {
      Authorization: `Bearer ${GIT_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "clocking-bot",
    },
  });

  if (get.ok) {
    sha = (await get.json()).sha;
  }

  const put = await fetch(api, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GIT_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "clocking-bot",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Update topup",
      content,
      sha,
      branch: GIT_BRANCH,
    }),
  });

  if (!put.ok) {
    const err = await put.text();
    console.error("❌ Topup GitHub commit failed:", err);
    return;
  }

  console.log("✅ Topup committed to GitHub");
}

function hasManagerRoleById(userId) {
  return MANAGER_IDS.includes(userId);
}

function hasLeaderRoleById(userId) {
  return LEADER_IDS.includes(userId);
}

process.on("unhandledRejection", err => {
  console.error("Unhandled rejection:", err);
});

// Last-resort protection so transient websocket/network faults do not kill the bot process.
process.on("uncaughtException", err => {
  console.error("Uncaught exception (process kept alive):", err);
});

// =======================
// SLASH COMMANDS
// =======================

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (!interaction.inGuild()) {
    return interaction.reply({
      content: "❌ This command can only be used in a server.",
      ephemeral: true,
    });
  }
  const trackerCommands = new Set([
    "clockin",
    "clockout",
    "forceclockout",
    "status",
    "timesheet",
    "logtracker",
    "edit",
    "totalhr",
  ]);

  const interactionChannel = await resolveInteractionChannel(interaction);

  if (
    trackerCommands.has(interaction.commandName) &&
    !isTimeTrackerInteractionContext(interaction, interactionChannel)
  ) {
    return interaction.reply({
      content: "❌ This command can only be used in **#time-tracker**.",
      ephemeral: true,
    });
  }

  if (
    interaction.commandName === "forceclockout" &&
    !interaction.options.data.length
  ) {
    return interaction.reply({
      content: "❌ Command schema out of sync. Please redeploy commands.",
      ephemeral: true,
    });
  }

  const isPublic = PUBLIC_COMMANDS.has(interaction.commandName);

  await interaction.deferReply({
    ephemeral: !isPublic,
  });

  if (interaction.commandName === "topup") {
    const resolvedChannel = await resolveInteractionChannel(interaction);
    const contextChannel = resolvedChannel || interaction.channel;
    const topupContext = getTopupContext(contextChannel, {
      channelId: interaction.channelId,
      threadId: interaction.channelId,
    });
    const entryText = interaction.options.getString("entry", true).trim();

    const parts = entryText.split("|");
    const primaryPart = (parts.shift() || "").trim();
    const extraParts = parts.map((part) => part.trim()).filter(Boolean);

    const amountMatch = primaryPart.match(/\d+(?:\.\d+)?/);
    const topupAmount = amountMatch ? Number(amountMatch[0]) : 0;
    const amountTotal = Number.isFinite(topupAmount) ? topupAmount : 0;
    const amounts = amountTotal > 0 ? [amountTotal] : [];
    const detailsText = extraParts.length ? extraParts.join(" | ") : "N/A";

    await withTopupWriteLock(async () => {
      await loadTopupFromDisk();

      const result = getOrCreateTopupThreadBucket(contextChannel, {
        channelId: topupContext.channelId,
        threadId: topupContext.threadId,
      });
      const threadBucket = result.bucket;
      const bucketContext = result.ctx;

      threadBucket.threadName = bucketContext.threadName || threadBucket.threadName;
      threadBucket.lastMessageAt = new Date().toISOString();
      threadBucket.entries.push({
        messageId: `manual:${interaction.id}`,
        userId: interaction.user.id,
        username: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
        raw: entryText,
        amounts,
        amountTotal,
        createdAt: new Date().toISOString(),
      });

      await persistTopup();

      console.log(
        `[TOPUP_DEBUG] captured via=/topup channelName=${bucketContext.channelName} channelId=${bucketContext.channelId} threadName=${bucketContext.threadName} threadId=${bucketContext.threadId} user=${interaction.user.id} amounts=${amounts.join(",") || "none"} total=${amountTotal} extras=${extraParts.join(" | ") || "none"}`
      );
    });

    return interaction.editReply({
      embeds: [{
        title: "✅ Topup Recorded",
        color: 0x2ecc71,
        fields: [
          {
            name: "Topup Amount",
            value: `$${amountTotal.toFixed(2)}`,
            inline: true,
          },
          {
            name: "Details",
            value: detailsText,
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  }

  if (interaction.commandName === "total") {
    const managerAllowed = hasManagerRoleById(interaction.user.id);
    const resolvedChannel = await resolveInteractionChannel(interaction);
    const contextChannel = resolvedChannel || interaction.channel;
    const topupContext = getTopupContext(contextChannel, {
      channelId: interaction.channelId,
      threadId: interaction.channelId,
    });

    console.log(
      `[TOTAL_DEBUG] command=/total user=${interaction.user.id} managerAllowed=${managerAllowed} channelId=${interaction.channelId} lookupChannelId=${topupContext.channelId} channelName=${topupContext.channelName}`
    );

    if (!managerAllowed) {
      console.log(`[TOTAL_DEBUG] denied reason=not_manager user=${interaction.user.id}`);
      return interaction.editReply("❌ Only managers can use this command.");
    }

    let matchedCount = 0;
    let sum = 0;

    await withTopupWriteLock(async () => {
      await loadTopupFromDisk();

      const channelBucket = topupData.channels?.[topupContext.channelId];
      const channelIdMatches =
        !!channelBucket &&
        String(channelBucket.channelId || "") === String(topupContext.channelId);

      if (!channelIdMatches) {
        matchedCount = 0;
        sum = 0;
        return;
      }

      const allEntries = Object.values(channelBucket.threads || {}).flatMap((t) => t?.entries || []);
      const matched = allEntries.filter((e) =>
        Array.isArray(e.amounts) ? e.amounts.length > 0 : Number(e.amountTotal) > 0
      );

      sum = matched.reduce((total, entry) => {
        if (Array.isArray(entry.amounts)) {
          return total + entry.amounts.reduce((a, b) => a + (Number(b) || 0), 0);
        }
        return total + (Number(entry.amountTotal) || 0);
      }, 0);
      matchedCount = matched.length;

    });

    console.log(
      `[TOTAL_DEBUG] computed channelId=${topupContext.channelId} channelName=${topupContext.channelName} matchedEntries=${matchedCount} sum=${sum.toFixed(2)} resetTopup=false`
    );

    return interaction.editReply({
      embeds: [{
        title: "💵 Channel Topup Total",
        color: 0x2ecc71,
        fields: [
          { name: "🆔 Channel ID", value: String(topupContext.channelId), inline: false },
          { name: "📌 Counted Entries", value: String(matchedCount), inline: true },
          { name: "🧮 Total", value: `$${sum.toFixed(2)}`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    });
  }


    
    // ==========================================================
    // TOTAL HOURS (WITH OPTIONAL DATE RANGE + HISTORY)
    // ==========================================================
    if (interaction.commandName === "totalhr") {
      await withTimesheetWriteLock(async () => {
        await loadFromDisk();
      });
  
      if (!hasLeaderRoleById(interaction.user.id)) {
        return interaction.editReply("❌ Only leaders and managers can view total hours.");
      }
  
      const startStr = interaction.options.getString("start");
      const endStr   = interaction.options.getString("end");
      const start = parseDatePH(startStr);
      const end   = parseDatePH(endStr, true);
  
      let historyTracks = [];
      if (start || end) {
        try {
          const history = await readFileFromGitHub("timesheetHistory.json");
          historyTracks = Array.isArray(history.tracks) ? history.tracks : [];
        } catch {
          historyTracks = [];
        }
      }
  
      const combined = new Map();
  
      const addLog = (user, log) => {
        if (!combined.has(user.userId)) {
          combined.set(user.userId, {
            userId: user.userId,
            name: user.name,
            logs: [],
          });
        }
        combined.get(user.userId).logs.push(log);
      };
  
      // current timesheet
      for (const user of Object.values(timesheet)) {
        for (const log of user.logs || []) {
          const s = new Date(log.start);
          if ((start && s < start) || (end && s > end)) continue;
          addLog(user, log);
        }
      }
  
      // archived history
      for (const track of historyTracks) {
        for (const user of Object.values(track.data || {})) {
          for (const log of user.logs || []) {
            const s = new Date(log.start);
            if ((start && s < start) || (end && s > end)) continue;
            addLog(user, log);
          }
        }
      }
  
      let lines = [];
      let grandTotal = 0;
  
      for (const user of combined.values()) {
        let total = user.logs.reduce((t, l) => t + (l.hours || 0), 0);
        total = Math.round(total * 100) / 100;
        if (total <= 0) continue;
  
        grandTotal += total;
        lines.push(`**${user.name}** — ${total.toFixed(2)}h`);
      }
  
      if (!lines.length) {
        return interaction.editReply("📭 No tracked hours in this range.");
      }
  
      lines.push("");
      lines.push(`**🧮 GRAND TOTAL:** **${grandTotal.toFixed(2)}h**`);
  
      const rangeLabel =
        startStr || endStr
          ? `${startStr || "Beginning"} → ${endStr || "Now"}`
          : "All time";
  
      return interaction.editReply({
        embeds: [{
          title: "📊 Total Hours (All Users)",
          color: 0x9b59b6,
          description: lines.join("\n"),
          footer: { text: `Range: ${rangeLabel}` },
          timestamp: new Date().toISOString(),
        }],
      });
    }
    


    // -------- CLOCK IN --------
    // -------- CLOCK IN --------
    if (interaction.commandName === "clockin") {
      return withTimesheetWriteLock(async () => {
        await loadFromDisk();
      
        const user = resolveStrictUser(interaction);
        if (!user) {
          return interaction.editReply("❌ Cannot resolve user.");
        }
      
        const record = ensureUserRecord(user.userId, user.name);
      
        if (record.active) {
          return interaction.editReply("❌ Already clocked in.");
        }
      
        record.active = nowISO();
        await persist();
      
        return interaction.editReply({
          embeds: [{
            title: "🟢 Clocked In",
            color: 0x2ecc71,
            fields: [
              { name: "👤 User", value: record.name },
              { name: "🆔 User ID", value: record.userId },
              { name: "⏱ Start", value: formatDate(record.active) },
            ],
            timestamp: new Date().toISOString(),
          }],
        });
      });
    }

  // -------- CLOCK OUT --------
  // -------- CLOCK OUT (EMBED + DETAILS) --------
  if (interaction.commandName === "clockout") {
    return withTimesheetWriteLock(async () => {
      await loadFromDisk();

      const user = resolveStrictUser(interaction);
      if (!user) {
        return interaction.editReply("❌ Cannot resolve user.");
      }
    
      const record = ensureUserRecord(user.userId, user.name);
    
      if (!record.active) {
        return interaction.editReply("❌ Not clocked in.");
      }
    
      const start = record.active;
      const end = nowISO();
      const hours = diffHours(start, end);
      const rounded = Math.round(hours * 100) / 100;

      record.logs.push({
        start,
        end,
        hours,
      });
    
      record.active = null;
      await persist();
    
      return interaction.editReply({
        embeds: [{
          title: "🔴 Clocked Out",
          color: 0xe74c3c,
          fields: [
            { name: "👤 User", value: record.name },
            { name: "▶️ Started", value: formatDate(start), inline: false },
            { name: "⏹ Ended", value: formatDate(end), inline: false },
            { name: "⏱ Session Duration", value: `${rounded}h`, inline: true },
            {
              name: "⚠️ Reminder",
              value: "**REMINDER: UPDATE AD SPENT**",
              inline: false,
            },
          ],
          timestamp: new Date().toISOString(),
        }],
      });
    });
  }

  // -------- EDIT SESSION (MANAGER ONLY) --------
  if (interaction.commandName === "edit") {
    try {
      return await withTimesheetWriteLock(async () => {
        await loadFromDisk();
  
      // Permission check
      if (!hasManagerRoleById(interaction.user.id)) {
        return interaction.editReply("❌ Only managers can edit sessions.");
      }
  
      const targetUser = interaction.options.getUser("user");
      if (!targetUser) {
        return interaction.editReply("❌ You must specify a user.");
      }
  
      const sessionIndex = interaction.options.getInteger("session");
      if (!sessionIndex || sessionIndex < 1) {
        return interaction.editReply(
          "❌ You must specify a valid session number (starting from 1)."
        );
      }
  
      const startStr = interaction.options.getString("started");
      const endStr   = interaction.options.getString("ended");
      if (!startStr || !endStr) {
        return interaction.editReply("❌ You must provide both start and end times.");
      }
  
      const record = timesheet[targetUser.id];
      if (!record || !Array.isArray(record.logs) || record.logs.length === 0) {
        return interaction.editReply("⚠️ This user has no sessions to edit.");
      }
  
      const editableLogs = record.logs.slice(-15);
      const editableOffset = record.logs.length - editableLogs.length;

      const visibleIndex = sessionIndex - 1;
      if (visibleIndex >= editableLogs.length) {
        return interaction.editReply(
          `⚠️ You can only edit the latest ${editableLogs.length} session(s), matching /timesheet view order.`
        );
      }

      const index = editableOffset + visibleIndex;
  
      // ==================================================
      // 🗑️ DELETE SESSION EXCEPTION
      // ==================================================
      if (startStr === "0" && endStr === "0") {
        const deleted = record.logs.splice(index, 1);
  
        await persist();
  
        const member = await safeGetMember(interaction, targetUser.id);
        const displayName =
          member?.displayName ||
          targetUser.globalName ||
          targetUser.username;
  
        return interaction.editReply({
          embeds: [{
            title: "🗑️ Session Deleted",
            color: 0xe74c3c,
            fields: [
              { name: "👤 User", value: displayName, inline: true },
              { name: "🆔 User ID", value: targetUser.id, inline: true },
              { name: "📝 Deleted Session", value: `#${sessionIndex}`, inline: true },
              {
                name: "📅 Original Session",
                value: formatSession(deleted[0].start, deleted[0].end),
                inline: false,
              },
              {
                name: "👮 Deleted by",
                value:
                  interaction.member?.displayName ||
                  interaction.user.username,
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
          }],
        });
      }
  
      // ==================================================
      // ⏱️ STRICT HH:MM VALIDATION
      // ==================================================
      const START_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
      const END_HHMM_EXTENDED = /^(?:([01]\d|2[0-3])|([2-4]\d)):[0-5]\d$/;

      if (!START_HHMM.test(startStr) || !END_HHMM_EXTENDED.test(endStr)) {
        return interaction.editReply(
          "❌ Time format must be **HH:MM**. Start accepts 00:00-23:59, end accepts 00:00-49:59 (24:00+ becomes next day). Use `0` + `0` to delete a session."
        );
      }
  
      // Preserve original session date (PH)
      const original = record.logs[index];
      const originalStart = new Date(original.start);
  
      const phDate = originalStart.toLocaleDateString("en-PH", {
        timeZone: PH_TZ,
      });
  
      const newStart = parsePHTime(startStr, phDate);
      const newEnd   = parseExtendedEndPHTime(endStr, phDate);
  
      if (!newStart || !newEnd || newStart >= newEnd) {
        return interaction.editReply(
          "❌ Invalid times. Ensure start < end and format is HH:MM."
        );
      }
  
      const hours = (newEnd - newStart) / 3600000;
  
      record.logs[index] = {
        start: newStart.toISOString(),
        end: newEnd.toISOString(),
        hours: Math.round(hours * 100) / 100,
      };
  
      await persist();
  
      const member = await safeGetMember(interaction, targetUser.id);
      const displayName =
        member?.displayName ||
        targetUser.globalName ||
        targetUser.username;
  
      return interaction.editReply({
        embeds: [{
          title: "✏️ Session Edited",
          color: 0xf1c40f,
          fields: [
            { name: "👤 User", value: displayName, inline: true },
            { name: "🆔 User ID", value: targetUser.id, inline: true },
            { name: "📝 Session", value: `#${sessionIndex}`, inline: true },
            { name: "▶️ New Start", value: formatDate(newStart.toISOString()), inline: true },
            { name: "⏹ New End", value: formatDate(newEnd.toISOString()), inline: true },
            { name: "⏱ Duration", value: `${Math.round(hours * 100) / 100}h`, inline: true },
            {
              name: "👮 Edited by",
              value:
                interaction.member?.displayName ||
                interaction.user.username,
              inline: true,
            },
          ],
          timestamp: new Date().toISOString(),
        }],
      });
      });
  
    } catch (err) {
      console.error("Edit command failed:", err);
      return safeEdit(
        interaction,
        "❌ Failed to edit session due to an internal error."
      );
    }
  }


  // -------- STATUS --------
  if (interaction.commandName === "status") {
    await withTimesheetWriteLock(async () => {
      await loadFromDisk();
    });
  
    const showAll = interaction.options.getBoolean("all");
    const targetUser =
      interaction.options.getUser("user") || interaction.user;
  
    const uid = targetUser.id;
  
    // ======================
    // /status all  (COMPACT EMBED)
    // ======================
    if (showAll) {
      const activeUsers = Object.values(timesheet).filter(u => u?.active);
  
      if (!activeUsers.length) {
        return interaction.editReply("⚪ No users are currently clocked in.");
      }
  
      const lines = [];
  
      for (const u of activeUsers) {
        const member = await safeGetMember(interaction, u.userId);
  
        const displayName = member
          ? `${member.displayName} (${member.user.username})`
          : u.name;

        lines.push(
          `❇️ **${displayName}** — \`${formatDate(u.active)}\``
        );
      }
  
      return interaction.editReply({
        embeds: [{
          title: "🟢 Active Users",
          color: 0x2ecc71,
          description: lines.join("\n"),
          footer: { text: `Active: ${activeUsers.length}` },
          timestamp: new Date().toISOString(),
        }],
      });
    }
  
    // ======================
    // /status (SELF or USER)
    // ======================
    const record = timesheet[uid];
    const member = await safeGetMember(interaction, uid);
  
    const displayName =
      member?.displayName ||
      targetUser.globalName ||
      targetUser.username;
  
    // ===== CLOCKED IN (LIVE UPDATE) =====
    if (record?.active) {
      const start = record.active;
  
      const embedBase = {
        title: "🟢 Status: Clocked In",
        color: 0x2ecc71,
        footer: { text: "Live updating every 5 seconds" },
      };
  
      const buildEmbed = () => ({
        ...embedBase,
        fields: [
          { name: "👤 User", value: displayName, inline: true },
          { name: "▶️ Started", value: formatDate(start), inline: false },
          { name: "⏱ Elapsed", value: formatElapsedLive(start), inline: true },
        ],
        timestamp: new Date().toISOString(),
      });
  
      // clear existing timer
      const existing = liveStatusTimers.get(uid);
      if (existing) {
        clearInterval(existing);
        liveStatusTimers.delete(uid);
      }
  
      const initialResult = await safeEdit(interaction, { embeds: [buildEmbed()] });
      if (!initialResult?.ok && (initialResult.code === 10062 || initialResult.code === 50027)) {
        return;
      }
  
      const timer = setInterval(async () => {
        if (!timesheet[uid]?.active) {
          clearInterval(timer);
          liveStatusTimers.delete(uid);
          return;
        }
        const result = await safeEdit(interaction, { embeds: [buildEmbed()] });
        if (!result?.ok && (result.code === 10062 || result.code === 50027)) {
          clearInterval(timer);
          liveStatusTimers.delete(uid);
        }
      }, 5000);
  
      liveStatusTimers.set(uid, timer);
      return;
    }
  
    // ===== CLOCKED OUT =====
    const total =
      record?.logs?.reduce((t, l) => t + l.hours, 0) || 0;
  
    return interaction.editReply({
      embeds: [{
        title: "⚪ Status: Clocked Out",
        color: 0x95a5a6,
        fields: [
          { name: "👤 User", value: displayName, inline: true },
        ],
        footer: { text: "No active session" },
        timestamp: new Date().toISOString(),
      }],
    });
  }

    // -------- FORCE CLOCK OUT (MANAGER ONLY | CRASH SAFE) --------
    if (interaction.commandName === "forceclockout") {
      try {
        return withTimesheetWriteLock(async () => {
          await loadFromDisk();
    
        // permission check
        if (!hasLeaderRoleById(interaction.user.id)) {
          return interaction.editReply("❌ Only leaders can force clock-out users.");
        }
    
        const targetUser = interaction.options.getUser("user");
    
        // 🚨 HARD GUARD (THIS FIXES THE HANG)
        if (!targetUser) {
          return interaction.editReply("❌ No user provided. Please re-run the command.");
        }
    
        const record = timesheet[targetUser.id];
    
        if (!record || !record.active) {
          return interaction.editReply("⚠️ That user is not currently clocked in.");
        }
    
        const start = record.active;
        const end = nowISO();
        const hours = diffHours(start, end);
        const rounded = Math.round(hours * 100) / 100;
    
        record.logs.push({ start, end, hours });
        record.active = null;
    
        await persist();
    
        const member = await safeGetMember(interaction, targetUser.id);
    
        const displayName =
          member?.displayName ||
          targetUser.globalName ||
          targetUser.username;
    
          return interaction.editReply({
          embeds: [{
            title: "⛔ Force Clock-Out",
            color: 0xe67e22,
            fields: [
              { name: "👤 User", value: displayName, inline: true },
              { name: "🆔 User ID", value: targetUser.id, inline: true },
              { name: "▶️ Started", value: formatDate(start) },
              { name: "⏹ Ended", value: formatDate(end) },
              { name: "⏱ Duration", value: `${rounded}h`, inline: true },
              {
                name: "👮 Forced by",
                value:
                  interaction.member?.displayName ||
                  interaction.user.globalName ||
                  interaction.user.username,
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
          }],
          });
        });
    
      } catch (err) {
        console.error("ForceClockOut failed:", err);
    
        // ensure Discord always gets a response
        return safeEdit(interaction, "❌ Force clock-out failed due to an internal error.");
      }
    }

  // -------- LOG TRACKER (MANAGER ONLY) --------
  if (interaction.commandName === "logtracker") {
    const sub = interaction.options.getSubcommand(); // should always be 'run'
    if (!hasManagerRoleById(interaction.user.id)) {
      return interaction.editReply("❌ Only managers can run log tracker.");
    }
  
    const reset = interaction.options.getBoolean("reset");
    const trackId = interaction.options.getInteger("id");
  
    // ===== VIEW ARCHIVED LOG =====
    if (trackId) {
      let history;
      try {
        history = await readFileFromGitHub("timesheetHistory.json");
      } catch (err) {
        console.error(err);
        return interaction.editReply("❌ Failed to read log history from GitHub.");
      }
  
      const track = history.tracks?.find(t => t.trackId === trackId);
      if (!track) {
        return interaction.editReply(`❌ No log found for ID **${trackId}**.`);
      }
  
      const lines = [];
      let grandTotal = 0;
  
      for (const user of Object.values(track.data)) {
        let total = 0;
        for (const log of user.logs || []) {
          if (typeof log.hours === "number") total += log.hours;
        }
  
        total = Math.round(total * 100) / 100;
        if (total <= 0) continue;
  
        grandTotal += total;
        lines.push(`**${user.name}** — ${total.toFixed(2)}h`);
      }
  
      lines.push("");
      lines.push(`**🧮 GRAND TOTAL:** **${grandTotal.toFixed(2)}h**`);
  
      return interaction.editReply({
        embeds: [{
          title: "📦 LogTracker View",
          color: 0x3498db,
          description: lines.join("\n"),
          fields: [
            { name: "🆔 Track ID", value: String(track.trackId), inline: true },
            {
              name: "🕒 Time Range",
              value: `${formatDate(track.timeRange.oldest)}\n→ ${formatDate(track.timeRange.latest)}`,
              inline: false,
            },
          ],
          footer: { text: "Source: GitHub • timesheetHistory.json" },
          timestamp: new Date().toISOString(),
        }],
      });
    }
  
    // ===== ARCHIVE LOGS =====
    else if (reset) {
      return withTimesheetWriteLock(async () => {
        await loadFromDisk();

      const HISTORY_FILE = "./timesheetHistory.json";
      let history = { tracks: [] };
  
      try {
        history = JSON.parse(await fs.readFile(HISTORY_FILE, "utf8"));
        if (!Array.isArray(history.tracks)) history.tracks = [];
      } catch {
        history = { tracks: [] };
      }
  
      const movedData = {};
      let oldest = null;
      let latest = null;
  
      for (const [key, user] of Object.entries(timesheet)) {
        if (!Array.isArray(user.logs) || user.logs.length === 0) continue;
  
        for (const log of user.logs) {
          const s = new Date(log.start);
          const e = new Date(log.end);
  
          if (!oldest || s < oldest) oldest = s;
          if (!latest || e > latest) latest = e;
        }
  
        movedData[key] = { ...user, logs: [...user.logs] };
        user.logs = []; // clear active logs
      }
  
      if (!Object.keys(movedData).length) {
        return interaction.editReply("📭 No logs to archive.");
      }
  
      const newTrackId = history.tracks.length + 1;
  
      history.tracks.push({
        trackId: newTrackId,
        createdAt: new Date().toISOString(),
        timeRange: {
          oldest: oldest.toISOString(),
          latest: latest.toISOString(),
        },
        data: movedData,
      });
  
      const historyJson = JSON.stringify(history, null, 2);
      await fs.writeFile(HISTORY_FILE, historyJson);
  
      await commitFileToGitHub({
        path: "timesheetHistory.json",
        content: historyJson,
        message: `LogTracker #${newTrackId} (${formatDate(oldest.toISOString())} → ${formatDate(latest.toISOString())})`,
      });
  
      await persist();

      return interaction.editReply({
        embeds: [{
          title: "📦 Log Tracker Completed",
          color: 0x3498db,
          fields: [
            { name: "🆔 Track ID", value: `${newTrackId}`, inline: true },
            {
              name: "🕒 Time Range",
              value: `${formatDate(oldest.toISOString())}\n→ ${formatDate(latest.toISOString())}`,
              inline: false,
            },
            {
              name: "👮 Executed by",
              value: interaction.member?.displayName || interaction.user.username,
              inline: true,
            },
          ],
          footer: { text: "Archived logs, active sessions preserved" },
          timestamp: new Date().toISOString(),
        }],
      });
      });
    }
  
    // ===== DEFAULT INSTRUCTIONS =====
    else {
      return interaction.editReply({
        embeds: [{
          title: "📦 LogTracker Instructions",
          color: 0x3498db,
          description:
            "Use this command to archive logs or view past logtracks.\n\n" +
            "`/logtracker run reset:true` → Archive current logs, clear active logs, push to GitHub.\n" +
            "`/logtracker run id:<number>` → View a specific logtrack.\n" +
            "`/logtracker run` → Show these instructions.",
          footer: { text: "Manager only" },
          timestamp: new Date().toISOString(),
        }],
      });
    }
  }




  // -------- TIMESHEET --------
  if (interaction.commandName === "timesheet") {
    const sub = interaction.options.getSubcommand(false);
  
    if (sub !== "view") return;
  
    await withTimesheetWriteLock(async () => {
      await loadFromDisk();
    });
  
    // options (all optional)
    const requestedUser = interaction.options.getUser("user");
    const targetUser = requestedUser || interaction.user;
    
    // permission check
    if (
      requestedUser &&
      requestedUser.id !== interaction.user.id &&
      !hasLeaderRoleById(interaction.user.id)
    ) {
      return interaction.editReply("❌ You don’t have permission to view other users’ timesheets.");
    }

    const startStr = interaction.options.getString("start");
    const endStr   = interaction.options.getString("end");
  
    // parse dates
    const start = parseDatePH(startStr);
    const end   = parseDatePH(endStr, true);

    const member = await safeGetMember(interaction, targetUser.id);
  
    const displayName =
      member?.displayName ||
      targetUser.globalName ||
      targetUser.username;
  
    // fetch record
    const record = timesheet[targetUser.id];
  
    if (!record || !Array.isArray(record.logs) || record.logs.length === 0) {
      return interaction.editReply("📭 No records found.");
    }
  
    const isUnfilteredView = !startStr && !endStr;

    // filter logs by date range first
    const filteredLogs = [];
    for (const l of record.logs) {
      const sessionStart = new Date(l.start);
      if ((start && sessionStart < start) || (end && sessionStart > end)) continue;
      filteredLogs.push(l);
    }

    // for unfiltered /timesheet view (self or user), only return latest 15 sessions
    const logsToShow = isUnfilteredView
      ? filteredLogs.slice(-15)
      : filteredLogs;

    let total = 0;
    let lines = [];
    let count = 0;
  
    for (const l of logsToShow) {
      const hours = (new Date(l.end) - new Date(l.start)) / 3600000;
      total += hours;
      count++;

      lines.push(
        `**${count}.** ${formatSession(l.start, l.end)} — **${Math.round(hours * 100) / 100}h**`
      );
    }
  
    if (!count) {
      return interaction.editReply("📭 No sessions in the selected range.");
    }
  
    // range label
    const rangeLabel =
      startStr || endStr
        ? `${startStr || "Beginning"} → ${endStr || "Now"}`
        : isUnfilteredView
          ? "All time (latest 15 shown)"
          : "All time";
  
    // response
    return interaction.editReply({
      embeds: [{
        title: "🧾 Timesheet",
        color: 0x3498db,
        fields: [
          { name: "👤 User", value: displayName, inline: true },
          { name: "🆔 User ID", value: targetUser.id, inline: true },
          { name: "📅 Range", value: rangeLabel, inline: true },
          {
            name: "🧮 Sessions",
            value: isUnfilteredView
              ? `${count} shown (${filteredLogs.length} total)`
              : String(count),
            inline: true
          },
          { name: "⏱ Total Hours", value: `${Math.round(total * 100) / 100}h`, inline: true },
          { name: "📋 Logs", value: lines.join("\n"), inline: false },
        ],
        footer: { text: "Time Tracker" },
        timestamp: new Date().toISOString(),
      }],
    });
  }
});  

// =======================
// STARTUP
// =======================
(async () => {
  await loadFromGitHub();
  await persist(); // persist already merges safely

  await loadTopupFromDisk();
  await loadTopupFromGitHub();

  await autoClockOutReachedSessions();
  startAutoClockOutWatcher();

  await sweepInactiveFreecashReports();
  startFreecashReportInactivityWatcher();

  startKeepAlive();

  const loginWithRetry = async () => {
    while (true) {
      try {
        await client.login(process.env.DISCORD_TOKEN);
        console.log(`✅ Logged in as ${client.user.tag}`);
        return;
      } catch (err) {
        console.error("❌ Discord login failed. Retrying in 15s:", err);
        await new Promise(resolve => setTimeout(resolve, 15000));
      }
    }
  };

  await loginWithRetry();
})();
