'use strict';
const http = require('http');
const crypto = require('crypto');
const PORT = parseInt(process.env.PORT || '3000', 10);

let todos = [];
let notes = [];
const uid = () => crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

const TOOLS = [
  { name: 'get_todos', description: 'List todos. Pass status=pending|completed|all to filter.', inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['all','pending','completed'] } } } },
  { name: 'create_todo', description: 'Add a new todo.', inputSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, priority: { type: 'string', enum: ['low','medium','high'] }, dueDate: { type: 'string' } } } },
  { name: 'update_todo', description: 'Edit a todo or mark it complete. Needs the todo id from get_todos first.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, title: { type: 'string' }, completed: { type: 'boolean' }, priority: { type: 'string', enum: ['low','medium','high'] } } } },
  { name: 'delete_todo', description: 'Remove a todo by id.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'get_notes', description: 'List all notes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_note', description: 'Save a new note.', inputSchema: { type: 'object', required: ['title','content'], properties: { title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
  { name: 'update_note', description: 'Edit a note by id.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } },
  { name: 'delete_note', description: 'Remove a note by id.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
];

function runTool(name, args) {
  switch (name) {
    case 'get_todos': {
      const s = args.status || 'all';
      const list = s === 'pending' ? todos.filter(t => !t.completed) : s === 'completed' ? todos.filter(t => t.completed) : todos;
      return { todos: list, count: list.length };
    }
    case 'create_todo': {
      const t = { id: uid(), title: String(args.title), completed: false, priority: args.priority || 'medium', dueDate: args.dueDate || null, createdAt: new Date().toISOString() };
      todos.push(t); return { success: true, todo: t };
    }
    case 'update_todo': {
      const i = todos.findIndex(t => t.id === args.id);
      if (i < 0) throw new Error('Todo not found');
      const { id: _, ...rest } = args;
      todos[i] = { ...todos[i], ...rest, updatedAt: new Date().toISOString() };
      return { success: true, todo: todos[i] };
    }
    case 'delete_todo': {
      const i = todos.findIndex(t => t.id === args.id);
      if (i < 0) throw new Error('Todo not found');
      todos.splice(i, 1); return { success: true };
    }
    case 'get_notes': return { notes, count: notes.length };
    case 'create_note': {
      const n = { id: uid(), title: String(args.title), content: String(args.content), tags: args.tags || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes.push(n); return { success: true, note: n };
    }
    case 'update_note': {
      const i = notes.findIndex(n => n.id === args.id);
      if (i < 0) throw new Error('Note not found');
      const { id: _, ...rest } = args;
      notes[i] = { ...notes[i], ...rest, updatedAt: new Date().toISOString() };
      return { success: true, note: notes[i] };
    }
    case 'delete_note': {
      const i = notes.findIndex(n => n.id === args.id);
      if (i < 0) throw new Error('Note not found');
      notes.splice(i, 1); return { success: true };
    }
    default: throw new Error('Unknown tool: ' + name);
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJSON(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString() || 'null')); } catch(e) { fail(e); } });
    req.on('error', fail);
  });
}

// In-memory session store for Streamable HTTP
const sessions = new Map();

function handleRPC(msg, sessionId) {
  const { id, method, params = {} } = msg;

  // Initialise creates a session
  if (method === 'initialize') {
    sessions.set(sessionId, { createdAt: Date.now() });
    return { id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'todo-notes-mcp', version: '1.0.0' } } };
  }
  if (method === 'notifications/initialized') return null; // no response
  if (method === 'ping') return { id, result: {} };
  if (method === 'tools/list') return { id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    try {
      return { id, result: { content: [{ type: 'text', text: JSON.stringify(runTool(name, args), null, 2) }] } };
    } catch(e) {
      return { id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } };
    }
  }
  return { id, error: { code: -32601, message: 'Method not found: ' + method } };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch(_) {}

  // ── Health
  if (pathname === '/health') {
    return json(res, 200, { status: 'ok', uptime: Math.floor(process.uptime()), sessions: sessions.size });
  }

  // ── MCP Streamable HTTP endpoint (POST /mcp)
  // This is the modern MCP transport — no SSE, no persistent connection.
  // ChatGPT POSTs JSON-RPC and gets JSON back immediately.
  if (req.method === 'POST' && pathname === '/mcp') {
    let body;
    try { body = await readJSON(req); } catch(e) {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }

    // Session management
    let sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
      sessionId = uid();
      res.setHeader('Mcp-Session-Id', sessionId);
    }

    // Accept single message or batch array
    const messages = Array.isArray(body) ? body : [body];
    const responses = [];

    for (const msg of messages) {
      if (!msg || msg.jsonrpc !== '2.0') continue;
      const r = handleRPC(msg, sessionId);
      if (r) responses.push({ jsonrpc: '2.0', ...r });
    }

    // If all messages were notifications (no responses), return 204
    if (responses.length === 0) { res.writeHead(204); return res.end(); }

    // Return single object or array depending on input
    return json(res, 200, Array.isArray(body) ? responses : responses[0]);
  }

  // ── DELETE /mcp  (session termination)
  if (req.method === 'DELETE' && pathname === '/mcp') {
    const sid = req.headers['mcp-session-id'];
    if (sid) sessions.delete(sid);
    res.writeHead(204); return res.end();
  }

  // ── GET /mcp  (capability discovery — some clients check this)
  if (req.method === 'GET' && pathname === '/mcp') {
    return json(res, 200, {
      transport: 'streamable-http',
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} }
    });
  }

  // ── Browser status page
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html><head><title>Todo MCP</title>
<style>body{background:#0c0c0f;color:#c8f060;font-family:monospace;padding:48px;line-height:2}
code{background:#1a1a22;color:#60d0f0;padding:2px 8px;border-radius:4px}a{color:#60d0f0}
.ok{color:#80e080}</style></head><body>
<h1>&#10003; Todo &amp; Notes MCP</h1>
<p class="ok">&#9679; Running — uptime ${Math.floor(process.uptime())}s</p>
<p>Transport: <strong>Streamable HTTP</strong> (MCP 2024-11-05)</p>
<p>MCP endpoint: <code>POST /mcp</code></p>
<p>Health: <a href="/health">/health</a></p>
<hr style="border-color:#1f1f28;margin:24px 0">
<p style="color:#666">Tools: get_todos · create_todo · update_todo · delete_todo<br>
get_notes · create_note · update_note · delete_note</p>
</body></html>`);
  }

  res.writeHead(404); res.end('Not found');
});

server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;
server.listen(PORT, '0.0.0.0', () => console.log('[MCP] Streamable HTTP ready on port ' + PORT));
server.on('error', err => { console.error('[MCP] Fatal:', err); process.exit(1); });