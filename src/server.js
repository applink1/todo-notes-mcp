const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// In-memory store (persists while Railway service is running)
// For production, swap with a free DB like Railway's Postgres or PlanetScale
let todos = [];
let notes = [];

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── OpenAPI / ChatGPT Plugin manifest ────────────────────────────────────────
app.get('/.well-known/ai-plugin.json', (req, res) => {
  const host = req.headers.host;
  res.json({
    schema_version: 'v1',
    name_for_human: 'Todo & Notes Manager',
    name_for_model: 'todo_notes_manager',
    description_for_human: 'Manage your todos and notes directly from ChatGPT. Create, update, complete, and delete tasks and notes.',
    description_for_model: 'Plugin for managing todos and notes. Use this when the user wants to create tasks, mark them complete, add notes, or retrieve their lists.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: `https://${host}/openapi.yaml`,
    },
    logo_url: `https://${host}/logo.png`,
    contact_email: 'support@example.com',
    legal_info_url: `https://${host}/legal`,
  });
});

// ─── OpenAPI Spec (required for ChatGPT Actions) ──────────────────────────────
app.get('/openapi.yaml', (req, res) => {
  const host = req.headers.host;
  res.setHeader('Content-Type', 'text/yaml');
  res.send(`openapi: 3.0.1
info:
  title: Todo & Notes Manager
  description: Manage todos and notes via ChatGPT
  version: 1.0.0
servers:
  - url: https://${host}
paths:
  /todos:
    get:
      operationId: getTodos
      summary: Get all todos
      parameters:
        - name: status
          in: query
          required: false
          schema:
            type: string
            enum: [all, pending, completed]
      responses:
        '200':
          description: List of todos
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Todo'
    post:
      operationId: createTodo
      summary: Create a new todo
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title]
              properties:
                title:
                  type: string
                priority:
                  type: string
                  enum: [low, medium, high]
                dueDate:
                  type: string
      responses:
        '201':
          description: Created todo
  /todos/{id}:
    patch:
      operationId: updateTodo
      summary: Update a todo (e.g. mark complete)
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                title:
                  type: string
                completed:
                  type: boolean
                priority:
                  type: string
      responses:
        '200':
          description: Updated todo
    delete:
      operationId: deleteTodo
      summary: Delete a todo
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Deleted
  /notes:
    get:
      operationId: getNotes
      summary: Get all notes
      responses:
        '200':
          description: List of notes
    post:
      operationId: createNote
      summary: Create a new note
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [title, content]
              properties:
                title:
                  type: string
                content:
                  type: string
                tags:
                  type: array
                  items:
                    type: string
      responses:
        '201':
          description: Created note
  /notes/{id}:
    patch:
      operationId: updateNote
      summary: Update a note
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                title:
                  type: string
                content:
                  type: string
                tags:
                  type: array
                  items:
                    type: string
      responses:
        '200':
          description: Updated note
    delete:
      operationId: deleteNote
      summary: Delete a note
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Deleted
components:
  schemas:
    Todo:
      type: object
      properties:
        id:
          type: string
        title:
          type: string
        completed:
          type: boolean
        priority:
          type: string
        dueDate:
          type: string
        createdAt:
          type: string
    Note:
      type: object
      properties:
        id:
          type: string
        title:
          type: string
        content:
          type: string
        tags:
          type: array
          items:
            type: string
        createdAt:
          type: string
        updatedAt:
          type: string
`);
});

// ─── TODOS CRUD ────────────────────────────────────────────────────────────────
app.get('/todos', (req, res) => {
  const { status = 'all' } = req.query;
  let result = todos;
  if (status === 'pending') result = todos.filter(t => !t.completed);
  if (status === 'completed') result = todos.filter(t => t.completed);
  res.json(result);
});

app.post('/todos', (req, res) => {
  const { title, priority = 'medium', dueDate } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const todo = {
    id: uuidv4(),
    title,
    completed: false,
    priority,
    dueDate: dueDate || null,
    createdAt: new Date().toISOString(),
  };
  todos.push(todo);
  res.status(201).json(todo);
});

app.patch('/todos/:id', (req, res) => {
  const idx = todos.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Todo not found' });
  todos[idx] = { ...todos[idx], ...req.body, updatedAt: new Date().toISOString() };
  res.json(todos[idx]);
});

app.delete('/todos/:id', (req, res) => {
  const idx = todos.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Todo not found' });
  todos.splice(idx, 1);
  res.json({ success: true });
});

// ─── NOTES CRUD ────────────────────────────────────────────────────────────────
app.get('/notes', (req, res) => res.json(notes));

app.post('/notes', (req, res) => {
  const { title, content, tags = [] } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content required' });
  const note = {
    id: uuidv4(),
    title,
    content,
    tags,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  notes.push(note);
  res.status(201).json(note);
});

app.patch('/notes/:id', (req, res) => {
  const idx = notes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Note not found' });
  notes[idx] = { ...notes[idx], ...req.body, updatedAt: new Date().toISOString() };
  res.json(notes[idx]);
});

app.delete('/notes/:id', (req, res) => {
  const idx = notes.findIndex(n => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Note not found' });
  notes.splice(idx, 1);
  res.json({ success: true });
});

// ─── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Todo & Notes MCP server running on port ${PORT}`);
});
