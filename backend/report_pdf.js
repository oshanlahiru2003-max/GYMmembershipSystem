'use strict';

// Dependency-free, A4 PDF export (PDF 1.4, standard Helvetica fonts).
// Report content uses concise Latin text; arbitrary scripts require font embedding.
const PAGE_W = 595.28, PAGE_H = 841.89, LEFT = 42, RIGHT = PAGE_W - 42;
const NAVY = [0.11, 0.16, 0.25];
const BLUE = [0.02, 0.52, 0.80];
const SLATE = [0.35, 0.42, 0.51];
const LIGHT = [0.95, 0.97, 0.99];
const GREEN = [0.10, 0.64, 0.42];
const ORANGE = [0.95, 0.51, 0.15];
const RED = [0.90, 0.28, 0.35];
const fmt = n => Number(n || 0).toLocaleString('en-US', {maximumFractionDigits: 2});
const money = n => `Rs. ${Number(n || 0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const date = value => value ? String(value).slice(0, 10) : '-';
function clean(value) {
    return String(value === undefined || value === null ? '-' : value)
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g,'"')
        .replace(/[^\x20-\x7e\xA0-\xFF]/g, '?');
}
function fit(value, width, size = 9) {
    let s = clean(value).replace(/\s+/g, ' ');
    const max = Math.max(3, Math.floor(width / (size * 0.53)));
    if (s.length > max) s = s.slice(0, max - 3) + '...';
    return s;
}
function escapePdf(s) { return clean(s).replace(/[\\()]/g, '\\$&'); }
function rgb(color) { return color.map(n=>Number(n).toFixed(3)).join(' '); }
function num(n) {return Number(n).toFixed(2);}

class Painter {
    constructor(meta) { this.meta=meta; this.pages=[]; this.newPage(); }
    newPage() {
        this.page=[]; this.pages.push(this.page); this.y=PAGE_H-110;
        this.rect(0, PAGE_H-72, PAGE_W, 72, NAVY);
        this.text('MY.GYM', LEFT, PAGE_H-43, 19, [1,1,1], true);
        this.text('MANAGEMENT REPORT', LEFT+110, PAGE_H-42, 9, [0.72,0.84,0.95]);
        this.line(LEFT, 54, RIGHT, 54, [0.86,0.89,0.93]);
    }
    text(value,x,y,size=9,color=NAVY,bold=false) {
        this.page.push(`BT /F${bold?2:1} ${num(size)} Tf ${rgb(color)} rg 1 0 0 1 ${num(x)} ${num(y)} Tm (${escapePdf(value)}) Tj ET\n`);
    }
    rect(x,y,w,h,color) { this.page.push(`${rgb(color)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f\n`); }
    strokeRect(x,y,w,h,color) { this.page.push(`${rgb(color)} RG 0.8 w ${num(x)} ${num(y)} ${num(w)} ${num(h)} re S\n`); }
    line(x1,y1,x2,y2,color=[0.85,0.89,0.92],thick=0.7) { this.page.push(`${rgb(color)} RG ${num(thick)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S\n`); }
    ensure(h) { if (this.y-h < 77) this.newPage(); }
    gap(n=12) { this.y -= n; }
    heading(title, subtitle='') {
        this.ensure(58);
        this.gap(12);
        this.text(title, LEFT, this.y, 14, NAVY, true);
        this.y -= 14;
        if (subtitle) { this.text(subtitle, LEFT, this.y, 8, SLATE); this.y -= 15; }
        else this.y -= 10;
        this.line(LEFT, this.y, RIGHT, this.y, [0.86,0.90,0.95]);
        this.y -= 12;
    }
    note(value) {
        this.ensure(24); this.text(fit(value, RIGHT-LEFT, 8.5), LEFT, this.y, 8.5, SLATE); this.y -= 19;
    }
    kpis(values) {
        this.ensure(Math.ceil(values.length/2)*64+12);
        const w=(RIGHT-LEFT-13)/2, h=55;
        values.forEach(([label,value], i)=>{
            const col=i%2, row=Math.floor(i/2), x=LEFT+col*(w+13), y=this.y-row*64-h;
            this.rect(x,y,w,h,LIGHT);
            this.rect(x,y,w,3,BLUE);
            this.text(fit(label,w-25,8.5), x+12,y+36,8.5,SLATE);
            this.text(fit(value,w-24,17),x+12,y+12,17,NAVY,true);
        });
        this.y -= Math.ceil(values.length/2)*64+8;
    }
    chart(bars,title) {
        this.ensure(208);
        this.heading(title);
        const x=LEFT+35, y=this.y-137, w=RIGHT-LEFT-48, h=114;
        this.line(x,y,x+w,y,[0.7,0.77,0.84]);
        const max=Math.max(1,...bars.map(p=>Number(p.revenue)||0));
        const n=Math.max(1,bars.length), step=w/n, barW=Math.max(2,Math.min(28,step*0.62));
        bars.forEach((p,i)=>{
            const amount=Math.max(0,Number(p.revenue)||0), bh=amount/max*(h-17);
            this.rect(x+i*step+(step-barW)/2,y+1,barW,bh,BLUE);
            if (i % Math.max(1,Math.ceil(n/9)) === 0) {
                const label=String(p.label || '').slice(-5);
                this.text(label,x+i*step-1,y-12,6.7,SLATE);
            }
        });
        this.text(money(max),x+1,y+h-1,7,SLATE);
        this.text('0',x-10,y-3,7,SLATE);
        this.y=y-29;
    }
    pie(items) {
        this.ensure(152);
        this.heading('Membership status at period end');
        const vals=items.map(v=>Math.max(0,Number(v.value)||0)), total=vals.reduce((a,b)=>a+b,0);
        const colors=[GREEN,RED,SLATE], cx=LEFT+91, cy=this.y-65, r=57;
        if (!total) {
            this.rect(cx-r,cy-3,r*2,6,LIGHT);
            this.text('No memberships',cx+80,cy,9,SLATE);
        } else {
            let angle=-Math.PI/2;
            vals.forEach((value,i)=>{
                if (!value) return;
                const arc=2*Math.PI*value/total, segments=Math.max(3,Math.ceil(arc/0.12));
                const parts=[`${rgb(colors[i])} rg ${num(cx)} ${num(cy)} m`];
                for(let s=0;s<=segments;s++) {
                    const a=angle+s/segments*arc;
                    parts.push(`${num(cx+Math.cos(a)*r)} ${num(cy+Math.sin(a)*r)} l`);
                }
                parts.push('h f\n');this.page.push(parts.join(' ')); angle+=arc;
            });
        }
        items.forEach((item,i)=>{
            const y=this.y-27-i*31;
            this.rect(LEFT+187,y-2,9,9,colors[i]);
            this.text(fit(item.label,190,9),LEFT+206,y,9,NAVY);
            this.text(fmt(item.value),RIGHT-40,y,10,NAVY,true);
        });
        this.y-=142;
    }
    table(title,columns,rows,options={}) {
        // Keep a section heading with at least its column header and first record.
        this.ensure(105);
        const subtitle=options.subtitle||`${rows.length} record(s)`;
        this.heading(title,subtitle);
        if (!rows.length) {this.note('No records in this selection.');return;}
        const widths=columns.map(c=>c.width), fullWidth=widths.reduce((a,b)=>a+b,0);
        if (Math.abs(fullWidth-(RIGHT-LEFT))>1) throw new Error(`PDF table width invalid: ${title}`);
        const head=()=>{
            this.ensure(45);
            const top=this.y;
            this.rect(LEFT,top-24,RIGHT-LEFT,24,NAVY);
            let x=LEFT;
            columns.forEach(c=>{this.text(fit(c.title,c.width-10,8),x+6,top-16,8,[1,1,1],true);x+=c.width;});
            this.y-=24;
        };
        head();
        for (let i=0;i<rows.length;i++) {
            if(this.y-23 < 76){this.newPage();this.text(fit(title+' (continued)',RIGHT-LEFT,10),LEFT,this.y,10,NAVY,true);this.y-=23;head();}
            const row=rows[i];
            if (i%2===0) this.rect(LEFT,this.y-22,RIGHT-LEFT,22,LIGHT);
            let x=LEFT;
            columns.forEach(c=>{
                const value=typeof c.render==='function' ? c.render(row) : row[c.key];
                this.text(fit(value,c.width-13,8),x+6,this.y-14.5,8,NAVY);
                x+=c.width;
            });
            this.y-=22;
        }
        this.y-=10;
    }
    finish() {
        this.pages.forEach((page,i)=>{
            const generated=this.meta.generatedAt.replace('T',' ').replace(/\.\d+Z$/,' UTC');
            page.push(`BT /F1 8 Tf ${rgb(SLATE)} rg 1 0 0 1 ${num(LEFT)} 37 Tm (${escapePdf('Generated: '+generated)}) Tj ET\n`);
            page.push(`BT /F1 8 Tf ${rgb(SLATE)} rg 1 0 0 1 ${num(RIGHT-83)} 37 Tm (${escapePdf(`Page ${i+1} of ${this.pages.length}`)}) Tj ET\n`);
        });
        return serializePdf(this.pages);
    }
}
function serializePdf(pages) {
    const objs=new Map(), kids=[];
    objs.set(1,'<< /Type /Catalog /Pages 2 0 R >>');
    objs.set(3,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objs.set(4,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    pages.forEach((lines,i)=>{
        const p=5+i*2, streamId=p+1, s=Buffer.from(lines.join(''),'latin1');
        kids.push(`${p} 0 R`);
        objs.set(p,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(PAGE_W)} ${num(PAGE_H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`);
        objs.set(streamId, Buffer.concat([Buffer.from(`<< /Length ${s.length} >>\nstream\n`),s,Buffer.from('\nendstream')]));
    });
    objs.set(2,`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
    const result=[Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n','latin1')];
    const offsets=[0]; let cursor=result[0].length;
    const add=b=>{ result.push(b);cursor+=b.length; };
    for(let id=1;id<=4+pages.length*2;id++){
        offsets[id]=cursor;
        add(Buffer.from(`${id} 0 obj\n`));
        const value=objs.get(id);
        add(Buffer.isBuffer(value)?value:Buffer.from(value,'latin1'));
        add(Buffer.from('\nendobj\n'));
    }
    const xref=cursor;
    add(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`));
    for(let id=1;id<offsets.length;id++)add(Buffer.from(`${String(offsets[id]).padStart(10,'0')} 00000 n \n`));
    add(Buffer.from(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    return Buffer.concat(result);
}

function buildReportPdf(report) {
    const {meta,summary:s,charts,tables:t}=report;
    const pdf=new Painter(meta);
    const typeLabel={full:'COMPLETE GYM REPORT',financial:'FINANCIAL REPORT',members:'MEMBERSHIP REPORT',attendance:'ATTENDANCE REPORT'}[meta.type];
    pdf.text(typeLabel,LEFT,pdf.y,18,NAVY,true);pdf.y-=26;
    pdf.text(`Period: ${date(meta.start)} to ${date(meta.end)}  |  Membership status as of ${date(meta.asOf)}`,LEFT,pdf.y,9,SLATE);pdf.y-=23;
    if (meta.type==='full') {
        pdf.kpis([['Total members',fmt(s.totalMembers)],['Active members',fmt(s.activeMembers)],['Paid revenue',money(s.totalRevenue)],['Pending payments',fmt(s.pendingPayments)]]);
        pdf.note(`New registrations: ${s.newMembers}   |   Attendance records: ${s.totalAttendance}   |   Trainers: ${s.trainers}`);
    } else if (meta.type==='financial') {
        pdf.kpis([['Paid revenue',money(s.totalRevenue)],['Paid payments',fmt(s.paidPayments)],['Pending amount',money(s.pendingAmount)],['Pending payments',fmt(s.pendingPayments)]]);
    } else if (meta.type==='members') {
        pdf.kpis([['Total members',fmt(s.totalMembers)],['Active memberships',fmt(s.activeMembers)],['Expired memberships',fmt(s.expiredMembers)],['New registrations',fmt(s.newMembers)]]);
    } else if(meta.type==='attendance') {
        pdf.kpis([['Attendance records',fmt(s.totalAttendance)],['Unique member-day visits',fmt(s.uniqueAttendance)],['Average per calendar day',fmt(s.averageDailyAttendance)],['Days with attendance',fmt(s.daysWithAttendance)]]);
    }
    if(['full','financial'].includes(meta.type)) pdf.chart(charts.revenue,`${meta.revenueBucket} revenue (paid payments only)`);
    if(['full','members'].includes(meta.type)) {
        pdf.pie(charts.membership);
        pdf.table('Membership plans',[
            {title:'Plan',key:'plan_name',width:205},{title:'Duration',render:r=>`${r.duration_months} months`,width:100},
            {title:'Fee',render:r=>money(r.fee),width:115},{title:'Active',render:r=>fmt(r.active_members),width:91}
        ],t.plans,{subtitle:'Current plan catalog; active member counts at period end'});
        pdf.table('Registered members',[
            {title:'Member',key:'full_name',width:188},{title:'Username',key:'username',width:111},
            {title:'Join date',render:r=>date(r.join_date),width:100},{title:'Status',key:'status',width:112}
        ],t.members,{subtitle:'Members registered by period end; statuses at period end'});
    }
    if(['full','financial'].includes(meta.type)) {
        pdf.table('Payment history',[
            {title:'Date',render:r=>date(r.payment_date),width:93},
            {title:'Member',render:r=>r.member_name||`Member #${r.member_id}`,width:185},
            {title:'Amount',render:r=>money(r.amount),width:127},
            {title:'Status',key:'status',width:106}
        ],t.payments,{subtitle:'Only payments dated inside the selected period'});
    }
    if(['full','attendance'].includes(meta.type)) {
        pdf.table('Attendance records',[
            {title:'Date',render:r=>date(r.attendance_date),width:111},
            {title:'Member',render:r=>r.member_name||`Member #${r.member_id}`,width:226},
            {title:'Time in',key:'time_in',width:174}
        ],t.attendance,{subtitle:`${s.totalAttendance} check-ins; average ${s.averageDailyAttendance} per calendar day`});
        pdf.table('Most active members',[
            {title:'Member',key:'name',width:361},{title:'Check-ins',key:'visits',width:150}
        ],t.mostActiveMembers,{subtitle:'Top five by check-ins in the selected period'});
    }
    if(meta.type==='full') {
        pdf.table('Trainers',[
            {title:'Name',key:'full_name',width:132},{title:'Mobile',key:'mobile',width:100},
            {title:'Specialization',key:'specialization',width:120},{title:'Shift timing',key:'shift_timing',width:159}
        ],t.trainers,{subtitle:'Current trainer list; not historical'});
        pdf.table('Equipment',[
            {title:'Item',key:'name',width:257},{title:'Units',key:'units',width:81},{title:'Unit price',render:r=>money(r.price),width:173}
        ],t.equipment,{subtitle:'Current inventory; equipment maintenance status is not stored'});
        pdf.table('Workout / diet plans',[
            {title:'Member',key:'member_name',width:121},{title:'Plan title',key:'plan_title',width:169},
            {title:'Start',render:r=>date(r.start_date),width:110},{title:'End',render:r=>date(r.end_date),width:111}
        ],t.workouts,{subtitle:'Plans overlapping the selected report period'});
        pdf.table('Member feedback',[
            {title:'Date',render:r=>date(r.created_date),width:94},
            {title:'Member',key:'member_name',width:121},
            {title:'Message excerpt',key:'message',width:296}
        ],t.feedbacks,{subtitle:'Feedback submitted in the selected period; messages abbreviated to fit'});
        pdf.note('Income is based on Paid payment records; Pending amounts are excluded from revenue.');
        pdf.note('Trainer, plan catalog and equipment figures show current database records.');
    }
    return pdf.finish();
}
module.exports = { buildReportPdf };
