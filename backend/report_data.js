'use strict';

// Read-only report aggregation. All date filters use inclusive calendar dates.
function toIsoDate(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const date = String(value);
    return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null;
}
function validateReportOptions(params) {
    const type = params.type || 'full';
    const validTypes = ['full', 'financial', 'members', 'attendance'];
    if (!validTypes.includes(type)) throw new Error('Invalid report type.');
    const start = String(params.start || '');
    const end = String(params.end || '');
    const exactDate = (str) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
        const date = new Date(`${str}T00:00:00.000Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === str;
    };
    if (!exactDate(start) || !exactDate(end)) throw new Error('Choose valid start and end dates.');
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
    if (days < 0) throw new Error('Start date must be before or equal to end date.');
    if (days > 366 * 2) throw new Error('Select a period of up to two years.');
    return { type, start, end };
}

async function readReportData(db, options) {
    const { type, start, end } = validateReportOptions(options);
    const query = async (sql, values = []) => {
        const [rows] = await db.promise().query(sql, values);
        return rows;
    };
    // As-of snapshot: membership status at period end, not an unfiltered historical total.
    const [members, memberPlans, payments, attendance, plans, trainers, equipment, workouts, feedbacks] = await Promise.all([
        query(`SELECT id, full_name, username, DATE_FORMAT(join_date, '%Y-%m-%d') AS join_date
               FROM members WHERE join_date <= ? OR join_date IS NULL ORDER BY id DESC`, [end]),
        query(`SELECT mp.member_id, mp.plan_id, mp.status,
                      DATE_FORMAT(mp.start_date, '%Y-%m-%d') AS start_date,
                      DATE_FORMAT(mp.end_date, '%Y-%m-%d') AS end_date
               FROM member_plans mp WHERE mp.start_date <= ? ORDER BY mp.id DESC`, [end]),
        query(`SELECT p.id, p.member_id, m.full_name AS member_name,
                      p.amount, p.status, DATE_FORMAT(p.payment_date, '%Y-%m-%d') AS payment_date
               FROM payments p LEFT JOIN members m ON p.member_id=m.id
               WHERE p.payment_date >= ? AND p.payment_date < DATE_ADD(?, INTERVAL 1 DAY)
               ORDER BY p.payment_date DESC, p.id DESC`, [start, end]),
        query(`SELECT a.id, a.member_id, m.full_name AS member_name,
                      DATE_FORMAT(a.attendance_date, '%Y-%m-%d') AS attendance_date,
                      a.time_in
               FROM attendance a LEFT JOIN members m ON a.member_id=m.id
               WHERE a.attendance_date >= ? AND a.attendance_date < DATE_ADD(?, INTERVAL 1 DAY)
               ORDER BY a.attendance_date DESC, a.id DESC`, [start, end]),
        query('SELECT id, plan_name, fee, duration_months FROM plans ORDER BY id DESC'),
        query('SELECT id, full_name, mobile, specialization, shift_timing FROM trainers ORDER BY id DESC'),
        query('SELECT id, name, units, price FROM equipment ORDER BY id DESC'),
        query(`SELECT w.id, m.full_name AS member_name, w.plan_title,
                      DATE_FORMAT(w.start_date, '%Y-%m-%d') AS start_date,
                      DATE_FORMAT(w.end_date, '%Y-%m-%d') AS end_date
               FROM workout_plans w LEFT JOIN members m ON w.member_id=m.id
               WHERE w.start_date <= ? AND w.end_date >= ? ORDER BY w.start_date DESC, w.id DESC`, [end, start]),
        query(`SELECT f.id, m.full_name AS member_name, f.message,
                      DATE_FORMAT(f.created_at, '%Y-%m-%d') AS created_date
               FROM feedbacks f LEFT JOIN members m ON f.member_id=m.id
               WHERE f.created_at >= ? AND f.created_at < DATE_ADD(?, INTERVAL 1 DAY)
               ORDER BY f.created_at DESC, f.id DESC`, [start, end])
    ]);

    const planIdsByMember = new Map();
    for (const plan of memberPlans) {
        if (!planIdsByMember.has(Number(plan.member_id))) planIdsByMember.set(Number(plan.member_id), []);
        planIdsByMember.get(Number(plan.member_id)).push(plan);
    }
    const memberRows = members.map(member => {
        const assigned = planIdsByMember.get(Number(member.id)) || [];
        const active = assigned.find(p => p.start_date <= end && p.end_date >= end && String(p.status).toLowerCase() === 'active');
        const past = assigned.some(p => p.end_date < end);
        const status = active ? 'Active' : past && !assigned.some(p => p.end_date >= end) ? 'Expired' : 'Other / No Plan';
        const selected = active || assigned[0] || null;
        return { ...member, status, plan_id: selected ? Number(selected.plan_id) : null };
    });
    const active = memberRows.filter(m => m.status === 'Active').length;
    const expired = memberRows.filter(m => m.status === 'Expired').length;
    const other = memberRows.length - active - expired;
    const newMembers = memberRows.filter(m => m.join_date && m.join_date >= start && m.join_date <= end).length;
    const paid = payments.filter(p => String(p.status).toLowerCase() === 'paid');
    const pending = payments.filter(p => String(p.status).toLowerCase() === 'pending');
    const amount = list => Math.round(list.reduce((sum, p) => sum + (Number(p.amount) || 0), 0) * 100) / 100;
    const totalRevenue = amount(paid);
    const pendingAmount = amount(pending);
    const uniqueAttendance = new Set(attendance.map(a => String(a.attendance_date) + '/' + String(a.member_id))).size;
    const dayCount = Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
    const daysWithAttendance = new Set(attendance.map(a => String(a.attendance_date))).size;
    const frequency = new Map();
    for (const a of attendance) {
        const key = String(a.member_name || `Member #${a.member_id}`);
        frequency.set(key, (frequency.get(key) || 0) + 1);
    }
    const mostActiveMembers = [...frequency].sort((a,b) => b[1] - a[1]).slice(0, 5).map(([name, visits]) => ({name, visits}));
    const planCounts = new Map();
    for (const m of memberRows.filter(row => row.status === 'Active' && row.plan_id !== null)) {
        planCounts.set(m.plan_id, (planCounts.get(m.plan_id) || 0) + 1);
    }
    const planPopularity = plans.map(p => ({ ...p, active_members: planCounts.get(Number(p.id)) || 0 })).sort((a,b)=>b.active_members-a.active_members);

    // Per-day bars for short reports, per-month for longer reports; zero-periods are included.
    const daily = dayCount <= 45;
    const timeline = [];
    if (daily) {
        for (let d = Date.parse(start); d <= Date.parse(end); d += 86400000) timeline.push({key:new Date(d).toISOString().slice(0,10),label:new Date(d).toISOString().slice(5,10),revenue:0});
    } else {
        let year = Number(start.slice(0, 4)), month = Number(start.slice(5, 7));
        const endYear = Number(end.slice(0, 4)), endMonth = Number(end.slice(5, 7));
        while (year < endYear || (year === endYear && month <= endMonth)) {
            const key = String(year) + '-' + String(month).padStart(2, '0');
            timeline.push({key,label:key,revenue:0});
            month++; if (month > 12) { year++; month=1; }
        }
    }
    const revenueMap = new Map(timeline.map(p => [p.key, p]));
    for (const p of paid) {
        const date = toIsoDate(p.payment_date);
        const key = daily ? date : (date ? date.slice(0, 7) : null);
        if (revenueMap.has(key)) revenueMap.get(key).revenue += Number(p.amount) || 0;
    }
    for (const pt of timeline) pt.revenue = Math.round(pt.revenue * 100) / 100;
    const generatedAt = new Date().toISOString();

    return {
        meta: { type, start, end, generatedAt, asOf: end, revenueBucket: daily ? 'Daily' : 'Monthly' },
        summary: {
            totalMembers: memberRows.length, activeMembers: active, expiredMembers: expired, otherMembers: other,
            newMembers, totalRevenue, paidPayments:paid.length, pendingPayments:pending.length,
            pendingAmount, totalAttendance:attendance.length, uniqueAttendance,
            averageDailyAttendance: Math.round(attendance.length / dayCount * 10) / 10,
            daysWithAttendance, trainers:trainers.length, plans:plans.length,
            equipment:equipment.length, workoutPlans:workouts.length, feedbacks:feedbacks.length
        },
        charts: { revenue:timeline, membership:[
            { label:'Active', value:active }, { label:'Expired',value:expired }, { label:'Other / No Plan', value:other }
        ]},
        tables: { members:memberRows, payments, attendance, trainers, plans:planPopularity, equipment, workouts, feedbacks, mostActiveMembers }
    };
}

module.exports = { validateReportOptions, readReportData };
