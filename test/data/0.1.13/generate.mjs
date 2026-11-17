// One-off generator for plain.duckdb and enc.duckdb in this folder. Not run by the tests.
//
// The files are the artifact under test: what the real keyv-duckdb 0.1.13 wrote with keyv 5.
// They cannot be regenerated from current code. Run it in a scratch folder that has the old packages installed:
//
//   mkdir scratch && cd scratch && npm init -y && npm install keyv-duckdb@0.1.13 keyv@5
//   cp <repo>/test/data/0.1.13/generate.mjs . && node generate.mjs <repo>/test/data/0.1.13
//
// All values are dummies. The encryption key is the one the tests use.
import fs from 'node:fs';
import path from 'node:path';
import Keyv from 'keyv';
import { KeyvDuckDB } from 'keyv-duckdb';

const outDir = path.resolve(process.argv[2] ?? '.');
const ENCRYPTION_KEY = 'dummy-fixture-key-0.1.13-32chars!';
const CENTURY = 100 * 365 * 24 * 3600 * 1000;

async function write(file, options) {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.wal`, { force: true });
  // One store shared by two Keyv instances: keyv 5 prefixes keys in core, and 0.1.13 loses writes when two stores share a file.
  const store = new KeyvDuckDB(file, options);
  const defaults = new Keyv({ store }); // keyv 5 default namespace 'keyv': keys are stored as keyv:<key>
  const named = new Keyv({ store, namespace: 'app' });
  await defaults.set('user@example.com:google:token', { access_token: 'dummy-at', refresh_token: 'dummy-rt' });
  await defaults.set('dcr:client:abc', { client_id: 'abc' });
  await defaults.set('num', 42);
  await defaults.set('ttl', 'expiring', CENTURY);
  await defaults.set('expired', 'gone', 1);
  await named.set('k1', 'nsval');
  await store.dispose();
}

await write(path.join(outDir, 'plain.duckdb'), {});
await write(path.join(outDir, 'enc.duckdb'), { encryptionKey: ENCRYPTION_KEY });
