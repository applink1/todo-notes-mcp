const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'Mcp-Session-Id'],
  exposedHeaders: ['Mcp-Session-Id'],
}));
app.use(express.json());

// ─── In-memory data ────────────────────────────────────────────────────────────
let todos = [];
let notes = [];

// ─── MCP Tool definitions ──────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_todos',
    description: 'Get all todos. Optionally filter by status: all, pending, or completed.',
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
        title: { type: 'string', description: 'The todo title' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        dueDate: { type: 'string', description: 'Optional due date' }
      }
    }
  },
  {
    name: 'update_todo',
    description: 'Update a todo — mark it complete or change title/priority. Requires the todo ID.',
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
    description: 'Delete a todo by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } }
    }
  },
  {
    name: 'get_notes',
    description: 'Get all saved notes.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_note',
    description: 'Create a new note with title, content, and optional tags.',
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
    description: 'Delete a note by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } }
    }
  }
];

// ─── Tool execution ────────────────────────────────────────────────────────────
function executeTool(name, args) {
  switch (name) {
    case 'get_todos': {
      const status = args.status || 'all';
      let result = todos;
      if (status === 'pending') result = todos.filter(t => !t.completed);
      if (status === 'completed') result = todos.filter(t => t.completed);
      return { todos: result, count: result.length };
    }
    case 'create_todo': {
      if (!args.title) throw new Error('title is required');
      const todo = { id: uuidv4(), title: args.title, completed: false, priority: args.priority || 'medium', dueDate: args.dueDate || null, createdAt: new Date().toISOString() };
      todos.push(todo);
      return { success: true, todo };
    }
    case 'update_todo': {
      const idx = todos.findIndex(t => t.id === args.id);
      if (idx === -1) throw new Error(`Todo "${args.id}" not found`);
      const { id, ...updates } = args;
      todos[idx] = { ...todos[idx], ...updates, updatedAt: new Date().toISOString() };
      return { success: true, todo: todos[idx] };
    }
    case 'delete_todo': {
      const idx = todos.findIndex(t => t.id === args.id);
      if (idx === -1) throw new Error(`Todo "${args.id}" not found`);
      todos.splice(idx, 1);
      return { success: true };
    }
    case 'get_notes': {
      return { notes, count: notes.length };
    }
    case 'create_note': {
      if (!args.title || !args.content) throw new Error('title and content required');
      const note = { id: uuidv4(), title: args.title, content: args.content, tags: args.tags || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes.push(note);
      return { success: true, note };
    }
    case 'update_note': {
      const idx = notes.findIndex(n => n.id === args.id);
      if (idx === -1) throw new Error(`Note "${args.id}" not found`);
      const { id, ...updates } = args;
      notes[idx] = { ...notes[idx], ...updates, updatedAt: new Date().toISOString() };
      return { success: true, note: notes[idx] };
    }
    case 'delete_note': {
      const idx = notes.findIndex(n => n.id === args.id);
      if (idx === -1) throw new Error(`Note "${args.id}" not found`);
      notes.splice(idx, 1);
      return { success: true };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', protocol: 'MCP-SSE' }));

// ─── MCP SSE stream — ChatGPT connects here first ─────────────────────────────
// ChatGPT sends Accept: text/event-stream → we open the SSE channel
// and tell it where to POST JSON-RPC messages
app.get('/', (req, res) => {
  const accept = req.headers['accept'] || '';

  if (!accept.includes('text/event-stream')) {
    // Serve a simple status page for browser visits
    return res.send(`
      <!DOCTYPE html><html><head><title>Todo & Notes MCP</title>
      <style>body{font-family:monospace;background:#0c0c0f;color:#c8f060;padding:40px;}</style></head>
      <body>
        <h1>✓ Todo & Notes MCP Server</h1>
        <p>Status: <strong>Running</strong></p>
        <p>Protocol: MCP over SSE (Model Context Protocol)</p>
        <p>SSE endpoint: <code>GET /</code> with <code>Accept: text/event-stream</code></p>
        <p>Message endpoint: <code>POST /message</code></p>
        <p>Tools: get_todos, create_todo, update_todo, delete_todo, get_notes, create_note, update_note, delete_note</p>
        <hr/>
        <p><a href="/health" style="color:#60d0f0">/health</a></p>
      </body></html>
    `);
  }

  // SSE handshake
  const sessionId = uuidv4();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disables Railway/nginx buffering
  res.setHeader('Mcp-Session-Id', sessionId);
  res.flushHeaders();

  // Tell the client where to POST JSON-RPC messages
  const base = `${req.protocol}://${req.headers.host}`;
  const endpointEvent = `event: endpoint\ndata: ${JSON.stringify({ uri: `${base}/message?sessionId=${sessionId}` })}\n\n`;
  res.write(endpointEvent);

  // Keep-alive
  const ping = setInterval(() => res.write(`: ping\n\n`), 15000);
  req.on('close', () => clearInterval(ping));
});

// ─── MCP JSON-RPC message handler ─────────────────────────────────────────────
app.post('/message', (req, res) => {
  const { jsonrpc, id, method, params = {} } = req.body;

  if (jsonrpc !== '2.0') {
    return res.status(400).json({ error: 'Expected JSON-RPC 2.0' });
  }

  try {
    let result;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'todo-notes-mcp', version: '1.0.0' }
        };
        break;

      case 'notifications/initialized':
        return res.status(204).send();

      case 'ping':
        result = {};
        break;

      case 'tools/list':
        result = { tools: TOOLS };
        break;

      case 'tools/call': {
        const { name, arguments: args = {} } = params;
        try {
          const data = executeTool(name, args);
          result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (e) {
          result = { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
        }
        break;
      }

      default:
        return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
    }

    res.json({ jsonrpc: '2.0', id, result });

  } catch (err) {
    res.json({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
});

app.listen(PORT, () => {
  console.log(`MCP Todo & Notes server on port ${PORT}`);
});