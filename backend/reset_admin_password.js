'use strict';
// Optional local-only admin credential reset. Does not erase any gym records.
const crypto=require('node:crypto');
const fs=require('node:fs');
const {run,hashPassword,CREDENTIALS_FILE}=require('./local_db');
const newPass=crypto.randomBytes(12).toString('base64url');
run('UPDATE admin_accounts SET password_hash=? WHERE username=?',[hashPassword(newPass),'admin']);
let contents=fs.existsSync(CREDENTIALS_FILE)?fs.readFileSync(CREDENTIALS_FILE,'utf8'):'MY.GYM LOCAL CREDENTIALS\r\nAdmin username: admin\r\n';
if(contents.includes('Admin password:'))contents=contents.replace(/^Admin password:.*$/m,'Admin password: '+newPass);
else contents += '\r\nAdmin password: '+newPass+'\r\n';
fs.writeFileSync(CREDENTIALS_FILE,contents,{mode:0o600});
console.log('Admin password reset. See: '+CREDENTIALS_FILE);
