import { config } from 'dotenv';
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';

config();

const app = express();
const PORT: number = parseInt(process.env.PORT || '3000', 10);

// View engine setup (robust for ts-node and dist builds)
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/', (req: Request, res: Response) => {
  res.render('index');
});

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
