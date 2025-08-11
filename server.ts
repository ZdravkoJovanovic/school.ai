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

    const system = `Du bist ein Zeichenassistent für Unterricht im Notizblatt-Stil. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, keine Erklärsätze.
Schema:
{
  "layers": [
    {"name":"Schritt 1","strokes":[ ... ]},
    {"name":"Schritt 2","strokes":[ ... ]},
    {"name":"Tipps","strokes":[ ... ]}
  ],
  "steps": ["Kurzer Titel für Schritt 1","…"]
}
Strokes:
- {"type":"text","position":[x,y],"text":"…","size":0.045,"color":"#ffffff"}
Vorgaben:
- Nur TEXT-Strokes erzeugen; keine Pfade, keine Kreise, keine Deko‑Linien.
- KEINE Koordinatenachsen/Gitter.
- Stil: digitales Notizblatt; klare Abschnittstitel, darunter kurze, sehr verständliche Bullet‑Erklärungen und Formeln.
- Fläche maximal nutzen: linksbündig, oben starten, bis ~92% Breite; kleine Ränder; ausreichend Zeilenabstand.
- Struktur: 1) Idee/Definition, 2) Regeln/Formeln, 3) Schritt‑für‑Schritt mini Herleitung, 4) Mini‑Beispiel mit konkreten Zahlen (Ende der Seite), 5) typische Fehler.
- Farbe standard #ffffff. Nur JSON ohne Markdown.`;

    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Skizziere didaktisch (nutze nur Text, fülle die Fläche mit maximal vielen, leicht verständlichen Punkten, beende mit einem kurzen Zahlenbeispiel): ${prompt}` },
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
