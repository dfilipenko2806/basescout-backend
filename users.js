import User from "./models/User.js";

function normalize(address) {
  return address.toLowerCase();
}

/**
 * Обновление профиля пользователя: nickname и avatar
 */
export async function updateProfile(address, data) {
  address = normalize(address);

  const update = {};

  if (data.nickname !== undefined) {
    update.nickname = data.nickname;
  }

  if (data.avatar !== undefined) {
    update.avatar = data.avatar;
  }

  // Используем findOneAndUpdate с upsert: true, чтобы создать пользователя если его нет
  return await User.findOneAndUpdate(
    { address },
    { $set: update, $setOnInsert: { address } },
    {
      upsert: true,
      returnDocument: "after" // Возвращаем обновленный документ
    }
  );
}

/**
 * Обновление onchain-данных: points, streak, badges
 */
export async function updateOnchainData(address, points, streak, badges) {
  address = normalize(address);

  return await User.findOneAndUpdate(
    { address },
    {
      $set: { points, streak, badges },
      $setOnInsert: { address }
    },
    {
      upsert: true,
      returnDocument: "after"
    }
  );
}

/**
 * Получение профиля по адресу
 */
export async function getProfile(address) {
  address = normalize(address);
  return await User.findOne({ address });
}

/**
 * Лидерборд по очкам
 */
export async function getLeaderboard() {
  return await User.find()
    .sort({ points: -1 })
    .limit(100);
}
