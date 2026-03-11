import User from "./models/User.js";

function normalize(address) {
  return address.toLowerCase();
}

export async function updateProfile(address, data) {

  address = normalize(address);

  const update = {};

  if (data.nickname !== undefined) {
    update.nickname = data.nickname;
  }

  if (data.avatar !== undefined) {
    update.avatar = data.avatar;
  }

  return await User.findOneAndUpdate(
    { address },
    { $set: update },
    {
      upsert: true,
      returnDocument: "after"
    }
  );
}

export async function updateOnchainData(address, points, streak, badges) {

  address = normalize(address);

  return await User.findOneAndUpdate(
    { address },
    {
      $set: {
        points,
        streak,
        badges
      },
      $setOnInsert: {
        address
      }
    },
    {
      upsert: true,
      returnDocument: "after"
    }
  );
}

export async function getProfile(address) {
  address = normalize(address);
  return await User.findOne({ address });
}

export async function getLeaderboard() {
  return await User.find()
    .sort({ points: -1 })
    .limit(100);
}