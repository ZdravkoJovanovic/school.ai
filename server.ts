import { config } from 'dotenv';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import OpenAI from 'openai';

config();

const app = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);

// OpenAI Client lazy init
function getOpenAIClient(): OpenAI {
  const apiKey = (process.env.OPENAI_API_KEY || process.env.OPEN_AI_SECRET_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY/OPEN_AI_SECRET_KEY');
  }
  return new OpenAI({ apiKey });
}
const MODEL = (process.env.OPENAI_MODEL || 'gpt-5').trim();

// Professor System Prompt (nur als Präfix, UI/Flows bleiben bestehen)
const PROFESSOR_SYSTEM_PROMPT = `Du bist ein geduldiger Mathematik‑Professor. Erkläre jedes Thema so, als hätte die Person es noch nie gehört. Arbeite immer in diesem Format:
[PARSE] Zielaufgabe, gegebene/nötige Formeln, Annahmen/Unklarheiten.
[PLAN] 3–7 Mikro‑Ziele (vom Einfachen zum Ziel).
[TEACH] Schritt 1…n: kurze Erklärung + Mini‑Frage.
[VERIFY] kurze Checks (symbolisch/numerisch) + Domäne/Sonderfälle.
[QUIZ] 2–3 Mini‑Aufgaben mit kurzer Lösung/Warum.
[SUMMARY] Merksatz in 1 Zeile.
[NEXT] nächster Lernschritt.
Sprache: Deutsch. Prägnant, keine Sprünge, Standard‑Notation.`;

// View engine setup (robust for ts-node and dist builds)
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/', (req: Request, res: Response) => {
  res.render('index');
});

// Chat Endpoint (non-streaming)
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { messages } = req.body as { messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>; };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const openai = getOpenAIClient();

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: PROFESSOR_SYSTEM_PROMPT }, ...messages],
    });

    const output = response.choices?.[0]?.message?.content ?? '';
    res.json({ reply: output });
  } catch (err: any) {
    if (err?.message?.startsWith('Missing OPENAI_API_KEY')) {
      return res.status(500).json({ error: 'OPENAI_API_KEY oder OPEN_AI_SECRET_KEY fehlt in .env' });
    }
    const detail = err?.response?.data || err?.message || err;
    console.error('OpenAI error:', detail);
    res.status(500).json({ error: 'OpenAI request failed', detail });
  }
});

// Chat Streaming Endpoint (chunked text)
app.post('/api/chat/stream', async (req: Request, res: Response) => {
  try {
    const { messages } = req.body as { messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>; };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const openai = getOpenAIClient();

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: PROFESSOR_SYSTEM_PROMPT }, ...messages],
      stream: true,
    });

    for await (const part of stream as any) {
      const delta: string = part?.choices?.[0]?.delta?.content || '';
      if (delta) res.write(delta);
    }
    res.end();
  } catch (err: any) {
    const msg = err?.message?.startsWith('Missing OPENAI_API_KEY')
      ? 'OPENAI_API_KEY oder OPEN_AI_SECRET_KEY fehlt in .env'
      : (err?.response?.data || err?.message || 'OpenAI request failed');
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    } else {
      res.end();
    }
  }
});

// Sketch Endpoint – erzeugt normiertes Vektor-JSON (didaktisch)
app.post('/api/sketch', async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body as { prompt: string };
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt required' });
    }

    const openai = getOpenAIClient();

    const system = `Du bist ein Zeichenassistent für Unterricht. Antworte ausschließlich mit einem JSON-Objekt:
{
  "layers": [
    {"name":"Achsen","strokes":[{"type":"path","points":[[0.1,0.9],[0.9,0.9]],"width":0.002,"color":"#ffffff"}, {"type":"path","points":[[0.1,0.9],[0.1,0.1]],"width":0.002,"color":"#ffffff"}]},
    {"name":"Objekt","strokes":[{"type":"path","points":[[0.2,0.8],[0.3,0.7]],"width":0.003,"color":"#ffffff"}]},
    {"name":"Beschriftung","strokes":[{"type":"text","position":[0.85,0.92],"text":"x","size":0.03,"color":"#ffffff"}]}
  ],
  "steps": ["Achsengerüst", "Kurve/Objekt", "Markierungen/Labels"]
}
Regeln: Koordinaten/Längen normiert [0,1], Farbe default #ffffff, max ~400 Punkte, keine Zusatztexte/Markdown – nur reines JSON.`;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Skizziere didaktisch: ${prompt}` },
      ],
    });

    const content = completion.choices?.[0]?.message?.content ?? '';
    let sketch: any;
    try {
      sketch = JSON.parse(content);
    } catch {
      return res.status(500).json({ error: 'Sketch JSON konnte nicht geparst werden', raw: content });
    }
    if (!sketch?.layers && !sketch?.strokes) {
      return res.status(500).json({ error: 'Ungültiges Sketch-Format', raw: content });
    }
    res.json({ sketch });
  } catch (err: any) {
    const msg = err?.message?.startsWith('Missing OPENAI_API_KEY')
      ? 'OPENAI_API_KEY oder OPEN_AI_SECRET_KEY fehlt in .env'
      : (err?.response?.data || err?.message || 'OpenAI request failed');
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
