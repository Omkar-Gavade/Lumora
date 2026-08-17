#!/usr/bin/env node
/**
 * Rewrites only the password inside DATABASE_URL.
 *
 * Exists because assembling a Postgres URI by hand is the step that keeps
 * going wrong: the password has to be percent-encoded, it sits between a `:`
 * and an `@` in a 141-character string, and Supabase's connection-string panel
 * shows `[YOUR-PASSWORD]` rather than the real value — so anyone copying from
 * there is substituting a remembered password into a template.
 *
 * Usage: put the password ALONE in a file, then
 *   node backend/scripts/set-db-password.mjs /tmp/pw.txt
 *
 * A file rather than an argument: an argument lands in shell history.
 * Everything else in DATABASE_URL is preserved. The password is never printed.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const source = process.argv[2];
if (!source) {
  console.error('usage: node backend/scripts/set-db-password.mjs <file-containing-only-the-password>');
  process.exit(1);
}

const password = readFileSync(source, 'utf8').replace(/\r?\n$/, '');
if (!password) {
  console.error('That file is empty.');
  process.exit(1);
}
if (/^\[.*\]$/.test(password) || password.includes('YOUR-PASSWORD')) {
  console.error('That is the placeholder from the connection-string panel, not a password.');
  console.error('The real value appears only in the reset dialog, once.');
  process.exit(1);
}

const path = 'backend/.env';
const env = readFileSync(path, 'utf8');
const line = env.match(/^DATABASE_URL=(.*)$/m);
if (!line) {
  console.error('No DATABASE_URL in backend/.env');
  process.exit(1);
}

const url = line[1].trim().replace(/^["']|["']$/g, '');
const [scheme, after] = url.split('://');
const [authority, ...rest] = after.split('/');
const at = authority.lastIndexOf('@');
const userinfo = authority.slice(0, at);
const host = authority.slice(at + 1);
const user = userinfo.split(':')[0];

const encoded = encodeURIComponent(password);
const rebuilt = `${scheme}://${user}:${encoded}@${host}${rest.length ? '/' + rest.join('/') : ''}`;

writeFileSync(path, env.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${rebuilt}`));

console.log('DATABASE_URL updated.');
console.log('  user:            ', user);
console.log('  host:            ', host);
console.log('  password length: ', password.length);
console.log('  characters escaped:', encoded.length - password.length);

try {
  unlinkSync(source);
  console.log(`  deleted ${source}`);
} catch {
  console.log(`  NOTE: delete ${source} yourself — it contains the password.`);
}
