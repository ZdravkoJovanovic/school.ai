import { config } from 'dotenv';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import OpenAI from 'openai';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

config();

const app = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);
const HOST: string = (process.env.HOST || '0.0.0.0').trim();

// OpenAI Client lazy init
function getOpenAIClient(): OpenAI {
  const apiKey = (process.env.OPENAI_API_KEY || process.env.OPEN_AI_SECRET_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY/OPEN_AI_SECRET_KEY');
  }
  return new OpenAI({ apiKey });
}
const MODEL = (process.env.OPENAI_MODEL || 'gpt-5').trim();

// Professor System Prompt – einfache, schülerfreundliche Antworten
const PROFESSOR_SYSTEM_PROMPT = `Rolle: geduldiger Mathe‑Lehrer für 8.–12. Klasse. Sprich einfach, kurze Sätze.
Wenn der Nutzer eine komplexe Frage stellt, formuliere zuerst eine sehr einfache Version der Frage.
Antworte IMMER in dieser klaren Struktur:
1) Einfache Formulierung: 1 kurze Zeile (so würde man die Frage in einfach sagen)
2) Kurzantwort: 1 Satz (Ja/Nein/Ergebnis in Kürze)
3) Schritt‑für‑Schritt (3–5 kurze Schritte):
   - Gegeben (K0, p, i, n, m, …) in einfachen Worten
   - Passende Formel in Standard‑Notation
   - Einsetzen der Werte
   - Rechnen (nur die wichtigsten Zwischenschritte)
4) Ergebnis + Einheit (klar und fett markiert, falls möglich)
5) Warum stimmt das? (1–2 kurze Hinweise)
6) Rückfrage: eine kleine Frage, ob noch etwas vertieft werden soll
Hinweise:
- Keine Fachfloskeln, keine langen Absätze. Maximal 2 kurze Sätze pro Bullet.
- Zahlen und Einheiten immer nennen. Runden am Ende.
- Wenn etwas fehlt/unklar ist: kurz nachfragen, dann Vorschlag machen.
Sprache: Deutsch.`;

// View engine setup (robust for ts-node and dist builds)
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));

// S3 Setup
const S3_REGION = process.env.AWS_REGION || '';
const S3_BUCKET = process.env.AWS_S3_BUCKET || '';
let s3Client: S3Client | null = null;
function getS3(){
  if (!s3Client) s3Client = new S3Client({ region: S3_REGION });
  return s3Client;
}

// Presign Upload (Direct Upload vom Browser via fetch/PUT)
app.post('/api/uploads/presign', async (req: Request, res: Response) => {
  try {
    const { contentType } = req.body as { contentType: string };
    if (!S3_BUCKET || !S3_REGION) return res.status(500).json({ error: 'AWS_S3_BUCKET oder AWS_REGION fehlt' });
    const key = `uploads/${randomUUID()}`;
    const cmd = new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType || 'application/octet-stream' });
    const url = await getSignedUrl(getS3(), cmd, { expiresIn: 60 });
    res.json({ url, key, bucket: S3_BUCKET });
  } catch (e:any) {
    res.status(500).json({ error: 'presign failed', detail: e?.message || e });
  }
});

// Placeholder: Upload-Liste (später aus Postgres)
app.get('/api/uploads', async (_req: Request, res: Response) => {
  res.json({ items: [] });
});

app.get('/', (req: Request, res: Response) => {
  res.render('index');
});

// Neue Route: /folder (nur Navbar + gleiche BG)
app.get('/folder', (req: Request, res: Response) => {
  res.render('folder');
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

    async function chatJSON(system: string, user: string): Promise<any> {
      const r = await openai.chat.completions.create({ model: MODEL, messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]});
      const content = r.choices?.[0]?.message?.content ?? '';
      try { return JSON.parse(content); } catch { return { raw: content }; }
    }

    async function genAufgabe(p: string): Promise<string> {
      const sys = `Gib AUSSCHLIESSLICH JSON: {"aufgabe": string}.
Schreibe eine realistische, einfache Klausur-Aufgabe (3-6 ganze Sätze) zum Thema Zinsrechnung.
Erkläre kurz die Begriffe in Worten (K0 Startbetrag, p Zinssatz/Jahr, t Laufzeit in Jahren, optional m Perioden/Jahr).
Nenne gegebene Werte textlich, aber KEINE Rechnung/KEIN Ergebnis.`;
      for (let i=0;i<2;i++){
        const j = await chatJSON(sys, `Thema: ${p}`);
        const s = (j?.aufgabe || '').toString().trim();
        if (s.length > 60) return s;
      }
      return 'Aufgabe: Du erhältst eine typische Zins-Aufgabe. Formuliere Werte und Ziel ohne zu rechnen.';
    }

    async function genLoesung(aufgabe: string): Promise<{schritte: string[]; ergebnis?: string}> {
      const sys = `Gib JSON: {"schritte": string[], "ergebnis"?: string}.
Formuliere eine Lösung in 5-9 einfachen Schritten (ganze Sätze + Formeln). Nutze Standard-Notation (K0, i=p/100, t in Jahren, Kn=K0*(1+i)^n bzw. Z=K0*i*t bei einfacher Verzinsung). Runden am Ende. Einheit nennen.`;
      const j = await chatJSON(sys, aufgabe);
      const arr = Array.isArray(j?.schritte) ? j.schritte.map((x: any)=> String(x)).filter(Boolean) : [];
      return { schritte: arr.slice(0, 9), ergebnis: (j?.ergebnis? String(j.ergebnis) : undefined) };
    }

    async function review(aufgabe: string, loesung: string[]): Promise<{ok:boolean;hint?:string}> {
      const sys = `Beurteile knapp, ob Lösung zur Aufgabe passt und vollständig ist (5-9 Schritte, Formeln+Einsetzen, Ergebnis mit Einheit). Antworte nur als JSON: {"ok": boolean, "hint"?: string}.`;
      const j = await chatJSON(sys, `Aufgabe:\n${aufgabe}\nLösung:\n${loesung.join('\n')}`);
      return { ok: Boolean(j?.ok), hint: j?.hint ? String(j.hint) : undefined };
    }

    function buildExamLayer(aufgabe: string, loesung: string[]): any {
      const aText = `Aufgabe: ${aufgabe}`;
      const lText = `Lösung:\n${loesung.join('\n')}`;
      return {
        name: 'Klausurbeispiel',
        strokes: [
          { type: 'text', position: [0.82, 0.10], text: aText, size: 0.032, color: '#ffffff' },
          { type: 'text', position: [0.82, 0.58], text: lText, size: 0.032, color: '#ffffff' },
        ]
      };
    }

    const system = `Du bist ein Zeichenassistent für Unterricht im Notizblatt-Stil. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, keine Erklärsätze.
Schema:
{
  "layers": [
    {"name":"Schritt 1","strokes":[ ... ]},
    {"name":"Schritt 2","strokes":[ ... ]},
    {"name":"Tipps","strokes":[ ... ]}
    ,{"name":"Klausurbeispiel","strokes":[ ... ]}
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
- Struktur: 1) Idee/Def., 2) Regeln/Formeln, 3) Mini‑Herleitung, 4) Fehler/Tipps. Verwende Kurzformen wie "Anfangskapital=K0", "Zinssatz p% → i=p/100" und sehr dichte Bulletpoints. Fülle die Seite spaltenweise (2 Spalten), nutze die Breite maximal.
- Zusätzlich MUSS es eine eigene Layer "Klausurbeispiel" geben, mit Text‑Strokes, die so formatiert sind:
  - Beginne mit der Überschrift "Aufgabe:" und beschreibe in 3–6 ganzen, einfachen Sätzen die Situation. Definiere kurz die Begriffe in Worten (z. B. K0 = Startbetrag, p = Zinssatz pro Jahr, t = Laufzeit in Jahren). Nenne die gegebenen Werte, aber KEINE Rechnung und KEIN Ergebnis. Formuliere klar, was berechnet werden soll (z. B. Zinsen Z und Endkapital Kn bei einfacher Verzinsung).
  - Danach die Überschrift "Lösung:" mit 5–9 Schritten in kurzen Sätzen plus Formelzeilen: 1) Größen festlegen, 2) passende Formel nennen, 3) Werte in Dezimalform, 4) Einsetzen, 5) rechnen, 6) Ergebnis klar mit Einheit. Keine überflüssigen Fachwörter, verständliche Sprache.
  - Diese Section ist strikt getrennt und wird unten rechts positioniert. Keine Farben nötig.`;

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

    // Fallback: Wenn keine Klausurbeispiel-Layer vorhanden, fordere sie separat an
    const hasExamLayer = Array.isArray(sketch?.layers) && sketch.layers.some((l: any)=> /klausur|beispiel/i.test(String(l?.name||'')));
    if (!hasExamLayer) {
      try {
        const aufgabe = await genAufgabe(prompt);
        let { schritte } = await genLoesung(aufgabe);
        // Review/Refine bis zu 1x
        const r = await review(aufgabe, schritte);
        if (!r.ok && r.hint) {
          const sysFix = `Verbessere die Lösung anhand der Hinweise. Gib JSON: {"schritte": string[]}`;
          const fixed = await chatJSON(sysFix, `Aufgabe:\n${aufgabe}\nLösung bisher:\n${schritte.join('\n')}\nHinweise:\n${r.hint}`);
          if (Array.isArray(fixed?.schritte) && fixed.schritte.length) schritte = fixed.schritte.map((x: any)=> String(x));
        }
        const layer = buildExamLayer(aufgabe, schritte);
        sketch.layers = Array.isArray(sketch.layers) ? [...sketch.layers, layer] : [layer];
      } catch {}
    }
    res.json({ sketch });
  } catch (err: any) {
    const msg = err?.message?.startsWith('Missing OPENAI_API_KEY')
      ? 'OPENAI_API_KEY oder OPEN_AI_SECRET_KEY fehlt in .env'
      : (err?.response?.data || err?.message || 'OpenAI request failed');
    res.status(500).json({ error: msg });
  }
});

app.listen(PORT, HOST as any, () => {
  console.log(`Server läuft auf http://${HOST}:${PORT}`);
});
