import mongoose from "mongoose";

const ReferralSchema = new mongoose.Schema({

referrer: String,

user: String,

createdAt: {
type: Date,
default: Date.now
}

});

export default mongoose.model("Referral", ReferralSchema);