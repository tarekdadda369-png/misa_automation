// dashboard/server.js
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint to receive dashboard data and run the Playwright test
app.post('/run', async (req, res) => {
  try {
    const data = req.body;
    // Update config.json with provided values
    const configPath = path.resolve(__dirname, '..', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (data.email) config.targetEmail = data.email;
    if (data.isicCodes) config.isicCodes = data.isicCodes.split(',').map(s => s.trim());
    if (data.country) config.country = data.country;
    if (data.mobilePrefix) config.entityMobilePrefix = data.mobilePrefix;
    // Save back to file
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    // Run the Playwright test
    const child = spawn('npx', ['playwright', 'test', 'tests/misa.spec.js', '--headed'], {
      cwd: path.resolve(__dirname, '..'),
      shell: true
    });

    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); console.log(data.toString()); });
    child.stderr.on('data', (data) => { output += data.toString(); console.error(data.toString()); });
    child.on('close', (code) => {
      res.json({ exitCode: code, log: output });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Dashboard server listening on http://localhost:${PORT}`);
});
