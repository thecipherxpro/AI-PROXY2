// oc-api-proxy.mjs — OpenCode free models as OpenAI/Anthropic APIs.

import express from "express";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Hostinger provides the port via process.env.PORT
const PROXY_PORT = Number(process.env.PORT || process.env.PROXY_PORT || 6447);
const OC_SERVER = process.env.OC_SERVER;
const OC_USERNAME = process.env.OC_USERNAME || "opencode";
const OC_PASSWORD = process.env.OC_PASSWORD;
const OC_WORKDIR = process.env.OC_WORKDIR || path.join(HERE, "oc-workspace");
const REQUEST_TIMEOUT = Number(process.env.OC_TIMEOUT || 600) * 1000;

function findBinary() {
  const candidates = [
    path.join(HERE, "node_modules", ".bin", "opencode"),
    path.join(HERE, "node_modules", "opencode-ai", "bin", "opencode"),
    path.join(process.cwd(), "node_modules", ".bin", "opencode"),
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try { fs.chmodSync(c, 0o755); } catch {}
      return c;
    }
  }
  return "opencode";
}

const OC_BIN = process.env.OC_BIN || findBinary();

// ── API keys ────────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || path.join(HERE, "api-keys.json");
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    try { fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2)); } catch {}
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) if (tok === key) return name;
  return null;
}

// ── opencode serve backend ──────────────────────────────────────────
let ocBase = null;
let ocAuth = null;
let backendError = null;

function ocReq(method, pathname, body) {
  return new Promise((resolve, reject) => {
    if (!ocBase) return reject(new Error(backendError || "Backend not initialized"));
    const u = new URL(ocBase + pathname);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method,
        headers: {
          ...(ocAuth ? { Authorization: ocAuth } : {}),
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
        timeout: REQUEST_TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          let json = null;
          try { json = JSON.parse(raw); } catch {}
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("opencode request timed out")); });
    if (data) req.write(data);
    req.end();
  });
}

async function startBackend() {
  if (OC_SERVER) {
    ocBase = OC_SERVER.replace(/\/$/, "");
    ocAuth = OC_PASSWORD
      ? "Basic " + Buffer.from(`${OC_USERNAME}:${OC_PASSWORD}`).toString("base64")
      : null;
    return;
  }
  
  console.log(`[OC] Using opencode binary at: ${OC_BIN}`);
  fs.mkdirSync(OC_WORKDIR, { recursive: true });
  const password = "oc-" + crypto.randomBytes(12).toString("hex");
  const child = spawn(OC_BIN, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
    cwd: OC_WORKDIR,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.on("exit", (code) => console.log("[OC] opencode serve exited with code", code));
  process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });

  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("opencode serve did not start within 45s")), 45000);
    const onData = (d) => {
      const str = d.toString();
      buf += str;
      console.log(`[OC CORE] ${str.trim()}`);
      const m = buf.match(/listening on https?:\/\/[^:]+:(\d+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (c) => { clearTimeout(timer); reject(new Error(`opencode serve exited early (code ${c})`)); });
  });

  ocBase = `http://127.0.0.1:${port}`;
  ocAuth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
  console.log(`[OC] opencode serve backend ready on ${ocBase}`);

  for (let i = 0; i < 60; i++) {
    try {
      const r = await ocReq("GET", "/provider");
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("opencode serve did not become healthy");
}

// ── models ──────────────────────────────────────────────────────────
let modelCache = null;
async function getModels() {
  if (modelCache) return modelCache;
  const r = await ocReq("GET", "/provider");
  if (r.status !== 200 || !r.json?.all) throw new Error("failed to list opencode providers");
  const oc = r.json.all.find((p) => p.id === "opencode");
  modelCache = oc ? Object.keys(oc.models || {}) : [];
  if (!modelCache.length) throw new Error("no opencode models found");
  return modelCache;
}

// ── translation: chat formats → opencode prompt ─────────────────────
function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c.type === "text") return c.text ?? "";
        if (c.type === "tool_result")
          return typeof c.content === "string"
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x) => x.text || "").join("\n")
              : "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function messagesToPrompt(messages) {
  let system = "";
  const turns = [];
  for (const m of messages || []) {
    if (m.role === "system") system += (system ? "\n\n" : "") + extractText(m.content);
    else turns.push(`${m.role === "assistant" ? "Assistant" : "User"}: ${extractText(m.content)}`);
  }
  const lastUserText = [...turns].reverse().find((t) => t.startsWith("User:"))?.slice(6) ?? "";
  return { system, transcript: turns.join("\n\n"), lastUserText };
}

function anthropicToPrompt(body) {
  const system = typeof body.system === "string" ? body.system : extractText(body.system);
  const { transcript, lastUserText } = messagesToPrompt(body.messages);
  return { system, transcript, lastUserText };
}

// ── sessions ────────────────────────────────────────────────────────
const sessions = new Map();
function sessionEntry(key) {
  if (!sessions.has(key)) sessions.set(key, { sessionID: null, turns: 0, chain: Promise.resolve() });
  return sessions.get(key);
}

function upstreamError(r) {
  const msg =
    r.json?.data?.message ||
    r.json?.error?.message ||
    r.json?.message ||
    `opencode server returned ${r.status}`;
  const err = new Error(msg);
  err.status = r.status === 429 ? 429 : r.status === 400 ? 400 : r.status === 401 ? 401 : 502;
  return err;
}

async function ask({ key, system, modelId, transcript, lastUserText, onSession }) {
  const model = { modelID: modelId, providerID: "opencode" };
  if (!key) {
    const created = await ocReq("POST", "/session", {});
    if (created.status !== 200) throw upstreamError(created);
    const sid = created.json.id;
    onSession?.(sid);
    try {
      return await ocReq("POST", `/session/${sid}/message`, {
        ...(system ? { system } : {}),
        model,
        parts: [{ type: "text", text: transcript || lastUserText }],
      });
    } finally {
      ocReq("DELETE", `/session/${sid}`).catch((e) =>
        console.log(`[OC] temp session ${sid} not deleted:`, e.message)
      );
    }
  }
  const entry = sessionEntry(key);
  const run = entry.chain.then(async () => {
    if (!entry.sessionID) {
      const created = await ocReq("POST", "/session", {});
      if (created.status !== 200) throw upstreamError(created);
      entry.sessionID = created.json.id;
      entry.turns = 0;
    }
    onSession?.(entry.sessionID);
    const text = entry.turns === 0 ? (transcript || lastUserText) : lastUserText;
    entry.turns++;
    return ocReq("POST", `/session/${entry.sessionID}/message`, {
      ...(system ? { system } : {}),
      model,
      parts: [{ type: "text", text }],
    });
  });
  entry.chain = run.catch(() => {});
  return run;
}

// ── translation: opencode message → chat formats ────────────────────
function extractMessage(message) {
  let text = "";
  let reasoning = "";
  for (const p of message?.parts || []) {
    if (p.type === "text") text += p.text ?? "";
    else if (p.type === "reasoning") reasoning += p.text ?? "";
  }
  const tokens = message?.info?.tokens || {};
  return {
    text,
    reasoning,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    finish: message?.info?.finish,
  };
}

function mapFinish(finish) {
  return finish === "length" ? "length" : "stop";
}

const rid = (prefix) => prefix + crypto.randomBytes(12).toString("hex");

function openaiResponse(modelId, r) {
  return {
    id: rid("chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: r.text,
          ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
        },
        finish_reason: mapFinish(r.finish),
      },
    ],
    usage: {
      prompt_tokens: r.inputTokens,
      completion_tokens: r.outputTokens,
      total_tokens: r.inputTokens + r.outputTokens,
    },
  };
}

function writeSafe(res, s) {
  if (res.writableEnded || res.destroyed) return false;
  try { return res.write(s); } catch { return false; }
}

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function openaiSink(res, modelId) {
  const id = rid("chatcmpl-");
  const created = Math.floor(Date.now() / 1000);
  let opened = false;
  let sentText = "";
  let sentReasoning = "";
  const chunk = (delta, finish, usage) =>
    `data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  const open = () => {
    if (opened) return true;
    if (res.writableEnded || res.destroyed) return false;
    opened = true;
    sseHead(res);
    writeSafe(res, chunk({ role: "assistant" }));
    return true;
  };
  const rest = (full, sent) => (!sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "");
  return {
    get opened() { return opened; },
    delta(kind, text) {
      if (!open()) return;
      if (kind === "reasoning") { sentReasoning += text; writeSafe(res, chunk({ reasoning_content: text })); }
      else { sentText += text; writeSafe(res, chunk({ content: text })); }
    },
    finish(r) {
      if (!open()) return;
      const reasoning = rest(r.reasoning, sentReasoning);
      const text = rest(r.text, sentText);
      if (reasoning) writeSafe(res, chunk({ reasoning_content: reasoning }));
      if (text) writeSafe(res, chunk({ content: text }));
      writeSafe(res, chunk({}, mapFinish(r.finish), {
        prompt_tokens: r.inputTokens,
        completion_tokens: r.outputTokens,
        total_tokens: r.inputTokens + r.outputTokens,
      }));
      writeSafe(res, "data: [DONE]\n\n");
      try { res.end(); } catch {}
    },
    fail(message) {
      if (!open()) return;
      writeSafe(res, `data: ${JSON.stringify({ error: { message } })}\n\n`);
      writeSafe(res, "data: [DONE]\n\n");
      try { res.end(); } catch {}
    },
  };
}

function anthropicResponse(modelId, r) {
  return {
    id: rid("msg_"),
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "text", text: r.text }],
    stop_reason: r.finish === "length" ? "max_tokens" : "end_turn",
    usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
  };
}

function anthropicSink(res, modelId) {
  const id = rid("msg_");
  let opened = false;
  let block = null;
  let index = -1;
  let sentText = "";
  let sentReasoning = "";
  const send = (event, data) => writeSafe(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const openBlock = (type) => {
    if (block === type) return;
    if (block) send("content_block_stop", { type: "content_block_stop", index });
    index += 1;
    block = type;
    send("content_block_start", {
      type: "content_block_start",
      index,
      content_block: type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    });
  };
  const open = () => {
    if (opened) return true;
    if (res.writableEnded || res.destroyed) return false;
    opened = true;
    sseHead(res);
    send("message_start", {
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", content: [], model: modelId,
        stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    return true;
  };
  const rest = (full, sent) => (!sent ? full || "" : full && full.startsWith(sent) ? full.slice(sent.length) : "");
  const emit = (type, text) => {
    openBlock(type);
    send("content_block_delta", {
      type: "content_block_delta",
      index,
      delta: type === "thinking" ? { type: "thinking_delta", thinking: text } : { type: "text_delta", text },
    });
  };
  return {
    get opened() { return opened; },
    delta(kind, text) {
      if (!open()) return;
      if (kind === "reasoning") { sentReasoning += text; emit("thinking", text); }
      else { sentText += text; emit("text", text); }
    },
    finish(r) {
      if (!open()) return;
      const reasoning = rest(r.reasoning, sentReasoning);
      const text = rest(r.text, sentText);
      if (reasoning) { sentReasoning += reasoning; emit("thinking", reasoning); }
      if (text) { sentText += text; emit("text", text); }
      if (block) send("content_block_stop", { type: "content_block_stop", index });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: r.finish === "length" ? "max_tokens" : "end_turn" },
        usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
      });
      send("message_stop", { type: "message_stop" });
      try { res.end(); } catch {}
    },
    fail(message) {
      if (!open()) return;
      send("error", { type: "error", error: { type: "api_error", message } });
      try { res.end(); } catch {}
    },
  };
}

function connectEvents(watch) {
  let req = null;
  let done = false;
  let buf = "";
  const close = () => {
    if (done) return;
    done = true;
    try { req?.destroy(); } catch {}
  };
  const onFrame = (frame) => {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) return;
    let ev;
    try { ev = JSON.parse(line.slice(5)); } catch { return; }
    const p = ev.properties || {};
    if (!watch.sid || p.sessionID !== watch.sid) return;
    if (ev.type === "message.part.updated" && p.part && p.part.id) {
      watch.types.set(p.part.id, p.part.type);
    } else if (ev.type === "message.part.delta" && typeof p.delta === "string" && p.delta) {
      const kind = watch.types.get(p.partID) === "reasoning" ? "reasoning" : "text";
      watch.sink.delta(kind, p.delta);
    }
  };
  try {
    const u = new URL(ocBase + "/event");
    req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "GET",
        headers: { ...(ocAuth ? { Authorization: ocAuth } : {}) },
        timeout: REQUEST_TIMEOUT,
      },
      (r) => {
        r.setEncoding("utf8");
        r.on("data", (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            onFrame(frame);
          }
        });
        r.on("end", close);
        r.on("error", close);
      }
    );
    req.on("error", close);
    req.on("timeout", close);
    req.end();
  } catch {
    close();
  }
  return { close };
}

// ── HTTP API ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

// Landing Route for browser checks
app.get("/", (_req, res) => {
  res.json({
    status: backendError ? "backend_initializing_or_error" : "online",
    backend: ocBase || null,
    error: backendError,
    endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models", "/health"],
  });
});

app.get("/v1/models", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: { message: "Invalid API key" } });
  try {
    const models = await getModels();
    res.json({
      object: "list",
      data: models.map((id) => ({ id, object: "model", created: 1779000000, owned_by: "opencode" })),
    });
  } catch (e) {
    res.status(502).json({ error: { message: e.message, type: "upstream_error" } });
  }
});

app.post("/v1/chat/completions", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ error: { message: "Invalid API key" } });
  let sink = null;
  let watch = null;
  try {
    const { model, messages, stream, user: userId } = req.body || {};
    const modelId = String(model || "").replace(/^opencode\//, "");
    const models = await getModels();
    if (!models.includes(modelId)) {
      return res.status(400).json({
        error: { message: `Unknown model: ${modelId}. Available: ${models.join(", ")}` },
      });
    }
    const { system, transcript, lastUserText } = messagesToPrompt(messages);
    if (!lastUserText) return res.status(400).json({ error: { message: "No user message in request" } });
    const key = req.headers["x-oc-session"] || userId || null;
    if (stream) {
      sink = openaiSink(res, modelId);
      watch = { sid: null, types: new Map(), sink, conn: null };
      watch.conn = connectEvents(watch);
      res.on("close", () => watch.conn.close());
    }
    const r = await ask({
      key, system, modelId, transcript, lastUserText,
      onSession: (sid) => { if (watch) watch.sid = sid; },
    });
    if (r.status !== 200) throw upstreamError(r);
    const extracted = extractMessage(r.json);
    if (!extracted.text && !extracted.reasoning && !(sink && sink.opened)) {
      throw new Error("empty response from opencode");
    }
    if (stream) return sink.finish(extracted);
    return res.json(openaiResponse(modelId, extracted));
  } catch (e) {
    if (sink && sink.opened) return sink.fail(e.message);
    return res.status(e.status || 502).json({ error: { message: e.message, type: "upstream_error" } });
  } finally {
    watch?.conn?.close();
  }
});

app.post("/v1/messages", async (req, res) => {
  if (!auth(req)) return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  let sink = null;
  let watch = null;
  try {
    const { model, stream, metadata } = req.body || {};
    const modelId = String(model || "").replace(/^opencode\//, "");
    const models = await getModels();
    if (!models.includes(modelId)) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: `Unknown model: ${modelId}. Available: ${models.join(", ")}` },
      });
    }
    const { system, transcript, lastUserText } = anthropicToPrompt(req.body);
    if (!lastUserText) {
      return res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "No user message in request" },
      });
    }
    const key = req.headers["x-oc-session"] || metadata?.user_id || null;
    if (stream) {
      sink = anthropicSink(res, modelId);
      watch = { sid: null, types: new Map(), sink, conn: null };
      watch.conn = connectEvents(watch);
      res.on("close", () => watch.conn.close());
    }
    const r = await ask({
      key, system, modelId, transcript, lastUserText,
      onSession: (sid) => { if (watch) watch.sid = sid; },
    });
    if (r.status !== 200) throw upstreamError(r);
    const extracted = extractMessage(r.json);
    if (!extracted.text && !extracted.reasoning && !(sink && sink.opened)) {
      throw new Error("empty response from opencode");
    }
    if (stream) return sink.finish(extracted);
    return res.json(anthropicResponse(modelId, extracted));
  } catch (e) {
    if (sink && sink.opened) return sink.fail(e.message);
    return res.status(e.status || 502).json({
      type: "error",
      error: { type: e.status === 429 ? "rate_limit_error" : "upstream_error", message: e.message },
    });
  } finally {
    watch?.conn?.close();
  }
});

app.get("/health", (_req, res) =>
  res.json({
    status: backendError ? "error" : "ok",
    backendError: backendError || null,
    opencode: ocBase,
    models: modelCache ? modelCache.length : 0,
  })
);

// ── start ───────────────────────────────────────────────────────────

app.listen(PROXY_PORT, "0.0.0.0", async () => {
  console.log(`oc-api-proxy running on port ${PROXY_PORT}`);
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  try {
    await startBackend();
    const models = await getModels();
    console.log("  Models:", models.join(", "));
  } catch (e) {
    backendError = e.message;
    console.error("  Failed to start opencode backend:", e.message);
    // Keep server running so Hostinger doesn't fail with a 503 and logs remain viewable
  }
  for (const [name, key] of Object.entries(apiKeys)) console.log(`  ${name.padEnd(15)} ${key}`);
});
