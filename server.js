import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ethers } from "ethers";
import multer from "multer";

import { updateProfile } from "./users.js";
import { uploadToIPFS } from "./upload.js";

import User from "./models/User.js";
import PointsHistory from "./models/PointsHistory.js";
import Prediction from "./models/Prediction.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }
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

  await PointsHistory.create({
    address: address.toLowerCase(),
    points: gained,
    createdAt: new Date()
  });
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

      await addPointsHistory(address, reward);

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

      await addPointsHistory(address, gained);

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

      await addPointsHistory(address, gained);

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

  // ---------------- PredictionResolved ----------------
  predictContract.on(
    "PredictionResolved",
    async (predictionId, correctChoice) => {
      try {
        // Обновляем предикт в базе как resolved
        const prediction = await Prediction.findOneAndUpdate(
          { contractId: Number(predictionId) },
          { $set: { resolved: true, correctChoice: Number(correctChoice) } },
          { new: true }
        );

        if (!prediction) return;

        // Проверяем всех пользователей, которые сыграли
        const usersPlayed = await User.find({
          [`predictionsPlayed.${predictionId}`]: { $exists: true }
        });

        for (const user of usersPlayed) {
          const choice = user.predictionsPlayed[predictionId];
          if (choice === Number(correctChoice)) {
            // Помечаем, что пользователь выиграл
            await Prediction.updateOne(
              { contractId: Number(predictionId) },
              { $set: { [`userWonMap.${user.address}`]: true } }
            );
          }
        }

        console.log(
          `Prediction ${predictionId} resolved with choice ${correctChoice}`
        );
      } catch (err) {
        console.error("PredictionResolved error:", err);
      }
    }
  );

  // ---------------- PredictionWin ----------------
  predictContract.on(
    "PredictionWin",
    async (user, predictionId, reward) => {
      try {
        const address = user.toLowerCase();

        // Добавляем очки и историю
        await addPointsHistory(address, Number(reward));
        await User.updateOne(
          { address },
          { $inc: { points: Number(reward) } }
        );

        // Помечаем победу в предикте
        await Prediction.updateOne(
          { contractId: Number(predictionId) },
          { $set: { [`userWonMap.${address}`]: true } }
        );

        console.log(
          `User ${address} won ${reward} points on prediction ${predictionId}`
        );
      } catch (err) {
        console.error("PredictionWin error:", err);
      }
    }
  );
}

/* ================= PROFILE ================= */

app.get("/profile/:address", async (req, res) => {
  try {
    const profile = await syncUserData(req.params.address);
    res.json(profile);
  } catch {
    res.status(500).json({ error: "Profile error" });
  }
});

/* ================= POINTS HISTORY ================= */

app.get("/points-history/:address", async (req, res) => {
  const history = await PointsHistory.find({
    address: req.params.address.toLowerCase()
  })
    .sort({ createdAt: -1 })
    .limit(100);

  res.json(history);
});

/* ================= CREATE PREDICTION ================= */

app.post("/admin/create-prediction", async (req, res) => {
  try {
    const { question, durationHours, rewardPoints } = req.body;

    if (!question || !durationHours) {
      return res.status(400).json({ error: "Missing data" });
    }

    const nextId = Date.now();
    const endDate = new Date(Date.now() + durationHours * 60 * 60 * 1000);

    const prediction = await Prediction.create({
      question,
      contractId: nextId,
      rewardPoints: rewardPoints || 20,
      endDate,
      resolved: false
    });

    res.json(prediction);
  } catch (err) {
    console.error("Create prediction error:", err);
    res.status(500).json({ error: "Cannot create prediction" });
  }
});

/* ================= GET PREDICTIONS ================= */

app.get("/predictions/:address?", async (req, res) => {
  try {
    const address = req.params.address?.toLowerCase();

    const predictions = await Prediction.find({}).sort({ createdAt: -1 });
    const now = new Date();

    const enriched = predictions.map((p) => ({
      ...p.toObject(),
      userPlayed: false,
      userWon: false,
      resolved: p.resolved,
      expired: now > new Date(p.endDate)
    }));

    res.json(enriched);
  } catch (err) {
    console.error("Predictions error:", err);
    res.status(500).json([]);
  }
});

/* ================= LEADERBOARD ================= */

app.get("/leaderboard", async (req, res) => {
  const users = await User.find({}).sort({ points: -1 }).limit(100);
  res.json(users);
});

/* ================= GLOBAL STATS ================= */

app.get("/stats", async (req, res) => {
  const usersCount = await User.countDocuments();

  const pointsAgg = await User.aggregate([
    { $group: { _id: null, total: { $sum: "$points" } } }
  ]);

  const totalPoints = pointsAgg[0]?.total || 0;
  const transactionsCount = await PointsHistory.countDocuments();

  res.json({
    users: usersCount,
    points: totalPoints,
    transactions: transactionsCount
  });
});

/* ================= START SERVER ================= */

async function startServer() {
  await mongoose.connect(process.env.MONGO_URL);
  console.log("Mongo connected");

  await provider.getBlockNumber();
  console.log("WebSocket ready");

  startCoreListener();
  startPredictionListener();

  app.listen(process.env.PORT || 3001, () => {
    console.log("Backend running");
  });
}

startServer();