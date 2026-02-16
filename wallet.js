const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');

const ECPair = ECPairFactory(tinysecp);

// Litecoin network
const ltcNetwork = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: {
    public: 0x019da462,
    private: 0x019d9cfe,
  },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;
const FEE_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';

// ============================================
// INDEX 0 ONLY - NO EXCEPTIONS
// ============================================

// Get wallet at INDEX 0 ONLY
function getWalletAtIndex0() {
  const mnemonic = process.env.WALLET_MNEMONIC;
  if (!mnemonic) {
    throw new Error('WALLET_MNEMONIC not set in .env');
  }
  
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = hdkey.fromMasterSeed(seed);
  
  // ONLY INDEX 0 - HARD CODED
  const path = `m/84'/2'/0'/0/0`;
  const child = root.derive(path);
  
  const keyPair = ECPair.fromPrivateKey(child.privateKey);
  const { address } = bitcoin.payments.p2wpkh({ 
    pubkey: keyPair.publicKey, 
    network: ltcNetwork 
  });

  return {
    address,
    privateKey: keyPair.toWIF(),
    publicKey: keyPair.publicKey.toString('hex'),
    keyPair,
    index: 0
  };
}

// Get ONLY index 0 address
function getAddress() {
  const wallet = getWalletAtIndex0();
  return wallet.address;
}

// Get balance at INDEX 0 ONLY
async function getBalance() {
  const address = getAddress();
  
  try {
    const response = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 30000 }
    );
    
    // Convert from satoshis to LTC
    const balanceLTC = response.data.balance / 100000000;
    const unconfirmedLTC = response.data.unconfirmed_balance / 100000000;
    const finalBalanceLTC = response.data.final_balance / 100000000;
    
    return {
      confirmed: balanceLTC,
      unconfirmed: unconfirmedLTC,
      total: finalBalanceLTC,
      address: address,
      index: 0
    };
  } catch (error) {
    console.error('Balance check error:', error.response?.data || error.message);
    return {
      confirmed: 0,
      unconfirmed: 0,
      total: 0,
      address: address,
      index: 0
    };
  }
}

// Get UTXOs at INDEX 0 ONLY
async function getUTXOs() {
  const address = getAddress();
  
  try {
    const response = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}?unspentOnly=true&token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 30000 }
    );

    if (!response.data.txrefs || response.data.txrefs.length === 0) {
      return [];
    }

    return response.data.txrefs.map(utxo => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_output_n,
      value: utxo.value,
      confirmations: utxo.confirmations
    }));
  } catch (error) {
    console.error('UTXO fetch error:', error.response?.data || error.message);
    return [];
  }
}

// Send ALL LTC from INDEX 0 ONLY
async function sendAllLTC(toAddress, feeLTC = 0.001) {
  const wallet = getWalletAtIndex0();
  const fromAddress = wallet.address;
  
  console.log(`[Wallet] Sending from INDEX 0: ${fromAddress}`);
  
  try {
    // Get UTXOs for INDEX 0 ONLY
    const utxos = await getUTXOs();
    
    if (utxos.length === 0) {
      throw new Error('No UTXOs found at index 0');
    }

    const balanceSatoshi = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
    const balanceLTC = balanceSatoshi / 100000000;

    console.log(`[Wallet] Balance at index 0: ${balanceLTC} LTC`);

    if (balanceLTC <= feeLTC) {
      throw new Error(`Insufficient balance. Have: ${balanceLTC} LTC, need fee: ${feeLTC} LTC`);
    }

    const amountToSendSatoshi = balanceSatoshi - Math.floor(feeLTC * 100000000);

    if (amountToSendSatoshi <= 0) {
      throw new Error('Amount to send is too small after fee');
    }

    // Build transaction
    const psbt = new bitcoin.Psbt({ network: ltcNetwork });

    let totalInput = 0;
    for (const utxo of utxos) {
      // Fetch full transaction for nonWitnessUtxo
      const txResponse = await axios.get(
        `https://api.blockcypher.com/v1/ltc/main/txs/${utxo.txid}?token=${BLOCKCYPHER_TOKEN}`,
        { timeout: 30000 }
      );
      
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(txResponse.data.hex, 'hex'),
        witnessUtxo: {
          script: bitcoin.address.toOutputScript(fromAddress, ltcNetwork),
          value: utxo.value,
        },
      });
      totalInput += utxo.value;
    }

    // Add output
    psbt.addOutput({
      address: toAddress,
      value: amountToSendSatoshi,
    });

    // Sign ALL inputs with INDEX 0 key
    for (let i = 0; i < utxos.length; i++) {
      psbt.signInput(i, wallet.keyPair);
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    console.log(`[Wallet] Broadcasting transaction...`);

    // Broadcast
    const broadcastResponse = await axios.post(
      `https://api.blockcypher.com/v1/ltc/main/txs/push?token=${BLOCKCYPHER_TOKEN}`,
      { tx: txHex },
      { timeout: 30000 }
    );

    console.log(`[Wallet] Transaction broadcasted: ${broadcastResponse.data.hash}`);

    return {
      success: true,
      txHash: broadcastResponse.data.hash,
      amount: amountToSendSatoshi / 100000000,
      fee: feeLTC,
      from: fromAddress,
      to: toAddress,
      index: 0
    };

  } catch (error) {
    console.error('[Wallet] Send error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error || error.message);
  }
}

// Send specific amount from INDEX 0
async function sendLTC(toAddress, amountLTC, feeLTC = 0.001) {
  const wallet = getWalletAtIndex0();
  const fromAddress = wallet.address;
  
  console.log(`[Wallet] Sending ${amountLTC} LTC from INDEX 0: ${fromAddress}`);
  
  try {
    const utxos = await getUTXOs();
    
    if (utxos.length === 0) {
      throw new Error('No UTXOs found at index 0');
    }

    const amountSatoshi = Math.floor(amountLTC * 100000000);
    const feeSatoshi = Math.floor(feeLTC * 100000000);
    const totalNeeded = amountSatoshi + feeSatoshi;

    // Select UTXOs
    let selectedUtxos = [];
    let selectedAmount = 0;
    
    for (const utxo of utxos) {
      selectedUtxos.push(utxo);
      selectedAmount += utxo.value;
      if (selectedAmount >= totalNeeded) break;
    }

    if (selectedAmount < totalNeeded) {
      throw new Error(`Insufficient balance. Have: ${selectedAmount / 100000000} LTC, need: ${totalNeeded / 100000000} LTC`);
    }

    // Build transaction
    const psbt = new bitcoin.Psbt({ network: ltcNetwork });

    for (const utxo of selectedUtxos) {
      const txResponse = await axios.get(
        `https://api.blockcypher.com/v1/ltc/main/txs/${utxo.txid}?token=${BLOCKCYPHER_TOKEN}`,
        { timeout: 30000 }
      );
      
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(txResponse.data.hex, 'hex'),
        witnessUtxo: {
          script: bitcoin.address.toOutputScript(fromAddress, ltcNetwork),
          value: utxo.value,
        },
      });
    }

    // Add recipient output
    psbt.addOutput({
      address: toAddress,
      value: amountSatoshi,
    });

    // Add change output if needed
    const change = selectedAmount - totalNeeded;
    if (change > 546) { // Dust threshold
      psbt.addOutput({
        address: fromAddress,
        value: change,
      });
    }

    // Sign with INDEX 0 key
    for (let i = 0; i < selectedUtxos.length; i++) {
      psbt.signInput(i, wallet.keyPair);
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    // Broadcast
    const broadcastResponse = await axios.post(
      `https://api.blockcypher.com/v1/ltc/main/txs/push?token=${BLOCKCYPHER_TOKEN}`,
      { tx: txHex },
      { timeout: 30000 }
    );

    return {
      success: true,
      txHash: broadcastResponse.data.hash,
      amount: amountLTC,
      fee: feeLTC,
      from: fromAddress,
      to: toAddress,
      change: change > 546 ? change / 100000000 : 0,
      index: 0
    };

  } catch (error) {
    console.error('[Wallet] Send error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error || error.message);
  }
}

// Send fee to your address from INDEX 0
async function sendFeeToAddress(feeLTC = 0.001) {
  return await sendAllLTC(FEE_ADDRESS, feeLTC);
}

// Get transaction history for INDEX 0
async function getTransactions() {
  const address = getAddress();
  
  try {
    const response = await axios.get(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/full?token=${BLOCKCYPHER_TOKEN}`,
      { timeout: 30000 }
    );
    
    return response.data.txs || [];
  } catch (error) {
    console.error('Transaction history error:', error.response?.data || error.message);
    return [];
  }
}

// Get private key for INDEX 0 (for backup)
function getPrivateKey() {
  const wallet = getWalletAtIndex0();
  return wallet.privateKey;
}

// Validate LTC address
function validateAddress(address) {
  try {
    bitcoin.address.toOutputScript(address, ltcNetwork);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  getAddress,
  getBalance,
  getUTXOs,
  sendAllLTC,
  sendLTC,
  sendFeeToAddress,
  getTransactions,
  getPrivateKey,
  validateAddress,
  getWalletAtIndex0,
  FEE_ADDRESS
};
