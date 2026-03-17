import mongoose from "mongoose";

const PredictionSchema = new mongoose.Schema({
  question: String,
  contractId: Number,
  rewardPoints: {
    type: Number,
    default: 20
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  // ===== новые поля для фаз =====
  playDeadline: Date,   // конец участия
  resolveTime: Date,    // когда можно показывать результаты
  resolved: {
    type: Boolean,
    default: false
  },
  correctChoice: Number
});

export default mongoose.model(
  "Prediction",
  PredictionSchema
);
