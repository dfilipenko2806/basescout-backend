import mongoose from "mongoose";

const UserPredictionSchema = new mongoose.Schema({

address: String,

predictionId: Number,

choice: Number,

txHash: String,

createdAt: {
type: Date,
default: Date.now
}

});

export default mongoose.model("UserPrediction", UserPredictionSchema);