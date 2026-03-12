import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ethers } from "ethers";
import multer from "multer";

import { updateProfile, getLeaderboard } from "./users.js"; // добавил getLeaderboard
import { uploadToIPFS } from "./upload.js";

import User from "./models/User.js";
import PointsHistory from "./models/PointsHistory.js";
import Prediction from "./models/Prediction.js";

dotenv.config();

const app = express();
app.use(cors());
app.options("*", cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 } // 2 MB
});

// === ИНИЦИАЛИЗАЦИЯ WebSocket PROVIDER ===
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

      await addPointsHistory(address, Number(reward));
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

app.get("/leaderboard", async (req, res) => {
  try {
    const leaderboard = await getLeaderboard(); // функция из users.js
    res.json(leaderboard);
  } catch (err) {
    console.error("Leaderboard GET error:", err);
    res.status(500).json([]);
  }
});

app.post("/upload-avatar", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const url = await uploadToIPFS(req.file);
    res.json({ url });
  } catch (err) {
    console.error("Avatar upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

app.post("/profile", async (req, res) => {
  try {
    const { address, nickname, avatar } = req.body;
    if (!address) return res.status(400).json({ error: "Address required" });

    const updated = await updateProfile(address, { nickname, avatar });
    res.json(updated);
  } catch (err) {
    console.error("Profile update POST error:", err);
    res.status(500).json({ error: "Profile update failed" });
  }
});

/* ================= GLOBAL STATS ================= */
app.get("/stats", async (req, res) => {
  try {
    // общее количество пользователей
    const users = await User.countDocuments();

    // общее количество очков
    const pointsAgg = await User.aggregate([
      { $group: { _id: null, totalPoints: { $sum: "$points" } } }
    ]);
    const points = pointsAgg[0]?.totalPoints || 0;

    // общее количество транзакций (PointsHistory)
    const transactions = await PointsHistory.countDocuments();

    res.json({ users, points, transactions });
  } catch (err) {
    console.error("Stats GET error:", err);
    res.status(500).json({ users: 0, points: 0, transactions: 0 });
  }
});

/* ================= CREATE PREDICTION (ADMIN ONLY) ================= */
app.post("/predictions/create", async (req, res) => {
  try {
    // 🔑 Проверка секретного ключа
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { question, endDate } = req.body;

    if (!question || !endDate) {
      return res.status(400).json({ error: "Missing question or endDate" });
    }

    // Создаем новый предикт в MongoDB
    const newPrediction = await Prediction.create({
      question,
      createdAt: new Date(),
      endDate: new Date(endDate),
      resolved: false,
      contractId: Number(req.body.contractId || Date.now()) // временный ID, потом заменяется при публикации на контракт
    });

    res.json({ success: true, prediction: newPrediction });
  } catch (err) {
    console.error("Create prediction error:", err);
    res.status(500).json({ error: "Failed to create prediction" });
  }
});

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
