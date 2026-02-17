const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');
const { getAddressUTXOs, getTransactionHex, delay } = require('./blockchain');

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
let cachedBalances = {};
const CACHE_DURATION = 30 * 1000;

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
    console.log(`✅ [Wallet] Index 0 (TRADES): ${generateAddress(0)}`);
    console.log(`✅ [Wallet] Index 1 (FEES): ${generateAddress(1)}`);
    console.log(`✅ [Wallet] Index 2: ${generateAddress(2)}`);

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
  
  const cacheKey = address;
  if (!forceRefresh && cachedBalances[cacheKey] && (Date.now() - cachedBalances[cacheKey].timestamp < CACHE_DURATION)) {
    return cachedBalances[cacheKey].balance;
  }

  try {
    await delay(200);
    
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`;
    
    const res = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'LTC-Bot/1.0' }
    });
    
    const balance = (res.data.balance || 0) / 1e8;
    const unconfirmed = (res.data.unconfirmed_balance || 0) / 1e8;
    const total = balance + unconfirmed;
    
    cachedBalances[cacheKey] = { balance: total, timestamp: Date.now() };
    return total;
  } catch (err) {
    if (err.response?.status === 429) {
      console.error(`[Wallet] BlockCypher rate limit (429)`);
      return cachedBalances[cacheKey]?.balance || 0;
    } else if (err.response?.status === 404) {
      return 0;
    } else {
      console.error(`[Wallet] BlockCypher error:`, err.message);
    }
    
    return cachedBalances[cacheKey]?.balance || 0;
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
  
  const found = [];
  let total = 0;
  
  for (let i = 0; i <= 2; i++) {
    const balance = await getBalanceAtIndex(i, forceRefresh);
    if (balance > 0) {
      found.push({ index: i, balance, address: generateAddress(i) });
      total += balance;
    }
  }
  
  return { total, found };
}

async function broadcastTransaction(txHex) {
  console.log(`[Wallet] Broadcasting transaction...`);
  
  try {
    const broadcastRes = await axios.post(
      `${BLOCKCYPHER_BASE}/txs/push?token=${BLOCKCYPHER_TOKEN}`,
      { tx: txHex },
      { 
        timeout: 30000,
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'LTC-Bot/1.0'
        }
      }
    );

    if (broadcastRes.data?.tx?.hash) {
      console.log(`[Wallet] Broadcast successful: ${broadcastRes.data.tx.hash}`);
      return { 
        success: true, 
        txid: broadcastRes.data.tx.hash
      };
    } else {
      return { success: false, error: 'No transaction hash returned' };
    }
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Wallet] Broadcast failed:', errorMsg);
    return { success: false, error: `Broadcast failed: ${errorMsg}` };
  }
}

// IMPROVED sendFromIndex with better UTXO handling
async function sendFromIndex(fromIndex, toAddress, amountLTC) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  const fromAddress = generateAddress(fromIndex);
  const wif = getPrivateKeyWIF(fromIndex);
  
  if (!fromAddress || !wif) {
    return { success: false, error: 'Could not derive keys' };
  }

  console.log(`[Wallet] Sending ${amountLTC} LTC from index ${fromIndex} (${fromAddress}) to ${toAddress}`);

  try {
    // Get fresh balance
    const currentBalance = await getAddressBalance(fromAddress, true);
    
    if (currentBalance <= 0) {
      return { success: false, error: `No balance in wallet index ${fromIndex}` };
    }

    // Try up to 3 times to get UTXOs
    let utxos = [];
    let attempts = 0;
    while (utxos.length === 0 && attempts < 3) {
      utxos = await getAddressUTXOs(fromAddress);
      if (utxos.length === 0) {
        console.log(`[Wallet] No UTXOs found, attempt ${attempts + 1}/3, waiting...`);
        await delay(2000);
        attempts++;
      }
    }
    
    if (utxos.length === 0) {
      // If still no UTXOs but we have balance, try to use the full balance endpoint
      console.log(`[Wallet] Trying alternative UTXO method...`);
      const info = await getAddressInfo(fromAddress);
      if (info && info.balance > 0) {
        // Create a single "virtual" UTXO with the full balance
        // This is a fallback that assumes the balance is spendable
        console.log(`[Wallet] Using balance-based fallback`);
        utxos = [{
          txid: 'pending',
          vout: 0,
          value: info.balance,
          confirmations: info.confirmations || 1
        }];
      } else {
        return { success: false, error: 'No UTXOs found and no balance detected' };
      }
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000; // 0.0001 LTC fee
    const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);

    if (totalInput < amountSatoshi + fee) {
      return { success: false, error: `Insufficient balance. Have: ${(totalInput/1e8).toFixed(8)}, Need: ${((amountSatoshi+fee)/1e8).toFixed(8)}` };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let inputSum = 0;
    let inputsAdded = 0;

    for (const utxo of utxos) {
      if (inputSum >= amountSatoshi + fee) break;
      
      try {
        // Skip if txid is 'pending' (fallback mode)
        if (utxo.txid === 'pending') {
          console.log(`[Wallet] Cannot use fallback UTXO for signing, need actual txid`);
          continue;
        }
        
        await delay(300);
        const txHex = await getTransactionHex(utxo.txid);
        
        if (!txHex) {
          console.log(`[Wallet] Could not get hex for ${utxo.txid}, skipping`);
          continue;
        }
        
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(txHex, 'hex')
        });
        inputSum += utxo.value;
        inputsAdded++;
        console.log(`[Wallet] Added input: ${utxo.txid}:${utxo.vout} = ${utxo.value} satoshi`);
      } catch (err) {
        console.error(`[Wallet] Error adding input ${utxo.txid}:`, err.message);
        continue;
      }
    }

    if (inputsAdded === 0) {
      return { success: false, error: 'Could not add any inputs - UTXOs may be unconfirmed or unavailable' };
    }

    psbt.addOutput({ address: toAddress, value: amountSatoshi });
    
    const change = inputSum - amountSatoshi - fee;
    if (change > 546) { // Dust threshold
      psbt.addOutput({ address: fromAddress, value: change });
      console.log(`[Wallet] Change output: ${change} satoshi to ${fromAddress}`);
    }

    const keyPair = ECPair.fromWIF(wif, ltcNet);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
        console.log(`[Wallet] Signed input ${i}`);
      } catch (e) {
        console.error(`[Wallet] Signing failed for input ${i}:`, e.message);
        return { success: false, error: `Signing failed: ${e.message}` };
      }
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    const broadcastResult = await broadcastTransaction(txHex);
    
    if (broadcastResult.success) {
      return { 
        success: true, 
        txid: broadcastResult.txid,
        amountSent: (amountSatoshi / 1e8).toFixed(8)
      };
    } else {
      return { success: false, error: broadcastResult.error };
    }

  } catch (err) {
    console.error('[Wallet] Send error:', err);
    return { success: false, error: err.message };
  }
}

// ALL TRADES USE INDEX 0
async function sendLTC(toAddress, amountLTC) {
  console.log(`[Wallet] TRADE SEND - Using INDEX 0`);
  return sendFromIndex(0, toAddress, amountLTC);
}

// SEND ALL FROM SPECIFIC INDEX
async function sendAllLTC(fromIndex, toAddress) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }
  
  const balance = await getBalanceAtIndex(fromIndex, true);
  if (balance <= 0) {
    return { success: false, error: `No balance in index ${fromIndex}` };
  }
  
  const fee = 0.0001;
  const amountToSend = Math.max(0, balance - fee);
  
  if (amountToSend <= 0) {
    return { success: false, error: `Balance too low to cover fee` };
  }
  
  console.log(`[Wallet] Sending ALL ${amountToSend} LTC from index ${fromIndex}`);
  return await sendFromIndex(fromIndex, toAddress, amountToSend.toFixed(8));
}

// SEND FEE FROM INDEX 0 TO INDEX 1 (FEE WALLET)
async function sendFeeToFeeWallet(feeLtc) {
  console.log(`[Wallet] Sending fee ${feeLtc} LTC from INDEX 0 to INDEX 1 (Fee Wallet)`);
  const feeAddress = generateAddress(1);
  return await sendFromIndex(0, feeAddress, feeLtc);
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
  sendFeeToFeeWallet
};
