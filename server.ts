import { config } from 'dotenv';
import express, { Request, Response } from 'express';
import http from 'http';
import { initSockets } from './server.socket';
import cors from 'cors';
import path from 'path';
import OpenAI from 'openai';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';

config();

const app = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);
const HOST: string = (process.env.HOST || '0.0.0.0').trim();
const NGROK_URL: string = (process.env.NGROK_URL || '').trim();
if (NGROK_URL) {
  console.log('🔗 [NGROK] URL:', NGROK_URL);
}

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

// Bild-OCR System Prompt
const IMAGE_OCR_PROMPT = `Du bist ein präziser Transkriptor. Aufgabe: Extrahiere ausschließlich den sichtbaren Text aus dem/den Bild(er)n.
Regeln:
- Gib den Text 1:1 wieder (Zeilenumbrüche, Rechtschreibung, Formatierung soweit sinnvoll erhalten).
- Nichts erklären, nicht interpretieren, keine Zusatztexte.
- Unleserliches als [unleserlich] markieren.`;

// OCR → Sketch Prompt (mit Positionen und einfachen Formen)
const IMAGE_OCR_TO_SKETCH_PROMPT = `Aufgabe: Lies den Inhalt des Fotos und gib AUSSCHLIESSLICH JSON im folgenden Format aus. Keine Erklärungen, kein Markdown.
Schema:
{
  "layers": [
    {
      "name": "OCR",
      "strokes": [
        {"type":"text","position":[x,y],"text":"...","size":0.028,"color":"#ffffff"},
        {"type":"circle","center":[x,y],"radius":r,"color":"#ffffff","thickness":0.002},
        {"type":"line","points":[[x1,y1],[x2,y2],...],"color":"#ffffff","thickness":0.002},
        {"type":"rect","position":[x,y],"size":[w,h],"color":"#ffffff","thickness":0.002},
        {"type":"path","points":[[x1,y1],[x2,y2],...],"closed":false,"color":"#ffffff","thickness":0.002}
      ]
    }
  ]
}
Hinweise:
- Sämtliche Koordinaten sind in [0,1] normiert relativ zum Bild (0,0 oben links; 1,1 unten rechts). "radius", "thickness" ebenfalls normiert (Radius relativ zur kleineren Seite des Bildes; Liniendicke relativ zur Breite).
- Für Text: "position" ist die Startposition der Zeile. Halte die vertikale Reihenfolge exakt ein. Bewahre Zeilenumbrüche.
- Zerlege den Text in sinnvolle Zeilen. Bewahre Zeilenumbrüche aus dem Bild möglichst.
- Unleserliche Segmente als [unleserlich].
- size ca. 0.026–0.040 wählen, damit gut lesbar.
- KEINE anderen Keys als oben genannt.
- KEINE zusätzlichen Titel/Labels wie "Aufgabe" oder "Lösung" hinzufügen.`;

// View engine setup (robust for ts-node and dist builds)
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(process.cwd(), 'public')));
// Statisch: lokal ausgelieferte Third-Party-Skripte (verhindert CDN-Blocker/nosniff)
app.get('/vendor/html5-qrcode.min.js', (_req, res) => {
  const p = path.join(process.cwd(), 'node_modules', 'html5-qrcode', 'html5-qrcode.min.js');
  res.type('application/javascript');
  res.sendFile(p);
});
// EJS-Views: NGROK_URL verfügbar machen
app.use((_req, res, next) => { (res as any).locals.NGROK_URL = NGROK_URL; next(); });

// S3 Setup – Region bereinigen (typografische Bindestriche entfernen)
let S3_REGION = (process.env.AWS_REGION || '').trim();
// Ersetze en/em dash oder sonstige Unicode‑Bindestriche durch normales '-'
S3_REGION = S3_REGION
  .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-') // exotische Dashes → '-'
  .replace(/[\s_]+/g, '-')                                  // Whitespaces/Underscores → '-'
  .replace(/-+/g, '-')                                        // doppelte Dashes → '-'
  .toLowerCase();
console.log('🌍 [S3] Region detected:', S3_REGION);
const S3_BUCKET = process.env.AWS_S3_BUCKET || '';
let s3Client: S3Client | null = null;
function getS3(){
  if (!s3Client) s3Client = new S3Client({ region: S3_REGION });
  return s3Client;
}

// S3 Presigned URL for POST (Form Upload)
app.post('/api/uploads/presign', async (req: Request, res: Response) => {
  console.log('📤 [UPLOAD] Presign Request:', req.body);
  try {
    const { contentType, folder } = req.body as { contentType: string; folder?: string };
    if (!contentType) {
      console.error('❌ [UPLOAD] Missing contentType');
      return res.status(400).json({ error: 'contentType is required' });
    }

    const s3 = getS3();
    const bucketName = process.env.AWS_S3_BUCKET;
    if (!bucketName) {
      console.error('❌ [UPLOAD] Missing AWS_S3_BUCKET');
      throw new Error('AWS_S3_BUCKET not configured in .env');
    }

    // optional: Unterordner
    let safeFolder = '';
    if (folder && typeof folder === 'string') {
      const m = folder.trim().toLowerCase();
      if (!/^[-a-z0-9_]{1,64}$/.test(m)) {
        return res.status(400).json({ error: 'invalid folder name' });
      }
      safeFolder = `${m}/`;
    }

    // Dateiendung aus contentType ableiten (optional)
    const extMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'application/pdf': '.pdf'
    };
    const ext = extMap[contentType] || '';
    const key = `uploads/${safeFolder}${uuidv4()}${ext}`;
    console.log('🔑 [UPLOAD] Generated key:', key);

    const presignedUrl = await createPresignedPost(s3, {
      Bucket: bucketName,
      Key: key,
      Expires: 60,
      Conditions: [
        ['content-length-range', 0, 10485760], // Max 10MB
        { 'Content-Type': contentType },
        { bucket: bucketName },
        { key },
      ],
    });

    console.log('✅ [UPLOAD] Presigned URL created successfully:', presignedUrl.url);
    console.log('🧾 [UPLOAD] Presigned fields keys:', Object.keys(presignedUrl.fields));
    res.json({ url: presignedUrl.url, fields: presignedUrl.fields, key, region: S3_REGION, bucket: bucketName });
  } catch (err: any) {
    console.error('❌ [UPLOAD] Presign error:', err);
    res.status(500).json({ error: err.message || 'Failed to create presigned URL' });
  }
});

// Datei löschen
app.post('/api/uploads/delete', async (req: Request, res: Response) => {
  try {
    const { key } = req.body as { key: string };
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ error: 'key is required' });
    }
    const s3 = getS3();
    const bucketName = process.env.AWS_S3_BUCKET;
    if (!bucketName) {
      console.error('❌ [DELETE] Missing AWS_S3_BUCKET');
      throw new Error('AWS_S3_BUCKET not configured in .env');
    }
    console.log('🗑️  [DELETE] Deleting key:', key);
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
    res.json({ ok: true });
  } catch (err: any) {
    console.error('❌ [DELETE] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete object' });
  }
});

// S3 Presigned URL for GET (viewing)
app.get('/api/uploads/view-url', async (req: Request, res: Response) => {
  console.log('👁️ [VIEW] View URL Request:', req.query);
  try {
    const { key } = req.query as { key: string };
    if (!key) {
      console.error('❌ [VIEW] Missing key parameter');
      return res.status(400).json({ error: 'key is required' });
    }

    const s3 = getS3();
    const bucketName = process.env.AWS_S3_BUCKET;
    if (!bucketName) {
      console.error('❌ [VIEW] Missing AWS_S3_BUCKET');
      throw new Error('AWS_S3_BUCKET not configured in .env');
    }

    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

    console.log('✅ [VIEW] View URL created for key:', key);
    res.json({ url });
  } catch (err: any) {
    console.error('❌ [VIEW] View URL error:', err);
    res.status(500).json({ error: err.message || 'Failed to create view URL' });
  }
});

// Auflistung der Uploads aus dem S3 Bucket
app.get('/api/uploads', async (req: Request, res: Response) => {
  try {
    const s3 = getS3();
    const bucketName = process.env.AWS_S3_BUCKET;
    if (!bucketName) {
      console.error('❌ [LIST] Missing AWS_S3_BUCKET');
      throw new Error('AWS_S3_BUCKET not configured in .env');
    }

    const folder = String((req.query.folder || '') as string).trim();
    const prefix = folder ? `uploads/${folder.replace(/\/+$/,'')}/` : 'uploads/';
    const cmd = new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix });
    const out = await s3.send(cmd);
    const items = (out.Contents || [])
      .filter(obj => !!obj.Key)
      // Nur echte Objekte (kein Ordner-Platzhalter), Größe > 0
      .filter(obj => {
        const key = String(obj.Key);
        const size = Number(obj.Size || 0);
        if (!key || key.endsWith('/')) return false;
        if (size <= 0) return false;
        return true;
      })
      .map(obj => ({
        key: String(obj.Key),
        size: Number(obj.Size || 0),
        lastModified: (obj.LastModified ? new Date(obj.LastModified).toISOString() : null)
      }))
      .sort((a, b) => (a.lastModified && b.lastModified ? (a.lastModified < b.lastModified ? 1 : -1) : 0));

    console.log(`📚 [LIST] Returned ${items.length} items`);
    res.json({ items });
  } catch (err: any) {
    console.error('❌ [LIST] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to list uploads', items: [] });
  }
});

// Folders: Auflisten (mithilfe von _folders/ Metadateien und Prefix-Zählung)
app.get('/api/folders', async (_req: Request, res: Response) => {
  try {
    const s3 = getS3();
    const bucketName = process.env.AWS_S3_BUCKET!;
    // Liste Metadateien
    const metaPrefix = 'uploads/_folders/';
    const metaCmd = new ListObjectsV2Command({ Bucket: bucketName, Prefix: metaPrefix });
    const metaOut = await s3.send(metaCmd);
    const metas = (metaOut.Contents || []).filter(o => (o.Key||'').endsWith('.json'));

    async function readShared(name: string): Promise<boolean> {
      try {
        const key = `${metaPrefix}${name}.json`;
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
        const chunks: any[] = [];
        await new Promise<void>((resolve, reject) => {
          (obj.Body as any).on('data', (c: any) => chunks.push(c));
          (obj.Body as any).on('end', () => resolve());
          (obj.Body as any).on('error', reject);
        });
        const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        return Boolean(json?.shared);
      } catch {
        return false;
      }
    }

    // CommonPrefixes anhand von _folders/*.json ableiten
    const folderNames = metas.map(m => String(m.Key).slice(metaPrefix.length).replace(/\.json$/,''));

    const result: Array<{name:string; shared:boolean; count:number}> = [];
    for (const name of folderNames) {
      const shared = await readShared(name);
      const list = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: `uploads/${name}/` }));
      const count = (list.Contents || []).filter(o => (o.Size||0) > 0).length;
      result.push({ name, shared, count });
    }
    res.json({ folders: result.sort((a,b)=> a.name.localeCompare(b.name)) });
  } catch (err:any) {
    console.error('❌ [FOLDERS] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to list folders', folders: [] });
  }
});

// Folders: Anlegen
app.post('/api/folders', async (req: Request, res: Response) => {
  try {
    const { name, shared } = req.body as { name: string; shared?: boolean };
    const folder = String(name || '').trim().toLowerCase();
    if (!/^[-a-z0-9_]{1,64}$/.test(folder)) return res.status(400).json({ error: 'invalid folder name' });
    const s3 = getS3();
    const bucketName = process.env.AWS_S3_BUCKET!;
    // Meta schreiben
    const metaKey = `uploads/_folders/${folder}.json`;
    const body = Buffer.from(JSON.stringify({ name: folder, shared: Boolean(shared), createdAt: new Date().toISOString() }), 'utf-8');
    await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: metaKey, Body: body, ContentType: 'application/json' }));
    // Optional: Platzhalter-Objekt für Ordner
    await s3.send(new PutObjectCommand({ Bucket: bucketName, Key: `uploads/${folder}/.keep`, Body: Buffer.from(''), ContentType: 'application/octet-stream' }));
    res.json({ ok: true });
  } catch (err:any) {
    console.error('❌ [FOLDER_CREATE] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to create folder' });
  }
});

// Folders: Löschen (Ordner-Metadatei + alle Objekte unter uploads/<name>/)
app.post('/api/folders/delete', async (req: Request, res: Response) => {
  try {
    const { name } = req.body as { name: string };
    const folder = String(name || '').trim().toLowerCase();
    if (!/^[-a-z0-9_]{1,64}$/.test(folder)) return res.status(400).json({ error: 'invalid folder name' });
    const s3 = getS3();
    const bucketName = process.env.AWS_S3_BUCKET!;

    // 1) Alle Keys sammeln
    const prefix = `uploads/${folder}/`;
    const keys: string[] = [];
    let ContinuationToken: string | undefined = undefined;
    do {
      const out: any = await s3.send(new ListObjectsV2Command({ Bucket: bucketName, Prefix: prefix, ContinuationToken }));
      (out.Contents || []).forEach((o: any) => { if (o.Key) keys.push(String(o.Key)); });
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);

    // 2) In Batches löschen (max 1000 pro Request)
    for (let i=0; i<keys.length; i+=1000) {
      const chunk = keys.slice(i, i+1000).map(Key => ({ Key }));
      if (chunk.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucketName, Delete: { Objects: chunk } }));
    }

    // 3) Metadatei löschen
    await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: `uploads/_folders/${folder}.json` }));

    res.json({ ok: true, deleted: keys.length });
  } catch (err:any) {
    console.error('❌ [FOLDER_DELETE] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to delete folder' });
  }
});

app.get('/', (req: Request, res: Response) => {
  res.render('index');
});

// Neue Route: /folder (nur Navbar + gleiche BG)
app.get('/folder', (req: Request, res: Response) => {
  res.render('folder');
});

// Minimaler Whiteboard‑View ohne Toolbar/Chat
app.get('/real-time-class-link-sw', (req: Request, res: Response) => {
  res.render('classlink');
});

// Chat Endpoint (non-streaming)
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    const { messages, imageKey, ocrToSketch } = req.body as { messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>; imageKey?: string; ocrToSketch?: boolean };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const openai = getOpenAIClient();

    // Optional: Bild-Analyse aktiv, falls imageKey vorhanden → presigned GET URL erzeugen und multimodale Nachricht bauen
    let apiMessages: any[] = [];
    if (imageKey && typeof imageKey === 'string') {
      try {
        const url = await getSignedUrl(getS3(), new GetObjectCommand({ Bucket: S3_BUCKET, Key: imageKey }), { expiresIn: 900 });
        const system = ocrToSketch ? IMAGE_OCR_TO_SKETCH_PROMPT : IMAGE_OCR_PROMPT;
        apiMessages = [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              { type: 'text', text: messages[messages.length-1]?.content || (ocrToSketch? 'Erzeuge JSON-Skizze des Textes' : 'Bitte Text aus dem Bild extrahieren.') },
              { type: 'image_url', image_url: { url } }
            ]
          }
        ];
      } catch (e) {
        console.error('❌ [OCR] Failed to create view URL:', e);
        return res.status(500).json({ error: 'Bild-URL konnte nicht erstellt werden' });
      }
    } else {
      apiMessages = [{ role: 'system', content: PROFESSOR_SYSTEM_PROMPT }, ...messages];
    }

    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: apiMessages as any,
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
    const { messages, imageKey, ocrToSketch } = req.body as { messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>; imageKey?: string; ocrToSketch?: boolean };
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const openai = getOpenAIClient();

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    let apiMessages: any[] = [];
    if (imageKey && typeof imageKey === 'string') {
      try {
        const url = await getSignedUrl(getS3(), new GetObjectCommand({ Bucket: S3_BUCKET, Key: imageKey }), { expiresIn: 900 });
        const system = ocrToSketch ? IMAGE_OCR_TO_SKETCH_PROMPT : IMAGE_OCR_PROMPT;
        apiMessages = [
          { role: 'system', content: system },
          { role: 'user', content: [ { type: 'text', text: messages[messages.length-1]?.content || (ocrToSketch? 'Erzeuge JSON-Skizze des Textes' : 'Bitte Text aus dem Bild extrahieren.') }, { type: 'image_url', image_url: { url } } ] }
        ];
      } catch (e) {
        console.error('❌ [OCR] Failed to create view URL (stream):', e);
        return res.status(500).json({ error: 'Bild-URL konnte nicht erstellt werden' });
      }
    } else {
      apiMessages = [{ role: 'system', content: PROFESSOR_SYSTEM_PROMPT }, ...messages];
    }

    const stream = await openai.chat.completions.create({
      model: MODEL,
      messages: apiMessages as any,
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

const httpServer = http.createServer(app);
httpServer.listen(PORT, HOST as any, () => {
  console.log(`Server läuft auf http://${HOST}:${PORT}`);
});

// Socket.IO an denselben Server hängen (CORS auf NGROK_URL einschränken, falls vorhanden)
try {
  initSockets(httpServer, { origin: NGROK_URL || '*' });
} catch (e) {
  console.error('❌ [SOCKET] Init failed:', e);
}
