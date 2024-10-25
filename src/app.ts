import * as fs from 'fs';
import cors from 'cors';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { promises as promise } from 'fs';
import { getFeeInLamports } from './utils/fee' 
import { NFTConfig } from './utils/interfaces'
import { safePrompting } from './utils/safety'
import { imagine } from './utils/generateImage'
import { createNewConnection } from './utils/createNewConnection'
import * as actions from '@solana/actions'
import * as web3 from '@solana/web3.js'
import { MEMO_PROGRAM_ID } from '@solana/spl-memo';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey, createGenericFile, keypairIdentity, generateSigner } from '@metaplex-foundation/umi';
import { mplCore, transferV1, create } from '@metaplex-foundation/mpl-core';
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys';

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
const mintKeypair = web3.Keypair.fromSecretKey(secretKey);

// Initialize UMI instance with wallet
const keypair = newUMI.eddsa.createKeypairFromSecretKey(new Uint8Array(secretKey))
const umi = newUMI
  .use(mplCore())
  .use(irysUploader())
  .use(keypairIdentity(keypair));

///////////////

///// AI LOGIC
const oai_client = new OpenAI({apiKey: process.env['OPENAI_API_KEY']});
const gpt_llm = "gpt-4o-2024-08-06"

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

async function findTransactionWithMemo(connection: web3.Connection, userAccount: web3.PublicKey, memo: string): Promise<web3.TransactionSignature | null> {
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

///////// API ROUTES ////////

// Create a new express application instance
const app: express.Application = express();
app.use(cors());

app.get('/get_action', async (req, res) => {
    try {
      const payload: actions.ActionGetResponse = {
        icon: new URL("https://i.imgur.com/02jEt0P.png").toString(), // astrophant background
        label: "Mint NFT",
        title: "Astrophant 🐘🪐",
        description: "AI-Powered NFT Mint",
        links: {
          actions: [
            {
              type: "transaction",
              label: "Mint NFT",
              href: `https://actions-55pw.onrender.com/post_action?user_prompt={prompt}&memo={memo}`, // prod href
              //href: `http://localhost:8000/post_action?user_prompt={prompt}&memo={memo}`, // dev href
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
          message: "⚠️ A single mint costs $3 USD, payable in SOL."
        },
      };
  
      res.header(actions.ACTIONS_CORS_HEADERS).status(200).json(payload);
    } catch (error) {
      console.error("Error handling GET request:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
});

app.options('/post_action', (req: Request, res: Response) => {
  res.header(actions.ACTIONS_CORS_HEADERS).status(200).end();
});

app.use(express.json());
app.post('/post_action', async (req: Request, res: Response) => {
  const randomNumber = Math.floor(Math.random() * 100000);

  try {
    // Extract and validate query parameters
    const prompt = ((req.query.user_prompt as string) || '').trim();
    const preMemo = ((req.query.memo as string) || '').trim();
    const memo = preMemo + randomNumber.toString();

    console.log('User prompt:', prompt);
    console.log('User random memo:', memo);

    // Validate body
    const body: actions.ActionPostRequest = req.body;

    // Perform safety check
    const safetyCheck = await safePrompting(prompt);
    
    // If the prompt is flagged as unsafe, stop further execution
    if (safetyCheck !== 'safe') {
      return res.status(400).json({ error: 'Prompt failed safety checks' });
    }

    // Validate and create user account
    let userAccount: web3.PublicKey;
    try {
      userAccount = new web3.PublicKey(body.account);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid account' });
    }

    // Establish connection
    const connection = await createNewConnection(QUICKNODE_RPC);

    // Prepare transaction
    const transaction = new web3.Transaction();

    // Get the latest blockhash
    const { blockhash } = await connection.getLatestBlockhash();

    // Get fee details
    const mintingFee = await getFeeInLamports();
    const mintingFeeSOL = mintingFee / web3.LAMPORTS_PER_SOL;
    console.log(`Fee for this transaction -> ${mintingFee} lamports or ${mintingFeeSOL} SOL.`);

    // Add payment instruction
    transaction.add(
      web3.SystemProgram.transfer({
        fromPubkey: userAccount,
        toPubkey: mintKeypair.publicKey,
        lamports: mintingFee,
      })
    );

    // Add memo instruction
    transaction.add(
      new web3.TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memo, 'utf-8'),
      })
    );

    // Set computational resources for transaction
    transaction.add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }));
    transaction.add(web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100 }));

    // Finalize transaction details
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = userAccount;

    // Create payload
    const payload: actions.ActionPostResponse = await actions.createPostResponse({
      fields: {
        transaction: transaction,
        message: 'Your NFT is on the way! Wait a few minutes then check your wallet with https://solana.fm/.',
        type: 'transaction',
      },
    });

    // Validate payload and prompt before sending response
    if (payload && prompt && prompt.trim() !== '' && prompt !== '{prompt}' && safetyCheck == 'safe') {
      res.status(200).json(payload);
      await processPostTransaction(prompt, connection, userAccount, memo, preMemo, randomNumber);
    } else {
      return res.status(400).json({ error: 'Invalid payload or prompt' });
    }

  } catch (err) {
    console.error('Error in /post_action:', err);
    const message = err instanceof Error ? err.message : 'An unknown error occurred';
    res.status(500).json({ error: message });
  }
});

async function processPostTransaction(prompt: string, connection: web3.Connection, user_account: web3.PublicKey, memo:string, pre_memo:string, randomNumber: number) {

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
      await transferNFT(new web3.PublicKey(newAssetAddress), user_account);
  
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

async function transferNFT(newAssetAddress: web3.PublicKey, user_account: web3.PublicKey) {
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

// Start dev server
// const port: number = process.env.PORT ? parseInt(process.env.PORT) : 8000;
// app.listen(port, () => {
//   console.log(`Listening at http://localhost:${port}/`);
//   console.log(`Test your blinks http://localhost:${port}/get_action \n at https://www.dial.to/`)
// });

// Start prod server
const port: number = process.env.PORT ? parseInt(process.env.PORT) : 8000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on http://0.0.0.0:${port}`);
  console.log(`Test your blinks https://actions-55pw.onrender.com/get_action \n at https://www.dial.to/`)
});

export default app;
