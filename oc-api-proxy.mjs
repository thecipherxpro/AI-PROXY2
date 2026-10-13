import express from 'express';
import cors from 'cors';

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-opencode-client', 'x-opencode-session']
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

// Generates OpenCode canonical ID shape: <prefix>_<12 hex timestamp><14 base62 random>
function generateCanonicalId(prefix) {
  const hex12 = Math.floor(Date.now()).toString(16).padStart(12, '0').slice(-12);
  const base62Chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let base62Tail = '';
  for (let i = 0; i < 14; i++) {
    base62Tail += base62Chars.charAt(Math.floor(Math.random() * base62Chars.length));
  }
  return `${prefix}_${hex12}${base62Tail}`;
}

// Client API key validator: enforces key if configured in Hostinger, otherwise open/public
function checkClientAuth(req, res, next) {
  const configuredKey = process.env.API_KEY || process.env.PROXY_API_KEY;
  if (!configuredKey) {
    return next(); // Public mode: No key required
  }

  const rawAuth = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const incomingKey = rawAuth.replace(/^Bearer\s+/i, '').trim();

  if (incomingKey !== configuredKey.trim()) {
    return res.status(401).json({
      error: {
        message: 'Unauthorized: Invalid or missing API key',
        type: 'invalid_request_error'
      }
    });
  }
  next();
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    domain: 'ai.genzee.lt',
    service: 'OpenCode Free Model Bypass Proxy'
  });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/debug', (req, res) => {
  const envToken = process.env.OPENCODE_SESSION_TOKEN;
  const configuredKey = process.env.API_KEY || process.env.PROXY_API_KEY;
  res.status(200).json({
    domain: 'ai.genzee.lt',
    hasEnvToken: !!envToken && envToken !== 'public',
    tokenPreview: envToken ? `${envToken.substring(0, 8)}...` : 'NONE',
    requiresApiKey: !!configuredKey
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

app.post('/v1/chat/completions', checkClientAuth, async (req, res) => {
  try {
    const { model, messages, stream, temperature, top_p } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Messages array is required' } });
    }

    // Upstream token selection: Default to 'Bearer public' for OpenCode Free Tier
    const envToken = process.env.OPENCODE_SESSION_TOKEN;
    let activeToken = 'Bearer public';
    if (envToken && envToken !== 'public' && !envToken.startsWith('oc_sk_')) {
      activeToken = envToken.startsWith('Bearer ') ? envToken : `Bearer ${envToken}`;
    }

    const targetModel = MODEL_MAP[model] || 'big-pickle';
    const upstreamUrl = 'https://opencode.ai/zen/v1/chat/completions';

    // Strictly match OpenCode gateway requirements
    const bypassHeaders = {
      'Content-Type': 'application/json',
      'Authorization': activeToken,
      'User-Agent': 'opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
      'x-opencode-client': 'cli',
      'x-opencode-version': '1.18.31',
      'x-opencode-project': 'global',
      'x-opencode-session': generateCanonicalId('ses'),
      'x-opencode-request': generateCanonicalId('msg')
    };

    // OpenCode gateway requires stream: true
    const upstreamResponse = await fetch(upstreamUrl, {
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

    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      try {
        return res.status(upstreamResponse.status).json(JSON.parse(errText));
      } catch (e) {
        return res.status(upstreamResponse.status).send(errText);
      }
    }

    // Handle streaming request from client
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

    // Handle non-streaming request from client by aggregating stream SSE text
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.delta?.text || '';
            accumulatedContent += delta;
          } catch (e) {
            // Ignore partial SSE JSON parse errors
          }
        }
      }
    }

    // Return standard OpenAI non-stream response object
    return res.status(200).json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: targetModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: accumulatedContent
          },
          finish_reason: 'stop'
        }
      ]
    });

  } catch (error) {
    console.error('Bypass Proxy Error:', error);
    return res.status(500).json({ error: { message: 'Proxy forwarding failed', details: error.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bypass Proxy running on port ${PORT} for ai.genzee.lt`);
});
