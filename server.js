import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { ethers } from "ethers";
import multer from "multer";

import User from "./models/User.js";
import PointsHistory from "./models/PointsHistory.js";
import Prediction from "./models/Prediction.js";
import Referral from "./models/Referral.js";
import { uploadToIPFS } from "./upload.js";

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
  "function badgeMinted(address user,uint256 level) view returns(bool)",
  "event CheckedIn(address user,uint256 streak,uint256 totalPoints)",
  "event PointsAdded(address user,uint256 amount)",
  "event BadgeMinted(address user,uint256 level,uint256 reward)"
];
const coreContract = new ethers.Contract(process.env.CORE_CONTRACT_ADDRESS, coreAbi, provider);

/* ================= PREDICTION CONTRACT ================= */
const predictAbi = [
  "function played(address,uint256) view returns(bool)",
  "function userChoice(address,uint256) view returns(uint8)",
  "function results(uint256) view returns(bool resolved,uint8 correctChoice,uint8 pType)",
  "event PredictionWin(address indexed user,uint256 indexed predictionId,uint256 reward)",
  "event PredictionResolved(uint256 indexed predictionId,uint8 correctChoice)"
];
const predictContract = new ethers.Contract(process.env.PREDICT_CONTRACT_ADDRESS, predictAbi, provider);

/* ================= HELPERS ================= */
async function addPointsHistory(address, gained) {
  if (gained <= 0) return;
  try {
    await PointsHistory.create({ address: address.toLowerCase(), points: gained, createdAt: new Date() });
  } catch (err) {
    console.error("Add points history error:", err);
  }
}

async function addPointsHistoryWithReferral(address, gained) {
  if (gained <= 0) return;
  const user = await User.findOne({ address: address.toLowerCase() });
  if (!user) return;

  await addPointsHistory(address, gained);
  await User.updateOne({ address: address.toLowerCase() }, { $inc: { points: gained } });

  if (user.referrer) {
    const bonus = Math.floor(gained * 0.2);
    await addPointsHistory(user.referrer, bonus);
    await User.updateOne({ address: user.referrer }, { $inc: { points: bonus } });
  }
}

async function syncUserData(address) {
  address = address.toLowerCase();
  const pointsBN = await coreContract.points(address);
  const streakBN = await coreContract.streak(address);

  const totalPoints = Number(pointsBN);
  const streak = Number(streakBN);

  const badges = [];
  for (let i = 1; i <= 10; i++) {
    if (await coreContract.badgeMinted(address, i)) badges.push(i);
  }

  await User.updateOne({ address }, { $set: { points: totalPoints, streak, badges } }, { upsert: true });
  return await User.findOne({ address });
}

/* ================= CORE LISTENER ================= */
function startCoreListener() {
  console.log("Core listener started");

  coreContract.on("CheckedIn", async (userAddr, newStreak, totalPoints) => {
    const address = userAddr.toLowerCase();
    const streak = Number(newStreak);
    const reward = 10 + streak * 2;
    try {
      await addPointsHistoryWithReferral(address, reward);
      await User.updateOne({ address }, { $set: { points: Number(totalPoints), streak } }, { upsert: true });
    } catch (err) {
      console.error("CheckedIn error:", err);
    }
  });

  coreContract.on("PointsAdded", async (userAddr, amount) => {
    try {
      const address = userAddr.toLowerCase();
      await addPointsHistoryWithReferral(address, Number(amount));
      await User.updateOne({ address }, { $inc: { points: Number(amount) } }, { upsert: true });
    } catch (err) {
      console.error("PointsAdded error:", err);
    }
  });

  coreContract.on("BadgeMinted", async (userAddr, level, reward) => {
    try {
      const address = userAddr.toLowerCase();
      await addPointsHistoryWithReferral(address, Number(reward));
      await User.updateOne({ address }, { $inc: { points: Number(reward) } }, { upsert: true });
    } catch (err) {
      console.error("BadgeMinted error:", err);
    }
  });
}

/* ================= PREDICTION LISTENER ================= */
function startPredictionListener() {
  console.log("Prediction listener started");

  predictContract.on("PredictionResolved", async (predictionId, correctChoice) => {
    try {
      await Prediction.updateOne({ contractId: Number(predictionId) }, { $set: { resolved: true, correctChoice: Number(correctChoice) } });
    } catch (err) {
      console.error("PredictionResolved error:", err);
    }
  });

  predictContract.on("PredictionWin", async (user, predictionId, reward) => {
    try {
      const address = user.toLowerCase();
      await addPointsHistoryWithReferral(address, Number(reward));
      await User.updateOne({ address }, { $inc: { points: Number(reward), predictionsWon: 1 } });
      await Prediction.updateOne({ contractId: Number(predictionId) }, { $set: { [`userWonMap.${address}`]: true } });
    } catch (err) {
      console.error("PredictionWin error:", err);
    }
  });
}

/* ================= ROUTES ================= */
// Profile
app.get("/profile/:address", async (req, res) => {
  try {
    const profile = await syncUserData(req.params.address);
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: "Profile error" });
  }
});

// Points history
app.get("/points-history/:address", async (req, res) => {
  try {
    const history = await PointsHistory.find({ address: req.params.address.toLowerCase() }).sort({ createdAt: -1 }).limit(100);
    res.json(history);
  } catch {
    res.status(500).json([]);
  }
});

// Leaderboard
app.get("/leaderboard", async (req, res) => {
  try {
    const users = await User.find({}).sort({ points: -1 }).limit(50);
    res.json(users);
  } catch {
    res.status(500).json([]);
  }
});

// Stats
app.get("/stats", async (req, res) => {
  try {
    const users = await User.countDocuments();
    const points = await User.aggregate([{ $group: { _id: null, total: { $sum: "$points" } } }]);
    const transactions = await PointsHistory.countDocuments();

    res.json({
      users,
      points: points[0]?.total || 0,
      transactions
    });
  } catch {
    res.json({ users: 0, points: 0, transactions: 0 });
  }
});

// Predictions
app.get("/predictions", async (req, res) => {
  try {
    const preds = await Prediction.find({}).sort({ createdAt: -1 });
    res.json(preds);
  } catch {
    res.json([]);
  }
});

// Upload avatar
app.post("/upload-avatar", upload.single("file"), async (req, res) => {
  try {

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const url = await uploadToIPFS(req.file);

    res.json({ url });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

/* ================= REFERRALS ================= */
app.get("/referral/:address", async (req, res) => {
  try {
    const address = req.params.address.toLowerCase();
    const user = await User.findOne({ address });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ referralLink: `${process.env.FRONTEND_URL}?ref=${address}` });
  } catch {
    res.status(500).json({ error: "Referral error" });
  }
});

app.post("/referral/register", async (req, res) => {
  try {
    let { address, referrer } = req.body;

    address = address.toLowerCase();
    referrer = referrer?.toLowerCase();

    let user = await User.findOne({ address });

    if (!user) {
      user = await User.create({ address });
    }

    if (!referrer) {
      return res.json({ success: true });
    }

    if (referrer === address) {
      return res.json({ success: true });
    }

    if (user.referrer) {
      return res.json({ success: true });
    }

    const refUser = await User.findOne({ address: referrer });

    if (!refUser) {
      return res.json({ success: true });
    }

    user.referrer = referrer;
    await user.save();

    await User.updateOne(
      { address: referrer },
      { $inc: { referralsCount: 1 } }
    );

    await Referral.create({
      user: address,
      referrer
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Referral register failed" });
  }
});

app.post("/profile", async (req, res) => {
  try {
    const { address, nickname, avatar } = req.body;

    await User.updateOne(
      { address: address.toLowerCase() },
      {
        $set: {
          nickname: nickname || "",
          avatar: avatar || ""
        }
      },
      { upsert: true }
    );

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Profile update failed" });
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
    app.listen(process.env.PORT || 3001, () => console.log("Backend running"));
  } catch (err) {
    console.error("Server start error:", err);
    process.exit(1);
  }
}

startServer();
