const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ── FIREBASE ADMIN SETUP ───────────────────────────────────
const admin = require('firebase-admin');

const firebaseConfig = {
  projectId: "casino-app-c634d",
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
  });
}

const db = admin.firestore();

// ── PAYSTACK CONFIG ────────────────────────────────────────
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

// ── SPORTS API CONFIG ──────────────────────────────────────
const SPORTS_API_KEY = process.env.SPORTS_API_KEY;
const SPORTS_BASE = 'https://v3.football.api-sports.io';

// ════════════════════════════════════════════════════════════
// SPORTS API ROUTES (proxied so key is hidden)
// ════════════════════════════════════════════════════════════

// Get fixtures
app.get('/api/fixtures', async (req, res) => {
  try {
    const { live, date, league, season } = req.query;
    let url = `${SPORTS_BASE}/fixtures?`;
    if (live) url += `live=all&`;
    if (date) url += `date=${date}&`;
    if (league) url += `league=${league}&`;
    if (season) url += `season=${season}&`;

    const response = await axios.get(url, {
      headers: { 'x-apisports-key': SPORTS_API_KEY }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get fixture events
app.get('/api/fixtures/events', async (req, res) => {
  try {
    const { fixture } = req.query;
    const response = await axios.get(
      `${SPORTS_BASE}/fixtures/events?fixture=${fixture}`,
      { headers: { 'x-apisports-key': SPORTS_API_KEY } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get fixture statistics
app.get('/api/fixtures/statistics', async (req, res) => {
  try {
    const { fixture } = req.query;
    const response = await axios.get(
      `${SPORTS_BASE}/fixtures/statistics?fixture=${fixture}`,
      { headers: { 'x-apisports-key': SPORTS_API_KEY } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get fixture lineups
app.get('/api/fixtures/lineups', async (req, res) => {
  try {
    const { fixture } = req.query;
    const response = await axios.get(
      `${SPORTS_BASE}/fixtures/lineups?fixture=${fixture}`,
      { headers: { 'x-apisports-key': SPORTS_API_KEY } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// PAYMENT ROUTES
// ════════════════════════════════════════════════════════════

// Initialize Paystack payment
app.post('/api/payment/initialize', async (req, res) => {
  try {
    const { email, amount, userId, phone } = req.body;

    const response = await axios.post(
      `${PAYSTACK_BASE}/transaction/initialize`,
      {
        email,
        amount: amount * 100, // convert to kobo
        metadata: { userId, phone },
        callback_url: process.env.FRONTEND_URL
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify Paystack payment + credit user
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { reference, userId } = req.body;

    // Verify with Paystack
    const response = await axios.get(
      `${PAYSTACK_BASE}/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
      }
    );

    const payment = response.data.data;

    if (payment.status !== 'success') {
      return res.status(400).json({ error: 'Payment not successful' });
    }

    const amount = payment.amount / 100; // convert from kobo

    // Get user from Firebase
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    const currentBalance = userData.balance || 0;
    const hasDeposited = userData.hasDeposited || false;

    // Calculate bonus (30% on first deposit of ₦100+)
    let bonus = 0;
    if (!hasDeposited && amount >= 100) {
      bonus = Math.floor(amount * 0.30);
    }

    const newBalance = currentBalance + amount + bonus;

    // Update Firebase
    await userRef.update({
      balance: newBalance,
      hasDeposited: true,
      lastDeposit: amount,
      lastDepositDate: new Date().toISOString(),
      bonusReceived: (userData.bonusReceived || 0) + bonus
    });

    // Save transaction
    await db.collection('transactions').add({
      userId,
      type: 'deposit',
      amount,
      bonus,
      reference,
      status: 'success',
      date: new Date().toISOString(),
      balanceAfter: newBalance
    });

    res.json({
      success: true,
      amount,
      bonus,
      newBalance,
      message: bonus > 0
        ? `₦${amount} deposited + ₦${bonus} bonus added!`
        : `₦${amount} deposited successfully!`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Paystack webhook (auto credit)
app.post('/api/webhook', async (req, res) => {
  try {
    const event = req.body;

    if (event.event === 'charge.success') {
      const payment = event.data;
      const userId = payment.metadata?.userId;
      const amount = payment.amount / 100;

      if (userId) {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
          const userData = userDoc.data();
          const currentBalance = userData.balance || 0;
          const hasDeposited = userData.hasDeposited || false;

          let bonus = 0;
          if (!hasDeposited && amount >= 100) {
            bonus = Math.floor(amount * 0.30);
          }

          await userRef.update({
            balance: currentBalance + amount + bonus,
            hasDeposited: true,
          });

          await db.collection('transactions').add({
            userId,
            type: 'deposit',
            amount,
            bonus,
            reference: payment.reference,
            status: 'success',
            date: new Date().toISOString()
          });
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// WITHDRAWAL ROUTES
// ════════════════════════════════════════════════════════════

// Get list of banks
app.get('/api/banks', async (req, res) => {
  try {
    const response = await axios.get(`${PAYSTACK_BASE}/bank`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify bank account number
app.post('/api/verify-account', async (req, res) => {
  try {
    const { account_number, bank_code } = req.body;
    const response = await axios.get(
      `${PAYSTACK_BASE}/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process withdrawal
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, amount, bankCode, accountNumber, accountName } = req.body;

    // Minimum withdrawal check
    if (amount < 500) {
      return res.status(400).json({ error: 'Minimum withdrawal is ₦500' });
    }

    // Check user balance
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    if ((userData.balance || 0) < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Create transfer recipient
    const recipientRes = await axios.post(
      `${PAYSTACK_BASE}/transferrecipient`,
      {
        type: 'nuban',
        name: accountName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN'
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    const recipientCode = recipientRes.data.data.recipient_code;

    // Initiate transfer
    const transferRes = await axios.post(
      `${PAYSTACK_BASE}/transfer`,
      {
        source: 'balance',
        amount: amount * 100,
        recipient: recipientCode,
        reason: 'BetZone Withdrawal'
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );

    // Deduct from Firebase balance
    await userRef.update({
      balance: (userData.balance || 0) - amount
    });

    // Save transaction
    await db.collection('transactions').add({
      userId,
      type: 'withdrawal',
      amount,
      accountNumber,
      accountName,
      bankCode,
      status: 'processing',
      date: new Date().toISOString(),
      transferCode: transferRes.data.data.transfer_code
    });

    res.json({
      success: true,
      message: `₦${amount} withdrawal initiated to ${accountName}`,
      transferCode: transferRes.data.data.transfer_code
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// BETTING ROUTES
// ════════════════════════════════════════════════════════════

// Place bet
app.post('/api/bet/place', async (req, res) => {
  try {
    const { userId, selections, stake, betType, totalOdds, potentialWin } = req.body;

    // Validate minimum stake
    if (stake < 50) {
      return res.status(400).json({ error: 'Minimum stake is ₦50' });
    }

    // Validate maximum win
    if (potentialWin > 10000000) {
      return res.status(400).json({ error: 'Maximum win is ₦10,000,000' });
    }

    // Check balance
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = userDoc.data();
    if ((userData.balance || 0) < stake) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Deduct stake
    await userRef.update({
      balance: (userData.balance || 0) - stake
    });

    // Save bet
    const betRef = await db.collection('bets').add({
      userId,
      selections,
      stake,
      betType,
      totalOdds,
      potentialWin,
      status: 'pending',
      date: new Date().toISOString()
    });

    // Save transaction
    await db.collection('transactions').add({
      userId,
      type: 'bet',
      amount: stake,
      betId: betRef.id,
      status: 'pending',
      date: new Date().toISOString()
    });

    res.json({
      success: true,
      betId: betRef.id,
      message: `Bet placed! Potential win: ₦${potentialWin}`
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user bets
app.get('/api/bet/history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const bets = await db.collection('bets')
      .where('userId', '==', userId)
      .orderBy('date', 'desc')
      .limit(50)
      .get();

    const betList = bets.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({ success: true, bets: betList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════════

// Get all users
app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await db.collection('users').get();
    const userList = users.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    res.json({ success: true, users: userList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Credit user by phone
app.post('/api/admin/credit', async (req, res) => {
  try {
    const { phone, amount, reason } = req.body;

    const users = await db.collection('users')
      .where('phone', '==', phone)
      .get();

    if (users.empty) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userDoc = users.docs[0];
    const userData = userDoc.data();
    const newBalance = (userData.balance || 0) + amount;

    await userDoc.ref.update({ balance: newBalance });

    await db.collection('transactions').add({
      userId: userDoc.id,
      type: 'admin_credit',
      amount,
      reason,
      date: new Date().toISOString(),
      balanceAfter: newBalance
    });

    res.json({
      success: true,
      message: `₦${amount} credited to ${userData.name || phone}`,
      newBalance
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suspend user
app.post('/api/admin/suspend', async (req, res) => {
  try {
    const { userId, reason } = req.body;
    await db.collection('users').doc(userId).update({
      suspended: true,
      suspendReason: reason,
      suspendDate: new Date().toISOString()
    });
    res.json({ success: true, message: 'User suspended' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all bets (admin)
app.get('/api/admin/bets', async (req, res) => {
  try {
    const bets = await db.collection('bets')
      .orderBy('date', 'desc')
      .limit(100)
      .get();
    const betList = bets.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, bets: betList });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get profit/loss report
app.get('/api/admin/report', async (req, res) => {
  try {
    const transactions = await db.collection('transactions').get();
    let totalDeposits = 0;
    let totalWithdrawals = 0;
    let totalBets = 0;
    let totalWinnings = 0;

    transactions.docs.forEach(doc => {
      const t = doc.data();
      if (t.type === 'deposit') totalDeposits += t.amount;
      if (t.type === 'withdrawal') totalWithdrawals += t.amount;
      if (t.type === 'bet') totalBets += t.amount;
      if (t.type === 'win') totalWinnings += t.amount;
    });

    res.json({
      success: true,
      report: {
        totalDeposits,
        totalWithdrawals,
        totalBets,
        totalWinnings,
        profit: totalBets - totalWinnings
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send notification to all users
app.post('/api/admin/notify', async (req, res) => {
  try {
    const { title, message } = req.body;
    await db.collection('notifications').add({
      title,
      message,
      date: new Date().toISOString(),
      read: false
    });
    res.json({ success: true, message: 'Notification sent to all users' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── START SERVER ───────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BetZone Backend running on port ${PORT}`);
});
