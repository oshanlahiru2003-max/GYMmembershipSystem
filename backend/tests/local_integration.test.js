'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.GYM_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'mygym-int-test-'));
const {server}=require('../server');
const {CREDENTIALS_FILE}=require('../local_db');

const send=async (base, pathName, token, method='GET', body)=>{
 const r=await fetch(base+pathName,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const contentType=r.headers.get('content-type')||'';
 return {status:r.status,data:contentType.includes('application/pdf')?Buffer.from(await r.arrayBuffer()):contentType.includes('application/json')?await r.json():await r.text()};
};
test('local start, login, CRUD endpoints, report and access controls',async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 try {
  const details=fs.readFileSync(CREDENTIALS_FILE,'utf8');
  const adminPass=details.match(/Admin password: (\S+)/)[1];
  const memberPass=details.match(/Demo member password: (\S+)/)[1];
  const home=await send(base,'/landing.html'); assert.equal(home.status,200);assert.match(home.data,/Sign In/);
  const health=await send(base,'/api/health');assert.equal(health.data.mode,'SQLite embedded');
  const adminLogin=await send(base,'/api/login',null,'POST',{username:'admin',password:adminPass});assert.equal(adminLogin.status,200);
  const memberLogin=await send(base,'/api/login',null,'POST',{username:'member01',password:memberPass});assert.equal(memberLogin.status,200);
  const admin=adminLogin.data.token, member=memberLogin.data.token;
  assert.equal((await send(base,'/api/members')).status,401);
  assert.equal((await send(base,'/api/members',member)).status,403);
  for (const ep of ['members','plans','trainers','payments','attendance','equipment','workout-plans','feedbacks']) {
   const r=await send(base,'/api/'+ep,admin);assert.equal(r.status,200,ep+' '+JSON.stringify(r.data));assert(Array.isArray(r.data));
  }
  const trainer=await send(base,'/api/trainers',admin,'POST',{full_name:'Test Trainer',mobile:'0771111111',specialization:'Cardio',shift_timing:'7:00 AM - 11:00 AM'});
  assert.equal(trainer.status,201);
  const trainers=(await send(base,'/api/trainers',admin)).data;
  const trainerId=trainers[0].id;
  assert.equal((await send(base,'/api/trainers/'+trainerId,admin,'PUT',{full_name:'Updated Trainer',mobile:'0771111111',specialization:'Strength',shift_timing:'8:00 AM - 12:00 PM'})).status,200);
  assert.equal((await send(base,'/api/trainers/'+trainerId,admin,'DELETE')).status,200);
  const m=await send(base,'/api/register',admin,'POST',{full_name:'Test Student',username:'student42',password:'TestPass@123',mobile:'0771234567',plan_id:'1'});
  assert.equal(m.status,201,JSON.stringify(m.data));const memberId=m.data.member_id;
  assert.equal((await send(base,'/api/members/'+memberId,admin)).status,200);
  assert.equal((await send(base,'/api/members/'+memberId,admin,'PUT',{full_name:'Student Updated',mobile:'0771234567',age:20,gender:'Other',address:'Demo'})).status,200);
  assert.equal((await send(base,'/api/login',null,'POST',{username:'student42',password:'TestPass@123'})).status,200);
  const now=new Date(), y=now.getFullYear(), mo=String(now.getMonth()+1).padStart(2,'0');
  const today=now.toISOString().slice(0,10);const start=y+'-'+mo+'-01';const end=y+'-'+mo+'-'+String(new Date(y,now.getMonth()+1,0).getDate()).padStart(2,'0');
  const reportQuery=`?type=full&start=${start}&end=${end}`;
  const preview=await send(base,'/api/reports/preview'+reportQuery,admin);
  assert.equal(preview.status,200,JSON.stringify(preview.data));assert(preview.data.summary.totalRevenue>=33300);assert(preview.data.summary.totalMembers>=4);
  const pdf=await send(base,'/api/reports/pdf'+reportQuery,admin);assert.equal(pdf.status,200,JSON.stringify(pdf.data));assert(pdf.data.toString('ascii',0,8).startsWith('%PDF-1.4'));
  assert.equal((await send(base,'/api/reports/preview'+reportQuery,member)).status,403);
  const memberPayments=await send(base,'/api/payments',member);assert.equal(memberPayments.status,200);assert(memberPayments.data.every(row=>row.member_id===1));
  const feedback=await send(base,'/api/feedbacks',member,'POST',{member_id:2,message:'Member feedback demo'});assert.equal(feedback.status,201);
  const allFeedback=(await send(base,'/api/feedbacks',admin)).data;
  assert.equal(allFeedback[0].member_id,1,'Member cannot forge feedback author');
  const newMemberPayment=await send(base,'/api/payments',admin,'POST',{member_id:memberId,amount:1000,payment_date:today,status:'Paid'});assert.equal(newMemberPayment.status,201);
  const attend=await send(base,'/api/attendance',admin,'POST',{member_id:memberId,attendance_date:today,time_in:'09:00'});assert.equal(attend.status,201);
  const equipment=await send(base,'/api/equipment',admin,'POST',{name:'Demo Test Bench',units:1,price:900});assert.equal(equipment.status,201);
  const workouts=await send(base,'/api/workout-plans',admin,'POST',{member_id:memberId,plan_title:'Intro',start_date:today,end_date:today,details:'Demo plan'});assert.equal(workouts.status,201);
  assert.equal((await send(base,'/api/members/'+memberId,admin,'DELETE')).status,200);
 } finally {
  await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
 }
});
