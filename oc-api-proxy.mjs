import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-opencode-client', 'x-opencode-session', 'anthropic-version']
}));

app.use(express.json({ limit: '10mb' }));

const MODEL_MAP = {
  'big-pickle': 'big-pickle',
  'mimo-v2.6-flash-free': 'mimo-v2.6-flash-free',
  'mimo-v2.5-free': 'mimo-v2.5-free',
  'minimax-m2.5-free': 'minimax-m2.5-free',
  'qwen3.6-plus-free': 'qwen3.6-plus-free',
  'space-bunny-free': 'space-bunny-free',
  'longcat-2.5-preview-free': 'longcat-2.5-preview-free',
  'deepseek-v4-flash-free': 'big-pickle'
};

function sanitizeEnvVar(value) {
  if (!value) return '';
  return value.trim().replace(/^["']|["']$/g, '');
}

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastTimestamp = 0;
let idCounter = 0;

function createOpencodeId(prefix, descending = false) {
  const timestamp = Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter++;

  // OpenCode 48-bit layout: BigInt(timestamp) * 0x1000n + BigInt(idCounter)
  const current = BigInt(timestamp) * 0x1000n + BigInt(idCounter);
  const value = descending ? ~current : current;

  // 6 bytes (12 hex chars)
  let timeHex = '';
  for (let i = 0; i < 6; i++) {
    const byte = Number((value >> BigInt(40 - 8 * i)) & 0xffn);
    timeHex += byte.toString(16).padStart(2, '0');
  }

  // 14 base62 random characters
  let tail = '';
  const randomBytes = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) {
    tail += BASE62_CHARS[randomBytes[i] % 62];
  }

  return `${prefix}_${timeHex}${tail}`;
}

function loadValidApiKeys() {
  const filePath = path.resolve(process.cwd(), 'api-keys.json');
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) return parsed.map(k => String(k).trim());
      if (parsed.keys && Array.isArray(parsed.keys)) return parsed.keys.map(k => String(k).trim());
    }
  } catch (err) {
    // If api-keys.json is missing or invalid, do not crash
  }
  const fallbackKey = sanitizeEnvVar(process.env.PROXY_API_KEY);
  return fallbackKey ? [fallbackKey] : [];
}

function isAuthorizedClient(req) {
  const validKeys = loadValidApiKeys();
  if (validKeys.length === 0) return true; // Open access if no local keys defined

  const rawHeader = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const incomingKey = rawHeader.replace(/^Bearer\s+/i, '').trim();
  return validKeys.includes(incomingKey);
}

async function callOpenCodeUpstream(targetModel, messages, temperature, top_p) {
  const rawOpenCodeToken = sanitizeEnvVar(process.env.OPENCODE_SESSION_TOKEN) || 'public';
  const upstreamAuth = rawOpenCodeToken.startsWith('Bearer ') ? rawOpenCodeToken : `Bearer ${rawOpenCodeToken}`;
  const upstreamUrl = 'https://opencode.ai/zen/v1/chat/completions';

  // ses_ MUST be descending (true); msg_ MUST be ascending (false)
  const sessionId = createOpencodeId('ses', true);
  const requestId = createOpencodeId('msg', false);

  const bypassHeaders = {
    'Content-Type': 'application/json',
    'Authorization': upstreamAuth,
    'User-Agent': 'opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
    'x-opencode-client': 'cli',
    'x-opencode-version': '1.18.32',
    'x-opencode-project': 'prj_0000000000000000',
    'x-opencode-session': sessionId,
    'x-opencode-request': requestId,
    'x-session-affinity': sessionId,
    'x-session-id': sessionId
  };

  return await fetch(upstreamUrl, {
    method: 'POST',
    headers: bypassHeaders,
    body: JSON.stringify({
      model: targetModel,
      messages,
      stream: true,
      ...(temperature !== undefined && { temperature }),
      ...(top_p !== undefined && { top_p })
    })
  });
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    domain: 'ai.genzee.lt',
    service: 'OpenCode Free Model Dual Proxy'
  });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/debug', (req, res) => {
  const envToken = sanitizeEnvVar(process.env.OPENCODE_SESSION_TOKEN);
  const loadedKeys = loadValidApiKeys();
  res.status(200).json({
    domain: 'ai.genzee.lt',
    hasOpenCodeToken: !!envToken && envToken !== 'public',
    openCodeTokenPreview: envToken ? `${envToken.substring(0, 8)}...` : 'NONE',
    activeKeysCount: loadedKeys.length,
    openAccess: loadedKeys.length === 0
  });
});

app.get('/v1/models', (req, res) => {
  res.status(200).json({
    object: 'list',
    data: Object.keys(MODEL_MAP).map(id => ({
      id,
      object: 'model',
      created: 1700000000,
      owned_by: 'opencode-zen'
    }))
  });
});

// 1. OpenAI Endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    if (!isAuthorizedClient(req)) {
      return res.status(401).json({
        error: { message: 'Unauthorized: Invalid API key', type: 'invalid_request_error' }
      });
    }

    const { model, messages, stream, temperature, top_p } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Messages array is required' } });
    }

    const targetModel = MODEL_MAP[model] || 'big-pickle';
    const upstreamResponse = await callOpenCodeUpstream(targetModel, messages, temperature, top_p);

    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      try {
        return res.status(upstreamResponse.status).json(JSON.parse(errText));
      } catch (e) {
        return res.status(upstreamResponse.status).send(errText);
      }
    }

    if (stream && upstreamResponse.body) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = upstreamResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      return res.end();
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedContent = '';
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.delta?.text || '';
            accumulatedContent += delta;
          } catch (e) {
            // Ignore incomplete chunks
          }
        }
      }
    }

    return res.status(200).json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: targetModel,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: accumulatedContent },
          finish_reason: 'stop'
        }
      ]
    });

  } catch (error) {
    console.error('OpenAI Proxy Error:', error);
    return res.status(500).json({ error: { message: 'Proxy forwarding failed', details: error.message } });
  }
});

// 2. Anthropic Endpoint
app.post('/v1/messages', async (req, res) => {
  try {
    if (!isAuthorizedClient(req)) {
      return res.status(401).json({
        error: { type: 'authentication_error', message: 'Unauthorized: Invalid API key.' }
      });
    }

    const { model, messages, system, temperature } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { type: 'invalid_request_error', message: 'messages array is required' } });
    }

    const formattedMessages = [];
    if (system) {
      formattedMessages.push({
        role: 'system',
        content: typeof system === 'string' ? system : JSON.stringify(system)
      });
    }

    for (const msg of messages) {
      const contentStr = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '');
      formattedMessages.push({ role: msg.role, content: contentStr });
    }

    const targetModel = MODEL_MAP[model] || 'big-pickle';
    const upstreamResponse = await callOpenCodeUpstream(targetModel, formattedMessages, temperature);

    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      try {
        return res.status(upstreamResponse.status).json(JSON.parse(errText));
      } catch (e) {
        return res.status(upstreamResponse.status).send(errText);
      }
    }

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedContent = '';
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.delta?.text || '';
            accumulatedContent += delta;
          } catch (e) {
            // Ignore incomplete chunks
          }
        }
      }
    }

    return res.status(200).json({
      id: generateCanonicalId('msg'),
      type: 'message',
      role: 'assistant',
      model: targetModel,
      content: [{ type: 'text', text: accumulatedContent }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    });

  } catch (error) {
    console.error('Anthropic Proxy Error:', error);
    return res.status(500).json({ error: { type: 'api_error', message: 'Proxy forwarding failed', details: error.message } });
  }
});

// Dynamic port assignment for Hostinger / Phusion Passenger
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy listening on dynamic port ${PORT} for ai.genzee.lt`);
});
