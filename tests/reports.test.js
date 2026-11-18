'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { readReportData, validateReportOptions } = require('../report_data');
const { buildReportPdf } = require('../report_pdf');

const sample = {
    members: [{id:1,full_name:'Lahiru S',username:'lahiru',join_date:'2026-11-01'}, {id:2,full_name:'Bhanu K',username:'bhanu',join_date:'2026-09-01'}, {id:3,full_name:'Test Member',username:'test',join_date:'2026-11-16'}],
    member_plans: [
        {member_id:1,plan_id:2,status:'Active',start_date:'2026-10-01',end_date:'2026-12-01'},
        {member_id:2,plan_id:1,status:'Active',start_date:'2026-07-01',end_date:'2026-10-01'}
    ],
    payments: [
        {id:1,member_id:1,member_name:'Lahiru S',amount:'1500.00',status:'Paid',payment_date:'2026-11-03'},
        {id:2,member_id:2,member_name:'Bhanu K',amount:'1200.00',status:'Pending',payment_date:'2026-11-10'},
        {id:3,member_id:1,member_name:'Lahiru S',amount:'500.00',status:'Paid',payment_date:'2026-11-18'}
    ],
    attendance: [{id:1, member_name:'Lahiru S',member_id:1,attendance_date:'2026-11-02',time_in:'06:00:00'}, {id:2,member_name:'Lahiru S',member_id:1,attendance_date:'2026-11-03',time_in:'06:00:00'}],
    plans: [{id:1,plan_name:'Monthly',fee:1200,duration_months:1}, {id:2,plan_name:'Quarterly',fee:3400,duration_months:3}],
    trainers: [{id:1,full_name:'Lahiru',mobile:'078123456',specialization:'Cardio',shift_timing:'6:00 AM - 10:00 AM'}],
    equipment:[{id:1,name:'Treadmill',units:2,price:400000}],
    workout_plans:[{id:1,member_name:'Lahiru S',plan_title:'Strength',start_date:'2026-11-01',end_date:'2026-12-01'}],
    feedbacks:[{id:1,member_name:'Lahiru S',message:'Great service',created_date:'2026-11-12'}]
};
const db = {promise(){return {query:async(sql)=>{
    let key;
    if (sql.includes('FROM member_plans')) key='member_plans';
    else if(sql.includes('FROM members')) key='members';
    else if(sql.includes('FROM payments')) key='payments';
    else if(sql.includes('FROM attendance')) key='attendance';
    else if(sql.includes('FROM plans')) key='plans';
    else if(sql.includes('FROM trainers')) key='trainers';
    else if(sql.includes('FROM equipment')) key='equipment';
    else if(sql.includes('FROM workout_plans')) key='workout_plans';
    else if(sql.includes('FROM feedbacks')) key='feedbacks';
    else throw Error('unexpected sql: '+sql);
    return [sample[key]];
}};}};

for (const bad of [
    {type:'full',start:'2026-02-30',end:'2026-03-01'},
    {type:'invalid',start:'2026-11-01',end:'2026-11-30'},
    {type:'full',start:'2026-12-01',end:'2026-11-30'},
    {type:'full',start:'2023-01-01',end:'2026-11-30'}
]) test('bad report options rejected '+JSON.stringify(bad),()=>assert.throws(()=>validateReportOptions(bad)));

test('report totals, range filters, time buckets and as-of membership calculation',async()=>{
    const report=await readReportData(db,{type:'full',start:'2026-11-01',end:'2026-11-30'});
    assert.equal(report.summary.totalMembers,3);
    assert.equal(report.summary.activeMembers,1);
    assert.equal(report.summary.expiredMembers,1);
    assert.equal(report.summary.otherMembers,1);
    assert.equal(report.summary.newMembers,2);
    assert.equal(report.summary.totalRevenue,2000);
    assert.equal(report.summary.pendingAmount,1200);
    assert.equal(report.summary.totalAttendance,2);
    assert.equal(report.charts.revenue.length,30);
    assert.equal(report.charts.revenue.reduce((sum,p)=>sum+p.revenue,0),2000);
    assert.equal(report.tables.plans.find(p=>p.id===2).active_members,1);
});

test('export each report type as a self-contained PDF',async()=>{
    for(const type of ['full','financial','members','attendance']) {
        const report=await readReportData(db,{type,start:'2026-11-01',end:'2026-11-30'});
        const pdf=buildReportPdf(report);
        assert.equal(pdf.subarray(0,8).toString(),'%PDF-1.4');
        assert(pdf.includes(Buffer.from('startxref')));
        assert(pdf.includes(Buffer.from('Generated: ')));
        assert(pdf.length>3000);
    }
});

test('many rows paginate correctly and footer includes page count',async()=>{
    const report=await readReportData(db,{type:'attendance',start:'2026-11-01',end:'2026-11-30'});
    report.tables.attendance=Array.from({length:160},(_,i)=>({...sample.attendance[0],id:i+1}));
    const pdf=buildReportPdf(report);
    assert(pdf.includes(Buffer.from('Page 1 of ')));
    assert(pdf.includes(Buffer.from('Attendance records \\(continued\\)')));
});
