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

// Litecoin network parameters
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
const CACHE_DURATION = 30 * 1000; // 30 seconds cache

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
  
  if (!forceRefresh && balanceCache.has(address)) {
    const cached = balanceCache.get(address);
    if (Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.balance;
    }
  }

  try {
    // Add delay to avoid rate limits
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
    
    console.log(`[Wallet] BlockCypher: ${address}: ${total} LTC (${balance} confirmed, ${unconfirmed} unconfirmed)`);
    
    balanceCache.set(address, { balance: total, timestamp: Date.now() });
    return total;
  } catch (err) {
    if (err.response?.status === 429) {
      console.error(`[Wallet] BlockCypher rate limit (429) for ${address}`);
      // Return cached value even if expired
      if (balanceCache.has(address)) {
        const cached = balanceCache.get(address);
        console.log(`[Wallet] Using stale cached balance: ${cached.balance} LTC`);
        return cached.balance;
      }
    } else if (err.response?.status === 404) {
      // Address not found = 0 balance
      console.log(`[Wallet] Address ${address} not found (0 balance)`);
      return 0;
    } else {
      console.error(`[Wallet] BlockCypher error for ${address}:`, err.message);
    }
    
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
  
  console.log(`[Wallet] Scanning indices 0-20...`);
  let total = 0;
  const found = [];
  
  for (let i = 0; i <= 20; i++) {
    const balance = await getBalanceAtIndex(i, forceRefresh);
    if (balance > 0) {
      found.push({ index: i, balance });
      total += balance;
    }
    // Small delay between requests
    if (i < 20) await delay(100);
  }
  
  console.log(`[Wallet] Scan complete. Total: ${total} LTC across ${found.length} addresses`);
  return { total, found };
}

async function broadcastTransaction(txHex) {
  console.log(`[Wallet] Broadcasting transaction via BlockCypher...`);
  console.log(`[Wallet] TX Hex length: ${txHex.length} bytes`);
  
  try {
    // BlockCypher requires the tx hex to be sent as { tx: "hexstring" }
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
      console.log(`[Wallet] BlockCypher broadcast successful: ${broadcastRes.data.tx.hash}`);
      return { 
        success: true, 
        txid: broadcastRes.data.tx.hash
      };
    } else {
      console.error('[Wallet] BlockCypher returned success but no tx hash:', broadcastRes.data);
      return { success: false, error: 'No transaction hash returned' };
    }
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Wallet] BlockCypher broadcast failed:', errorMsg);
    
    if (err.response?.data?.errors) {
      console.error('[Wallet] Detailed errors:', JSON.stringify(err.response.data.errors));
    }
    
    return { success: false, error: `Broadcast failed: ${errorMsg}` };
  }
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

  console.log(`[Wallet] Preparing to send ${amountLTC} LTC from index ${index} (${fromAddress}) to ${toAddress}`);

  try {
    // Force refresh balance
    const currentBalance = await getBalanceAtIndex(index, true);
    console.log(`[Wallet] Balance at index ${index}: ${currentBalance} LTC`);
    
    if (currentBalance <= 0) {
      return { success: false, error: `No balance at index ${index}` };
    }

    // Get UTXOs
    const utxos = await getAddressUTXOs(fromAddress);
    console.log(`[Wallet] Found ${utxos.length} UTXOs for ${fromAddress}`);
    
    if (utxos.length === 0) {
      return { success: false, error: 'No UTXOs found' };
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000; // 0.0001 LTC fee
    const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);

    console.log(`[Wallet] Amount: ${amountSatoshi} satoshi, Fee: ${fee}, Total Input: ${totalInput}`);

    if (totalInput < amountSatoshi + fee) {
      return { success: false, error: `Insufficient balance. Have: ${(totalInput/1e8).toFixed(8)}, Need: ${((amountSatoshi+fee)/1e8).toFixed(8)}` };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let inputSum = 0;
    let inputsAdded = 0;

    for (const utxo of utxos) {
      if (inputSum >= amountSatoshi + fee) break;
      
      try {
        // Fetch the full transaction to get the output script
        await delay(200);
        const txRes = await axios.get(
          `${BLOCKCYPHER_BASE}/txs/${utxo.txid}?token=${BLOCKCYPHER_TOKEN}`,
          { 
            timeout: 15000,
            headers: { 'User-Agent': 'LTC-Bot/1.0' }
          }
        );
        
        const tx = txRes.data;
        const output = tx.outputs[utxo.vout];
        
        if (!output || !output.script) {
          console.error(`[Wallet] No script found for ${utxo.txid}:${utxo.vout}`);
          continue;
        }
        
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: Buffer.from(output.script, 'hex'),
            value: utxo.value
          }
        });
        inputSum += utxo.value;
        inputsAdded++;
        console.log(`[Wallet] Added input ${inputsAdded}: ${utxo.txid}:${utxo.vout} (${utxo.value} satoshi)`);
      } catch (err) {
        console.error(`[Wallet] Error fetching tx ${utxo.txid}:`, err.message);
        continue;
      }
    }

    if (inputsAdded === 0) {
      return { success: false, error: 'Could not add any inputs (failed to fetch transaction data)' };
    }

    // Add output to recipient
    psbt.addOutput({ address: toAddress, value: amountSatoshi });
    console.log(`[Wallet] Added output: ${toAddress} for ${amountSatoshi} satoshi`);
    
    // Add change output if needed (above dust threshold of 546 satoshi)
    const change = inputSum - amountSatoshi - fee;
    if (change > 546) {
      psbt.addOutput({ address: fromAddress, value: change });
      console.log(`[Wallet] Added change: ${change} satoshi back to ${fromAddress}`);
    }

    // Sign all inputs
    const keyPair = ECPair.fromWIF(wif, ltcNet);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
        console.log(`[Wallet] Signed input ${i}`);
      } catch (e) {
        console.error(`[Wallet] Error signing input ${i}:`, e.message);
        return { success: false, error: `Signing failed: ${e.message}` };
      }
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    console.log(`[Wallet] Transaction built, size: ${txHex.length / 2} bytes`);

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

async function sendLTC(tradeId, toAddress, amountLTC) {
  return sendFromIndex(tradeId, toAddress, amountLTC);
}

async function sendAllLTC(toAddress, specificIndex = null) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }
  
  let indexToUse = specificIndex;
  
  if (indexToUse === null) {
    console.log(`[Wallet] Auto-detecting funded index...`);
    for (let i = 0; i <= 20; i++) {
      const balance = await getBalanceAtIndex(i, true);
      if (balance > 0) {
        indexToUse = i;
        console.log(`[Wallet] Found funds at index ${i}: ${balance} LTC`);
        break;
      }
      await delay(100);
    }
  }
  
  if (indexToUse === null) {
    return { success: false, error: 'No funded addresses found (checked indices 0-20)' };
  }
  
  const balance = await getBalanceAtIndex(indexToUse, true);
  if (balance <= 0) {
    return { success: false, error: `No balance at index ${indexToUse}` };
  }
  
  const fee = 0.0001;
  const amountToSend = Math.max(0, balance - fee);
  
  if (amountToSend <= 0) {
    return { success: false, error: `Balance too low to cover fee` };
  }
  
  console.log(`[Wallet] Sending all ${amountToSend} LTC from index ${indexToUse}`);
  return await sendFromIndex(indexToUse, toAddress, amountToSend.toFixed(8));
}

async function sendFeeToAddress(feeAddress, feeLtc, tradeId) {
  for (let i = 0; i <= 20; i++) {
    const balance = await getBalanceAtIndex(i, true);
    if (balance >= parseFloat(feeLtc) + 0.0001) {
      return await sendFromIndex(i, feeAddress, feeLtc);
    }
    await delay(100);
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
