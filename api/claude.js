// /api/claude.js
// Vercel serverless function (Node.js runtime).
//
// Contract (matches the frontend's callClaude() in index.html exactly):
//   Request  (POST, JSON): { system, prompt, image, mode }
//     - system : string  — system prompt for this feature (ask / improve-note / concepts / quiz-gen / quiz-eval)
//     - prompt : string  — user-turn content, already scoped to relevant context by the frontend
//     - image  : string  — OPTIONAL. A data URL (e.g. "data:image/png;base64,....") for
//                          screenshot-analysis style requests. Omitted for text-only calls.
//     - mode   : string  — which feature is calling (used only for logging/debugging here;
//                          the frontend already tailors `system`/`prompt` per mode)
//
//   Response (JSON): { text }             on success
//                     { error }           on failure (non-2xx status)
//
// The Anthropic API key is read ONLY from process.env.ANTHROPIC_API_KEY on the server.
// It is never sent to, or readable by, the browser.

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 1024;

function setCors(res) {
  // Permissive CORS so the frontend can be hosted separately from this API
  // (e.g. tested locally as a plain file, or deployed to a different origin).
  // If you deploy frontend + backend to the same Vercel project/domain, this
  // is not strictly required, but it's harmless to leave on.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseDataUrl(dataUrl) {
  // "data:image/png;base64,AAAA..." -> { mediaType, data }
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fails loudly and clearly rather than silently — this is a server
    // misconfiguration (env var not set in Vercel), not a client error.
    res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Add it in Vercel → Project → Settings → Environment Variables, then redeploy.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { system, prompt, image, mode } = body || {};

  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'Request must include a non-empty "prompt" string.' });
    return;
  }

  // Build the user message content, optionally attaching an image (used for
  // captured-frame analysis; only included when the frontend actually sends one —
  // per the app's accuracy rules, Claude should never be told it "saw" a frame
  // unless the image was genuinely supplied).
  const userContent = [];
  if (image) {
    const parsed = parseDataUrl(image);
    if (parsed) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data }
      });
    }
  }
  userContent.push({ type: 'text', text: prompt });

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        system: system || undefined,
        messages: [{ role: 'user', content: userContent }]
      })
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      console.error(`[api/claude] Anthropic API error (mode=${mode}):`, data);
      res.status(anthropicRes.status).json({
        error: (data && data.error && data.error.message) || 'Anthropic API request failed.'
      });
      return;
    }

    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    res.status(200).json({ text });
  } catch (err) {
    console.error(`[api/claude] Request failed (mode=${mode}):`, err);
    res.status(502).json({ error: 'Could not reach the Anthropic API. Try again shortly.' });
  }
};
