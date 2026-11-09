import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [operation, scope, input, output] = process.argv.slice(2);
const key = process.env.GALGOS_CHECKPOINT_KEY || '';
if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Invalid checkpoint key');
if (!/^(shared|\d{4}-\d{2}-\d{2})$/.test(scope || '')) throw new Error('Invalid checkpoint scope');

const aad = Buffer.from(`expert-galgos-checkpoint-v1:${scope}`);
const data = readFileSync(input);
const keyBytes = Buffer.from(key, 'hex');

if (operation === 'seal') {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  writeFileSync(output, Buffer.concat([nonce, cipher.getAuthTag(), encrypted]));
} else if (operation === 'open' && data.length >= 28) {
  const decipher = createDecipheriv('aes-256-gcm', keyBytes, data.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(data.subarray(12, 28));
  const plaintext = Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  writeFileSync(output, plaintext, { mode: 0o600 });
} else {
  throw new Error('Invalid checkpoint operation');
}
