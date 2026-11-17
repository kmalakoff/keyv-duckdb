import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { closeAllConnections, KeyvDuckDB } from 'keyv-duckdb';

const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : url.fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..', '..');

describe('connection manager', () => {
  let tmpDir: string;

  beforeEach(async () => {
    const tmpParent = path.join(packageRoot, '.tmp');
    await fs.mkdir(tmpParent, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(tmpParent, 'duckdb-conn-test-'));
  });

  afterEach(async () => {
    await closeAllConnections();
    safeRmSync(tmpDir);
  });

  for (const encrypted of [false, true]) {
    const options = encrypted ? { encryptionKey: 'a_32_character_long_test_key_here' } : {};
    describe(encrypted ? 'encrypted file' : 'plain file', () => {
      for (const order of ['first store closed first', 'second store closed first']) {
        it(`keeps the writes of two stores on one file (${order})`, async () => {
          const file = path.join(tmpDir, 'two.duckdb');
          const one = new KeyvDuckDB(file, { ...options, namespace: 'one' });
          const two = new KeyvDuckDB(file, { ...options, namespace: 'two' });
          await one.set('a', '1');
          await two.set('b', '2');
          // Without one shared instance, the store closed last checkpoints a view that lacks the other's write
          for (const store of order.startsWith('first') ? [one, two] : [two, one]) await store.dispose();

          const check1 = new KeyvDuckDB(file, { ...options, namespace: 'one' });
          const check2 = new KeyvDuckDB(file, { ...options, namespace: 'two' });
          assert.strictEqual(await check1.get('a'), '1');
          assert.strictEqual(await check2.get('b'), '2');
        });
      }

      it('shares one file across differently spelled paths', async () => {
        const file = path.join(tmpDir, 'spelled.duckdb');
        const one = new KeyvDuckDB(file, { ...options, namespace: 'one' });
        const two = new KeyvDuckDB(path.join(tmpDir, '.', 'spelled.duckdb'), { ...options, namespace: 'two' });
        await one.set('a', '1');
        await two.set('b', '2');
        await one.dispose();
        await two.dispose();
        const check = new KeyvDuckDB(file, { ...options, namespace: 'two' });
        assert.strictEqual(await check.get('b'), '2');
      });

      it('creates the table once when stores open at the same time', async () => {
        const file = path.join(tmpDir, 'race.duckdb');
        const stores = Array.from({ length: 5 }, (_, i) => new KeyvDuckDB(file, { ...options, namespace: `n${i}` }));
        await Promise.all(stores.map((store, i) => store.set('k', String(i))));
        for (const [i, store] of stores.entries()) assert.strictEqual(await store.get('k'), String(i));
      });

      it('keeps the file open until the last store is disposed', async () => {
        const file = path.join(tmpDir, 'refs.duckdb');
        const one = new KeyvDuckDB(file, { ...options, namespace: 'one' });
        const two = new KeyvDuckDB(file, { ...options, namespace: 'two' });
        await one.set('a', '1');
        await two.set('b', '2');
        await one.dispose();
        assert.strictEqual(await two.get('b'), '2');
      });
    });
  }

  it('rejects opening a file already open with a different encryption setting', async () => {
    const file = path.join(tmpDir, 'mixed.duckdb');
    const plain = new KeyvDuckDB(file);
    await plain.set('a', '1');
    const encrypted = new KeyvDuckDB(file, { encryptionKey: 'a_32_character_long_test_key_here' });
    await assert.rejects(() => encrypted.get('a'), /already open without an encryption key/);
  });

  it('rejects a different encryption key on a file that is already open', async () => {
    const file = path.join(tmpDir, 'wrong-key.duckdb');
    const right = new KeyvDuckDB(file, { encryptionKey: 'a_32_character_long_test_key_here' });
    await right.set('a', '1');
    const wrong = new KeyvDuckDB(file, { encryptionKey: 'another_32_character_long_key_xxx' });
    await assert.rejects(
      () => wrong.get('a'),
      (error: Error) => /already open with a different encryption key/.test(error.message) && !error.message.includes('another_32')
    );
    assert.strictEqual(await right.get('a'), '1');
  });

  it('waits for a file that is still closing before opening it again', async () => {
    for (const options of [{}, { encryptionKey: 'a_32_character_long_test_key_here' }]) {
      const file = path.join(tmpDir, `closing-${Object.keys(options).length}.duckdb`);
      const first = new KeyvDuckDB(file, options);
      await first.set('a', '1');
      const closing = first.dispose(); // not awaited
      const second = new KeyvDuckDB(file, options);
      await second.set('b', '2');
      await closing;
      assert.strictEqual(await second.get('a'), '1');
      assert.strictEqual(await second.get('b'), '2');
      await second.dispose();
      const third = new KeyvDuckDB(file, options);
      assert.strictEqual(await third.get('b'), '2');
      await third.dispose();
    }
  });
});
