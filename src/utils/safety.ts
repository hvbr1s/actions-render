import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const oai_client = new OpenAI({apiKey: process.env['OPENAI_API_KEY']});

export async function safePrompting(userPrompt: string): Promise<string> {
    try {
      const moderation = await oai_client.moderations.create({ input: userPrompt });
  
      if (moderation.results[0].flagged === true) {
        console.log(`The prompt '${userPrompt}' is unsafe! 🚨`)
        return 'unsafe';
      } else {
        console.log(`The prompt '${userPrompt}' is safe! 🟢`)
        return 'safe';
      }
    } catch (error) {
      console.error('Error during moderation request:', error);
      throw new Error('Failed to check prompt safety.');
    }
  }