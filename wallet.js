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

// BIP44 gap limit is 20, but we'll scan more to be safe
const GAP_LIMIT = 100;  // Increased from 20 to catch more addresses

function initWallet(mnemonic) {
  if (!mnemonic) {
    console.error("❌ No BOT_MNEMONIC set in environment");
    return false;
  }

  try {
    if (!bip39.validateMnemonic(mnemonic)) {
      console.error("❌ Invalid mnemonic provided");
      return false;
    }

    const seed = bip39.mnemonicToSeedSync(mnemonic);
    root = hdkey.fromMasterSeed(seed);
    initialized = true;
    console.log("✅ Litecoin HD wallet initialized");
    return true;
  } catch (err) {
    console.error("❌ Failed to initialize wallet:", err.message);
    return false;
  }
}

function generateAddress(index) {
  if (!initialized || !root) {
    console.error("Wallet not initialized");
    return "WALLET_NOT_LOADED";
  }

  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: child.publicKey,
      network: ltcNet
    });
    return address;
  } catch (err) {
    console.error(`Failed to generate address for index ${index}:`, err);
    return "ADDRESS_GENERATION_FAILED";
  }
}

function getPrivateKeyWIF(index) {
  if (!initialized || !root) return null;

  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    const wif = bitcoin.ECPair.fromPrivateKey(child.privateKey, { network: ltcNet }).toWIF();
    return wif;
  } catch (err) {
    console.error(`Failed to get private key for index ${index}:`, err);
    return null;
  }
}

async function getAddressUTXOs(address) {
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
    console.error('Error fetching UTXOs:', err.message);
    return [];
  }
}

async function getAddressBalance(address) {
  try {
    const res = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 10000 }
    );
    
    // Return confirmed balance (in LTC, not satoshi)
    return (res.data.balance || 0) / 1e8;
  } catch (err) {
    console.error('Error fetching address balance:', err.message);
    return 0;
  }
}

async function getWalletBalance() {
  if (!initialized || !root) {
    console.error("Wallet not initialized");
    return 0;
  }

  try {
    let totalBalance = 0;
    let checkedCount = 0;
    let lastUsedIndex = -1;
    
    console.log(`[Balance Check] Scanning up to ${GAP_LIMIT} addresses...`);
    
    // Check addresses until we hit GAP_LIMIT empty addresses in a row
    for (let i = 0; i < GAP_LIMIT; i++) {
      const address = generateAddress(i);
      const balance = await getAddressBalance(address);
      
      if (balance > 0) {
        console.log(`[Balance Check] Address ${i} (${address}): ${balance} LTC`);
        totalBalance += balance;
        lastUsedIndex = i;
      }
      
      checkedCount++;
      
      // BIP44 gap limit: stop if we've checked 20 empty addresses after the last used one
      if (i > lastUsedIndex + 20 && lastUsedIndex !== -1) {
        console.log(`[Balance Check] Reached gap limit (20 empty after last used). Stopping at index ${i}`);
        break;
      }
    }
    
    console.log(`[Balance Check] Checked ${checkedCount} addresses. Total balance: ${totalBalance} LTC`);
    return totalBalance;
  } catch (err) {
    console.error('Error getting wallet balance:', err.message);
    return 0;
  }
}

async function getFundedAddresses() {
  if (!initialized || !root) {
    return [];
  }

  const funded = [];
  let lastUsedIndex = -1;
  
  console.log(`[Funded Addresses] Scanning up to ${GAP_LIMIT} addresses...`);
  
  for (let i = 0; i < GAP_LIMIT; i++) {
    const address = generateAddress(i);
    const balance = await getAddressBalance(address);
    
    if (balance > 0) {
      console.log(`[Funded Addresses] Found funded address at index ${i}: ${address} (${balance} LTC)`);
      const utxos = await getAddressUTXOs(address);
      funded.push({
        index: i,
        address: address,
        balance: balance,
        utxos: utxos
      });
      lastUsedIndex = i;
    }
    
    // BIP44 gap limit
    if (i > lastUsedIndex + 20 && lastUsedIndex !== -1) {
      console.log(`[Funded Addresses] Reached gap limit. Stopping at index ${i}`);
      break;
    }
  }
  
  console.log(`[Funded Addresses] Found ${funded.length} funded addresses`);
  return funded;
}

async function sendLTC(tradeId, toAddress, amountLTC) {
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
        console.error('Error fetching TX:', err.message);
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
        console.error(`Error signing input ${i}:`, err.message);
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
    console.error('Send LTC error:', err);
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

async function sendAllLTC(toAddress) {
  if (!BLOCKCYPHER_TOKEN) {
    return { success: false, error: 'BLOCKCYPHER_TOKEN not configured' };
  }

  try {
    const fundedAddresses = await getFundedAddresses();
    
    if (fundedAddresses.length === 0) {
      return { success: false, error: 'No funded addresses found' };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let totalInput = 0;
    const fee = 10000; // Base fee, might need adjustment for multiple inputs

    // Add inputs from all funded addresses
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
          console.error(`Error fetching TX for UTXO ${utxo.txid}:`, err.message);
          continue;
        }
      }
    }

    if (psbt.inputCount === 0) {
      return { success: false, error: 'Could not add any inputs' };
    }

    // Calculate amount to send (total - fee)
    const amountToSend = totalInput - fee;
    if (amountToSend <= 0) {
      return { success: false, error: 'Insufficient balance to cover fees' };
    }

    // Add output to destination
    psbt.addOutput({
      address: toAddress,
      value: amountToSend
    });

    // Sign all inputs with their respective keys
    let inputIndex = 0;
    for (const funded of fundedAddresses) {
      const wif = getPrivateKeyWIF(funded.index);
      
      if (!wif) {
        console.error(`Could not get WIF for index ${funded.index}`);
        continue;
      }

      const keyPair = bitcoin.ECPair.fromWIF(wif, ltcNet);
      
      // Sign all inputs for this address
      for (let i = 0; i < funded.utxos.length; i++) {
        try {
          psbt.signInput(inputIndex, keyPair);
          inputIndex++;
        } catch (err) {
          console.error(`Error signing input ${inputIndex}:`, err.message);
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

    return {
      success: true,
      txid: broadcastRes.data.tx.hash,
      amountSent: (amountToSend / 1e8).toFixed(8)
    };

  } catch (err) {
    console.error('Send All LTC error:', err);
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

async function sendLTCMicrotx(tradeId, toAddress, amountLTC) {
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
    console.error('Microtx error:', err.response?.data || err.message);
    return { success: false, error: err.response?.data?.error || err.message };
  }
}

module.exports = { 
  initWallet, 
  generateAddress, 
  getPrivateKeyWIF, 
  sendLTC, 
  sendLTCMicrotx,
  getWalletBalance,
  getAddressBalance,
  getFundedAddresses,
  sendAllLTC
};
