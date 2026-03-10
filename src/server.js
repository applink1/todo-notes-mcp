'use strict';
const http  = require('http');
const https = require('https');
const crypto = require('crypto');
const PORT  = parseInt(process.env.PORT || '3000', 10);

// ─── Neon Postgres HTTP API ───────────────────────────────────────────────────
const NEON_URL = process.env.DATABASE_URL;

function parseNeonUrl(connStr) {
  const u = new URL(connStr);
  return {
    hostname: u.hostname,
    user:     decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

async function query(sql, params = []) {
  if (!NEON_URL) throw new Error('DATABASE_URL not set');
  const { hostname, user, password, database } = parseNeonUrl(NEON_URL);
  const body = JSON.stringify({ query: sql, params });
  const auth = Buffer.from(`${user}:${password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path: '/sql', method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${auth}`,
        'Neon-Database': database,
        'Content-Length': Buffer.byteLength(body),
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.message) return reject(new Error(json.message));
          resolve(json.rows || []);
        } catch(e) { reject(new Error('DB parse: ' + raw.slice(0,200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Gmail SMTP ───────────────────────────────────────────────────────────────
const GMAIL_USER     = process.env.GMAIL_USER;
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASSWORD;

function sendGmail(to, subject, bodyText) {
  return new Promise((resolve, reject) => {
    if (!GMAIL_USER || !GMAIL_APP_PASS) return reject(new Error('Gmail not configured'));
    const tls = require('tls');
    const rawMsg = [`From: ${GMAIL_USER}`,`To: ${to}`,`Subject: ${subject}`,
      `MIME-Version: 1.0`,`Content-Type: text/plain; charset=UTF-8`,``,bodyText].join('\r\n');
    const authB64 = Buffer.from(`\x00${GMAIL_USER}\x00${GMAIL_APP_PASS.replace(/\s/g,'')}`).toString('base64');
    let step = 0, socket;
    const send = s => socket.write(s + '\r\n');
    function handle(line) {
      line = line.trim();
      if      (step===0 && line.startsWith('220'))  { send('EHLO mcp'); step++; }
      else if (step===1 && line.startsWith('250 '))  { send('AUTH PLAIN '+authB64); step++; }
      else if (step===2 && line.startsWith('235'))   { send(`MAIL FROM:<${GMAIL_USER}>`); step++; }
      else if (step===3 && line.startsWith('250'))   { send(`RCPT TO:<${to}>`); step++; }
      else if (step===4 && line.startsWith('250'))   { send('DATA'); step++; }
      else if (step===5 && line.startsWith('354'))   { send(rawMsg+'\r\n.'); step++; }
      else if (step===6 && line.startsWith('250'))   { send('QUIT'); resolve({success:true}); }
      else if (line.startsWith('5'))                 { reject(new Error('SMTP: '+line)); }
    }
    socket = tls.connect(465,'smtp.gmail.com',{},()=>{});
    socket.setTimeout(15000,()=>reject(new Error('SMTP timeout')));
    socket.on('error',reject);
    let buf='';
    socket.on('data',d=>{
      buf+=d.toString();
      buf.split('\r\n').forEach((l,i,arr)=>{ if(i<arr.length-1&&l) handle(l); });
      buf=buf.includes('\r\n')?buf.slice(buf.lastIndexOf('\r\n')+2):buf;
    });
  });
}

// ─── DB Init ──────────────────────────────────────────────────────────────────
async function initDB() {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL, email TEXT, company TEXT, website TEXT,
      niche TEXT, status TEXT DEFAULT 'new'
        CHECK(status IN ('new','contacted','replied','qualified','closed_won','closed_lost')),
      notes TEXT, source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS outreach (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
      subject TEXT, body TEXT, sent_at TIMESTAMPTZ,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','failed')),
      created_at TIMESTAMPTZ DEFAULT NOW())`,
    `CREATE TABLE IF NOT EXISTS followups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
      note TEXT, due_date DATE NOT NULL, done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW())`,
  ];
  for (const sql of sqls) { try { await query(sql); } catch(e) { console.error('[DB]',e.message); } }
  console.log('[DB] Ready');
}

// ─── Tools ────────────────────────────────────────────────────────────────────
const TOOLS = [
  { name:'add_lead', description:'Add a new lead to your sales pipeline.',
    inputSchema:{ type:'object', required:['name'], properties:{
      name:{type:'string'}, email:{type:'string'}, company:{type:'string'},
      website:{type:'string'}, niche:{type:'string'}, notes:{type:'string'}, source:{type:'string'}}}},
  { name:'get_leads', description:'List leads. Filter by status, niche, or search.',
    inputSchema:{ type:'object', properties:{
      status:{type:'string',enum:['new','contacted','replied','qualified','closed_won','closed_lost','all']},
      niche:{type:'string'}, search:{type:'string'}, limit:{type:'number'}}}},
  { name:'update_lead', description:'Update any field on a lead.',
    inputSchema:{ type:'object', required:['id'], properties:{
      id:{type:'string'}, status:{type:'string',enum:['new','contacted','replied','qualified','closed_won','closed_lost']},
      email:{type:'string'}, company:{type:'string'}, website:{type:'string'}, notes:{type:'string'}, niche:{type:'string'}}}},
  { name:'delete_lead', description:'Delete a lead.',
    inputSchema:{ type:'object', required:['id'], properties:{ id:{type:'string'}}}},
  { name:'find_flutterflow_leads',
    description:'Find real potential clients for FlutterFlow/mobile app services. Returns WHERE to find them, buying signals, pitch angles, and LinkedIn search strings for any niche + location.',
    inputSchema:{ type:'object', required:['niche'], properties:{
      niche:{type:'string', description:'restaurant, gym, real estate, ecommerce, startup, agency, logistics, healthcare, school'},
      location:{type:'string', description:'UAE, Pakistan, UK, Saudi Arabia, US, etc.'}}}},
  { name:'draft_email', description:'Write a personalised cold email for a lead (does not send).',
    inputSchema:{ type:'object', required:['lead_id'], properties:{
      lead_id:{type:'string'}, tone:{type:'string',enum:['professional','casual','direct']},
      service:{type:'string'}, custom_note:{type:'string'}}}},
  { name:'send_email', description:'Send email to a lead via Gmail. Auto-updates status to contacted.',
    inputSchema:{ type:'object', required:['lead_id','subject','body'], properties:{
      lead_id:{type:'string'}, subject:{type:'string'}, body:{type:'string'}}}},
  { name:'add_followup', description:'Schedule a follow-up reminder.',
    inputSchema:{ type:'object', required:['lead_id','due_date'], properties:{
      lead_id:{type:'string'}, due_date:{type:'string',description:'YYYY-MM-DD'}, note:{type:'string'}}}},
  { name:'get_followups', description:'Get upcoming follow-up reminders.',
    inputSchema:{ type:'object', properties:{ days_ahead:{type:'number'}, include_done:{type:'boolean'}}}},
  { name:'complete_followup', description:'Mark a follow-up as done.',
    inputSchema:{ type:'object', required:['id'], properties:{ id:{type:'string'}}}},
  { name:'get_pipeline_stats', description:'Full pipeline summary with stats and conversion rates.',
    inputSchema:{ type:'object', properties:{}}},
  { name:'get_email_template', description:'Get a cold email template.',
    inputSchema:{ type:'object', properties:{ type:{type:'string',enum:['cold_outreach','followup','reengagement','proposal']}, niche:{type:'string'}}}},
];

async function runTool(name, args) {
  switch(name) {

    case 'add_lead': {
      const rows = await query(
        `INSERT INTO leads (name,email,company,website,niche,notes,source) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [args.name,args.email||null,args.company||null,args.website||null,args.niche||null,args.notes||null,args.source||null]
      );
      return { success:true, lead:rows[0], message:`✓ "${args.name}" added` };
    }

    case 'get_leads': {
      let sql=`SELECT l.*,(SELECT COUNT(*) FROM outreach WHERE lead_id=l.id AND status='sent') AS emails_sent,
        (SELECT COUNT(*) FROM followups WHERE lead_id=l.id AND done=false) AS pending_followups
        FROM leads l WHERE 1=1`;
      const p=[];
      if(args.status&&args.status!=='all'){p.push(args.status);sql+=` AND l.status=$${p.length}`;}
      if(args.niche){p.push(`%${args.niche}%`);sql+=` AND l.niche ILIKE $${p.length}`;}
      if(args.search){p.push(`%${args.search}%`);sql+=` AND (l.name ILIKE $${p.length} OR l.company ILIKE $${p.length} OR l.email ILIKE $${p.length})`;}
      sql+=` ORDER BY l.updated_at DESC LIMIT $${p.length+1}`;p.push(args.limit||25);
      const rows=await query(sql,p);
      return {leads:rows,count:rows.length};
    }

    case 'update_lead': {
      const sets=[],p=[];
      for(const[k,v]of Object.entries(args)){
        if(k!=='id'&&['status','email','company','website','notes','niche'].includes(k)&&v!==undefined){
          p.push(v);sets.push(`${k}=$${p.length}`);
        }
      }
      if(!sets.length) throw new Error('Nothing to update');
      p.push(args.id);
      const rows=await query(`UPDATE leads SET ${sets.join(',')},updated_at=NOW() WHERE id=$${p.length} RETURNING *`,p);
      if(!rows.length) throw new Error('Lead not found');
      return {success:true,lead:rows[0]};
    }

    case 'delete_lead': {
      await query(`DELETE FROM leads WHERE id=$1`,[args.id]);
      return {success:true,message:'Deleted'};
    }

    case 'find_flutterflow_leads': {
      const n=args.niche.toLowerCase(), loc=args.location||'worldwide';
      const db={
        restaurant:{pain:'Paying 15-30% commission to Uber Eats/Talabat on every order',solution:'Own branded ordering app — zero commission, push notifications, loyalty program',budget:'$2k–$8k USD',linkedin:`"restaurant owner" OR "F&B director" OR "food & beverage" location:"${loc}"`,where:[`Talabat/Uber Eats listings in ${loc} (top-rated restaurants)`,`Google Maps "restaurant" ${loc} with 50+ reviews`,`Instagram food pages in ${loc} with 1k+ followers but no app link in bio`],signals:['2+ locations (growing chain)','Active Instagram but no app','Posts complaining about delivery fees'],pitch:'Your own ordering app pays for itself in 2 months vs Talabat commissions'},
        gym:{pain:'Manual class bookings via WhatsApp, no member retention system',solution:'Member app with class booking, check-in, progress tracking, push notifications',budget:'$1.5k–$5k USD',linkedin:`"gym owner" OR "fitness center" OR "CrossFit box" location:"${loc}"`,where:[`Google Maps "gym" OR "crossfit" ${loc}`,`Instagram fitness accounts in ${loc}`,`Facebook gym groups in ${loc}`],signals:['Uses WhatsApp for class scheduling','100+ members','Active Instagram with no booking link'],pitch:'Replace WhatsApp chaos — members book themselves, you track everything'},
        'real estate':{pain:'Listings on generic portals (Bayut/Zameen), losing leads to the platform',solution:'Branded property search app with virtual tours, lead capture, direct WhatsApp connect',budget:'$4k–$15k USD',linkedin:`"real estate agency" OR "property developer" location:"${loc}"`,where:[`Bayut/Zameen top agencies in ${loc}`,`LinkedIn "real estate" companies ${loc} with 10+ staff`,`Google "property agency" ${loc}`],signals:['Own website + active listings','5+ agents','No mobile app'],pitch:'Own your leads — clients save YOUR listings, not Bayut\'s'},
        ecommerce:{pain:'Only on website/Instagram DMs, low mobile conversion',solution:'Branded shopping app — 3x conversion, push notifications, loyalty points',budget:'$2.5k–$9k USD',linkedin:`"ecommerce" OR "online store" OR "shopify store" location:"${loc}"`,where:[`Instagram shops in ${loc} with 5k+ followers`,`Shopify stores shipping to ${loc}`,`Facebook marketplace sellers in ${loc}`],signals:['Active Instagram shop','Shopify website','Running paid ads'],pitch:'Your Instagram DMs are not a sales system — a branded app 3x repeat purchases'},
        startup:{pain:'Need an MVP fast but dev quotes are $50k+ and 6 months',solution:'FlutterFlow MVP in 3-4 weeks — real iOS + Android, at 50-70% less cost',budget:'$5k–$20k USD',linkedin:`"founder" OR "co-founder" "mobile app" OR "app" location:"${loc}"`,where:[`ProductHunt recent launches in ${loc}`,`AngelList/Wellfound ${loc} startups`,`LinkedIn "seed funded" startups ${loc}`],signals:['Raised seed funding','Job posting for Flutter dev','Web product needing mobile'],pitch:'Launch your MVP in 4 weeks for what others charge in 4 months'},
        agency:{pain:'Clients ask for mobile apps but they can\'t deliver — losing deals',solution:'White-label FlutterFlow dev — agency sells, you build, everyone wins',budget:'$4k–$18k USD per project',linkedin:`"digital agency" OR "web agency" OR "creative agency" location:"${loc}"`,where:[`Clutch.co digital agencies in ${loc}`,`LinkedIn "web agency" ${loc} under 50 staff`,`Upwork agencies posting mobile app jobs`],signals:['Web/branding agency with no mobile services','Active LinkedIn','5-50 employees'],pitch:'Never turn down a mobile project again — I build, you bill, you keep the margin'},
        logistics:{pain:'Drivers use WhatsApp, no live tracking, manual proof of delivery',solution:'Driver + customer tracking app — GPS, digital POD, automated updates',budget:'$5k–$18k USD',linkedin:`"logistics" OR "courier service" OR "last mile delivery" location:"${loc}"`,where:[`Google "courier company" OR "delivery service" ${loc}`,`LinkedIn logistics companies ${loc} with 10+ staff`,`E-commerce Facebook groups in ${loc}`],signals:['10+ drivers','WhatsApp for dispatch','Growing delivery volume'],pitch:'Replace WhatsApp dispatch with live GPS tracking — built in 4 weeks'},
        healthcare:{pain:'Appointments via phone, no reminders, paper records',solution:'Patient app — booking, reminders, test results, teleconsult',budget:'$6k–$25k USD',linkedin:`"clinic" OR "medical center" OR "private hospital" location:"${loc}"`,where:[`Google "private clinic" ${loc}`,`LinkedIn "clinic owner" OR "medical director" ${loc}`,`Instagram private clinics in ${loc}`],signals:['Private clinic 3+ doctors','Active social media','No appointment app'],pitch:'Patients book 24/7 online, you cut no-shows by 40% with auto-reminders'},
        school:{pain:'Parent comms via WhatsApp groups and printed circulars',solution:'School app — announcements, attendance, homework, fee payments, parent chat',budget:'$3.5k–$12k USD',linkedin:`"private school" OR "academy" OR "education" location:"${loc}"`,where:[`Google "private school" ${loc}`,`LinkedIn school principals/directors in ${loc}`,`Facebook parent groups in ${loc}`],signals:['200+ students','WhatsApp parent groups','No school app'],pitch:'Replace 10 WhatsApp groups with one professional school app'},
      };
      const info=db[n]||{pain:`Manual processes, no mobile presence`,solution:`Custom FlutterFlow app — iOS + Android in 3-4 weeks`,budget:'$2k–$10k USD',linkedin:`"${n}" location:"${loc}"`,where:[`Google "${n}" companies ${loc}`,`LinkedIn "${n}" ${loc}`,`Instagram "${n}" in ${loc}`],signals:['Active social media','Website but no app','Growing business'],pitch:`Build a mobile app 3x faster and cheaper`};
      return {
        niche:args.niche, location:loc,
        THEIR_PAIN: info.pain,
        YOUR_SOLUTION: info.solution,
        TYPICAL_BUDGET: info.budget,
        WHERE_TO_FIND_THEM: info.where,
        LINKEDIN_SEARCH_STRING: info.linkedin,
        BUYING_SIGNALS: info.signals,
        ONE_LINE_PITCH: info.pitch,
        GOOGLE_SEARCHES:[`"${n}" company ${loc} site:linkedin.com`,`"${n}" ${loc} "need an app" OR "looking for developer"`,`"${n}" ${loc} "mobile app" -jobs -apple`],
        OTHER_PLATFORMS:[`ProductHunt.com → browse ${n} category`,`Clutch.co → "${n}" + ${loc}`,`Upwork → clients posting "${n} app" jobs`,`Instagram → #${n.replace(/\s/g,'')}${loc.replace(/\s/g,'')}`],
        NEXT_STEP:`Search LinkedIn using the string above → find 5-10 companies → add_lead for each → draft_email to start outreach today.`
      };
    }

    case 'draft_email': {
      const leads=await query(`SELECT * FROM leads WHERE id=$1`,[args.lead_id]);
      if(!leads.length) throw new Error('Lead not found');
      const L=leads[0];
      const svc=args.service||'FlutterFlow mobile app development';
      const tone=args.tone||'professional';
      const extra=args.custom_note?`\n${args.custom_note}\n`:'';
      const name=L.name||L.company||'there';
      const co=L.company?` (${L.company})`:'';
      const bodies={
        professional:`Hi ${name},\n\nI came across your work${co} and wanted to reach out.\n\nI specialise in ${svc} — helping ${L.niche||'businesses'} launch mobile products faster and cheaper than traditional development.${extra}\nWhat I offer:\n• iOS + Android from one FlutterFlow codebase\n• Production-ready in 3–4 weeks\n• Full backend, payments, and API integration\n\nWould a 15-minute call make sense?\n\nBest regards`,
        casual:`Hey ${name},\n\nSpotted your work${co} and thought I'd reach out.\n\nI build mobile apps using FlutterFlow — cuts dev time by 70% without sacrificing quality.${extra}\nHappy to show you a quick demo. Worth a chat?\n\nCheers`,
        direct:`Hi ${name},\n\nAre you currently looking to build or improve a mobile app${co}?\n\nI build production-grade iOS + Android apps with FlutterFlow. Fast, cost-effective, real quality.${extra}\n15 minutes this week?`,
      };
      const subjects={professional:`Mobile app for ${L.company||L.name}`,casual:`Quick idea for ${L.company||L.name}`,direct:`App for ${L.company||L.name}?`};
      const subject=subjects[tone]||subjects.professional;
      const body=bodies[tone]||bodies.professional;
      await query(`INSERT INTO outreach (lead_id,subject,body,status) VALUES ($1,$2,$3,'draft')`,[args.lead_id,subject,body]);
      return {draft:{subject,body,to:L.email,lead_name:L.name},message:`Draft saved. Use send_email with lead_id="${args.lead_id}" to send.`};
    }

    case 'send_email': {
      const leads=await query(`SELECT * FROM leads WHERE id=$1`,[args.lead_id]);
      if(!leads.length) throw new Error('Lead not found');
      const L=leads[0];
      if(!L.email) throw new Error(`No email for "${L.name}" — use update_lead to add it first`);
      let ok=false,errMsg='';
      try{await sendGmail(L.email,args.subject,args.body);ok=true;}catch(e){errMsg=e.message;}
      await query(`INSERT INTO outreach (lead_id,subject,body,sent_at,status) VALUES ($1,$2,$3,$4,$5)`,
        [args.lead_id,args.subject,args.body,ok?new Date().toISOString():null,ok?'sent':'failed']);
      if(ok){
        await query(`UPDATE leads SET status='contacted',updated_at=NOW() WHERE id=$1`,[args.lead_id]);
        return {success:true,message:`✓ Email sent to ${L.email}. Status → contacted.`};
      }
      throw new Error(`Send failed: ${errMsg}`);
    }

    case 'add_followup': {
      const rows=await query(`INSERT INTO followups (lead_id,due_date,note) VALUES ($1,$2,$3) RETURNING *`,
        [args.lead_id,args.due_date,args.note||null]);
      const lead=await query(`SELECT name FROM leads WHERE id=$1`,[args.lead_id]);
      return {success:true,followup:rows[0],message:`✓ Follow-up set for ${args.due_date} with ${lead[0]?.name}`};
    }

    case 'get_followups': {
      const days=parseInt(args.days_ahead)||7;
      const doneFilter=args.include_done?'':'AND f.done=false';
      const rows=await query(
        `SELECT f.*,l.name AS lead_name,l.email AS lead_email,l.company,l.status AS lead_status
         FROM followups f JOIN leads l ON l.id=f.lead_id
         WHERE f.due_date<=CURRENT_DATE+($1||' days')::INTERVAL ${doneFilter}
         ORDER BY f.due_date ASC LIMIT 50`,[days]);
      const overdue=rows.filter(r=>new Date(r.due_date)<new Date()).length;
      return {followups:rows,count:rows.length,overdue,message:`${rows.length} follow-ups in next ${days} days (${overdue} overdue)`};
    }

    case 'complete_followup': {
      const rows=await query(`UPDATE followups SET done=true WHERE id=$1 RETURNING id`,[args.id]);
      if(!rows.length) throw new Error('Not found');
      return {success:true,message:'✓ Done'};
    }

    case 'get_pipeline_stats': {
      const[stats,tot,emails,fups,recent]=await Promise.all([
        query(`SELECT status,COUNT(*) AS count FROM leads GROUP BY status`),
        query(`SELECT COUNT(*) AS n FROM leads`),
        query(`SELECT COUNT(*) AS n FROM outreach WHERE status='sent'`),
        query(`SELECT COUNT(*) AS n FROM followups WHERE done=false`),
        query(`SELECT name,company,status,updated_at FROM leads ORDER BY updated_at DESC LIMIT 6`),
      ]);
      const by={};stats.forEach(r=>{by[r.status]=parseInt(r.count);});
      const total=parseInt(tot[0]?.n||0),won=by.closed_won||0;
      return {total_leads:total,by_status:by,emails_sent:parseInt(emails[0]?.n||0),
        pending_followups:parseInt(fups[0]?.n||0),
        conversion_rate:total>0?`${Math.round(won/total*100)}%`:'0%',
        contact_rate:total>0?`${Math.round(((by.contacted||0)+(by.replied||0)+(by.qualified||0)+won)/total*100)}%`:'0%',
        recent_activity:recent};
    }

    case 'get_email_template': {
      const n=args.niche||'businesses';
      const t={
        cold_outreach:{subject:`Quick idea for [Company]`,body:`Hi [Name],\n\nI noticed [specific thing — no app, WhatsApp orders, etc.].\n\nI build mobile apps for ${n} using FlutterFlow — iOS + Android in 3-4 weeks at 50-70% less than traditional dev.\n\n15-min call this week?\n\n[Your name]`,tips:['Personalise line 2 for every send','Under 80 words','One CTA only']},
        followup:{subject:`Re: Quick idea for [Company]`,body:`Hi [Name],\n\nFollowing up from last week — happy to send a 2-min screen recording showing what an app would look like for [Company] if easier than a call.\n\nWorth a look?\n\n[Your name]`,tips:['Send 4-5 days after cold email','Offer video vs call','Max 2 follow-ups']},
        reengagement:{subject:`Still thinking about an app for [Company]?`,body:`Hi [Name],\n\nReaching back out — just finished a similar project for a ${n} client: [specific result].\n\nIs mobile still on your radar?\n\n[Your name]`,tips:['2-3 months after silence','Lead with a real result','Short and casual']},
        proposal:{subject:`Proposal: [App Name] for [Company]`,body:`Hi [Name],\n\nHere's a quick outline:\n\nSCOPE\n• iOS + Android app\n• Features: [1], [2], [3]\n• Built with FlutterFlow\n\nTIMELINE: 4 weeks\nINVESTMENT: [your price]\n\nNext step: confirm and I'll send the contract.\n\n[Your name]`,tips:['Keep scope tight','Single next step','Follow up in 2 days']},
      };
      return {template:t[args.type||'cold_outreach'],all_types:Object.keys(t)};
    }

    default: throw new Error('Unknown tool: '+name);
  }
}

// ─── Server boilerplate ───────────────────────────────────────────────────────
const sessions=new Map();
const uid=()=>crypto.randomUUID?crypto.randomUUID():crypto.randomBytes(16).toString('hex');
const cors=res=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Accept,Authorization,Mcp-Session-Id');res.setHeader('Access-Control-Expose-Headers','Mcp-Session-Id');};
const jsonRes=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(obj));};
const readBody=req=>new Promise((ok,fail)=>{const c=[];req.on('data',d=>c.push(d));req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(c).toString()||'null'));}catch(e){fail(e);}});req.on('error',fail);});

async function handleRPC(msg,sid){
  const{id,method,params={}}=msg;
  if(method==='initialize'){sessions.set(sid,Date.now());return{id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'leads-mcp',version:'3.0.0'}}};}
  if(method==='notifications/initialized') return null;
  if(method==='ping') return{id,result:{}};
  if(method==='tools/list') return{id,result:{tools:TOOLS}};
  if(method==='tools/call'){
    const{name,arguments:a={}}=params;
    try{const data=await runTool(name,a);return{id,result:{content:[{type:'text',text:JSON.stringify(data,null,2)}]}};}
    catch(e){return{id,result:{content:[{type:'text',text:'❌ '+e.message}],isError:true}};}
  }
  return{id,error:{code:-32601,message:'Unknown method: '+method}};
}

const server=http.createServer(async(req,res)=>{
  cors(res);
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  let pathname='/';try{pathname=new URL(req.url,'http://x').pathname;}catch(_){}
  const host=req.headers['x-forwarded-host']||req.headers['host']||'localhost';
  const proto=(req.headers['x-forwarded-proto']||'https').split(',')[0].trim();
  const base=`${proto}://${host}`;

  if(pathname==='/health'){
    let dbOk=false;try{await query('SELECT 1');dbOk=true;}catch(_){}
    return jsonRes(res,200,{status:'ok',db:dbOk,gmail:!!(GMAIL_USER&&GMAIL_APP_PASS)});
  }

  if(pathname==='/api/stats'){
    try{
      const[stats,tot,emails,fups,recent]=await Promise.all([
        query(`SELECT status,COUNT(*) AS count FROM leads GROUP BY status`),
        query(`SELECT COUNT(*) AS n FROM leads`),
        query(`SELECT COUNT(*) AS n FROM outreach WHERE status='sent'`),
        query(`SELECT COUNT(*) AS n FROM followups WHERE done=false AND due_date<=CURRENT_DATE+'7 days'::INTERVAL`),
        query(`SELECT name,company,status,updated_at FROM leads ORDER BY updated_at DESC LIMIT 8`),
      ]);
      const byStatus={};stats.forEach(r=>{byStatus[r.status]=parseInt(r.count);});
      return jsonRes(res,200,{byStatus,total:parseInt(tot[0]?.n||0),emailsSent:parseInt(emails[0]?.n||0),followupsDue:parseInt(fups[0]?.n||0),recent});
    }catch(e){return jsonRes(res,200,{byStatus:{},total:0,emailsSent:0,followupsDue:0,recent:[],error:e.message});}
  }

  if(pathname==='/api/leads'){
    try{return jsonRes(res,200,await query(`SELECT * FROM leads ORDER BY created_at DESC LIMIT 200`));}
    catch(e){return jsonRes(res,500,{error:e.message});}
  }

  if(pathname==='/api/followups'){
    try{return jsonRes(res,200,await query(`SELECT f.*,l.name AS lead_name,l.company FROM followups f JOIN leads l ON l.id=f.lead_id WHERE f.done=false ORDER BY f.due_date ASC LIMIT 30`));}
    catch(e){return jsonRes(res,500,{error:e.message});}
  }

  // OAuth passthrough (no real auth)
  if(pathname==='/.well-known/oauth-authorization-server')
    return jsonRes(res,200,{issuer:base,authorization_endpoint:`${base}/oauth/authorize`,token_endpoint:`${base}/oauth/token`,registration_endpoint:`${base}/oauth/register`,response_types_supported:['code'],grant_types_supported:['authorization_code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none']});
  if(req.method==='POST'&&pathname==='/oauth/register'){
    let b={};try{b=await readBody(req);}catch(_){}
    return jsonRes(res,201,{client_id:uid(),client_secret:uid(),client_name:b.client_name||'Client',redirect_uris:b.redirect_uris||[],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'});
  }
  if(req.method==='GET'&&pathname==='/oauth/authorize'){
    const u=new URL(req.url,base),r=u.searchParams.get('redirect_uri')||'',s=u.searchParams.get('state')||'';
    res.writeHead(302,{Location:`${r}${r.includes('?')?'&':'?'}code=${uid()}${s?'&state='+encodeURIComponent(s):''}`});return res.end();
  }
  if(req.method==='POST'&&pathname==='/oauth/token')
    return jsonRes(res,200,{access_token:'open-'+uid(),token_type:'bearer',expires_in:31536000});

  // MCP
  if(req.method==='POST'&&pathname==='/mcp'){
    let body;try{body=await readBody(req);}catch(e){return jsonRes(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
    let sid=req.headers['mcp-session-id'];if(!sid){sid=uid();res.setHeader('Mcp-Session-Id',sid);}
    const msgs=Array.isArray(body)?body:[body],out=[];
    for(const msg of msgs){if(!msg||msg.jsonrpc!=='2.0')continue;const r=await handleRPC(msg,sid);if(r)out.push({jsonrpc:'2.0',...r});}
    if(!out.length){res.writeHead(204);return res.end();}
    return jsonRes(res,200,Array.isArray(body)?out:out[0]);
  }
  if(req.method==='DELETE'&&pathname==='/mcp'){const sid=req.headers['mcp-session-id'];if(sid)sessions.delete(sid);res.writeHead(204);return res.end();}
  if(req.method==='GET'&&pathname==='/mcp') return jsonRes(res,200,{transport:'streamable-http',protocolVersion:'2024-11-05',tools:TOOLS.length});

  // Dashboard
  if(req.method==='GET'&&(pathname==='/'||pathname==='/index.html')){
    const fs=require('fs'),path=require('path');
    try{const html=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});return res.end(html);}
    catch(e){res.writeHead(404);return res.end('Dashboard not found');}
  }
  res.writeHead(404);res.end('Not found');
});

server.keepAliveTimeout=65000;server.headersTimeout=66000;
server.listen(PORT,'0.0.0.0',async()=>{console.log(`[Leads MCP v3] Port ${PORT}`);await initDB();});
server.on('error',err=>{console.error('[Fatal]',err);process.exit(1);});