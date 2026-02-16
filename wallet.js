const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');
const ECPairFactory = require('ecpair').ECPairFactory; // ✅ FIX
const tinysecp = require('tiny-secp256k1');              // ✅ FIX

const ECPair = ECPairFactory(tinysecp); // ✅ FIX: use ECPairFactory

const axios = require('axios');

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;

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
    const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: ltcNet }); // ✅ FIX
    return keyPair.toWIF();
  } catch (err) {
    console.error(`[Wallet] Failed to get private key for index ${index}:`, err.message);
    return null;
  }
}

async function getAddressBalance(address) {
  if (!BLOCKCYPHER_TOKEN) {
    console.error("[Wallet] BLOCKCYPHER_TOKEN not set");
    return 0;
  }
  
  if (!address) return 0;
  
  if (balanceCache.has(address)) {
    return balanceCache.get(address);
  }

  try {
    await delay(1000);
    
    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 15000 }
    );
    
    const balance = (res.data.balance || 0) / 1e8;
    balanceCache.set(address, balance);
    return balance;
  } catch (err) {
    if (err.response?.status === 429) {
      console.error(`[Wallet] Rate limit hit, waiting 10s...`);
      await delay(10000);
      try {
        const res = await axios.get(
          `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`,
          { timeout: 15000 }
        );
        const balance = (res.data.balance || 0) / 1e8;
        balanceCache.set(address, balance);
        return balance;
      } catch {
        return 0;
      }
    }
    return 0;
  }
}

async function getAddressUTXOs(address) {
  if (!BLOCKCYPHER_TOKEN || !address) return [];
  
  try {
    await delay(1000);
    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}?unspentOnly=true&token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 15000 }
    );
    if (!res.data.txrefs) return [];
    return res.data.txrefs.map(utxo => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_output_n,
      value: utxo.value
    }));
  } catch (err) {
    return [];
  }
}

async function getBalanceAtIndex(index) {
  if (!isInitialized()) {
    console.error("[Wallet] Cannot get balance: not initialized");
    return 0;
  }
  
  const address = generateAddress(index);
  if (!address) return 0;
  
  return await getAddressBalance(address);
}

async function getWalletBalance() {
  if (!isInitialized()) return 0;
  
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const balance = await getBalanceAtIndex(i);
    if (balance > 0) {
      console.log(`[Wallet] Index ${i}: ${balance} LTC`);
      total += balance;
    }
  }
  return total;
}

async function sendFromIndex(index, toAddress, amountLTC) {
  console.log(`[Wallet] sendFromIndex called: index=${index}, to=${toAddress}, amount=${amountLTC}`);
  console.log(`[Wallet] isInitialized=${isInitialized()}, root=${root ? 'exists' : 'null'}`);
  
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  if (!BLOCKCYPHER_TOKEN) {
    return { success: false, error: 'BLOCKCYPHER_TOKEN not configured' };
  }

  const fromAddress = generateAddress(index);
  const wif = getPrivateKeyWIF(index);
  
  console.log(`[Wallet] fromAddress=${fromAddress}, wif=${wif ? 'exists' : 'null'}`);

  if (!fromAddress || !wif) {
    return { success: false, error: 'Could not derive private key or address' };
  }

  try {
    const utxos = await getAddressUTXOs(fromAddress);
    console.log(`[Wallet] Found ${utxos.length} UTXOs`);
    
    if (utxos.length === 0) {
      return { success: false, error: 'No UTXOs found (insufficient balance)' };
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000;
    const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);

    console.log(`[Wallet] amountSatoshi=${amountSatoshi}, fee=${fee}, totalInput=${totalInput}`);

    if (totalInput < amountSatoshi + fee) {
      return { success: false, error: `Insufficient balance. Have: ${totalInput / 1e8} LTC` };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let inputSum = 0;

    for (const utxo of utxos) {
      if (inputSum >= amountSatoshi + fee) break;
      try {
        await delay(1000);
        const txRes = await axios.get(
          `https://api.blockcypher.com/v1/ltc/main/txs/${utxo.txid}?token=${BLOCKCYPHER_TOKEN}`,
          { timeout: 10000 }
        );
        const output = txRes.data.outputs[utxo.vout];
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: { 
            script: Buffer.from(output.script, 'hex'), 
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

    const keyPair = ECPair.fromWIF(wif, ltcNet); // ✅ FIX
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
      `https://api.blockcypher.com/v1/ltc/main/txs/push?token=${BLOCKCYPHER_TOKEN}`,
      { tx: txHex }, 
      { timeout: 15000 }
    );

    console.log(`[Wallet] Transaction broadcasted: ${broadcastRes.data.tx.hash}`);

    return { 
      success: true, 
      txid: broadcastRes.data.tx.hash,
      amountSent: (amountSatoshi / 1e8).toFixed(8)
    };

  } catch (err) {
    console.error('[Wallet] Send error:', err);
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

async function sendLTC(tradeId, toAddress, amountLTC) {
  return sendFromIndex(tradeId, toAddress, amountLTC);
}

async function sendAllLTC(toAddress, specificIndex = null) {
  console.log(`[Wallet] sendAllLTC called: to=${toAddress}, index=${specificIndex}`);
  console.log(`[Wallet] isInitialized=${isInitialized()}`);
  
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }
  
  let indexToUse = specificIndex;
  
  if (indexToUse === null) {
    console.log(`[Wallet] Searching for funds...`);
    for (let i = 0; i < 10; i++) {
      const balance = await getBalanceAtIndex(i);
      if (balance > 0) {
        indexToUse = i;
        console.log(`[Wallet] Found funds at index ${i}: ${balance} LTC`);
        break;
      }
    }
  }
  
  if (indexToUse === null) {
    return { success: false, error: 'No funded addresses found' };
  }
  
  const balance = await getBalanceAtIndex(indexToUse);
  if (balance <= 0) {
    return { success: false, error: 'No balance at specified index' };
  }
  
  const amountToSend = Math.max(0, balance - 0.0001);
  console.log(`[Wallet] Sending ${amountToSend} LTC from index ${indexToUse}`);
  
  return await sendFromIndex(indexToUse, toAddress, amountToSend.toFixed(8));
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
  sendAllLTC 
};
