const { exec } = require('child_process');

(async function() {
  const maxAttempts = 60;
  for (let i = 1; i <= maxAttempts; i++) {
    console.log(`Attempt ${i}/${maxAttempts}: running screenshot script`);
    try {
      await new Promise((resolve, reject) => {
        const p = exec('node scripts/screenshot.js', { timeout: 60000 }, (err, stdout, stderr) => {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          if (err) return reject(err);
          resolve();
        });
      });
      console.log('Screenshot script succeeded. Exiting retry loop.');
      process.exit(0);
    } catch (e) {
      console.log(`Attempt ${i} failed: ${e.message || e}. Retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.error(`All ${maxAttempts} attempts failed.`);
  process.exit(1);
})();
