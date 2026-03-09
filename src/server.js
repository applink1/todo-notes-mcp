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
  { name: 'update_todo', description: 'Edit a todo or mark it complete. Needs the todo id.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, title: { type: 'string' }, completed: { type: 'boolean' }, priority: { type: 'string', enum: ['low','medium','high'] } } } },
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
      const { id: _x, ...rest } = args;
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
      const { id: _x, ...rest } = args;
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

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readJSON(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch(e) { fail(e); } });
    req.on('error', fail);
  });
}

const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch(_) {}
  const accept = req.headers['accept'] || '';

  // Health
  if (pathname === '/health') {
    return sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
  }

  // SSE — ChatGPT connects here first
  if (req.method === 'GET' && pathname === '/' && accept.includes('text/event-stream')) {
    const sid = uid();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': sid,
    });
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers['x-forwarded-host']  || req.headers['host'] || 'localhost';
    res.write('event: endpoint\ndata: ' + JSON.stringify({ uri: proto + '://' + host + '/message?sessionId=' + sid }) + '\n\n');
    const t = setInterval(() => { try { res.write(': ping\n\n'); } catch(_) {} }, 20000);
    req.on('close', () => clearInterval(t));
    return;
  }

  // JSON-RPC
  if (req.method === 'POST' && pathname === '/message') {
    let body;
    try { body = await readJSON(req); } catch(e) {
      return sendJSON(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const { id, method, params = {} } = body;
    if (method === 'notifications/initialized') { res.writeHead(204); return res.end(); }
    let result, error;
    try {
      switch (method) {
        case 'initialize': result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'todo-notes-mcp', version: '1.0.0' } }; break;
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: TOOLS }; break;
        case 'tools/call': {
          const { name, arguments: args = {} } = params;
          try { result = { content: [{ type: 'text', text: JSON.stringify(runTool(name, args), null, 2) }] }; }
          catch(e) { result = { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }; }
          break;
        }
        default: error = { code: -32601, message: 'Method not found: ' + method };
      }
    } catch(e) { error = { code: -32603, message: e.message }; }
    return sendJSON(res, 200, error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
  }

  // Browser page
  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html><html><head><title>Todo & Notes MCP</title>
<style>body{background:#0c0c0f;color:#c8f060;font-family:monospace;padding:48px;line-height:2}
code{background:#1a1a22;color:#60d0f0;padding:2px 8px;border-radius:4px}a{color:#60d0f0}</style></head>
<body><h1>&#10003; Todo &amp; Notes MCP Server</h1>
<p style="color:#80e080">&#9679; Running &mdash; uptime ${Math.floor(process.uptime())}s</p>
<p>SSE: <code>GET /</code> with Accept: text/event-stream</p>
<p>RPC: <code>POST /message</code></p>
<p>Health: <a href="/health">/health</a></p>
</body></html>`);
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => console.log('[MCP] Listening on 0.0.0.0:' + PORT));
server.on('error', err => { console.error('[MCP] Fatal:', err); process.exit(1); });
process.on('uncaughtException', err => { console.error('[MCP] Uncaught:', err); process.exit(1); });