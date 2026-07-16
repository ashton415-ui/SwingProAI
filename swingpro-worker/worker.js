const { createClient } = require('@supabase/supabase-js');
const { OpenAI } = require('openai');
require('dotenv').config();

// Initialize Clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Core Processing Function triggered when a new video is uploaded
 */
async function processSwingVideo(swingId) {
  try {
    console.log(`[Worker] Starting analysis for Swing ID: ${swingId}`);

    // 1. Fetch the swing data AND the associated club data from Supabase
    const { data: swingRecord, error } = await supabase
      .from('swings')
      .select(`
        *,
        user_bags (
          club_type,
          make,
          model
        )
      `)
      .eq('id', swingId)
      .single();

    if (error) throw error;

    const clubType = swingRecord.user_bags.club_type;
    const clubModel = `${swingRecord.user_bags.make} ${swingRecord.user_bags.model}`;
    const slope = swingRecord.recorded_slope; // Captured from your spatial UI

    console.log(`[Worker] Identified Club: ${clubModel} (${clubType})`);

    // 2. THE ROUTER: Dynamically assign the AI Prompt based on Club Type
    let systemPrompt = "";
    
    if (clubType === 'Putter') {
      console.log(`[Worker] Routing to Putting Lab AI Pipeline...`);
      systemPrompt = `
        You are an elite PGA Tour putting coach. Analyze this putting stroke video. 
        The player is using a ${clubModel}. 
        The spatial computing sensor detected a green slope of ${slope} degrees.
        
        Ignore full-swing mechanics. Grade the user strictly on:
        1. Eye position directly over the ball.
        2. A quiet lower body (zero hip rotation).
        3. A pure shoulder pendulum motion.
        4. Smooth acceleration through the stroke.
        
        Return the analysis in a strict JSON format containing a 'score' out of 100, a 'primary_fault', and a 'fix_recommendation'.
      `;
    } else {
      console.log(`[Worker] Routing to Full Swing AI Pipeline...`);
      systemPrompt = `
        You are an elite PGA Tour biomechanics coach. Analyze this full swing video. 
        The player is using a ${clubModel}.
        
        Evaluate the biomechanics based on standard full-swing principles:
        1. Posture and spine angle at address.
        2. Takeaway width and one-piece mechanics.
        3. Top of swing club face control.
        4. Hip rotation and kinematic sequence on the downswing.
        
        Return the analysis in a strict JSON format containing a 'score' out of 100, a 'primary_fault', and a 'fix_recommendation'.
      `;
    }

    // 3. Execute the AI Vision Request (using GPT-4o)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { 
          role: "user", 
          content: [
            { type: "text", text: "Analyze this swing video based on your system instructions." },
            { type: "image_url", image_url: { url: swingRecord.video_url } } // Or frame arrays depending on your specific compression pipeline
          ]
        }
      ]
    });

    const aiTelemetry = JSON.parse(completion.choices[0].message.content);
    console.log(`[Worker] AI Analysis Complete. Score: ${aiTelemetry.score}`);

    // 4. Write the JSON payload back to the database
    const { error: updateError } = await supabase
      .from('swings')
      .update({
        ai_score: aiTelemetry.score,
        primary_fault: aiTelemetry.primary_fault,
        fix_recommendation: aiTelemetry.fix_recommendation,
        status: 'completed'
      })
      .eq('id', swingId);

    if (updateError) throw updateError;
    console.log(`[Worker] Successfully updated database for Swing ID: ${swingId}`);

  } catch (err) {
    console.error(`[Worker] Fatal Error processing swing:`, err);
  }
}