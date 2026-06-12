const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('SUPABASE_URL exists?', !!supabaseUrl);
console.log('SUPABASE_SERVICE_KEY exists?', !!supabaseKey);

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

// Helper for Supabase REST API calls
const headers = {
  'apikey': supabaseKey,
  'Authorization': `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json'
};

async function fetchSupabase(path, options = {}) {
  const url = `${supabaseUrl}/rest/v1/${path}`;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function processJobs() {
  console.log('Checking for pending video jobs...');
  
  try {
    // Fetch one pending job
    const jobs = await fetchSupabase(
      'quiz_queue?job_type=eq.video_render&status=eq.pending&order=created_at.asc&limit=1'
    );
    
    if (!jobs || jobs.length === 0) {
      console.log('No pending jobs');
      return;
    }

    const job = jobs[0];
    console.log(`Processing job ${job.id} for quiz ${job.quiz_id}`);

    // Update to processing
    await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'processing', started_at: new Date().toISOString() })
    });

    try {
      // Simulate video rendering (replace with real FFmpeg later)
      console.log('Rendering video (simulated)...');
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      // Update to completed
      await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
      });
      
      console.log(`Job ${job.id} completed successfully`);
    } catch (err) {
      console.error(`Job ${job.id} failed:`, err);
      await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'failed', last_error: err.message })
      });
    }
  } catch (err) {
    console.error('Unexpected error:', err);
  }
}

processJobs().then(() => {
  console.log('Worker finished this run');
  process.exit(0);
});
