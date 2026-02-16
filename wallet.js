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
const balanceCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000;

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
    console.log(`✅ [Wallet] Address [0]: ${generateAddress(0)}`);
    console.log(`✅ [Wallet] Address [1]: ${generateAddress(1)}`);

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
    const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: ltcNet });
    return keyPair.toWIF();
  } catch (err) {
    console.error(`[Wallet] Failed to get private key ${index}:`, err.message);
    return null;
  }
}

async function getAddressBalance(address, forceRefresh = false) {
  if (!address) return 0;
  
  if (!forceRefresh && balanceCache.has(address)) {
    const cached = balanceCache.get(address);
    if (Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.balance;
    }
  }

  try {
    await delay(2000);
    
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`;
    const res = await axios.get(url, { timeout: 15000 });
    
    const balance = (res.data.balance || 0) / 1e8;
    const unconfirmed = (res.data.unconfirmed_balance || 0) / 1e8;
    const total = balance + unconfirmed;
    
    console.log(`[Wallet] ${address}: ${total} LTC`);
    
    balanceCache.set(address, { balance: total, timestamp: Date.now() });
    return total;
  } catch (err) {
    console.error(`[Wallet] Error fetching balance:`, err.message);
    return 0;
  }
}

async function getBalanceAtIndex(index, forceRefresh = false) {
  if (!isInitialized()) return 0;
  
  const address = generateAddress(index);
  if (!address) return 0;
  
  return await getAddressBalance(address, forceRefresh);
}

async function getWalletBalance(forceRefresh = false) {
  if (!isInitialized()) return { total: 0, found: [] };
  
  console.log(`[Wallet] Scanning indices 0-10...`);
  let total = 0;
  const found = [];
  
  for (let i = 0; i <= 10; i++) {
    const balance = await getBalanceAtIndex(i, forceRefresh);
    if (balance > 0) {
      found.push({ index: i, balance });
      total += balance;
    }
  }
  
  return { total, found };
}

async function sendFromIndex(index, toAddress, amountLTC) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  const fromAddress = generateAddress(index);
  const wif = getPrivateKeyWIF(index);
  
  if (!fromAddress || !wif) {
    return { success: false, error: 'Could not derive keys' };
  }

  try {
    const currentBalance = await getBalanceAtIndex(index, true);
    
    if (currentBalance <= 0) {
      return { success: false, error: `No balance at index ${index}` };
    }

    const utxos = await getAddressUTXOs(fromAddress);
    
    if (utxos.length === 0) {
      return { success: false, error: 'No UTXOs found' };
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000;
    const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);

    if (totalInput < amountSatoshi + fee) {
      return { success: false, error: `Insufficient balance` };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let inputSum = 0;

    for (const utxo of utxos) {
      if (inputSum >= amountSatoshi + fee) break;
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: { 
          script: Buffer.from(utxo.script, 'hex'), 
          value: utxo.value 
        }
      });
      inputSum += utxo.value;
    }

    psbt.addOutput({ address: toAddress, value: amountSatoshi });
    
    const change = inputSum - amountSatoshi - fee;
    if (change > 546) {
      psbt.addOutput({ address: fromAddress, value: change });
    }

    const keyPair = ECPair.fromWIF(wif, ltcNet);
    for (let i = 0; i < psbt.inputCount; i++) {
      try { 
        psbt.signInput(i, keyPair); 
      } catch (e) {
        console.error(`[Wallet] Error signing input ${i}:`, e.message);
      }
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    const broadcastRes = await axios.post(
      `${BLOCKCYPHER_BASE}/txs/push?token=${BLOCKCYPHER_TOKEN}`,
      { tx: txHex },
      { timeout: 15000 }
    );

    if (broadcastRes.data?.tx?.hash) {
      return { 
        success: true, 
        txid: broadcastRes.data.tx.hash,
        amountSent: (amountSatoshi / 1e8).toFixed(8)
      };
    } else {
      return { success: false, error: 'Broadcast failed' };
    }

  } catch (err) {
    console.error('[Wallet] Send error:', err);
    return { success: false, error: err.message };
  }
}

async function sendLTC(tradeId, toAddress, amountLTC) {
  return sendFromIndex(tradeId, toAddress, amountLTC);
}

async function sendAllLTC(toAddress, specificIndex = null) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }
  
  let indexToUse = specificIndex;
  
  if (indexToUse === null) {
    for (let i = 0; i <= 10; i++) {
      const balance = await getBalanceAtIndex(i, true);
      if (balance > 0) {
        indexToUse = i;
        break;
      }
    }
  }
  
  if (indexToUse === null) {
    return { success: false, error: 'No funded addresses found' };
  }
  
  const balance = await getBalanceAtIndex(indexToUse, true);
  if (balance <= 0) {
    return { success: false, error: `No balance at index ${indexToUse}` };
  }
  
  const fee = 0.0001;
  const amountToSend = Math.max(0, balance - fee);
  
  if (amountToSend <= 0) {
    return { success: false, error: `Balance too low` };
  }
  
  return await sendFromIndex(indexToUse, toAddress, amountToSend.toFixed(8));
}

async function sendFeeToAddress(feeAddress, feeLtc, tradeId) {
  for (let i = 0; i <= 10; i++) {
    const balance = await getBalanceAtIndex(i, true);
    if (balance >= parseFloat(feeLtc) + 0.0001) {
      return await sendFromIndex(i, feeAddress, feeLtc);
    }
  }
  return { success: false, error: 'No index with sufficient balance for fee' };
}

module.exports = { 
  initWallet, 
  isInitialized,
  generateAddress, 
  getPrivateKeyWIF, 
  sendLTC, 
  sendFromIndex, 
  getWalletBalance, 
  getBalanceAtIndex, 
  sendAllLTC,
  sendFeeToAddress
};
