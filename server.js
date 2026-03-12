import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ethers } from "ethers";
import multer from "multer";

import { updateProfile, getLeaderboard } from "./users.js";
import { uploadToIPFS } from "./upload.js";

import User from "./models/User.js";
import PointsHistory from "./models/PointsHistory.js";
import Prediction from "./models/Prediction.js";
import Referral from "./models/Referral.js"; // новая модель

dotenv.config();

const app = express();
app.use(cors());
app.options("*", cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2 MB
});

const provider = new ethers.WebSocketProvider(process.env.RPC_URL);

/* ================= CORE CONTRACT ================= */
const coreAbi = [
  "function points(address user) view returns(uint256)",
  "function streak(address user) view returns(uint256)",
  "function badgeMinted(address user, uint256 level) view returns(bool)",
  "event CheckedIn(address user,uint256 streak,uint256 totalPoints)",
  "event PointsAdded(address user,uint256 amount)",
  "event BadgeMinted(address user,uint256 level,uint256 reward)"
];

const coreContract = new ethers.Contract(
  process.env.CORE_CONTRACT_ADDRESS,
  coreAbi,
  provider
);

/* ================= PREDICTION CONTRACT ================= */
const predictAbi = [
  "function played(address,uint256) view returns(bool)",
  "function userChoice(address,uint256) view returns(uint8)",
  "function results(uint256) view returns(bool resolved,uint8 correctChoice,uint8 pType)",
  "event PredictionWin(address indexed user,uint256 indexed predictionId,uint256 reward)",
  "event PredictionResolved(uint256 indexed predictionId,uint8 correctChoice)"
];

const predictContract = new ethers.Contract(
  process.env.PREDICT_CONTRACT_ADDRESS,
  predictAbi,
  provider
);

/* ================= ADD HISTORY ================= */
async function addPointsHistory(address, gained) {
  if (gained <= 0) return;
  try {
    await PointsHistory.create({
      address: address.toLowerCase(),
      points: gained,
      createdAt: new Date()
    });
  } catch (err) {
    console.error("Add points history error:", err);
  }
}

/* ================= ADD HISTORY WITH REFERRAL ================= */
async function addPointsHistoryWithReferral(address, gained) {
  if (gained <= 0) return;
  const user = await User.findOne({ address: address.toLowerCase() });
  if (!user) return;

  // Начисляем пользователю
  await addPointsHistory(address, gained);
  await User.updateOne({ address: address.toLowerCase() }, { $inc: { points: gained } });

  // Если есть реферер, начисляем 20%
  if (user.referrer) {
    const bonus = Math.floor(gained * 0.2);
    await addPointsHistory(user.referrer, bonus);
    await User.updateOne({ address: user.referrer }, { $inc: { points: bonus } });
  }
}

/* ================= SYNC USER ================= */
async function syncUserData(address) {
  address = address.toLowerCase();

  const pointsBN = await coreContract.points(address);
  const streakBN = await coreContract.streak(address);

  const totalPoints = Number(pointsBN);
  const streak = Number(streakBN);

  const badges = [];
  for (let i = 1; i <= 10; i++) {
    const minted = await coreContract.badgeMinted(address, i);
    if (minted) badges.push(i);
  }

  await User.updateOne(
    { address },
    { $set: { points: totalPoints, streak, badges } },
    { upsert: true }
  );

  return await User.findOne({ address });
}

/* ================= CORE LISTENER ================= */
function startCoreListener() {
  console.log("Core listener started");

  coreContract.on("CheckedIn", async (userAddr, newStreak, totalPoints) => {
    try {
      const address = userAddr.toLowerCase();
      const streak = Number(newStreak);
      const total = Number(totalPoints);
      const reward = 10 + (streak * 2);

      await addPointsHistoryWithReferral(address, reward);

      await User.updateOne(
        { address },
        { $set: { points: total, streak } },
        { upsert: true }
      );

    } catch (err) {
      console.error("CheckedIn error:", err);
    }
  });

  coreContract.on("BadgeMinted", async (userAddr, level, reward) => {
    try {
      const address = userAddr.toLowerCase();
      const gained = Number(reward);

      await addPointsHistoryWithReferral(address, gained);

      await User.updateOne(
        { address },
        { $inc: { points: gained } },
        { upsert: true }
      );

    } catch (err) {
      console.error("BadgeMinted error:", err);
    }
  });

  coreContract.on("PointsAdded", async (userAddr, amount) => {
    try {
      const address = userAddr.toLowerCase();
      const gained = Number(amount);

      await addPointsHistoryWithReferral(address, gained);

      await User.updateOne(
        { address },
        { $inc: { points: gained } },
        { upsert: true }
      );

    } catch (err) {
      console.error("PointsAdded error:", err);
    }
  });
}

/* ================= PREDICTION LISTENER ================= */
function startPredictionListener() {
  console.log("Prediction listener started");

  predictContract.on("PredictionResolved", async (predictionId, correctChoice) => {
    try {
      const prediction = await Prediction.findOneAndUpdate(
        { contractId: Number(predictionId) },
        { $set: { resolved: true, correctChoice: Number(correctChoice) } },
        { new: true }
      );

      if (!prediction) return;

      const usersPlayed = await User.find({
        [`predictionsPlayed.${predictionId}`]: { $exists: true }
      });

      for (const user of usersPlayed) {
        const choice = user.predictionsPlayed[predictionId];
        if (choice === Number(correctChoice)) {
          await Prediction.updateOne(
            { contractId: Number(predictionId) },
            { $set: { [`userWonMap.${user.address}`]: true } }
          );
        }
      }

    } catch (err) {
      console.error("PredictionResolved error:", err);
    }
  });

  predictContract.on("PredictionWin", async (user, predictionId, reward) => {
    try {
      const address = user.toLowerCase();

      await addPointsHistoryWithReferral(address, Number(reward));
      await User.updateOne({ address }, { $inc: { points: Number(reward) } });

      await Prediction.updateOne(
        { contractId: Number(predictionId) },
        { $set: { [`userWonMap.${address}`]: true } }
      );

    } catch (err) {
      console.error("PredictionWin error:", err);
    }
  });
}

/* ================= PROFILE ROUTES ================= */
app.get("/profile/:address", async (req, res) => {
  try {
    const profile = await syncUserData(req.params.address);
    res.json(profile);
  } catch (err) {
    console.error("Profile GET error:", err);
    res.status(500).json({ error: "Profile error" });
  }
});

app.get("/points-history/:address", async (req, res) => {
  try {
    const history = await PointsHistory.find({
      address: req.params.address.toLowerCase()
    }).sort({ createdAt: -1 }).limit(100);

    res.json(history);
  } catch (err) {
    console.error("Points history GET error:", err);
    res.status(500).json([]);
  }
});

/* ================= REFERRAL ROUTES ================= */

// Получить реферальную ссылку
app.get("/referral/:address", async (req, res) => {
  try {
    const address = req.params.address.toLowerCase();
    const user = await User.findOne({ address });
    if (!user) return res.status(404).json({ error: "User not found" });

    const referralLink = `${process.env.FRONTEND_URL}?ref=${address}`;
    res.json({ referralLink });
  } catch (err) {
    console.error("Referral GET error:", err);
    res.status(500).json({ error: "Referral error" });
  }
});

// Зарегистрировать нового пользователя с реферером
app.post("/referral/register", async (req, res) => {
  try {
    const { address, referrer } = req.body;
    const lowerAddress = address.toLowerCase();
    const lowerReferrer = referrer?.toLowerCase();

    const user = await User.findOne({ address: lowerAddress });
    if (!user) return res.status(404).json({ error: "User not found" });

    if (lowerReferrer && lowerReferrer !== lowerAddress) {
      if (!user.referrer) {
        user.referrer = lowerReferrer;
        await user.save();

        await User.updateOne(
          { address: lowerReferrer },
          { $inc: { referralsCount: 1 } }
        );

        await Referral.create({ user: lowerAddress, referrer: lowerReferrer });
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Referral register error:", err);
    res.status(500).json({ error: "Referral registration failed" });
  }
});

/* ================= REST OF ROUTES ================= */
// — оставляем все остальные маршруты как были: /leaderboard, /upload-avatar, /profile POST, /stats, /predictions/create, /predictions

/* ================= START SERVER ================= */
async function startServer() {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log("Mongo connected");

    await provider.getBlockNumber();
    console.log("WebSocket ready");

    startCoreListener();
    startPredictionListener();

    app.listen(process.env.PORT || 3001, () => {
      console.log("Backend running");
    });

  } catch (err) {
    console.error("Server start error:", err);
    process.exit(1);
  }
}

startServer();
