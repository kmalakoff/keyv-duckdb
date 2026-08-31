const assert = require('assert');
const { default: KeyvDuckDB, closeAllConnections, getConnectionCount, isEncryptedConnection } = require('keyv-duckdb');

describe('exports .cjs', () => {
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
