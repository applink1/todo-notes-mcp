'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const PORT = parseInt(process.env.PORT || '3000', 10);

// ─── Neon Postgres via HTTP (zero npm deps) ───────────────────────────────────
const NEON_URL = process.env.DATABASE_URL;

async function query(sql, params = []) {
  if (!NEON_URL) throw new Error('DATABASE_URL not set. Add your Neon connection string in Railway env vars.');
  const url = new URL(NEON_URL);
  const body = JSON.stringify({ query: sql, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: '/sql', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${url.password}`,
        'Neon-Connection-String': NEON_URL,
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error));
          else resolve(json.rows || []);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Gmail via raw SMTP/TLS (zero npm deps) ───────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

function sendEmail(to, subject, bodyText) {
  return new Promise((resolve, reject) => {
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      return reject(new Error('Gmail not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD in Railway env vars.'));
    }
    const tls = require('tls');
    const message = [
      `From: ${GMAIL_USER}`, `To: ${to}`, `Subject: ${subject}`,
      `MIME-Version: 1.0`, `Content-Type: text/plain; charset=UTF-8`, ``, bodyText
    ].join('\r\n');
    const authStr = Buffer.from(`\x00${GMAIL_USER}\x00${GMAIL_APP_PASSWORD}`).toString('base64');
    let step = 0, socket;
    const send = s => socket.write(s + '\r\n');
    function handle(line) {
      line = line.trim();
      if (step === 0 && line.startsWith('220')) { send('EHLO localhost'); step++; }
      else if (step === 1 && line.startsWith('250 ')) { send('AUTH PLAIN ' + authStr); step++; }
      else if (step === 2 && line.startsWith('235')) { send(`MAIL FROM:<${GMAIL_USER}>`); step++; }
      else if (step === 3 && line.startsWith('250')) { send(`RCPT TO:<${to}>`); step++; }
      else if (step === 4 && line.startsWith('250')) { send('DATA'); step++; }
      else if (step === 5 && line.startsWith('354')) {
        const encoded = Buffer.from(message).toString('base64').replace(/(.{76})/g,'$1\r\n');
        send(encoded + '\r\n.'); step++;
      } else if (step === 6 && line.startsWith('250')) { send('QUIT'); resolve({ success: true }); }
      else if (line.startsWith('5')) { reject(new Error('SMTP error: ' + line)); }
    }
    socket = tls.connect(465, 'smtp.gmail.com', {}, () => {});
    socket.on('error', reject);
    let buf = '';
    socket.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\r\n'); buf = lines.pop();
      lines.forEach(l => { if (l) handle(l); });
    });
  });
}

// ─── DB Init ──────────────────────────────────────────────────────────────────
async function initDB() {
  try {
    await query(`CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL, email TEXT, company TEXT, website TEXT,
      niche TEXT, status TEXT DEFAULT 'new'
        CHECK(status IN ('new','contacted','replied','qualified','closed_won','closed_lost')),
      notes TEXT, source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS outreach (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
      subject TEXT, body TEXT, sent_at TIMESTAMPTZ,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','failed')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await query(`CREATE TABLE IF NOT EXISTS followups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
      note TEXT, due_date DATE NOT NULL, done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    console.log('[DB] Tables ready');
  } catch(e) { console.error('[DB] Init error:', e.message); }
}

// ─── MCP Tools ────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'add_lead',
    description: 'Add a new lead to your sales pipeline.',
    inputSchema: {
      type: 'object', required: ['name'],
      properties: {
        name:    { type: 'string', description: 'Contact or company name' },
        email:   { type: 'string', description: 'Email address' },
        company: { type: 'string', description: 'Company name' },
        website: { type: 'string', description: 'Website URL' },
        niche:   { type: 'string', description: 'e.g. startup, agency, saas, restaurant, gym' },
        notes:   { type: 'string', description: 'Context or notes about this lead' },
        source:  { type: 'string', description: 'Where you found them: linkedin, twitter, referral, etc.' }
      }
    }
  },
  {
    name: 'get_leads',
    description: 'Get leads from the pipeline. Filter by status, niche, or keyword search.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['new','contacted','replied','qualified','closed_won','closed_lost','all'] },
        niche:  { type: 'string' },
        search: { type: 'string', description: 'Search by name, company, or email' },
        limit:  { type: 'number', description: 'Max results (default 20)' }
      }
    }
  },
  {
    name: 'update_lead_status',
    description: 'Move a lead through the sales pipeline stages.',
    inputSchema: {
      type: 'object', required: ['id', 'status'],
      properties: {
        id:     { type: 'string' },
        status: { type: 'string', enum: ['new','contacted','replied','qualified','closed_won','closed_lost'] },
        notes:  { type: 'string', description: 'Note about why status changed' }
      }
    }
  },
  {
    name: 'delete_lead',
    description: 'Delete a lead from the pipeline.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
  },
  {
    name: 'draft_email',
    description: 'Draft a personalised cold outreach email for a lead. Saves as draft, does NOT send.',
    inputSchema: {
      type: 'object', required: ['lead_id'],
      properties: {
        lead_id:     { type: 'string' },
        tone:        { type: 'string', enum: ['professional','casual','direct'] },
        service:     { type: 'string', description: 'Service to pitch e.g. FlutterFlow app development' },
        custom_note: { type: 'string', description: 'Personalisation angle to include' }
      }
    }
  },
  {
    name: 'send_email',
    description: 'Send an email to a lead via Gmail. Updates lead status to contacted automatically.',
    inputSchema: {
      type: 'object', required: ['lead_id', 'subject', 'body'],
      properties: {
        lead_id:       { type: 'string' },
        subject:       { type: 'string' },
        body:          { type: 'string' },
        update_status: { type: 'boolean', description: 'Auto-update status to contacted (default true)' }
      }
    }
  },
  {
    name: 'add_followup',
    description: 'Schedule a follow-up reminder for a lead on a specific date.',
    inputSchema: {
      type: 'object', required: ['lead_id', 'due_date'],
      properties: {
        lead_id:  { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD format' },
        note:     { type: 'string', description: 'What to follow up about' }
      }
    }
  },
  {
    name: 'get_followups',
    description: 'Get upcoming follow-up reminders. Use every morning to see what needs attention today.',
    inputSchema: {
      type: 'object',
      properties: {
        days_ahead:   { type: 'number', description: 'Followups due in next N days (default 7)' },
        include_done: { type: 'boolean' }
      }
    }
  },
  {
    name: 'complete_followup',
    description: 'Mark a follow-up as done.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }
  },
  {
    name: 'get_pipeline_stats',
    description: 'Full pipeline summary: counts by status, conversion rates, emails sent, recent activity.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'find_leads_by_niche',
    description: 'Generate targeted lead research: search queries, outreach angles, and platforms to find prospects in any niche.',
    inputSchema: {
      type: 'object', required: ['niche'],
      properties: {
        niche:    { type: 'string', description: 'e.g. restaurant apps, gym management, real estate, logistics' },
        location: { type: 'string', description: 'e.g. UAE, UK, US, Pakistan' }
      }
    }
  },
  {
    name: 'get_email_templates',
    description: 'Get proven cold email templates for cold outreach, follow-up, re-engagement, or proposals.',
    inputSchema: {
      type: 'object',
      properties: {
        type:  { type: 'string', enum: ['cold_outreach','followup','reengagement','proposal'] },
        niche: { type: 'string' }
      }
    }
  }
];

// ─── Tool handlers ────────────────────────────────────────────────────────────
async function runTool(name, args) {
  switch(name) {

    case 'add_lead': {
      const rows = await query(
        `INSERT INTO leads (name, email, company, website, niche, notes, source) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [args.name, args.email||null, args.company||null, args.website||null, args.niche||null, args.notes||null, args.source||null]
      );
      return { success: true, lead: rows[0], message: `✓ Lead "${args.name}" added to pipeline` };
    }

    case 'get_leads': {
      let sql = `SELECT l.*,
        (SELECT COUNT(*) FROM outreach WHERE lead_id=l.id AND status='sent') as emails_sent,
        (SELECT COUNT(*) FROM followups WHERE lead_id=l.id AND done=false) as pending_followups
        FROM leads l WHERE 1=1`;
      const p = [];
      if (args.status && args.status !== 'all') { p.push(args.status); sql += ` AND l.status=$${p.length}`; }
      if (args.niche) { p.push(`%${args.niche}%`); sql += ` AND l.niche ILIKE $${p.length}`; }
      if (args.search) {
        p.push(`%${args.search}%`);
        sql += ` AND (l.name ILIKE $${p.length} OR l.company ILIKE $${p.length} OR l.email ILIKE $${p.length})`;
      }
      sql += ` ORDER BY l.created_at DESC LIMIT $${p.length+1}`;
      p.push(args.limit || 20);
      const rows = await query(sql, p);
      return { leads: rows, count: rows.length };
    }

    case 'update_lead_status': {
      const noteClause = args.notes ? `, notes = COALESCE(notes || E'\\n', '') || $3` : '';
      const p = [args.status, args.id];
      if (args.notes) p.push(`[${new Date().toLocaleDateString()}] ${args.notes}`);
      const rows = await query(`UPDATE leads SET status=$1, updated_at=NOW()${noteClause} WHERE id=$2 RETURNING *`, p);
      if (!rows.length) throw new Error('Lead not found');
      return { success: true, lead: rows[0], message: `✓ Status updated to "${args.status}"` };
    }

    case 'delete_lead': {
      await query(`DELETE FROM leads WHERE id=$1`, [args.id]);
      return { success: true, message: 'Lead deleted' };
    }

    case 'draft_email': {
      const leads = await query(`SELECT * FROM leads WHERE id=$1`, [args.lead_id]);
      if (!leads.length) throw new Error('Lead not found');
      const lead = leads[0];
      const service = args.service || 'FlutterFlow app development and mobile solutions';
      const tone = args.tone || 'professional';
      const custom = args.custom_note ? `\n${args.custom_note}\n` : '';
      const name = lead.name || lead.company || 'there';
      const co = lead.company ? ` (${lead.company})` : '';

      const bodies = {
        professional: `Hi ${name},\n\nI came across your work${co} and wanted to reach out directly.\n\nI specialise in ${service} — helping ${lead.niche || 'businesses'} launch and scale mobile products faster and more cost-effectively than traditional development.${custom}\nWhat I can help with:\n• Custom iOS + Android apps from a single FlutterFlow codebase\n• Rapid MVP delivery — production-ready in 2–4 weeks\n• Full backend integration (APIs, payments, auth)\n\nWould a quick 15-minute call make sense to see if there's a fit?\n\nBest regards`,
        casual: `Hey ${name},\n\nNoticed your work${co} and thought I'd reach out.\n\nI build mobile apps with FlutterFlow — it's a no-code/low-code platform that cuts development time dramatically without sacrificing quality.${custom}\nHappy to show you what's possible in a quick demo. Worth a chat?\n\nCheers`,
        direct: `Hi ${name},\n\nQuick question — are you currently exploring building or improving a mobile app${co}?\n\nI build production-grade iOS + Android apps with FlutterFlow. Fast delivery, significantly lower cost than traditional dev.${custom}\n15 mins this week?`
      };
      const subjects = {
        professional: `${service} for ${lead.company || lead.name}`,
        casual: `Quick idea for ${lead.company || lead.name}`,
        direct: `Mobile app for ${lead.company || lead.name}?`
      };
      const subject = subjects[tone] || subjects.professional;
      const body = bodies[tone] || bodies.professional;
      await query(`INSERT INTO outreach (lead_id, subject, body, status) VALUES ($1,$2,$3,'draft')`, [args.lead_id, subject, body]);
      return { draft: { subject, body, to: lead.email, lead_name: lead.name }, message: 'Draft saved. Use send_email to send it.' };
    }

    case 'send_email': {
      const leads = await query(`SELECT * FROM leads WHERE id=$1`, [args.lead_id]);
      if (!leads.length) throw new Error('Lead not found');
      const lead = leads[0];
      if (!lead.email) throw new Error(`Lead "${lead.name}" has no email. Update the lead with their email first.`);
      let sent = false, errMsg = null;
      try { await sendEmail(lead.email, args.subject, args.body); sent = true; } catch(e) { errMsg = e.message; }
      await query(
        `INSERT INTO outreach (lead_id, subject, body, sent_at, status) VALUES ($1,$2,$3,$4,$5)`,
        [args.lead_id, args.subject, args.body, sent ? new Date().toISOString() : null, sent ? 'sent' : 'failed']
      );
      if (sent && args.update_status !== false) {
        await query(`UPDATE leads SET status='contacted', updated_at=NOW() WHERE id=$1`, [args.lead_id]);
      }
      if (!sent) throw new Error(`Failed to send: ${errMsg}`);
      return { success: true, message: `✓ Email sent to ${lead.email}. Lead status → contacted.` };
    }

    case 'add_followup': {
      const rows = await query(
        `INSERT INTO followups (lead_id, due_date, note) VALUES ($1,$2,$3) RETURNING *`,
        [args.lead_id, args.due_date, args.note || null]
      );
      const lead = await query(`SELECT name FROM leads WHERE id=$1`, [args.lead_id]);
      return { success: true, followup: rows[0], message: `✓ Follow-up set for ${args.due_date} with ${lead[0]?.name || 'lead'}` };
    }

    case 'get_followups': {
      const days = args.days_ahead || 7;
      const doneFilter = args.include_done ? '' : 'AND f.done = false';
      const rows = await query(
        `SELECT f.*, l.name as lead_name, l.email as lead_email, l.company, l.status as lead_status
         FROM followups f JOIN leads l ON l.id=f.lead_id
         WHERE f.due_date <= CURRENT_DATE + INTERVAL '${parseInt(days)} days' ${doneFilter}
         ORDER BY f.due_date ASC LIMIT 50`
      );
      const overdue = rows.filter(r => new Date(r.due_date) < new Date()).length;
      return { followups: rows, count: rows.length, overdue, message: `${rows.length} follow-ups in next ${days} days (${overdue} overdue)` };
    }

    case 'complete_followup': {
      const rows = await query(`UPDATE followups SET done=true WHERE id=$1 RETURNING *`, [args.id]);
      if (!rows.length) throw new Error('Follow-up not found');
      return { success: true, message: '✓ Follow-up marked done' };
    }

    case 'get_pipeline_stats': {
      const stats = await query(`SELECT status, COUNT(*) as count FROM leads GROUP BY status`);
      const [tot, emails, fups, recent] = await Promise.all([
        query(`SELECT COUNT(*) as n FROM leads`),
        query(`SELECT COUNT(*) as n FROM outreach WHERE status='sent'`),
        query(`SELECT COUNT(*) as n FROM followups WHERE done=false`),
        query(`SELECT name, company, status, updated_at FROM leads ORDER BY updated_at DESC LIMIT 5`)
      ]);
      const byStatus = {};
      stats.forEach(r => { byStatus[r.status] = parseInt(r.count); });
      const total = parseInt(tot[0]?.n || 0);
      const won = byStatus.closed_won || 0;
      return {
        total_leads: total,
        by_status: byStatus,
        emails_sent: parseInt(emails[0]?.n || 0),
        pending_followups: parseInt(fups[0]?.n || 0),
        conversion_rate: total > 0 ? `${Math.round(won/total*100)}%` : '0%',
        recent_activity: recent
      };
    }

    case 'find_leads_by_niche': {
      const n = args.niche, loc = args.location || 'worldwide';
      const angles = {
        restaurant: 'Their own ordering app cuts Uber Eats fees by 30%+ and builds direct customer relationships',
        gym: 'Member check-in, class booking, and progress tracking app increases retention significantly',
        'real estate': 'Property listings app with virtual tours and lead capture converts 3x better than web',
        logistics: 'Driver tracking + delivery management app eliminates phone calls and manual updates',
        ecommerce: 'Branded shopping app delivers 3x better conversion than mobile web and enables push notifications',
        saas: 'Mobile companion app for their SaaS product dramatically increases daily active usage',
        startup: 'FlutterFlow MVPs launch in 2-4 weeks at 50-70% less cost than native development'
      };
      const angle = angles[n.toLowerCase()] || `Custom mobile app eliminates manual processes and delights ${n} customers`;
      return {
        niche: n, location: loc,
        where_to_find_leads: [
          `LinkedIn: search "${n}" companies with 5-50 employees in ${loc}`,
          `ProductHunt: browse recent launches in "${n}" category`,
          `Clutch.co: companies in "${n}" seeking app development`,
          `AngelList/Wellfound: funded "${n}" startups`,
          `Twitter/X: search "${n}" "need an app" OR "build an app" OR "mobile app"`,
          `Google: "${n} company ${loc}" + check if they have a mobile app`
        ],
        outreach_angle: angle,
        search_queries_for_google: [
          `site:linkedin.com/company "${n}" ${loc}`,
          `"${n}" "${loc}" "mobile app" -apple.com -play.google.com`,
          `"${n}" startup "${loc}" 2023 OR 2024`
        ],
        suggested_dm: `I help ${n} businesses build mobile apps 2-4x faster. ${angle}. Worth 15 mins?`,
        next_step: `Use add_lead to add each prospect, then draft_email to write personalised outreach.`
      };
    }

    case 'get_email_templates': {
      const n = args.niche || 'businesses';
      const t = {
        cold_outreach: {
          subject: `Quick idea for [Company]`,
          body: `Hi [Name],\n\nI came across [Company] and wanted to reach out.\n\nI build mobile apps for ${n} using FlutterFlow — production iOS + Android in 2-4 weeks, at a fraction of traditional dev cost.\n\n[One specific observation about their business or problem you can solve]\n\nWorth a quick 15-min chat?\n\n[Your name]`,
          tips: ['Personalise line 3 for every send', 'Keep under 80 words', 'One clear CTA only']
        },
        followup: {
          subject: `Re: Quick idea for [Company]`,
          body: `Hi [Name],\n\nJust following up on my note from [X days] ago — wanted to make sure it didn\'t get buried.\n\nHappy to share a 2-min screen recording showing what a FlutterFlow app looks like for ${n} if that\'s easier than a call.\n\nStill worth exploring?\n\n[Your name]`,
          tips: ['Send 4-5 days after cold email', 'Offer lower-friction option (video vs call)', 'Max 2 follow-ups then move on']
        },
        reengagement: {
          subject: `Still thinking about an app for [Company]?`,
          body: `Hi [Name],\n\nReaching back out — I\'ve been working with a few ${n} clients recently and thought of you.\n\nOne client [specific result relevant to their niche].\n\nIs mobile still something on your radar for [Company]?\n\n[Your name]`,
          tips: ['Lead with a concrete result from a similar client', 'Use after 2-3 months of silence', 'Make it feel like a fresh start']
        },
        proposal: {
          subject: `Proposal: [App Name] for [Company]`,
          body: `Hi [Name],\n\nFollowing our conversation, here\'s a quick outline:\n\nSCOPE\n• [App name] — iOS + Android\n• Core features: [feature 1], [feature 2], [feature 3]\n• Built with FlutterFlow\n\nTIMELINE\n• Week 1-2: Design & prototype\n• Week 3-4: Core build\n• Week 5: Testing & launch\n\nINVESTMENT\n• [Your rate/package]\n\nNext step: Confirm scope and I\'ll send a contract.\n\n[Your name]`,
          tips: ['Fill specifics from your discovery call', 'Keep scope tight for first engagement', 'Make next step a single clear action']
        }
      };
      const type = args.type || 'cold_outreach';
      return { template: t[type] || t.cold_outreach, available_types: Object.keys(t) };
    }

    default: throw new Error('Unknown tool: ' + name);
  }
}

// ─── MCP session store ────────────────────────────────────────────────────────
const sessions = new Map();
const uid = () => crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function jsonRes(res, code, obj) {
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

async function handleRPC(msg, sessionId) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    sessions.set(sessionId, { createdAt: Date.now() });
    return { id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'leads-mcp', version: '2.0.0' } } };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'ping') return { id, result: {} };
  if (method === 'tools/list') return { id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const { name, arguments: a = {} } = params;
    try {
      const data = await runTool(name, a);
      return { id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } };
    } catch(e) {
      return { id, result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true } };
    }
  }
  return { id, error: { code: -32601, message: 'Method not found: ' + method } };
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch(_) {}
  const host  = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base  = proto + '://' + host;

  // Health
  if (pathname === '/health') return jsonRes(res, 200, { status: 'ok', db: !!NEON_URL, gmail: !!GMAIL_USER });

  // Dashboard API
  if (pathname === '/api/stats') {
    try {
      const [stats, tot, emails, fups, recent] = await Promise.all([
        query(`SELECT status, COUNT(*) as count FROM leads GROUP BY status`),
        query(`SELECT COUNT(*) as n FROM leads`),
        query(`SELECT COUNT(*) as n FROM outreach WHERE status='sent'`),
        query(`SELECT COUNT(*) as n FROM followups WHERE done=false AND due_date <= CURRENT_DATE + 7`),
        query(`SELECT name, company, status, updated_at FROM leads ORDER BY updated_at DESC LIMIT 8`)
      ]);
      const byStatus = {};
      stats.forEach(r => { byStatus[r.status] = parseInt(r.count); });
      return jsonRes(res, 200, { byStatus, total: parseInt(tot[0]?.n||0), emailsSent: parseInt(emails[0]?.n||0), followupsDue: parseInt(fups[0]?.n||0), recent });
    } catch(e) { return jsonRes(res, 200, { error: e.message, byStatus:{}, total:0, emailsSent:0, followupsDue:0, recent:[] }); }
  }
  if (pathname === '/api/leads') {
    try { return jsonRes(res, 200, await query(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 100`)); }
    catch(e) { return jsonRes(res, 200, []); }
  }
  if (pathname === '/api/followups') {
    try { return jsonRes(res, 200, await query(
      `SELECT f.*, l.name as lead_name, l.company FROM followups f JOIN leads l ON l.id=f.lead_id WHERE f.done=false ORDER BY f.due_date ASC LIMIT 20`
    )); } catch(e) { return jsonRes(res, 200, []); }
  }

  // OAuth passthrough (ChatGPT App Marketplace / MCP clients)
  if (pathname === '/.well-known/oauth-authorization-server') return jsonRes(res, 200, {
    issuer: base, authorization_endpoint: base+'/oauth/authorize',
    token_endpoint: base+'/oauth/token', registration_endpoint: base+'/oauth/register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none']
  });
  if (req.method === 'POST' && pathname === '/oauth/register') {
    let b = {}; try { b = await readJSON(req); } catch(_) {}
    return jsonRes(res, 201, { client_id: uid(), client_secret: uid(), client_name: b.client_name||'Client', redirect_uris: b.redirect_uris||[], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  }
  if (req.method === 'GET' && pathname === '/oauth/authorize') {
    const u = new URL(req.url, base), r = u.searchParams.get('redirect_uri')||'', s = u.searchParams.get('state')||'';
    res.writeHead(302, { Location: r+(r.includes('?')?'&':'?')+'code='+uid()+(s?'&state='+encodeURIComponent(s):'') }); return res.end();
  }
  if (req.method === 'POST' && pathname === '/oauth/token') return jsonRes(res, 200, { access_token: 'open-'+uid(), token_type: 'bearer', expires_in: 86400*365 });

  // MCP endpoint (Streamable HTTP)
  if (req.method === 'POST' && pathname === '/mcp') {
    let body; try { body = await readJSON(req); } catch(e) { return jsonRes(res, 400, { jsonrpc:'2.0', id:null, error:{code:-32700,message:'Parse error'} }); }
    let sid = req.headers['mcp-session-id'];
    if (!sid) { sid = uid(); res.setHeader('Mcp-Session-Id', sid); }
    const msgs = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const msg of msgs) {
      if (!msg || msg.jsonrpc !== '2.0') continue;
      const r = await handleRPC(msg, sid);
      if (r) responses.push({ jsonrpc: '2.0', ...r });
    }
    if (!responses.length) { res.writeHead(204); return res.end(); }
    return jsonRes(res, 200, Array.isArray(body) ? responses : responses[0]);
  }
  if (req.method === 'DELETE' && pathname === '/mcp') {
    const sid = req.headers['mcp-session-id']; if (sid) sessions.delete(sid);
    res.writeHead(204); return res.end();
  }
  if (req.method === 'GET' && pathname === '/mcp') return jsonRes(res, 200, { transport: 'streamable-http', protocolVersion: '2024-11-05' });

  // Serve dashboard
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const fs = require('fs'), path = require('path');
    try {
      const content = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(content);
    } catch(e) { res.writeHead(404); return res.end('Not found'); }
  }

  res.writeHead(404); res.end('Not found');
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Leads MCP] Port ${PORT} | DB: ${!!NEON_URL} | Gmail: ${!!GMAIL_USER}`);
  await initDB();
});
server.on('error', err => { console.error('[Fatal]', err); process.exit(1); });