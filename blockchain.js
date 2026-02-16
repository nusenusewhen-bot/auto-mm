const axios = require('axios');

// SoChain - No API token required!
const SOCHAIN_BASE = 'https://sochain.com/api/v2';

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
      `${SOCHAIN_BASE}/address/LTC/${address}`,
      { timeout: 10000 }
    );
    
    const data = res.data.data;
    if (data.txs && data.txs.length > 0) {
      for (const tx of data.txs) {
        if (tx.confirmations === 0) {
          return tx.txid;
        }
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
      `${SOCHAIN_BASE}/address/LTC/${address}`,
      { timeout: 10000 }
    );

    const data = res.data.data;
    
    const confirmedLtc = parseFloat(data.balance) || 0;
    const unconfirmedLtc = parseFloat(data.unconfirmed_balance) || 0;
    const totalLtc = confirmedLtc + unconfirmedLtc;
    
    const confirmedUsd = confirmedLtc * price;
    const unconfirmedUsd = unconfirmedLtc * price;
    const totalUsd = confirmedUsd + unconfirmedUsd;

    console.log(
      `[Payment Check] ${address}: ${confirmedLtc.toFixed(8)} LTC ($${confirmedUsd.toFixed(4)}) confirmed + ` +
      `${unconfirmedLtc.toFixed(8)} LTC ($${unconfirmedUsd.toFixed(4)}) unconfirmed = ` +
      `${totalLtc.toFixed(8)} LTC ($${totalUsd.toFixed(4)}) total`
    );

    const minAmount = expectedUsd * 0.90;
    const maxAmount = expectedUsd * 1.20;
    
    console.log(`[Payment Check] Acceptable range: $${minAmount.toFixed(4)} - $${maxAmount.toFixed(4)}, Have: $${totalUsd.toFixed(4)}`);

    if (totalUsd >= minAmount && totalUsd <= maxAmount && totalLtc > 0) {
      console.log(`[Payment Check] ✅ Payment confirmed!`);
      return true;
    }

    if (totalUsd > maxAmount) {
      console.log(`[Payment Check] ⚠️ Overpayment detected: $${totalUsd.toFixed(4)} > $${maxAmount.toFixed(4)}`);
      return true;
    }

    if (totalUsd < minAmount) {
      console.log(`[Payment Check] ❌ Underpayment: $${totalUsd.toFixed(4)} < $${minAmount.toFixed(4)}`);
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
      `${SOCHAIN_BASE}/address/LTC/${address}`,
      { timeout: 10000 }
    );
    return res.data.data;
  } catch (err) {
    console.error('Error fetching address info:', err.message);
    return null;
  }
}

async function getTransaction(txid) {
  try {
    const res = await axios.get(
      `${SOCHAIN_BASE}/transaction/LTC/${txid}`,
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
      `${SOCHAIN_BASE}/unspent/LTC/${address}`,
      { timeout: 10000 }
    );
    
    if (res.data.data && res.data.data.txs) {
      return res.data.data.txs.map(utxo => ({
        txid: utxo.txid,
        vout: utxo.output_no,
        value: Math.floor(parseFloat(utxo.value) * 1e8),
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
