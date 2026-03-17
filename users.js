import User from "./models/User.js";
import PointsHistory from "./models/PointsHistory.js";

function normalize(address) {
  return address.toLowerCase();
}

/**
 * Обновление профиля пользователя: nickname и avatar
 */
export async function updateProfile(address, data) {
  address = normalize(address);

  const update = {};
  if (data.nickname !== undefined) update.nickname = data.nickname;
  if (data.avatar !== undefined) update.avatar = data.avatar;

  return await User.findOneAndUpdate(
    { address },
    { 
      $set: update,
      $setOnInsert: { address } 
    },
    { 
      upsert: true,
      returnDocument: "after"
    }
  );
}

export async function syncUserPoints(address) {
  const history = await PointsHistory.find({ address });
  const points = history.reduce((sum, h) => sum + (h.points || 0), 0);

  return await User.findOneAndUpdate(
    { address },
    { $set: { points } },
    { upsert: true, returnDocument: "after" }
  );
}

/**
 * Получение профиля пользователя с суммой поинтов из истории
 */
export async function getProfile(address) {
  address = normalize(address);

  const user = await User.findOne({ address }) || { address };

  // Суммируем все points из истории
  const agg = await PointsHistory.aggregate([
    { $match: { address } },
    { $group: { _id: null, totalPoints: { $sum: "$points" } } }
  ]);

  const totalPoints = agg[0]?.totalPoints || 0;

  return {
    ...user.toObject?.() || user,
    points: totalPoints
  };
}

/**
 * Лидерборд по сумме очков из истории
 */
export async function getLeaderboard() {
  const agg = await PointsHistory.aggregate([
    { $group: { _id: "$address", totalPoints: { $sum: "$points" } } },
    { $sort: { totalPoints: -1 } },
    { $limit: 100 },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "address",
        as: "userInfo"
      }
    },
    {
      $addFields: {
        nickname: { $arrayElemAt: ["$userInfo.nickname", 0] },
        avatar: { $arrayElemAt: ["$userInfo.avatar", 0] }
      }
    },
    { $project: { userInfo: 0 } }
  ]);

  return agg.map(u => ({
    address: u._id,
    points: u.totalPoints,
    nickname: u.nickname || "",
    avatar: u.avatar || ""
  }));
}
