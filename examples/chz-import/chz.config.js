import 'dotenv/config';
import { ChzOpenAIRealizer, defineConfig } from "chz";


export default defineConfig({
  realizers: [
    new ChzOpenAIRealizer({
      model: process.env.CHZ_OPENAI_MODEL,
      baseURL: process.env.CHZ_OPENAI_API_HOST,
      apiKey: process.env.CHZ_OPENAI_API_KEY,
    }),
  ],
});
