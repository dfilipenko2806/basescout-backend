import mongoose from "mongoose";

const UserSchema = new mongoose.Schema(
{
address: { type: String, unique: true, index: true },

nickname: String,
avatar: String,

points: { type: Number, default: 0 },
streak: { type: Number, default: 0 },

badges: { type: [Number], default: [] },

referrer: { type: String, default: null },
referralsCount: { type: Number, default: 0 },

correctPredictions: { type: Number, default: 0 },
totalPredictions: { type: Number, default: 0 },
predictionsWon: { type: Number, default: 0 }

},
{ timestamps: true }
);

export default mongoose.model("User", UserSchema);
