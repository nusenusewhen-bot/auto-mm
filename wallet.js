const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');
const { getAddressUTXOs } = require('./blockchain');

const ECPair = ECPairFactory(tinysecp);

const BLOCKCHAIR_BASE = 'https://api.blockchair.com/litecoin';

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
const CACHE_DURATION = 2 * 60 * 1000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function initWallet(mnemonic) {
  console.log("[Wallet] Initializing wallet...");

  if (!mnemonic) {
    console.error("❌ [Wallet] No BOT_MNEMONIC set in environment");
    return false;
  }

  const cleanMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

  console.log(`[Wallet] Mnemonic length: ${cleanMnemonic.split(' ').length} words`);

  try {
    if (!bip39.validateMnemonic(cleanMnemonic)) {
      console.error("❌ [Wallet] Invalid mnemonic provided");
      return false;
    }

    const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
    root = hdkey.fromMasterSeed(seed);
    initialized = true;
    
    console.log(`✅ [Wallet] Wallet initialized successfully`);
    console.log(`✅ [Wallet] Address [0]: ${generateAddress(0)}`);
    console.log(`✅ [Wallet] Address [1]: ${generateAddress(1)}`);

    return true;
  } catch (err) {
    console.error("❌ [Wallet] Failed to initialize wallet:", err.message);
    root = null;
    initialized = false;
    return false;
  }
}

function isInitialized() {
  return initialized === true && root !== null;
}

function generateAddress(index) {
  if (!isInitialized()) {
    console.error(`[Wallet] Cannot generate address ${index}: wallet not initialized`);
    return null;
  }
  
  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    const { address } = bitcoin.payments.p2wpkh({ 
      pubkey: child.publicKey, 
      network: ltcNet 
    });
    return address;
  } catch (err) {
    console.error(`[Wallet] Failed to generate address for index ${index}:`, err.message);
    return null;
  }
}

function getPrivateKeyWIF(index) {
  if (!isInitialized()) {
    console.error(`[Wallet] Cannot get private key for index ${index}: wallet not initialized`);
    return null;
  }
  
  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: ltcNet });
    return keyPair.toWIF();
  } catch (err) {
    console.error(`[Wallet] Failed to get private key for index ${index}:`, err.message);
    return null;
  }
}

async function getAddressBalance(address, forceRefresh = false) {
  if (!address) {
    console.error('[Wallet] No address provided to getAddressBalance');
    return 0;
  }
  
  if (!forceRefresh && balanceCache.has(address)) {
    const cached = balanceCache.get(address);
    if (Date.now() - cached.timestamp < CACHE_DURATION) {
      console.log(`[Wallet] Using cached balance for ${address}: ${cached.balance} LTC`);
      return cached.balance;
    }
  }

  try {
    // Blockchair rate limit: 30 req/min, so we wait 2 seconds between calls
    await delay(2000);
    
    console.log(`[Wallet] Fetching balance for ${address} from Blockchair...`);
    const url = `${BLOCKCHAIR_BASE}/dashboards/address/${address}`;
    console.log(`[Wallet] URL: ${url}`);
    
    const res = await axios.get(url, { timeout: 15000 });
    
    console.log(`[Wallet] Blockchair response status: ${res.status}`);
    console.log(`[Wallet] Blockchair response data:`, JSON.stringify(res.data).substring(0, 500));
    
    // Check if response has data
    if (!res.data || !res.data.data || !res.data.data[address]) {
      console.error(`[Wallet] Invalid response structure from Blockchair`);
      return 0;
    }
    
    const addressData = res.data.data[address];
    console.log(`[Wallet] Address data:`, JSON.stringify(addressData).substring(0, 500));
    
    // Blockchair returns balance in satoshis
    const balanceSatoshi = addressData.address?.balance || 0;
    const balance = balanceSatoshi / 1e8;
    
    console.log(`[Wallet] ${address}: ${balance} LTC (${balanceSatoshi} satoshi)`);
    
    if (balance > 0) {
      balanceCache.set(address, { balance: balance, timestamp: Date.now() });
    }
    
    return balance;
  } catch (err) {
    console.error(`[Wallet] Error fetching balance for ${address}:`, err.message);
    if (err.response) {
      console.error(`[Wallet] Response status: ${err.response.status}`);
      console.error(`[Wallet] Response data:`, err.response.data);
    }
    return 0;
  }
}

async function getBalanceAtIndex(index, forceRefresh = false) {
  if (!isInitialized()) {
    console.error("[Wallet] Cannot get balance: not initialized");
    return 0;
  }
  
  const address = generateAddress(index);
  if (!address) {
    console.error(`[Wallet] Could not generate address for index ${index}`);
    return 0;
  }
  
  console.log(`[Wallet] Getting balance for index ${index}, address: ${address}`);
  return await getAddressBalance(address, forceRefresh);
}

async function getWalletBalance(forceRefresh = false) {
  if (!isInitialized()) {
    console.error("[Wallet] Not initialized");
    return { total: 0, found: [] };
  }
  
  console.log(`[Wallet] Scanning indices 0-20 for balances...`);
  let total = 0;
  const found = [];
  
  for (let i = 0; i <= 20; i++) {
    try {
      const balance = await getBalanceAtIndex(i, forceRefresh);
      if (balance > 0) {
        console.log(`[Wallet] Index ${i}: ${balance} LTC`);
        found.push({ index: i, balance });
        total += balance;
      }
    } catch (err) {
      console.error(`[Wallet] Error checking index ${i}:`, err.message);
    }
  }
  
  console.log(`[Wallet] Total balance across all indices: ${total} LTC`);
  return { total, found };
}

async function sendFromIndex(index, toAddress, amountLTC) {
  console.log(`[Wallet] sendFromIndex called: index=${index}, to=${toAddress}, amount=${amountLTC}`);
  
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  const fromAddress = generateAddress(index);
  const wif = getPrivateKeyWIF(index);
  
  console.log(`[Wallet] fromAddress=${fromAddress}, wif=${wif ? 'exists' : 'null'}`);

  if (!fromAddress) {
    return { success: false, error: 'Could not generate address' };
  }
  
  if (!wif) {
    return { success: false, error: 'Could not derive private key' };
  }

  try {
    const currentBalance = await getBalanceAtIndex(index, true);
    console.log(`[Wallet] Current balance at index ${index}: ${currentBalance} LTC`);
    
    if (currentBalance <= 0) {
      return { success: false, error: `No balance at index ${index}. Found: ${currentBalance} LTC` };
    }

    const utxos = await getAddressUTXOs(fromAddress);
    console.log(`[Wallet] Found ${utxos.length} UTXOs`);

    if (utxos.length === 0) {
      return { success: false, error: 'No UTXOs found' };
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000;
    const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);

    console.log(`[Wallet] amountSatoshi=${amountSatoshi}, fee=${fee}, totalInput=${totalInput}`);

    if (totalInput < amountSatoshi + fee) {
      return { success: false, error: `Insufficient balance. Have: ${totalInput / 1e8} LTC, Need: ${(amountSatoshi + fee) / 1e8} LTC` };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let inputSum = 0;

    for (const utxo of utxos) {
      if (inputSum >= amountSatoshi + fee) break;
      try {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: { 
            script: Buffer.from(utxo.script, 'hex'), 
            value: utxo.value 
          }
        });
        inputSum += utxo.value;
      } catch (err) {
        console.error(`[Wallet] Error adding input:`, err.message);
        continue;
      }
    }

    if (psbt.inputCount === 0) {
      return { success: false, error: 'Could not add any inputs' };
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
      `${BLOCKCHAIR_BASE}/push/transaction`,
      { data: txHex },
      { timeout: 15000 }
    );

    if (broadcastRes.data.data && broadcastRes.data.data.transaction_hash) {
      console.log(`[Wallet] Transaction broadcasted: ${broadcastRes.data.data.transaction_hash}`);
      return { 
        success: true, 
        txid: broadcastRes.data.data.transaction_hash,
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
  console.log(`[Wallet] sendAllLTC called: to=${toAddress}, index=${specificIndex}`);
  
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }
  
  let indexToUse = specificIndex;
  
  if (indexToUse === null) {
    console.log(`[Wallet] Searching for funds...`);
    for (let i = 0; i <= 20; i++) {
      const balance = await getBalanceAtIndex(i, true);
      if (balance > 0) {
        indexToUse = i;
        console.log(`[Wallet] Found funds at index ${i}: ${balance} LTC`);
        break;
      }
    }
  }
  
  if (indexToUse === null) {
    return { success: false, error: 'No funded addresses found (checked indices 0-20)' };
  }
  
  const balance = await getBalanceAtIndex(indexToUse, true);
  if (balance <= 0) {
    return { success: false, error: `No balance at index ${indexToUse}. Balance: ${balance}` };
  }
  
  const fee = 0.0001;
  const amountToSend = Math.max(0, balance - fee);
  
  if (amountToSend <= 0) {
    return { success: false, error: `Balance too low. Have: ${balance} LTC, Fee: ${fee} LTC` };
  }
  
  console.log(`[Wallet] Sending ${amountToSend} LTC from index ${indexToUse}`);
  
  return await sendFromIndex(indexToUse, toAddress, amountToSend.toFixed(8));
}

async function sendFeeToAddress(feeAddress, feeLtc, tradeId) {
  console.log(`[Wallet] Sending fee ${feeLtc} LTC to ${feeAddress}`);
  
  for (let i = 0; i <= 20; i++) {
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
