const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');

const ltcNet = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019da4e8 },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

let root;

function initWallet(mnemonic) {
  if (!mnemonic) {
    console.error("No BOT_MNEMONIC set");
    return;
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  root = hdkey.fromMasterSeed(seed);
  console.log("Litecoin wallet loaded.");
}

function generateAddress(index) {
  if (!root) return "WALLET_NOT_LOADED";
  const child = root.derive(`m/44'/2'/0'/0/${index}`);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: ltcNet });
  return address;
}

module.exports = { initWallet, generateAddress };
