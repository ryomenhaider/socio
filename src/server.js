const app = require('./app');
const config = require('./config');
const { start } = require('./services/publisher');

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`[socio] listening on http://localhost:${config.port}`);
  console.log(`[socio] data dir: ${config.dataDir}`);
});

start();

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
