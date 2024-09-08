// Node.js built-in modules
import * as fs from 'fs';
import { promises as promise } from 'fs';
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
import { NFTConfig }  from './utils/interfaces'

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
} from '@solana/web3.js';

// Metaplex-related imports
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey, createGenericFile, } from '@metaplex-foundation/umi';
import { mplCore, transferV1, create, fetchAsset } from '@metaplex-foundation/mpl-core';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';
import { keypairIdentity, generateSigner } from '@metaplex-foundation/umi';

// Load environment variable
dotenv.config();

//// UMI INIT /////
const QUICKNODE_RPC = `https://winter-solemn-sun.solana-mainnet.quiknode.pro/${process.env.QUICKNODE_MAINNET_KEY}/`; // mainnet
//const QUICKNODE_RPC = `https://fragrant-ancient-needle.solana-devnet.quiknode.pro/${process.env.QUICKNODE_DEVNET_KEY}/`; // devnet 
const newUMI = createUmi(QUICKNODE_RPC)

// Load wallet
function getKeypairFromEnvironment(): Uint8Array {
  const privateKeyString = process.env.MINTER_PRIVATE_KEY;
  if (!privateKeyString) {
    throw new Error('Minter key is not set in environment variables');
  }
  // Convert the private key string to an array of numbers
  const privateKeyArray = privateKeyString.split(',').map(num => parseInt(num, 10));
  // Return a Uint8Array from the array of numbers
  return new Uint8Array(privateKeyArray);
}
const secretKey = getKeypairFromEnvironment()
const mintKeypair = Keypair.fromSecretKey(secretKey);

// Initialize UMI instance with wallet
const keypair = newUMI.eddsa.createKeypairFromSecretKey(new Uint8Array(secretKey))
const umi = newUMI
  .use(mplCore())
  .use(irysUploader())
  .use(keypairIdentity(keypair));

///////////////

// Solana connection handler
async function createNewConnection(rpcUrl: string){
  console.log(`Connecting to Solana...🔌`)
  const connection = await new Connection(rpcUrl)
  console.log(`Connection to Solana established🔌✅`)
  return connection;
}

///// AI LOGIC
const oai_client = new OpenAI({apiKey: process.env['OPENAI_API_KEY']});
const gpt_llm = "gpt-4o-2024-08-06"

// Prepare Instructor
const instructor_client = Instructor({
  client: oai_client,
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
    model: gpt_llm,
    temperature: 0.0,
    response_model: { 
      schema: UserSchema, 
      name: "Safety Check"
    }
  });
  
  const safetyCheckResponse = llmSafetyCheck.safety.toLowerCase();
  console.log(`The prompt is ${safetyCheckResponse} 👮`)

  return safetyCheckResponse;
}

async function generatePrompt(userPrompt: string) {
  const llmResponse = await oai_client.chat.completions.create({
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
      model: gpt_llm,
      temperature: 0.5
  });

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

  const config: NFTConfig = {
    // File handling properties
    uploadPath: './image/',
    imgFileName: `image${randomNumber}.png`,
    imgType: 'image/png',
  
    // NFT metadata properties
    imgName: llmResponse.one_word_title || '',
    description: llmResponse.description || '',
    image: '', // This will be set after the image is uploaded
    attributes: [
      { trait_type: 'Haiku', value: llmResponse.haiku || '' },
      { trait_type: 'Note', value: memo || '' }
    ],
    properties: {
      files: [
        {
          uri: '', // This will be set after the image is uploaded
          type: 'image/png',
        },
      ],
      category: 'image',
    },
  };
  
  return config;

}

async function updateConfigWithImageUri(config: NFTConfig, imageUri: string): Promise<NFTConfig> {
  return {
    ...config,
    image: imageUri,
    properties: {
      ...config.properties,
      files: [
        {
          uri: imageUri,
          type: config.imgType,
        },
      ],
    },
  };
}

async function createURI(imagePath: string, CONFIG: NFTConfig): Promise<string> {
try {
  // Read the image file
  const imageBuffer = await promise.readFile(imagePath);

  // Create a GenericFile object
  const umiImageFile = createGenericFile(
    imageBuffer,
    CONFIG.imgFileName,
    {
      displayName: CONFIG.imgName,
      uniqueName: CONFIG.imgFileName,
      contentType: CONFIG.imgType,
      extension: CONFIG.imgFileName.split('.').pop() || 'png',
      tags: [{ name: 'Content-Type', value: CONFIG.imgType }],
    }
  );

  // Upload the image and get its URI
  const [imageUri] = await umi.uploader.upload([umiImageFile]);
  if (!imageUri) {
    throw new Error("Failed to upload image");
  }
  console.log('Image uploaded, URI:', imageUri);

  // Add the image URI to the config
  const configWithUri = await updateConfigWithImageUri(CONFIG, imageUri)
  console.log(configWithUri)

  // Upload the JSON metadata
  const metadataUri = await umi.uploader.uploadJson(configWithUri);
  if (!metadataUri) {
    throw new Error("Failed to upload metadata");
  }

  return metadataUri;

} catch (error) {
  console.error("Error in createURI:", error);
  throw error;
}
}

async function imagine(userPrompt: string, CONFIG: NFTConfig, randomNumber: number) {

  try{

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

    const imagePath = path.join(CONFIG.uploadPath, `${CONFIG.imgName}_${randomNumber}.png`);

    // Ensure the directory exists
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });

    // Write the image data to a file
    await fs.promises.writeFile(imagePath, imageResponse.data);
    console.log(imagePath)

    return imagePath;
    
  } catch (error) {
    console.error("Error in createImage:", error);
    throw error;
  }

}

async function createAsset(CONFIG: NFTConfig, uri: string): Promise<string> {
  try {
    // Generate a new signer for the asset
    const assetSigner = generateSigner(umi);
    console.log(`Creating asset with metadata: ${uri}`)

    // Create the asset
    const result = await create(umi, {
      asset: assetSigner,
      name: CONFIG.imgName,
      uri: uri,
    }).sendAndConfirm(umi);

    console.log(`Asset address: ${assetSigner.publicKey}`);

    return assetSigner.publicKey.toString();
  } catch (error) {
    console.error("Error in createAsset:", error);
    throw error;
  }
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
async function getFeeInLamports(): Promise<number> {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    const solPrice = data.solana.usd;

    if (solPrice && typeof solPrice === 'number' && solPrice > 0) {
      const solAmount = 2 / solPrice; //target fee $2
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

///////// API ROUTES ////////

// Create a new express application instance
const app: express.Application = express();
app.use(cors());

app.get('/get_action', async (req, res) => {
    try {
      const payload: ActionGetResponse = {
        icon: new URL("https://i.imgur.com/Frju6Dq.png").toString(), // elephant background
        //icon: new URL("https://i.imgur.com/aFLHCnR.png").toString(), // kimono background
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
          message: "⚠️ A single mint costs $3 USD, payable in SOL.\nThis blink is still in beta, use at your own risks!"
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
      const mintingFee =  await getFeeInLamports();
      const mintingFeeSOL = mintingFee / LAMPORTS_PER_SOL;
      console.log(`Fee for this transaction -> ${mintingFee} lamports or ${mintingFeeSOL} SOL.`)

      // Adding payment
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: user_account,
          toPubkey: mintKeypair.publicKey,
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
      transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }))
      transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100 }))

      // Set transaction's blockchash and fee payer
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = user_account;

      const payload: ActionPostResponse = await createPostResponse({
        fields:{
        transaction: transaction,
        message: `Your NFT is on the way, Wait a few minutes then check your wallet at https://solana.fm/address/${user_account}/nfts?cluster=mainnet-alpha `,
        },
      });

      res.status(200).json(payload);

      await processPostTransaction(prompt, connection, user_account, memo, pre_memo, randomNumber)

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

async function processPostTransaction(prompt: string, connection: Connection, user_account:PublicKey, memo:string, pre_memo:string, randomNumber: number) {

  const transactionSignature = await findTransactionWithMemo(connection, user_account, memo);

  if (transactionSignature) {
    console.log(`Found transaction with memo: ${transactionSignature}`);
    try{

      const llmSays = await generatePrompt(prompt);
      console.log(`LLM prompt 🤖-> ${llmSays}`);

      const CONFIG = await defineConfig(llmSays, randomNumber, pre_memo);
      const imageName = `'${CONFIG.imgName}'`
      console.log(`Image Name -> ${imageName}`)
      
      console.log("Creating image 🎨 ...");
      const imagePath = await imagine(llmSays, CONFIG, randomNumber);
      console.log(imagePath)

      console.log("Creating URI 🔗 ...");
      const uri = await createURI(imagePath, CONFIG);
      console.log("Metadata URI created:", uri);

      // Delete local image file
      fs.unlink(imagePath, (err) => {
        if (err) {
          console.error('Failed to delete the local image file:', err);
        } else {
          console.log(`Local image file deleted successfully 🗑️`);
        }
      });

      console.log("Creating asset ⛏️ ...");
      const newAssetAddress = await createAsset(CONFIG, uri);

      console.log(`Transferring your NFT 📬`);
      await transferNFT(new PublicKey(newAssetAddress), user_account);

      // const seeAsset = await goFetch(newAssetAddress);
      // console.log(seeAsset);
  
      console.log("Process completed successfully!");

    }
    catch(error){
      console.error("An error occurred in the post-transaction process:", error);
      throw error;
    }
  } else {
    console.log('Transaction with memo not found within the timeout period');
  }
}

async function transferNFT(newAssetAddress: PublicKey, user_account: PublicKey) {
  try {
    const result = await transferV1(umi, {
      asset: publicKey(newAssetAddress),
      newOwner: publicKey(user_account)
    }).sendAndConfirm(umi);

    console.log(`NFT transferred to user: ${user_account}`);
    return result.signature;
  } catch (error) {
    console.error('Error transferring NFT to user:', error);
    throw error;
  }
}

async function goFetch(assetAddress:string) {
  try {
    // Fetch the asset using the provided UMI instance
    const asset = await fetchAsset(umi, assetAddress, {
      skipDerivePlugins: false,
    });

    // Get the asset's URI
    const assetLocation = asset.uri;

    // Fetch the metadata from the asset's URI
    const response = await axios.get(assetLocation);
    
    // Extract the imageURI from the metadata
    const foundIt = response.data.imageURI;

    return foundIt;
  } catch (error) {
    console.error('Error in goFetch:', error);
    throw error;
  }
}

// Start prod server
const port: number = process.env.PORT ? parseInt(process.env.PORT) : 8000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
  console.log(`Test your blinks https://actions-55pw.onrender.com/get_action \n at https://www.dial.to/`)
});

export default app;
