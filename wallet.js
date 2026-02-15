const bip39 = require('bip39');
const hdkey = require('hdkey');
const litecore = require('litecore-lib');

let root;

function initWallet(mnemonic) {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  root = hdkey.fromMasterSeed(seed);
}

function generateAddress(index) {
  const child = root.derive(`m/44'/2'/0'/0/${index}`);
  const privateKey = new litecore.PrivateKey(child.privateKey);
  const address = privateKey.toAddress().toString();
  return {
    privateKey,
    address
  };
}

module.exports = { initWallet, generateAddress };
