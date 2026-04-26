// src/config/firebase.js
const admin = require('firebase-admin');
const logger = require('../utils/logger');

let firebaseApp;

function getFirebaseApp() {
  if (firebaseApp) return firebaseApp;

  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    logger.warn('FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
    return null;
  }

  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    logger.info('Firebase Admin SDK initialised');
    return firebaseApp;
  } catch (err) {
    logger.error('Failed to initialise Firebase Admin SDK', { error: err.message });
    return null;
  }
}


function getMessaging() {
  const app = getFirebaseApp();
  if (!app) return null;
  return admin.messaging(app);
}

module.exports = { getFirebaseApp, getMessaging };
