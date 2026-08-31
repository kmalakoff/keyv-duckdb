import assert from 'assert';
import KeyvDuckDB, { closeAllConnections, getConnectionCount, isEncryptedConnection } from 'keyv-duckdb';

describe('exports .ts', () => {
  it('default', () => {
    assert.equal(typeof KeyvDuckDB, 'function');
  });
  it('closeAllConnections', () => {
    assert.equal(typeof closeAllConnections, 'function');
  });
  it('getConnectionCount', () => {
    assert.equal(typeof getConnectionCount, 'function');
  });
  it('isEncryptedConnection', () => {
    assert.equal(typeof isEncryptedConnection, 'function');
  });
});
