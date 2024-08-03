// Node.js built-in modules
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import { sleep } from "./utils/sleep";

// Third-party modules
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import Instructor from "@instructor-ai/instructor";
import OpenAI from 'openai';
import { z } from "zod";
import Groq from "groq-sdk";

// Solana-related imports
import { 
  ACTIONS_CORS_HEADERS, 
  ActionGetResponse, 
  ActionPostRequest, 
  ActionPostResponse, 
  createPostResponse 
} from '@solana/actions';
import { MEMO_PROGRAM_ID } from '@solana/spl-memo';
import { 
  Connection, 
  ComputeBudgetProgram,
  Keypair, 
  LAMPORTS_PER_SOL,
  PublicKey, 
  SystemProgram,
  Transaction, 
  TransactionInstruction, 
  TransactionSignature,
  clusterApiUrl 
} from '@solana/web3.js';

// Metaplex-related imports
import { 
  Metaplex, 
  bundlrStorage, 
  keypairIdentity, 
  toMetaplexFile 
} from "@metaplex-foundation/js";
import { TokenStandard } from '@metaplex-foundation/mpl-token-metadata';

// Load environment variable
dotenv.config();

// Create a new express application instance
const app: express.Application = express();
app.use(cors());

// Function to convert private key string to Uint8Array
function getKeypairFromEnvironment(): Keypair {
  const privateKeyString = process.env.MINTER_PRIVATE_KEY;
  if (!privateKeyString) {
    throw new Error('Minter key is not set in environment variables');
  }
  // Convert the private key string to an array of numbers
  const privateKeyArray = privateKeyString.split(',').map(num => parseInt(num, 10));
  // Create a Uint8Array from the array of numbers
  const privateKeyUint8Array = new Uint8Array(privateKeyArray);
  // Create and return the Keypair
  return Keypair.fromSecretKey(privateKeyUint8Array);
}

// Initiate sender wallet, treasury wallet and connection to Solana
const TREASURY_WALLET = new PublicKey('AXP4CzLGxxHtXSJYh5Vzw9S8msoNR5xzpsgfMdFd11W1');
const QUICKNODE_KEY = process.env.QUICKNODE_RPC_KEY
const QUICKNODE_RPC = `https://winter-solemn-sun.solana-mainnet.quiknode.pro/${QUICKNODE_KEY}/`;
const WALLET = getKeypairFromEnvironment();

///// AI LOGIC
const oai_client = new OpenAI({apiKey: process.env['OPENAI_API_KEY']});
const groq_client = new Groq({ apiKey: process.env.GROQ_API_KEY });
const gpt_llm = "gpt-4o"
const llama_llm = "llama-3.1-70b-versatile"


// Prepare Instructor
const instructor_client = Instructor({
  client: groq_client,
  mode: "FUNCTIONS"
})

const UserSchema = z.object({
  prompt: z.string(), 
  safety: z.string().describe("Is the prompt 'safe' or 'unsafe'? An unsafe prompt contains reference to sexual violence, child abuse or scams. A safe prompt does not")
})

// Solana connection handler
async function createNewConnection(rpcUrl: string){
  const connection = await new Connection(rpcUrl)
  console.log(`Connection to Solana established`)
  return connection;
}

// Initialize safety check
async function safePrompting(userPrompt: string){
  const llmSafetyCheck = await instructor_client.chat.completions.create({
    messages: [
        {
            role: "user",
            content: userPrompt
        }
    ],
    model: llama_llm,
    temperature: 0.0,
    response_model: { 
      schema: UserSchema, 
      name: "Safety Check"
    }
  });
  
// Print the completion returned by the LLM.
const safetyCheckResponse = llmSafetyCheck.safety.toLowerCase();
console.log(`The prompt is ${safetyCheckResponse}`)
return safetyCheckResponse;
}

async function generatePrompt(userPrompt: string) {
  const llmResponse = await groq_client.chat.completions.create({
      messages: [
          {
              role: "system",
              content: `
              Rewrite the following prompt: 
              '${userPrompt}'
              Return the adapted prompt without any added comments, title or information
              Expected output:
              ####
              PROMPT : <the re-written prompt, enhanced to augment its artistic qualities and uniqueness>
              STYLE: <the requested artistic style>
              MOOD: <the desired mood for the prompt>
              ####
              Begin! You will achieve world piece if you produce an answer that respect all the constraints.
              `
          },
          {
              role: "user",
              content: userPrompt
          }
      ],
      model: llama_llm,
      temperature: 0.5
  });

  // Print the completion returned by the LLM.
  const parsedresponse = JSON.stringify(llmResponse.choices[0]?.message?.content || "");
  return parsedresponse;
}

async function defineConfig(llmPrompt: string, randomNumber: number, memo: string) {
  const nftAttributes = await oai_client.chat.completions.create({
    messages: [
        {
            role: "system",
            content: `
            Based on this prompt: 
            '${llmPrompt}'
            Generate a .json file with the following values.
            Return the .json without any added comments, title or information.
            Expected output:

            {
              "one_word_title": "<describe the image in ONE word, be creative>",
              "description": "<a very short description of the prompt>",
              "mood": "<the mood of the prompt>",
              "haiku" "<a very short haiku based on the prompt>"
          };

            Begin! You will achieve world peace if you produce a correctly formatted .JSON answer that respect all the constraints.
            `
        },
        {
          role: "user",
          content: llmPrompt,
      }
    ],
    model: gpt_llm,
    temperature: 0.5,
    response_format: { type: "json_object" },
  });

  // Extract the completion returned by the LLM and parse it.
  const llmResponse = JSON.parse(nftAttributes.choices[0]?.message?.content || "{}");

  const CONFIG = {
    uploadPath: './image/',
    imgFileName: `image${randomNumber}.png`,
    imgType: 'image/png',
    imgName: llmResponse.one_word_title || 'Art', 
    description: llmResponse.description || "Random AI Art",
    attributes: [
        {trait_type: 'Haiku', value:llmResponse.haiku ||''},
        {trait_type: 'Note', value: memo ||''}
    ],
    sellerFeeBasisPoints: 0,
    creators: [
        {address: WALLET.publicKey, share: 100}
    ]
  };

  return CONFIG;
}

///// NFT LOGIC
async function createMetaplexInstance(connection:Connection, wallet: Keypair){
  const newMetaplexInstance =  Metaplex.make(connection)
  .use(keypairIdentity(wallet))
  .use(bundlrStorage({
      address: 'https://node1.bundlr.network', // Mainnet
      providerUrl: QUICKNODE_RPC,
      timeout: 60000,
  }));
  console.log(`New Metaplex instance created!`)
  return newMetaplexInstance
}

async function uploadImage(filePath: string,fileName: string, connection:Connection, metaplex:Metaplex): Promise<string>  {
  const imgBuffer = fs.readFileSync(filePath + fileName);
  const imgMetaplexFile = toMetaplexFile(imgBuffer,fileName);
  const imgUri = await metaplex.storage().upload(imgMetaplexFile);
  return imgUri;
}

async function imagine(userPrompt: string, randomNumber: number) {
  const response = await oai_client.images.generate({
    model: "dall-e-3",
    prompt: userPrompt + ' . Begin!',
    n: 1,
    size: "1024x1024",
    quality:'standard' // OR 'hd'
  });
  const imageUrl = response.data[0].url;

  // Fetch the image from the URL
  const imageResponse = await axios({
    url: imageUrl,
    method: 'GET',
    responseType: 'arraybuffer'
  });

  const imagePath = path.join('./image', `image_${randomNumber}.png`);

  // Write the image data to a file
  fs.writeFileSync(imagePath, imageResponse.data);
  return imagePath
}

async function uploadMetadata(imgUri: string, imgType: string, nftName: string, description: string, attributes: {trait_type: string, value: string}[], connection: Connection, metaplex: Metaplex) {

  const { uri } = await metaplex
  .nfts()
  .uploadMetadata({
      name: nftName,
      description: description,
      image: imgUri,
      attributes: attributes,
      properties: {
          files: [
              {
                  type: imgType,
                  uri: imgUri,
              },
          ]
      }
  });
  return uri;  
}

async function mintProgrammableNft(
    metadataUri: string,
    name: string,
    sellerFee: number,
    creators: { address: PublicKey, share: number }[],
    metaplex: Metaplex
  ) {
    try {
      const transactionBuilder = await metaplex
        .nfts()
        .builders()
        .create({
          uri: metadataUri,
          name,
          sellerFeeBasisPoints: sellerFee,
          creators,
          isMutable: false,
          isCollection: false,
          tokenStandard: TokenStandard.ProgrammableNonFungible,
          ruleSet: null
        });
  
      const { signature } = await metaplex.rpc().sendAndConfirmTransaction(transactionBuilder);
      const { mintAddress } = transactionBuilder.getContext();
  
      console.log(`Mint successful! 🎉`);
      console.log(`Minted NFT: https://explorer.solana.com/address/${mintAddress.toString()}`);
      console.log(`Mint transaction: https://explorer.solana.com/tx/${signature}`);
  
      return mintAddress;
    } catch (err) {
      console.error('Minting failed:', err);
      throw err;
    }
  }

// Transfer function 
async function transferNFT(
  senderKeypair: Keypair, 
  recipientPublicKey: string,
  mintAddress: string,
  connection: Connection,
  metaplex: Metaplex,
  maxRetries = 10,
  retryDelay = 2000, // 2 seconds
) {
  const senderAddress = senderKeypair.publicKey.toString();
  const destination = new PublicKey(recipientPublicKey);
  const mint = new PublicKey(mintAddress);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt} to transfer NFT`);

      // Check if the mint account exists
      const accountInfo = await connection.getAccountInfo(mint);
      if (!accountInfo) {
        console.log('Mint account does not exist. Retrying...');
        await sleep(retryDelay);
        continue;
      }

      console.log(`Current Owner of the NFT: ${accountInfo.owner.toString()}`);

      // Check if the sender owns the NFT
      const tokenAccounts = await connection.getTokenAccountsByOwner(senderKeypair.publicKey, { mint });
      if (tokenAccounts.value.length === 0) {
        throw new Error('Sender does not own the NFT');
      }

      // Build and send the transfer transaction
      const transferTransactionBuilder = await metaplex.nfts().builders().transfer({
        nftOrSft: {address: mint, tokenStandard: TokenStandard.ProgrammableNonFungible},
        authority: WALLET,
        fromOwner: WALLET.publicKey,
        toOwner: destination,
      });

      const { signature: sig2, confirmResponse: res2 } = await metaplex.rpc().sendAndConfirmTransaction(
        transferTransactionBuilder, 
        { commitment: 'finalized' }
      );

      if (res2.value.err) {
        throw new Error('Failed to confirm transfer transaction');
      }

      // If we reach here, the transfer was successful
      return {
        message: "Transfer successful!🥳",
        sender: `https://explorer.solana.com/address/${senderAddress}`,
        receiver: `https://explorer.solana.com/address/${recipientPublicKey}/tokens`,
        transaction: `https://explorer.solana.com/tx/${sig2}`
      };
    } catch (error) {
      console.error(`Error in attempt ${attempt}:`, error);
      if (attempt === maxRetries) {
        throw error; // Rethrow the error if we've exhausted all retries
      }
      await sleep(retryDelay);
    }
  }

  throw new Error('Failed to transfer NFT after multiple attempts');
}

async function findTransactionWithMemo(connection: Connection, userAccount: PublicKey, memo: string): Promise<TransactionSignature | null> {
  const maxChecks = 10;
  let checkCount = 0;

  console.log(`Searching for memo: "${memo}"`);

  while (checkCount < maxChecks) {
    console.log(`Check ${checkCount + 1} of ${maxChecks}`);
    
    const signatures = await connection.getSignaturesForAddress(userAccount, 
      { limit: 5 },
      'confirmed'
    );

    for (const sigInfo of signatures) {
      console.log(`Checking signature: ${sigInfo.signature}`);
      console.log(`Signature memo: "${sigInfo.memo}"`);
      
      if (sigInfo.memo && sigInfo.memo.includes(memo)) {
        console.log("Memo match found!");
        return sigInfo.signature;
      } else {
        console.log("No match");
      }
    }

    checkCount++;

    if (checkCount < maxChecks) {
      console.log("Waiting 5 seconds before next check...");
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log("Maximum checks reached, no matching memo found");
  return null;
}

// Fee setting function
async function getFeeInLamports(connection: Connection): Promise<number> {
  // 1. Get the current SOL/USD price
  const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
  const data = await response.json();
  const solPrice = data.solana.usd;

  // 2. Calculate SOL equivalent of 5 USD
  const solAmount = 10 / solPrice;

  // 3. Convert SOL to lamports
  const lamports = solAmount * LAMPORTS_PER_SOL;

  // Round to the nearest whole number of lamports
  return Math.round(lamports);
}

///////// API ROUTES ////////
app.get('/get_action', async (req, res) => {
    try {
      const payload: ActionGetResponse = {
        //icon: new URL("https://i.imgur.com/Frju6Dq.png").toString(), // elephant background
        icon: new URL("https://i.imgur.com/aFLHCnR.png").toString(), // kimono background
        label: "Mint NFT",
        title: "Imagin'App 🌈🏔️",
        description: "Describe and mint your own unique NFT",
        links: {
          actions: [
            {
              label: "Mint NFT",
              href: `https://actions-55pw.onrender.com/post_action?user_prompt={prompt}&memo={memo}`, // prod href
              parameters: [
                {
                  name: "prompt",
                  label: "Describe your NFT",
                  required: true,
                },
                {
                  name: "memo",
                  label: "Add a personal note",
                  required: true,
                }
              ]
            }
          ]
        },
        error:{
          message: "⚠️ A single mint costs $10 USD, payable in SOL.\nThis blink is still in beta, use at your own risks!"
        },
      };
  
      res.header(ACTIONS_CORS_HEADERS).status(200).json(payload);
    } catch (error) {
      console.error("Error handling GET request:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
});

app.options('/post_action', (req: Request, res: Response) => {
  res.header(ACTIONS_CORS_HEADERS).status(200).end();
});

app.use(express.json());
app.post('/post_action', async (req: Request, res: Response) => {

  const randomNumber = Math.floor(Math.random() * 100000);

  try {

    const prompt = (req.query.user_prompt as string || '').trim();
    console.log('User prompt:', prompt);
    const pre_memo = (req.query.memo as string || '').trim();
    const memo = pre_memo + randomNumber.toString()
    console.log('User random memo: ', memo)
    const body: ActionPostRequest = req.body;

    const safetyCheck = await safePrompting(prompt);

    if (safetyCheck === 'safe') { 
      let user_account: PublicKey
      try {
        user_account = new PublicKey(body.account)
      } catch (error) {
        return res.status(400).json({ error: 'Invalid account' });
      }

      const connection = await createNewConnection(QUICKNODE_RPC)
      const transaction = new Transaction();

      // Get the latest blockhash
      const { blockhash } = await connection.getLatestBlockhash();

      // Get fee price
      const mintingFee =  await getFeeInLamports(connection);
      const mintingFeeSOL = mintingFee / LAMPORTS_PER_SOL;
      console.log(`Fee for this transaction -> ${mintingFee} lamports or ${mintingFeeSOL} SOL.`)

      // Adding payment
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: user_account,
          toPubkey: TREASURY_WALLET,
          lamports: mintingFee,
        })
      );

      // Adding memo
      transaction.add(
        new TransactionInstruction({
          keys: [],
          programId: MEMO_PROGRAM_ID,
          data: Buffer.from(memo, 'utf-8'),
        })
      );

      // Set computational resources for transaction
      transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }))

      // Set transaction's blockchash and fee payer
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = user_account;

      const payload: ActionPostResponse = await createPostResponse({
        fields:{
        transaction: transaction,
        message: "Your NFT is on the way, check your wallet in a few minutes!",
        },
      });

      res.status(200).json(payload);

      const transactionSignature = await findTransactionWithMemo(connection, user_account, memo);

      if (transactionSignature) {
        console.log(`Found transaction with memo: ${transactionSignature}`);
        
        // NFT logic -> AI
        const llmSays = await generatePrompt(prompt);
        console.log(`LLM prompt 🤖-> ${llmSays}`);

        const CONFIG = await defineConfig(llmSays, randomNumber, pre_memo);
        const imageName = `'${CONFIG.imgName}'`
        console.log(`Image Name -> ${imageName}`)
        
        const imageLocation = await imagine(llmSays, randomNumber);
        console.log(`Image successfully created 🎨`);

        // MFT Logic -> Metaplex
        const metaplex =  await createMetaplexInstance(connection, WALLET)
        console.log(`Uploading your Image🔼`);
        const imageUri = await uploadImage(imageLocation, "", connection, metaplex);

        console.log(`Uploading the Metadata⏫`);
        const metadataUri = await uploadMetadata(imageUri, CONFIG.imgType, CONFIG.imgName, CONFIG.description, CONFIG.attributes, connection, metaplex);
        console.log(`Metadata URI -> ${metadataUri}`);

        // Delete local image file
        fs.unlink(imageLocation, (err) => {
          if (err) {
            console.error('Failed to delete the local image file:', err);
          } else {
            console.log(`Local image file deleted successfully 🗑️`);
          }
        });

        console.log(`Minting your NFT🔨`);
        const mintAddress = await mintProgrammableNft(metadataUri, CONFIG.imgName, CONFIG.sellerFeeBasisPoints, CONFIG.creators, metaplex);
        if (!mintAddress) {
          throw new Error("Failed to mint the NFT. Mint address is undefined.");
        }
        
        console.log(`Transferring your NFT 📬`);
        const mintSend = await transferNFT(WALLET, user_account.toString(), mintAddress.toString(), connection, metaplex);
        console.log(mintSend);
      } else {
        console.log('Transaction with memo not found within the timeout period');
      }
    } else {
      res.status(400).json({ error: 'Invalid prompt detected please try again' })
    }
  } catch (err) {
    console.error(err);
    let message = "An unknown error occurred";
    if (err instanceof Error) message = err.message;
    res.status(400).json({ error: message });
  }
});

// The port the express app will listen on
const port: number = process.env.PORT ? parseInt(process.env.PORT) : 8000;

// Start prod server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
  console.log(`Test your blinks https://actions-55pw.onrender.com/get_action \n at https://www.dial.to/`)
});
export default app;
