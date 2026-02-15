const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const tinysecp = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');

// Initialize bip32 with tiny-secp256k1
const bip32 = BIP32Factory(tinysecp);

let root = null;

// Litecoin network parameters
const ltcNet = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: {
    public: 0x019da462,
    private: 0x019da4e8
  },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

/**
 * Initialize wallet from mnemonic
 * @param {string} mnemonic - 12-word mnemonic from env
 * @returns {BIP32} root node or null
 */
function initWallet(mnemonic) {
  if (!mnemonic) {
    console.log('No BOT_MNEMONIC set - wallet disabled');
    return null;
  }

  try {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Invalid mnemonic format');
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    root = bip32.fromSeed(seed, ltcNet);

    const testAddr = getDepositAddress(0);
    console.log(`Litecoin wallet loaded. Address #0: ${testAddr}`);

    return root;
  } catch (err) {
    console.error(`Wallet init failed: ${err.message}`);
    return null;
  }
}

/**
 * Derive a deposit address at the given index
 * @param {number} index
 * @returns {string} Litecoin address or error string
 */
function getDepositAddress(index) {
  if (!root) return 'WALLET_NOT_LOADED';

  try {
    // BIP84 derivation path for native SegWit LTC (ltc1...)
    const path = `m/84'/2'/0'/0/${index}`;
    const child = root.derivePath(path);

    const { address } = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(child.publicKey),
      network: ltcNet
    });

    return address;
  } catch (err) {
    console.error(`Address derivation failed: ${err.message}`);
    return 'ADDRESS_ERROR';
  }
}

module.exports = {
  initWallet,
  getDepositAddress
};
