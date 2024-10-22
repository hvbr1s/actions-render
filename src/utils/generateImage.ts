import OpenAI from 'openai';
import dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';
import { NFTConfig } from './interfaces'
import { promises, mkdirSync } from 'fs';

dotenv.config();

const oai_client = new OpenAI({apiKey: process.env['OPENAI_API_KEY']});

export async function imagine(userPrompt: string, CONFIG: NFTConfig, randomNumber: number) {

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
      mkdirSync(path.dirname(imagePath), { recursive: true });
  
      // Write the image data to a file
      await promises.writeFile(imagePath, imageResponse.data);
      console.log(imagePath)
  
      return imagePath;
      
    } catch (error) {
      console.error("Error in createImage:", error);
      throw error;
    }
  
}