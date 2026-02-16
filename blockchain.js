const axios = require('axios');

const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN;
const BLOCKCYPHER_BASE = 'https://api.blockcypher.com/v1/ltc/main';

if (!BLOCKCYPHER_TOKEN) {
  console.warn('⚠️ BLOCKCYPHER_TOKEN not set');
}

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
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}?token=${BLOCKCYPHER_TOKEN}`;
    const res = await axios.get(url, { timeout: 10000 });
    
    if (res.data.unconfirmed_n_tx > 0 && res.data.unconfirmed_txrefs?.length > 0) {
      return res.data.unconfirmed_txrefs[0].tx_hash;
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function checkPayment(address, expectedUsd) {
  try {
    const price = await getLtcPriceUSD();
    if (price === 0) return false;

    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`;
    const res = await axios.get(url, { timeout: 10000 });

    const confirmedLtc = (res.data.balance || 0) / 1e8;
    const unconfirmedLtc = (res.data.unconfirmed_balance || 0) / 1e8;
    const totalLtc = confirmedLtc + unconfirmedLtc;
    const totalUsd = totalLtc * price;

    const minAmount = expectedUsd * 0.90;
    const maxAmount = expectedUsd * 1.20;

    if (totalUsd >= minAmount && totalLtc > 0) return true;
    if (totalUsd > maxAmount) return true;
    return false;

  } catch (err) {
    console.error('Error checking payment:', err.message);
    return false;
  }
}

async function getAddressInfo(address) {
  try {
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}/balance?token=${BLOCKCYPHER_TOKEN}`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch (err) {
    console.error('Error fetching address info:', err.message);
    return null;
  }
}

async function getTransaction(txid) {
  try {
    const url = `${BLOCKCYPHER_BASE}/txs/${txid}?token=${BLOCKCYPHER_TOKEN}`;
    const res = await axios.get(url, { timeout: 10000 });
    return res.data;
  } catch (err) {
    console.error('Error fetching transaction:', err.message);
    return null;
  }
}

async function getAddressUTXOs(address) {
  try {
    const url = `${BLOCKCYPHER_BASE}/addrs/${address}?unspentOnly=true&token=${BLOCKCYPHER_TOKEN}`;
    const res = await axios.get(url, { timeout: 10000 });
    
    if (res.data.txrefs) {
      return res.data.txrefs.map(utxo => ({
        txid: utxo.tx_hash,
        vout: utxo.tx_output_n,
        value: utxo.value,
        script: utxo.script
      }));
    }
    return [];
  } catch (err) {
    console.error('Error fetching UTXOs:', err.message);
    return [];
  }
}

module.exports = { checkPayment, getLtcPriceUSD, getAddressInfo, getTransaction, checkTransactionMempool, getAddressUTXOs };
