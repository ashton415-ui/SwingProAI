import 'dotenv/config'; // Loads environment variables
import { OpenAI } from 'openai';
import { createClient } from '@supabase/supabase-js';

async function testConnections() {
  console.log("--- Starting API Connection Test ---");

  // 1. Test OpenAI
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // Attempting to list models is a quick way to verify the key works
    await openai.models.list();
    console.log("✅ OpenAI Connection Successful");
  } catch (err) {
    console.error("❌ OpenAI Connection Failed:", err.message);
  }

  // 2. Test Supabase
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase.from('user_bags').select('id').limit(1);
    
    if (error) throw error;
    console.log("✅ Supabase Connection Successful");
  } catch (err) {
    console.error("❌ Supabase Connection Failed:", err.message);
  }

  console.log("--- Test Complete ---");
}

testConnections();