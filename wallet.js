const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');
const { getAddressUTXOs } = require('./blockchain');

const ECPair = ECPairFactory(tinysecp);

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;
const BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/ltc/main';

const ltcNet = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019da4e8 },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

let root = null;
let initialized = false;
let cachedBalance = 0;
let balanceTimestamp = 0;
const CACHE_DURATION = 30 * 1000; // 30 seconds

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function initWallet(mnemonic) {
  console.log("[Wallet] Initializing wallet...");

  if (!mnemonic) {
    console.error("❌ [Wallet] No BOT_MNEMONIC set");
    return false;
  }

  const cleanMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

  try {
    if (!bip39.validateMnemonic(cleanMnemonic)) {
      console.error("❌ [Wallet] Invalid mnemonic");
      return false;
    }

    const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
    root = hdkey.fromMasterSeed(seed);
    initialized = true;
    
    console.log(`✅ [Wallet] Wallet initialized`);
    console.log(`✅ [Wallet] Address: ${generateAddress(0)}`);

    return true;
  } catch (err) {
    console.error("❌ [Wallet] Failed to initialize:", err.message);
    return false;
  }
}

function isInitialized() {
  return initialized === true && root !== null;
}

function generateAddress(index) {
  if (!isInitialized()) return null;
  
  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    const { address } = bitcoin.payments.p2wpkh({ 
      pubkey: child.publicKey, 
      network: ltcNet 
    });
    return address;
  } catch (err) {
    console.error(`[Wallet] Failed to generate address ${index}:`, err.message);
    return null;
  }
}

function getPrivateKeyWIF(index) {
  if (!isInitialized()) return null;
  
  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    
    if (!child.privateKey) {
      console.error(`[Wallet] No private key found for index ${index}`);
      return null;
    }
    
    const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: ltcNet });
    return keyPair.toWIF();
  } catch (err) {
    console.error(`[Wallet] Failed to get private key ${index}:`, err.message);
    return null;
  }
}

async function getAddressBalance(address, forceRefresh = false) {
  if (!address) return 0;
  
  if (!forceRefresh && (Date.now() - balanceTimestamp < CACHE_DURATION)) {
    return cachedBalance;
  }

  try {
    await delay(200);
    
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`;
    console.log(`[Wallet] Checking balance for ${address}`);
    
    const res = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'LTC-Bot/1.0' }
    });
    
    const balance = (res.data.balance || 0) / 1e8;
    const unconfirmed = (res.data.unconfirmed_balance || 0) / 1e8;
    const total = balance + unconfirmed;
    
    console.log(`[Wallet] Balance: ${total} LTC (${balance} confirmed, ${unconfirmed} unconfirmed)`);
    
    cachedBalance = total;
    balanceTimestamp = Date.now();
   
