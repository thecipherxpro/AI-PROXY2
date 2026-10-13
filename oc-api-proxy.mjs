import express from 'express';
import cors from 'cors';

const app = express();

app.use(cors({ origin: '*' }));
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

// Generates canonical IDs: msg_<12 hex><14 base62> or ses_<12 hex><14 base62>
function generateCanonicalId(prefix) {
  const hex12 = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const base62_14 = Array.from({ length: 14 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${prefix}_${hex12}${base62_14}`;
}

// Required default 6 OpenCode CLI tools
const DEFAULT_OPENCODE_TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'Execute bash commands', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'edit', description: 'Edit a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files matching a pattern', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search for string in files', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'read', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write', description: 'Write contents to file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }
];

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
    data: Object.keys(MODEL_MAP).map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'opencode-zen' }))
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, stream, tools, temperature, top_p } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: { message: 'Messages array is required' } });
    }

    const incomingAuth = req.headers['authorization'];
    const envToken = process.env.OPENCODE_SESSION_TOKEN;
    let activeToken = 'Bearer public';

    if (incomingAuth && incomingAuth !== 'Bearer test' && incomingAuth !== 'Bearer public') {
      activeToken = incomingAuth;
    } else if (envToken && envToken !== 'public') {
      activeToken = envToken.startsWith('Bearer ') ? envToken : `Bearer ${envToken}`;
    }

    const targetModel = MODEL_MAP[model] || 'big-pickle';
    const upstreamUrl = 'https://opencode.ai/zen/v1/chat/completions';
    const finalTools = (tools && tools.length > 0) ? tools : DEFAULT_OPENCODE_TOOLS;

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

    const isStreamRequested = !!stream;
    
    // Always request stream: true upstream to satisfy free tier gate
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: bypassHeaders,
      body: JSON.stringify({
        model: targetModel,
        messages,
        tools: finalTools,
        stream: true,
        ...(temperature !== undefined && { temperature }),
        ...(top_p !== undefined && { top_p })
      })
    });

    if (!upstreamResponse.ok) {
      const errData = await upstreamResponse.json().catch(() => ({}));
      return res.status(upstreamResponse.status).json(errData);
    }

    if (isStreamRequested && upstreamResponse.body) {
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
    } else {
      // Consume SSE stream and return standard OpenAI JSON object for non-stream clients
      const text = await upstreamResponse.text();
      let fullContent = '';
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(line.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content || '';
            fullContent += delta;
          } catch (e) {}
        }
      }

      return res.status(200).json({
        id: generateCanonicalId('chatcmpl'),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: targetModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: fullContent },
          finish_reason: 'stop'
        }]
      });
    }

  } catch (error) {
    console.error('Bypass Proxy Error:', error);
    return res.status(500).json({ error: { message: 'Proxy forwarding failed', details: error.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bypass Proxy running on port ${PORT} for AI.cpxs.ca`);
});
