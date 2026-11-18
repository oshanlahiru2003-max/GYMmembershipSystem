'use strict';
// Embedded SQLite database — no MySQL, XAMPP, native npm modules or network required.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const DATA_DIR = process.env.GYM_DATA_DIR ? path.resolve(process.env.GYM_DATA_DIR) : path.join(__dirname, 'local_data');
const DB_FILE = path.join(DATA_DIR, 'mygym.sqlite');
const CREDENTIALS_FILE = path.join(DATA_DIR, 'DEMO_LOGIN_DETAILS.txt');
const SECRET_FILE = path.join(DATA_DIR, '.auth_secret');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS admin_accounts (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
 id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL,
 username TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL,
 mobile TEXT, age INTEGER, gender TEXT, address TEXT,
 join_date TEXT NOT NULL DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS plans (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 plan_name TEXT NOT NULL, duration_months INTEGER NOT NULL DEFAULT 1, fee REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trainers (
 id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL, mobile TEXT,
 gender TEXT, age INTEGER, specialization TEXT, shift_timing TEXT, salary REAL
);
CREATE TABLE IF NOT EXISTS member_plans (
 id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
 plan_id INTEGER NOT NULL, trainer_id INTEGER, start_date TEXT NOT NULL,
 end_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Active',
 FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE,
 FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE CASCADE,
 FOREIGN KEY(trainer_id) REFERENCES trainers(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
 amount REAL NOT NULL, payment_date TEXT NOT NULL, status TEXT NOT NULL,
 FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS attendance (
 id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
 attendance_date TEXT NOT NULL, time_in TEXT NOT NULL,
 FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS equipment (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
 units INTEGER NOT NULL DEFAULT 1, price REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workout_plans (
 id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
 plan_title TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
 details TEXT, FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS feedbacks (
 id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL,
 message TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE
);
`);

function all(sql, args = []) { return db.prepare(sql).all(...args); }
function get(sql, args = []) { return db.prepare(sql).get(...args); }
function run(sql, args = []) { return db.prepare(sql).run(...args); }
function today(offset = 0) { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); }
function monthsAfter(day, count) { const d = new Date(day + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Number(count)); return d.toISOString().slice(0,10); }
function hashPassword(password) {
 const salt = crypto.randomBytes(16).toString('hex');
 const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
 return `scrypt:${salt}:${hash}`;
}
function verifyPassword(password, saved) {
 if (typeof saved !== 'string' || !saved.startsWith('scrypt:')) return false;
 const parts = saved.split(':');
 if (parts.length !== 3) return false;
 try {
  const actual = crypto.scryptSync(String(password), parts[1], 64);
  const expected = Buffer.from(parts[2], 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
 } catch (_) { return false; }
}
function newPassword() { return crypto.randomBytes(12).toString('base64url'); }
const authSecret = fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, 'utf8').trim() : crypto.randomBytes(48).toString('hex');
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, authSecret, { mode: 0o600 });

const adminExists = !!get('SELECT id FROM admin_accounts LIMIT 1');
if (!adminExists) {
 const adminPass = newPassword();
 const memberPass = newPassword();
 const initialDate = today();
 db.exec('BEGIN');
 try {
  run('INSERT INTO admin_accounts (id,username,password_hash) VALUES (1,?,?)',['admin',hashPassword(adminPass)]);
  const plan1 = run('INSERT INTO plans (plan_name,duration_months,fee) VALUES (?,?,?)',['Monthly Basic',1,2500]).lastInsertRowid;
  const plan2 = run('INSERT INTO plans (plan_name,duration_months,fee) VALUES (?,?,?)',['Quarterly Fitness',3,6800]).lastInsertRowid;
  const plan3 = run('INSERT INTO plans (plan_name,duration_months,fee) VALUES (?,?,?)',['Annual Premium',12,24000]).lastInsertRowid;
  const trainer1 = run('INSERT INTO trainers (full_name,mobile,specialization,shift_timing) VALUES (?,?,?,?)',['Demo Trainer A','0770000001','Cardio','6:00 AM - 10:00 AM']).lastInsertRowid;
  const trainer2 = run('INSERT INTO trainers (full_name,mobile,specialization,shift_timing) VALUES (?,?,?,?)',['Demo Trainer B','0770000002','Strength Training','4:00 PM - 8:00 PM']).lastInsertRowid;
  const demoNames = [['Demo Member A','member01',plan1,trainer1,2500],['Demo Member B','member02',plan2,trainer2,6800],['Demo Member C','member03',plan3,trainer1,24000]];
  for (const [name, username, plan, trainer, fee] of demoNames) {
   const id = Number(run('INSERT INTO members (full_name,username,password,mobile,age,gender,address,join_date) VALUES (?,?,?,?,?,?,?,?)',[name,username,hashPassword(memberPass),'0770000000',23,'Other','Demo data only',initialDate]).lastInsertRowid);
   const dur = Number(get('SELECT duration_months FROM plans WHERE id=?',[plan]).duration_months);
   run('INSERT INTO member_plans(member_id,plan_id,trainer_id,start_date,end_date,status) VALUES (?,?,?,?,?,?)',[id,plan,trainer,initialDate,monthsAfter(initialDate,dur),'Active']);
   run('INSERT INTO payments(member_id,amount,payment_date,status) VALUES (?,?,?,?)',[id,fee,initialDate,'Paid']);
   run('INSERT INTO attendance(member_id,attendance_date,time_in) VALUES (?,?,?)',[id,initialDate,'07:30:00']);
   run('INSERT INTO workout_plans(member_id,plan_title,start_date,end_date,details) VALUES (?,?,?,?,?)',[id,'Demo Fitness Routine',initialDate,monthsAfter(initialDate,1),'Cardio and strength training demo plan']);
  }
  run('INSERT INTO equipment(name,units,price) VALUES (?,?,?)',['Treadmill',3,450000]);
  run('INSERT INTO equipment(name,units,price) VALUES (?,?,?)',['Exercise Bike',2,125000]);
  run('INSERT INTO equipment(name,units,price) VALUES (?,?,?)',['Dumbbell Set',10,15000]);
  run('INSERT INTO feedbacks(member_id,message) VALUES (?,?)',[1,'Demo feedback: Friendly staff and good facilities.']);
  db.exec('COMMIT');
  fs.writeFileSync(CREDENTIALS_FILE, [
   'MY.GYM LOCAL UNIVERSITY PROJECT — DEMONSTRATION LOGIN',
   'This is a LOCAL, automatically created sample database (not your old MySQL data).',
   'URL: http://localhost:5000/landing.html',
   'Admin username: admin', `Admin password: ${adminPass}`,
   'Demo member username: member01', `Demo member password: ${memberPass}`,
   '', 'Keep these credentials private. For classroom demo use on your own computer only.',
   'Change admin password after setup by running CHANGE_ADMIN_PASSWORD.bat.',
   'Sample data is clearly marked DEMO; replace before real use.',
  ].join('\r\n') + '\r\n', {mode: 0o600});
 } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// mysql2-compatible read adapter for the existing report generator; adapt SQL date functions.
function compatibleSql(sql) {
 return sql.replace(/DATE_FORMAT\(([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?),\s*'%Y-%m-%d'\)/gi, 'date($1)')
  .replace(/DATE_ADD\(\?,\s*INTERVAL\s+1\s+DAY\)/gi,"date(?, '+1 day')");
}
const reportAdapter = {promise() {return {query:async (sql, args=[]) => [all(compatibleSql(sql), args)]};}};
module.exports = {db,all,get,run,today,monthsAfter,hashPassword,verifyPassword,authSecret,reportAdapter,DB_FILE,CREDENTIALS_FILE};
