import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import Keyv from 'keyv';
import { closeAllConnections, KeyvDuckDB } from 'keyv-duckdb';

const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : url.fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..', '..');
const fixtures = path.join(packageRoot, 'test', 'data', '0.1.13');
const ENCRYPTION_KEY = 'dummy-fixture-key-0.1.13-32chars!';

type Row = { key: string; value: string; namespace: string; expires: bigint | null };

/** Run SQL against a database file with plain DuckDB, outside the adapter; `t` is the table prefix. */
async function withRawDb<T>(file: string, encrypted: boolean, work: (run: (sql: string) => Promise<Record<string, unknown>[]>, t: string) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(encrypted ? ':memory:' : file);
  const conn = await instance.connect();
  try {
    if (encrypted) await conn.run(`ATTACH '${file}' AS store (ENCRYPTION_KEY '${ENCRYPTION_KEY}')`);
    return await work(async (sql) => (await conn.runAndReadAll(sql)).getRowObjects() as Record<string, unknown>[], encrypted ? 'store.' : '');
  } finally {
    if (encrypted) await conn.run('DETACH store').catch(() => undefined);
    conn.closeSync();
    instance.closeSync();
  }
}

describe('0.1.13 files', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const tmpParent = path.join(packageRoot, '.tmp');
    await fs.mkdir(tmpParent, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(tmpParent, 'legacy-test-'));
  });

  afterEach(async () => {
    await closeAllConnections();
    safeRmSync(tmpDir);
  });

  for (const encrypted of [false, true]) {
    const name = encrypted ? 'enc.duckdb' : 'plain.duckdb';
    const options = encrypted ? { encryptionKey: ENCRYPTION_KEY } : {};

    describe(encrypted ? 'encrypted file' : 'plain file', () => {
      let file: string;

      beforeEach(async () => {
        file = path.join(tmpDir, name);
        await fs.copyFile(path.join(fixtures, name), file);
      });

      const rows = (): Promise<Row[]> => withRawDb(file, encrypted, async (run, t) => (await run(`SELECT key, value, namespace, expires FROM ${t}keyv ORDER BY namespace, key`)) as Row[]);
      const tables = (): Promise<string[]> => withRawDb(file, encrypted, async (run) => (await run(`SELECT table_name FROM duckdb_tables() WHERE database_name = ${encrypted ? "'store'" : 'current_database()'} ORDER BY table_name`)).map((r) => r.table_name as string));
      const keysOf = async (namespace?: string): Promise<string[]> => {
        const store = new KeyvDuckDB(file, { ...options, namespace });
        const keys: string[] = [];
        for await (const [key] of store.iterator()) keys.push(key);
        await store.dispose();
        return keys;
      };

      it('starts as the 0.1.13 layout', async () => {
        const columns = await withRawDb(file, encrypted, async (run) => (await run(`SELECT column_name FROM duckdb_columns() WHERE table_name = 'keyv' AND database_name = ${encrypted ? "'store'" : 'current_database()'}`)).map((r) => r.column_name));
        assert.deepStrictEqual(columns, ['k', 'v']);
      });

      it('converts to the namespace layout on first open', async () => {
        assert.deepStrictEqual(await keysOf('keyv'), ['dcr:client:abc', 'num', 'ttl', 'user@example.com:google:token']);

        const converted = await rows();
        assert.deepStrictEqual(
          converted.map((r) => [r.namespace, r.key]),
          [
            ['app', 'k1'],
            ['keyv', 'dcr:client:abc'],
            ['keyv', 'expired'],
            ['keyv', 'num'],
            ['keyv', 'ttl'],
            ['keyv', 'user@example.com:google:token'],
          ]
        );
        assert.strictEqual(converted.find((r) => r.key === 'num')?.value, '{"value":42}');
        assert.deepStrictEqual(
          converted.filter((r) => r.namespace === 'keyv').map((r) => [r.key, r.expires === null ? null : r.expires > BigInt(Date.now()) ? 'future' : 'past']),
          [
            ['dcr:client:abc', null],
            ['expired', 'past'],
            ['num', null],
            ['ttl', 'future'],
            ['user@example.com:google:token', null],
          ]
        );
        assert.deepStrictEqual(await tables(), ['keyv']);
      });

      it('scopes each namespace and leaves the empty namespace empty', async () => {
        assert.deepStrictEqual(await keysOf('app'), ['k1']);
        assert.deepStrictEqual(await keysOf(), []);
      });

      it('reads old values through Keyv, with expiry taken from the stored value', async () => {
        const keyv = new Keyv({ store: new KeyvDuckDB(file, options), namespace: 'keyv' });
        assert.deepStrictEqual(await keyv.get('user@example.com:google:token'), { access_token: 'dummy-at', refresh_token: 'dummy-rt' });
        assert.deepStrictEqual(await keyv.get('dcr:client:abc'), { client_id: 'abc' });
        assert.strictEqual(await keyv.get('num'), 42);
        assert.strictEqual(await keyv.get('ttl'), 'expiring'); // expires in 2126
        assert.strictEqual(await keyv.get('expired'), undefined); // expired in 2026, inside the value
        const app = new Keyv({ store: new KeyvDuckDB(file, options), namespace: 'app' });
        assert.strictEqual(await app.get('k1'), 'nsval');
      });

      it('writes expires into its column for new entries', async () => {
        const store = new KeyvDuckDB(file, options);
        const keyv = new Keyv({ store, namespace: 'keyv' });
        const before = Date.now();
        await keyv.set('fresh', 'x', 60_000);
        await store.dispose();
        const fresh = (await rows()).find((r) => r.key === 'fresh');
        assert.ok(fresh && fresh.expires !== null && Number(fresh.expires) >= before + 60_000);
      });

      it('does nothing the second time it is opened', async () => {
        await keysOf('keyv');
        const first = await rows();
        await keysOf('keyv');
        await keysOf('app');
        assert.deepStrictEqual(await rows(), first);
        assert.deepStrictEqual(await tables(), ['keyv']);
      });

      it('recovers a leftover _migration_old table from an interrupted conversion', async () => {
        // State after a crash between the rename and the copy: old table renamed, new table partly filled
        await withRawDb(file, encrypted, async (run, t) => {
          await run(`ALTER TABLE ${t}keyv RENAME TO keyv_migration_old`);
          await run(`CREATE TABLE ${t}keyv (key TEXT NOT NULL, value TEXT, namespace TEXT NOT NULL DEFAULT '', expires BIGINT DEFAULT NULL, UNIQUE (key, namespace))`);
          await run(`INSERT INTO ${t}keyv (key, value, namespace) VALUES ('num', 'newer', 'keyv')`);
        });

        assert.deepStrictEqual(await keysOf('keyv'), ['dcr:client:abc', 'num', 'ttl', 'user@example.com:google:token']);

        const recovered = await rows();
        assert.strictEqual(recovered.length, 6);
        assert.strictEqual(recovered.find((r) => r.key === 'num')?.value, 'newer'); // existing rows win, as INSERT OR IGNORE does
        assert.strictEqual(recovered.find((r) => r.key === 'k1')?.namespace, 'app');
        assert.deepStrictEqual(await tables(), ['keyv']);
      });

      it('recovers when the new table was never created', async () => {
        await withRawDb(file, encrypted, async (run, t) => {
          await run(`ALTER TABLE ${t}keyv RENAME TO keyv_migration_old`);
        });
        assert.deepStrictEqual(await keysOf('app'), ['k1']);
        assert.deepStrictEqual(await tables(), ['keyv']);
      });
    });
  }

  it('leaves a _migration_old table alone when it is not a 0.1.x table', async () => {
    const file = path.join(tmpDir, 'foreign.duckdb');
    await withRawDb(file, false, async (run) => {
      await run('CREATE TABLE keyv_migration_old (id INTEGER, note TEXT)');
      await run("INSERT INTO keyv_migration_old VALUES (1, 'not ours')");
    });
    const store = new KeyvDuckDB(file);
    await store.set('k', 'v');
    await store.dispose();
    await withRawDb(file, false, async (run) => {
      assert.deepStrictEqual(await run('SELECT id, note FROM keyv_migration_old'), [{ id: 1, note: 'not ours' }]);
      assert.strictEqual((await run('SELECT key FROM keyv')).length, 1);
    });
  });

  it('converts when several stores open the same old file at once', async () => {
    const file = path.join(tmpDir, 'concurrent.duckdb');
    await fs.copyFile(path.join(fixtures, 'plain.duckdb'), file);
    const stores = [new KeyvDuckDB(file, { namespace: 'keyv' }), new KeyvDuckDB(file, { namespace: 'app' }), new KeyvDuckDB(file)];
    const counts = await Promise.all(
      stores.map(async (store) => {
        let n = 0;
        for await (const _ of store.iterator()) n++;
        return n;
      })
    );
    assert.deepStrictEqual(counts, [4, 1, 0]);
  });
});
