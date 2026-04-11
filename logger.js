const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs-extra');

// Ensure logs directory exists
fs.ensureDirSync(path.join(__dirname, 'logs'));

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${stack || message}`;
  })
);

const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    // Console output with colors
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      )
    }),
    // Daily rotating file
    new winston.transports.DailyRotateFile({
      filename: path.join(__dirname, 'logs', 'activity-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '14d',
      zippedArchive: true
    }),
    // Error-only file
    new winston.transports.File({
      filename: path.join(__dirname, 'logs', 'errors.log'),
      level: 'error'
    })
  ]
});

module.exports = logger;
