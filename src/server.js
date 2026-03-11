'use strict';
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const PORT   = parseInt(process.env.PORT || '3000', 10);

// ─── Neon HTTP SQL API ────────────────────────────────────────────────────────
// Correct format: POST https://{host}/sql
// Header: Neon-Connection-String: postgresql://...
// Body:   { query: "SELECT $1", params: ["val"] }
// Returns: { rows: [...], rowCount: N, fields: [...] }
const DATABASE_URL = process.env.DATABASE_URL || '';

async function db(sql, params = []) {
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set in Railway environment variables');
  let hostname;
  try { hostname = new URL(DATABASE_URL).hostname; }
  catch(e) { throw new Error('DATABASE_URL is not a valid postgres URL'); }

  const body = JSON.stringify({ query: sql, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      port: 443,
      path: '/sql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': DATABASE_URL,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          // Neon error format
          if (json.code || json.message) return reject(new Error(`DB: ${json.message || json.code}`));
          resolve(json.rows || []);
        } catch(e) {
          reject(new Error(`DB parse error (status ${res.statusCode}): ${raw.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('DB timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── DB Init: create tables if not exist ─────────────────────────────────────
async function initDB() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS leads (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL,
      email      TEXT,
      company    TEXT,
      website    TEXT,
      niche      TEXT,
      status     TEXT DEFAULT 'new'
                 CHECK(status IN ('new','contacted','replied','qualified','closed_won','closed_lost')),
      notes      TEXT,
      source     TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS outreach (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id    UUID REFERENCES leads(id) ON DELETE CASCADE,
      subject    TEXT,
      body       TEXT,
      sent_at    TIMESTAMPTZ,
      status     TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','failed')),
      error_msg  TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS followups (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id    UUID REFERENCES leads(id) ON DELETE CASCADE,
      note       TEXT,
      due_date   DATE NOT NULL,
      done       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];
  for (const sql of tables) {
    try { await db(sql); } catch(e) { console.error('[DB init]', e.message); }
  }
  // verify connection
  try {
    const rows = await db('SELECT COUNT(*) AS n FROM leads');
    console.log(`[DB] Connected ✓  leads: ${rows[0].n}`);
  } catch(e) {
    console.error('[DB] Connection failed:', e.message);
  }
}



// ─── Email sending ────────────────────────────────────────────────────────────
// Supports Brevo and Resend — both use HTTPS port 443 (works on Railway)
// Brevo: brevo.com  — 300/day free, NO domain verification needed ← USE THIS
// Resend: resend.com — 3,000/month free, needs verified domain for cold email
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const BREVO_KEY  = process.env.BREVO_API_KEY  || '';
const GMAIL_USER = process.env.GMAIL_USER     || '';
const FROM_NAME  = process.env.FROM_NAME      || 'App Developer';

// Add a professional footer to every email
// - Gives a reply-to address so leads can respond
// - Includes unsubscribe notice (required to avoid spam filters)
// - Makes emails look legitimate not like spam
function wrapEmailBody(text) {
  const replyTo = GMAIL_USER || 'your@email.com';
  return [
    text.trim(),
    '',
    '---',
    `Reply directly to this email or reach me at: ${replyTo}`,
    'To unsubscribe from these emails, reply with "unsubscribe".',
  ].join('\n');
}

// ── Brevo (brevo.com — 300/day free, no domain verification needed) ───────────
function sendViaBrevo(to, subject, text) {
  return new Promise((resolve, reject) => {
    if (!BREVO_KEY) return reject(new Error('BREVO_API_KEY not set'));
    const senderEmail = GMAIL_USER || 'noreply@gmail.com';
    const fullText    = wrapEmailBody(text);
    const body = JSON.stringify({
      sender:      { name: FROM_NAME, email: senderEmail },
      to:          [{ email: to }],
      replyTo:     { email: senderEmail },
      subject,
      textContent: fullText,
    });
    console.log('[Brevo] Sending to:', to, '| from:', senderEmail);
    const req = https.request({
      hostname: 'api.brevo.com', port: 443, path: '/v3/smtp/email', method: 'POST',
      headers: {
        'api-key':        BREVO_KEY,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        console.log('[Brevo] Response:', res.statusCode, raw.slice(0, 400));
        try {
          const j = JSON.parse(raw);
          if (res.statusCode < 300) return resolve({ ok: true, provider: 'brevo', id: j.messageId });
          reject(new Error(`Brevo ${res.statusCode}: ${j.message || raw}`));
        } catch(e) { reject(new Error('Brevo parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', e => reject(new Error('Brevo network error: ' + e.code + ' ' + e.message)));
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Brevo timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Resend (resend.com — 3,000/month free, needs verified domain) ─────────────
function sendViaResend(to, subject, text) {
  return new Promise((resolve, reject) => {
    if (!RESEND_KEY) return reject(new Error('RESEND_API_KEY not set'));
    // IMPORTANT: fromEmail MUST be a verified domain on your Resend account
    // onboarding@resend.dev only works if "to" is your own Resend account email
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
    const from      = `${FROM_NAME} <${fromEmail}>`;
    const fullText  = wrapEmailBody(text);
    const body = JSON.stringify({
      from,
      to:       [to],
      subject,
      text:     fullText,
      reply_to: GMAIL_USER ? [GMAIL_USER] : undefined,
    });
    console.log('[Resend] Sending to:', to, '| from:', from);
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: {
        'Authorization':  `Bearer ${RESEND_KEY}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        console.log('[Resend] Response:', res.statusCode, raw.slice(0, 400));
        try {
          const j = JSON.parse(raw);
          if (res.statusCode < 300) return resolve({ ok: true, provider: 'resend', id: j.id });
          reject(new Error(`Resend ${res.statusCode}: ${j.message || j.name || raw}`));
        } catch(e) { reject(new Error('Resend parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', e => reject(new Error('Resend network error: ' + e.code + ' ' + e.message)));
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Resend timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Master send — Brevo first (no domain needed), then Resend ─────────────────
async function sendGmail(to, subject, bodyText) {
  const errors = [];

  // Try Brevo first — works without domain verification
  if (BREVO_KEY) {
    try { return await sendViaBrevo(to, subject, bodyText); }
    catch(e) { errors.push('Brevo: ' + e.message); console.error('[Email] Brevo failed:', e.message); }
  }

  // Try Resend as fallback
  if (RESEND_KEY) {
    try { return await sendViaResend(to, subject, bodyText); }
    catch(e) { errors.push('Resend: ' + e.message); console.error('[Email] Resend failed:', e.message); }
  }

  // No keys set at all
  if (!BREVO_KEY && !RESEND_KEY) {
    throw new Error(
      'No email provider configured!\n\n' +
      'EASIEST SETUP (Brevo — free, no domain needed):\n' +
      '  1. Go to brevo.com → Sign up free\n' +
      '  2. Top right → SMTP & API → API Keys → Generate new key\n' +
      '  3. Railway → Variables → add:  BREVO_API_KEY = xkeysib-xxxx\n' +
      '  4. Also add: GMAIL_USER = your@gmail.com  and  FROM_NAME = Your Name\n' +
      '  5. Redeploy → test with: test_email to your@gmail.com'
    );
  }

  throw new Error('All email providers failed:\n' + errors.join('\n'));
}

// ─── Lead finder data ─────────────────────────────────────────────────────────
function getLeadIntel(niche, location) {
  const loc = location || 'worldwide';
  const n = niche.toLowerCase().trim();
  const map = {
    restaurant: {
      pain: 'Paying 15–30% commission to Talabat/Uber Eats on every single order',
      pitch: 'Your own ordering app pays for itself in 2 months vs Talabat commissions',
      budget: '$2,000–$8,000',
      linkedin: `"restaurant owner" OR "F&B manager" OR "food & beverage director" location:"${loc}"`,
      where: [
        `Talabat/Uber Eats top-rated restaurants in ${loc} — they pay the most in fees`,
        `Google Maps: "restaurant" ${loc} — filter by 50+ reviews`,
        `Instagram: food accounts in ${loc} with 2k+ followers but no ordering link in bio`,
      ],
      signals: ['2+ locations (growing chain)', 'Active Instagram but orders via WhatsApp', 'Posts complaining about delivery fees'],
    },
    gym: {
      pain: 'Class bookings via WhatsApp, no member retention, manual check-in sheets',
      pitch: 'Members book classes themselves, you get automated attendance and retention data',
      budget: '$1,500–$6,000',
      linkedin: `"gym owner" OR "fitness center" OR "CrossFit" OR "health club" location:"${loc}"`,
      where: [
        `Google Maps: "gym" OR "fitness center" OR "CrossFit" in ${loc}`,
        `Instagram: fitness accounts in ${loc} without a booking app link`,
        `Facebook Groups: fitness/gym owners in ${loc}`,
      ],
      signals: ['Uses WhatsApp for class scheduling', '100+ members', 'Has an Instagram but no app'],
    },
    'real estate': {
      pain: 'Losing leads to Bayut/Zameen platform — clients save the portal, not the agency',
      pitch: "Own your leads — clients bookmark YOUR app, not Bayut's listing",
      budget: '$4,000–$15,000',
      linkedin: `"real estate agency" OR "property developer" OR "real estate broker" location:"${loc}"`,
      where: [
        `Bayut/Zameen/Propertyfinder — top agencies in ${loc}`,
        `LinkedIn: "real estate" companies in ${loc} with 5–50 employees`,
        `Google: "property agency" ${loc} with their own website`,
      ],
      signals: ['5+ agents', 'Own website + active listings', 'No mobile app'],
    },
    ecommerce: {
      pain: 'Selling via Instagram DMs or basic website — low mobile conversion, no repeat customers',
      pitch: 'A branded shopping app gives 3x better conversion and builds a loyal customer base',
      budget: '$2,500–$9,000',
      linkedin: `"ecommerce" OR "online store" OR "shopify" location:"${loc}"`,
      where: [
        `Instagram shops in ${loc} with 5k+ followers`,
        `Shopify stores in ${loc} — check with commerce inspector`,
        `Facebook marketplace sellers scaling up in ${loc}`,
      ],
      signals: ['Active Instagram shop', 'Running paid ads', 'Sells physical products'],
    },
    startup: {
      pain: 'Dev quotes are $50k+ and 6 months — MVP never launches',
      pitch: 'Launch your MVP in 4 weeks for what others charge in 4 months',
      budget: '$5,000–$20,000',
      linkedin: `"founder" OR "co-founder" OR "CEO" "mobile app" OR "startup" location:"${loc}"`,
      where: [
        `ProductHunt — recent launches in ${loc} needing a mobile companion`,
        `AngelList/Wellfound — seed-funded startups in ${loc}`,
        `LinkedIn: "co-founder" + "app" in ${loc}`,
      ],
      signals: ['Raised seed funding', 'Job posting for Flutter/React Native dev', 'Web-only product with mobile demand'],
    },
    agency: {
      pain: "Clients ask for mobile apps but can't deliver — turning down deals",
      pitch: 'White-label partnership — you sell the project, I build it, you keep the margin',
      budget: '$4,000–$18,000/project',
      linkedin: `"digital agency" OR "web agency" OR "creative agency" OR "marketing agency" location:"${loc}"`,
      where: [
        `Clutch.co — digital agencies in ${loc}`,
        `LinkedIn — "web agency" in ${loc} with 5–50 employees`,
        `Upwork agencies posting mobile app projects`,
      ],
      signals: ['Web/design agency with no mobile services page', '5–50 employees', 'Active on LinkedIn'],
    },
    logistics: {
      pain: 'Drivers on WhatsApp, no live tracking, manual proof of delivery',
      pitch: 'Live GPS tracking + digital POD — eliminate WhatsApp dispatch in 4 weeks',
      budget: '$5,000–$18,000',
      linkedin: `"logistics" OR "courier service" OR "last mile delivery" OR "freight" location:"${loc}"`,
      where: [
        `Google: "courier company" OR "delivery service" in ${loc}`,
        `LinkedIn: logistics companies in ${loc} with 10–100 employees`,
        `E-commerce Facebook groups — delivery businesses advertising`,
      ],
      signals: ['10+ drivers', 'WhatsApp for dispatch coordination', 'Growing delivery volume'],
    },
    healthcare: {
      pain: 'Appointments by phone call, no reminders, no digital patient records',
      pitch: 'Patients book online 24/7, automated reminders cut no-shows by 40%',
      budget: '$6,000–$25,000',
      linkedin: `"clinic owner" OR "medical center" OR "private hospital" OR "polyclinic" location:"${loc}"`,
      where: [
        `Google: "private clinic" OR "medical center" in ${loc}`,
        `LinkedIn: "clinic director" OR "medical director" in ${loc}`,
        `Instagram: private clinics in ${loc} with active social media`,
      ],
      signals: ['Private clinic with 3+ doctors', 'Active Instagram/Facebook', 'No online booking system'],
    },
    school: {
      pain: 'Parent communication via printed circulars and 10 different WhatsApp groups',
      pitch: 'Replace all WhatsApp chaos with one professional school app parents will love',
      budget: '$3,500–$12,000',
      linkedin: `"school principal" OR "academy director" OR "private school" location:"${loc}"`,
      where: [
        `Google: "private school" OR "international school" in ${loc}`,
        `LinkedIn: school principals/directors in ${loc}`,
        `Facebook: parent groups for private schools in ${loc}`,
      ],
      signals: ['200+ students', 'Multiple WhatsApp parent groups', 'No dedicated school app'],
    },
  };

  const info = map[n] || {
    pain: `Manual processes and no mobile presence in the ${niche} sector`,
    pitch: `Custom mobile app — iOS + Android in 3–4 weeks, 50–70% less than traditional dev`,
    budget: '$2,000–$10,000',
    linkedin: `"${niche}" location:"${loc}"`,
    where: [`Google: "${niche}" companies in ${loc}`, `LinkedIn: "${niche}" in ${loc}`, `Instagram: ${niche} businesses in ${loc}`],
    signals: ['Active social media', 'Website but no app', 'Growing business'],
  };

  return {
    niche, location: loc,
    THEIR_PAIN:       info.pain,
    YOUR_PITCH:       info.pitch,
    TYPICAL_BUDGET:   info.budget,
    WHERE_TO_FIND:    info.where,
    LINKEDIN_SEARCH:  info.linkedin,
    BUYING_SIGNALS:   info.signals,
    GOOGLE_SEARCHES: [
      `"${niche}" company ${loc} site:linkedin.com`,
      `"${niche}" "${loc}" "mobile app" -jobs`,
      `"${niche}" "${loc}" "need an app" OR "looking for developer"`,
    ],
    OTHER_PLATFORMS: [
      `Clutch.co → search "${niche}" + ${loc}`,
      `ProductHunt → browse ${niche} category`,
      `Upwork → find clients posting "${niche} app" projects`,
      `Instagram → #${niche.replace(/\s+/g, '')} in ${loc}`,
    ],
    NEXT_STEP: `1. Search LinkedIn using the string above  2. Find 5–10 companies  3. add_lead for each  4. Say "run full outreach for all new leads" to automate emails`,
  };
}

// ─── Email composer ───────────────────────────────────────────────────────────
function composeEmail(lead, opts = {}) {
  const tone    = opts.tone || 'professional';
  const service = opts.service || 'FlutterFlow mobile app development';
  const extra   = opts.custom_note ? `\n${opts.custom_note}\n` : '';
  const name    = lead.name || lead.company || 'there';
  const co      = lead.company ? ` (${lead.company})` : '';
  const niche   = lead.niche || 'your industry';

  const subjects = {
    professional: `Mobile app for ${lead.company || lead.name}`,
    casual:       `Quick idea for ${lead.company || lead.name}`,
    direct:       `App development for ${lead.company || lead.name}?`,
    followup:     `Re: Mobile app for ${lead.company || lead.name}`,
  };
  const bodies = {
    professional:
`Hi ${name},

I came across your work${co} and wanted to reach out.

I specialise in ${service} — helping ${niche} businesses launch mobile products faster and more cost-effectively than traditional development.${extra}
What I can offer:
• iOS + Android app from a single FlutterFlow codebase
• Production-ready in 3–4 weeks
• Full backend, payments, and API integration included

Would a quick 15-minute call make sense to see if there's a fit?

Best regards`,

    casual:
`Hey ${name},

Spotted your work${co} and thought I'd reach out directly.

I build mobile apps with FlutterFlow — cuts development time by 70% without sacrificing quality.${extra}
Happy to show you a quick demo. Worth a chat?

Cheers`,

    direct:
`Hi ${name},

Quick question — are you currently looking to build or improve a mobile app${co}?

I build production-grade iOS + Android apps with FlutterFlow. Fast delivery, significantly lower cost.${extra}
15 minutes this week?`,

    followup:
`Hi ${name},

Following up on my message from last week — just wanted to make sure it didn't get buried.

I'm happy to send a 2-minute screen recording showing exactly what an app could look like for ${lead.company || lead.name} — no call needed.

Still worth exploring?

Best regards`,
  };

  return {
    subject: subjects[tone] || subjects.professional,
    body:    bodies[tone]   || bodies.professional,
  };
}

// ─── MCP Tools ────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'add_lead',
    description: 'Add a new prospect to your pipeline.',
    inputSchema: {
      type: 'object', required: ['name'],
      properties: {
        name:    { type: 'string' },
        email:   { type: 'string' },
        company: { type: 'string' },
        website: { type: 'string' },
        niche:   { type: 'string', description: 'restaurant, gym, startup, agency, ecommerce, etc.' },
        notes:   { type: 'string' },
        source:  { type: 'string', description: 'linkedin, instagram, referral, cold_search, etc.' },
      },
    },
  },
  {
    name: 'get_leads',
    description: 'List leads. Filter by status, niche, or keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['new','contacted','replied','qualified','closed_won','closed_lost','all'] },
        niche:  { type: 'string' },
        search: { type: 'string' },
        limit:  { type: 'number' },
      },
    },
  },
  {
    name: 'update_lead',
    description: 'Update any field on a lead (status, email, company, notes, niche, website).',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id:      { type: 'string' },
        status:  { type: 'string', enum: ['new','contacted','replied','qualified','closed_won','closed_lost'] },
        email:   { type: 'string' },
        company: { type: 'string' },
        website: { type: 'string' },
        notes:   { type: 'string' },
        niche:   { type: 'string' },
      },
    },
  },
  {
    name: 'delete_lead',
    description: 'Delete a lead.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'find_flutterflow_leads',
    description: 'Get detailed intelligence on where to find FlutterFlow/mobile app clients for any niche and location. Returns LinkedIn search strings, buying signals, pain points, and pitch angles.',
    inputSchema: {
      type: 'object', required: ['niche'],
      properties: {
        niche:    { type: 'string', description: 'restaurant, gym, real estate, ecommerce, startup, agency, logistics, healthcare, school' },
        location: { type: 'string', description: 'UAE, Pakistan, UK, Saudi Arabia, US, etc.' },
      },
    },
  },
  {
    name: 'outreach_lead',
    description: 'FULLY AUTOMATED: Draft AND send a cold email to a lead in one step. Also schedules a follow-up reminder automatically. Use this to run outreach without manual steps.',
    inputSchema: {
      type: 'object', required: ['lead_id'],
      properties: {
        lead_id:       { type: 'string' },
        tone:          { type: 'string', enum: ['professional','casual','direct'], description: 'Default: professional' },
        service:       { type: 'string', description: 'Service to pitch. Default: FlutterFlow mobile app development' },
        custom_note:   { type: 'string', description: 'Any personalisation to add to the email' },
        followup_days: { type: 'number', description: 'Days until follow-up reminder. Default: 4' },
        send:          { type: 'boolean', description: 'Set to false to draft only, not send. Default: true' },
      },
    },
  },
  {
    name: 'bulk_outreach',
    description: 'FULLY AUTOMATED: Run outreach on ALL new leads at once. Drafts and sends emails + schedules follow-ups for every lead with status=new that has an email address.',
    inputSchema: {
      type: 'object',
      properties: {
        tone:          { type: 'string', enum: ['professional','casual','direct'] },
        service:       { type: 'string' },
        followup_days: { type: 'number', description: 'Days until follow-up. Default: 4' },
        dry_run:       { type: 'boolean', description: 'Set true to preview without sending. Default: false' },
      },
    },
  },
  {
    name: 'send_followups',
    description: 'FULLY AUTOMATED: Send follow-up emails to all leads that are overdue for follow-up (status=contacted, followup date passed). Marks each as done after sending.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'Preview without sending' },
      },
    },
  },
  {
    name: 'add_followup',
    description: 'Schedule a follow-up reminder for a specific lead.',
    inputSchema: {
      type: 'object', required: ['lead_id', 'due_date'],
      properties: {
        lead_id:  { type: 'string' },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        note:     { type: 'string' },
      },
    },
  },
  {
    name: 'get_followups',
    description: 'Get upcoming follow-up reminders. Use every morning.',
    inputSchema: {
      type: 'object',
      properties: {
        days_ahead:   { type: 'number', description: 'Next N days (default 7)' },
        include_done: { type: 'boolean' },
      },
    },
  },
  {
    name: 'complete_followup',
    description: 'Mark a follow-up as done.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
  },
  {
    name: 'get_pipeline_stats',
    description: 'Full pipeline summary: lead counts, conversion rates, emails sent.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_email_template',
    description: 'Get a ready-to-use email template.',
    inputSchema: {
      type: 'object',
      properties: {
        type:  { type: 'string', enum: ['cold_outreach','followup','reengagement','proposal'] },
        niche: { type: 'string' },
      },
    },
  },
  {
    name: 'test_db',
    description: 'Test the database connection and show table counts. Use this to debug DB issues.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'test_email',
    description: 'Test email sending — sends a real test email to confirm Resend API is configured correctly.',
    inputSchema: {
      type: 'object', required: ['to'],
      properties: { to: { type: 'string', description: 'Your own email address to send a test to' } },
    },
  },
];

// ─── Tool runners ─────────────────────────────────────────────────────────────
async function runTool(name, args) {
  switch (name) {

    case 'test_db': {
      const results = {};
      try {
        await db('SELECT 1 AS ping');
        results.connection = 'OK';
      } catch(e) {
        results.connection = 'FAILED: ' + e.message;
        return results;
      }
      for (const table of ['leads','outreach','followups']) {
        try {
          const rows = await db(`SELECT COUNT(*) AS n FROM ${table}`);
          results[table + '_count'] = parseInt(rows[0].n);
        } catch(e) {
          results[table] = 'table missing or error: ' + e.message;
        }
      }
      results.database_url_set = !!DATABASE_URL;
      results.resend_configured = !!RESEND_KEY;
      results.brevo_configured  = !!BREVO_KEY;
      results.gmail_user        = GMAIL_USER || '(not set)';
      results.from_name         = FROM_NAME;
      return results;
    }

    case 'test_email': {
      // Send a real test email so you can confirm the provider works
      const to = args.to;
      if (!to || !to.includes('@')) throw new Error('Provide a valid "to" email address');
      const subject  = 'Test email from Leads MCP ✓';
      const bodyText = [
        'Hi,',
        '',
        'This is a test email from your Leads MCP server.',
        'If you received this, email sending is working correctly!',
        '',
        `Provider: ${RESEND_KEY ? 'Resend' : BREVO_KEY ? 'Brevo' : 'none configured'}`,
        `From name: ${FROM_NAME}`,
        `Sent at: ${new Date().toISOString()}`,
        '',
        '-- Leads MCP',
      ].join('\n');
      try {
        const result = await sendGmail(to, subject, bodyText);
        return { success: true, message: `✓ Test email sent to ${to}`, provider: result.provider, id: result.id };
      } catch(e) {
        return { success: false, error: e.message, resend_key_set: !!RESEND_KEY, brevo_key_set: !!BREVO_KEY };
      }
    }

    case 'add_lead': {
      const rows = await db(
        `INSERT INTO leads (name,email,company,website,niche,notes,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [args.name, args.email||null, args.company||null, args.website||null,
         args.niche||null, args.notes||null, args.source||null]
      );
      return { success: true, lead: rows[0], message: `✓ "${args.name}" added to pipeline` };
    }

    case 'get_leads': {
      let sql = `SELECT l.*,
        (SELECT COUNT(*) FROM outreach  WHERE lead_id=l.id AND status='sent') AS emails_sent,
        (SELECT COUNT(*) FROM followups WHERE lead_id=l.id AND done=false)    AS pending_followups
        FROM leads l WHERE 1=1`;
      const p = [];
      if (args.status && args.status !== 'all') { p.push(args.status); sql += ` AND l.status=$${p.length}`; }
      if (args.niche)  { p.push(`%${args.niche}%`);  sql += ` AND l.niche ILIKE $${p.length}`; }
      if (args.search) {
        p.push(`%${args.search}%`);
        sql += ` AND (l.name ILIKE $${p.length} OR l.company ILIKE $${p.length} OR l.email ILIKE $${p.length})`;
      }
      sql += ` ORDER BY l.updated_at DESC LIMIT $${p.length+1}`;
      p.push(args.limit || 50);
      const rows = await db(sql, p);
      return { leads: rows, count: rows.length };
    }

    case 'update_lead': {
      const allowed = ['status','email','company','website','notes','niche'];
      const sets = [], p = [];
      for (const k of allowed) {
        if (args[k] !== undefined) { p.push(args[k]); sets.push(`${k}=$${p.length}`); }
      }
      if (!sets.length) throw new Error('Nothing to update — provide at least one field');
      p.push(args.id);
      const rows = await db(
        `UPDATE leads SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${p.length} RETURNING *`, p
      );
      if (!rows.length) throw new Error('Lead not found');
      return { success: true, lead: rows[0], message: `✓ Lead updated` };
    }

    case 'delete_lead': {
      await db(`DELETE FROM leads WHERE id=$1`, [args.id]);
      return { success: true, message: 'Lead deleted' };
    }

    case 'find_flutterflow_leads': {
      return getLeadIntel(args.niche, args.location);
    }

    // ── FULLY AUTOMATED: single lead outreach ──
    case 'outreach_lead': {
      const leads = await db(`SELECT * FROM leads WHERE id=$1`, [args.lead_id]);
      if (!leads.length) throw new Error('Lead not found');
      const lead = leads[0];
      if (!lead.email) throw new Error(`No email for "${lead.name}". Use update_lead to add email first.`);

      const { subject, body } = composeEmail(lead, {
        tone:        args.tone,
        service:     args.service,
        custom_note: args.custom_note,
      });

      const shouldSend = args.send !== false;
      let sent = false, sendError = '';

      if (shouldSend) {
        try { await sendGmail(lead.email, subject, body); sent = true; }
        catch(e) { sendError = e.message; }
      }

      // Log the email
      await db(
        `INSERT INTO outreach (lead_id,subject,body,sent_at,status,error_msg) VALUES ($1,$2,$3,$4,$5,$6)`,
        [lead.id, subject, body, sent ? new Date().toISOString() : null,
         shouldSend ? (sent ? 'sent' : 'failed') : 'draft', sendError || null]
      );

      // Update status if sent
      if (sent) {
        await db(`UPDATE leads SET status='contacted', updated_at=NOW() WHERE id=$1`, [lead.id]);
      }

      // Auto-schedule follow-up
      const followupDays = args.followup_days || 4;
      const followupDate = new Date();
      followupDate.setDate(followupDate.getDate() + followupDays);
      const dueDateStr = followupDate.toISOString().slice(0, 10);

      let followupId = null;
      if (sent) {
        const fu = await db(
          `INSERT INTO followups (lead_id,due_date,note) VALUES ($1,$2,$3) RETURNING id`,
          [lead.id, dueDateStr, `Follow up on cold email sent ${new Date().toLocaleDateString()}`]
        );
        followupId = fu[0]?.id;
      }

      return {
        success:     shouldSend ? sent : true,
        action:      shouldSend ? (sent ? 'sent' : 'failed') : 'drafted',
        lead_name:   lead.name,
        to:          lead.email,
        subject,
        body,
        followup_scheduled: sent ? dueDateStr : null,
        followup_id: followupId,
        error:       sendError || null,
        message:     sent
          ? `✓ Email sent to ${lead.email}. Follow-up scheduled for ${dueDateStr}.`
          : shouldSend
          ? `✗ Send failed: ${sendError}. Email saved as draft.`
          : `Draft saved. Call outreach_lead with send:true to send.`,
      };
    }

    // ── FULLY AUTOMATED: bulk outreach to all new leads ──
    case 'bulk_outreach': {
      const newLeads = await db(
        `SELECT * FROM leads WHERE status='new' AND email IS NOT NULL AND email != '' ORDER BY created_at ASC`
      );
      if (!newLeads.length) {
        return { message: 'No new leads with email addresses found. Add leads first.', count: 0 };
      }

      const dryRun = args.dry_run === true;
      const followupDays = args.followup_days || 4;
      const results = { total: newLeads.length, sent: 0, failed: 0, skipped: 0, details: [] };

      for (const lead of newLeads) {
        const { subject, body } = composeEmail(lead, {
          tone:    args.tone,
          service: args.service,
        });

        if (dryRun) {
          results.details.push({ lead: lead.name, email: lead.email, subject, action: 'dry_run' });
          results.skipped++;
          continue;
        }

        let sent = false, sendError = '';
        try { await sendGmail(lead.email, subject, body); sent = true; }
        catch(e) { sendError = e.message; }

        await db(
          `INSERT INTO outreach (lead_id,subject,body,sent_at,status,error_msg) VALUES ($1,$2,$3,$4,$5,$6)`,
          [lead.id, subject, body, sent ? new Date().toISOString() : null,
           sent ? 'sent' : 'failed', sendError || null]
        );

        if (sent) {
          await db(`UPDATE leads SET status='contacted', updated_at=NOW() WHERE id=$1`, [lead.id]);
          const followupDate = new Date();
          followupDate.setDate(followupDate.getDate() + followupDays);
          await db(
            `INSERT INTO followups (lead_id,due_date,note) VALUES ($1,$2,$3)`,
            [lead.id, followupDate.toISOString().slice(0,10),
             `Follow up on cold email sent ${new Date().toLocaleDateString()}`]
          );
          results.sent++;
        } else {
          results.failed++;
        }

        results.details.push({
          lead:    lead.name,
          email:   lead.email,
          subject,
          action:  sent ? 'sent' : 'failed',
          error:   sendError || null,
        });

        // Small delay between sends to avoid Gmail rate limits
        await new Promise(r => setTimeout(r, 1500));
      }

      return {
        ...results,
        message: dryRun
          ? `Dry run: would send to ${results.total} leads`
          : `✓ Bulk outreach done: ${results.sent} sent, ${results.failed} failed. Follow-ups scheduled for ${results.sent} leads.`,
      };
    }

    // ── FULLY AUTOMATED: send follow-up emails ──
    case 'send_followups': {
      const dryRun = args.dry_run === true;
      // Get overdue follow-ups for leads that are still in contacted status
      const overdue = await db(`
        SELECT f.id AS followup_id, f.note, f.due_date,
               l.id AS lead_id, l.name, l.email, l.company, l.niche, l.status
        FROM followups f
        JOIN leads l ON l.id = f.lead_id
        WHERE f.done = false
          AND f.due_date <= CURRENT_DATE
          AND l.status = 'contacted'
          AND l.email IS NOT NULL
        ORDER BY f.due_date ASC
        LIMIT 20
      `);

      if (!overdue.length) {
        return { message: 'No overdue follow-ups for contacted leads. Check back tomorrow!', count: 0 };
      }

      const results = { total: overdue.length, sent: 0, failed: 0, details: [] };

      for (const fu of overdue) {
        const { subject, body } = composeEmail(fu, { tone: 'followup' });

        if (dryRun) {
          results.details.push({ lead: fu.name, email: fu.email, subject, action: 'dry_run' });
          continue;
        }

        let sent = false, sendError = '';
        try { await sendGmail(fu.email, subject, body); sent = true; }
        catch(e) { sendError = e.message; }

        await db(
          `INSERT INTO outreach (lead_id,subject,body,sent_at,status,error_msg) VALUES ($1,$2,$3,$4,$5,$6)`,
          [fu.lead_id, subject, body, sent ? new Date().toISOString() : null,
           sent ? 'sent' : 'failed', sendError || null]
        );

        if (sent) {
          await db(`UPDATE followups SET done=true WHERE id=$1`, [fu.followup_id]);
          // Schedule second follow-up in 5 days if no reply
          const nextDate = new Date();
          nextDate.setDate(nextDate.getDate() + 5);
          await db(
            `INSERT INTO followups (lead_id,due_date,note) VALUES ($1,$2,$3)`,
            [fu.lead_id, nextDate.toISOString().slice(0,10), 'Final follow-up (2nd attempt)']
          );
          results.sent++;
        } else {
          results.failed++;
        }

        results.details.push({ lead: fu.name, email: fu.email, subject, action: sent ? 'sent' : 'failed', error: sendError || null });
        await new Promise(r => setTimeout(r, 1500));
      }

      return {
        ...results,
        message: dryRun
          ? `Dry run: would follow up with ${results.total} leads`
          : `✓ Follow-ups done: ${results.sent} sent, ${results.failed} failed.`,
      };
    }

    case 'add_followup': {
      const rows = await db(
        `INSERT INTO followups (lead_id,due_date,note) VALUES ($1,$2,$3) RETURNING *`,
        [args.lead_id, args.due_date, args.note || null]
      );
      const lead = await db(`SELECT name FROM leads WHERE id=$1`, [args.lead_id]);
      return { success: true, followup: rows[0], message: `✓ Follow-up set for ${args.due_date} with ${lead[0]?.name}` };
    }

    case 'get_followups': {
      const days = parseInt(args.days_ahead) || 7;
      const done = args.include_done ? '' : 'AND f.done=false';
      const rows = await db(`
        SELECT f.*, l.name AS lead_name, l.email AS lead_email, l.company, l.status AS lead_status
        FROM followups f JOIN leads l ON l.id=f.lead_id
        WHERE f.due_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL ${done}
        ORDER BY f.due_date ASC LIMIT 50`, [days]
      );
      const overdue = rows.filter(r => new Date(r.due_date) < new Date()).length;
      return { followups: rows, count: rows.length, overdue, message: `${rows.length} follow-ups in next ${days} days (${overdue} overdue)` };
    }

    case 'complete_followup': {
      const rows = await db(`UPDATE followups SET done=true WHERE id=$1 RETURNING id`, [args.id]);
      if (!rows.length) throw new Error('Follow-up not found');
      return { success: true, message: '✓ Follow-up marked done' };
    }

    case 'get_pipeline_stats': {
      const [stats, tot, emails, fups, recent] = await Promise.all([
        db(`SELECT status, COUNT(*) AS count FROM leads GROUP BY status`),
        db(`SELECT COUNT(*) AS n FROM leads`),
        db(`SELECT COUNT(*) AS n FROM outreach WHERE status='sent'`),
        db(`SELECT COUNT(*) AS n FROM followups WHERE done=false`),
        db(`SELECT name, company, status, updated_at FROM leads ORDER BY updated_at DESC LIMIT 6`),
      ]);
      const by = {};
      stats.forEach(r => { by[r.status] = parseInt(r.count); });
      const total = parseInt(tot[0]?.n || 0);
      const won   = by.closed_won || 0;
      const contacted = (by.contacted||0)+(by.replied||0)+(by.qualified||0)+won;
      return {
        total_leads:       total,
        by_status:         by,
        emails_sent:       parseInt(emails[0]?.n || 0),
        pending_followups: parseInt(fups[0]?.n || 0),
        conversion_rate:   total > 0 ? `${Math.round(won/total*100)}%` : '0%',
        contact_rate:      total > 0 ? `${Math.round(contacted/total*100)}%` : '0%',
        recent_activity:   recent,
      };
    }

    case 'get_email_template': {
      const n = args.niche || 'businesses';
      const templates = {
        cold_outreach: {
          subject: 'Quick idea for [Company]',
          body: `Hi [Name],\n\nI noticed [something specific — no app, WhatsApp orders, etc.].\n\nI build mobile apps for ${n} using FlutterFlow — iOS + Android in 3–4 weeks at 50–70% less than traditional dev.\n\n15-min call this week?\n\n[Your name]`,
          tips: ['Personalise line 2 for every send', 'Keep under 80 words', 'One CTA only'],
        },
        followup: {
          subject: 'Re: Mobile app for [Company]',
          body: `Hi [Name],\n\nFollowing up from last week — happy to send a 2-min screen recording showing what an app could look like for [Company] if easier than a call.\n\nStill worth exploring?\n\n[Your name]`,
          tips: ['Send 4–5 days after cold email', 'Offer video vs call', 'Max 2 follow-ups'],
        },
        reengagement: {
          subject: 'Still thinking about an app for [Company]?',
          body: `Hi [Name],\n\nReaching back out — just wrapped up a similar project for a ${n} client: [specific result].\n\nIs mobile still on your radar?\n\n[Your name]`,
          tips: ['2–3 months after silence', 'Lead with a real result', 'Short and casual'],
        },
        proposal: {
          subject: 'Proposal: [App Name] for [Company]',
          body: `Hi [Name],\n\nHere's a quick outline:\n\nSCOPE\n• iOS + Android app\n• Features: [1], [2], [3]\n• Built with FlutterFlow\n\nTIMELINE: 4 weeks\nINVESTMENT: [your price]\n\nNext step: confirm and I'll send the contract.\n\n[Your name]`,
          tips: ['Keep scope to 3 features', 'One clear next step', 'Follow up in 2 days'],
        },
      };
      const type = args.type || 'cold_outreach';
      return { template: templates[type] || templates.cold_outreach, all_types: Object.keys(templates) };
    }

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// ─── MCP protocol boilerplate ─────────────────────────────────────────────────
const sessions = new Map();
const uid = () => crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { ok(JSON.parse(Buffer.concat(chunks).toString() || 'null')); }
      catch(e) { fail(e); }
    });
    req.on('error', fail);
  });
}

async function handleRPC(msg, sid) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    sessions.set(sid, Date.now());
    return { id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'leads-mcp', version: '4.0.0' } } };
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
      console.error(`[tool:${name}]`, e.message);
      return { id, result: { content: [{ type: 'text', text: '❌ Error: ' + e.message }], isError: true } };
    }
  }
  return { id, error: { code: -32601, message: 'Unknown method: ' + method } };
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  let pathname = '/';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch(_) {}

  const host  = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost';
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const base  = `${proto}://${host}`;

  // ── Health ──
  if (pathname === '/health') {
    let dbOk = false;
    try { await db('SELECT 1'); dbOk = true; } catch(_) {}
    return sendJSON(res, 200, { status: 'ok', db: dbOk, email: !!(RESEND_KEY || GMAIL_USER), version: '4.0.0' });
  }

  // ── Dashboard API ──
  if (pathname === '/api/stats') {
    try {
      const [stats, tot, emails, fups, recent] = await Promise.all([
        db(`SELECT status, COUNT(*) AS count FROM leads GROUP BY status`),
        db(`SELECT COUNT(*) AS n FROM leads`),
        db(`SELECT COUNT(*) AS n FROM outreach WHERE status='sent'`),
        db(`SELECT COUNT(*) AS n FROM followups WHERE done=false AND due_date<=CURRENT_DATE+'7 days'::INTERVAL`),
        db(`SELECT name, company, status, updated_at FROM leads ORDER BY updated_at DESC LIMIT 8`),
      ]);
      const byStatus = {};
      stats.forEach(r => { byStatus[r.status] = parseInt(r.count); });
      return sendJSON(res, 200, {
        byStatus, recent,
        total:        parseInt(tot[0]?.n   || 0),
        emailsSent:   parseInt(emails[0]?.n || 0),
        followupsDue: parseInt(fups[0]?.n  || 0),
      });
    } catch(e) {
      return sendJSON(res, 200, { byStatus: {}, total: 0, emailsSent: 0, followupsDue: 0, recent: [], error: e.message });
    }
  }

  if (pathname === '/api/leads') {
    try { return sendJSON(res, 200, await db(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 200`)); }
    catch(e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (pathname === '/api/followups') {
    try {
      return sendJSON(res, 200, await db(
        `SELECT f.*, l.name AS lead_name, l.company FROM followups f
         JOIN leads l ON l.id=f.lead_id WHERE f.done=false ORDER BY f.due_date ASC LIMIT 30`
      ));
    } catch(e) { return sendJSON(res, 500, { error: e.message }); }
  }

  // ── OAuth passthrough (no real auth — open) ──
  if (pathname === '/.well-known/oauth-authorization-server') {
    return sendJSON(res, 200, { issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
  }
  if (req.method === 'POST' && pathname === '/oauth/register') {
    let b = {}; try { b = await readBody(req); } catch(_) {}
    return sendJSON(res, 201, { client_id: uid(), client_secret: uid(),
      client_name: b.client_name||'Client', redirect_uris: b.redirect_uris||[],
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  }
  if (req.method === 'GET' && pathname === '/oauth/authorize') {
    const u = new URL(req.url, base);
    const r = u.searchParams.get('redirect_uri') || '';
    const s = u.searchParams.get('state') || '';
    res.writeHead(302, { Location: `${r}${r.includes('?')?'&':'?'}code=${uid()}${s?'&state='+encodeURIComponent(s):''}` });
    return res.end();
  }
  if (req.method === 'POST' && pathname === '/oauth/token') {
    return sendJSON(res, 200, { access_token: 'open-'+uid(), token_type: 'bearer', expires_in: 31536000 });
  }

  // ── MCP Streamable HTTP ──
  if (req.method === 'POST' && pathname === '/mcp') {
    let body;
    try { body = await readBody(req); }
    catch(e) { return sendJSON(res, 400, { jsonrpc:'2.0', id:null, error:{ code:-32700, message:'Parse error' } }); }

    let sid = req.headers['mcp-session-id'];
    if (!sid) { sid = uid(); res.setHeader('Mcp-Session-Id', sid); }

    const msgs = Array.isArray(body) ? body : [body];
    const out  = [];
    for (const msg of msgs) {
      if (!msg || msg.jsonrpc !== '2.0') continue;
      const r = await handleRPC(msg, sid);
      if (r) out.push({ jsonrpc: '2.0', ...r });
    }
    if (!out.length) { res.writeHead(204); return res.end(); }
    return sendJSON(res, 200, Array.isArray(body) ? out : out[0]);
  }
  if (req.method === 'DELETE' && pathname === '/mcp') {
    const sid = req.headers['mcp-session-id'];
    if (sid) sessions.delete(sid);
    res.writeHead(204); return res.end();
  }
  if (req.method === 'GET' && pathname === '/mcp') {
    return sendJSON(res, 200, { transport: 'streamable-http', protocolVersion: '2024-11-05', tools: TOOLS.length });
  }

  // ── Dashboard ──
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const fs   = require('fs');
    const path = require('path');
    try {
      const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch(e) { res.writeHead(404); return res.end('Dashboard not found'); }
  }

  res.writeHead(404); res.end('Not found');
});

server.keepAliveTimeout = 65000;
server.headersTimeout   = 66000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[Leads MCP v4] Listening on port ${PORT}`);
  await initDB();
});
server.on('error', err => { console.error('[Fatal]', err); process.exit(1); });