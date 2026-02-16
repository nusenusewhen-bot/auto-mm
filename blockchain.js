const axios = require('axios');

// Blockchair - No API token required for free tier!
const BLOCKCHAIR_BASE = 'https://api.blockchair.com/litecoin';

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;

async function getLtcPriceUSD() {
  const now = Date.now();
  if (now - priceCache.timestamp < CACHE_DURATION && priceCache.value > 0) {
    return priceCache.value;
  }

  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd',
      { timeout: 5000 }
    );
    priceCache = { value: res.data.litecoin.usd, timestamp: now };
    return priceCache.value;
  } catch (err) {
    console.error('Failed to fetch LTC price:', err.message);
    return priceCache.value || 0;
  }
}

async function checkTransactionMempool(address) {
  if (!address) return null;
  
  try {
    const res = await axios.get(
      `${BLOCKCHAIR_BASE}/dashboards/address/${address}`,
      { timeout: 10000 }
    );
    
    const data = res.data.data[address];
    if (data.transactions && data.transactions.length > 0) {
      // Get first transaction and check if unconfirmed
      const txRes = await axios.get(
        `${BLOCKCHAIR_BASE}/raw/transaction/${data.transactions[0]}`,
        { timeout: 10000 }
      );
      if (txRes.data.data && !txRes.data.data.block_id) {
        return data.transactions[0];
      }
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

async function checkPayment(address, expectedUsd) {
  try {
    const price = await getLtcPriceUSD();
    if (price === 0) {
      console.error('Cannot check payment: LTC price unavailable');
      return false;
    }

    console.log(`[Payment Check] Checking: ${address}, Expecting: $${expectedUsd}, LTC Price: $${price}`);

    const res = await axios.get(
      `${BLOCKCHAIR_BASE}/dashboards/address/${address}`,
      { timeout: 10000 }
    );

    const data = res.data.data[address];
    
    // Blockchair gives balance in satoshis
    const balanceSatoshi = data.address.balance || 0;
    const receivedSatoshi = data.address.received || 0;
    
    const balanceLtc = balanceSatoshi / 1e8;
    const receivedLtc = receivedSatoshi / 1e8;
    
    const balanceUsd = balanceLtc * price;
    const receivedUsd = receivedLtc * price;

    console.log(
      `[Payment Check] ${address}: ${balanceLtc.toFixed(8)} LTC ($${balanceUsd.toFixed(4)}) balance, ` +
      `${receivedLtc.toFixed(8)} LTC ($${receivedUsd.toFixed(4)}) total received`
    );

    // Use received amount for payment check (includes all time)
    const minAmount = expectedUsd * 0.90;
    const maxAmount = expectedUsd * 1.20;
    
    console.log(`[Payment Check] Acceptable range: $${minAmount.toFixed(4)} - $${maxAmount.toFixed(4)}, Have: $${receivedUsd.toFixed(4)}`);

    if (receivedUsd >= minAmount && receivedUsd <= maxAmount && receivedLtc > 0) {
      console.log(`[Payment Check] ✅ Payment confirmed!`);
      return true;
    }

    if (receivedUsd > maxAmount) {
      console.log(`[Payment Check] ⚠️ Overpayment detected: $${receivedUsd.toFixed(4)} > $${maxAmount.toFixed(4)}`);
      return true;
    }

    if (receivedUsd < minAmount) {
      console.log(`[Payment Check] ❌ Underpayment: $${receivedUsd.toFixed(4)} < $${minAmount.toFixed(4)}`);
    }

    console.log(`[Payment Check] ❌ Not enough funds yet`);
    return false;

  } catch (err) {
    console.error('Error checking payment:', err.message);
    return false;
  }
}

async function getAddressInfo(address) {
  try {
    const res = await axios.get(
      `${BLOCKCHAIR_BASE}/dashboards/address/${address}`,
      { timeout: 10000 }
    );
    return res.data.data[address];
  } catch (err) {
    console.error('Error fetching address info:', err.message);
    return null;
  }
}

async function getTransaction(txid) {
  try {
    const res = await axios.get(
      `${BLOCKCHAIR_BASE}/raw/transaction/${txid}`,
      { timeout: 10000 }
    );
    return res.data.data;
  } catch (err) {
    console.error('Error fetching transaction:', err.message);
    return null;
  }
}

async function getAddressUTXOs(address) {
  try {
    const res = await axios.get(
      `${BLOCKCHAIR_BASE}/outputs?q=recipient(${address}),is_spent(false)`,
      { timeout: 10000 }
    );
    
    if (res.data.data && res.data.data.length > 0) {
      return res.data.data.map(utxo => ({
        txid: utxo.transaction_hash,
        vout: utxo.index,
        value: utxo.value,
        script: utxo.script_hex
      }));
    }
    return [];
  } catch (err) {
    console.error('Error fetching UTXOs:', err.message);
    return [];
  }
}

module.exports = { checkPayment, getLtcPriceUSD, getAddressInfo, getTransaction, checkTransactionMempool, getAddressUTXOs };
