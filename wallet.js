const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');
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

let root;
let initialized = false;
let walletMnemonic = null;

const GAP_LIMIT = 100;

function initWallet(mnemonic) {
  console.log("[Wallet] Initializing wallet...");

  if (!mnemonic) {
    console.error("❌ [Wallet] No BOT_MNEMONIC set in environment");
    console.error("[Wallet] Make sure your .env file has: BOT_MNEMONIC=your twelve word phrase here");
    return false;
  }

  const cleanMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

  console.log(`[Wallet] Mnemonic length: ${cleanMnemonic.split(' ').length} words`);
  console.log(`[Wallet] First 4 words: ${cleanMnemonic.split(' ').slice(0, 4).join(' ')}...`);

  try {
    if (!bip39.validateMnemonic(cleanMnemonic)) {
      console.error("❌ [Wallet] Invalid mnemonic provided");
      return false;
    }

    const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
    root = hdkey.fromMasterSeed(seed);
    initialized = true;
    walletMnemonic = cleanMnemonic;
    
    const firstAddress = generateAddress(0);
    console.log(`✅ [Wallet] Litecoin HD wallet initialized successfully`);
    console.log(`✅ [Wallet] First address (index 0): ${firstAddress}`);

    return true;
  } catch (err) {
    console.error("❌ [Wallet] Failed to initialize wallet:", err.message);
    return false;
  }
}

function isInitialized() {
  return initialized && root !== null;
}

function generateAddress(index) {
  if (!initialized || !root) {
    console.error("[Wallet] ERROR: Wallet not initialized when generating address");
    return "WALLET_NOT_INITIALIZED";
  }

  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: child.publicKey,
      network: ltcNet
    });
    return address;
  } catch (err) {
    console.error(`[Wallet] Failed to generate address for index ${index}:`, err);
    return "ADDRESS_GENERATION_FAILED";
  }
}

function getPrivateKeyWIF(index) {
  if (!initialized || !root) {
    console.error("[Wallet] ERROR: Wallet not initialized when getting private key");
    return null;
  }

  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    const wif = bitcoin.ECPair.fromPrivateKey(child.privateKey, { network: ltcNet }).toWIF();
    return wif;
  } catch (err) {
    console.error(`[Wallet] Failed to get private key for index ${index}:`, err);
    return null;
  }
}

async function getAddressUTXOs(address) {
  if (!BLOCKCYPHER_TOKEN) {
    console.error("[Wallet] ERROR: BLOCKCYPHER_TOKEN not set");
    return [];
  }

  try {
    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}?unspentOnly=true&token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 15000 }
    );

    if (!res.data.txrefs) return [];

    return res.data.txrefs.map(utxo => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_output_n,
      value: utxo.value,
      confirmations: utxo.confirmations
    }));
  } catch (err) {
    if (err.response?.status === 429) {
      console.error(`[Wallet] Rate limit hit for address ${address}`);
    } else if (err.response?.status === 404) {
      return [];
    } else {
      console.error(`[Wallet] Error fetching UTXOs for ${address}:`, err.message);
    }
    return [];
  }
}

async function getAddressBalance(address) {
  if (!BLOCKCYPHER_TOKEN) {
    console.error("[Wallet] ERROR: BLOCKCYPHER_TOKEN not set");
    return 0;
  }

  try {
    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 10000 }
    );
    
    return (res.data.balance || 0) / 1e8;
  } catch (err) {
    if (err.response?.status === 429) {
      console.error(`[Wallet] Rate limit hit for address ${address}`);
    } else if (err.response?.status === 404) {
      return 0;
    } else {
      console.error(`[Wallet] Error fetching balance for ${address}:`, err.message);
    }
    return 0;
  }
}

async function getWalletBalance() {
  if (!isInitialized()) {
    console.error("❌ [Wallet] Cannot get balance: Wallet not initialized");
    console.error("[Wallet] Make sure BOT_MNEMONIC is set correctly in .env");
    return 0;
  }

  try {
    let totalBalance = 0;
    let checkedCount = 0;
    let lastUsedIndex = -1;
    let consecutiveEmpty = 0;
    
    console.log(`[Wallet] Starting balance scan (max ${GAP_LIMIT} addresses)...`);
    
    for (let i = 0; i < GAP_LIMIT; i++) {
      const address = generateAddress(i);
      
      if (address === "WALLET_NOT_INITIALIZED" || address === "ADDRESS_GENERATION_FAILED") {
        console.error(`[Wallet] Failed to generate address at index ${i}`);
        continue;
      }
      
      const balance = await getAddressBalance(address);
      
      if (balance > 0) {
        console.log(`[Wallet] ✅ Address ${i}: ${balance} LTC (${address})`);
        totalBalance += balance;
        lastUsedIndex = i;
        consecutiveEmpty = 0;
      } else {
        consecutiveEmpty++;
      }
      
      checkedCount++;
      
      if (consecutiveEmpty >= 20 && lastUsedIndex !== -1) {
        console.log(`[Wallet] Reached gap limit (20 empty addresses). Stopping scan at index ${i}`);
        break;
      }
    }
    
    console.log(`[Wallet] Scan complete. Checked ${checkedCount} addresses.`);
    console.log(`[Wallet] Total balance found: ${totalBalance} LTC`);
    
    if (totalBalance === 0) {
      console.log("[Wallet] ⚠️ No balance found in any address!");
      console.log("[Wallet] Make sure you have LTC in addresses derived from this mnemonic");
      console.log(`[Wallet] First few addresses to check:`);
      for (let i = 0; i < 5; i++) {
        console.log(`[Wallet]   Index ${i}: ${generateAddress(i)}`);
      }
    }
    
    return totalBalance;
  } catch (err) {
    console.error('[Wallet] Error getting wallet balance:', err.message);
    return 0;
  }
}

async function getFundedAddresses() {
  if (!isInitialized()) {
    console.error("❌ [Wallet] Cannot get funded addresses: Wallet not initialized");
    return [];
  }

  const funded = [];
  let lastUsedIndex = -1;
  let consecutiveEmpty = 0;
  
  console.log(`[Wallet] Scanning for funded addresses...`);
  
  for (let i = 0; i < GAP_LIMIT; i++) {
    const address = generateAddress(i);
    const balance = await getAddressBalance(address);
    
    if (balance > 0) {
      console.log(`[Wallet] Found funded address at index ${i}: ${address} (${balance} LTC)`);
      const utxos = await getAddressUTXOs(address);
      funded.push({
        index: i,
        address: address,
        balance: balance,
        utxos: utxos
      });
      lastUsedIndex = i;
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty++;
    }
    
    if (consecutiveEmpty >= 20 && lastUsedIndex !== -1) {
      break;
    }
  }
  
  console.log(`[Wallet] Found ${funded.length} funded addresses with total balance: ${funded.reduce((sum, f) => sum + f.balance, 0)} LTC`);
  return funded;
}

async function sendLTC(tradeId, toAddress, amountLTC) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  if (!BLOCKCYPHER_TOKEN) {
    return { success: false, error: 'BLOCKCYPHER_TOKEN not configured' };
  }

  try {
    const fromAddress = generateAddress(tradeId);
    const wif = getPrivateKeyWIF(tradeId);

    if (!wif) {
      return { success: false, error: 'Could not derive private key' };
    }

    const utxos = await getAddressUTXOs(fromAddress);
    if (utxos.length === 0) {
      return { success: false, error: 'No UTXOs found (insufficient balance)' };
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000;
    const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);

    if (totalInput < amountSatoshi + fee) {
      return { success: false, error: `Insufficient balance. Have: ${totalInput / 1e8}, Need: ${(amountSatoshi + fee) / 1e8}` };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });

    let inputSum = 0;
    for (const utxo of utxos) {
      if (inputSum >= amountSatoshi + fee) break;

      try {
        const txRes = await axios.get(
          `https://api.blockcypher.com/v1/ltc/main/txs/${utxo.txid}?token=${BLOCKCYPHER_TOKEN}`,
          { timeout: 10000 }
        );

        const tx = txRes.data;
        const output = tx.outputs[utxo.vout];

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
        console.error('[Wallet] Error fetching TX:', err.message);
        continue;
      }
    }

    psbt.addOutput({
      address: toAddress,
      value: amountSatoshi
    });

    const change = inputSum - amountSatoshi - fee;
    if (change > 546) {
      psbt.addOutput({
        address: fromAddress,
        value: change
      });
    }

    const keyPair = bitcoin.ECPair.fromWIF(wif, ltcNet);
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
      } catch (err) {
        console.error(`[Wallet] Error signing input ${i}:`, err.message);
      }
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    const broadcastRes = await axios.post(
      `https://api.blockcypher.com/v1/ltc/main/txs/push?token=${BLOCKCYPHER_TOKEN}`,
      { tx: txHex },
      { timeout: 15000 }
    );

    return {
      success: true,
      txid: broadcastRes.data.tx.hash
    };

  } catch (err) {
    console.error('[Wallet] Send LTC error:', err);
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

async function sendAllLTC(toAddress) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  if (!BLOCKCYPHER_TOKEN) {
    return { success: false, error: 'BLOCKCYPHER_TOKEN not configured' };
  }

  try {
    console.log(`[Wallet] Starting sendAllLTC to ${toAddress}`);
    const fundedAddresses = await getFundedAddresses();
    
    if (fundedAddresses.length === 0) {
      return { success: false, error: 'No funded addresses found' };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let totalInput = 0;
    const fee = 10000;

    for (const funded of fundedAddresses) {
      for (const utxo of funded.utxos) {
        try {
          const txRes = await axios.get(
            `https://api.blockcypher.com/v1/ltc/main/txs/${utxo.txid}?token=${BLOCKCYPHER_TOKEN}`,
            { timeout: 10000 }
          );

          const tx = txRes.data;
          const output = tx.outputs[utxo.vout];

          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: Buffer.from(output.script, 'hex'),
              value: utxo.value
            }
          });

          totalInput += utxo.value;
        } catch (err) {
          console.error(`[Wallet] Error fetching TX for UTXO ${utxo.txid}:`, err.message);
          continue;
        }
      }
    }

    if (psbt.inputCount === 0) {
      return { success: false, error: 'Could not add any inputs' };
    }

    const amountToSend = totalInput - fee;
    if (amountToSend <= 0) {
      return { success: false, error: 'Insufficient balance to cover fees' };
    }

    psbt.addOutput({
      address: toAddress,
      value: amountToSend
    });

    let inputIndex = 0;
    for (const funded of fundedAddresses) {
      const wif = getPrivateKeyWIF(funded.index);
      
      if (!wif) {
        console.error(`[Wallet] Could not get WIF for index ${funded.index}`);
        continue;
      }

      const keyPair = bitcoin.ECPair.fromWIF(wif, ltcNet);
      
      for (let i = 0; i < funded.utxos.length; i++) {
        try {
          psbt.signInput(inputIndex, keyPair);
          inputIndex++;
        } catch (err) {
          console.error(`[Wallet] Error signing input ${inputIndex}:`, err.message);
          inputIndex++;
        }
      }
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    const broadcastRes = await axios.post(
      `https://api.blockcypher.com/v1/ltc/main/txs/push?token=${BLOCKCYPHER_TOKEN}`,
      { tx: txHex },
      { timeout: 15000 }
    );

    console.log(`[Wallet] Successfully sent ${(amountToSend / 1e8).toFixed(8)} LTC`);
    
    return {
      success: true,
      txid: broadcastRes.data.tx.hash,
      amountSent: (amountToSend / 1e8).toFixed(8)
    };

  } catch (err) {
    console.error('[Wallet] Send All LTC error:', err);
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

async function sendLTCMicrotx(tradeId, toAddress, amountLTC) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  if (!BLOCKCYPHER_TOKEN) {
    return { success: false, error: 'BLOCKCYPHER_TOKEN not configured' };
  }

  try {
    const fromAddress = generateAddress(tradeId);
    const wif = getPrivateKeyWIF(tradeId);

    if (!wif) {
      return { success: false, error: 'Could not derive private key' };
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);

    const res = await axios.post(
      `https://api.blockcypher.com/v1/ltc/main/txs/micro?token=${BLOCKCYPHER_TOKEN}`,
      {
        from_address: fromAddress,
        to_address: toAddress,
        value_satoshis: amountSatoshi,
        private_key: wif
      },
      { timeout: 30000 }
    );

    return {
      success: true,
      txid: res.data.tx.hash
    };

  } catch (err) {
    console.error('[Wallet] Microtx error:', err.response?.data || err.message);
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

module.exports = { 
  initWallet, 
  isInitialized,
  generateAddress, 
  getPrivateKeyWIF, 
  sendLTC, 
  sendLTCMicrotx,
  getWalletBalance,
  getAddressBalance,
  getFundedAddresses,
  sendAllLTC
};
