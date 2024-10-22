
import { Connection } from '@solana/web3.js'

export async function createNewConnection(rpcUrl: string){
    console.log(`Connecting to Solana...🔌`)
    const connection = await new Connection(rpcUrl)
    console.log(`Connection to Solana established🔌✅`)
    return connection;
}