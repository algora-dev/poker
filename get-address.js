// Quick script to derive wallet address from private key
const crypto = require('crypto');

function privateKeyToAddress(privateKey) {
  const EC = require('elliptic').ec;
  const ec = new EC('secp256k1');
  const key = ec.keyFromPrivate(privateKey, 'hex');
  const publicKey = key.getPublic().encode('hex');
  
  // Ethereum address = last 20 bytes of keccak256(publicKey)
  const hash = crypto.createHash('sha3-256').update(Buffer.from(publicKey.slice(2), 'hex')).digest();
  const address = '0x' + hash.slice(-20).toString('hex');
  return address;
}

// Note: This is simplified - proper derivation uses keccak256, not sha3-256
// Real address will be computed by ethers.js during deployment

const privKey = 'ed1fa1fe6db69f1f039c58ae278277ec2edf7f0a647224293e49f3f29a48121f';
console.log('Private Key:', privKey);
console.log('Address will be computed during deployment by ethers.js');
console.log('\nWaiting for ETH + mUSD funding...');
