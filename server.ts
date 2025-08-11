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

// Chat Endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { messages } = req.body as { messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>; };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const openai = getOpenAIClient();

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      // Kein temperature-Parameter: einige Modelle akzeptieren nur den Default
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

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
