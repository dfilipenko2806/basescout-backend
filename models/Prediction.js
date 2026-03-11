import mongoose from "mongoose";

const PredictionSchema = new mongoose.Schema({

question: String,

contractId: Number,

rewardPoints: {
type:Number,
default:20
},

endDate: Date,

resolved:{
type:Boolean,
default:false
},

createdAt:{
type:Date,
default:Date.now
}

});

export default mongoose.model(
"Prediction",
PredictionSchema
);