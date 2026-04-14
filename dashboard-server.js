require('dotenv').config();
const express = require('express');
const path = require('path');
const { getStats } = require('./queue');
const logger = require('./logger');
const fs = require('fs-extra');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3456;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'state', 'images')));

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
    { time: '6:05 AM', action: 'Scrape Website', platform: 'system' },
    { time: '9:00 AM', action: 'Post Article #1', platform: 'all' },
    { time: '10:00 AM', action: 'Post Article #2', platform: 'all' },
    { time: '11:00 AM', action: 'Post Article #3', platform: 'all' },
    { time: '12:00 PM', action: 'Post Article #4', platform: 'all' },
    { time: '1:00 PM', action: 'Post Article #5', platform: 'all' }
  ];
  res.json({ timezone, schedule });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`📊 Dashboard running on port ${PORT}`);
});

module.exports = app;
