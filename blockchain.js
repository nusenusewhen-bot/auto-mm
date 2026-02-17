const axios = require('axios');
const { 
  isNodeConfigured,
  getAddressBalanceNode, 
  getAddressUTXOsNode, 
  getTransactionHexNode,
  broadcastTransactionNode,
  isNodeSynced,
  getMempoolForAddress
} = require('./litecoin-node');

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// PRIMARY: Your own node (super fast, no limits)
async function getAddressBalance(address, forceRefresh = false) {
  console.log(`[Balance] Checking ${address}`);
  
  // Try your own node first (instant, no rate limit)
  if (isNodeConfigured()) {
    const nodeSynced = await isNodeSynced();
    if (nodeSynced) {
      console.log(`[Balance] Using OWN NODE (fast)...`);
      const nodeResult = await getAddressBalanceNode(address);
      if (nodeResult) {
        console.log(`[Balance] Node: ${nodeResult.total} LTC (${nodeResult.confirmed} confirmed, ${nodeResult.unconfirmed} unconfirmed)`);
        return nodeResult;
      }
    }
  }
  
  console.error(`[Balance] Node not available or not synced!`);
  return { confirmed: 0, unconfirmed: 0, total: 0, source: 'none' };
}

// Get UTXOs - Node only
async function getAddressUTXOs(address) {
  console.log(`[UTXO] Fetching for ${address}`);
  
  // Try own node first (instant)
  if (isNodeConfigured()) {
    const nodeSynced = await isNodeSynced();
    if (nodeSynced) {
      const nodeUTXOs = await getAddressUTXOsNode(address);
      console.log(`[UTXO] Node found ${nodeUTXOs.length} UTXOs (INSTANT)`);
      return nodeUTXOs;
    }
  }
  
  console.error(`[UTXO] Node not available!`);
  return [];
}

// Get transaction hex - Node only
async function getTransactionHex(txid) {
  // Try node first (instant)
  if (isNodeConfigured()) {
    const nodeHex = await getTransactionHexNode(txid);
    if (nodeHex) return nodeHex;
  }
  
  console.error(`[GetTx] Node not available for tx ${txid}`);
  return null;
}

// Broadcast - Node only
async function broadcastTransaction(txHex) {
  // Try node first (instant confirmation)
  if (isNodeConfigured()) {
    const nodeResult = await broadcastTransactionNode(txHex);
    if (nodeResult.success) {
      console.log(`[Broadcast] Sent via OWN NODE (instant)`);
      return nodeResult;
    }
  }
  
  console.error(`[Broadcast] Node not available!`);
  return { success: false, error: 'Node not available' };
}

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
    return priceCache.value || 0;
  }
}

async function checkTransactionMempool(address) {
  if (!address) return null;
  
  // Try node first
  if (isNodeConfigured()) {
    try {
      const mempool = await getMempoolForAddress(address);
      if (mempool && mempool.length > 0) {
        return mempool[0].txid;
      }
      
      // Also check unconfirmed balance
      const balance = await getAddressBalanceNode(address);
      if (balance.unconfirmed > 0) {
        // Has unconfirmed balance, try to find the tx
        const utxos = await getAddressUTXOsNode(address);
        const unconfirmedUtxo = utxos.find(u => u.confirmations === 0);
        if (unconfirmedUtxo) return unconfirmedUtxo.txid;
      }
    } catch (e) {
      console.error('[Mempool] Node check failed:', e.message);
    }
  }
  
  return null;
}

module.exports = {
  getAddressBalance,
  getAddressUTXOs,
  getTransactionHex,
  broadcastTransaction,
  getLtcPriceUSD,
  checkTransactionMempool,
  delay
};
