const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');
const { getAddressUTXOs, getTransactionHex, broadcastTransaction, getAddressBalance, delay } = require('./blockchain');

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

async function getBalanceAtIndex(index, forceRefresh = false) {
  if (!isInitialized()) return 0;
  
  const address = generateAddress(index);
  if (!address) return 0;
  
  const balance = await getAddressBalance(address, forceRefresh);
  return balance.total || 0;
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
    // Get balance (uses node if available - INSTANT)
    const balanceData = await getAddressBalance(fromAddress, true);
    const currentBalance = balanceData.total;
    
    console.log(`[Wallet] Balance from ${balanceData.source}: ${currentBalance} LTC`);
    
    if (currentBalance <= 0) {
      return { success: false, error: `No balance in wallet index ${fromIndex}. Address: ${fromAddress}` };
    }

    // Get UTXOs (uses node if available - INSTANT)
    let utxos = await getAddressUTXOs(fromAddress);
    
    if (utxos.length === 0 && currentBalance > 0) {
      console.log(`[Wallet] No UTXOs found but balance is ${currentBalance}, waiting for sync...`);
      await delay(2000);
      utxos = await getAddressUTXOs(fromAddress);
    }
    
    if (utxos.length === 0) {
      return { 
        success: false, 
        error: `No UTXOs found. Balance: ${currentBalance} LTC. Funds may need 1 confirmation.` 
      };
    }

    console.log(`[Wallet] Using ${utxos.length} UTXOs from ${balanceData.source}`);

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000;
    const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);

    console.log(`[Wallet] Amount: ${amountSatoshi} satoshi, Fee: ${fee}, Input: ${totalInput}`);

    if (totalInput < amountSatoshi + fee) {
      return { 
        success: false, 
        error: `Insufficient balance. Have: ${(totalInput/1e8).toFixed(8)} LTC, Need: ${((amountSatoshi+fee)/1e8).toFixed(8)} LTC` 
      };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let inputSum = 0;
    let inputsAdded = 0;

    for (const utxo of utxos) {
      if (inputSum >= amountSatoshi + fee) break;
      
      try {
        await delay(100); // Small delay between fetches
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
        console.log(`[Wallet] Added input: ${utxo.txid}:${utxo.vout}`);
      } catch (err) {
        console.error(`[Wallet] Error adding input:`, err.message);
        continue;
      }
    }

    if (inputsAdded === 0) {
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
        return { success: false, error: `Signing failed: ${e.message}` };
      }
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    // Broadcast (uses node if available - INSTANT)
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

async function sendLTC(toAddress, amountLTC) {
  console.log(`[Wallet] TRADE SEND - Using INDEX 0`);
  return sendFromIndex(0, toAddress, amountLTC);
}

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

async function sendFeeToFeeWallet(feeLtc) {
  console.log(`[Wallet] Sending fee ${feeLtc} LTC from INDEX 0 to INDEX 1`);
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
  sendFeeToFeeWallet,
  getAddressBalance
};
