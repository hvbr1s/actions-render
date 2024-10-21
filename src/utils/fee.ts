import { LAMPORTS_PER_SOL } from '@solana/web3.js'

// Fee setting function
export async function getFeeInLamports(): Promise<number> {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      const solPrice = data.solana.usd;
  
      if (solPrice && typeof solPrice === 'number' && solPrice > 0) {
        const solAmount = 3 / solPrice; //target fee $3
        const lamports = Math.round(solAmount * LAMPORTS_PER_SOL);
        console.log(`Dynamic fee: ${lamports} lamports (${solAmount.toFixed(4)} SOL)`);
        return lamports;
      } else {
        throw new Error('Invalid SOL price data');
      }
    } catch (error) {
      console.error('Error fetching dynamic fee, using fallback:', error);
      const fallbackLamports = Math.round(0.02 * LAMPORTS_PER_SOL);
      console.log(`Fallback fee: ${fallbackLamports} lamports`);
      return fallbackLamports;
    }
  }