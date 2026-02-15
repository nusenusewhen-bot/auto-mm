const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const tinysecp = require('tiny-secp256k1');

const bip32 = bitcoin.bip32; // top-level export (v6+)

let root = null;
const ltcNet = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019da4e8 },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

function initWallet(mnemonic) {
  if (!mnemonic) {
    console.log('No BOT_MNEMONIC set - wallet disabled');
    return null;
  }

  try {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    root = bip32.fromSeed(seed, ltcNet);
    const addr = getDepositAddress(0);
    console.log(`Litecoin wallet loaded. Address #0: ${addr}`);
    return root;
  } catch (err) {
    console.error(`Wallet init failed: ${err.message}`);
    return null;
  }
}

function getDepositAddress(index) {
  if (!root) return 'WALLET_NOT_LOADED';
  const path = `m/44'/2'/0'/0/${index}`;
  const child = root.derivePath(path);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network: ltcNet });
  return address;
}

module.exports = { initWallet, getDepositAddress };
