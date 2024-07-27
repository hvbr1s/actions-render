// Node.js built-in modules
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';

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

const TREASURY_ADDRESS = new PublicKey('3crhbDnPJU9xvvhUwEs8WXPqAcA9aovsbj6aRBX9bNbw');

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

// Initiate sender wallet and connection to Solana
const QUICKNODE_RPC = 'https://fragrant-ancient-needle.solana-devnet.quiknode.pro/71caf4b466e52b402cb9891702899d7631646396/';
const SOLANA_CONNECTION = new Connection(QUICKNODE_RPC);
const WALLET = getKeypairFromEnvironment();
const METAPLEX = Metaplex.make(SOLANA_CONNECTION)
    .use(keypairIdentity(WALLET))
    .use(bundlrStorage({
        address: 'https://devnet.bundlr.network', // Devnet
        //address: 'https://node1.bundlr.network', // Mainnet
        providerUrl: QUICKNODE_RPC,
        timeout: 60000,
    }));


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
        {trait_type: 'Mood', value: llmResponse.mood ||''},
        {trait_type: 'Haiku', value:llmResponse.haiku ||''},
        {trait_type: 'Note', value: memo ||''},
    ],
    sellerFeeBasisPoints: 500, // 500 bp = 5%
    symbol: 'AIART',
    creators: [
        {address: WALLET.publicKey, share: 100}
    ]
  };

  return CONFIG;
}

///// NFT LOGIC
async function uploadImage(filePath: string,fileName: string): Promise<string>  {
  const imgBuffer = fs.readFileSync(filePath + fileName);
  const imgMetaplexFile = toMetaplexFile(imgBuffer,fileName);
  const imgUri = await METAPLEX.storage().upload(imgMetaplexFile);
  return imgUri;
}

async function imagine(userPrompt: string, randomNumber: number) {
  const response = await oai_client.images.generate({
    model: "dall-e-3",
    prompt: userPrompt + ' . Begin!',
    n: 1,
    size: "1024x1024",
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

async function uploadMetadata(imgUri: string, imgType: string, nftName: string, description: string, attributes: {trait_type: string, value: string}[]) {
  const { uri } = await METAPLEX
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
  symbol: string,
  creators: { address: PublicKey, share: number }[]
)
{
  try {
    const transactionBuilder = await METAPLEX
    .nfts()
    .builders()
    .create({
        uri: metadataUri,
        name: name,
        sellerFeeBasisPoints: sellerFee,
        symbol: symbol,
        creators: creators,
        isMutable: true,
        isCollection: false,
        tokenStandard: TokenStandard.ProgrammableNonFungible,
        ruleSet: null
    });
    await METAPLEX.nfts().create({
        uri: metadataUri,
        name: name,
        sellerFeeBasisPoints: sellerFee,
        symbol: symbol,
        creators: creators,
        isMutable: false,
    });
    let { signature, confirmResponse } = await METAPLEX.rpc().sendAndConfirmTransaction(transactionBuilder);
    if (confirmResponse.value.err) {
        throw new Error('failed to confirm transaction');
    }
    const { mintAddress } = transactionBuilder.getContext();
    console.log(`   Mint successful!🎉`);
    console.log(`   Minted NFT:       https://explorer.solana.com/address/${mintAddress.toString()}?cluster=devnet`);
    console.log(`   Mint transaction: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    return mintAddress
  }
  catch (err) {
    console.log(err);
  }
}

// Transfer function 
async function transferNFT(
  senderKeypair: Keypair, 
  recipientPublicKey: string,
  mintAddress: string
) {
  const senderAddress = senderKeypair.publicKey.toString()
  const destination = new PublicKey(recipientPublicKey);
  const mint = new PublicKey(mintAddress)
  const accountInfo = await SOLANA_CONNECTION.getAccountInfo(new PublicKey(mint));
  if (accountInfo) {
    console.log(`Current Owner of the NFT: ${accountInfo.owner.toString()}`);
  } else {
    console.log('Account info is null.');
  }
  const transferTransactionBuilder = await METAPLEX.nfts().builders().transfer({
      nftOrSft: {address: mint, tokenStandard: TokenStandard.ProgrammableNonFungible},
      authority: WALLET,
      fromOwner: WALLET.publicKey,
      toOwner: destination,
  });
  
  let { signature: sig2, confirmResponse: res2 } = await METAPLEX.rpc().sendAndConfirmTransaction(transferTransactionBuilder, {commitment: 'finalized'});
  if (res2.value.err) {
      throw new Error('Failed to confirm transfer transaction');
  }
  else
    return {
      message: "Transfer successful!🥳",
      sender: `https://explorer.solana.com/address/${senderAddress}?cluster=devnet`,
      receiver: `https://explorer.solana.com/address/${recipientPublicKey}/tokens?cluster=devnet`,
      transaction: `https://explorer.solana.com/tx/${sig2}?cluster=devnet`
    }
}

async function findTransactionWithMemo(connection: Connection, userAccount: PublicKey, memo: string, timeoutMinutes: number = 5): Promise<TransactionSignature | null> {
  const startTime = Date.now();
  const timeoutMs = timeoutMinutes * 60 * 1000;

  console.log(`Searching for memo: "${memo}"`);

  while (Date.now() - startTime < timeoutMs) {
    const signatures = await connection.getSignaturesForAddress(userAccount, 
      { limit: 5 },
      'confirmed'
    );
    console.log("Fetched signatures:", signatures);

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

    console.log("Waiting 5 seconds before next check...");
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  console.log("Timeout reached, no matching memo found");
  return null;
}

// Fee setting function
async function getFeeInLamports(connection: Connection): Promise<number> {
  // 1. Get the current SOL/USD price
  const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
  const data = await response.json();
  const solPrice = data.solana.usd;

  // 2. Calculate SOL equivalent of 10 USD
  const solAmount = 10 / solPrice;

  // 3. Convert SOL to lamports
  const lamports = solAmount * LAMPORTS_PER_SOL;

  // Round to the nearest whole number of lamports
  return Math.round(lamports);
}

///////// API ROUTES

app.get('/get_action', async (req, res) => {
    try {
      const payload: ActionGetResponse = {
        icon: new URL("https://i.imgur.com/aFLHCnR.png").toString(),
        label: "Mint NFT",
        title: "Imagin'App 🌈",
        description: "Describe your own unique NFT",
        links: {
          actions: [
            {
              label: "Mint NFT",
              href: `https://actions-55pw.onrender.com/post_action?user_prompt={prompt}&memo={memo}`, // prod href
              //href: 'http://localhost:8000/post_action?user_prompt={prompt}&memo={memo}', // dev href
              parameters: [
                {
                  name: "prompt",
                  label: "Describe your NFT",
                  required: true,
                },
                {
                  name: "memo",
                  label: "Add a note",
                  required: true,
                }
              ]
            }
          ]
        }
      };
  
      res.header(ACTIONS_CORS_HEADERS).status(200).json(payload);
    } catch (error) {
      console.error("Error handling GET request:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
});

app.options('/post_action', (req: Request, res: Response) => {
  res.header(ACTIONS_CORS_HEADERS).sendStatus(200);
});

app.use(express.json());
app.post('/post_action', async (req: Request, res: Response) => {

  const randomNumber = Math.floor(Math.random() * 10000);

  try {
    const prompt = (req.query.user_prompt as string || '').trim();
    console.log('User prompt:', prompt);
    const memo = (req.query.memo as string || '').trim();
    console.log('User memo: ', memo)
    const body: ActionPostRequest = req.body;

    const safetyCheck = await safePrompting(prompt);

    if (safetyCheck === 'safe') { 
      let user_account: PublicKey
      try {
        user_account = new PublicKey(body.account)
      } catch (error) {
        return res.status(400).json({ error: 'Invalid account' });
      }

      const connection = new Connection(
        // process.env.SOLANA_RPC! || clusterApiUrl("mainnet-beta"),
        process.env.SOLANA_RPC! || clusterApiUrl("devnet"),
      );

      const transaction = new Transaction();

      // Get the latest blockhash
      const { blockhash } = await connection.getLatestBlockhash();

      // Get fee price
      const mintingFee =  await getFeeInLamports(connection);
      console.log(`Fee for this transaction -> ${mintingFee} lamports or `)

      // Adding payment
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: user_account,
          toPubkey: TREASURY_ADDRESS,
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

      // Set the transaction properties
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
        
        // Trigger NFT creation process
        const llmSays = await generatePrompt(prompt);
        console.log(`LLM prompt 🤖-> ${llmSays}`);

        const CONFIG = await defineConfig(llmSays, randomNumber, memo);
        const imageName = `'${CONFIG.imgName}'`
        console.log(`Image Name -> ${imageName}`)
        
        const imageLocation = await imagine(llmSays, randomNumber);
        console.log(`Image successfully created 🎨`);

        console.log(`Uploading your Image🔼`);
        const imageUri = await uploadImage(imageLocation, "");

        console.log(`Uploading the Metadata⏫`);
        const metadataUri = await uploadMetadata(imageUri, CONFIG.imgType, CONFIG.imgName, CONFIG.description, CONFIG.attributes);
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
        const mintAddress = await mintProgrammableNft(metadataUri, CONFIG.imgName, CONFIG.sellerFeeBasisPoints, CONFIG.symbol, CONFIG.creators);
        if (!mintAddress) {
          throw new Error("Failed to mint the NFT. Mint address is undefined.");
        }
        
        console.log(`Transferring your NFT 📬`);
        const mintSend = await transferNFT(WALLET, user_account.toString(), mintAddress.toString());
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
});
export default app;

// Start dev server
// app.listen(port, () => {
//   console.log(`Listening at http://localhost:${port}/`);
//   console.log(`Test your blinks http://localhost:${port}/get_action \n at https://www.dial.to/devnet`)
// });
// export default app;
