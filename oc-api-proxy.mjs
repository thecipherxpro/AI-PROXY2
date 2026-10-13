import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-opencode-client', 'x-opencode-session']
}));

app.use(express.json({ limit: '10mb' }));

// Active OpenCode Zen Free Models Map
const MODEL_MAP = {
  'big-pickle': 'big-pickle',
  'mimo-v2.6-flash-free': 'mimo-v2.6-flash-free',
  'mimo-v2.5-free': 'mimo-v2.5-free',
  'minimax-m2.5-free': 'minimax-m2.5-free',
  'qwen3.6-plus-free': 'qwen3.6-plus-free',
  'space-bunny-free': 'space-bunny-free',
  'longcat-2.5-preview-free': 'longcat-2.5-preview-free',
  // Legacy aliases mapped to active models
  'deepseek-v4-flash-free': 'big-pickle'
};

function generateOpenCodeSession() {
  const hexTimestamp = Math.floor(Date.now()).toString(16);
  const randomTail = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `ses_${hexTimestamp}${randomTail}`;
}

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    domain: 'ai.genzee.lt',
    service: 'OpenCode Free Model Bypass Proxy'
  });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

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

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream, temperature, top_p } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Messages array is required' } });
    }

    // Retrieve Hostinger environment token or fall back to public
    const rawToken = process.env.OPENCODE_SESSION_TOKEN || 'public';
    const authToken = rawToken.startsWith('Bearer ') ? rawToken : `Bearer ${rawToken}`;

    const targetModel = MODEL_MAP[model] || 'big-pickle';
    const upstreamUrl = 'https://opencode.ai/zen/v1/chat/completions';

    const bypassHeaders = {
      'Content-Type': 'application/json',
      'Authorization': authToken,
      'User-Agent': 'opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14',
      'x-opencode-client': 'cli',
      'x-opencode-version': '1.18.32',
      'x-opencode-project': 'global',
      'x-opencode-session': generateOpenCodeSession(),
      'x-opencode-request': `msg_${Math.random().toString(36).substring(2, 12)}`
    };

    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: bypassHeaders,
      body: JSON.stringify({
        model: targetModel,
        messages,
        stream: !!stream,
        ...(temperature !== undefined && { temperature }),
        ...(top_p !== undefined && { top_p })
      })
    });

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

    const data = await upstreamResponse.json();
    return res.status(upstreamResponse.status).json(data);

  } catch (error) {
    console.error('Bypass Proxy Error:', error);
    return res.status(500).json({ error: { message: 'Proxy forwarding failed', details: error.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bypass Proxy running on port ${PORT} for AI.cpxs.ca`);
});
