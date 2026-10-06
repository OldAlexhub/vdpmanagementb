import 'dotenv/config';
import { connectDb } from './src/config/db.js';
import { createApp } from './src/app.js';
import { autoApproveDue } from './src/services/vdpService.js';
import { startCompassSyncScheduler } from './src/services/compassSyncScheduler.js';

const port = Number(process.env.PORT) || 5000;

try {
  const conn = await connectDb();
  console.log(`MongoDB connected (database "${conn.name}")`);
  createApp().listen(port, () => console.log(`VDP API listening on http://localhost:${port}`));

  // Auto-approve VDPs whose provider approval deadline (end of "Closed for Submission" date) has passed.
  const runAutoApprove = () => autoApproveDue()
    .then((n) => n && console.log(`Auto-approved ${n} VDP(s) after the submission deadline`))
    .catch((err) => console.error('Auto-approval failed:', err.message));
  runAutoApprove();
  setInterval(runAutoApprove, 5 * 60 * 1000);
  startCompassSyncScheduler();
} catch (err) {
  console.error('Failed to start:', err.message);
  process.exit(1);
}
