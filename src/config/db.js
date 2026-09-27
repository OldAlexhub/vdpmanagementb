import mongoose from 'mongoose';

// The app keeps its own database inside the cluster given by MONGO_URI.
// It never reads or writes the previous application's collections.
export const DEFAULT_DB_NAME = 'bigstar_vdp';

export async function connectDb(dbName = process.env.MONGO_DB_NAME || DEFAULT_DB_NAME) {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set (server/.env).');
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 15000 });
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  return mongoose.connection;
}

export const disconnectDb = () => mongoose.disconnect();
