/**
 * WhatsApp Name Lookup Service (v2)
 *
 * HTTP API backed by Baileys (WhatsApp Web multi-device).
 * On first run, prints a QR code — scan it with WhatsApp.
 * After linking, the session persists in ./auth_info/.
 *
 * Name resolution strategy (in order):
 *   1. Local contact cache (populated from WhatsApp events)
 *   2. presenceSubscribe() — triggers contacts.update with pushName
 *   3. getBusinessProfile() — for WhatsApp Business accounts
 *
 * Endpoints:
 *   POST /lookup  { phone: "+27821234567" }
 *     → { exists, name, jid }
 *
 *   GET  /health
 *     → { ok, connected, lookups, cachedNames }
 *
 * Start:  node lookup.js          (default port 3456)
 *         PORT=3457 node lookup.js (custom port)
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import pino from "pino";

const PORT = parseInt(process.env.PORT || "3456", 10);
const AUTH_DIR = "./auth_info";
const CACHE_FILE = "./contact_names.json";
const MAX_LOOKUPS_PER_SESSION = 100;
const LOOKUP_DELAY_MIN_MS = 2000;
const LOOKUP_DELAY_MAX_MS = 5000;
const PRESENCE_WAIT_MS = 5000; // how long to wait for name after presenceSubscribe

const logger = pino({ level: "warn" });

let sock = null;
let connected = false;
let lookupCount = 0;
let lastLookupAt = 0;

const MAX_SENDS_PER_DAY = parseInt(process.env.MAX_SENDS_PER_DAY || '10', 10);
let sendsToday = 0;
let sendDate = new Date().toISOString().slice(0, 10);
const MAX_INBOUND_MESSAGES = 1000;
const inboundMessages = []; // { phone, jid, text, timestamp }

setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== sendDate) { sendDate = today; sendsToday = 0; }
}, 60_000);

// ── Contact name cache ──────────────────────────────────────

let contactNames = {};

async function loadCache() {
  try {
    const data = await readFile(CACHE_FILE, "utf-8");
    contactNames = JSON.parse(data);
    console.log(`[wa] Loaded ${Object.keys(contactNames).length} cached names from ${CACHE_FILE}`);
  } catch {
    // First run or corrupt file — start fresh
    contactNames = {};
  }
}

async function saveCache() {
  try {
    await writeFile(CACHE_FILE, JSON.stringify(contactNames, null, 2));
  } catch {
    // Ignore write errors
  }
}

// Persist cache every 30 seconds
setInterval(saveCache, 30_000);

// ── Baileys connection ──────────────────────────────────────

async function startWhatsApp() {
  await mkdir(AUTH_DIR, { recursive: true });
  await loadCache();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Leadgen Lookup", "Chrome", "1.0.0"],
    logger,
    syncFullHistory: true,
  });

  // QR code for initial linking
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n╔══════════════════════════════════════╗");
      console.log("║  Scan this QR with WhatsApp          ║");
      console.log("╚══════════════════════════════════════╝\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      connected = true;
      lookupCount = 0;
      console.log("[wa] Connected to WhatsApp");
    }

    if (connection === "close") {
      connected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[wa] Disconnected (status=${statusCode}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        startWhatsApp();
      } else {
        console.log("[wa] Logged out — delete auth_info/ and restart to re-link");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ── Collect contact names from all available events ──────

  sock.ev.on("contacts.upsert", (contacts) => {
    let added = 0;
    for (const c of contacts) {
      const name = c.notify || c.verifiedName || c.name;
      if (name && c.id) {
        contactNames[c.id] = name;
        added++;
      }
    }
    if (added) {
      console.log(`[wa] contacts.upsert: +${added} names (${Object.keys(contactNames).length} total)`);
    }
  });

  sock.ev.on("contacts.update", (updates) => {
    for (const u of updates) {
      const name = u.notify || u.verifiedName;
      if (name && u.id) {
        contactNames[u.id] = name;
      }
    }
  });

  // Capture pushNames from incoming messages + buffer inbound replies
  sock.ev.on("messages.upsert", ({ messages }) => {
    if (!messages) return;
    for (const msg of messages) {
      if (msg.pushName && msg.key?.remoteJid) {
        contactNames[msg.key.remoteJid] = msg.pushName;
      }
      // Buffer inbound messages for /messages endpoint
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@g.us") || jid.endsWith("@newsletter") || jid.endsWith("@broadcast")) continue;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || null;
      if (!text) continue;
      // @lid JIDs are linked-device IDs — must use senderPn for the real phone number
      // Skip @lid messages without senderPn (can't resolve to a real phone number)
      let phone;
      if (jid.endsWith("@lid")) {
        if (!msg.key.senderPn) continue;
        const senderDigits = msg.key.senderPn.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "");
        phone = `+${senderDigits}`;
      } else {
        const digits = jid.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "");
        phone = `+${digits}`;
      }
      inboundMessages.push({ id: msg.key.id, phone, jid, text, timestamp: new Date().toISOString() });
      if (inboundMessages.length > MAX_INBOUND_MESSAGES) inboundMessages.shift();
    }
  });

  // Bulk history sync (fires on initial connect)
  sock.ev.on("messaging-history.set", ({ contacts }) => {
    if (!contacts) return;
    let added = 0;
    for (const c of contacts) {
      const name = c.notify || c.verifiedName || c.name;
      if (name && c.id) {
        contactNames[c.id] = name;
        added++;
      }
    }
    if (added) {
      console.log(`[wa] history sync: +${added} names (${Object.keys(contactNames).length} total)`);
    }
  });
}

// ── Name lookup ─────────────────────────────────────────────

async function lookupPhone(phone) {
  if (!connected || !sock) {
    return { exists: false, name: null, jid: null, error: "not connected" };
  }

  if (lookupCount >= MAX_LOOKUPS_PER_SESSION) {
    return {
      exists: false,
      name: null,
      jid: null,
      error: `session limit reached (${MAX_LOOKUPS_PER_SESSION})`,
    };
  }

  // Rate limit with random jitter
  const now = Date.now();
  const delay = LOOKUP_DELAY_MIN_MS + Math.random() * (LOOKUP_DELAY_MAX_MS - LOOKUP_DELAY_MIN_MS);
  const elapsed = now - lastLookupAt;
  if (elapsed < delay) {
    await new Promise((r) => setTimeout(r, delay - elapsed));
  }
  lastLookupAt = Date.now();

  // Normalise phone: strip + prefix, ensure just digits
  const digits = phone.replace(/[^0-9]/g, "");
  const jid = `${digits}@s.whatsapp.net`;

  try {
    // Step 1: Check if number is on WhatsApp
    const [result] = await sock.onWhatsApp(jid);

    if (!result?.exists) {
      lookupCount++;
      console.log(`[wa] Lookup #${lookupCount}: ${phone} → not on WhatsApp`);
      return { exists: false, name: null, jid: null };
    }

    const canonicalJid = result.jid;

    // Step 2: Check local cache
    if (contactNames[canonicalJid]) {
      lookupCount++;
      const name = contactNames[canonicalJid];
      console.log(`[wa] Lookup #${lookupCount}: ${phone} → cache hit: "${name}"`);
      return { exists: true, name, jid: canonicalJid };
    }

    // Step 3: presenceSubscribe — sometimes triggers contacts.update with pushName
    let resolvedName = null;
    try {
      const namePromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          sock.ev.off("contacts.update", handler);
          resolve(null);
        }, PRESENCE_WAIT_MS);

        const handler = (updates) => {
          const match = updates.find((u) => u.id === canonicalJid);
          if (match?.notify || match?.verifiedName) {
            clearTimeout(timeout);
            sock.ev.off("contacts.update", handler);
            resolve(match.notify || match.verifiedName);
          }
        };
        sock.ev.on("contacts.update", handler);
      });

      await sock.presenceSubscribe(canonicalJid);
      resolvedName = await namePromise;
    } catch {
      // Ignore — best effort
    }

    if (resolvedName) {
      contactNames[canonicalJid] = resolvedName;
      lookupCount++;
      console.log(`[wa] Lookup #${lookupCount}: ${phone} → presence resolved: "${resolvedName}"`);
      return { exists: true, name: resolvedName, jid: canonicalJid };
    }

    // Step 4: Try business profile as last resort
    try {
      const biz = await sock.getBusinessProfile(canonicalJid);
      const bizName = biz?.name || biz?.pushName;
      if (bizName) {
        contactNames[canonicalJid] = bizName;
        lookupCount++;
        console.log(`[wa] Lookup #${lookupCount}: ${phone} → business profile: "${bizName}"`);
        return { exists: true, name: bizName, jid: canonicalJid };
      }
    } catch {
      // Not a business account or method unavailable
    }

    // Step 5: No name resolved
    lookupCount++;
    console.log(`[wa] Lookup #${lookupCount}: ${phone} → exists but no name resolved`);
    return { exists: true, name: null, jid: canonicalJid };

  } catch (err) {
    console.error(`[wa] Lookup error for ${phone}: ${err.message}`);
    return { exists: false, name: null, jid: null, error: err.message };
  }
}

// ── HTTP server ─────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.end(
      JSON.stringify({
        ok: true,
        connected,
        lookups: lookupCount,
        max: MAX_LOOKUPS_PER_SESSION,
        cachedNames: Object.keys(contactNames).length,
        sendsToday,
        maxSendsPerDay: MAX_SENDS_PER_DAY,
        inboxBufferSize: inboundMessages.length,
        oldestMessageTimestamp: inboundMessages[0]?.timestamp ?? null,
      })
    );
    return;
  }

  // Send WhatsApp message (Phase B outreach)
  if (req.method === "POST" && req.url === "/send") {
    try {
      const body = await parseBody(req);
      const { phone, message } = body;

      if (!phone || typeof phone !== "string") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "missing 'phone' field" }));
        return;
      }
      if (!message || typeof message !== "string") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "missing 'message' field" }));
        return;
      }

      if (!connected || !sock) {
        res.writeHead(503);
        res.end(JSON.stringify({ error: "not connected" }));
        return;
      }

      if (sendsToday >= MAX_SENDS_PER_DAY) {
        res.writeHead(429);
        res.end(JSON.stringify({ error: "daily send limit reached", sendsToday, maxSendsPerDay: MAX_SENDS_PER_DAY }));
        return;
      }

      // Server-side jitter: 30–60 seconds (callers must use timeout >= 120s)
      const jitterMs = 30_000 + Math.random() * 30_000;
      await new Promise((r) => setTimeout(r, jitterMs));

      const digits = phone.replace(/[^0-9]/g, "");
      const jid = `${digits}@s.whatsapp.net`;

      const result = await sock.sendMessage(jid, { text: message });
      sendsToday++;

      console.log(`[wa] Sent message to ${phone} (${sendsToday}/${MAX_SENDS_PER_DAY} today)`);

      res.end(JSON.stringify({
        sent: true,
        messageId: result?.key?.id,
        jid,
        sendsToday,
        remaining: MAX_SENDS_PER_DAY - sendsToday,
      }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Get buffered inbound messages
  if (req.method === "GET" && req.url?.startsWith("/messages")) {
    const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const since = urlObj.searchParams.get("since");

    let filtered = inboundMessages;
    if (since) {
      filtered = inboundMessages.filter((m) => m.timestamp > since);
    }

    res.end(JSON.stringify({ messages: filtered, total: filtered.length }));
    return;
  }

  // Drain inbound messages (outreach response poller — one-shot, clears buffer)
  if (req.method === "GET" && req.url === "/inbox") {
    const drained = inboundMessages.splice(0);
    res.end(JSON.stringify({ messages: drained }));
    return;
  }

  // Lookup
  if (req.method === "POST" && req.url === "/lookup") {
    try {
      const body = await parseBody(req);
      const phone = body?.phone;

      if (!phone || typeof phone !== "string") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "missing 'phone' field" }));
        return;
      }

      const result = await lookupPhone(phone);
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

// ── Start ───────────────────────────────────────────────────

await startWhatsApp();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[wa] Lookup service listening on http://127.0.0.1:${PORT}`);
  console.log(`[wa] POST /lookup { "phone": "+27821234567" }`);
  console.log(`[wa] GET  /health`);
  console.log(`[wa] Cached names: ${Object.keys(contactNames).length}`);
});
