# Umgebungsvariablen (lokal in `.env` setzen)

Pflicht für Deployment/Uploads – Beispielwerte anpassen:

```
# Server
PORT=3000
HOST=0.0.0.0

# OpenAI (optional)
# OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5

# AWS S3
AWS_REGION=eu-central-1
AWS_S3_BUCKET=your-bucket-name
# AWS Credentials (nicht committen)
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...
# AWS_SESSION_TOKEN=...   # optional
```

Hinweise:
- `.env` liegt lokal und ist in `.gitignore`; niemals Schlüssel committen.
- Nach Änderungen Server neu starten.
- Für temporäre Credentials (z. B. via AWS SSO/IAM Role) wird `AWS_SESSION_TOKEN` automatisch von der Umgebung gesetzt.
