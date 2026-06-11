const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('SUPABASE_URL exists?', !!supabaseUrl);
console.log('SUPABASE_SERVICE_KEY exists?', !!supabaseKey);

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function processJobs() {
  console.log('Checking for pending video jobs...');
  
  const { data: jobs, error } = await supabase
    .from('quiz_queue')
    .select('*')
    .eq('job_type', 'video_render')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    console.error('Database error:', error);
    return;
  }

  if (!jobs || jobs.length === 0) {
    console.log('No pending jobs');
    return;
  }

  const job = jobs[0];
  console.log(`Processing job ${job.id} for quiz ${job.quiz_id}`);

  await supabase
    .from('quiz_queue')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', job.id);

  try {
    console.log('Rendering video (simulated)...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    await supabase
      .from('quiz_queue')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', job.id);
      
    console.log(`Job ${job.id} completed successfully`);
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);
    await supabase
      .from('quiz_queue')
      .update({ status: 'failed', last_error: err.message })
      .eq('id', job.id);
  }
}

processJobs().then(() => {
  console.log('Worker finished this run');
  process.exit(0);
});
