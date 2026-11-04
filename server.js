'use strict';

/**
 * Point d'entrée du serveur.
 * Orkestr injecte PORT ; on écoute sur 0.0.0.0 pour être joignable par le proxy.
 */

const { createApp } = require('./src/app');
const { config } = require('./src/config');

const app = createApp();

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[todoist-triage] v${config.appVersion} en écoute sur le port ${config.port}`);
  console.log(`[todoist-triage] fuseau : ${config.timezone}`);
});

function shutdown(signal) {
  console.log(`[todoist-triage] ${signal} reçu, arrêt...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
