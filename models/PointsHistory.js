import mongoose from "mongoose";

const schema = new mongoose.Schema(
{
  address: { type: String, index: true },
  points: { type: Number, required: true }
},
{ timestamps: true } // createdAt добавится автоматически
);

export default mongoose.model("PointsHistory", schema);