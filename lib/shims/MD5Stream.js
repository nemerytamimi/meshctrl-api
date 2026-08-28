// Shim for the MeshAgent native MD5Stream module.
// amt-redir-duk.js uses it for exactly one thing: hex_md5() during Intel AMT
// digest authentication. node's crypto covers it. Input is a binary
// ("latin1") string, matching what the redirection code builds.
const crypto = require('crypto');

module.exports.create = function () {
  return {
    syncHash: function (data) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'binary');
      return crypto.createHash('md5').update(buf).digest();
    }
  };
};
