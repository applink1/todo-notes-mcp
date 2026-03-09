# Todo & Notes Manager — MCP Plugin
### Deploy to Railway → Publish on ChatGPT Actions Marketplace

---

## What This Is

A fully functional **MCP-compatible REST API** for managing todos and notes.
It exposes a standard OpenAPI spec that ChatGPT reads to understand what actions it can take on your behalf.

**What ChatGPT will be able to do:**
- "Add buy milk to my todos"
- "Mark my dentist appointment todo as done"
- "Show me all my pending tasks"
- "Save a note titled Meeting Summary with these bullet points..."
- "Delete all completed todos"

---

## Project Structure

```
todo-mcp/
├── src/
│   └── server.js          ← Express API + OpenAPI spec + plugin manifest
├── public/
│   └── index.html         ← Test UI (also served by the API)
├── package.json
├── railway.toml            ← Railway deployment config
└── .gitignore
```

---

## Step 1 — Push to GitHub (Free)

1. Go to https://github.com/new and create a **new public repo** (e.g. `todo-notes-mcp`)
2. In your terminal, from the project folder:

```bash
git init
git add .
git commit -m "Initial commit: Todo & Notes MCP plugin"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/todo-notes-mcp.git
git push -u origin main
```

---

## Step 2 — Deploy to Railway (Free)

Railway's free Hobby tier gives you **$5/month in free credits** — enough to run this 24/7.

1. Go to **https://railway.app** and sign up (use GitHub login for speed)
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Select your `todo-notes-mcp` repo
4. Railway auto-detects Node.js via nixpacks — no config needed
5. Click **"Deploy"** — takes ~60 seconds
6. Go to **Settings → Networking → Generate Domain**
7. Copy your public URL (e.g. `https://todo-notes-mcp-production.up.railway.app`)

✅ Test it: Visit `https://YOUR_RAILWAY_URL/health` — you should see `{"status":"ok"}`
✅ View UI: Visit `https://YOUR_RAILWAY_URL` — the test interface loads
✅ Check manifest: Visit `https://YOUR_RAILWAY_URL/.well-known/ai-plugin.json`

---

## Step 3 — Register as a ChatGPT Action

### Option A: ChatGPT Custom GPT (Easiest)

1. Go to https://chatgpt.com → Click your avatar → **"My GPTs"** → **"Create a GPT"**
2. Click **"Configure"** tab
3. Scroll to **"Actions"** → Click **"Create new action"**
4. In the **"Schema"** field, paste your OpenAPI URL:
   ```
   https://YOUR_RAILWAY_URL/openapi.yaml
   ```
   ChatGPT will auto-import all your endpoints.
5. Set **Authentication** to **None**
6. Click **"Save"** → name your GPT (e.g. "My Todo Manager")
7. Test it in the chat: *"Add a high priority todo: finish the report"*

### Option B: ChatGPT Plugin Marketplace (Developer Preview)

> Note: The plugin marketplace is currently invite-only. The Custom GPT path above
> is the fastest way to publish publicly.

1. Go to https://platform.openai.com/docs/plugins
2. Apply for plugin developer access
3. Submit your plugin manifest URL: `https://YOUR_RAILWAY_URL/.well-known/ai-plugin.json`

---

## Step 4 — Test Your MCP Endpoints

### Using curl:

```bash
# Create a todo
curl -X POST https://YOUR_RAILWAY_URL/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Buy groceries", "priority": "high"}'

# Get all todos
curl https://YOUR_RAILWAY_URL/todos

# Mark complete (replace ID with real id from above response)
curl -X PATCH https://YOUR_RAILWAY_URL/todos/SOME_ID \
  -H "Content-Type: application/json" \
  -d '{"completed": true}'

# Create a note
curl -X POST https://YOUR_RAILWAY_URL/notes \
  -H "Content-Type: application/json" \
  -d '{"title": "Meeting notes", "content": "Discussed Q1 targets", "tags": ["work","q1"]}'
```

---

## Upgrading: Add Persistent Storage

Right now data resets when Railway restarts the service.
To persist data forever for free:

### Option: Railway + PostgreSQL (Free)

1. In your Railway project → **"New Service"** → **"Database"** → **"PostgreSQL"**
2. Railway auto-sets `DATABASE_URL` env var
3. Install pg: `npm install pg`
4. Replace the in-memory arrays in `server.js` with SQL queries

### Option: PlanetScale (Free MySQL, 5GB)

1. Sign up at https://planetscale.com (free tier)
2. Create a database → get a connection string
3. Set `DATABASE_URL` in Railway environment variables

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /todos | List todos (`?status=pending\|completed\|all`) |
| POST | /todos | Create todo `{title, priority, dueDate}` |
| PATCH | /todos/:id | Update todo `{title, completed, priority}` |
| DELETE | /todos/:id | Delete todo |
| GET | /notes | List all notes |
| POST | /notes | Create note `{title, content, tags[]}` |
| PATCH | /notes/:id | Update note |
| DELETE | /notes/:id | Delete note |
| GET | /.well-known/ai-plugin.json | Plugin manifest |
| GET | /openapi.yaml | OpenAPI 3.0 spec |
| GET | /health | Health check |

---

## Total Cost: $0

| Service | Cost |
|---------|------|
| GitHub | Free |
| Railway Hobby | Free ($5/mo credit) |
| ChatGPT Custom GPT | Free |
| **Total** | **$0** |
