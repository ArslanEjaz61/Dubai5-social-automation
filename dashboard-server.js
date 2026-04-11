require('dotenv').config();
const express = require('express');
const path = require('path');
const { getStats } = require('./queue');
const logger = require('./logger');
const fs = require('fs-extra');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3456;

app.use(express.static(path.join(__dirname, 'public')));

// API: Get today's posting stats
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get recent logs
app.get('/api/logs', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(__dirname, 'logs', `activity-${today}.log`);
    if (await fs.pathExists(logFile)) {
      const content = await fs.readFile(logFile, 'utf8');
      const lines = content.trim().split('\n').slice(-100); // Last 100 lines
      res.json({ lines });
    } else {
      res.json({ lines: ['No logs yet for today'] });
    }
  } catch (e) {
    res.json({ lines: [`Error reading logs: ${e.message}`] });
  }
});

// API: Get next scheduled posts
app.get('/api/schedule', (req, res) => {
  const timezone = process.env.TIMEZONE || 'Asia/Dubai';
  const schedule = [
    { time: '6:00 AM', action: 'Scrape dubai5.space', platform: 'system' },
    { time: '7:00 AM', action: 'Post Article #1', platform: 'linkedin' },
    { time: '8:00 AM', action: 'Post Article #2', platform: 'linkedin' },
    { time: '9:00 AM', action: 'Post Article #3', platform: 'linkedin' },
    { time: '10:00 AM', action: 'Post Article #4', platform: 'linkedin' },
    { time: '11:00 AM', action: 'Post Article #5', platform: 'linkedin' }
  ];
  res.json({ timezone, schedule });
});

app.listen(PORT, () => {
  logger.info(`📊 Dashboard running at http://localhost:${PORT}`);
});

module.exports = app;
