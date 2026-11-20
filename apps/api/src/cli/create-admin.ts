/**
 * Creates (or resets) a Dosly admin. Run on the server, never with the password on the command line:
 *   docker compose run --rm api node apps/api/dist/cli/create-admin.js you@example.com "Your Name"
 * It asks for the password, then prints a one-time setup key for an authenticator app.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createDb } from '@dosly/db';
import { encrypt, hashPassword, loadKey, newTotpSecret, totpUri } from '@dosly/shared';

const [email, name] = process.argv.slice(2);
if (!email || !name) { console.error('Usage: create-admin <email> "<name>"'); process.exit(1); }

let muted = false;
const out = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
const rl = createInterface({ input: process.stdin, output: out, terminal: true });
const ask = (q: string) => new Promise<string>(res => { process.stdout.write(q); muted = true; rl.question('', a => { muted = false; process.stdout.write('\n'); res(a); }); });

const password = await ask('Password (12+ characters): ');
const again = await ask('Again: ');
rl.close();
if (password.length < 12 || password !== again) { console.error('Passwords must match and be at least 12 characters.'); process.exit(1); }

const db = createDb();
const secret = newTotpSecret();
const data = { name, passwordHash: await hashPassword(password), totpSecretEnc: encrypt(secret, loadKey(process.env.ENCRYPTION_KEY ?? '')) };
await db.adminUser.upsert({ where: { email: email.toLowerCase() }, create: { email: email.toLowerCase(), ...data }, update: data });
await db.adminSession.deleteMany({ where: { admin: { email: email.toLowerCase() } } });
console.log(`\nAdmin ready: ${email}\nAdd this to your authenticator app (shown once):\n  Key: ${secret}\n  Or open: ${totpUri(secret, email)}\n`);
await db.$disconnect();
