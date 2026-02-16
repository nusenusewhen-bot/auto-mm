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
const CACHE_DURATION = 30 * 1000;
const FIXED_INDEX = 0;

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
    console.log(`✅ [Wallet] INDEX 0 ADDRESS: ${generateAddress()}`);

    return true;
  } catch (err) {
    console.error("❌ [Wallet] Failed to initialize:", err.message);
    return false;
  }
}

function isInitialized() {
  return initialized === true && root !== null;
}

// NO PARAMETERS - ALWAYS INDEX 0
function generateAddress() {
  if (!isInitialized()) return null;
  
  try {
    const child = root.derive(`m/44'/2'/0'/0/${FIXED_INDEX}`);
    const { address } = bitcoin.payments.p2wpkh({ 
      pubkey: child.publicKey, 
      network: ltcNet 
    });
    console.log(`[Wallet] Generated address (INDEX ${FIXED_INDEX}): ${address}`);
    return address;
  } catch (err) {
    console.error(`[Wallet] Failed to generate address:`, err.message);
    return null;
  }
}

// NO PARAMETERS - ALWAYS INDEX 0
function getPrivateKeyWIF() {
  if (!isInitialized()) return null;
  
  try {
    const child = root.derive(`m/44'/2'/0'/0/${FIXED_INDEX}`);
    
    if (!child.privateKey) {
      console.error(`[Wallet] No private key found`);
      return null;
    }
    
    const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: ltcNet });
    return keyPair.toWIF();
  } catch (err) {
    console.error(`[Wallet] Failed to get private key:`, err.message);
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
    console.log(`[Wallet] Checking balance for INDEX ${FIXED_INDEX}: ${address}`);
    
    const res = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'LTC-Bot/1.0' }
    });
    
    const balance = (res.data.balance || 0) / 1e8;
    const unconfirmed = (res.data.unconfirmed_balance || 0) / 1e8;
    const total = balance + unconfirmed;
    
    console.log(`[Wallet] Balance (INDEX ${FIXED_INDEX}): ${total} LTC (${balance} confirmed, ${unconfirmed} unconfirmed)`);
    
    cachedBalance = total;
    balanceTimestamp = Date.now();
    return total;
  } catch (err) {
    if (err.response?.status === 429) {
      console.error(`[Wallet] BlockCypher rate limit (429)`);
      return cachedBalance;
    } else if (err.response?.status === 404) {
      console.log(`[Wallet] Address not found (0 balance)`);
      return 0;
    } else {
      console.error(`[Wallet] BlockCypher error:`, err.message);
    }
    
    return cachedBalance;
  }
}

// NO PARAMETERS - ALWAYS INDEX 0
async function getBalanceAtIndex(forceRefresh = false) {
  if (!isInitialized()) return 0;
  
  const address = generateAddress();
  if (!address) return 0;
  
  return await getAddressBalance(address, forceRefresh);
}

// NO PARAMETERS - ALWAYS INDEX 0
async function getWalletBalance(forceRefresh = false) {
  if (!isInitialized()) return { total: 0, found: [] };
  
  const balance = await getBalanceAtIndex(forceRefresh);
  
  if (balance > 0) {
    return { total: balance, found: [{ index: FIXED_INDEX, balance }] };
  }
  
  return { total: 0, found: [] };
}

async function broadcastTransaction(txHex) {
  console.log(`[Wallet] Broadcasting transaction...`);
  console.log(`[Wallet] TX Hex length: ${txHex.length} bytes`);
  
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
      console.error('[Wallet] Broadcast returned success but no tx hash:', broadcastRes.data);
      return { success: false, error: 'No transaction hash returned' };
    }
  } catch (err) {
    const errorMsg = err.response?.data?.error || err.message;
    console.error('[Wallet] Broadcast failed:', errorMsg);
    
    if (err.response?.data?.errors) {
      console.error('[Wallet] Detailed errors:', JSON.stringify(err.response.data.errors));
    }
    
    return { success: false, error: `Broadcast failed: ${errorMsg}` };
  }
}

// ALWAYS INDEX 0
async function sendFromIndex(toAddress, amountLTC) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  const fromAddress = generateAddress();
  const wif = getPrivateKeyWIF();
  
  if (!fromAddress || !wif) {
    return { success: false, error: 'Could not derive keys' };
  }

  console.log(`[Wallet] Sending ${amountLTC} LTC from INDEX ${FIXED_INDEX} (${fromAddress}) to ${toAddress}`);

  try {
    const currentBalance = await getAddressBalance(fromAddress, true);
    console.log(`[Wallet] Current balance (INDEX ${FIXED_INDEX}): ${currentBalance} LTC`);
    
    if (currentBalance <= 0) {
      return { success: false, error: `No balance in wallet` };
    }

    const utxos = await getAddressUTXOs(fromAddress);
    console.log(`[Wallet] Found ${utxos.length} UTXOs`);
    
    if (utxos.length === 0) {
      return { success: false, error: 'No UTXOs found' };
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000;
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
        console.error(`[Wallet] Error adding input ${utxo.txid}:${utxo.vout}:`, err.message);
        continue;
      }
    }

    if (inputsAdded === 0) {
      return { success: false, error: 'Could not add any inputs (failed to fetch transaction data)' };
    }

    psbt.addOutput({ address: toAddress, value: amountSatoshi });
    console.log(`[Wallet] Added output: ${toAddress} for ${amountSatoshi} satoshi`);
    
    const change = inputSum - amountSatoshi - fee;
    if (change > 546) {
      psbt.addOutput({ address: fromAddress, value: change });
      console.log(`[Wallet] Added change: ${change} satoshi back to INDEX ${FIXED_INDEX}`);
    }

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

// ALWAYS INDEX 0
async function sendLTC(toAddress, amountLTC) {
  console.log(`[Wallet] sendLTC called - FORCING INDEX ${FIXED_INDEX}`);
  return sendFromIndex(toAddress, amountLTC);
}

// ALWAYS INDEX 0
async function sendAllLTC(toAddress) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }
  
  const balance = await getBalanceAtIndex(true);
  if (balance <= 0) {
    return { success: false, error: `No balance in wallet` };
  }
  
  const fee = 0.0001;
  const amountToSend = Math.max(0, balance - fee);
  
  if (amountToSend <= 0) {
    return { success: false, error: `Balance too low to cover fee` };
  }
  
  console.log(`[Wallet] Sending ALL ${amountToSend} LTC from INDEX ${FIXED_INDEX}`);
  return await sendFromIndex(toAddress, amountToSend.toFixed(8));
}

// ALWAYS INDEX 0
async function sendFeeToAddress(feeAddress, feeLtc) {
  console.log(`[Wallet] sendFeeToAddress called - FORCING INDEX ${FIXED_INDEX}`);
  const balance = await getBalanceAtIndex(true);
  if (balance >= parseFloat(feeLtc) + 0.0001) {
    return await sendFromIndex(feeAddress, feeLtc);
  }
  return { success: false, error: 'Insufficient balance for fee' };
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
