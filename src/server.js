// MCP Todo & Notes Server — zero external dependencies (Node built-ins only)
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

let todos = [];
let notes = [];

const uid = () => crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

const TOOLS = [
  {
    name: 'get_todos',
    description: 'Get all todos. Filter by status: all, pending, or completed.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['all', 'pending', 'completed'] }
      }
    }
  },
  {
    name: 'create_todo',
    description: 'Create a new todo item.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        dueDate: { type: 'string' }
      }
    }
  },
  {
    name: 'update_todo',
    description: 'Update a todo — mark complete, change title or priority. Requires the todo ID from get_todos.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        completed: { type: 'boolean' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] }
      }
    }
  },
  {
    name: 'delete_todo',
    description: 'Delete a todo by its ID.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
  },
  {
    name: 'get_notes',
    description: 'Get all saved notes.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_note',
    description: 'Create a new note with a title and content.',
    inputSchema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'update_note',
    description: 'Update an existing note by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'delete_note',
    description: 'Delete a note by its ID.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
  }
];

function runTool(name, args) {
  switch (name) {
    case 'get_todos': {
      const s = args.status || 'all';
      const result = s === 'pending' ? todos.filter(t => !t.completed)
                   : s === 'completed' ? todos.filter(t => t.completed) : todos;
      return { todos: result, count: result.length };
    }
    case 'create_todo': {
      if (!args.title) throw new Error('title is required');
      const t = { id: uid(), title: args.title, completed: false, priority: args.priority || 'medium', dueDate: args.dueDate || null, createdAt: new Date().toISOString() };
      todos.push(t);
      return { success: true, todo: t };
    }
    case 'update_todo': {
      const i = todos.findIndex(t => t.id === args.id);
      if (i === -1) throw new Error('Todo not found: ' + args.id);
      const { id, ...u } = args;
      todos[i] = { ...todos[i], ...u, updatedAt: new Date().toISOString() };
      return { success: true, todo: todos[i] };
    }
    case 'delete_todo': {
      const i = todos.findIndex(t => t.id === args.id);
      if (i === -1) throw new Error('Todo not found: ' + args.id);
      todos.splice(i, 1);
      return { success: true };
    }
    case 'get_notes':
      return { notes, count: notes.length };
    case 'create_note': {
      if (!args.title || !args.content) throw new Error('title and content are required');
      const n = { id: uid(), title: args.title, content: args.content, tags: args.tags || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes.push(n);
      return { success: true, note: n };
    }
    case 'update_note': {
      const i = notes.findIndex(n => n.id === args.id);
      if (i === -1) throw new Error('Note not found: ' + args.id);
      const { id, ...u } = args;
      notes[i] = { ...notes[i], ...u, updatedAt: new Date().toISOString() };
      return { success: true, note: notes[i] };
    }
    case 'delete_note': {
      const i = notes.findIndex(n => n.id === args.id);
      if (i === -1) throw new Error('Note not found: ' + args.id);
      notes.splice(i, 1);
      return { success: true };
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

function handleRPC(body) {
  const { id, method, params = {} } = body;
  switch (method) {
    case 'initialize':
      return { id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'todo-notes-mcp', version: '1.0.0' } } };
    case 'ping':
      return { id, result: {} };
    case 'tools/list':
      return { id, result: { tools: TOOLS } };
    case 'tools/call': {
      const { name, arguments: args = {} } = params;
      try {
        const data = runTool(name, args);
        return { id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } };
      } catch (e) {
        return { id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } };
      }
    }
    default:
      return { id, error: { code: -32601, message: 'Unknown method: ' + method } };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const accept = req.headers['accept'] || '';

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', protocol: 'MCP-SSE' }));
  }

  // SSE stream — ChatGPT connects here
  if (req.method === 'GET' && path === '/' && accept.includes('text/event-stream')) {
    const sessionId = uid();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Mcp-Session-Id': sessionId,
    });
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const base = proto + '://' + host;
    res.write('event: endpoint\ndata: ' + JSON.stringify({ uri: base + '/message?sessionId=' + sessionId }) + '\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  // JSON-RPC messages
  if (req.method === 'POST' && path === '/message') {
    try {
      const body = await readBody(req);
      if (body.method === 'notifications/initialized') { res.writeHead(204); return res.end(); }
      const rpc = handleRPC(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', ...rpc }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }));
    }
  }

  // Browser page
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<!DOCTYPE html><html><head><title>Todo & Notes MCP</title>
<style>body{font-family:monospace;background:#0c0c0f;color:#c8f060;padding:48px;line-height:2}
code{background:#1a1a22;padding:2px 8px;border-radius:4px;color:#60d0f0}a{color:#60d0f0}</style></head>
<body><h1>✓ Todo & Notes MCP Server</h1>
<p>Status: <strong style="color:#80e080">Running</strong></p>
<p>SSE: <code>GET /</code> with <code>Accept: text/event-stream</code></p>
<p>RPC: <code>POST /message</code></p>
<p>Health: <a href="/health">/health</a></p>
<p style="color:#666">Tools: get_todos · create_todo · update_todo · delete_todo · get_notes · create_note · update_note · delete_note</p>
</body></html>`);
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log('MCP server on port ' + PORT));