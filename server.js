'use strict';
// MY.GYM — portable, local-only university demo backend. Requires Node.js 24+.
// Embedded SQLite replaces the broken XAMPP/MariaDB installation; no npm install needed.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {all,get,run,today,monthsAfter,hashPassword,verifyPassword,authSecret,reportAdapter,DB_FILE,CREDENTIALS_FILE} = require('./local_db');
const {validateReportOptions,readReportData} = require('./report_data');
const {buildReportPdf} = require('./report_pdf');
const FRONTEND = path.resolve(__dirname,'..','Front end');
const HOST = '127.0.0.1';
const PORT = 5000;
const JSON_HEADERS = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};

const b64url = x => Buffer.from(x).toString('base64url');
function makeToken(id, role) {
 const header=b64url(JSON.stringify({alg:'HS256',typ:'JWT'}));
 const payload=b64url(JSON.stringify({id,role,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+8*3600}));
 const sign=crypto.createHmac('sha256',authSecret).update(header+'.'+payload).digest('base64url');
 return header+'.'+payload+'.'+sign;
}
function verifyToken(text) {
 if (typeof text !== 'string') return null;
 const parts=text.split('.');
 if (parts.length!==3) return null;
 const actual=crypto.createHmac('sha256',authSecret).update(parts[0]+'.'+parts[1]).digest();
 let claimed;
 try {claimed=Buffer.from(parts[2],'base64url');} catch (_) {return null;}
 if (actual.length!==claimed.length || !crypto.timingSafeEqual(actual,claimed)) return null;
 try {
  const payload=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
  if(payload.exp <= Date.now()/1000 || !['admin','member'].includes(payload.role)|| !Number.isSafeInteger(payload.id)) return null;
  return payload;
 } catch (_) {return null;}
}
function output(res,status,data,extra={}) {
 const body=Buffer.from(JSON.stringify(data));
 res.writeHead(status,{...JSON_HEADERS,'Content-Length':body.length,...extra});res.end(body);
}
function error(res,status,message) {output(res,status,{message,error:message});}
async function readBody(req) {
 let count=0, chunks=[];
 for await(const chunk of req){ count+=chunk.length; if(count>1024*1024){const e=new Error('Request too large');e.status=413;throw e;}chunks.push(chunk);}
 try {return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch(_){const e=new Error('Invalid JSON');e.status=400;throw e;}
}
function cleanString(x) {return typeof x==='string' ? x.trim() : '';}
function int(x,min=1) {const n=Number(x);return Number.isSafeInteger(n)&&n>=min?n:null;}
function float(x,min=0) {const n=Number(x);return Number.isFinite(n)&&n>=min?n:null;}
function date(x){return typeof x==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(x)&&!Number.isNaN(Date.parse(x))&&new Date(x).toISOString().slice(0,10)===x?x:null;}
function validShift(value) {
 const r=/^(1[0-2]|[1-9]):([0-5]\d) (AM|PM) - (1[0-2]|[1-9]):([0-5]\d) (AM|PM)$/;
 const m=r.exec(value||'');return !!(m && `${m[1]}:${m[2]} ${m[3]}`!==`${m[4]}:${m[5]} ${m[6]}`);
}
function safeRun(sql,values=[]) {return run(sql,values.map(v=>v===undefined?'':v));}
function ownOrAdmin(user,id){return user.role==='admin'||Number(user.id)===Number(id);}
function isDbError(err){return /SQLITE_|constraint|FOREIGN KEY|UNIQUE/.test(err.message||'');}

async function handleApi(req,res,url) {
 const p=url.pathname, m=req.method;
 if(p==='/api/health' && m==='GET') return output(res,200,{ok:true,mode:'SQLite embedded',database:'Ready'});
 if(p==='/api/login' && m==='POST') {
  const b=await readBody(req);let user,role;
  if (!cleanString(b.username)||typeof b.password!=='string') return error(res,400,'Username and password are required.');
  user=get('SELECT id,username,password_hash FROM admin_accounts WHERE username=? COLLATE NOCASE',[cleanString(b.username)]);
  if(user) role='admin';
  else {user=get('SELECT id,username,password FROM members WHERE username=? COLLATE NOCASE',[cleanString(b.username)]);role='member';}
  if(!user||!verifyPassword(b.password,user.password_hash||user.password)) return error(res,401,'Incorrect username or password.');
  return output(res,200,{message:'Login successful',token:makeToken(Number(user.id),role),role,...(role==='member'?{member_id:Number(user.id)}:{})});
 }
 const auth=(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);
 const user=verifyToken(auth?.[1]);
 if(!user) return error(res,401,'Sign in required or session expired.');
 const isAdmin=user.role==='admin';
 const memberMatch=p.match(/^\/api\/members\/(\d+)(?:\/(password|renew-plan))?$/);
 const membershipMatch=p.match(/^\/api\/my-membership\/(\d+)$/);
 const memberRead = isAdmin || (
   (memberMatch && (m==='GET'||m==='PUT') && memberMatch[2]!=='renew-plan' && Number(memberMatch[1])===user.id) ||
   (membershipMatch && m==='GET' && Number(membershipMatch[1])===user.id) ||
   (m==='GET'&&['/api/payments','/api/attendance','/api/workout-plans'].includes(p)) ||
   (m==='POST'&&p==='/api/feedbacks')
 );
 if(!memberRead) return error(res,403,'You do not have permission to do this.');

 // Members: registration is managed by the administrator.
 if(p==='/api/register'&&m==='POST') {
  const b=await readBody(req);
  if(!cleanString(b.full_name)||!cleanString(b.username)||typeof b.password!=='string'||b.password.length<8)
   return error(res,400,'Name and username are required; password must be at least 8 characters.');
  if(get('SELECT id FROM members WHERE username=? COLLATE NOCASE',[cleanString(b.username)])||get('SELECT id FROM admin_accounts WHERE username=? COLLATE NOCASE',[cleanString(b.username)]))return error(res,400,'Username already exists.');
  const chosenPlan=b.plan_id?int(b.plan_id):null, chosenTrainer=b.trainer_id?int(b.trainer_id):null;
  if(b.plan_id && (!chosenPlan||!get('SELECT id FROM plans WHERE id=?',[chosenPlan]))) return error(res,400,'Select an existing membership plan.');
  if(chosenTrainer && !get('SELECT id FROM trainers WHERE id=?',[chosenTrainer])) return error(res,400,'Select an existing trainer.');
  const start=date(b.join_date)||today();
  const id=Number(safeRun('INSERT INTO members(full_name,username,password,mobile,age,gender,address,join_date) VALUES(?,?,?,?,?,?,?,?)',[
    cleanString(b.full_name),cleanString(b.username),hashPassword(b.password),cleanString(b.mobile),b.age?int(b.age):null,cleanString(b.gender),cleanString(b.address),start]).lastInsertRowid);
  if(chosenPlan){ const plan=get('SELECT duration_months FROM plans WHERE id=?',[chosenPlan]);safeRun('INSERT INTO member_plans(member_id,plan_id,trainer_id,start_date,end_date,status) VALUES(?,?,?,?,?,?)',[id,chosenPlan,chosenTrainer,start,monthsAfter(start,plan.duration_months),'Active']); }
  return output(res,201,{message:'Member registered successfully.',member_id:id});
 }
 if(p==='/api/members'&&m==='GET')return output(res,200,all('SELECT id,full_name,username,mobile,join_date FROM members ORDER BY id DESC'));
 if(memberMatch) {
  const id=int(memberMatch[1]); if(!id)return error(res,400,'Invalid member ID.');
  if(memberMatch[2]==='password'&&m==='PUT') {
   const b=await readBody(req);const record=get('SELECT password FROM members WHERE id=?',[id]);
   if(!record)return error(res,404,'Member not found.');
   if(typeof b.newPassword!=='string'||b.newPassword.length<8)return error(res,400,'New password must be at least 8 characters.');
   if(!verifyPassword(b.currentPassword,record.password))return error(res,400,'Current password incorrect.');
   safeRun('UPDATE members SET password=? WHERE id=?',[hashPassword(b.newPassword),id]);
   return output(res,200,{message:'Password updated successfully.'});
  }
  if(memberMatch[2]==='renew-plan'&&m==='POST') {
   const b=await readBody(req), plan=int(b.plan_id);
   const item=plan?get('SELECT duration_months FROM plans WHERE id=?',[plan]):null;
   if(!get('SELECT id FROM members WHERE id=?',[id]))return error(res,404,'Member not found.');
   if(!item)return error(res,404,'Plan not found.');
   const tr=b.trainer_id?int(b.trainer_id):null, start=date(b.start_date)||today();
   if(tr&&!get('SELECT id FROM trainers WHERE id=?',[tr]))return error(res,400,'Trainer not found.');
   safeRun("UPDATE member_plans SET status='Expired' WHERE member_id=?",[id]);
   safeRun('INSERT INTO member_plans (member_id,plan_id,trainer_id,start_date,end_date,status) VALUES(?,?,?,?,?,?)',[id,plan,tr,start,monthsAfter(start,item.duration_months),'Active']);
   return output(res,201,{message:'Membership renewed successfully.'});
  }
  if(!memberMatch[2]&&m==='GET') {const result=get('SELECT id,full_name,username,mobile,age,gender,address,join_date FROM members WHERE id=?',[id]);return result?output(res,200,result):error(res,404,'Member not found.');}
  if(!memberMatch[2]&&m==='PUT') {
   const b=await readBody(req);
   if(!cleanString(b.full_name))return error(res,400,'Name is required.');
   const r=safeRun('UPDATE members SET full_name=?,mobile=?,age=?,gender=?,address=? WHERE id=?',[cleanString(b.full_name),cleanString(b.mobile),b.age?int(b.age):null,cleanString(b.gender),cleanString(b.address),id]);
   return r.changes?output(res,200,{message:'Member updated.'}):error(res,404,'Member not found.');
  }
  if(!memberMatch[2]&&m==='DELETE'){const r=safeRun('DELETE FROM members WHERE id=?',[id]);return r.changes?output(res,200,{message:'Member deleted.'}):error(res,404,'Member not found.');}
 }
 if(p==='/api/plans'&&m==='GET')return output(res,200,all('SELECT * FROM plans ORDER BY id DESC'));
 if(p==='/api/plans'&&m==='POST') {
  const b=await readBody(req),months=int(b.duration_months),fee=float(b.fee);
  if(!cleanString(b.plan_name)||!months||months>120||fee===null)return error(res,400,'Enter plan name, duration and a valid fee.');
  safeRun('INSERT INTO plans(plan_name,duration_months,fee) VALUES(?,?,?)',[cleanString(b.plan_name),months,fee]);return output(res,201,{message:'Plan added.'});
 }
 if(p==='/api/trainers'&&m==='GET')return output(res,200,all('SELECT * FROM trainers ORDER BY id DESC'));
 const trainerMatch=p.match(/^\/api\/trainers\/(\d+)$/);
 if(p==='/api/trainers'&&m==='POST'||trainerMatch&&m==='PUT'){
  const b=await readBody(req);
  if(!cleanString(b.full_name)||!cleanString(b.mobile)||!cleanString(b.specialization)||!validShift(b.shift_timing))return error(res,400,'Enter name, mobile, specialization and exact shift hours.');
  if(trainerMatch){const r=safeRun('UPDATE trainers SET full_name=?,mobile=?,specialization=?,shift_timing=? WHERE id=?',[cleanString(b.full_name),cleanString(b.mobile),cleanString(b.specialization),b.shift_timing,int(trainerMatch[1])]);return r.changes?output(res,200,{message:'Trainer updated.'}):error(res,404,'Trainer not found.');}
  safeRun('INSERT INTO trainers(full_name,mobile,gender,age,specialization,shift_timing,salary) VALUES(?,?,?,?,?,?,?)',[cleanString(b.full_name),cleanString(b.mobile),cleanString(b.gender),b.age?int(b.age):null,cleanString(b.specialization),b.shift_timing,b.salary?float(b.salary):null]);return output(res,201,{message:'Trainer added.'});
 }
 if(trainerMatch&&m==='DELETE'){const r=safeRun('DELETE FROM trainers WHERE id=?',[int(trainerMatch[1])]);return r.changes?output(res,200,{message:'Trainer deleted.'}):error(res,404,'Trainer not found.');}
 if(p==='/api/payments'&&m==='GET')return output(res,200,all(`SELECT p.id,p.member_id,m.full_name AS member_name,p.amount,p.status,p.payment_date
 FROM payments p JOIN members m ON p.member_id=m.id WHERE (?='admin' OR p.member_id=?) ORDER BY p.id DESC`,[user.role,user.id]));
 if(p==='/api/payments'&&m==='POST'){
  const b=await readBody(req),id=int(b.member_id),amount=float(b.amount),when=date(b.payment_date);
  if(!id||!get('SELECT id FROM members WHERE id=?',[id])||amount===null||!when||!['Paid','Pending'].includes(b.status))return error(res,400,'Select a member, amount, valid date and payment status.');
  safeRun('INSERT INTO payments(member_id,amount,payment_date,status) VALUES(?,?,?,?)',[id,amount,when,b.status]);return output(res,201,{message:'Payment recorded.'});
 }
 if(p==='/api/attendance'&&m==='GET')return output(res,200,all(`SELECT a.id,a.member_id,m.full_name AS member_name,a.attendance_date,a.time_in FROM attendance a JOIN members m ON a.member_id=m.id WHERE (?='admin' OR a.member_id=?) ORDER BY a.attendance_date DESC,a.time_in DESC`,[user.role,user.id]));
 if(p==='/api/attendance'&&m==='POST'){
  const b=await readBody(req),id=int(b.member_id),when=date(b.attendance_date);
  if(!id||!get('SELECT id FROM members WHERE id=?',[id])||!when||!/^\d\d:\d\d(?::\d\d)?$/.test(b.time_in||''))return error(res,400,'Select member, valid date and time.');
  safeRun('INSERT INTO attendance(member_id,attendance_date,time_in) VALUES(?,?,?)',[id,when,b.time_in]);return output(res,201,{message:'Attendance saved.'});
 }
 if(p==='/api/equipment'&&m==='GET')return output(res,200,all('SELECT * FROM equipment ORDER BY id DESC'));
 if(p==='/api/equipment'&&m==='POST'){
  const b=await readBody(req),n=int(b.units),price=float(b.price);
  if(!cleanString(b.name)||!n||price===null)return error(res,400,'Enter equipment name, units and price.');
  safeRun('INSERT INTO equipment(name,units,price) VALUES(?,?,?)',[cleanString(b.name),n,price]);return output(res,201,{message:'Equipment added.'});
 }
 const equipMatch=p.match(/^\/api\/equipment\/(\d+)$/);
 if(equipMatch&&m==='DELETE'){const r=safeRun('DELETE FROM equipment WHERE id=?',[int(equipMatch[1])]);return r.changes?output(res,200,{message:'Equipment deleted.'}):error(res,404,'Equipment not found.');}
 if(p==='/api/workout-plans'&&m==='GET')return output(res,200,all(`SELECT w.id,w.member_id,m.full_name AS member_name,w.plan_title,w.start_date,w.end_date,w.details FROM workout_plans w JOIN members m ON w.member_id=m.id WHERE (?='admin' OR w.member_id=?) ORDER BY w.id DESC`,[user.role,user.id]));
 if(p==='/api/workout-plans'&&m==='POST'){
  const b=await readBody(req),id=int(b.member_id),start=date(b.start_date),end=date(b.end_date);
  if(!id||!get('SELECT id FROM members WHERE id=?',[id])||!cleanString(b.plan_title)||!start||!end||end<start)return error(res,400,'Enter member, plan title, valid start and end dates.');
  safeRun('INSERT INTO workout_plans(member_id,plan_title,start_date,end_date,details) VALUES(?,?,?,?,?)',[id,cleanString(b.plan_title),start,end,cleanString(b.details)]);return output(res,201,{message:'Workout plan saved.'});
 }
 const workoutMatch=p.match(/^\/api\/workout-plans\/(\d+)$/);
 if(workoutMatch&&m==='DELETE'){const r=safeRun('DELETE FROM workout_plans WHERE id=?',[int(workoutMatch[1])]);return r.changes?output(res,200,{message:'Workout plan deleted.'}):error(res,404,'Workout plan not found.');}
 if(p==='/api/feedbacks'&&m==='GET')return output(res,200,all('SELECT f.id,f.member_id,m.full_name AS member_name,f.message,f.created_at FROM feedbacks f JOIN members m ON f.member_id=m.id ORDER BY f.id DESC'));
 if(p==='/api/feedbacks'&&m==='POST'){
  const b=await readBody(req),id=user.role==='member'?user.id:int(b.member_id);
  if(!id||!get('SELECT id FROM members WHERE id=?',[id])||!cleanString(b.message)||b.message.length>5000)return error(res,400,'Enter a feedback message (up to 5000 characters).');
  safeRun('INSERT INTO feedbacks(member_id,message) VALUES (?,?)',[id,cleanString(b.message)]);return output(res,201,{message:'Feedback sent.'});
 }
 if(membershipMatch&&m==='GET'){
  const id=int(membershipMatch[1]);
  return output(res,200,all(`SELECT mp.*,p.plan_name,p.fee,p.duration_months,t.full_name AS trainer_name
 FROM member_plans mp JOIN plans p ON mp.plan_id=p.id LEFT JOIN trainers t ON mp.trainer_id=t.id
 WHERE mp.member_id=? AND mp.status='Active' ORDER BY mp.id DESC LIMIT 1`,[id]));
 }
 if((p==='/api/reports/preview'||p==='/api/reports/pdf')&&m==='GET'){
  const options=validateReportOptions(Object.fromEntries(url.searchParams));
  const report=await readReportData(reportAdapter,options);
  if(p.endsWith('/preview'))return output(res,200,{meta:report.meta,summary:report.summary,charts:report.charts});
  const pdf=buildReportPdf(report);
  const filename=`MyGym_${options.type}_${options.start}_to_${options.end}.pdf`;
  res.writeHead(200,{'Content-Type':'application/pdf','Content-Length':pdf.length,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="${filename}"`,'X-Content-Type-Options':'nosniff'});
  return res.end(pdf);
 }
 return error(res,404,'API route not found.');
}
function servePage(req,res,pathname){
 const filenames={'/':'landing.html','/landing.html':'landing.html','/index.html':'index.html','/admin.html':'admin.html','/member.html':'member.html'};
 const name=filenames[pathname];
 if(!name)return error(res,404,'Page not found.');
 const content=fs.readFileSync(path.join(FRONTEND,name));
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':content.length,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(content);
}
const server=http.createServer(async(req,res)=>{
 try{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Authorization,Content-Type');
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  const url=new URL(req.url,'http://localhost:5000');
  if(url.pathname.startsWith('/api/'))return await handleApi(req,res,url);
  if(req.method==='GET')return servePage(req,res,url.pathname);
  return error(res,405,'Method not allowed.');
 }catch(err){
  console.error('Request error:',err.message);
  if(!res.headersSent)return error(res,err.status||((isDbError(err)||/^(Invalid report type|Choose valid|Start date|Select a period)/.test(err.message))?400:500),err.status===413||err.status===400||isDbError(err)||/^(Invalid report type|Choose valid|Start date|Select a period)/.test(err.message)?err.message:'Unable to complete request. See server console.');
  res.end();
 }
});
if(require.main===module){server.listen(PORT,HOST,()=>{
 console.log('\n==============================================');
 console.log('   MY.GYM — University Project (Local Mode)');
 console.log('==============================================');
 console.log(`Server running: http://localhost:${PORT}/`);
 console.log('Database: Embedded SQLite (XAMPP NOT required)');
 console.log(`Database file: ${DB_FILE}`);
 console.log(`First-run login file: ${CREDENTIALS_FILE}`);
 console.log('Keep this window open while using the project.');
 console.log('==============================================\n');
 });}
module.exports={server,makeToken,verifyToken};
