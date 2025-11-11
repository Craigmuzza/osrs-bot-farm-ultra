const fs = require('fs');
const path = require('path');

/**
 * Parse Bank Wealth plugin data
 * Reads bank value and coin data from custom RuneLite plugin
 */
class BankWealthParser {
  constructor() {
    this.bankWealthDir = path.join(
      process.env.USERPROFILE || process.env.HOME,
      '.runelite',
      'bank-wealth'
    );
  }

  /**
   * Get bank wealth info for a specific RSN
   * Returns the latest entry with total bank value and coins
   */
  getBankWealth(rsn) {
    try {
      const filePath = path.join(this.bankWealthDir, `${rsn}.json`);
      
      if (!fs.existsSync(filePath)) {
        console.log(`[BankWealth] No file found for RSN: ${rsn}`);
        return null;
      }

      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      if (!data.entries || data.entries.length === 0) {
        console.log(`[BankWealth] No entries found for RSN: ${rsn}`);
        return null;
      }

      // Get the latest entry (last in array)
      const latestEntry = data.entries[data.entries.length - 1];

      // Calculate total bank value (bank GE value + inventory coins)
      const totalBankValue = latestEntry.bank_ge_value + latestEntry.inventory_coins;

      // Total coins = bank coins + inventory coins
      const totalCoins = latestEntry.bank_coins + latestEntry.inventory_coins;

      return {
        rsn: data.rsn,
        bankValue: totalBankValue,
        coins: totalCoins,
        bankCoins: latestEntry.bank_coins,
        inventoryCoins: latestEntry.inventory_coins,
        bankGeValue: latestEntry.bank_ge_value,
        timestamp: latestEntry.timestamp,
        lastUpdated: data.lastUpdated
      };
    } catch (error) {
      console.error(`[BankWealth] Error reading file for RSN "${rsn}":`, error.message);
      return null;
    }
  }

  /**
   * Get all bank wealth data
   */
  getAllBankWealth() {
    try {
      if (!fs.existsSync(this.bankWealthDir)) {
        console.log('[BankWealth] Directory not found');
        return [];
      }

      const files = fs.readdirSync(this.bankWealthDir).filter(f => f.endsWith('.json'));
      
      return files.map(file => {
        const rsn = file.replace('.json', '');
        return this.getBankWealth(rsn);
      }).filter(data => data !== null);
    } catch (error) {
      console.error('[BankWealth] Error reading directory:', error.message);
      return [];
    }
  }
}

module.exports = { BankWealthParser };