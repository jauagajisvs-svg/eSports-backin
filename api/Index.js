const express = require('express');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// Initialize Firebase Admin (Environment variables required in production)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const db = admin.firestore();
const app = express();
app.use(express.json());

// --- CONFIGURATION ---
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;
const CASHFREE_ENV = process.env.CASHFREE_ENV || 'TEST'; // TEST or PRODUCTION
const CF_URL = CASHFREE_ENV === 'PRODUCTION' 
  ? 'https://api.cashfree.com/pg/orders' 
  : 'https://sandbox.cashfree.com/pg/orders';

// --- MIDDLEWARE: AUTHENTICATION ---
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.uid = decodedToken.uid;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid Token' });
  }
};

// --- ROUTES ---

// 1. AUTH SIGNUP
app.post('/auth/signup', authenticate, async (req, res) => {
  const { username, email, referralCode } = req.body;
  const userRef = db.collection('users').doc(req.uid);

  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (userDoc.exists) return;

      const newReferralCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      t.set(userRef, {
        username,
        email,
        wallet: 0,
        totalXP: 0,
        joinedMatches: [],
        referralCode: newReferralCode,
        referredBy: referralCode || null,
        matchesPlayed: 0,
        totalKills: 0,
        dailyStreak: 0,
        isVIP: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.status(200).json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. JOIN MATCH
app.post('/match/join', authenticate, async (req, res) => {
  const { matchId, gameUids } = req.body;
  if (!Array.isArray(gameUids) || ![1, 2, 4].includes(gameUids.length)) {
    return res.status(400).json({ error: 'Invalid team size' });
  }

  const matchRef = db.collection('matches').doc(matchId);
  const userRef = db.collection('users').doc(req.uid);
  const teamRef = matchRef.collection('teams').doc(req.uid);

  try {
    const result = await db.runTransaction(async (t) => {
      const [matchSnap, userSnap, teamSnap] = await Promise.all([
        t.get(matchRef), t.get(userRef), t.get(teamRef)
      ]);

      if (!matchSnap.exists) throw new Error('Match not found');
      const match = matchSnap.data();

      if (match.status !== 'upcoming') throw new Error('Match not open');
      if (teamSnap.exists) throw new Error('Already joined this match');
      if (userSnap.data().wallet < match.entryFee) throw new Error('Insufficient balance');
      if (match.joinedCount + gameUids.length > match.maxPlayers) throw new Error('Match full');

      // Check global duplicate gameUids in this match
      const existingTeams = await matchRef.collection('teams').where('gameUids', 'array-contains-any', gameUids).get();
      if (!existingTeams.empty) throw new Error('One or more Game IDs already registered');

      // Deductions and Updates
      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(-match.entryFee),
        joinedMatches: admin.firestore.FieldValue.arrayUnion(matchId)
      });

      t.update(matchRef, {
        joinedCount: admin.firestore.FieldValue.increment(gameUids.length)
      });

      t.set(teamRef, {
        ownerUid: req.uid,
        ownerUsername: userSnap.data().username,
        gameUids: gameUids
      });

      t.set(db.collection('transactions').doc(), {
        userId: req.uid,
        type: 'MATCH_JOIN',
        amount: match.entryFee,
        status: 'SUCCESS',
        matchId,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return { success: true };
    });
    res.status(200).json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 3. DAILY REWARDS
app.post('/rewards/daily', authenticate, async (req, res) => {
  const userRef = db.collection('users').doc(req.uid);
  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      const data = userDoc.data();
      const now = new Date();
      const lastReward = data.lastDailyReward?.toDate();

      if (lastReward && (now - lastReward) < 24 * 60 * 60 * 1000) {
        throw new Error('Already claimed in last 24h');
      }

      const rewardAmount = 10; // Example flat reward
      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(rewardAmount),
        dailyStreak: admin.firestore.FieldValue.increment(1),
        lastDailyReward: admin.firestore.FieldValue.serverTimestamp()
      });

      t.set(db.collection('transactions').doc(), {
        userId: req.uid,
        type: 'DAILY_REWARD',
        amount: rewardAmount,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.status(200).json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 4. WALLET: CREATE ORDER
app.post('/wallet/createOrder', authenticate, async (req, res) => {
  const { amount } = req.body;
  const orderId = `ORDER_${uuidv4()}`;

  try {
    const response = await fetch(CF_URL, {
      method: 'POST',
      headers: {
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        order_id: orderId,
        order_amount: amount,
        order_currency: "INR",
        customer_details: {
          customer_id: req.uid,
          customer_phone: "9999999999" // Fallback or from user doc
        }
      })
    });

    const data = await response.json();
    
    await db.collection('transactions').doc(orderId).set({
      userId: req.uid,
      type: 'DEPOSIT',
      amount: amount,
      status: 'PENDING',
      orderId: orderId,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. WEBHOOK: CASHFREE
app.post('/webhook/cashfree', async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const rawBody = JSON.stringify(req.body);

  // Signature verification (Conceptual - verify according to Cashfree SDK docs)
  // const expectedSignature = crypto.createHmac('sha256', CASHFREE_SECRET_KEY).update(timestamp + rawBody).digest('base64');
  
  const { data } = req.body;
  const orderId = data.order.order_id;
  const status = data.payment.payment_status;
  const amount = data.order.order_amount;

  const txnRef = db.collection('transactions').doc(orderId);

  try {
    await db.runTransaction(async (t) => {
      const txnDoc = await t.get(txnRef);
      if (!txnDoc.exists || txnDoc.data().status !== 'PENDING') return;

      const userId = txnDoc.data().userId;
      const userRef = db.collection('users').doc(userId);

      if (status === 'SUCCESS') {
        t.update(txnRef, { status: 'SUCCESS' });
        t.update(userRef, { wallet: admin.firestore.FieldValue.increment(amount) });
      } else {
        t.update(txnRef, { status: 'FAILED' });
      }
    });
    res.status(200).send('OK');
  } catch (e) {
    res.status(500).send('Webhook Error');
  }
});

// 6. WALLET: WITHDRAW
app.post('/wallet/withdraw', authenticate, async (req, res) => {
  const { amount, upiId } = req.body;
  const userRef = db.collection('users').doc(req.uid);

  try {
    await db.runTransaction(async (t) => {
      const userDoc = await t.get(userRef);
      if (userDoc.data().wallet < amount) throw new Error('Insufficient balance');

      t.update(userRef, { wallet: admin.firestore.FieldValue.increment(-amount) });
      t.set(db.collection('transactions').doc(), {
        userId: req.uid,
        type: 'WITHDRAWAL',
        amount,
        upiId,
        status: 'PENDING',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    res.status(200).json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 7. ADMIN: DISTRIBUTE PRIZE
app.post('/admin/match/distribute', async (req, res) => {
  const { matchId, gameUid, rank, kills } = req.body;
  // Note: Add middleware to restrict this to Admin UIDs in production

  const matchRef = db.collection('matches').doc(matchId);
  
  try {
    const matchSnap = await matchRef.get();
    const match = matchSnap.data();
    if (match.prizeDistributed) throw new Error('Prizes already distributed');

    const teamsSnap = await matchRef.collection('teams').where('gameUids', 'array-contains', gameUid).limit(1).get();
    if (teamsSnap.empty) throw new Error('Team not found');
    
    const team = teamsSnap.docs[0].data();
    const ownerUid = team.ownerUid;
    const userRef = db.collection('users').doc(ownerUid);

    const rankPrize = match.rankPrizes[rank] || 0;
    const killPrize = kills * match.perKillRate;
    const totalPrize = rankPrize + killPrize;
    const xpGained = (kills * 10) + (rank === 1 ? 100 : 20);

    const prizeId = `PRIZE_${matchId}_${ownerUid}`;

    await db.runTransaction(async (t) => {
      const prizeDoc = await t.get(db.collection('transactions').doc(prizeId));
      if (prizeDoc.exists) throw new Error('Prize already processed for this user');

      t.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(totalPrize),
        totalXP: admin.firestore.FieldValue.increment(xpGained),
        totalKills: admin.firestore.FieldValue.increment(kills),
        matchesPlayed: admin.firestore.FieldValue.increment(1)
      });

      t.set(db.collection('transactions').doc(prizeId), {
        userId: ownerUid,
        type: 'MATCH_PRIZE',
        amount: totalPrize,
        matchId,
        status: 'SUCCESS',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    res.status(200).json({ success: true, prize: totalPrize });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
